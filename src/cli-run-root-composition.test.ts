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
  it("appends root instructions when multiple bundles target the same root-instruction file", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    setupSharedRootInstructionBundles(homeDir, [
      {
        bundle: "repo-standards",
        content: "# Repo standards\nUse consistent conventions.\n",
      },
      {
        bundle: "security-standards",
        content: "# Security standards\nNever commit secrets.\n",
      },
    ]);

    await run(["add", "repo-standards"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When
    await expect(
      run(["add", "security-standards"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe(
      "Applied security-standards for codex, claude-code, cursor, opencode, copilot, kiro, antigravity",
    );

    // Then
    expectAgentsDocument(
      repoRoot,
      formatRootInstructionBundleBlock(
        "repo-standards",
        "# Repo standards\nUse consistent conventions.\n",
        "github.com/user/ai-vault",
      ),
      formatRootInstructionBundleBlock(
        "security-standards",
        "# Security standards\nNever commit secrets.\n",
        "github.com/user/ai-vault",
      ),
    );
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const worktree = registry.worktrees[Object.keys(registry.worktrees)[0]];
    const fingerprint =
      worktree.materialized_state.bundles["repo-standards"]!.tools["codex"]!
        .file_fingerprints!["AGENTS.md"];
    expect(fingerprint).toBe(fingerprintFile(path.join(repoRoot, "AGENTS.md")));
  });

  it("reuses the original source when shared root recomposition follows a bundle-only add", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    setupSharedRootInstructionBundles(homeDir, [
      {
        source: "github.com/user/source-a",
        bundle: "repo-standards",
        content: "# Source A rules\nUse source A.\n",
      },
      {
        source: "github.com/user/source-a",
        bundle: "security-standards",
        content: "# Security standards\nNever commit secrets.\n",
      },
    ]);

    await run(["add", "repo-standards"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    writeRootInstructionBundleFixture(homeDir, {
      source: "github.com/user/source-b",
      bundle: "repo-standards",
      content: "# Source B rules\nUse source B.\n",
    });

    // When
    await expect(
      run(["add", "security-standards"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe(
      "Applied security-standards for codex, claude-code, cursor, opencode, copilot, kiro, antigravity",
    );

    // Then
    expectAgentsDocument(
      repoRoot,
      formatRootInstructionBundleBlock(
        "repo-standards",
        "# Source A rules\nUse source A.\n",
        "github.com/user/source-a",
      ),
      formatRootInstructionBundleBlock(
        "security-standards",
        "# Security standards\nNever commit secrets.\n",
        "github.com/user/source-a",
      ),
    );
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const repoFingerprint = detectGitContext({
      cwd: repoRoot,
    })!.repoFingerprint;
    expect(registry.repos[repoFingerprint]!.desired_state).toEqual([
      {
        bundle: "repo-standards",
        source: "github.com/user/source-a",
        protocol: "https",
      },
      {
        bundle: "security-standards",
        source: "github.com/user/source-a",
        protocol: "https",
      },
    ]);
  });

  it("preserves remaining root-instruction content when one shared bundle is removed", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    setupSharedRootInstructionBundles(homeDir, [
      {
        bundle: "repo-standards",
        content: "# Repo standards\nUse consistent conventions.\n",
      },
      {
        bundle: "security-standards",
        content: "# Security standards\nNever commit secrets.\n",
      },
    ]);

    await run(["add", "repo-standards"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    await run(["add", "security-standards"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When
    await expect(
      run(["remove", "repo-standards"], { homeDir, cwd: repoRoot }),
    ).resolves.toBe("Removed repo-standards");

    // Then
    expectAgentsDocument(
      repoRoot,
      formatRootInstructionBundleBlock(
        "security-standards",
        "# Security standards\nNever commit secrets.\n",
        "github.com/user/ai-vault",
      ),
    );
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const worktree = registry.worktrees[Object.keys(registry.worktrees)[0]];
    const fingerprint =
      worktree.materialized_state.bundles["security-standards"]!.tools["codex"]!
        .file_fingerprints!["AGENTS.md"];
    expect(fingerprint).toBe(fingerprintFile(path.join(repoRoot, "AGENTS.md")));
  });

  it("preserves shared root-instruction order when an existing bundle is re-added", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    setupSharedRootInstructionBundles(homeDir, [
      {
        bundle: "repo-standards",
        content: "# Repo standards\nUse consistent conventions.\n",
      },
      {
        bundle: "security-standards",
        content: "# Security standards\nNever commit secrets.\n",
      },
    ]);

    await run(["add", "repo-standards"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    await run(["add", "security-standards"], {
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
    ).resolves.toBe(
      "Applied repo-standards for codex, claude-code, cursor, opencode, copilot, kiro, antigravity",
    );

    // Then
    expectAgentsDocument(
      repoRoot,
      formatRootInstructionBundleBlock(
        "repo-standards",
        "# Repo standards\nUse consistent conventions.\n",
        "github.com/user/ai-vault",
      ),
      formatRootInstructionBundleBlock(
        "security-standards",
        "# Security standards\nNever commit secrets.\n",
        "github.com/user/ai-vault",
      ),
    );
  });

  it("appends shared root instructions during apply", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    setupSharedRootInstructionBundles(homeDir, [
      {
        bundle: "repo-standards",
        content: "# Repo standards\nUse consistent conventions.\n",
      },
      {
        bundle: "security-standards",
        content: "# Security standards\nNever commit secrets.\n",
      },
    ]);

    await run(["add", "repo-standards"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    const registryPath = path.join(homeDir, ".skul", "registry.json");
    const registry = readRegistryFile(registryPath);
    const repoFingerprint = detectGitContext({
      cwd: repoRoot,
    })!.repoFingerprint;
    registry.repos[repoFingerprint]!.desired_state.push({
      bundle: "security-standards",
      source: "github.com/user/ai-vault",
      protocol: "https",
    });
    writeRegistryFile(registryPath, registry);

    // When
    await expect(run(["apply"], { homeDir, cwd: repoRoot })).resolves.toBe(
      "Applied security-standards",
    );

    // Then
    expectAgentsDocument(
      repoRoot,
      formatRootInstructionBundleBlock(
        "repo-standards",
        "# Repo standards\nUse consistent conventions.\n",
        "github.com/user/ai-vault",
      ),
      formatRootInstructionBundleBlock(
        "security-standards",
        "# Security standards\nNever commit secrets.\n",
        "github.com/user/ai-vault",
      ),
    );
  });

  it("appends bundle content onto an existing AGENTS.md during add", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeRootInstructionBundleFixture(homeDir, {
      bundle: "repo-standards",
      content: "# Repo standards\nUse consistent conventions.\n",
    });
    fs.writeFileSync(
      path.join(repoRoot, "AGENTS.md"),
      "user root instruction\n",
    );

    // When
    await expect(
      run(["add", "repo-standards"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe(
      "Applied repo-standards for codex, claude-code, cursor, opencode, copilot, kiro, antigravity",
    );

    // Then
    expectAgentsDocument(
      repoRoot,
      "user root instruction\n",
      formatRootInstructionBundleBlock(
        "repo-standards",
        "# Repo standards\nUse consistent conventions.\n",
        "github.com/user/ai-vault",
      ),
    );
    expectClaudeDocument(
      repoRoot,
      formatRootInstructionBundleBlock(
        "repo-standards",
        "# Repo standards\nUse consistent conventions.\n",
        "github.com/user/ai-vault",
      ),
    );
  });

  it("appends bundle content onto an existing CLAUDE.md and records ownership", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeRootInstructionBundleFixture(homeDir, {
      bundle: "repo-standards",
      content: "# Repo standards\nUse consistent conventions.\n",
    });
    fs.writeFileSync(
      path.join(repoRoot, "CLAUDE.md"),
      "user claude instruction\n",
    );

    // When
    await expect(
      run(["add", "repo-standards"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe(
      "Applied repo-standards for codex, claude-code, cursor, opencode, copilot, kiro, antigravity",
    );

    // Then
    expectAgentsDocument(
      repoRoot,
      formatRootInstructionBundleBlock(
        "repo-standards",
        "# Repo standards\nUse consistent conventions.\n",
        "github.com/user/ai-vault",
      ),
    );
    expectClaudeDocument(
      repoRoot,
      "user claude instruction\n",
      formatRootInstructionBundleBlock(
        "repo-standards",
        "# Repo standards\nUse consistent conventions.\n",
        "github.com/user/ai-vault",
      ),
    );
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const worktree = registry.worktrees[Object.keys(registry.worktrees)[0]];
    expect(
      worktree.materialized_state.bundles["repo-standards"]!.tools[
        "claude-code"
      ]!.files,
    ).toContain("CLAUDE.md");
  });

  it("replaces existing root instruction content only when replace mode is explicit", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeRootInstructionBundleFixture(homeDir, {
      bundle: "repo-standards",
      content: "# Repo standards\n",
    });
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "user rules\n");

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
      `${formatRootInstructionBundleBlock(
        "repo-standards",
        "# Repo standards\n",
        "github.com/user/ai-vault",
      )}\n`,
    );

    // When: removing the bundle restores the discarded base content.
    await run(["remove", "repo-standards"], { homeDir, cwd: repoRoot });

    // Then
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      "user rules\n",
    );
  });

  it("uses manifest mode by default but lets the CLI override it", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "repo-standards", {
      name: "repo-standards",
      root_instruction_mode: "replace",
      tools: { codex: { root_instruction: { path: "AGENTS.md" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "repo-standards",
      "AGENTS.md",
      "# Repo standards\n",
    );
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "user rules\n");

    // When
    await run(["add", "repo-standards", "--agent", "codex"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // Then: manifest replace mode is used when no CLI mode is provided.
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      `${formatRootInstructionBundleBlock(
        "repo-standards",
        "# Repo standards\n",
        "github.com/user/ai-vault",
      )}\n`,
    );

    // When: reset removes materialization but preserves desired state, then apply.
    await run(["reset"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    await run(["apply"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // Then: apply keeps the manifest-derived mode.
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      `${formatRootInstructionBundleBlock(
        "repo-standards",
        "# Repo standards\n",
        "github.com/user/ai-vault",
      )}\n`,
    );

    // When
    await run(
      [
        "add",
        "repo-standards",
        "--agent",
        "codex",
        "--root-instruction-mode",
        "append",
      ],
      { homeDir, cwd: repoRoot, prompts: createPromptClientStub() },
    );

    // Then: the explicit CLI mode overrides manifest metadata.
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toContain(
      "user rules\n",
    );
    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    expect(Object.values(registry.repos)[0]?.desired_state[0]).toMatchObject({
      root_instruction_mode: "append",
    });
  });

  it("aborts replace mode when the replacement warning is rejected", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeRootInstructionBundleFixture(homeDir, {
      bundle: "repo-standards",
      content: "# Repo standards\n",
    });
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "user rules\n");
    const resolveFileConflict = vi.fn(async () => {
      throw new Error("replacement declined");
    });

    // When / Then
    await expect(
      run(
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
      ),
    ).rejects.toThrow("replacement declined");
    expect(resolveFileConflict).toHaveBeenCalledWith("AGENTS.md");
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      "user rules\n",
    );
  });

  it("rejects mixed append and replace bundles before changing the shared file", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeRootInstructionBundleFixture(homeDir, {
      bundle: "repo-standards",
      content: "# Repo standards\n",
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "security", {
      name: "security",
      root_instruction_mode: "replace",
      tools: { codex: { root_instruction: { path: "AGENTS.md" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "security",
      "AGENTS.md",
      "# Security\n",
    );

    await run(["add", "repo-standards", "--agent", "codex"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    const before = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");

    // When / Then
    await expect(
      run(["add", "security", "--agent", "codex"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).rejects.toThrow(/mixed modes/i);
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      before,
    );
  });

  it("restores pre-existing AGENTS.md content when the last shared root bundle is removed", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeRootInstructionBundleFixture(homeDir, {
      bundle: "repo-standards",
      content: "# Repo standards\nUse consistent conventions.\n",
    });
    fs.writeFileSync(
      path.join(repoRoot, "AGENTS.md"),
      "user root instruction\n",
    );
    await run(["add", "repo-standards"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When
    await expect(
      run(["remove", "repo-standards"], { homeDir, cwd: repoRoot }),
    ).resolves.toBe("Removed repo-standards");

    // Then
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      "user root instruction\n",
    );
  });

  it("restores pre-existing AGENTS.md content when reset removes shared root bundles", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeRootInstructionBundleFixture(homeDir, {
      bundle: "repo-standards",
      content: "# Repo standards\nUse consistent conventions.\n",
    });
    fs.writeFileSync(
      path.join(repoRoot, "AGENTS.md"),
      "user root instruction\n",
    );
    await run(["add", "repo-standards"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When
    await expect(run(["reset"], { homeDir, cwd: repoRoot })).resolves.toBe(
      "Reset Skul-managed files from the current worktree",
    );

    // Then
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      "user root instruction\n",
    );
  });

  it("recaptures restored root base content when a non-root bundle keeps the worktree alive", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeRootInstructionBundleFixture(homeDir, {
      bundle: "repo-standards",
      content: "# Repo standards\nUse consistent conventions.\n",
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
    fs.writeFileSync(
      path.join(repoRoot, "AGENTS.md"),
      "user root instruction\n",
    );
    await run(["add", "repo-standards"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    await run(["add", "react-expert"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    await run(["remove", "repo-standards"], { homeDir, cwd: repoRoot });
    fs.writeFileSync(
      path.join(repoRoot, "AGENTS.md"),
      "user root instruction v2\n",
    );

    // When
    await expect(
      run(["add", "repo-standards"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe(
      "Applied repo-standards for codex, claude-code, cursor, opencode, copilot, kiro, antigravity",
    );

    // Then
    expectAgentsDocument(
      repoRoot,
      "user root instruction v2\n",
      formatRootInstructionBundleBlock(
        "repo-standards",
        "# Repo standards\nUse consistent conventions.\n",
        "github.com/user/ai-vault",
      ),
    );
  });

  it("composes multiple tool-specific root instructions that land on the same file", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    // codex and opencode both target AGENTS.md, so their bundle content is combined
    writeManifest(homeDir, "github.com/user/ai-vault", "shared-agents-guide", {
      name: "shared-agents-guide",
      tools: {
        codex: { root_instruction: { path: "codex-guide.md" } },
        opencode: { root_instruction: { path: "opencode-guide.md" } },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "shared-agents-guide",
      "codex-guide.md",
      "# Codex guide\nUse Codex defaults.\n",
    );
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "shared-agents-guide",
      "opencode-guide.md",
      "# OpenCode guide\nUse OpenCode defaults.\n",
    );

    // When
    await expect(
      run(["add", "shared-agents-guide"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe(
      "Applied shared-agents-guide for codex, opencode, claude-code, cursor, copilot, kiro, antigravity",
    );

    // Then: codex and opencode content is merged into the shared AGENTS.md target
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      formatExpectedRootInstructionDocument(
        formatRootInstructionBundleBlock(
          "shared-agents-guide",
          "# Codex guide\nUse Codex defaults.\n\n# OpenCode guide\nUse OpenCode defaults.\n",
          "github.com/user/ai-vault",
        ),
      ),
    );
  });

  it("preserves unrelated managed fingerprints when shared root instructions sync", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    setupSharedRootInstructionBundles(homeDir, [
      {
        bundle: "repo-guide",
        content: "# Repo guide\nFollow the handbook.\n",
        extraTools: { "claude-code": { skills: { path: ".claude/skills" } } },
        extraFiles: { ".claude/skills/react/SKILL.md": "# react\n" },
      },
      {
        bundle: "security-standards",
        content: "# Security standards\nNever commit secrets.\n",
      },
    ]);

    await run(["add", "repo-guide"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    const registryPath = path.join(homeDir, ".skul", "registry.json");
    const initialRegistry = readRegistryFile(registryPath);
    const initialWorktree =
      initialRegistry.worktrees[Object.keys(initialRegistry.worktrees)[0]];
    const initialSkillFingerprint =
      initialWorktree.materialized_state.bundles["repo-guide"]!.tools[
        "claude-code"
      ]!.file_fingerprints![".claude/skills/react/SKILL.md"]!;

    fs.writeFileSync(
      path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
      "# modified\n",
    );

    // When
    await expect(
      run(["add", "security-standards"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe(
      "Applied security-standards for codex, claude-code, cursor, opencode, copilot, kiro, antigravity",
    );

    // Then
    const registry = readRegistryFile(registryPath);
    const worktree = registry.worktrees[Object.keys(registry.worktrees)[0]];
    const refreshedSkillFingerprint =
      worktree.materialized_state.bundles["repo-guide"]!.tools["claude-code"]!
        .file_fingerprints![".claude/skills/react/SKILL.md"]!;
    expect(refreshedSkillFingerprint).toBe(initialSkillFingerprint);
    expect(refreshedSkillFingerprint).not.toBe(
      fingerprintFile(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
      ),
    );
  });

  it("aborts shared root-instruction add before rewriting files when an existing shared bundle cache is missing", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const repoGuideSource = "github.com/user/repo-guide-source";
    const securitySource = "github.com/user/security-source";

    setupSharedRootInstructionBundles(homeDir, [
      {
        source: repoGuideSource,
        bundle: "repo-guide",
        content: "# Repo guide\nFollow the handbook.\n",
      },
      {
        source: securitySource,
        bundle: "security-standards",
        content: "# Security standards\nNever commit secrets.\n",
      },
    ]);

    await run(["add", "repo-guide"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    const agentsBefore = fs.readFileSync(
      path.join(repoRoot, "AGENTS.md"),
      "utf8",
    );
    const claudeBefore = fs.readFileSync(
      path.join(repoRoot, "CLAUDE.md"),
      "utf8",
    );
    fs.rmSync(
      path.join(
        homeDir,
        ".skul",
        "library",
        ...repoGuideSource.split("/"),
        "repo-guide",
      ),
      {
        recursive: true,
        force: true,
      },
    );

    // When / Then
    await expect(
      run(["add", "security-standards"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).rejects.toThrowError(/Bundle not found: repo-guide/);
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      agentsBefore,
    );
    expect(fs.readFileSync(path.join(repoRoot, "CLAUDE.md"), "utf8")).toBe(
      claudeBefore,
    );

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const repoFingerprint = detectGitContext({
      cwd: repoRoot,
    })!.repoFingerprint;
    expect(registry.repos[repoFingerprint]!.desired_state).toEqual([
      { bundle: "repo-guide", source: repoGuideSource, protocol: "https" },
    ]);
  });

  it("aborts shared root-instruction removal before deleting files when a remaining shared bundle cache is missing", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const repoGuideSource = "github.com/user/repo-guide-source";
    const securitySource = "github.com/user/security-source";

    setupSharedRootInstructionBundles(homeDir, [
      {
        source: repoGuideSource,
        bundle: "repo-guide",
        content: "# Repo guide\nFollow the handbook.\n",
      },
      {
        source: securitySource,
        bundle: "security-standards",
        content: "# Security standards\nNever commit secrets.\n",
      },
    ]);

    await run(["add", "repo-guide"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    await run(["add", "security-standards"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    const agentsBefore = fs.readFileSync(
      path.join(repoRoot, "AGENTS.md"),
      "utf8",
    );
    fs.rmSync(
      path.join(
        homeDir,
        ".skul",
        "library",
        ...securitySource.split("/"),
        "security-standards",
      ),
      {
        recursive: true,
        force: true,
      },
    );

    // When / Then
    await expect(
      run(["remove", "repo-guide"], { homeDir, cwd: repoRoot }),
    ).rejects.toThrowError(/Bundle not found: security-standards/);
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      agentsBefore,
    );

    const registry = readRegistryFile(
      path.join(homeDir, ".skul", "registry.json"),
    );
    const repoFingerprint = detectGitContext({
      cwd: repoRoot,
    })!.repoFingerprint;
    expect(registry.repos[repoFingerprint]!.desired_state).toEqual([
      { bundle: "repo-guide", source: repoGuideSource, protocol: "https" },
      {
        bundle: "security-standards",
        source: securitySource,
        protocol: "https",
      },
    ]);
    expect(Object.keys(registry.worktrees)).toHaveLength(1);
    const worktree = registry.worktrees[Object.keys(registry.worktrees)[0]];
    expect(Object.keys(worktree.materialized_state.bundles).sort()).toEqual([
      "repo-guide",
      "security-standards",
    ]);
  });

  it("removes one shared tracked root instruction after safety checks pass", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    setupSharedRootInstructionBundles(homeDir, [
      { bundle: "repo-guide", content: "# Repo guide\nFollow the handbook.\n" },
      {
        bundle: "security-standards",
        content: "# Security standards\nNever commit secrets.\n",
      },
    ]);

    await run(["add", "repo-guide"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    await run(["add", "security-standards"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    runGit(repoRoot, ["add", "-f", "AGENTS.md", "CLAUDE.md"]);
    runGit(repoRoot, ["commit", "-m", "materialize shared roots"]);

    // When
    await expect(
      run(["remove", "repo-guide"], { homeDir, cwd: repoRoot }),
    ).resolves.toBe("Removed repo-guide");

    // Then
    expectAgentsDocument(
      repoRoot,
      formatRootInstructionBundleBlock(
        "security-standards",
        "# Security standards\nNever commit secrets.\n",
        "github.com/user/ai-vault",
      ),
    );
  });
});
