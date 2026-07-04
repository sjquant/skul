import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { escapeRegExp } from "./fs-utils";

export interface FetchRemoteSourceOptions {
  /** Normalized source identifier, e.g. "github.com/owner/repo" */
  source: string;
  libraryDir: string;
  /** Transport protocol to use when cloning. Defaults to "https". */
  protocol?: "https" | "ssh";
  /** Optional branch, tag, or commit to fetch. */
  ref?: string;
}

export interface FetchRemoteSourceResult {
  /** true if a fresh clone was performed; false if the cache already existed */
  cloned: boolean;
  targetDir: string;
}

export interface CachedSourceRevision {
  cached: boolean;
  targetDir: string;
  currentCommit?: string;
  currentRef?: string;
  remoteUrl?: string;
}

export interface RemoteSourceStatus extends CachedSourceRevision {
  remoteUrl: string;
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
const GITHUB_HOST = "github.com";
const ARCHIVE_METADATA_FILE = ".skul-source.json";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_TRANSPORT_ENV = "SKUL_GITHUB_TRANSPORT";
const GITHUB_TRANSPORT_ARCHIVE = "archive";
const GITHUB_API_BASE_URL_ENV = "SKUL_GITHUB_API_BASE_URL";
const GITHUB_USER_AGENT = "skul";

interface GithubArchiveMetadata {
  transport: "github-archive";
  source: string;
  requested_ref: string | null;
  resolved_commit: string;
  resolved_ref: string | null;
  fetched_at: string;
}

interface GithubSourceParts {
  owner: string;
  repo: string;
}

interface GithubResolvedRef {
  commit: string;
  kind: "branch" | "tag" | "commit";
  requestedRef: string | null;
  resolvedRef: string | null;
}

type GithubArchiveReplacement = Pick<
  GithubResolvedRef,
  "commit" | "requestedRef" | "resolvedRef"
>;

/**
 * Ensures a remote git source is present in the local library cache.
 * If the target directory already exists the operation is a no-op (returns cloned: false).
 * Otherwise the repo is shallow-cloned into libraryDir/host/owner/repo using
 * HTTPS (default) or SSH when protocol is "ssh".
 */
export async function fetchRemoteSource(
  options: FetchRemoteSourceOptions,
): Promise<FetchRemoteSourceResult> {
  const targetDir = getTargetDir(options);

  if (fs.existsSync(targetDir)) {
    return { cloned: false, targetDir };
  }

  const cloneUrl = getCloneUrl(options.source, options.protocol);

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });

  if (shouldUseGithubArchiveFirst(options)) {
    await fetchGithubArchiveSource(options, targetDir);
    return { cloned: true, targetDir };
  }

  try {
    runGit(["clone", "--depth=1", cloneUrl, targetDir]);
    if (options.ref) {
      checkoutGitRemoteRef(targetDir, cloneUrl, options.ref);
    }
  } catch (error) {
    fs.rmSync(targetDir, { recursive: true, force: true });

    if (shouldFallbackToGithubArchive(options, error)) {
      try {
        await fetchGithubArchiveSource(options, targetDir);
        return { cloned: true, targetDir };
      } catch (archiveError) {
        throw combineGitAndArchiveErrors(error, archiveError, cloneUrl, {
          source: options.source,
          protocol: options.protocol,
        });
      }
    }

    throw normalizeGitError(error, `Failed to clone ${cloneUrl}`, {
      source: options.source,
      protocol: options.protocol,
    });
  }

  return { cloned: true, targetDir };
}

/** Reads the currently cached commit, ref, and remote URL for one source. */
export function readCachedSourceRevision(
  options: FetchRemoteSourceOptions,
): CachedSourceRevision {
  const targetDir = getTargetDir(options);

  if (!fs.existsSync(targetDir)) {
    return { cached: false, targetDir };
  }

  const archiveMetadata = readGithubArchiveMetadata(targetDir, options.source);

  if (archiveMetadata) {
    return {
      cached: true,
      targetDir,
      currentCommit: archiveMetadata.resolved_commit,
      currentRef: archiveMetadata.resolved_ref ?? undefined,
      remoteUrl: getCloneUrl(options.source, "https"),
    };
  }

  return {
    cached: true,
    targetDir,
    currentCommit: tryRunGit(["-C", targetDir, "rev-parse", "HEAD"]),
    currentRef: normalizeCurrentRef(
      tryRunGit([
        "-C",
        targetDir,
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]),
    ),
    remoteUrl: tryRunGit(["-C", targetDir, "remote", "get-url", "origin"]),
  };
}

