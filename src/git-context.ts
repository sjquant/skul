import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface GitContext {
  repoRoot: string;
  worktreeRoot: string;
  gitDir: string;
  gitCommonDir: string;
  isWorktree: boolean;
  repoFingerprint: string;
  worktreeId: string;
}

export interface DetectGitContextOptions {
  cwd: string;
}

export function detectGitContext(options: DetectGitContextOptions): GitContext | null {
  const worktreeRoot = gitRevParse(options.cwd, ["--show-toplevel"]);

  if (!worktreeRoot) {
    return null;
  }

  const gitDir = gitRevParse(options.cwd, ["--git-dir"]);
  const gitCommonDir = gitRevParse(options.cwd, ["--git-common-dir"]);

  if (!gitDir || !gitCommonDir) {
    return null;
  }

  const normalizedWorktreeRoot = fs.realpathSync.native(worktreeRoot);
  const normalizedGitDir = fs.realpathSync.native(gitDir);
  const normalizedGitCommonDir = fs.realpathSync.native(gitCommonDir);
  const repoRoot =
    path.basename(normalizedGitCommonDir) === ".git"
      ? fs.realpathSync.native(path.dirname(normalizedGitCommonDir))
      : normalizedWorktreeRoot;

  return {
    repoRoot,
    worktreeRoot: normalizedWorktreeRoot,
    gitDir: normalizedGitDir,
    gitCommonDir: normalizedGitCommonDir,
    isWorktree: normalizedGitDir !== normalizedGitCommonDir,
    repoFingerprint: `repo_${fingerprint(normalizedGitCommonDir)}`,
    worktreeId: `worktree_${fingerprint(normalizedWorktreeRoot)}`,
  };
}

function gitRevParse(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--path-format=absolute", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
