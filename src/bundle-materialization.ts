import fs from "node:fs";
import path from "node:path";
import type { ResolvedBundleItemRef } from "./bundle-item-refs";
import {
  type BundleItemSelector,
  isDirectoryItemSelected,
  isMcpItemSelected,
  isRootInstructionItemSelected,
  stripKnownBundleItemExtension,
} from "./bundle-items";
import type { BundleManifest } from "./bundle-manifest";
import {
  toTranslationToolName,
  translateAgent,
  translateCommand,
  translateRootInstruction,
  translateSkill,
} from "./bundle-translation";
import type { FileConflictResolution } from "./cli";
import { pathDepth, writeFileAtomic } from "./fs-utils";
import {
  type McpServer,
  mergeMcpConfigDocument,
  readBundleMcpServers,
  resolveMcpPluginPaths,
  supportsMcpConfig,
} from "./mcp-config";
import type { RootInstructionMode } from "./registry";
import { collectComposedRootInstructionContents } from "./root-instruction-content";
import {
  composeRootInstructionContent,
  wrapRootInstructionBundleContent,
  wrapSkulManagedInstructionContent,
} from "./root-instruction-render";
import {
  getToolDefinition,
  PROJECT_TOOL_MATERIALIZATION_LAYOUT,
  type ToolMaterializationLayout,
  type ToolName,
  type ToolTargetName,
} from "./tool-mapping";

export interface MaterializeBundleResult {
  byTool: Partial<
    Record<
      ToolName,
      {
        files: string[];
        directories: string[];
        /** MCP server names now owned in each shared configuration file. */
        mcpServers: Record<string, string[]>;
      }
    >
  >;
}

interface CanonicalTargetItem {
  selector: BundleItemSelector;
  itemName: string;
  kind?: "directory" | "file";
  localPath?: string;
  nativeRelativePath?: string;
  resolvedRef?: ResolvedBundleItemRef;
}

/**
 * Predicts the initial repo-relative files a bundle targets before any
 * conflict-resolution overwrites are applied.
 *
 * This is a side-effect-free preview used by higher-level safety checks such as
 * root-instruction shadow protection, where Skul needs to know the exact
 * root-instruction targets before it removes existing managed files or writes
 * new content.
 */
export function previewMaterializeBundleWriteTargets(options: {
  repoRoot: string;
  bundleDir: string;
  manifest: BundleManifest;
  tools?: ToolName[];
  itemSelectors?: BundleItemSelector[];
  pathLayout?: ToolMaterializationLayout;
  disableModelInvocation?: boolean;
  resolvedBundleItemRefs?: ReadonlyMap<string, ResolvedBundleItemRef>;
}): string[] {
  const writeTargets = new Set<string>();
  const pathLayout = options.pathLayout ?? PROJECT_TOOL_MATERIALIZATION_LAYOUT;
  const toolEntries =
    options.tools && options.tools.length > 0
      ? Object.entries(options.manifest.tools).filter(([toolName]) =>
          options.tools!.includes(toolName as ToolName),
        )
      : Object.entries(options.manifest.tools);

  for (const [toolName, targets] of toolEntries) {
    for (const [targetName, target] of Object.entries(targets)) {
      const targetDefinition = getToolDefinition(toolName as ToolName)?.targets[
        targetName as ToolTargetName
      ];

      if (targetName === "mcp") {
        if (!isMcpItemSelected(options.itemSelectors)) {
          continue;
        }

        const repoRelativePath = resolveMcpRepoRelPath({
          toolName: toolName as ToolName,
          repoRoot: options.repoRoot,
          pathLayout,
        });

        if (repoRelativePath) {
          writeTargets.add(repoRelativePath);
        }

        continue;
      }

      if (targetDefinition?.kind === "file") {
        if (!isRootInstructionItemSelected(options.itemSelectors)) {
          continue;
        }

        for (const repoRelativePath of previewRootInstructionWriteTargets({
          bundleDir: options.bundleDir,
          sourcePath: target.path,
          toolName: toolName as ToolName,
          targetName: targetName as ToolTargetName,
          pathLayout,
          resolvedBundleItemRefs: options.resolvedBundleItemRefs,
        })) {
          writeTargets.add(repoRelativePath);
        }

        continue;
      }

      if (
        isNativeSourcePath(
          toolName as ToolName,
          targetName as ToolTargetName,
          target.path,
        )
      ) {
        for (const repoRelativePath of previewNativeTargetWriteTargets({
          bundleDir: options.bundleDir,
          sourcePath: target.path,
          toolName: toolName as ToolName,
          targetName: targetName as ToolTargetName,
          repoRoot: options.repoRoot,
          itemSelectors: options.itemSelectors,
          pathLayout,
          resolvedBundleItemRefs: options.resolvedBundleItemRefs,
        })) {
          writeTargets.add(repoRelativePath);
        }

        continue;
      }

      for (const repoRelativePath of previewCanonicalTargetWriteTargets({
        bundleDir: options.bundleDir,
        sourcePath: target.path,
        toolName: toolName as ToolName,
        targetName: targetName as ToolTargetName,
        itemSelectors: options.itemSelectors,
        pathLayout,
        disableModelInvocation: options.disableModelInvocation,
        resolvedBundleItemRefs: options.resolvedBundleItemRefs,
      })) {
        writeTargets.add(repoRelativePath);
      }
    }
  }

  return Array.from(writeTargets).sort((left, right) =>
    left.localeCompare(right),
  );
}

/**
 * Materializes a bundle into the repository, returning the files and
 * directories that became owned by each tool.
 *
 * Callers may optionally provide `assertSafeWriteTarget` to veto individual
 * writes before they happen and `resolveFileConflict` to overwrite or abort
 * colliding outputs.
 */
