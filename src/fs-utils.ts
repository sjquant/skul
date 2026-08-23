import fs from "node:fs";
import path from "node:path";

/** Reads a directory and returns an empty list when it cannot be read. */
export function safeReaddirSync(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Returns the slash-delimited segment count for a relative path. */
export function pathDepth(value: string): number {
  return value.split("/").length;
}

/** Escapes a string so it can be embedded in a regular expression literally. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Writes a file by replacing it wholesale, so an interrupted write cannot leave
 * a truncated file behind.
 *
 * Skul merges into configuration files it shares with the user, where a partial
 * write would destroy settings it does not own. The temporary file is created
 * beside the target so the rename stays within one filesystem, and at the
 * target's own mode rather than the ambient umask default, so a configuration
 * the user restricted — a home-directory file holding account details, say — is
 * never briefly world-readable while the copy sits beside the original.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.skul-${process.pid}-${Date.now()}`,
  );
  const existingMode = readFilePermissions(filePath);

  try {
    fs.writeFileSync(
      tempPath,
      content,
      existingMode === undefined ? {} : { mode: existingMode },
    );

    if (existingMode !== undefined) {
      // The umask masks a creation mode, so the file only reaches the target's
      // exact permissions once they are set outright.
      fs.chmodSync(tempPath, existingMode);
    }

    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // The temporary file never made it to disk.
    }

    throw error;
  }
}

/** Returns an existing file's permission bits, or undefined when it has none. */
function readFilePermissions(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mode & 0o7777;
  } catch {
    return undefined;
  }
}
