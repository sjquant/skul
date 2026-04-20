import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectSourceProtocol, findCachedBundle, listCachedBundles } from "./bundle-discovery";
import {
  fetchRemoteSource,
  inspectRemoteSource,
  readCachedSourceRevision,
  updateCachedRemoteSource,
} from "./bundle-fetch";
import { materializeBundle, type MaterializeBundleResult } from "./bundle-materialization";
import {
  type BundleSelection,
  createHeadlessPromptClient,
  createHelpText,
  createPromptClient,
  createPromptClientForSelections,
  isHeadlessMode,
  type PromptClient,
  parseCliArgs,
} from "./cli";
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
  const stateLayout = resolveGlobalStateLayout({ homeDir: options.homeDir ?? os.homedir() });
  const prompts = options.prompts ?? createDefaultPromptClient(stateLayout.libraryDir);
  const parsed = await parseCliArgs(argv, prompts);
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
      protocol: parsed.options.protocol,
      agents: parsed.options.agents,
      dryRun: parsed.options.dryRun,
    });
  }

  if (parsed.command === "list") {
    return renderBundleList({ libraryDir: stateLayout.libraryDir, json: parsed.options.json });
  }

  if (parsed.command === "status") {
    return renderStatus({
      cwd,
      registryFile: stateLayout.registryFile,
      json: parsed.options.json,
    });
  }

  if (parsed.command === "check") {
    return renderUpdateCheck({
      cwd,
      registryFile: stateLayout.registryFile,
      libraryDir: stateLayout.libraryDir,
      bundle: parsed.options.bundle,
      json: parsed.options.json,
    });
  }

  if (parsed.command === "update") {
    return updateBundles({
      cwd,
      prompts,
      registryFile: stateLayout.registryFile,
      libraryDir: stateLayout.libraryDir,
      bundle: parsed.options.bundle,
      dryRun: parsed.options.dryRun,
    });
  }

  if (parsed.command === "reset") {
    return resetWorktree({
      cwd,
      prompts,
      registryFile: stateLayout.registryFile,
      dryRun: parsed.options.dryRun,
    });
  }

  if (parsed.command === "remove") {
    return removeBundle({
      cwd,
      prompts,
      registryFile: stateLayout.registryFile,
      bundle: parsed.options.bundle,
      dryRun: parsed.options.dryRun,
    });
  }

  if (parsed.command === "apply") {
    return applyWorktree({
      cwd,
      prompts,
      registryFile: stateLayout.registryFile,
      libraryDir: stateLayout.libraryDir,
    });
  }

  // All known commands are handled above — this branch is unreachable at runtime.
  return "Command not implemented";
}

function createDefaultPromptClient(libraryDir: string): PromptClient {
  if (isHeadlessMode()) {
    return createHeadlessPromptClient();
  }

  const availableBundles = listCachedBundles({ libraryDir })
    .map((bundle) => buildBundleSelection(bundle.source, bundle.bundle, libraryDir))
    .sort(compareBundleSelections);

  return createPromptClientForSelections(availableBundles);
}

function buildBundleSelection(
  source: string,
  bundle: string,
  libraryDir: string,
): BundleSelection {
  const revision = readCachedSourceRevision({ source, libraryDir });
  const protocol = revision.remoteUrl ? detectSourceProtocol(revision.remoteUrl) : "https";

  return {
    bundle,
    source,
    protocol,
  };
}

function compareBundleSelections(left: BundleSelection, right: BundleSelection): number {
  const bundleNameComparison = left.bundle.localeCompare(right.bundle);

  if (bundleNameComparison !== 0) {
    return bundleNameComparison;
  }

  return (left.source ?? "").localeCompare(right.source ?? "");
}

