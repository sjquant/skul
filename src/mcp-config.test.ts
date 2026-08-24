import { describe, expect, it } from "vitest";

import {
  extractMcpOverlay,
  globalMcpCapableToolNames,
  mergeMcpConfigDocument,
  mergeRenderedMcpServers,
  parseMcpConfig,
  subtractMcpConfigServers,
  supportsMcpConfig,
} from "./mcp-config";
import {
  listGlobalToolDefinitions,
  listToolDefinitions,
  type ToolName,
} from "./tool-mapping";

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
    // Given a name that is not one of the supported tools. Every supported tool
    // now has a dialect, so only a name the type system would have rejected can
    // reach this guard; the cast stands in for a caller that skipped that check.
    const servers = parseMcpConfig({
      mcpServers: { docs: { type: "stdio", command: "server" } },
    });

    // When it is rendered for that tool / Then the tool is named in the error
    expect(() =>
      mergeMcpConfigDocument({
        toolName: "gemini-cli" as ToolName,
        servers,
        pluginPaths: PLUGIN_PATHS,
      }),
    ).toThrow("Tool does not support MCP servers: gemini-cli");
  });
});

describe("dialect matrix", () => {
  const stdio = parseMcpConfig({
    mcpServers: {
      srv: {
        type: "stdio",
        command: "run",
        args: ["--root", "${PLUGIN_ROOT}/ref"],
        env: { TOKEN: "t" },
        cwd: "${PLUGIN_ROOT}",
      },
    },
  });
  const sse = parseMcpConfig({
    mcpServers: {
      srv: { type: "sse", url: "https://x/sse", headers: { "X-Key": "v" } },
    },
  });

  it.each([
    [
      "claude-code",
      "mcpServers",
      {
        type: "stdio",
        command: "run",
        args: ["--root", "/lib/ref"],
        env: { TOKEN: "t" },
        cwd: "/lib",
      },
      { type: "sse", url: "https://x/sse", headers: { "X-Key": "v" } },
    ],
    [
      "cursor",
      "mcpServers",
      {
        type: "stdio",
        command: "run",
        args: ["--root", "/lib/ref"],
        env: { TOKEN: "t" },
        cwd: "/lib",
      },
      { url: "https://x/sse", headers: { "X-Key": "v" } },
    ],
    [
      "copilot",
      "servers",
      {
        type: "stdio",
        command: "run",
        args: ["--root", "/lib/ref"],
        env: { TOKEN: "t" },
        cwd: "/lib",
      },
      { type: "sse", url: "https://x/sse", headers: { "X-Key": "v" } },
    ],
    [
      "copilot-cli",
      "mcpServers",
      {
        type: "local",
        command: "run",
        args: ["--root", "/lib/ref"],
        env: { TOKEN: "t" },
        cwd: "/lib",
        tools: ["*"],
      },
      {
        type: "sse",
        url: "https://x/sse",
        headers: { "X-Key": "v" },
        tools: ["*"],
      },
    ],
    [
      "kiro",
      "mcpServers",
      {
        command: "run",
        args: ["--root", "/lib/ref"],
        env: { TOKEN: "t" },
        cwd: "/lib",
      },
      { url: "https://x/sse", headers: { "X-Key": "v" } },
    ],
    [
      "opencode",
      "mcp",
      {
        type: "local",
        enabled: true,
        command: ["run", "--root", "/lib/ref"],
        environment: { TOKEN: "t" },
        cwd: "/lib",
      },
      {
        type: "remote",
        url: "https://x/sse",
        enabled: true,
        headers: { "X-Key": "v" },
      },
    ],
    [
      "antigravity",
      "mcpServers",
      {
        command: "run",
        args: ["--root", "/lib/ref"],
        env: { TOKEN: "t" },
        cwd: "/lib",
      },
      { serverUrl: "https://x/sse", headers: { "X-Key": "v" } },
    ],
  ] as const)("renders stdio and sse servers in %s's vocabulary", (toolName, serversKey, expectedStdio, expectedRemote) => {
    // Given a stdio server and an sse server
    const paths = { pluginRoot: "/lib", pluginData: "/data" };

    // When each is rendered for the tool
    const stdioDocument = JSON.parse(
      mergeMcpConfigDocument({ toolName, servers: stdio, pluginPaths: paths })
        .content,
    );
    const sseDocument = JSON.parse(
      mergeMcpConfigDocument({ toolName, servers: sse, pluginPaths: paths })
        .content,
    );

    // Then every field is spelled the way that tool documents
    expect(stdioDocument[serversKey].srv).toEqual(expectedStdio);
    expect(sseDocument[serversKey].srv).toEqual(expectedRemote);
  });

  it("renders a stdio server for Codex as a bare table with no type field", () => {
    // Given a stdio server rendered for Codex
    const content = mergeMcpConfigDocument({
      toolName: "codex",
      servers: stdio,
      pluginPaths: { pluginRoot: "/lib", pluginData: "/data" },
    }).content;

    // Then every field lands in Codex's own spelling, and none is invented
    expect(content).toContain("[mcp_servers.srv]");
    expect(content).toContain('command = "run"');
    expect(content).toContain('args = ["--root", "/lib/ref"]');
    expect(content).toContain('env = { TOKEN = "t" }');
    expect(content).toContain('cwd = "/lib"');
    expect(content).not.toContain("type =");
  });

  it("renders an sse server for Codex as a url table with http_headers", () => {
    // Given an sse server rendered for Codex
    const content = mergeMcpConfigDocument({
      toolName: "codex",
      servers: sse,
      pluginPaths: { pluginRoot: "/lib", pluginData: "/data" },
    }).content;

    // Then Codex's own header key is used
    expect(content).toContain('url = "https://x/sse"');
    expect(content).toContain('http_headers = { X-Key = "v" }');
  });
});

