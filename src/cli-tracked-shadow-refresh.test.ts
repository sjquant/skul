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

describe("tracked root-instruction shadow safety", () => {
  it("preserves untouched tracked shadow files during partial --agent refreshes", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# Team AGENTS\n");
    fs.writeFileSync(path.join(repoRoot, "CLAUDE.md"), "# Team CLAUDE\n");
    runGit(repoRoot, ["add", "AGENTS.md", "CLAUDE.md"]);
    runGit(repoRoot, ["commit", "-m", "track root instructions"]);
    writeManifest(homeDir, "github.com/user/ai-vault", "mixed-shadow", {
      name: "mixed-shadow",
      tools: {
        codex: { root_instruction: { path: "AGENTS.md" } },
        "claude-code": { root_instruction: { path: "CLAUDE.md" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "mixed-shadow",
      "AGENTS.md",
      "# Personal AGENTS\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "mixed-shadow",
      "CLAUDE.md",
      "# Personal CLAUDE\n",
    );
    await run(["add", "mixed-shadow"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    const claudeBefore = fs.readFileSync(
      path.join(repoRoot, "CLAUDE.md"),
      "utf8",
    );

    // When
    await expect(
      run(["add", "mixed-shadow", "--agent", "codex"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe("Applied mixed-shadow for codex");

    // Then
    expect(fs.readFileSync(path.join(repoRoot, "CLAUDE.md"), "utf8")).toBe(
      claudeBefore,
    );
    expect(readGitIndexFlag(repoRoot, "AGENTS.md")).toBe("S");
    expect(readGitIndexFlag(repoRoot, "CLAUDE.md")).toBe("S");

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const worktreeState =
      registry.worktrees[detectGitContext({ cwd: repoRoot })!.worktreeId]!;

    expect(worktreeState.shadowed_files["AGENTS.md"]).toBeDefined();
    expect(worktreeState.shadowed_files["CLAUDE.md"]).toBeDefined();
  });

  it("updates a tracked AGENTS.md shadow when a remote-backed bundle refreshes", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    fs.writeFileSync(
      path.join(repoRoot, "AGENTS.md"),
      "# Team base\nFollow repository policy.\n",
    );
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "track AGENTS"]);
    const remoteSource = createRemoteBundleSource(homeDir, {
      bundle: "personal-rules",
      manifest: {
        name: "personal-rules",
        tools: { codex: { root_instruction: { path: "AGENTS.md" } } },
      },
      files: {
        "AGENTS.md": "# Personal rules\nPrefer terse answers.\n",
      },
    });
    await run(["add", remoteSource.source, remoteSource.bundle], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    const initialRegistry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const initialShadow =
      initialRegistry.worktrees[
        detectGitContext({ cwd: repoRoot })!.worktreeId
      ]!.shadowed_files["AGENTS.md"]!;
    const updatedCommit = updateRemoteBundleSource(
      remoteSource.remoteRepoPath,
      remoteSource.bundle,
      {
        "AGENTS.md": "# Personal rules\nPrefer exact dates.\n",
      },
    );

    // When
    await expect(run(["update"], { homeDir, cwd: repoRoot })).resolves.toBe(
      `Updated personal-rules ${remoteSource.initialCommit.slice(0, 7)} -> ${updatedCommit.slice(0, 7)}`,
    );

    // Then
    assertAgentsDocument(
      repoRoot,
      "# Team base\nFollow repository policy.\n",
      formatTrackedRootInstructionShadowBlock(
        "personal-rules",
        "# Personal rules\nPrefer exact dates.\n",
      ),
    );
    expect(readGitIndexFlag(repoRoot, "AGENTS.md")).toBe("S");

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const worktreeState =
      registry.worktrees[detectGitContext({ cwd: repoRoot })!.worktreeId]!;
    const updatedShadow = worktreeState.shadowed_files["AGENTS.md"]!;

    expect(updatedShadow.base_blob).toBe(
      runGit(repoRoot, ["rev-parse", "HEAD:AGENTS.md"]),
    );
    expect(updatedShadow.overlay_fingerprint).not.toBe(
      initialShadow.overlay_fingerprint,
    );
    expect(updatedShadow.rendered_fingerprint).not.toBe(
      initialShadow.rendered_fingerprint,
    );
    expect(
      worktreeState.materialized_state.bundles["personal-rules"]!
        .resolved_commit,
    ).toBe(updatedCommit);
  });

  it("rejects tracked shadow refresh when prompt-time edits change the current rendered file", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    fs.writeFileSync(
      path.join(repoRoot, "AGENTS.md"),
      "# Team base\nFollow repository policy.\n",
    );
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "track AGENTS"]);
    writeManifest(homeDir, "github.com/user/ai-vault", "personal-rules", {
      name: "personal-rules",
      tools: {
        codex: {
          root_instruction: { path: "AGENTS.md" },
          skills: { path: ".agents/skills" },
        },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "personal-rules",
      "AGENTS.md",
      "# Personal rules\nPrefer terse answers.\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "personal-rules",
      ".agents/skills/p-rules/SKILL.md",
      "---\nname: p-rules\ndescription: Personal rules\n---\n# Personal rules\n",
    );
    await run(["add", "personal-rules"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    fs.writeFileSync(
      path.join(repoRoot, ".agents", "skills", "p-rules", "SKILL.md"),
      "# modified\n",
    );

    // When / Then
    await expect(
      run(["add", "personal-rules"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          confirmManagedFileRemoval: async () => {
            fs.writeFileSync(
              path.join(repoRoot, "AGENTS.md"),
              "# prompt edit\n",
            );
            return true;
          },
        }),
      }),
    ).rejects.toThrowError(/no longer matches Skul's recorded render/);
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      "# prompt edit\n",
    );
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".agents", "skills", "p-rules", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# modified\n");
  });

  it("retires a tracked AGENTS.md shadow when bundle refresh stops targeting the root instruction", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    fs.writeFileSync(
      path.join(repoRoot, "AGENTS.md"),
      "# Team base\nFollow repository policy.\n",
    );
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "track AGENTS"]);
    const remoteSource = createRemoteBundleSource(homeDir, {
      bundle: "personal-rules",
      manifest: {
        name: "personal-rules",
        tools: { codex: { root_instruction: { path: "AGENTS.md" } } },
      },
      files: {
        "AGENTS.md": "# Personal rules\nPrefer terse answers.\n",
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
        "manifest.json": `${JSON.stringify(
          {
            name: "personal-rules",
            tools: { codex: { skills: { path: ".agents/skills" } } },
          },
          null,
          2,
        )}\n`,
        ".agents/skills/p-rules/SKILL.md":
          "---\nname: p-rules\ndescription: Personal rules\n---\n# Personal rules\n",
      },
    );

    // When
    await expect(run(["update"], { homeDir, cwd: repoRoot })).resolves.toBe(
      `Updated personal-rules ${remoteSource.initialCommit.slice(0, 7)} -> ${updatedCommit.slice(0, 7)}`,
    );

    // Then
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      "# Team base\nFollow repository policy.\n",
    );
    expect(readGitIndexFlag(repoRoot, "AGENTS.md")).toBe("H");
    expect(
      pathExists(
        path.join(repoRoot, ".agents", "skills", "p-rules", "SKILL.md"),
      ),
    ).toBe(true);

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const worktreeState =
      registry.worktrees[detectGitContext({ cwd: repoRoot })!.worktreeId]!;

    expect(worktreeState.shadowed_files["AGENTS.md"]).toBeUndefined();
    expect(
      worktreeState.materialized_state.bundles["personal-rules"]!
        .resolved_commit,
    ).toBe(updatedCommit);
  });

  it("rejects tracked shadow retirement when the current rendered file was edited locally", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    fs.writeFileSync(
      path.join(repoRoot, "AGENTS.md"),
      "# Team base\nFollow repository policy.\n",
    );
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "track AGENTS"]);
    const remoteSource = createRemoteBundleSource(homeDir, {
      bundle: "personal-rules",
      manifest: {
        name: "personal-rules",
        tools: { codex: { root_instruction: { path: "AGENTS.md" } } },
      },
      files: {
        "AGENTS.md": "# Personal rules\nPrefer terse answers.\n",
      },
    });
    await run(["add", remoteSource.source, remoteSource.bundle], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# local edit\n");
    updateRemoteBundleSource(remoteSource.remoteRepoPath, remoteSource.bundle, {
      "manifest.json": `${JSON.stringify(
        {
          name: "personal-rules",
          tools: { codex: { skills: { path: ".agents/skills" } } },
        },
        null,
        2,
      )}\n`,
      ".agents/skills/p-rules/SKILL.md":
        "---\nname: p-rules\ndescription: Personal rules\n---\n# Personal rules\n",
    });

    // When / Then
    await expect(
      run(["update"], { homeDir, cwd: repoRoot }),
    ).rejects.toThrowError(
      /Cannot retire the shadow of AGENTS\.md because the current worktree content no longer matches what Skul wrote/,
    );
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      "# local edit\n",
    );
  });

  it("refuses add when materialization targets a tracked root instruction with staged changes", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# tracked\n");
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "track AGENTS"]);
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# staged\n");
    runGit(repoRoot, ["add", "AGENTS.md"]);
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });

    vi.resetModules();
    vi.doMock("./bundle-materialization", async () => {
      const actual = await vi.importActual<
        typeof import("./bundle-materialization")
      >("./bundle-materialization");

      return {
        ...actual,
        previewMaterializeBundleWriteTargets: vi.fn(() => ["AGENTS.md"]),
        materializeBundle: vi.fn(async () => {
          throw new Error(
            "materializeBundle should not run after preflight rejection",
          );
        }),
      };
    });

    // When / Then
    try {
      const { run: isolatedRun } = await import("./index");

      await expect(
        isolatedRun(["add", "react-expert"], {
          homeDir,
          cwd: repoRoot,
          prompts: createPromptClientStub(),
        }),
      ).rejects.toThrowError(/target has staged changes/);
    } finally {
      vi.doUnmock("./bundle-materialization");
      vi.resetModules();
    }
  });

  it("refuses tracked root-instruction shadow creation when the target has staged changes", () => {
    // Given
    const repoRoot = createRepository();
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# tracked\n");
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "track AGENTS"]);
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# staged\n");
    runGit(repoRoot, ["add", "AGENTS.md"]);

    // When / Then
    expect(() =>
      assertTrackedShadowSafety({
        repoRoot,
        filePath: "AGENTS.md",
        operation: "create",
      }),
    ).toThrowError(/target has staged changes/);
  });

  it("refuses tracked root-instruction shadow refresh when the target has unstaged changes", () => {
    // Given
    const repoRoot = createRepository();
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# tracked\n");
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "track AGENTS"]);
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# unstaged\n");

    // When / Then
    expect(() =>
      assertTrackedShadowSafety({
        repoRoot,
        filePath: "AGENTS.md",
        operation: "refresh",
      }),
    ).toThrowError(/target has unstaged changes/);
  });

  it("refuses tracked root-instruction shadow creation when the target is unmerged", () => {
    // Given
    const repoRoot = createRepository();
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# base\n");
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "track AGENTS"]);

    runGit(repoRoot, ["checkout", "-b", "feature"]);
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# feature\n");
    runGit(repoRoot, ["commit", "-am", "feature change"]);

    runGit(repoRoot, ["checkout", "main"]);
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# main\n");
    runGit(repoRoot, ["commit", "-am", "main change"]);
    runGit(repoRoot, ["merge", "feature"], { allowFailure: true });

    // When / Then
    expect(() =>
      assertTrackedShadowSafety({
        repoRoot,
        filePath: "AGENTS.md",
        operation: "create",
      }),
    ).toThrowError(/target has unmerged index entries/);
  });

  it("refuses tracked root-instruction shadow creation when the target has no HEAD content", () => {
    // Given
    const repoRoot = createRepository();
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# staged only\n");
    runGit(repoRoot, ["add", "AGENTS.md"]);

    // When / Then
    expect(() =>
      assertTrackedShadowSafety({
        repoRoot,
        filePath: "AGENTS.md",
        operation: "create",
      }),
    ).toThrowError(/does not have HEAD content/);
  });

  it("refuses tracked root-instruction shadow refresh when the target has incompatible index flags", () => {
    // Given
    const repoRoot = createRepository();
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# tracked\n");
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "track AGENTS"]);
    runGit(repoRoot, ["update-index", "--assume-unchanged", "--", "AGENTS.md"]);

    // When / Then
    expect(() =>
      assertTrackedShadowSafety({
        repoRoot,
        filePath: "AGENTS.md",
        operation: "refresh",
      }),
    ).toThrowError(/incompatible index flags: h/);
  });

  it("refuses bundle refresh before deleting existing managed files when a tracked root instruction is dirty", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# tracked\n");
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "track AGENTS"]);
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

    const managedFilePath = path.join(
      repoRoot,
      ".claude",
      "skills",
      "react",
      "SKILL.md",
    );
    expect(fs.existsSync(managedFilePath)).toBe(true);
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# unstaged\n");

    vi.resetModules();
    vi.doMock("./bundle-materialization", async () => {
      const actual = await vi.importActual<
        typeof import("./bundle-materialization")
      >("./bundle-materialization");

      return {
        ...actual,
        previewMaterializeBundleWriteTargets: vi.fn(() => ["AGENTS.md"]),
        materializeBundle: vi.fn(async () => {
          throw new Error(
            "materializeBundle should not run after preflight rejection",
          );
        }),
      };
    });

    // When / Then
    try {
      const { run: isolatedRun } = await import("./index");

      await expect(
        isolatedRun(["add", "react-expert"], {
          homeDir,
          cwd: repoRoot,
          prompts: createPromptClientStub(),
        }),
      ).rejects.toThrowError(/target has unstaged changes/);
      expect(fs.existsSync(managedFilePath)).toBe(true);
    } finally {
      vi.doUnmock("./bundle-materialization");
      vi.resetModules();
    }
  });
});