function renderBundleList(options: { libraryDir: string; json: boolean }): string {
  const bundles = listCachedBundles(options);

  if (options.json) {
    return JSON.stringify(
      {
        bundles: bundles.map((bundle) => ({
          name: bundle.bundle,
          tools: Object.keys(bundle.manifest.tools),
        })),
      },
      null,
      2,
    );
  }

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
  json: boolean;
}): string {
  const gitContext = requireGitContext(options.cwd, "status");

  const registry = readRegistryWithGuidance(options.registryFile);
  const repoState = registry.repos[gitContext.repoFingerprint];
  const worktreeState = registry.worktrees[gitContext.worktreeId];

  if (options.json) {
    const desiredState = repoState?.desired_state ?? [];
    const worktreeData = worktreeState
      ? {
          path: gitContext.worktreeRoot,
          materialized: true,
          bundles: Object.fromEntries(
            Object.entries(worktreeState.materialized_state.bundles).map(([bundleName, bundleState]) => [
              bundleName,
              {
                tools: Object.fromEntries(
                  Object.entries(bundleState.tools).map(([toolName, toolState]) => [
                    toolName,
                    { files: toolState.files },
                  ]),
                ),
              },
            ]),
          ),
          git_exclude_configured: hasSkulExcludeBlock({ gitDir: gitContext.gitDir }),
        }
      : {
          path: gitContext.worktreeRoot,
          materialized: false,
          bundles: {},
          git_exclude_configured: hasSkulExcludeBlock({ gitDir: gitContext.gitDir }),
        };

    const suggestedAction =
      !worktreeState && repoState && repoState.desired_state.length > 0 ? "skul apply" : null;

    return JSON.stringify(
      {
        repo: { desired_state: desiredState },
        worktree: worktreeData,
        ...(suggestedAction !== null ? { suggested_action: suggestedAction } : {}),
      },
      null,
      2,
    );
  }

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
      lines.push('Suggested Action: run "skul apply"');
    }

    return lines.join("\n");
  }

  lines.push("Materialized: yes", "", "Files:");

  for (const [bundleName, bundleState] of Object.entries(worktreeState.materialized_state.bundles)) {
    lines.push(`  Bundle: ${bundleName}`);
    for (const [toolName, toolState] of Object.entries(bundleState.tools)) {
      lines.push(`    Tool: ${toolName}`);
      for (const file of toolState.files) {
        lines.push(`      ${file}`);
      }
    }
  }

  lines.push("", "Git Exclude:");
  lines.push(`  ${hasSkulExcludeBlock({ gitDir: gitContext.gitDir }) ? "configured" : "missing"}`);

  return lines.join("\n");
}

function renderUpdateCheck(options: {
  cwd: string;
  registryFile: string;
  libraryDir: string;
  bundle?: string;
  json: boolean;
}): string {
  const gitContext = requireGitContext(options.cwd, "check");
  const registry = readRegistryWithGuidance(options.registryFile);
  const repoState = registry.repos[gitContext.repoFingerprint];
  const worktreeState = registry.worktrees[gitContext.worktreeId];
  const entries = selectDesiredEntries(repoState?.desired_state ?? [], options.bundle, "check");

  if (entries.length === 0) {
    return "No bundles configured for this repository";
  }

  const results = entries.map((entry) => {
    const materializedBundle = worktreeState?.materialized_state.bundles[entry.bundle];

    if (!entry.source) {
      return {
        bundle: entry.bundle,
        status: "local-only",
        source: null,
        current_commit: null,
        latest_commit: null,
        worktree_commit: materializedBundle?.resolved_commit ?? null,
        worktree_stale: false,
      };
    }

    const remoteStatus = inspectRemoteSource({
      source: entry.source,
      libraryDir: options.libraryDir,
      protocol: entry.protocol,
      ref: entry.ref,
    });
    const desiredCommit = entry.resolved_commit ?? remoteStatus.currentCommit ?? null;
    const worktreeCommit = materializedBundle?.resolved_commit ?? null;
    const isPinned = remoteStatus.refKind === "commit";
    const status =
      isPinned
        ? "pinned"
        : desiredCommit !== null && desiredCommit === remoteStatus.remoteCommit
          ? "up-to-date"
          : "update-available";
    const worktreeStale =
      worktreeCommit !== null &&
      desiredCommit !== null &&
      worktreeCommit !== desiredCommit;

    return {
      bundle: entry.bundle,
      status,
      source: entry.source,
      current_commit: desiredCommit,
      latest_commit: isPinned ? desiredCommit : remoteStatus.remoteCommit,
      worktree_commit: worktreeCommit,
      worktree_stale: worktreeStale,
    };
  });

  if (options.json) {
    return JSON.stringify({ bundles: results }, null, 2);
  }

  return results
    .map((result) => {
      const updateSuffix =
        result.status === "update-available" && result.current_commit && result.latest_commit
          ? ` ${shortCommit(result.current_commit)} -> ${shortCommit(result.latest_commit)}`
          : "";
      const staleSuffix = result.worktree_stale ? " (worktree stale)" : "";
      return `${result.bundle}: ${result.status}${updateSuffix}${staleSuffix}`;
    })
    .join("\n");
}

