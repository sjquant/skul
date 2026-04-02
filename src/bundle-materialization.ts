import fs from "node:fs";
import path from "node:path";

import { type BundleManifest } from "./bundle-manifest";
import { type FileConflictResolution } from "./cli";
import {
  DEFAULT_CONFLICT_PREFIX,
  normalizeConflictDestination,
  suggestPrefixedDestination,
} from "./conflict-resolution";
import { resolveToolTargetPath, type ToolName, type ToolTargetName } from "./tool-mapping";

export interface MaterializeBundleResult {
  files: string[];
  directories: string[];
}

export async function materializeBundle(options: {
  repoRoot: string;
  bundleDir: string;
  manifest: BundleManifest;
  resolveFileConflict?: (conflictPath: string, suggestedDestination: string) => Promise<FileConflictResolution>;
}): Promise<MaterializeBundleResult> {
  const writtenFiles: string[] = [];
  const ownedDirectories = new Set<string>();

  for (const [toolName, targets] of Object.entries(options.manifest.tools)) {
    const toolReservedDestinations = new Set<string>();

    for (const [targetName, target] of Object.entries(targets)) {
      const sourceDir = path.join(options.bundleDir, target.path);
      const destinationDir = resolveToolTargetPath(
        toolName as ToolName,
        targetName as ToolTargetName,
        options.repoRoot,
      );

      if (!destinationDir) {
        continue;
      }

      assertBundleTargetDirectory(sourceDir, target.path);
      fs.mkdirSync(destinationDir, { recursive: true });

      await copyDirectory(
        sourceDir,
        destinationDir,
        destinationDir,
        writtenFiles,
        ownedDirectories,
        toolReservedDestinations,
        options.repoRoot,
        options.resolveFileConflict,
      );
    }
  }

  writtenFiles.sort((left, right) => {
    const depthDifference = pathDepth(left) - pathDepth(right);

    return depthDifference !== 0 ? depthDifference : left.localeCompare(right);
  });
  const directories = Array.from(ownedDirectories).sort((left, right) => {
    const depthDifference = pathDepth(right) - pathDepth(left);

    return depthDifference !== 0 ? depthDifference : left.localeCompare(right);
  });

  return { files: writtenFiles, directories };
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

function assertBundleTargetDirectory(sourceDir: string, targetPath: string): void {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Bundle target path does not exist: ${targetPath}`);
  }

  if (!fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`Bundle target path must be a directory: ${targetPath}`);
  }
}
