import fs from "node:fs";
import path from "node:path";

import { type BundleManifest } from "./bundle-manifest";
import { translateRootInstruction } from "./bundle-translation";
import { type ToolName } from "./tool-mapping";

export function collectRootInstructionContents(options: {
  bundleDir: string;
  manifest: BundleManifest;
  toolName: ToolName;
}): Record<string, string> {
  const target = options.manifest.tools[options.toolName]?.root_instruction;

  if (!target) {
    return {};
  }

  const sourceFile = path.join(options.bundleDir, target.path);
  const source = fs.readFileSync(sourceFile, "utf8");

  return translateRootInstruction({
    targetTool: toTranslationToolName(options.toolName),
    source,
  });
}

export function collectComposedRootInstructionContents(options: {
  bundleDir: string;
  manifest: BundleManifest;
  toolNames: ToolName[];
  targetPaths?: Set<string>;
}): Record<string, string> {
  const partsByPath = new Map<string, string[]>();
  const seenSourceTargets = new Set<string>();

  for (const toolName of options.toolNames) {
    const sourcePath = options.manifest.tools[toolName]?.root_instruction?.path;

    if (!sourcePath) {
      continue;
    }

    const translated = collectRootInstructionContents({
      bundleDir: options.bundleDir,
      manifest: options.manifest,
      toolName,
    });

    for (const [repoRelativePath, content] of Object.entries(translated)) {
      if (options.targetPaths && !options.targetPaths.has(repoRelativePath)) {
        continue;
      }

      const sourceTargetKey = `${repoRelativePath}:${sourcePath}`;

      if (seenSourceTargets.has(sourceTargetKey)) {
        continue;
      }

      seenSourceTargets.add(sourceTargetKey);
      const existingParts = partsByPath.get(repoRelativePath) ?? [];
      existingParts.push(content);
      partsByPath.set(repoRelativePath, existingParts);
    }
  }

  return Object.fromEntries(
    Array.from(partsByPath.entries()).map(([repoRelativePath, parts]) => [
      repoRelativePath,
      composeRootInstructionContent(parts),
    ]),
  );
}

export function composeRootInstructionContent(parts: string[]): string {
  return parts
    .map((part) => normalizeRootInstructionPart(part))
    .filter((part) => part.length > 0)
    .join("\n\n");
}

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

export function isRootInstructionPath(repoRelativePath: string): boolean {
  return repoRelativePath === "AGENTS.md" || repoRelativePath === "CLAUDE.md";
}

function normalizeRootInstructionPart(part: string): string {
  return part.replace(/\s+$/, "");
}

function toTranslationToolName(toolName: ToolName): "claude" | "cursor" | "opencode" | "codex" {
  if (toolName === "codex") {
    return "codex";
  }

  if (toolName === "cursor") {
    return "cursor";
  }

  if (toolName === "opencode") {
    return "opencode";
  }

  return "claude";
}