export async function materializeBundle(options: {
  repoRoot: string;
  bundleDir: string;
  manifest: BundleManifest;
  tools?: ToolName[];
  itemSelectors?: BundleItemSelector[];
  bundleName?: string;
  bundleSource?: string;
  assertSafeWriteTarget?: (repoRelativePath: string) => void;
  allowFileOverwriteTargets?: Set<string>;
  deferredWriteTargets?: Set<string>;
  rootInstructionBaseContents?: Record<string, string>;
  rootInstructionMode?: RootInstructionMode;
  resolveFileConflict?: (
    conflictPath: string,
  ) => Promise<FileConflictResolution>;
  pathLayout?: ToolMaterializationLayout;
  disableModelInvocation?: boolean;
  resolvedBundleItemRefs?: ReadonlyMap<string, ResolvedBundleItemRef>;
  /** Skul's bundle cache root, used to derive the bundle's ${PLUGIN_DATA} directory. */
  libraryDir?: string;
  /**
   * MCP server names this bundle already owns per configuration file, which it
   * may overwrite. Anything else in the file belongs to the user or another
   * bundle and is refused rather than replaced.
   */
  existingMcpServers?: Record<string, string[]>;
}): Promise<MaterializeBundleResult> {
  const byTool: MaterializeBundleResult["byTool"] = {};
  const writtenSharedFileTargets = new Set<string>();
  const pathLayout = options.pathLayout ?? PROJECT_TOOL_MATERIALIZATION_LAYOUT;
  const toolEntries =
    options.tools && options.tools.length > 0
      ? Object.entries(options.manifest.tools).filter(([toolName]) =>
          options.tools!.includes(toolName as ToolName),
        )
      : Object.entries(options.manifest.tools);
  const composedRootInstructionContents = isRootInstructionItemSelected(
    options.itemSelectors,
  )
    ? collectComposedRootInstructionContents({
        bundleDir: options.bundleDir,
        manifest: options.manifest,
        toolNames: toolEntries
          .filter(([, targets]) =>
            Object.keys(targets).includes("root_instruction"),
          )
          .map(([toolName]) => toolName as ToolName),
        resolvedBundleItemRefs: options.resolvedBundleItemRefs,
      })
    : {};
  const plannedMcpWrites = isMcpItemSelected(options.itemSelectors)
    ? planMcpTargetWrites({
        bundleDir: options.bundleDir,
        repoRoot: options.repoRoot,
        mcpSources: toolEntries.flatMap(([toolName, targets]) =>
          targets.mcp
            ? [[toolName as ToolName, targets.mcp.path] as const]
            : [],
        ),
        pathLayout,
        ...(options.libraryDir ? { libraryDir: options.libraryDir } : {}),
        ...(options.existingMcpServers
          ? { existingMcpServers: options.existingMcpServers }
          : {}),
        ...(options.deferredWriteTargets
          ? { deferredWriteTargets: options.deferredWriteTargets }
          : {}),
        ...(options.assertSafeWriteTarget
          ? { assertSafeWriteTarget: options.assertSafeWriteTarget }
          : {}),
      })
    : new Map<ToolName, PlannedMcpWrite>();

  for (const [toolName, targets] of toolEntries) {
    const toolFiles: string[] = [];
    const toolDirectories = new Set<string>();
    const toolMcpServers: Record<string, string[]> = {};

    for (const [targetName, target] of Object.entries(targets)) {
      const targetDefinition = getToolDefinition(toolName as ToolName)?.targets[
        targetName as ToolTargetName
      ];

      if (targetName === "mcp") {
        const plannedWrite = plannedMcpWrites.get(toolName as ToolName);

        if (plannedWrite) {
          await writeMcpTarget({
            plannedWrite,
            repoRoot: options.repoRoot,
            writtenFiles: toolFiles,
            ownedDirectories: toolDirectories,
            writtenSharedFileTargets,
            assertSafeWriteTarget: options.assertSafeWriteTarget,
            ownedMcpServers: toolMcpServers,
          });
        }

        continue;
      }

      if (targetDefinition?.kind === "file") {
        if (!isRootInstructionItemSelected(options.itemSelectors)) {
          continue;
        }

        await materializeRootInstructionTarget({
          bundleDir: options.bundleDir,
          sourcePath: target.path,
          toolName: toolName as ToolName,
          targetName: targetName as ToolTargetName,
          repoRoot: options.repoRoot,
          writtenFiles: toolFiles,
          ownedDirectories: toolDirectories,
          assertSafeWriteTarget: options.assertSafeWriteTarget,
          allowFileOverwriteTargets: options.allowFileOverwriteTargets,
          deferredWriteTargets: options.deferredWriteTargets,
          composedRootInstructionContents,
          writtenSharedFileTargets,
          rootInstructionBaseContents: options.rootInstructionBaseContents,
          rootInstructionMode: options.rootInstructionMode,
          bundleName: options.bundleName ?? options.manifest.name ?? "bundle",
          bundleSource: options.bundleSource,
          resolveFileConflict: options.resolveFileConflict,
          pathLayout,
          resolvedBundleItemRefs: options.resolvedBundleItemRefs,
        });
        continue;
      }

      if (
        isNativeSourcePath(
          toolName as ToolName,
          targetName as ToolTargetName,
          target.path,
        )
      ) {
        await materializeNativeTarget({
          bundleDir: options.bundleDir,
          sourcePath: target.path,
          toolName: toolName as ToolName,
          targetName: targetName as ToolTargetName,
          repoRoot: options.repoRoot,
          writtenFiles: toolFiles,
          ownedDirectories: toolDirectories,
          assertSafeWriteTarget: options.assertSafeWriteTarget,
          resolveFileConflict: options.resolveFileConflict,
          itemSelectors: options.itemSelectors,
          pathLayout,
          resolvedBundleItemRefs: options.resolvedBundleItemRefs,
        });
      } else {
        // Canonical path: apply cross-tool content transforms via bundle-translation.
        await materializeCanonicalTarget({
          bundleDir: options.bundleDir,
          sourcePath: target.path,
          toolName: toolName as ToolName,
          targetName: targetName as ToolTargetName,
          repoRoot: options.repoRoot,
          writtenFiles: toolFiles,
          ownedDirectories: toolDirectories,
          assertSafeWriteTarget: options.assertSafeWriteTarget,
          resolveFileConflict: options.resolveFileConflict,
          itemSelectors: options.itemSelectors,
          pathLayout,
          disableModelInvocation: options.disableModelInvocation,
          resolvedBundleItemRefs: options.resolvedBundleItemRefs,
        });
      }
    }

    toolFiles.sort((left, right) => {
      const depthDifference = pathDepth(left) - pathDepth(right);
      return depthDifference !== 0
        ? depthDifference
        : left.localeCompare(right);
    });
    const sortedToolDirs = Array.from(toolDirectories).sort((left, right) => {
      const depthDifference = pathDepth(right) - pathDepth(left);
      return depthDifference !== 0
        ? depthDifference
        : left.localeCompare(right);
    });
    byTool[toolName as ToolName] = {
      files: toolFiles,
      directories: sortedToolDirs,
      mcpServers: toolMcpServers,
    };
  }

  return { byTool };
}

