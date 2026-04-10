import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface FetchSourceOptions {
  libraryDir: string;
  /** Normalized source, e.g. "github.com/user/ai-vault" */
  source: string;
}

/**
 * Returns true if the source looks like a remote Git host that Skul can clone
 * (any three-segment "host/owner/repo" string starting with a known host or any
 * host that is not "local").
 */
export function isFetchableSource(source: string): boolean {
  const parts = source.split("/");
  return parts.length === 3 && parts[0] !== "local";
}

/**
 * Clones the remote repository for a source into the library cache, or pulls
 * the latest commits if it has already been cloned.
 *
 * The remote URL is derived from the normalized source by prepending `https://`
 * and appending `.git`, e.g. "github.com/user/ai-vault" becomes
 * "https://github.com/user/ai-vault.git".
 *
 * Throws if git is not available or the remote cannot be reached.
 */
export function fetchSource(options: FetchSourceOptions): void {
  const { libraryDir, source } = options;
  const segments = source.split("/");

  if (segments.length !== 3) {
    throw new Error(`Cannot fetch source with unexpected format: ${source}`);
  }

  const sourceDir = path.join(libraryDir, ...segments);
  const remoteUrl = `https://${source}.git`;

  if (isGitRepo(sourceDir)) {
    execSync(`git -C "${sourceDir}" fetch --depth=1 origin`, { stdio: "pipe" });
    execSync(`git -C "${sourceDir}" reset --hard FETCH_HEAD`, { stdio: "pipe" });
  } else {
    fs.mkdirSync(path.dirname(sourceDir), { recursive: true });
    execSync(`git clone --depth=1 "${remoteUrl}" "${sourceDir}"`, { stdio: "pipe" });
  }
}

function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}
