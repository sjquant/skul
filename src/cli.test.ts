import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseCliArgs } from "./cli";
import { run } from "./index";
import { readRegistryFile } from "./registry";

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
    const cleanArgs = ["clean"];

    // When / Then
    await expect(parseCliArgs(listArgs)).resolves.toEqual({ kind: "command", command: "list" });
    await expect(parseCliArgs(statusArgs)).resolves.toEqual({ kind: "command", command: "status" });
    await expect(parseCliArgs(cleanArgs)).resolves.toEqual({ kind: "command", command: "clean" });
  });

  it("parses use in interactive, cached, and explicit source modes", async () => {
    // Given
    const selectBundle = vi.fn().mockResolvedValue("react-expert");

    // When / Then
    await expect(parseCliArgs([], { selectBundle })).resolves.toEqual({ kind: "help" });

    await expect(parseCliArgs(["use"], { selectBundle })).resolves.toEqual({
      kind: "command",
      command: "use",
      options: { mode: "stealth", bundle: "react-expert" },
    });
    expect(selectBundle).toHaveBeenCalledWith();

    await expect(parseCliArgs(["use", "react-expert"])).resolves.toEqual({
      kind: "command",
      command: "use",
      options: { mode: "stealth", bundle: "react-expert" },
    });

    await expect(parseCliArgs(["use", "github.com/user/ai-vault", "react-expert"])).resolves.toEqual({
      kind: "command",
      command: "use",
      options: {
        mode: "stealth",
        source: "github.com/user/ai-vault",
        bundle: "react-expert",
      },
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
    await expect(parseCliArgs(["clean", "extra"])).rejects.toThrowError(
      /Command clean does not accept positional arguments/,
    );
    await expect(parseCliArgs(["use", "a", "b", "c"])).rejects.toThrowError(
      /Command use accepts at most 2 positional arguments/,
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
      tool: "codex",
      targets: { skills: { path: "skills" } },
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tool: "claude-code",
      targets: { skills: { path: "skills" } },
    });

    // When / Then
    await expect(run(["list"], { homeDir })).resolves.toBe(renderBundleListOutput("react-expert", "repo-standards"));
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
      tool: "claude-code",
      targets: { skills: { path: "skills" } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");

    // When
    await expect(run(["use", "react-expert"], { homeDir, cwd: repoRoot })).resolves.toBe(
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

  it("replaces the previous bundle for the same tool before applying the new one", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tool: "claude-code",
      targets: { skills: { path: "skills" }, commands: { path: "commands" } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "skills/react/SKILL.md", "# react\n");
    writeBundleFile(homeDir, "github.com/user/ai-vault", "react-expert", "commands/review.md", "# review\n");
    writeManifest(homeDir, "github.com/user/ai-vault", "next-expert", {
      name: "next-expert",
      tool: "claude-code",
      targets: { skills: { path: "skills" } },
    });
    writeBundleFile(homeDir, "github.com/user/ai-vault", "next-expert", "skills/next/SKILL.md", "# next\n");
    await run(["use", "react-expert"], { homeDir, cwd: repoRoot });

    // When
    await expect(run(["use", "next-expert"], { homeDir, cwd: repoRoot })).resolves.toBe(
      "Applied next-expert for claude-code",
    );

    // Then
    expect(pathExists(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"))).toBe(false);
    expect(pathExists(path.join(repoRoot, ".claude", "commands", "review.md"))).toBe(false);
    expect(fs.readFileSync(path.join(repoRoot, ".claude", "skills", "next", "SKILL.md"), "utf8")).toBe(
      "# next\n",
    );
    const excludeFile = fs.readFileSync(path.join(repoRoot, ".git", "info", "exclude"), "utf8");
    expect(excludeFile).toContain(
      ["# >>> SKUL START", ".claude/skills/next/SKILL.md", "# <<< SKUL END"].join("\n"),
    );
    expect(excludeFile).not.toContain(".claude/skills/react/SKILL.md");
    expect(excludeFile).not.toContain(".claude/commands/review.md");

    const registry = readRegistryFile(path.join(homeDir, ".skul", "registry.json"));
    const worktree = registry.worktrees[Object.keys(registry.worktrees)[0]];
    expect(worktree.materialized_state).toMatchObject({
      tool: "claude-code",
      bundle: "next-expert",
      files: [".claude/skills/next/SKILL.md"],
    });
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
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# test\n");
  runGit(repoRoot, ["add", "README.md"]);
  runGit(repoRoot, ["commit", "-m", "init"]);
  return repoRoot;
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

function renderBundleListOutput(...lines: string[]): string {
  return ["Available Bundles", "", ...lines].join("\n");
}
