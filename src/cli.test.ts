import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseCliArgs, type PromptClient } from "./cli";
import { detectGitContext } from "./git-context";
import { run } from "./index";
import { createEmptyRegistry, readRegistryFile, upsertRepoState, writeRegistryFile } from "./registry";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseCliArgs", () => {
  it("returns help when no command is provided", async () => {
    // Given
    const argv: string[] = [];

    // When / Then
    await expect(parseCliArgs(argv)).resolves.toEqual({ kind: "help" });
  });

  it("parses non-mutating commands without arguments", async () => {
    // Given
    const listArgs = ["list"];
    const statusArgs = ["status"];
    const checkArgs = ["check"];
    const updateArgs = ["update"];
    const resetArgs = ["reset"];
    const applyArgs = ["apply"];

    // When / Then
    await expect(parseCliArgs(listArgs)).resolves.toEqual({ kind: "command", command: "list", options: { json: false } });
    await expect(parseCliArgs(statusArgs)).resolves.toEqual({ kind: "command", command: "status", options: { json: false } });
    await expect(parseCliArgs(checkArgs)).resolves.toEqual({ kind: "command", command: "check", options: { json: false } });
    await expect(parseCliArgs(updateArgs)).resolves.toEqual({ kind: "command", command: "update", options: { dryRun: false } });
    await expect(parseCliArgs(resetArgs)).resolves.toEqual({ kind: "command", command: "reset", options: { dryRun: false } });
    await expect(parseCliArgs(applyArgs)).resolves.toEqual({ kind: "command", command: "apply" });
  });

  it("parses add in interactive, cached, and explicit source modes", async () => {
    // Given
    const selectBundle = vi.fn().mockResolvedValue("react-expert");
    const prompts = createPromptClientStub({ selectBundle });

    // When / Then
    await expect(parseCliArgs([], prompts)).resolves.toEqual({ kind: "help" });

    await expect(parseCliArgs(["add"], prompts)).resolves.toEqual({
      kind: "command",
      command: "add",
      options: { mode: "stealth", bundle: "react-expert", protocol: "https", agents: [], dryRun: false },
    });
    expect(selectBundle).toHaveBeenCalledWith();

    await expect(parseCliArgs(["add", "react-expert"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: { mode: "stealth", bundle: "react-expert", protocol: "https", agents: [], dryRun: false },
    });

    await expect(parseCliArgs(["add", "github.com/user/ai-vault", "react-expert"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        mode: "stealth",
        source: "github.com/user/ai-vault",
        bundle: "react-expert",
        protocol: "https",
        agents: [],
        dryRun: false,
      },
    });
  });

  it("normalizes explicit HTTPS source URLs for add", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["add", "https://github.com/user/ai-vault.git", "react-expert"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        mode: "stealth",
        source: "github.com/user/ai-vault",
        bundle: "react-expert",
        protocol: "https",
        agents: [],
        dryRun: false,
      },
    });
  });

  it("derives bundle name from repo slug when only a source URL is given", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["add", "github.com/user/react-bundle"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        mode: "stealth",
        source: "github.com/user/react-bundle",
        bundle: "react-bundle",
        protocol: "https",
        agents: [],
        dryRun: false,
      },
    });
  });

  it("treats a single arg as a plain bundle name when it is not a valid source URL", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["add", "react-expert"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: { mode: "stealth", bundle: "react-expert", protocol: "https", agents: [], dryRun: false },
    });
  });

  it("parses --agent flag as a single selected agent", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["add", "react-expert", "--agent", "claude-code"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: { mode: "stealth", bundle: "react-expert", protocol: "https", agents: ["claude-code"], dryRun: false },
    });
  });

  it("collects multiple --agent flags into an array", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs(["add", "react-expert", "--agent", "claude-code", "--agent", "cursor"]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: { mode: "stealth", bundle: "react-expert", protocol: "https", agents: ["claude-code", "cursor"], dryRun: false },
    });
  });

  it("accepts -a as shorthand for --agent", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["add", "react-expert", "-a", "claude-code"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: { mode: "stealth", bundle: "react-expert", protocol: "https", agents: ["claude-code"], dryRun: false },
    });
  });

  it("collects multiple -a flags into an array", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["add", "react-expert", "-a", "claude-code", "-a", "cursor"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: { mode: "stealth", bundle: "react-expert", protocol: "https", agents: ["claude-code", "cursor"], dryRun: false },
    });
  });

  it("accepts -n as shorthand for --dry-run", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["add", "react-expert", "-n"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: { mode: "stealth", bundle: "react-expert", protocol: "https", agents: [], dryRun: true },
    });
  });

  it("accepts -s as shorthand for --ssh", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["add", "github.com/user/ai-vault", "react-expert", "-s"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: { mode: "stealth", source: "github.com/user/ai-vault", bundle: "react-expert", protocol: "ssh", agents: [], dryRun: false },
    });
  });

  it("accepts -j as shorthand for --json on list and status", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["list", "-j"])).resolves.toEqual({
      kind: "command",
      command: "list",
      options: { json: true },
    });

    await expect(parseCliArgs(["status", "-j"])).resolves.toEqual({
      kind: "command",
      command: "status",
      options: { json: true },
    });

    await expect(parseCliArgs(["check", "-j"])).resolves.toEqual({
      kind: "command",
      command: "check",
      options: { json: true },
    });
  });

  it("parses remove with a required bundle argument", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["remove", "react-expert"])).resolves.toEqual({
      kind: "command",
      command: "remove",
      options: { bundle: "react-expert", dryRun: false },
    });
  });

  it("parses --json flag on list and status", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["list", "--json"])).resolves.toEqual({
      kind: "command",
      command: "list",
      options: { json: true },
    });

    await expect(parseCliArgs(["status", "--json"])).resolves.toEqual({
      kind: "command",
      command: "status",
      options: { json: true },
    });

    await expect(parseCliArgs(["check", "--json"])).resolves.toEqual({
      kind: "command",
      command: "check",
      options: { json: true },
    });
  });

  it("parses bundle-scoped check and update commands", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["check", "react-expert"])).resolves.toEqual({
      kind: "command",
      command: "check",
      options: { bundle: "react-expert", json: false },
    });

    await expect(parseCliArgs(["update", "react-expert", "--dry-run"])).resolves.toEqual({
      kind: "command",
      command: "update",
      options: { bundle: "react-expert", dryRun: true },
    });
  });

  it("parses --ssh flag and sets protocol to ssh", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["add", "github.com/user/ai-vault", "react-expert", "--ssh"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        mode: "stealth",
        source: "github.com/user/ai-vault",
        bundle: "react-expert",
        protocol: "ssh",
        agents: [],
        dryRun: false,
      },
    });
  });

  it("auto-detects SSH protocol from a git@ source URL with explicit bundle", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs(["add", "git@github.com:user/ai-vault.git", "react-expert"]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        mode: "stealth",
        source: "github.com/user/ai-vault",
        bundle: "react-expert",
        protocol: "ssh",
        agents: [],
        dryRun: false,
      },
    });
  });

  it("auto-detects SSH protocol and derives bundle name from a git@ source URL", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["add", "git@github.com:user/react-bundle.git"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        mode: "stealth",
        source: "github.com/user/react-bundle",
        bundle: "react-bundle",
        protocol: "ssh",
        agents: [],
        dryRun: false,
      },
    });
  });

  it("parses --dry-run flag on add, remove, and reset", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["add", "react-expert", "--dry-run"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: { mode: "stealth", bundle: "react-expert", protocol: "https", agents: [], dryRun: true },
    });

    await expect(parseCliArgs(["remove", "react-expert", "--dry-run"])).resolves.toEqual({
      kind: "command",
      command: "remove",
      options: { bundle: "react-expert", dryRun: true },
    });

    await expect(parseCliArgs(["reset", "--dry-run"])).resolves.toEqual({
      kind: "command",
      command: "reset",
      options: { dryRun: true },
    });
  });

  it("rejects unknown commands and invalid arity", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["deploy"])).rejects.toThrowError(/Unknown command: deploy/);
    await expect(parseCliArgs(["list", "extra"])).rejects.toThrowError(
      /Command list does not accept positional arguments/,
    );
    await expect(parseCliArgs(["status", "extra"])).rejects.toThrowError(
      /Command status does not accept positional arguments/,
    );
    await expect(parseCliArgs(["reset", "extra"])).rejects.toThrowError(
      /Command reset does not accept positional arguments/,
    );
    await expect(parseCliArgs(["apply", "extra"])).rejects.toThrowError(
      /Command apply does not accept positional arguments/,
    );
    await expect(parseCliArgs(["add", "a", "b", "c"])).rejects.toThrowError(
      /Command add accepts at most 2 positional arguments/,
    );
    await expect(parseCliArgs(["remove", "a", "b"])).rejects.toThrowError(
      /Command remove accepts exactly 1 positional argument/,
    );
    await expect(parseCliArgs(["check", "a", "b"])).rejects.toThrowError(
      /Command check accepts at most 1 positional argument/,
    );
    await expect(parseCliArgs(["update", "a", "b"])).rejects.toThrowError(
      /Command update accepts at most 1 positional argument/,
    );
    await expect(parseCliArgs(["remove"])).rejects.toThrowError(
      /missing required argument 'bundle'/,
    );
  });
});