async function updateBundles(options: {
  cwd: string;
  prompts: PromptClient;
  registryFile: string;
  libraryDir: string;
  bundle?: string;
  dryRun: boolean;
}): Promise<string> {
  const gitContext = requireGitContext(options.cwd, "update");
  let registry = readRegistryWithGuidance(options.registryFile);
  const repoState = registry.repos[gitContext.repoFingerprint];
  const worktreeState = registry.worktrees[gitContext.worktreeId];
  const entries = selectDesiredEntries(repoState?.desired_state ?? [], options.bundle, "update");

  if (entries.length === 0) {
    return "No bundles configured for this repository";
  }

  const updatePlans = entries.flatMap((entry) => {
    if (!entry.source) {
      return [];
    }

    const remoteStatus = inspectRemoteSource({
      source: entry.source,
      libraryDir: options.libraryDir,
      protocol: entry.protocol,
      ref: entry.ref,
    });
    const currentCommit = entry.resolved_commit ?? remoteStatus.currentCommit;

    if (
      (currentCommit !== undefined && currentCommit === remoteStatus.remoteCommit) ||
      remoteStatus.refKind === "commit"
    ) {
      return [];
    }

    return [{
      entry,
      currentCommit,
      remoteStatus,
    }];
  });

  if (updatePlans.length === 0) {
    return "All selected bundles are already up to date";
  }

  if (options.dryRun) {
    return updatePlans
      .map(
        ({ entry, currentCommit, remoteStatus }) =>
          `DRY RUN: Would update ${entry.bundle}${formatCommitTransition(currentCommit, remoteStatus.remoteCommit)}`,
      )
      .join("\n");
  }

  const existingWorktreeState = registry.worktrees[gitContext.worktreeId]?.materialized_state;
  let currentBundles: MaterializedState["bundles"] = { ...(existingWorktreeState?.bundles ?? {}) };
  const nextDesiredState = [...(repoState?.desired_state ?? [])];
  const outputLines: string[] = [];

  for (const { entry, currentCommit, remoteStatus } of updatePlans) {
    const existingBundleState = currentBundles[entry.bundle];
    const toolsToRefresh = getToolsToRefresh(entry, existingBundleState);
    const bundleStateToReplace =
      existingBundleState && toolsToRefresh && toolsToRefresh.length > 0
        ? {
            ...existingBundleState,
            tools: Object.fromEntries(
              Object.entries(existingBundleState.tools).filter(([toolName]) =>
                toolsToRefresh.includes(toolName as ToolName),
              ),
            ),
          }
        : existingBundleState;

    if (existingBundleState) {
      const replacementAllowed = await confirmManagedFileRemovals(
        gitContext.worktreeRoot,
        flattenBundleState(bundleStateToReplace),
        options.prompts,
        "replace",
      );

      if (!replacementAllowed) {
        throw new Error("Replacement aborted because a modified managed file was kept");
      }
    }

    const refreshed = updateCachedRemoteSource({
      source: entry.source!,
      libraryDir: options.libraryDir,
      protocol: entry.protocol,
      ref: entry.ref,
    });
    const desiredIndex = nextDesiredState.findIndex((candidate) => candidate.bundle === entry.bundle);

    nextDesiredState[desiredIndex] = {
      ...nextDesiredState[desiredIndex]!,
      ...(toolsToRefresh !== undefined ? { tools: toolsToRefresh } : {}),
      ...(refreshed.resolvedRef !== undefined ? { resolved_ref: refreshed.resolvedRef } : {}),
      resolved_commit: refreshed.currentCommit,
    };

    if (bundleStateToReplace) {
      removeManagedPaths(gitContext.worktreeRoot, flattenBundleState(bundleStateToReplace));

      const cachedBundle = findCachedBundleWithGuidance({
        libraryDir: options.libraryDir,
        bundle: entry.bundle,
        source: entry.source,
      });
      const materializedResult = await materializeBundle({
        repoRoot: gitContext.worktreeRoot,
        bundleDir: path.dirname(cachedBundle.manifestFile),
        manifest: cachedBundle.manifest,
        tools: toolsToRefresh,
        resolveFileConflict: options.prompts.resolveFileConflict,
      });

      currentBundles = {
        ...currentBundles,
        [entry.bundle]: buildMaterializedBundleState({
          existingBundleState,
          materializedResult,
          repoRoot: gitContext.worktreeRoot,
          source: entry.source,
          resolvedCommit: refreshed.currentCommit,
          selectedTools: toolsToRefresh,
        }),
      };
    }

    outputLines.push(
      `Updated ${entry.bundle}${formatCommitTransition(currentCommit, remoteStatus.remoteCommit)}`,
    );
  }

  registry = upsertRepoState(registry, gitContext.repoFingerprint, {
    repo_root: gitContext.repoRoot,
    desired_state: nextDesiredState,
  });

  if (registry.worktrees[gitContext.worktreeId] || Object.keys(currentBundles).length > 0) {
    const newMaterializedState: MaterializedState = {
      bundles: currentBundles,
      exclude_configured: Object.keys(currentBundles).length > 0,
    };

    if (Object.keys(currentBundles).length > 0) {
      configureSkulExcludeBlock({
        gitDir: gitContext.gitDir,
        files: collectAllFiles(newMaterializedState),
      });

      registry = upsertWorktreeState(registry, gitContext.worktreeId, {
        repo_fingerprint: gitContext.repoFingerprint,
        path: gitContext.worktreeRoot,
        materialized_state: newMaterializedState,
      });
    } else {
      removeSkulExcludeBlock({ gitDir: gitContext.gitDir });
      registry = removeWorktreeState(registry, gitContext.worktreeId);
    }
  }

  writeRegistryFile(options.registryFile, registry);

  return outputLines.join("\n");
}

