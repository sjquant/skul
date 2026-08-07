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
 * `serversKey` is the top-level object key, `stdioType` and `remoteType` are the
 * `type` discriminators to emit — `null` means the tool infers the transport
 * from the presence of `command` versus `url`, so emitting a `type` it does not
 * document would risk tripping strict config validation.
 */
interface McpConfigDialect {
  serversKey: string;
  stdioType: string | null;
  remoteType: ((transport: McpRemoteServer["transport"]) => string) | null;
}

const MCP_CONFIG_DIALECTS: Partial<Record<ToolName, McpConfigDialect>> = {
  "claude-code": {
    serversKey: "mcpServers",
    stdioType: "stdio",
    remoteType: (transport) => (transport === "sse" ? "sse" : "http"),
  },
  cursor: {
    serversKey: "mcpServers",
    stdioType: "stdio",
    remoteType: null,
  },
  copilot: {
    serversKey: "servers",
    stdioType: "stdio",
    remoteType: (transport) => (transport === "sse" ? "sse" : "http"),
  },
  kiro: {
    serversKey: "mcpServers",
    stdioType: null,
    remoteType: null,
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

/** Renders the MCP configuration document one tool expects, as JSON text. */
export function renderMcpConfigDocument(options: {
  toolName: ToolName;
  servers: Record<string, McpServer>;
  pluginPaths: McpPluginPaths;
}): string {
  const dialect = MCP_CONFIG_DIALECTS[options.toolName];

  if (!dialect) {
    throw new Error(`Tool does not support MCP servers: ${options.toolName}`);
  }

  const servers = Object.fromEntries(
    Object.entries(options.servers).map(([serverName, server]) => [
      serverName,
      renderMcpServer(server, dialect, options.pluginPaths),
    ]),
  );

  return `${JSON.stringify({ [dialect.serversKey]: servers }, null, 2)}\n`;
}

function renderMcpServer(
  server: McpServer,
  dialect: McpConfigDialect,
  pluginPaths: McpPluginPaths,
): Record<string, unknown> {
  if (server.transport === "stdio") {
    return {
      ...(dialect.stdioType ? { type: dialect.stdioType } : {}),
      command: server.command,
      ...(server.args
        ? {
            args: server.args.map((arg) =>
              expandPlaceholders(arg, pluginPaths),
            ),
          }
        : {}),
      ...(server.env
        ? { env: expandPlaceholderValues(server.env, pluginPaths) }
        : {}),
      ...(server.cwd
        ? { cwd: expandPlaceholders(server.cwd, pluginPaths) }
        : {}),
    };
  }

  return {
    ...(dialect.remoteType
      ? { type: dialect.remoteType(server.transport) }
      : {}),
    url: server.url,
    ...(server.headers ? { headers: server.headers } : {}),
  };
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
