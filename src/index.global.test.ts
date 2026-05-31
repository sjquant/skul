import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PromptClient } from "./cli";
import { run } from "./index";
import { readRegistryFile, writeRegistryFile } from "./registry";
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

  it("does not remove a same-named global bundle from a different explicit source", async () => {
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
    await run(["add", "--global", "github.com/user/ai-vault", "react-expert"], {
      homeDir,
    });
    const selectBundle = vi.fn().mockResolvedValue({
      bundle: "react-expert",
      source: "github.com/other/ai-vault",
    });

    // When / Then
    await expect(
      run(["remove", "--global", "github.com/other/ai-vault", "react-expert"], {
        homeDir,
        prompts: createPromptStub({ selectBundle }),
      }),
    ).rejects.toThrowError(/Bundle not found in global active set/);
    expect(selectBundle).not.toHaveBeenCalled();
    expect(
      fs.readFileSync(
        path.join(homeDir, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
  });

  it("selects an active source-scoped global bundle from state when removing by source", async () => {
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
    await run(["add", "--global", "github.com/user/ai-vault", "react-expert"], {
      homeDir,
    });
    const selectBundle = vi.fn().mockResolvedValue({
      bundle: "react-expert",
      source: "github.com/user/ai-vault",
    });
    fs.rmSync(path.join(homeDir, ".skul", "library", "github.com", "user"), {
      recursive: true,
      force: true,
    });

    // When
    await expect(
      run(["remove", "--global", "github.com/user/ai-vault"], {
        homeDir,
        prompts: createPromptStub({ selectBundle }),
      }),
    ).resolves.toBe("Removed global react-expert");

    // Then
    expect(selectBundle).not.toHaveBeenCalled();
    expect(
      pathExists(path.join(homeDir, ".claude", "skills", "react", "SKILL.md")),
    ).toBe(false);
    expect(
      readRegistryFile(path.join(homeDir, ".skul", "registry.json")).global,
    ).toBeUndefined();
  });

  it("keeps same-named global desired bundles from other sources during source-scoped remove", async () => {
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
    await run(["add", "--global", "github.com/user/ai-vault", "react-expert"], {
      homeDir,
    });
    const registryFile = path.join(homeDir, ".skul", "registry.json");
    const registry = readRegistryFile(registryFile);
    registry.global!.desired_state.push({
      bundle: "react-expert",
      source: "github.com/other/ai-vault",
      protocol: "https",
    });
    writeRegistryFile(registryFile, registry);

    // When
    await expect(
      run(["remove", "--global", "github.com/user/ai-vault", "react-expert"], {
        homeDir,
        prompts: createPromptStub(),
      }),
    ).resolves.toBe("Removed global react-expert");

    // Then
    expect(readRegistryFile(registryFile).global?.desired_state).toEqual([
      {
        bundle: "react-expert",
        source: "github.com/other/ai-vault",
        protocol: "https",
      },
    ]);
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

  it("installs a codex-only bundle globally", async () => {
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

    // When
    const output = await run(["add", "--global", "codex-only"], { homeDir });

    // Then
    expect(output).toContain("Applied codex-only globally for codex");
    expect(
      pathExists(path.join(homeDir, ".agents", "skills", "task", "SKILL.md")),
    ).toBe(true);
  });

  it("installs opencode content to its global config directory", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "opencode-only", {
      name: "opencode-only",
      tools: {
        opencode: {
          skills: { path: ".opencode/skills" },
          commands: { path: ".opencode/commands" },
          root_instruction: { path: "AGENTS.md" },
        },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "opencode-only",
      ".opencode/skills/review/SKILL.md",
      "# review\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "opencode-only",
      ".opencode/commands/check.md",
      "# check\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "opencode-only",
      "AGENTS.md",
      "# OpenCode guidance\n",
    );

    // When
    const output = await run(["add", "--global", "opencode-only"], {
      homeDir,
    });

    // Then
    expect(output).toContain("Applied opencode-only globally for opencode");
    expect(
      pathExists(
        path.join(
          homeDir,
          ".config",
          "opencode",
          "skills",
          "review",
          "SKILL.md",
        ),
      ),
    ).toBe(true);
    expect(
      pathExists(
        path.join(homeDir, ".config", "opencode", "commands", "check.md"),
      ),
    ).toBe(true);
    expect(
      fs.readFileSync(
        path.join(homeDir, ".config", "opencode", "AGENTS.md"),
        "utf8",
      ),
    ).toContain("# OpenCode guidance");
  });

  it("passes the relative conflict path to the callback for remapped global canonical targets", async () => {
    // Given
    const homeDir = createHomeDir();
    const resolveFileConflict = vi.fn().mockResolvedValue({
      action: "overwrite",
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "opencode-canonical", {
      name: "opencode-canonical",
      tools: { opencode: { skills: { path: "skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "opencode-canonical",
      "skills/review/SKILL.md",
      "---\nname: review\ndescription: Review code\n---\nReview carefully.\n",
    );
    fs.mkdirSync(
      path.join(homeDir, ".config", "opencode", "skills", "review"),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(homeDir, ".config", "opencode", "skills", "review", "SKILL.md"),
      "user file\n",
    );

    // When
    const output = await run(
      ["add", "--global", "opencode-canonical", "--agent", "opencode"],
      {
        homeDir,
        prompts: createPromptStub({ resolveFileConflict }),
      },
    );

    // Then
    expect(output).toContain(
      "Applied opencode-canonical globally for opencode",
    );
    // Then: callback is called with the path relative to the tool target root (not the remapped abs path)
    expect(resolveFileConflict).toHaveBeenCalledWith("review/SKILL.md");
    // Then: bundle file overwrites the user's file at the same location
    expect(
      fs.readFileSync(
        path.join(
          homeDir,
          ".config",
          "opencode",
          "skills",
          "review",
          "SKILL.md",
        ),
        "utf8",
      ),
    ).toContain("Review carefully.");
    expect(
      pathExists(
        path.join(
          homeDir,
          ".config",
          "opencode",
          "p-skills",
          "review",
          "SKILL.md",
        ),
      ),
    ).toBe(false);
  });

  it("applies only selected bundle items in global mode", async () => {
    // Given
    const homeDir = createHomeDir();
    const selectBundleItems = vi.fn().mockResolvedValue(["skills/review"]);
    writeManifest(homeDir, "github.com/user/ai-vault", "codex-only", {
      name: "codex-only",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "codex-only",
      ".agents/skills/next-task/SKILL.md",
      "# next task\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "codex-only",
      ".agents/skills/review/SKILL.md",
      "# review\n",
    );

    // When
    const output = await run(
      ["add", "--global", "codex-only", "--agent", "codex", "--select-items"],
      {
        homeDir,
        prompts: createPromptStub({ selectBundleItems }),
      },
    );

    // Then
    expect(output).toContain(
      "Applied codex-only globally for codex: skills/review",
    );
    expect(selectBundleItems).toHaveBeenCalledWith(
      ["skills/next-task", "skills/review"],
      [],
    );
    expect(
      pathExists(
        path.join(homeDir, ".agents", "skills", "next-task", "SKILL.md"),
      ),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(homeDir, ".agents", "skills", "review", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# review\n");

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    expect(registry.global!.desired_state[0]!.items).toEqual(["skills/review"]);
    expect(
      registry.global!.materialized_state.bundles["codex-only"]!.tools.codex!
        .items,
    ).toEqual(["skills/review"]);
  });

  it("offers only active bundle items when removing selected global items", async () => {
    // Given
    const homeDir = createHomeDir();
    const selectBundleItemChoices = vi.fn(
      async (choices: Array<{ value: string }>) =>
        choices.map((choice) => choice.value),
    );
    const selectBundleFromSelections = vi.fn(async () => {
      throw new Error("selectBundleFromSelections should not be called");
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "codex-only", {
      name: "codex-only",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "codex-only",
      ".agents/skills/next-task/SKILL.md",
      "# next task\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "codex-only",
      ".agents/skills/review/SKILL.md",
      "# review\n",
    );
    await run(
      [
        "add",
        "--global",
        "codex-only",
        "--agent",
        "codex",
        "--include",
        "skills/next-task",
      ],
      { homeDir },
    );

    // When
    await expect(
      run(["remove", "--global", "codex-only", "--select-items"], {
        homeDir,
        prompts: createPromptStub({
          selectBundleFromSelections,
          selectBundleItemChoices,
        }),
      }),
    ).resolves.toBe("Removed codex-only: skills/next-task from global bundles");

    // Then
    expect(selectBundleFromSelections).not.toHaveBeenCalled();
    expect(selectBundleItemChoices).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          label: "github.com/user/ai-vault / codex-only: skills/next-task",
        }),
      ],
      [],
      "remove",
    );
    expect(
      pathExists(
        path.join(homeDir, ".agents", "skills", "next-task", "SKILL.md"),
      ),
    ).toBe(false);
    expect(
      readRegistryFile(path.join(homeDir, ".skul", "registry.json")).global,
    ).toBeUndefined();
  });

  it("selects removable items across global bundles without selecting a bundle first", async () => {
    // Given
    const homeDir = createHomeDir();
    const selectBundleFromSelections = vi.fn(async () => {
      throw new Error("selectBundleFromSelections should not be called");
    });
    const selectBundleItemChoices = vi.fn(
      async (choices: Array<{ value: string; label: string }>) =>
        choices
          .filter(
            (choice) =>
              choice.label.endsWith("core: skills/review") ||
              choice.label.endsWith("extras: skills/audit"),
          )
          .map((choice) => choice.value),
    );
    writeManifest(homeDir, "github.com/user/ai-vault", "core", {
      name: "core",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "core",
      ".agents/skills/next-task/SKILL.md",
      "# next task\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "core",
      ".agents/skills/review/SKILL.md",
      "# review\n",
    );
    writeManifest(homeDir, "github.com/user/ai-vault", "extras", {
      name: "extras",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "extras",
      ".agents/skills/audit/SKILL.md",
      "# audit\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "extras",
      ".agents/skills/plan/SKILL.md",
      "# plan\n",
    );
    await run(
      [
        "add",
        "--global",
        "github.com/user/ai-vault",
        "core",
        "--agent",
        "codex",
      ],
      {
        homeDir,
        prompts: createPromptStub(),
      },
    );
    await run(
      [
        "add",
        "--global",
        "github.com/user/ai-vault",
        "extras",
        "--agent",
        "codex",
      ],
      {
        homeDir,
        prompts: createPromptStub(),
      },
    );

    // When
    await expect(
      run(["remove", "--global", "--select-items"], {
        homeDir,
        prompts: createPromptStub({
          selectBundleFromSelections,
          selectBundleItemChoices,
        }),
      }),
    ).resolves.toBe(
      "Removed core: skills/review, extras: skills/audit from global bundles",
    );

    // Then
    expect(selectBundleFromSelections).not.toHaveBeenCalled();
    expect(selectBundleItemChoices).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          label: "github.com/user/ai-vault / core: skills/next-task",
        }),
        expect.objectContaining({
          label: "github.com/user/ai-vault / core: skills/review",
        }),
        expect.objectContaining({
          label: "github.com/user/ai-vault / extras: skills/audit",
        }),
        expect.objectContaining({
          label: "github.com/user/ai-vault / extras: skills/plan",
        }),
      ],
      [],
      "remove",
    );
    expect(
      pathExists(path.join(homeDir, ".agents", "skills", "review", "SKILL.md")),
    ).toBe(false);
    expect(
      pathExists(path.join(homeDir, ".agents", "skills", "audit", "SKILL.md")),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(homeDir, ".agents", "skills", "next-task", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# next task\n");
    expect(
      fs.readFileSync(
        path.join(homeDir, ".agents", "skills", "plan", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# plan\n");
    expect(
      readRegistryFile(path.join(homeDir, ".skul", "registry.json")).global!
        .desired_state,
    ).toEqual([
      {
        bundle: "core",
        source: "github.com/user/ai-vault",
        tools: ["codex"],
        items: ["skills/next-task"],
        protocol: "https",
      },
      {
        bundle: "extras",
        source: "github.com/user/ai-vault",
        tools: ["codex"],
        items: ["skills/plan"],
        protocol: "https",
      },
    ]);
  });

  it("removes included items across global bundles without selecting a bundle first", async () => {
    // Given
    const homeDir = createHomeDir();
    const selectBundleFromSelections = vi.fn(async () => {
      throw new Error("selectBundleFromSelections should not be called");
    });
    const selectBundleItemChoices = vi.fn(async () => {
      throw new Error("selectBundleItemChoices should not be called");
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "core", {
      name: "core",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "core",
      ".agents/skills/next-task/SKILL.md",
      "# next task\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "core",
      ".agents/skills/review/SKILL.md",
      "# review\n",
    );
    writeManifest(homeDir, "github.com/user/ai-vault", "extras", {
      name: "extras",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "extras",
      ".agents/skills/audit/SKILL.md",
      "# audit\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "extras",
      ".agents/skills/plan/SKILL.md",
      "# plan\n",
    );
    await run(
      [
        "add",
        "--global",
        "github.com/user/ai-vault",
        "core",
        "--agent",
        "codex",
      ],
      {
        homeDir,
        prompts: createPromptStub(),
      },
    );
    await run(
      [
        "add",
        "--global",
        "github.com/user/ai-vault",
        "extras",
        "--agent",
        "codex",
      ],
      {
        homeDir,
        prompts: createPromptStub(),
      },
    );

    // When
    await expect(
      run(
        [
          "remove",
          "--global",
          "--include",
          "skills/review",
          "--include",
          "skills/audit",
        ],
        {
          homeDir,
          prompts: createPromptStub({
            selectBundleFromSelections,
            selectBundleItemChoices,
          }),
        },
      ),
    ).resolves.toBe(
      "Removed core: skills/review, extras: skills/audit from global bundles",
    );

    // Then
    expect(selectBundleFromSelections).not.toHaveBeenCalled();
    expect(selectBundleItemChoices).not.toHaveBeenCalled();
    expect(
      pathExists(path.join(homeDir, ".agents", "skills", "review", "SKILL.md")),
    ).toBe(false);
    expect(
      pathExists(path.join(homeDir, ".agents", "skills", "audit", "SKILL.md")),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(homeDir, ".agents", "skills", "next-task", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# next task\n");
    expect(
      fs.readFileSync(
        path.join(homeDir, ".agents", "skills", "plan", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# plan\n");
  });

  it("cleans up global bundles fully removed by included items", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "core", {
      name: "core",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "core",
      ".agents/skills/review/SKILL.md",
      "# review\n",
    );
    writeManifest(homeDir, "github.com/user/ai-vault", "extras", {
      name: "extras",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "extras",
      ".agents/skills/audit/SKILL.md",
      "# audit\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "extras",
      ".agents/skills/plan/SKILL.md",
      "# plan\n",
    );
    await run(
      [
        "add",
        "--global",
        "github.com/user/ai-vault",
        "core",
        "--agent",
        "codex",
      ],
      {
        homeDir,
        prompts: createPromptStub(),
      },
    );
    await run(
      [
        "add",
        "--global",
        "github.com/user/ai-vault",
        "extras",
        "--agent",
        "codex",
      ],
      {
        homeDir,
        prompts: createPromptStub(),
      },
    );

    // When
    await expect(
      run(
        [
          "remove",
          "--global",
          "--include",
          "skills/review",
          "--include",
          "skills/audit",
        ],
        {
          homeDir,
          prompts: createPromptStub(),
        },
      ),
    ).resolves.toBe(
      "Removed core: skills/review, extras: skills/audit from global bundles",
    );

    // Then
    expect(
      pathExists(path.join(homeDir, ".agents", "skills", "review", "SKILL.md")),
    ).toBe(false);
    expect(
      pathExists(path.join(homeDir, ".agents", "skills", "audit", "SKILL.md")),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(homeDir, ".agents", "skills", "plan", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# plan\n");
    const globalState = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    ).global!;
    expect(globalState.desired_state).toEqual([
      {
        bundle: "extras",
        source: "github.com/user/ai-vault",
        tools: ["codex"],
        items: ["skills/plan"],
        protocol: "https",
      },
    ]);
    expect(globalState.materialized_state.bundles.core).toBeUndefined();
    expect(
      globalState.materialized_state.bundles.extras?.tools.codex?.items,
    ).toEqual(["skills/plan"]);
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
    const targetPath = path.join(homeDir, ".github", "copilot-instructions.md");
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
    const copilotPath = path.join(
      homeDir,
      ".github",
      "copilot-instructions.md",
    );
    expect(fs.existsSync(copilotPath)).toBe(true);
    expect(fs.readFileSync(copilotPath, "utf8")).toContain(
      "# Shared AI guidance",
    );

    // Then: antigravity goes to .gemini/GEMINI.md — a different file
    const antigravityPath = path.join(homeDir, ".gemini", "GEMINI.md");
    expect(fs.existsSync(antigravityPath)).toBe(true);
    expect(fs.readFileSync(antigravityPath, "utf8")).toContain(
      "# Shared AI guidance",
    );

    // Paths must be different files
    expect(copilotPath).not.toBe(antigravityPath);
  });

  it("selects agents before opening a global source-scoped bundle picker", async () => {
    // Given
    const homeDir = createHomeDir();
    const promptOrder: string[] = [];
    const selectAgents = vi.fn().mockImplementation(async () => {
      promptOrder.push("agents");
      return ["codex"];
    });
    const selectBundle = vi.fn().mockImplementation(async () => {
      promptOrder.push("bundle");
      return {
        bundle: "core",
        source: "github.com/sjquant/ghosts",
      };
    });
    writeManifest(homeDir, "github.com/sjquant/ghosts", "core", {
      name: "core",
      tools: {
        "claude-code": { skills: { path: ".claude/skills" } },
        codex: { skills: { path: ".agents/skills" } },
      },
    });
    writeManifest(homeDir, "github.com/sjquant/ghosts", "sandbox", {
      name: "sandbox",
      tools: {
        "claude-code": { skills: { path: ".claude/skills" } },
        codex: { skills: { path: ".agents/skills" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".claude/skills/wdd/SKILL.md",
      "# claude wdd\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".agents/skills/wdd/SKILL.md",
      "# codex wdd\n",
    );

    // When
    await expect(
      run(["add", "--global", "sjquant/ghosts"], {
        homeDir,
        prompts: createPromptStub({ selectAgents, selectBundle }),
      }),
    ).resolves.toBe("Applied core globally for codex");

    // Then
    expect(promptOrder).toEqual(["agents", "bundle"]);
    expect(selectAgents).toHaveBeenCalledWith(["claude-code", "codex"]);
    expect(selectBundle).toHaveBeenCalledWith("github.com/sjquant/ghosts", [
      "codex",
    ]);
    expect(
      fs.readFileSync(
        path.join(homeDir, ".agents", "skills", "wdd", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# codex wdd\n");
    expect(
      pathExists(path.join(homeDir, ".claude", "skills", "wdd", "SKILL.md")),
    ).toBe(false);
  });

  it("selects items across global source-scoped bundles without selecting a bundle first", async () => {
    // Given
    const homeDir = createHomeDir();
    const promptOrder: string[] = [];
    const selectAgents = vi.fn().mockImplementation(async () => {
      promptOrder.push("agents");
      return ["codex"];
    });
    const selectBundle = vi.fn(async () => {
      throw new Error("selectBundle should not be called");
    });
    const selectBundleItemChoices = vi.fn(
      async (choices: Array<{ value: string; label: string }>) => {
        promptOrder.push("items");
        return choices
          .filter(
            (choice) =>
              choice.label.endsWith("core: skills/wdd") ||
              choice.label.endsWith("sandbox: skills/audit"),
          )
          .map((choice) => choice.value);
      },
    );
    writeManifest(homeDir, "github.com/sjquant/ghosts", "core", {
      name: "core",
      tools: {
        "claude-code": { skills: { path: ".claude/skills" } },
        codex: { skills: { path: ".agents/skills" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".claude/skills/wdd/SKILL.md",
      "# claude wdd\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".agents/skills/wdd/SKILL.md",
      "# codex wdd\n",
    );
    writeManifest(homeDir, "github.com/sjquant/ghosts", "sandbox", {
      name: "sandbox",
      tools: {
        "claude-code": { skills: { path: ".claude/skills" } },
        codex: { skills: { path: ".agents/skills" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "sandbox",
      ".claude/skills/audit/SKILL.md",
      "# claude audit\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "sandbox",
      ".agents/skills/audit/SKILL.md",
      "# codex audit\n",
    );

    // When
    await expect(
      run(["add", "--global", "sjquant/ghosts", "--select-items"], {
        homeDir,
        prompts: createPromptStub({
          selectAgents,
          selectBundle,
          selectBundleItemChoices,
        }),
      }),
    ).resolves.toBe(
      "Applied core globally for codex: skills/wdd\nApplied sandbox globally for codex: skills/audit",
    );

    // Then
    expect(promptOrder).toEqual(["agents", "items"]);
    expect(selectBundle).not.toHaveBeenCalled();
    expect(selectAgents).toHaveBeenCalledWith(["claude-code", "codex"]);
    expect(selectBundleItemChoices).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          label: "core: skills/wdd",
        }),
        expect.objectContaining({
          label: "sandbox: skills/audit",
        }),
      ],
      [],
      "install",
    );
    expect(
      fs.readFileSync(
        path.join(homeDir, ".agents", "skills", "wdd", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# codex wdd\n");
    expect(
      fs.readFileSync(
        path.join(homeDir, ".agents", "skills", "audit", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# codex audit\n");
    expect(
      pathExists(path.join(homeDir, ".claude", "skills", "wdd", "SKILL.md")),
    ).toBe(false);
  });

  it("replaces existing global items when selecting source-scoped bundle items", async () => {
    // Given
    const homeDir = createHomeDir();
    const selectBundle = vi.fn(async () => {
      throw new Error("selectBundle should not be called");
    });
    const selectBundleItemChoices = vi.fn(
      async (choices: Array<{ value: string; label: string }>) =>
        choices
          .filter((choice) => choice.label.endsWith("core: skills/review"))
          .map((choice) => choice.value),
    );
    writeManifest(homeDir, "github.com/sjquant/ghosts", "core", {
      name: "core",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".agents/skills/review/SKILL.md",
      "# review\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".agents/skills/wdd/SKILL.md",
      "# wdd\n",
    );
    writeManifest(homeDir, "github.com/sjquant/ghosts", "sandbox", {
      name: "sandbox",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    await run(
      [
        "add",
        "--global",
        "github.com/sjquant/ghosts",
        "core",
        "--agent",
        "codex",
        "--include",
        "skills/review",
        "--include",
        "skills/wdd",
      ],
      {
        homeDir,
        prompts: createPromptStub(),
      },
    );

    // When
    await expect(
      run(["add", "--global", "sjquant/ghosts", "--select-items"], {
        homeDir,
        prompts: createPromptStub({
          selectBundle,
          selectBundleItemChoices,
        }),
      }),
    ).resolves.toBe("Applied core globally for codex: skills/review");

    // Then
    expect(selectBundle).not.toHaveBeenCalled();
    expect(
      fs.readFileSync(
        path.join(homeDir, ".agents", "skills", "review", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# review\n");
    expect(
      pathExists(path.join(homeDir, ".agents", "skills", "wdd", "SKILL.md")),
    ).toBe(false);
    expect(
      readRegistryFile(path.join(homeDir, ".skul", "registry.json")).global!
        .desired_state,
    ).toEqual([
      {
        bundle: "core",
        source: "github.com/sjquant/ghosts",
        tools: ["codex"],
        items: ["skills/review"],
        protocol: "https",
      },
    ]);
  });

  it("removes an existing global source-scoped bundle when all of its items are deselected", async () => {
    // Given
    const homeDir = createHomeDir();
    let initiallySelectedLabels: string[] = [];
    const selectBundle = vi.fn(async () => {
      throw new Error("selectBundle should not be called");
    });
    const selectBundleItemChoices = vi.fn(
      async (
        choices: Array<{ value: string; label: string }>,
        selectedValues: string[],
      ) => {
        initiallySelectedLabels = choices
          .filter((choice) => selectedValues.includes(choice.value))
          .map((choice) => choice.label);

        return choices
          .filter((choice) => choice.label === "sandbox: skills/review")
          .map((choice) => choice.value);
      },
    );
    writeManifest(homeDir, "github.com/sjquant/ghosts", "core", {
      name: "core",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".agents/skills/review/SKILL.md",
      "# review\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".agents/skills/wdd/SKILL.md",
      "# wdd\n",
    );
    writeManifest(homeDir, "github.com/sjquant/ghosts", "sandbox", {
      name: "sandbox",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "sandbox",
      ".agents/skills/review/SKILL.md",
      "# sandbox review\n",
    );
    await run(
      [
        "add",
        "--global",
        "github.com/sjquant/ghosts",
        "core",
        "--agent",
        "codex",
        "--include",
        "skills/review",
        "--include",
        "skills/wdd",
      ],
      {
        homeDir,
        prompts: createPromptStub(),
      },
    );

    // When
    await expect(
      run(["add", "--global", "sjquant/ghosts", "--select-items"], {
        homeDir,
        prompts: createPromptStub({
          selectBundle,
          selectBundleItemChoices,
        }),
      }),
    ).resolves.toBe(
      "Removed global core\nApplied sandbox globally for codex: skills/review",
    );

    // Then
    expect(selectBundle).not.toHaveBeenCalled();
    expect(initiallySelectedLabels).toEqual([
      "core: skills/review",
      "core: skills/wdd",
    ]);
    expect(
      pathExists(path.join(homeDir, ".agents", "skills", "wdd", "SKILL.md")),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(homeDir, ".agents", "skills", "review", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# sandbox review\n");
    expect(
      readRegistryFile(path.join(homeDir, ".skul", "registry.json")).global!
        .desired_state,
    ).toEqual([
      {
        bundle: "sandbox",
        source: "github.com/sjquant/ghosts",
        tools: ["codex"],
        items: ["skills/review"],
        protocol: "https",
      },
    ]);
  });

  it("keeps other global agents when a partial-agent source-scoped item selection deselects a bundle", async () => {
    // Given
    const homeDir = createHomeDir();
    const selectAgents = vi.fn().mockResolvedValue(["codex"]);
    const selectBundle = vi.fn(async () => {
      throw new Error("selectBundle should not be called");
    });
    const selectBundleItemChoices = vi.fn(
      async (choices: Array<{ value: string; label: string }>) =>
        choices
          .filter((choice) => choice.label === "sandbox: skills/audit")
          .map((choice) => choice.value),
    );
    writeManifest(homeDir, "github.com/sjquant/ghosts", "core", {
      name: "core",
      tools: {
        "claude-code": { skills: { path: ".claude/skills" } },
        codex: { skills: { path: ".agents/skills" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".claude/skills/review/SKILL.md",
      "# claude review\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".agents/skills/review/SKILL.md",
      "# codex review\n",
    );
    writeManifest(homeDir, "github.com/sjquant/ghosts", "sandbox", {
      name: "sandbox",
      tools: {
        "claude-code": { skills: { path: ".claude/skills" } },
        codex: { skills: { path: ".agents/skills" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "sandbox",
      ".agents/skills/audit/SKILL.md",
      "# audit\n",
    );
    await run(
      [
        "add",
        "--global",
        "github.com/sjquant/ghosts",
        "core",
        "--agent",
        "claude-code",
        "--agent",
        "codex",
        "--include",
        "skills/review",
      ],
      {
        homeDir,
        prompts: createPromptStub(),
      },
    );

    // When
    await expect(
      run(["add", "--global", "sjquant/ghosts", "--select-items"], {
        homeDir,
        prompts: createPromptStub({
          selectAgents,
          selectBundle,
          selectBundleItemChoices,
        }),
      }),
    ).resolves.toBe("Applied sandbox globally for codex: skills/audit");

    // Then
    expect(selectAgents).toHaveBeenCalledWith(["claude-code", "codex"]);
    expect(selectBundle).not.toHaveBeenCalled();
    expect(
      fs.readFileSync(
        path.join(homeDir, ".claude", "skills", "review", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# claude review\n");
    expect(
      fs.readFileSync(
        path.join(homeDir, ".agents", "skills", "review", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# codex review\n");
    expect(
      fs.readFileSync(
        path.join(homeDir, ".agents", "skills", "audit", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# audit\n");
    expect(
      readRegistryFile(path.join(homeDir, ".skul", "registry.json")).global!
        .desired_state,
    ).toEqual([
      {
        bundle: "core",
        source: "github.com/sjquant/ghosts",
        tools: ["claude-code", "codex"],
        items: ["skills/review"],
        protocol: "https",
      },
      {
        bundle: "sandbox",
        source: "github.com/sjquant/ghosts",
        tools: ["codex"],
        items: ["skills/audit"],
        protocol: "https",
      },
    ]);
  });

  it("replaces desired tools (not unions) when re-applying without --agent after an explicit --agent install", async () => {
    // Given: first install explicitly selects only claude-code
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "team-guide", {
      name: "team-guide",
      tools: {
        "claude-code": { root_instruction: { path: "CLAUDE.md" } },
        copilot: { root_instruction: { path: "AGENTS.md" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "team-guide",
      "CLAUDE.md",
      "# Claude guidance\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "team-guide",
      "AGENTS.md",
      "# Shared guidance\n",
    );
    await run(["add", "--global", "--agent", "claude-code", "team-guide"], {
      homeDir,
    });

    // desired_state stores the explicit selection: only claude-code
    const registryBefore = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    expect(registryBefore.global!.desired_state[0]!.tools).toEqual([
      "claude-code",
    ]);

    // When: user re-applies without --agent (auto-select all globally-capable tools)
    await run(["add", "--global", "team-guide"], { homeDir });

    // Then: desired tools is REPLACED (not unioned) with the auto-selected set.
    // The bundle supports all globally-capable tools through root-instruction translation
    // so desired_state.tools is updated to reflect the current auto-selected set rather
    // than keeping the old explicit claude-code-only selection merged in.
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    expect(registry.global!.desired_state[0]!.tools).toEqual(
      expect.arrayContaining([
        "claude-code",
        "cursor",
        "opencode",
        "codex",
        "copilot",
        "kiro",
        "antigravity",
      ]),
    );
    // Crucially, the tools list is the REPLACED set (all auto-selected), not claude-code alone
    expect(registry.global!.desired_state[0]!.tools).toHaveLength(7);
  });

  it("unions desired tools when re-applying with an explicit --agent flag", async () => {
    // Given: bundle starts with claude-code only
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "team-guide", {
      name: "team-guide",
      tools: {
        "claude-code": { root_instruction: { path: "CLAUDE.md" } },
        copilot: { root_instruction: { path: "AGENTS.md" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "team-guide",
      "CLAUDE.md",
      "# Claude guidance\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "team-guide",
      "AGENTS.md",
      "# Shared guidance\n",
    );
    await run(["add", "--global", "--agent", "claude-code", "team-guide"], {
      homeDir,
    });

    const registryBefore = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    expect(registryBefore.global!.desired_state[0]!.tools).toEqual([
      "claude-code",
    ]);

    // When: re-apply with an explicit different --agent (should union)
    await run(["add", "--global", "--agent", "copilot", "team-guide"], {
      homeDir,
    });

    // Then: both tools are now in desired_state (unioned)
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    expect(registry.global!.desired_state[0]!.tools).toEqual(
      expect.arrayContaining(["claude-code", "copilot"]),
    );
  });

  it("installs newly global-capable tools without skipping them", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "mixed-bundle", {
      name: "mixed-bundle",
      tools: {
        "claude-code": { skills: { path: ".claude/skills" } },
        kiro: { skills: { path: ".kiro/skills" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "mixed-bundle",
      ".claude/skills/react/SKILL.md",
      "# react\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "mixed-bundle",
      ".kiro/skills/react/SKILL.md",
      "# react\n",
    );

    // When
    const output = await run(["add", "--global", "mixed-bundle"], { homeDir });

    // Then
    expect(output).toContain(
      "Applied mixed-bundle globally for claude-code, kiro",
    );
    expect(output).toContain("kiro");
    expect(output).not.toContain("skipped");
    expect(
      pathExists(path.join(homeDir, ".kiro", "skills", "react", "SKILL.md")),
    ).toBe(true);
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
  const defaults: PromptClient = {
    selectBundle: async () => {
      throw new Error("selectBundle should not be called in this test");
    },
    selectBundleFromSelections: async (availableBundles) => {
      if (availableBundles.length === 0) {
        throw new Error("selectBundleFromSelections received no bundles");
      }

      return availableBundles[0]!;
    },
    selectBundleItems: async (_available, selected) => selected,
    selectBundleItemChoices: async (_available, selected) => selected,
    selectAgents: async (agents) => agents,
    resolveFileConflict: async () => ({ action: "overwrite" }),
    confirmManagedFileRemoval: async () => true,
    confirmImport: async () => true,
  };

  return { ...defaults, ...overrides };
}
