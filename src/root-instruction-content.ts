import fs from "node:fs";
import path from "node:path";
import type { ResolvedBundleItemRef } from "./bundle-item-refs";
import {
  type BundleItemSelector,
  isRootInstructionItemSelected,
} from "./bundle-items";
import type { BundleManifest } from "./bundle-manifest";
import {
  toTranslationToolName,
  translateRootInstruction,
} from "./bundle-translation";
import { composeRootInstructionContent } from "./root-instruction-render";
import type { ToolName } from "./tool-mapping";

/** Reads and translates one tool's root-instruction source files by target path. */
function collectRootInstructionContents(options: {
  bundleDir: string;
  manifest: BundleManifest;
  toolName: ToolName;
  resolvedBundleItemRefs?: ReadonlyMap<string, ResolvedBundleItemRef>;
}): Record<string, string> {
  const target = options.manifest.tools[options.toolName]?.root_instruction;

  if (!target) {
    return {};
  }

  const sourceFile =
    options.resolvedBundleItemRefs?.get("root-instruction")?.path ??
    path.join(options.bundleDir, target.path);
  const source = fs.readFileSync(sourceFile, "utf8");

  return translateRootInstruction({
    targetTool: toTranslationToolName(options.toolName),
    source,
  });
}

/** Collects all translated root-instruction parts and composes them per output path. */
export function collectComposedRootInstructionContents(options: {
  bundleDir: string;
  manifest: BundleManifest;
  toolNames: ToolName[];
  targetPaths?: Set<string>;
  itemSelectors?: BundleItemSelector[];
  resolvedBundleItemRefs?: ReadonlyMap<string, ResolvedBundleItemRef>;
}): Record<string, string> {
  if (!isRootInstructionItemSelected(options.itemSelectors)) {
    return {};
  }

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
      resolvedBundleItemRefs: options.resolvedBundleItemRefs,
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
