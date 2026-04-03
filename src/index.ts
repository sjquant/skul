import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findCachedBundle, listCachedBundles } from "./bundle-discovery";
import { materializeBundle } from "./bundle-materialization";
import { createHelpText, createPromptClient, type PromptClient, parseCliArgs } from "./cli";
import { detectGitContext } from "./git-context";
import { configureSkulExcludeBlock, hasSkulExcludeBlock, removeSkulExcludeBlock } from "./git-exclude";
import {
  type DesiredBundleEntry,
  type MaterializedBundleState,
  type MaterializedState,
  type MaterializedToolState,
  listManagedPathsForRemoval,
  readRegistryFile,
  removeWorktreeState,
  upsertRepoState,
  upsertWorktreeState,
  writeRegistryFile,
} from "./registry";
import { resolveGlobalStateLayout } from "./state-layout";
import { type ToolName } from "./tool-mapping";

export interface RunOptions {
  homeDir?: string;
  cwd?: string;
  prompts?: PromptClient;
}

export async function run(argv: string[], options: RunOptions = {}): Promise<string> {
  const prompts = options.prompts ?? createPromptClient();
  const parsed = await parseCliArgs(argv, prompts);
  const stateLayout = resolveGlobalStateLayout({ homeDir: options.homeDir ?? os.homedir() });
  const cwd = options.cwd ?? process.cwd();

  if (parsed.kind === "help") {
    return createHelpText();
  }

  if (parsed.command === "add") {
    return applyBundle({
      cwd,
      prompts,
      registryFile: stateLayout.registryFile,
      libraryDir: stateLayout.libraryDir,
      bundle: parsed.options.bundle,
      source: parsed.options.source,
      tools: parsed.options.tools,
    });
  }

  if (parsed.command === "list") {
    return renderBundleList({ libraryDir: stateLayout.libraryDir });
  }

  if (parsed.command === "status") {
    return renderStatus({
      cwd,
      registryFile: stateLayout.registryFile,
    });
  }

  if (parsed.command === "clean") {
    return cleanWorktree({
      cwd,
      prompts,
      registryFile: stateLayout.registryFile,
    });
  }

  if (parsed.command === "remove") {
    return removeBundle({
      cwd,
      prompts,
      registryFile: stateLayout.registryFile,
      bundle: parsed.options.bundle,
    });
  }

  return `Command ${parsed.command} is defined but not implemented yet.`;
}

function renderBundleList(options: { libraryDir: string }): string {
  const bundles = listCachedBundles(options);

  if (bundles.length === 0) {
    return ["Available Bundles", "", "No cached bundles found."].join("\n");
  }

  return [
    "Available Bundles",
    "",
    ...bundles.map((bundle) => {
      const tools = Object.keys(bundle.manifest.tools).join(", ");
      return `${bundle.bundle} (${tools})`;
    }),
  ].join("\n");
}

function renderStatus(options: {
  cwd: string;
  registryFile: string;
}): string {
  const gitContext = requireGitContext(options.cwd, "status");

  const registry = readRegistryWithGuidance(options.registryFile);
  const repoState = registry.repos[gitContext.repoFingerprint];
  const worktreeState = registry.worktrees[gitContext.worktreeId];
  const lines: string[] = ["Repository Desired State"];

  if (repoState && repoState.desired_state.length > 0) {
    for (const entry of repoState.desired_state) {
      const toolSuffix = entry.tools ? ` (${entry.tools.join(", ")})` : "";
      lines.push(`Bundle: ${entry.bundle}${toolSuffix}`);
    }
  } else {
    lines.push("Configured: no");
  }

  lines.push("", "Current Worktree", `Path: ${gitContext.worktreeRoot}`);

  if (!worktreeState) {
    lines.push("Materialized: no");

    if (repoState && repoState.desired_state.length > 0) {
      lines.push('Suggested Action: run "skul add"');
    }

    return lines.join("\n");
  }

  lines.push("Materialized: yes", "", "Files:");

  for (const bundleState of Object.values(worktreeState.materialized_state.bundles)) {
    for (const toolState of Object.values(bundleState.tools)) {
      for (const file of toolState.files) {
        lines.push(`  ${file}`);
      }
    }
  }

  lines.push("", "Git Exclude:");
  lines.push(`  ${hasSkulExcludeBlock({ gitDir: gitContext.gitDir }) ? "configured" : "missing"}`);

  return lines.join("\n");
}

