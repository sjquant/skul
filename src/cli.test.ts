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
    const resetArgs = ["reset"];
    const applyArgs = ["apply"];

    // When / Then
    await expect(parseCliArgs(listArgs)).resolves.toEqual({ kind: "command", command: "list" });
    await expect(parseCliArgs(statusArgs)).resolves.toEqual({ kind: "command", command: "status" });
    await expect(parseCliArgs(resetArgs)).resolves.toEqual({ kind: "command", command: "reset" });
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
      options: { mode: "stealth", bundle: "react-expert", tools: [] },
    });
    expect(selectBundle).toHaveBeenCalledWith();

    await expect(parseCliArgs(["add", "react-expert"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: { mode: "stealth", bundle: "react-expert", tools: [] },
    });

    await expect(parseCliArgs(["add", "github.com/user/ai-vault", "react-expert"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        mode: "stealth",
        source: "github.com/user/ai-vault",
        bundle: "react-expert",
        tools: [],
      },
    });
  });

  it("parses --tool flag as a single selected tool", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["add", "react-expert", "--tool", "claude-code"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: { mode: "stealth", bundle: "react-expert", tools: ["claude-code"] },
    });
  });

  it("collects multiple --tool flags into an array", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs(["add", "react-expert", "--tool", "claude-code", "--tool", "cursor"]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: { mode: "stealth", bundle: "react-expert", tools: ["claude-code", "cursor"] },
    });
  });

  it("parses remove with a required bundle argument", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["remove", "react-expert"])).resolves.toEqual({
      kind: "command",
      command: "remove",
      options: { bundle: "react-expert" },
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
      tools: { codex: { skills: { path: "skills" } } },
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: "skills" } } },
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

  it("applies a cached bundle into the current repository and records ownership", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");

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
      tools: { "claude-code": { skills: { path: "skills" }, commands: { path: "commands" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "commands/review.md", "# review\n");
    writeManifest(homeDir, "github.com/user/ai-vault", "next-expert", {
      name: "next-expert",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "next-expert", "skills/next/SKILL.md", "# next\n");
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
      tools: { "claude-code": { skills: { path: "skills" }, commands: { path: "commands" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "commands/review.md", "# review\n");
    writeManifest(homeDir, "github.com/user/ai-vault", "repo-standards", {
      name: "repo-standards",
      tools: { codex: { skills: { path: "skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "repo-standards",
      "skills/next-task/SKILL.md",
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
      expect.arrayContaining([{ bundle: "react-expert" }, { bundle: "repo-standards" }]),
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
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
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
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
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
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
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
      tools: { "claude-code": { skills: { path: "skills" }, commands: { path: "commands" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "commands/review.md", "# review\n");
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
      desired_state: [{ bundle: "react-expert" }],
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
        'Suggested Action: run "skul add"',
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
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
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
        'Suggested Action: run "skul add"',
      ].join("\n"),
    );
  });

  it("reports missing when the Skul exclude block was removed manually", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
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
      tools: { "claude-code": { skills: { path: "skills" }, commands: { path: "commands" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "commands/review.md", "# review\n");
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
      { bundle: "react-expert" },
    ]);
  });

  it("prompts before resetting a modified managed file and aborts when the user declines", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
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
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
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
      tools: { "claude-code": { skills: { path: "skills" } }, codex: { skills: { path: "skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
    await run(["add", "react-expert", "--tool", "claude-code"], { homeDir, cwd: repoRoot });
    fs.writeFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "# modified\n");

    // When / Then: re-adding the same bundle+tool should prompt and abort
    await expect(
      run(["add", "react-expert", "--tool", "claude-code"], {
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
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "repo-standards", {
      name: "repo-standards",
      tools: { codex: { skills: { path: "skills" } } },
    });

    // When / Then
    await expect(run(["add", "missing-bundle"], { homeDir, cwd: repoRoot })).rejects.toThrowError(
      /Bundle not found: missing-bundle[\s\S]*Available bundles:[\s\S]*react-expert[\s\S]*repo-standards/i,
    );
  });

  it("applies only the selected tool when --tool is specified", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: {
        "claude-code": { skills: { path: "skills" } },
        cursor: { skills: { path: "skills" } },
      },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");

    // When
    await expect(
      run(["add", "react-expert", "--tool", "claude-code"], { homeDir, cwd: repoRoot }),
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

  it("applies multiple selected tools when multiple --tool flags are provided", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: {
        "claude-code": { skills: { path: "skills" } },
        cursor: { skills: { path: "skills" } },
        codex: { skills: { path: "skills" } },
      },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");

    // When
    await expect(
      run(["add", "react-expert", "--tool", "claude-code", "--tool", "cursor"], {
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
        "claude-code": { skills: { path: "skills" } },
        cursor: { skills: { path: "skills" } },
      },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
    await run(["add", "react-expert", "--tool", "claude-code"], { homeDir, cwd: repoRoot });

    // When: add cursor tool to the same bundle
    await expect(
      run(["add", "react-expert", "--tool", "cursor"], { homeDir, cwd: repoRoot }),
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
    const worktree = registry.worktrees[Object.keys(registry.worktrees)[0]];
    expect(worktree.materialized_state.bundles["react-expert"].tools).toMatchObject({
      "claude-code": { files: [".claude/skills/react/SKILL.md"] },
      cursor: { files: [".cursor/skills/react/SKILL.md"] },
    });
  });

  it("resets all materialized bundles from the current worktree", async () => {
    // Given: two bundles targeting different tools
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
    writeManifest(homeDir, "github.com/user/ai-vault", "repo-standards", {
      name: "repo-standards",
      tools: { codex: { skills: { path: "skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "repo-standards",
      "skills/next-task/SKILL.md",
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
      tools: { "claude-code": { skills: { path: "skills" }, commands: { path: "commands" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "commands/review.md", "# review\n");
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
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
    writeManifest(homeDir, "github.com/user/ai-vault", "repo-standards", {
      name: "repo-standards",
      tools: { codex: { skills: { path: "skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "repo-standards",
      "skills/next-task/SKILL.md",
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
    expect(registry.repos[repoFingerprint]?.desired_state).toEqual([{ bundle: "repo-standards" }]);
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
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
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
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
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

  it("rejects --tool names that are not supported by the bundle", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");

    // When / Then
    await expect(
      run(["add", "react-expert", "--tool", "cursor"], { homeDir, cwd: repoRoot }),
    ).rejects.toThrowError(/Bundle does not support tool\(s\): cursor[\s\S]*Supported tools: claude-code/i);
  });

  it("lists bundles with their supported tools", async () => {
    // Given
    const homeDir = createHomeDir();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: "skills" } }, cursor: { skills: { path: "skills" } } },
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "repo-standards", {
      name: "repo-standards",
      tools: { codex: { skills: { path: "skills" } } },
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
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
    writeManifest(homeDir, "github.com/user/ai-vault", "repo-standards", {
      name: "repo-standards",
      tools: { codex: { skills: { path: "skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "repo-standards",
      "skills/next-task/SKILL.md",
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
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
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
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
    writeManifest(homeDir, "github.com/user/ai-vault", "repo-standards", {
      name: "repo-standards",
      tools: { codex: { skills: { path: "skills" } } },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "repo-standards",
      "skills/next-task/SKILL.md",
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
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
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
