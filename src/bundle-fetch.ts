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

// Accepted characters in each segment of host/owner/repo.
// Defense-in-depth: normalizeBundleSource validates upstream, but this keeps
// the function safe as a standalone unit and prevents path traversal.
const SAFE_SOURCE_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

/**
 * Ensures a remote git source is present in the local library cache.
 * If the target directory already exists the operation is a no-op (returns cloned: false).
 * Otherwise the repo is shallow-cloned into libraryDir/host/owner/repo using
 * HTTPS (default) or SSH when protocol is "ssh".
 */
export function fetchRemoteSource(options: FetchRemoteSourceOptions): FetchRemoteSourceResult {
  const { source, libraryDir } = options;

  if (!SAFE_SOURCE_RE.test(source)) {
    throw new Error(`Invalid bundle source: ${source}`);
  }

  const targetDir = path.join(libraryDir, ...source.split("/"));

  if (fs.existsSync(targetDir)) {
    return { cloned: false, targetDir };
  }

  const [host, owner, repo] = source.split("/");
  const cloneUrl =
    options.protocol === "ssh"
      ? `git@${host}:${owner}/${repo}.git`
      : `https://${source}`;

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });

  process.stderr.write(`Cloning ${cloneUrl}...\n`);

  try {
    execFileSync("git", ["clone", "--depth=1", cloneUrl, targetDir], { stdio: "pipe" });
  } catch (error) {
    // Remove any partial clone so future calls don't treat an empty directory as valid cache.
    fs.rmSync(targetDir, { recursive: true, force: true });

    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new Error(
        "git is not installed or not on PATH. Install git to fetch remote bundles.",
      );
    }

    const stderr =
      error instanceof Error && "stderr" in error
        ? String((error as { stderr: Buffer | string }).stderr).trim()
        : String(error);

    throw new Error(`Failed to clone ${cloneUrl}${stderr ? `:\n${stderr}` : ""}`);
  }

  return { cloned: true, targetDir };
}
