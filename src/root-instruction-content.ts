import fs from "node:fs";
import path from "node:path";

import type { BundleManifest } from "./bundle-manifest";
import { translateRootInstruction } from "./bundle-translation";
import { composeRootInstructionContent } from "./root-instruction-render";
import type { ToolName } from "./tool-mapping";

/** Reads and translates one tool's root-instruction source files by target path. */
function collectRootInstructionContents(options: {
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

/** Collects all translated root-instruction parts and composes them per output path. */
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

function toTranslationToolName(
  toolName: ToolName,
): "claude" | "cursor" | "opencode" | "codex" | "copilot" | "kiro" {
  if (toolName === "claude-code") {
    return "claude";
  }

  return toolName;
}
