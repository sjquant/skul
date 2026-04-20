import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface FetchRemoteSourceOptions {
  /** Normalized source identifier, e.g. "github.com/owner/repo" */
  source: string;
  libraryDir: string;
  /** Transport protocol to use when cloning. Defaults to "https". */
  protocol?: "https" | "ssh";
}

export interface FetchRemoteSourceResult {
  /** true if a fresh clone was performed; false if the cache already existed */
  cloned: boolean;
  targetDir: string;
}

export interface ClearCachedSourceResult {
  cleared: boolean;
  targetDir: string;
}

export interface ClearAllCachedSourcesResult {
  clearedSources: string[];
}

export interface CachedSourceRevision {
  cached: boolean;
  targetDir: string;
  currentCommit?: string;
  currentRef?: string;
  remoteUrl?: string;
}

export interface RemoteSourceStatus extends CachedSourceRevision {
  remoteCommit: string;
  refKind: "branch" | "tag" | "commit";
  resolvedRef?: string;
}

export interface UpdateCachedRemoteSourceResult extends RemoteSourceStatus {
  previousCommit?: string;
  updated: boolean;
}

const SAFE_SOURCE_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
const SSH_AUTH_FAILURE_RE =
  /permission denied|could not read from remote repository|host key verification failed/i;

/**
 * Ensures a remote git source is present in the local library cache.
 * If the target directory already exists the operation is a no-op (returns cloned: false).
 * Otherwise the repo is shallow-cloned into libraryDir/host/owner/repo using
 * HTTPS (default) or SSH when protocol is "ssh".
 */
export function fetchRemoteSource(options: FetchRemoteSourceOptions): FetchRemoteSourceResult {
  const targetDir = getTargetDir(options);

  if (fs.existsSync(targetDir)) {
    return { cloned: false, targetDir };
  }

  const cloneUrl = getCloneUrl(options.source, options.protocol);

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });

  process.stderr.write(`Cloning ${cloneUrl}...\n`);

  try {
    runGit(["clone", "--depth=1", cloneUrl, targetDir]);
  } catch (error) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    throw normalizeGitError(error, `Failed to clone ${cloneUrl}`, {
      source: options.source,
      protocol: options.protocol,
    });
  }

  return { cloned: true, targetDir };
}

export function readCachedSourceRevision(options: FetchRemoteSourceOptions): CachedSourceRevision {
  const targetDir = getTargetDir(options);

  if (!fs.existsSync(targetDir)) {
    return { cached: false, targetDir };
  }

  return {
    cached: true,
    targetDir,
    currentCommit: tryRunGit(["-C", targetDir, "rev-parse", "HEAD"]),
    currentRef: normalizeCurrentRef(tryRunGit(["-C", targetDir, "symbolic-ref", "--quiet", "--short", "HEAD"])),
    remoteUrl: tryRunGit(["-C", targetDir, "remote", "get-url", "origin"]),
  };
}

export function inspectRemoteSource(
  options: FetchRemoteSourceOptions & { ref?: string },
): RemoteSourceStatus {
  const cached = readCachedSourceRevision(options);
  const remoteUrl = cached.remoteUrl ?? getCloneUrl(options.source, options.protocol);
  const resolvedRemote = resolveRemoteRef(remoteUrl, options.ref);

  return {
    ...cached,
    remoteCommit: resolvedRemote.commit,
    refKind: resolvedRemote.kind,
    ...(resolvedRemote.resolvedRef !== undefined
      ? { resolvedRef: resolvedRemote.resolvedRef }
      : {}),
  };
}