describe("run", () => {
  it("renders usage for bare invocations", async () => {
    // Given
    const argv: string[] = [];

    // When / Then
    await expect(run(argv)).resolves.toMatch(/^Usage: skul /);
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
      renderBundleListOutput("react-expert (claude-code)", "repo-standards (codex)"),
    );
  });

  it("reports when no cached bundles are available", async () => {
    // Given
    const homeDir = createHomeDir();

    // When / Then
    await expect(run(["list"], { homeDir })).resolves.toBe(renderBundleListOutput("No cached bundles found."));
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
      bundles: [{ name: "react-expert", tools: ["claude-code"] }],
    });
  });

  it("returns JSON status when --json is passed", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });

    // When
    const output = await run(["status", "--json"], { homeDir, cwd: repoRoot });
    const parsed = JSON.parse(output);

    // Then
    expect(parsed.repo.desired_state).toEqual([{ bundle: "react-expert", protocol: "https" }]);
    expect(parsed.worktree.materialized).toBe(true);
    expect(parsed.worktree.git_exclude_configured).toBe(true);
    expect(parsed.worktree.bundles["react-expert"].tools["claude-code"].files).toContain(
      ".claude/skills/react/SKILL.md",
    );
  });

  it("returns JSON status with suggested_action when bundles are not yet materialized", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });

    // Create a new linked worktree that has not materialized yet
    const linkedWorktree = createLinkedWorktree(repoRoot);

    // When
    const output = await run(["status", "--json"], { homeDir, cwd: linkedWorktree });
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
    await run(["add", remoteSource.source, remoteSource.bundle], { homeDir, cwd: repoRoot });
    const updatedCommit = updateRemoteBundleSource(remoteSource.remoteRepoPath, remoteSource.bundle, {
      ".claude/skills/react/SKILL.md": "# react v2\n",
    });

    // When / Then
    await expect(run(["check"], { homeDir, cwd: repoRoot })).resolves.toBe(
      `react-expert: update-available ${remoteSource.initialCommit.slice(0, 7)} -> ${updatedCommit.slice(0, 7)}`,
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
    await run(["add", remoteSource.source, remoteSource.bundle], { homeDir, cwd: repoRoot });
    const updatedCommit = updateRemoteBundleSource(remoteSource.remoteRepoPath, remoteSource.bundle, {
      ".claude/skills/react/SKILL.md": "# react v2\n",
    });

    // When
    await expect(run(["update"], { homeDir, cwd: repoRoot })).resolves.toBe(
      `Updated react-expert ${remoteSource.initialCommit.slice(0, 7)} -> ${updatedCommit.slice(0, 7)}`,
    );

    // Then
    expect(
      fs.readFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "utf8"),
    ).toBe("# react v2\n");

    const registry = readRegistryFile(path.join(homeDir, ".skul", "registry.json"));
    const repoEntry = registry.repos[detectGitContext({ cwd: repoRoot })!.repoFingerprint]!;
    const worktreeEntry = registry.worktrees[detectGitContext({ cwd: repoRoot })!.worktreeId]!;

    expect(repoEntry.desired_state[0]).toMatchObject({
      bundle: "react-expert",
      resolved_ref: "main",
      resolved_commit: updatedCommit,
    });
    expect(worktreeEntry.materialized_state.bundles["react-expert"]).toMatchObject({
      resolved_commit: updatedCommit,
    });
  });

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
    await run(["add", remoteSource.source, remoteSource.bundle], { homeDir, cwd: repoRoot });
    fs.writeFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "# modified locally\n");
    const updatedCommit = updateRemoteBundleSource(remoteSource.remoteRepoPath, remoteSource.bundle, {
      ".claude/skills/react/SKILL.md": "# react v2\n",
    });

    // When / Then
    await expect(
      run(["update"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          confirmManagedFileRemoval: async () => false,
        }),
      }),
    ).rejects.toThrowError(/Replacement aborted because a modified managed file was kept/);

    const registry = readRegistryFile(path.join(homeDir, ".skul", "registry.json"));
    const repoEntry = registry.repos[detectGitContext({ cwd: repoRoot })!.repoFingerprint]!;

    expect(repoEntry.desired_state[0]).toMatchObject({
      bundle: "react-expert",
      resolved_commit: remoteSource.initialCommit,
    });

    await expect(run(["apply"], { homeDir, cwd: linkedWorktree })).resolves.toBe("Applied react-expert");
    expect(
      fs.readFileSync(path.join(linkedWorktree, ".claude", "skills", "react", "SKILL.md"), "utf8"),
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
    await run(["add", remoteSource.source, remoteSource.bundle], { homeDir, cwd: repoRoot });
    await run(["apply"], { homeDir, cwd: linkedWorktree });
    const updatedCommit = updateRemoteBundleSource(remoteSource.remoteRepoPath, remoteSource.bundle, {
      ".claude/skills/react/SKILL.md": "# react v2\n",
    });
    await run(["update"], { homeDir, cwd: repoRoot });

    // When
    await expect(run(["apply"], { homeDir, cwd: linkedWorktree })).resolves.toBe("Applied react-expert");

    // Then
    expect(
      fs.readFileSync(path.join(linkedWorktree, ".claude", "skills", "react", "SKILL.md"), "utf8"),
    ).toBe("# react v2\n");

    const registry = readRegistryFile(path.join(homeDir, ".skul", "registry.json"));
    const linkedEntry = registry.worktrees[detectGitContext({ cwd: linkedWorktree })!.worktreeId]!;

    expect(linkedEntry.materialized_state.bundles["react-expert"]).toMatchObject({
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
    await run(["add", remoteSource.source, remoteSource.bundle], { homeDir, cwd: repoRoot });
    await run(["add", "react-expert", "--agent", "claude-code"], { homeDir, cwd: repoRoot });
    const updatedCommit = updateRemoteBundleSource(remoteSource.remoteRepoPath, remoteSource.bundle, {
      ".claude/skills/react/SKILL.md": "# react v2\n",
      ".cursor/skills/react/SKILL.md": "# react v2\n",
    });

    // When
    await expect(run(["update"], { homeDir, cwd: repoRoot })).resolves.toBe(
      `Updated react-expert ${remoteSource.initialCommit.slice(0, 7)} -> ${updatedCommit.slice(0, 7)}`,
    );

    // Then
    const registry = readRegistryFile(path.join(homeDir, ".skul", "registry.json"));
    const repoEntry = registry.repos[detectGitContext({ cwd: repoRoot })!.repoFingerprint]!;

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

  it("dry-runs add without writing any files", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");

    // When
    const output = await run(["add", "react-expert", "--dry-run"], { homeDir, cwd: repoRoot });

    // Then: output describes intent without materializing files
    expect(output).toMatch(/DRY RUN/);
    expect(output).toContain("react-expert");
    expect(fs.existsSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"))).toBe(false);
  });

  it("dry-runs remove without deleting any files", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });

    // When
    const output = await run(["remove", "react-expert", "--dry-run"], { homeDir, cwd: repoRoot });

    // Then: output describes intent without deleting files
    expect(output).toMatch(/DRY RUN/);
    expect(output).toContain("react-expert");
    expect(fs.existsSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"))).toBe(true);
  });

  it("dry-runs reset without deleting any files", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });

    // When
    const output = await run(["reset", "--dry-run"], { homeDir, cwd: repoRoot });

    // Then: output describes intent without deleting files
    expect(output).toMatch(/DRY RUN/);
    expect(output).toContain(".claude/skills/react/SKILL.md");
    expect(fs.existsSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"))).toBe(true);
  });

  it("errors in headless mode when bundle is not specified for add", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const { createHeadlessPromptClient } = await import("./cli");

    // When / Then: headless prompt client throws with a hint instead of prompting
    await expect(
      run(["add"], { homeDir, cwd: repoRoot, prompts: createHeadlessPromptClient() }),
    ).rejects.toThrowError(/Bundle name is required in headless mode/);
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
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });
    fs.writeFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "# modified\n");

    // When / Then: headless client throws instead of prompting
    await expect(
      run(["reset"], { homeDir, cwd: repoRoot, prompts: createHeadlessPromptClient() }),
    ).rejects.toThrowError(/Modified managed file blocks reset in headless mode/);
  });

  it("activates headless mode via SKUL_NO_TUI environment variable", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    // When / Then: SKUL_NO_TUI=1 causes run() to select the headless client,
    // which throws when no bundle is specified rather than opening a prompt.
    process.env["SKUL_NO_TUI"] = "1";
    try {
      await expect(run(["add"], { homeDir, cwd: repoRoot })).rejects.toThrowError(
        /Bundle name is required in headless mode/,
      );
    } finally {
      delete process.env["SKUL_NO_TUI"];
    }
  });

  it("applies a cached bundle into the current repository and records ownership", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");

    // When
    await expect(run(["add", "react-expert"], { homeDir, cwd: repoRoot })).resolves.toBe(
      "Applied react-expert for claude-code",
    );

    // Then
    expect(fs.readFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "utf8")).toBe(
      "# react\n",
    );
    expect(fs.readFileSync(path.join(repoRoot, ".git", "info", "exclude"), "utf8")).toContain(
      ".claude/skills/react/SKILL.md",
    );
    expect(readRegistryFile(path.join(homeDir, ".skul", "registry.json")).worktrees).toHaveProperty(
      Object.keys(readRegistryFile(path.join(homeDir, ".skul", "registry.json")).worktrees)[0],
    );
  });

  it("coexists with a previously added bundle for the same tool", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" }, commands: { path: ".claude/commands" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/commands/review.md", "# review\n");
    writeManifest(homeDir, "github.com/user/ai-vault", "next-expert", {
      name: "next-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "next-expert", ".claude/skills/next/SKILL.md", "# next\n");
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });

    // When
    await expect(run(["add", "next-expert"], { homeDir, cwd: repoRoot })).resolves.toBe(
      "Applied next-expert for claude-code",
    );

    // Then: both bundles coexist on disk
    expect(fs.readFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "utf8")).toBe("# react\n");
    expect(fs.readFileSync(path.join(repoRoot, ".claude", "commands", "review.md"), "utf8")).toBe("# review\n");
    expect(fs.readFileSync(path.join(repoRoot, ".claude", "skills", "next", "SKILL.md"), "utf8")).toBe("# next\n");
    const excludeFile = fs.readFileSync(path.join(repoRoot, ".git", "info", "exclude"), "utf8");
    expect(excludeFile).toContain(".claude/skills/react/SKILL.md");
    expect(excludeFile).toContain(".claude/commands/review.md");
    expect(excludeFile).toContain(".claude/skills/next/SKILL.md");

    const registry = readRegistryFile(path.join(homeDir, ".skul", "registry.json"));
    const worktree = registry.worktrees[Object.keys(registry.worktrees)[0]];
    expect(worktree.materialized_state).toMatchObject({
      bundles: {
        "react-expert": { tools: { "claude-code": { files: expect.arrayContaining([".claude/skills/react/SKILL.md"]) } } },
        "next-expert": { tools: { "claude-code": { files: [".claude/skills/next/SKILL.md"] } } },
      },
    });
  });

  it("coexists with a previously added bundle targeting a different tool", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" }, commands: { path: ".claude/commands" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/commands/review.md", "# review\n");
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
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });

    // When
    await expect(run(["add", "repo-standards"], { homeDir, cwd: repoRoot })).resolves.toBe(
      "Applied repo-standards for codex",
    );

    // Then: both bundles coexist on disk
    expect(fs.readFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "utf8")).toBe("# react\n");
    expect(fs.readFileSync(path.join(repoRoot, ".claude", "commands", "review.md"), "utf8")).toBe("# review\n");
    expect(fs.readFileSync(path.join(repoRoot, ".agents", "skills", "next-task", "SKILL.md"), "utf8")).toBe(
      "# next task\n",
    );
    const excludeFile = fs.readFileSync(path.join(repoRoot, ".git", "info", "exclude"), "utf8");
    expect(excludeFile).toContain(".claude/skills/react/SKILL.md");
    expect(excludeFile).toContain(".agents/skills/next-task/SKILL.md");

    const registry = readRegistryFile(path.join(homeDir, ".skul", "registry.json"));
    const repo = registry.repos[Object.keys(registry.repos)[0]];
    const worktree = registry.worktrees[Object.keys(registry.worktrees)[0]];
    expect(repo.desired_state).toEqual(
      expect.arrayContaining([{ bundle: "react-expert", protocol: "https" }, { bundle: "repo-standards", protocol: "https" }]),
    );
    expect(worktree.materialized_state).toMatchObject({
      bundles: {
        "react-expert": { tools: { "claude-code": { files: expect.arrayContaining([".claude/skills/react/SKILL.md"]) } } },
        "repo-standards": { tools: { codex: { files: [".agents/skills/next-task/SKILL.md"] } } },
      },
    });
  });

  it("applies the chosen conflict strategy when a destination file already exists", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    fs.mkdirSync(path.join(repoRoot, ".claude", "skills", "react"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "user file\n");

    // When
    await expect(
      run(["add", "react-expert"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          resolveFileConflict: async () => ({ action: "prefix", prefix: "team" }),
        }),
      }),
    ).resolves.toBe("Applied react-expert for claude-code");

    // Then
    expect(fs.readFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "utf8")).toBe(
      "user file\n",
    );
    expect(
      fs.readFileSync(path.join(repoRoot, ".claude", "skills", "team-react", "SKILL.md"), "utf8"),
    ).toBe("# react\n");
  });

  it("renames the incoming file when the conflict strategy chooses rename", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    fs.mkdirSync(path.join(repoRoot, ".claude", "skills", "react"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "user file\n");

    // When
    await expect(
      run(["add", "react-expert"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          resolveFileConflict: async () => ({
            action: "rename",
            destination: "custom-react/SKILL.md",
          }),
        }),
      }),
    ).resolves.toBe("Applied react-expert for claude-code");

    // Then
    expect(fs.readFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "utf8")).toBe(
      "user file\n",
    );
    expect(
      fs.readFileSync(path.join(repoRoot, ".claude", "skills", "custom-react", "SKILL.md"), "utf8"),
    ).toBe("# react\n");
  });

  it("skips the incoming file when the conflict strategy chooses skip", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    fs.mkdirSync(path.join(repoRoot, ".claude", "skills", "react"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "user file\n");

    // When
    await expect(
      run(["add", "react-expert"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          resolveFileConflict: async () => ({ action: "skip" }),
        }),
      }),
    ).resolves.toBe("Applied react-expert for claude-code");

    // Then
    expect(fs.readFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "utf8")).toBe(
      "user file\n",
    );
    expect(pathExists(path.join(repoRoot, ".claude", "skills", "p-react", "SKILL.md"))).toBe(false);
  });

  it("renders repository desired state, worktree files, and exclude status", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" }, commands: { path: ".claude/commands" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/commands/review.md", "# review\n");
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });

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
    const registry = upsertRepoState(createEmptyRegistry(), gitContext.repoFingerprint, {
      repo_root: fs.realpathSync.native(repoRoot),
      desired_state: [{ bundle: "react-expert", protocol: "https" }],
    });
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

  it("shows repository intent from the main worktree inside a linked worktree", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const linkedWorktreeRoot = createLinkedWorktree(repoRoot);
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });

    // When / Then
    await expect(run(["status"], { homeDir, cwd: linkedWorktreeRoot })).resolves.toBe(
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
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });
    fs.writeFileSync(path.join(repoRoot, ".git", "info", "exclude"), "node_modules\n");

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
      tools: { "claude-code": { skills: { path: ".claude/skills" }, commands: { path: ".claude/commands" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/commands/review.md", "# review\n");
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });
    fs.writeFileSync(path.join(repoRoot, "notes.txt"), "keep me\n");

    // When
    await expect(run(["reset"], { homeDir, cwd: repoRoot })).resolves.toBe(
      "Reset Skul-managed files from the current worktree",
    );

    // Then
    expect(pathExists(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"))).toBe(false);
    expect(pathExists(path.join(repoRoot, ".claude", "commands", "review.md"))).toBe(false);
    expect(fs.readFileSync(path.join(repoRoot, "notes.txt"), "utf8")).toBe("keep me\n");
    expect(fs.readFileSync(path.join(repoRoot, ".git", "info", "exclude"), "utf8")).not.toContain(
      "# >>> SKUL START",
    );

    const registry = readRegistryFile(path.join(homeDir, ".skul", "registry.json"));
    expect(registry.worktrees).toEqual({});
    expect(registry.repos[detectGitContext({ cwd: repoRoot })!.repoFingerprint]?.desired_state).toEqual([
      { bundle: "react-expert", protocol: "https" },
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
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });
    fs.writeFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "# modified\n");

    // When / Then
    await expect(
      run(["reset"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          confirmManagedFileRemoval: async () => false,
        }),
      }),
    ).rejects.toThrowError(/Reset aborted because a modified managed file was kept/);
    expect(fs.readFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "utf8")).toBe(
      "# modified\n",
    );
  });

  it("prompts before replacing a modified managed file and aborts when the user declines", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });
    // Modify the managed file
    fs.writeFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "# modified\n");

    // When / Then: re-adding the same bundle should prompt and abort
    await expect(
      run(["add", "react-expert"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          confirmManagedFileRemoval: async () => false,
        }),
      }),
    ).rejects.toThrowError(/Replacement aborted because a modified managed file was kept/);
    expect(fs.readFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "utf8")).toBe(
      "# modified\n",
    );
  });

  it("aborts re-add when a managed file was modified and the user declines replacement", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } }, codex: { skills: { path: ".agents/skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    await run(["add", "react-expert", "--agent", "claude-code"], { homeDir, cwd: repoRoot });
    fs.writeFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "# modified\n");

    // When / Then: re-adding the same bundle+tool should prompt and abort
    await expect(
      run(["add", "react-expert", "--agent", "claude-code"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          confirmManagedFileRemoval: async () => false,
        }),
      }),
    ).rejects.toThrowError(/Replacement aborted because a modified managed file was kept/);
    expect(fs.readFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "utf8")).toBe(
      "# modified\n",
    );
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
    await expect(run(["add", "react-expert"], { homeDir, cwd })).rejects.toThrowError(
      /skul add requires a Git repository/i,
    );
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
    await expect(run(["add", "missing-bundle"], { homeDir, cwd: repoRoot })).rejects.toThrowError(
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
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");

    // When
    await expect(
      run(["add", "react-expert", "--agent", "claude-code"], { homeDir, cwd: repoRoot }),
    ).resolves.toBe("Applied react-expert for claude-code");

    // Then
    expect(
      fs.readFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "utf8"),
    ).toBe("# react\n");
    expect(pathExists(path.join(repoRoot, ".cursor", "skills", "react", "SKILL.md"))).toBe(false);

    const registry = readRegistryFile(path.join(homeDir, ".skul", "registry.json"));
    const worktree = registry.worktrees[Object.keys(registry.worktrees)[0]];
    expect(worktree.materialized_state).toMatchObject({
      bundles: {
        "react-expert": { tools: { "claude-code": { files: [".claude/skills/react/SKILL.md"] } } },
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
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".cursor/skills/react/SKILL.md", "# react\n");

    // When
    await expect(
      run(["add", "react-expert", "--agent", "claude-code", "--agent", "cursor"], {
        homeDir,
        cwd: repoRoot,
      }),
    ).resolves.toBe("Applied react-expert for claude-code, cursor");

    // Then
    expect(
      fs.readFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "utf8"),
    ).toBe("# react\n");
    expect(
      fs.readFileSync(path.join(repoRoot, ".cursor", "skills", "react", "SKILL.md"), "utf8"),
    ).toBe("# react\n");
    expect(pathExists(path.join(repoRoot, ".agents", "skills", "react", "SKILL.md"))).toBe(false);
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
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".cursor/skills/react/SKILL.md", "# react\n");
    await run(["add", "react-expert", "--agent", "claude-code"], { homeDir, cwd: repoRoot });

    // When: add cursor tool to the same bundle
    await expect(
      run(["add", "react-expert", "--agent", "cursor"], { homeDir, cwd: repoRoot }),
    ).resolves.toBe("Applied react-expert for cursor");

    // Then: both tools' files exist
    expect(
      fs.readFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "utf8"),
    ).toBe("# react\n");
    expect(
      fs.readFileSync(path.join(repoRoot, ".cursor", "skills", "react", "SKILL.md"), "utf8"),
    ).toBe("# react\n");

    // And the registry records both tools for this bundle
    const registry = readRegistryFile(path.join(homeDir, ".skul", "registry.json"));
    const repoFingerprint = detectGitContext({ cwd: repoRoot })!.repoFingerprint;
    const worktree = registry.worktrees[Object.keys(registry.worktrees)[0]];
    expect(worktree.materialized_state.bundles["react-expert"].tools).toMatchObject({
      "claude-code": { files: [".claude/skills/react/SKILL.md"] },
      cursor: { files: [".cursor/skills/react/SKILL.md"] },
    });
    expect(registry.repos[repoFingerprint]?.desired_state).toEqual([
      { bundle: "react-expert", tools: ["claude-code", "cursor"], protocol: "https" },
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
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".cursor/skills/react/SKILL.md", "# react\n");
    await run(["add", "react-expert", "--agent", "claude-code"], { homeDir, cwd: repoRoot });
    await run(["apply"], { homeDir, cwd: linkedWorktree });

    // When
    await expect(run(["add", "react-expert"], { homeDir, cwd: repoRoot })).resolves.toBe(
      "Applied react-expert for claude-code, cursor",
    );
    await expect(run(["apply"], { homeDir, cwd: linkedWorktree })).resolves.toBe("Applied react-expert");

    // Then
    const registry = readRegistryFile(path.join(homeDir, ".skul", "registry.json"));
    const repoFingerprint = detectGitContext({ cwd: repoRoot })!.repoFingerprint;

    expect(registry.repos[repoFingerprint]?.desired_state).toEqual([
      { bundle: "react-expert", protocol: "https" },
    ]);
    expect(
      fs.readFileSync(path.join(repoRoot, ".cursor", "skills", "react", "SKILL.md"), "utf8"),
    ).toBe("# react\n");
    expect(
      fs.readFileSync(path.join(linkedWorktree, ".claude", "skills", "react", "SKILL.md"), "utf8"),
    ).toBe("# react\n");
    expect(
      fs.readFileSync(path.join(linkedWorktree, ".cursor", "skills", "react", "SKILL.md"), "utf8"),
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
    await run(["add", remoteSource.source, remoteSource.bundle, "--agent", "claude-code"], { homeDir, cwd: repoRoot });
    runGit(remoteSource.remoteRepoPath, ["branch", "stable"]);
    const registryFile = path.join(homeDir, ".skul", "registry.json");
    const repoFingerprint = detectGitContext({ cwd: repoRoot })!.repoFingerprint;
    const registryWithRef = readRegistryFile(registryFile);

    writeRegistryFile(
      registryFile,
      upsertRepoState(registryWithRef, repoFingerprint, {
        repo_root: repoRoot,
        desired_state: [{
          ...registryWithRef.repos[repoFingerprint]!.desired_state[0]!,
          ref: "stable",
        }],
      }),
    );

    // When
    await expect(run(["add", "react-expert"], { homeDir, cwd: repoRoot })).resolves.toBe(
      "Applied react-expert for claude-code, cursor",
    );

    // Then
    const registry = readRegistryFile(registryFile);
    const repoEntry = registry.repos[repoFingerprint]!;
    const worktreeEntry = registry.worktrees[detectGitContext({ cwd: repoRoot })!.worktreeId]!;

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
    expect(worktreeEntry.materialized_state.bundles["react-expert"]).toMatchObject({
      source: remoteSource.source,
      resolved_commit: remoteSource.initialCommit,
    });
    await expect(run(["check"], { homeDir, cwd: repoRoot })).resolves.toBe("react-expert: up-to-date");
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
    await run(["add", remoteSourceA.source, remoteSourceA.bundle], { homeDir, cwd: repoRoot });
    const registryFile = path.join(homeDir, ".skul", "registry.json");
    const repoFingerprint = detectGitContext({ cwd: repoRoot })!.repoFingerprint;
    const registryWithRef = readRegistryFile(registryFile);

    writeRegistryFile(
      registryFile,
      upsertRepoState(registryWithRef, repoFingerprint, {
        repo_root: repoRoot,
        desired_state: [{
          ...registryWithRef.repos[repoFingerprint]!.desired_state[0]!,
          ref: "stable",
        }],
      }),
    );

    // When
    await expect(run(["add", remoteSourceB.source, remoteSourceB.bundle], { homeDir, cwd: repoRoot })).resolves.toBe(
      "Applied react-expert for claude-code",
    );

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

  it("resets all materialized bundles from the current worktree", async () => {
    // Given: two bundles targeting different tools
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
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
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });
    await run(["add", "repo-standards"], { homeDir, cwd: repoRoot });

    // When
    await expect(run(["reset"], { homeDir, cwd: repoRoot })).resolves.toMatch(/Reset/i);

    // Then: all files from both bundles are removed
    expect(pathExists(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"))).toBe(false);
    expect(pathExists(path.join(repoRoot, ".agents", "skills", "next-task", "SKILL.md"))).toBe(false);
  });

  it("removes a named bundle and its managed files from the current worktree", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" }, commands: { path: ".claude/commands" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/commands/review.md", "# review\n");
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });

    // When
    await expect(run(["remove", "react-expert"], { homeDir, cwd: repoRoot })).resolves.toBe(
      "Removed react-expert",
    );

    // Then: managed files are deleted
    expect(pathExists(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"))).toBe(false);
    expect(pathExists(path.join(repoRoot, ".claude", "commands", "review.md"))).toBe(false);

    // Then: git exclude block is removed
    expect(fs.readFileSync(path.join(repoRoot, ".git", "info", "exclude"), "utf8")).not.toContain(
      "# >>> SKUL START",
    );

    // Then: registry is updated
    const registry = readRegistryFile(path.join(homeDir, ".skul", "registry.json"));
    expect(registry.worktrees).toEqual({});
    expect(registry.repos[detectGitContext({ cwd: repoRoot })!.repoFingerprint]?.desired_state).toEqual([]);
  });

  it("removes a specific bundle without disturbing other materialized bundles", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
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
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });
    await run(["add", "repo-standards"], { homeDir, cwd: repoRoot });

    // When
    await expect(run(["remove", "react-expert"], { homeDir, cwd: repoRoot })).resolves.toBe(
      "Removed react-expert",
    );

    // Then: only react-expert's files are removed; repo-standards files remain
    expect(pathExists(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"))).toBe(false);
    expect(fs.readFileSync(path.join(repoRoot, ".agents", "skills", "next-task", "SKILL.md"), "utf8")).toBe(
      "# next task\n",
    );

    // Then: exclude block retains repo-standards files only
    const excludeFile = fs.readFileSync(path.join(repoRoot, ".git", "info", "exclude"), "utf8");
    expect(excludeFile).not.toContain(".claude/skills/react/SKILL.md");
    expect(excludeFile).toContain(".agents/skills/next-task/SKILL.md");

    // Then: registry reflects only repo-standards
    const registry = readRegistryFile(path.join(homeDir, ".skul", "registry.json"));
    const repoFingerprint = detectGitContext({ cwd: repoRoot })!.repoFingerprint;
    expect(registry.repos[repoFingerprint]?.desired_state).toEqual([{ bundle: "repo-standards", protocol: "https" }]);
    const worktree = registry.worktrees[Object.keys(registry.worktrees)[0]];
    expect(worktree.materialized_state.bundles).not.toHaveProperty("react-expert");
    expect(worktree.materialized_state.bundles).toHaveProperty("repo-standards");
  });

  it("prompts before removing a modified managed file and aborts when the user declines", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });
    fs.writeFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "# modified\n");

    // When / Then
    await expect(
      run(["remove", "react-expert"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          confirmManagedFileRemoval: async () => false,
        }),
      }),
    ).rejects.toThrowError(/Removal aborted because a modified managed file was kept/);
    expect(fs.readFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "utf8")).toBe(
      "# modified\n",
    );
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
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    // Add (and materialize) from the main worktree
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });
    // Create a linked worktree that has not materialized react-expert
    const linkedWorktree = createLinkedWorktree(repoRoot);

    // When: remove from the linked worktree where nothing is materialized
    await expect(run(["remove", "react-expert"], { homeDir, cwd: linkedWorktree })).resolves.toBe(
      "Removed react-expert",
    );

    // Then: desired_state is cleared; no crash even though no files were on disk
    const registry = readRegistryFile(path.join(homeDir, ".skul", "registry.json"));
    const repoFingerprint = detectGitContext({ cwd: repoRoot })!.repoFingerprint;
    expect(registry.repos[repoFingerprint]?.desired_state).toEqual([]);
  });

  it("throws when the named bundle is not in the active set", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    // When / Then
    await expect(run(["remove", "nonexistent-bundle"], { homeDir, cwd: repoRoot })).rejects.toThrowError(
      /Bundle not found in active set: nonexistent-bundle/,
    );
  });

  it("surfaces a clear error when remove runs outside a Git repository", async () => {
    // Given
    const homeDir = createHomeDir();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skul-non-git-"));
    tempDirs.push(cwd);

    // When / Then
    await expect(run(["remove", "react-expert"], { homeDir, cwd })).rejects.toThrowError(
      /skul remove requires a Git repository/,
    );
  });

  it("rejects --agent names that are not supported by the bundle", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");

    // When / Then
    await expect(
      run(["add", "react-expert", "--agent", "cursor"], { homeDir, cwd: repoRoot }),
    ).rejects.toThrowError(/Bundle does not support agent\(s\): cursor[\s\S]*Supported agents: claude-code/i);
  });

  it("lists bundles with their supported tools", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } }, cursor: { skills: { path: ".cursor/skills" } } },
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "repo-standards", {
      name: "repo-standards",
      tools: { codex: { skills: { path: ".agents/skills" } } },
    });

    // When / Then
    await expect(run(["list"], { homeDir })).resolves.toBe(
      renderBundleListOutput("react-expert (claude-code, cursor)", "repo-standards (codex)"),
    );
  });

  it("apply materializes all desired bundles into the current worktree", async () => {
    // Given: two bundles in desired state but neither materialized in this worktree
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const linkedWorktree = createLinkedWorktree(repoRoot);
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
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
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });
    await run(["add", "repo-standards"], { homeDir, cwd: repoRoot });

    // When: apply from linked worktree that has no materialized files
    await expect(
      run(["apply"], { homeDir, cwd: linkedWorktree }),
    ).resolves.toBe("Applied react-expert, repo-standards");

    // Then: both bundles' files are written into the linked worktree
    expect(
      fs.readFileSync(path.join(linkedWorktree, ".claude", "skills", "react", "SKILL.md"), "utf8"),
    ).toBe("# react\n");
    expect(
      fs.readFileSync(path.join(linkedWorktree, ".agents", "skills", "next-task", "SKILL.md"), "utf8"),
    ).toBe("# next task\n");

    // And the registry records the linked worktree's materialized state
    const registry = readRegistryFile(path.join(homeDir, ".skul", "registry.json"));
    const linkedCtx = detectGitContext({ cwd: linkedWorktree })!;
    const worktreeState = registry.worktrees[linkedCtx.worktreeId];
    expect(worktreeState).toBeDefined();
    expect(worktreeState.materialized_state.bundles).toHaveProperty("react-expert");
    expect(worktreeState.materialized_state.bundles).toHaveProperty("repo-standards");
  });

  it("apply is a no-op when all desired bundles are already materialized", async () => {
    // Given: bundle already materialized in the current worktree
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });

    // When
    await expect(run(["apply"], { homeDir, cwd: repoRoot })).resolves.toBe(
      "All bundles are already materialized",
    );
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
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
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
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });
    await run(["add", "repo-standards"], { homeDir, cwd: repoRoot });
    // Materialize only react-expert in the linked worktree
    await run(["add", "react-expert"], { homeDir, cwd: linkedWorktree });

    // When: apply should only materialize the missing bundle
    await expect(
      run(["apply"], { homeDir, cwd: linkedWorktree }),
    ).resolves.toBe("Applied repo-standards");

    // Then: both bundles are now present in the linked worktree
    expect(
      fs.readFileSync(path.join(linkedWorktree, ".claude", "skills", "react", "SKILL.md"), "utf8"),
    ).toBe("# react\n");
    expect(
      fs.readFileSync(path.join(linkedWorktree, ".agents", "skills", "next-task", "SKILL.md"), "utf8"),
    ).toBe("# next task\n");
  });

  it("apply reports no bundles configured when the repository has no desired state", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    // When / Then
    await expect(run(["apply"], { homeDir, cwd: repoRoot })).resolves.toBe(
      "No bundles configured for this repository",
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
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });
    const registryBefore = readRegistryFile(path.join(homeDir, ".skul", "registry.json"));
    const repoFingerprint = detectGitContext({ cwd: repoRoot })!.repoFingerprint;
    const desiredStateBefore = registryBefore.repos[repoFingerprint]?.desired_state;

    // When
    await run(["apply"], { homeDir, cwd: linkedWorktree });

    // Then: desired state is unchanged
    const registryAfter = readRegistryFile(path.join(homeDir, ".skul", "registry.json"));
    expect(registryAfter.repos[repoFingerprint]?.desired_state).toEqual(desiredStateBefore);
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
    await expect(run(["status"], { homeDir, cwd: repoRoot })).rejects.toThrowError(
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
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    writeManifest(homeDir, "github.com/user/ai-vault", "next-expert", {
      name: "next-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    // next-expert also writes to the same relative skill path, causing a cross-bundle conflict
    writeBundleFile(homeDir, "github.com/user/ai-vault", "next-expert", ".claude/skills/react/SKILL.md", "# next react\n");
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });

    const resolveFileConflict = vi.fn().mockResolvedValue({ action: "prefix", prefix: "next" });

    // When: add next-expert whose file conflicts with react-expert's managed file
    await expect(
      run(["add", "next-expert"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ resolveFileConflict }),
      }),
    ).resolves.toBe("Applied next-expert for claude-code");

    // Then: conflict callback was invoked for the conflicting path
    expect(resolveFileConflict).toHaveBeenCalledWith("react/SKILL.md", expect.any(String));

    // Then: react-expert's original file is preserved unchanged
    expect(fs.readFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "utf8")).toBe("# react\n");

    // Then: next-expert's file is written at the prefixed location
    expect(
      fs.readFileSync(path.join(repoRoot, ".claude", "skills", "next-react", "SKILL.md"), "utf8"),
    ).toBe("# next react\n");

    // Then: the registry records both bundles with their respective file paths
    const registry = readRegistryFile(path.join(homeDir, ".skul", "registry.json"));
    const worktree = registry.worktrees[Object.keys(registry.worktrees)[0]];
    expect(worktree.materialized_state).toMatchObject({
      bundles: {
        "react-expert": { tools: { "claude-code": { files: [".claude/skills/react/SKILL.md"] } } },
        "next-expert": { tools: { "claude-code": { files: [".claude/skills/next-react/SKILL.md"] } } },
      },
    });
  });

  it("cleans up Skul-created directories when removing the last managed file in them", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });
    expect(pathExists(path.join(repoRoot, ".claude", "skills", "react"))).toBe(true);

    // When
    await expect(run(["remove", "react-expert"], { homeDir, cwd: repoRoot })).resolves.toBe(
      "Removed react-expert",
    );

    // Then: managed file is removed
    expect(pathExists(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"))).toBe(false);

    // Then: all Skul-created directories are cleaned up (deepest first)
    expect(pathExists(path.join(repoRoot, ".claude", "skills", "react"))).toBe(false);
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
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    writeManifest(homeDir, "github.com/user/ai-vault", "next-expert", {
      name: "next-expert",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    // next-expert writes a different file under the same directory; no conflict occurs
    writeBundleFile(homeDir, "github.com/user/ai-vault", "next-expert", ".claude/skills/react/NEXT.md", "# next\n");
    await run(["add", "react-expert"], { homeDir, cwd: repoRoot });
    await run(["add", "next-expert"], { homeDir, cwd: repoRoot });

    // When: remove react-expert only
    await expect(run(["remove", "react-expert"], { homeDir, cwd: repoRoot })).resolves.toBe(
      "Removed react-expert",
    );

    // Then: react-expert's file is gone
    expect(pathExists(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"))).toBe(false);

    // Then: the shared directory still exists because next-expert owns a file in it
    expect(fs.readFileSync(path.join(repoRoot, ".claude", "skills", "react", "NEXT.md"), "utf8")).toBe("# next\n");
    expect(pathExists(path.join(repoRoot, ".claude", "skills", "react"))).toBe(true);

    // Then: registry still records next-expert; react-expert is gone from both desired and materialized state
    const registry = readRegistryFile(path.join(homeDir, ".skul", "registry.json"));
    const repoFingerprint = detectGitContext({ cwd: repoRoot })!.repoFingerprint;
    expect(registry.repos[repoFingerprint]?.desired_state).toEqual([{ bundle: "next-expert", protocol: "https" }]);
    const worktree = registry.worktrees[Object.keys(registry.worktrees)[0]];
    expect(worktree.materialized_state.bundles).not.toHaveProperty("react-expert");
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
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", ".claude/skills/react/SKILL.md", "# react\n");
    await run(["add", "react-expert", "--agent", "claude-code"], { homeDir, cwd: repoRoot });

    // When: apply in the linked worktree should honour the stored tool selection
    await expect(run(["apply"], { homeDir, cwd: linkedWorktree })).resolves.toBe("Applied react-expert");

    // Then: only claude-code files are present; cursor files are absent
    expect(
      fs.readFileSync(path.join(linkedWorktree, ".claude", "skills", "react", "SKILL.md"), "utf8"),
    ).toBe("# react\n");
    expect(pathExists(path.join(linkedWorktree, ".cursor", "skills", "react", "SKILL.md"))).toBe(false);

    // Then: registry for linked worktree records only claude-code
    const registry = readRegistryFile(path.join(homeDir, ".skul", "registry.json"));
    const linkedCtx = detectGitContext({ cwd: linkedWorktree })!;
    const worktreeState = registry.worktrees[linkedCtx.worktreeId];
    expect(worktreeState.materialized_state.bundles["react-expert"].tools).toMatchObject({
      "claude-code": { files: expect.arrayContaining([".claude/skills/react/SKILL.md"]) },
    });
    expect(worktreeState.materialized_state.bundles["react-expert"].tools).not.toHaveProperty("cursor");
  });
});

function createHomeDir(): string {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-home-"));
  tempDirs.push(homeDir);
  return homeDir;
}

function writeManifest(homeDir: string, source: string, bundle: string, manifest: object): void {
  const bundleDir = path.join(homeDir, ".skul", "library", ...source.split("/"), bundle);
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

function writeBundleFile(
  homeDir: string,
  source: string,
  bundle: string,
  relativePath: string,
  content: string,
): void {
  const filePath = path.join(homeDir, ".skul", "library", ...source.split("/"), bundle, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createRemoteBundleSource(
  homeDir: string,
  options: {
    source?: string;
    bundle: string;
    manifest: object;
    files: Record<string, string>;
  },
): {
  source: string;
  bundle: string;
  remoteRepoPath: string;
  initialCommit: string;
} {
  const source = options.source ?? "github.com/user/ai-vault";
  const remoteRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), "skul-remote-source-"));
  tempDirs.push(remoteRepoPath);

  runGit(remoteRepoPath, ["init", "--initial-branch=main"]);
  runGit(remoteRepoPath, ["config", "user.name", "Skul Remote"]);
  runGit(remoteRepoPath, ["config", "user.email", "skul-remote@example.com"]);
  runGit(remoteRepoPath, ["config", "commit.gpgsign", "false"]);

  const bundleDir = path.join(remoteRepoPath, options.bundle);
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, "manifest.json"), `${JSON.stringify(options.manifest, null, 2)}\n`);

  for (const [relativePath, content] of Object.entries(options.files)) {
    const targetPath = path.join(bundleDir, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content);
  }

  runGit(remoteRepoPath, ["add", "."]);
  runGit(remoteRepoPath, ["commit", "-m", "Initial bundle"]);

  const targetDir = path.join(homeDir, ".skul", "library", ...source.split("/"));
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  runGit(path.dirname(targetDir), ["clone", remoteRepoPath, targetDir]);

  return {
    source,
    bundle: options.bundle,
    remoteRepoPath,
    initialCommit: runGit(remoteRepoPath, ["rev-parse", "HEAD"]),
  };
}

