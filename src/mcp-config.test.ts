import { describe, expect, it } from "vitest";

import {
  MCP_CONFIG_FILE_NAME,
  mergeMcpConfigDocument,
  parseMcpConfig,
  subtractMcpConfigServers,
  supportsMcpConfig,
} from "./mcp-config";
import { listToolDefinitions } from "./tool-mapping";

const PLUGIN_PATHS = {
  pluginRoot: "/library/github.com/acme/bundles/react",
  pluginData: "/data/github.com/acme/bundles/react",
};

describe("parseMcpConfig", () => {
  it("reads a stdio server with its arguments, environment, and working directory", () => {
    // Given an Agent Plugins mcp.json declaring one stdio server
    const document = {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        docs: {
          type: "stdio",
          command: "./bin/server",
          args: ["--port", "8080"],
          env: { TOKEN: "abc" },
          cwd: "./work",
        },
      },
    };

    // When it is parsed
    const servers = parseMcpConfig(document);

    // Then every declared field is preserved
    expect(servers).toEqual({
      docs: {
        transport: "stdio",
        command: "./bin/server",
        args: ["--port", "8080"],
        env: { TOKEN: "abc" },
        cwd: "./work",
      },
    });
  });

  it("reads a streamable-http server with its headers", () => {
    // Given a remote server declaration
    const document = {
      mcpServers: {
        remote: {
          type: "streamable-http",
          url: "https://example.com/mcp",
          headers: { "X-Custom": "value" },
        },
      },
    };

    // When it is parsed
    const servers = parseMcpConfig(document);

    // Then the transport and remote fields are preserved
    expect(servers).toEqual({
      remote: {
        transport: "streamable-http",
        url: "https://example.com/mcp",
        headers: { "X-Custom": "value" },
      },
    });
  });

  it("rejects a server declaring an unknown transport", () => {
    // Given a server with a transport outside the specification
    const document = {
      mcpServers: { bad: { type: "websocket", url: "ws://x" } },
    };

    // When it is parsed / Then the invalid transport is reported by name
    expect(() => parseMcpConfig(document)).toThrow(
      "mcpServers.bad.type must be one of: stdio, streamable-http, sse",
    );
  });

  it("rejects a stdio server missing its command", () => {
    // Given a stdio server without a command
    const document = { mcpServers: { bad: { type: "stdio", args: ["x"] } } };

    // When it is parsed / Then the missing field is reported
    expect(() => parseMcpConfig(document)).toThrow(
      "mcpServers.bad.command is required",
    );
  });

  it("rejects a document without an mcpServers object", () => {
    // Given a document missing the required top-level key
    const document = {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    };

    // When it is parsed / Then the missing key is reported
    expect(() => parseMcpConfig(document)).toThrow(
      "mcpServers must be an object",
    );
  });

  it("rejects non-string environment values rather than coercing them", () => {
    // Given an env entry holding a number
    const document = {
      mcpServers: { bad: { type: "stdio", command: "x", env: { PORT: 8080 } } },
    };

    // When it is parsed / Then the offending key is named
    expect(() => parseMcpConfig(document)).toThrow(
      "mcpServers.bad.env.PORT must be a string",
    );
  });
});

