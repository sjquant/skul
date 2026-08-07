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
 * Per-tool differences in how MCP servers are spelled on disk.
 *
 * `serversKey` is the top-level object key. The two render functions produce one
 * server entry in the tool's own vocabulary, which diverges more than field
 * naming: some tools infer the transport from `command` versus `url` and reject
 * an unknown `type`, and OpenCode folds command and arguments into one array.
 */
interface McpConfigDialect {
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
    serversKey: "mcpServers",
    renderStdio: (server, paths) =>
      renderConventionalStdio(server, paths, "stdio"),
    // Cursor infers a remote server from `url` and documents no type for it.
    renderRemote: (server) => renderConventionalRemote(server, null),
  },
  copilot: {
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
    serversKey: "mcpServers",
    renderStdio: (server, paths) =>
      renderConventionalStdio(server, paths, null),
    renderRemote: (server) => renderConventionalRemote(server, null),
  },
  opencode: {
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
};

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

export interface McpMergeResult {
  /** Full JSON text to write, including servers Skul does not own. */
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
}): McpMergeResult {
  const dialect = requireDialect(options.toolName);
  const document = parseExistingDocument(
    options.existingContent,
    options.toolName,
  );
  const existingServers = readServersObject(document, dialect);

  const rendered = Object.fromEntries(
    Object.entries(options.servers).map(([serverName, server]) => [
      serverName,
      server.transport === "stdio"
        ? dialect.renderStdio(server, options.pluginPaths)
        : dialect.renderRemote(server),
    ]),
  );

  return {
    content: formatDocument({
      ...document,
      [dialect.serversKey]: { ...existingServers, ...rendered },
    }),
    serverNames: Object.keys(rendered),
  };
}

export type McpSubtractResult =
  /** Nothing Skul did not own is left, so the file itself can be deleted. */
  | { releasable: true }
  /** Other servers or settings remain; write this content back instead. */
  | { releasable: false; content: string };

/**
 * Removes the servers one bundle owns from a tool's MCP configuration.
 *
 * A file that still holds other servers or unrelated settings is rewritten
 * rather than deleted, so removing one bundle never discards another bundle's
 * servers or a user's own tool configuration.
 */
export function subtractMcpConfigServers(options: {
  toolName: ToolName;
  existingContent: string;
  serverNames: string[];
}): McpSubtractResult {
  const dialect = requireDialect(options.toolName);
  const document = parseExistingDocument(
    options.existingContent,
    options.toolName,
  );
  const remainingServers = Object.fromEntries(
    Object.entries(readServersObject(document, dialect)).filter(
      ([serverName]) => !options.serverNames.includes(serverName),
    ),
  );

  if (Object.keys(remainingServers).length > 0) {
    return {
      content: formatDocument({
        ...document,
        [dialect.serversKey]: remainingServers,
      }),
      releasable: false,
    };
  }

  const { [dialect.serversKey]: _servers, ...otherSettings } = document;

  if (holdsOnlySchema(otherSettings)) {
    return { releasable: true };
  }

  return { content: formatDocument(otherSettings), releasable: false };
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
  toolName: ToolName,
): Record<string, unknown> {
  if (content === undefined || content.trim() === "") {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Existing ${toolName} MCP configuration is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Existing ${toolName} MCP configuration must be a JSON object`,
    );
  }

  return parsed as Record<string, unknown>;
}

function readServersObject(
  document: Record<string, unknown>,
  dialect: McpConfigDialect,
): Record<string, unknown> {
  const servers = document[dialect.serversKey];

  return servers && typeof servers === "object" && !Array.isArray(servers)
    ? (servers as Record<string, unknown>)
    : {};
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