function updateRemoteBundleSource(
  remoteRepoPath: string,
  bundle: string,
  files: Record<string, string>,
): string {
  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = path.join(remoteRepoPath, bundle, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content);
  }

  runGit(remoteRepoPath, ["add", "."]);
  runGit(remoteRepoPath, ["commit", "-m", "Update bundle"]);

  return runGit(remoteRepoPath, ["rev-parse", "HEAD"]);
}

function createRepository(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skul-repo-"));
  tempDirs.push(repoRoot);
  runGit(repoRoot, ["init", "--initial-branch=main"]);
  runGit(repoRoot, ["config", "user.name", "Skul Test"]);
  runGit(repoRoot, ["config", "user.email", "skul@example.com"]);
  runGit(repoRoot, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# test\n");
  runGit(repoRoot, ["add", "README.md"]);
  runGit(repoRoot, ["commit", "-m", "init"]);
  return repoRoot;
}

function createLinkedWorktree(repoRoot: string): string {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-linked-worktree-"));
  const worktreeRoot = path.join(parentDir, "linked-worktree");
  tempDirs.push(parentDir);
  runGit(repoRoot, ["worktree", "add", worktreeRoot]);
  return worktreeRoot;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function pathExists(targetPath: string): boolean {
  return fs.existsSync(targetPath);
}

function createPromptClientStub(overrides: Partial<PromptClient> = {}): PromptClient {
  return {
    selectBundle: async () => "react-expert",
    resolveFileConflict: async () => ({ action: "prefix", prefix: "p" }),
    confirmManagedFileRemoval: async () => true,
    ...overrides,
  };
}

function renderBundleListOutput(...lines: string[]): string {
  return ["Available Bundles", "", ...lines].join("\n");
}