/** Resolves the remote state for one source and optional ref selector without mutating the cache. */
export async function inspectRemoteSource(
  options: FetchRemoteSourceOptions,
): Promise<RemoteSourceStatus> {
  const cached = readCachedSourceRevision(options);
  const metadata = readGithubArchiveMetadata(cached.targetDir, options.source);

  if (metadata) {
    try {
      const resolvedRemote = await resolveGithubArchiveRef(
        options.source,
        options.ref ?? metadata.requested_ref,
      );

      return {
        ...cached,
        remoteUrl: getCloneUrl(options.source, "https"),
        remoteCommit: resolvedRemote.commit,
        refKind: resolvedRemote.kind,
        ...(resolvedRemote.resolvedRef !== null
          ? { resolvedRef: resolvedRemote.resolvedRef }
          : {}),
      };
    } catch (error) {
      throw normalizeGithubArchiveError(
        error,
        `Failed to inspect ${options.source}`,
      );
    }
  }

  const remoteUrl =
    cached.remoteUrl ?? getCloneUrl(options.source, options.protocol);
  let resolvedRemote: {
    kind: "branch" | "tag" | "commit";
    resolvedRef?: string;
    commit: string;
  };

  try {
    resolvedRemote = resolveRemoteRef(
      remoteUrl,
      options.ref,
      cached.cached ? cached.targetDir : undefined,
    );
  } catch (error) {
    throw normalizeGitError(error, `Failed to inspect ${options.source}`, {
      source: options.source,
      protocol: options.protocol,
    });
  }

  return {
    ...cached,
    remoteUrl,
    remoteCommit: resolvedRemote.commit,
    refKind: resolvedRemote.kind,
    ...(resolvedRemote.resolvedRef !== undefined
      ? { resolvedRef: resolvedRemote.resolvedRef }
      : {}),
  };
}

/** Updates a cached remote source to the latest commit for its selected ref. */
export async function updateCachedRemoteSource(
  options: FetchRemoteSourceOptions,
): Promise<UpdateCachedRemoteSourceResult> {
  const initialRevision = readCachedSourceRevision(options);

  if (!initialRevision.cached) {
    await fetchRemoteSource(options);
  }

  const targetDir = getTargetDir(options);

  const archiveMetadata = readGithubArchiveMetadata(targetDir, options.source);

  if (archiveMetadata && isGithubArchiveEligible(options)) {
    return updateGithubArchiveSource(options, initialRevision);
  }

  if (archiveMetadata) {
    await clearAndRefetchCachedRemoteSource(options);
  }

  let status: RemoteSourceStatus;

  try {
    status = await inspectRemoteSource(options);
  } catch (error) {
    throw rewriteInspectFailureForUpdate(error, options.source);
  }
  const requiresCheckoutRealignment =
    status.refKind === "branch"
      ? status.currentRef !== status.resolvedRef
      : status.currentRef !== undefined;

  if (
    status.currentCommit === status.remoteCommit &&
    !requiresCheckoutRealignment
  ) {
    return {
      ...status,
      previousCommit: status.currentCommit,
      updated: false,
      currentCommit: status.remoteCommit,
    };
  }

  try {
    checkoutResolvedRemoteRef(targetDir, {
      kind: status.refKind,
      resolvedRef: status.resolvedRef,
      commit: status.remoteCommit,
    });
  } catch (error) {
    throw normalizeGitError(error, `Failed to update ${options.source}`, {
      source: options.source,
      protocol: options.protocol,
    });
  }

  const refreshed = readCachedSourceRevision(options);

  return {
    ...status,
    currentCommit: refreshed.currentCommit ?? status.remoteCommit,
    currentRef: refreshed.currentRef,
    remoteUrl: refreshed.remoteUrl ?? status.remoteUrl,
    previousCommit: initialRevision.currentCommit,
    updated:
      status.currentCommit !== status.remoteCommit ||
      requiresCheckoutRealignment,
  };
}