export function updateCachedRemoteSource(
  options: FetchRemoteSourceOptions & { ref?: string },
): UpdateCachedRemoteSourceResult {
  const initialRevision = readCachedSourceRevision(options);

  if (!initialRevision.cached) {
    fetchRemoteSource(options);
  }

  const targetDir = getTargetDir(options);
  const status = inspectRemoteSource(options);

  if (status.currentCommit === status.remoteCommit) {
    return {
      ...status,
      previousCommit: status.currentCommit,
      updated: false,
      currentCommit: status.remoteCommit,
    };
  }

  if (status.refKind === "branch") {
    runGit(["-C", targetDir, "fetch", "--depth=1", "origin", `refs/heads/${status.resolvedRef!}`]);
    runGit(["-C", targetDir, "checkout", "-B", status.resolvedRef!, "FETCH_HEAD"]);
  } else if (status.refKind === "tag") {
    runGit(["-C", targetDir, "fetch", "--depth=1", "origin", `refs/tags/${status.resolvedRef!}`]);
    runGit(["-C", targetDir, "checkout", "--detach", "FETCH_HEAD"]);
  } else {
    runGit(["-C", targetDir, "fetch", "--depth=1", "origin", status.remoteCommit]);
    runGit(["-C", targetDir, "checkout", "--detach", "FETCH_HEAD"]);
  }

  const refreshed = readCachedSourceRevision(options);

  return {
    ...status,
    currentCommit: refreshed.currentCommit ?? status.remoteCommit,
    currentRef: refreshed.currentRef,
    remoteUrl: refreshed.remoteUrl ?? status.remoteUrl,
    previousCommit: initialRevision.currentCommit,
    updated: true,
  };
}