async function materializeRootInstructionTarget(options: {
  bundleDir: string;
  sourcePath: string;
  toolName: ToolName;
  targetName: ToolTargetName;
  repoRoot: string;
  writtenFiles: string[];
  ownedDirectories: Set<string>;
  assertSafeWriteTarget?: (repoRelativePath: string) => void;
  allowFileOverwriteTargets?: Set<string>;
  deferredWriteTargets?: Set<string>;
  composedRootInstructionContents: Record<string, string>;
  writtenSharedFileTargets: Set<string>;
  rootInstructionBaseContents?: Record<string, string>;
  rootInstructionMode?: RootInstructionMode;
  bundleName: string;
  bundleSource?: string;
  resolveFileConflict:
    | ((conflictPath: string) => Promise<FileConflictResolution>)
    | undefined;
  pathLayout: ToolMaterializationLayout;
  resolvedBundleItemRefs?: ReadonlyMap<string, ResolvedBundleItemRef>;
}): Promise<void> {
  if (options.targetName !== "root_instruction") {
    throw new Error(`Unsupported file target: ${options.targetName}`);
  }

  const translatedContentByPath = readTranslatedRootInstructionTargets({
    bundleDir: options.bundleDir,
    sourcePath: options.sourcePath,
    toolName: options.toolName,
    resolvedBundleItemRefs: options.resolvedBundleItemRefs,
  });

  for (const [origRelPath, content] of Object.entries(
    translatedContentByPath,
  )) {
    const repoRelPath = options.pathLayout.remapRepoRelPath(
      options.toolName,
      origRelPath,
    );

    if (options.writtenSharedFileTargets.has(repoRelPath)) {
      options.writtenFiles.push(repoRelPath);
      continue;
    }

    if (options.deferredWriteTargets?.has(repoRelPath)) {
      continue;
    }

    await writeTranslatedFile({
      repoRelPath,
      content: renderRootInstructionDocument({
        repoRoot: options.repoRoot,
        repoRelPath,
        rootInstructionBaseContents: options.rootInstructionBaseContents,
        rootInstructionMode: options.rootInstructionMode,
        bundleName: options.bundleName,
        bundleSource: options.bundleSource,
        composedContent:
          options.composedRootInstructionContents[origRelPath] ?? content,
      }),
      repoRoot: options.repoRoot,
      writtenFiles: options.writtenFiles,
      ownedDirectories: options.ownedDirectories,
      reservedDestinations: new Set<string>(),
      assertSafeWriteTarget: options.assertSafeWriteTarget,
      allowExistingFileOverwrite: true,
      resolveFileConflict: options.resolveFileConflict,
      targetRoot: "",
    });

    options.writtenSharedFileTargets.add(repoRelPath);
  }
}

/**
 * Resolves the repo-relative MCP configuration path for one tool, or null when
 * the active layout has no MCP location for it.
 *
 * Every part of Skul that needs this path — the write, the tracked shadow, and
 * the reverse lookup on removal — resolves it here, because a divergence would
 * silently write a committed file directly instead of shadowing it.
 *
 * Global (`--global`) materialization has no MCP targets: the per-tool global
 * stores either live outside a stable path or hold unrelated user state, so
 * Skul only writes MCP configuration inside a worktree.
 */
export function resolveMcpRepoRelPath(options: {
  toolName: ToolName;
  repoRoot: string;
  pathLayout?: ToolMaterializationLayout;
}): string | null {
  if (!supportsMcpConfig(options.toolName)) {
    return null;
  }

  const destinationPath = (
    options.pathLayout ?? PROJECT_TOOL_MATERIALIZATION_LAYOUT
  ).resolveToolTargetPath(options.toolName, "mcp", options.repoRoot);

  return destinationPath
    ? path.relative(options.repoRoot, destinationPath).split(path.sep).join("/")
    : null;
}

/** Reads and parses a bundle's MCP declarations, refusing an unsafe source file. */
export function readBundleMcpDeclarations(options: {
  bundleDir: string;
  sourcePath: string;
}): Record<string, McpServer> {
  const sourceFile = path.join(
    options.bundleDir,
    ...options.sourcePath.split("/"),
  );
  assertBundleTargetFile(sourceFile, options.sourcePath);

  return readBundleMcpServers({ sourceFile, sourcePath: options.sourcePath });
}

/** One tool's MCP configuration write, fully resolved and ready to land on disk. */
interface PlannedMcpWrite {
  repoRelPath: string;
  content: string;
  serverNames: string[];
  /** True when Skul is bringing the file into existence, and so owns it. */
  created: boolean;
}

/**
 * Resolves every MCP configuration write before the first one happens.
 *
 * Merging can fail — a bundle declaring a server the user already has, a config
 * Skul cannot parse — and failing partway through the tool loop would leave
 * files on disk that no registry entry records, so no later command could
 * remove them. Planning all of them up front makes the MCP step either succeed
 * or touch nothing.
 */
function planMcpTargetWrites(options: {
  bundleDir: string;
  repoRoot: string;
  mcpSources: ReadonlyArray<readonly [ToolName, string]>;
  pathLayout: ToolMaterializationLayout;
  libraryDir?: string;
  existingMcpServers?: Record<string, string[]>;
  deferredWriteTargets?: Set<string>;
  assertSafeWriteTarget?: (repoRelativePath: string) => void;
}): Map<ToolName, PlannedMcpWrite> {
  const plans = new Map<ToolName, PlannedMcpWrite>();
  const claimedPaths = new Set<string>();
  const declarationsBySource = new Map<string, Record<string, McpServer>>();

  for (const [toolName, sourcePath] of options.mcpSources) {
    const repoRelPath = resolveMcpRepoRelPath({
      toolName,
      repoRoot: options.repoRoot,
      pathLayout: options.pathLayout,
    });

    if (
      !repoRelPath ||
      claimedPaths.has(repoRelPath) ||
      // A tracked target is written by the shadow lifecycle instead, which
      // keeps the committed file clean in `git status`.
      options.deferredWriteTargets?.has(repoRelPath)
    ) {
      continue;
    }

    options.assertSafeWriteTarget?.(repoRelPath);

    let servers = declarationsBySource.get(sourcePath);

    if (!servers) {
      servers = readBundleMcpDeclarations({
        bundleDir: options.bundleDir,
        sourcePath,
      });
      declarationsBySource.set(sourcePath, servers);
    }

    const existingContent = readExistingMcpConfig(
      path.join(options.repoRoot, ...repoRelPath.split("/")),
      repoRelPath,
    );
    const merged = mergeMcpConfigDocument({
      toolName,
      servers,
      pluginPaths: resolveMcpPluginPaths({
        bundleDir: options.bundleDir,
        ...(options.libraryDir ? { libraryDir: options.libraryDir } : {}),
      }),
      ...(existingContent !== null ? { existingContent } : {}),
      ownedServerNames: options.existingMcpServers?.[repoRelPath] ?? [],
      configPath: repoRelPath,
    });

    claimedPaths.add(repoRelPath);
    plans.set(toolName, {
      repoRelPath,
      content: merged.content,
      serverNames: merged.serverNames,
      created: existingContent === null,
    });
  }

  return plans;
}

/**
 * Reads a tool's current MCP configuration, refusing a target that is not a
 * regular file.
 *
 * Merging writes through whatever is at the path, and unlike an owned file this
 * write has no conflict prompt, so a symlink would silently carry Skul's
 * servers to a file outside the worktree.
 */
function readExistingMcpConfig(
  targetAbsPath: string,
  repoRelPath: string,
): string | null {
  let stats: fs.Stats;

  try {
    stats = fs.lstatSync(targetAbsPath);
  } catch {
    return null;
  }

  if (stats.isSymbolicLink()) {
    throw new Error(
      `MCP configuration path must not be a symlink: ${repoRelPath}`,
    );
  }

  if (!stats.isFile()) {
    throw new Error(`MCP configuration path must be a file: ${repoRelPath}`);
  }

  return fs.readFileSync(targetAbsPath, "utf8");
}

