import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { CachedBundle } from "./bundle-discovery";
import type { ResolvedBundleItemRef } from "./bundle-item-refs";
import type {
  DesiredBundleEntry,
  MaterializedBundleState,
  MaterializedState,
  RootInstructionMode,
} from "./registry";
import { collectComposedRootInstructionContents } from "./root-instruction-content";
import {
  composeRootInstructionContent,
  isRootInstructionPath,
  wrapRootInstructionBundleContent,
  wrapSkulManagedInstructionContent,
} from "./root-instruction-render";
import type { ToolName } from "./tool-mapping";
import { globalCapableToolNames } from "./tool-mapping";

/** Captures pre-existing root-instruction file contents before Skul starts managing them. */
export function captureRootInstructionBaseContents(options: {
  repoRoot: string;
  targetPaths: Set<string>;
  existingBaseContents?: Record<string, string>;
  managedTargetPaths?: Set<string>;
}): Record<string, string> | undefined {
  if (options.targetPaths.size === 0) {
    return options.existingBaseContents;
  }

  const nextBaseContents = { ...(options.existingBaseContents ?? {}) };

  for (const repoRelativePath of options.targetPaths) {
    if (repoRelativePath in nextBaseContents) {
      continue;
    }

    if (options.managedTargetPaths?.has(repoRelativePath)) {
      continue;
    }

    const targetPath = path.join(options.repoRoot, repoRelativePath);

    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
      continue;
    }

    nextBaseContents[repoRelativePath] = fs.readFileSync(targetPath, "utf8");
  }

  return Object.keys(nextBaseContents).length > 0
    ? nextBaseContents
    : undefined;
}