describe("server name collisions", () => {
  const docs = parseMcpConfig({
    mcpServers: { docs: { type: "stdio", command: "docs" } },
  });

  it.each([
    ["claude-code", "mcpServers"],
    ["cursor", "mcpServers"],
    ["copilot", "servers"],
    ["kiro", "mcpServers"],
    ["opencode", "mcp"],
  ] as const)("refuses to replace a server %s's configuration already declares", (toolName, serversKey) => {
    // Given a configuration that already declares the same server name
    const existingContent = JSON.stringify({
      [serversKey]: { docs: { command: "user-own" } },
    });

    // When a bundle would add it again / Then the collision is refused
    expect(() =>
      mergeMcpConfigDocument({
        toolName,
        servers: docs,
        pluginPaths: PLUGIN_PATHS,
        existingContent,
      }),
    ).toThrow('MCP server "docs" is already declared');
  });

  it("still overwrites a server this bundle already owns", () => {
    // Given a server the bundle previously wrote
    const existingContent = JSON.stringify({
      mcpServers: { docs: { type: "stdio", command: "stale" } },
    });

    // When the same bundle re-applies with itself named as owner
    const document = JSON.parse(
      mergeMcpConfigDocument({
        toolName: "claude-code",
        servers: docs,
        pluginPaths: PLUGIN_PATHS,
        existingContent,
        ownedServerNames: ["docs"],
      }).content,
    );

    // Then its own entry is refreshed rather than refused
    expect(document.mcpServers.docs.command).toBe("docs");
  });
});