/**
 * Writes one planned MCP configuration and records what Skul now owns in it.
 *
 * Only a file Skul brought into existence is recorded as a managed file. A file
 * that was already there is merged into but never owned, so removal subtracts
 * Skul's servers from it rather than deleting the user's file.
 */
async function writeMcpTarget(options: {
  plannedWrite: PlannedMcpWrite;
  repoRoot: string;
  writtenFiles: string[];
  ownedDirectories: Set<string>;
  writtenSharedFileTargets: Set<string>;
  assertSafeWriteTarget?: (repoRelativePath: string) => void;
  ownedMcpServers: Record<string, string[]>;
}): Promise<void> {
  const { repoRelPath, content, serverNames, created } = options.plannedWrite;

  await writeTranslatedFile({
    repoRelPath,
    content,
    repoRoot: options.repoRoot,
    writtenFiles: created ? options.writtenFiles : [],
    ownedDirectories: options.ownedDirectories,
    reservedDestinations: new Set<string>(),
    assertSafeWriteTarget: options.assertSafeWriteTarget,
    allowExistingFileOverwrite: true,
    resolveFileConflict: undefined,
    targetRoot: "",
  });

  options.writtenSharedFileTargets.add(repoRelPath);
  options.ownedMcpServers[repoRelPath] = serverNames;
}

async function materializeNativeTarget(options: {
  bundleDir: string;
  sourcePath: string;
  toolName: ToolName;
  targetName: ToolTargetName;
  repoRoot: string;
  writtenFiles: string[];
  ownedDirectories: Set<string>;
  assertSafeWriteTarget?: (repoRelativePath: string) => void;
  resolveFileConflict:
    | ((conflictPath: string) => Promise<FileConflictResolution>)
    | undefined;
  itemSelectors?: BundleItemSelector[];
  pathLayout: ToolMaterializationLayout;
  resolvedBundleItemRefs?: ReadonlyMap<string, ResolvedBundleItemRef>;
}): Promise<void> {
  const destinationDir = options.pathLayout.resolveToolTargetPath(
    options.toolName,
    options.targetName,
    options.repoRoot,
  );

  if (!destinationDir) {
    return;
  }

  const reservedDestinations = new Set<string>();
  const destinationDirExisted = fs.existsSync(destinationDir);
  fs.mkdirSync(destinationDir, { recursive: true });

  if (!destinationDirExisted) {
    options.ownedDirectories.add(
      path.relative(options.repoRoot, destinationDir),
    );
  }

  for (const item of listNativeTargetItems(options)) {
    const sourcePath = item.resolvedRef?.path ?? item.localPath;
    const nativeRelativePath = item.nativeRelativePath;

    if (!sourcePath || !nativeRelativePath) {
      throw new Error(`Bundle item has no source path: ${item.selector}`);
    }

    const destinationPath = path.join(destinationDir, nativeRelativePath);
    const resolveFileConflict =
      item.kind === "directory"
        ? createItemScopedConflictResolver({
            itemRelativePath: nativeRelativePath,
            resolveFileConflict: options.resolveFileConflict,
          })
        : options.resolveFileConflict;

    if (item.kind === "directory") {
      if (item.resolvedRef?.description !== undefined) {
        const translated = translateCanonicalTargetItem({
          item,
          toolName: options.toolName,
          targetName: options.targetName,
        });
        await writeTranslatedItemFiles({
          translated,
          pathLayout: options.pathLayout,
          toolName: options.toolName,
          repoRoot: options.repoRoot,
          writtenFiles: options.writtenFiles,
          ownedDirectories: options.ownedDirectories,
          reservedDestinations,
          assertSafeWriteTarget: options.assertSafeWriteTarget,
          resolveFileConflict,
          targetRoot: destinationDir,
        });
        continue;
      }

      await copyDirectory(
        sourcePath,
        destinationPath,
        destinationDir,
        options.writtenFiles,
        options.ownedDirectories,
        reservedDestinations,
        options.repoRoot,
        options.assertSafeWriteTarget,
        resolveFileConflict,
      );
      continue;
    }

    if (item.resolvedRef?.description !== undefined) {
      const translated = translateCanonicalTargetItem({
        item,
        toolName: options.toolName,
        targetName: options.targetName,
      });
      await writeTranslatedItemFiles({
        translated,
        pathLayout: options.pathLayout,
        toolName: options.toolName,
        repoRoot: options.repoRoot,
        writtenFiles: options.writtenFiles,
        ownedDirectories: options.ownedDirectories,
        reservedDestinations,
        assertSafeWriteTarget: options.assertSafeWriteTarget,
        resolveFileConflict,
        targetRoot: destinationDir,
      });
      continue;
    }

    await copyFileToDestination({
      sourcePath,
      destinationPath,
      targetRoot: destinationDir,
      writtenFiles: options.writtenFiles,
      ownedDirectories: options.ownedDirectories,
      reservedDestinations,
      repoRoot: options.repoRoot,
      assertSafeWriteTarget: options.assertSafeWriteTarget,
      resolveFileConflict,
    });
  }
}

async function writeTranslatedItemFiles(options: {
  translated: Record<string, string>;
  pathLayout: ToolMaterializationLayout;
  toolName: ToolName;
  repoRoot: string;
  writtenFiles: string[];
  ownedDirectories: Set<string>;
  reservedDestinations: Set<string>;
  assertSafeWriteTarget?: (repoRelativePath: string) => void;
  resolveFileConflict:
    | ((conflictPath: string) => Promise<FileConflictResolution>)
    | undefined;
  targetRoot: string;
}): Promise<void> {
  for (const [origRelPath, content] of Object.entries(options.translated)) {
    const repoRelPath = options.pathLayout.remapRepoRelPath(
      options.toolName,
      origRelPath,
    );
    await writeTranslatedFile({
      repoRelPath,
      content,
      repoRoot: options.repoRoot,
      writtenFiles: options.writtenFiles,
      ownedDirectories: options.ownedDirectories,
      reservedDestinations: options.reservedDestinations,
      assertSafeWriteTarget: options.assertSafeWriteTarget,
      resolveFileConflict: options.resolveFileConflict,
      targetRoot: options.targetRoot,
    });
  }
}

function createItemScopedConflictResolver(options: {
  itemRelativePath: string;
  resolveFileConflict:
    | ((conflictPath: string) => Promise<FileConflictResolution>)
    | undefined;
}): ((conflictPath: string) => Promise<FileConflictResolution>) | undefined {
  if (!options.resolveFileConflict) {
    return undefined;
  }

  const resolveFileConflict = options.resolveFileConflict;
  let itemConflictResolved = false;
  const itemPath = options.itemRelativePath.split(path.sep).join("/");

  return async (conflictPath) => {
    if (conflictPath === itemPath || conflictPath.startsWith(`${itemPath}/`)) {
      if (!itemConflictResolved) {
        itemConflictResolved = true;
        return resolveFileConflict(itemPath);
      }

      return { action: "overwrite" };
    }

    return resolveFileConflict(conflictPath);
  };
}

