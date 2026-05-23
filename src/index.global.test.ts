import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PromptClient } from "./cli";
import { run } from "./index";
import { readRegistryFile } from "./registry";
import {
  formatExpectedRootInstructionDocument,
  formatRootInstructionBundleBlock,
} from "./utils/testing";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("run --global", () => {
  it("installs skills to homeDir and writes registry global section", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: {
        "claude-code": { skills: { path: ".claude/skills" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".claude/skills/react/SKILL.md",
      "# react\n",
    );

    // When
    const output = await run(["add", "--global", "react-expert"], { homeDir });

    // Then
    expect(output).toContain("Applied react-expert globally for claude-code");
    expect(
      fs.readFileSync(
        path.join(homeDir, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    expect(registry.global).toBeDefined();
    expect(registry.global!.desired_state).toEqual([
      expect.objectContaining({ bundle: "react-expert" }),
    ]);
    expect(
      registry.global!.materialized_state.bundles["react-expert"]!.tools[
        "claude-code"
      ]!.files,
    ).toContain(".claude/skills/react/SKILL.md");
  });

  it("installs agents to homeDir under .claude/agents", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: {
        "claude-code": { agents: { path: ".claude/agents" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".claude/agents/reviewer.md",
      "# reviewer\n",
    );

    // When
    await run(["add", "--global", "react-expert"], { homeDir });

    // Then
    expect(
      fs.readFileSync(
        path.join(homeDir, ".claude", "agents", "reviewer.md"),
        "utf8",
      ),
    ).toBe("# reviewer\n");
  });

  it("appends root instruction content to ~/.claude/CLAUDE.md with markers", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: {
        "claude-code": { root_instruction: { path: "CLAUDE.md" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      "CLAUDE.md",
      "# React guidance\n",
    );

    // When
    await run(["add", "--global", "react-expert"], { homeDir });

    // Then: CLAUDE.md appears at ~/.claude/CLAUDE.md with bundle markers
    const claudePath = path.join(homeDir, ".claude", "CLAUDE.md");
    expect(fs.existsSync(claudePath)).toBe(true);
    const content = fs.readFileSync(claudePath, "utf8");
    expect(content).toBe(
      formatExpectedRootInstructionDocument(
        formatRootInstructionBundleBlock(
          "react-expert",
          "# React guidance\n",
          "github.com/user/ai-vault",
        ),
      ),
    );

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    // No pre-existing file, so base contents are not recorded in the registry.
    expect(
      registry.global!.materialized_state.root_instruction_base_contents,
    ).toBeUndefined();
  });

  it("captures non-empty base content before appending bundle markers", async () => {
    // Given
    const homeDir = createHomeDir();
    const claudePath = path.join(homeDir, ".claude", "CLAUDE.md");
    fs.mkdirSync(path.dirname(claudePath), { recursive: true });
    fs.writeFileSync(claudePath, "# My personal rules\n");

    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: {
        "claude-code": { root_instruction: { path: "CLAUDE.md" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      "CLAUDE.md",
      "# React guidance\n",
    );

    // When
    await run(["add", "--global", "react-expert"], { homeDir });

    // Then: base content is preserved and bundle block is appended
    const content = fs.readFileSync(claudePath, "utf8");
    expect(content).toBe(
      formatExpectedRootInstructionDocument(
        "# My personal rules\n",
        formatRootInstructionBundleBlock(
          "react-expert",
          "# React guidance\n",
          "github.com/user/ai-vault",
        ),
      ),
    );

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    expect(
      registry.global!.materialized_state.root_instruction_base_contents![
        ".claude/CLAUDE.md"
      ],
    ).toBe("# My personal rules\n");
  });

  it("restores base content when removing a bundle that owns the root instruction", async () => {
    // Given
    const homeDir = createHomeDir();
    const claudePath = path.join(homeDir, ".claude", "CLAUDE.md");
    fs.mkdirSync(path.dirname(claudePath), { recursive: true });
    fs.writeFileSync(claudePath, "# My personal rules\n");

    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: {
        "claude-code": { root_instruction: { path: "CLAUDE.md" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      "CLAUDE.md",
      "# React guidance\n",
    );
    await run(["add", "--global", "react-expert"], { homeDir });

    // When
    await run(["remove", "--global", "react-expert"], {
      homeDir,
      prompts: createPromptStub(),
    });

    // Then: base content is restored
    expect(fs.readFileSync(claudePath, "utf8")).toBe("# My personal rules\n");

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    expect(registry.global).toBeUndefined();
  });

  it("removes skill files and updates registry when removing a bundle", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".claude/skills/react/SKILL.md",
      "# react\n",
    );
    await run(["add", "--global", "react-expert"], { homeDir });
    expect(
      pathExists(path.join(homeDir, ".claude", "skills", "react", "SKILL.md")),
    ).toBe(true);

    // When
    await run(["remove", "--global", "react-expert"], {
      homeDir,
      prompts: createPromptStub(),
    });

    // Then
    expect(
      pathExists(path.join(homeDir, ".claude", "skills", "react", "SKILL.md")),
    ).toBe(false);
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    expect(registry.global).toBeUndefined();
  });

  it("removes all globally managed files on reset --global", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".claude/skills/react/SKILL.md",
      "# react\n",
    );
    writeManifest(homeDir, "github.com/user/ai-vault", "next-expert", {
      name: "next-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "next-expert",
      ".claude/skills/next/SKILL.md",
      "# next\n",
    );
    await run(["add", "--global", "react-expert"], { homeDir });
    await run(["add", "--global", "next-expert"], { homeDir });

    // When
    const output = await run(["reset", "--global"], {
      homeDir,
      prompts: createPromptStub(),
    });

    // Then
    expect(output).toContain("Reset globally managed Skul files");
    expect(
      pathExists(path.join(homeDir, ".claude", "skills", "react", "SKILL.md")),
    ).toBe(false);
    expect(
      pathExists(path.join(homeDir, ".claude", "skills", "next", "SKILL.md")),
    ).toBe(false);

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    expect(registry.global!.materialized_state.bundles).toEqual({});
    expect(registry.global!.desired_state).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bundle: "react-expert" }),
        expect.objectContaining({ bundle: "next-expert" }),
      ]),
    );
  });

  it("restores base content on reset --global when a root instruction was managed", async () => {
    // Given
    const homeDir = createHomeDir();
    const claudePath = path.join(homeDir, ".claude", "CLAUDE.md");
    fs.mkdirSync(path.dirname(claudePath), { recursive: true });
    fs.writeFileSync(claudePath, "# My personal rules\n");

    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: {
        "claude-code": { root_instruction: { path: "CLAUDE.md" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      "CLAUDE.md",
      "# React guidance\n",
    );
    await run(["add", "--global", "react-expert"], { homeDir });

    // When
    await run(["reset", "--global"], { homeDir, prompts: createPromptStub() });

    // Then: base content restored
    expect(fs.readFileSync(claudePath, "utf8")).toBe("# My personal rules\n");
  });

  it("composes two bundles sharing ~/.claude/CLAUDE.md and decomposes correctly", async () => {
    // Given
    const homeDir = createHomeDir();
    const claudePath = path.join(homeDir, ".claude", "CLAUDE.md");

    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: {
        "claude-code": { root_instruction: { path: "CLAUDE.md" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      "CLAUDE.md",
      "# React guidance\n",
    );
    writeManifest(homeDir, "github.com/user/ai-vault", "next-expert", {
      name: "next-expert",
      tools: {
        "claude-code": { root_instruction: { path: "CLAUDE.md" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "next-expert",
      "CLAUDE.md",
      "# Next.js guidance\n",
    );

    // When: add both bundles
    await run(["add", "--global", "react-expert"], { homeDir });
    await run(["add", "--global", "next-expert"], { homeDir });

    // Then: both bundle blocks appear in ~/.claude/CLAUDE.md
    const composedContent = fs.readFileSync(claudePath, "utf8");
    expect(composedContent).toContain("BEGIN SKUL BUNDLE: react-expert");
    expect(composedContent).toContain("BEGIN SKUL BUNDLE: next-expert");
    expect(composedContent).toContain("# React guidance");
    expect(composedContent).toContain("# Next.js guidance");

    // When: remove first bundle
    await run(["remove", "--global", "react-expert"], {
      homeDir,
      prompts: createPromptStub(),
    });

    // Then: only second bundle remains
    const afterRemove = fs.readFileSync(claudePath, "utf8");
    expect(afterRemove).not.toContain("BEGIN SKUL BUNDLE: react-expert");
    expect(afterRemove).toContain("BEGIN SKUL BUNDLE: next-expert");
    expect(afterRemove).not.toContain("# React guidance");
    expect(afterRemove).toContain("# Next.js guidance");

    // When: remove second bundle
    await run(["remove", "--global", "next-expert"], {
      homeDir,
      prompts: createPromptStub(),
    });

    // Then: file is deleted (or empty base content restored)
    expect(pathExists(claudePath)).toBe(false);
  });

  it("reports global status with installed bundles", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".claude/skills/react/SKILL.md",
      "# react\n",
    );
    await run(["add", "--global", "react-expert"], { homeDir });

    // When
    const output = await run(["status", "--global"], { homeDir });

    // Then
    expect(output).toContain("react-expert");
    expect(output).toContain("claude-code");
  });

  it("reports empty global status when no bundles are installed", async () => {
    // Given
    const homeDir = createHomeDir();

    // When
    const output = await run(["status", "--global"], { homeDir });

    // Then
    expect(output).toContain("Global Desired State");
    expect(output).toContain("Configured: no");
  });

  it("applies bundles from desired_state after reset --global", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".claude/skills/react/SKILL.md",
      "# react\n",
    );
    await run(["add", "--global", "react-expert"], { homeDir });
    await run(["reset", "--global"], { homeDir });
    expect(
      pathExists(path.join(homeDir, ".claude", "skills", "react", "SKILL.md")),
    ).toBe(false);

    // When
    const output = await run(["apply", "--global"], { homeDir });

    // Then
    expect(output).toContain("Applied react-expert");
    expect(
      fs.readFileSync(
        path.join(homeDir, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
  });

  it("does not require a git repository", async () => {
    // Given
    const homeDir = createHomeDir();
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-nogit-"));
    tempDirs.push(nonGitDir);
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".claude/skills/react/SKILL.md",
      "# react\n",
    );

    // When / Then: runs without error even outside a git repository
    await expect(
      run(["add", "--global", "react-expert"], { homeDir, cwd: nonGitDir }),
    ).resolves.toContain("Applied react-expert globally for claude-code");
  });

  it("status, remove, and reset --global work without a git repository", async () => {
    // Given: a bundle installed globally, cwd is outside any git repo
    const homeDir = createHomeDir();
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-nogit-"));
    tempDirs.push(nonGitDir);
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".claude/skills/react/SKILL.md",
      "# react\n",
    );
    await run(["add", "--global", "react-expert"], { homeDir, cwd: nonGitDir });

    // When / Then: status, remove, and reset all work without a git repo
    await expect(
      run(["status", "--global"], { homeDir, cwd: nonGitDir }),
    ).resolves.toContain("react-expert");

    await expect(
      run(["remove", "--global", "react-expert"], {
        homeDir,
        cwd: nonGitDir,
        prompts: createPromptStub(),
      }),
    ).resolves.toBeDefined();

    // Re-install for reset test
    await run(["add", "--global", "react-expert"], { homeDir, cwd: nonGitDir });
    await expect(
      run(["reset", "--global"], {
        homeDir,
        cwd: nonGitDir,
        prompts: createPromptStub(),
      }),
    ).resolves.toContain("Reset");
  });

  it("throws when the bundle has no globally installable tools", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "codex-only", {
      name: "codex-only",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "codex-only",
      ".agents/skills/task/SKILL.md",
      "# task\n",
    );

    // When / Then: fails because codex is not a globally-capable tool
    await expect(
      run(["add", "--global", "codex-only"], { homeDir }),
    ).rejects.toThrowError(/no globally installable tools/i);
  });

  it("returns JSON global status when --json is passed", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".claude/skills/react/SKILL.md",
      "# react\n",
    );
    await run(["add", "--global", "react-expert"], { homeDir });

    // When
    const output = await run(["status", "--global", "--json"], { homeDir });
    const parsed = JSON.parse(output);

    // Then
    expect(parsed.desired_state).toEqual([
      expect.objectContaining({ bundle: "react-expert" }),
    ]);
    expect(
      parsed.materialized.bundles["react-expert"].tools["claude-code"].files,
    ).toContain(".claude/skills/react/SKILL.md");
  });

  it("dry-runs remove --global without deleting files", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".claude/skills/react/SKILL.md",
      "# react\n",
    );
    await run(["add", "--global", "react-expert"], { homeDir });

    // When
    const output = await run(
      ["remove", "--global", "--dry-run", "react-expert"],
      {
        homeDir,
        prompts: createPromptStub(),
      },
    );

    // Then
    expect(output).toContain("DRY RUN");
    expect(output).toContain("react-expert");
    expect(
      pathExists(path.join(homeDir, ".claude", "skills", "react", "SKILL.md")),
    ).toBe(true);
  });

  it("dry-runs reset --global without deleting files", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".claude/skills/react/SKILL.md",
      "# react\n",
    );
    await run(["add", "--global", "react-expert"], { homeDir });

    // When
    const output = await run(["reset", "--global", "--dry-run"], {
      homeDir,
      prompts: createPromptStub(),
    });

    // Then
    expect(output).toContain("DRY RUN");
    expect(
      pathExists(path.join(homeDir, ".claude", "skills", "react", "SKILL.md")),
    ).toBe(true);
  });

  it("writes copilot root instruction to ~/.github/copilot-instructions.md", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "team-guide", {
      name: "team-guide",
      tools: {
        copilot: { root_instruction: { path: "AGENTS.md" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "team-guide",
      "AGENTS.md",
      "# Copilot guidance\n",
    );

    // When
    const output = await run(["add", "--global", "team-guide"], { homeDir });

    // Then: root instruction lands at the copilot-native global path
    expect(output).toContain("Applied team-guide globally for copilot");
    const targetPath = path.join(
      homeDir,
      ".github",
      "copilot-instructions.md",
    );
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.readFileSync(targetPath, "utf8")).toBe(
      formatExpectedRootInstructionDocument(
        formatRootInstructionBundleBlock(
          "team-guide",
          "# Copilot guidance\n",
          "github.com/user/ai-vault",
        ),
      ),
    );
  });

  it("writes antigravity root instruction to ~/.gemini/GEMINI.md", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "team-guide", {
      name: "team-guide",
      tools: {
        antigravity: { root_instruction: { path: "AGENTS.md" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "team-guide",
      "AGENTS.md",
      "# Gemini guidance\n",
    );

    // When
    const output = await run(["add", "--global", "team-guide"], { homeDir });

    // Then: root instruction lands at the antigravity-native global path
    expect(output).toContain("Applied team-guide globally for antigravity");
    const targetPath = path.join(homeDir, ".gemini", "GEMINI.md");
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.readFileSync(targetPath, "utf8")).toBe(
      formatExpectedRootInstructionDocument(
        formatRootInstructionBundleBlock(
          "team-guide",
          "# Gemini guidance\n",
          "github.com/user/ai-vault",
        ),
      ),
    );
  });

  it("splits a bundle supporting both copilot and antigravity into their respective global paths", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "team-guide", {
      name: "team-guide",
      tools: {
        copilot: { root_instruction: { path: "AGENTS.md" } },
        antigravity: { root_instruction: { path: "AGENTS.md" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "team-guide",
      "AGENTS.md",
      "# Shared AI guidance\n",
    );

    // When
    await run(["add", "--global", "team-guide"], { homeDir });

    // Then: copilot goes to .github/copilot-instructions.md
    const copilotPath = path.join(homeDir, ".github", "copilot-instructions.md");
    expect(fs.existsSync(copilotPath)).toBe(true);
    expect(fs.readFileSync(copilotPath, "utf8")).toContain("# Shared AI guidance");

    // Then: antigravity goes to .gemini/GEMINI.md — a different file
    const antigravityPath = path.join(homeDir, ".gemini", "GEMINI.md");
    expect(fs.existsSync(antigravityPath)).toBe(true);
    expect(fs.readFileSync(antigravityPath, "utf8")).toContain(
      "# Shared AI guidance",
    );

    // Paths must be different files
    expect(copilotPath).not.toBe(antigravityPath);
  });

  it("removes a bundle that is in desired_state but not materialized", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".claude/skills/react/SKILL.md",
      "# react\n",
    );
    await run(["add", "--global", "react-expert"], { homeDir });
    // Reset clears materialized state but keeps desired_state
    await run(["reset", "--global"], { homeDir, prompts: createPromptStub() });

    const registryBefore = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    expect(registryBefore.global!.desired_state).toHaveLength(1);
    expect(registryBefore.global!.materialized_state.bundles).toEqual({});

    // When: remove from desired_state without a materialized bundle present
    const output = await run(["remove", "--global", "react-expert"], {
      homeDir,
      prompts: createPromptStub(),
    });

    // Then
    expect(output).toContain("Removed global react-expert");
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    expect(registry.global).toBeUndefined();
  });
});

function createHomeDir(): string {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-home-"));
  tempDirs.push(homeDir);
  return homeDir;
}

function writeManifest(
  homeDir: string,
  source: string,
  bundle: string,
  manifest: object,
): void {
  const bundleDir = path.join(
    homeDir,
    ".skul",
    "library",
    ...source.split("/"),
    bundle,
  );
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(
    path.join(bundleDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}

function writeBundleFile(
  homeDir: string,
  source: string | undefined,
  bundle: string,
  relativePath: string,
  content: string,
): void {
  const libraryDir = path.join(homeDir, ".skul", "library");
  const bundleDir = source
    ? path.join(libraryDir, ...source.split("/"), bundle)
    : path.join(libraryDir, bundle);
  const filePath = path.join(bundleDir, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function pathExists(targetPath: string): boolean {
  return fs.existsSync(targetPath);
}

function createPromptStub(overrides: Partial<PromptClient> = {}): PromptClient {
  return {
    selectBundle: async () => {
      throw new Error("selectBundle should not be called in this test");
    },
    selectBundleItems: async (_available, selected) => selected,
    selectAgents: async (agents) => agents,
    resolveFileConflict: async () => ({ action: "prefix", prefix: "p" }),
    confirmManagedFileRemoval: async () => true,
    ...overrides,
  };
}