describe("Codex TOML editing", () => {
  const codexServers = (name: string) =>
    parseMcpConfig({
      mcpServers: { [name]: { type: "stdio", command: name } },
    });

  it("accumulates servers from several bundles in one managed block", () => {
    // Given one bundle's servers already written
    const first = mergeMcpConfigDocument({
      toolName: "codex",
      servers: codexServers("a"),
      pluginPaths: PLUGIN_PATHS,
    }).content;

    // When a second bundle merges into the same file
    const both = mergeMcpConfigDocument({
      toolName: "codex",
      servers: codexServers("b"),
      pluginPaths: PLUGIN_PATHS,
      existingContent: first,
    }).content;

    // Then both tables live inside a single marked block
    expect(both).toContain("[mcp_servers.a]");
    expect(both).toContain("[mcp_servers.b]");
    expect(both.match(/SKUL:MCP BEGIN/g)).toHaveLength(1);
  });

  it("subtracts one bundle's table and keeps the other", () => {
    // Given a block holding two bundles' servers
    const first = mergeMcpConfigDocument({
      toolName: "codex",
      servers: codexServers("a"),
      pluginPaths: PLUGIN_PATHS,
    }).content;
    const both = mergeMcpConfigDocument({
      toolName: "codex",
      servers: codexServers("b"),
      pluginPaths: PLUGIN_PATHS,
      existingContent: first,
    }).content;

    // When one is subtracted
    const result = subtractMcpConfigServers({
      toolName: "codex",
      existingContent: both,
      serverNames: ["a"],
    });

    // Then only the other remains
    expect(result.emptied).toBe(false);
    expect(result.content).toContain("[mcp_servers.b]");
    expect(result.content).not.toContain("[mcp_servers.a]");
  });

  it("reports a file that held nothing but the managed block as emptied", () => {
    // Given a file Skul created entirely
    const content = mergeMcpConfigDocument({
      toolName: "codex",
      servers: codexServers("a"),
      pluginPaths: PLUGIN_PATHS,
    }).content;

    // When its only server is subtracted / Then nothing is left to keep
    expect(
      subtractMcpConfigServers({
        toolName: "codex",
        existingContent: content,
        serverNames: ["a"],
      }),
    ).toEqual({ content: "", emptied: true });
  });

  it("leaves text outside the managed block byte-for-byte intact", () => {
    // Given a hand-maintained config with comments
    const existing = '# keep me\nmodel = "gpt-5"  # inline\n';

    // When servers are merged and then subtracted again
    const merged = mergeMcpConfigDocument({
      toolName: "codex",
      servers: codexServers("a"),
      pluginPaths: PLUGIN_PATHS,
      existingContent: existing,
    }).content;
    const restored = subtractMcpConfigServers({
      toolName: "codex",
      existingContent: merged,
      serverNames: ["a"],
    });

    // Then the original text returns unchanged
    expect(restored.emptied).toBe(false);
    expect(restored.content).toBe(existing);
  });

  it("ignores an unrelated table whose name merely shares a prefix", () => {
    // Given a config declaring a longer, unrelated server name
    const existing = '[mcp_servers.docs-legacy]\ncommand = "other"\n';

    // When a bundle adds a server called "docs"
    const content = mergeMcpConfigDocument({
      toolName: "codex",
      servers: codexServers("docs"),
      pluginPaths: PLUGIN_PATHS,
      existingContent: existing,
    }).content;

    // Then it is not mistaken for a duplicate
    expect(content).toContain("[mcp_servers.docs]");
    expect(content).toContain("[mcp_servers.docs-legacy]");
  });

  it("refuses to create a table the config already declares", () => {
    // Given a config that already declares the same server name
    const existing = '[mcp_servers.docs]\ncommand = "user-own"\n';

    // When a bundle would add it again / Then the duplicate is refused
    expect(() =>
      mergeMcpConfigDocument({
        toolName: "codex",
        servers: codexServers("docs"),
        pluginPaths: PLUGIN_PATHS,
        existingContent: existing,
      }),
    ).toThrow('MCP server "docs" is already declared');
  });

  it("refuses a server name that cannot be written as a TOML key", () => {
    // Given a server name containing a quote
    const servers = parseMcpConfig({
      mcpServers: { 'bad"name': { type: "stdio", command: "x" } },
    });

    // When it is merged / Then the unsafe name is refused
    expect(() =>
      mergeMcpConfigDocument({
        toolName: "codex",
        servers,
        pluginPaths: PLUGIN_PATHS,
      }),
    ).toThrow("cannot be written to a TOML configuration");
  });

  it("escapes string values so quotes and backslashes survive", () => {
    // Given an environment value containing a quote and a backslash
    const servers = parseMcpConfig({
      mcpServers: {
        srv: {
          type: "stdio",
          command: "x",
          env: { TOKEN: 'a"b', WIN: "C:\\tmp" },
        },
      },
    });

    // When it is rendered for Codex
    const content = mergeMcpConfigDocument({
      toolName: "codex",
      servers,
      pluginPaths: PLUGIN_PATHS,
    }).content;

    // Then both characters are escaped in the emitted TOML
    expect(content).toContain('TOKEN = "a\\"b"');
    expect(content).toContain('WIN = "C:\\\\tmp"');
  });
});