describe("mergeMcpConfigDocument", () => {
  it("writes Claude Code servers under mcpServers with an explicit stdio type", () => {
    // Given one stdio server
    const servers = parseMcpConfig({
      mcpServers: { docs: { type: "stdio", command: "server" } },
    });

    // When it is rendered for Claude Code
    const document = mergeMcpConfigDocument({
      toolName: "claude-code",
      servers,
      pluginPaths: PLUGIN_PATHS,
    }).content;

    // Then the tool's own key and discriminator are used
    expect(JSON.parse(document)).toEqual({
      mcpServers: { docs: { type: "stdio", command: "server" } },
    });
  });

  it("translates streamable-http to the http type Claude Code understands", () => {
    // Given a streamable-http server
    const servers = parseMcpConfig({
      mcpServers: { remote: { type: "streamable-http", url: "https://x/mcp" } },
    });

    // When it is rendered for Claude Code
    const document = mergeMcpConfigDocument({
      toolName: "claude-code",
      servers,
      pluginPaths: PLUGIN_PATHS,
    }).content;

    // Then the specification's transport name is mapped to the tool's spelling
    expect(JSON.parse(document)).toEqual({
      mcpServers: { remote: { type: "http", url: "https://x/mcp" } },
    });
  });

  it("writes Copilot servers under the servers key", () => {
    // Given one stdio server
    const servers = parseMcpConfig({
      mcpServers: { docs: { type: "stdio", command: "server" } },
    });

    // When it is rendered for Copilot
    const document = mergeMcpConfigDocument({
      toolName: "copilot",
      servers,
      pluginPaths: PLUGIN_PATHS,
    }).content;

    // Then VS Code's top-level key is used instead of mcpServers
    expect(JSON.parse(document)).toEqual({
      servers: { docs: { type: "stdio", command: "server" } },
    });
  });

  it("omits the type discriminator for a Cursor remote server", () => {
    // Given a remote server rendered for Cursor, which infers transport from url
    const servers = parseMcpConfig({
      mcpServers: { remote: { type: "streamable-http", url: "https://x/mcp" } },
    });

    // When it is rendered
    const document = mergeMcpConfigDocument({
      toolName: "cursor",
      servers,
      pluginPaths: PLUGIN_PATHS,
    }).content;

    // Then no type field is emitted
    expect(JSON.parse(document)).toEqual({
      mcpServers: { remote: { url: "https://x/mcp" } },
    });
  });

  it("omits the type discriminator for Kiro, which does not document one", () => {
    // Given a stdio server rendered for Kiro
    const servers = parseMcpConfig({
      mcpServers: { docs: { type: "stdio", command: "server", args: ["--x"] } },
    });

    // When it is rendered
    const document = mergeMcpConfigDocument({
      toolName: "kiro",
      servers,
      pluginPaths: PLUGIN_PATHS,
    }).content;

    // Then only the fields Kiro documents are written
    expect(JSON.parse(document)).toEqual({
      mcpServers: { docs: { command: "server", args: ["--x"] } },
    });
  });

  it("expands plugin placeholders in arguments, environment values, and cwd", () => {
    // Given a server referencing both specification placeholders
    const servers = parseMcpConfig({
      mcpServers: {
        docs: {
          type: "stdio",
          command: "server",
          args: ["--root", "${PLUGIN_ROOT}/data"],
          env: { CACHE: "${PLUGIN_DATA}/cache" },
          cwd: "${PLUGIN_ROOT}",
        },
      },
    });

    // When it is rendered
    const document = mergeMcpConfigDocument({
      toolName: "claude-code",
      servers,
      pluginPaths: PLUGIN_PATHS,
    }).content;

    // Then each placeholder is replaced with the absolute path Skul assigns
    expect(JSON.parse(document).mcpServers.docs).toEqual({
      type: "stdio",
      command: "server",
      args: ["--root", `${PLUGIN_PATHS.pluginRoot}/data`],
      env: { CACHE: `${PLUGIN_PATHS.pluginData}/cache` },
      cwd: PLUGIN_PATHS.pluginRoot,
    });
  });

  it("leaves the command untouched so it stays a single executable token", () => {
    // Given a command that itself looks like a placeholder reference
    const servers = parseMcpConfig({
      mcpServers: {
        docs: { type: "stdio", command: "${PLUGIN_ROOT}/bin/server" },
      },
    });

    // When it is rendered
    const document = mergeMcpConfigDocument({
      toolName: "claude-code",
      servers,
      pluginPaths: PLUGIN_PATHS,
    }).content;

    // Then the command is emitted verbatim, as the specification requires
    expect(JSON.parse(document).mcpServers.docs.command).toBe(
      "${PLUGIN_ROOT}/bin/server",
    );
  });

  it("fails loudly when a bundle uses ${PLUGIN_DATA} but no data directory is available", () => {
    // Given a server referencing the data placeholder
    const servers = parseMcpConfig({
      mcpServers: {
        docs: { type: "stdio", command: "server", args: ["${PLUGIN_DATA}"] },
      },
    });

    // When it is rendered without a data directory / Then rendering is refused
    expect(() =>
      mergeMcpConfigDocument({
        toolName: "claude-code",
        servers,
        pluginPaths: { pluginRoot: PLUGIN_PATHS.pluginRoot },
      }),
    ).toThrow("${PLUGIN_DATA} is not available");
  });

  it("refuses to render for a tool with no known MCP configuration", () => {
    // Given a tool Skul has no MCP dialect for
    const servers = parseMcpConfig({
      mcpServers: { docs: { type: "stdio", command: "server" } },
    });

    // When it is rendered for that tool / Then the tool is named in the error
    expect(() =>
      mergeMcpConfigDocument({
        toolName: "codex",
        servers,
        pluginPaths: PLUGIN_PATHS,
      }),
    ).toThrow("Tool does not support MCP servers: codex");
  });
});

describe("MCP dialect coverage", () => {
  it("knows a dialect for exactly the tools that declare an MCP target", () => {
    // Given the tools whose layout declares where MCP configuration lives
    const toolsWithMcpTarget = listToolDefinitions()
      .filter((definition) => definition.targets.mcp)
      .map((definition) => definition.name);

    // When each is checked against the rendering dialects
    const toolsWithDialect = toolsWithMcpTarget.filter(supportsMcpConfig);

    // Then the two sets agree, so no tool can be given a path without a dialect
    expect(toolsWithDialect).toEqual(toolsWithMcpTarget);
    expect(toolsWithMcpTarget.length).toBeGreaterThan(0);
  });

  it("declares no MCP target for tools it cannot render configuration for", () => {
    // Given every supported tool
    const toolsWithoutDialect = listToolDefinitions().filter(
      (definition) => !supportsMcpConfig(definition.name),
    );

    // When their targets are inspected / Then none claims an MCP location
    expect(
      toolsWithoutDialect.filter((definition) => definition.targets.mcp),
    ).toEqual([]);
  });
});

describe("supportsMcpConfig", () => {
  it.each([
    ["claude-code", true],
    ["cursor", true],
    ["copilot", true],
    ["kiro", true],
    ["codex", false],
    ["opencode", true],
    ["antigravity", false],
  ] as const)("reports %s as %s", (toolName, expected) => {
    // Given / When / Then
    expect(supportsMcpConfig(toolName)).toBe(expected);
  });
});

describe("MCP_CONFIG_FILE_NAME", () => {
  it("matches the bundle-root file name the specification defines", () => {
    // Given / When / Then
    expect(MCP_CONFIG_FILE_NAME).toBe("mcp.json");
  });
});
