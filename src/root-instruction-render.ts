import { createHash } from "node:crypto";

import { type ToolName } from "./tool-mapping";

/** Joins root-instruction parts into one normalized document body. */
export function composeRootInstructionContent(parts: Array<string | undefined>): string {
  return parts
    .map((part) => normalizeRootInstructionPart(part))
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export interface RenderTrackedRootInstructionShadowOptions {
  baseContent?: string;
  overlayContent: string;
  bundleName: string;
  toolName: ToolName;
  strategy: "append" | "prepend" | "replace";
  allowReplace?: boolean;
}

export interface RenderTrackedRootInstructionShadowResult {
  overlay: string;
  rendered: string;
  overlayFingerprint: string;
  renderedFingerprint: string;
}

/**
 * Renders a deterministic tracked root-instruction shadow plus the
 * fingerprints later lifecycle commands use to detect stale overlays and
 * local manual edits.
 */
export function renderTrackedRootInstructionShadow(
  options: RenderTrackedRootInstructionShadowOptions,
): RenderTrackedRootInstructionShadowResult {
  if (options.strategy === "replace" && options.allowReplace !== true) {
    throw new Error(
      `Tracked root-instruction replace strategy for ${options.toolName} requires explicit confirmation`,
    );
  }

  const overlay = formatTrackedRootInstructionShadowBlock({
    bundleName: options.bundleName,
    toolName: options.toolName,
    content: options.overlayContent,
  });
  const rendered = renderTrackedRootInstructionDocument({
    baseContent: options.baseContent,
    overlay,
    strategy: options.strategy,
  });

  return {
    overlay,
    rendered,
    overlayFingerprint: fingerprintRootInstructionContent(overlay),
    renderedFingerprint: fingerprintRootInstructionContent(rendered),
  };
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

/** Wraps tracked shadow overlay content with deterministic marker boundaries. */
export function formatTrackedRootInstructionShadowBlock(options: {
  bundleName: string;
  toolName: ToolName;
  content: string;
}): string {
  const normalizedContent = normalizeRootInstructionPart(options.content);

  return [
    `<!-- SKUL SHADOW START bundle=${options.bundleName} -->`,
    normalizedContent,
    "<!-- SKUL SHADOW END -->",
  ]
    .filter((part, index) => index === 0 || index === 2 || part.length > 0)
    .join("\n");
}

/** Returns whether content still matches the recorded shadow render fingerprint. */
export function hasTrackedRootInstructionManualEdit(options: {
  content: string;
  renderedFingerprint: string;
}): boolean {
  return fingerprintRootInstructionContent(options.content) !== options.renderedFingerprint;
}

/** Returns whether a repo-relative path is a managed root-instruction file. */
export function isRootInstructionPath(repoRelativePath: string): boolean {
  return repoRelativePath === "AGENTS.md" || repoRelativePath === "CLAUDE.md";
}

function renderTrackedRootInstructionDocument(options: {
  baseContent?: string;
  overlay: string;
  strategy: "append" | "prepend" | "replace";
}): string {
  if (options.strategy === "replace") {
    return ensureTrailingNewline(composeRootInstructionContent([options.overlay]));
  }

  const parts =
    options.strategy === "prepend"
      ? [options.overlay, options.baseContent]
      : [options.baseContent, options.overlay];

  return ensureTrailingNewline(composeRootInstructionContent(parts));
}

function fingerprintRootInstructionContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function ensureTrailingNewline(content: string): string {
  return content.length === 0 ? "" : `${content}\n`;
}

function normalizeRootInstructionPart(part: string | undefined): string {
  return part?.replace(/\s+$/, "") ?? "";
}
