import { createHash } from "node:crypto";

import {
  listGlobalToolDefinitions,
  listToolDefinitions,
  type ToolName,
} from "./tool-mapping";

const ROOT_INSTRUCTION_PATHS: ReadonlySet<string> = new Set([
  ...listToolDefinitions()
    .map((tool) => tool.targets.root_instruction?.path)
    .filter((p): p is string => p !== undefined),
  ...listGlobalToolDefinitions()
    .map((tool) => tool.targets.root_instruction?.path)
    .filter((p): p is string => p !== undefined),
]);

const SKUL_INSTRUCTIONS_START = "<!-- SKUL:INSTRUCTIONS START -->";
const SKUL_INSTRUCTIONS_END = "<!-- SKUL:INSTRUCTIONS END -->";
const SHADOW_BLOCK_END = "<!-- SKUL SHADOW END -->";
const SKUL_INSTRUCTIONS_PREAMBLE =
  "Follow the instructions in this section; SKUL markers are metadata used to manage the content.";

/** Joins root-instruction parts into one normalized document body. */
export function composeRootInstructionContent(
  parts: Array<string | undefined>,
): string {
  return parts
    .map((part) => normalizeRootInstructionPart(part))
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/** One bundle's contribution to a tracked root-instruction shadow. */
export interface TrackedRootInstructionOverlay {
  bundleName: string;
  content: string;
}

export interface RenderTrackedRootInstructionShadowOptions {
  baseContent?: string;
  overlays: TrackedRootInstructionOverlay[];
  toolName: ToolName;
  strategy: "append" | "prepend" | "replace";
  allowReplace?: boolean;
}

export interface RenderTrackedRootInstructionShadowResult {
  /** Fingerprint of the block rendered for each overlay, in the same order. */
  overlayFingerprints: string[];
  rendered: string;
  renderedFingerprint: string;
}

/**
 * Renders a deterministic tracked root-instruction shadow plus the
 * fingerprints later lifecycle commands use to detect stale overlays and
 * local manual edits.
 *
 * Every overlay keeps its own boundary markers, so a file several bundles
 * contribute to stays readable and each contribution stays identifiable. The
 * strategy decides where the composed blocks sit relative to the committed
 * base — or, for `replace`, that the base is dropped entirely.
 */
export function renderTrackedRootInstructionShadow(
  options: RenderTrackedRootInstructionShadowOptions,
): RenderTrackedRootInstructionShadowResult {
  if (options.strategy === "replace" && options.allowReplace !== true) {
    throw new Error(
      `Tracked root-instruction replace strategy for ${options.toolName} requires explicit confirmation`,
    );
  }

  const blocks = options.overlays.map((overlay) =>
    formatTrackedRootInstructionShadowBlock({
      bundleName: overlay.bundleName,
      content: overlay.content,
    }),
  );
  const rendered = renderTrackedRootInstructionDocument({
    baseContent: options.baseContent,
    overlay: composeRootInstructionContent(blocks),
    strategy: options.strategy,
  });

  return {
    overlayFingerprints: blocks.map((block) => fingerprintShadowContent(block)),
    rendered,
    renderedFingerprint: fingerprintShadowContent(rendered),
  };
}

/**
 * Reads one bundle's rendered shadow block back out of a shadowed file.
 *
 * Status compares this against the stored overlay fingerprint, so it has to
 * find the very markers `renderTrackedRootInstructionShadow` wrote — which is
 * why extraction lives beside the formatter rather than restating its markers.
 */
export function extractTrackedRootInstructionShadowBlock(options: {
  content: string;
  bundleName: string;
}): string | null {
  const startMarker = formatShadowBlockStartMarker(options.bundleName);
  const startIndex = options.content.indexOf(startMarker);

  if (startIndex < 0) {
    return null;
  }

  const endIndex = options.content.indexOf(SHADOW_BLOCK_END, startIndex);

  if (endIndex < 0) {
    return null;
  }

  return normalizeRootInstructionPart(
    options.content.slice(startIndex, endIndex + SHADOW_BLOCK_END.length),
  );
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
    `<!-- SKUL:BUNDLE ${label} -->`,
    normalizedContent,
    "<!-- /SKUL:BUNDLE -->",
  ].join("\n");
}

/** Wraps generated root instructions with one model-facing Skul explanation. */
export function wrapSkulManagedInstructionContent(content: string): string {
  const normalizedContent = normalizeRootInstructionPart(content);

  if (normalizedContent.length === 0) {
    return "";
  }

  return [
    SKUL_INSTRUCTIONS_START,
    SKUL_INSTRUCTIONS_PREAMBLE,
    normalizedContent,
    SKUL_INSTRUCTIONS_END,
  ].join("\n\n");
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
    formatShadowBlockStartMarker(options.bundleName),
    normalizedContent,
    SHADOW_BLOCK_END,
  ].join("\n");
}

function formatShadowBlockStartMarker(bundleName: string): string {
  return `<!-- SKUL SHADOW START bundle=${bundleName} -->`;
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
    return ensureTrailingNewline(
      wrapSkulManagedInstructionContent(options.overlay),
    );
  }

  if (options.overlay.length === 0) {
    return options.baseContent ?? "";
  }

  const managedContent = wrapSkulManagedInstructionContent(options.overlay);

  if (!options.baseContent || options.baseContent.length === 0) {
    return ensureTrailingNewline(managedContent);
  }

  if (options.strategy === "prepend") {
    return `${managedContent}\n\n${options.baseContent}`;
  }

  return `${options.baseContent}${selectAppendSeparator(options.baseContent)}${managedContent}\n`;
}

/** Fingerprints shadow content so later commands can detect local edits. */
export function fingerprintShadowContent(content: string): string {
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
