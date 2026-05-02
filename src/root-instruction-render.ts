/** Joins root-instruction parts into one normalized document body. */
export function composeRootInstructionContent(parts: Array<string | undefined>): string {
  return parts
    .map((part) => normalizeRootInstructionPart(part))
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/** Wraps one bundle's root-instruction content with explicit boundary markers. */
export function wrapRootInstructionBundleContent(options: {
  bundleName: string;
  source?: string;
  content: string;
}): string {
  const normalizedContent = normalizeRootInstructionPart(options.content);

  if (normalizedContent.length === 0) {
    return "";
  }

  const label = options.source ? `${options.bundleName} (${options.source})` : options.bundleName;

  return [
    `<!-- BEGIN SKUL BUNDLE: ${label} -->`,
    normalizedContent,
    `<!-- END SKUL BUNDLE: ${label} -->`,
  ].join("\n");
}

/** Returns whether a repo-relative path is a managed root-instruction file. */
export function isRootInstructionPath(repoRelativePath: string): boolean {
  return repoRelativePath === "AGENTS.md" || repoRelativePath === "CLAUDE.md";
}

function normalizeRootInstructionPart(part: string | undefined): string {
  return part?.replace(/\s+$/, "") ?? "";
}
