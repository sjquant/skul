import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createHelpText,
  createPromptClientForSelections,
  parseCliArgs,
} from "./cli";
import {
  assertAgentsDocument,
  assertClaudeDocument,
  createHomeDir,
  createLinkedWorktree,
  createPromptClientStub,
  createRemoteBundleSource,
  createRepository,
  createSyncRepository,
  expectAgentsDocument,
  expectClaudeDocument,
  fingerprintFile,
  formatExpectedRootInstructionDocument,
  formatRootInstructionBundleBlock,
  formatTrackedRootInstructionShadowBlock,
  pathExists,
  pushSyncRepositoryUpdate,
  readGitIndexFlag,
  renderBundleListOutput,
  runGit,
  setupSharedRootInstructionBundles,
  tempDirs,
  updateRemoteBundleSource,
  writeBundleFile,
  writeManifest,
  writeRootInstructionBundleFixture,
} from "./cli.test-support";
import { detectGitContext } from "./git-context";
import { assertTrackedShadowSafety, run } from "./index";
import {
  createEmptyRegistry,
  readRegistryFile,
  upsertRepoState,
  upsertWorktreeState,
  writeRegistryFile,
} from "./registry";
import { renderTrackedRootInstructionShadow } from "./root-instruction-render";

describe("run", () => {
  it("dry-runs add without writing any files", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

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

    // When
    const output = await run(["add", "react-expert", "--dry-run"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // Then: output describes intent without materializing files
    expect(output).toMatch(/DRY RUN/);
    expect(output).toContain("react-expert");
    expect(
      fs.existsSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
      ),
    ).toBe(false);
  });

  it("dry-runs remove without deleting any files", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

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
    await run(["add", "react-expert"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When
    const output = await run(["remove", "react-expert", "--dry-run"], {
      homeDir,
      cwd: repoRoot,
    });

    // Then: output describes intent without deleting files
    expect(output).toMatch(/DRY RUN/);
    expect(output).toContain("react-expert");
    expect(
      fs.existsSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
      ),
    ).toBe(true);
  });

  it("dry-runs reset without deleting any files", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

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
    await run(["add", "react-expert"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When
    const output = await run(["reset", "--dry-run"], {
      homeDir,
      cwd: repoRoot,
    });

    // Then: output describes intent without deleting files
    expect(output).toMatch(/DRY RUN/);
    expect(output).toContain(".claude/skills/react/SKILL.md");
    expect(
      fs.existsSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
      ),
    ).toBe(true);
  });

  it("errors when add is run without a source or bundle name", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const { createHeadlessPromptClient } = await import("./cli");

    // When / Then
    await expect(
      run(["add"], {
        homeDir,
        cwd: repoRoot,
        prompts: createHeadlessPromptClient(),
      }),
    ).rejects.toThrowError(/Command add requires a source or bundle name/);
  });

  it("errors in headless mode when a modified managed file would be deleted", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const { createHeadlessPromptClient } = await import("./cli");

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
    await run(["add", "react-expert"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    fs.writeFileSync(
      path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
      "# modified\n",
    );

    // When / Then: headless client throws instead of prompting
    await expect(
      run(["reset"], {
        homeDir,
        cwd: repoRoot,
        prompts: createHeadlessPromptClient(),
      }),
    ).rejects.toThrowError(
      /Modified managed file blocks reset in headless mode/,
    );
  });

  it("throws in headless mode when a file conflict is encountered", async () => {
    // Given
    const { createHeadlessPromptClient } = await import("./cli");

    // When / Then
    await expect(
      createHeadlessPromptClient().resolveFileConflict("AGENTS.md"),
    ).rejects.toThrowError(/file already exists \(headless mode\)/i);
  });

  it("returns overwrite when the user confirms the interactive conflict prompt", async () => {
    // Given
    const confirm = vi.fn().mockResolvedValue(true);
    const loadPrompts = vi.fn().mockResolvedValue({
      isCancel: () => false,
      confirm,
    });
    const { createPromptClientForSelections } = await import("./cli");

    // When
    const resolution = await createPromptClientForSelections(
      [],
      loadPrompts,
    ).resolveFileConflict("CLAUDE.md");

    // Then
    expect(resolution).toEqual({ action: "overwrite" });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("CLAUDE.md"),
      }),
    );
  });

  it("throws when the user declines the interactive conflict prompt", async () => {
    // Given
    const confirm = vi.fn().mockResolvedValue(false);
    const loadPrompts = vi.fn().mockResolvedValue({
      isCancel: () => false,
      confirm,
    });
    const { createPromptClientForSelections } = await import("./cli");

    // When / Then
    await expect(
      createPromptClientForSelections([], loadPrompts).resolveFileConflict(
        "CLAUDE.md",
      ),
    ).rejects.toThrowError(/conflict not resolved/i);
  });

  it("explains Space and Enter roles in multiselect prompts", async () => {
    // Given
    const multiselect = vi
      .fn()
      .mockResolvedValueOnce(["skills/review"])
      .mockResolvedValueOnce(["codex"]);
    const loadPrompts = async () =>
      ({
        isCancel: () => false,
        multiselect,
      }) as unknown as typeof import("@clack/prompts");
    const prompts = createPromptClientForSelections([], loadPrompts);

    // When
    await expect(
      prompts.selectBundleItems(["skills/review"], []),
    ).resolves.toEqual(["skills/review"]);
    await expect(prompts.selectAgents(["codex"])).resolves.toEqual(["codex"]);

    // Then
    expect(multiselect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        message: expect.stringMatching(/Space toggles choices; Enter confirms/),
      }),
    );
    expect(multiselect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message: expect.stringMatching(/Space toggles choices; Enter confirms/),
      }),
    );
  });

  it("activates headless mode via SKUL_NO_TUI environment variable", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    // When / Then: SKUL_NO_TUI=1 still rejects the unscoped add form before prompting.
    process.env["SKUL_NO_TUI"] = "1";
    try {
      await expect(
        run(["add"], {
          homeDir,
          cwd: repoRoot,
          prompts: createPromptClientStub(),
        }),
      ).rejects.toThrowError(/Command add requires a source or bundle name/);
    } finally {
      delete process.env["SKUL_NO_TUI"];
    }
  });

  it("does not open a global bundle selector when add is run without arguments", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const selectBundle = vi.fn().mockResolvedValue({ bundle: "react-expert" });

    // When / Then
    await expect(
      run(["add"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ selectBundle }),
      }),
    ).rejects.toThrowError(/Command add requires a source or bundle name/);

    // Then
    expect(selectBundle).not.toHaveBeenCalled();
  });

  it("selects a bundle from a multi-bundle source when the single source argument has no repo-slug bundle", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/sjquant/ghosts", "codex", {
      name: "codex",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeManifest(homeDir, "github.com/sjquant/ghosts", "core", {
      name: "core",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeManifest(homeDir, "github.com/sjquant/ghosts", "sandbox", {
      name: "sandbox",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".agents/skills/wdd/SKILL.md",
      "# wdd\n",
    );
    const selectBundle = vi.fn().mockResolvedValue({
      bundle: "core",
      source: "github.com/sjquant/ghosts",
    });

    // When
    await expect(
      run(["add", "sjquant/ghosts"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ selectBundle }),
      }),
    ).resolves.toBe("Applied core for codex");

    // Then
    expect(selectBundle).toHaveBeenCalledWith("github.com/sjquant/ghosts");
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "wdd", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# wdd\n");
  });

  it("selects agents before opening a source-scoped bundle picker", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
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
        codex: { skills: { path: ".agents/skills" } },
        cursor: { skills: { path: ".cursor/skills" } },
      },
    });
    writeManifest(homeDir, "github.com/sjquant/ghosts", "sandbox", {
      name: "sandbox",
      tools: {
        codex: { skills: { path: ".agents/skills" } },
        cursor: { skills: { path: ".cursor/skills" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".agents/skills/wdd/SKILL.md",
      "# wdd\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".cursor/skills/wdd/SKILL.md",
      "# cursor wdd\n",
    );

    // When
    await expect(
      run(["add", "sjquant/ghosts"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ selectAgents, selectBundle }),
      }),
    ).resolves.toBe("Applied core for codex");

    // Then
    expect(promptOrder).toEqual(["agents", "bundle"]);
    expect(selectAgents).toHaveBeenCalledWith(["codex", "cursor"]);
    expect(selectBundle).toHaveBeenCalledWith("github.com/sjquant/ghosts", [
      "codex",
    ]);
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "wdd", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# wdd\n");
    expect(
      pathExists(path.join(repoRoot, ".cursor", "skills", "wdd", "SKILL.md")),
    ).toBe(false);
  });

  it("adds every bundle from a source when add uses all", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "core", {
      name: "core",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "extras", {
      name: "extras",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "core",
      ".agents/skills/core/SKILL.md",
      "# core\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "extras",
      ".agents/skills/extras/SKILL.md",
      "# extras\n",
    );

    // When
    await expect(
      run(["add", "github.com/user/ai-vault", "--all"], {
        homeDir,
        cwd: repoRoot,
      }),
    ).resolves.toBe("Applied core for codex\nApplied extras for codex");

    // Then
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "core", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# core\n");
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "extras", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# extras\n");
  });

  it("dry-runs all bundles from an uncached source without creating local state", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    // When
    await expect(
      run(["add", "github.com/user/ai-vault", "--all", "--dry-run"], {
        homeDir,
        cwd: repoRoot,
      }),
    ).resolves.toBe(
      "(would clone github.com/user/ai-vault)\nDRY RUN: Would apply all bundles from github.com/user/ai-vault",
    );

    // Then
    expect(
      pathExists(
        path.join(
          homeDir,
          ".skul",
          "library",
          "github.com",
          "user",
          "ai-vault",
        ),
      ),
    ).toBe(false);
    expect(pathExists(path.join(homeDir, ".skul", "registry.json"))).toBe(
      false,
    );
    expect(pathExists(path.join(repoRoot, ".agents"))).toBe(false);
  });

  it("dry-runs all cached bundles without refreshing or writing local state", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "core", {
      name: "core",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "core",
      ".agents/skills/core/SKILL.md",
      "# core\n",
    );

    // When
    await expect(
      run(["add", "github.com/user/ai-vault", "--all", "--dry-run"], {
        homeDir,
        cwd: repoRoot,
      }),
    ).resolves.toBe("DRY RUN: Would apply core for codex");

    // Then
    expect(pathExists(path.join(homeDir, ".skul", "registry.json"))).toBe(
      false,
    );
    expect(
      pathExists(path.join(repoRoot, ".agents", "skills", "core", "SKILL.md")),
    ).toBe(false);
  });

  it("adds every globally installable bundle from a source when global add uses all", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "core", {
      name: "core",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "extras", {
      name: "extras",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "core",
      ".claude/skills/core/SKILL.md",
      "# core\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "extras",
      ".agents/skills/extras/SKILL.md",
      "# extras\n",
    );

    // When
    await expect(
      run(["add", "--global", "github.com/user/ai-vault", "--all"], {
        homeDir,
      }),
    ).resolves.toBe(
      "Applied core globally for claude-code\nApplied extras globally for codex",
    );

    // Then
    expect(
      fs.readFileSync(
        path.join(homeDir, ".claude", "skills", "core", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# core\n");
    expect(
      fs.readFileSync(
        path.join(homeDir, ".agents", "skills", "extras", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# extras\n");
  });

  it("installs all available agents without prompting when add uses yes", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const selectAgents = vi.fn(async () => {
      throw new Error("selectAgents should not be called");
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: {
        codex: { skills: { path: ".agents/skills" } },
        cursor: { skills: { path: ".cursor/skills" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".agents/skills/wdd/SKILL.md",
      "# wdd\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".cursor/skills/wdd/SKILL.md",
      "# cursor wdd\n",
    );

    // When
    await expect(
      run(["add", "react-expert", "-y"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ selectAgents }),
      }),
    ).resolves.toBe("Applied react-expert for codex, cursor");

    // Then
    expect(selectAgents).not.toHaveBeenCalled();
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "wdd", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# wdd\n");
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".cursor", "skills", "wdd", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# cursor wdd\n");
  });

  it("selects items across source-scoped bundles without selecting a bundle first", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
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
        codex: { skills: { path: ".agents/skills" } },
        cursor: { skills: { path: ".cursor/skills" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".agents/skills/wdd/SKILL.md",
      "# wdd\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".cursor/skills/wdd/SKILL.md",
      "# cursor wdd\n",
    );
    writeManifest(homeDir, "github.com/sjquant/ghosts", "sandbox", {
      name: "sandbox",
      tools: {
        codex: { skills: { path: ".agents/skills" } },
        cursor: { skills: { path: ".cursor/skills" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "sandbox",
      ".agents/skills/audit/SKILL.md",
      "# audit\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "sandbox",
      ".cursor/skills/audit/SKILL.md",
      "# cursor audit\n",
    );

    // When
    await expect(
      run(["add", "sjquant/ghosts", "--select-items"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          selectAgents,
          selectBundle,
          selectBundleItemChoices,
        }),
      }),
    ).resolves.toBe(
      "Applied core for codex: skills/wdd\nApplied sandbox for codex: skills/audit",
    );

    // Then
    expect(promptOrder).toEqual(["agents", "items"]);
    expect(selectBundle).not.toHaveBeenCalled();
    expect(selectAgents).toHaveBeenCalledWith(["codex", "cursor"]);
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
        path.join(repoRoot, ".agents", "skills", "wdd", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# wdd\n");
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "audit", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# audit\n");
  });

  it("replaces existing items when selecting source-scoped bundle items", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
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
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      },
    );

    // When
    await expect(
      run(["add", "sjquant/ghosts", "--select-items"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          selectBundle,
          selectBundleItemChoices,
        }),
      }),
    ).resolves.toBe("Applied core for codex: skills/review");

    // Then
    expect(selectBundle).not.toHaveBeenCalled();
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "review", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# review\n");
    expect(
      pathExists(path.join(repoRoot, ".agents", "skills", "wdd", "SKILL.md")),
    ).toBe(false);
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const repoFingerprint = detectGitContext({
      cwd: repoRoot,
    })!.repoFingerprint;
    expect(registry.repos[repoFingerprint]?.desired_state).toEqual([
      {
        bundle: "core",
        source: "github.com/sjquant/ghosts",
        tools: ["codex"],
        items: ["skills/review"],
        protocol: "https",
      },
    ]);
  });

  it("removes an existing source-scoped bundle when all of its items are deselected", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
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
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      },
    );

    // When
    await expect(
      run(["add", "sjquant/ghosts", "--select-items"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          selectBundle,
          selectBundleItemChoices,
        }),
      }),
    ).resolves.toBe("Removed core\nApplied sandbox for codex: skills/review");

    // Then
    expect(selectBundle).not.toHaveBeenCalled();
    expect(initiallySelectedLabels).toEqual([
      "core: skills/review",
      "core: skills/wdd",
    ]);
    expect(
      pathExists(path.join(repoRoot, ".agents", "skills", "wdd", "SKILL.md")),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "review", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# sandbox review\n");
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const repoFingerprint = detectGitContext({
      cwd: repoRoot,
    })!.repoFingerprint;
    expect(registry.repos[repoFingerprint]?.desired_state).toEqual([
      {
        bundle: "sandbox",
        source: "github.com/sjquant/ghosts",
        tools: ["codex"],
        items: ["skills/review"],
        protocol: "https",
      },
    ]);
  });

  it("keeps other agents when a partial-agent source-scoped item selection deselects a bundle", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
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
        codex: { skills: { path: ".agents/skills" } },
        cursor: { skills: { path: ".cursor/skills" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".agents/skills/review/SKILL.md",
      "# codex review\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".cursor/skills/review/SKILL.md",
      "# cursor review\n",
    );
    writeManifest(homeDir, "github.com/sjquant/ghosts", "sandbox", {
      name: "sandbox",
      tools: {
        codex: { skills: { path: ".agents/skills" } },
        cursor: { skills: { path: ".cursor/skills" } },
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
        "github.com/sjquant/ghosts",
        "core",
        "--agent",
        "codex",
        "--agent",
        "cursor",
        "--include",
        "skills/review",
      ],
      {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      },
    );

    // When
    await expect(
      run(["add", "sjquant/ghosts", "--select-items"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          selectAgents,
          selectBundle,
          selectBundleItemChoices,
        }),
      }),
    ).resolves.toBe("Applied sandbox for codex: skills/audit");

    // Then
    expect(selectAgents).toHaveBeenCalledWith(["codex", "cursor"]);
    expect(selectBundle).not.toHaveBeenCalled();
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "review", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# codex review\n");
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".cursor", "skills", "review", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# cursor review\n");
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "audit", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# audit\n");
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const repoFingerprint = detectGitContext({
      cwd: repoRoot,
    })!.repoFingerprint;
    expect(registry.repos[repoFingerprint]?.desired_state).toEqual([
      {
        bundle: "core",
        source: "github.com/sjquant/ghosts",
        tools: ["codex", "cursor"],
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

  it("uses an explicit agent to narrow source-scoped bundle selection", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const selectAgents = vi.fn();
    const selectBundle = vi.fn().mockResolvedValue({
      bundle: "core",
      source: "github.com/sjquant/ghosts",
    });
    writeManifest(homeDir, "github.com/sjquant/ghosts", "core", {
      name: "core",
      tools: {
        codex: { skills: { path: ".agents/skills" } },
        cursor: { skills: { path: ".cursor/skills" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".agents/skills/wdd/SKILL.md",
      "# wdd\n",
    );

    // When
    await expect(
      run(["add", "sjquant/ghosts", "--agent", "codex"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ selectAgents, selectBundle }),
      }),
    ).resolves.toBe("Applied core for codex");

    // Then
    expect(selectAgents).not.toHaveBeenCalled();
    expect(selectBundle).toHaveBeenCalledWith("github.com/sjquant/ghosts", [
      "codex",
    ]);
  });

  it("keeps the selected source-scoped bundle when a ref selector is requested", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const remoteSource = createRemoteBundleSource(homeDir, {
      source: "github.com/sjquant/ghosts",
      bundle: "core",
      manifest: {
        tools: { codex: { skills: { path: ".agents/skills" } } },
      },
      files: {
        ".agents/skills/wdd/SKILL.md": "# wdd\n",
      },
    });
    runGit(remoteSource.remoteRepoPath, ["checkout", "-b", "stable"]);
    const selectBundle = vi.fn().mockResolvedValue({
      bundle: "core",
      source: "github.com/sjquant/ghosts",
    });

    // When
    await expect(
      run(["add", "sjquant/ghosts", "--ref", "stable"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ selectBundle }),
      }),
    ).resolves.toBe("Applied core for codex");

    // Then
    expect(selectBundle).toHaveBeenCalledWith("github.com/sjquant/ghosts");
    expect(
      readRegistryFile(path.join(homeDir, ".skul", "registry.json")).repos[
        detectGitContext({ cwd: repoRoot })!.repoFingerprint
      ]?.desired_state,
    ).toContainEqual({
      bundle: "core",
      source: "github.com/sjquant/ghosts",
      protocol: "https",
      ref: "stable",
      resolved_ref: "stable",
      resolved_commit: remoteSource.initialCommit,
    });
  });

  it("selects from the requested cached source when duplicate bundle names exist", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".claude/skills/react/SKILL.md",
      "# first\n",
    );
    writeManifest(homeDir, "github.com/other/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/other/ai-vault",
      "react-expert",
      ".claude/skills/react/SKILL.md",
      "# second\n",
    );
    const selectBundle = vi.fn().mockResolvedValue({
      bundle: "react-expert",
      source: "github.com/other/ai-vault",
    });

    // When
    await expect(
      run(["add", "github.com/other/ai-vault"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ selectBundle }),
      }),
    ).resolves.toBe("Applied react-expert for claude-code");

    // Then
    expect(selectBundle).toHaveBeenCalledWith("github.com/other/ai-vault");
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# second\n");
    expect(
      readRegistryFile(path.join(homeDir, ".skul", "registry.json")).repos[
        detectGitContext({ cwd: repoRoot })!.repoFingerprint
      ]?.desired_state,
    ).toContainEqual({
      bundle: "react-expert",
      source: "github.com/other/ai-vault",
      protocol: "https",
    });
  });

  it("records the requested SSH protocol when source-scoped selection is used", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
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
    const selectBundle = vi.fn().mockResolvedValue({
      bundle: "react-expert",
      source: "github.com/user/ai-vault",
    });

    // When
    await expect(
      run(["add", "github.com/user/ai-vault", "--ssh"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ selectBundle }),
      }),
    ).resolves.toBe("Applied react-expert for claude-code");

    // Then
    expect(selectBundle).toHaveBeenCalledWith("github.com/user/ai-vault");
    expect(
      readRegistryFile(path.join(homeDir, ".skul", "registry.json")).repos[
        detectGitContext({ cwd: repoRoot })!.repoFingerprint
      ]?.desired_state,
    ).toContainEqual({
      bundle: "react-expert",
      source: "github.com/user/ai-vault",
      protocol: "ssh",
    });
  });

  it("applies a cached bundle into the current repository and records ownership", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
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

    // When
    await expect(
      run(["add", "react-expert"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe("Applied react-expert for claude-code");

    // Then
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
    expect(
      fs.readFileSync(path.join(repoRoot, ".git", "info", "exclude"), "utf8"),
    ).toContain(".claude/skills/react/SKILL.md");
    expect(
      readRegistryFile(path.join(homeDir, ".skul", "registry.json")).worktrees,
    ).toHaveProperty(
      Object.keys(
        readRegistryFile(path.join(homeDir, ".skul", "registry.json"))
          .worktrees,
      )[0],
    );
  });

  it("persists remote revision metadata when a cached bundle is added by name", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const remoteSource = createRemoteBundleSource(homeDir, {
      bundle: "react-expert",
      manifest: {
        name: "react-expert",
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
      },
      files: {
        ".claude/skills/react/SKILL.md": "# react\n",
      },
    });

    // When
    await expect(
      run(["add", remoteSource.bundle], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe("Applied react-expert for claude-code");

    // Then
    expect(
      readRegistryFile(path.join(homeDir, ".skul", "registry.json")).repos[
        detectGitContext({ cwd: repoRoot })!.repoFingerprint
      ]?.desired_state,
    ).toContainEqual({
      bundle: "react-expert",
      source: remoteSource.source,
      protocol: "https",
      resolved_ref: "main",
      resolved_commit: remoteSource.initialCommit,
    });
  });

  it("refreshes a cached remote source before source-scoped add", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const remoteSource = createRemoteBundleSource(homeDir, {
      bundle: "react-expert",
      manifest: {
        name: "react-expert",
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
      },
      files: {
        ".claude/skills/react/SKILL.md": "# initial\n",
      },
    });
    const updatedCommit = updateRemoteBundleSource(
      remoteSource.remoteRepoPath,
      remoteSource.bundle,
      {
        ".claude/skills/react/SKILL.md": "# refreshed\n",
      },
    );

    // When
    await expect(
      run(["add", remoteSource.source, remoteSource.bundle], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe("Applied react-expert for claude-code (Updated)");

    // Then
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# refreshed\n");
    expect(
      readRegistryFile(path.join(homeDir, ".skul", "registry.json")).repos[
        detectGitContext({ cwd: repoRoot })!.repoFingerprint
      ]?.desired_state,
    ).toContainEqual({
      bundle: "react-expert",
      source: remoteSource.source,
      protocol: "https",
      resolved_ref: "main",
      resolved_commit: updatedCommit,
    });
  });

  it("preserves cached source protocol when a cached bundle is added by name", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const remoteSource = createRemoteBundleSource(homeDir, {
      bundle: "react-expert",
      manifest: {
        name: "react-expert",
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
      },
      files: {
        ".claude/skills/react/SKILL.md": "# react\n",
      },
    });
    const cachedSourceDir = path.join(
      homeDir,
      ".skul",
      "library",
      ...remoteSource.source.split("/"),
    );
    runGit(cachedSourceDir, [
      "remote",
      "set-url",
      "origin",
      "git@github.com:user/ai-vault.git",
    ]);

    // When
    await expect(
      run(["add", remoteSource.bundle], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe("Applied react-expert for claude-code");

    // Then
    expect(
      readRegistryFile(path.join(homeDir, ".skul", "registry.json")).repos[
        detectGitContext({ cwd: repoRoot })!.repoFingerprint
      ]?.desired_state,
    ).toContainEqual({
      bundle: "react-expert",
      source: remoteSource.source,
      protocol: "ssh",
      resolved_ref: "main",
      resolved_commit: remoteSource.initialCommit,
    });
  });

  it("upgrades a legacy source-less entry to the cached source protocol on bundle-only add", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const remoteSource = createRemoteBundleSource(homeDir, {
      bundle: "react-expert",
      manifest: {
        name: "react-expert",
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
      },
      files: {
        ".claude/skills/react/SKILL.md": "# react\n",
      },
    });
    const cachedSourceDir = path.join(
      homeDir,
      ".skul",
      "library",
      ...remoteSource.source.split("/"),
    );
    runGit(cachedSourceDir, [
      "remote",
      "set-url",
      "origin",
      "git@github.com:user/ai-vault.git",
    ]);
    const registryFile = path.join(homeDir, ".skul", "registry.json");
    const gitContext = detectGitContext({ cwd: repoRoot })!;
    const registry = upsertRepoState(
      createEmptyRegistry(),
      gitContext.repoFingerprint,
      {
        repo_root: fs.realpathSync.native(repoRoot),
        desired_state: [{ bundle: remoteSource.bundle, protocol: "https" }],
      },
    );
    writeRegistryFile(registryFile, registry);

    // When
    await expect(
      run(["add", remoteSource.bundle], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe("Applied react-expert for claude-code");

    // Then
    expect(
      readRegistryFile(registryFile).repos[
        detectGitContext({ cwd: repoRoot })!.repoFingerprint
      ]?.desired_state,
    ).toContainEqual({
      bundle: "react-expert",
      source: remoteSource.source,
      protocol: "ssh",
      resolved_ref: "main",
      resolved_commit: remoteSource.initialCommit,
    });
  });

  it("coexists with a previously added bundle for the same tool", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: {
        "claude-code": {
          skills: { path: ".claude/skills" },
          commands: { path: ".claude/commands" },
        },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".claude/skills/react/SKILL.md",
      "# react\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".claude/commands/review.md",
      "# review\n",
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
    await run(["add", "react-expert"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When
    await expect(
      run(["add", "next-expert"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe("Applied next-expert for claude-code");

    // Then: both bundles coexist on disk
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "commands", "review.md"),
        "utf8",
      ),
    ).toBe("# review\n");
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "next", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# next\n");
    const excludeFile = fs.readFileSync(
      path.join(repoRoot, ".git", "info", "exclude"),
      "utf8",
    );
    expect(excludeFile).toContain(".claude/skills/react/SKILL.md");
    expect(excludeFile).toContain(".claude/commands/review.md");
    expect(excludeFile).toContain(".claude/skills/next/SKILL.md");

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const worktree = registry.worktrees[Object.keys(registry.worktrees)[0]];
    expect(worktree.materialized_state).toMatchObject({
      bundles: {
        "react-expert": {
          tools: {
            "claude-code": {
              files: expect.arrayContaining([".claude/skills/react/SKILL.md"]),
            },
          },
        },
        "next-expert": {
          tools: { "claude-code": { files: [".claude/skills/next/SKILL.md"] } },
        },
      },
    });
  });

  it("coexists with a previously added bundle targeting a different tool", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: {
        "claude-code": {
          skills: { path: ".claude/skills" },
          commands: { path: ".claude/commands" },
        },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".claude/skills/react/SKILL.md",
      "# react\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".claude/commands/review.md",
      "# review\n",
    );
    writeManifest(homeDir, "github.com/user/ai-vault", "repo-standards", {
      name: "repo-standards",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "repo-standards",
      ".agents/skills/next-task/SKILL.md",
      "# next task\n",
    );
    await run(["add", "react-expert"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When
    await expect(
      run(["add", "repo-standards"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe("Applied repo-standards for codex");

    // Then: both bundles coexist on disk
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "commands", "review.md"),
        "utf8",
      ),
    ).toBe("# review\n");
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "next-task", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# next task\n");
    const excludeFile = fs.readFileSync(
      path.join(repoRoot, ".git", "info", "exclude"),
      "utf8",
    );
    expect(excludeFile).toContain(".claude/skills/react/SKILL.md");
    expect(excludeFile).toContain(".agents/skills/next-task/SKILL.md");

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const repo = registry.repos[Object.keys(registry.repos)[0]];
    const worktree = registry.worktrees[Object.keys(registry.worktrees)[0]];
    expect(repo.desired_state).toEqual(
      expect.arrayContaining([
        {
          bundle: "react-expert",
          source: "github.com/user/ai-vault",
          protocol: "https",
        },
        {
          bundle: "repo-standards",
          source: "github.com/user/ai-vault",
          protocol: "https",
        },
      ]),
    );
    expect(worktree.materialized_state).toMatchObject({
      bundles: {
        "react-expert": {
          tools: {
            "claude-code": {
              files: expect.arrayContaining([".claude/skills/react/SKILL.md"]),
            },
          },
        },
        "repo-standards": {
          tools: { codex: { files: [".agents/skills/next-task/SKILL.md"] } },
        },
      },
    });
  });
});