function previewNativeTargetWriteTargets(options: {
  bundleDir: string;
  sourcePath: string;
  toolName: ToolName;
  targetName: ToolTargetName;
  repoRoot: string;
  itemSelectors?: BundleItemSelector[];
  pathLayout: ToolMaterializationLayout;
  resolvedBundleItemRefs?: ReadonlyMap<string, ResolvedBundleItemRef>;
}): string[] {
  const destinationDir = options.pathLayout.resolveToolTargetPath(
    options.toolName,
    options.targetName,
    options.repoRoot,
  );

  if (!destinationDir) {
    return [];
  }

  return listNativeTargetItems(options).flatMap((item) => {
    if (item.resolvedRef?.description !== undefined) {
      return Object.keys(
        translateCanonicalTargetItem({
          item,
          toolName: options.toolName,
          targetName: options.targetName,
        }),
      ).map((origRelPath) =>
        path.relative(
          options.repoRoot,
          pathLayoutPath(
            options.pathLayout,
            options.toolName,
            origRelPath,
            options.repoRoot,
          ),
        ),
      );
    }

    const sourcePath = item.resolvedRef?.path ?? item.localPath;
    const nativeRelativePath = item.nativeRelativePath;

    if (!sourcePath || !nativeRelativePath) {
      return [];
    }

    if (item.kind === "directory") {
      return listRelativeFiles(sourcePath).map((relativePath) =>
        path.relative(
          options.repoRoot,
          path.join(destinationDir, nativeRelativePath, relativePath),
        ),
      );
    }

    return [
      path.relative(
        options.repoRoot,
        path.join(destinationDir, nativeRelativePath),
      ),
    ];
  });
}

function pathLayoutPath(
  pathLayout: ToolMaterializationLayout,
  toolName: ToolName,
  repoRelativePath: string,
  repoRoot: string,
): string {
  return path.join(
    repoRoot,
    pathLayout.remapRepoRelPath(toolName, repoRelativePath),
  );
}

function listNativeTargetItems(options: {
  bundleDir: string;
  sourcePath: string;
  targetName: ToolTargetName;
  itemSelectors?: BundleItemSelector[];
  resolvedBundleItemRefs?: ReadonlyMap<string, ResolvedBundleItemRef>;
}): CanonicalTargetItem[] {
  const sourceDir = path.join(options.bundleDir, options.sourcePath);
  const items = new Map<BundleItemSelector, CanonicalTargetItem>();

  if (fs.existsSync(sourceDir)) {
    assertBundleTargetDirectory(sourceDir, options.sourcePath);

    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      assertNotSymlink(entry, sourceDir);
      const item = nativeTargetItemFromLocalEntry({
        entry,
        sourceDir,
        targetName: options.targetName,
      });

      if (!item || !isBundleItemSelectorSelected(options.itemSelectors, item)) {
        continue;
      }

      items.set(item.selector, item);
    }
  }

  for (const [selector, resolvedRef] of options.resolvedBundleItemRefs ?? []) {
    const item = nativeTargetItemFromResolvedRef({
      selector,
      targetName: options.targetName,
      resolvedRef,
    });

    if (!item || !isBundleItemSelectorSelected(options.itemSelectors, item)) {
      continue;
    }

    if (items.has(item.selector)) {
      throw new Error(
        `Bundle item reference conflicts with local bundle item: ${item.selector}`,
      );
    }

    items.set(item.selector, item);
  }

  if (
    !fs.existsSync(sourceDir) &&
    items.size === 0 &&
    isDirectoryTargetSelected(options.itemSelectors, options.targetName)
  ) {
    assertBundleTargetDirectory(sourceDir, options.sourcePath);
  }

  return Array.from(items.values()).sort((left, right) =>
    left.selector.localeCompare(right.selector),
  );
}

function nativeTargetItemFromLocalEntry(options: {
  entry: fs.Dirent;
  sourceDir: string;
  targetName: ToolTargetName;
}): CanonicalTargetItem | undefined {
  if (options.targetName === "skills") {
    if (options.entry.isDirectory()) {
      return {
        selector: `skills/${options.entry.name}`,
        itemName: options.entry.name,
        kind: "directory",
        localPath: path.join(options.sourceDir, options.entry.name),
        nativeRelativePath: options.entry.name,
      };
    }

    if (!options.entry.isFile()) {
      return undefined;
    }

    const itemName = stripKnownBundleItemExtension(options.entry.name);
    return {
      selector: `skills/${itemName}`,
      itemName,
      kind: "file",
      localPath: path.join(options.sourceDir, options.entry.name),
      nativeRelativePath: options.entry.name,
    };
  }

  if (options.targetName === "agents" && options.entry.isDirectory()) {
    return {
      selector: `agents/${options.entry.name}`,
      itemName: options.entry.name,
      kind: "directory",
      localPath: path.join(options.sourceDir, options.entry.name),
      nativeRelativePath: options.entry.name,
    };
  }

  if (options.targetName === "commands" || options.targetName === "agents") {
    if (!options.entry.isFile()) {
      return undefined;
    }

    const itemName = stripKnownBundleItemExtension(options.entry.name);
    return {
      selector: `${options.targetName}/${itemName}`,
      itemName,
      kind: "file",
      localPath: path.join(options.sourceDir, options.entry.name),
      nativeRelativePath: options.entry.name,
    };
  }

  return undefined;
}

function nativeTargetItemFromResolvedRef(options: {
  selector: BundleItemSelector;
  targetName: ToolTargetName;
  resolvedRef: ResolvedBundleItemRef;
}): CanonicalTargetItem | undefined {
  const [targetName, itemName] = options.selector.split("/");

  if (targetName !== options.targetName || !itemName) {
    return undefined;
  }

  const kind = targetName === "skills" ? "directory" : "file";
  const nativeRelativePath =
    kind === "directory"
      ? itemName
      : `${itemName}${nativeFileSuffix(options.resolvedRef.path)}`;

  return {
    selector: options.selector,
    itemName,
    kind,
    nativeRelativePath,
    resolvedRef: options.resolvedRef,
  };
}

function nativeFileSuffix(filePath: string): string {
  const basename = path.basename(filePath);
  const strippedName = stripKnownBundleItemExtension(basename);
  const suffix = basename.slice(strippedName.length);

  return suffix || ".md";
}

function readTranslatedRootInstructionTargets(options: {
  bundleDir: string;
  sourcePath: string;
  toolName: ToolName;
  resolvedBundleItemRefs?: ReadonlyMap<string, ResolvedBundleItemRef>;
}): Record<string, string> {
  const sourceFile =
    options.resolvedBundleItemRefs?.get("root-instruction")?.path ??
    path.join(options.bundleDir, options.sourcePath);
  assertBundleTargetFile(sourceFile, options.sourcePath);

  return translateRootInstruction({
    targetTool: toTranslationToolName(options.toolName),
    source: fs.readFileSync(sourceFile, "utf8"),
  });
}

