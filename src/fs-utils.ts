import fs from "node:fs";

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
