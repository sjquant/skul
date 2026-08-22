import fs from "node:fs";
import path from "node:path";

import { resolveBundleDataDir } from "./state-layout";
import type { ToolName } from "./tool-mapping";

/**
 * Bundle-root file holding MCP server declarations, as defined by the Agent
 * Plugins specification (https://agent-plugins.org/specification).
 */
export const MCP_CONFIG_FILE_NAME = "mcp.json";

const PLUGIN_ROOT_PLACEHOLDER = "${PLUGIN_ROOT}";
const PLUGIN_DATA_PLACEHOLDER = "${PLUGIN_DATA}";

export interface McpStdioServer {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpRemoteServer {
  transport: "streamable-http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export type McpServer = McpStdioServer | McpRemoteServer;

export interface McpPluginPaths {
  /** Absolute path to the cached bundle directory, substituted for ${PLUGIN_ROOT}. */
  pluginRoot: string;
  /**
   * Absolute path to the bundle's persistent data directory, substituted for
   * ${PLUGIN_DATA}. Undefined where Skul has no data directory to offer, which
   * makes a bundle that uses the placeholder fail loudly instead of silently
   * pointing a server at the wrong location.
   */
  pluginData?: string;
}

/**
 * Builds the placeholder paths one bundle's MCP declarations expand against.
 *
 * `${PLUGIN_DATA}` is offered only where Skul has a library to derive it from,
 * so a bundle materialized without one fails loudly on the placeholder instead
 * of silently pointing a server at the wrong directory.
 */
export function resolveMcpPluginPaths(options: {
  bundleDir: string;
  libraryDir?: string;
}): McpPluginPaths {
  return {
    pluginRoot: options.bundleDir,
    ...(options.libraryDir
      ? {
          pluginData: resolveBundleDataDir({
            libraryDir: options.libraryDir,
            bundleDir: options.bundleDir,
          }),
        }
      : {}),
  };
}

/**
 * Per-tool differences in how MCP servers are spelled on disk.
 *
 * `serversKey` is the top-level object key. The two render functions produce one
 * server entry in the tool's own vocabulary, which diverges more than field
 * naming: some tools infer the transport from `command` versus `url` and reject
 * an unknown `type`, and OpenCode folds command and arguments into one array.
 */
interface McpConfigDialect {
  /**
   * How the file is edited. JSON documents are merged key-wise; TOML documents
   * are edited as a marker-delimited block appended at the end, because
   * re-serializing TOML would discard the comments and formatting of a
   * hand-maintained config.
   */
  format: "json" | "toml";
  /** Top-level JSON key, or the TOML table prefix such as `mcp_servers`. */
  serversKey: string;
  renderStdio(
    server: McpStdioServer,
    pluginPaths: McpPluginPaths,
  ): Record<string, unknown>;
  renderRemote(server: McpRemoteServer): Record<string, unknown>;
}

/** Renders the `mcpServers` shape shared by Claude Code, Cursor, Kiro, and Copilot. */
function renderConventionalStdio(
  server: McpStdioServer,
  pluginPaths: McpPluginPaths,
  type: string | null,
): Record<string, unknown> {
  return {
    ...(type ? { type } : {}),
    command: server.command,
    ...(server.args
      ? { args: server.args.map((arg) => expandPlaceholders(arg, pluginPaths)) }
      : {}),
    ...(server.env
      ? { env: expandPlaceholderValues(server.env, pluginPaths) }
      : {}),
    ...(server.cwd ? { cwd: expandPlaceholders(server.cwd, pluginPaths) } : {}),
  };
}

function renderConventionalRemote(
  server: McpRemoteServer,
  type: string | null,
): Record<string, unknown> {
  return {
    ...(type ? { type } : {}),
    url: server.url,
    ...(server.headers ? { headers: server.headers } : {}),
  };
}

const MCP_CONFIG_DIALECTS: Partial<Record<ToolName, McpConfigDialect>> = {
  "claude-code": {
    format: "json",
    serversKey: "mcpServers",
    renderStdio: (server, paths) =>
      renderConventionalStdio(server, paths, "stdio"),
    renderRemote: (server) =>
      renderConventionalRemote(
        server,
        server.transport === "sse" ? "sse" : "http",
      ),
  },
  cursor: {
    format: "json",
    serversKey: "mcpServers",
    renderStdio: (server, paths) =>
      renderConventionalStdio(server, paths, "stdio"),
    // Cursor infers a remote server from `url` and documents no type for it.
    renderRemote: (server) => renderConventionalRemote(server, null),
  },
  copilot: {
    format: "json",
    serversKey: "servers",
    renderStdio: (server, paths) =>
      renderConventionalStdio(server, paths, "stdio"),
    renderRemote: (server) =>
      renderConventionalRemote(
        server,
        server.transport === "sse" ? "sse" : "http",
      ),
  },
  kiro: {
    format: "json",
    serversKey: "mcpServers",
    renderStdio: (server, paths) =>
      renderConventionalStdio(server, paths, null),
    renderRemote: (server) => renderConventionalRemote(server, null),
  },
  opencode: {
    format: "json",
    serversKey: "mcp",
    renderStdio: (server, paths) => ({
      type: "local",
      command: [
        server.command,
        ...(server.args ?? []).map((arg) => expandPlaceholders(arg, paths)),
      ],
      enabled: true,
      ...(server.env
        ? { environment: expandPlaceholderValues(server.env, paths) }
        : {}),
      ...(server.cwd ? { cwd: expandPlaceholders(server.cwd, paths) } : {}),
    }),
    renderRemote: (server) => ({
      type: "remote",
      url: server.url,
      enabled: true,
      ...(server.headers ? { headers: server.headers } : {}),
    }),
  },
  codex: {
    format: "toml",
    serversKey: "mcp_servers",
    renderStdio: (server, paths) =>
      renderConventionalStdio(server, paths, null),
    renderRemote: (server) => ({
      url: server.url,
      ...(server.headers ? { http_headers: server.headers } : {}),
    }),
  },
};

const TOML_BLOCK_BEGIN = "# >>> SKUL:MCP BEGIN — managed by skul, do not edit";
const TOML_BLOCK_END = "# <<< SKUL:MCP END";

/** Returns true when the tool has a known MCP configuration file and dialect. */
export function supportsMcpConfig(toolName: ToolName): boolean {
  return toolName in MCP_CONFIG_DIALECTS;
}

/**
 * Parses an Agent Plugins `mcp.json` document into Skul's internal server shape.
 *
 * Invalid individual servers fail the whole parse rather than being skipped, so
 * a typo surfaces at `skul add` time instead of producing a silently incomplete
 * tool configuration.
 */
export function parseMcpConfig(input: unknown): Record<string, McpServer> {
  const document = expectRecord(input, MCP_CONFIG_FILE_NAME);
  const serversInput = expectRecord(document.mcpServers, "mcpServers");

  return Object.fromEntries(
    Object.entries(serversInput).map(([serverName, serverInput]) => [
      expectServerName(serverName),
      parseMcpServer(serverInput, `mcpServers.${serverName}`),
    ]),
  );
}

/**
 * Reads and parses a bundle's MCP declarations, naming the source file when the
 * document is malformed so the failure points at the bundle, not at Skul.
 */
export function readBundleMcpServers(options: {
  /** Absolute path to the declaration file, already checked by the caller. */
  sourceFile: string;
  /** Bundle-relative path, used to name the file in failures. */
  sourcePath: string;
}): Record<string, McpServer> {
  const { sourceFile, sourcePath } = options;
  let document: unknown;

  try {
    document = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid ${sourcePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  return parseMcpConfig(document);
}

export interface McpMergeResult {
  /** Full document text to write — JSON or TOML — including servers Skul does not own. */
  content: string;
  /** Server names Skul now owns in this file, recorded so removal can subtract them. */
  serverNames: string[];
}

/**
 * Merges a bundle's servers into a tool's MCP configuration document.
 *
 * Everything Skul does not own is carried through untouched — unrelated
 * servers, and unrelated top-level keys such as OpenCode's model and theme
 * settings, which share the file with the `mcp` block.
 */
export function mergeMcpConfigDocument(options: {
  toolName: ToolName;
  servers: Record<string, McpServer>;
  pluginPaths: McpPluginPaths;
  existingContent?: string;
  ownedServerNames?: string[];
  configPath?: string;
}): McpMergeResult {
  return mergeRenderedMcpServers({
    toolName: options.toolName,
    renderedServers: renderMcpServers(options),
    ...(options.existingContent !== undefined
      ? { existingContent: options.existingContent }
      : {}),
    ...(options.ownedServerNames !== undefined
      ? { ownedServerNames: options.ownedServerNames }
      : {}),
    ...(options.configPath !== undefined
      ? { configPath: options.configPath }
      : {}),
  });
}

/** Server entries in one tool's vocabulary, with plugin placeholders already expanded. */
export type RenderedMcpServers = Record<string, Record<string, unknown>>;

/**
 * Parses stored rendered servers back out of registry JSON.
 *
 * The registry is a trust boundary — the file is on disk and hand-editable — so
 * the shape is checked here, in the module that defines it, rather than being
 * re-described wherever it is read.
 */
export function parseRenderedMcpServers(
  input: string,
  label: string,
): RenderedMcpServers {
  let parsed: unknown;

  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error(`${label} must be JSON`);
  }

  const servers = expectRecord(parsed, label);

  for (const [serverName, server] of Object.entries(servers)) {
    expectRecord(server, `${label}.${serverName}`);
  }

  return servers as RenderedMcpServers;
}

/**
 * Translates servers into one tool's vocabulary without writing them.
 *
 * Tracked-file shadows keep the result in the registry so a later refresh can
 * replay it onto a new committed base, at which point the bundle's cache
 * directory — and so the plugin placeholders — is no longer in hand.
 */
export function renderMcpServers(options: {
  toolName: ToolName;
  servers: Record<string, McpServer>;
  pluginPaths: McpPluginPaths;
}): RenderedMcpServers {
  const dialect = requireDialect(options.toolName);

  return Object.fromEntries(
    Object.entries(options.servers).map(([serverName, server]) => [
      serverName,
      server.transport === "stdio"
        ? dialect.renderStdio(server, options.pluginPaths)
        : dialect.renderRemote(server),
    ]),
  );
}

/** Merges already-translated server entries into a tool's configuration document. */
export function mergeRenderedMcpServers(options: {
  toolName: ToolName;
  renderedServers: RenderedMcpServers;
  existingContent?: string;
  /** Names this bundle already owns here, which it may overwrite on re-apply. */
  ownedServerNames?: string[];
  /** Repo-relative path of the document, used to name it in failures. */
  configPath?: string;
}): McpMergeResult {
  const dialect = requireDialect(options.toolName);
  const serverNames = Object.keys(options.renderedServers);
  const label = describeConfig(options.toolName, options.configPath);
  const owned = new Set(options.ownedServerNames ?? []);

  if (dialect.format === "toml") {
    return {
      content: mergeTomlBlock({
        existingContent: options.existingContent ?? "",
        tablePrefix: dialect.serversKey,
        rendered: options.renderedServers,
        owned,
        label,
      }),
      serverNames,
    };
  }

  const document = parseExistingDocument(options.existingContent, label);
  const existingServers = readServersObject(document, dialect, label);

  for (const serverName of serverNames) {
    if (Object.hasOwn(existingServers, serverName) && !owned.has(serverName)) {
      throw new Error(
        `MCP server "${serverName}" is already declared in ${label}.\nSkul will not replace a server it does not own: rename or remove that entry, or the one in the bundle.`,
      );
    }
  }

  return {
    content: formatDocument({
      ...document,
      [dialect.serversKey]: { ...existingServers, ...options.renderedServers },
    }),
    serverNames,
  };
}

/**
 * Names an MCP configuration document in an error message.
 *
 * The repo-relative path is the useful name — one bundle writes up to six of
 * these files — and the tool name is the fallback where no path is in hand.
 */
function describeConfig(toolName: ToolName, configPath?: string): string {
  return configPath ?? `the ${toolName} MCP configuration`;
}

/**
 * Rewrites the Skul-managed block of a TOML config, leaving everything outside
 * it byte-for-byte identical.
 *
 * A server the user already declares outside the block would become a duplicate
 * TOML table, which makes the whole config unparseable for the tool, so that
 * collision is refused rather than written.
 */
function mergeTomlBlock(options: {
  existingContent: string;
  tablePrefix: string;
  rendered: Record<string, Record<string, unknown>>;
  owned: Set<string>;
  label: string;
}): string {
  const { before, blockBody, after } = splitTomlBlock(options.existingContent);
  const outsideBlock = `${before}\n${after}`;

  for (const serverName of Object.keys(options.rendered)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(serverName)) {
      throw new Error(
        `MCP server name "${serverName}" cannot be written to a TOML configuration.\nUse only letters, digits, hyphens, underscores, and periods.`,
      );
    }

    if (
      !options.owned.has(serverName) &&
      declaresTomlTable(outsideBlock, options.tablePrefix, serverName)
    ) {
      throw new Error(
        `MCP server "${serverName}" is already declared in ${options.label} outside Skul's managed block.\nSkul will not create a duplicate [${options.tablePrefix}.${serverName}] table: rename or remove that entry, or the one in the bundle.`,
      );
    }
  }

  const tables = {
    ...parseTomlBlockTables(blockBody, options.tablePrefix),
    ...Object.fromEntries(
      Object.entries(options.rendered).map(([serverName, fields]) => [
        serverName,
        renderTomlTable(options.tablePrefix, serverName, fields),
      ]),
    ),
  };

  return joinTomlDocument(before, renderTomlBlock(tables), after);
}

function subtractTomlBlock(options: {
  existingContent: string;
  tablePrefix: string;
  serverNames: string[];
}): McpSubtractResult {
  const { before, blockBody, after } = splitTomlBlock(options.existingContent);
  const tables = parseTomlBlockTables(blockBody, options.tablePrefix);

  for (const serverName of options.serverNames) {
    delete tables[serverName];
  }

  const remainingBlock =
    Object.keys(tables).length > 0 ? renderTomlBlock(tables) : "";
  const content = joinTomlDocument(before, remainingBlock, after);

  return { content, emptied: content.trim() === "" };
}

function splitTomlBlock(content: string): {
  before: string;
  blockBody: string;
  after: string;
} {
  const beginIndex = content.indexOf(TOML_BLOCK_BEGIN);
  const endIndex = content.indexOf(TOML_BLOCK_END);

  if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
    return { before: content.replace(/\s+$/, ""), blockBody: "", after: "" };
  }