/** Rebuilds shared root-instruction files from desired bundle state and returns the rewritten paths. */
export function syncManagedRootInstructionFiles(options: {
  repoRoot: string;
  desiredState: DesiredBundleEntry[];
  materializedBundles: MaterializedState["bundles"];
  rootInstructionBaseContents?: Record<string, string>;
  targetPaths?: Set<string>;
  resolveCachedBundle: (entry: DesiredBundleEntry) => CachedBundle;
  repoRelPathRemapper?: (toolName: string, relPath: string) => string;
  resolvedBundleItemRefsByBundle?: ReadonlyMap<
    string,
    ReadonlyMap<string, ResolvedBundleItemRef>
  >;
}): Set<string> {
  const contentByPath = collectRootInstructionContentByPath(options);
  const writtenPaths = new Set<string>();

  for (const [repoRelativePath, composed] of contentByPath.entries()) {
    const baseContent =
      composed.mode === "replace"
        ? undefined
        : options.rootInstructionBaseContents?.[repoRelativePath];
    const targetPath = path.join(options.repoRoot, repoRelativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(
      targetPath,
      `${composeRootInstructionContent([
        baseContent,
        wrapSkulManagedInstructionContent(
          composeRootInstructionContent(composed.parts),
        ),
      ])}\n`,
    );
    writtenPaths.add(repoRelativePath);
  }

  return writtenPaths;
}

function collectRootInstructionContentByPath(options: {
  desiredState: DesiredBundleEntry[];
  materializedBundles: MaterializedState["bundles"];
  targetPaths?: Set<string>;
  resolveCachedBundle: (entry: DesiredBundleEntry) => CachedBundle;
  repoRelPathRemapper?: (toolName: string, relPath: string) => string;
  resolvedBundleItemRefsByBundle?: ReadonlyMap<
    string,
    ReadonlyMap<string, ResolvedBundleItemRef>
  >;
}): Map<string, { parts: string[]; mode: RootInstructionMode }> {
  const contentByPath = new Map<
    string,
    { parts: string[]; mode: RootInstructionMode }
  >();
  const seenBundleTargets = new Set<string>();

  for (const desiredEntry of options.desiredState) {
    const materializedBundleState =
      options.materializedBundles[desiredEntry.bundle];

    if (!materializedBundleState) {
      continue;
    }

    const cachedBundle = options.resolveCachedBundle(desiredEntry);
    const toolNames = Object.keys(materializedBundleState.tools) as ToolName[];

    if (options.repoRelPathRemapper) {
      // In global mode, tools that share a project path (e.g. AGENTS.md) may remap to different
      // global targets (e.g. .github/copilot-instructions.md vs .gemini/GEMINI.md). Collect and
      // remap per-tool so each tool maps to its own global path independently.
      // Only process globally-capable tools; non-global tools in the materialized state (e.g. from
      // registry corruption) would pass through the remapper unchanged and write to homeDir at the
      // project-level path.
      const globalTools = globalCapableToolNames();
      for (const toolName of toolNames.filter((t) => globalTools.includes(t))) {
        const rawToolContentByPath = collectComposedRootInstructionContents({
          bundleDir: path.dirname(cachedBundle.manifestFile),
          manifest: cachedBundle.manifest,
          toolNames: [toolName],
          targetPaths: undefined,
          itemSelectors: desiredEntry.items,
          resolvedBundleItemRefs: options.resolvedBundleItemRefsByBundle?.get(
            desiredEntry.bundle,
          ),
        });

        const toolContentByPath = Object.fromEntries(
          Object.entries(rawToolContentByPath).map(([k, v]) => [
            options.repoRelPathRemapper!(toolName, k),
            v,
          ]),
        );

        for (const repoRelativePath of materializedBundleState.tools[toolName]!
          .files) {
          if (!isRootInstructionPath(repoRelativePath)) {
            continue;
          }

          if (
            options.targetPaths &&
            !options.targetPaths.has(repoRelativePath)
          ) {
            continue;
          }

          const content = toolContentByPath[repoRelativePath];

          if (content === undefined) {
            continue;
          }

          const bundleTargetKey = `${desiredEntry.bundle}:${repoRelativePath}`;

          if (seenBundleTargets.has(bundleTargetKey)) {
            continue;
          }

          seenBundleTargets.add(bundleTargetKey);
          addRootInstructionPart({
            contentByPath,
            repoRelativePath,
            desiredEntry,
            content,
          });
        }
      }
    } else {
      // Non-global mode: collect all tools at once so tools sharing a path (e.g. multiple tools
      // targeting AGENTS.md) have their content properly aggregated before writing.
      const rawBundleContentByPath = collectComposedRootInstructionContents({
        bundleDir: path.dirname(cachedBundle.manifestFile),
        manifest: cachedBundle.manifest,
        toolNames,
        targetPaths: options.targetPaths,
        itemSelectors: desiredEntry.items,
        resolvedBundleItemRefs: options.resolvedBundleItemRefsByBundle?.get(
          desiredEntry.bundle,
        ),
      });

      for (const toolName of toolNames) {
        for (const repoRelativePath of materializedBundleState.tools[toolName]!
          .files) {
          if (!isRootInstructionPath(repoRelativePath)) {
            continue;
          }

          if (
            options.targetPaths &&
            !options.targetPaths.has(repoRelativePath)
          ) {
            continue;
          }

          const content = rawBundleContentByPath[repoRelativePath];

          if (content === undefined) {
            continue;
          }

          const bundleTargetKey = `${desiredEntry.bundle}:${repoRelativePath}`;

          if (seenBundleTargets.has(bundleTargetKey)) {
            continue;
          }

          seenBundleTargets.add(bundleTargetKey);
          addRootInstructionPart({
            contentByPath,
            repoRelativePath,
            desiredEntry,
            content,
          });
        }
      }
    }
  }

  return contentByPath;
}

/** Adds one bundle's root content and rejects ambiguous mixed composition modes. */
function addRootInstructionPart(options: {
  contentByPath: Map<string, { parts: string[]; mode: RootInstructionMode }>;
  repoRelativePath: string;
  desiredEntry: DesiredBundleEntry;
  content: string;
}): void {
  const mode = options.desiredEntry.root_instruction_mode ?? "append";
  const existing = options.contentByPath.get(options.repoRelativePath);

  if (existing && existing.mode !== mode) {
    throw new Error(
      `Cannot compose ${options.repoRelativePath} because bundles use mixed root instruction modes (${existing.mode} and ${mode})`,
    );
  }

  const composed = existing ?? { parts: [], mode };
  composed.parts.push(
    wrapRootInstructionBundleContent({
      bundleName: options.desiredEntry.bundle,
      source: options.desiredEntry.source,
      content: options.content,
    }),
  );
  options.contentByPath.set(options.repoRelativePath, composed);
}

/** Restores preserved base content for root-instruction files that Skul no longer manages. */
export function restoreRootInstructionBaseContents(options: {
  repoRoot: string;
  baseContents?: Record<string, string>;
  targetPaths: Set<string>;
}): Set<string> {
  if (!options.baseContents || options.targetPaths.size === 0) {
    return new Set<string>();
  }

  const restoredPaths = new Set<string>();

  for (const repoRelativePath of options.targetPaths) {
    const baseContent = options.baseContents[repoRelativePath];

    if (baseContent === undefined) {
      continue;
    }

    const targetPath = path.join(options.repoRoot, repoRelativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, baseContent);
    restoredPaths.add(repoRelativePath);
  }

  return restoredPaths;
}

/** Refreshes fingerprints for a subset of managed files after they are rewritten in place. */
export function refreshManagedFileFingerprintsForPaths(
  repoRoot: string,
  bundles: MaterializedState["bundles"],
  filePaths: Set<string>,
): MaterializedState["bundles"] {
  if (filePaths.size === 0) {
    return bundles;
  }

  return Object.fromEntries(
    Object.entries(bundles).map(([bundleName, bundleState]) => [
      bundleName,
      {
        ...bundleState,
        tools: Object.fromEntries(
          Object.entries(bundleState.tools).map(([toolName, toolState]) => [
            toolName,
            {
              ...toolState,
              file_fingerprints: {
                ...(toolState.file_fingerprints ?? {}),
                ...captureManagedFileFingerprints(
                  repoRoot,
                  toolState.files.filter((filePath) => filePaths.has(filePath)),
                ),
              },
            },
          ]),
        ),
      } satisfies MaterializedBundleState,
    ]),
  );
}

function captureManagedFileFingerprints(
  repoRoot: string,
  files: string[],
): Record<string, string> {
  return Object.fromEntries(
    files.map((relativePath) => [
      relativePath,
      fingerprintFile(path.join(repoRoot, relativePath)),
    ]),
  );
}

function fingerprintFile(filePath: string): string {
  try {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    // On read failure treat the file as modified so callers prompt before deletion
    // rather than silently skipping a managed file that may still exist.
    return "";
  }
}

/** Returns every root-instruction path currently owned by managed bundles. */
export function collectManagedRootInstructionTargets(
  bundles: MaterializedState["bundles"],
): Set<string> {
  return new Set(
    Object.values(bundles).flatMap((bundleState) =>
      Object.values(bundleState.tools).flatMap((toolState) =>
        toolState.files.filter((filePath) => isRootInstructionPath(filePath)),
      ),
    ),
  );
}

/** Verifies that every bundle needed for shared root-instruction recomposition is cached. */
export function assertManagedRootInstructionSyncSourcesCached(options: {
  desiredState: DesiredBundleEntry[];
  materializedBundles: MaterializedState["bundles"];
  targetPaths: Set<string>;
  resolveCachedBundle: (entry: DesiredBundleEntry) => CachedBundle;
}): void {
  if (options.targetPaths.size === 0) {
    return;
  }

  for (const desiredEntry of options.desiredState) {
    const materializedBundleState =
      options.materializedBundles[desiredEntry.bundle];

    if (!materializedBundleState) {
      continue;
    }

    const ownsTargetPath = Object.values(materializedBundleState.tools).some(
      (toolState) =>
        toolState.files.some((filePath) => options.targetPaths.has(filePath)),
    );

    if (!ownsTargetPath) {
      continue;
    }

    options.resolveCachedBundle(desiredEntry);
  }
}

/** Collects other bundles that already own root-instruction paths targeted by an upcoming write. */
export function collectSharedRootInstructionState(
  bundles: MaterializedState["bundles"],
  plannedWriteTargets: string[],
  excludedBundleName: string,
): { files: string[]; file_fingerprints: Record<string, string> } {
  const sharedRootTargets = new Set(
    plannedWriteTargets.filter((filePath) => isRootInstructionPath(filePath)),
  );
  const files = new Set<string>();
  const fileFingerprints: Record<string, string> = {};

  for (const [bundleName, bundleState] of Object.entries(bundles)) {
    if (bundleName === excludedBundleName) {
      continue;
    }

    const flattenedState = flattenBundleState(bundleState);

    for (const filePath of flattenedState.files) {
      if (!sharedRootTargets.has(filePath)) {
        continue;
      }

      files.add(filePath);

      if (flattenedState.file_fingerprints[filePath]) {
        fileFingerprints[filePath] = flattenedState.file_fingerprints[filePath];
      }
    }
  }

  return {
    files: Array.from(files),
    file_fingerprints: fileFingerprints,
  };
}

function flattenBundleState(bundleState: MaterializedBundleState): {
  files: string[];
  file_fingerprints: Record<string, string>;
} {
  const files = new Set<string>();
  const fileFingerprints: Record<string, string> = {};

  for (const toolState of Object.values(bundleState.tools)) {
    for (const file of toolState.files) {
      files.add(file);
    }

    if (toolState.file_fingerprints) {
      Object.assign(fileFingerprints, toolState.file_fingerprints);
    }
  }

  return {
    files: Array.from(files),
    file_fingerprints: fileFingerprints,
  };
}
