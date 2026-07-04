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
  it("apply materializes all desired bundles into the current worktree", async () => {
    // Given: two bundles in desired state but neither materialized in this worktree
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const linkedWorktree = createLinkedWorktree(repoRoot);
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
    // Add both bundles from main worktree
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

    // When: apply from linked worktree that has no materialized files
    await expect(
      run(["apply"], { homeDir, cwd: linkedWorktree }),
    ).resolves.toBe("Applied react-expert, repo-standards");

    // Then: both bundles' files are written into the linked worktree
    expect(
      fs.readFileSync(
        path.join(linkedWorktree, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
    expect(
      fs.readFileSync(
        path.join(linkedWorktree, ".agents", "skills", "next-task", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# next task\n");

    // And the registry records the linked worktree's materialized state
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const linkedCtx = detectGitContext({ cwd: linkedWorktree })!;
    const worktreeState = registry.worktrees[linkedCtx.worktreeId];
    expect(worktreeState).toBeDefined();
    expect(worktreeState.materialized_state.bundles).toHaveProperty(
      "react-expert",
    );
    expect(worktreeState.materialized_state.bundles).toHaveProperty(
      "repo-standards",
    );
  });

  it("apply is a no-op when all desired bundles are already materialized", async () => {
    // Given: bundle already materialized in the current worktree
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
    await expect(run(["apply"], { homeDir, cwd: repoRoot })).resolves.toBe(
      "All bundles are already materialized",
    );
  });

  it("applies over a modified managed file without prompting when apply uses yes", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const linkedWorktree = createLinkedWorktree(repoRoot);
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
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "react-expert",
      ".claude/skills/next/SKILL.md",
      "# next\n",
    );
    await run(["add", "react-expert", "--include", "skills/react"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    await run(["apply"], { homeDir, cwd: linkedWorktree });
    fs.writeFileSync(
      path.join(linkedWorktree, ".claude", "skills", "react", "SKILL.md"),
      "# modified\n",
    );
    await run(["add", "react-expert", "--include", "skills/next"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When
    await expect(
      run(["apply", "-y"], {
        homeDir,
        cwd: linkedWorktree,
        prompts: createPromptClientStub({ confirmManagedFileRemoval }),
      }),
    ).resolves.toContain("Applied react-expert");

    // Then
    expect(confirmManagedFileRemoval).not.toHaveBeenCalled();
    expect(
      fs.readFileSync(
        path.join(linkedWorktree, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
    expect(
      fs.readFileSync(
        path.join(linkedWorktree, ".claude", "skills", "next", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# next\n");
  });

  it("apply only materializes bundles missing from the current worktree", async () => {
    // Given: two bundles in desired state; one already materialized, one missing
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const linkedWorktree = createLinkedWorktree(repoRoot);
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
    // Add both to desired state from main worktree
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
    // Materialize only react-expert in the linked worktree
    await run(["add", "react-expert"], {
      homeDir,
      cwd: linkedWorktree,
      prompts: createPromptClientStub(),
    });

    // When: apply should only materialize the missing bundle
    await expect(
      run(["apply"], { homeDir, cwd: linkedWorktree }),
    ).resolves.toBe("Applied repo-standards");

    // Then: both bundles are now present in the linked worktree
    expect(
      fs.readFileSync(
        path.join(linkedWorktree, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
    expect(
      fs.readFileSync(
        path.join(linkedWorktree, ".agents", "skills", "next-task", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# next task\n");
  });

  it("apply reports no bundles configured when the repository has no desired state", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    // When / Then
    await expect(run(["apply"], { homeDir, cwd: repoRoot })).resolves.toBe(
      `No bundles configured for this repository. Run "skul add <bundle>" to add one`,
    );
  });

  it("apply does not modify desired state", async () => {
    // Given: bundle added from main worktree
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const linkedWorktree = createLinkedWorktree(repoRoot);
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
    const registryBefore = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const repoFingerprint = detectGitContext({
      cwd: repoRoot,
    })!.repoFingerprint;
    const desiredStateBefore =
      registryBefore.repos[repoFingerprint]?.desired_state;

    // When
    await run(["apply"], { homeDir, cwd: linkedWorktree });

    // Then: desired state is unchanged
    const registryAfter = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    expect(registryAfter.repos[repoFingerprint]?.desired_state).toEqual(
      desiredStateBefore,
    );
  });

  it("surfaces a clear error when apply runs outside a Git repository", async () => {
    // Given
    const homeDir = createHomeDir();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skul-non-git-"));
    tempDirs.push(cwd);

    // When / Then
    await expect(run(["apply"], { homeDir, cwd })).rejects.toThrowError(
      /skul apply requires a Git repository/,
    );
  });

  it("warns and suggests repair when the registry file is corrupted", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const registryFile = path.join(homeDir, ".skul", "registry.json");
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(registryFile, "{broken json");

    // When / Then
    await expect(
      run(["status"], { homeDir, cwd: repoRoot }),
    ).rejects.toThrowError(
      /Registry is corrupted[\s\S]*repair or remove[\s\S]*registry\.json/i,
    );
  });

  it("invokes conflict resolution when a newly added bundle targets a file already managed by another bundle", async () => {
    // Given: react-expert is materialized with .claude/skills/react/SKILL.md
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
    writeManifest(homeDir, "github.com/user/ai-vault", "next-expert", {
      name: "next-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    // next-expert also writes to the same relative skill path, causing a cross-bundle conflict
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "next-expert",
      ".claude/skills/react/SKILL.md",
      "# next react\n",
    );
    await run(["add", "react-expert"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    const resolveFileConflict = vi
      .fn()
      .mockResolvedValue({ action: "overwrite" });

    // When: add next-expert whose file conflicts with react-expert's managed file
    await expect(
      run(["add", "next-expert"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ resolveFileConflict }),
      }),
    ).resolves.toBe("Applied next-expert for claude-code");

    // Then: conflict callback was invoked with the relative skill item path
    expect(resolveFileConflict).toHaveBeenCalledWith("react");

    // Then: next-expert's file overwrites react-expert's managed file
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# next react\n");

    // Then: the registry records both bundles with their respective file paths
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
        "next-expert": {
          tools: {
            "claude-code": { files: [".claude/skills/react/SKILL.md"] },
          },
        },
      },
    });
  });

  it("overwrites a conflicting managed file without prompting when add uses yes", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const resolveFileConflict = vi.fn(async () => {
      throw new Error("resolveFileConflict should not be called");
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
    writeManifest(homeDir, "github.com/user/ai-vault", "next-expert", {
      name: "next-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "next-expert",
      ".claude/skills/react/SKILL.md",
      "# next react\n",
    );
    await run(["add", "react-expert"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When
    await expect(
      run(["add", "next-expert", "-y"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ resolveFileConflict }),
      }),
    ).resolves.toBe("Applied next-expert for claude-code");

    // Then
    expect(resolveFileConflict).not.toHaveBeenCalled();
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# next react\n");
  });

  it("cleans up Skul-created directories when removing the last managed file in them", async () => {
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
    expect(pathExists(path.join(repoRoot, ".claude", "skills", "react"))).toBe(
      true,
    );

    // When
    await expect(
      run(["remove", "react-expert"], { homeDir, cwd: repoRoot }),
    ).resolves.toBe("Removed react-expert");

    // Then: managed file is removed
    expect(
      pathExists(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md")),
    ).toBe(false);

    // Then: all Skul-created directories are cleaned up (deepest first)
    expect(pathExists(path.join(repoRoot, ".claude", "skills", "react"))).toBe(
      false,
    );
    expect(pathExists(path.join(repoRoot, ".claude", "skills"))).toBe(false);
  });

  it("does not remove a Skul-created directory when another bundle still owns files in it", async () => {
    // Given: two bundles both write into .claude/skills/react/
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
    writeManifest(homeDir, "github.com/user/ai-vault", "next-expert", {
      name: "next-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    // next-expert writes a different file under the same directory; no conflict occurs
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "next-expert",
      ".claude/skills/react/NEXT.md",
      "# next\n",
    );
    await run(["add", "react-expert"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    await run(["add", "next-expert"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When: remove react-expert only
    await expect(
      run(["remove", "react-expert"], { homeDir, cwd: repoRoot }),
    ).resolves.toBe("Removed react-expert");

    // Then: react-expert's file is gone
    expect(
      pathExists(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md")),
    ).toBe(false);

    // Then: the shared directory still exists because next-expert owns a file in it
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "NEXT.md"),
        "utf8",
      ),
    ).toBe("# next\n");
    expect(pathExists(path.join(repoRoot, ".claude", "skills", "react"))).toBe(
      true,
    );

    // Then: registry still records next-expert; react-expert is gone from both desired and materialized state
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const repoFingerprint = detectGitContext({
      cwd: repoRoot,
    })!.repoFingerprint;
    expect(registry.repos[repoFingerprint]?.desired_state).toEqual([
      {
        bundle: "next-expert",
        source: "github.com/user/ai-vault",
        protocol: "https",
      },
    ]);
    const worktree = registry.worktrees[Object.keys(registry.worktrees)[0]];
    expect(worktree.materialized_state.bundles).not.toHaveProperty(
      "react-expert",
    );
    expect(worktree.materialized_state.bundles).toHaveProperty("next-expert");
  });

  it("apply respects tool selection stored in desired state", async () => {
    // Given: react-expert added with --agent claude-code; desired_state records tools: ['claude-code']
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
    await run(["add", "react-expert", "--agent", "claude-code"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When: apply in the linked worktree should honour the stored tool selection
    await expect(
      run(["apply"], { homeDir, cwd: linkedWorktree }),
    ).resolves.toBe("Applied react-expert");

    // Then: only claude-code files are present; cursor files are absent
    expect(
      fs.readFileSync(
        path.join(linkedWorktree, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
    expect(
      pathExists(
        path.join(linkedWorktree, ".cursor", "skills", "react", "SKILL.md"),
      ),
    ).toBe(false);

    // Then: registry for linked worktree records only claude-code
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const linkedCtx = detectGitContext({ cwd: linkedWorktree })!;
    const worktreeState = registry.worktrees[linkedCtx.worktreeId];
    expect(
      worktreeState.materialized_state.bundles["react-expert"].tools,
    ).toMatchObject({
      "claude-code": {
        files: expect.arrayContaining([".claude/skills/react/SKILL.md"]),
      },
    });
    expect(
      worktreeState.materialized_state.bundles["react-expert"].tools,
    ).not.toHaveProperty("cursor");
  });

  it("apply materializes a tracked AGENTS.md in a linked worktree from repository desired state", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    fs.writeFileSync(
      path.join(repoRoot, "AGENTS.md"),
      "repo base instruction\n",
    );
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "track agents"]);

    const linkedWorktree = createLinkedWorktree(repoRoot);
    writeRootInstructionBundleFixture(homeDir, {
      bundle: "repo-standards",
      content: "# Repo standards\nUse consistent conventions.\n",
    });
    await run(["add", "repo-standards"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    expect(
      fs.readFileSync(path.join(linkedWorktree, "AGENTS.md"), "utf8"),
    ).toBe("repo base instruction\n");

    // When
    await expect(
      run(["apply"], { homeDir, cwd: linkedWorktree }),
    ).resolves.toBe("Applied repo-standards");

    // Then
    expectAgentsDocument(
      linkedWorktree,
      "repo base instruction\n",
      formatTrackedRootInstructionShadowBlock(
        "repo-standards",
        "# Repo standards\nUse consistent conventions.\n",
      ),
    );
    expect(readGitIndexFlag(linkedWorktree, "AGENTS.md")).toBe("S");

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const repoFingerprint = detectGitContext({
      cwd: repoRoot,
    })!.repoFingerprint;
    const linkedCtx = detectGitContext({ cwd: linkedWorktree })!;
    const linkedEntry = registry.worktrees[linkedCtx.worktreeId]!;

    expect(registry.repos[repoFingerprint]!.desired_state).toEqual([
      {
        bundle: "repo-standards",
        source: "github.com/user/ai-vault",
        protocol: "https",
      },
    ]);
    expect(
      linkedEntry.materialized_state.bundles["repo-standards"]!.tools["codex"]!
        .files,
    ).toEqual([]);
    expect(linkedEntry.shadowed_files["AGENTS.md"]).toMatchObject({
      tool: "codex",
      bundle: "repo-standards",
      strategy: "append",
      base_blob: runGit(linkedWorktree, ["rev-parse", "HEAD:AGENTS.md"]),
      skip_worktree: true,
    });
  });

  it("apply preserves linked worktree shadow metadata while materializing inherited non-root bundles", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    fs.writeFileSync(
      path.join(repoRoot, "AGENTS.md"),
      "repo base instruction\n",
    );
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "track agents"]);

    const linkedWorktree = createLinkedWorktree(repoRoot);
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
      path.join(linkedWorktree, "AGENTS.md"),
      "# Shadowed content\n",
    );
    runGit(linkedWorktree, [
      "update-index",
      "--skip-worktree",
      "--",
      "AGENTS.md",
    ]);
    const renderedFingerprint = fingerprintFile(
      path.join(linkedWorktree, "AGENTS.md"),
    );

    const registryFile = path.join(homeDir, ".skul", "registry.json");
    const registry = readRegistryFile(registryFile);
    const repoCtx = detectGitContext({ cwd: repoRoot })!;
    const linkedCtx = detectGitContext({ cwd: linkedWorktree })!;
    const linkedShadowState = {
      "AGENTS.md": {
        tool: "codex" as const,
        bundle: "personal-rules",
        strategy: "append" as const,
        base_blob: runGit(repoRoot, ["rev-parse", "HEAD:AGENTS.md"]),
        overlay: "# Shadowed content\n",
        overlay_fingerprint: renderedFingerprint,
        rendered_fingerprint: renderedFingerprint,
        skip_worktree: true,
      },
    };

    writeRegistryFile(
      registryFile,
      upsertWorktreeState(registry, linkedCtx.worktreeId, {
        repo_fingerprint: repoCtx.repoFingerprint,
        path: fs.realpathSync.native(linkedWorktree),
        materialized_state: {
          bundles: {},
          exclude_configured: false,
        },
        shadowed_files: linkedShadowState,
      }),
    );

    // When
    await expect(
      run(["apply"], { homeDir, cwd: linkedWorktree }),
    ).resolves.toBe("Applied react-expert");

    // Then
    const updatedRegistry = readRegistryFile(registryFile);
    const linkedEntry = updatedRegistry.worktrees[linkedCtx.worktreeId]!;
    const mainEntry = updatedRegistry.worktrees[repoCtx.worktreeId]!;

    expect(
      fs.readFileSync(path.join(linkedWorktree, "AGENTS.md"), "utf8"),
    ).toBe("# Shadowed content\n");
    expect(readGitIndexFlag(linkedWorktree, "AGENTS.md")).toBe("S");
    expect(
      fs.readFileSync(
        path.join(linkedWorktree, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
    expect(linkedEntry.shadowed_files).toEqual(linkedShadowState);
    expect(
      linkedEntry.materialized_state.bundles["react-expert"]!.tools[
        "claude-code"
      ]!.files,
    ).toContain(".claude/skills/react/SKILL.md");
    expect(mainEntry.shadowed_files).toEqual({});
  });

  it("surfaces a clear error when status runs outside a Git repository", async () => {
    // Given
    const homeDir = createHomeDir();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skul-non-git-"));
    tempDirs.push(cwd);

    // When / Then
    await expect(run(["status"], { homeDir, cwd })).rejects.toThrowError(
      /skul status requires a Git repository/,
    );
  });

  it("surfaces a clear error when check runs outside a Git repository", async () => {
    // Given
    const homeDir = createHomeDir();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skul-non-git-"));
    tempDirs.push(cwd);

    // When / Then
    await expect(run(["check"], { homeDir, cwd })).rejects.toThrowError(
      /skul check requires a Git repository/,
    );
  });

  it("surfaces a clear error when update runs outside a Git repository", async () => {
    // Given
    const homeDir = createHomeDir();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skul-non-git-"));
    tempDirs.push(cwd);

    // When / Then
    await expect(run(["update"], { homeDir, cwd })).rejects.toThrowError(
      /skul update requires a Git repository/,
    );
  });

  it("dry-runs update without fetching or modifying files", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const { source, bundle, remoteRepoPath } = createRemoteBundleSource(
      homeDir,
      {
        bundle: "react-expert",
        manifest: {
          name: "react-expert",
          tools: { "claude-code": { skills: { path: ".claude/skills" } } },
        },
        files: { ".claude/skills/react/SKILL.md": "# v1\n" },
      },
    );
    await run(["add", source, bundle], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    const commitBefore = updateRemoteBundleSource(remoteRepoPath, bundle, {
      ".claude/skills/react/SKILL.md": "# v2\n",
    });

    // When
    const output = await run(["update", "--dry-run"], {
      homeDir,
      cwd: repoRoot,
    });

    // Then: output describes what would happen without actually updating
    expect(output).toMatch(/DRY RUN: Would update react-expert/);

    // Then: the local cached source is not fetched / updated
    const skillFile = path.join(
      repoRoot,
      ".claude",
      "skills",
      "react",
      "SKILL.md",
    );
    expect(fs.readFileSync(skillFile, "utf8")).toBe("# v1\n");
    void commitBefore; // silence unused-var warning
  });

  it("returns JSON output for check", async () => {
    // Given — desired state contains a source-less bundle entry
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const registryFile = path.join(homeDir, ".skul", "registry.json");
    const gitContext = detectGitContext({ cwd: repoRoot })!;
    const registry = upsertRepoState(
      createEmptyRegistry(),
      gitContext.repoFingerprint,
      {
        repo_root: fs.realpathSync.native(repoRoot),
        desired_state: [{ bundle: "react-expert", protocol: "https" }],
      },
    );
    writeRegistryFile(registryFile, registry);

    // When
    const output = await run(["check", "--json"], { homeDir, cwd: repoRoot });
    const parsed = JSON.parse(output);

    // Then
    expect(parsed.bundles).toHaveLength(1);
    expect(parsed.bundles[0]).toMatchObject({
      bundle: "react-expert",
      status: "local-only",
      source: null,
    });
  });

  it("dry-runs apply without materializing files", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const linkedWorktree = createLinkedWorktree(repoRoot);
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

    // When: dry-run apply in a linked worktree that has nothing materialized yet
    const output = await run(["apply", "--dry-run"], {
      homeDir,
      cwd: linkedWorktree,
    });

    // Then: output describes what would happen
    expect(output).toMatch(/DRY RUN: Would apply react-expert/);

    // Then: no files were written to the linked worktree
    expect(
      pathExists(
        path.join(linkedWorktree, ".claude", "skills", "react", "SKILL.md"),
      ),
    ).toBe(false);
  });

  it("dry-runs apply reporting intent without cloning when source is not cached", async () => {
    // Given: desired state references a remote source, but nothing is cached locally yet
    const homeDir = createHomeDir();
    const { source, bundle, remoteRepoPath } = createRemoteBundleSource(
      homeDir,
      {
        bundle: "react-expert",
        manifest: {
          name: "react-expert",
          tools: { "claude-code": { skills: { path: ".claude/skills" } } },
        },
        files: { ".claude/skills/react/SKILL.md": "# react\n" },
      },
    );

    // Set up desired state manually without materializing (simulate a fresh worktree)
    const repoRoot = createRepository();
    const registryFile = path.join(homeDir, ".skul", "registry.json");
    const repoFingerprint = detectGitContext({
      cwd: repoRoot,
    })!.repoFingerprint;
    let registry = readRegistryFile(registryFile);
    registry = upsertRepoState(registry, repoFingerprint, {
      repo_root: repoRoot,
      desired_state: [{ bundle, source, protocol: "https" }],
    });
    writeRegistryFile(registryFile, registry);

    // Remove the cached source so it is not available locally
    fs.rmSync(path.join(homeDir, ".skul", "library", ...source.split("/")), {
      recursive: true,
      force: true,
    });

    // When
    const output = await run(["apply", "--dry-run"], {
      homeDir,
      cwd: repoRoot,
    });

    // Then: output reports intent without cloning
    expect(output).toMatch(
      new RegExp(
        `DRY RUN: Would clone ${source.replace(/\./g, "\\.")} then apply ${bundle}`,
      ),
    );

    // Then: no clone was performed
    expect(
      pathExists(path.join(homeDir, ".skul", "library", ...source.split("/"))),
    ).toBe(false);

    void remoteRepoPath;
  });

  it("rejects unknown --agent names with a helpful error", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs(["add", "react-expert", "--agent", "windsurf"]),
    ).rejects.toThrowError(/Unknown tool: windsurf[\s\S]*Valid tools:/);
  });

  it("persists an explicit ref selector when adding a remote-backed bundle", async () => {
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
    runGit(remoteSource.remoteRepoPath, ["branch", "stable"]);

    // When
    await expect(
      run(
        ["add", remoteSource.source, remoteSource.bundle, "--ref", "stable"],
        { homeDir, cwd: repoRoot, prompts: createPromptClientStub() },
      ),
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
      ref: "stable",
      resolved_ref: "stable",
      resolved_commit: remoteSource.initialCommit,
    });
  });

  it("applies an uncached remote-backed bundle from its explicit ref", async () => {
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
        ".claude/skills/react/SKILL.md": "# main\n",
      },
    });
    runGit(remoteSource.remoteRepoPath, ["checkout", "-b", "stable"]);
    fs.writeFileSync(
      path.join(
        remoteSource.remoteRepoPath,
        remoteSource.bundle,
        ".claude",
        "skills",
        "react",
        "SKILL.md",
      ),
      "# stable\n",
    );
    runGit(remoteSource.remoteRepoPath, ["add", "."]);
    runGit(remoteSource.remoteRepoPath, ["commit", "-m", "Stable bundle"]);
    const stableCommit = runGit(remoteSource.remoteRepoPath, [
      "rev-parse",
      "HEAD",
    ]);
    runGit(remoteSource.remoteRepoPath, ["checkout", "main"]);

    await run(
      ["add", remoteSource.source, remoteSource.bundle, "--ref", "stable"],
      { homeDir, cwd: repoRoot, prompts: createPromptClientStub() },
    );
    const linkedWorktree = createLinkedWorktree(repoRoot);
    fs.rmSync(
      path.join(homeDir, ".skul", "library", ...remoteSource.source.split("/")),
      { recursive: true, force: true },
    );
    const previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    const gitConfigFile = path.join(homeDir, "gitconfig");
    fs.writeFileSync(
      gitConfigFile,
      `[url "${remoteSource.remoteRepoPath}"]\n\tinsteadOf = https://${remoteSource.source}\n`,
    );
    process.env.GIT_CONFIG_GLOBAL = gitConfigFile;

    try {
      // When
      await expect(
        run(["apply"], { homeDir, cwd: linkedWorktree }),
      ).resolves.toBe(`Cloned ${remoteSource.source}\nApplied react-expert`);
    } finally {
      if (previousGitConfigGlobal === undefined) {
        delete process.env.GIT_CONFIG_GLOBAL;
      } else {
        process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal;
      }
    }

    // Then
    expect(
      fs.readFileSync(
        path.join(linkedWorktree, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# stable\n");
    expect(
      readRegistryFile(path.join(homeDir, ".skul", "registry.json")).worktrees[
        detectGitContext({ cwd: linkedWorktree })!.worktreeId
      ]?.materialized_state.bundles["react-expert"]?.resolved_commit,
    ).toBe(stableCommit);
  });

  it("pins a remote-backed bundle to an explicit commit via --ref", async () => {
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
      run(
        [
          "add",
          remoteSource.source,
          remoteSource.bundle,
          "--ref",
          remoteSource.initialCommit,
        ],
        { homeDir, cwd: repoRoot, prompts: createPromptClientStub() },
      ),
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
      ref: remoteSource.initialCommit,
      resolved_commit: remoteSource.initialCommit,
    });
  });
});