async function applyBundle(options: {
  cwd: string;
  prompts: PromptClient;
  registryFile: string;
  libraryDir: string;
  bundle: string;
  source?: string;
  protocol: "https" | "ssh";
  agents: ToolName[];
  dryRun: boolean;
}): Promise<string> {
  const gitContext = requireGitContext(options.cwd, "add");

  const cloneLines: string[] = [];
  if (options.source) {
    const { cloned } = fetchRemoteSource({ source: options.source, libraryDir: options.libraryDir, protocol: options.protocol });
    if (cloned) cloneLines.push(`Cloned ${options.source}`);
  }
  const sourceRevision = options.source
    ? readCachedSourceRevision({
        source: options.source,
        libraryDir: options.libraryDir,
        protocol: options.protocol,
      })
    : undefined;

  const cachedBundle = findCachedBundleWithGuidance({
    libraryDir: options.libraryDir,
    bundle: options.bundle,
    source: options.source,
  });

  const availableTools = Object.keys(cachedBundle.manifest.tools);
  const hasToolSelection = options.agents.length > 0;

  if (hasToolSelection) {
    const unknownTools = options.agents.filter((t) => !availableTools.includes(t));

    if (unknownTools.length > 0) {
      throw new Error(
        `Bundle does not support agent(s): ${unknownTools.join(", ")}\nSupported agents: ${availableTools.join(", ")}`,
      );
    }
  }

  const toolLabel = (hasToolSelection ? options.agents : availableTools).join(", ");

  if (options.dryRun) {
    return [...cloneLines, `DRY RUN: Would apply ${cachedBundle.bundle} for ${toolLabel}`].join("\n");
  }

  let registry = readRegistryWithGuidance(options.registryFile);
  const existingWorktreeState = registry.worktrees[gitContext.worktreeId]?.materialized_state;
  const existingBundleState = existingWorktreeState?.bundles[cachedBundle.bundle];

  if (existingBundleState) {
    // When --agent is specified, only replace the selected agents; otherwise replace all agents for this bundle
    const toolsToReplace = hasToolSelection
      ? options.agents.filter((t) => t in existingBundleState.tools)
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
    tools: hasToolSelection ? options.agents : undefined,
    resolveFileConflict: options.prompts.resolveFileConflict,
  });

  const newBundleState = buildMaterializedBundleState({
    existingBundleState,
    materializedResult,
    repoRoot: gitContext.worktreeRoot,
    source: options.source,
    resolvedCommit: sourceRevision?.currentCommit,
    selectedTools: hasToolSelection ? options.agents : undefined,
  });

  // Append to desired_state if this bundle isn't already listed (idempotent add)
  const existingDesiredState = registry.repos[gitContext.repoFingerprint]?.desired_state ?? [];
  const existingDesiredEntry = existingDesiredState.find((entry) => entry.bundle === cachedBundle.bundle);
  const mergedDesiredTools = mergeDesiredTools({
    existingEntry: existingDesiredEntry,
    requestedTools: hasToolSelection ? options.agents : undefined,
  });
  const newDesiredEntry: DesiredBundleEntry = {
    bundle: cachedBundle.bundle,
    ...(options.source !== undefined
      ? { source: options.source }
      : existingDesiredEntry?.source !== undefined
        ? { source: existingDesiredEntry.source }
        : {}),
    ...(mergedDesiredTools !== undefined ? { tools: mergedDesiredTools } : {}),
    protocol: options.protocol ?? existingDesiredEntry?.protocol ?? "https",
    ...(sourceRevision?.currentRef !== undefined
      ? { resolved_ref: sourceRevision.currentRef }
      : existingDesiredEntry?.resolved_ref !== undefined
        ? { resolved_ref: existingDesiredEntry.resolved_ref }
        : {}),
    ...(sourceRevision?.currentCommit !== undefined
      ? { resolved_commit: sourceRevision.currentCommit }
      : existingDesiredEntry?.resolved_commit !== undefined
        ? { resolved_commit: existingDesiredEntry.resolved_commit }
        : {}),
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

  return [...cloneLines, `Applied ${cachedBundle.bundle} for ${toolLabel}`].join("\n");
}