  return {
    before: content.slice(0, beginIndex).replace(/\s+$/, ""),
    blockBody: content.slice(beginIndex + TOML_BLOCK_BEGIN.length, endIndex),
    after: content.slice(endIndex + TOML_BLOCK_END.length).replace(/^\s+/, ""),
  };
}

/** Splits a managed block into one text chunk per `[prefix.name]` table. */
function parseTomlBlockTables(
  blockBody: string,
  tablePrefix: string,
): Record<string, string> {
  const tables: Record<string, string> = {};
  let currentName: string | undefined;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentName) {
      tables[currentName] = currentLines.join("\n").replace(/\s+$/, "");
    }
  };

  for (const line of blockBody.split("\n")) {
    const header = matchTomlTableHeader(line);

    // A deeper header such as [prefix.name.env] belongs to the table above it,
    // so only a two-segment header opens a new one.
    if (header?.length === 2 && header[0] === tablePrefix) {
      flush();
      currentName = header[1];
      currentLines = [line.trim()];
      continue;
    }

    if (currentName) {
      currentLines.push(line);
    }
  }

  flush();
  return tables;
}

/**
 * Parses a TOML table header into its dotted key segments, or null when the
 * line is not one.
 *
 * TOML allows whitespace inside the brackets and around the dots, and lets each
 * segment be bare or quoted. Both the managed-block parser and the collision
 * check read headers through here so they cannot disagree about what
 * `[mcp_servers.docs]` means.
 */