function renderRootInstructionDocument(options: {
  repoRoot: string;
  repoRelPath: string;
  rootInstructionBaseContents?: Record<string, string>;
  rootInstructionMode?: RootInstructionMode;
  bundleName: string;
  bundleSource?: string;
  composedContent: string;
}): string {
  return ensureTrailingNewline(
    composeRootInstructionContent([
      options.rootInstructionMode === "replace"
        ? undefined
        : (options.rootInstructionBaseContents?.[options.repoRelPath] ??
          readExistingRootInstructionBaseContent(
            options.repoRoot,
            options.repoRelPath,
          )),
      wrapSkulManagedInstructionContent(
        wrapRootInstructionBundleContent({
          bundleName: options.bundleName,
          source: options.bundleSource,
          content: options.composedContent,
        }),
      ),
    ]),
  );
}

async function copyDirectory(
  sourceDir: string,
  destinationDir: string,
  targetRoot: string,
  writtenFiles: string[],
  ownedDirectories: Set<string>,
  reservedDestinations: Set<string>,
  repoRoot: string,
  assertSafeWriteTarget: ((repoRelativePath: string) => void) | undefined,
  resolveFileConflict:
    | ((conflictPath: string) => Promise<FileConflictResolution>)
    | undefined,
  itemFilter?: {
    targetName: ToolTargetName;
    selectors: BundleItemSelector[];
    sourceRoot: string;
  },
): Promise<void> {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    assertNotSymlink(entry, sourceDir);

    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    const relativeSourcePath = path.relative(
      itemFilter?.sourceRoot ?? sourceDir,
      sourcePath,
    );
    const topLevelEntryName =
      relativeSourcePath.split(path.sep)[0] ?? entry.name;

    if (
      itemFilter &&
      !isDirectoryItemSelected({
        selectors: itemFilter.selectors,
        targetName: itemFilter.targetName,
        entryName: topLevelEntryName,
      })
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      await copyDirectory(
        sourcePath,
        destinationPath,
        targetRoot,
        writtenFiles,
        ownedDirectories,
        reservedDestinations,
        repoRoot,
        assertSafeWriteTarget,
        resolveFileConflict,
        itemFilter,
      );
      continue;
    }

    if (entry.isFile()) {
      const finalDestinationPath = await resolveDestinationPath({
        destinationPath,
        targetRoot,
        reservedDestinations,
        resolveFileConflict,
      });

      ensureOwnedParentDirectories(
        path.dirname(finalDestinationPath),
        targetRoot,
        ownedDirectories,
        repoRoot,
      );
      assertSafeWriteTarget?.(path.relative(repoRoot, finalDestinationPath));
      fs.copyFileSync(sourcePath, finalDestinationPath);
      reservedDestinations.add(
        path
          .relative(targetRoot, finalDestinationPath)
          .split(path.sep)
          .join("/"),
      );
      writtenFiles.push(path.relative(repoRoot, finalDestinationPath));
    }
  }
}

async function copyFileToDestination(options: {
  sourcePath: string;
  destinationPath: string;
  targetRoot: string;
  writtenFiles: string[];
  ownedDirectories: Set<string>;
  reservedDestinations: Set<string>;
  repoRoot: string;
  assertSafeWriteTarget: ((repoRelativePath: string) => void) | undefined;
  resolveFileConflict:
    | ((conflictPath: string) => Promise<FileConflictResolution>)
    | undefined;
}): Promise<void> {
  assertBundleTargetFile(options.sourcePath, options.sourcePath);
  const finalDestinationPath = await resolveDestinationPath({
    destinationPath: options.destinationPath,
    targetRoot: options.targetRoot,
    reservedDestinations: options.reservedDestinations,
    resolveFileConflict: options.resolveFileConflict,
  });

  ensureOwnedParentDirectories(
    path.dirname(finalDestinationPath),
    options.targetRoot,
    options.ownedDirectories,
    options.repoRoot,
  );
  options.assertSafeWriteTarget?.(
    path.relative(options.repoRoot, finalDestinationPath),
  );
  fs.copyFileSync(options.sourcePath, finalDestinationPath);
  options.reservedDestinations.add(
    path
      .relative(options.targetRoot, finalDestinationPath)
      .split(path.sep)
      .join("/"),
  );
  options.writtenFiles.push(
    path.relative(options.repoRoot, finalDestinationPath),
  );
}

async function resolveDestinationPath(options: {
  destinationPath: string;
  targetRoot: string;
  reservedDestinations: Set<string>;
  resolveFileConflict:
    | ((conflictPath: string) => Promise<FileConflictResolution>)
    | undefined;
}): Promise<string> {
  const relativePath = path
    .relative(options.targetRoot, options.destinationPath)
    .split(path.sep)
    .join("/");

  if (options.reservedDestinations.has(relativePath)) {
    throw new Error(`Conflict detected: ${relativePath}`);
  }

  if (!fs.existsSync(options.destinationPath)) {
    return options.destinationPath;
  }

  if (!options.resolveFileConflict) {
    throw new Error(`Conflict detected: ${relativePath}`);
  }

  await options.resolveFileConflict(relativePath);
  return options.destinationPath;
}

function ensureOwnedParentDirectories(
  directoryPath: string,
  targetRoot: string,
  ownedDirectories: Set<string>,
  repoRoot: string,
): void {
  if (directoryPath === targetRoot) {
    return;
  }

  const missingDirectories: string[] = [];
  let currentPath = directoryPath;

  while (currentPath !== targetRoot && !fs.existsSync(currentPath)) {
    missingDirectories.push(currentPath);
    currentPath = path.dirname(currentPath);
  }

  fs.mkdirSync(directoryPath, { recursive: true });

  for (const missingDirectory of missingDirectories) {
    ownedDirectories.add(path.relative(repoRoot, missingDirectory));
  }
}

function listRelativeFiles(sourceDir: string, prefix = ""): string[] {
  const relativeFiles: string[] = [];

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    assertNotSymlink(entry, sourceDir);

    const sourcePath = path.join(sourceDir, entry.name);
    const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;

    if (entry.isDirectory()) {
      relativeFiles.push(...listRelativeFiles(sourcePath, relativePath));
      continue;
    }

    if (entry.isFile()) {
      relativeFiles.push(relativePath);
    }
  }

  return relativeFiles;
}
function assertNotSymlink(entry: fs.Dirent, parentDir: string): void {
  if (entry.isSymbolicLink()) {
    throw new Error(
      `Bundle contains a symlink which is not allowed: ${path.join(parentDir, entry.name)}`,
    );
  }
}

function isNativeSourcePath(
  toolName: ToolName,
  targetName: ToolTargetName,
  sourcePath: string,
): boolean {
  const nativePath = getToolDefinition(toolName)?.targets[targetName]?.path;
  return (
    !!nativePath &&
    (sourcePath === nativePath || sourcePath.startsWith(`${nativePath}/`))
  );
}

