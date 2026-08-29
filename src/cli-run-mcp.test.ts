import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  createHomeDir,
  createLinkedWorktree,
  createPromptClientStub,
  createRepository,
  pathExists,
  runGit,
  writeBundleFile,
  writeManifest,
} from "./cli.test-support";
import { run } from "./index";
import { readRegistryFile } from "./registry";
import { listToolDefinitions } from "./tool-mapping";

const SOURCE = "github.com/acme/bundles";
const BUNDLE = "mcp-bundle";

/** Prefix of the note naming the tools a global install cannot place MCP servers for. */
const MCP_SKIP_NOTE = "MCP servers were skipped";

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

function writeMcpBundleWithSkill(homeDir: string): void {
  writeManifest(homeDir, SOURCE, BUNDLE, {
    name: BUNDLE,
    tools: {
      "claude-code": {
        skills: { path: ".claude/skills" },
        mcp: { path: "mcp.json" },
      },
    },
  });
  writeMcpBundle(homeDir);
  writeBundleFile(
    homeDir,
    SOURCE,
    BUNDLE,
    ".claude/skills/guide/SKILL.md",
    "# guide\n",
  );
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/** Runs an action with `console.warn` captured, returning everything it wrote. */
async function captureWarnings(
  action: () => Promise<unknown>,
): Promise<string> {
  const warnings: string[] = [];
  const spy = vi
    .spyOn(console, "warn")
    .mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });

  try {
    await action();
  } finally {
    spy.mockRestore();
  }

  return warnings.join("\n");
}