function matchTomlTableHeader(line: string): string[] | null {
  const trimmed = line.trim();

  // `[[x]]` declares an array of tables, which is not a shape MCP servers use.
  if (!trimmed.startsWith("[") || trimmed.startsWith("[[")) {
    return null;
  }

  if (!trimmed.endsWith("]")) {
    return null;
  }

  const segments: string[] = [];
  let rest = trimmed.slice(1, -1);

  for (;;) {
    rest = rest.trimStart();
    const quoted = rest.match(/^"((?:[^"\\]|\\.)*)"/);
    const bare = rest.match(/^[A-Za-z0-9_-]+/);

    if (quoted) {
      segments.push(JSON.parse(quoted[0]) as string);
      rest = rest.slice(quoted[0].length);
    } else if (bare) {
      segments.push(bare[0]);
      rest = rest.slice(bare[0].length);
    } else {
      return null;
    }

    rest = rest.trimStart();

    if (rest === "") {
      return segments;
    }

    if (!rest.startsWith(".")) {
      return null;
    }

    rest = rest.slice(1);
  }
}

/**
 * Detects an existing `[prefix.name]` table, however it is spelled.
 *
 * The name must be a whole segment: `[mcp_servers.docs-legacy]` is a different
 * server from `docs` and must not read as a collision, while
 * `[mcp_servers.docs.env]` is part of `docs` and must.
 */