async function applyBundle(options: {
  cwd: string;
  prompts: PromptClient;
  registryFile: string;
  libraryDir: string;
  bundle: string;
  source?: string;
  tools: ToolName[];
}): Promise<string> {
  const gitContext = requireGitContext(options.cwd, "add");

  const cachedBundle = findCachedBundleWithGuidance({
    libraryDir: options.libraryDir,
    bundle: options.bundle,
    source: options.source,
  });

  const availableTools = Object.keys(cachedBundle.manifest.tools);
  const hasToolSelection = options.tools.length > 0;

  if (hasToolSelection) {
    const unknownTools = options.tools.filter((t) => !availableTools.includes(t));

    if (unknownTools.length > 0) {
      throw new Error(
        `Bundle does not support tool(s): ${unknownTools.join(", ")}\nSupported tools: ${availableTools.join(", ")}`,
      );
    }
  }

  let registry = readRegistryWithGuidance(options.registryFile);
  const existingWorktreeState = registry.worktrees[gitContext.worktreeId]?.materialized_state;
  const existingBundleState = existingWorktreeState?.bundles[cachedBundle.bundle];

  if (existingBundleState) {
    // When --tool is specified, only replace the selected tools; otherwise replace all tools for this bundle
    const toolsToReplace = hasToolSelection
      ? options.tools.filter((t) => t in existingBundleState.tools)
      : (Object.keys(existingBundleState.tools) as ToolName[]);

    const pathsToReplace = flattenBundleState({
      tools: Object.fromEntries(toolsToReplace.map((t) => [t, existingBundleState.tools[t]!])),
    });

    const replacementAllowed = await confirmManagedFileRemovals(
      gitContext.worktreeRoot,
      pathsToReplace,
      options.prompts,
      "replace",
    );

    if (!replacementAllowed) {
      throw new Error("Replacement aborted because a modified managed file was kept");
    }

    removeManagedPaths(gitContext.worktreeRoot, pathsToReplace);
  }

  const materializedResult = await materializeBundle({
    repoRoot: gitContext.worktreeRoot,
    bundleDir: path.dirname(cachedBundle.manifestFile),
    manifest: cachedBundle.manifest,
    tools: hasToolSelection ? options.tools : undefined,
    resolveFileConflict: options.prompts.resolveFileConflict,
  });

  const toolLabel = (hasToolSelection ? options.tools : availableTools).join(", ");

  // Build per-tool registry entries from the materialization result, preserving
  // existing tool states that were not part of this (partial) materialization run
  const preservedTools =
    existingBundleState && hasToolSelection
      ? Object.fromEntries(
          Object.entries(existingBundleState.tools).filter(
            ([t]) => !options.tools.includes(t as ToolName),
          ),
        )
      : {};

  const newBundleState: MaterializedBundleState = {
    ...(options.source !== undefined ? { source: options.source } : {}),
    tools: {
      ...preservedTools,
      ...Object.fromEntries(
        Object.entries(materializedResult.byTool).map(([toolName, toolResult]) => [
          toolName,
          {
            files: toolResult.files,
            file_fingerprints: captureManagedFileFingerprints(
              gitContext.worktreeRoot,
              toolResult.files,
            ),
            ...(toolResult.directories.length > 0 ? { directories: toolResult.directories } : {}),
          } satisfies MaterializedToolState,
        ]),
      ),
    },
  };

  // Append to desired_state if this bundle isn't already listed (idempotent add)
  const existingDesiredState = registry.repos[gitContext.repoFingerprint]?.desired_state ?? [];
  const newDesiredEntry: DesiredBundleEntry = {
    bundle: cachedBundle.bundle,
    ...(options.source !== undefined ? { source: options.source } : {}),
    ...(hasToolSelection ? { tools: options.tools } : {}),
  };
  const newDesiredState = [
    ...existingDesiredState.filter((e) => e.bundle !== cachedBundle.bundle),
    newDesiredEntry,
  ];

  registry = upsertRepoState(registry, gitContext.repoFingerprint, {
    repo_root: gitContext.repoRoot,
    desired_state: newDesiredState,
  });

  // Merge into existing materialized state, preserving other bundles
  const newMatState: MaterializedState = {
    bundles: {
      ...(existingWorktreeState?.bundles ?? {}),
      [cachedBundle.bundle]: newBundleState,
    },
    exclude_configured: true,
  };

  configureSkulExcludeBlock({
    gitDir: gitContext.gitDir,
    files: collectAllFiles(newMatState),
  });

  registry = upsertWorktreeState(registry, gitContext.worktreeId, {
    repo_fingerprint: gitContext.repoFingerprint,
    path: gitContext.worktreeRoot,
    materialized_state: newMatState,
  });
  writeRegistryFile(options.registryFile, registry);

  return `Applied ${cachedBundle.bundle} for ${toolLabel}`;
}

