import fs from "node:fs";
import path from "node:path";

import { type BundleManifest } from "./bundle-manifest";
import { translateAgent, translateCommand, translateSkill } from "./bundle-translation";
import { type FileConflictResolution } from "./cli";
import {
  DEFAULT_CONFLICT_PREFIX,
  normalizeConflictDestination,
  suggestPrefixedDestination,
} from "./conflict-resolution";
import { getToolDefinition, resolveToolTargetPath, type ToolName, type ToolTargetName } from "./tool-mapping";

export interface MaterializeBundleResult {
  files: string[];
  directories: string[];
  byTool: Partial<Record<ToolName, { files: string[]; directories: string[] }>>;
}

export async function materializeBundle(options: {
  repoRoot: string;
  bundleDir: string;
  manifest: BundleManifest;
  tools?: ToolName[];
  resolveFileConflict?: (conflictPath: string, suggestedDestination: string) => Promise<FileConflictResolution>;
}): Promise<MaterializeBundleResult> {
  const allFiles: string[] = [];
  const allDirectories = new Set<string>();
  const byTool: Record<string, { files: string[]; directories: string[] }> = {};
  const toolEntries = options.tools && options.tools.length > 0
    ? Object.entries(options.manifest.tools).filter(([toolName]) => options.tools!.includes(toolName as ToolName))
    : Object.entries(options.manifest.tools);

  for (const [toolName, targets] of toolEntries) {
    const toolFiles: string[] = [];
    const toolDirectories = new Set<string>();

    for (const [targetName, target] of Object.entries(targets)) {
      if (isNativeSourcePath(toolName as ToolName, targetName as ToolTargetName, target.path)) {
        // Native dotdir path: raw copy verbatim into the tool's target directory.
        const reservedDestinations = new Set<string>();
        const sourceDir = path.join(options.bundleDir, target.path);
        const destinationDir = resolveToolTargetPath(
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
          options.resolveFileConflict,
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
          resolveFileConflict: options.resolveFileConflict,
        });
      }
    }

    toolFiles.sort((left, right) => {
      const depthDifference = pathDepth(left) - pathDepth(right);
      return depthDifference !== 0 ? depthDifference : left.localeCompare(right);
    });
    const sortedToolDirs = Array.from(toolDirectories).sort((left, right) => {
      const depthDifference = pathDepth(right) - pathDepth(left);
      return depthDifference !== 0 ? depthDifference : left.localeCompare(right);
    });
    byTool[toolName as ToolName] = { files: toolFiles, directories: sortedToolDirs };
    allFiles.push(...toolFiles);
    for (const dir of toolDirectories) allDirectories.add(dir);
  }

  allFiles.sort((left, right) => {
    const depthDifference = pathDepth(left) - pathDepth(right);
    return depthDifference !== 0 ? depthDifference : left.localeCompare(right);
  });
  const directories = Array.from(allDirectories).sort((left, right) => {
    const depthDifference = pathDepth(right) - pathDepth(left);
    return depthDifference !== 0 ? depthDifference : left.localeCompare(right);
  });

  return { files: allFiles, directories, byTool };
}