function declaresTomlTable(
  content: string,
  tablePrefix: string,
  serverName: string,
): boolean {
  return content.split("\n").some((line) => {
    const header = matchTomlTableHeader(line);

    return (
      header !== null &&
      header.length >= 2 &&
      header[0] === tablePrefix &&
      header[1] === serverName
    );
  });
}

function renderTomlTable(
  tablePrefix: string,
  serverName: string,
  fields: Record<string, unknown>,
): string {
  return [
    `[${tablePrefix}.${tomlKey(serverName)}]`,
    ...Object.entries(fields).map(
      ([key, value]) => `${tomlKey(key)} = ${tomlValue(value)}`,
    ),
  ].join("\n");
}

function renderTomlBlock(tables: Record<string, string>): string {
  return [
    TOML_BLOCK_BEGIN,
    Object.keys(tables)
      .sort()
      .map((name) => tables[name])
      .join("\n\n"),
    TOML_BLOCK_END,
  ].join("\n");
}

function joinTomlDocument(
  before: string,
  block: string,
  after: string,
): string {
  const sections = [before, block, after].filter(
    (section) => section.trim() !== "",
  );

  return sections.length === 0 ? "" : `${sections.join("\n\n")}\n`;
}

/** Quotes a TOML key unless it is already a safe bare key. */
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

