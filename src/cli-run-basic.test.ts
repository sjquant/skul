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
  it("renders usage for bare invocations", async () => {
    // Given
    const argv: string[] = [];

    // When
    const output = await run(argv);

    // Then
    expect(output).toContain("Usage: skul [options] [command]");
    expect(output).toContain("Commands:");
    expect(output).toContain("Root instructions:");
    expect(output).toContain("Safety and recovery:");
  });

  it("routes command help through run", async () => {
    // Given
    const argv = ["shadow", "--help"];

    // When
    const output = await run(argv);

    // Then
    expect(output).toBe(createHelpText("shadow"));
    expect(output).toContain("Usage: skul shadow [options]");
    expect(output).toContain("Lifecycle:");
    expect(output).toContain("skul shadow --refresh");
  });

  it("prints the package version", async () => {
    // Given
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { version: string };

    // When / Then
    await expect(run(["--version"])).resolves.toBe(packageJson.version);
    await expect(run(["-v"])).resolves.toBe(packageJson.version);
  });

  it("lists cached bundles from the global library", async () => {
    // Given
    const homeDir = createHomeDir();

    writeManifest(homeDir, "github.com/user/ai-vault", "repo-standards", {
      name: "repo-standards",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });

    // When / Then
    await expect(run(["list"], { homeDir })).resolves.toBe(
      renderBundleListOutput(
        "react-expert [github.com/user/ai-vault] (claude-code)",
        "repo-standards [github.com/user/ai-vault] (codex)",
      ),
    );
  });

  it("reports when no cached bundles are available", async () => {
    // Given
    const homeDir = createHomeDir();

    // When / Then
    await expect(run(["list"], { homeDir })).resolves.toBe(
      renderBundleListOutput(
        "No cached bundles found.",
        "",
        "Add one with: skul add github.com/<owner>/<repo> <bundle-name>",
      ),
    );
  });

  it("returns JSON bundle list when --json is passed", async () => {
    // Given
    const homeDir = createHomeDir();

    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });

    // When
    const output = await run(["list", "--json"], { homeDir });

    // Then
    expect(JSON.parse(output)).toEqual({
      bundles: [
        {
          name: "react-expert",
          source: "github.com/user/ai-vault",
          tools: ["claude-code"],
        },
      ],
    });
  });

  it("filters bundle list output by source", async () => {
    // Given
    const homeDir = createHomeDir();

    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeManifest(homeDir, "github.com/other/ai-vault", "next-expert", {
      name: "next-expert",
      tools: { cursor: { skills: { path: ".cursor/skills" } } },
    });

    // When / Then
    await expect(
      run(["list", "--source", "github.com/user/ai-vault"], { homeDir }),
    ).resolves.toBe(
      renderBundleListOutput(
        "react-expert [github.com/user/ai-vault] (claude-code)",
      ),
    );
  });

  it("reports when list source filtering finds no cached bundles", async () => {
    // Given
    const homeDir = createHomeDir();

    // When / Then
    await expect(
      run(["list", "--source", "github.com/user/ai-vault"], { homeDir }),
    ).resolves.toBe(
      renderBundleListOutput(
        "No cached bundles found for github.com/user/ai-vault.",
        "",
        "Cache one with: skul add github.com/user/ai-vault <bundle-name>",
      ),
    );
  });

  it("returns JSON status when --json is passed", async () => {
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
    const output = await run(["status", "--json"], { homeDir, cwd: repoRoot });
    const parsed = JSON.parse(output);

    // Then
    expect(parsed.repo.desired_state).toEqual([
      {
        bundle: "react-expert",
        source: "github.com/user/ai-vault",
        protocol: "https",
      },
    ]);
    expect(parsed.worktree.materialized).toBe(true);
    expect(parsed.worktree.git_exclude_configured).toBe(true);
    expect(
      parsed.worktree.bundles["react-expert"].tools["claude-code"].files,
    ).toContain(".claude/skills/react/SKILL.md");
  });

  it("returns computed shadow status fields in JSON for tracked AGENTS.md and CLAUDE.md", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const registryFile = path.join(homeDir, ".skul", "registry.json");
    const gitContext = detectGitContext({ cwd: repoRoot })!;

    const agentsBaseContent = "# agents base\n";
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), agentsBaseContent);
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "track agents"]);

    const claudeBaseContent = "# claude base\n";
    fs.writeFileSync(path.join(repoRoot, "CLAUDE.md"), claudeBaseContent);
    runGit(repoRoot, ["add", "CLAUDE.md"]);
    runGit(repoRoot, ["commit", "-m", "track claude"]);

    const agentsBaseBlob = runGit(repoRoot, ["rev-parse", "HEAD:AGENTS.md"]);
    const claudeBaseBlob = runGit(repoRoot, ["rev-parse", "HEAD:CLAUDE.md"]);
    const agentsShadow = renderTrackedRootInstructionShadow({
      baseContent: agentsBaseContent,
      overlayContent: "Follow the agents guidance.",
      bundleName: "agents-rules",
      toolName: "codex",
      strategy: "append",
    });
    const claudeShadow = renderTrackedRootInstructionShadow({
      baseContent: claudeBaseContent,
      overlayContent: "Follow the claude guidance.",
      bundleName: "claude-rules",
      toolName: "claude-code",
      strategy: "prepend",
    });

    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), agentsShadow.rendered);
    runGit(repoRoot, ["update-index", "--skip-worktree", "--", "AGENTS.md"]);

    fs.writeFileSync(
      path.join(repoRoot, "CLAUDE.md"),
      "# manually edited claude\n",
    );

    writeRegistryFile(
      registryFile,
      upsertWorktreeState(
        upsertRepoState(createEmptyRegistry(), gitContext.repoFingerprint, {
          repo_root: fs.realpathSync.native(repoRoot),
          desired_state: [],
        }),
        gitContext.worktreeId,
        {
          repo_fingerprint: gitContext.repoFingerprint,
          path: fs.realpathSync.native(repoRoot),
          materialized_state: {
            bundles: {},
            exclude_configured: false,
          },
          shadowed_files: {
            "AGENTS.md": {
              tool: "codex",
              bundle: "agents-rules",
              strategy: "append",
              base_blob: agentsBaseBlob,
              overlay: "Follow the agents guidance.",
              overlay_fingerprint: agentsShadow.overlayFingerprint,
              rendered_fingerprint: agentsShadow.renderedFingerprint,
              skip_worktree: true,
            },
            "CLAUDE.md": {
              tool: "claude-code",
              bundle: "claude-rules",
              strategy: "prepend",
              base_blob: agentsBaseBlob,
              overlay: "Follow the claude guidance.",
              overlay_fingerprint: claudeShadow.overlayFingerprint,
              rendered_fingerprint: claudeShadow.renderedFingerprint,
              skip_worktree: true,
            },
          },
        },
      ),
    );

    // When
    const output = await run(["status", "--json"], { homeDir, cwd: repoRoot });
    const parsed = JSON.parse(output);

    // Then
    expect(parsed.worktree.shadowed_files["AGENTS.md"]).toEqual({
      tool: "codex",
      bundle: "agents-rules",
      strategy: "append",
      base_blob: agentsBaseBlob,
      overlay_fingerprint: agentsShadow.overlayFingerprint,
      rendered_fingerprint: agentsShadow.renderedFingerprint,
      skip_worktree: true,
      active: true,
      base_fresh: true,
      overlay_fresh: true,
      skip_worktree_active: true,
      manual_edit_suspected: false,
    });
    expect(parsed.worktree.shadowed_files["CLAUDE.md"]).toEqual({
      tool: "claude-code",
      bundle: "claude-rules",
      strategy: "prepend",
      base_blob: agentsBaseBlob,
      overlay_fingerprint: claudeShadow.overlayFingerprint,
      rendered_fingerprint: claudeShadow.renderedFingerprint,
      skip_worktree: true,
      active: false,
      base_fresh: false,
      overlay_fresh: false,
      skip_worktree_active: false,
      manual_edit_suspected: true,
    });
    expect(claudeBaseBlob).not.toBe(agentsBaseBlob);
  });

  it("returns JSON status with suggested_action when bundles are not yet materialized", async () => {
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

    // Create a new linked worktree that has not materialized yet
    const linkedWorktree = createLinkedWorktree(repoRoot);

    // When
    const output = await run(["status", "--json"], {
      homeDir,
      cwd: linkedWorktree,
    });
    const parsed = JSON.parse(output);

    // Then
    expect(parsed.worktree.materialized).toBe(false);
    expect(parsed.suggested_action).toBe("skul apply");
  });

  it("reports upstream updates for a remote-backed bundle", async () => {
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
        ".claude/skills/react/SKILL.md": "# react v2\n",
      },
    );

    // When / Then
    await expect(run(["check"], { homeDir, cwd: repoRoot })).resolves.toBe(
      `react-expert: update-available ${remoteSource.initialCommit.slice(0, 7)} -> ${updatedCommit.slice(0, 7)}\n\nRun "skul update" to apply available updates`,
    );
  });

  it("reports a specific message when all bundles are local-only during update", async () => {
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
        desired_state: [{ bundle: "local-bundle", protocol: "https" }],
      },
    );
    writeRegistryFile(registryFile, registry);

    // When / Then
    await expect(run(["update"], { homeDir, cwd: repoRoot })).resolves.toBe(
      "No remote-backed bundles to update (local-bundle is local-only)",
    );
  });

  it("updates a remote-backed bundle and refreshes the current worktree", async () => {
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
        ".claude/skills/react/SKILL.md": "# react v2\n",
      },
    );

    // When
    await expect(run(["update"], { homeDir, cwd: repoRoot })).resolves.toBe(
      `Updated react-expert ${remoteSource.initialCommit.slice(0, 7)} -> ${updatedCommit.slice(0, 7)}`,
    );

    // Then
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react v2\n");

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const repoEntry =
      registry.repos[detectGitContext({ cwd: repoRoot })!.repoFingerprint]!;
    const worktreeEntry =
      registry.worktrees[detectGitContext({ cwd: repoRoot })!.worktreeId]!;

    expect(repoEntry.desired_state[0]).toMatchObject({
      bundle: "react-expert",
      resolved_ref: "main",
      resolved_commit: updatedCommit,
    });
    expect(
      worktreeEntry.materialized_state.bundles["react-expert"],
    ).toMatchObject({
      resolved_commit: updatedCommit,
    });
  });

  it("preserves manifest root instruction mode during update", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const remoteSource = createRemoteBundleSource(homeDir, {
      bundle: "repo-standards",
      manifest: {
        root_instruction_mode: "replace",
        tools: { codex: { root_instruction: { path: "AGENTS.md" } } },
      },
      files: { "AGENTS.md": "# standards v1\n" },
    });
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# local rules\n");
    await run(["add", remoteSource.source, remoteSource.bundle], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    updateRemoteBundleSource(remoteSource.remoteRepoPath, remoteSource.bundle, {
      "AGENTS.md": "# standards v2\n",
    });

    // When
    await run(["update"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // Then
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toContain(
      "# standards v2",
    );
    expect(
      fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8"),
    ).not.toContain("# local rules");
  });

  it("updates over a modified managed file without prompting when update uses yes", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const confirmManagedFileRemoval = vi.fn(async () => {
      throw new Error("confirmManagedFileRemoval should not be called");
    });
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
    fs.writeFileSync(
      path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
      "# modified\n",
    );
    const updatedCommit = updateRemoteBundleSource(
      remoteSource.remoteRepoPath,
      remoteSource.bundle,
      {
        ".claude/skills/react/SKILL.md": "# react v2\n",
      },
    );

    // When
    await expect(
      run(["update", "-y"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ confirmManagedFileRemoval }),
      }),
    ).resolves.toBe(
      `Updated react-expert ${remoteSource.initialCommit.slice(0, 7)} -> ${updatedCommit.slice(0, 7)}`,
    );

    // Then
    expect(confirmManagedFileRemoval).not.toHaveBeenCalled();
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react v2\n");
  });

  it("normalizes SSH authentication failures raised while resolving a requested remote ref during check", async () => {
    // Given
    const fixture = await prepareRemoteRefFailureFixture();

    // When / Then
    try {
      await expect(
        run(["check"], { homeDir: fixture.homeDir, cwd: fixture.repoRoot }),
      ).rejects.toThrowError(
        /Hint: SSH authentication failed[\s\S]*skul add github\.com\/user\/ai-vault/,
      );
    } finally {
      fixture.restoreGitSsh();
    }
  });

  it("normalizes SSH authentication failures raised while resolving a requested remote ref during update", async () => {
    // Given
    const fixture = await prepareRemoteRefFailureFixture();

    // When / Then
    try {
      await expect(
        run(["update"], { homeDir: fixture.homeDir, cwd: fixture.repoRoot }),
      ).rejects.toThrowError(
        /Hint: SSH authentication failed[\s\S]*skul add github\.com\/user\/ai-vault/,
      );
    } finally {
      fixture.restoreGitSsh();
    }
  });

  async function prepareRemoteRefFailureFixture(): Promise<{
    homeDir: string;
    repoRoot: string;
    restoreGitSsh: () => void;
  }> {
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
    runGit(remoteSource.remoteRepoPath, ["branch", "stable"]);
    await run(
      [
        "add",
        remoteSource.source,
        remoteSource.bundle,
        "--ssh",
        "--ref",
        "stable",
      ],
      { homeDir, cwd: repoRoot, prompts: createPromptClientStub() },
    );

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
      "git@github.com:user/react-bundle.git",
    ]);

    const fakeSshPath = path.join(homeDir, "fake-ssh.sh");
    fs.writeFileSync(
      fakeSshPath,
      "#!/bin/sh\necho 'git@github.com: Permission denied (publickey).' 1>&2\nexit 255\n",
    );
    fs.chmodSync(fakeSshPath, 0o755);
    const previousGitSsh = process.env["GIT_SSH"];
    process.env["GIT_SSH"] = fakeSshPath;

    // Then
    return {
      homeDir,
      repoRoot,
      restoreGitSsh() {
        if (previousGitSsh === undefined) {
          delete process.env["GIT_SSH"];
          return;
        }

        process.env["GIT_SSH"] = previousGitSsh;
      },
    };
  }

  it("aborts update without leaking a newer cached revision into apply", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const linkedWorktree = createLinkedWorktree(repoRoot);
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
    fs.writeFileSync(
      path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
      "# modified locally\n",
    );
    const updatedCommit = updateRemoteBundleSource(
      remoteSource.remoteRepoPath,
      remoteSource.bundle,
      {
        ".claude/skills/react/SKILL.md": "# react v2\n",
      },
    );

    // When / Then
    await expect(
      run(["update"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          confirmManagedFileRemoval: async () => false,
        }),
      }),
    ).rejects.toThrowError(
      /Replacement aborted because a modified managed file was kept/,
    );

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const repoEntry =
      registry.repos[detectGitContext({ cwd: repoRoot })!.repoFingerprint]!;

    expect(repoEntry.desired_state[0]).toMatchObject({
      bundle: "react-expert",
      resolved_commit: remoteSource.initialCommit,
    });

    await expect(
      run(["apply"], { homeDir, cwd: linkedWorktree }),
    ).resolves.toBe("Applied react-expert");
    expect(
      fs.readFileSync(
        path.join(linkedWorktree, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
    expect(updatedCommit).not.toBe(remoteSource.initialCommit);
  });

  it("refreshes a stale linked worktree when apply runs after update", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const linkedWorktree = createLinkedWorktree(repoRoot);
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
    await run(["apply"], { homeDir, cwd: linkedWorktree });
    const updatedCommit = updateRemoteBundleSource(
      remoteSource.remoteRepoPath,
      remoteSource.bundle,
      {
        ".claude/skills/react/SKILL.md": "# react v2\n",
      },
    );
    await run(["update"], { homeDir, cwd: repoRoot });

    // When
    await expect(
      run(["apply"], { homeDir, cwd: linkedWorktree }),
    ).resolves.toBe("Applied react-expert");

    // Then
    expect(
      fs.readFileSync(
        path.join(linkedWorktree, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react v2\n");

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const linkedEntry =
      registry.worktrees[
        detectGitContext({ cwd: linkedWorktree })!.worktreeId
      ]!;

    expect(
      linkedEntry.materialized_state.bundles["react-expert"],
    ).toMatchObject({
      resolved_commit: updatedCommit,
    });
  });

  it("keeps desired tool selection narrowed during update", async () => {
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
    await run(["add", remoteSource.source, remoteSource.bundle], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    await run(["add", "react-expert", "--agent", "claude-code"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    const updatedCommit = updateRemoteBundleSource(
      remoteSource.remoteRepoPath,
      remoteSource.bundle,
      {
        ".claude/skills/react/SKILL.md": "# react v2\n",
        ".cursor/skills/react/SKILL.md": "# react v2\n",
      },
    );

    // When
    await expect(run(["update"], { homeDir, cwd: repoRoot })).resolves.toBe(
      `Updated react-expert ${remoteSource.initialCommit.slice(0, 7)} -> ${updatedCommit.slice(0, 7)}`,
    );

    // Then
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const repoEntry =
      registry.repos[detectGitContext({ cwd: repoRoot })!.repoFingerprint]!;

    expect(repoEntry.desired_state).toEqual([
      {
        bundle: "react-expert",
        source: remoteSource.source,
        tools: ["claude-code"],
        protocol: "https",
        resolved_ref: "main",
        resolved_commit: updatedCommit,
      },
    ]);
  });

  it("removes stale tools from a linked worktree when apply refreshes a narrowed bundle", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const linkedWorktree = createLinkedWorktree(repoRoot);
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
    await run(["add", remoteSource.source, remoteSource.bundle], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    await run(["apply"], { homeDir, cwd: linkedWorktree });
    await run(["add", "react-expert", "--agent", "claude-code"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    const updatedCommit = updateRemoteBundleSource(
      remoteSource.remoteRepoPath,
      remoteSource.bundle,
      {
        ".claude/skills/react/SKILL.md": "# react v2\n",
        ".cursor/skills/react/SKILL.md": "# react v2\n",
      },
    );
    await run(["update"], { homeDir, cwd: repoRoot });

    // When
    await expect(
      run(["apply"], { homeDir, cwd: linkedWorktree }),
    ).resolves.toBe("Applied react-expert");

    // Then
    expect(
      fs.readFileSync(
        path.join(linkedWorktree, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react v2\n");
    expect(
      pathExists(
        path.join(linkedWorktree, ".cursor", "skills", "react", "SKILL.md"),
      ),
    ).toBe(false);

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const linkedEntry =
      registry.worktrees[
        detectGitContext({ cwd: linkedWorktree })!.worktreeId
      ]!;

    expect(
      linkedEntry.materialized_state.bundles["react-expert"],
    ).toMatchObject({
      resolved_commit: updatedCommit,
      tools: {
        "claude-code": {
          files: expect.arrayContaining([".claude/skills/react/SKILL.md"]),
        },
      },
    });
    expect(
      linkedEntry.materialized_state.bundles["react-expert"].tools,
    ).not.toHaveProperty("cursor");
  });
});