async function resetWorktree(options: {
  cwd: string;
  prompts: PromptClient;
  registryFile: string;
  dryRun: boolean;
}): Promise<string> {
  const gitContext = requireGitContext(options.cwd, "reset");

  let registry = readRegistryWithGuidance(options.registryFile);
  const worktreeState = registry.worktrees[gitContext.worktreeId];

  if (options.dryRun) {
    if (!worktreeState) {
      return "DRY RUN: No Skul-managed files found in the current worktree";
    }

    const allFiles = Object.values(worktreeState.materialized_state.bundles).flatMap(
      (bundleState) => Object.values(bundleState.tools).flatMap((toolState) => toolState.files),
    );

    const lines = [`DRY RUN: Would remove ${allFiles.length} file(s) from ${gitContext.worktreeRoot}`];
    for (const file of allFiles) {
      lines.push(`  ${file}`);
    }

    return lines.join("\n");
  }

  if (worktreeState) {
    const allBundlePaths = Object.values(worktreeState.materialized_state.bundles).map(flattenBundleState);

    // Confirm all removals before touching any files (all-or-nothing)
    for (const bundlePaths of allBundlePaths) {
      const resetAllowed = await confirmManagedFileRemovals(
        gitContext.worktreeRoot,
        bundlePaths,
        options.prompts,
        "reset",
      );

      if (!resetAllowed) {
        throw new Error("Reset aborted because a modified managed file was kept");
      }
    }

    for (const bundlePaths of allBundlePaths) {
      removeManagedPaths(gitContext.worktreeRoot, bundlePaths);
    }

    registry = removeWorktreeState(registry, gitContext.worktreeId);
    writeRegistryFile(options.registryFile, registry);
  }

  const excludeRemoved = removeSkulExcludeBlock({ gitDir: gitContext.gitDir });

  if (!worktreeState && !excludeRemoved) {
    return "No Skul-managed files found in the current worktree";
  }

  return "Reset Skul-managed files from the current worktree";
}