/**
 * Serializes the small value space MCP servers use: strings, string arrays, and
 * string tables. TOML basic strings share JSON's escape syntax, so the standard
 * serializer produces a valid literal.
 */
function tomlValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => tomlValue(item)).join(", ")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${tomlKey(key)} = ${tomlValue(item)}`,
    );
    return `{ ${entries.join(", ")} }`;
  }

  return JSON.stringify(value);
}

export interface McpSubtractResult {
  /**
   * The document with this bundle's servers removed, ready to be written back.
   * Empty text when the document held nothing else at all.
   */
  content: string;
  /**
   * True when nothing outside this bundle's servers remained.
   *
   * Only a file Skul created may then be deleted. A file that was already there
   * is written back as `content` instead, because deleting a document Skul does
   * not own would discard the user's file along with Skul's servers.
   */
  emptied: boolean;
}

/**
 * Removes the servers one bundle owns from a tool's MCP configuration.
 *
 * The result is always content to write back: other servers and unrelated
 * settings living in the same document survive, so removing one bundle never
 * discards another bundle's servers or a user's own tool configuration. Whether
 * the emptied document is deleted instead is the caller's decision, because
 * only the caller knows whether Skul created the file.
 */
export function subtractMcpConfigServers(options: {
  toolName: ToolName;
  existingContent: string;
  serverNames: string[];
  configPath?: string;
}): McpSubtractResult {
  const dialect = requireDialect(options.toolName);
  const label = describeConfig(options.toolName, options.configPath);

  if (dialect.format === "toml") {
    return subtractTomlBlock({
      existingContent: options.existingContent,
      tablePrefix: dialect.serversKey,
      serverNames: options.serverNames,
    });
  }

  const document = parseExistingDocument(options.existingContent, label);
  const remainingServers = Object.fromEntries(
    Object.entries(readServersObject(document, dialect, label)).filter(
      ([serverName]) => !options.serverNames.includes(serverName),
    ),
  );

  if (Object.keys(remainingServers).length > 0) {
    return {
      content: formatDocument({
        ...document,
        [dialect.serversKey]: remainingServers,
      }),
      emptied: false,
    };
  }

  const { [dialect.serversKey]: _servers, ...otherSettings } = document;

  return {
    content: formatDocument(otherSettings),
    emptied: holdsOnlySchema(otherSettings),
  };
}

/**
 * Reads back the servers Skul owns in a document as they stand on disk.
 *
 * Returns null when any of them is no longer declared, which is how the shadow
 * status tells "Skul's servers are in place" from "something removed them". The
 * returned text is the stored overlay verbatim when the declarations still
 * match it, so an unchanged file fingerprints identically.
 */
export function extractMcpOverlay(options: {
  toolName: ToolName;
  content: string;
  overlay: RenderedMcpServers;
}): string | null {
  const dialect = requireDialect(options.toolName);
  const serverNames = Object.keys(options.overlay);

  if (dialect.format === "toml") {
    const tables = parseTomlBlockTables(
      splitTomlBlock(options.content).blockBody,
      dialect.serversKey,
    );
    const declared = serverNames.map((serverName) => tables[serverName]);

    if (declared.some((table) => table === undefined)) {
      return null;
    }

    const expected = serverNames.map((serverName) =>
      renderTomlTable(
        dialect.serversKey,
        serverName,
        options.overlay[serverName] as Record<string, unknown>,
      ),
    );

    return declared.join("\n\n") === expected.join("\n\n")
      ? JSON.stringify(options.overlay)
      : declared.join("\n\n");
  }

  let servers: Record<string, unknown>;

  try {
    const label = describeConfig(options.toolName);
    servers = readServersObject(
      parseExistingDocument(options.content, label),
      dialect,
      label,
    );
  } catch {
    return null;
  }

  if (!serverNames.every((serverName) => Object.hasOwn(servers, serverName))) {
    return null;
  }

  return JSON.stringify(
    Object.fromEntries(
      serverNames.map((serverName) => [serverName, servers[serverName]]),
    ),
  );
}

function requireDialect(toolName: ToolName): McpConfigDialect {
  const dialect = MCP_CONFIG_DIALECTS[toolName];

  if (!dialect) {
    throw new Error(`Tool does not support MCP servers: ${toolName}`);
  }

  return dialect;
}

function parseExistingDocument(
  content: string | undefined,
  label: string,
): Record<string, unknown> {
  if (content === undefined || content.trim() === "") {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Existing MCP configuration ${label} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Existing MCP configuration ${label} must be a JSON object`,
    );
  }

  return parsed as Record<string, unknown>;
}

