import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { escapeRegExp } from "./fs-utils";

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
const PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;
const NO_PROXY_ENV_NAMES = ["NO_PROXY", "no_proxy"] as const;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const GITHUB_HOST = "github.com";
const GITHUB_TOKEN_CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo password="$SKUL_GIT_AUTH_TOKEN"; }; f';

interface GitRunContext {
  remoteUrl?: string;
  source?: string;
  protocol?: "https" | "ssh";
}

/**
 * Ensures a remote git source is present in the local library cache.
 * If the target directory already exists the operation is a no-op (returns cloned: false).
 * Otherwise the repo is shallow-cloned into libraryDir/host/owner/repo using
 * HTTPS (default) or SSH when protocol is "ssh".
 */
export function fetchRemoteSource(
  options: FetchRemoteSourceOptions,
): FetchRemoteSourceResult {
  const targetDir = getTargetDir(options);

  if (fs.existsSync(targetDir)) {
    return { cloned: false, targetDir };
  }

  const cloneUrl = getCloneUrl(options.source, options.protocol);

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });

  try {
    runGit(["clone", "--depth=1", cloneUrl, targetDir], {
      remoteUrl: cloneUrl,
      source: options.source,
      protocol: options.protocol,
    });
  } catch (error) {
    fs.rmSync(targetDir, { recursive: true, force: true });
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
export function inspectRemoteSource(
  options: FetchRemoteSourceOptions & { ref?: string },
): RemoteSourceStatus {
  const cached = readCachedSourceRevision(options);
  const remoteUrl =
    cached.remoteUrl ?? getCloneUrl(options.source, options.protocol);
  let resolvedRemote: {
    kind: "branch" | "tag" | "commit";
    resolvedRef?: string;
    commit: string;
  };

  try {
    resolvedRemote = resolveRemoteRef(remoteUrl, options.ref);
  } catch (error) {
    throw normalizeGitError(error, `Failed to inspect ${options.source}`, {
      source: options.source,
      protocol: options.protocol,
    });
  }

  return {
    ...cached,
    remoteCommit: resolvedRemote.commit,
    refKind: resolvedRemote.kind,
    ...(resolvedRemote.resolvedRef !== undefined
      ? { resolvedRef: resolvedRemote.resolvedRef }
      : {}),
  };
}

/** Updates a cached remote source to the latest commit for its selected ref. */
export function updateCachedRemoteSource(
  options: FetchRemoteSourceOptions & { ref?: string },
): UpdateCachedRemoteSourceResult {
  const initialRevision = readCachedSourceRevision(options);

  if (!initialRevision.cached) {
    fetchRemoteSource(options);
  }

  const targetDir = getTargetDir(options);
  let status: RemoteSourceStatus;

  try {
    status = inspectRemoteSource(options);
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
    if (status.refKind === "branch") {
      runGit(
        [
          "-C",
          targetDir,
          "fetch",
          "--depth=1",
          "origin",
          `refs/heads/${status.resolvedRef!}`,
        ],
        {
          remoteUrl: status.remoteUrl,
          source: options.source,
          protocol: options.protocol,
        },
      );
      runGit([
        "-C",
        targetDir,
        "checkout",
        "-B",
        status.resolvedRef!,
        "FETCH_HEAD",
      ]);
    } else if (status.refKind === "tag") {
      runGit(
        [
          "-C",
          targetDir,
          "fetch",
          "--depth=1",
          "origin",
          `refs/tags/${status.resolvedRef!}`,
        ],
        {
          remoteUrl: status.remoteUrl,
          source: options.source,
          protocol: options.protocol,
        },
      );
      runGit(["-C", targetDir, "checkout", "--detach", "FETCH_HEAD"]);
    } else {
      runGit(
        ["-C", targetDir, "fetch", "--depth=1", "origin", status.remoteCommit],
        {
          remoteUrl: status.remoteUrl,
          source: options.source,
          protocol: options.protocol,
        },
      );
      runGit(["-C", targetDir, "checkout", "--detach", "FETCH_HEAD"]);
    }
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
export function restoreCachedRemoteSourceRevision(
  options: FetchRemoteSourceOptions & {
    ref?: string;
    commit: string;
    refName?: string;
  },
): void {
  const targetDir = getTargetDir(options);

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
export function clearAndRefetchCachedRemoteSource(
  options: FetchRemoteSourceOptions,
): void {
  const targetDir = getTargetDir(options);
  const revision = readCachedSourceRevision(options);
  const isStoredSsh = revision.remoteUrl?.startsWith("git@") ?? false;
  const cloneUrl =
    revision.remoteUrl && isStoredSsh === (options.protocol === "ssh")
      ? revision.remoteUrl
      : getCloneUrl(options.source, options.protocol);

  const tempDir = `${targetDir}.tmp`;
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });

  try {
    runGit(["clone", "--depth=1", cloneUrl, tempDir], {
      remoteUrl: cloneUrl,
      source: options.source,
      protocol: options.protocol,
    });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(tempDir, targetDir);
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
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
): { kind: "branch" | "tag" | "commit"; resolvedRef?: string; commit: string } {
  if (requestedRef && isCommitSha(requestedRef)) {
    return { kind: "commit", commit: requestedRef };
  }

  if (requestedRef) {
    const branchCommit = parseFirstSha(
      runGit(["ls-remote", remoteUrl, `refs/heads/${requestedRef}`], {
        remoteUrl,
      }),
    );

    if (branchCommit) {
      return {
        kind: "branch",
        resolvedRef: requestedRef,
        commit: branchCommit,
      };
    }

    const tagOutput = runGit(
      [
        "ls-remote",
        remoteUrl,
        `refs/tags/${requestedRef}`,
        `refs/tags/${requestedRef}^{}`,
      ],
      { remoteUrl },
    );
    const tagCommit = parsePreferredTagSha(tagOutput, requestedRef);

    if (tagCommit) {
      return { kind: "tag", resolvedRef: requestedRef, commit: tagCommit };
    }

    throw new Error(`Remote ref not found: ${requestedRef}`);
  }

  const headOutput = runGit(["ls-remote", "--symref", remoteUrl, "HEAD"], {
    remoteUrl,
  });
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

function runGit(args: string[], context: GitRunContext = {}): string {
  const invocation = buildGitInvocation(args, context);

  try {
    return String(
      execFileSync("git", invocation.args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...(invocation.env ? { env: invocation.env } : {}),
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

function buildGitInvocation(
  args: string[],
  context: GitRunContext,
): { args: string[]; env?: NodeJS.ProcessEnv } {
  const remoteHosts = getHttpsRemoteHosts(context);

  if (remoteHosts.length === 0) {
    return { args };
  }

  const githubToken = getGithubToken(process.env);
  const shouldUseGithubToken =
    githubToken !== undefined && remoteHosts.includes(GITHUB_HOST);
  const shouldBypassGitProxy =
    shouldUseGithubToken || hasLoopbackProxy(process.env);
  const shouldScrubProxyEnv = hasLoopbackProxy(process.env);

  if (!shouldUseGithubToken && !shouldBypassGitProxy) {
    return { args };
  }

  return {
    args: [
      ...buildGitConfigArgs(remoteHosts, {
        bypassGitProxy: shouldBypassGitProxy,
        useGithubToken: shouldUseGithubToken,
      }),
      ...args,
    ],
    env: buildGitEnv(remoteHosts, {
      scrubProxyEnv: shouldScrubProxyEnv,
      githubToken,
    }),
  };
}

function getHttpsRemoteHosts(context: GitRunContext): string[] {
  const remoteUrlHost = context.remoteUrl
    ? parseHttpsRemoteHost(context.remoteUrl)
    : undefined;

  if (remoteUrlHost) {
    return [remoteUrlHost];
  }

  if (context.source && (context.protocol ?? "https") === "https") {
    return [context.source.split("/")[0].toLowerCase()];
  }

  return [];
}

function parseHttpsRemoteHost(remoteUrl: string): string | undefined {
  try {
    const url = new URL(remoteUrl);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return undefined;
    }

    return normalizeHostname(url.hostname);
  } catch {
    return undefined;
  }
}

function buildGitConfigArgs(
  remoteHosts: string[],
  options: { bypassGitProxy: boolean; useGithubToken: boolean },
): string[] {
  const args: string[] = [];

  if (options.bypassGitProxy) {
    for (const host of remoteHosts) {
      args.push("-c", `http.https://${host}.proxy=`);
    }
  }

  if (options.useGithubToken) {
    args.push(
      "-c",
      "credential.helper=",
      "-c",
      `credential.helper=${GITHUB_TOKEN_CREDENTIAL_HELPER}`,
    );
  }

  return args;
}

function buildGitEnv(
  remoteHosts: string[],
  options: { scrubProxyEnv: boolean; githubToken?: string },
): NodeJS.ProcessEnv {
  const env = { ...process.env };

  if (options.scrubProxyEnv) {
    for (const name of PROXY_ENV_NAMES) {
      delete env[name];
    }

    const noProxy = mergeNoProxyHosts(env, remoteHosts);

    for (const name of NO_PROXY_ENV_NAMES) {
      env[name] = noProxy;
    }
  }

  if (options.githubToken !== undefined) {
    env.SKUL_GIT_AUTH_TOKEN = options.githubToken;
  }

  return env;
}

function mergeNoProxyHosts(
  env: NodeJS.ProcessEnv,
  remoteHosts: string[],
): string {
  const existing = NO_PROXY_ENV_NAMES.flatMap((name) =>
    (env[name] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const merged = new Set([...existing, ...remoteHosts]);

  return [...merged].join(",");
}

function getGithubToken(env: NodeJS.ProcessEnv): string | undefined {
  return env.GH_TOKEN || env.GITHUB_TOKEN || undefined;
}

function hasLoopbackProxy(env: NodeJS.ProcessEnv): boolean {
  return PROXY_ENV_NAMES.some((name) => {
    const value = env[name];

    return value ? isLoopbackProxy(value) : false;
  });
}

function isLoopbackProxy(value: string): boolean {
  const hostname = parseProxyHostname(value);

  return (
    hostname !== undefined &&
    (LOOPBACK_HOSTS.has(hostname) || hostname.startsWith("127."))
  );
}

function parseProxyHostname(value: string): string | undefined {
  const proxyValue = value.trim();

  if (!proxyValue) {
    return undefined;
  }

  const urlValue = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(proxyValue)
    ? proxyValue
    : `http://${proxyValue}`;

  try {
    return normalizeHostname(new URL(urlValue).hostname);
  } catch {
    return undefined;
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
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
