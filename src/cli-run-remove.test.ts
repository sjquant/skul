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
  it("resets all materialized bundles from the current worktree", async () => {
    // Given: two bundles targeting different tools
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
    await run(["add", "repo-standards"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When
    await expect(run(["reset"], { homeDir, cwd: repoRoot })).resolves.toMatch(
      /Reset/i,
    );

    // Then: all files from both bundles are removed
    expect(
      pathExists(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md")),
    ).toBe(false);
    expect(
      pathExists(
        path.join(repoRoot, ".agents", "skills", "next-task", "SKILL.md"),
      ),
    ).toBe(false);
  });

  it("removes a named bundle and its managed files from the current worktree", async () => {
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
    await run(["add", "react-expert"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When
    await expect(
      run(["remove", "react-expert"], { homeDir, cwd: repoRoot }),
    ).resolves.toBe("Removed react-expert");

    // Then: managed files are deleted
    expect(
      pathExists(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md")),
    ).toBe(false);
    expect(
      pathExists(path.join(repoRoot, ".claude", "commands", "review.md")),
    ).toBe(false);

    // Then: git exclude block is removed
    expect(
      fs.readFileSync(path.join(repoRoot, ".git", "info", "exclude"), "utf8"),
    ).not.toContain("# >>> SKUL START");

    // Then: registry is updated
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    expect(registry.worktrees).toEqual({});
    expect(
      registry.repos[detectGitContext({ cwd: repoRoot })!.repoFingerprint]
        ?.desired_state,
    ).toEqual([]);
  });

  it("selects an active source-scoped bundle from state when removing by source", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/sjquant/ghosts", "core", {
      name: "core",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".agents/skills/wdd/SKILL.md",
      "# wdd\n",
    );
    await run(["add", "github.com/sjquant/ghosts", "core"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    const selectBundle = vi.fn().mockResolvedValue({
      bundle: "core",
      source: "github.com/sjquant/ghosts",
    });
    fs.rmSync(path.join(homeDir, ".skul", "library", "github.com", "sjquant"), {
      recursive: true,
      force: true,
    });

    // When
    await expect(
      run(["remove", "sjquant/ghosts"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ selectBundle }),
      }),
    ).resolves.toBe("Removed core");

    // Then
    expect(selectBundle).not.toHaveBeenCalled();
    expect(
      pathExists(path.join(repoRoot, ".agents", "skills", "wdd", "SKILL.md")),
    ).toBe(false);
    expect(
      readRegistryFile(path.join(homeDir, ".skul", "registry.json")).repos[
        detectGitContext({ cwd: repoRoot })!.repoFingerprint
      ]?.desired_state,
    ).toEqual([]);
  });

  it("does not reselect when an explicit source-scoped remove misses the active bundle", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/sjquant/ghosts", "core", {
      name: "core",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".agents/skills/wdd/SKILL.md",
      "# wdd\n",
    );
    await run(["add", "github.com/sjquant/ghosts", "core"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    const selectBundle = vi.fn().mockResolvedValue({
      bundle: "core",
      source: "github.com/sjquant/ghosts",
    });

    // When / Then
    await expect(
      run(["remove", "sjquant/ghosts", "missing"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ selectBundle }),
      }),
    ).rejects.toThrowError(/Bundle not found in active set: missing/);
    expect(selectBundle).not.toHaveBeenCalled();
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "wdd", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# wdd\n");
  });

  it("keeps same-named desired bundles from other sources during source-scoped remove", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/sjquant/ghosts", "core", {
      name: "core",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".agents/skills/wdd/SKILL.md",
      "# wdd\n",
    );
    await run(["add", "github.com/sjquant/ghosts", "core"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    const registryFile = path.join(homeDir, ".skul", "registry.json");
    const repoFingerprint = detectGitContext({
      cwd: repoRoot,
    })!.repoFingerprint;
    const registry = readRegistryFile(registryFile);
    registry.repos[repoFingerprint]!.desired_state.push({
      bundle: "core",
      source: "github.com/other/ghosts",
      protocol: "https",
    });
    writeRegistryFile(registryFile, registry);

    // When
    await expect(
      run(["remove", "github.com/sjquant/ghosts", "core"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe("Removed core");

    // Then
    expect(
      readRegistryFile(registryFile).repos[repoFingerprint]?.desired_state,
    ).toEqual([
      {
        bundle: "core",
        source: "github.com/other/ghosts",
        protocol: "https",
      },
    ]);
  });

  it("selects removable items across source-scoped bundles without selecting a bundle first", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
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
    writeManifest(homeDir, "github.com/sjquant/ghosts", "core", {
      name: "core",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".agents/skills/next-task/SKILL.md",
      "# next task\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".agents/skills/review/SKILL.md",
      "# review\n",
    );
    writeManifest(homeDir, "github.com/sjquant/ghosts", "extras", {
      name: "extras",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "extras",
      ".agents/skills/audit/SKILL.md",
      "# audit\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "extras",
      ".agents/skills/plan/SKILL.md",
      "# plan\n",
    );
    await run(
      ["add", "github.com/sjquant/ghosts", "core", "--agent", "codex"],
      {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      },
    );
    await run(
      ["add", "github.com/sjquant/ghosts", "extras", "--agent", "codex"],
      {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      },
    );

    // When
    await expect(
      run(["remove", "sjquant/ghosts", "--select-items"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          selectBundleFromSelections,
          selectBundleItemChoices,
        }),
      }),
    ).resolves.toBe("Removed core: skills/review, extras: skills/audit");

    // Then
    expect(selectBundleFromSelections).not.toHaveBeenCalled();
    expect(selectBundleItemChoices).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          label: "github.com/sjquant/ghosts / core: skills/next-task",
        }),
        expect.objectContaining({
          label: "github.com/sjquant/ghosts / core: skills/review",
        }),
        expect.objectContaining({
          label: "github.com/sjquant/ghosts / extras: skills/audit",
        }),
        expect.objectContaining({
          label: "github.com/sjquant/ghosts / extras: skills/plan",
        }),
      ],
      [],
      "remove",
    );
    expect(
      pathExists(
        path.join(repoRoot, ".agents", "skills", "review", "SKILL.md"),
      ),
    ).toBe(false);
    expect(
      pathExists(path.join(repoRoot, ".agents", "skills", "audit", "SKILL.md")),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "next-task", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# next task\n");
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "plan", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# plan\n");
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
        items: ["skills/next-task"],
        protocol: "https",
      },
      {
        bundle: "extras",
        source: "github.com/sjquant/ghosts",
        tools: ["codex"],
        items: ["skills/plan"],
        protocol: "https",
      },
    ]);
  });

  it("removes included items across source-scoped bundles without selecting a bundle first", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const selectBundleFromSelections = vi.fn(async () => {
      throw new Error("selectBundleFromSelections should not be called");
    });
    const selectBundleItemChoices = vi.fn(async () => {
      throw new Error("selectBundleItemChoices should not be called");
    });
    writeManifest(homeDir, "github.com/sjquant/ghosts", "core", {
      name: "core",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".agents/skills/next-task/SKILL.md",
      "# next task\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".agents/skills/review/SKILL.md",
      "# review\n",
    );
    writeManifest(homeDir, "github.com/sjquant/ghosts", "extras", {
      name: "extras",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "extras",
      ".agents/skills/audit/SKILL.md",
      "# audit\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "extras",
      ".agents/skills/plan/SKILL.md",
      "# plan\n",
    );
    await run(
      ["add", "github.com/sjquant/ghosts", "core", "--agent", "codex"],
      {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      },
    );
    await run(
      ["add", "github.com/sjquant/ghosts", "extras", "--agent", "codex"],
      {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      },
    );

    // When
    await expect(
      run(
        [
          "remove",
          "sjquant/ghosts",
          "--include",
          "skills/review",
          "--include",
          "skills/audit",
        ],
        {
          homeDir,
          cwd: repoRoot,
          prompts: createPromptClientStub({
            selectBundleFromSelections,
            selectBundleItemChoices,
          }),
        },
      ),
    ).resolves.toBe("Removed core: skills/review, extras: skills/audit");

    // Then
    expect(selectBundleFromSelections).not.toHaveBeenCalled();
    expect(selectBundleItemChoices).not.toHaveBeenCalled();
    expect(
      pathExists(
        path.join(repoRoot, ".agents", "skills", "review", "SKILL.md"),
      ),
    ).toBe(false);
    expect(
      pathExists(path.join(repoRoot, ".agents", "skills", "audit", "SKILL.md")),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "next-task", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# next task\n");
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "plan", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# plan\n");
  });

  it("cleans up source-scoped bundles fully removed by included items", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
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
    writeManifest(homeDir, "github.com/sjquant/ghosts", "extras", {
      name: "extras",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "extras",
      ".agents/skills/audit/SKILL.md",
      "# audit\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "extras",
      ".agents/skills/plan/SKILL.md",
      "# plan\n",
    );
    await run(
      ["add", "github.com/sjquant/ghosts", "core", "--agent", "codex"],
      {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      },
    );
    await run(
      ["add", "github.com/sjquant/ghosts", "extras", "--agent", "codex"],
      {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      },
    );

    // When
    await expect(
      run(
        [
          "remove",
          "sjquant/ghosts",
          "--include",
          "skills/review",
          "--include",
          "skills/audit",
        ],
        {
          homeDir,
          cwd: repoRoot,
          prompts: createPromptClientStub(),
        },
      ),
    ).resolves.toBe("Removed core: skills/review, extras: skills/audit");

    // Then
    expect(
      pathExists(
        path.join(repoRoot, ".agents", "skills", "review", "SKILL.md"),
      ),
    ).toBe(false);
    expect(
      pathExists(path.join(repoRoot, ".agents", "skills", "audit", "SKILL.md")),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "plan", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# plan\n");
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const gitContext = detectGitContext({ cwd: repoRoot })!;
    expect(registry.repos[gitContext.repoFingerprint]?.desired_state).toEqual([
      {
        bundle: "extras",
        source: "github.com/sjquant/ghosts",
        tools: ["codex"],
        items: ["skills/plan"],
        protocol: "https",
      },
    ]);
    expect(
      registry.worktrees[gitContext.worktreeId]?.materialized_state.bundles
        .core,
    ).toBeUndefined();
    expect(
      registry.worktrees[gitContext.worktreeId]?.materialized_state.bundles
        .extras?.tools.codex?.items,
    ).toEqual(["skills/plan"]);
  });

  it("removes included bundle items while keeping the remaining items active", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".agents/skills/next-task/SKILL.md",
      "# next task\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".agents/skills/review/SKILL.md",
      "# review\n",
    );
    await run(["add", "react-expert", "--agent", "codex"], {
      homeDir,
      cwd: repoRoot,
    });

    // When
    await expect(
      run(["remove", "react-expert", "--include", "skills/review"], {
        homeDir,
        cwd: repoRoot,
      }),
    ).resolves.toBe("Removed skills/review from react-expert");

    // Then
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "next-task", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# next task\n");
    expect(
      pathExists(
        path.join(repoRoot, ".agents", "skills", "review", "SKILL.md"),
      ),
    ).toBe(false);

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const repoFingerprint = detectGitContext({
      cwd: repoRoot,
    })!.repoFingerprint;
    expect(registry.repos[repoFingerprint]?.desired_state).toEqual([
      {
        bundle: "react-expert",
        source: "github.com/user/ai-vault",
        tools: ["codex"],
        items: ["skills/next-task"],
        protocol: "https",
      },
    ]);
    expect(
      registry.worktrees[Object.keys(registry.worktrees)[0]!]!
        .materialized_state.bundles["react-expert"]!.tools.codex!.items,
    ).toEqual(["skills/next-task"]);
  });

  it("opens the bundle item selector before removing selected items", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const selectBundleItemChoices = vi.fn(
      async (choices: Array<{ value: string; label: string }>) =>
        choices
          .filter((choice) =>
            choice.label.endsWith("react-expert: skills/review"),
          )
          .map((choice) => choice.value),
    );
    const selectBundleFromSelections = vi.fn(async () => {
      throw new Error("selectBundleFromSelections should not be called");
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".agents/skills/next-task/SKILL.md",
      "# next task\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".agents/skills/review/SKILL.md",
      "# review\n",
    );
    await run(["add", "react-expert", "--agent", "codex"], {
      homeDir,
      cwd: repoRoot,
    });

    // When
    await expect(
      run(
        [
          "remove",
          "react-expert",
          "--include",
          "skills/next-task",
          "--select-items",
        ],
        {
          homeDir,
          cwd: repoRoot,
          prompts: createPromptClientStub({
            selectBundleFromSelections,
            selectBundleItemChoices,
          }),
        },
      ),
    ).resolves.toBe("Removed react-expert: skills/review");

    // Then
    expect(selectBundleFromSelections).not.toHaveBeenCalled();
    expect(selectBundleItemChoices).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          label: "github.com/user/ai-vault / react-expert: skills/next-task",
        }),
        expect.objectContaining({
          label: "github.com/user/ai-vault / react-expert: skills/review",
        }),
      ],
      [expect.any(String)],
      "remove",
    );
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "next-task", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# next task\n");
    expect(
      pathExists(
        path.join(repoRoot, ".agents", "skills", "review", "SKILL.md"),
      ),
    ).toBe(false);
  });

  it("offers only active bundle items when removing selected items", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const selectBundleItemChoices = vi.fn(
      async (choices: Array<{ value: string }>) =>
        choices.map((choice) => choice.value),
    );
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".agents/skills/next-task/SKILL.md",
      "# next task\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".agents/skills/review/SKILL.md",
      "# review\n",
    );
    await run(
      [
        "add",
        "react-expert",
        "--agent",
        "codex",
        "--include",
        "skills/next-task",
      ],
      {
        homeDir,
        cwd: repoRoot,
      },
    );

    // When
    await expect(
      run(["remove", "react-expert", "--select-items"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ selectBundleItemChoices }),
      }),
    ).resolves.toBe("Removed react-expert: skills/next-task");

    // Then
    expect(selectBundleItemChoices).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          label: "github.com/user/ai-vault / react-expert: skills/next-task",
        }),
      ],
      [],
      "remove",
    );
    expect(
      pathExists(
        path.join(repoRoot, ".agents", "skills", "next-task", "SKILL.md"),
      ),
    ).toBe(false);
  });

  it("removes a specific bundle without disturbing other materialized bundles", async () => {
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
    await run(["add", "repo-standards"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When
    await expect(
      run(["remove", "react-expert"], { homeDir, cwd: repoRoot }),
    ).resolves.toBe("Removed react-expert");

    // Then: only react-expert's files are removed; repo-standards files remain
    expect(
      pathExists(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md")),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "next-task", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# next task\n");

    // Then: exclude block retains repo-standards files only
    const excludeFile = fs.readFileSync(
      path.join(repoRoot, ".git", "info", "exclude"),
      "utf8",
    );
    expect(excludeFile).not.toContain(".claude/skills/react/SKILL.md");
    expect(excludeFile).toContain(".agents/skills/next-task/SKILL.md");

    // Then: registry reflects only repo-standards
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const repoFingerprint = detectGitContext({
      cwd: repoRoot,
    })!.repoFingerprint;
    expect(registry.repos[repoFingerprint]?.desired_state).toEqual([
      {
        bundle: "repo-standards",
        source: "github.com/user/ai-vault",
        protocol: "https",
      },
    ]);
    const worktree = registry.worktrees[Object.keys(registry.worktrees)[0]];
    expect(worktree.materialized_state.bundles).not.toHaveProperty(
      "react-expert",
    );
    expect(worktree.materialized_state.bundles).toHaveProperty(
      "repo-standards",
    );
  });

  it("removes every active bundle when remove uses all", async () => {
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
    await run(["add", "repo-standards"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When
    await expect(
      run(["remove", "--all"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe("Removed react-expert\nRemoved repo-standards");

    // Then
    expect(
      pathExists(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md")),
    ).toBe(false);
    expect(
      pathExists(
        path.join(repoRoot, ".agents", "skills", "next-task", "SKILL.md"),
      ),
    ).toBe(false);

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    expect(
      registry.repos[detectGitContext({ cwd: repoRoot })!.repoFingerprint]
        ?.desired_state,
    ).toEqual([]);
    expect(registry.worktrees).toEqual({});
  });

  it("dry-runs removing every active bundle without deleting files or registry state", async () => {
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
    await run(["add", "repo-standards"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    const registryBefore = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );

    // When
    await expect(
      run(["remove", "--all", "--dry-run"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe(
      [
        "DRY RUN: Would remove react-expert (1 file(s))",
        "  .claude/skills/react/SKILL.md",
        "DRY RUN: Would remove repo-standards (1 file(s))",
        "  .agents/skills/next-task/SKILL.md",
      ].join("\n"),
    );

    // Then
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "next-task", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# next task\n");
    expect(
      readRegistryFile(path.join(homeDir, ".skul", "registry.json")),
    ).toEqual(registryBefore);
  });

  it("removes every active bundle from one source when source-scoped remove uses all", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/sjquant/ghosts", "core", {
      name: "core",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/sjquant/ghosts",
      "core",
      ".agents/skills/wdd/SKILL.md",
      "# wdd\n",
    );
    writeManifest(homeDir, "github.com/other/ai-vault", "extras", {
      name: "extras",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/other/ai-vault",
      "extras",
      ".claude/skills/other/SKILL.md",
      "# other\n",
    );
    await run(["add", "github.com/sjquant/ghosts", "core"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    await run(["add", "github.com/other/ai-vault", "extras"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When
    await expect(
      run(["remove", "github.com/sjquant/ghosts", "--all"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe("Removed core");

    // Then
    expect(
      pathExists(path.join(repoRoot, ".agents", "skills", "wdd", "SKILL.md")),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "other", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# other\n");

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const gitContext = detectGitContext({ cwd: repoRoot })!;
    expect(registry.repos[gitContext.repoFingerprint]?.desired_state).toEqual([
      {
        bundle: "extras",
        source: "github.com/other/ai-vault",
        protocol: "https",
      },
    ]);
    expect(
      registry.worktrees[gitContext.worktreeId]?.materialized_state.bundles,
    ).toEqual({
      extras: expect.objectContaining({ source: "github.com/other/ai-vault" }),
    });
  });

  it("prompts before removing a modified managed file when remove all is used", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const confirmManagedFileRemoval = vi.fn(async () => false);
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

    // When / Then
    await expect(
      run(["remove", "--all"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ confirmManagedFileRemoval }),
      }),
    ).rejects.toThrowError(
      /Removal aborted because a modified managed file was kept/,
    );
    expect(confirmManagedFileRemoval).toHaveBeenCalledWith(
      ".claude/skills/react/SKILL.md",
      "remove",
    );
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# modified\n");
  });

  it("prompts before removing a modified managed file and aborts when the user declines", async () => {
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
    fs.writeFileSync(
      path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
      "# modified\n",
    );

    // When / Then
    await expect(
      run(["remove", "react-expert"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          confirmManagedFileRemoval: async () => false,
        }),
      }),
    ).rejects.toThrowError(
      /Removal aborted because a modified managed file was kept/,
    );
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# modified\n");
  });

  it("removes a modified managed file without prompting when remove uses yes", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const confirmManagedFileRemoval = vi.fn(async () => {
      throw new Error("confirmManagedFileRemoval should not be called");
    });
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

    // When
    await expect(
      run(["remove", "react-expert", "-y"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ confirmManagedFileRemoval }),
      }),
    ).resolves.toBe("Removed react-expert");

    // Then
    expect(confirmManagedFileRemoval).not.toHaveBeenCalled();
    expect(
      pathExists(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md")),
    ).toBe(false);
  });

  it("removes bundle from desired state even when not yet materialized in the current worktree", async () => {
    // Given: bundle added from the main worktree, but remove is run from a linked worktree
    // that has never materialized it
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
    // Add (and materialize) from the main worktree
    await run(["add", "react-expert"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    // Create a linked worktree that has not materialized react-expert
    const linkedWorktree = createLinkedWorktree(repoRoot);

    // When: remove from the linked worktree where nothing is materialized
    await expect(
      run(["remove", "react-expert"], { homeDir, cwd: linkedWorktree }),
    ).resolves.toBe("Removed react-expert");

    // Then: desired_state is cleared; no crash even though no files were on disk
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const repoFingerprint = detectGitContext({
      cwd: repoRoot,
    })!.repoFingerprint;
    expect(registry.repos[repoFingerprint]?.desired_state).toEqual([]);
  });

  it("throws when the named bundle is not in the active set", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    // When / Then
    await expect(
      run(["remove", "nonexistent-bundle"], { homeDir, cwd: repoRoot }),
    ).rejects.toThrowError(
      /Bundle not found in active set: nonexistent-bundle/,
    );
  });

  it("includes configured bundle names in the error when removing an unknown bundle", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
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

    // When / Then
    await expect(
      run(["remove", "nonexistent-bundle"], { homeDir, cwd: repoRoot }),
    ).rejects.toThrowError(/Configured bundles: react-expert/);
  });

  it("surfaces a clear error when remove runs outside a Git repository", async () => {
    // Given
    const homeDir = createHomeDir();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skul-non-git-"));
    tempDirs.push(cwd);

    // When / Then
    await expect(
      run(["remove", "react-expert"], { homeDir, cwd }),
    ).rejects.toThrowError(/skul remove requires a Git repository/);
  });

  it("rejects --agent names that are not supported by the bundle", async () => {
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

    // When / Then
    await expect(
      run(["add", "react-expert", "--agent", "cursor"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).rejects.toThrowError(
      /Bundle does not support tool\(s\): cursor[\s\S]*Supported tools: claude-code/i,
    );
  });

  it("materializes AGENTS.md for codex when the bundle only provides CLAUDE.md", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeRootInstructionBundleFixture(homeDir, {
      bundle: "repo-standards",
      agent: "claude-code",
      content: "# Shared instructions\nUse consistent conventions.\n",
    });

    // When
    await expect(
      run(["add", "repo-standards", "--agent", "codex"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe("Applied repo-standards for codex");

    // Then
    expectAgentsDocument(
      repoRoot,
      formatRootInstructionBundleBlock(
        "repo-standards",
        "# Shared instructions\nUse consistent conventions.\n",
        "github.com/user/ai-vault",
      ),
    );
  });

  it("materializes CLAUDE.md for claude-code when the bundle only provides AGENTS.md", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeRootInstructionBundleFixture(homeDir, {
      bundle: "repo-standards",
      content: "# Shared instructions\nUse consistent conventions.\n",
    });

    // When
    await expect(
      run(["add", "repo-standards", "--agent", "claude-code"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe("Applied repo-standards for claude-code");

    // Then
    expectClaudeDocument(
      repoRoot,
      formatRootInstructionBundleBlock(
        "repo-standards",
        "# Shared instructions\nUse consistent conventions.\n",
        "github.com/user/ai-vault",
      ),
    );
  });

  it("lists bundles with their supported tools", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: {
        "claude-code": { skills: { path: ".claude/skills" } },
        cursor: { skills: { path: ".cursor/skills" } },
      },
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "repo-standards", {
      name: "repo-standards",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });

    // When / Then
    await expect(run(["list"], { homeDir })).resolves.toBe(
      renderBundleListOutput(
        "react-expert [github.com/user/ai-vault] (claude-code, cursor)",
        "repo-standards [github.com/user/ai-vault] (codex)",
      ),
    );
  });
});
