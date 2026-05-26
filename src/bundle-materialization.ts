import fs from "node:fs";
import path from "node:path";
import {
  type BundleItemSelector,
  isDirectoryItemSelected,
  isRootInstructionItemSelected,
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
import { pathDepth } from "./fs-utils";
import { collectComposedRootInstructionContents } from "./root-instruction-content";
import {
  composeRootInstructionContent,
  wrapRootInstructionBundleContent,
} from "./root-instruction-render";
import {
  getToolDefinition,
  PROJECT_TOOL_MATERIALIZATION_LAYOUT,
  type ToolMaterializationLayout,
  type ToolName,
  type ToolTargetName,
} from "./tool-mapping";

export interface MaterializeBundleResult {
  byTool: Partial<Record<ToolName, { files: string[]; directories: string[] }>>;
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
        const sourceDir = path.join(options.bundleDir, target.path);
        const destinationDir = pathLayout.resolveToolTargetPath(
          toolName as ToolName,
          targetName as ToolTargetName,
          options.repoRoot,
        );

        if (!destinationDir) {
          continue;
        }

        assertBundleTargetDirectory(sourceDir, target.path);

        for (const relativePath of listRelativeFiles(sourceDir)) {
          if (
            !isDirectoryItemSelected({
              selectors: options.itemSelectors,
              targetName: targetName as ToolTargetName,
              entryName: relativePath.split(path.sep)[0] ?? relativePath,
            })
          ) {
            continue;
          }

          writeTargets.add(
            path.relative(
              options.repoRoot,
              path.join(destinationDir, relativePath),
            ),
          );
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
  resolveFileConflict?: (conflictPath: string) => Promise<FileConflictResolution>;
  pathLayout?: ToolMaterializationLayout;
}): Promise<MaterializeBundleResult> {
  const byTool: Record<string, { files: string[]; directories: string[] }> = {};
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
          .filter(([toolName, targets]) =>
            Object.keys(targets).some(
              (targetName) =>
                getToolDefinition(toolName as ToolName)?.targets[
                  targetName as ToolTargetName
                ]?.kind === "file",
            ),
          )
          .map(([toolName]) => toolName as ToolName),
      })
    : {};

  for (const [toolName, targets] of toolEntries) {
    const toolFiles: string[] = [];
    const toolDirectories = new Set<string>();

    for (const [targetName, target] of Object.entries(targets)) {
      const targetDefinition = getToolDefinition(toolName as ToolName)?.targets[
        targetName as ToolTargetName
      ];

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
          bundleName: options.bundleName ?? options.manifest.name ?? "bundle",
          bundleSource: options.bundleSource,
          resolveFileConflict: options.resolveFileConflict,
          pathLayout,
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
        // Native dotdir path: raw copy verbatim into the tool's target directory.
        const reservedDestinations = new Set<string>();
        const sourceDir = path.join(options.bundleDir, target.path);
        const destinationDir = pathLayout.resolveToolTargetPath(
          toolName as ToolName,
          targetName as ToolTargetName,
          options.repoRoot,
        );

        if (!destinationDir) {
          continue;
        }

        const destinationDirExisted = fs.existsSync(destinationDir);
        assertBundleTargetDirectory(sourceDir, target.path);
        fs.mkdirSync(destinationDir, { recursive: true });

        if (!destinationDirExisted) {
          toolDirectories.add(path.relative(options.repoRoot, destinationDir));
        }

        await copyDirectory(
          sourceDir,
          destinationDir,
          destinationDir,
          toolFiles,
          toolDirectories,
          reservedDestinations,
          options.repoRoot,
          options.assertSafeWriteTarget,
          options.resolveFileConflict,
          options.itemSelectors
            ? {
                targetName: targetName as ToolTargetName,
                selectors: options.itemSelectors,
                sourceRoot: sourceDir,
              }
            : undefined,
        );
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
  bundleName: string;
  bundleSource?: string;
  resolveFileConflict:
    | ((conflictPath: string) => Promise<FileConflictResolution>)
    | undefined;
  pathLayout: ToolMaterializationLayout;
}): Promise<void> {
  if (options.targetName !== "root_instruction") {
    throw new Error(`Unsupported file target: ${options.targetName}`);
  }

  const translatedContentByPath = readTranslatedRootInstructionTargets({
    bundleDir: options.bundleDir,
    sourcePath: options.sourcePath,
    toolName: options.toolName,
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

function readTranslatedRootInstructionTargets(options: {
  bundleDir: string;
  sourcePath: string;
  toolName: ToolName;
}): Record<string, string> {
  const sourceFile = path.join(options.bundleDir, options.sourcePath);
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
  bundleName: string;
  bundleSource?: string;
  composedContent: string;
}): string {
  return ensureTrailingNewline(
    composeRootInstructionContent([
      options.rootInstructionBaseContents?.[options.repoRelPath] ??
        readExistingRootInstructionBaseContent(
          options.repoRoot,
          options.repoRelPath,
        ),
      wrapRootInstructionBundleContent({
        bundleName: options.bundleName,
        source: options.bundleSource,
        content: options.composedContent,
      }),
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
}): Promise<void> {
  const sourceDir = path.join(options.bundleDir, options.sourcePath);
  assertBundleTargetDirectory(sourceDir, options.sourcePath);

  const translTool = toTranslationToolName(options.toolName);
  const reservedDestinations = new Set<string>();

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    assertNotSymlink(entry, sourceDir);

    if (
      !isDirectoryItemSelected({
        selectors: options.itemSelectors,
        targetName: options.targetName,
        entryName: entry.name,
      })
    ) {
      continue;
    }

    let translated: Record<string, string>;

    if (options.targetName === "skills") {
      if (!entry.isDirectory()) continue;

      const skillDir = path.join(sourceDir, entry.name);
      const files: Record<string, string> = {};
      readFilesIntoRecord(skillDir, "", files);
      translated = translateSkill({
        sourceTool: "claude",
        targetTool: translTool,
        files,
      });
    } else if (options.targetName === "commands") {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

      const commandName = entry.name.slice(0, -3);
      const content = fs.readFileSync(path.join(sourceDir, entry.name), "utf8");
      translated = translateCommand({
        sourceTool: "claude",
        targetTool: translTool as Parameters<
          typeof translateCommand
        >[0]["targetTool"],
        source: content,
        options: { name: commandName },
      });
    } else if (options.targetName === "agents") {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

      const content = fs.readFileSync(path.join(sourceDir, entry.name), "utf8");
      translated = translateAgent({
        sourceTool: "claude",
        targetTool: translTool as Parameters<
          typeof translateAgent
        >[0]["targetTool"],
        source: content,
      });
    } else {
      continue;
    }

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
        resolveFileConflict: options.resolveFileConflict,
        targetRoot,
      });
    }
  }
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
}): string[] {
  const sourceDir = path.join(options.bundleDir, options.sourcePath);
  assertBundleTargetDirectory(sourceDir, options.sourcePath);

  const translTool = toTranslationToolName(options.toolName);
  const writeTargets: string[] = [];

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    assertNotSymlink(entry, sourceDir);

    if (
      !isDirectoryItemSelected({
        selectors: options.itemSelectors,
        targetName: options.targetName,
        entryName: entry.name,
      })
    ) {
      continue;
    }

    let translated: Record<string, string>;

    if (options.targetName === "skills") {
      if (!entry.isDirectory()) continue;

      const skillDir = path.join(sourceDir, entry.name);
      const files: Record<string, string> = {};
      readFilesIntoRecord(skillDir, "", files);
      translated = translateSkill({
        sourceTool: "claude",
        targetTool: translTool,
        files,
      });
    } else if (options.targetName === "commands") {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

      const commandName = entry.name.slice(0, -3);
      const content = fs.readFileSync(path.join(sourceDir, entry.name), "utf8");
      translated = translateCommand({
        sourceTool: "claude",
        targetTool: translTool as Parameters<
          typeof translateCommand
        >[0]["targetTool"],
        source: content,
        options: { name: commandName },
      });
    } else if (options.targetName === "agents") {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

      const content = fs.readFileSync(path.join(sourceDir, entry.name), "utf8");
      translated = translateAgent({
        sourceTool: "claude",
        targetTool: translTool as Parameters<
          typeof translateAgent
        >[0]["targetTool"],
        source: content,
      });
    } else {
      continue;
    }

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

  let currentRepoRelPath = options.repoRelPath;
  let currentAbsPath = path.join(
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
  fs.writeFileSync(currentAbsPath, options.content);
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