function rewriteInspectFailureForUpdate(error: unknown, source: string): Error {
  if (
    error instanceof Error &&
    error.message.startsWith(`Failed to inspect ${source}`)
  ) {
    return new Error(
      error.message.replace(
        `Failed to inspect ${source}`,
        `Failed to update ${source}`,
      ),
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}

/** Moves a cached source checkout back to a previously recorded revision. */
export async function restoreCachedRemoteSourceRevision(
  options: FetchRemoteSourceOptions & {
    ref?: string;
    commit: string;
    refName?: string;
  },
): Promise<void> {
  const targetDir = getTargetDir(options);

  const archiveMetadata = readGithubArchiveMetadata(targetDir, options.source);

  if (archiveMetadata) {
    await replaceWithGithubArchiveSource(options.source, targetDir, {
      commit: options.commit,
      requestedRef: options.ref ?? archiveMetadata.requested_ref,
      resolvedRef: options.refName ?? archiveMetadata.resolved_ref,
    });
    return;
  }

  if (options.refName) {
    runGit([
      "-C",
      targetDir,
      "checkout",
      "-B",
      options.refName,
      options.commit,
    ]);
    return;
  }

  runGit(["-C", targetDir, "checkout", "--detach", options.commit]);
}

/** Deletes one cached source checkout without reporting whether it existed. */
export function removeCachedRemoteSource(
  options: FetchRemoteSourceOptions,
): void {
  fs.rmSync(getTargetDir(options), { recursive: true, force: true });
}

/**
 * Clears the cached clone for a source and re-clones it fresh at HEAD.
 *
 * Clones into a sibling `.tmp` directory first so the existing cache survives
 * any network or authentication failure — the working copy is only replaced
 * after the clone succeeds.
 *
 * Respects protocol switching: if the stored origin URL uses a different
 * transport than `options.protocol` (e.g. the cache was SSH but the caller
 * requests HTTPS), a fresh URL is constructed from the source identifier so the
 * new protocol takes effect. Local-path remotes used in tests are left as-is
 * because they don't start with `git@` and therefore match `"https"` by default.
 */
export async function clearAndRefetchCachedRemoteSource(
  options: FetchRemoteSourceOptions,
): Promise<void> {
  const targetDir = getTargetDir(options);
  const revision = readCachedSourceRevision(options);

  const archiveMetadata = readGithubArchiveMetadata(targetDir, options.source);

  if (
    (archiveMetadata && isGithubArchiveEligible(options)) ||
    shouldUseGithubArchiveFirst(options)
  ) {
    await fetchGithubArchiveSource(options, targetDir);
    return;
  }

  const isStoredSsh = revision.remoteUrl?.startsWith("git@") ?? false;
  const cloneUrl =
    revision.remoteUrl && isStoredSsh === (options.protocol === "ssh")
      ? revision.remoteUrl
      : getCloneUrl(options.source, options.protocol);

  const tempDir = `${targetDir}.tmp`;
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });

  try {
    runGit(["clone", "--depth=1", cloneUrl, tempDir]);
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(tempDir, targetDir);
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (shouldFallbackToGithubArchive(options, error)) {
      try {
        await fetchGithubArchiveSource(options, targetDir);
        return;
      } catch (archiveError) {
        throw combineGitAndArchiveErrors(error, archiveError, cloneUrl, {
          source: options.source,
          protocol: options.protocol,
        });
      }
    }

    throw normalizeGitError(error, `Failed to clone ${cloneUrl}`, {
      source: options.source,
      protocol: options.protocol,
    });
  }
}

function getTargetDir(options: FetchRemoteSourceOptions): string {
  assertSafeSource(options.source);
  return path.join(options.libraryDir, ...options.source.split("/"));
}

function getCloneUrl(
  source: string,
  protocol: "https" | "ssh" = "https",
): string {
  assertSafeSource(source);

  const [host, owner, repo] = source.split("/");

  return protocol === "ssh"
    ? `git@${host}:${owner}/${repo}.git`
    : `https://${source}`;
}

