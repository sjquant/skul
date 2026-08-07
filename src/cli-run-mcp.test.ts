import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createHomeDir,
  createPromptClientStub,
  createRepository,
  pathExists,
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

  it("asks before replacing an MCP configuration the project already has", async () => {
    // Given a project that already hand-wrote an MCP configuration
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { existing: { command: "mine" } } }),
    );
    const conflicts: string[] = [];

    // When a bundle targeting the same file is added without auto-approval
    await run(["add", SOURCE, BUNDLE, "--agent", "claude-code"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub({
        resolveFileConflict: async (conflictPath) => {
          conflicts.push(conflictPath);
          return { action: "overwrite" };
        },
      }),
    });

    // Then the existing file is reported as a conflict before being replaced
    expect(conflicts).toEqual([".mcp.json"]);
    expect(readMcpServers(path.join(cwd, ".mcp.json"))).toHaveProperty("docs");
  });

  it("leaves an existing MCP configuration untouched when the user declines", async () => {
    // Given a project with a hand-written MCP configuration
    const homeDir = createHomeDir();
    const cwd = createRepository();
    writeMcpBundle(homeDir);
    const existing = JSON.stringify({
      mcpServers: { existing: { command: "mine" } },
    });
    fs.writeFileSync(path.join(cwd, ".mcp.json"), existing);

    // When the user declines the overwrite prompt
    await expect(
      run(["add", SOURCE, BUNDLE, "--agent", "claude-code"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub({
          resolveFileConflict: async () => {
            throw new Error("Aborted by user");
          },
        }),
      }),
    ).rejects.toThrowError(/Aborted by user/);

    // Then the original configuration is still on disk
    expect(fs.readFileSync(path.join(cwd, ".mcp.json"), "utf8")).toBe(existing);
  });

  it("guards the shared configuration when a second bundle has replaced it", async () => {
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

    // When the first bundle is removed after the second replaced its file
    const removal = run(["remove", "first"], {
      homeDir,
      cwd,
      prompts: createPromptClientStub({
        confirmManagedFileRemoval: async () => false,
      }),
    });

    // Then the removal stops rather than discarding the second bundle's servers
    await expect(removal).rejects.toThrowError(/modified managed file/);
    expect(readMcpServers(path.join(cwd, ".mcp.json"))).toHaveProperty(
      "second",
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
