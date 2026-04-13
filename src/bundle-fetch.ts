import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface FetchRemoteSourceOptions {
  /** Normalized source identifier, e.g. "github.com/owner/repo" */
  source: string;
  libraryDir: string;
}

export interface FetchRemoteSourceResult {
  /** true if a fresh clone was performed; false if the cache already existed */
  cloned: boolean;
  targetDir: string;
}

/**
 * Ensures a remote git source is present in the local library cache.
 * If the target directory already exists the operation is a no-op (returns cloned: false).
 * Otherwise the repo is shallow-cloned into libraryDir/host/owner/repo.
 */
export function fetchRemoteSource(options: FetchRemoteSourceOptions): FetchRemoteSourceResult {
  const { source, libraryDir } = options;
  const targetDir = path.join(libraryDir, ...source.split("/"));

  if (fs.existsSync(targetDir)) {
    return { cloned: false, targetDir };
  }

  const cloneUrl = `https://${source}`;
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });

  try {
    execFileSync("git", ["clone", "--depth=1", cloneUrl, targetDir], { stdio: "pipe" });
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

    const stderr =
      error instanceof Error && "stderr" in error
        ? String((error as { stderr: Buffer | string }).stderr).trim()
        : String(error);

    throw new Error(`Failed to clone ${cloneUrl}${stderr ? `:\n${stderr}` : ""}`);
  }

  return { cloned: true, targetDir };
}
