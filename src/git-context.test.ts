import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectGitContext } from "./git-context";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("detectGitContext", () => {
  it("returns null outside a git repository", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skul-git-context-"));
    tempDirs.push(cwd);

    expect(detectGitContext({ cwd })).toBeNull();
  });

  it("detects the main worktree for a repository", () => {
    const repoRoot = createRepository();
    const normalizedRepoRoot = fs.realpathSync.native(repoRoot);

    const context = detectGitContext({ cwd: repoRoot });

    expect(context).toMatchObject({
      repoRoot: normalizedRepoRoot,
      worktreeRoot: normalizedRepoRoot,
      gitDir: path.join(normalizedRepoRoot, ".git"),
      gitCommonDir: path.join(normalizedRepoRoot, ".git"),
      isWorktree: false,
    });
    expect(context?.repoFingerprint).toMatch(/^repo_/);
    expect(context?.worktreeId).toMatch(/^worktree_/);
  });

  it("uses one repository fingerprint across linked worktrees and unique worktree ids", () => {
    const repoRoot = createRepository();
    const worktreeParent = fs.mkdtempSync(path.join(os.tmpdir(), "skul-worktree-"));
    const worktreeRoot = path.join(worktreeParent, "linked-worktree");
    const normalizedRepoRoot = fs.realpathSync.native(repoRoot);
    tempDirs.push(worktreeParent);

    runGit(repoRoot, ["worktree", "add", worktreeRoot]);

    const main = detectGitContext({ cwd: repoRoot });
    const linked = detectGitContext({ cwd: worktreeRoot });
    const normalizedWorktreeRoot = fs.realpathSync.native(worktreeRoot);

    expect(main).not.toBeNull();
    expect(linked).not.toBeNull();
    expect(linked).toMatchObject({
      repoRoot: normalizedRepoRoot,
      worktreeRoot: normalizedWorktreeRoot,
      gitCommonDir: path.join(normalizedRepoRoot, ".git"),
      isWorktree: true,
    });
    expect(linked?.repoFingerprint).toBe(main?.repoFingerprint);
    expect(linked?.worktreeId).not.toBe(main?.worktreeId);
  });
});

function createRepository(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skul-repo-"));
  tempDirs.push(cwd);

  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.name", "Skul Test"]);
  runGit(cwd, ["config", "user.email", "skul@example.com"]);
  runGit(cwd, ["config", "commit.gpgsign", "false"]);

  fs.writeFileSync(path.join(cwd, "README.md"), "# test\n");
  runGit(cwd, ["add", "README.md"]);
  runGit(cwd, ["commit", "-m", "init"]);

  return cwd;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