export function clearCachedSource(options: FetchRemoteSourceOptions): ClearCachedSourceResult {
  const targetDir = getTargetDir(options);

  if (!fs.existsSync(targetDir)) {
    return { cleared: false, targetDir };
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  removeEmptyLibraryAncestors(path.dirname(targetDir), options.libraryDir);

  return { cleared: true, targetDir };
}

export function clearAllCachedSources(options: { libraryDir: string }): ClearAllCachedSourcesResult {
  const clearedSources: string[] = [];

  for (const source of listCachedSources(options.libraryDir)) {
    const result = clearCachedSource({ source, libraryDir: options.libraryDir });

    if (result.cleared) {
      clearedSources.push(source);
    }
  }

  return { clearedSources };
}

export function listCachedSources(libraryDir: string): string[] {
  if (!fs.existsSync(libraryDir)) {
    return [];
  }

  const sources: string[] = [];

  for (const hostEntry of safeReaddirSync(libraryDir)) {
    if (!hostEntry.isDirectory()) continue;
    const hostDir = path.join(libraryDir, hostEntry.name);

    for (const ownerEntry of safeReaddirSync(hostDir)) {
      if (!ownerEntry.isDirectory()) continue;
      const ownerDir = path.join(hostDir, ownerEntry.name);

      for (const repoEntry of safeReaddirSync(ownerDir)) {
        if (!repoEntry.isDirectory()) continue;
        sources.push(`${hostEntry.name}/${ownerEntry.name}/${repoEntry.name}`);
      }
    }
  }

  return sources.sort((left, right) => left.localeCompare(right));
}

function getTargetDir(options: FetchRemoteSourceOptions): string {
  assertSafeSource(options.source);
  return path.join(options.libraryDir, ...options.source.split("/"));
}

function removeEmptyLibraryAncestors(currentDir: string, libraryDir: string): void {
  let directory = currentDir;
  const libraryRoot = path.resolve(libraryDir);

  while (directory.startsWith(libraryRoot) && directory !== libraryRoot) {
    if (fs.readdirSync(directory).length > 0) {
      return;
    }

    fs.rmdirSync(directory);
    directory = path.dirname(directory);
  }
}

function safeReaddirSync(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function getCloneUrl(source: string, protocol: "https" | "ssh" = "https"): string {
  assertSafeSource(source);

  const [host, owner, repo] = source.split("/");

  return protocol === "ssh"
    ? `git@${host}:${owner}/${repo}.git`
    : `https://${source}`;
}

function resolveRemoteRef(
  remoteUrl: string,
  requestedRef?: string,
): { kind: "branch" | "tag" | "commit"; resolvedRef?: string; commit: string } {
  if (requestedRef && isCommitSha(requestedRef)) {
    return { kind: "commit", commit: requestedRef };
  }

  if (requestedRef) {
    const branchCommit = parseFirstSha(runGit(["ls-remote", remoteUrl, `refs/heads/${requestedRef}`]));

    if (branchCommit) {
      return { kind: "branch", resolvedRef: requestedRef, commit: branchCommit };
    }

    const tagOutput = runGit(["ls-remote", remoteUrl, `refs/tags/${requestedRef}`, `refs/tags/${requestedRef}^{}`]);
    const tagCommit = parsePreferredTagSha(tagOutput, requestedRef);

    if (tagCommit) {
      return { kind: "tag", resolvedRef: requestedRef, commit: tagCommit };
    }

    throw new Error(`Remote ref not found: ${requestedRef}`);
  }

  const headOutput = runGit(["ls-remote", "--symref", remoteUrl, "HEAD"]);
  const headRef = parseHeadRef(headOutput);
  const headCommit = parseHeadCommit(headOutput);

  if (!headRef || !headCommit) {
    throw new Error(`Failed to resolve remote HEAD for ${remoteUrl}`);
  }

  return { kind: "branch", resolvedRef: headRef, commit: headCommit };
}

function parseHeadRef(output: string): string | undefined {
  for (const line of output.split("\n")) {
    const match = line.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/);

    if (match) {
      return match[1];
    }
  }

  return undefined;
}

function parseHeadCommit(output: string): string | undefined {
  for (const line of output.split("\n")) {
    const match = line.match(/^([0-9a-f]{7,40})\s+HEAD$/i);

    if (match) {
      return match[1];
    }
  }

  return undefined;
}

function parsePreferredTagSha(output: string, tagName: string): string | undefined {
  const peeledPattern = new RegExp(`^([0-9a-f]{7,40})\\s+refs/tags/${escapeRegExp(tagName)}\\^{}$`, "i");
  const directPattern = new RegExp(`^([0-9a-f]{7,40})\\s+refs/tags/${escapeRegExp(tagName)}$`, "i");
  let directCommit: string | undefined;

  for (const line of output.split("\n")) {
    const peeledMatch = line.match(peeledPattern);

    if (peeledMatch) {
      return peeledMatch[1];
    }

    const directMatch = line.match(directPattern);

    if (directMatch) {
      directCommit = directMatch[1];
    }
  }

  return directCommit;
}

function parseFirstSha(output: string): string | undefined {
  for (const line of output.split("\n")) {
    const match = line.match(/^([0-9a-f]{7,40})\s+/i);

    if (match) {
      return match[1];
    }
  }

  return undefined;
}

function normalizeCurrentRef(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.replace(/^heads\//, "");
}

function runGit(args: string[]): string {
  try {
    return String(
      execFileSync("git", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).trim();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new Error(
        "git is not installed or not on PATH. Install git to fetch remote bundles.",
      );
    }

    throw error;
  }
}

function tryRunGit(args: string[]): string | undefined {
  try {
    const result = runGit(args);
    return result === "" ? undefined : result;
  } catch {
    return undefined;
  }
}

function normalizeGitError(
  error: unknown,
  prefix: string,
  context: { source: string; protocol?: "https" | "ssh" },
): Error {
  if (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  ) {
    return new Error("git is not installed or not on PATH. Install git to fetch remote bundles.");
  }

  const stderr =
    error instanceof Error && "stderr" in error
      ? String((error as { stderr: Buffer | string }).stderr).trim()
      : String(error);

  let message = `${prefix}${stderr ? `:\n${stderr}` : ""}`;

  if ((context.protocol ?? "https") === "ssh" && SSH_AUTH_FAILURE_RE.test(stderr)) {
    message += `\nHint: SSH authentication failed. To clone via HTTPS instead, omit --ssh:\n  skul add ${context.source}`;
  }

  return new Error(message);
}

function assertSafeSource(source: string): void {
  if (!SAFE_SOURCE_RE.test(source)) {
    throw new Error(`Invalid bundle source: ${source}`);
  }
}

function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