async function cleanWorktree(options: {
  cwd: string;
  prompts: PromptClient;
  registryFile: string;
}): Promise<string> {
  const gitContext = requireGitContext(options.cwd, "clean");

  let registry = readRegistryWithGuidance(options.registryFile);
  const worktreeState = registry.worktrees[gitContext.worktreeId];

  if (worktreeState) {
    for (const bundleState of Object.values(
      worktreeState.materialized_state.bundles,
    )) {
      const bundlePaths = flattenBundleState(bundleState);
      const cleanAllowed = await confirmManagedFileRemovals(
        gitContext.worktreeRoot,
        bundlePaths,
        options.prompts,
        "clean",
      );

      if (!cleanAllowed) {
        throw new Error("Clean aborted because a modified managed file was kept");
      }

      removeManagedPaths(gitContext.worktreeRoot, bundlePaths);
    }

    registry = removeWorktreeState(registry, gitContext.worktreeId);
    writeRegistryFile(options.registryFile, registry);
  }

  const excludeRemoved = removeSkulExcludeBlock({ gitDir: gitContext.gitDir });

  if (!worktreeState && !excludeRemoved) {
    return "No Skul-managed files found in the current worktree";
  }

  return "Cleaned Skul-managed files from the current worktree";
}

async function removeBundle(options: {
  cwd: string;
  prompts: PromptClient;
  registryFile: string;
  bundle: string;
}): Promise<string> {
  const gitContext = requireGitContext(options.cwd, "remove");

  let registry = readRegistryWithGuidance(options.registryFile);
  const repoState = registry.repos[gitContext.repoFingerprint];
  const worktreeState = registry.worktrees[gitContext.worktreeId];

  const isInDesiredState = repoState?.desired_state.some((e) => e.bundle === options.bundle) ?? false;
  const bundleMaterializedState = worktreeState?.materialized_state.bundles[options.bundle];

  if (!isInDesiredState && !bundleMaterializedState) {
    throw new Error(`Bundle not found in active set: ${options.bundle}`);
  }

  if (bundleMaterializedState) {
    const bundlePaths = flattenBundleState(bundleMaterializedState);
    const removeAllowed = await confirmManagedFileRemovals(
      gitContext.worktreeRoot,
      bundlePaths,
      options.prompts,
      "remove",
    );

    if (!removeAllowed) {
      throw new Error("Removal aborted because a modified managed file was kept");
    }

    removeManagedPaths(gitContext.worktreeRoot, bundlePaths);

    const remainingBundles = { ...worktreeState!.materialized_state.bundles };
    delete remainingBundles[options.bundle];

    if (Object.keys(remainingBundles).length > 0) {
      const newMatState: MaterializedState = {
        bundles: remainingBundles,
        exclude_configured: true,
      };

      configureSkulExcludeBlock({
        gitDir: gitContext.gitDir,
        files: collectAllFiles(newMatState),
      });

      registry = upsertWorktreeState(registry, gitContext.worktreeId, {
        repo_fingerprint: gitContext.repoFingerprint,
        path: gitContext.worktreeRoot,
        materialized_state: newMatState,
      });
    } else {
      removeSkulExcludeBlock({ gitDir: gitContext.gitDir });
      registry = removeWorktreeState(registry, gitContext.worktreeId);
    }
  }

  if (isInDesiredState && repoState) {
    const newDesiredState = repoState.desired_state.filter((e) => e.bundle !== options.bundle);
    registry = upsertRepoState(registry, gitContext.repoFingerprint, {
      ...repoState,
      desired_state: newDesiredState,
    });
  }

  writeRegistryFile(options.registryFile, registry);

  return `Removed ${options.bundle}`;
}