function readFilesIntoRecord(
  dir: string,
  prefix: string,
  result: Record<string, string>,
): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    assertNotSymlink(entry, dir);

    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      readFilesIntoRecord(fullPath, relPath, result);
    } else if (entry.isFile()) {
      result[relPath] = fs.readFileSync(fullPath, "utf8");
    }
  }
}

async function materializeCanonicalTarget(options: {
  bundleDir: string;
  sourcePath: string;
  toolName: ToolName;
  targetName: ToolTargetName;
  repoRoot: string;
  writtenFiles: string[];
  ownedDirectories: Set<string>;
  assertSafeWriteTarget?: (repoRelativePath: string) => void;
  resolveFileConflict:
    | ((conflictPath: string) => Promise<FileConflictResolution>)
    | undefined;
  itemSelectors?: BundleItemSelector[];
  pathLayout: ToolMaterializationLayout;
  disableModelInvocation?: boolean;
  resolvedBundleItemRefs?: ReadonlyMap<string, ResolvedBundleItemRef>;
}): Promise<void> {
  const reservedDestinations = new Set<string>();

  for (const item of listCanonicalTargetItems(options)) {
    const translated = translateCanonicalTargetItem({ ...options, item });
    const itemResolveFileConflict =
      options.targetName === "skills"
        ? createItemScopedConflictResolver({
            itemRelativePath: item.itemName,
            resolveFileConflict: options.resolveFileConflict,
          })
        : options.resolveFileConflict;

    for (const [origRelPath, content] of Object.entries(translated)) {
      const repoRelPath = options.pathLayout.remapRepoRelPath(
        options.toolName,
        origRelPath,
      );
      const targetRoot = resolveDirectoryTargetRoot({
        pathLayout: options.pathLayout,
        toolName: options.toolName,
        targetName: options.targetName,
        repoRoot: options.repoRoot,
      });
      await writeTranslatedFile({
        repoRelPath,
        content,
        repoRoot: options.repoRoot,
        writtenFiles: options.writtenFiles,
        ownedDirectories: options.ownedDirectories,
        reservedDestinations,
        assertSafeWriteTarget: options.assertSafeWriteTarget,
        resolveFileConflict: itemResolveFileConflict,
        targetRoot,
      });
    }
  }
}

function listCanonicalTargetItems(options: {
  bundleDir: string;
  sourcePath: string;
  targetName: ToolTargetName;
  itemSelectors?: BundleItemSelector[];
  resolvedBundleItemRefs?: ReadonlyMap<string, ResolvedBundleItemRef>;
}): CanonicalTargetItem[] {
  const sourceDir = path.join(options.bundleDir, options.sourcePath);
  const items = new Map<BundleItemSelector, CanonicalTargetItem>();

  if (fs.existsSync(sourceDir)) {
    assertBundleTargetDirectory(sourceDir, options.sourcePath);

    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      assertNotSymlink(entry, sourceDir);
      const item = localCanonicalTargetItem({
        entry,
        sourceDir,
        targetName: options.targetName,
      });

      if (!item || !isBundleItemSelectorSelected(options.itemSelectors, item)) {
        continue;
      }

      items.set(item.selector, item);
    }
  }

  for (const [selector, resolvedRef] of options.resolvedBundleItemRefs ?? []) {
    const item = resolvedCanonicalTargetItem({
      selector,
      targetName: options.targetName,
      resolvedRef,
    });

    if (!item || !isBundleItemSelectorSelected(options.itemSelectors, item)) {
      continue;
    }

    if (items.has(item.selector)) {
      throw new Error(
        `Bundle item reference conflicts with local bundle item: ${item.selector}`,
      );
    }

    items.set(item.selector, item);
  }

  if (
    !fs.existsSync(sourceDir) &&
    items.size === 0 &&
    isDirectoryTargetSelected(options.itemSelectors, options.targetName)
  ) {
    assertBundleTargetDirectory(sourceDir, options.sourcePath);
  }

  return Array.from(items.values()).sort((left, right) =>
    left.selector.localeCompare(right.selector),
  );
}

function isDirectoryTargetSelected(
  selectors: BundleItemSelector[] | undefined,
  targetName: ToolTargetName,
): boolean {
  return (
    !selectors ||
    selectors.some((selector) => selector.startsWith(`${targetName}/`))
  );
}

function localCanonicalTargetItem(options: {
  entry: fs.Dirent;
  sourceDir: string;
  targetName: ToolTargetName;
}): CanonicalTargetItem | undefined {
  if (options.targetName === "skills") {
    if (!options.entry.isDirectory()) {
      return undefined;
    }

    const itemName = options.entry.name;
    return {
      selector: `skills/${itemName}`,
      itemName,
      localPath: path.join(options.sourceDir, options.entry.name),
    };
  }

  if (options.targetName === "commands" || options.targetName === "agents") {
    if (!options.entry.isFile() || !options.entry.name.endsWith(".md")) {
      return undefined;
    }

    const itemName = stripKnownBundleItemExtension(options.entry.name);
    return {
      selector: `${options.targetName}/${itemName}`,
      itemName,
      localPath: path.join(options.sourceDir, options.entry.name),
    };
  }

  return undefined;
}

function resolvedCanonicalTargetItem(options: {
  selector: BundleItemSelector;
  targetName: ToolTargetName;
  resolvedRef: ResolvedBundleItemRef;
}): CanonicalTargetItem | undefined {
  const [targetName, itemName] = options.selector.split("/");

  if (targetName !== options.targetName || !itemName) {
    return undefined;
  }

  return {
    selector: options.selector,
    itemName,
    resolvedRef: options.resolvedRef,
  };
}

function isBundleItemSelectorSelected(
  selectors: BundleItemSelector[] | undefined,
  item: CanonicalTargetItem,
): boolean {
  return !selectors || selectors.includes(item.selector);
}

function translateCanonicalTargetItem(options: {
  item: CanonicalTargetItem;
  toolName: ToolName;
  targetName: ToolTargetName;
  disableModelInvocation?: boolean;
}): Record<string, string> {
  const translTool = toTranslationToolName(options.toolName);
  const sourcePath = options.item.resolvedRef?.path ?? options.item.localPath;

  if (!sourcePath) {
    throw new Error(`Bundle item has no source path: ${options.item.selector}`);
  }

  if (options.targetName === "skills") {
    const files: Record<string, string> = {};
    readFilesIntoRecord(sourcePath, "", files);
    const description = options.item.resolvedRef?.description;
    const disableModelInvocation =
      options.disableModelInvocation ||
      options.item.resolvedRef?.disableModelInvocation;
    return translateSkill({
      sourceTool: files["agents/openai.yaml"] ? "codex" : "claude",
      targetTool: translTool,
      files,
      options: {
        ...(options.item.resolvedRef ? { name: options.item.itemName } : {}),
        fallbackName: options.item.itemName,
        ...(description !== undefined ? { description } : {}),
        ...(disableModelInvocation ? { disableModelInvocation: true } : {}),
      },
    });
  }

  if (options.targetName === "commands") {
    return translateCommand({
      sourceTool: "claude",
      targetTool: translTool as Parameters<
        typeof translateCommand
      >[0]["targetTool"],
      source: fs.readFileSync(sourcePath, "utf8"),
      options: {
        name: options.item.itemName,
        ...(options.item.resolvedRef?.description !== undefined
          ? { description: options.item.resolvedRef.description }
          : {}),
      },
    });
  }

  if (options.targetName === "agents") {
    return translateAgent({
      sourceTool: sourcePath.endsWith(".toml") ? "codex" : "claude",
      targetTool: translTool as Parameters<
        typeof translateAgent
      >[0]["targetTool"],
      source: fs.readFileSync(sourcePath, "utf8"),
      options: options.item.resolvedRef
        ? {
            name: options.item.itemName,
            ...(options.item.resolvedRef.description !== undefined
              ? { description: options.item.resolvedRef.description }
              : {}),
          }
        : undefined,
    });
  }

  return {};
}

