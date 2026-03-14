import fs from "node:fs";
import path from "node:path";

import { type BundleManifest } from "./bundle-manifest";
import { resolveToolTargetPath, type ToolTargetName } from "./tool-mapping";

export interface MaterializeBundleResult {
  files: string[];
  directories: string[];
}

export function materializeBundle(options: {
  repoRoot: string;
  bundleDir: string;
  manifest: BundleManifest;
}): MaterializeBundleResult {
  const writtenFiles: string[] = [];
  const ownedDirectories = new Set<string>();

  for (const [targetName, target] of Object.entries(options.manifest.targets)) {
    const sourceDir = path.join(options.bundleDir, target.path);
    const destinationDir = resolveToolTargetPath(
      options.manifest.tool,
      targetName as ToolTargetName,
      options.repoRoot,
    );

    if (!destinationDir) {
      continue;
    }

    assertBundleTargetDirectory(sourceDir, target.path);
    fs.mkdirSync(destinationDir, { recursive: true });

    copyDirectory(sourceDir, destinationDir, destinationDir, writtenFiles, ownedDirectories, options.repoRoot);
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

function copyDirectory(
  sourceDir: string,
  destinationDir: string,
  targetRoot: string,
  writtenFiles: string[],
  ownedDirectories: Set<string>,
  repoRoot: string,
): void {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(
        sourcePath,
        destinationPath,
        targetRoot,
        writtenFiles,
        ownedDirectories,
        repoRoot,
      );
      continue;
    }

    if (entry.isFile()) {
      ensureOwnedParentDirectories(
        path.dirname(destinationPath),
        targetRoot,
        ownedDirectories,
        repoRoot,
      );
      fs.copyFileSync(sourcePath, destinationPath);
      writtenFiles.push(path.relative(repoRoot, destinationPath));
    }
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