async function copyDirectory(
  sourceDir: string,
  destinationDir: string,
  targetRoot: string,
  writtenFiles: string[],
  ownedDirectories: Set<string>,
  reservedDestinations: Set<string>,
  repoRoot: string,
  resolveFileConflict:
    | ((conflictPath: string, suggestedDestination: string) => Promise<FileConflictResolution>)
    | undefined,
): Promise<void> {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Bundle contains a symlink which is not allowed: ${path.join(sourceDir, entry.name)}`);
    }

    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(
        sourcePath,
        destinationPath,
        targetRoot,
        writtenFiles,
        ownedDirectories,
        reservedDestinations,
        repoRoot,
        resolveFileConflict,
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

      if (!finalDestinationPath) {
        continue;
      }

      ensureOwnedParentDirectories(
        path.dirname(finalDestinationPath),
        targetRoot,
        ownedDirectories,
        repoRoot,
      );
      fs.copyFileSync(sourcePath, finalDestinationPath);
      reservedDestinations.add(path.relative(targetRoot, finalDestinationPath).split(path.sep).join("/"));
      writtenFiles.push(path.relative(repoRoot, finalDestinationPath));
    }
  }
}

async function resolveDestinationPath(options: {
  destinationPath: string;
  targetRoot: string;
  reservedDestinations: Set<string>;
  resolveFileConflict:
    | ((conflictPath: string, suggestedDestination: string) => Promise<FileConflictResolution>)
    | undefined;
}): Promise<string | null> {
  let destinationPath = options.destinationPath;

  while (true) {
    const relativePath = path.relative(options.targetRoot, destinationPath).split(path.sep).join("/");
    const hasReservedConflict = options.reservedDestinations.has(relativePath);
    const hasFilesystemConflict = fs.existsSync(destinationPath);

    if (!hasReservedConflict && !hasFilesystemConflict) {
      return destinationPath;
    }

    if (!options.resolveFileConflict) {
      throw new Error(`Conflict detected: ${relativePath}`);
    }

    const suggestedDestination = suggestPrefixedDestination(relativePath, DEFAULT_CONFLICT_PREFIX);
    const resolution = await options.resolveFileConflict(relativePath, suggestedDestination);

    if (resolution.action === "skip") {
      return null;
    }

    const nextRelativePath =
      resolution.action === "prefix"
        ? suggestPrefixedDestination(relativePath, resolution.prefix)
        : normalizeConflictDestination(resolution.destination);

    if (!nextRelativePath) {
      throw new Error("Conflict destination must stay inside the tool target");
    }

    destinationPath = path.join(options.targetRoot, ...nextRelativePath.split("/"));
  }
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

function pathDepth(value: string): number {
  return value.split(path.sep).length;
}

// Returns true when the manifest source path matches the tool's own native dotdir,
// meaning files should be copied verbatim. Returns false for canonical dirs (skills/,
// commands/, agents/) that require cross-tool content transforms.
function isNativeSourcePath(toolName: ToolName, targetName: ToolTargetName, sourcePath: string): boolean {
  const nativePath = getToolDefinition(toolName)?.targets[targetName]?.path;
  return !!nativePath && (sourcePath === nativePath || sourcePath.startsWith(nativePath + "/"));
}

// Maps the registry ToolName to the short tool identifier used by bundle-translation.ts.
function toTranslationToolName(toolName: ToolName): "claude" | "cursor" | "opencode" | "codex" {
  return toolName === "claude-code" ? "claude" : toolName as "cursor" | "opencode" | "codex";
}

// Reads every file under `dir` recursively into `result` with keys relative to `dir`.
function readFilesIntoRecord(dir: string, prefix: string, result: Record<string, string>): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Bundle contains a symlink which is not allowed: ${path.join(dir, entry.name)}`);
    }

    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      readFilesIntoRecord(fullPath, relPath, result);
    } else if (entry.isFile()) {
      result[relPath] = fs.readFileSync(fullPath, "utf8");
    }
  }
}

