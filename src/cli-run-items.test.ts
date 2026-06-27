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
import { assertTrackedRootInstructionShadowSafety, run } from "./index";
import {
  createEmptyRegistry,
  readRegistryFile,
  upsertRepoState,
  upsertWorktreeState,
  writeRegistryFile,
} from "./registry";
import { renderTrackedRootInstructionShadow } from "./root-instruction-render";

describe("run", () => {
  it("surfaces a clear error when reset runs outside a Git repository", async () => {
    // Given
    const homeDir = createHomeDir();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skul-non-git-"));
    tempDirs.push(cwd);

    // When / Then
    await expect(run(["reset"], { homeDir, cwd })).rejects.toThrowError(
      /skul reset requires a Git repository/,
    );
  });

  it("surfaces a clear error when add runs outside a Git repository", async () => {
    // Given
    const homeDir = createHomeDir();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skul-non-git-"));
    tempDirs.push(cwd);

    // When / Then
    await expect(
      run(["add", "react-expert"], {
        homeDir,
        cwd,
        prompts: createPromptClientStub(),
      }),
    ).rejects.toThrowError(/skul add requires a Git repository/i);
  });

  it("lists available bundles when the requested bundle is missing", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "repo-standards", {
      name: "repo-standards",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });

    // When / Then
    await expect(
      run(["add", "missing-bundle"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).rejects.toThrowError(
      /Bundle not found: missing-bundle[\s\S]*Available bundles:[\s\S]*react-expert[\s\S]*repo-standards/i,
    );
  });

  it("applies only the selected agent when --agent is specified", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: {
        "claude-code": { skills: { path: ".claude/skills" } },
        cursor: { skills: { path: ".cursor/skills" } },
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
    await expect(
      run(["add", "react-expert", "--agent", "claude-code"], {
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
      pathExists(path.join(repoRoot, ".cursor", "skills", "react", "SKILL.md")),
    ).toBe(false);

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const worktree = registry.worktrees[Object.keys(registry.worktrees)[0]];
    expect(worktree.materialized_state).toMatchObject({
      bundles: {
        "react-expert": {
          tools: {
            "claude-code": { files: [".claude/skills/react/SKILL.md"] },
          },
        },
      },
    });
  });

  it("applies multiple selected agents when multiple --agent flags are provided", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: {
        "claude-code": { skills: { path: ".claude/skills" } },
        cursor: { skills: { path: ".cursor/skills" } },
        codex: { skills: { path: ".agents/skills" } },
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
      ".cursor/skills/react/SKILL.md",
      "# react\n",
    );

    // When
    await expect(
      run(
        ["add", "react-expert", "--agent", "claude-code", "--agent", "cursor"],
        {
          homeDir,
          cwd: repoRoot,
          prompts: createPromptClientStub(),
        },
      ),
    ).resolves.toBe("Applied react-expert for claude-code, cursor");

    // Then
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".cursor", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
    expect(
      pathExists(path.join(repoRoot, ".agents", "skills", "react", "SKILL.md")),
    ).toBe(false);
  });

  it("parses bundle item selection flags for add", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs([
        "add",
        "react-expert",
        "--include",
        "skills/diagnose",
        "--include",
        "AGENTS.md",
        "--select-items",
      ]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        bundle: "react-expert",
        protocol: "https",
        agents: [],
        includeItems: ["skills/diagnose", "root-instruction"],
        selectItems: true,
        dryRun: false,
        global: false,
      },
    });
  });

  it("applies only selected bundle items when --include is specified", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const linkedWorktree = createLinkedWorktree(repoRoot);
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

    // When
    await expect(
      run(
        [
          "add",
          "react-expert",
          "--agent",
          "codex",
          "--include",
          "skills/next-task",
        ],
        { homeDir, cwd: repoRoot },
      ),
    ).resolves.toBe("Applied react-expert for codex");
    await expect(
      run(["apply"], { homeDir, cwd: linkedWorktree }),
    ).resolves.toBe("Applied react-expert");

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
    expect(
      fs.readFileSync(
        path.join(linkedWorktree, ".agents", "skills", "next-task", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# next task\n");
    expect(
      pathExists(
        path.join(linkedWorktree, ".agents", "skills", "review", "SKILL.md"),
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

  it("opens the bundle item selector with --include items preselected", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const selectBundleItems = vi.fn().mockResolvedValue(["skills/review"]);
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

    // When
    await expect(
      run(
        [
          "add",
          "react-expert",
          "--agent",
          "codex",
          "--include",
          "skills/next-task",
          "--select-items",
        ],
        {
          homeDir,
          cwd: repoRoot,
          prompts: createPromptClientStub({ selectBundleItems }),
        },
      ),
    ).resolves.toBe("Applied react-expert for codex: skills/review");

    // Then
    expect(selectBundleItems).toHaveBeenCalledWith(
      ["skills/next-task", "skills/review"],
      ["skills/next-task"],
    );
    expect(
      pathExists(
        path.join(repoRoot, ".agents", "skills", "next-task", "SKILL.md"),
      ),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "review", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# review\n");
  });

  it("merges selected bundle items when a bundle is re-added with --include", async () => {
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
    await run(
      [
        "add",
        "react-expert",
        "--agent",
        "codex",
        "--include",
        "skills/next-task",
      ],
      { homeDir, cwd: repoRoot },
    );

    // When
    await expect(
      run(
        [
          "add",
          "react-expert",
          "--agent",
          "codex",
          "--include",
          "skills/review",
        ],
        { homeDir, cwd: repoRoot },
      ),
    ).resolves.toBe("Applied react-expert for codex");

    // Then
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "next-task", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# next task\n");
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "review", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# review\n");

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const repoFingerprint = detectGitContext({
      cwd: repoRoot,
    })!.repoFingerprint;
    expect(registry.repos[repoFingerprint]?.desired_state[0]?.items).toEqual([
      "skills/next-task",
      "skills/review",
    ]);
  });

  it("removes stale linked-worktree files when desired bundle items change", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const linkedWorktree = createLinkedWorktree(repoRoot);
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
    await run(["apply"], { homeDir, cwd: linkedWorktree });

    // When
    await run(
      [
        "add",
        "react-expert",
        "--agent",
        "codex",
        "--include",
        "skills/next-task",
      ],
      { homeDir, cwd: repoRoot },
    );
    await expect(
      run(["apply"], { homeDir, cwd: linkedWorktree }),
    ).resolves.toBe("Applied react-expert");

    // Then
    expect(
      fs.readFileSync(
        path.join(linkedWorktree, ".agents", "skills", "next-task", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# next task\n");
    expect(
      pathExists(
        path.join(linkedWorktree, ".agents", "skills", "review", "SKILL.md"),
      ),
    ).toBe(false);

    // When
    await run(["add", "react-expert", "--agent", "codex", "--select-items"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub({
        selectBundleItems: async () => ["skills/review"],
      }),
    });
    await expect(
      run(["apply"], { homeDir, cwd: linkedWorktree }),
    ).resolves.toBe("Applied react-expert");

    // Then
    expect(
      pathExists(
        path.join(linkedWorktree, ".agents", "skills", "next-task", "SKILL.md"),
      ),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(linkedWorktree, ".agents", "skills", "review", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# review\n");
  });

  it("applies only root instructions when root-instruction is included", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "repo-standards", {
      name: "repo-standards",
      tools: {
        codex: {
          skills: { path: ".agents/skills" },
          root_instruction: { path: "AGENTS.md" },
        },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "repo-standards",
      ".agents/skills/review/SKILL.md",
      "# review\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "repo-standards",
      "AGENTS.md",
      "Follow the repo standards.\n",
    );

    // When
    await expect(
      run(
        [
          "add",
          "repo-standards",
          "--agent",
          "codex",
          "--include",
          "root-instruction",
        ],
        { homeDir, cwd: repoRoot },
      ),
    ).resolves.toBe("Applied repo-standards for codex");

    // Then
    expectAgentsDocument(
      repoRoot,
      formatRootInstructionBundleBlock(
        "repo-standards",
        "Follow the repo standards.",
        "github.com/user/ai-vault",
      ),
    );
    expect(
      pathExists(
        path.join(repoRoot, ".agents", "skills", "review", "SKILL.md"),
      ),
    ).toBe(false);
  });

  it("adds a second tool to a bundle, preserving the first tool's files", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: {
        "claude-code": { skills: { path: ".claude/skills" } },
        cursor: { skills: { path: ".cursor/skills" } },
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
      ".cursor/skills/react/SKILL.md",
      "# react\n",
    );
    await run(["add", "react-expert", "--agent", "claude-code"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When: add cursor tool to the same bundle
    await expect(
      run(["add", "react-expert", "--agent", "cursor"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe("Applied react-expert for cursor");

    // Then: both tools' files exist
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".cursor", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");

    // And the registry records both tools for this bundle
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const repoFingerprint = detectGitContext({
      cwd: repoRoot,
    })!.repoFingerprint;
    const worktree = registry.worktrees[Object.keys(registry.worktrees)[0]];
    expect(
      worktree.materialized_state.bundles["react-expert"].tools,
    ).toMatchObject({
      "claude-code": { files: [".claude/skills/react/SKILL.md"] },
      cursor: { files: [".cursor/skills/react/SKILL.md"] },
    });
    expect(registry.repos[repoFingerprint]?.desired_state).toEqual([
      {
        bundle: "react-expert",
        source: "github.com/user/ai-vault",
        tools: ["claude-code", "cursor"],
        protocol: "https",
      },
    ]);
  });

  it("clears prior tool selection when the bundle is re-added without --agent", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const linkedWorktree = createLinkedWorktree(repoRoot);
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: {
        "claude-code": { skills: { path: ".claude/skills" } },
        cursor: { skills: { path: ".cursor/skills" } },
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
      ".cursor/skills/react/SKILL.md",
      "# react\n",
    );
    await run(["add", "react-expert", "--agent", "claude-code"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    await run(["apply"], { homeDir, cwd: linkedWorktree });

    // When
    await expect(
      run(["add", "react-expert"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe("Applied react-expert for claude-code, cursor");
    await expect(
      run(["apply"], { homeDir, cwd: linkedWorktree }),
    ).resolves.toBe("Applied react-expert");

    // Then
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
        protocol: "https",
      },
    ]);
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".cursor", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
    expect(
      fs.readFileSync(
        path.join(linkedWorktree, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
    expect(
      fs.readFileSync(
        path.join(linkedWorktree, ".cursor", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
  });

  it("preserves remote metadata when a remote-backed bundle is re-added without --agent", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const remoteSource = createRemoteBundleSource(homeDir, {
      bundle: "react-expert",
      manifest: {
        tools: {
          "claude-code": { skills: { path: ".claude/skills" } },
          cursor: { skills: { path: ".cursor/skills" } },
        },
      },
      files: {
        ".claude/skills/react/SKILL.md": "# react\n",
        ".cursor/skills/react/SKILL.md": "# react\n",
      },
    });
    await run(
      [
        "add",
        remoteSource.source,
        remoteSource.bundle,
        "--agent",
        "claude-code",
      ],
      { homeDir, cwd: repoRoot },
    );
    runGit(remoteSource.remoteRepoPath, ["branch", "stable"]);
    const registryFile = path.join(homeDir, ".skul", "registry.json");
    const repoFingerprint = detectGitContext({
      cwd: repoRoot,
    })!.repoFingerprint;
    const registryWithRef = readRegistryFile(registryFile);

    writeRegistryFile(
      registryFile,
      upsertRepoState(registryWithRef, repoFingerprint, {
        repo_root: repoRoot,
        desired_state: [
          {
            ...registryWithRef.repos[repoFingerprint]!.desired_state[0]!,
            ref: "stable",
          },
        ],
      }),
    );

    // When
    await expect(
      run(["add", "react-expert"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe("Applied react-expert for claude-code, cursor");

    // Then
    const registry = readRegistryFile(registryFile);
    const repoEntry = registry.repos[repoFingerprint]!;
    const worktreeEntry =
      registry.worktrees[detectGitContext({ cwd: repoRoot })!.worktreeId]!;

    expect(repoEntry.desired_state).toEqual([
      {
        bundle: "react-expert",
        source: remoteSource.source,
        protocol: "https",
        ref: "stable",
        resolved_ref: "main",
        resolved_commit: remoteSource.initialCommit,
      },
    ]);
    expect(
      worktreeEntry.materialized_state.bundles["react-expert"],
    ).toMatchObject({
      source: remoteSource.source,
      resolved_commit: remoteSource.initialCommit,
    });
    await expect(run(["check"], { homeDir, cwd: repoRoot })).resolves.toBe(
      "react-expert: up-to-date",
    );
  });

  it("marks a remote-backed bundle as updated when add refreshes cached content", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const remoteSource = createRemoteBundleSource(homeDir, {
      bundle: "react-expert",
      manifest: {
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
      },
      files: {
        ".claude/skills/react/SKILL.md": "# react\n",
      },
    });
    await run(["add", remoteSource.source, remoteSource.bundle], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    const updatedCommit = updateRemoteBundleSource(
      remoteSource.remoteRepoPath,
      remoteSource.bundle,
      {
        ".claude/skills/react/SKILL.md": "# updated react\n",
      },
    );
    const selectBundleItemChoices = vi.fn(
      async (choices: Array<{ value: string }>) =>
        choices.map((choice) => choice.value),
    );
    // When
    await expect(
      run(["add", remoteSource.source, remoteSource.bundle, "--select-items"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ selectBundleItemChoices }),
      }),
    ).resolves.toBe(
      "Applied react-expert for claude-code: skills/react (Updated)",
    );

    // Then
    expect(selectBundleItemChoices).toHaveBeenCalledWith(
      [
        {
          value: "skills/react",
          label: "skills/react",
          hint: "Updated",
        },
      ],
      [],
      "install",
    );
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# updated react\n");
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const gitContext = detectGitContext({ cwd: repoRoot })!;
    expect(
      registry.repos[gitContext.repoFingerprint]?.desired_state[0]
        ?.resolved_commit,
    ).toBe(updatedCommit);
  });

  it("marks each source-scoped item add as updated when the remote source refreshes", async () => {
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
    updateRemoteBundleSource(remoteSource.remoteRepoPath, "sandbox", {
      "manifest.json": `${JSON.stringify(
        {
          tools: { codex: { skills: { path: ".agents/skills" } } },
        },
        null,
        2,
      )}\n`,
      ".agents/skills/audit/SKILL.md": "# audit\n",
    });
    const selectBundleItemChoices = vi.fn(
      async (choices: Array<{ value: string }>) =>
        choices.map((choice) => choice.value),
    );

    // When
    await expect(
      run(["add", remoteSource.source, "--select-items"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ selectBundleItemChoices }),
      }),
    ).resolves.toBe(
      "Applied core for codex: skills/wdd\nApplied sandbox for codex: skills/audit (Updated)",
    );

    // Then
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
    expect(selectBundleItemChoices).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          label: "core: skills/wdd",
        }),
        expect.objectContaining({
          label: "sandbox: skills/audit",
          hint: "Updated",
        }),
      ],
      [],
      "install",
    );
    expect(selectBundleItemChoices.mock.calls[0]?.[0][0]).not.toHaveProperty(
      "hint",
    );
  });

  it("does not mark selected items as updated when only an unselected tool changed", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const remoteSource = createRemoteBundleSource(homeDir, {
      bundle: "react-expert",
      manifest: {
        tools: {
          codex: { skills: { path: ".agents/skills" } },
          cursor: { skills: { path: ".cursor/skills" } },
        },
      },
      files: {
        ".agents/skills/react/SKILL.md": "# codex react\n",
        ".cursor/skills/react/SKILL.md": "# cursor react\n",
      },
    });
    await run(
      ["add", remoteSource.source, remoteSource.bundle, "--agent", "codex"],
      {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      },
    );
    updateRemoteBundleSource(remoteSource.remoteRepoPath, remoteSource.bundle, {
      ".cursor/skills/react/SKILL.md": "# updated cursor react\n",
    });
    const selectBundleItemChoices = vi.fn(
      async (choices: Array<{ value: string }>) =>
        choices.map((choice) => choice.value),
    );
    const selectBundleItems = vi.fn(async (items: string[]) => items);

    // When
    await expect(
      run(
        [
          "add",
          remoteSource.source,
          remoteSource.bundle,
          "--agent",
          "codex",
          "--select-items",
        ],
        {
          homeDir,
          cwd: repoRoot,
          prompts: createPromptClientStub({
            selectBundleItems,
            selectBundleItemChoices,
          }),
        },
      ),
    ).resolves.toBe("Applied react-expert for codex: skills/react");

    // Then
    expect(selectBundleItemChoices).not.toHaveBeenCalled();
    expect(selectBundleItems).toHaveBeenCalledWith(["skills/react"], []);
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# codex react\n");
  });

  it("marks changed items during global remote-backed item selection", async () => {
    // Given
    const homeDir = createHomeDir();
    const remoteSource = createRemoteBundleSource(homeDir, {
      source: "github.com/sjquant/ghosts",
      bundle: "core",
      manifest: {
        tools: { codex: { skills: { path: "skills" } } },
      },
      files: {
        "skills/gotchas/SKILL.md":
          "---\nname: gotchas\ndescription: Gotchas\n---\n# gotchas\n",
        "skills/interview/SKILL.md":
          "---\nname: interview\ndescription: Interview\n---\n# interview\n",
        "skills/wdd/SKILL.md": "---\nname: wdd\ndescription: WDD\n---\n# wdd\n",
      },
    });
    await run(["add", remoteSource.source, remoteSource.bundle, "--global"], {
      homeDir,
      prompts: createPromptClientStub(),
    });
    updateRemoteBundleSource(remoteSource.remoteRepoPath, remoteSource.bundle, {
      "skills/gotchas/SKILL.md":
        "---\nname: gotchas\ndescription: Gotchas\n---\n# updated gotchas\n",
      "skills/interview/SKILL.md":
        "---\nname: interview\ndescription: Interview\n---\n# updated interview\n",
    });
    const selectBundleItemChoices = vi.fn(
      async (choices: Array<{ value: string }>) =>
        choices.map((choice) => choice.value),
    );

    // When
    await expect(
      run(
        [
          "add",
          remoteSource.source,
          remoteSource.bundle,
          "--global",
          "--select-items",
        ],
        {
          homeDir,
          prompts: createPromptClientStub({ selectBundleItemChoices }),
        },
      ),
    ).resolves.toBe(
      "Applied core globally for codex: skills/gotchas, skills/interview, skills/wdd (Updated)",
    );

    // Then
    expect(selectBundleItemChoices).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          label: "skills/gotchas",
          hint: "Updated",
        }),
        expect.objectContaining({
          label: "skills/interview",
          hint: "Updated",
        }),
        expect.objectContaining({
          label: "skills/wdd",
        }),
      ],
      [],
      "install",
    );
    expect(selectBundleItemChoices.mock.calls[0]?.[0][2]).not.toHaveProperty(
      "hint",
    );
  });

  it("drops a preserved ref when the bundle is re-added from a different source", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const remoteSourceA = createRemoteBundleSource(homeDir, {
      source: "github.com/user/ai-vault-a",
      bundle: "react-expert",
      manifest: {
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
      },
      files: {
        ".claude/skills/react/SKILL.md": "# react a\n",
      },
    });
    const remoteSourceB = createRemoteBundleSource(homeDir, {
      source: "github.com/user/ai-vault-b",
      bundle: "react-expert",
      manifest: {
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
      },
      files: {
        ".claude/skills/react/SKILL.md": "# react b\n",
      },
    });
    await run(["add", remoteSourceA.source, remoteSourceA.bundle], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    const registryFile = path.join(homeDir, ".skul", "registry.json");
    const repoFingerprint = detectGitContext({
      cwd: repoRoot,
    })!.repoFingerprint;
    const registryWithRef = readRegistryFile(registryFile);

    writeRegistryFile(
      registryFile,
      upsertRepoState(registryWithRef, repoFingerprint, {
        repo_root: repoRoot,
        desired_state: [
          {
            ...registryWithRef.repos[repoFingerprint]!.desired_state[0]!,
            ref: "stable",
          },
        ],
      }),
    );

    // When
    await expect(
      run(["add", remoteSourceB.source, remoteSourceB.bundle], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe("Applied react-expert for claude-code");

    // Then
    const registry = readRegistryFile(registryFile);
    const repoEntry = registry.repos[repoFingerprint]!;

    expect(repoEntry.desired_state).toEqual([
      {
        bundle: "react-expert",
        source: remoteSourceB.source,
        protocol: "https",
        resolved_ref: "main",
        resolved_commit: remoteSourceB.initialCommit,
      },
    ]);
  });
});