function readExistingRootInstructionBaseContent(
  repoRoot: string,
  repoRelPath: string,
): string | undefined {
  const targetPath = path.join(repoRoot, repoRelPath);

  if (!fs.existsSync(targetPath)) {
    return undefined;
  }

  return fs.readFileSync(targetPath, "utf8");
}

function previewCanonicalTargetWriteTargets(options: {
  bundleDir: string;
  sourcePath: string;
  toolName: ToolName;
  targetName: ToolTargetName;
  itemSelectors?: BundleItemSelector[];
  pathLayout: ToolMaterializationLayout;
  disableModelInvocation?: boolean;
  resolvedBundleItemRefs?: ReadonlyMap<string, ResolvedBundleItemRef>;
}): string[] {
  const writeTargets: string[] = [];

  for (const item of listCanonicalTargetItems(options)) {
    const translated = translateCanonicalTargetItem({ ...options, item });
    writeTargets.push(
      ...Object.keys(translated).map((repoRelPath) =>
        options.pathLayout.remapRepoRelPath(options.toolName, repoRelPath),
      ),
    );
  }

  return writeTargets;
}

function previewRootInstructionWriteTargets(options: {
  bundleDir: string;
  sourcePath: string;
  toolName: ToolName;
  targetName: ToolTargetName;
  pathLayout: ToolMaterializationLayout;
  resolvedBundleItemRefs?: ReadonlyMap<string, ResolvedBundleItemRef>;
}): string[] {
  if (options.targetName !== "root_instruction") {
    throw new Error(`Unsupported file target: ${options.targetName}`);
  }

  return Object.keys(readTranslatedRootInstructionTargets(options)).map((p) =>
    options.pathLayout.remapRepoRelPath(options.toolName, p),
  );
}

function resolveDirectoryTargetRoot(options: {
  pathLayout: ToolMaterializationLayout;
  toolName: ToolName;
  targetName: ToolTargetName;
  repoRoot: string;
}): string {
  const targetPath = options.pathLayout.resolveToolTargetPath(
    options.toolName,
    options.targetName,
    options.repoRoot,
  );

  if (!targetPath) {
    throw new Error(
      `Tool ${options.toolName} does not support ${options.targetName}`,
    );
  }

  return path.relative(options.repoRoot, targetPath).split(path.sep).join("/");
}

async function writeTranslatedFile(options: {
  repoRelPath: string;
  content: string;
  repoRoot: string;
  writtenFiles: string[];
  ownedDirectories: Set<string>;
  reservedDestinations: Set<string>;
  assertSafeWriteTarget?: (repoRelativePath: string) => void;
  allowExistingFileOverwrite?: boolean;
  resolveFileConflict:
    | ((conflictPath: string) => Promise<FileConflictResolution>)
    | undefined;
  targetRoot?: string;
}): Promise<void> {
  // Conflict resolution paths are expressed relative to the target root. Directory-based
  // targets use the two-segment tool root (e.g. ".cursor/skills"); repo-root files use "".
  const targetRoot =
    options.targetRoot ?? options.repoRelPath.split("/").slice(0, 2).join("/");
  const targetRootAbsPath = path.join(
    options.repoRoot,
    ...targetRoot.split("/"),
  );
  const targetRootIsNew = !fs.existsSync(targetRootAbsPath);

  const currentRepoRelPath = options.repoRelPath;
  const currentAbsPath = path.join(
    options.repoRoot,
    ...currentRepoRelPath.split("/"),
  );

  const hasReserved = options.reservedDestinations.has(currentRepoRelPath);
  const hasFilesystem = fs.existsSync(currentAbsPath);

  if (hasReserved) {
    throw new Error(`Conflict detected: ${currentRepoRelPath}`);
  }

  if (hasFilesystem && !options.allowExistingFileOverwrite) {
    if (!options.resolveFileConflict) {
      throw new Error(`Conflict detected: ${currentRepoRelPath}`);
    }

    const relWithinTarget =
      targetRoot === ""
        ? currentRepoRelPath
        : currentRepoRelPath.substring(targetRoot.length + 1);

    await options.resolveFileConflict(relWithinTarget);
  }

  const parentAbsDir = path.dirname(currentAbsPath);
  const newDirs: string[] = [];
  let current = parentAbsDir;

  while (current !== targetRootAbsPath && !fs.existsSync(current)) {
    newDirs.push(current);
    current = path.dirname(current);
  }

  fs.mkdirSync(parentAbsDir, { recursive: true });

  for (const dir of newDirs) {
    options.ownedDirectories.add(path.relative(options.repoRoot, dir));
  }

  if (targetRoot !== "" && targetRootIsNew) {
    options.ownedDirectories.add(
      path.relative(options.repoRoot, targetRootAbsPath),
    );
  }

  options.assertSafeWriteTarget?.(currentRepoRelPath);
  writeFileAtomic(currentAbsPath, options.content);
  options.reservedDestinations.add(currentRepoRelPath);
  options.writtenFiles.push(currentRepoRelPath);
}

function assertBundleTargetDirectory(
  sourceDir: string,
  targetPath: string,
): void {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Bundle target path does not exist: ${targetPath}`);
  }

  const stat = fs.lstatSync(sourceDir);

  if (stat.isSymbolicLink()) {
    throw new Error(`Bundle target path must not be a symlink: ${targetPath}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`Bundle target path must be a directory: ${targetPath}`);
  }
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function assertBundleTargetFile(sourceFile: string, targetPath: string): void {
  if (!fs.existsSync(sourceFile)) {
    throw new Error(`Bundle target path does not exist: ${targetPath}`);
  }

  const stat = fs.lstatSync(sourceFile);

  if (stat.isSymbolicLink()) {
    throw new Error(`Bundle target path must not be a symlink: ${targetPath}`);
  }

  if (!stat.isFile()) {
    throw new Error(`Bundle target path must be a file: ${targetPath}`);
  }
}