function resolveRemoteRef(
  remoteUrl: string,
  requestedRef?: string,
  targetDir?: string,
): { kind: "branch" | "tag" | "commit"; resolvedRef?: string; commit: string } {
  if (requestedRef && requestedRef.length === 40 && isCommitSha(requestedRef)) {
    return { kind: "commit", commit: requestedRef };
  }

  if (requestedRef) {
    const branchCommit = parseFirstSha(
      runGit(["ls-remote", remoteUrl, `refs/heads/${requestedRef}`]),
    );

    if (branchCommit) {
      return {
        kind: "branch",
        resolvedRef: requestedRef,
        commit: branchCommit,
      };
    }

    const tagOutput = runGit([
      "ls-remote",
      remoteUrl,
      `refs/tags/${requestedRef}`,
      `refs/tags/${requestedRef}^{}`,
    ]);
    const tagCommit = parsePreferredTagSha(tagOutput, requestedRef);

    if (tagCommit) {
      return { kind: "tag", resolvedRef: requestedRef, commit: tagCommit };
    }

    if (isCommitSha(requestedRef)) {
      const commit = parseUniqueShaPrefix(
        runGit(["ls-remote", remoteUrl]),
        requestedRef,
      );

      if (commit) {
        return { kind: "commit", commit };
      }

      if (targetDir) {
        const fetchArgs = [
          "-C",
          targetDir,
          "fetch",
          "--tags",
          "origin",
          "+refs/heads/*:refs/remotes/origin/*",
        ];

        if (
          tryRunGit([
            "-C",
            targetDir,
            "rev-parse",
            "--is-shallow-repository",
          ]) === "true"
        ) {
          fetchArgs.splice(3, 0, "--unshallow");
        }

        runGit(fetchArgs);

        try {
          return {
            kind: "commit",
            commit: runGit([
              "-C",
              targetDir,
              "rev-parse",
              "--verify",
              `${requestedRef}^{commit}`,
            ]),
          };
        } catch {
          throw new Error(`Remote ref not found: ${requestedRef}`);
        }
      }
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

function checkoutGitRemoteRef(
  targetDir: string,
  remoteUrl: string,
  requestedRef: string,
): void {
  const resolved = resolveRemoteRef(remoteUrl, requestedRef, targetDir);

  checkoutResolvedRemoteRef(targetDir, resolved);
}

function checkoutResolvedRemoteRef(
  targetDir: string,
  resolved: {
    kind: "branch" | "tag" | "commit";
    resolvedRef?: string;
    commit: string;
  },
): void {
  if (resolved.kind === "branch") {
    const branch = requireResolvedRemoteRef(resolved);
    runGit([
      "-C",
      targetDir,
      "fetch",
      "--depth=1",
      "origin",
      `refs/heads/${branch}`,
    ]);
    runGit(["-C", targetDir, "checkout", "-B", branch, "FETCH_HEAD"]);
    return;
  }

  if (resolved.kind === "tag") {
    const tag = requireResolvedRemoteRef(resolved);
    runGit([
      "-C",
      targetDir,
      "fetch",
      "--depth=1",
      "origin",
      `refs/tags/${tag}`,
    ]);
    runGit(["-C", targetDir, "checkout", "--detach", "FETCH_HEAD"]);
    return;
  }

  try {
    runGit(["-C", targetDir, "cat-file", "-e", `${resolved.commit}^{commit}`]);
  } catch {
    runGit(["-C", targetDir, "fetch", "--depth=1", "origin", resolved.commit]);
  }

  runGit(["-C", targetDir, "checkout", "--detach", resolved.commit]);
}

function requireResolvedRemoteRef(resolved: {
  kind: "branch" | "tag" | "commit";
  resolvedRef?: string;
}): string {
  if (!resolved.resolvedRef) {
    throw new Error(`Failed to resolve remote ${resolved.kind} ref`);
  }

  return resolved.resolvedRef;
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

function parsePreferredTagSha(
  output: string,
  tagName: string,
): string | undefined {
  const peeledPattern = new RegExp(
    `^([0-9a-f]{7,40})\\s+refs/tags/${escapeRegExp(tagName)}\\^{}$`,
    "i",
  );
  const directPattern = new RegExp(
    `^([0-9a-f]{7,40})\\s+refs/tags/${escapeRegExp(tagName)}$`,
    "i",
  );
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

function parseUniqueShaPrefix(
  output: string,
  requestedRef: string,
): string | undefined {
  const matches = new Set<string>();

  for (const line of output.split("\n")) {
    const match = line.match(/^([0-9a-f]{40})\s+/i);

    if (match?.[1]?.toLowerCase().startsWith(requestedRef.toLowerCase())) {
      matches.add(match[1]);
    }
  }

  if (matches.size > 1) {
    throw new Error(`Remote commit ref is ambiguous: ${requestedRef}`);
  }

  return Array.from(matches)[0];
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

function shouldUseGithubArchiveFirst(
  options: FetchRemoteSourceOptions,
): boolean {
  return (
    process.env[GITHUB_TRANSPORT_ENV] === GITHUB_TRANSPORT_ARCHIVE &&
    isGithubArchiveEligible(options)
  );
}

function shouldFallbackToGithubArchive(
  options: FetchRemoteSourceOptions,
  error: unknown,
): boolean {
  return (
    isGithubArchiveEligible(options) &&
    getGithubToken(process.env) !== undefined &&
    isProxyForbiddenGitError(error)
  );
}

function isGithubArchiveEligible(options: FetchRemoteSourceOptions): boolean {
  return (
    (options.protocol ?? "https") === "https" &&
    parseGithubSource(options.source) !== undefined
  );
}

function isProxyForbiddenGitError(error: unknown): boolean {
  const stderr =
    error instanceof Error && "stderr" in error
      ? String((error as { stderr: Buffer | string }).stderr)
      : String(error);

  return /proxy[\s\S]*403|403[\s\S]*proxy|CONNECT[\s\S]*403/i.test(stderr);
}

async function fetchGithubArchiveSource(
  options: FetchRemoteSourceOptions,
  targetDir: string,
): Promise<GithubArchiveMetadata> {
  const resolved = await resolveGithubArchiveRef(options.source, options.ref);

  return replaceWithGithubArchiveSource(options.source, targetDir, resolved);
}

async function replaceWithGithubArchiveSource(
  source: string,
  targetDir: string,
  resolved: GithubArchiveReplacement,
): Promise<GithubArchiveMetadata> {
  const parentDir = path.dirname(targetDir);
  const tempDir = `${targetDir}.tmp-${process.pid}-${Date.now()}`;
  const archiveFile = `${tempDir}.tar.gz`;
  const backupDir = `${targetDir}.backup-${process.pid}-${Date.now()}`;

  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(archiveFile, { force: true });
  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.mkdirSync(parentDir, { recursive: true });

  try {
    await downloadGithubArchive(source, resolved.commit, archiveFile);
    extractGithubArchive(archiveFile, tempDir);
    writeGithubArchiveMetadata(tempDir, {
      transport: "github-archive",
      source,
      requested_ref: resolved.requestedRef,
      resolved_commit: resolved.commit,
      resolved_ref: resolved.resolvedRef,
      fetched_at: new Date().toISOString(),
    });
    if (fs.existsSync(targetDir)) {
      fs.renameSync(targetDir, backupDir);
    }
    fs.renameSync(tempDir, targetDir);
    fs.rmSync(backupDir, { recursive: true, force: true });

    return readRequiredGithubArchiveMetadata(targetDir, source);
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (fs.existsSync(backupDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.renameSync(backupDir, targetDir);
    }
    throw normalizeGithubArchiveError(error, `Failed to fetch ${source}`);
  } finally {
    fs.rmSync(archiveFile, { force: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
}

async function updateGithubArchiveSource(
  options: FetchRemoteSourceOptions,
  initialRevision: CachedSourceRevision,
): Promise<UpdateCachedRemoteSourceResult> {
  const targetDir = getTargetDir(options);
  const metadata = readRequiredGithubArchiveMetadata(targetDir, options.source);
  const status = await inspectRemoteSource(options);

  if (metadata.resolved_commit === status.remoteCommit) {
    return {
      ...status,
      previousCommit: initialRevision.currentCommit,
      updated: false,
      currentCommit: metadata.resolved_commit,
    };
  }

  const refreshed = await replaceWithGithubArchiveSource(
    options.source,
    targetDir,
    {
      commit: status.remoteCommit,
      requestedRef: options.ref ?? metadata.requested_ref,
      resolvedRef: status.resolvedRef ?? null,
    },
  );

  return {
    ...status,
    currentCommit: refreshed.resolved_commit,
    currentRef: refreshed.resolved_ref ?? undefined,
    previousCommit: initialRevision.currentCommit,
    updated: true,
  };
}

async function resolveGithubArchiveRef(
  source: string,
  requestedRef?: string | null,
): Promise<GithubResolvedRef> {
  const github = requireGithubSource(source);

  if (requestedRef && isCommitSha(requestedRef)) {
    const commit = await githubApiJson<{ sha: string }>(
      `/repos/${encodeURIComponent(github.owner)}/${encodeURIComponent(
        github.repo,
      )}/commits/${encodeURIComponent(requestedRef)}`,
    );

    return {
      commit: commit.sha,
      kind: "commit",
      requestedRef,
      resolvedRef: requestedRef,
    };
  }

  if (requestedRef) {
    const branch = await tryResolveGithubBranch(github, requestedRef);

    if (branch) {
      return branch;
    }

    const tag = await tryResolveGithubTag(github, requestedRef);

    if (tag) {
      return tag;
    }

    throw new Error(`GitHub ref not found: ${requestedRef}`);
  }

  const repo = await githubApiJson<{ default_branch: string }>(
    `/repos/${encodeURIComponent(github.owner)}/${encodeURIComponent(
      github.repo,
    )}`,
  );
  const defaultBranch = await tryResolveGithubBranch(
    github,
    repo.default_branch,
  );

  if (!defaultBranch) {
    throw new Error(`GitHub default branch not found: ${repo.default_branch}`);
  }

  return {
    ...defaultBranch,
    requestedRef: null,
  };
}

async function tryResolveGithubBranch(
  github: GithubSourceParts,
  branch: string,
): Promise<GithubResolvedRef | undefined> {
  try {
    const ref = await githubApiJson<{ object: { sha: string } }>(
      `/repos/${encodeURIComponent(github.owner)}/${encodeURIComponent(
        github.repo,
      )}/git/ref/heads/${encodeGithubRefPath(branch)}`,
    );

    return {
      commit: ref.object.sha,
      kind: "branch",
      requestedRef: branch,
      resolvedRef: branch,
    };
  } catch (error) {
    if (isGithubNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

async function tryResolveGithubTag(
  github: GithubSourceParts,
  tag: string,
): Promise<GithubResolvedRef | undefined> {
  try {
    const ref = await githubApiJson<{
      object: { sha: string; type: string };
    }>(
      `/repos/${encodeURIComponent(github.owner)}/${encodeURIComponent(
        github.repo,
      )}/git/ref/tags/${encodeGithubRefPath(tag)}`,
    );

    return {
      commit: await peelGithubTagObject(github, ref.object),
      kind: "tag",
      requestedRef: tag,
      resolvedRef: tag,
    };
  } catch (error) {
    if (isGithubNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

async function peelGithubTagObject(
  github: GithubSourceParts,
  object: { sha: string; type: string },
): Promise<string> {
  if (object.type === "commit") {
    return object.sha;
  }

  if (object.type !== "tag") {
    throw new Error(`Unsupported GitHub tag object type: ${object.type}`);
  }

  const tag = await githubApiJson<{ object: { sha: string; type: string } }>(
    `/repos/${encodeURIComponent(github.owner)}/${encodeURIComponent(
      github.repo,
    )}/git/tags/${encodeURIComponent(object.sha)}`,
  );

  return peelGithubTagObject(github, tag.object);
}

async function downloadGithubArchive(
  source: string,
  commit: string,
  archiveFile: string,
): Promise<void> {
  const github = requireGithubSource(source);

  await githubApiFile(
    `/repos/${encodeURIComponent(github.owner)}/${encodeURIComponent(
      github.repo,
    )}/tarball/${encodeURIComponent(commit)}`,
    archiveFile,
  );
}

async function githubApiJson<T>(apiPath: string): Promise<T> {
  return JSON.parse((await githubApiRequest(apiPath)).toString("utf8")) as T;
}

async function githubApiRequest(apiPath: string): Promise<Buffer> {
  const response = await fetchGithubApi(apiPath);
  const bytes = Buffer.from(await response.arrayBuffer());

  if (!response.ok) {
    throw new Error(formatGithubApiResponseFailure(response, bytes));
  }

  return bytes;
}

async function githubApiFile(
  apiPath: string,
  outputPath: string,
): Promise<void> {
  const response = await fetchGithubApi(apiPath);

  if (!response.ok) {
    throw new Error(
      formatGithubApiResponseFailure(
        response,
        Buffer.from(await response.arrayBuffer()),
      ),
    );
  }

  if (!response.body) {
    throw new Error("Missing GitHub API file response body");
  }

  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(outputPath),
  );
}

async function fetchGithubApi(apiPath: string): Promise<Response> {
  const token = getRequiredGithubToken();
  const url = new URL(apiPath, getGithubApiBaseUrl());

  try {
    return await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": GITHUB_USER_AGENT,
      },
    });
  } catch (error) {
    throw new Error(
      formatGithubApiFailure({
        message: sanitizeGithubErrorMessage(getErrorText(error)),
      }),
    );
  }
}

function formatGithubApiResponseFailure(
  response: Response,
  body: Buffer,
): string {
  return formatGithubApiFailure({
    status: response.status,
    statusText: response.statusText,
    body: body.toString("utf8"),
    rateLimitRemaining: response.headers.get("x-ratelimit-remaining"),
    rateLimitReset: response.headers.get("x-ratelimit-reset"),
  });
}

function extractGithubArchive(archiveFile: string, targetDir: string): void {
  const extractDir = `${targetDir}.extract`;
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    execFileSync("tar", ["-xzf", archiveFile, "-C", extractDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const wrapperDir = getArchiveWrapperDir(extractDir);
    fs.mkdirSync(targetDir, { recursive: true });

    for (const entry of fs.readdirSync(wrapperDir)) {
      fs.renameSync(path.join(wrapperDir, entry), path.join(targetDir, entry));
    }
  } catch (error) {
    throw new Error(`Failed to extract GitHub archive: ${getErrorText(error)}`);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

function getArchiveWrapperDir(extractDir: string): string {
  const entries = fs
    .readdirSync(extractDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());

  if (entries.length !== 1) {
    throw new Error("GitHub archive did not contain one wrapper directory");
  }

  return path.join(extractDir, entries[0]!.name);
}

function writeGithubArchiveMetadata(
  targetDir: string,
  metadata: GithubArchiveMetadata,
): void {
  fs.writeFileSync(
    getGithubArchiveMetadataPath(targetDir),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
}

function readGithubArchiveMetadata(
  targetDir: string,
  expectedSource: string,
): GithubArchiveMetadata | undefined {
  if (fs.existsSync(path.join(targetDir, ".git"))) {
    return undefined;
  }

  const metadataPath = getGithubArchiveMetadataPath(targetDir);

  if (!fs.existsSync(metadataPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(
      fs.readFileSync(metadataPath, "utf8"),
    ) as GithubArchiveMetadata;

    if (
      parsed.transport !== "github-archive" ||
      parsed.source !== expectedSource ||
      typeof parsed.fetched_at !== "string" ||
      !isCommitSha(parsed.resolved_commit) ||
      !isNullableString(parsed.requested_ref) ||
      !isNullableString(parsed.resolved_ref)
    ) {
      throw new Error(`Invalid GitHub archive metadata in ${targetDir}`);
    }

    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid GitHub archive metadata in ${targetDir}`);
    }

    throw error;
  }
}

function readRequiredGithubArchiveMetadata(
  targetDir: string,
  expectedSource: string,
): GithubArchiveMetadata {
  const metadata = readGithubArchiveMetadata(targetDir, expectedSource);

  if (!metadata) {
    throw new Error(`Missing GitHub archive metadata in ${targetDir}`);
  }

  return metadata;
}

function getGithubArchiveMetadataPath(targetDir: string): string {
  return path.join(targetDir, ARCHIVE_METADATA_FILE);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseGithubSource(source: string): GithubSourceParts | undefined {
  assertSafeSource(source);
  const [host, owner, repo] = source.split("/");

  if (host !== GITHUB_HOST) {
    return undefined;
  }

  return { owner, repo };
}

function requireGithubSource(source: string): GithubSourceParts {
  const github = parseGithubSource(source);

  if (!github) {
    throw new Error(
      `GitHub archive transport only supports github.com sources`,
    );
  }

  return github;
}

function encodeGithubRefPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

function getRequiredGithubToken(): string {
  const token = getGithubToken(process.env);

  if (!token) {
    throw new Error(
      "GitHub archive transport requires GH_TOKEN or GITHUB_TOKEN.",
    );
  }

  return token;
}

function getGithubToken(env: NodeJS.ProcessEnv): string | undefined {
  return env.GH_TOKEN || env.GITHUB_TOKEN || undefined;
}

function getGithubApiBaseUrl(): string {
  const override = process.env[GITHUB_API_BASE_URL_ENV];

  if (!override) {
    return "https://api.github.com";
  }

  if (process.env.NODE_ENV === "test") {
    return override;
  }

  throw new Error(
    `${GITHUB_API_BASE_URL_ENV} is only supported in tests. GitHub Enterprise archive transport is not supported yet.`,
  );
}

function combineGitAndArchiveErrors(
  gitError: unknown,
  archiveError: unknown,
  cloneUrl: string,
  context: { source: string; protocol?: "https" | "ssh" },
): Error {
  const gitMessage = normalizeGitError(
    gitError,
    `Failed to clone ${cloneUrl}`,
    context,
  ).message;
  const archiveMessage =
    archiveError instanceof Error ? archiveError.message : String(archiveError);

  return new Error(
    `${gitMessage}\nGitHub archive fallback failed:\n${archiveMessage}`,
  );
}

function normalizeGithubArchiveError(error: unknown, prefix: string): Error {
  if (error instanceof Error) {
    return new Error(
      `${prefix}:\n${sanitizeGithubErrorMessage(error.message)}`,
    );
  }

  return new Error(`${prefix}:\n${sanitizeGithubErrorMessage(String(error))}`);
}

function formatGithubApiFailure(error: {
  body?: string;
  message?: string;
  rateLimitRemaining?: string | null;
  rateLimitReset?: string | null;
  status?: number;
  statusText?: string;
}): string {
  const detail = parseGithubApiErrorBody(error.body) ?? error.message;

  if (error.status === 401) {
    return "GitHub API authentication failed (401). Check GH_TOKEN or GITHUB_TOKEN.";
  }

  if (error.status === 403) {
    if (error.rateLimitRemaining === "0") {
      const reset = error.rateLimitReset
        ? new Date(Number(error.rateLimitReset) * 1000).toISOString()
        : "the rate limit resets";
      return `GitHub API rate limit exceeded (403). Try again after ${reset}.`;
    }

    return `GitHub API request forbidden (403). Check token repository access.${detail ? ` ${detail}` : ""}`;
  }

  if (error.status === 404) {
    return "GitHub repository or ref was not found (404). Check the source, ref, and token access.";
  }

  if (error.status) {
    return `GitHub API request failed (${error.status}${error.statusText ? ` ${error.statusText}` : ""}).${detail ? ` ${detail}` : ""}`;
  }

  return detail ?? "GitHub API request failed.";
}

function parseGithubApiErrorBody(body: string | undefined): string | undefined {
  if (!body) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(body) as { message?: string };
    return parsed.message
      ? sanitizeGithubErrorMessage(parsed.message)
      : undefined;
  } catch {
    return sanitizeGithubErrorMessage(body);
  }
}

function isGithubNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error && /\(404\)|not found \(404\)/i.test(error.message)
  );
}

function sanitizeGithubErrorMessage(message: string): string {
  const token = getGithubToken(process.env);

  return token ? message.split(token).join("[redacted]") : message;
}

function getErrorText(error: unknown): string {
  if (error instanceof Error && "stderr" in error) {
    return String((error as { stderr: Buffer | string }).stderr).trim();
  }

  return error instanceof Error ? error.message : String(error);
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
    return new Error(
      "git is not installed or not on PATH. Install git to fetch remote bundles.",
    );
  }

  const stderr =
    error instanceof Error && "stderr" in error
      ? String((error as { stderr: Buffer | string }).stderr).trim()
      : String(error);

  let message = `${prefix}${stderr ? `:\n${stderr}` : ""}`;

  if (
    (context.protocol ?? "https") === "ssh" &&
    SSH_AUTH_FAILURE_RE.test(stderr)
  ) {
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