describe("TOML table headers", () => {
  const docs = parseMcpConfig({
    mcpServers: { docs: { type: "stdio", command: "docs" } },
  });

  const mergeDocs = (existingContent: string) =>
    mergeMcpConfigDocument({
      toolName: "codex",
      servers: docs,
      pluginPaths: PLUGIN_PATHS,
      existingContent,
    });

  it.each([
    ["a bare header", "[mcp_servers.docs]"],
    ["a quoted name", '[mcp_servers."docs"]'],
    ["whitespace inside the brackets", "[ mcp_servers . docs ]"],
    ["a sub-table of the same server", "[mcp_servers.docs.env]"],
  ])("refuses a duplicate declared with %s", (_label, header) => {
    // Given a config declaring the same server in one of TOML's spellings
    const existing = `${header}\ncommand = "user-own"\n`;

    // When a bundle would add it again / Then the duplicate is refused
    expect(() => mergeDocs(existing)).toThrow(/"docs" is already declared/);
  });

  it.each([
    ["a longer name", "[mcp_servers.docs-legacy]"],
    ["a different prefix", "[other_servers.docs]"],
    ["an array of tables", "[[mcp_servers.docs]]"],
  ])("does not mistake %s for the same server", (_label, header) => {
    // Given a config declaring something that is not this server
    const existing = `${header}\ncommand = "other"\n`;

    // When a bundle adds "docs" / Then it is written alongside
    const content = mergeDocs(existing).content;
    expect(content).toContain("[mcp_servers.docs]");
    expect(content).toContain(header);
  });
});

describe("extractMcpOverlay", () => {
  const overlay = { docs: { command: "docs-server" } };

  it("returns the stored overlay unchanged when a JSON document still declares it", () => {
    // Given a document holding the overlay's server plus the user's own
    const content = JSON.stringify({
      mcpServers: { mine: { command: "m" }, ...overlay },
    });

    // When the overlay is read back
    const extracted = extractMcpOverlay({
      toolName: "claude-code",
      content,
      overlay,
    });

    // Then it matches the stored text, so a fingerprint comparison holds
    expect(extracted).toBe(JSON.stringify(overlay));
  });

  it("returns null when a JSON document no longer declares the server", () => {
    // Given a document the user removed Skul's server from
    const content = JSON.stringify({ mcpServers: { mine: { command: "m" } } });

    // When the overlay is read back / Then it reports the shadow inactive
    expect(
      extractMcpOverlay({ toolName: "claude-code", content, overlay }),
    ).toBeNull();
  });

  it("reports a changed JSON declaration as different from the stored overlay", () => {
    // Given a document whose copy of the server was edited
    const content = JSON.stringify({ mcpServers: { docs: { command: "x" } } });

    // When the overlay is read back / Then it no longer matches
    expect(
      extractMcpOverlay({ toolName: "claude-code", content, overlay }),
    ).not.toBe(JSON.stringify(overlay));
  });

  it("returns null for a JSON document that no longer parses", () => {
    // Given a document the user broke
    // When the overlay is read back / Then no overlay is claimed
    expect(
      extractMcpOverlay({
        toolName: "claude-code",
        content: "{ broken",
        overlay,
      }),
    ).toBeNull();
  });

  it("round-trips a Codex managed block back to the stored overlay", () => {
    // Given a Codex config Skul merged the overlay into
    const content = mergeRenderedMcpServers({
      toolName: "codex",
      renderedServers: overlay,
      existingContent: '# user comment\nmodel = "gpt-5"\n',
    }).content;

    // When the overlay is read back / Then it matches the stored text
    expect(extractMcpOverlay({ toolName: "codex", content, overlay })).toBe(
      JSON.stringify(overlay),
    );
  });

  it("returns null when a Codex managed block no longer holds the server", () => {
    // Given a Codex config with nothing of Skul's in it
    // When the overlay is read back / Then it reports the shadow inactive
    expect(
      extractMcpOverlay({
        toolName: "codex",
        content: 'model = "gpt-5"\n',
        overlay,
      }),
    ).toBeNull();
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

  it("can write globally for exactly the tools the global layout gives a location", () => {
    // Given the tools whose global layout declares where MCP configuration lives
    const globalToolsWithMcpTarget = listGlobalToolDefinitions()
      .filter((definition) => definition.targets.mcp)
      .map((definition) => definition.name);

    // When those are compared with the tools a global install writes for
    // Then no tool can be given a global path Skul has no dialect for, which
    // would otherwise be reported as both skipped and supported at once
    expect(globalMcpCapableToolNames()).toEqual(globalToolsWithMcpTarget);
    expect(globalToolsWithMcpTarget.length).toBeGreaterThan(0);
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
