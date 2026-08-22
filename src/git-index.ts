import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * A single `git ls-files -s` entry for one path in the index.
 *
 * Stage `0` means a normal tracked entry. Stages `1`, `2`, and `3` indicate
 * an unmerged path with base/ours/theirs entries present in the index.
 */
export interface GitIndexStageEntry {
  mode: string;
  objectId: string;
  stage: number;
  path: string;
}

/**
 * The blob currently recorded for a path in `HEAD`.
 */
export interface GitHeadBlob {
  objectId: string;
  content: string;
}

/**
 * Reasons that make a tracked root-instruction target unsafe to shadow.
 */
export type TrackedShadowSafetyIssue =
  | "unmerged"
  | "missing-head"
  | "staged-changes"
  | "unstaged-changes"
  | "incompatible-index-flags";

/**
 * Aggregated Git state used to decide whether Skul may create or refresh a
 * tracked root-instruction shadow such as `AGENTS.md` or `CLAUDE.md`.
 */
export interface TrackedShadowSafetyInspection {
  /**
   * Whether the target is tracked by Git through either the index or `HEAD`.
   */
  tracked: boolean;
  /**
   * Raw index stage entries for the target path.
   */
  stageEntries: GitIndexStageEntry[];
  /**
   * The blob currently stored in `HEAD`, if any.
   */
  headBlob: GitHeadBlob | null;
  /**
   * Single-letter flags reported by `git ls-files -v`.
   */
  indexFlags: string[];
  /**
   * Normalized refusal reasons derived from the current Git state.
   */
  issues: TrackedShadowSafetyIssue[];
}

/**
 * Returns whether a path should be treated as Git-tracked for shadow-safety
 * purposes.
 *
 * A path is considered tracked when it exists either in the current index or
 * in `HEAD`, including staged deletions where only the `HEAD` blob remains.
 */
export function isTrackedGitPath(options: {
  repoRoot: string;
  filePath: string;
}): boolean {
  return (
    inspectGitIndexStages(options).length > 0 ||
    readGitHeadBlob(options) !== null
  );
}

/**
 * Inspects the Git state of a root-instruction target and summarizes whether
 * Skul may safely create or refresh a tracked shadow for it.
 */
export function inspectTrackedShadowTarget(options: {
  repoRoot: string;
  filePath: string;
}): TrackedShadowSafetyInspection {
  const stageEntries = inspectGitIndexStages(options);
  const headBlob = readGitHeadBlob(options);
  const indexFlags = readGitIndexFlags(options);
  const tracked = stageEntries.length > 0 || headBlob !== null;

  if (!tracked) {
    return {
      tracked: false,
      stageEntries,
      headBlob,
      indexFlags,
      issues: [],
    };
  }

  const issues: TrackedShadowSafetyIssue[] = [];

  if (hasUnmergedEntries(stageEntries)) {
    issues.push("unmerged");
  }

  if (!headBlob) {
    issues.push("missing-head");
  }

  if (
    !issues.includes("unmerged") &&
    hasStagedChanges(options.repoRoot, options.filePath)
  ) {
    issues.push("staged-changes");
  }

  if (
    !issues.includes("unmerged") &&
    hasUnstagedChanges(options.repoRoot, options.filePath)
  ) {
    issues.push("unstaged-changes");
  }

  if (hasIncompatibleIndexFlags(indexFlags)) {
    issues.push("incompatible-index-flags");
  }

  return {
    tracked,
    stageEntries,
    headBlob,
    indexFlags,
    issues,
  };
}

/**
 * Reads the blob stored for a path in `HEAD`.
 *
 * Returns `null` when the path has no `HEAD` entry, such as an index-only path
 * that has been staged without ever being committed.
 */
export function readGitHeadBlob(options: {
  repoRoot: string;
  filePath: string;
}): GitHeadBlob | null {
  const repoRelativePath = normalizeRepoRelativePath(options.filePath);
  const objectId = tryRunGit(options.repoRoot, [
    "rev-parse",
    `HEAD:${repoRelativePath}`,
  ])?.trim();

  if (!objectId) {
    return null;
  }

  return {
    objectId,
    content: runGit(options.repoRoot, ["show", `HEAD:${repoRelativePath}`]),
  };
}

/**
 * Returns all index stage entries for a path.
 */
export function inspectGitIndexStages(options: {
  repoRoot: string;
  filePath: string;
}): GitIndexStageEntry[] {
  const repoRelativePath = normalizeRepoRelativePath(options.filePath);
  const output = runGit(options.repoRoot, [
    "ls-files",
    "-s",
    "--",
    repoRelativePath,
  ]);

  if (output.trim() === "") {
    return [];
  }

  return output.trim().split("\n").map(parseGitIndexStageEntry);
}

/**
 * Returns the `git ls-files -v` flags for a path.
 */
export function readGitIndexFlags(options: {
  repoRoot: string;
  filePath: string;
}): string[] {
  const repoRelativePath = normalizeRepoRelativePath(options.filePath);
  const output = runGit(options.repoRoot, [
    "ls-files",
    "-v",
    "--",
    repoRelativePath,
  ]);

  if (output.trim() === "") {
    return [];
  }

  return output.trim().split("\n").map(parseGitIndexFlag);
}

/**
 * Marks a tracked path as `skip-worktree`.
 */
export function setGitSkipWorktree(options: {
  repoRoot: string;
  filePath: string;
}): void {
  const repoRelativePath = normalizeRepoRelativePath(options.filePath);
  runGit(options.repoRoot, [
    "update-index",
    "--skip-worktree",
    "--",
    repoRelativePath,
  ]);
}

/**
 * Clears the `skip-worktree` flag from a tracked path.
 */
export function clearGitSkipWorktree(options: {
  repoRoot: string;
  filePath: string;
}): void {
  const repoRelativePath = normalizeRepoRelativePath(options.filePath);
  runGit(options.repoRoot, [
    "update-index",
    "--no-skip-worktree",
    "--",
    repoRelativePath,
  ]);
}

function hasUnmergedEntries(stageEntries: GitIndexStageEntry[]): boolean {
  return stageEntries.some((entry) => entry.stage !== 0);
}

function hasStagedChanges(repoRoot: string, filePath: string): boolean {
  return (
    gitCommandExitCode(repoRoot, [
      "diff",
      "--cached",
      "--quiet",
      "--",
      normalizeRepoRelativePath(filePath),
    ]) === 1
  );
}

function hasUnstagedChanges(repoRoot: string, filePath: string): boolean {
  return (
    gitCommandExitCode(repoRoot, [
      "diff",
      "--quiet",
      "--",
      normalizeRepoRelativePath(filePath),
    ]) === 1
  );
}

function hasIncompatibleIndexFlags(indexFlags: string[]): boolean {
  return indexFlags.some((flag) => flag !== "H" && flag !== "S");
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

function gitCommandExitCode(repoRoot: string, args: string[]): number {
  try {
    execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return 0;
  } catch (error) {
    if (
      error instanceof Error &&
      "status" in error &&
      typeof error.status === "number"
    ) {
      return error.status;
    }

    throw error;
  }
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