async function runWithoutConsoleWarnings(
  action: () => Promise<string>,
): Promise<string> {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

  try {
    const output = await action();
    expect(spy).not.toHaveBeenCalled();
    return output;
  } finally {
    spy.mockRestore();
  }
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
    const mcpPaths = listToolDefinitions()
      .map((definition) => definition.targets.mcp?.path)
      .filter((mcpPath): mcpPath is string => mcpPath !== undefined);
    expect(mcpPaths.length).toBeGreaterThan(0);
    expect(
      mcpPaths.filter(
        (mcpPath) => !pathExists(path.join(cwd, ...mcpPath.split("/"))),
      ),
    ).toEqual([]);
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
    // And Copilot gets the tool allowlist the Agent Host expects
    expect(readJson(path.join(cwd, ".github", "mcp.json"))).toMatchObject({
      mcpServers: {
        remote: {
          type: "http",
          url: "https://example.com/mcp",
          tools: ["*"],
        },
      },
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

  it("leaves a restricted configuration's permissions alone when merging into it", async () => {
    // Given an MCP configuration the user restricted to their own account
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    const configFile = path.join(cwd, ".mcp.json");
    fs.writeFileSync(
      configFile,
      JSON.stringify({ mcpServers: { mine: { command: "mine" } } }),
    );
    fs.chmodSync(configFile, 0o600);

    // When a bundle merges its servers into it
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the replaced file still carries the mode the user set
    expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);
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

    // When the remaining bundle is removed
    await run(["remove", "second", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the file Skul originally created is deleted instead of left empty
    expect(pathExists(path.join(cwd, ".mcp.json"))).toBe(false);
  });

  it("deletes a globally created shared MCP file after its bundles are removed in order", async () => {
    // Given two global bundles sharing a configuration file created by the first
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
      await run(
        ["add", SOURCE, bundle, "--global", "--agent", "claude-code", "-y"],
        {
          homeDir,
          cwd,
          prompts: createPromptClientStub(),
        },
      );
    }

    // When the creator is removed before the remaining bundle
    await run(["remove", "--global", "first", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });
    expect(pathExists(path.join(homeDir, ".claude.json"))).toBe(true);
    expect(readMcpServers(path.join(homeDir, ".claude.json"))).toEqual({
      second: { type: "stdio", command: "second" },
    });

    // And then the final bundle is removed
    await run(["remove", "--global", "second", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the global file Skul originally created is deleted
    expect(pathExists(path.join(homeDir, ".claude.json"))).toBe(false);
  });

  it("reports a final shared MCP file in a dry run after its creator is removed", async () => {
    // Given two bundles sharing a project MCP file created by the first
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
    await run(["remove", "first", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // When the final bundle is inspected without changing files
    const output = await run(["remove", "second", "--dry-run"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the dry run names the shared file that actual removal will delete
    expect(output).toContain("Would remove second (1 file(s))");
    expect(output).toContain(".mcp.json");
    expect(pathExists(path.join(cwd, ".mcp.json"))).toBe(true);
  });

  it("preserves a pre-existing empty global MCP configuration after removal", async () => {
    // Given an empty global configuration that predates Skul
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    fs.writeFileSync(path.join(homeDir, ".claude.json"), "{}\n");

    // When a bundle is installed and then removed globally
    await run(
      ["add", SOURCE, BUNDLE, "--global", "--agent", "claude-code", "-y"],
      {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      },
    );
    await run(["remove", "--global", BUNDLE, "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the user's empty file remains
    expect(pathExists(path.join(homeDir, ".claude.json"))).toBe(true);
    expect(readJson(path.join(homeDir, ".claude.json"))).toEqual({});
  });

  it("deletes nested MCP directories after global shared bundles are removed", async () => {
    // Given two global Codex bundles sharing a configuration created by the first
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
      await run(["add", SOURCE, bundle, "--global", "--agent", "codex", "-y"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      });
    }

    // When the creator and then the remaining bundle are removed
    await run(["remove", "--global", "first", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });
    expect(pathExists(path.join(homeDir, ".codex"))).toBe(true);
    await run(["remove", "--global", "second", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then both the configuration and its Skul-created parent directory are gone
    expect(pathExists(path.join(homeDir, ".codex", "config.toml"))).toBe(false);
    expect(pathExists(path.join(homeDir, ".codex"))).toBe(false);
  });

  it("removes an MCP-created parent directory after a later bundle releases its last file", async () => {
    // Given a global Codex MCP file and a later bundle that adds an agent below
    // the same Skul-created parent directory
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeManifest(homeDir, SOURCE, "first", {
      name: "first",
      tools: { codex: { mcp: { path: "mcp.json" } } },
    });
    writeBundleFile(
      homeDir,
      SOURCE,
      "first",
      "mcp.json",
      JSON.stringify({
        mcpServers: { first: { type: "stdio", command: "first" } },
      }),
    );
    writeManifest(homeDir, SOURCE, "second", {
      name: "second",
      tools: { codex: { agents: { path: "agents" } } },
    });
    writeBundleFile(
      homeDir,
      SOURCE,
      "second",
      "agents/reviewer.md",
      "---\nname: reviewer\ndescription: Review changes\n---\n\n# reviewer\n",
    );

    await run(["add", SOURCE, "first", "--global", "--agent", "codex", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });
    await run(["add", SOURCE, "second", "--global", "--agent", "codex", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // When the MCP-owning bundle is removed first
    await run(["remove", "--global", "first", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });
    expect(pathExists(path.join(homeDir, ".codex"))).toBe(true);

    // And then the later bundle releases its final file
    await run(["remove", "--global", "second", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the parent directory created for the MCP file is removed too
    expect(pathExists(path.join(homeDir, ".codex"))).toBe(false);
  });

  it("deletes a created shared MCP file when worktree remove --all is used", async () => {
    // Given two project bundles sharing a configuration created by the first
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

    // When all bundles are removed at once
    await run(["remove", "--all", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the created shared file is deleted
    expect(pathExists(path.join(cwd, ".mcp.json"))).toBe(false);
  });

  it("deletes a created shared MCP file when worktree reset is used", async () => {
    // Given two project bundles sharing a configuration created by the first
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

    // When all worktree materialization is reset
    await run(["reset", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the created shared file is deleted
    expect(pathExists(path.join(cwd, ".mcp.json"))).toBe(false);
  });

  it("preserves created MCP ownership when apply materializes a linked worktree", async () => {
    // Given two desired bundles sharing a project MCP file
    const homeDir = createHomeDir();
    const mainWorktree = createRepository();
    const linkedWorktree = createLinkedWorktree(mainWorktree);
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
        cwd: mainWorktree,
        prompts: createPromptClientStub(),
      });
    }

    // When the linked worktree materializes both desired bundles
    await run(["apply"], { homeDir, cwd: linkedWorktree });
    await run(["remove", "first", "-y"], {
      homeDir,
      cwd: linkedWorktree,
      prompts: createPromptClientStub(),
    });
    await run(["remove", "second", "-y"], {
      homeDir,
      cwd: linkedWorktree,
      prompts: createPromptClientStub(),
    });

    // Then final removal still deletes the file created during apply
    expect(pathExists(path.join(linkedWorktree, ".mcp.json"))).toBe(false);
  });

  it("deletes a created shared MCP file when global reset is used", async () => {
    // Given two global bundles sharing a configuration created by the first
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
      await run(
        ["add", SOURCE, bundle, "--global", "--agent", "claude-code", "-y"],
        {
          homeDir,
          cwd,
          prompts: createPromptClientStub(),
        },
      );
    }

    // When the global installation is reset
    await run(["reset", "--global", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the created shared file is deleted
    expect(pathExists(path.join(homeDir, ".claude.json"))).toBe(false);
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

  it("appends a marked block to Codex's TOML config, preserving what is there", async () => {
    // Given a hand-maintained Codex config with comments and a user's own server
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    const existing = [
      "# hand-maintained settings",
      'model = "gpt-5"   # inline comment',
      "",
      "[mcp_servers.mine]",
      'command = "my-server"',
      "",
    ].join("\n");
    fs.mkdirSync(path.join(cwd, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".codex", "config.toml"), existing);

    // When the bundle is added for Codex
    await run(["add", SOURCE, BUNDLE, "--agent", "codex", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the original text survives byte-for-byte above a marked block
    const merged = fs.readFileSync(
      path.join(cwd, ".codex", "config.toml"),
      "utf8",
    );
    expect(merged.startsWith(existing.trimEnd())).toBe(true);
    expect(merged).toContain("# >>> SKUL:MCP BEGIN");
    expect(merged).toContain("[mcp_servers.docs]");
    expect(merged).toContain('url = "https://example.com/mcp"');
  });

  it("restores Codex's config exactly when the bundle is removed", async () => {
    // Given a Codex config that predates the bundle
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    const existing =
      '# keep me\nmodel = "gpt-5"\n\n[mcp_servers.mine]\ncommand = "my-server"\n';
    fs.mkdirSync(path.join(cwd, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".codex", "config.toml"), existing);
    await run(["add", SOURCE, BUNDLE, "--agent", "codex", "-y"], {
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

    // Then the file is back to its original content, comments included
    expect(
      fs.readFileSync(path.join(cwd, ".codex", "config.toml"), "utf8"),
    ).toBe(existing);
  });

  it("refuses when Codex already declares a server of the same name", async () => {
    // Given a Codex config that already declares a "docs" server
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    fs.mkdirSync(path.join(cwd, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".codex", "config.toml"),
      '[mcp_servers.docs]\ncommand = "user-own"\n',
    );

    // When the bundle is added / Then Skul refuses rather than writing a
    // duplicate table, which would make the whole config unparseable
    await expect(
      run(["add", SOURCE, BUNDLE, "--agent", "codex", "-y"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      }),
    ).rejects.toThrowError(/"docs" is already declared/);
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
      /Existing MCP configuration \.mcp\.json is not valid JSON/,
    );
    expect(fs.readFileSync(path.join(cwd, ".mcp.json"), "utf8")).toBe(
      "{ broken",
    );
  });

  it("shadows a Git-tracked MCP configuration instead of dirtying the worktree", async () => {
    // Given an MCP configuration the repository commits
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { mine: { command: "m" } } }, null, 2)}\n`,
    );
    runGit(cwd, ["add", ".mcp.json"]);
    runGit(cwd, ["commit", "-m", "add mcp config"]);

    // When a bundle targeting that file is added
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the servers are present on disk beside the committed one
    const servers = readMcpServers(path.join(cwd, ".mcp.json"));
    expect(Object.keys(servers).sort()).toEqual(["docs", "mine", "remote"]);

    // And Git still reports a clean worktree
    expect(runGit(cwd, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("refuses a second bundle shadowing the same tracked MCP configuration", async () => {
    // Given a committed MCP config already shadowed by one bundle
    const homeDir = createHomeDir();
    const cwd = createRepository();
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { mine: { command: "m" } } }, null, 2)}\n`,
    );
    runGit(cwd, ["add", ".mcp.json"]);
    runGit(cwd, ["commit", "-m", "add mcp config"]);
    for (const bundle of ["one", "two"]) {
      writeBundleFile(
        homeDir,
        SOURCE,
        bundle,
        "mcp.json",
        JSON.stringify({
          mcpServers: { [bundle]: { type: "stdio", command: bundle } },
        }),
      );
    }
    await run(["add", SOURCE, "one", "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // When a second bundle would shadow the same file / Then it is refused,
    // because a shadow renders one bundle's overlay onto committed content
    await expect(
      run(["add", SOURCE, "two", "--agent", "claude-code", "-y"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      }),
    ).rejects.toThrowError(/already shadowed by one/);

    // And the first bundle's servers are still in place
    expect(readMcpServers(path.join(cwd, ".mcp.json"))).toHaveProperty("one");
  });

  it("suspends and refreshes a shadowed MCP configuration around a HEAD change", async () => {
    // Given a shadowed MCP configuration
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    const committed = `${JSON.stringify({ mcpServers: { mine: { command: "m" } } }, null, 2)}\n`;
    fs.writeFileSync(path.join(cwd, ".mcp.json"), committed);
    runGit(cwd, ["add", ".mcp.json"]);
    runGit(cwd, ["commit", "-m", "add mcp config"]);
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // When the shadow is suspended for a Git operation
    await run(["shadow", "--suspend"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the committed content is back so Git can move HEAD safely
    expect(readMcpServers(path.join(cwd, ".mcp.json"))).toEqual({
      mine: { command: "m" },
    });

    // When the committed base then changes upstream and the shadow refreshes
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { mine: { command: "upstream" } } }, null, 2)}\n`,
    );
    runGit(cwd, ["add", ".mcp.json"]);
    runGit(cwd, ["commit", "-m", "upstream change"]);
    await run(["shadow", "--refresh"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the bundle's servers are replayed onto the new base, still clean
    const servers = readMcpServers(path.join(cwd, ".mcp.json"));
    expect(servers.mine).toEqual({ command: "upstream" });
    expect(servers).toHaveProperty("docs");
    expect(runGit(cwd, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("shadows and restores a Git-tracked Codex TOML configuration", async () => {
    // Given a committed Codex config with a hand-maintained comment
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    const committed = '# keep me\nmodel = "gpt-5"\n';
    fs.mkdirSync(path.join(cwd, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".codex", "config.toml"), committed);
    runGit(cwd, ["add", ".codex/config.toml"]);
    runGit(cwd, ["commit", "-m", "add codex config"]);

    // When a bundle is added for Codex
    await run(["add", SOURCE, BUNDLE, "--agent", "codex", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the servers are on disk and Git still sees a clean worktree
    const merged = fs.readFileSync(
      path.join(cwd, ".codex", "config.toml"),
      "utf8",
    );
    expect(merged).toContain("[mcp_servers.docs]");
    expect(merged.slice(0, committed.trimEnd().length)).toBe(
      committed.trimEnd(),
    );
    expect(runGit(cwd, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("restores a Git-tracked Codex TOML configuration byte-for-byte on remove", async () => {
    // Given a committed Codex config a bundle has been shadowed onto
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    const committed = '# keep me\nmodel = "gpt-5"\n';
    fs.mkdirSync(path.join(cwd, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".codex", "config.toml"), committed);
    runGit(cwd, ["add", ".codex/config.toml"]);
    runGit(cwd, ["commit", "-m", "add codex config"]);
    await run(["add", SOURCE, BUNDLE, "--agent", "codex", "-y"], {
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

    // Then the committed text is back exactly as it was
    expect(
      fs.readFileSync(path.join(cwd, ".codex", "config.toml"), "utf8"),
    ).toBe(committed);
    expect(runGit(cwd, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("restores the committed MCP configuration when the bundle is removed", async () => {
    // Given a committed MCP configuration shadowed by a bundle
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    const committed = `${JSON.stringify({ mcpServers: { mine: { command: "m" } } }, null, 2)}\n`;
    fs.writeFileSync(path.join(cwd, ".mcp.json"), committed);
    runGit(cwd, ["add", ".mcp.json"]);
    runGit(cwd, ["commit", "-m", "add mcp config"]);
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

    // Then the committed content is back and the worktree is clean
    expect(fs.readFileSync(path.join(cwd, ".mcp.json"), "utf8")).toBe(
      committed,
    );
    expect(runGit(cwd, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("writes Claude Code's user-scope MCP configuration for a global install", async () => {
    // Given a cached MCP bundle and a home directory used as the global root
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);

    // When the bundle is installed globally
    const output = await run(
      ["add", SOURCE, BUNDLE, "--global", "--agent", "claude-code", "-y"],
      {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      },
    );

    // Then the servers land in ~/.claude.json, not in the project-scoped location
    expect(
      Object.keys(readMcpServers(path.join(homeDir, ".claude.json"))).sort(),
    ).toEqual(["docs", "remote"]);
    expect(pathExists(path.join(homeDir, ".mcp.json"))).toBe(false);
    expect(output).not.toContain(MCP_SKIP_NOTE);
  });

  it("appends a marked block to the user-scope Codex config for a global install", async () => {
    // Given a hand-maintained ~/.codex/config.toml carrying the user's own server
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    const existing =
      '# keep me\nmodel = "gpt-5"\n\n[mcp_servers.mine]\ncommand = "my-server"\n';
    fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), existing);

    // When the bundle is installed globally for Codex
    await run(["add", SOURCE, BUNDLE, "--global", "--agent", "codex", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the bundle's block is appended below what was already there
    const merged = fs.readFileSync(
      path.join(homeDir, ".codex", "config.toml"),
      "utf8",
    );
    expect(merged).toContain("# keep me");
    expect(merged).toContain("[mcp_servers.docs]");
    expect(merged.indexOf("# >>> SKUL:MCP BEGIN")).toBeGreaterThan(
      merged.indexOf("[mcp_servers.mine]"),
    );
  });

  it("subtracts exactly what a global install merged into the user's own configuration", async () => {
    // Given a ~/.claude.json holding the user's own server and unrelated settings
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    fs.writeFileSync(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({
        numStartups: 7,
        mcpServers: { mine: { command: "mine" } },
      }),
    );
    await run(
      ["add", SOURCE, BUNDLE, "--global", "--agent", "claude-code", "-y"],
      {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      },
    );
    // And the bundle's servers now sit alongside the user's own
    expect(
      Object.keys(readMcpServers(path.join(homeDir, ".claude.json"))).sort(),
    ).toEqual(["docs", "mine", "remote"]);

    // When the bundle is removed globally
    await run(["remove", "--global", BUNDLE, "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then only the bundle's servers are gone and the rest of the file survives
    expect(readJson(path.join(homeDir, ".claude.json"))).toEqual({
      numStartups: 7,
      mcpServers: { mine: { command: "mine" } },
    });
  });

  it("restores the user-scope Codex config exactly when the global install is removed", async () => {
    // Given a Codex config that predates a global install
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    const existing =
      '# keep me\nmodel = "gpt-5"\n\n[mcp_servers.mine]\ncommand = "my-server"\n';
    fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), existing);
    await run(["add", SOURCE, BUNDLE, "--global", "--agent", "codex", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // When the bundle is removed globally
    await run(["remove", "--global", BUNDLE, "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the file is back to its original content, comments included
    expect(
      fs.readFileSync(path.join(homeDir, ".codex", "config.toml"), "utf8"),
    ).toBe(existing);
  });

  it("merges into OpenCode's user config without disturbing the settings beside it", async () => {
    // Given a ~/.config/opencode/opencode.json holding the user's model choice
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    const configFile = path.join(
      homeDir,
      ".config",
      "opencode",
      "opencode.json",
    );
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(
      configFile,
      JSON.stringify({ model: "anthropic/claude-opus-5" }),
    );

    // When the bundle is installed globally for OpenCode and then removed
    await run(
      ["add", SOURCE, BUNDLE, "--global", "--agent", "opencode", "-y"],
      { homeDir, cwd, prompts: createPromptClientStub() },
    );
    // And the servers arrive under OpenCode's own key, in its own dialect
    const merged = readJson(configFile) as {
      mcp: Record<string, { type: string }>;
    };
    expect(Object.keys(merged.mcp).sort()).toEqual(["docs", "remote"]);
    expect(merged.mcp.docs!.type).toBe("local");

    await run(["remove", "--global", BUNDLE, "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the user's own settings are all that is left
    expect(readJson(configFile)).toEqual({ model: "anthropic/claude-opus-5" });
  });

  it("writes Antigravity's user-scope MCP configuration in its own vocabulary", async () => {
    // Given a cached MCP bundle and a home directory used as the global root
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);

    // When the bundle is installed globally for Antigravity
    await run(
      ["add", SOURCE, BUNDLE, "--global", "--agent", "antigravity", "-y"],
      { homeDir, cwd, prompts: createPromptClientStub() },
    );

    // Then the servers land under ~/.gemini/config, with the remote endpoint
    // spelled `serverUrl` — Antigravity rejects the `url` spelling
    const configFile = path.join(
      homeDir,
      ".gemini",
      "config",
      "mcp_config.json",
    );
    const servers = readMcpServers(configFile);
    expect(Object.keys(servers).sort()).toEqual(["docs", "remote"]);
    expect(servers.remote).toEqual({ serverUrl: "https://example.com/mcp" });

    // And removing the bundle takes the file Skul created with it
    await run(["remove", "--global", BUNDLE, "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });
    expect(pathExists(configFile)).toBe(false);
  });

  it("installs Copilot into its own home directory, not its project layout", async () => {
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

    // When it is installed globally for Copilot
    const output = await run(
      ["add", SOURCE, BUNDLE, "--global", "--agent", "copilot", "-y"],
      { homeDir, cwd, prompts: createPromptClientStub() },
    );

    // Then everything lands under ~/.copilot, and nothing is reported as skipped
    expect(pathExists(path.join(homeDir, ".copilot", "skills", "review"))).toBe(
      true,
    );
    expect(pathExists(path.join(homeDir, ".github", "skills"))).toBe(false);
    expect(output).not.toContain(MCP_SKIP_NOTE);

    // And the servers use the Agent Host's vocabulary
    const config = readJson(
      path.join(homeDir, ".copilot", "mcp-config.json"),
    ) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(Object.keys(config.mcpServers).sort()).toEqual(["docs", "remote"]);
    expect(config.mcpServers.docs).toMatchObject({
      type: "local",
      tools: ["*"],
    });
    expect(config).not.toHaveProperty("servers");
  });

  it("drops a server the bundle no longer declares when a global install is repeated", async () => {
    // Given a bundle installed globally beside a server the user added themselves
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    fs.writeFileSync(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({ mcpServers: { mine: { command: "mine" } } }),
    );
    await run(
      ["add", SOURCE, BUNDLE, "--global", "--agent", "claude-code", "-y"],
      { homeDir, cwd, prompts: createPromptClientStub() },
    );

    // When the bundle withdraws one server and is installed globally again
    writeMcpBundle(homeDir, {
      mcpServers: {
        remote: { type: "streamable-http", url: "https://example.com/mcp" },
      },
    });
    await run(
      ["add", SOURCE, BUNDLE, "--global", "--agent", "claude-code", "-y"],
      { homeDir, cwd, prompts: createPromptClientStub() },
    );

    // Then the withdrawn server is gone and the user's own is left alone
    expect(
      Object.keys(readMcpServers(path.join(homeDir, ".claude.json"))).sort(),
    ).toEqual(["mine", "remote"]);
  });

  it("subtracts a global bundle's servers from the user's own file on remove --all", async () => {
    // Given a globally installed bundle sharing ~/.claude.json with the user
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    fs.writeFileSync(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({ mcpServers: { mine: { command: "mine" } } }),
    );
    await run(
      ["add", SOURCE, BUNDLE, "--global", "--agent", "claude-code", "-y"],
      { homeDir, cwd, prompts: createPromptClientStub() },
    );

    // When every global bundle is removed at once
    await run(["remove", "--global", "--all", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then only the user's own server is left behind
    expect(readJson(path.join(homeDir, ".claude.json"))).toEqual({
      mcpServers: { mine: { command: "mine" } },
    });
  });

  it("subtracts a global bundle's servers from the user's own file on reset --global", async () => {
    // Given a globally installed bundle sharing ~/.claude.json with the user
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    fs.writeFileSync(
      path.join(homeDir, ".claude.json"),
      JSON.stringify({ mcpServers: { mine: { command: "mine" } } }),
    );
    await run(
      ["add", SOURCE, BUNDLE, "--global", "--agent", "claude-code", "-y"],
      { homeDir, cwd, prompts: createPromptClientStub() },
    );

    // When the global installation is reset
    await run(["reset", "--global", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then only the user's own server is left behind
    expect(readJson(path.join(homeDir, ".claude.json"))).toEqual({
      mcpServers: { mine: { command: "mine" } },
    });
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

    // Then the exact path is excluded and Git reports nothing to commit
    expect(excludeFile.split("\n")).toContain(".mcp.json");
    expect(runGit(cwd, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("checks a committed configuration back out of HEAD when the bundle is removed", async () => {
    // Given a materialized configuration force-added past the exclude entry,
    // since edited by hand so a restore has something to undo
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    await run(["add", SOURCE, BUNDLE, "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });
    runGit(cwd, ["add", "-f", ".mcp.json"]);
    runGit(cwd, ["commit", "-m", "commit the materialized config"]);
    const committedContent = fs.readFileSync(
      path.join(cwd, ".mcp.json"),
      "utf8",
    );
    fs.writeFileSync(path.join(cwd, ".mcp.json"), '{ "mcpServers": {} }\n');

    // When the bundle is removed
    const removeOutput = await run(["remove", BUNDLE, "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the committed content is back, byte for byte
    expect(fs.readFileSync(path.join(cwd, ".mcp.json"), "utf8")).toBe(
      committedContent,
    );

    // And the path is reported, alongside the edit that was replaced
    expect(removeOutput).toContain(
      "checked out from HEAD instead of deleted: .mcp.json",
    );
    expect(removeOutput).toContain("git rm --cached .mcp.json");

    // And no other tool's configuration survived, leaving the worktree clean
    expect(pathExists(path.join(cwd, ".cursor", "mcp.json"))).toBe(false);
    expect(runGit(cwd, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("restores a committed configuration the user has already deleted", async () => {
    // Given a committed configuration deleted from the worktree
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });
    runGit(cwd, ["add", "-f", ".mcp.json"]);
    runGit(cwd, ["commit", "-m", "commit the materialized config"]);
    fs.rmSync(path.join(cwd, ".mcp.json"));

    // When the bundle is removed
    await run(["remove", BUNDLE, "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the pending deletion is resolved rather than carried forward
    expect(pathExists(path.join(cwd, ".mcp.json"))).toBe(true);
    expect(runGit(cwd, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("leaves a committed configuration modified while another bundle owns servers in it", async () => {
    // Given two bundles sharing a committed configuration
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    writeBundleFile(
      homeDir,
      SOURCE,
      "other-bundle",
      "mcp.json",
      JSON.stringify(
        { mcpServers: { other: { type: "stdio", command: "other" } } },
        null,
        2,
      ),
    );
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });
    await run(["add", SOURCE, "other-bundle", "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });
    runGit(cwd, ["add", "-f", ".mcp.json"]);
    runGit(cwd, ["commit", "-m", "commit the shared config"]);

    // When only one of them is removed
    const removeOutput = await run(["remove", BUNDLE, "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the surviving bundle keeps its server and the change is explained
    expect(Object.keys(readMcpServers(path.join(cwd, ".mcp.json")))).toEqual([
      "other",
    ]);
    expect(removeOutput).toContain("left modified");
    expect(removeOutput).toContain(".mcp.json");
  });

  it("names every committed configuration on apply, and nothing else", async () => {
    // Given two of the materialized configurations committed, and an
    // unrelated committed file that Skul never wrote
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    await run(["add", SOURCE, BUNDLE, "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });
    runGit(cwd, ["add", "-f", ".mcp.json", ".cursor/mcp.json"]);
    runGit(cwd, ["commit", "-m", "commit two materialized configs"]);

    // When the bundles are applied
    const applyWarnings = await captureWarnings(() =>
      run(["apply", "-y"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      }),
    );

    // Then both committed paths are named, in order, and README.md is not
    expect(applyWarnings).toContain(
      "but written by Skul: .cursor/mcp.json, .mcp.json",
    );
    expect(applyWarnings).toContain(
      "git rm --cached .cursor/mcp.json .mcp.json",
    );
    expect(applyWarnings).not.toContain("README.md");
  });

  it("stays silent about a committed configuration during a dry run", async () => {
    // Given a committed materialized configuration
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });
    runGit(cwd, ["add", "-f", ".mcp.json"]);
    runGit(cwd, ["commit", "-m", "commit the materialized config"]);

    // When apply runs as a dry run
    const applyWarnings = await captureWarnings(() =>
      run(["apply", "--dry-run"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      }),
    );

    // Then a preview reports nothing about the committed file
    expect(applyWarnings).toBe("");
  });

  it("warns on add that a previously materialized configuration is committed", async () => {
    // Given a committed MCP configuration from an earlier add
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });
    runGit(cwd, ["add", "-f", ".mcp.json"]);
    runGit(cwd, ["commit", "-m", "commit the materialized config"]);
    writeBundleFile(
      homeDir,
      SOURCE,
      "skills-bundle",
      "skills/review/SKILL.md",
      "---\nname: review\ndescription: Review code\n---\n\nReview.\n",
    );

    // When an unrelated bundle is added
    const addWarnings = await captureWarnings(() =>
      run(["add", SOURCE, "skills-bundle", "--agent", "claude-code", "-y"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      }),
    );

    // Then the committed configuration is still called out
    expect(addWarnings).toContain("but written by Skul: .mcp.json");
    expect(addWarnings).toContain("git rm --cached .mcp.json");
  });

  it("keeps a configuration Skul did not create when its last server leaves", async () => {
    // Given an empty configuration file the project already had
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    fs.writeFileSync(path.join(cwd, ".mcp.json"), '{"mcpServers": {}}\n');

    // When a bundle is added and removed again
    for (const argv of [
      ["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"],
      ["remove", BUNDLE, "-y"],
    ]) {
      await run(argv, { homeDir, cwd, prompts: createPromptClientStub() });
    }

    // Then the user's file is still there, holding none of Skul's servers
    expect(pathExists(path.join(cwd, ".mcp.json"))).toBe(true);
    expect(readMcpServers(path.join(cwd, ".mcp.json"))).toEqual({});
  });

  it("removes a bundle's servers from a pre-existing file when only its MCP item is removed", async () => {
    // Given a bundle with MCP and skills content merged into a user-owned file
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundleWithSkill(homeDir);
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { mine: { command: "mine" } } }),
    );
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // When only the MCP item is removed
    await run(["remove", BUNDLE, "--include", "mcp", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the user-owned config keeps its server and the skill remains active
    expect(readMcpServers(path.join(cwd, ".mcp.json"))).toEqual({
      mine: { command: "mine" },
    });
    expect(
      pathExists(path.join(cwd, ".claude", "skills", "guide", "SKILL.md")),
    ).toBe(true);
  });

  it("keeps a second bundle's servers when the bundle that created the file goes", async () => {
    // Given two bundles sharing a file the first one created
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

    // When the bundle that created the file is removed
    await run(["remove", "first", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the other bundle's server survives, still hidden from Git
    expect(readMcpServers(path.join(cwd, ".mcp.json"))).toEqual({
      second: { type: "stdio", command: "second" },
    });
    expect(
      fs
        .readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf8")
        .split("\n"),
    ).toContain(".mcp.json");
    expect(runGit(cwd, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("subtracts servers merged into a user-owned file on remove --all", async () => {
    // Given a bundle merged into a configuration the project already had
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { mine: { command: "m" } } }, null, 2)}\n`,
    );
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // When every bundle is removed at once
    await run(["remove", "--all", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then only the user's own server is left
    expect(readMcpServers(path.join(cwd, ".mcp.json"))).toEqual({
      mine: { command: "m" },
    });
  });

  it("writes nothing at all when one tool's configuration cannot be merged", async () => {
    // Given a project whose Copilot configuration carries a JSONC comment
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    fs.mkdirSync(path.join(cwd, ".github"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".github", "mcp.json"),
      '{\n  // a comment\n  "mcpServers": {}\n}\n',
    );

    // When the bundle is added for every tool / Then it fails
    await expect(
      run(["add", SOURCE, BUNDLE, "-y"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      }),
    ).rejects.toThrowError(/\.github\/mcp\.json is not valid JSON/);

    // And no other tool's configuration was left behind unrecorded
    expect(pathExists(path.join(cwd, ".mcp.json"))).toBe(false);
    expect(pathExists(path.join(cwd, ".cursor"))).toBe(false);
    expect(pathExists(path.join(cwd, ".codex"))).toBe(false);
    expect(pathExists(path.join(cwd, "opencode.json"))).toBe(false);
  });

  it("finishes removing a bundle whose shared configuration no longer parses", async () => {
    // Given a bundle whose configuration file the user has since broken
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });
    fs.writeFileSync(path.join(cwd, ".mcp.json"), "{ broken");

    // When the bundle is removed
    const output = await run(["remove", BUNDLE, "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then removal finishes, the file is left alone, and the servers are named
    expect(fs.readFileSync(path.join(cwd, ".mcp.json"), "utf8")).toBe(
      "{ broken",
    );
    expect(output).toContain(".mcp.json");
    expect(output).toContain("docs");

    // And the failed MCP ownership remains retryable after the warning
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    expect(
      registry.worktrees[Object.keys(registry.worktrees)[0]!]
        ?.materialized_state.bundles[BUNDLE],
    ).toBeDefined();

    // When the user repairs the configuration and retries removal
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { docs: { command: "docs" } } }),
    );
    await run(["remove", BUNDLE, "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the repaired, originally-created file is deleted
    expect(pathExists(path.join(cwd, ".mcp.json"))).toBe(false);
  });

  it("returns recovery warnings in JSON when removing a broken shared configuration", async () => {
    // Given a bundle whose shared MCP configuration has become invalid
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });
    fs.writeFileSync(path.join(cwd, ".mcp.json"), "{ broken");

    // When the bundle is removed with machine-readable output
    const output = await runWithoutConsoleWarnings(() =>
      run(["remove", BUNDLE, "-y", "--json"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      }),
    );

    // Then the warning travels with the successful command result
    expect(JSON.parse(output)).toMatchObject({
      output: "Removed mcp-bundle",
      warnings: [expect.stringContaining("Remove these MCP servers by hand")],
    });
  });

  it("returns recovery warnings in JSON when removing the MCP item from a broken shared configuration", async () => {
    // Given a bundle whose MCP configuration and skill are both materialized
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundleWithSkill(homeDir);
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });
    fs.writeFileSync(path.join(cwd, ".mcp.json"), "{ broken");

    // When only the MCP item is removed with machine-readable output
    const output = await runWithoutConsoleWarnings(() =>
      run(["remove", BUNDLE, "--include", "mcp", "-y", "--json"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      }),
    );

    // Then the partial removal succeeds and includes the recovery warning
    expect(JSON.parse(output)).toMatchObject({
      output: "Removed mcp from mcp-bundle",
      warnings: [expect.stringContaining("Remove these MCP servers by hand")],
    });
  });

  it("returns recovery warnings in JSON when resetting a broken shared configuration", async () => {
    // Given a materialized bundle whose shared MCP configuration has become invalid
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });
    fs.writeFileSync(path.join(cwd, ".mcp.json"), "{ broken");

    // When all materialized bundles are reset with machine-readable output
    const output = await runWithoutConsoleWarnings(() =>
      run(["reset", "-y", "--json"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      }),
    );

    // Then reset succeeds and includes the recovery warning
    expect(JSON.parse(output)).toMatchObject({
      output: "Reset Skul-managed files from the current worktree",
      warnings: [expect.stringContaining("Remove these MCP servers by hand")],
    });
  });

  it.each([
    {
      name: "removing one global bundle",
      argv: ["remove", "--global", BUNDLE, "-y", "--json"],
      output: "Removed global mcp-bundle",
    },
    {
      name: "removing all global bundles",
      argv: ["remove", "--global", "--all", "-y", "--json"],
      output: "Removed global mcp-bundle",
    },
    {
      name: "resetting globally",
      argv: ["reset", "--global", "-y", "--json"],
      output: "Reset globally managed Skul files",
    },
  ])("returns recovery warnings in JSON when $name with a broken shared configuration", async ({
    argv,
    output: expectedOutput,
  }) => {
    // Given a globally materialized bundle whose shared configuration is invalid
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    await run(
      ["add", SOURCE, BUNDLE, "--global", "--agent", "claude-code", "-y"],
      {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      },
    );
    fs.writeFileSync(path.join(homeDir, ".claude.json"), "{ broken");

    // When the global mutation runs with machine-readable output
    const output = await runWithoutConsoleWarnings(() =>
      run([...argv], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      }),
    );

    // Then the command succeeds with the warning attached to its result
    expect(JSON.parse(output)).toMatchObject({
      output: expectedOutput,
      warnings: [expect.stringContaining("Remove these MCP servers by hand")],
    });
  });

  it("returns recovery warnings in JSON when removing the global MCP item from a broken shared configuration", async () => {
    // Given a globally materialized bundle whose MCP configuration and skill are both active
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundleWithSkill(homeDir);
    await run(
      ["add", SOURCE, BUNDLE, "--global", "--agent", "claude-code", "-y"],
      {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      },
    );
    fs.writeFileSync(path.join(homeDir, ".claude.json"), "{ broken");

    // When only the MCP item is removed with machine-readable output
    const output = await runWithoutConsoleWarnings(() =>
      run(["remove", "--global", BUNDLE, "--include", "mcp", "-y", "--json"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      }),
    );

    // Then the partial global removal succeeds and includes the warning
    expect(JSON.parse(output)).toMatchObject({
      output: "Removed mcp from global mcp-bundle",
      warnings: [expect.stringContaining("Remove these MCP servers by hand")],
    });
  });

  it("refuses a configuration whose server key is not an object", async () => {
    // Given a configuration whose servers key holds a string
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    fs.writeFileSync(path.join(cwd, ".mcp.json"), '{"mcpServers": "oops"}\n');

    // When a bundle is added / Then Skul refuses rather than overwriting it
    await expect(
      run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      }),
    ).rejects.toThrowError(/"mcpServers" in \.mcp\.json must be an object/);
    expect(fs.readFileSync(path.join(cwd, ".mcp.json"), "utf8")).toBe(
      '{"mcpServers": "oops"}\n',
    );
  });

  it("refuses to write through a symlinked configuration path", async () => {
    // Given an MCP configuration path that is a symlink out of the worktree
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    const outside = path.join(homeDir, "outside-mcp.json");
    fs.writeFileSync(outside, "{}\n");
    fs.symlinkSync(outside, path.join(cwd, ".mcp.json"));

    // When a bundle is added / Then the write is refused
    await expect(
      run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      }),
    ).rejects.toThrowError(/must not be a symlink: \.mcp\.json/);
    expect(fs.readFileSync(outside, "utf8")).toBe("{}\n");
  });

  it("installs a server whose name is also an Object prototype member", async () => {
    // Given a bundle declaring a server called "constructor"
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir, {
      mcpServers: { constructor: { type: "stdio", command: "ctor" } },
    });

    // When the bundle is added
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the inherited property is not mistaken for the user's own server
    expect(readMcpServers(path.join(cwd, ".mcp.json"))).toEqual({
      constructor: { type: "stdio", command: "ctor" },
    });
  });

  it("refuses a tracked configuration that has no committed content", async () => {
    // Given an MCP configuration staged but never committed
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      '{"mcpServers":{"mine":{"command":"m"}}}\n',
    );
    runGit(cwd, ["add", ".mcp.json"]);

    // When a bundle is added / Then Skul stops instead of dirtying the index
    await expect(
      run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      }),
    ).rejects.toThrowError(
      /Cannot create tracked shadow for \.mcp\.json because the target does not have HEAD content/,
    );
    expect(runGit(cwd, ["status", "--porcelain"]).trim()).toBe("A  .mcp.json");
  });

  it("replays its own servers onto a base that already commits them", async () => {
    // Given a repository that commits the very servers the bundle declares
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir, {
      mcpServers: { docs: { type: "stdio", command: "docs-server" } },
    });
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { docs: { type: "stdio", command: "committed" } } }, null, 2)}\n`,
    );
    runGit(cwd, ["add", ".mcp.json"]);
    runGit(cwd, ["commit", "-m", "commit mcp config"]);
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // When the shadow is refreshed against that same committed base
    await run(["shadow", "--refresh"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the bundle's own server wins, without reading as someone else's
    expect(readMcpServers(path.join(cwd, ".mcp.json"))).toEqual({
      docs: { type: "stdio", command: "docs-server" },
    });
    expect(runGit(cwd, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("reports a shadowed MCP configuration as active in status", async () => {
    // Given a committed MCP configuration shadowed by a bundle
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { mine: { command: "m" } } }, null, 2)}\n`,
    );
    runGit(cwd, ["add", ".mcp.json"]);
    runGit(cwd, ["commit", "-m", "add mcp config"]);
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // When status is read as JSON
    const status = JSON.parse(
      await run(["status", "--json"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      }),
    ) as {
      worktree: {
        shadowed_files: Record<
          string,
          { active: boolean; overlay_fresh: boolean }
        >;
      };
    };

    // Then the merge shadow reads as live, not as a missing text overlay
    expect(status.worktree.shadowed_files[".mcp.json"]).toMatchObject({
      active: true,
      overlay_fresh: true,
    });
  });

  it("excludes a pre-existing configuration only while its servers are merged in", async () => {
    // Given a project that already owns its MCP configuration file
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { mine: { command: "m" } } }, null, 2)}\n`,
    );
    const readExcludeLines = () =>
      fs
        .readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf8")
        .split("\n");

    // When a bundle merges into it
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code", "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the file is hidden, because it now carries machine-specific paths
    expect(readExcludeLines()).toContain(".mcp.json");

    // When the bundle is removed
    await run(["remove", BUNDLE, "-y"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub(),
    });

    // Then the user's own file is visible again, with their server intact
    expect(readExcludeLines()).not.toContain(".mcp.json");
    expect(
      JSON.parse(fs.readFileSync(path.join(cwd, ".mcp.json"), "utf8")),
    ).toEqual({ mcpServers: { mine: { command: "m" } } });
  });
});
