import fs from "node:fs";
import path from "node:path";

import { type BundleManifest } from "./bundle-manifest";
import { configureSkulExcludeBlock } from "./git-exclude";
import { type InstallMode } from "./registry";
import { resolveToolTargetPath, type ToolTargetName } from "./tool-mapping";

export interface MaterializeBundleResult {
  files: string[];
  excludeConfigured: boolean;
}

export function materializeBundle(options: {
  repoRoot: string;
  gitDir?: string;
  mode?: InstallMode;
  bundleDir: string;
  manifest: BundleManifest;
}): MaterializeBundleResult {
  const writtenFiles: string[] = [];

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

    copyDirectory(sourceDir, destinationDir, writtenFiles, options.repoRoot);
  }

  writtenFiles.sort((left, right) => {
    const depthDifference = pathDepth(left) - pathDepth(right);

    return depthDifference !== 0 ? depthDifference : left.localeCompare(right);
  });

  return finalizeMaterialization({
    files: writtenFiles,
    gitDir: options.gitDir,
    mode: options.mode ?? "tracked",
  });
}

function copyDirectory(
  sourceDir: string,
  destinationDir: string,
  writtenFiles: string[],
  repoRoot: string,
): void {
  fs.mkdirSync(destinationDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath, writtenFiles, repoRoot);
      continue;
    }

    if (entry.isFile()) {
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
      writtenFiles.push(path.relative(repoRoot, destinationPath));
    }
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

function finalizeMaterialization(options: {
  files: string[];
  gitDir?: string;
  mode: InstallMode;
}): MaterializeBundleResult {
  if (options.mode !== "stealth") {
    return {
      files: options.files,
      excludeConfigured: false,
    };
  }

  const gitDir = options.gitDir?.trim();

  if (!gitDir) {
    throw new Error("A git directory is required for stealth materialization");
  }

  configureSkulExcludeBlock({ gitDir, files: options.files });

  return {
    files: options.files,
    excludeConfigured: true,
  };
}