// Applies cross-tool transforms for a canonical source directory (skills/, commands/, agents/).
// Output paths are determined by the translation function and are relative to repoRoot.
async function materializeCanonicalTarget(options: {
  bundleDir: string;
  sourcePath: string;
  toolName: ToolName;
  targetName: ToolTargetName;
  repoRoot: string;
  writtenFiles: string[];
  ownedDirectories: Set<string>;
  resolveFileConflict:
    | ((conflictPath: string, suggestedDestination: string) => Promise<FileConflictResolution>)
    | undefined;
}): Promise<void> {
  const sourceDir = path.join(options.bundleDir, options.sourcePath);
  assertBundleTargetDirectory(sourceDir, options.sourcePath);

  const translTool = toTranslationToolName(options.toolName);
  const reservedDestinations = new Set<string>(); // keyed by repo-relative path

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Bundle contains a symlink which is not allowed: ${path.join(sourceDir, entry.name)}`);
    }

    let translated: Record<string, string>;

    if (options.targetName === "skills") {
      if (!entry.isDirectory()) continue;

      const skillDir = path.join(sourceDir, entry.name);
      const files: Record<string, string> = {};
      readFilesIntoRecord(skillDir, "", files);
      translated = translateSkill({ sourceTool: "claude", targetTool: translTool, files });
    } else if (options.targetName === "commands") {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

      const commandName = entry.name.slice(0, -3);
      const content = fs.readFileSync(path.join(sourceDir, entry.name), "utf8");
      translated = translateCommand({
        sourceTool: "claude",
        targetTool: translTool as "claude" | "cursor" | "opencode" | "codex",
        source: content,
        options: { name: commandName },
      });
    } else if (options.targetName === "agents") {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (translTool === "cursor") continue; // cursor has no agents target

      const content = fs.readFileSync(path.join(sourceDir, entry.name), "utf8");
      translated = translateAgent({
        sourceTool: "claude",
        targetTool: translTool as "claude" | "codex" | "opencode",
        source: content,
      });
    } else {
      continue;
    }

    for (const [repoRelPath, content] of Object.entries(translated)) {
      await writeTranslatedFile({
        repoRelPath,
        content,
        repoRoot: options.repoRoot,
        writtenFiles: options.writtenFiles,
        ownedDirectories: options.ownedDirectories,
        reservedDestinations,
        resolveFileConflict: options.resolveFileConflict,
      });
    }
  }
}

// Writes a single translated file to the repo, creating parent directories and handling
// conflicts. Paths are relative to repoRoot (e.g. ".cursor/skills/react/SKILL.md").
async function writeTranslatedFile(options: {
  repoRelPath: string;
  content: string;
  repoRoot: string;
  writtenFiles: string[];
  ownedDirectories: Set<string>;
  reservedDestinations: Set<string>;
  resolveFileConflict:
    | ((conflictPath: string, suggestedDestination: string) => Promise<FileConflictResolution>)
    | undefined;
}): Promise<void> {
  // The first two path segments form the "target root" for this translated file
  // (e.g. ".cursor/skills"). Conflict prompts are expressed relative to it.
  const targetRoot = options.repoRelPath.split("/").slice(0, 2).join("/");
  const targetRootAbsPath = path.join(options.repoRoot, ...targetRoot.split("/"));

  let currentRepoRelPath = options.repoRelPath;
  let currentAbsPath = path.join(options.repoRoot, ...currentRepoRelPath.split("/"));

  while (true) {
    const hasReserved = options.reservedDestinations.has(currentRepoRelPath);
    const hasFilesystem = fs.existsSync(currentAbsPath);

    if (!hasReserved && !hasFilesystem) break;

    if (!options.resolveFileConflict) {
      throw new Error(`Conflict detected: ${currentRepoRelPath}`);
    }

    const currentTargetRoot = currentRepoRelPath.split("/").slice(0, 2).join("/");
    const relWithinTarget = currentRepoRelPath.substring(currentTargetRoot.length + 1);
    const suggestedRelWithinTarget = suggestPrefixedDestination(relWithinTarget, DEFAULT_CONFLICT_PREFIX);

    const resolution = await options.resolveFileConflict(relWithinTarget, suggestedRelWithinTarget);

    if (resolution.action === "skip") return;

    const newRelWithinTarget =
      resolution.action === "prefix"
        ? suggestPrefixedDestination(relWithinTarget, resolution.prefix)
        : normalizeConflictDestination(resolution.destination);

    if (!newRelWithinTarget) {
      throw new Error("Conflict destination must stay inside the tool target");
    }

    currentRepoRelPath = `${currentTargetRoot}/${newRelWithinTarget}`;
    currentAbsPath = path.join(options.repoRoot, ...currentRepoRelPath.split("/"));
  }

  // Track the target root dir as owned if it did not exist before this materialization.
  const targetRootIsNew = !fs.existsSync(targetRootAbsPath);

  // Track any intermediate directories between targetRoot and the file's parent that
  // did not exist before (e.g. ".cursor/skills/react").
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

  if (targetRootIsNew) {
    options.ownedDirectories.add(path.relative(options.repoRoot, targetRootAbsPath));
  }

  fs.writeFileSync(currentAbsPath, options.content);
  options.reservedDestinations.add(currentRepoRelPath);
  options.writtenFiles.push(currentRepoRelPath);
}

function assertBundleTargetDirectory(sourceDir: string, targetPath: string): void {
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
