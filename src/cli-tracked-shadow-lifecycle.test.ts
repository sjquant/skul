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

describe("tracked root-instruction shadow safety", () => {
  it("creates a tracked AGENTS.md shadow during add and records shadow metadata", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    fs.writeFileSync(
      path.join(repoRoot, "AGENTS.md"),
      "# Team base\nFollow repository policy.\n",
    );
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "track AGENTS"]);
    writeRootInstructionBundleFixture(homeDir, {
      bundle: "personal-rules",
      content: "# Personal rules\nPrefer terse answers.\n",
    });

    // When
    await expect(
      run(["add", "personal-rules", "--agent", "codex"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe("Applied personal-rules for codex");

    // Then
    assertAgentsDocument(
      repoRoot,
      "# Team base\nFollow repository policy.\n",
      formatTrackedRootInstructionShadowBlock(
        "personal-rules",
        "# Personal rules\nPrefer terse answers.\n",
      ),
    );
    expect(readGitIndexFlag(repoRoot, "AGENTS.md")).toBe("S");
    expect(
      fs.readFileSync(path.join(repoRoot, ".git", "info", "exclude"), "utf8"),
    ).not.toContain("# >>> SKUL START");

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const worktreeState =
      registry.worktrees[detectGitContext({ cwd: repoRoot })!.worktreeId]!;

    expect(
      worktreeState.materialized_state.bundles["personal-rules"]!.tools[
        "codex"
      ]!.files,
    ).toEqual([]);
    expect(worktreeState.shadowed_files["AGENTS.md"]).toMatchObject({
      tool: "codex",
      bundle: "personal-rules",
      strategy: "append",
      base_blob: runGit(repoRoot, ["rev-parse", "HEAD:AGENTS.md"]),
      skip_worktree: true,
    });
    expect(
      worktreeState.shadowed_files["AGENTS.md"]!.overlay_fingerprint,
    ).toMatch(/^[0-9a-f]{64}$/);
    expect(
      worktreeState.shadowed_files["AGENTS.md"]!.rendered_fingerprint,
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it("creates a tracked CLAUDE.md shadow during add", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    fs.writeFileSync(
      path.join(repoRoot, "CLAUDE.md"),
      "# Team base\nUse shared prompts.\n",
    );
    runGit(repoRoot, ["add", "CLAUDE.md"]);
    runGit(repoRoot, ["commit", "-m", "track CLAUDE"]);
    writeRootInstructionBundleFixture(homeDir, {
      bundle: "repo-guide",
      agent: "claude-code",
      content: "# Repo guide\nUse @imports sparingly.\n",
    });

    // When
    await expect(
      run(["add", "repo-guide", "--agent", "claude-code"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe("Applied repo-guide for claude-code");

    // Then
    assertClaudeDocument(
      repoRoot,
      "# Team base\nUse shared prompts.\n",
      formatTrackedRootInstructionShadowBlock(
        "repo-guide",
        "# Repo guide\nUse @imports sparingly.\n",
      ),
    );
    expect(readGitIndexFlag(repoRoot, "CLAUDE.md")).toBe("S");
    expect(
      fs.readFileSync(path.join(repoRoot, ".git", "info", "exclude"), "utf8"),
    ).not.toContain("# >>> SKUL START");

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const worktreeState =
      registry.worktrees[detectGitContext({ cwd: repoRoot })!.worktreeId]!;

    expect(
      worktreeState.materialized_state.bundles["repo-guide"]!.tools[
        "claude-code"
      ]!.files,
    ).toEqual([]);
    expect(worktreeState.shadowed_files["CLAUDE.md"]).toMatchObject({
      tool: "claude-code",
      bundle: "repo-guide",
      strategy: "append",
      base_blob: runGit(repoRoot, ["rev-parse", "HEAD:CLAUDE.md"]),
      skip_worktree: true,
    });
  });

  it("creates a tracked replace shadow when explicitly requested", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# team policy\n");
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "Add team policy"]);
    writeRootInstructionBundleFixture(homeDir, {
      bundle: "repo-standards",
      content: "# personal policy\n",
    });

    // When
    await run(
      [
        "add",
        "repo-standards",
        "--agent",
        "codex",
        "--root-instruction-mode",
        "replace",
      ],
      { homeDir, cwd: repoRoot, prompts: createPromptClientStub() },
    );

    // Then
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      "<!-- SKUL:INSTRUCTIONS START -->\n\nFollow the instructions in this section; SKUL markers are metadata used to manage the content.\n\n# personal policy\n\n<!-- SKUL:INSTRUCTIONS END -->\n",
    );
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const worktree = registry.worktrees[Object.keys(registry.worktrees)[0]!];
    expect(worktree.shadowed_files["AGENTS.md"]?.strategy).toBe("replace");

    // When
    await run(["remove", "repo-standards"], { homeDir, cwd: repoRoot });

    // Then
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      "# team policy\n",
    );
  });

  it("warns when an existing tracked append shadow changes to replace", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# team policy\n");
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "Add team policy"]);
    writeRootInstructionBundleFixture(homeDir, {
      bundle: "repo-standards",
      content: "# personal policy\n",
    });
    await run(["add", "repo-standards", "--agent", "codex"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    const resolveFileConflict = vi.fn(
      async (): Promise<{ action: "overwrite" }> => ({ action: "overwrite" }),
    );

    // When
    await run(
      [
        "add",
        "repo-standards",
        "--agent",
        "codex",
        "--root-instruction-mode",
        "replace",
      ],
      {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ resolveFileConflict }),
      },
    );

    // Then
    expect(resolveFileConflict).toHaveBeenCalledWith("AGENTS.md");
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      "<!-- SKUL:INSTRUCTIONS START -->\n\nFollow the instructions in this section; SKUL markers are metadata used to manage the content.\n\n# personal policy\n\n<!-- SKUL:INSTRUCTIONS END -->\n",
    );
  });

  it("suspends and refreshes a tracked AGENTS.md shadow around a HEAD change", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# tracked agents\n");
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "track AGENTS"]);
    writeRootInstructionBundleFixture(homeDir, {
      bundle: "repo-standards",
      content: "# Repo standards\nUse consistent conventions.\n",
    });
    await run(["add", "repo-standards", "--agent", "codex"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When
    await expect(
      run(["shadow", "--suspend"], { homeDir, cwd: repoRoot }),
    ).resolves.toBe("Suspended tracked shadows for AGENTS.md");
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# tracked agents v2\n");
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "refresh agents base"]);
    await expect(
      run(["shadow", "--refresh"], { homeDir, cwd: repoRoot }),
    ).resolves.toBe("Refreshed tracked shadows for AGENTS.md");

    // Then
    assertAgentsDocument(
      repoRoot,
      "# tracked agents v2\n",
      formatTrackedRootInstructionShadowBlock(
        "repo-standards",
        "# Repo standards\nUse consistent conventions.\n",
      ),
    );
    expect(readGitIndexFlag(repoRoot, "AGENTS.md")).toBe("S");

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const shadowedFile =
      registry.worktrees[detectGitContext({ cwd: repoRoot })!.worktreeId]!
        .shadowed_files["AGENTS.md"]!;
    expect(shadowedFile.skip_worktree).toBe(true);
    expect(shadowedFile.base_blob).toBe(
      runGit(repoRoot, ["rev-parse", "HEAD:AGENTS.md"]),
    );
    expect(shadowedFile.overlay.trimEnd()).toBe(
      "# Repo standards\nUse consistent conventions.",
    );
  });

  it("suspends and refreshes a tracked CLAUDE.md shadow around a HEAD change", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    fs.writeFileSync(path.join(repoRoot, "CLAUDE.md"), "# tracked claude\n");
    runGit(repoRoot, ["add", "CLAUDE.md"]);
    runGit(repoRoot, ["commit", "-m", "track CLAUDE"]);
    writeRootInstructionBundleFixture(homeDir, {
      bundle: "claude-standards",
      agent: "claude-code",
      content: "# Claude standards\nUse Claude defaults.\n",
    });
    await run(["add", "claude-standards", "--agent", "claude-code"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When
    await expect(
      run(["shadow", "--suspend"], { homeDir, cwd: repoRoot }),
    ).resolves.toBe("Suspended tracked shadows for CLAUDE.md");
    expect(readGitIndexFlag(repoRoot, "CLAUDE.md")).toBe("H");
    fs.writeFileSync(path.join(repoRoot, "CLAUDE.md"), "# tracked claude v2\n");
    runGit(repoRoot, ["add", "CLAUDE.md"]);
    runGit(repoRoot, ["commit", "-m", "refresh claude base"]);
    await expect(
      run(["shadow", "--refresh"], { homeDir, cwd: repoRoot }),
    ).resolves.toBe("Refreshed tracked shadows for CLAUDE.md");

    // Then
    assertClaudeDocument(
      repoRoot,
      "# tracked claude v2\n",
      formatTrackedRootInstructionShadowBlock(
        "claude-standards",
        "# Claude standards\nUse Claude defaults.\n",
      ),
    );
    expect(readGitIndexFlag(repoRoot, "CLAUDE.md")).toBe("S");

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const shadowedFile =
      registry.worktrees[detectGitContext({ cwd: repoRoot })!.worktreeId]!
        .shadowed_files["CLAUDE.md"]!;
    expect(shadowedFile.skip_worktree).toBe(true);
    expect(shadowedFile.base_blob).toBe(
      runGit(repoRoot, ["rev-parse", "HEAD:CLAUDE.md"]),
    );
    expect(shadowedFile.overlay.trimEnd()).toBe(
      "# Claude standards\nUse Claude defaults.",
    );
  });

  it("refreshes a tracked shadow from stored overlay state after the cache is removed", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# tracked agents\n");
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "track AGENTS"]);
    writeRootInstructionBundleFixture(homeDir, {
      bundle: "repo-standards",
      content: "# Repo standards\nUse consistent conventions.\n",
    });
    await run(["add", "repo-standards", "--agent", "codex"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When
    await expect(
      run(["shadow", "--suspend"], { homeDir, cwd: repoRoot }),
    ).resolves.toBe("Suspended tracked shadows for AGENTS.md");
    fs.rmSync(path.join(homeDir, ".skul", "library"), {
      recursive: true,
      force: true,
    });
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# tracked agents v2\n");
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "refresh agents base without cache"]);
    await expect(
      run(["shadow", "--refresh"], { homeDir, cwd: repoRoot }),
    ).resolves.toBe("Refreshed tracked shadows for AGENTS.md");

    // Then
    assertAgentsDocument(
      repoRoot,
      "# tracked agents v2\n",
      formatTrackedRootInstructionShadowBlock(
        "repo-standards",
        "# Repo standards\nUse consistent conventions.\n",
      ),
    );
  });

  it("wraps git pull --ff-only with tracked AGENTS.md and CLAUDE.md shadow suspend and refresh", async () => {
    // Given
    const homeDir = createHomeDir();
    const { repoRoot, upstreamRepoPath } = createSyncRepository({
      "AGENTS.md": "# tracked agents\n",
      "CLAUDE.md": "# tracked claude\n",
    });
    writeRootInstructionBundleFixture(homeDir, {
      bundle: "repo-standards",
      content: "# Repo standards\nUse consistent conventions.\n",
    });
    writeRootInstructionBundleFixture(homeDir, {
      bundle: "claude-standards",
      agent: "claude-code",
      content: "# Claude standards\nUse Claude defaults.\n",
    });
    await run(["add", "repo-standards", "--agent", "codex"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    await run(["add", "claude-standards", "--agent", "claude-code"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    const initialHead = runGit(repoRoot, ["rev-parse", "HEAD"]);
    const updatedHead = pushSyncRepositoryUpdate(
      upstreamRepoPath,
      {
        "AGENTS.md": "# tracked agents v2\n",
        "CLAUDE.md": "# tracked claude v2\n",
      },
      "refresh tracked roots",
    );

    // When
    await expect(run(["sync"], { homeDir, cwd: repoRoot })).resolves.toBe(
      `Synced git worktree ${initialHead.slice(0, 7)} -> ${updatedHead.slice(0, 7)}; refreshed tracked shadows for AGENTS.md, CLAUDE.md`,
    );

    // Then
    assertAgentsDocument(
      repoRoot,
      "# tracked agents v2\n",
      formatTrackedRootInstructionShadowBlock(
        "repo-standards",
        "# Repo standards\nUse consistent conventions.\n",
      ),
    );
    assertClaudeDocument(
      repoRoot,
      "# tracked claude v2\n",
      formatTrackedRootInstructionShadowBlock(
        "claude-standards",
        "# Claude standards\nUse Claude defaults.\n",
      ),
    );
    expect(readGitIndexFlag(repoRoot, "AGENTS.md")).toBe("S");
    expect(readGitIndexFlag(repoRoot, "CLAUDE.md")).toBe("S");

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const worktreeState =
      registry.worktrees[detectGitContext({ cwd: repoRoot })!.worktreeId]!;

    expect(worktreeState.shadowed_files["AGENTS.md"]).toMatchObject({
      base_blob: runGit(repoRoot, ["rev-parse", "HEAD:AGENTS.md"]),
      overlay: "# Repo standards\nUse consistent conventions.",
      skip_worktree: true,
    });
    expect(worktreeState.shadowed_files["CLAUDE.md"]).toMatchObject({
      base_blob: runGit(repoRoot, ["rev-parse", "HEAD:CLAUDE.md"]),
      overlay: "# Claude standards\nUse Claude defaults.",
      skip_worktree: true,
    });
  });

  it("restores tracked shadows after a git sync failure", async () => {
    // Given
    const homeDir = createHomeDir();
    const { repoRoot, upstreamRepoPath } = createSyncRepository({
      "AGENTS.md": "# tracked agents\n",
    });
    writeRootInstructionBundleFixture(homeDir, {
      bundle: "repo-standards",
      content: "# Repo standards\nUse consistent conventions.\n",
    });
    await run(["add", "repo-standards", "--agent", "codex"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    pushSyncRepositoryUpdate(
      upstreamRepoPath,
      {
        "AGENTS.md": "# tracked agents v2\n",
      },
      "remote tracked root update",
    );
    fs.writeFileSync(path.join(repoRoot, "README.md"), "# local divergence\n");
    runGit(repoRoot, ["add", "README.md"]);
    runGit(repoRoot, ["commit", "-m", "local divergence"]);
    const localHead = runGit(repoRoot, ["rev-parse", "HEAD"]);

    // When / Then
    await expect(
      run(["sync"], { homeDir, cwd: repoRoot }),
    ).rejects.toThrowError(
      /Failed to sync the current branch with git pull --ff-only: .*fatal: Not possible to fast-forward, aborting\./is,
    );
    expect(runGit(repoRoot, ["rev-parse", "HEAD"])).toBe(localHead);
    assertAgentsDocument(
      repoRoot,
      "# tracked agents\n",
      formatTrackedRootInstructionShadowBlock(
        "repo-standards",
        "# Repo standards\nUse consistent conventions.\n",
      ),
    );
    expect(readGitIndexFlag(repoRoot, "AGENTS.md")).toBe("S");

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const shadowedFile =
      registry.worktrees[detectGitContext({ cwd: repoRoot })!.worktreeId]!
        .shadowed_files["AGENTS.md"]!;
    expect(shadowedFile.skip_worktree).toBe(true);
    expect(shadowedFile.base_blob).toBe(
      runGit(repoRoot, ["rev-parse", "HEAD:AGENTS.md"]),
    );
    expect(shadowedFile.overlay).toBe(
      "# Repo standards\nUse consistent conventions.",
    );
  });

  it("retires a tracked shadow when upstream stops tracking the root instruction during sync", async () => {
    // Given
    const homeDir = createHomeDir();
    const { repoRoot, upstreamRepoPath } = createSyncRepository({
      "AGENTS.md": "# tracked agents\n",
    });
    writeRootInstructionBundleFixture(homeDir, {
      bundle: "repo-standards",
      content: "# Repo standards\nUse consistent conventions.\n",
    });
    await run(["add", "repo-standards", "--agent", "codex"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    const initialHead = runGit(repoRoot, ["rev-parse", "HEAD"]);
    fs.rmSync(path.join(upstreamRepoPath, "AGENTS.md"));
    runGit(upstreamRepoPath, ["add", "AGENTS.md"]);
    runGit(upstreamRepoPath, ["commit", "-m", "remove tracked AGENTS"]);
    runGit(upstreamRepoPath, ["push", "origin", "main"]);
    const updatedHead = runGit(upstreamRepoPath, ["rev-parse", "HEAD"]);

    // When
    await expect(run(["sync"], { homeDir, cwd: repoRoot })).resolves.toBe(
      `Synced git worktree ${initialHead.slice(0, 7)} -> ${updatedHead.slice(0, 7)}; retired tracked shadows for AGENTS.md because upstream no longer tracks them`,
    );

    // Then
    expect(pathExists(path.join(repoRoot, "AGENTS.md"))).toBe(false);
    expect(readGitIndexFlag(repoRoot, "AGENTS.md")).toBe("");

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const worktreeState =
      registry.worktrees[detectGitContext({ cwd: repoRoot })!.worktreeId]!;
    expect(worktreeState.shadowed_files["AGENTS.md"]).toBeUndefined();
  });

  it("restores tracked root-instruction shadows when removing the owning bundle", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    fs.writeFileSync(
      path.join(repoRoot, "AGENTS.md"),
      "# Team base\nFollow repository policy.\n",
    );
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "track AGENTS"]);
    writeRootInstructionBundleFixture(homeDir, {
      bundle: "personal-rules",
      content: "# Personal rules\nPrefer terse answers.\n",
    });
    await run(["add", "personal-rules"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    const agentsBefore = fs.readFileSync(
      path.join(repoRoot, "AGENTS.md"),
      "utf8",
    );

    // When
    await expect(
      run(["remove", "personal-rules"], { homeDir, cwd: repoRoot }),
    ).resolves.toBe("Removed personal-rules");

    // Then
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      "# Team base\nFollow repository policy.\n",
    );
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).not.toBe(
      agentsBefore,
    );
    expect(readGitIndexFlag(repoRoot, "AGENTS.md")).toBe("H");
  });

  it("removes the Skul exclude block when removing the last non-shadow bundle", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    fs.writeFileSync(path.join(repoRoot, "CLAUDE.md"), "# Team base\n");
    runGit(repoRoot, ["add", "CLAUDE.md"]);
    runGit(repoRoot, ["commit", "-m", "track CLAUDE"]);
    writeRootInstructionBundleFixture(homeDir, {
      bundle: "repo-guide",
      agent: "claude-code",
      content: "# Repo guide\nUse @imports sparingly.\n",
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
    await run(["add", "repo-guide", "--agent", "claude-code"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    await run(["add", "react-expert"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When
    await expect(
      run(["remove", "react-expert"], { homeDir, cwd: repoRoot }),
    ).resolves.toBe("Removed react-expert");

    // Then
    expect(
      fs.readFileSync(path.join(repoRoot, ".git", "info", "exclude"), "utf8"),
    ).not.toContain("# >>> SKUL START");
    expect(readGitIndexFlag(repoRoot, "CLAUDE.md")).toBe("S");
  });

  it("preserves existing tracked CLAUDE.md shadow content when a second shared tool is added", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    fs.writeFileSync(
      path.join(repoRoot, "CLAUDE.md"),
      "# Team base\nUse shared prompts.\n",
    );
    runGit(repoRoot, ["add", "CLAUDE.md"]);
    runGit(repoRoot, ["commit", "-m", "track CLAUDE"]);
    writeRootInstructionBundleFixture(homeDir, {
      bundle: "shared-guide",
      agent: "claude-code",
      content: "# Claude guide\nUse @imports sparingly.\n",
      extraTools: {
        cursor: { root_instruction: { path: "cursor-rules.md" } },
      },
      extraFiles: {
        "cursor-rules.md": "# Cursor guide\nUse inline diffs.\n",
      },
    });
    await run(["add", "shared-guide", "--agent", "claude-code"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When
    await expect(
      run(["add", "shared-guide", "--agent", "cursor"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe("Applied shared-guide for cursor");

    // Then: cursor targets AGENTS.md (not CLAUDE.md), so CLAUDE.md shadow is unchanged (claude-code only)
    assertClaudeDocument(
      repoRoot,
      "# Team base\nUse shared prompts.\n",
      formatTrackedRootInstructionShadowBlock(
        "shared-guide",
        "# Claude guide\nUse @imports sparingly.\n",
      ),
    );
    // cursor targets AGENTS.md, so that file is written separately
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      formatExpectedRootInstructionDocument(
        formatRootInstructionBundleBlock(
          "shared-guide",
          "# Cursor guide\nUse inline diffs.\n",
          "github.com/user/ai-vault",
        ),
      ),
    );

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const worktreeState =
      registry.worktrees[detectGitContext({ cwd: repoRoot })!.worktreeId]!;

    expect(
      Object.keys(
        worktreeState.materialized_state.bundles["shared-guide"]!.tools,
      ).sort(),
    ).toEqual(["claude-code", "cursor"]);
  });
});
