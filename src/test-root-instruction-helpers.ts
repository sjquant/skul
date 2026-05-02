export function formatRootInstructionBundleBlock(bundle: string, content: string, source?: string): string {
  const label = source ? `${bundle} (${source})` : bundle;
  const normalizedContent = content.replace(/\s+$/, "");
  return `<!-- BEGIN SKUL BUNDLE: ${label} -->\n${normalizedContent}\n<!-- END SKUL BUNDLE: ${label} -->`;
}

export function formatExpectedRootInstructionDocument(...parts: string[]): string {
  return `${parts.map((part) => part.replace(/\s+$/, "")).filter((part) => part.length > 0).join("\n\n")}\n`;
}