// Flatten all files and directories from every tool within a single bundle
function flattenBundleState(bundleState: MaterializedBundleState): {
  files: string[];
  file_fingerprints: Record<string, string>;
  directories: string[];
} {
  const files: string[] = [];
  const file_fingerprints: Record<string, string> = {};
  const directories: string[] = [];

  for (const toolState of Object.values(bundleState.tools)) {
    files.push(...toolState.files);
    if (toolState.file_fingerprints) Object.assign(file_fingerprints, toolState.file_fingerprints);
    if (toolState.directories) directories.push(...toolState.directories);
  }

  return { files, file_fingerprints, directories };
}

// Collect all files across every bundle and tool for git-exclude configuration
function collectAllFiles(materializedState: MaterializedState): string[] {
  return Object.values(materializedState.bundles).flatMap((bundleState) =>
    Object.values(bundleState.tools).flatMap((toolState) => toolState.files),
  );
}

function removeManagedPaths(
  repoRoot: string,
  state: Parameters<typeof listManagedPathsForRemoval>[0],
): void {
  for (const relativePath of listManagedPathsForRemoval(state)) {
    const targetPath = path.join(repoRoot, relativePath);

    if (!fs.existsSync(targetPath)) {
      continue;
    }

    const stats = fs.lstatSync(targetPath);

    if (stats.isDirectory()) {
      try {
        fs.rmdirSync(targetPath);
      } catch (error) {
        if (!isDirectoryNotEmptyError(error)) {
          throw error;
        }
      }
      continue;
    }

    fs.rmSync(targetPath, { force: true });
  }
}

function isDirectoryNotEmptyError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOTEMPTY";
}

function requireGitContext(cwd: string, command: "add" | "status" | "clean" | "remove") {
  const gitContext = detectGitContext({ cwd });

  if (!gitContext) {
    throw new Error(`skul ${command} requires a Git repository`);
  }

  return gitContext;
}

function readRegistryWithGuidance(registryFile: string) {
  try {
    return readRegistryFile(registryFile);
  } catch {
    throw new Error(`Registry is corrupted. Please repair or remove ${registryFile} and try again.`);
  }
}

function findCachedBundleWithGuidance(options: {
  libraryDir: string;
  bundle: string;
  source?: string;
}) {
  try {
    return findCachedBundle(options);
  } catch (error) {
    if (error instanceof Error && /^Bundle not found: /.test(error.message)) {
      const availableBundles = listCachedBundles({ libraryDir: options.libraryDir }).map(
        (bundle) => bundle.bundle,
      );

      if (availableBundles.length === 0) {
        throw error;
      }

      throw new Error(
        `${error.message}\nAvailable bundles:\n${Array.from(new Set(availableBundles))
          .sort((left, right) => left.localeCompare(right))
          .join("\n")}`,
      );
    }

    throw error;
  }
}

async function confirmManagedFileRemovals(
  repoRoot: string,
  state: { files: string[]; file_fingerprints?: Record<string, string> },
  prompts: PromptClient,
  operation: "clean" | "replace" | "remove",
): Promise<boolean> {
  for (const relativePath of findModifiedManagedFiles(repoRoot, state)) {
    const confirmed = await prompts.confirmManagedFileRemoval(relativePath, operation);

    if (!confirmed) {
      return false;
    }
  }

  return true;
}

function findModifiedManagedFiles(
  repoRoot: string,
  state: { files: string[]; file_fingerprints?: Record<string, string> },
): string[] {
  return state.files.filter((relativePath) => {
    const fingerprint = state.file_fingerprints?.[relativePath];

    if (!fingerprint) {
      return false;
    }

    const targetPath = path.join(repoRoot, relativePath);

    if (!fs.existsSync(targetPath) || !fs.lstatSync(targetPath).isFile()) {
      return false;
    }

    return fingerprint !== fingerprintFile(targetPath);
  });
}

function captureManagedFileFingerprints(
  repoRoot: string,
  files: string[],
): Record<string, string> {
  return Object.fromEntries(
    files.map((relativePath) => [relativePath, fingerprintFile(path.join(repoRoot, relativePath))]),
  );
}

function fingerprintFile(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

if (require.main === module) {
  void run(process.argv.slice(2))
    .then((output) => {
      console.log(output);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    });
}
