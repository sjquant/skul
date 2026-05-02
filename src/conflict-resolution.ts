import path from "node:path";

export const DEFAULT_CONFLICT_PREFIX = "p";

/** Normalizes a user-supplied conflict destination within one managed target root. */
export function normalizeConflictDestination(input: string): string | null {
  const normalizedValue = input.trim().split(path.sep).join("/");

  if (
    !normalizedValue ||
    path.isAbsolute(normalizedValue) ||
    normalizedValue === "." ||
    normalizedValue === ".." ||
    normalizedValue.startsWith("../") ||
    normalizedValue.includes("/../")
  ) {
    return null;
  }

  return normalizedValue;
}

/** Normalizes a user-supplied conflict prefix into one safe path segment. */
export function normalizeConflictPrefix(input: string): string | null {
  const normalizedValue = input.trim();

  if (
    !normalizedValue ||
    normalizedValue.includes("/") ||
    normalizedValue.includes(path.sep) ||
    normalizedValue === "." ||
    normalizedValue === ".."
  ) {
    return null;
  }

  return normalizedValue;
}

/** Prefixes the leading filename or directory segment of a relative path. */
export function suggestPrefixedDestination(relativePath: string, prefix: string): string {
  const segments = relativePath.split("/");
  const [firstSegment, ...rest] = segments;

  if (!firstSegment) {
    return relativePath;
  }

  const extension = path.posix.extname(firstSegment);
  const basename = extension ? firstSegment.slice(0, -extension.length) : firstSegment;
  const prefixedSegment = `${basename ? `${prefix}-${basename}` : prefix}${extension}`;

  return [prefixedSegment, ...rest].join("/");
}