/**
 * Reads the document's server table.
 *
 * A key of the wrong shape is refused rather than treated as absent: writing
 * over it would destroy configuration Skul does not own, which is the one thing
 * this module exists to avoid.
 */
function readServersObject(
  document: Record<string, unknown>,
  dialect: McpConfigDialect,
  label: string,
): Record<string, unknown> {
  const servers = document[dialect.serversKey];

  if (servers === undefined || servers === null) {
    return {};
  }

  if (typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error(
      `"${dialect.serversKey}" in ${label} must be an object.\nSkul will not overwrite it, because that would discard configuration it does not own.`,
    );
  }

  return servers as Record<string, unknown>;
}

/** True when only a `$schema` pointer remains, which is not worth keeping a file for. */
function holdsOnlySchema(document: Record<string, unknown>): boolean {
  return Object.keys(document).every((key) => key === "$schema");
}

function formatDocument(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Substitutes the two placeholders the specification defines.
 *
 * Replacement is literal and single-pass: an expanded value that itself looks
 * like a placeholder is left alone, as the spec requires non-recursive
 * expansion.
 */
function expandPlaceholders(
  value: string,
  pluginPaths: McpPluginPaths,
): string {
  const expanded = value
    .split(PLUGIN_ROOT_PLACEHOLDER)
    .join(pluginPaths.pluginRoot);

  if (!expanded.includes(PLUGIN_DATA_PLACEHOLDER)) {
    return expanded;
  }

  if (!pluginPaths.pluginData) {
    throw new Error(
      "${PLUGIN_DATA} is not available when materializing this bundle",
    );
  }

  return expanded.split(PLUGIN_DATA_PLACEHOLDER).join(pluginPaths.pluginData);
}

function expandPlaceholderValues(
  values: Record<string, string>,
  pluginPaths: McpPluginPaths,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      expandPlaceholders(value, pluginPaths),
    ]),
  );
}

