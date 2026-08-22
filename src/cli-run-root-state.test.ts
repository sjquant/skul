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
  it("overwrites the existing file when the user confirms the conflict prompt", async () => {
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
    fs.mkdirSync(path.join(repoRoot, ".claude", "skills", "react"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
      "user file\n",
    );

    // When
    await expect(
      run(["add", "react-expert"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          resolveFileConflict: async () => ({ action: "overwrite" }),
        }),
      }),
    ).resolves.toBe("Applied react-expert for claude-code");

    // Then — bundle content overwrites the user's file
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
  });

  it("fails when the user declines to overwrite a conflicting file", async () => {
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
    fs.mkdirSync(path.join(repoRoot, ".claude", "skills", "react"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
      "user file\n",
    );

    // When / Then — declining the overwrite propagates as an error
    await expect(
      run(["add", "react-expert"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          resolveFileConflict: async () => {
            throw new Error(
              "Conflict not resolved: react/SKILL.md already exists",
            );
          },
        }),
      }),
    ).rejects.toThrowError(/conflict not resolved/i);

    // Then — user's file is untouched
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("user file\n");
  });

  it("renders repository desired state, worktree files, and exclude status", async () => {
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

    // When / Then
    await expect(run(["status"], { homeDir, cwd: repoRoot })).resolves.toBe(
      [
        "Repository Desired State",
        "Bundle: react-expert",
        "",
        "Current Worktree",
        `Path: ${fs.realpathSync.native(repoRoot)}`,
        "Materialized: yes",
        "",
        "Files:",
        "  Bundle: react-expert",
        "    Tool: claude-code",
        "      .claude/commands/review.md",
        "      .claude/skills/react/SKILL.md",
        "",
        "Git Exclude:",
        "  configured",
      ].join("\n"),
    );
  });

  it("reports repository intent when the current worktree has not materialized yet", async () => {
    // Given
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

    // When / Then
    await expect(run(["status"], { homeDir, cwd: repoRoot })).resolves.toBe(
      [
        "Repository Desired State",
        "Bundle: react-expert",
        "",
        "Current Worktree",
        `Path: ${fs.realpathSync.native(repoRoot)}`,
        "Materialized: no",
        'Suggested Action: run "skul apply"',
      ].join("\n"),
    );
  });

  it("reports repository intent when a worktree only has shadowed file metadata", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const registryFile = path.join(homeDir, ".skul", "registry.json");
    const gitContext = detectGitContext({ cwd: repoRoot })!;
    const registry = upsertWorktreeState(
      upsertRepoState(createEmptyRegistry(), gitContext.repoFingerprint, {
        repo_root: fs.realpathSync.native(repoRoot),
        desired_state: [{ bundle: "react-expert", protocol: "https" }],
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
            bundle: "personal-rules",
            strategy: "append",
            base_blob: "2813b888fb134532be3749c71a38ee111b788e5b",
            overlay: "# Personal rules\n",
            overlay_fingerprint: "overlay-abc123",
            rendered_fingerprint: "rendered-def456",
            skip_worktree: true,
          },
        },
      },
    );
    writeRegistryFile(registryFile, registry);

    // When / Then
    await expect(run(["status"], { homeDir, cwd: repoRoot })).resolves.toBe(
      [
        "Repository Desired State",
        "Bundle: react-expert",
        "",
        "Current Worktree",
        `Path: ${fs.realpathSync.native(repoRoot)}`,
        "Materialized: no",
        "",
        "Shadowed Instructions",
        "  AGENTS.md",
        "    Bundle: personal-rules",
        "    Tool: codex",
        "    Strategy: append",
        "    Active: no",
        "    Base: stale",
        "    Overlay: stale",
        "    Skip-worktree: missing",
        "    Manual edits: suspected",
        'Suggested Action: run "skul apply"',
      ].join("\n"),
    );
  });

  it("renders a shadowed instructions section for tracked AGENTS.md and CLAUDE.md", async () => {
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
          desired_state: [{ bundle: "react-expert", protocol: "https" }],
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

    // When / Then
    await expect(run(["status"], { homeDir, cwd: repoRoot })).resolves.toBe(
      [
        "Repository Desired State",
        "Bundle: react-expert",
        "",
        "Current Worktree",
        `Path: ${fs.realpathSync.native(repoRoot)}`,
        "Materialized: no",
        "",
        "Shadowed Instructions",
        "  AGENTS.md",
        "    Bundle: agents-rules",
        "    Tool: codex",
        "    Strategy: append",
        "    Active: yes",
        "    Base: current",
        "    Overlay: current",
        "    Skip-worktree: set",
        "    Manual edits: no",
        "  CLAUDE.md",
        "    Bundle: claude-rules",
        "    Tool: claude-code",
        "    Strategy: prepend",
        "    Active: no",
        "    Base: stale",
        "    Overlay: stale",
        "    Skip-worktree: missing",
        "    Manual edits: suspected",
        'Suggested Action: run "skul apply"',
      ].join("\n"),
    );
  });

  it("shows repository intent from the main worktree inside a linked worktree", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const linkedWorktreeRoot = createLinkedWorktree(repoRoot);
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

    // When / Then
    await expect(
      run(["status"], { homeDir, cwd: linkedWorktreeRoot }),
    ).resolves.toBe(
      [
        "Repository Desired State",
        "Bundle: react-expert",
        "",
        "Current Worktree",
        `Path: ${fs.realpathSync.native(linkedWorktreeRoot)}`,
        "Materialized: no",
        'Suggested Action: run "skul apply"',
      ].join("\n"),
    );
  });

  it("reports missing when the Skul exclude block was removed manually", async () => {
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
      path.join(repoRoot, ".git", "info", "exclude"),
      "node_modules\n",
    );

    // When / Then
    await expect(run(["status"], { homeDir, cwd: repoRoot })).resolves.toBe(
      [
        "Repository Desired State",
        "Bundle: react-expert",
        "",
        "Current Worktree",
        `Path: ${fs.realpathSync.native(repoRoot)}`,
        "Materialized: yes",
        "",
        "Files:",
        "  Bundle: react-expert",
        "    Tool: claude-code",
        "      .claude/skills/react/SKILL.md",
        "",
        "Git Exclude:",
        "  missing",
      ].join("\n"),
    );
  });

  it("resets only registry-owned files from the current worktree", async () => {
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
    fs.writeFileSync(path.join(repoRoot, "notes.txt"), "keep me\n");

    // When
    await expect(run(["reset"], { homeDir, cwd: repoRoot })).resolves.toBe(
      "Reset Skul-managed files from the current worktree",
    );

    // Then
    expect(
      pathExists(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md")),
    ).toBe(false);
    expect(
      pathExists(path.join(repoRoot, ".claude", "commands", "review.md")),
    ).toBe(false);
    expect(fs.readFileSync(path.join(repoRoot, "notes.txt"), "utf8")).toBe(
      "keep me\n",
    );
    expect(
      fs.readFileSync(path.join(repoRoot, ".git", "info", "exclude"), "utf8"),
    ).not.toContain("# >>> SKUL START");

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    expect(registry.worktrees).toEqual({});
    expect(
      registry.repos[detectGitContext({ cwd: repoRoot })!.repoFingerprint]
        ?.desired_state,
    ).toEqual([
      {
        bundle: "react-expert",
        source: "github.com/user/ai-vault",
        protocol: "https",
      },
    ]);
  });

  it("prompts before resetting a modified managed file and aborts when the user declines", async () => {
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
      run(["reset"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          confirmManagedFileRemoval: async () => false,
        }),
      }),
    ).rejects.toThrowError(
      /Reset aborted because a modified managed file was kept/,
    );
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# modified\n");
  });

  it("resets a modified managed file without prompting when reset uses yes", async () => {
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
      run(["reset", "-y"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ confirmManagedFileRemoval }),
      }),
    ).resolves.toBe("Reset Skul-managed files from the current worktree");

    // Then
    expect(confirmManagedFileRemoval).not.toHaveBeenCalled();
    expect(
      pathExists(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md")),
    ).toBe(false);
  });

  it("prompts before replacing a modified managed file and aborts when the user declines", async () => {
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
    // Modify the managed file
    fs.writeFileSync(
      path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
      "# modified\n",
    );

    // When / Then: re-adding the same bundle should prompt and abort
    await expect(
      run(["add", "react-expert"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          confirmManagedFileRemoval: async () => false,
        }),
      }),
    ).rejects.toThrowError(
      /Replacement aborted because a modified managed file was kept/,
    );
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# modified\n");
  });

  it("aborts re-add when a managed file was modified and the user declines replacement", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: {
        "claude-code": { skills: { path: ".claude/skills" } },
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
    await run(["add", "react-expert", "--agent", "claude-code"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    fs.writeFileSync(
      path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
      "# modified\n",
    );

    // When / Then: re-adding the same bundle+tool should prompt and abort
    await expect(
      run(["add", "react-expert", "--agent", "claude-code"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          confirmManagedFileRemoval: async () => false,
        }),
      }),
    ).rejects.toThrowError(
      /Replacement aborted because a modified managed file was kept/,
    );
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# modified\n");
  });

  it("replaces a modified managed file without prompting when add uses yes", async () => {
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
      run(["add", "react-expert", "-y"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ confirmManagedFileRemoval }),
      }),
    ).resolves.toBe("Applied react-expert for claude-code");

    // Then
    expect(confirmManagedFileRemoval).not.toHaveBeenCalled();
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
  });

  it("reports when there is nothing to reset in the current worktree", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    // When / Then
    await expect(run(["reset"], { homeDir, cwd: repoRoot })).resolves.toBe(
      "No Skul-managed files found in the current worktree",
    );
  });

  it("restores tracked root-instruction shadows during reset", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# Team base\n");
    runGit(repoRoot, ["add", "AGENTS.md"]);
    runGit(repoRoot, ["commit", "-m", "track AGENTS"]);
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "# Shadowed content\n");
    runGit(repoRoot, ["update-index", "--skip-worktree", "--", "AGENTS.md"]);
    const renderedFingerprint = fingerprintFile(
      path.join(repoRoot, "AGENTS.md"),
    );
    const registryFile = path.join(homeDir, ".skul", "registry.json");
    const gitContext = detectGitContext({ cwd: repoRoot })!;
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
              bundle: "personal-rules",
              strategy: "append",
              base_blob: runGit(repoRoot, ["rev-parse", "HEAD:AGENTS.md"]),
              overlay: "# Shadowed content\n",
              overlay_fingerprint: renderedFingerprint,
              rendered_fingerprint: renderedFingerprint,
              skip_worktree: true,
            },
          },
        },
      ),
    );

    // When / Then
    await expect(run(["reset"], { homeDir, cwd: repoRoot })).resolves.toBe(
      "Reset Skul-managed files from the current worktree",
    );
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      "# Team base\n",
    );
    expect(readGitIndexFlag(repoRoot, "AGENTS.md")).toBe("H");
    await expect(
      run(["reset", "--dry-run"], { homeDir, cwd: repoRoot }),
    ).resolves.toBe(
      "DRY RUN: No Skul-managed files found in the current worktree",
    );
  });

  it("resets a linked worktree and clears tracked shadow state during cleanup", async () => {
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
    await run(["apply"], { homeDir, cwd: linkedWorktree });

    const registryFile = path.join(homeDir, ".skul", "registry.json");
    const linkedCtx = detectGitContext({ cwd: linkedWorktree })!;
    const registry = readRegistryFile(registryFile);
    const linkedEntry = registry.worktrees[linkedCtx.worktreeId]!;
    const linkedShadowState = {
      "AGENTS.md": {
        tool: "codex" as const,
        bundle: "personal-rules",
        strategy: "append" as const,
        base_blob: runGit(repoRoot, ["rev-parse", "HEAD:AGENTS.md"]),
        overlay: "# Shadowed content\n",
        overlay_fingerprint: "overlay-abc123",
        rendered_fingerprint: renderedFingerprint,
        skip_worktree: true,
      },
    };
    linkedShadowState["AGENTS.md"].overlay_fingerprint = renderedFingerprint;

    writeRegistryFile(
      registryFile,
      upsertWorktreeState(registry, linkedCtx.worktreeId, {
        ...linkedEntry,
        shadowed_files: linkedShadowState,
      }),
    );

    // When
    await expect(
      run(["reset"], { homeDir, cwd: linkedWorktree }),
    ).resolves.toBe("Reset Skul-managed files from the current worktree");

    // Then
    expect(
      fs.readFileSync(path.join(linkedWorktree, "AGENTS.md"), "utf8"),
    ).toBe("repo base instruction\n");
    expect(readGitIndexFlag(linkedWorktree, "AGENTS.md")).toBe("H");
    expect(
      pathExists(
        path.join(linkedWorktree, ".claude", "skills", "react", "SKILL.md"),
      ),
    ).toBe(false);
    const updatedRegistry = readRegistryFile(registryFile);
    expect(updatedRegistry.worktrees[linkedCtx.worktreeId]).toBeUndefined();
  });
});
