import { createHash } from "node:crypto";

import { listGlobalToolDefinitions, listToolDefinitions, type ToolName } from "./tool-mapping";

const ROOT_INSTRUCTION_PATHS: ReadonlySet<string> = new Set([
  ...listToolDefinitions()
    .map((tool) => tool.targets.root_instruction?.path)
    .filter((p): p is string => p !== undefined),
  ...listGlobalToolDefinitions()
    .map((tool) => tool.targets.root_instruction?.path)
    .filter((p): p is string => p !== undefined),
]);

/** Joins root-instruction parts into one normalized document body. */
export function composeRootInstructionContent(
  parts: Array<string | undefined>,
): string {
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

  const normalizedOverlayContent = normalizeRootInstructionPart(
    options.overlayContent,
  );
  const overlay =
    options.strategy === "replace"
      ? normalizedOverlayContent
      : formatTrackedRootInstructionShadowBlock({
          bundleName: options.bundleName,
          content: normalizedOverlayContent,
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

  const label = options.source
    ? `${options.bundleName} (${options.source})`
    : options.bundleName;

  return [
    `<!-- BEGIN SKUL BUNDLE: ${label} -->`,
    normalizedContent,
    `<!-- END SKUL BUNDLE: ${label} -->`,
  ].join("\n");
}

/** Wraps tracked shadow overlay content with deterministic marker boundaries. */
function formatTrackedRootInstructionShadowBlock(options: {
  bundleName: string;
  content: string;
}): string {
  const normalizedContent = normalizeRootInstructionPart(options.content);

  if (normalizedContent.length === 0) {
    return "";
  }

  return [
    `<!-- SKUL SHADOW START bundle=${options.bundleName} -->`,
    normalizedContent,
    "<!-- SKUL SHADOW END -->",
  ].join("\n");
}

/** Returns whether content still matches the recorded shadow render fingerprint. */
function hasTrackedRootInstructionManualEdit(options: {
  content: string;
  renderedFingerprint: string;
}): boolean {
  return (
    fingerprintRootInstructionContent(options.content) !==
    options.renderedFingerprint
  );
}

/** Returns whether a repo-relative path is a managed root-instruction file. */
export function isRootInstructionPath(repoRelativePath: string): boolean {
  return ROOT_INSTRUCTION_PATHS.has(repoRelativePath);
}

function renderTrackedRootInstructionDocument(options: {
  baseContent?: string;
  overlay: string;
  strategy: "append" | "prepend" | "replace";
}): string {
  if (options.strategy === "replace") {
    return ensureTrailingNewline(options.overlay);
  }

  if (options.overlay.length === 0) {
    return options.baseContent ?? "";
  }

  if (!options.baseContent || options.baseContent.length === 0) {
    return ensureTrailingNewline(options.overlay);
  }

  if (options.strategy === "prepend") {
    return `${options.overlay}\n\n${options.baseContent}`;
  }

  return `${options.baseContent}${selectAppendSeparator(options.baseContent)}${options.overlay}\n`;
}

function fingerprintRootInstructionContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function ensureTrailingNewline(content: string): string {
  return content.length === 0 ? "" : `${content}\n`;
}

function selectAppendSeparator(baseContent: string): string {
  if (baseContent.endsWith("\n\n")) {
    return "";
  }

  if (baseContent.endsWith("\n")) {
    return "\n";
  }

  return "\n\n";
}

function normalizeRootInstructionPart(part: string | undefined): string {
  return part?.replace(/\s+$/, "") ?? "";
}