function parseMcpServer(input: unknown, label: string): McpServer {
  const server = expectRecord(input, label);
  const transport = expectTransport(server.type, `${label}.type`);

  if (transport === "stdio") {
    return {
      transport,
      command: expectNonEmptyString(server.command, `${label}.command`),
      ...(server.args !== undefined
        ? { args: expectStringArray(server.args, `${label}.args`) }
        : {}),
      ...(server.env !== undefined
        ? { env: expectStringRecord(server.env, `${label}.env`) }
        : {}),
      ...(server.cwd !== undefined
        ? { cwd: expectNonEmptyString(server.cwd, `${label}.cwd`) }
        : {}),
    };
  }

  return {
    transport,
    url: expectNonEmptyString(server.url, `${label}.url`),
    ...(server.headers !== undefined
      ? { headers: expectStringRecord(server.headers, `${label}.headers`) }
      : {}),
  };
}

function expectTransport(
  input: unknown,
  label: string,
): McpServer["transport"] {
  if (input === "stdio" || input === "streamable-http" || input === "sse") {
    return input;
  }

  throw new Error(`${label} must be one of: stdio, streamable-http, sse`);
}

function expectServerName(name: string): string {
  if (name.trim() === "") {
    throw new Error("mcpServers keys must be non-empty server names");
  }

  return name;
}

function expectRecord(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }

  return input as Record<string, unknown>;
}

function expectNonEmptyString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error(`${label} is required`);
  }

  return input;
}

function expectStringArray(input: unknown, label: string): string[] {
  if (!Array.isArray(input) || input.some((it) => typeof it !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }

  return input as string[];
}

function expectStringRecord(
  input: unknown,
  label: string,
): Record<string, string> {
  const record = expectRecord(input, label);

  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string") {
      throw new Error(`${label}.${key} must be a string`);
    }
  }

  return record as Record<string, string>;
}
