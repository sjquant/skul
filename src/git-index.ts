import { execFileSync } from "node:child_process";
import path from "node:path";

export interface GitIndexStageEntry {
  mode: string;
  objectId: string;
  stage: number;
  path: string;
}

export interface GitHeadBlob {
  objectId: string;
  content: string;
}

export function isTrackedGitPath(options: { repoRoot: string; filePath: string }): boolean {
  return inspectGitIndexStages(options).length > 0 || readGitHeadBlob(options) !== null;
}

export function readGitHeadBlob(options: { repoRoot: string; filePath: string }): GitHeadBlob | null {
  const repoRelativePath = normalizeRepoRelativePath(options.filePath);
  const objectId = tryRunGit(options.repoRoot, ["rev-parse", `HEAD:${repoRelativePath}`])?.trim();

  if (!objectId) {
    return null;
  }

  return {
    objectId,
    content: runGit(options.repoRoot, ["show", `HEAD:${repoRelativePath}`]),
  };
}

export function inspectGitIndexStages(options: { repoRoot: string; filePath: string }): GitIndexStageEntry[] {
  const repoRelativePath = normalizeRepoRelativePath(options.filePath);
  const output = runGit(options.repoRoot, ["ls-files", "-s", "--", repoRelativePath]);

  if (output.trim() === "") {
    return [];
  }

  return output
    .trim()
    .split("\n")
    .map(parseGitIndexStageEntry);
}

export function readGitIndexFlags(options: { repoRoot: string; filePath: string }): string[] {
  const repoRelativePath = normalizeRepoRelativePath(options.filePath);
  const output = runGit(options.repoRoot, ["ls-files", "-v", "--", repoRelativePath]);

  if (output.trim() === "") {
    return [];
  }

  return output
    .trim()
    .split("\n")
    .map(parseGitIndexFlag);
}

export function setGitSkipWorktree(options: { repoRoot: string; filePath: string }): void {
  const repoRelativePath = normalizeRepoRelativePath(options.filePath);
  runGit(options.repoRoot, ["update-index", "--skip-worktree", "--", repoRelativePath]);
}

export function clearGitSkipWorktree(options: { repoRoot: string; filePath: string }): void {
  const repoRelativePath = normalizeRepoRelativePath(options.filePath);
  runGit(options.repoRoot, ["update-index", "--no-skip-worktree", "--", repoRelativePath]);
}

function normalizeRepoRelativePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function parseGitIndexStageEntry(line: string): GitIndexStageEntry {
  const match = line.match(/^(\d+) ([0-9a-f]+) (\d+)\t(.+)$/);

  if (!match) {
    throw new Error(`Unable to parse git index stage entry: ${line}`);
  }

  return {
    mode: match[1],
    objectId: match[2],
    stage: Number(match[3]),
    path: match[4],
  };
}

function parseGitIndexFlag(line: string): string {
  const match = line.match(/^([A-Za-z]) /);

  if (!match) {
    throw new Error(`Unable to parse git index flag entry: ${line}`);
  }

  return match[1];
}

function runGit(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tryRunGit(repoRoot: string, args: string[]): string | null {
  try {
    return runGit(repoRoot, args);
  } catch {
    return null;
  }
}
