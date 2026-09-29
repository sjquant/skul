import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Metadata file recorded in a cached source fetched without Git. */
export const SOURCE_METADATA_FILE = ".skul-source.json";

const ROOT_INSTRUCTION_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

/**
 * Builds a replacement for one cached source beside it and swaps it in. The
 * previous cache survives any failure while `populate` fills the temp dir.
 */
export async function replaceSourceDirectory(
  targetDir: string,
  populate: (tempDir: string, archiveFile: string) => Promise<void>,
): Promise<void> {
  const suffix = `${process.pid}-${Date.now()}`;
  const tempDir = `${targetDir}.tmp-${suffix}`;
  const archiveFile = `${tempDir}.tar.gz`;
  const backupDir = `${targetDir}.backup-${suffix}`;

  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(archiveFile, { force: true });
  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });

  try {
    await populate(tempDir, archiveFile);
    if (fs.existsSync(targetDir)) {
      fs.renameSync(targetDir, backupDir);
    }
    fs.renameSync(tempDir, targetDir);
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (fs.existsSync(backupDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.renameSync(backupDir, targetDir);
    }
    throw error;
  } finally {
    fs.rmSync(archiveFile, { force: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
}

/** Extracts a gzipped tarball whose contents sit in one wrapper directory into `targetDir`. */
export function extractTarball(
  archiveFile: string,
  targetDir: string,
  label: string,
): void {
  const extractDir = `${targetDir}.extract`;
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    execFileSync("tar", ["-xzf", archiveFile, "-C", extractDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const wrapperDirs = fs
      .readdirSync(extractDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());

    if (wrapperDirs.length !== 1) {
      throw new Error(`${label} did not contain one wrapper directory`);
    }

    fs.renameSync(path.join(extractDir, wrapperDirs[0]!.name), targetDir);
  } catch (error) {
    throw new Error(`Failed to extract ${label}: ${getErrorText(error)}`);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

/** Removes repository-root instruction files unless the caller keeps them. */
export function stripRepositoryRootInstructions(
  sourceDir: string,
  includeRootInstructions = false,
): void {
  if (includeRootInstructions) {
    return;
  }

  for (const fileName of ROOT_INSTRUCTION_FILE_NAMES) {
    fs.rmSync(path.join(sourceDir, fileName), { force: true });
  }
}

/** Returns a subprocess's stderr when present, otherwise the error message. */
export function getErrorText(error: unknown): string {
  if (error instanceof Error && "stderr" in error) {
    return String((error as { stderr: Buffer | string }).stderr).trim();
  }

  return error instanceof Error ? error.message : String(error);
}
