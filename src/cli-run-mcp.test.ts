import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createHomeDir,
  createPromptClientStub,
  createRepository,
  pathExists,
  runGit,
  writeBundleFile,
} from "./cli.test-support";
import { run } from "./index";

const SOURCE = "github.com/acme/bundles";
const BUNDLE = "mcp-bundle";

const MCP_CONFIG = {
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: {
    docs: {
      type: "stdio",
      command: "docs-server",
      args: ["--root", "${PLUGIN_ROOT}/reference"],
      env: { CACHE_DIR: "${PLUGIN_DATA}/cache" },
    },
    remote: {
      type: "streamable-http",
      url: "https://example.com/mcp",
    },
  },
};

function writeMcpBundle(homeDir: string, config: object = MCP_CONFIG): void {
  writeBundleFile(
    homeDir,
    SOURCE,
    BUNDLE,
    "mcp.json",
    JSON.stringify(config, null, 2),
  );
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readMcpServers(
  filePath: string,
): Record<string, Record<string, unknown>> {
  const document = readJson(filePath) as {
    mcpServers?: Record<string, Record<string, unknown>>;
  };

  return document.mcpServers ?? {};
}

describe("skul add with an Agent Plugins mcp.json", () => {
  it("materializes each supported tool's MCP configuration in its own location", async () => {
    // Given a cached bundle whose only content is an Agent Plugins mcp.json
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);

    // When the bundle is added
    await run(["add", SOURCE, BUNDLE, "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then every tool with a known MCP location receives a configuration file
    expect(pathExists(path.join(cwd, ".mcp.json"))).toBe(true);
    expect(pathExists(path.join(cwd, ".cursor", "mcp.json"))).toBe(true);
    expect(pathExists(path.join(cwd, ".vscode", "mcp.json"))).toBe(true);
    expect(pathExists(path.join(cwd, ".kiro", "settings", "mcp.json"))).toBe(
      true,
    );
  });

  it("writes each tool's own server key and transport spelling", async () => {
    // Given a bundle declaring a stdio and a streamable-http server
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);

    // When the bundle is added
    await run(["add", SOURCE, BUNDLE, "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then Claude Code gets mcpServers with the http transport name it understands
    expect(readJson(path.join(cwd, ".mcp.json"))).toMatchObject({
      mcpServers: { remote: { type: "http", url: "https://example.com/mcp" } },
    });
    // And Copilot gets the servers key VS Code expects
    expect(readJson(path.join(cwd, ".vscode", "mcp.json"))).toMatchObject({
      servers: { remote: { type: "http", url: "https://example.com/mcp" } },
    });
  });

  it("expands plugin placeholders to absolute paths under the Skul state directory", async () => {
    // Given a bundle whose server references ${PLUGIN_ROOT} and ${PLUGIN_DATA}
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);

    // When the bundle is added
    await run(["add", SOURCE, BUNDLE, "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then both placeholders resolve to the bundle's cache and data directories
    const docs = readMcpServers(path.join(cwd, ".mcp.json")).docs!;
    expect(docs.args).toEqual([
      "--root",
      path.join(
        homeDir,
        ".skul",
        "library",
        ...SOURCE.split("/"),
        BUNDLE,
        "reference",
      ),
    ]);
    expect(docs.env).toEqual({
      CACHE_DIR: path.join(
        homeDir,
        ".skul",
        "data",
        ...SOURCE.split("/"),
        BUNDLE,
        "cache",
      ),
    });
  });

  it("writes only the selected tool's configuration when an agent is targeted", async () => {
    // Given a cached MCP bundle
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);

    // When it is added for Cursor only
    await run(["add", SOURCE, BUNDLE, "--agent", "cursor", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then no other tool's MCP configuration is created
    expect(pathExists(path.join(cwd, ".cursor", "mcp.json"))).toBe(true);
    expect(pathExists(path.join(cwd, ".mcp.json"))).toBe(false);
    expect(pathExists(path.join(cwd, ".vscode", "mcp.json"))).toBe(false);
  });

  it("installs MCP servers without skills when only the mcp item is included", async () => {
    // Given a bundle carrying both a skill and MCP servers
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    writeBundleFile(
      homeDir,
      SOURCE,
      BUNDLE,
      "skills/review/SKILL.md",
      "---\nname: review\ndescription: Review code\n---\n\nReview.\n",
    );

    // When only the mcp item is requested
    await run(
      [
        "add",
        SOURCE,
        BUNDLE,
        "--agent",
        "claude-code",
        "--include",
        "mcp",
        "-y",
      ],
      { homeDir, cwd, prompts: createPromptClientStub() },
    );

    // Then the MCP configuration lands but the skill does not
    expect(pathExists(path.join(cwd, ".mcp.json"))).toBe(true);
    expect(pathExists(path.join(cwd, ".claude", "skills", "review"))).toBe(
      false,
    );
  });

  it("leaves MCP servers out when another item is the only one included", async () => {
    // Given a bundle carrying both a skill and MCP servers
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    writeBundleFile(
      homeDir,
      SOURCE,
      BUNDLE,
      "skills/review/SKILL.md",
      "---\nname: review\ndescription: Review code\n---\n\nReview.\n",
    );

    // When only the skill is requested
    await run(
      [
        "add",
        SOURCE,
        BUNDLE,
        "--agent",
        "claude-code",
        "--include",
        "skills/review",
        "-y",
      ],
      { homeDir, cwd, prompts: createPromptClientStub() },
    );

    // Then no MCP configuration is written
    expect(pathExists(path.join(cwd, ".mcp.json"))).toBe(false);
  });

  it("removes the MCP configuration it created when the bundle is removed", async () => {
    // Given an added MCP bundle
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // When the bundle is removed
    await run(["remove", BUNDLE, "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the managed configuration file is gone
    expect(pathExists(path.join(cwd, ".mcp.json"))).toBe(false);
  });

  it("keeps servers the project already had alongside the bundle's own", async () => {
    // Given a project that hand-wrote its own MCP server
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { mine: { command: "mine" } } }),
    );

    // When a bundle targeting the same file is added
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then both the hand-written and the bundle's servers are present
    const servers = readMcpServers(path.join(cwd, ".mcp.json"));
    expect(Object.keys(servers).sort()).toEqual(["docs", "mine", "remote"]);
  });

  it("restores the hand-written configuration when the bundle is removed", async () => {
    // Given a project whose own server sits beside an added bundle's servers
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { mine: { command: "mine" } } }),
    );
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // When the bundle is removed
    await run(["remove", BUNDLE, "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then only the user's own server remains, and the file survives
    expect(readMcpServers(path.join(cwd, ".mcp.json"))).toEqual({
      mine: { command: "mine" },
    });
  });

  it("keeps each bundle's servers independent in the shared file", async () => {
    // Given two bundles that both target Claude Code's single MCP file
    const homeDir = createHomeDir();
    const cwd = createRepository();
    for (const bundle of ["first", "second"]) {
      writeBundleFile(
        homeDir,
        SOURCE,
        bundle,
        "mcp.json",
        JSON.stringify({
          mcpServers: { [bundle]: { type: "stdio", command: bundle } },
        }),
      );
      await run(["add", SOURCE, bundle, "--agent", "claude-code", "-y"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      });
    }

    // Then both bundles' servers coexist
    expect(
      Object.keys(readMcpServers(path.join(cwd, ".mcp.json"))).sort(),
    ).toEqual(["first", "second"]);

    // When the first bundle is removed
    await run(["remove", "first", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then only its own server is subtracted
    expect(readMcpServers(path.join(cwd, ".mcp.json"))).toEqual({
      second: { type: "stdio", command: "second" },
    });
  });

  it("preserves unrelated OpenCode settings sharing the config file", async () => {
    // Given an opencode.json holding model and theme settings
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    fs.writeFileSync(
      path.join(cwd, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "anthropic/claude-opus-4",
        theme: "tokyonight",
      }),
    );

    // When a bundle's MCP servers are added for OpenCode
    await run(["add", SOURCE, BUNDLE, "--agent", "opencode", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the unrelated settings survive beside the new mcp block
    const document = readJson(path.join(cwd, "opencode.json")) as Record<
      string,
      unknown
    >;
    expect(document.model).toBe("anthropic/claude-opus-4");
    expect(document.theme).toBe("tokyonight");
    expect(document.mcp).toHaveProperty("docs");
  });

  it("leaves OpenCode's own settings behind after the bundle is removed", async () => {
    // Given OpenCode settings that predate the bundle
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    fs.writeFileSync(
      path.join(cwd, "opencode.json"),
      JSON.stringify({ model: "anthropic/claude-opus-4" }),
    );
    await run(["add", SOURCE, BUNDLE, "--agent", "opencode", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // When the bundle is removed
    await run(["remove", BUNDLE, "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the file remains with the user's settings and no mcp block
    expect(readJson(path.join(cwd, "opencode.json"))).toEqual({
      model: "anthropic/claude-opus-4",
    });
  });

  it("translates a stdio server into OpenCode's local command array", async () => {
    // Given a bundle declaring a stdio server with arguments
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);

    // When it is added for OpenCode
    await run(["add", SOURCE, BUNDLE, "--agent", "opencode", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then command and args become one array under OpenCode's local type
    const document = readJson(path.join(cwd, "opencode.json")) as {
      mcp: Record<string, Record<string, unknown>>;
    };
    expect(document.mcp.docs).toMatchObject({
      type: "local",
      enabled: true,
      command: [
        "docs-server",
        "--root",
        path.join(
          homeDir,
          ".skul",
          "library",
          ...SOURCE.split("/"),
          BUNDLE,
          "reference",
        ),
      ],
    });
    expect(document.mcp.remote).toMatchObject({
      type: "remote",
      url: "https://example.com/mcp",
    });
  });

  it("removes one bundle without prompting about another bundle's merge", async () => {
    // Given two bundles sharing Claude Code's MCP file
    const homeDir = createHomeDir();
    const cwd = createRepository();
    for (const bundle of ["first", "second"]) {
      writeBundleFile(
        homeDir,
        SOURCE,
        bundle,
        "mcp.json",
        JSON.stringify({
          mcpServers: { [bundle]: { type: "stdio", command: bundle } },
        }),
      );
      await run(["add", SOURCE, bundle, "--agent", "claude-code", "-y"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      });
    }
    const prompted: string[] = [];

    // When the first is removed without auto-approval
    await run(["remove", "first"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub({
        confirmManagedFileRemoval: async (conflictPath) => {
          prompted.push(conflictPath);
          return true;
        },
      }),
    });

    // Then the second bundle's merge is not mistaken for tampering
    expect(prompted).toEqual([]);
    expect(readMcpServers(path.join(cwd, ".mcp.json"))).toHaveProperty(
      "second",
    );
  });

  it("refuses to merge into an MCP configuration that is not valid JSON", async () => {
    // Given a project whose existing MCP configuration is corrupt
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    fs.writeFileSync(path.join(cwd, ".mcp.json"), "{ broken");

    // When a bundle is added / Then Skul refuses rather than discarding the file
    await expect(
      run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      }),
    ).rejects.toThrowError(
      /Existing claude-code MCP configuration is not valid JSON/,
    );
    expect(fs.readFileSync(path.join(cwd, ".mcp.json"), "utf8")).toBe(
      "{ broken",
    );
  });

  it("refuses to merge into a Git-tracked MCP configuration", async () => {
    // Given an MCP configuration that the repository commits
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    const committed = JSON.stringify({
      mcpServers: { mine: { command: "m" } },
    });
    fs.writeFileSync(path.join(cwd, ".mcp.json"), committed);
    runGit(cwd, ["add", ".mcp.json"]);
    runGit(cwd, ["commit", "-m", "add mcp config"]);

    // When a bundle targeting that file is added / Then Skul refuses
    await expect(
      run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      }),
    ).rejects.toThrowError(/\.mcp\.json is tracked by Git/);

    // And the committed file is left exactly as it was
    expect(fs.readFileSync(path.join(cwd, ".mcp.json"), "utf8")).toBe(
      committed,
    );
  });

  it("skips MCP configuration entirely for a global install", async () => {
    // Given a cached MCP bundle and a home directory used as the global root
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    writeBundleFile(
      homeDir,
      SOURCE,
      BUNDLE,
      "skills/review/SKILL.md",
      "---\nname: review\ndescription: Review code\n---\n\nReview.\n",
    );

    // When the bundle is installed globally
    await run(
      ["add", SOURCE, BUNDLE, "--global", "--agent", "claude-code", "-y"],
      {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      },
    );

    // Then the skill is materialized but no MCP configuration is written under home
    expect(pathExists(path.join(homeDir, ".claude", "skills", "review"))).toBe(
      true,
    );
    expect(pathExists(path.join(homeDir, ".mcp.json"))).toBe(false);
  });

  it("reports the offending server when the bundle's mcp.json is invalid", async () => {
    // Given a bundle whose mcp.json declares an unsupported transport
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir, {
      mcpServers: { bad: { type: "websocket", url: "ws://example.com" } },
    });

    // When the bundle is added / Then the failure names the invalid field
    await expect(
      run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      }),
    ).rejects.toThrowError(/mcpServers\.bad\.type/);
  });

  it("names the source file when the bundle's mcp.json is not valid JSON", async () => {
    // Given a bundle whose mcp.json is truncated
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeBundleFile(homeDir, SOURCE, BUNDLE, "mcp.json", '{"mcpServers":');

    // When the bundle is added / Then the failure identifies the offending file
    await expect(
      run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      }),
    ).rejects.toThrowError(/Invalid mcp\.json/);
  });

  it("keeps a native .mcp.json in the bundle scoped to Claude Code", async () => {
    // Given a bundle that pre-authored Claude Code's native MCP file
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeBundleFile(
      homeDir,
      SOURCE,
      BUNDLE,
      ".mcp.json",
      JSON.stringify({
        mcpServers: { docs: { type: "stdio", command: "docs-server" } },
      }),
    );

    // When the bundle is added
    await run(["add", SOURCE, BUNDLE, "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then only Claude Code's configuration is materialized
    expect(pathExists(path.join(cwd, ".mcp.json"))).toBe(true);
    expect(pathExists(path.join(cwd, ".cursor", "mcp.json"))).toBe(false);
  });

  it("hides the materialized MCP configuration from Git status", async () => {
    // Given an added MCP bundle in a repository
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // When the exclude file is read
    const excludeFile = fs.readFileSync(
      path.join(cwd, ".git", "info", "exclude"),
      "utf8",
    );

    // Then the managed configuration path is excluded
    expect(excludeFile).toContain(".mcp.json");
  });
});