async function removeBundle(options: {
  cwd: string;
  prompts: PromptClient;
  registryFile: string;
  bundle: string;
  dryRun: boolean;
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

  if (options.dryRun) {
    if (bundleMaterializedState) {
      const files = Object.values(bundleMaterializedState.tools).flatMap((toolState) => toolState.files);
      const lines = [`DRY RUN: Would remove ${options.bundle} (${files.length} file(s))`];
      for (const file of files) {
        lines.push(`  ${file}`);
      }
      return lines.join("\n");
    }

    return `DRY RUN: Would remove ${options.bundle} from desired state (not yet materialized in this worktree)`;
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
      repo_root: gitContext.repoRoot,
      desired_state: newDesiredState,
    });
  }

  writeRegistryFile(options.registryFile, registry);

  return `Removed ${options.bundle}`;
}

async function applyWorktree(options: {
  cwd: string;
  prompts: PromptClient;
  registryFile: string;
  libraryDir: string;
}): Promise<string> {
  const gitContext = requireGitContext(options.cwd, "apply");
  let registry = readRegistryWithGuidance(options.registryFile);
  const repoState = registry.repos[gitContext.repoFingerprint];

  if (!repoState || repoState.desired_state.length === 0) {
    return "No bundles configured for this repository";
  }

  const worktreeState = registry.worktrees[gitContext.worktreeId];
  const materializedBundles = worktreeState?.materialized_state.bundles ?? {};
  const cloneLines: string[] = [];
  const applyPlans = repoState.desired_state.flatMap((entry) => {
    if (entry.source) {
      const { cloned } = fetchRemoteSource({ source: entry.source, libraryDir: options.libraryDir, protocol: entry.protocol });
      if (cloned) cloneLines.push(`Cloned ${entry.source}`);
    }
    const sourceRevision = entry.source
      ? readCachedSourceRevision({
          source: entry.source,
          libraryDir: options.libraryDir,
          protocol: entry.protocol,
        })
      : undefined;

    const cachedBundle = findCachedBundleWithGuidance({
      libraryDir: options.libraryDir,
      bundle: entry.bundle,
      source: entry.source,
    });
    const existingBundleState = materializedBundles[entry.bundle];

    if (
      existingBundleState &&
      isDesiredBundleMaterialized({
        desiredEntry: entry,
        materializedBundleState: existingBundleState,
        availableTools: Object.keys(cachedBundle.manifest.tools) as ToolName[],
      })
    ) {
      return [];
    }

    return [{
      entry,
      sourceRevision,
      cachedBundle,
      existingBundleState,
      availableTools: Object.keys(cachedBundle.manifest.tools) as ToolName[],
    }];
  });

  if (applyPlans.length === 0) {
    return "All bundles are already materialized";
  }

  let currentBundles: MaterializedState["bundles"] = { ...materializedBundles };

  for (const { entry, sourceRevision, cachedBundle, existingBundleState, availableTools } of applyPlans) {
    const toolsToApply = getToolsToApply({
      desiredEntry: entry,
      materializedBundleState: existingBundleState,
      availableTools,
    });

    const materializedResult = await materializeBundle({
      repoRoot: gitContext.worktreeRoot,
      bundleDir: path.dirname(cachedBundle.manifestFile),
      manifest: cachedBundle.manifest,
      tools: toolsToApply,
      resolveFileConflict: options.prompts.resolveFileConflict,
    });

    currentBundles = {
      ...currentBundles,
      [cachedBundle.bundle]: buildMaterializedBundleState({
        materializedResult,
        repoRoot: gitContext.worktreeRoot,
        source: entry.source,
        resolvedCommit: entry.resolved_commit ?? sourceRevision?.currentCommit,
        selectedTools: toolsToApply,
      }),
    };

    const newMatState: MaterializedState = {
      bundles: currentBundles,
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
  }

  const appliedNames = applyPlans.map(({ entry }) => entry.bundle).join(", ");
  return [...cloneLines, `Applied ${appliedNames}`].join("\n");
}

function isDesiredBundleMaterialized(options: {
  desiredEntry: DesiredBundleEntry;
  materializedBundleState: MaterializedBundleState;
  availableTools: ToolName[];
}): boolean {
  const expectedTools = options.desiredEntry.tools ?? options.availableTools;

  return expectedTools.every((toolName) => toolName in options.materializedBundleState.tools);
}

function getToolsToApply(options: {
  desiredEntry: DesiredBundleEntry;
  materializedBundleState?: MaterializedBundleState;
  availableTools: ToolName[];
}): ToolName[] | undefined {
  const expectedTools = options.desiredEntry.tools ?? options.availableTools;

  if (!options.materializedBundleState) {
    return options.desiredEntry.tools;
  }

  const existingTools = options.materializedBundleState.tools;

  return expectedTools.filter((toolName) => !(toolName in existingTools));
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

// Build per-tool registry entries from a materialization result
function buildMaterializedToolStates(
  repoRoot: string,
  result: MaterializeBundleResult,
): Record<string, MaterializedToolState> {
  return Object.fromEntries(
    Object.entries(result.byTool).map(([toolName, toolResult]) => [
      toolName,
      {
        files: toolResult.files,
        file_fingerprints: captureManagedFileFingerprints(repoRoot, toolResult.files),
        ...(toolResult.directories.length > 0 ? { directories: toolResult.directories } : {}),
      } satisfies MaterializedToolState,
    ]),
  );
}

function buildMaterializedBundleState(options: {
  existingBundleState?: MaterializedBundleState;
  materializedResult: MaterializeBundleResult;
  repoRoot: string;
  source?: string;
  resolvedCommit?: string;
  selectedTools?: ToolName[];
}): MaterializedBundleState {
  const preservedTools =
    options.existingBundleState && options.selectedTools
      ? Object.fromEntries(
          Object.entries(options.existingBundleState.tools).filter(
            ([toolName]) => !options.selectedTools!.includes(toolName as ToolName),
          ),
        )
      : {};

  return {
    ...(options.source !== undefined
      ? { source: options.source }
      : options.existingBundleState?.source !== undefined
        ? { source: options.existingBundleState.source }
        : {}),
    ...(options.resolvedCommit !== undefined
      ? { resolved_commit: options.resolvedCommit }
      : options.existingBundleState?.resolved_commit !== undefined
        ? { resolved_commit: options.existingBundleState.resolved_commit }
        : {}),
    tools: {
      ...preservedTools,
      ...buildMaterializedToolStates(options.repoRoot, options.materializedResult),
    },
  };
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

function requireGitContext(cwd: string, command: "add" | "apply" | "status" | "check" | "update" | "reset" | "remove") {
  const gitContext = detectGitContext({ cwd });

  if (!gitContext) {
    throw new Error(`skul ${command} requires a Git repository`);
  }

  return gitContext;
}

function selectDesiredEntries(
  desiredState: DesiredBundleEntry[],
  bundle: string | undefined,
  command: "check" | "update",
): DesiredBundleEntry[] {
  if (!bundle) {
    return desiredState;
  }

  const matchingEntry = desiredState.find((entry) => entry.bundle === bundle);

  if (!matchingEntry) {
    throw new Error(`Bundle not found in active set: ${bundle}`);
  }

  return [matchingEntry];
}

function mergeDesiredTools(options: {
  existingEntry?: DesiredBundleEntry;
  requestedTools?: ToolName[];
}): ToolName[] | undefined {
  if (options.requestedTools === undefined) {
    return undefined;
  }

  if (options.existingEntry?.tools === undefined) {
    return [...options.requestedTools];
  }

  return Array.from(new Set([...options.existingEntry.tools, ...options.requestedTools])).sort(
    (left, right) => left.localeCompare(right),
  ) as ToolName[];
}

function getToolsToRefresh(
  entry: DesiredBundleEntry,
  existingBundleState: MaterializedBundleState | undefined,
): ToolName[] | undefined {
  if (entry.tools === undefined) {
    return undefined;
  }

  const existingTools = existingBundleState
    ? (Object.keys(existingBundleState.tools) as ToolName[])
    : [];

  return Array.from(new Set([...entry.tools, ...existingTools])).sort(
    (left, right) => left.localeCompare(right),
  ) as ToolName[];
}

function formatCommitTransition(currentCommit: string | undefined, nextCommit: string): string {
  return currentCommit
    ? ` ${shortCommit(currentCommit)} -> ${shortCommit(nextCommit)}`
    : ` to ${shortCommit(nextCommit)}`;
}

function shortCommit(commit: string): string {
  return commit.slice(0, 7);
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
  operation: "reset" | "replace" | "remove",
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
