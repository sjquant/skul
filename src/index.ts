#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createColors, isColorSupported } from "picocolors";

import {
  type CachedBundle,
  detectSourceProtocol,
  findCachedBundle,
  listCachedBundles,
} from "./bundle-discovery";
import {
  type CachedSourceRevision,
  clearAndRefetchCachedRemoteSource,
  type FetchRemoteSourceOptions,
  fetchRemoteSource,
  inspectRemoteSource,
  type RemoteSourceStatus,
  readCachedSourceRevision,
  removeCachedRemoteSource,
  restoreCachedRemoteSourceRevision,
  updateCachedRemoteSource,
} from "./bundle-fetch";
import {
  BUNDLE_ITEM_REFS_FILE_NAME,
  listBundleItemRefSelectors,
  type ResolvedBundleItemRef,
  resolveBundleItemRefs,
} from "./bundle-item-refs";
import {
  assertBundleSupportsRequestedItems,
  type BundleItemSelector,
  bundleItemSelectionsEqual,
  isMcpItemSelected,
  isSelectableBundleItemEntry,
  listSelectableBundleItems,
  mergeDesiredBundleItems,
  normalizeBundleItemSelectors,
  stripKnownBundleItemExtension,
} from "./bundle-items";
import type { BundleManifest } from "./bundle-manifest";
import {
  type BundleMaterializationScope,
  type MaterializeBundleResult,
  materializeBundle,
  previewMaterializeBundleWriteTargets,
  readBundleMcpDeclarations,
  resolveMcpRepoRelPath,
} from "./bundle-materialization";
import {
  type BundleItemChoice,
  type BundleSelection,
  createHeadlessPromptClient,
  createHelpText,
  createPromptClientForSelections,
  isHeadlessMode,
  type PromptClient,
  parseCliArgs,
} from "./cli";
import { writeFileAtomic } from "./fs-utils";
import { detectGitContext } from "./git-context";
import {
  configureSkulExcludeBlock,
  hasSkulExcludeBlock,
  removeSkulExcludeBlock,
} from "./git-exclude";
import {
  clearGitSkipWorktree,
  inspectTrackedShadowTarget,
  isTrackedGitPath,
  listCommittedPaths,
  restoreCommittedPaths,
  setGitSkipWorktree,
} from "./git-index";
import {
  extractMcpOverlay,
  globalMcpCapableToolNames,
  type McpServer,
  type McpSubtractResult,
  mergeRenderedMcpServers,
  type RenderedMcpServers,
  renderMcpServers,
  resolveMcpPluginPaths,
  subtractMcpConfigServers,
} from "./mcp-config";
import {
  createMcpMaterializationOwnership,
  type McpMaterializationOwnership,
} from "./mcp-materialization-state";
import {
  type DesiredBundleEntry,
  type GlobalState,
  listManagedPathsForRemoval,
  type MaterializedBundleState,
  type MaterializedState,
  type MaterializedToolState,
  type Registry,
  type RepoState,
  type RootInstructionMode,
  readRegistryFile,
  removeWorktreeState,
  type ShadowedFileState,
  type ShadowStrategy,
  upsertGlobalState,
  upsertRepoState,
  upsertWorktreeState,
  type WorktreeState,
  writeRegistryFile,
} from "./registry";
import { collectComposedRootInstructionContents } from "./root-instruction-content";
import {
  fingerprintShadowContent,
  isRootInstructionPath,
  renderTrackedRootInstructionShadow,
} from "./root-instruction-render";
import {
  assertManagedRootInstructionSyncSourcesCached,
  captureRootInstructionBaseContents,
  collectManagedRootInstructionTargets,
  collectSharedRootInstructionState,
  refreshManagedFileFingerprintsForPaths,
  restoreRootInstructionBaseContents,
  syncManagedRootInstructionFiles,
} from "./root-instruction-state";
import { resolveBundleDataDir, resolveGlobalStateLayout } from "./state-layout";
import {
  GLOBAL_TOOL_MATERIALIZATION_LAYOUT,
  getToolDefinition,
  globalCapableToolNames,
  type ToolName,
  type ToolTargetName,
} from "./tool-mapping";
import { getPackageVersion } from "./version";

// Lazily evaluated so that SKUL_NO_TUI set after module load (e.g. in tests) is respected.
const pc = new Proxy({} as ReturnType<typeof createColors>, {
  get(_t, prop: string) {
    return createColors(isColorSupported && !isHeadlessMode())[
      prop as keyof ReturnType<typeof createColors>
    ];
  },
});

const ansiEscapeCodePattern = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);

type RefreshedSourceUpdate = {
  updated: boolean;
  before: SourceItemFingerprints;
  after: SourceItemFingerprints;
};

type SourceItemFingerprints = Map<
  string,
  Map<ToolName, Map<BundleItemSelector, string>>
>;

export interface RunOptions {
  homeDir?: string;
  cwd?: string;
  prompts?: PromptClient;
}

type CommandWarningCollector = string[];

/**
 * Managed paths already reported as committed during the current `run`.
 *
 * Cleared at the top of `run`, so the notice is once per command rather than
 * once per bundle a command happens to materialize.
 */
const reportedCommittedPaths = new Set<string>();

/** Parses CLI arguments and executes the selected Skul command. */
export async function run(
  argv: string[],
  options: RunOptions = {},
): Promise<string> {
  // One command can materialize many bundles — a whole source, or a selection
  // spread across several — and each pass sees the same worktree. Clearing here
  // scopes "report a committed managed file once" to the invocation.
  reportedCommittedPaths.clear();
  const stateLayout = resolveGlobalStateLayout({
    homeDir: options.homeDir ?? os.homedir(),
  });
  const prompts =
    options.prompts ?? createDefaultPromptClient(stateLayout.libraryDir);
  const parsed = await parseCliArgs(argv, prompts);
  const cwd = options.cwd ?? process.cwd();
  const commandWarnings: CommandWarningCollector = [];

  if (parsed.kind === "help") {
    return createHelpText(parsed.command);
  }

  if (parsed.kind === "version") {
    return getPackageVersion();
  }

  switch (parsed.command) {
    case "add": {
      const addPrompts = parsed.options.yes
        ? createYesPromptClient(prompts, { selectAllAgents: true })
        : prompts;

      if (parsed.options.all) {
        const addSource = parsed.options.source;
        if (addSource === undefined) {
          throw new Error("Command add --all requires a source");
        }

        return applyAllBundles({
          cwd,
          homeDir: options.homeDir ?? os.homedir(),
          prompts: addPrompts,
          registryFile: stateLayout.registryFile,
          libraryDir: stateLayout.libraryDir,
          source: addSource,
          protocol: parsed.options.protocol,
          agents: parsed.options.agents,
          dryRun: parsed.options.dryRun,
          ref: parsed.options.ref,
          global: parsed.options.global,
          disableModelInvocation: parsed.options.disableModelInvocation,
          rootInstructionMode: parsed.options.rootInstructionMode,
        });
      }

      const addBundle = parsed.options.bundle;
      if (addBundle === undefined) {
        throw new Error("Command add requires a bundle name");
      }

      if (parsed.options.global) {
        return applyBundleGlobal({
          homeDir: options.homeDir ?? os.homedir(),
          prompts: addPrompts,
          registryFile: stateLayout.registryFile,
          libraryDir: stateLayout.libraryDir,
          bundle: addBundle,
          source: parsed.options.source,
          protocol: parsed.options.protocol,
          agents: parsed.options.agents,
          includeItems: parsed.options.includeItems ?? [],
          selectItems: parsed.options.selectItems ?? false,
          dryRun: parsed.options.dryRun,
          ref: parsed.options.ref,
          inferredBundleFromSource: parsed.options.inferredBundleFromSource,
          disableModelInvocation: parsed.options.disableModelInvocation,
          rootInstructionMode: parsed.options.rootInstructionMode,
        });
      }
      return applyBundle({
        cwd,
        prompts: addPrompts,
        registryFile: stateLayout.registryFile,
        libraryDir: stateLayout.libraryDir,
        bundle: addBundle,
        source: parsed.options.source,
        protocol: parsed.options.protocol,
        agents: parsed.options.agents,
        includeItems: parsed.options.includeItems ?? [],
        selectItems: parsed.options.selectItems ?? false,
        dryRun: parsed.options.dryRun,
        ref: parsed.options.ref,
        inferredBundleFromSource: parsed.options.inferredBundleFromSource,
        disableModelInvocation: parsed.options.disableModelInvocation,
        rootInstructionMode: parsed.options.rootInstructionMode,
      });
    }
    case "list":
      return renderBundleList({
        libraryDir: stateLayout.libraryDir,
        json: parsed.options.json,
        source: parsed.options.source,
      });
    case "status":
      if (parsed.options.global) {
        return renderGlobalStatus({
          registryFile: stateLayout.registryFile,
          json: parsed.options.json,
        });
      }
      return renderStatus({
        cwd,
        registryFile: stateLayout.registryFile,
        json: parsed.options.json,
      });
    case "check":
      return renderUpdateCheck({
        cwd,
        registryFile: stateLayout.registryFile,
        libraryDir: stateLayout.libraryDir,
        bundle: parsed.options.bundle,
        json: parsed.options.json,
      });
    case "update":
      return updateBundles({
        cwd,
        prompts: parsed.options.yes ? createYesPromptClient(prompts) : prompts,
        registryFile: stateLayout.registryFile,
        libraryDir: stateLayout.libraryDir,
        bundle: parsed.options.bundle,
        dryRun: parsed.options.dryRun,
      });
    case "shadow":
      return shadowWorktree({
        cwd,
        registryFile: stateLayout.registryFile,
        action: parsed.options.action,
      });
    case "sync":
      return syncWorktree({
        cwd,
        registryFile: stateLayout.registryFile,
      });
    case "reset":
      if (parsed.options.global) {
        const output = await resetGlobal({
          homeDir: options.homeDir ?? os.homedir(),
          prompts: parsed.options.yes
            ? createYesPromptClient(prompts)
            : prompts,
          registryFile: stateLayout.registryFile,
          dryRun: parsed.options.dryRun,
          warnings: commandWarnings,
        });
        return renderMutatingCommandResult({
          output,
          warnings: commandWarnings,
          json: parsed.options.json ?? false,
        });
      }
      {
        const output = await resetWorktree({
          cwd,
          prompts: parsed.options.yes
            ? createYesPromptClient(prompts)
            : prompts,
          registryFile: stateLayout.registryFile,
          dryRun: parsed.options.dryRun,
          warnings: commandWarnings,
        });
        return renderMutatingCommandResult({
          output,
          warnings: commandWarnings,
          json: parsed.options.json ?? false,
        });
      }
    case "remove":
      if (parsed.options.all) {
        const removePrompts = parsed.options.yes
          ? createYesPromptClient(prompts)
          : prompts;
        const output = parsed.options.global
          ? await removeAllGlobalBundles({
              homeDir: options.homeDir ?? os.homedir(),
              prompts: removePrompts,
              registryFile: stateLayout.registryFile,
              libraryDir: stateLayout.libraryDir,
              source: parsed.options.source,
              dryRun: parsed.options.dryRun,
              warnings: commandWarnings,
            })
          : await removeAllWorktreeBundles({
              cwd,
              prompts: removePrompts,
              registryFile: stateLayout.registryFile,
              libraryDir: stateLayout.libraryDir,
              source: parsed.options.source,
              dryRun: parsed.options.dryRun,
              warnings: commandWarnings,
            });
        return renderMutatingCommandResult({
          output,
          warnings: commandWarnings,
          json: parsed.options.json ?? false,
        });
      }

      if (parsed.options.global) {
        const output = await removeGlobalBundle({
          homeDir: options.homeDir ?? os.homedir(),
          prompts: parsed.options.yes
            ? createYesPromptClient(prompts)
            : prompts,
          registryFile: stateLayout.registryFile,
          libraryDir: stateLayout.libraryDir,
          bundle: parsed.options.bundle,
          source: parsed.options.source,
          includeItems: parsed.options.includeItems ?? [],
          selectItems: parsed.options.selectItems ?? false,
          dryRun: parsed.options.dryRun,
          inferredBundleFromSource: parsed.options.inferredBundleFromSource,
          warnings: commandWarnings,
        });
        return renderMutatingCommandResult({
          output,
          warnings: commandWarnings,
          json: parsed.options.json ?? false,
        });
      }
      {
        const output = await removeBundle({
          cwd,
          prompts: parsed.options.yes
            ? createYesPromptClient(prompts)
            : prompts,
          registryFile: stateLayout.registryFile,
          libraryDir: stateLayout.libraryDir,
          bundle: parsed.options.bundle,
          source: parsed.options.source,
          includeItems: parsed.options.includeItems ?? [],
          selectItems: parsed.options.selectItems ?? false,
          dryRun: parsed.options.dryRun,
          inferredBundleFromSource: parsed.options.inferredBundleFromSource,
          warnings: commandWarnings,
        });
        return renderMutatingCommandResult({
          output,
          warnings: commandWarnings,
          json: parsed.options.json ?? false,
        });
      }
    case "apply":
      if (parsed.options.global) {
        return applyGlobal({
          homeDir: options.homeDir ?? os.homedir(),
          prompts: parsed.options.yes
            ? createYesPromptClient(prompts)
            : prompts,
          registryFile: stateLayout.registryFile,
          libraryDir: stateLayout.libraryDir,
          dryRun: parsed.options.dryRun,
        });
      }
      return applyWorktree({
        cwd,
        prompts: parsed.options.yes ? createYesPromptClient(prompts) : prompts,
        registryFile: stateLayout.registryFile,
        libraryDir: stateLayout.libraryDir,
        dryRun: parsed.options.dryRun,
      });
    default:
      return assertUnreachable(parsed);
  }
}

/**
 * Keeps recovery notices attached to the command result instead of writing
 * them to stderr. Commands that do not provide a collector retain the legacy
 * warning behavior used by internal apply/refresh flows.
 */
function reportCommandWarning(
  message: string,
  warnings?: CommandWarningCollector,
): void {
  if (warnings) {
    warnings.push(message);
    return;
  }

  console.warn(message);
}

/** Renders a mutating command result in text or machine-readable JSON form. */
function renderMutatingCommandResult(options: {
  output: string;
  warnings: CommandWarningCollector;
  json: boolean;
}): string {
  if (options.json) {
    return JSON.stringify(
      {
        output: stripAnsiEscapeCodes(options.output),
        warnings: options.warnings.map(stripAnsiEscapeCodes),
      },
      null,
      2,
    );
  }

  return options.warnings.length > 0
    ? [options.output, ...options.warnings].join("\n")
    : options.output;
}

function stripAnsiEscapeCodes(value: string): string {
  return value.replace(ansiEscapeCodePattern, "");
}

function createYesPromptClient(
  prompts: PromptClient,
  options: { selectAllAgents?: boolean } = {},
): PromptClient {
  return {
    ...prompts,
    ...(options.selectAllAgents
      ? {
          selectAgents: async (availableAgents: ToolName[]) => availableAgents,
        }
      : {}),
    resolveFileConflict: async () => ({ action: "overwrite" }),
    confirmManagedFileRemoval: async () => true,
  };
}

async function applyAllBundles(options: {
  cwd: string;
  homeDir: string;
  prompts: PromptClient;
  registryFile: string;
  libraryDir: string;
  source: string;
  protocol: "https" | "ssh";
  agents: ToolName[];
  dryRun: boolean;
  ref?: string;
  global: boolean;
  disableModelInvocation?: boolean;
  rootInstructionMode?: RootInstructionMode;
}): Promise<string> {
  if (options.dryRun) {
    const { cached } = readCachedSourceRevision({
      source: options.source,
      libraryDir: options.libraryDir,
      protocol: options.protocol,
    });
    if (!cached) {
      return [
        pc.dim(`(would clone ${options.source})`),
        `${pc.yellow("DRY RUN:")} Would apply all bundles from ${options.source}`,
      ].join("\n");
    }

    return renderAllApplyDryRun({
      libraryDir: options.libraryDir,
      source: options.source,
      agents: options.agents,
      global: options.global,
    });
  }

  const refreshedSources = new Set<string>();
  const refreshedSourceUpdates = new Map<string, RefreshedSourceUpdate>();
  const cloneLines = await refreshBundleSourceForApply(
    {
      source: options.source,
      libraryDir: options.libraryDir,
      protocol: options.protocol,
      ref: options.ref,
    },
    refreshedSources,
    refreshedSourceUpdates,
  );
  const bundles = listAllApplyBundles({
    libraryDir: options.libraryDir,
    source: options.source,
    agents: options.agents,
    global: options.global,
  });

  if (bundles.length === 0) {
    const agentLabel =
      options.agents.length > 0
        ? ` supporting ${options.agents.join(", ")}`
        : "";
    throw new Error(`No bundles found for ${options.source}${agentLabel}`);
  }

  const outputLines: string[] = [];
  for (const bundle of bundles) {
    outputLines.push(
      options.global
        ? await applyBundleGlobal({
            homeDir: options.homeDir,
            prompts: options.prompts,
            registryFile: options.registryFile,
            libraryDir: options.libraryDir,
            bundle: bundle.bundle,
            source: bundle.source,
            protocol: options.protocol,
            agents: options.agents,
            includeItems: [],
            selectItems: false,
            dryRun: options.dryRun,
            ref: options.ref,
            refreshedSources,
            refreshedSourceUpdates,
            disableModelInvocation: options.disableModelInvocation,
            rootInstructionMode: options.rootInstructionMode,
          })
        : await applyBundle({
            cwd: options.cwd,
            prompts: options.prompts,
            registryFile: options.registryFile,
            libraryDir: options.libraryDir,
            bundle: bundle.bundle,
            source: bundle.source,
            protocol: options.protocol,
            agents: options.agents,
            includeItems: [],
            selectItems: false,
            dryRun: options.dryRun,
            ref: options.ref,
            refreshedSources,
            refreshedSourceUpdates,
            disableModelInvocation: options.disableModelInvocation,
            rootInstructionMode: options.rootInstructionMode,
          }),
    );
  }

  return [...cloneLines, ...outputLines].filter(Boolean).join("\n");
}

function renderAllApplyDryRun(options: {
  libraryDir: string;
  source: string;
  agents: ToolName[];
  global: boolean;
}): string {
  const bundles = listAllApplyBundles(options);

  if (bundles.length === 0) {
    const agentLabel =
      options.agents.length > 0
        ? ` supporting ${options.agents.join(", ")}`
        : "";
    throw new Error(`No bundles found for ${options.source}${agentLabel}`);
  }

  return bundles
    .map((bundle) => {
      const toolLabel = formatAllApplyDryRunToolLabel({
        bundle,
        agents: options.agents,
        global: options.global,
      });
      const message = options.global
        ? formatApplyGlobalBundleMessage({
            bundle: bundle.bundle,
            toolLabel,
          })
        : formatApplyBundleMessage({
            bundle: bundle.bundle,
            toolLabel,
          });

      return `${pc.yellow("DRY RUN:")} Would ${message}`;
    })
    .join("\n");
}

function formatAllApplyDryRunToolLabel(options: {
  bundle: CachedBundle;
  agents: ToolName[];
  global: boolean;
}): string {
  if (options.agents.length > 0) {
    return options.agents.join(", ");
  }

  const bundleTools = Object.keys(options.bundle.manifest.tools) as ToolName[];
  const toolNames = options.global
    ? bundleTools.filter((toolName) =>
        globalCapableToolNames().includes(toolName),
      )
    : bundleTools;

  return toolNames.join(", ");
}

function listAllApplyBundles(options: {
  libraryDir: string;
  source: string;
  agents: ToolName[];
  global: boolean;
}): CachedBundle[] {
  const globalTools = globalCapableToolNames();

  if (
    options.global &&
    options.agents.some((toolName) => !globalTools.includes(toolName))
  ) {
    throw new Error(
      `Global mode only supports: ${globalTools.join(", ")}. Unsupported: ${options.agents.filter((toolName) => !globalTools.includes(toolName)).join(", ")}`,
    );
  }

  return listCachedBundles({ libraryDir: options.libraryDir })
    .filter((bundle) =>
      isBundleSelectionCandidate({
        bundle,
        source: options.source,
        requestedTools: options.agents,
      }),
    )
    .filter(
      (bundle) =>
        !options.global ||
        Object.keys(bundle.manifest.tools).some((toolName) =>
          globalTools.includes(toolName as ToolName),
        ),
    )
    .sort((left, right) =>
      compareBundleSelections(
        { bundle: left.bundle, source: left.source },
        { bundle: right.bundle, source: right.source },
      ),
    );
}

async function removeAllWorktreeBundles(options: {
  cwd: string;
  prompts: PromptClient;
  registryFile: string;
  libraryDir: string;
  source?: string;
  dryRun: boolean;
  warnings?: CommandWarningCollector;
}): Promise<string> {
  const gitContext = requireGitContext(options.cwd, "remove");
  let registry = readRegistryWithGuidance(options.registryFile);
  const repoState = registry.repos[gitContext.repoFingerprint];
  const selections = listActiveRemoveBundleSelections({
    repoState,
    worktreeState: registry.worktrees[gitContext.worktreeId],
    source: options.source,
  });

  if (selections.length === 0) {
    throw new Error(
      options.source
        ? `No active bundles found for ${options.source}. Run "skul add ${options.source} <bundle>" to add one first`
        : 'No active bundles found. Run "skul add <bundle>" to add one first',
    );
  }

  if (options.dryRun) {
    return selections
      .map((selection) =>
        renderWorktreeRemoveDryRun({
          selection,
          worktreeState: registry.worktrees[gitContext.worktreeId],
        }),
      )
      .join("\n");
  }

  const worktreeState = registry.worktrees[gitContext.worktreeId];
  const selectionKeys = new Set(selections.map(encodeBundleIdentity));
  const materializedTargets = Object.entries(
    worktreeState?.materialized_state.bundles ?? {},
  ).filter(([bundle, bundleState]) =>
    selectionKeys.has(
      encodeBundleIdentity({
        bundle,
        ...(bundleState.source !== undefined
          ? { source: bundleState.source }
          : {}),
      }),
    ),
  );
  const shadowedFilePaths = Object.entries(worktreeState?.shadowed_files ?? {})
    .filter(([, shadowedFile]) =>
      selections.some((selection) => selection.bundle === shadowedFile.bundle),
    )
    .map(([filePath]) => filePath);
  const removedBundlePaths = mergeManagedRemovalPaths(
    materializedTargets.map(([, bundleState]) =>
      flattenBundleState(bundleState),
    ),
  );
  const mcpOwnership = createMcpMaterializationOwnership(
    worktreeState?.materialized_state,
  );
  const removedRootInstructionPaths = new Set(
    removedBundlePaths.files.filter((filePath) =>
      isRootInstructionPath(filePath),
    ),
  );
  const remainingBundles = {
    ...(worktreeState?.materialized_state.bundles ?? {}),
  };

  for (const [bundle] of materializedTargets) {
    delete remainingBundles[bundle];
  }

  const remainingDesiredState =
    repoState?.desired_state.filter(
      (entry) => !selectionKeys.has(encodeBundleIdentity(entry)),
    ) ?? [];
  const rewrittenRootInstructionPaths = new Set(
    Array.from(collectManagedRootInstructionTargets(remainingBundles)).filter(
      (filePath) => removedRootInstructionPaths.has(filePath),
    ),
  );

  assertManagedRootInstructionSyncSourcesCached({
    desiredState: remainingDesiredState,
    materializedBundles: remainingBundles,
    targetPaths: rewrittenRootInstructionPaths,
    resolveCachedBundle: (entry) =>
      resolveDesiredCachedBundle(options.libraryDir, entry),
  });

  if (removedBundlePaths.files.length > 0 || shadowedFilePaths.length > 0) {
    const removeAllowed = await confirmManagedFileRemovals(
      gitContext.worktreeRoot,
      removedBundlePaths,
      options.prompts,
      "remove",
    );

    if (!removeAllowed) {
      throw new Error(
        "Removal aborted because a modified managed file was kept",
      );
    }
  }

  let currentShadowedFiles = { ...(worktreeState?.shadowed_files ?? {}) };
  currentShadowedFiles = retireTrackedShadows({
    repoRoot: gitContext.worktreeRoot,
    shadowedFiles: currentShadowedFiles,
    filePaths: shadowedFilePaths,
  });

  if (Object.keys(remainingBundles).length > 0) {
    assertTrackedRootInstructionShadowSafetyForPaths({
      repoRoot: gitContext.worktreeRoot,
      operation: "refresh",
      filePaths: Array.from(rewrittenRootInstructionPaths),
    });
  }

  const remainingRootInstructionRefs =
    Object.keys(remainingBundles).length > 0
      ? await resolveMaterializedBundleItemRefsByBundle({
          desiredState: remainingDesiredState,
          materializedBundles: remainingBundles,
          libraryDir: options.libraryDir,
          itemSelectors: ["root-instruction"],
        })
      : undefined;

  const removalResult = removeManagedPaths(
    gitContext.worktreeRoot,
    removedBundlePaths,
    {
      restoreCommitted: true,
      mcpOwnership,
      warnings: options.warnings,
    },
  );
  const failedBundleStates = retainFailedMcpBundleStates(
    Object.fromEntries(materializedTargets),
    removalResult.failedMcpServers,
  );
  const rootInstructionBaseContents =
    worktreeState?.materialized_state.root_instruction_base_contents;
  const remainingRootInstructionTargets =
    collectManagedRootInstructionTargets(remainingBundles);
  const restoredRootInstructionPaths = new Set(
    Array.from(removedRootInstructionPaths).filter(
      (filePath) => !remainingRootInstructionTargets.has(filePath),
    ),
  );
  restoreRootInstructionBaseContents({
    repoRoot: gitContext.worktreeRoot,
    baseContents: rootInstructionBaseContents,
    targetPaths: restoredRootInstructionPaths,
  });
  const nextRootInstructionBaseContents = rootInstructionBaseContents
    ? Object.fromEntries(
        Object.entries(rootInstructionBaseContents).filter(
          ([filePath]) => !restoredRootInstructionPaths.has(filePath),
        ),
      )
    : undefined;

  if (Object.keys(remainingBundles).length > 0) {
    const syncedRootInstructionPaths = syncManagedRootInstructionFiles({
      repoRoot: gitContext.worktreeRoot,
      desiredState: remainingDesiredState,
      materializedBundles: remainingBundles,
      rootInstructionBaseContents: nextRootInstructionBaseContents,
      targetPaths: rewrittenRootInstructionPaths,
      resolveCachedBundle: (entry) =>
        resolveDesiredCachedBundle(options.libraryDir, entry),
      resolvedBundleItemRefsByBundle: remainingRootInstructionRefs,
    });
    const refreshedRemainingBundles = refreshManagedFileFingerprintsForPaths(
      gitContext.worktreeRoot,
      remainingBundles,
      syncedRootInstructionPaths,
    );
    const newMatState: MaterializedState = {
      bundles: { ...refreshedRemainingBundles, ...failedBundleStates },
      exclude_configured: false,
      ...mcpOwnership.toRegistryFields(),
      ...(nextRootInstructionBaseContents !== undefined &&
      Object.keys(nextRootInstructionBaseContents).length > 0
        ? { root_instruction_base_contents: nextRootInstructionBaseContents }
        : {}),
    };
    const managedFiles = collectExcludedPaths(newMatState);
    newMatState.exclude_configured = managedFiles.length > 0;

    if (managedFiles.length > 0) {
      configureSkulExcludeBlock({
        gitDir: gitContext.gitDir,
        files: managedFiles,
      });
    } else {
      removeSkulExcludeBlock({ gitDir: gitContext.gitDir });
    }

    registry = upsertWorktreeState(registry, gitContext.worktreeId, {
      repo_fingerprint: gitContext.repoFingerprint,
      path: gitContext.worktreeRoot,
      materialized_state: newMatState,
      shadowed_files: currentShadowedFiles,
    });
  } else {
    if (
      Object.keys(currentShadowedFiles).length > 0 ||
      Object.keys(failedBundleStates).length > 0
    ) {
      const retainedBundles = failedBundleStates;
      const retainedMaterializedState: MaterializedState = {
        bundles: retainedBundles,
        exclude_configured: false,
        ...mcpOwnership.toRegistryFields(),
        ...(worktreeState.materialized_state.root_instruction_base_contents !==
        undefined
          ? {
              root_instruction_base_contents:
                worktreeState.materialized_state.root_instruction_base_contents,
            }
          : {}),
      };
      const retainedManagedFiles = collectExcludedPaths(
        retainedMaterializedState,
      );
      retainedMaterializedState.exclude_configured =
        retainedManagedFiles.length > 0;
      if (retainedManagedFiles.length > 0) {
        configureSkulExcludeBlock({
          gitDir: gitContext.gitDir,
          files: retainedManagedFiles,
        });
      } else {
        removeSkulExcludeBlock({ gitDir: gitContext.gitDir });
      }
      registry = upsertWorktreeState(registry, gitContext.worktreeId, {
        repo_fingerprint: gitContext.repoFingerprint,
        path: gitContext.worktreeRoot,
        materialized_state: retainedMaterializedState,
        shadowed_files: currentShadowedFiles,
      });
    } else {
      removeSkulExcludeBlock({ gitDir: gitContext.gitDir });
      registry = removeWorktreeState(registry, gitContext.worktreeId);
    }
  }

  if (repoState) {
    registry = upsertRepoState(registry, gitContext.repoFingerprint, {
      ...repoState,
      repo_root: gitContext.repoRoot,
      desired_state: remainingDesiredState,
    });
  }

  writeRegistryFile(options.registryFile, registry);

  return selections
    .map((selection) => `Removed ${selection.bundle}`)
    .join("\n");
}

function renderWorktreeRemoveDryRun(options: {
  selection: BundleSelection;
  worktreeState?: WorktreeState;
}): string {
  const bundleMaterializedState = findMaterializedBundleState({
    worktreeState: options.worktreeState,
    bundle: options.selection.bundle,
    source: options.selection.source,
  });
  const shadowedFilesForBundle = Object.entries(
    options.worktreeState?.shadowed_files ?? {},
  ).filter(
    ([, shadowedFile]) => shadowedFile.bundle === options.selection.bundle,
  );

  return renderRemoveDryRun({
    bundle: options.selection.bundle,
    prefix: "",
    materializedState: bundleMaterializedState,
    extraFiles: shadowedFilesForBundle.map(([filePath]) => filePath),
    desiredStateLabel: "desired state",
  });
}

/**
 * Everything one removal needs to undo.
 *
 * `mcp_servers` is not optional: MCP configuration files are shared with the
 * user and with other bundles, and a caller that rebuilt this state without the
 * field would fall through to deleting a whole file it does not own.
 */
type ManagedRemovalState = {
  files: string[];
  file_fingerprints?: Record<string, string>;
  directories?: string[];
  mcp_servers: ManagedMcpOwnership[];
};

/**
 * The servers one bundle put into one tool's MCP configuration file.
 *
 * The tool travels with the path because subtracting the servers again needs
 * the dialect of the file, not its location. Recording only the path would mean
 * recovering the tool by matching that path against every tool's layout, and
 * the caller would then have to say which layout the path came from.
 */
type ManagedMcpOwnership = {
  tool: ToolName;
  path: string;
  servers: string[];
};

/** Unions MCP server ownership across several bundles or tools. */
function mergeMcpServerOwnership(
  ownerships: Array<ManagedMcpOwnership[] | undefined>,
): ManagedMcpOwnership[] {
  const merged = new Map<string, ManagedMcpOwnership>();

  for (const ownership of ownerships ?? []) {
    for (const entry of ownership ?? []) {
      const key = `${entry.tool}\u0000${entry.path}`;
      const existing = merged.get(key);

      merged.set(key, {
        tool: entry.tool,
        path: entry.path,
        servers: [...new Set([...(existing?.servers ?? []), ...entry.servers])],
      });
    }
  }

  return Array.from(merged.values());
}

function mergeManagedRemovalPaths(
  states: ManagedRemovalState[],
): ManagedRemovalState {
  return {
    files: Array.from(new Set(states.flatMap((state) => state.files))),
    file_fingerprints: Object.assign(
      {},
      ...states.map((state) => state.file_fingerprints ?? {}),
    ),
    directories: Array.from(
      new Set(states.flatMap((state) => state.directories ?? [])),
    ),
    mcp_servers: mergeMcpServerOwnership(
      states.map((state) => state.mcp_servers),
    ),
  };
}

async function removeAllGlobalBundles(options: {
  homeDir: string;
  prompts: PromptClient;
  registryFile: string;
  libraryDir: string;
  source?: string;
  dryRun: boolean;
  warnings?: CommandWarningCollector;
}): Promise<string> {
  let registry = readRegistryWithGuidance(options.registryFile);
  const selections = listActiveGlobalRemoveBundleSelections({
    globalState: registry.global,
    source: options.source,
  });

  if (selections.length === 0) {
    throw new Error(
      options.source
        ? `No active global bundles found for ${options.source}. Run "skul add --global ${options.source} <bundle>" to add one first`
        : 'No active global bundles found. Run "skul add --global <bundle>" to add one first',
    );
  }

  if (options.dryRun) {
    return selections
      .map((selection) =>
        renderGlobalRemoveDryRun({
          selection,
          globalState: registry.global,
        }),
      )
      .join("\n");
  }

  const globalState = registry.global;
  const selectionKeys = new Set(selections.map(encodeBundleIdentity));
  const materializedTargets = Object.entries(
    globalState?.materialized_state.bundles ?? {},
  ).filter(([bundle, bundleState]) =>
    selectionKeys.has(
      encodeBundleIdentity({
        bundle,
        ...(bundleState.source !== undefined
          ? { source: bundleState.source }
          : {}),
      }),
    ),
  );
  const removedBundlePaths = mergeManagedRemovalPaths(
    materializedTargets.map(([, bundleState]) =>
      flattenBundleState(bundleState),
    ),
  );
  const mcpOwnership = createMcpMaterializationOwnership(
    globalState?.materialized_state,
  );
  const removedRootInstructionPaths = new Set(
    removedBundlePaths.files.filter((filePath) =>
      isRootInstructionPath(filePath),
    ),
  );
  const remainingBundles = {
    ...(globalState?.materialized_state.bundles ?? {}),
  };

  for (const [bundle] of materializedTargets) {
    delete remainingBundles[bundle];
  }

  const remainingDesiredState =
    globalState?.desired_state.filter(
      (entry) => !selectionKeys.has(encodeBundleIdentity(entry)),
    ) ?? [];
  const rewrittenRootInstructionPaths = new Set(
    Array.from(collectManagedRootInstructionTargets(remainingBundles)).filter(
      (filePath) => removedRootInstructionPaths.has(filePath),
    ),
  );

  assertManagedRootInstructionSyncSourcesCached({
    desiredState: remainingDesiredState,
    materializedBundles: remainingBundles,
    targetPaths: rewrittenRootInstructionPaths,
    resolveCachedBundle: (entry) =>
      resolveDesiredCachedBundle(options.libraryDir, entry),
  });

  if (removedBundlePaths.files.length > 0) {
    const removeAllowed = await confirmManagedFileRemovals(
      options.homeDir,
      removedBundlePaths,
      options.prompts,
      "remove",
    );
    if (!removeAllowed) {
      throw new Error(
        "Removal aborted because a modified managed file was kept",
      );
    }
  }

  const remainingRootInstructionRefs =
    Object.keys(remainingBundles).length > 0
      ? await resolveMaterializedBundleItemRefsByBundle({
          desiredState: remainingDesiredState,
          materializedBundles: remainingBundles,
          libraryDir: options.libraryDir,
          itemSelectors: ["root-instruction"],
        })
      : undefined;

  const removalResult = removeManagedPaths(
    options.homeDir,
    removedBundlePaths,
    {
      restoreCommitted: false,
      mcpOwnership,
      warnings: options.warnings,
    },
  );
  const failedBundleStates = retainFailedMcpBundleStates(
    Object.fromEntries(materializedTargets),
    removalResult.failedMcpServers,
  );

  const rootInstructionBaseContents =
    globalState?.materialized_state.root_instruction_base_contents;
  const remainingRootInstructionTargets =
    collectManagedRootInstructionTargets(remainingBundles);
  const restoredRootInstructionPaths = new Set(
    Array.from(removedRootInstructionPaths).filter(
      (filePath) => !remainingRootInstructionTargets.has(filePath),
    ),
  );
  restoreRootInstructionBaseContents({
    repoRoot: options.homeDir,
    baseContents: rootInstructionBaseContents,
    targetPaths: restoredRootInstructionPaths,
  });
  const nextRootInstructionBaseContents = rootInstructionBaseContents
    ? Object.fromEntries(
        Object.entries(rootInstructionBaseContents).filter(
          ([filePath]) => !restoredRootInstructionPaths.has(filePath),
        ),
      )
    : undefined;

  if (
    Object.keys(remainingBundles).length > 0 ||
    remainingDesiredState.length > 0
  ) {
    if (Object.keys(remainingBundles).length > 0) {
      const syncedRootInstructionPaths = syncManagedRootInstructionFiles({
        repoRoot: options.homeDir,
        desiredState: remainingDesiredState,
        materializedBundles: remainingBundles,
        rootInstructionBaseContents: nextRootInstructionBaseContents,
        targetPaths: rewrittenRootInstructionPaths,
        resolveCachedBundle: (entry) =>
          resolveDesiredCachedBundle(options.libraryDir, entry),
        repoRelPathRemapper:
          GLOBAL_TOOL_MATERIALIZATION_LAYOUT.remapRepoRelPath,
        resolvedBundleItemRefsByBundle: remainingRootInstructionRefs,
      });
      const refreshedBundles = refreshManagedFileFingerprintsForPaths(
        options.homeDir,
        remainingBundles,
        syncedRootInstructionPaths,
      );
      registry = upsertGlobalState(registry, {
        desired_state: remainingDesiredState,
        materialized_state: {
          bundles: { ...refreshedBundles, ...failedBundleStates },
          ...mcpOwnership.toRegistryFields(),
          ...(nextRootInstructionBaseContents !== undefined &&
          Object.keys(nextRootInstructionBaseContents).length > 0
            ? {
                root_instruction_base_contents: nextRootInstructionBaseContents,
              }
            : {}),
        },
      });
    } else {
      registry = upsertGlobalState(registry, {
        desired_state: remainingDesiredState,
        materialized_state: {
          bundles: failedBundleStates,
          ...mcpOwnership.toRegistryFields(),
        },
      });
    }
  } else if (Object.keys(failedBundleStates).length > 0) {
    registry = upsertGlobalState(registry, {
      desired_state: remainingDesiredState,
      materialized_state: {
        bundles: failedBundleStates,
        ...mcpOwnership.toRegistryFields(),
      },
    });
  } else {
    registry = { ...registry, global: undefined };
  }

  writeRegistryFile(options.registryFile, registry);

  return selections
    .map((selection) => `Removed global ${selection.bundle}`)
    .join("\n");
}

function renderGlobalRemoveDryRun(options: {
  selection: BundleSelection;
  globalState?: GlobalState;
}): string {
  const bundleMaterializedState = findGlobalMaterializedBundleState({
    globalState: options.globalState,
    bundle: options.selection.bundle,
    source: options.selection.source,
  });

  return renderRemoveDryRun({
    bundle: options.selection.bundle,
    prefix: "global ",
    materializedState: bundleMaterializedState,
    extraFiles: [],
    desiredStateLabel: "global desired state",
  });
}

function renderRemoveDryRun(options: {
  bundle: string;
  prefix: string;
  materializedState?: MaterializedBundleState;
  extraFiles: string[];
  desiredStateLabel: string;
}): string {
  if (options.materializedState || options.extraFiles.length > 0) {
    const materializedFiles = options.materializedState
      ? flattenBundleState(options.materializedState)
      : undefined;
    const files = Array.from(
      new Set([
        ...(materializedFiles?.files ?? []),
        ...(materializedFiles?.mcp_servers.map(
          ({ path: filePath }) => filePath,
        ) ?? []),
        ...options.extraFiles,
      ]),
    );
    const lines = [
      `${pc.yellow("DRY RUN:")} Would remove ${options.prefix}${options.bundle} (${files.length} file(s))`,
    ];

    for (const file of files) {
      lines.push(`  ${file}`);
    }

    return lines.join("\n");
  }

  return `${pc.yellow("DRY RUN:")} Would remove ${options.bundle} from ${options.desiredStateLabel}`;
}

function shadowWorktree(options: {
  cwd: string;
  registryFile: string;
  action: "suspend" | "refresh";
}): string {
  const gitContext = requireGitContext(options.cwd, "shadow");
  let registry = readRegistryWithGuidance(options.registryFile);
  const worktreeState = registry.worktrees[gitContext.worktreeId];
  const shadowedFiles = worktreeState?.shadowed_files ?? {};
  const shadowedFilePaths = Object.keys(shadowedFiles);

  if (shadowedFilePaths.length === 0) {
    return "No tracked shadows found in the current worktree";
  }

  const nextShadowedFiles =
    options.action === "suspend"
      ? suspendTrackedShadows({
          repoRoot: gitContext.worktreeRoot,
          shadowedFiles,
        })
      : refreshTrackedShadows({
          repoRoot: gitContext.worktreeRoot,
          shadowedFiles,
        });

  registry = upsertWorktreeState(registry, gitContext.worktreeId, {
    repo_fingerprint: worktreeState!.repo_fingerprint,
    path: gitContext.worktreeRoot,
    materialized_state: worktreeState!.materialized_state,
    shadowed_files: nextShadowedFiles,
  });
  writeRegistryFile(options.registryFile, registry);

  const actionLabel = options.action === "suspend" ? "Suspended" : "Refreshed";
  return `${actionLabel} tracked shadows for ${shadowedFilePaths.sort().join(", ")}`;
}

function syncWorktree(options: { cwd: string; registryFile: string }): string {
  const gitContext = requireGitContext(options.cwd, "sync");
  let registry = readRegistryWithGuidance(options.registryFile);
  const worktreeState = registry.worktrees[gitContext.worktreeId];
  const shadowedFilePaths = Object.keys(
    worktreeState?.shadowed_files ?? {},
  ).sort();
  let currentShadowedFiles = { ...(worktreeState?.shadowed_files ?? {}) };

  if (worktreeState && shadowedFilePaths.length > 0) {
    currentShadowedFiles = suspendTrackedShadows({
      repoRoot: gitContext.worktreeRoot,
      shadowedFiles: currentShadowedFiles,
    });
    registry = writeShadowedFilesForWorktree({
      registry,
      registryFile: options.registryFile,
      worktreeId: gitContext.worktreeId,
      worktreeState,
      shadowedFiles: currentShadowedFiles,
    });
  }

  let syncResult: GitSyncResult | null = null;
  let syncError: Error | null = null;

  try {
    syncResult = runGitPullWithFastForward(gitContext.worktreeRoot);
  } catch (error) {
    syncError = normalizeGitCommandError(
      "sync the current branch with git pull --ff-only",
      error,
    );
  }

  if (worktreeState && shadowedFilePaths.length > 0) {
    try {
      currentShadowedFiles = refreshTrackedShadowsAfterSync({
        repoRoot: gitContext.worktreeRoot,
        shadowedFiles: currentShadowedFiles,
      });
      writeShadowedFilesForWorktree({
        registry,
        registryFile: options.registryFile,
        worktreeId: gitContext.worktreeId,
        worktreeState,
        shadowedFiles: currentShadowedFiles,
      });
    } catch (error) {
      if (syncError) {
        throw new Error(
          `${syncError.message}\nSkul also failed to restore tracked shadows: ${describeError(error)}`,
        );
      }

      throw error;
    }
  }

  if (syncError) {
    throw syncError;
  }

  return renderSyncWorktreeResult({
    syncResult: syncResult!,
    shadowRefreshResult: buildShadowRefreshResult({
      initialShadowedFilePaths: shadowedFilePaths,
      currentShadowedFiles,
    }),
  });
}

function refreshTrackedShadowsAfterSync(options: {
  repoRoot: string;
  shadowedFiles: Record<string, ShadowedFileState>;
}): Record<string, ShadowedFileState> {
  const refreshableShadowedFiles: Record<string, ShadowedFileState> = {};

  for (const [filePath, shadowedFile] of Object.entries(
    options.shadowedFiles,
  )) {
    const inspection = inspectTrackedShadowTarget({
      repoRoot: options.repoRoot,
      filePath,
    });

    if (!inspection.headBlob) {
      fs.rmSync(path.join(options.repoRoot, filePath), { force: true });
      continue;
    }

    refreshableShadowedFiles[filePath] = shadowedFile;
  }

  if (Object.keys(refreshableShadowedFiles).length === 0) {
    return {};
  }

  return refreshTrackedShadows({
    repoRoot: options.repoRoot,
    shadowedFiles: refreshableShadowedFiles,
  });
}

function writeShadowedFilesForWorktree(options: {
  registry: ReturnType<typeof readRegistryWithGuidance>;
  registryFile: string;
  worktreeId: string;
  worktreeState: NonNullable<
    ReturnType<typeof readRegistryWithGuidance>["worktrees"][string]
  >;
  shadowedFiles: Record<string, ShadowedFileState>;
}) {
  const nextRegistry = upsertWorktreeState(
    options.registry,
    options.worktreeId,
    {
      repo_fingerprint: options.worktreeState.repo_fingerprint,
      path: options.worktreeState.path,
      materialized_state: options.worktreeState.materialized_state,
      shadowed_files: options.shadowedFiles,
    },
  );
  writeRegistryFile(options.registryFile, nextRegistry);
  return nextRegistry;
}

interface GitSyncResult {
  previousHead: string;
  currentHead: string;
}

interface ShadowRefreshResult {
  refreshedFilePaths: string[];
  retiredFilePaths: string[];
}

function buildShadowRefreshResult(options: {
  initialShadowedFilePaths: string[];
  currentShadowedFiles: Record<string, ShadowedFileState>;
}): ShadowRefreshResult {
  const refreshedFilePaths = Object.keys(options.currentShadowedFiles).sort();

  return {
    refreshedFilePaths,
    retiredFilePaths: options.initialShadowedFilePaths
      .filter((filePath) => !refreshedFilePaths.includes(filePath))
      .sort(),
  };
}

function runGitPullWithFastForward(repoRoot: string): GitSyncResult {
  const previousHead = runGitForOutput(repoRoot, ["rev-parse", "HEAD"]).trim();
  runGitForOutput(repoRoot, ["pull", "--ff-only"]);
  const currentHead = runGitForOutput(repoRoot, ["rev-parse", "HEAD"]).trim();

  return {
    previousHead,
    currentHead,
  };
}

function runGitForOutput(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function normalizeGitCommandError(action: string, error: unknown): Error {
  return new Error(`Failed to ${action}: ${describeGitCommandFailure(error)}`);
}

function describeGitCommandFailure(error: unknown): string {
  if (
    error instanceof Error &&
    "stderr" in error &&
    typeof error.stderr === "string"
  ) {
    const stderr = error.stderr.trim();

    if (stderr.length > 0) {
      return stderr;
    }
  }

  return describeError(error);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderSyncWorktreeResult(options: {
  syncResult: GitSyncResult;
  shadowRefreshResult: ShadowRefreshResult;
}): string {
  const syncMessage =
    options.syncResult.previousHead === options.syncResult.currentHead
      ? "Git already up to date"
      : `Synced git worktree ${options.syncResult.previousHead.slice(0, 7)} -> ${options.syncResult.currentHead.slice(0, 7)}`;

  const detailMessages: string[] = [];

  if (options.shadowRefreshResult.refreshedFilePaths.length > 0) {
    detailMessages.push(
      `refreshed tracked shadows for ${options.shadowRefreshResult.refreshedFilePaths.join(", ")}`,
    );
  }

  if (options.shadowRefreshResult.retiredFilePaths.length > 0) {
    detailMessages.push(
      `retired tracked shadows for ${options.shadowRefreshResult.retiredFilePaths.join(", ")} because upstream no longer tracks them`,
    );
  }

  if (detailMessages.length === 0) {
    return syncMessage;
  }

  return `${syncMessage}; ${detailMessages.join("; ")}`;
}

/**
 * Renders one tracked shadow, whichever kind it is.
 *
 * Root instructions compose text; MCP configuration folds stored server entries
 * into the committed document. Both produce the same rendered/fingerprint shape
 * so the shadow lifecycle — suspend, refresh, retire — stays common to them.
 */
function renderTrackedShadow(options: {
  baseContent: string;
  overlay: string;
  bundleName: string;
  toolName: ToolName;
  strategy: ShadowStrategy;
  allowReplace?: boolean;
  filePath?: string;
}): {
  rendered: string;
  overlayFingerprint: string;
  renderedFingerprint: string;
} {
  if (options.strategy !== "merge") {
    const render = renderTrackedRootInstructionShadow({
      baseContent: options.baseContent,
      overlayContent: options.overlay,
      bundleName: options.bundleName,
      toolName: options.toolName,
      strategy: options.strategy,
      ...(options.allowReplace !== undefined
        ? { allowReplace: options.allowReplace }
        : {}),
    });

    return {
      rendered: render.rendered,
      overlayFingerprint: render.overlayFingerprint,
      renderedFingerprint: render.renderedFingerprint,
    };
  }

  const renderedServers = JSON.parse(options.overlay) as RenderedMcpServers;
  const merged = mergeRenderedMcpServers({
    toolName: options.toolName,
    renderedServers,
    existingContent: options.baseContent,
    // The base here is committed content, which may already declare the very
    // servers this shadow replays — that is this bundle's own earlier work
    // being folded onto a new base, not a collision with someone else's.
    ownedServerNames: Object.keys(renderedServers),
    ...(options.filePath !== undefined ? { configPath: options.filePath } : {}),
  });

  return {
    rendered: merged.content,
    overlayFingerprint: fingerprintShadowContent(options.overlay),
    renderedFingerprint: fingerprintShadowContent(merged.content),
  };
}

function suspendTrackedShadows(options: {
  repoRoot: string;
  shadowedFiles: Record<string, ShadowedFileState>;
}): Record<string, ShadowedFileState> {
  const plans = Object.entries(options.shadowedFiles)
    .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
    .map(([filePath, shadowedFile]) => {
      assertTrackedShadowSafetyForAction({
        repoRoot: options.repoRoot,
        filePath,
        action: "suspend",
      });

      if (shadowedFile.skip_worktree) {
        assertTrackedShadowPristine({
          repoRoot: options.repoRoot,
          filePath,
          shadowedFile,
          action: "suspend",
        });
      }

      return { filePath, shadowedFile };
    });

  for (const plan of plans) {
    restoreTrackedShadowTarget({
      repoRoot: options.repoRoot,
      filePath: plan.filePath,
    });
  }

  return Object.fromEntries(
    plans.map(({ filePath, shadowedFile }) => [
      filePath,
      {
        ...shadowedFile,
        skip_worktree: false,
      },
    ]),
  );
}

function refreshTrackedShadows(options: {
  repoRoot: string;
  shadowedFiles: Record<string, ShadowedFileState>;
}): Record<string, ShadowedFileState> {
  const plans = Object.entries(options.shadowedFiles)
    .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
    .map(([filePath, shadowedFile]) => {
      assertTrackedShadowSafetyForAction({
        repoRoot: options.repoRoot,
        filePath,
        action: "refresh",
      });

      if (shadowedFile.skip_worktree) {
        assertTrackedShadowPristine({
          repoRoot: options.repoRoot,
          filePath,
          shadowedFile,
          action: "refresh",
        });
      }

      const headBlob = requireTrackedShadowHeadBlob({
        repoRoot: options.repoRoot,
        filePath,
        action: "refresh",
      });
      const render = renderTrackedShadow({
        baseContent: headBlob.content,
        overlay: shadowedFile.overlay,
        bundleName: shadowedFile.bundle,
        toolName: shadowedFile.tool,
        strategy: shadowedFile.strategy,
        allowReplace: true,
      });

      return { filePath, shadowedFile, headBlob, render };
    });

  for (const plan of plans) {
    const targetPath = path.join(options.repoRoot, plan.filePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, plan.render.rendered);
    setGitSkipWorktree({ repoRoot: options.repoRoot, filePath: plan.filePath });
  }

  return Object.fromEntries(
    plans.map(({ filePath, shadowedFile, headBlob, render }) => [
      filePath,
      {
        ...shadowedFile,
        base_blob: headBlob.objectId,
        overlay: shadowedFile.overlay,
        overlay_fingerprint: render.overlayFingerprint,
        rendered_fingerprint: render.renderedFingerprint,
        skip_worktree: true,
      },
    ]),
  );
}

function requireTrackedShadowHeadBlob(options: {
  repoRoot: string;
  filePath: string;
  action: "create" | "refresh" | "suspend";
}) {
  const inspection = inspectTrackedShadowTarget({
    repoRoot: options.repoRoot,
    filePath: options.filePath,
  });

  if (inspection.headBlob) {
    return inspection.headBlob;
  }

  throw new Error(
    `Cannot ${options.action} tracked shadow for ${options.filePath} because the target does not have HEAD content`,
  );
}

function assertTrackedShadowPristine(options: {
  repoRoot: string;
  filePath: string;
  shadowedFile: ShadowedFileState;
  action: "refresh" | "suspend";
}): void {
  const targetPath = path.join(options.repoRoot, options.filePath);

  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
    return;
  }

  if (
    fingerprintFile(targetPath) === options.shadowedFile.rendered_fingerprint
  ) {
    return;
  }

  throw new Error(
    `Cannot ${options.action} tracked shadow for ${options.filePath} because the shadow file has local manual edits`,
  );
}

function createDefaultPromptClient(libraryDir: string): PromptClient {
  if (isHeadlessMode()) {
    return createHeadlessPromptClient();
  }

  const promptClient = createPromptClientForSelections([]);
  return {
    async selectBundle(
      source?: string,
      requestedTools?: ToolName[],
    ): Promise<BundleSelection> {
      const availableBundles = listCachedBundles({ libraryDir })
        .filter((bundle) =>
          isBundleSelectionCandidate({ bundle, source, requestedTools }),
        )
        .map((bundle) =>
          buildBundleSelection(bundle.source, bundle.bundle, libraryDir),
        )
        .sort(compareBundleSelections);

      if (availableBundles.length === 0 && requestedTools?.length) {
        throw new Error(
          `No bundles cached${source ? ` for ${source}` : ""} support selected agent(s): ${requestedTools.join(", ")}`,
        );
      }

      return createPromptClientForSelections(availableBundles).selectBundle(
        source,
      );
    },
    selectBundleItems: promptClient.selectBundleItems,
    selectBundleItemChoices: promptClient.selectBundleItemChoices,
    selectBundleFromSelections: promptClient.selectBundleFromSelections,
    selectAgents: promptClient.selectAgents,
    resolveFileConflict: promptClient.resolveFileConflict,
    confirmManagedFileRemoval: promptClient.confirmManagedFileRemoval,
  };
}

function isBundleSelectionCandidate(options: {
  bundle: CachedBundle;
  source?: string;
  requestedTools?: ToolName[];
}): boolean {
  if (
    options.source !== undefined &&
    options.bundle.source !== options.source
  ) {
    return false;
  }

  if (!options.requestedTools?.length) {
    return true;
  }

  const availableTools = Object.keys(options.bundle.manifest.tools);
  return options.requestedTools.every((toolName) =>
    availableTools.includes(toolName),
  );
}

function buildBundleSelection(
  source: string,
  bundle: string,
  libraryDir: string,
): BundleSelection {
  const revision = readCachedSourceRevision({ source, libraryDir });
  const protocol = revision.remoteUrl
    ? detectSourceProtocol(revision.remoteUrl)
    : "https";

  return {
    bundle,
    source,
    protocol,
  };
}

function compareBundleSelections(
  left: BundleSelection,
  right: BundleSelection,
): number {
  const bundleNameComparison = left.bundle.localeCompare(right.bundle);

  if (bundleNameComparison !== 0) {
    return bundleNameComparison;
  }

  return (left.source ?? "").localeCompare(right.source ?? "");
}

function renderBundleList(options: {
  libraryDir: string;
  json: boolean;
  source?: string;
}): string {
  const bundles = listCachedBundles({ libraryDir: options.libraryDir }).filter(
    (bundle) =>
      options.source === undefined || bundle.source === options.source,
  );

  if (options.json) {
    return JSON.stringify(
      {
        bundles: bundles.map((bundle) => ({
          name: bundle.bundle,
          source: bundle.source,
          tools: Object.keys(bundle.manifest.tools),
        })),
      },
      null,
      2,
    );
  }

  if (bundles.length === 0) {
    return [
      pc.bold("Available Bundles"),
      "",
      options.source !== undefined
        ? `No cached bundles found for ${options.source}.`
        : "No cached bundles found.",
      "",
      options.source === undefined
        ? pc.dim(
            "Add one with: skul add github.com/<owner>/<repo> <bundle-name>",
          )
        : pc.dim(`Cache one with: skul add ${options.source} <bundle-name>`),
    ].join("\n");
  }

  return [
    pc.bold("Available Bundles"),
    "",
    ...bundles.map((bundle) => {
      const tools = Object.keys(bundle.manifest.tools).join(", ");
      return `${pc.cyan(bundle.bundle)} [${bundle.source}] ${pc.dim(`(${tools})`)}`;
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
  const hasMaterializedBundles = worktreeState
    ? worktreeHasMaterializedBundles(worktreeState.materialized_state)
    : false;
  const shadowedInstructionStatuses = collectShadowedInstructionStatuses({
    repoRoot: gitContext.worktreeRoot,
    shadowedFiles: worktreeState?.shadowed_files ?? {},
  });

  if (options.json) {
    const desiredState = repoState?.desired_state ?? [];
    const worktreeData = worktreeState
      ? {
          path: gitContext.worktreeRoot,
          materialized: hasMaterializedBundles,
          bundles: Object.fromEntries(
            Object.entries(worktreeState.materialized_state.bundles).map(
              ([bundleName, bundleState]) => [
                bundleName,
                {
                  tools: Object.fromEntries(
                    Object.entries(bundleState.tools).map(
                      ([toolName, toolState]) => [
                        toolName,
                        { files: toolState.files },
                      ],
                    ),
                  ),
                },
              ],
            ),
          ),
          shadowed_files: buildShadowedFilesJson(shadowedInstructionStatuses),
          git_exclude_configured: hasSkulExcludeBlock({
            gitDir: gitContext.gitDir,
          }),
        }
      : {
          path: gitContext.worktreeRoot,
          materialized: false,
          bundles: {},
          shadowed_files: buildShadowedFilesJson(shadowedInstructionStatuses),
          git_exclude_configured: hasSkulExcludeBlock({
            gitDir: gitContext.gitDir,
          }),
        };

    const suggestedAction =
      !hasMaterializedBundles && repoState && repoState.desired_state.length > 0
        ? "skul apply"
        : null;

    return JSON.stringify(
      {
        repo: { desired_state: desiredState },
        worktree: worktreeData,
        ...(suggestedAction !== null
          ? { suggested_action: suggestedAction }
          : {}),
      },
      null,
      2,
    );
  }

  const lines: string[] = [pc.bold("Repository Desired State")];

  if (repoState && repoState.desired_state.length > 0) {
    for (const entry of repoState.desired_state) {
      const toolSuffix = entry.tools ? ` (${entry.tools.join(", ")})` : "";
      lines.push(`Bundle: ${pc.cyan(entry.bundle)}${toolSuffix}`);
    }
  } else {
    lines.push(pc.dim("Configured: no"));
    lines.push(pc.dim('Run "skul add <bundle>" to get started'));
  }

  lines.push(
    "",
    pc.bold("Current Worktree"),
    `Path: ${gitContext.worktreeRoot}`,
  );

  if (!hasMaterializedBundles) {
    lines.push(pc.dim("Materialized: no"));

    appendShadowedInstructionLines(lines, shadowedInstructionStatuses);

    if (repoState && repoState.desired_state.length > 0) {
      lines.push(pc.yellow('Suggested Action: run "skul apply"'));
    }

    return lines.join("\n");
  }

  lines.push(pc.green("Materialized: yes"), "", "Files:");

  for (const [bundleName, bundleState] of Object.entries(
    worktreeState.materialized_state.bundles,
  )) {
    lines.push(`  Bundle: ${pc.cyan(bundleName)}`);
    for (const [toolName, toolState] of Object.entries(bundleState.tools)) {
      lines.push(`    Tool: ${toolName}`);
      for (const file of toolState.files) {
        lines.push(`      ${file}`);
      }
    }
  }

  appendShadowedInstructionLines(lines, shadowedInstructionStatuses);

  lines.push("", pc.bold("Git Exclude:"));
  lines.push(
    `  ${hasSkulExcludeBlock({ gitDir: gitContext.gitDir }) ? pc.green("configured") : pc.yellow("missing")}`,
  );

  return lines.join("\n");
}

interface ShadowedInstructionStatus extends ShadowedFileState {
  path: string;
  active: boolean;
  base_fresh: boolean;
  overlay_fresh: boolean;
  skip_worktree_active: boolean;
  manual_edit_suspected: boolean;
}

function collectShadowedInstructionStatuses(options: {
  repoRoot: string;
  shadowedFiles: Record<string, ShadowedFileState>;
}): ShadowedInstructionStatus[] {
  return Object.entries(options.shadowedFiles)
    .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
    .map(([filePath, shadowedFile]) =>
      collectShadowedInstructionStatus({
        repoRoot: options.repoRoot,
        filePath,
        shadowedFile,
      }),
    );
}

function collectShadowedInstructionStatus(options: {
  repoRoot: string;
  filePath: string;
  shadowedFile: ShadowedFileState;
}): ShadowedInstructionStatus {
  const inspection = inspectTrackedShadowTarget({
    repoRoot: options.repoRoot,
    filePath: options.filePath,
  });
  const targetPath = path.join(options.repoRoot, options.filePath);
  const currentContent = readStatusTargetFile(targetPath);
  const overlay = extractTrackedShadowOverlay({
    content: currentContent,
    bundleName: options.shadowedFile.bundle,
    toolName: options.shadowedFile.tool,
    strategy: options.shadowedFile.strategy,
    overlay: options.shadowedFile.overlay,
  });

  return {
    path: options.filePath,
    ...options.shadowedFile,
    active: overlay !== null,
    base_fresh:
      inspection.headBlob?.objectId === options.shadowedFile.base_blob,
    overlay_fresh:
      overlay !== null &&
      fingerprintShadowContent(overlay) ===
        options.shadowedFile.overlay_fingerprint,
    skip_worktree_active: inspection.indexFlags.includes("S"),
    manual_edit_suspected:
      currentContent === null ||
      fingerprintShadowContent(currentContent) !==
        options.shadowedFile.rendered_fingerprint,
  };
}

function buildShadowedFilesJson(
  shadowedInstructionStatuses: ShadowedInstructionStatus[],
) {
  return Object.fromEntries(
    shadowedInstructionStatuses.map((status) => [
      status.path,
      {
        tool: status.tool,
        bundle: status.bundle,
        strategy: status.strategy,
        base_blob: status.base_blob,
        overlay_fingerprint: status.overlay_fingerprint,
        rendered_fingerprint: status.rendered_fingerprint,
        skip_worktree: status.skip_worktree,
        active: status.active,
        base_fresh: status.base_fresh,
        overlay_fresh: status.overlay_fresh,
        skip_worktree_active: status.skip_worktree_active,
        manual_edit_suspected: status.manual_edit_suspected,
      },
    ]),
  );
}

function appendShadowedInstructionLines(
  lines: string[],
  shadowedInstructionStatuses: ShadowedInstructionStatus[],
): void {
  if (shadowedInstructionStatuses.length === 0) {
    return;
  }

  lines.push("", pc.bold("Shadowed Instructions"));

  for (const status of shadowedInstructionStatuses) {
    lines.push(`  ${status.path}`);
    lines.push(`    Bundle: ${pc.cyan(status.bundle)}`);
    lines.push(`    Tool: ${status.tool}`);
    lines.push(`    Strategy: ${status.strategy}`);
    lines.push(
      `    Active: ${status.active ? pc.green("yes") : pc.yellow("no")}`,
    );
    lines.push(
      `    Base: ${status.base_fresh ? pc.green("current") : pc.yellow("stale")}`,
    );
    lines.push(
      `    Overlay: ${status.overlay_fresh ? pc.green("current") : pc.yellow("stale")}`,
    );
    lines.push(
      `    Skip-worktree: ${status.skip_worktree_active ? pc.green("set") : pc.yellow("missing")}`,
    );
    lines.push(
      `    Manual edits: ${status.manual_edit_suspected ? pc.yellow("suspected") : pc.green("no")}`,
    );
  }
}

function readStatusTargetFile(filePath: string): string | null {
  if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) {
    return null;
  }

  return fs.readFileSync(filePath, "utf8");
}

function extractTrackedShadowOverlay(options: {
  content: string | null;
  bundleName: string;
  toolName: ToolName;
  strategy: ShadowedFileState["strategy"];
  overlay: string;
}): string | null {
  if (options.content === null) {
    return null;
  }

  if (options.strategy === "merge") {
    return extractMcpOverlay({
      toolName: options.toolName,
      content: options.content,
      overlay: JSON.parse(options.overlay) as RenderedMcpServers,
    });
  }

  if (options.strategy === "replace") {
    return normalizeTrackedRootInstructionStatusContent(options.content);
  }

  const startMarker = `<!-- SKUL SHADOW START bundle=${options.bundleName} -->`;
  const endMarker = "<!-- SKUL SHADOW END -->";
  const startIndex = options.content.indexOf(startMarker);

  if (startIndex < 0) {
    return null;
  }

  const endIndex = options.content.indexOf(endMarker, startIndex);

  if (endIndex < 0) {
    return null;
  }

  return normalizeTrackedRootInstructionStatusContent(
    options.content.slice(startIndex, endIndex + endMarker.length),
  );
}

function normalizeTrackedRootInstructionStatusContent(content: string): string {
  return content.replace(/\s+$/, "");
}

function worktreeHasMaterializedBundles(
  materializedState: MaterializedState,
): boolean {
  return Object.keys(materializedState.bundles).length > 0;
}

async function renderUpdateCheck(options: {
  cwd: string;
  registryFile: string;
  libraryDir: string;
  bundle?: string;
  json: boolean;
}): Promise<string> {
  const gitContext = requireGitContext(options.cwd, "check");
  const registry = readRegistryWithGuidance(options.registryFile);
  const repoState = registry.repos[gitContext.repoFingerprint];
  const worktreeState = registry.worktrees[gitContext.worktreeId];
  const entries = selectDesiredEntries(
    repoState?.desired_state ?? [],
    options.bundle,
    "check",
  );

  if (entries.length === 0) {
    return `No bundles configured for this repository. Run "skul add <bundle>" to add one`;
  }

  const inspectCache = new Map<string, Promise<RemoteSourceStatus>>();
  const results = [];
  for (const entry of entries) {
    const materializedBundle =
      worktreeState?.materialized_state.bundles[entry.bundle];

    if (!entry.source) {
      results.push({
        bundle: entry.bundle,
        status: "local-only",
        source: null,
        current_commit: null,
        latest_commit: null,
        worktree_commit: materializedBundle?.resolved_commit ?? null,
        worktree_stale: false,
      });
      continue;
    }

    const remoteStatus = await inspectRemoteSourceCached(inspectCache, {
      source: entry.source,
      libraryDir: options.libraryDir,
      protocol: entry.protocol,
      ref: entry.ref,
    });
    const desiredCommit =
      entry.resolved_commit ?? remoteStatus.currentCommit ?? null;
    const worktreeCommit = materializedBundle?.resolved_commit ?? null;
    const isPinned = remoteStatus.refKind === "commit";
    const status = isPinned
      ? "pinned"
      : desiredCommit !== null && desiredCommit === remoteStatus.remoteCommit
        ? "up-to-date"
        : "update-available";
    const worktreeStale =
      worktreeCommit !== null &&
      desiredCommit !== null &&
      worktreeCommit !== desiredCommit;

    results.push({
      bundle: entry.bundle,
      status,
      source: entry.source,
      current_commit: desiredCommit,
      latest_commit: isPinned ? desiredCommit : remoteStatus.remoteCommit,
      worktree_commit: worktreeCommit,
      worktree_stale: worktreeStale,
    });
  }

  if (options.json) {
    return JSON.stringify({ bundles: results }, null, 2);
  }

  const lines = results.map((result) => {
    if (result.status === "local-only") {
      return `${pc.cyan(result.bundle)}: local-only (no remote source to check)`;
    }
    const updateSuffix =
      result.status === "update-available" &&
      result.current_commit &&
      result.latest_commit
        ? ` ${shortCommit(result.current_commit)} -> ${shortCommit(result.latest_commit)}`
        : "";
    const staleSuffix = result.worktree_stale ? " (worktree stale)" : "";
    return `${pc.cyan(result.bundle)}: ${result.status}${updateSuffix}${staleSuffix}`;
  });

  const hasUpdates = results.some((r) => r.status === "update-available");
  if (hasUpdates) {
    lines.push("", pc.dim('Run "skul update" to apply available updates'));
  }

  return lines.join("\n");
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
  const entries = selectDesiredEntries(
    repoState?.desired_state ?? [],
    options.bundle,
    "update",
  );

  if (entries.length === 0) {
    return `No bundles configured for this repository. Run "skul add <bundle>" to add one`;
  }

  const skippedLocalOnly: string[] = [];
  const inspectCache = new Map<string, Promise<RemoteSourceStatus>>();
  const updatePlans = [];
  for (const entry of entries) {
    if (!entry.source) {
      skippedLocalOnly.push(entry.bundle);
      continue;
    }

    const remoteStatus = await inspectRemoteSourceCached(inspectCache, {
      source: entry.source,
      libraryDir: options.libraryDir,
      protocol: entry.protocol,
      ref: entry.ref,
    });
    const currentCommit = entry.resolved_commit ?? remoteStatus.currentCommit;

    if (
      (currentCommit !== undefined &&
        currentCommit === remoteStatus.remoteCommit) ||
      remoteStatus.refKind === "commit"
    ) {
      continue;
    }

    updatePlans.push({
      entry,
      currentCommit,
      remoteStatus,
    });
  }

  const localOnlyNote =
    skippedLocalOnly.length > 0
      ? `Skipped (local-only): ${skippedLocalOnly.join(", ")}`
      : "";

  if (updatePlans.length === 0) {
    if (skippedLocalOnly.length === entries.length) {
      return `No remote-backed bundles to update (${skippedLocalOnly.join(", ")} ${skippedLocalOnly.length === 1 ? "is" : "are"} local-only)`;
    }
    return [localOnlyNote, "All selected bundles are already up to date"]
      .filter(Boolean)
      .join("\n");
  }

  if (options.dryRun) {
    const dryLines = updatePlans.map(
      ({ entry, currentCommit, remoteStatus }) =>
        `${pc.yellow("DRY RUN:")} Would update ${entry.bundle}${formatCommitTransition(currentCommit, remoteStatus.remoteCommit)}`,
    );
    return [localOnlyNote, ...dryLines].filter(Boolean).join("\n");
  }

  const existingWorktreeState =
    registry.worktrees[gitContext.worktreeId]?.materialized_state;
  let currentBundles: MaterializedState["bundles"] = {
    ...(existingWorktreeState?.bundles ?? {}),
  };
  const mcpOwnership = createMcpMaterializationOwnership(existingWorktreeState);
  let currentShadowedFiles = { ...(worktreeState?.shadowed_files ?? {}) };
  const nextDesiredState = [...(repoState?.desired_state ?? [])];
  const outputLines: string[] = [];
  let rootInstructionBaseContents =
    worktreeState?.materialized_state.root_instruction_base_contents;

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

    const initialRevision = readCachedSourceRevision({
      source: entry.source!,
      libraryDir: options.libraryDir,
      protocol: entry.protocol,
    });

    try {
      const refreshed = await updateCachedRemoteSource({
        source: entry.source!,
        libraryDir: options.libraryDir,
        protocol: entry.protocol,
        ref: entry.ref,
        includeRootInstructions: entry.items?.includes("root-instruction"),
      });
      const cachedBundle = findCachedBundleWithGuidance({
        libraryDir: options.libraryDir,
        bundle: entry.bundle,
        source: entry.source,
      });
      const resolvedBundleItemRefs = await resolveBundleItemRefs({
        bundleDir: path.dirname(cachedBundle.manifestFile),
        manifest: cachedBundle.manifest,
        tools: toolsToRefresh,
        itemSelectors: entry.items,
        libraryDir: options.libraryDir,
        protocol: entry.protocol,
      });

      const materializationScope: BundleMaterializationScope = {
        repoRoot: gitContext.worktreeRoot,
        bundleDir: path.dirname(cachedBundle.manifestFile),
        manifest: cachedBundle.manifest,
        tools: toolsToRefresh,
        itemSelectors: entry.items,
        disableModelInvocation: entry.disable_model_invocation,
        resolvedBundleItemRefs,
      };
      const plannedWriteTargets =
        previewMaterializeBundleWriteTargets(materializationScope);
      const plannedRootInstructionTargets = new Set(
        plannedWriteTargets.filter((filePath) =>
          isRootInstructionPath(filePath),
        ),
      );
      const trackedShadowPlan = planTrackedShadows({
        repoRoot: gitContext.worktreeRoot,
        bundleDir: path.dirname(cachedBundle.manifestFile),
        manifest: cachedBundle.manifest,
        toolNames: selectTrackedShadowToolNames({
          existingBundleState,
          nextToolNames:
            toolsToRefresh ??
            (Object.keys(cachedBundle.manifest.tools) as ToolName[]),
        }),
        itemSelectors: entry.items,
        targetPaths: plannedRootInstructionTargets,
        bundleName: entry.bundle,
        bundleSource: entry.source,
        rootInstructionMode: entry.root_instruction_mode,
        resolvedBundleItemRefs,
        existingShadowedFiles: currentShadowedFiles,
        materializedBundles: currentBundles,
        libraryDir: options.libraryDir,
      });
      assertRootInstructionModeCompatibility({
        desiredState: nextDesiredState,
        materializedBundles: currentBundles,
        currentBundle: entry.bundle,
        targetPaths: plannedRootInstructionTargets,
        mode: entry.root_instruction_mode,
      });

      if (existingBundleState) {
        const replacementAllowed = await confirmManagedFileRemovals(
          gitContext.worktreeRoot,
          excludeShadowedTrackedTargets(
            flattenBundleState(bundleStateToReplace),
            trackedShadowPlan.deferredMaterializationTargets,
          ),
          options.prompts,
          "replace",
        );

        if (!replacementAllowed) {
          throw new Error(
            "Replacement aborted because a modified managed file was kept",
          );
        }
      }
      assertTrackedShadowPlanCanApply({
        repoRoot: gitContext.worktreeRoot,
        bundleName: entry.bundle,
        existingShadowedFiles: currentShadowedFiles,
        plan: trackedShadowPlan,
      });

      rootInstructionBaseContents = captureRootInstructionBaseContents({
        repoRoot: gitContext.worktreeRoot,
        targetPaths: trackedShadowPlan.untrackedTargetPaths,
        existingBaseContents: rootInstructionBaseContents,
        managedTargetPaths:
          collectManagedRootInstructionTargets(currentBundles),
      });
      await confirmRootInstructionReplacements({
        repoRoot: gitContext.worktreeRoot,
        targetPaths: plannedRootInstructionTargets,
        mode: entry.root_instruction_mode,
        prompts: options.prompts,
      });

      assertManagedRootInstructionSyncSourcesCached({
        desiredState: nextDesiredState,
        materializedBundles: currentBundles,
        targetPaths: trackedShadowPlan.untrackedTargetPaths,
        resolveCachedBundle: (entry) =>
          resolveDesiredCachedBundle(options.libraryDir, entry),
      });

      if (existingBundleState) {
        assertTrackedRootInstructionShadowSafetyForPaths({
          repoRoot: gitContext.worktreeRoot,
          operation: "refresh",
          filePaths: plannedWriteTargets,
        });
      }
      const desiredIndex = nextDesiredState.findIndex(
        (candidate) => candidate.bundle === entry.bundle,
      );

      nextDesiredState[desiredIndex] = {
        ...nextDesiredState[desiredIndex]!,
        ...(refreshed.resolvedRef !== undefined
          ? { resolved_ref: refreshed.resolvedRef }
          : {}),
        resolved_commit: refreshed.currentCommit,
      };

      if (bundleStateToReplace) {
        removeManagedPaths(
          gitContext.worktreeRoot,
          excludeShadowedTrackedTargets(
            flattenBundleState(bundleStateToReplace),
            trackedShadowPlan.deferredMaterializationTargets,
          ),
          { restoreCommitted: true, mcpOwnership },
        );
        const materializedResult = await materializeBundle({
          ...materializationScope,
          bundleName: entry.bundle,
          bundleSource: entry.source,
          assertSafeWriteTarget: createManagedWriteSafetyAssertion({
            repoRoot: gitContext.worktreeRoot,
            operation: existingBundleState ? "refresh" : "create",
          }),
          deferredWriteTargets:
            trackedShadowPlan.deferredMaterializationTargets,
          rootInstructionBaseContents,
          rootInstructionMode: entry.root_instruction_mode,
          resolveFileConflict: options.prompts.resolveFileConflict,
          libraryDir: options.libraryDir,
          existingMcpServers: ownedMcpServers(existingBundleState),
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
            selectedItems: entry.items,
          }),
        };
        mcpOwnership.recordMaterialization(materializedResult);
        currentShadowedFiles = applyTrackedShadowPlan({
          repoRoot: gitContext.worktreeRoot,
          bundleName: entry.bundle,
          existingShadowedFiles: currentShadowedFiles,
          plan: trackedShadowPlan,
        });

        const syncedRootInstructionPaths = syncManagedRootInstructionFiles({
          repoRoot: gitContext.worktreeRoot,
          desiredState: nextDesiredState,
          materializedBundles: currentBundles,
          rootInstructionBaseContents,
          targetPaths: trackedShadowPlan.untrackedTargetPaths,
          resolveCachedBundle: (entry) =>
            resolveDesiredCachedBundle(options.libraryDir, entry),
          resolvedBundleItemRefsByBundle:
            await resolveMaterializedBundleItemRefsByBundle({
              desiredState: nextDesiredState,
              materializedBundles: currentBundles,
              libraryDir: options.libraryDir,
              seed: new Map([[entry.bundle, resolvedBundleItemRefs]]),
              itemSelectors: ["root-instruction"],
            }),
        });
        currentBundles = refreshManagedFileFingerprintsForPaths(
          gitContext.worktreeRoot,
          currentBundles,
          syncedRootInstructionPaths,
        );
      }

      outputLines.push(
        pc.green(
          `Updated ${entry.bundle}${formatCommitTransition(currentCommit, remoteStatus.remoteCommit)}`,
        ),
      );
    } catch (error) {
      if (!initialRevision.cached) {
        removeCachedRemoteSource({
          source: entry.source!,
          libraryDir: options.libraryDir,
          protocol: entry.protocol,
        });
      } else if (initialRevision.currentCommit) {
        await restoreCachedRemoteSourceRevision({
          source: entry.source!,
          libraryDir: options.libraryDir,
          protocol: entry.protocol,
          ref: entry.ref,
          commit: initialRevision.currentCommit,
          refName: initialRevision.currentRef,
          includeRootInstructions: entry.items?.includes("root-instruction"),
        });
      }

      throw error;
    }
  }

  registry = upsertRepoState(registry, gitContext.repoFingerprint, {
    repo_root: gitContext.repoRoot,
    desired_state: nextDesiredState,
  });

  if (
    registry.worktrees[gitContext.worktreeId] ||
    Object.keys(currentBundles).length > 0
  ) {
    const managedFiles = collectExcludedPaths({
      bundles: currentBundles,
      exclude_configured: false,
      ...(rootInstructionBaseContents !== undefined
        ? { root_instruction_base_contents: rootInstructionBaseContents }
        : {}),
    });
    const newMaterializedState: MaterializedState = {
      bundles: currentBundles,
      exclude_configured: managedFiles.length > 0,
      ...mcpOwnership.toRegistryFields(),
      ...(rootInstructionBaseContents !== undefined
        ? { root_instruction_base_contents: rootInstructionBaseContents }
        : {}),
    };

    if (Object.keys(currentBundles).length > 0) {
      if (managedFiles.length > 0) {
        configureSkulExcludeBlock({
          gitDir: gitContext.gitDir,
          files: managedFiles,
        });
      } else {
        removeSkulExcludeBlock({ gitDir: gitContext.gitDir });
      }

      registry = upsertWorktreeState(registry, gitContext.worktreeId, {
        repo_fingerprint: gitContext.repoFingerprint,
        path: gitContext.worktreeRoot,
        materialized_state: newMaterializedState,
        shadowed_files: currentShadowedFiles,
      });
    } else {
      removeSkulExcludeBlock({ gitDir: gitContext.gitDir });
      if (Object.keys(currentShadowedFiles).length > 0) {
        registry = upsertWorktreeState(registry, gitContext.worktreeId, {
          repo_fingerprint: gitContext.repoFingerprint,
          path: gitContext.worktreeRoot,
          materialized_state: newMaterializedState,
          shadowed_files: currentShadowedFiles,
        });
      } else {
        registry = removeWorktreeState(registry, gitContext.worktreeId);
      }
    }
  }

  writeRegistryFile(options.registryFile, registry);

  return [localOnlyNote, ...outputLines].filter(Boolean).join("\n");
}

function inspectRemoteSourceCached(
  cache: Map<string, Promise<RemoteSourceStatus>>,
  options: FetchRemoteSourceOptions,
): Promise<RemoteSourceStatus> {
  const key = JSON.stringify([
    options.source,
    options.protocol ?? "https",
    options.ref ?? null,
  ]);
  const cached = cache.get(key);

  if (cached) {
    return cached;
  }

  const status = inspectRemoteSource(options);
  cache.set(key, status);

  return status;
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
  includeItems: BundleItemSelector[];
  selectItems: boolean;
  dryRun: boolean;
  ref?: string;
  inferredBundleFromSource?: true;
  replaceItems?: boolean;
  refreshedSources?: Set<string>;
  refreshedSourceUpdates?: Map<string, RefreshedSourceUpdate>;
  disableModelInvocation?: boolean;
  rootInstructionMode?: RootInstructionMode;
}): Promise<string> {
  const gitContext = requireGitContext(options.cwd, "add");

  // Skip cloning in dry-run: when a remote source is specified and not yet
  // cached, return a preview message immediately so no network I/O occurs.
  // (When source is omitted, fetchBundleSourceForApply is a no-op, so the
  // dryRun guard at the end of this function is sufficient for that case.)
  if (options.dryRun && options.source) {
    const { cached } = readCachedSourceRevision({
      source: options.source,
      libraryDir: options.libraryDir,
      protocol: options.protocol,
    });
    if (!cached) {
      const toolsLabel =
        options.agents.length > 0
          ? options.agents.join(", ")
          : "available tools";
      return [
        pc.dim(`(would clone ${options.source})`),
        `${pc.yellow("DRY RUN:")} Would apply ${options.bundle} for ${toolsLabel}`,
      ].join("\n");
    }
  }

  const registryBeforePrepare = readRegistryWithGuidance(options.registryFile);

  if (shouldApplySelectedItemsAcrossSourceBundles(options)) {
    return applySelectedItemsAcrossSourceBundles({
      cwd: options.cwd,
      prompts: options.prompts,
      registryFile: options.registryFile,
      libraryDir: options.libraryDir,
      source: options.source!,
      protocol: options.protocol,
      agents: options.agents,
      includeItems: options.includeItems,
      dryRun: options.dryRun,
      ref: options.ref,
      existingDesiredState:
        registryBeforePrepare.repos[gitContext.repoFingerprint]
          ?.desired_state ?? [],
      disableModelInvocation: options.disableModelInvocation,
    });
  }

  const preparedBundle = await prepareApplyBundle({
    bundle: options.bundle,
    source: options.source,
    protocol: options.protocol,
    requestedTools: options.agents,
    requestedItems: options.includeItems,
    selectItems: options.selectItems,
    replaceItems: options.replaceItems,
    prompts: options.prompts,
    libraryDir: options.libraryDir,
    ref: options.ref,
    inferredBundleFromSource: options.inferredBundleFromSource,
    existingDesiredState:
      registryBeforePrepare.repos[gitContext.repoFingerprint]?.desired_state ??
      [],
    refreshedSources: options.refreshedSources,
    refreshedSourceUpdates: options.refreshedSourceUpdates,
  });

  if (options.dryRun) {
    return [
      ...preparedBundle.cloneLines,
      `${pc.yellow("DRY RUN:")} Would ${formatApplyBundleMessage({
        bundle: preparedBundle.cachedBundle.bundle,
        toolLabel: preparedBundle.toolLabel,
        items: preparedBundle.replacesItemSelection
          ? preparedBundle.selectedItems
          : undefined,
      })}`,
    ].join("\n");
  }

  let registry = registryBeforePrepare;
  const existingWorktreeState =
    registry.worktrees[gitContext.worktreeId]?.materialized_state;
  const mcpOwnership = createMcpMaterializationOwnership(existingWorktreeState);
  // Only an earlier command can have recorded a path the repository went on to
  // commit, so the state as found on entry already holds every such path.
  warnAboutCommittedManagedFiles({
    repoRoot: gitContext.worktreeRoot,
    bundles: existingWorktreeState?.bundles ?? {},
  });
  let currentShadowedFiles = {
    ...(registry.worktrees[gitContext.worktreeId]?.shadowed_files ?? {}),
  };
  let rootInstructionBaseContents =
    existingWorktreeState?.root_instruction_base_contents;
  const existingBundleState =
    existingWorktreeState?.bundles[preparedBundle.cachedBundle.bundle];
  const existingDesiredState =
    registry.repos[gitContext.repoFingerprint]?.desired_state ?? [];
  const effectiveRootInstructionMode =
    options.rootInstructionMode ??
    preparedBundle.cachedBundle.manifest.root_instruction_mode;
  const resolvedBundleItemRefs = await resolveBundleItemRefs({
    bundleDir: path.dirname(preparedBundle.cachedBundle.manifestFile),
    manifest: preparedBundle.cachedBundle.manifest,
    tools: preparedBundle.selectedTools,
    itemSelectors: preparedBundle.selectedItems,
    libraryDir: options.libraryDir,
    protocol: options.protocol,
  });
  const materializationScope: BundleMaterializationScope = {
    repoRoot: gitContext.worktreeRoot,
    bundleDir: path.dirname(preparedBundle.cachedBundle.manifestFile),
    manifest: preparedBundle.cachedBundle.manifest,
    tools: preparedBundle.selectedTools,
    itemSelectors: preparedBundle.selectedItems,
    disableModelInvocation: options.disableModelInvocation,
    resolvedBundleItemRefs,
  };
  const plannedWriteTargets =
    previewMaterializeBundleWriteTargets(materializationScope);
  const plannedRootInstructionTargets = new Set(
    plannedWriteTargets.filter((filePath) => isRootInstructionPath(filePath)),
  );
  const trackedShadowPlan = planTrackedShadows({
    repoRoot: gitContext.worktreeRoot,
    bundleDir: path.dirname(preparedBundle.cachedBundle.manifestFile),
    manifest: preparedBundle.cachedBundle.manifest,
    toolNames: selectTrackedShadowToolNames({
      existingBundleState,
      nextToolNames: preparedBundle.nextToolNames,
    }),
    itemSelectors: preparedBundle.selectedItems,
    targetPaths: plannedRootInstructionTargets,
    bundleName: preparedBundle.cachedBundle.bundle,
    bundleSource: preparedBundle.bundleSource,
    rootInstructionMode: effectiveRootInstructionMode,
    resolvedBundleItemRefs,
    existingShadowedFiles: currentShadowedFiles,
    materializedBundles: existingWorktreeState?.bundles ?? {},
    libraryDir: options.libraryDir,
  });
  assertRootInstructionModeCompatibility({
    desiredState: existingDesiredState,
    materializedBundles: existingWorktreeState?.bundles ?? {},
    currentBundle: preparedBundle.cachedBundle.bundle,
    targetPaths: plannedRootInstructionTargets,
    mode: effectiveRootInstructionMode,
  });
  rootInstructionBaseContents = captureRootInstructionBaseContents({
    repoRoot: gitContext.worktreeRoot,
    targetPaths: trackedShadowPlan.untrackedTargetPaths,
    existingBaseContents: rootInstructionBaseContents,
    managedTargetPaths: collectManagedRootInstructionTargets(
      existingWorktreeState?.bundles ?? {},
    ),
  });
  await confirmRootInstructionReplacements({
    repoRoot: gitContext.worktreeRoot,
    targetPaths: plannedRootInstructionTargets,
    mode: effectiveRootInstructionMode,
    prompts: options.prompts,
  });
  assertManagedRootInstructionSyncSourcesCached({
    desiredState: existingDesiredState,
    materializedBundles: existingWorktreeState?.bundles ?? {},
    targetPaths: trackedShadowPlan.untrackedTargetPaths,
    resolveCachedBundle: (entry) =>
      resolveDesiredCachedBundle(options.libraryDir, entry),
  });

  let pathsToReplace: ReturnType<typeof excludeShadowedTrackedTargets> | null =
    null;

  if (existingBundleState) {
    assertTrackedRootInstructionShadowSafetyForPaths({
      repoRoot: gitContext.worktreeRoot,
      operation: "refresh",
      filePaths: plannedWriteTargets,
    });

    // When a tool flag is specified, only replace the selected tool targets.
    const toolsToReplace = preparedBundle.hasToolSelection
      ? options.agents.filter((t) => t in existingBundleState.tools)
      : (Object.keys(existingBundleState.tools) as ToolName[]);

    pathsToReplace = excludeShadowedTrackedTargets(
      flattenBundleState({
        tools: Object.fromEntries(
          toolsToReplace.map((t) => [t, existingBundleState.tools[t]!]),
        ),
      }),
      trackedShadowPlan.deferredMaterializationTargets,
    );

    const replacementAllowed = await confirmManagedFileRemovals(
      gitContext.worktreeRoot,
      pathsToReplace,
      options.prompts,
      "replace",
    );

    if (!replacementAllowed) {
      throw new Error(
        "Replacement aborted because a modified managed file was kept",
      );
    }
  }

  const sharedRootInstructionState = collectSharedRootInstructionState(
    existingWorktreeState?.bundles ?? {},
    plannedWriteTargets,
    preparedBundle.cachedBundle.bundle,
  );

  if (sharedRootInstructionState.files.length > 0) {
    const replacementAllowed = await confirmManagedFileRemovals(
      gitContext.worktreeRoot,
      sharedRootInstructionState,
      options.prompts,
      "replace",
    );

    if (!replacementAllowed) {
      throw new Error(
        "Replacement aborted because a modified managed file was kept",
      );
    }
  }
  assertTrackedShadowPlanCanApply({
    repoRoot: gitContext.worktreeRoot,
    bundleName: preparedBundle.cachedBundle.bundle,
    existingShadowedFiles: currentShadowedFiles,
    plan: trackedShadowPlan,
  });

  assertTrackedRootInstructionShadowSafetyForPaths({
    repoRoot: gitContext.worktreeRoot,
    operation: existingBundleState ? "refresh" : "create",
    filePaths: plannedWriteTargets,
  });

  if (pathsToReplace) {
    removeManagedPaths(gitContext.worktreeRoot, pathsToReplace, {
      restoreCommitted: true,
      mcpOwnership,
    });
  }

  const materializedResult = await materializeBundle({
    ...materializationScope,
    bundleName: preparedBundle.cachedBundle.bundle,
    bundleSource: preparedBundle.bundleSource,
    assertSafeWriteTarget: createManagedWriteSafetyAssertion({
      repoRoot: gitContext.worktreeRoot,
      operation: existingBundleState ? "refresh" : "create",
    }),
    deferredWriteTargets: trackedShadowPlan.deferredMaterializationTargets,
    rootInstructionBaseContents,
    rootInstructionMode: effectiveRootInstructionMode,
    resolveFileConflict: options.prompts.resolveFileConflict,
    libraryDir: options.libraryDir,
    existingMcpServers: ownedMcpServers(existingBundleState),
  });
  mcpOwnership.recordMaterialization(materializedResult);
  currentShadowedFiles = applyTrackedShadowPlan({
    repoRoot: gitContext.worktreeRoot,
    bundleName: preparedBundle.cachedBundle.bundle,
    existingShadowedFiles: currentShadowedFiles,
    plan: trackedShadowPlan,
  });

  const newBundleState = buildMaterializedBundleState({
    existingBundleState,
    materializedResult,
    repoRoot: gitContext.worktreeRoot,
    source: preparedBundle.bundleSource,
    resolvedCommit: preparedBundle.sourceRevision?.currentCommit,
    selectedTools: preparedBundle.selectedTools,
    selectedItems: preparedBundle.selectedItems,
  });

  const newDesiredEntry = buildDesiredEntryForAppliedBundle({
    existingDesiredState,
    cachedBundle: preparedBundle.cachedBundle,
    requestedSource: options.source,
    requestedProtocol: options.protocol,
    requestedRef: options.ref,
    requestedTools: preparedBundle.selectedTools,
    requestedItems: preparedBundle.selectedItems,
    replaceRequestedItems: preparedBundle.replacesItemSelection,
    sourceRevision: preparedBundle.sourceRevision,
    disableModelInvocation: options.disableModelInvocation,
    rootInstructionMode: effectiveRootInstructionMode,
  });
  const newDesiredState = [
    ...upsertDesiredEntryPreservingOrder(existingDesiredState, newDesiredEntry),
  ];

  registry = upsertRepoState(registry, gitContext.repoFingerprint, {
    repo_root: gitContext.repoRoot,
    desired_state: newDesiredState,
  });

  // Merge into existing materialized state, preserving other bundles
  const newMatState: MaterializedState = {
    bundles: {
      ...(existingWorktreeState?.bundles ?? {}),
      [preparedBundle.cachedBundle.bundle]: newBundleState,
    },
    exclude_configured: false,
    ...mcpOwnership.toRegistryFields(),
    ...(rootInstructionBaseContents !== undefined
      ? { root_instruction_base_contents: rootInstructionBaseContents }
      : {}),
  };

  const syncedRootInstructionPaths = syncManagedRootInstructionFiles({
    repoRoot: gitContext.worktreeRoot,
    desiredState: newDesiredState,
    materializedBundles: newMatState.bundles,
    rootInstructionBaseContents,
    targetPaths: trackedShadowPlan.untrackedTargetPaths,
    resolveCachedBundle: (entry) =>
      resolveDesiredCachedBundle(options.libraryDir, entry),
    resolvedBundleItemRefsByBundle:
      await resolveMaterializedBundleItemRefsByBundle({
        desiredState: newDesiredState,
        materializedBundles: newMatState.bundles,
        libraryDir: options.libraryDir,
        seed: new Map([
          [preparedBundle.cachedBundle.bundle, resolvedBundleItemRefs],
        ]),
        itemSelectors: ["root-instruction"],
      }),
  });
  newMatState.bundles = refreshManagedFileFingerprintsForPaths(
    gitContext.worktreeRoot,
    newMatState.bundles,
    syncedRootInstructionPaths,
  );

  const managedFiles = collectExcludedPaths(newMatState);
  newMatState.exclude_configured = managedFiles.length > 0;

  if (managedFiles.length > 0) {
    configureSkulExcludeBlock({
      gitDir: gitContext.gitDir,
      files: managedFiles,
    });
  } else {
    removeSkulExcludeBlock({ gitDir: gitContext.gitDir });
  }

  registry = upsertWorktreeState(registry, gitContext.worktreeId, {
    repo_fingerprint: gitContext.repoFingerprint,
    path: gitContext.worktreeRoot,
    materialized_state: newMatState,
    shadowed_files: currentShadowedFiles,
  });
  writeRegistryFile(options.registryFile, registry);

  return [
    ...preparedBundle.cloneLines,
    pc.green(
      formatAppliedBundleMessage({
        bundle: preparedBundle.cachedBundle.bundle,
        toolLabel: preparedBundle.toolLabel,
        items: preparedBundle.replacesItemSelection
          ? preparedBundle.selectedItems
          : undefined,
        updated: preparedBundle.sourceUpdated,
      }),
    ),
  ].join("\n");
}

function formatAppliedBundleMessage(options: {
  bundle: string;
  toolLabel: string;
  items?: BundleItemSelector[];
  updated?: boolean;
}): string {
  return formatApplyBundleMessage({
    bundle: options.bundle,
    toolLabel: options.toolLabel,
    items: options.items,
    updated: options.updated,
    action: "Applied",
  });
}

function formatApplyBundleMessage(options: {
  bundle: string;
  toolLabel: string;
  items?: BundleItemSelector[];
  updated?: boolean;
  action?: "Applied";
}): string {
  const itemLabel =
    options.items !== undefined && options.items.length > 0
      ? `: ${options.items.join(", ")}`
      : "";
  const updatedLabel = options.updated ? " (Updated)" : "";

  return `${options.action ?? "apply"} ${options.bundle} for ${options.toolLabel}${itemLabel}${updatedLabel}`;
}

function shouldApplySelectedItemsAcrossSourceBundles(options: {
  source?: string;
  selectItems: boolean;
  inferredBundleFromSource?: true;
}): boolean {
  return (
    options.selectItems &&
    options.source !== undefined &&
    options.inferredBundleFromSource === true
  );
}

async function applySelectedItemsAcrossSourceBundles(options: {
  cwd: string;
  prompts: PromptClient;
  registryFile: string;
  libraryDir: string;
  source: string;
  protocol: "https" | "ssh";
  agents: ToolName[];
  includeItems: BundleItemSelector[];
  dryRun: boolean;
  ref?: string;
  existingDesiredState: DesiredBundleEntry[];
  disableModelInvocation?: boolean;
}): Promise<string> {
  const refreshedSources = new Set<string>();
  const refreshedSourceUpdates = new Map<string, RefreshedSourceUpdate>();
  const cloneLines = await refreshBundleSourceForApply(
    {
      source: options.source,
      libraryDir: options.libraryDir,
      protocol: options.protocol,
      ref: options.ref,
      requestedItems: options.includeItems,
    },
    refreshedSources,
    refreshedSourceUpdates,
  );
  const selection = await selectSourceBundleItemApplyTargets({
    libraryDir: options.libraryDir,
    source: options.source,
    requestedTools: options.agents,
    requestedItems: options.includeItems,
    prompts: options.prompts,
    existingDesiredState: options.existingDesiredState,
    sourceUpdate: getRefreshedSourceUpdate(
      refreshedSourceUpdates,
      options.source,
    ),
  });
  const outputLines: string[] = [];

  for (const target of selection.removeTargets) {
    outputLines.push(
      await removeBundle({
        cwd: options.cwd,
        prompts: options.prompts,
        registryFile: options.registryFile,
        libraryDir: options.libraryDir,
        bundle: target.bundle,
        source: target.source,
        includeItems: [],
        selectItems: false,
        dryRun: options.dryRun,
      }),
    );
  }

  for (const target of selection.applyTargets) {
    outputLines.push(
      await applyBundle({
        cwd: options.cwd,
        prompts: options.prompts,
        registryFile: options.registryFile,
        libraryDir: options.libraryDir,
        bundle: target.bundle,
        source: target.source,
        protocol: options.protocol,
        agents: target.tools,
        includeItems: target.items,
        selectItems: false,
        replaceItems: true,
        dryRun: options.dryRun,
        ref: options.ref,
        refreshedSources,
        refreshedSourceUpdates,
        disableModelInvocation: options.disableModelInvocation,
      }),
    );
  }

  return [...cloneLines, ...outputLines].filter(Boolean).join("\n");
}

async function selectSourceBundleItemApplyTargets(options: {
  libraryDir: string;
  source: string;
  requestedTools: ToolName[];
  requestedItems: BundleItemSelector[];
  prompts: PromptClient;
  existingDesiredState: DesiredBundleEntry[];
  global?: boolean;
  sourceUpdate?: RefreshedSourceUpdate;
}): Promise<BundleItemApplySelection> {
  const selectedTools = await selectToolsForSourceBundleItems(options);
  const choices = listSourceBundleItemApplyChoices({
    libraryDir: options.libraryDir,
    source: options.source,
    tools: selectedTools,
    sourceUpdate: options.sourceUpdate,
  });

  if (choices.length === 0) {
    throw new Error(`No selectable bundle items found for ${options.source}`);
  }

  const requestedItems = normalizeBundleItemSelectors(options.requestedItems);
  const selectedValues = selectInitialSourceBundleItemApplyValues({
    choices,
    requestedItems,
    existingDesiredState: options.existingDesiredState,
  });
  const selections = await options.prompts.selectBundleItemChoices(
    choices,
    selectedValues,
    "install",
  );

  const removeTargets = listDeselectedSourceBundleApplyTargets({
    choices,
    selectedValues: selections,
    existingDesiredState: options.existingDesiredState,
    source: options.source,
  });

  if (selections.length === 0 && removeTargets.length === 0) {
    throw new Error("No bundle items selected for install");
  }

  return {
    applyTargets: groupBundleItemApplyTargets({
      choices,
      selectedValues: selections,
    }),
    removeTargets,
  };
}

async function selectToolsForSourceBundleItems(options: {
  libraryDir: string;
  source: string;
  requestedTools: ToolName[];
  prompts: PromptClient;
  global?: boolean;
}): Promise<ToolName[]> {
  const availableTools = listSelectableToolsForSource({
    libraryDir: options.libraryDir,
    source: options.source,
  }).filter(
    (toolName) =>
      options.global !== true || globalCapableToolNames().includes(toolName),
  );

  if (options.requestedTools.length > 0) {
    assertRequestedToolsAreSelectableForSource({
      requestedTools: options.requestedTools,
      availableTools,
      source: options.source,
    });
    return options.requestedTools;
  }

  if (availableTools.length === 0) {
    throw new Error(`No selectable agents found for ${options.source}`);
  }

  if (availableTools.length === 1) {
    return availableTools;
  }

  return options.prompts.selectAgents(availableTools);
}

function assertRequestedToolsAreSelectableForSource(options: {
  requestedTools: ToolName[];
  availableTools: ToolName[];
  source: string;
}): void {
  const unsupportedTools = options.requestedTools.filter(
    (toolName) => !options.availableTools.includes(toolName),
  );

  if (unsupportedTools.length === 0) {
    return;
  }

  throw new Error(
    `Source ${options.source} does not support agent(s): ${unsupportedTools.join(", ")}\nSupported agents: ${options.availableTools.join(", ")}`,
  );
}

function listSourceBundleItemApplyChoices(options: {
  libraryDir: string;
  source: string;
  tools: ToolName[];
  sourceUpdate?: RefreshedSourceUpdate;
}): BundleItemApplyChoice[] {
  return listCachedBundles({ libraryDir: options.libraryDir })
    .filter((bundle) => bundle.source === options.source)
    .flatMap((bundle) => {
      const bundleTools = options.tools.filter((toolName) =>
        Object.keys(bundle.manifest.tools).includes(toolName),
      );

      if (bundleTools.length === 0) {
        return [];
      }

      const availableItems = listSelectableBundleItems({
        bundleDir: path.dirname(bundle.manifestFile),
        manifest: bundle.manifest,
        tools: bundleTools,
      });

      return availableItems.map((item) => ({
        value: encodeBundleItemApplyChoice({
          source: bundle.source,
          bundle: bundle.bundle,
          item,
        }),
        label: `${bundle.bundle}: ${item}`,
        ...(getUpdatedItemsForBundle({
          sourceUpdate: options.sourceUpdate,
          bundle: bundle.bundle,
          tools: bundleTools,
        }).has(item)
          ? { hint: "Updated" }
          : {}),
        source: bundle.source,
        bundle: bundle.bundle,
        item,
        tools: bundleTools,
        availableTools: Object.keys(bundle.manifest.tools) as ToolName[],
      }));
    });
}

function selectInitialSourceBundleItemApplyValues(options: {
  choices: BundleItemApplyChoice[];
  requestedItems: BundleItemSelector[];
  existingDesiredState: DesiredBundleEntry[];
}): string[] {
  const selectedValues = new Set<string>();
  const requestedItemSet = new Set(options.requestedItems);

  for (const choice of options.choices) {
    if (requestedItemSet.has(choice.item)) {
      selectedValues.add(choice.value);
      continue;
    }

    const existingEntry = options.existingDesiredState.find(
      (entry) =>
        entry.bundle === choice.bundle && entry.source === choice.source,
    );
    if (
      existingEntry &&
      bundleItemApplyChoiceMatchesDesiredTools({
        choice,
        desiredEntry: existingEntry,
      }) &&
      (existingEntry.items === undefined ||
        existingEntry.items.includes(choice.item))
    ) {
      selectedValues.add(choice.value);
    }
  }

  const missingItems = options.requestedItems.filter(
    (item) => !options.choices.some((choice) => choice.item === item),
  );

  if (missingItems.length > 0) {
    throw new Error(
      `Bundle item(s) are not available: ${missingItems.join(", ")}`,
    );
  }

  return Array.from(selectedValues);
}

function listDeselectedSourceBundleApplyTargets(options: {
  choices: BundleItemApplyChoice[];
  selectedValues: string[];
  existingDesiredState: DesiredBundleEntry[];
  source: string;
}): BundleItemApplyRemoveTarget[] {
  const selectedBundleKeys = new Set(
    options.selectedValues.map((value) => {
      const choice = options.choices.find(
        (candidate) => candidate.value === value,
      );
      if (!choice) {
        throw new Error(`Selected bundle item is not available: ${value}`);
      }

      return encodeBundleIdentity(choice);
    }),
  );
  const choicesByBundle = groupBundleItemApplyChoices(options.choices);
  const targets: BundleItemApplyRemoveTarget[] = [];

  for (const entry of options.existingDesiredState) {
    const key = encodeBundleIdentity(entry);
    if (selectedBundleKeys.has(key)) {
      continue;
    }

    const bundleChoices = choicesByBundle.get(key);
    if (!bundleChoices) {
      if (entry.source === options.source) {
        targets.push({ bundle: entry.bundle, source: entry.source });
      }
      continue;
    }

    if (
      !bundleItemApplyChoiceCoversDesiredTools({
        choice: bundleChoices[0]!,
        desiredEntry: entry,
      })
    ) {
      continue;
    }

    const activeChoices = bundleChoices.filter((choice) =>
      bundleItemApplyChoiceMatchesDesiredState({
        choice,
        desiredEntry: entry,
      }),
    );
    if (activeChoices.length === 0) {
      continue;
    }

    targets.push({
      bundle: entry.bundle,
      source: entry.source ?? activeChoices[0]!.source,
    });
  }

  return targets;
}

function groupBundleItemApplyChoices(
  choices: BundleItemApplyChoice[],
): Map<string, BundleItemApplyChoice[]> {
  const choicesByBundle = new Map<string, BundleItemApplyChoice[]>();

  for (const choice of choices) {
    const key = encodeBundleIdentity(choice);
    const bundleChoices = choicesByBundle.get(key) ?? [];
    bundleChoices.push(choice);
    choicesByBundle.set(key, bundleChoices);
  }

  return choicesByBundle;
}

function bundleItemApplyChoiceMatchesDesiredState(options: {
  choice: BundleItemApplyChoice;
  desiredEntry: DesiredBundleEntry;
}): boolean {
  return (
    bundleItemApplyChoiceMatchesDesiredTools(options) &&
    (options.desiredEntry.items === undefined ||
      options.desiredEntry.items.includes(options.choice.item))
  );
}

function bundleItemApplyChoiceMatchesDesiredTools(options: {
  choice: BundleItemApplyChoice;
  desiredEntry: DesiredBundleEntry;
}): boolean {
  return (
    options.desiredEntry.tools === undefined ||
    options.choice.tools.some((toolName) =>
      options.desiredEntry.tools?.includes(toolName),
    )
  );
}

function bundleItemApplyChoiceCoversDesiredTools(options: {
  choice: BundleItemApplyChoice;
  desiredEntry: DesiredBundleEntry;
}): boolean {
  const desiredTools =
    options.desiredEntry.tools ?? options.choice.availableTools;

  return desiredTools.every((toolName) =>
    options.choice.tools.includes(toolName),
  );
}

function groupBundleItemApplyTargets(options: {
  choices: BundleItemApplyChoice[];
  selectedValues: string[];
}): Array<{
  bundle: string;
  source: string;
  tools: ToolName[];
  items: BundleItemSelector[];
}> {
  const groupsByBundle = new Map<
    string,
    {
      bundle: string;
      source: string;
      tools: ToolName[];
      items: BundleItemSelector[];
    }
  >();

  for (const value of options.selectedValues) {
    const choice = options.choices.find(
      (candidate) => candidate.value === value,
    );
    if (!choice) {
      throw new Error(`Selected bundle item is not available: ${value}`);
    }

    const key = encodeBundleIdentity(choice);
    const group = groupsByBundle.get(key) ?? {
      bundle: choice.bundle,
      source: choice.source,
      tools: choice.tools,
      items: [],
    };
    group.items.push(choice.item);
    groupsByBundle.set(key, group);
  }

  return Array.from(groupsByBundle.values());
}

interface BundleItemApplyChoice extends BundleItemChoice {
  source: string;
  bundle: string;
  item: BundleItemSelector;
  tools: ToolName[];
  availableTools: ToolName[];
}

interface BundleItemApplySelection {
  applyTargets: Array<{
    bundle: string;
    source: string;
    tools: ToolName[];
    items: BundleItemSelector[];
  }>;
  removeTargets: BundleItemApplyRemoveTarget[];
}

interface BundleItemApplyRemoveTarget {
  bundle: string;
  source: string;
}

function encodeBundleItemApplyChoice(choice: {
  source: string;
  bundle: string;
  item: BundleItemSelector;
}): string {
  return JSON.stringify([choice.source, choice.bundle, choice.item]);
}

async function prepareApplyBundle(options: {
  bundle: string;
  source?: string;
  protocol: "https" | "ssh";
  requestedTools: ToolName[];
  requestedItems: BundleItemSelector[];
  selectItems: boolean;
  replaceItems?: boolean;
  prompts: PromptClient;
  libraryDir: string;
  ref?: string;
  inferredBundleFromSource?: true;
  existingDesiredState: DesiredBundleEntry[];
  preBundlePrompts?: PromptClient;
  refreshedSources?: Set<string>;
  refreshedSourceUpdates?: Map<string, RefreshedSourceUpdate>;
}): Promise<{
  cloneLines: string[];
  cachedBundle: CachedBundle;
  bundleSource?: string;
  sourceRevision?: CachedSourceRevision;
  sourceUpdated: boolean;
  selectedTools?: ToolName[];
  selectedItems?: BundleItemSelector[];
  nextToolNames: ToolName[];
  toolLabel: string;
  hasToolSelection: boolean;
  replacesItemSelection: boolean;
}> {
  const refreshedSources = options.refreshedSources ?? new Set<string>();
  const refreshedSourceUpdates =
    options.refreshedSourceUpdates ?? new Map<string, RefreshedSourceUpdate>();
  const cloneLines = await refreshBundleSourceForApply(
    options,
    refreshedSources,
    refreshedSourceUpdates,
  );
  let cachedBundle: CachedBundle;
  let bundleSource: string | undefined;
  let selectedToolsBeforeBundle: ToolName[] | undefined;

  try {
    cachedBundle = findCachedBundleWithGuidance({
      libraryDir: options.libraryDir,
      bundle: options.bundle,
      source: options.source,
    });
    bundleSource = options.source ?? cachedBundle.source;
  } catch (error) {
    if (
      !shouldPromptForInferredBundle({
        error,
        libraryDir: options.libraryDir,
        source: options.source,
        inferredBundleFromSource: options.inferredBundleFromSource,
      })
    ) {
      throw error;
    }

    selectedToolsBeforeBundle = await selectToolsBeforeBundle({
      libraryDir: options.libraryDir,
      source: options.source,
      requestedTools: options.requestedTools,
      prompts: options.preBundlePrompts ?? options.prompts,
    });
    const toolsForBundleSelection =
      selectedToolsBeforeBundle ??
      (options.requestedTools.length > 0 ? options.requestedTools : undefined);
    const selection = toolsForBundleSelection
      ? await options.prompts.selectBundle(
          options.source,
          toolsForBundleSelection,
        )
      : await options.prompts.selectBundle(options.source);
    cachedBundle = findCachedBundleWithGuidance({
      libraryDir: options.libraryDir,
      bundle: selection.bundle,
      source: selection.source ?? options.source,
    });
    bundleSource = selection.source ?? options.source ?? cachedBundle.source;
  }

  if (
    bundleSource &&
    (options.source !== undefined || options.ref !== undefined)
  ) {
    cloneLines.push(
      ...(await refreshBundleSourceForApply(
        {
          source: bundleSource,
          libraryDir: options.libraryDir,
          protocol: options.protocol,
          ref: options.ref,
          requestedItems: options.requestedItems,
        },
        refreshedSources,
        refreshedSourceUpdates,
      )),
    );
    cachedBundle = findCachedBundleWithGuidance({
      libraryDir: options.libraryDir,
      bundle: cachedBundle.bundle,
      source: bundleSource,
    });
  }

  const sourceRevision = bundleSource
    ? readCachedSourceRevision({
        source: bundleSource,
        libraryDir: options.libraryDir,
      })
    : undefined;
  const availableTools = Object.keys(cachedBundle.manifest.tools) as ToolName[];
  const wasExplicitlyRequested = options.requestedTools.length > 0;

  const toolsToAssert = selectedToolsBeforeBundle ?? options.requestedTools;
  if (toolsToAssert.length > 0) {
    assertBundleSupportsRequestedTools(toolsToAssert, availableTools);
  }

  const selectedRequestedTools =
    selectedToolsBeforeBundle ??
    (wasExplicitlyRequested || availableTools.length <= 1
      ? wasExplicitlyRequested
        ? options.requestedTools
        : availableTools
      : await options.prompts.selectAgents(availableTools));
  const hasToolSelection =
    wasExplicitlyRequested ||
    selectedRequestedTools.length < availableTools.length;
  const nextToolNames = selectedRequestedTools;
  const existingDesiredEntry = options.existingDesiredState.find(
    (entry) => entry.bundle === cachedBundle.bundle,
  );
  const sourceUpdate = bundleSource
    ? getRefreshedSourceUpdate(refreshedSourceUpdates, bundleSource)
    : createEmptyRefreshedSourceUpdate();
  const updatedItems = getUpdatedItemsForBundle({
    sourceUpdate,
    bundle: cachedBundle.bundle,
    tools: nextToolNames,
  });
  const selectedItems = await resolveSelectedBundleItems({
    bundleDir: path.dirname(cachedBundle.manifestFile),
    manifest: cachedBundle.manifest,
    tools: nextToolNames,
    requestedItems: options.requestedItems,
    selectItems: options.selectItems,
    replaceItems: options.replaceItems,
    prompts: options.prompts,
    existingItems: existingDesiredEntry?.items,
    updatedItems,
  });
  const sourceUpdated = isSelectedBundleUpdated({
    updatedItems,
    selectedItems,
  });

  return {
    cloneLines,
    cachedBundle,
    bundleSource,
    sourceRevision,
    sourceUpdated,
    ...(hasToolSelection ? { selectedTools: selectedRequestedTools } : {}),
    ...(selectedItems !== undefined ? { selectedItems } : {}),
    nextToolNames,
    toolLabel: nextToolNames.join(", "),
    hasToolSelection,
    replacesItemSelection: options.selectItems || options.replaceItems === true,
  };
}

async function selectToolsBeforeBundle(options: {
  libraryDir: string;
  source?: string;
  requestedTools: ToolName[];
  prompts: PromptClient;
}): Promise<ToolName[] | undefined> {
  if (!options.source || options.requestedTools.length > 0) {
    return undefined;
  }

  const availableTools = listSelectableToolsForSource({
    libraryDir: options.libraryDir,
    source: options.source,
  });

  if (availableTools.length <= 1) {
    return undefined;
  }

  return options.prompts.selectAgents(availableTools);
}

function listSelectableToolsForSource(options: {
  libraryDir: string;
  source: string;
}): ToolName[] {
  const toolNames = new Set<ToolName>();

  for (const bundle of listCachedBundles({ libraryDir: options.libraryDir })) {
    if (bundle.source !== options.source) {
      continue;
    }

    for (const toolName of Object.keys(bundle.manifest.tools) as ToolName[]) {
      toolNames.add(toolName);
    }
  }

  return Array.from(toolNames).sort((left, right) => left.localeCompare(right));
}

async function resolveSelectedBundleItems(options: {
  bundleDir: string;
  manifest: CachedBundle["manifest"];
  tools: ToolName[];
  requestedItems: BundleItemSelector[];
  selectItems: boolean;
  replaceItems?: boolean;
  prompts: PromptClient;
  existingItems?: BundleItemSelector[];
  updatedItems?: Set<BundleItemSelector>;
}): Promise<BundleItemSelector[] | undefined> {
  if (!options.selectItems && options.requestedItems.length === 0) {
    return undefined;
  }

  const availableItems = listSelectableBundleItems({
    bundleDir: options.bundleDir,
    manifest: options.manifest,
    tools: options.tools,
  });
  assertBundleSupportsRequestedItems({
    requestedItems: options.requestedItems,
    availableItems,
  });
  const mergedItems = mergeDesiredBundleItems({
    existingItems: options.existingItems,
    requestedItems: normalizeBundleItemSelectors(options.requestedItems),
    replace: options.replaceItems === true,
  });

  if (!options.selectItems) {
    return mergedItems;
  }

  if (options.updatedItems && options.updatedItems.size > 0) {
    return options.prompts.selectBundleItemChoices(
      availableItems.map((item) => ({
        value: item,
        label: item,
        ...(options.updatedItems?.has(item) ? { hint: "Updated" } : {}),
      })),
      mergedItems ?? [],
      "install",
    );
  }

  return options.prompts.selectBundleItems(availableItems, mergedItems ?? []);
}

function shouldPromptForInferredBundle(options: {
  error: unknown;
  libraryDir: string;
  source?: string;
  inferredBundleFromSource?: true;
}): boolean {
  if (!options.inferredBundleFromSource || !options.source) {
    return false;
  }

  if (
    !(options.error instanceof Error) ||
    !/^Bundle not found: /.test(options.error.message)
  ) {
    return false;
  }

  return listCachedBundles({ libraryDir: options.libraryDir }).some(
    (bundle) => bundle.source === options.source,
  );
}

async function refreshBundleSourceForApply(
  options: {
    source?: string;
    protocol: "https" | "ssh";
    libraryDir: string;
    ref?: string;
    requestedItems?: BundleItemSelector[];
  },
  refreshedSources: Set<string>,
  refreshedSourceUpdates: Map<string, RefreshedSourceUpdate>,
): Promise<string[]> {
  if (!options.source) {
    return [];
  }

  if (refreshedSources.has(options.source)) {
    return [];
  }

  refreshedSources.add(options.source);

  const initialRevision = readCachedSourceRevision({
    source: options.source,
    libraryDir: options.libraryDir,
    protocol: options.protocol,
  });
  const initialItemFingerprints = initialRevision.cached
    ? collectSourceItemFingerprints({
        libraryDir: options.libraryDir,
        source: options.source,
      })
    : new Map();

  if (initialRevision.cached && initialRevision.remoteUrl === undefined) {
    refreshedSourceUpdates.set(
      options.source,
      createEmptyRefreshedSourceUpdate(),
    );
    return [];
  }

  let updated = false;
  if (!options.ref && initialRevision.cached) {
    await clearAndRefetchCachedRemoteSource({
      source: options.source,
      libraryDir: options.libraryDir,
      protocol: options.protocol,
      includeRootInstructions:
        options.requestedItems?.includes("root-instruction"),
    });
    const refreshedRevision = readCachedSourceRevision({
      source: options.source,
      libraryDir: options.libraryDir,
      protocol: options.protocol,
    });
    updated =
      initialRevision.currentCommit !== undefined &&
      refreshedRevision.currentCommit !== undefined &&
      initialRevision.currentCommit !== refreshedRevision.currentCommit;
  } else {
    const refreshed = await updateCachedRemoteSource({
      source: options.source,
      libraryDir: options.libraryDir,
      protocol: options.protocol,
      ref: options.ref,
      includeRootInstructions:
        options.requestedItems?.includes("root-instruction"),
    });
    updated =
      initialRevision.cached &&
      refreshed.previousCommit !== undefined &&
      refreshed.currentCommit !== undefined &&
      refreshed.previousCommit !== refreshed.currentCommit;
  }

  refreshedSourceUpdates.set(options.source, {
    updated,
    before: initialItemFingerprints,
    after: updated
      ? collectSourceItemFingerprints({
          libraryDir: options.libraryDir,
          source: options.source,
        })
      : new Map(),
  });

  return initialRevision.cached ? [] : [pc.dim(`Cloned ${options.source}`)];
}

function collectSourceItemFingerprints(options: {
  libraryDir: string;
  source: string;
}): SourceItemFingerprints {
  return new Map(
    listCachedBundles({ libraryDir: options.libraryDir })
      .filter((bundle) => bundle.source === options.source)
      .map((bundle) => [
        bundle.bundle,
        collectBundleToolItemFingerprints({
          bundleDir: path.dirname(bundle.manifestFile),
          manifest: bundle.manifest,
        }),
      ]),
  );
}

function collectBundleToolItemFingerprints(options: {
  bundleDir: string;
  manifest: CachedBundle["manifest"];
}): Map<ToolName, Map<BundleItemSelector, string>> {
  return new Map(
    (Object.keys(options.manifest.tools) as ToolName[]).map((toolName) => [
      toolName,
      collectToolItemFingerprints({
        bundleDir: options.bundleDir,
        manifest: options.manifest,
        toolName,
      }),
    ]),
  );
}

function collectToolItemFingerprints(options: {
  bundleDir: string;
  manifest: CachedBundle["manifest"];
  toolName: ToolName;
}): Map<BundleItemSelector, string> {
  return new Map(
    listSelectableBundleItems({
      bundleDir: options.bundleDir,
      manifest: options.manifest,
      tools: [options.toolName],
    }).map((item) => [
      item,
      fingerprintBundleItem({
        bundleDir: options.bundleDir,
        manifest: options.manifest,
        tools: [options.toolName],
        item,
      }),
    ]),
  );
}

function fingerprintBundleItem(options: {
  bundleDir: string;
  manifest: CachedBundle["manifest"];
  tools: ToolName[];
  item: BundleItemSelector;
}): string {
  const itemPaths = listBundleItemSourcePaths(options);
  const content = itemPaths
    .map((itemPath) => {
      const relativePath = path.relative(options.bundleDir, itemPath);
      return `${relativePath}\0${fingerprintPath(itemPath)}`;
    })
    .join("\0");

  return createHash("sha256").update(content).digest("hex");
}

function listBundleItemSourcePaths(options: {
  bundleDir: string;
  manifest: CachedBundle["manifest"];
  tools: ToolName[];
  item: BundleItemSelector;
}): string[] {
  const sourcePaths: string[] = [];
  const refsFilePath = path.join(options.bundleDir, BUNDLE_ITEM_REFS_FILE_NAME);

  if (
    fs.existsSync(refsFilePath) &&
    listBundleItemRefSelectors({
      bundleDir: options.bundleDir,
      manifest: options.manifest,
      tools: options.tools,
    }).includes(options.item)
  ) {
    sourcePaths.push(refsFilePath);
  }

  for (const toolName of options.tools) {
    const targets = options.manifest.tools[toolName];
    if (!targets) {
      continue;
    }

    if (options.item === "root-instruction") {
      const rootInstructionPath = targets.root_instruction?.path;
      if (rootInstructionPath) {
        sourcePaths.push(path.join(options.bundleDir, rootInstructionPath));
      }
      continue;
    }

    if (options.item === "mcp") {
      const mcpPath = targets.mcp?.path;
      if (mcpPath) {
        sourcePaths.push(path.join(options.bundleDir, mcpPath));
      }
      continue;
    }

    const [targetName, itemName] = options.item.split("/");
    const target = targets[targetName as keyof typeof targets];
    if (!target || !("path" in target) || !itemName) {
      continue;
    }

    sourcePaths.push(
      ...listDirectoryItemSourcePaths({
        sourceDir: path.join(options.bundleDir, target.path),
        targetName: targetName as ToolTargetName,
        itemName,
      }),
    );
  }

  return Array.from(new Set(sourcePaths)).sort((left, right) =>
    left.localeCompare(right),
  );
}

function listDirectoryItemSourcePaths(options: {
  sourceDir: string;
  targetName: ToolTargetName;
  itemName: string;
}): string[] {
  if (!fs.existsSync(options.sourceDir)) {
    return [];
  }

  return fs
    .readdirSync(options.sourceDir, { withFileTypes: true })
    .filter((entry) => isMatchingBundleItemEntry(entry, options))
    .map((entry) => path.join(options.sourceDir, entry.name));
}

function isMatchingBundleItemEntry(
  entry: fs.Dirent,
  options: {
    targetName: ToolTargetName;
    itemName: string;
  },
): boolean {
  if (!isSelectableBundleItemEntry(entry, options.targetName)) {
    return false;
  }

  return stripKnownBundleItemExtension(entry.name) === options.itemName;
}

function fingerprintPath(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return "";
  }

  const stat = fs.lstatSync(filePath);

  if (stat.isDirectory()) {
    return fingerprintDirectory(filePath);
  }

  if (stat.isFile()) {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  }

  return "";
}

function fingerprintDirectory(directoryPath: string): string {
  const entries = fs
    .readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => {
      const entryPath = path.join(directoryPath, entry.name);
      return `${entry.name}\0${fingerprintPath(entryPath)}`;
    })
    .sort((left, right) => left.localeCompare(right))
    .join("\0");

  return createHash("sha256").update(entries).digest("hex");
}

function getRefreshedSourceUpdate(
  updates: Map<string, RefreshedSourceUpdate>,
  source: string,
): RefreshedSourceUpdate {
  return updates.get(source) ?? createEmptyRefreshedSourceUpdate();
}

function createEmptyRefreshedSourceUpdate(): RefreshedSourceUpdate {
  return { updated: false, before: new Map(), after: new Map() };
}

function getUpdatedItemsForBundle(options: {
  sourceUpdate: RefreshedSourceUpdate | undefined;
  bundle: string;
  tools: ToolName[];
}): Set<BundleItemSelector> {
  const updatedItems = new Set<BundleItemSelector>();

  if (!options.sourceUpdate?.updated) {
    return updatedItems;
  }

  for (const toolName of options.tools) {
    const afterItems = options.sourceUpdate.after
      .get(options.bundle)
      ?.get(toolName);

    if (!afterItems) {
      continue;
    }

    for (const [item, afterFingerprint] of afterItems) {
      const beforeFingerprint = options.sourceUpdate.before
        .get(options.bundle)
        ?.get(toolName)
        ?.get(item);

      if (beforeFingerprint !== afterFingerprint) {
        updatedItems.add(item);
      }
    }
  }

  return updatedItems;
}

function isSelectedBundleUpdated(options: {
  updatedItems: Set<BundleItemSelector> | undefined;
  selectedItems: BundleItemSelector[] | undefined;
}): boolean {
  if (!options.updatedItems || options.updatedItems.size === 0) {
    return false;
  }

  if (!options.selectedItems) {
    return true;
  }

  return options.selectedItems.some((item) => options.updatedItems?.has(item));
}

function assertBundleSupportsRequestedTools(
  requestedTools: ToolName[],
  availableTools: ToolName[],
): void {
  const unsupportedTools = requestedTools.filter(
    (toolName) => !availableTools.includes(toolName),
  );

  if (unsupportedTools.length === 0) {
    return;
  }

  throw new Error(
    `Bundle does not support tool(s): ${unsupportedTools.join(", ")}\nSupported tools: ${availableTools.join(", ")}`,
  );
}

function buildDesiredEntryForAppliedBundle(options: {
  existingDesiredState: DesiredBundleEntry[];
  cachedBundle: CachedBundle;
  requestedSource?: string;
  requestedProtocol: "https" | "ssh";
  requestedRef?: string;
  requestedTools?: ToolName[];
  replaceRequestedTools?: boolean;
  requestedItems?: BundleItemSelector[];
  replaceRequestedItems?: boolean;
  sourceRevision?: CachedSourceRevision;
  disableModelInvocation?: boolean;
  rootInstructionMode?: RootInstructionMode;
}): DesiredBundleEntry {
  const existingDesiredEntry = options.existingDesiredState.find(
    (entry) => entry.bundle === options.cachedBundle.bundle,
  );
  const mergedDesiredTools = mergeDesiredTools({
    existingEntry: existingDesiredEntry,
    requestedTools: options.requestedTools,
    replace: options.replaceRequestedTools,
  });
  const mergedDesiredItems = mergeDesiredBundleItems({
    existingItems: existingDesiredEntry?.items,
    requestedItems: options.requestedItems,
    replace: options.replaceRequestedItems ?? false,
  });
  const preservesExistingRef =
    existingDesiredEntry?.ref !== undefined &&
    (options.requestedSource === undefined ||
      options.requestedSource === existingDesiredEntry.source);
  const sourceProtocol =
    options.sourceRevision?.remoteUrl !== undefined
      ? detectSourceProtocol(options.sourceRevision.remoteUrl)
      : undefined;
  const desiredProtocol =
    options.requestedSource !== undefined
      ? options.requestedProtocol
      : existingDesiredEntry?.source !== undefined
        ? (existingDesiredEntry.protocol ?? sourceProtocol ?? "https")
        : (sourceProtocol ?? existingDesiredEntry?.protocol ?? "https");

  return {
    bundle: options.cachedBundle.bundle,
    ...(options.requestedSource !== undefined
      ? { source: options.requestedSource }
      : existingDesiredEntry?.source !== undefined
        ? { source: existingDesiredEntry.source }
        : options.cachedBundle.source !== undefined
          ? { source: options.cachedBundle.source }
          : {}),
    ...(mergedDesiredTools !== undefined ? { tools: mergedDesiredTools } : {}),
    ...(mergedDesiredItems !== undefined ? { items: mergedDesiredItems } : {}),
    protocol: desiredProtocol,
    ...(options.requestedRef !== undefined
      ? { ref: options.requestedRef }
      : preservesExistingRef
        ? { ref: existingDesiredEntry.ref }
        : {}),
    ...(options.sourceRevision?.currentRef !== undefined
      ? { resolved_ref: options.sourceRevision.currentRef }
      : existingDesiredEntry?.resolved_ref !== undefined
        ? { resolved_ref: existingDesiredEntry.resolved_ref }
        : {}),
    ...(options.sourceRevision?.currentCommit !== undefined
      ? { resolved_commit: options.sourceRevision.currentCommit }
      : existingDesiredEntry?.resolved_commit !== undefined
        ? { resolved_commit: existingDesiredEntry.resolved_commit }
        : {}),
    ...((options.disableModelInvocation ??
    existingDesiredEntry?.disable_model_invocation)
      ? { disable_model_invocation: true }
      : {}),
    ...(options.rootInstructionMode !== undefined
      ? { root_instruction_mode: options.rootInstructionMode }
      : existingDesiredEntry?.root_instruction_mode !== undefined
        ? { root_instruction_mode: existingDesiredEntry.root_instruction_mode }
        : {}),
  };
}

async function resetWorktree(options: {
  cwd: string;
  prompts: PromptClient;
  registryFile: string;
  dryRun: boolean;
  warnings?: CommandWarningCollector;
}): Promise<string> {
  const gitContext = requireGitContext(options.cwd, "reset");

  let registry = readRegistryWithGuidance(options.registryFile);
  const worktreeState = registry.worktrees[gitContext.worktreeId];
  const hasMaterializedBundles = worktreeState
    ? worktreeHasMaterializedBundles(worktreeState.materialized_state)
    : false;
  const hasShadowedFiles = worktreeState
    ? Object.keys(worktreeState.shadowed_files).length > 0
    : false;
  let cleanupPending = false;

  if (options.dryRun) {
    if (!hasMaterializedBundles && !hasShadowedFiles) {
      return `${pc.yellow("DRY RUN:")} No Skul-managed files found in the current worktree`;
    }

    const allFiles = Array.from(
      new Set(
        Object.values(worktreeState.materialized_state.bundles).flatMap(
          (bundleState) => {
            const paths = flattenBundleState(bundleState);
            return [
              ...paths.files,
              ...paths.mcp_servers.map(({ path: filePath }) => filePath),
            ];
          },
        ),
      ),
    );
    const lines = [
      `${pc.yellow("DRY RUN:")} Would restore ${Object.keys(worktreeState.shadowed_files).length} tracked shadow file(s) and remove ${allFiles.length} managed file(s) from ${gitContext.worktreeRoot}`,
    ];
    for (const file of allFiles) {
      lines.push(`  ${file}`);
    }
    for (const filePath of Object.keys(worktreeState.shadowed_files)) {
      lines.push(`  ${filePath}`);
    }

    return lines.join("\n");
  }

  if ((hasMaterializedBundles || hasShadowedFiles) && worktreeState) {
    const mcpOwnership = createMcpMaterializationOwnership(
      worktreeState.materialized_state,
    );
    const allBundleEntries = Object.entries(
      worktreeState.materialized_state.bundles,
    );
    const allBundlePaths = allBundleEntries.map(([, bundleState]) =>
      flattenBundleState(bundleState),
    );

    // Confirm all removals before touching any files (all-or-nothing)
    for (const bundlePaths of allBundlePaths) {
      const resetAllowed = await confirmManagedFileRemovals(
        gitContext.worktreeRoot,
        bundlePaths,
        options.prompts,
        "reset",
      );

      if (!resetAllowed) {
        throw new Error(
          "Reset aborted because a modified managed file was kept",
        );
      }
    }

    const remainingShadowedFiles = retireTrackedShadows({
      repoRoot: gitContext.worktreeRoot,
      shadowedFiles: worktreeState.shadowed_files,
      filePaths: Object.keys(worktreeState.shadowed_files),
    });

    const failedBundleStates: Record<string, MaterializedBundleState> = {};
    for (const [bundleName, bundleState] of allBundleEntries) {
      const removalResult = removeManagedPaths(
        gitContext.worktreeRoot,
        flattenBundleState(bundleState),
        {
          restoreCommitted: true,
          mcpOwnership,
          warnings: options.warnings,
        },
      );
      const retained = retainFailedMcpBundleState(
        bundleState,
        removalResult.failedMcpServers,
      );
      if (retained) failedBundleStates[bundleName] = retained;
    }

    restoreRootInstructionBaseContents({
      repoRoot: gitContext.worktreeRoot,
      baseContents:
        worktreeState.materialized_state.root_instruction_base_contents,
      targetPaths: collectManagedRootInstructionTargets(
        worktreeState.materialized_state.bundles,
      ),
    });

    if (
      Object.keys(remainingShadowedFiles).length > 0 ||
      Object.keys(failedBundleStates).length > 0
    ) {
      const retainedMaterializedState: MaterializedState = {
        bundles: failedBundleStates,
        exclude_configured: false,
        ...mcpOwnership.toRegistryFields(),
        ...(worktreeState.materialized_state.root_instruction_base_contents !==
        undefined
          ? {
              root_instruction_base_contents:
                worktreeState.materialized_state.root_instruction_base_contents,
            }
          : {}),
      };
      cleanupPending = Object.keys(failedBundleStates).length > 0;
      const retainedManagedFiles = collectExcludedPaths(
        retainedMaterializedState,
      );
      retainedMaterializedState.exclude_configured =
        retainedManagedFiles.length > 0;
      if (retainedManagedFiles.length > 0) {
        configureSkulExcludeBlock({
          gitDir: gitContext.gitDir,
          files: retainedManagedFiles,
        });
      } else {
        removeSkulExcludeBlock({ gitDir: gitContext.gitDir });
      }
      registry = upsertWorktreeState(registry, gitContext.worktreeId, {
        repo_fingerprint: gitContext.repoFingerprint,
        path: gitContext.worktreeRoot,
        materialized_state: retainedMaterializedState,
        shadowed_files: remainingShadowedFiles,
      });
    } else {
      registry = removeWorktreeState(registry, gitContext.worktreeId);
    }
    writeRegistryFile(options.registryFile, registry);
  }

  const excludeRemoved = cleanupPending
    ? false
    : removeSkulExcludeBlock({ gitDir: gitContext.gitDir });

  if (!hasMaterializedBundles && !hasShadowedFiles && !excludeRemoved) {
    return "No Skul-managed files found in the current worktree";
  }

  return pc.green("Reset Skul-managed files from the current worktree");
}

async function removeBundle(options: {
  cwd: string;
  prompts: PromptClient;
  registryFile: string;
  libraryDir: string;
  bundle?: string;
  source?: string;
  includeItems: BundleItemSelector[];
  selectItems: boolean;
  dryRun: boolean;
  inferredBundleFromSource?: true;
  warnings?: CommandWarningCollector;
}): Promise<string> {
  const gitContext = requireGitContext(options.cwd, "remove");

  let registry = readRegistryWithGuidance(options.registryFile);
  const repoState = registry.repos[gitContext.repoFingerprint];
  const worktreeState = registry.worktrees[gitContext.worktreeId];

  if (shouldRemoveItemsAcrossBundles(options)) {
    return removeBundleItemsAcrossActiveBundles({
      cwd: options.cwd,
      prompts: options.prompts,
      registryFile: options.registryFile,
      libraryDir: options.libraryDir,
      repoState,
      source: options.source,
      bundle: options.inferredBundleFromSource ? undefined : options.bundle,
      includeItems: options.includeItems,
      selectItems: options.selectItems,
      dryRun: options.dryRun,
      warnings: options.warnings,
    });
  }

  const selection = await resolveRemoveBundleSelection({
    requestedBundle: options.bundle,
    requestedSource: options.source,
    inferredBundleFromSource: options.inferredBundleFromSource,
    repoState,
    worktreeState,
    prompts: options.prompts,
  });
  const bundle = selection.bundle;
  const source = selection.source;

  const isInDesiredState =
    repoState?.desired_state.some(
      (e) => e.bundle === bundle && matchesOptionalSource(e.source, source),
    ) ?? false;
  const desiredEntry = repoState?.desired_state.find(
    (e) => e.bundle === bundle && matchesOptionalSource(e.source, source),
  );
  const bundleMaterializedState = findMaterializedBundleState({
    worktreeState,
    bundle,
    source,
  });
  const shadowedFilesForBundle = Object.entries(
    worktreeState?.shadowed_files ?? {},
  ).filter(([, shadowedFile]) => shadowedFile.bundle === bundle);

  if (!isInDesiredState && !bundleMaterializedState) {
    const configured =
      repoState?.desired_state
        .filter((entry) => matchesOptionalSource(entry.source, source))
        .map((e) => e.bundle) ?? [];
    const hint =
      configured.length > 0
        ? `Configured bundles: ${configured.join(", ")}`
        : `No bundles are configured yet. Run "skul add <bundle>" to add one`;
    throw new Error(`Bundle not found in active set: ${bundle}. ${hint}`);
  }

  if (options.includeItems.length > 0 || options.selectItems) {
    const itemRemoval = await removeBundleItems({
      cwd: options.cwd,
      prompts: options.prompts,
      registryFile: options.registryFile,
      libraryDir: options.libraryDir,
      gitContext,
      registry,
      repoState,
      worktreeState,
      desiredEntry,
      bundle,
      source,
      includeItems: options.includeItems,
      selectItems: options.selectItems,
      dryRun: options.dryRun,
      warnings: options.warnings,
    });

    if (itemRemoval.kind === "completed") {
      return itemRemoval.output;
    }
  }

  if (options.dryRun) {
    if (bundleMaterializedState || shadowedFilesForBundle.length > 0) {
      const flattened = bundleMaterializedState
        ? flattenBundleState(bundleMaterializedState)
        : undefined;
      const removableFiles = Array.from(
        new Set([
          ...(flattened?.files ?? []),
          ...(flattened?.mcp_servers ?? []).map(
            ({ path: filePath }) => filePath,
          ),
          ...shadowedFilesForBundle.map(([filePath]) => filePath),
        ]),
      );
      const lines = [
        `${pc.yellow("DRY RUN:")} Would remove ${bundle} (${removableFiles.length} file(s))`,
      ];
      for (const file of removableFiles) {
        lines.push(`  ${file}`);
      }
      return lines.join("\n");
    }

    return `${pc.yellow("DRY RUN:")} Would remove ${bundle} from desired state (not yet materialized in this worktree)`;
  }

  let currentShadowedFiles = { ...(worktreeState?.shadowed_files ?? {}) };
  const mcpOwnership = createMcpMaterializationOwnership(
    worktreeState?.materialized_state,
  );

  if (bundleMaterializedState || shadowedFilesForBundle.length > 0) {
    const bundlePaths = bundleMaterializedState
      ? flattenBundleState(bundleMaterializedState)
      : {
          files: [],
          file_fingerprints: {},
          directories: [],
          mcp_servers: [],
        };
    const rootInstructionBaseContents =
      worktreeState?.materialized_state.root_instruction_base_contents;
    const removedRootInstructionPaths = new Set(
      bundlePaths.files.filter((filePath) => isRootInstructionPath(filePath)),
    );
    const remainingBundles = { ...worktreeState!.materialized_state.bundles };
    delete remainingBundles[bundle];
    const remainingDesiredState =
      repoState?.desired_state.filter(
        (entry) => !matchesBundleIdentity(entry, bundle, source),
      ) ?? [];
    const rewrittenRootInstructionPaths = new Set(
      Array.from(collectManagedRootInstructionTargets(remainingBundles)).filter(
        (filePath) => removedRootInstructionPaths.has(filePath),
      ),
    );

    assertManagedRootInstructionSyncSourcesCached({
      desiredState: remainingDesiredState,
      materializedBundles: remainingBundles,
      targetPaths: rewrittenRootInstructionPaths,
      resolveCachedBundle: (entry) =>
        resolveDesiredCachedBundle(options.libraryDir, entry),
    });

    const removeAllowed = await confirmManagedFileRemovals(
      gitContext.worktreeRoot,
      bundlePaths,
      options.prompts,
      "remove",
    );

    if (!removeAllowed) {
      throw new Error(
        "Removal aborted because a modified managed file was kept",
      );
    }

    currentShadowedFiles = retireTrackedShadows({
      repoRoot: gitContext.worktreeRoot,
      shadowedFiles: currentShadowedFiles,
      filePaths: shadowedFilesForBundle.map(([filePath]) => filePath),
    });

    if (Object.keys(remainingBundles).length > 0) {
      assertTrackedRootInstructionShadowSafetyForPaths({
        repoRoot: gitContext.worktreeRoot,
        operation: "refresh",
        filePaths: Array.from(rewrittenRootInstructionPaths),
      });
    }

    const remainingRootInstructionRefs =
      Object.keys(remainingBundles).length > 0
        ? await resolveMaterializedBundleItemRefsByBundle({
            desiredState: remainingDesiredState,
            materializedBundles: remainingBundles,
            libraryDir: options.libraryDir,
            itemSelectors: ["root-instruction"],
          })
        : undefined;

    const removalResult = removeManagedPaths(
      gitContext.worktreeRoot,
      bundlePaths,
      {
        restoreCommitted: true,
        mcpOwnership,
        warnings: options.warnings,
      },
    );
    const failedBundleState = bundleMaterializedState
      ? retainFailedMcpBundleState(
          bundleMaterializedState,
          removalResult.failedMcpServers,
        )
      : undefined;
    const remainingRootInstructionTargets =
      collectManagedRootInstructionTargets(remainingBundles);
    const restoredRootInstructionPaths = new Set(
      Array.from(removedRootInstructionPaths).filter(
        (filePath) => !remainingRootInstructionTargets.has(filePath),
      ),
    );
    restoreRootInstructionBaseContents({
      repoRoot: gitContext.worktreeRoot,
      baseContents: rootInstructionBaseContents,
      targetPaths: restoredRootInstructionPaths,
    });
    const nextRootInstructionBaseContents = rootInstructionBaseContents
      ? Object.fromEntries(
          Object.entries(rootInstructionBaseContents).filter(
            ([filePath]) => !restoredRootInstructionPaths.has(filePath),
          ),
        )
      : undefined;

    if (Object.keys(remainingBundles).length > 0) {
      const syncedRootInstructionPaths = syncManagedRootInstructionFiles({
        repoRoot: gitContext.worktreeRoot,
        desiredState: remainingDesiredState,
        materializedBundles: remainingBundles,
        rootInstructionBaseContents: nextRootInstructionBaseContents,
        targetPaths: rewrittenRootInstructionPaths,
        resolveCachedBundle: (entry) =>
          resolveDesiredCachedBundle(options.libraryDir, entry),
        resolvedBundleItemRefsByBundle: remainingRootInstructionRefs,
      });
      const refreshedRemainingBundles = refreshManagedFileFingerprintsForPaths(
        gitContext.worktreeRoot,
        remainingBundles,
        syncedRootInstructionPaths,
      );
      const newMatState: MaterializedState = {
        bundles: failedBundleState
          ? { ...refreshedRemainingBundles, [bundle]: failedBundleState }
          : refreshedRemainingBundles,
        exclude_configured: false,
        ...mcpOwnership.toRegistryFields(),
        ...(nextRootInstructionBaseContents !== undefined &&
        Object.keys(nextRootInstructionBaseContents).length > 0
          ? { root_instruction_base_contents: nextRootInstructionBaseContents }
          : {}),
      };

      const managedFiles = collectExcludedPaths(newMatState);
      newMatState.exclude_configured = managedFiles.length > 0;

      if (managedFiles.length > 0) {
        configureSkulExcludeBlock({
          gitDir: gitContext.gitDir,
          files: managedFiles,
        });
      } else {
        removeSkulExcludeBlock({ gitDir: gitContext.gitDir });
      }

      registry = upsertWorktreeState(registry, gitContext.worktreeId, {
        repo_fingerprint: gitContext.repoFingerprint,
        path: gitContext.worktreeRoot,
        materialized_state: newMatState,
        shadowed_files: currentShadowedFiles,
      });
    } else {
      if (Object.keys(currentShadowedFiles).length > 0 || failedBundleState) {
        const retainedMaterializedState: MaterializedState = {
          bundles: failedBundleState ? { [bundle]: failedBundleState } : {},
          exclude_configured: false,
          ...mcpOwnership.toRegistryFields(),
        };
        const retainedManagedFiles = collectExcludedPaths(
          retainedMaterializedState,
        );
        retainedMaterializedState.exclude_configured =
          retainedManagedFiles.length > 0;
        if (retainedManagedFiles.length > 0) {
          configureSkulExcludeBlock({
            gitDir: gitContext.gitDir,
            files: retainedManagedFiles,
          });
        } else {
          removeSkulExcludeBlock({ gitDir: gitContext.gitDir });
        }
        registry = upsertWorktreeState(registry, gitContext.worktreeId, {
          repo_fingerprint: gitContext.repoFingerprint,
          path: gitContext.worktreeRoot,
          materialized_state: retainedMaterializedState,
          shadowed_files: currentShadowedFiles,
        });
      } else {
        removeSkulExcludeBlock({ gitDir: gitContext.gitDir });
        registry = removeWorktreeState(registry, gitContext.worktreeId);
      }
    }
  }

  if (isInDesiredState && repoState) {
    const newDesiredState = repoState.desired_state.filter(
      (entry) => !matchesBundleIdentity(entry, bundle, source),
    );
    registry = upsertRepoState(registry, gitContext.repoFingerprint, {
      ...repoState,
      repo_root: gitContext.repoRoot,
      desired_state: newDesiredState,
    });
  }

  writeRegistryFile(options.registryFile, registry);

  return pc.green(`Removed ${bundle}`);
}

function shouldRemoveItemsAcrossBundles(options: {
  bundle?: string;
  includeItems: BundleItemSelector[];
  selectItems: boolean;
  inferredBundleFromSource?: true;
}): boolean {
  return (
    options.selectItems ||
    (options.includeItems.length > 0 &&
      (options.bundle === undefined ||
        options.inferredBundleFromSource === true))
  );
}

async function removeBundleItemsAcrossActiveBundles(options: {
  cwd: string;
  prompts: PromptClient;
  registryFile: string;
  libraryDir: string;
  repoState?: RepoState;
  source?: string;
  bundle?: string;
  includeItems: BundleItemSelector[];
  selectItems: boolean;
  dryRun: boolean;
  warnings?: CommandWarningCollector;
}): Promise<string> {
  if (!options.repoState || options.repoState.desired_state.length === 0) {
    throw new Error(
      options.source
        ? `No active bundles found for ${options.source}. Run "skul add ${options.source} <bundle>" to add one first`
        : 'No active bundles found. Run "skul add <bundle>" to add one first',
    );
  }

  const choices = listActiveBundleItemRemovalChoices({
    libraryDir: options.libraryDir,
    desiredState: options.repoState.desired_state,
    source: options.source,
    bundle: options.bundle,
  });
  const requestedItems = normalizeBundleItemSelectors(options.includeItems);
  const selectedValues = options.selectItems
    ? await promptForBundleItemRemovalChoices({
        prompts: options.prompts,
        choices,
        requestedItems,
      })
    : selectRequestedBundleItemRemovalChoices({
        choices,
        requestedItems,
      });
  const removalPlan = planBundleItemRemovals({
    desiredState: options.repoState.desired_state,
    choices,
    selectedValues,
  });

  if (options.dryRun) {
    return `${pc.yellow("DRY RUN:")} Would remove ${formatBundleItemRemovalSummary(removalPlan.removedItems)}`;
  }

  for (const target of groupBundleItemRemovalTargets(
    removalPlan.removedItems,
  )) {
    await removeBundle({
      cwd: options.cwd,
      prompts: options.prompts,
      registryFile: options.registryFile,
      libraryDir: options.libraryDir,
      bundle: target.bundle,
      source: target.source,
      includeItems: target.items,
      selectItems: false,
      dryRun: false,
      warnings: options.warnings,
    });
  }

  return pc.green(
    `Removed ${formatBundleItemRemovalSummary(removalPlan.removedItems)}`,
  );
}

function groupBundleItemRemovalTargets(
  removedItems: BundleItemRemovalTarget[],
): Array<{
  bundle: string;
  source?: string;
  items: BundleItemSelector[];
}> {
  const groupsByBundle = new Map<
    string,
    { bundle: string; source?: string; items: BundleItemSelector[] }
  >();

  for (const item of removedItems) {
    const key = encodeBundleIdentity(item);
    const group = groupsByBundle.get(key) ?? {
      bundle: item.bundle,
      source: item.source,
      items: [],
    };
    group.items.push(item.item);
    groupsByBundle.set(key, group);
  }

  return Array.from(groupsByBundle.values());
}

function listActiveBundleItemRemovalChoices(options: {
  libraryDir: string;
  desiredState: DesiredBundleEntry[];
  source?: string;
  bundle?: string;
}): BundleItemRemovalChoice[] {
  const choices = options.desiredState.flatMap((entry) => {
    if (!matchesOptionalSource(entry.source, options.source)) return [];
    if (options.bundle !== undefined && entry.bundle !== options.bundle) {
      return [];
    }

    return listDesiredBundleItemRemovalChoices({
      libraryDir: options.libraryDir,
      desiredEntry: entry,
    });
  });

  if (choices.length === 0) {
    throw new Error(
      options.source
        ? `No active bundle items found for ${options.source}`
        : "No active bundle items found",
    );
  }

  return choices;
}

function listDesiredBundleItemRemovalChoices(options: {
  libraryDir: string;
  desiredEntry: DesiredBundleEntry;
}): BundleItemRemovalChoice[] {
  const cachedBundle = findCachedBundleWithGuidance({
    libraryDir: options.libraryDir,
    bundle: options.desiredEntry.bundle,
    source: options.desiredEntry.source,
  });
  const selectedTools =
    options.desiredEntry.tools ??
    (Object.keys(cachedBundle.manifest.tools) as ToolName[]);
  const availableItems = listSelectableBundleItems({
    bundleDir: path.dirname(cachedBundle.manifestFile),
    manifest: cachedBundle.manifest,
    tools: selectedTools,
  });
  const activeItems = options.desiredEntry.items ?? availableItems;

  return activeItems.map((item) => ({
    value: encodeBundleItemRemovalChoice({
      bundle: options.desiredEntry.bundle,
      source: options.desiredEntry.source,
      item,
    }),
    label: formatBundleItemRemovalChoiceLabel({
      bundle: options.desiredEntry.bundle,
      source: options.desiredEntry.source,
      item,
    }),
    bundle: options.desiredEntry.bundle,
    source: options.desiredEntry.source,
    item,
    activeItems,
  }));
}

async function promptForBundleItemRemovalChoices(options: {
  prompts: PromptClient;
  choices: BundleItemRemovalChoice[];
  requestedItems: BundleItemSelector[];
}): Promise<string[]> {
  const selectedValues = selectRequestedBundleItemRemovalChoices({
    choices: options.choices,
    requestedItems: options.requestedItems,
    allowEmptySelection: true,
  });

  const selections = await options.prompts.selectBundleItemChoices(
    options.choices,
    selectedValues,
    "remove",
  );

  if (selections.length === 0) {
    throw new Error("No bundle items selected for removal");
  }

  return selections;
}

function selectRequestedBundleItemRemovalChoices(options: {
  choices: BundleItemRemovalChoice[];
  requestedItems: BundleItemSelector[];
  allowEmptySelection?: boolean;
}): string[] {
  if (options.requestedItems.length === 0 && !options.allowEmptySelection) {
    throw new Error("No bundle items selected for removal");
  }

  const requestedItemSet = new Set(options.requestedItems);
  const selectedValues = options.choices
    .filter((choice) => requestedItemSet.has(choice.item))
    .map((choice) => choice.value);
  const missingItems = options.requestedItems.filter(
    (item) => !options.choices.some((choice) => choice.item === item),
  );

  if (missingItems.length > 0) {
    throw new Error(
      `Bundle item(s) are not active: ${missingItems.join(", ")}`,
    );
  }

  if (selectedValues.length === 0 && !options.allowEmptySelection) {
    throw new Error("No bundle items selected for removal");
  }

  return selectedValues;
}

function planBundleItemRemovals(options: {
  desiredState: DesiredBundleEntry[];
  choices: BundleItemRemovalChoice[];
  selectedValues: string[];
}): {
  removedItems: BundleItemRemovalTarget[];
} {
  const selectedChoices = options.selectedValues.map((value) => {
    const choice = options.choices.find(
      (candidate) => candidate.value === value,
    );
    if (!choice) {
      throw new Error(`Selected bundle item is not active: ${value}`);
    }

    return choice;
  });
  const selectedItemsByBundle = new Map<string, Set<BundleItemSelector>>();

  for (const choice of selectedChoices) {
    const key = encodeBundleIdentity(choice);
    const items =
      selectedItemsByBundle.get(key) ?? new Set<BundleItemSelector>();
    items.add(choice.item);
    selectedItemsByBundle.set(key, items);
  }

  for (const entry of options.desiredState) {
    const selectedItems = selectedItemsByBundle.get(
      encodeBundleIdentity(entry),
    );
    if (!selectedItems) continue;
    const activeItems = options.choices.find(
      (choice) => encodeBundleIdentity(choice) === encodeBundleIdentity(entry),
    )?.activeItems;
    const inactiveSelectedItems = Array.from(selectedItems).filter(
      (item) => !(activeItems ?? entry.items ?? []).includes(item),
    );
    if (inactiveSelectedItems.length > 0) {
      throw new Error(
        `Bundle item(s) are not active: ${inactiveSelectedItems.join(", ")}`,
      );
    }
  }

  return {
    removedItems: selectedChoices.map((choice) => ({
      bundle: choice.bundle,
      source: choice.source,
      item: choice.item,
    })),
  };
}

interface BundleItemRemovalChoice extends BundleItemChoice {
  bundle: string;
  source?: string;
  item: BundleItemSelector;
  activeItems: BundleItemSelector[];
}

interface BundleItemRemovalTarget {
  bundle: string;
  source?: string;
  item: BundleItemSelector;
}

function encodeBundleItemRemovalChoice(
  choice: BundleItemRemovalTarget,
): string {
  return JSON.stringify([choice.source ?? null, choice.bundle, choice.item]);
}

function encodeBundleIdentity(choice: { bundle: string; source?: string }) {
  return JSON.stringify([choice.source ?? null, choice.bundle]);
}

function formatBundleItemRemovalChoiceLabel(
  choice: BundleItemRemovalTarget,
): string {
  return choice.source
    ? `${choice.source} / ${choice.bundle}: ${choice.item}`
    : `${choice.bundle}: ${choice.item}`;
}

function formatBundleItemRemovalSummary(
  removedItems: BundleItemRemovalTarget[],
): string {
  return removedItems.map((item) => `${item.bundle}: ${item.item}`).join(", ");
}

async function resolveRemoveBundleSelection(options: {
  requestedBundle?: string;
  requestedSource?: string;
  inferredBundleFromSource?: true;
  repoState?: RepoState;
  worktreeState?: WorktreeState;
  prompts: PromptClient;
}): Promise<{ bundle: string; source?: string }> {
  if (
    options.requestedBundle &&
    isRemoveBundleActive({
      repoState: options.repoState,
      worktreeState: options.worktreeState,
      bundle: options.requestedBundle,
      source: options.requestedSource,
    })
  ) {
    return {
      bundle: options.requestedBundle,
      ...(options.requestedSource !== undefined
        ? { source: options.requestedSource }
        : {}),
    };
  }

  if (options.requestedBundle && !options.inferredBundleFromSource) {
    return {
      bundle: options.requestedBundle,
      ...(options.requestedSource !== undefined
        ? { source: options.requestedSource }
        : {}),
    };
  }

  if (
    options.requestedSource !== undefined &&
    options.inferredBundleFromSource
  ) {
    return promptForActiveRemoveBundleSelection({
      repoState: options.repoState,
      worktreeState: options.worktreeState,
      prompts: options.prompts,
      source: options.requestedSource,
    });
  }

  if (options.requestedBundle !== undefined) {
    return { bundle: options.requestedBundle };
  }

  return promptForActiveRemoveBundleSelection({
    repoState: options.repoState,
    worktreeState: options.worktreeState,
    prompts: options.prompts,
  });
}

async function promptForActiveRemoveBundleSelection(options: {
  repoState?: RepoState;
  worktreeState?: WorktreeState;
  prompts: PromptClient;
  source?: string;
}): Promise<{ bundle: string; source?: string }> {
  const activeSelections = listActiveRemoveBundleSelections({
    repoState: options.repoState,
    worktreeState: options.worktreeState,
    source: options.source,
  });

  if (activeSelections.length === 0) {
    throw new Error(
      options.source
        ? `No active bundles found for ${options.source}. Run "skul add ${options.source} <bundle>" to add one first`
        : 'No active bundles found. Run "skul add <bundle>" to add one first',
    );
  }

  if (activeSelections.length === 1) {
    return activeSelections[0]!;
  }

  const selection = await options.prompts.selectBundleFromSelections(
    activeSelections,
    options.source,
  );

  return {
    bundle: selection.bundle,
    ...(selection.source !== undefined ? { source: selection.source } : {}),
  };
}

function listActiveRemoveBundleSelections(options: {
  repoState?: RepoState;
  worktreeState?: WorktreeState;
  source?: string;
}): BundleSelection[] {
  const selections: BundleSelection[] = [];
  const seen = new Set<string>();

  for (const entry of options.repoState?.desired_state ?? []) {
    if (!matchesOptionalSource(entry.source, options.source)) continue;
    addActiveRemoveBundleSelection(selections, seen, {
      bundle: entry.bundle,
      ...(entry.source !== undefined ? { source: entry.source } : {}),
      protocol: entry.protocol,
    });
  }

  for (const [bundle, state] of Object.entries(
    options.worktreeState?.materialized_state.bundles ?? {},
  )) {
    if (!matchesOptionalSource(state.source, options.source)) continue;
    addActiveRemoveBundleSelection(selections, seen, {
      bundle,
      ...(state.source !== undefined ? { source: state.source } : {}),
    });
  }

  return selections.sort(compareBundleSelections);
}

function addActiveRemoveBundleSelection(
  selections: BundleSelection[],
  seen: Set<string>,
  selection: BundleSelection,
): void {
  const key = `${selection.source ?? ""}\0${selection.bundle}`;
  if (seen.has(key)) return;

  seen.add(key);
  selections.push(selection);
}

function isRemoveBundleActive(options: {
  repoState?: RepoState;
  worktreeState?: WorktreeState;
  bundle: string;
  source?: string;
}): boolean {
  return (
    (options.repoState?.desired_state.some(
      (entry) =>
        entry.bundle === options.bundle &&
        matchesOptionalSource(entry.source, options.source),
    ) ??
      false) ||
    findMaterializedBundleState({
      worktreeState: options.worktreeState,
      bundle: options.bundle,
      source: options.source,
    }) !== undefined
  );
}

function matchesOptionalSource(
  candidateSource: string | undefined,
  requestedSource: string | undefined,
): boolean {
  return requestedSource === undefined || candidateSource === requestedSource;
}

function matchesBundleIdentity(
  entry: { bundle: string; source?: string },
  bundle: string,
  source: string | undefined,
): boolean {
  return entry.bundle === bundle && matchesOptionalSource(entry.source, source);
}

function findMaterializedBundleState(options: {
  worktreeState?: WorktreeState;
  bundle: string;
  source?: string;
}): MaterializedBundleState | undefined {
  const bundleState =
    options.worktreeState?.materialized_state.bundles[options.bundle];

  if (
    !bundleState ||
    !matchesOptionalSource(bundleState.source, options.source)
  ) {
    return undefined;
  }

  return bundleState;
}

async function removeBundleItems(options: {
  cwd: string;
  prompts: PromptClient;
  registryFile: string;
  libraryDir: string;
  gitContext: ReturnType<typeof requireGitContext>;
  registry: Registry;
  repoState?: RepoState;
  worktreeState?: WorktreeState;
  desiredEntry?: DesiredBundleEntry;
  bundle: string;
  source?: string;
  includeItems: BundleItemSelector[];
  selectItems: boolean;
  dryRun: boolean;
  warnings?: CommandWarningCollector;
}): Promise<{ kind: "completed"; output: string } | { kind: "remove-bundle" }> {
  if (!options.repoState || !options.desiredEntry) {
    throw new Error(
      `Cannot remove selected items from ${options.bundle} because it is not in desired state`,
    );
  }

  const cachedBundle = findCachedBundleWithGuidance({
    libraryDir: options.libraryDir,
    bundle: options.bundle,
    source: options.desiredEntry.source ?? options.source,
  });
  const selectedTools =
    options.desiredEntry.tools ??
    (Object.keys(cachedBundle.manifest.tools) as ToolName[]);
  const availableItems = listSelectableBundleItems({
    bundleDir: path.dirname(cachedBundle.manifestFile),
    manifest: cachedBundle.manifest,
    tools: selectedTools,
  });
  const currentItems = options.desiredEntry.items ?? availableItems;
  const requestedItems = normalizeBundleItemSelectors(options.includeItems);

  assertBundleSupportsRequestedItems({
    requestedItems,
    availableItems,
  });

  const inactiveRequestedItems = requestedItems.filter(
    (item) => !currentItems.includes(item),
  );
  if (inactiveRequestedItems.length > 0) {
    throw new Error(
      `Bundle item(s) are not active in ${options.bundle}: ${inactiveRequestedItems.join(", ")}`,
    );
  }

  const selectedItems = options.selectItems
    ? await options.prompts.selectBundleItems(
        currentItems,
        requestedItems,
        "remove",
      )
    : requestedItems;
  const normalizedSelectedItems = normalizeBundleItemSelectors(selectedItems);
  const inactiveItems = normalizedSelectedItems.filter(
    (item) => !currentItems.includes(item),
  );

  if (inactiveItems.length > 0) {
    throw new Error(
      `Bundle item(s) are not active in ${options.bundle}: ${inactiveItems.join(", ")}`,
    );
  }

  const selectedItemSet = new Set(normalizedSelectedItems);
  const remainingItems = currentItems.filter(
    (item) => !selectedItemSet.has(item),
  );

  if (remainingItems.length === 0) {
    return { kind: "remove-bundle" };
  }

  if (options.dryRun) {
    return {
      kind: "completed",
      output: `${pc.yellow("DRY RUN:")} Would remove ${normalizedSelectedItems.join(", ")} from ${options.bundle}`,
    };
  }

  const nextRegistry = upsertRepoState(
    options.registry,
    options.gitContext.repoFingerprint,
    {
      ...options.repoState,
      repo_root: options.gitContext.repoRoot,
      desired_state: options.repoState.desired_state.map((entry) =>
        entry.bundle === options.bundle &&
        matchesOptionalSource(entry.source, options.source)
          ? { ...entry, items: remainingItems }
          : entry,
      ),
    },
  );

  writeRegistryFile(options.registryFile, nextRegistry);

  try {
    await applyWorktree({
      cwd: options.cwd,
      prompts: options.prompts,
      registryFile: options.registryFile,
      libraryDir: options.libraryDir,
      dryRun: false,
      warnings: options.warnings,
    });
  } catch (error) {
    writeRegistryFile(options.registryFile, options.registry);
    throw error;
  }

  return {
    kind: "completed",
    output: pc.green(
      `Removed ${normalizedSelectedItems.join(", ")} from ${options.bundle}`,
    ),
  };
}

async function applyWorktree(options: {
  cwd: string;
  prompts: PromptClient;
  registryFile: string;
  libraryDir: string;
  dryRun: boolean;
  warnings?: CommandWarningCollector;
}): Promise<string> {
  const gitContext = requireGitContext(options.cwd, "apply");
  let registry = readRegistryWithGuidance(options.registryFile);
  const repoState = registry.repos[gitContext.repoFingerprint];

  if (!repoState || repoState.desired_state.length === 0) {
    return `No bundles configured for this repository. Run "skul add <bundle>" to add one`;
  }

  type ApplyPlan =
    | { uncached: true; entry: DesiredBundleEntry }
    | {
        uncached: false;
        entry: DesiredBundleEntry;
        sourceRevision: CachedSourceRevision | undefined;
        cachedBundle: CachedBundle;
        existingBundleState: MaterializedBundleState | undefined;
        availableTools: ToolName[];
      };

  const worktreeState = registry.worktrees[gitContext.worktreeId];
  const materializedBundles = worktreeState?.materialized_state.bundles ?? {};

  // Ahead of the plan loop, which returns early once every bundle is already
  // materialized — the state a committed managed file is most likely found in.
  if (!options.dryRun) {
    warnAboutCommittedManagedFiles({
      repoRoot: gitContext.worktreeRoot,
      bundles: materializedBundles,
    });
  }

  const cloneLines: string[] = [];
  const applyPlans: ApplyPlan[] = [];
  for (const entry of repoState.desired_state) {
    // In dry-run mode skip actual cloning; if the source is not yet cached we
    // can still report intent without a manifest.
    const sourceRevision = entry.source
      ? readCachedSourceRevision({
          source: entry.source,
          libraryDir: options.libraryDir,
          protocol: entry.protocol,
        })
      : undefined;

    if (entry.source && !sourceRevision?.cached) {
      if (options.dryRun) {
        applyPlans.push({ uncached: true, entry });
        continue;
      }
      // Non-dry-run: fetch the source so the manifest is available below.
      const { cloned } = await fetchRemoteSource({
        source: entry.source,
        libraryDir: options.libraryDir,
        protocol: entry.protocol,
        ref: entry.ref ?? entry.resolved_commit,
        includeRootInstructions: entry.items?.includes("root-instruction"),
      });
      if (cloned) cloneLines.push(pc.dim(`Cloned ${entry.source}`));
    }

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
      continue;
    }

    applyPlans.push({
      uncached: false,
      entry,
      sourceRevision,
      cachedBundle,
      existingBundleState,
      availableTools: Object.keys(cachedBundle.manifest.tools) as ToolName[],
    });
  }

  if (applyPlans.length === 0) {
    return options.dryRun
      ? "DRY RUN: All bundles are already materialized"
      : "All bundles are already materialized";
  }

  if (options.dryRun) {
    const lines = applyPlans.map((plan) => {
      if (plan.uncached) {
        return `DRY RUN: Would clone ${plan.entry.source!} then apply ${plan.entry.bundle}`;
      }
      const tools =
        plan.entry.tools ?? Object.keys(plan.cachedBundle.manifest.tools);
      return `DRY RUN: Would apply ${plan.entry.bundle} for ${tools.join(", ")}`;
    });
    return lines.join("\n");
  }

  let currentBundles: MaterializedState["bundles"] = { ...materializedBundles };
  const mcpOwnership = createMcpMaterializationOwnership(
    worktreeState?.materialized_state,
  );
  let currentShadowedFiles = { ...(worktreeState?.shadowed_files ?? {}) };
  let rootInstructionBaseContents =
    worktreeState?.materialized_state.root_instruction_base_contents;

  for (const plan of applyPlans) {
    if (plan.uncached) continue;
    const {
      entry,
      sourceRevision,
      cachedBundle,
      existingBundleState,
      availableTools,
    } = plan;
    const refreshesExistingBundle =
      existingBundleState !== undefined &&
      entry.resolved_commit !== undefined &&
      existingBundleState.resolved_commit !== entry.resolved_commit;
    const toolsToApply = getToolsToApply({
      desiredEntry: entry,
      materializedBundleState: existingBundleState,
      availableTools,
    });
    const replacementState = refreshesExistingBundle
      ? existingBundleState
      : existingBundleState && toolsToApply
        ? selectExistingBundleToolState(existingBundleState, toolsToApply)
        : existingBundleState;
    const replacementPaths = replacementState
      ? flattenBundleState(replacementState)
      : undefined;
    const replacesExistingToolState =
      replacementPaths !== undefined &&
      (replacementPaths.files.length > 0 ||
        replacementPaths.mcp_servers.length > 0);
    const resolvedBundleItemRefs = await resolveBundleItemRefs({
      bundleDir: path.dirname(cachedBundle.manifestFile),
      manifest: cachedBundle.manifest,
      tools: toolsToApply,
      itemSelectors: entry.items,
      libraryDir: options.libraryDir,
      protocol: entry.protocol,
    });
    const materializationScope: BundleMaterializationScope = {
      repoRoot: gitContext.worktreeRoot,
      bundleDir: path.dirname(cachedBundle.manifestFile),
      manifest: cachedBundle.manifest,
      tools: toolsToApply,
      itemSelectors: entry.items,
      resolvedBundleItemRefs,
    };
    const plannedWriteTargets =
      previewMaterializeBundleWriteTargets(materializationScope);
    const plannedRootInstructionTargets = new Set(
      plannedWriteTargets.filter((filePath) => isRootInstructionPath(filePath)),
    );
    const trackedShadowPlan = planTrackedShadows({
      repoRoot: gitContext.worktreeRoot,
      bundleDir: path.dirname(cachedBundle.manifestFile),
      manifest: cachedBundle.manifest,
      toolNames: selectTrackedShadowToolNames({
        existingBundleState,
        nextToolNames: toolsToApply ?? availableTools,
      }),
      itemSelectors: entry.items,
      targetPaths: plannedRootInstructionTargets,
      bundleName: entry.bundle,
      bundleSource: entry.source,
      rootInstructionMode: entry.root_instruction_mode,
      resolvedBundleItemRefs,
      existingShadowedFiles: currentShadowedFiles,
      materializedBundles: currentBundles,
      libraryDir: options.libraryDir,
    });
    assertRootInstructionModeCompatibility({
      desiredState: repoState.desired_state,
      materializedBundles: currentBundles,
      currentBundle: entry.bundle,
      targetPaths: plannedRootInstructionTargets,
      mode: entry.root_instruction_mode,
    });
    rootInstructionBaseContents = captureRootInstructionBaseContents({
      repoRoot: gitContext.worktreeRoot,
      targetPaths: trackedShadowPlan.untrackedTargetPaths,
      existingBaseContents: rootInstructionBaseContents,
      managedTargetPaths: collectManagedRootInstructionTargets(currentBundles),
    });
    await confirmRootInstructionReplacements({
      repoRoot: gitContext.worktreeRoot,
      targetPaths: plannedRootInstructionTargets,
      mode: entry.root_instruction_mode,
      prompts: options.prompts,
    });

    assertManagedRootInstructionSyncSourcesCached({
      desiredState: repoState.desired_state,
      materializedBundles: currentBundles,
      targetPaths: trackedShadowPlan.untrackedTargetPaths,
      resolveCachedBundle: (entry) =>
        resolveDesiredCachedBundle(options.libraryDir, entry),
    });

    if (replacesExistingToolState && replacementState) {
      assertTrackedRootInstructionShadowSafetyForPaths({
        repoRoot: gitContext.worktreeRoot,
        operation: "refresh",
        filePaths: plannedWriteTargets,
      });

      const replacementAllowed = await confirmManagedFileRemovals(
        gitContext.worktreeRoot,
        excludeShadowedTrackedTargets(
          replacementPaths,
          trackedShadowPlan.deferredMaterializationTargets,
        ),
        options.prompts,
        "replace",
      );

      if (!replacementAllowed) {
        throw new Error(
          "Replacement aborted because a modified managed file was kept",
        );
      }
    }

    const sharedRootInstructionState = collectSharedRootInstructionState(
      currentBundles,
      plannedWriteTargets,
      cachedBundle.bundle,
    );

    if (sharedRootInstructionState.files.length > 0) {
      const replacementAllowed = await confirmManagedFileRemovals(
        gitContext.worktreeRoot,
        sharedRootInstructionState,
        options.prompts,
        "replace",
      );

      if (!replacementAllowed) {
        throw new Error(
          "Replacement aborted because a modified managed file was kept",
        );
      }
    }
    assertTrackedShadowPlanCanApply({
      repoRoot: gitContext.worktreeRoot,
      bundleName: entry.bundle,
      existingShadowedFiles: currentShadowedFiles,
      plan: trackedShadowPlan,
    });

    assertTrackedRootInstructionShadowSafetyForPaths({
      repoRoot: gitContext.worktreeRoot,
      operation: existingBundleState ? "refresh" : "create",
      filePaths: plannedWriteTargets,
    });

    if (replacesExistingToolState && replacementState) {
      const pathsToReplace = excludeShadowedTrackedTargets(
        flattenBundleState(replacementState),
        trackedShadowPlan.deferredMaterializationTargets,
      );
      const replacedRootInstructionPaths = new Set(
        pathsToReplace.files.filter((filePath) =>
          isRootInstructionPath(filePath),
        ),
      );

      removeManagedPaths(gitContext.worktreeRoot, pathsToReplace, {
        restoreCommitted: true,
        mcpOwnership,
        warnings: options.warnings,
      });
      restoreRootInstructionBaseContents({
        repoRoot: gitContext.worktreeRoot,
        baseContents: rootInstructionBaseContents,
        targetPaths: new Set(
          Array.from(replacedRootInstructionPaths).filter(
            (filePath) => !plannedRootInstructionTargets.has(filePath),
          ),
        ),
      });
    }

    const materializedResult = await materializeBundle({
      ...materializationScope,
      bundleName: entry.bundle,
      bundleSource: entry.source,
      assertSafeWriteTarget: createManagedWriteSafetyAssertion({
        repoRoot: gitContext.worktreeRoot,
        operation: existingBundleState ? "refresh" : "create",
      }),
      deferredWriteTargets: trackedShadowPlan.deferredMaterializationTargets,
      rootInstructionBaseContents,
      rootInstructionMode: entry.root_instruction_mode,
      resolveFileConflict: options.prompts.resolveFileConflict,
      libraryDir: options.libraryDir,
      existingMcpServers: ownedMcpServers(existingBundleState),
    });
    mcpOwnership.recordMaterialization(materializedResult);

    currentBundles = {
      ...currentBundles,
      [cachedBundle.bundle]: buildMaterializedBundleState({
        existingBundleState,
        materializedResult,
        repoRoot: gitContext.worktreeRoot,
        source: entry.source,
        resolvedCommit: entry.resolved_commit ?? sourceRevision?.currentCommit,
        selectedTools: refreshesExistingBundle ? undefined : toolsToApply,
        selectedItems: entry.items,
      }),
    };
    currentShadowedFiles = applyTrackedShadowPlan({
      repoRoot: gitContext.worktreeRoot,
      bundleName: entry.bundle,
      existingShadowedFiles: currentShadowedFiles,
      plan: trackedShadowPlan,
    });

    const syncedRootInstructionPaths = syncManagedRootInstructionFiles({
      repoRoot: gitContext.worktreeRoot,
      desiredState: repoState.desired_state,
      materializedBundles: currentBundles,
      rootInstructionBaseContents,
      targetPaths: trackedShadowPlan.untrackedTargetPaths,
      resolveCachedBundle: (entry) =>
        resolveDesiredCachedBundle(options.libraryDir, entry),
      resolvedBundleItemRefsByBundle:
        await resolveMaterializedBundleItemRefsByBundle({
          desiredState: repoState.desired_state,
          materializedBundles: currentBundles,
          libraryDir: options.libraryDir,
          seed: new Map([[entry.bundle, resolvedBundleItemRefs]]),
          itemSelectors: ["root-instruction"],
        }),
    });
    currentBundles = refreshManagedFileFingerprintsForPaths(
      gitContext.worktreeRoot,
      currentBundles,
      syncedRootInstructionPaths,
    );

    const newMatState: MaterializedState = {
      bundles: currentBundles,
      exclude_configured: false,
      ...mcpOwnership.toRegistryFields(),
      ...(rootInstructionBaseContents !== undefined
        ? { root_instruction_base_contents: rootInstructionBaseContents }
        : {}),
    };

    const managedFiles = collectExcludedPaths(newMatState);
    newMatState.exclude_configured = managedFiles.length > 0;

    if (managedFiles.length > 0) {
      configureSkulExcludeBlock({
        gitDir: gitContext.gitDir,
        files: managedFiles,
      });
    } else {
      removeSkulExcludeBlock({ gitDir: gitContext.gitDir });
    }

    registry = upsertWorktreeState(registry, gitContext.worktreeId, {
      repo_fingerprint: gitContext.repoFingerprint,
      path: gitContext.worktreeRoot,
      materialized_state: newMatState,
      shadowed_files: currentShadowedFiles,
    });
    writeRegistryFile(options.registryFile, registry);
  }

  const appliedNames = applyPlans.map(({ entry }) => entry.bundle).join(", ");
  return [...cloneLines, pc.green(`Applied ${appliedNames}`)].join("\n");
}

interface PlannedTrackedShadow {
  filePath: string;
  rendered: string;
  state: ShadowedFileState;
}

interface TrackedShadowPlan {
  writes: PlannedTrackedShadow[];
  deferredMaterializationTargets: Set<string>;
  untrackedTargetPaths: Set<string>;
  activeShadowPaths: Set<string>;
}

function selectTrackedShadowToolNames(options: {
  existingBundleState?: MaterializedBundleState;
  nextToolNames: ToolName[];
}): ToolName[] {
  return Array.from(
    new Set([
      ...(options.existingBundleState
        ? (Object.keys(options.existingBundleState.tools) as ToolName[])
        : []),
      ...options.nextToolNames,
    ]),
  ) as ToolName[];
}

async function resolveMaterializedBundleItemRefsByBundle(options: {
  desiredState: DesiredBundleEntry[];
  materializedBundles: MaterializedState["bundles"];
  libraryDir: string;
  seed?: ReadonlyMap<string, ReadonlyMap<string, ResolvedBundleItemRef>>;
  itemSelectors?: BundleItemSelector[];
}): Promise<Map<string, ReadonlyMap<string, ResolvedBundleItemRef>>> {
  const resolvedByBundle = new Map(options.seed);

  for (const desiredEntry of options.desiredState) {
    if (resolvedByBundle.has(desiredEntry.bundle)) {
      continue;
    }

    const materializedBundleState =
      options.materializedBundles[desiredEntry.bundle];

    if (!materializedBundleState) {
      continue;
    }

    const cachedBundle = resolveDesiredCachedBundle(
      options.libraryDir,
      desiredEntry,
    );
    const resolvedBundleItemRefs = await resolveBundleItemRefs({
      bundleDir: path.dirname(cachedBundle.manifestFile),
      manifest: cachedBundle.manifest,
      tools: Object.keys(materializedBundleState.tools) as ToolName[],
      itemSelectors: intersectDesiredItemSelectors({
        desiredItems: desiredEntry.items,
        itemSelectors: options.itemSelectors,
      }),
      libraryDir: options.libraryDir,
      protocol: desiredEntry.protocol,
    });

    if (resolvedBundleItemRefs.size > 0) {
      resolvedByBundle.set(desiredEntry.bundle, resolvedBundleItemRefs);
    }
  }

  return resolvedByBundle;
}

function intersectDesiredItemSelectors(options: {
  desiredItems?: BundleItemSelector[];
  itemSelectors?: BundleItemSelector[];
}): BundleItemSelector[] | undefined {
  if (!options.itemSelectors) {
    return options.desiredItems;
  }

  if (!options.desiredItems) {
    return options.itemSelectors;
  }

  return options.itemSelectors.filter((item) =>
    options.desiredItems?.includes(item),
  );
}

function planTrackedShadows(options: {
  repoRoot: string;
  bundleDir: string;
  manifest: CachedBundle["manifest"];
  toolNames: ToolName[];
  itemSelectors?: BundleItemSelector[];
  targetPaths: Set<string>;
  bundleName: string;
  bundleSource?: string;
  rootInstructionMode?: RootInstructionMode;
  resolvedBundleItemRefs?: ReadonlyMap<string, ResolvedBundleItemRef>;
  existingShadowedFiles: Record<string, ShadowedFileState>;
  materializedBundles: MaterializedState["bundles"];
  libraryDir?: string;
}): TrackedShadowPlan {
  const activeOverlayContents = collectComposedRootInstructionContents({
    bundleDir: options.bundleDir,
    manifest: options.manifest,
    toolNames: options.toolNames,
    itemSelectors: options.itemSelectors,
    resolvedBundleItemRefs: options.resolvedBundleItemRefs,
  });
  const activeRootInstructionPaths = new Set(
    Object.keys(activeOverlayContents).filter((targetPath) =>
      isRootInstructionPath(targetPath),
    ),
  );
  const trackedTargetPaths = new Set<string>();

  for (const targetPath of activeRootInstructionPaths) {
    const inspection = inspectTrackedShadowTarget({
      repoRoot: options.repoRoot,
      filePath: targetPath,
    });

    if (inspection.tracked) {
      trackedTargetPaths.add(targetPath);
    }
  }

  const mcpWrites = planTrackedMcpShadows(options);

  for (const write of mcpWrites) {
    trackedTargetPaths.add(write.filePath);
  }

  // Runs once both kinds of target are known: a shadow renders one bundle's
  // overlay onto committed content, so a second bundle claiming the same file
  // would silently replace the first bundle's contribution.
  assertTrackedShadowConflicts({
    targetPaths: trackedTargetPaths,
    bundleName: options.bundleName,
    existingShadowedFiles: options.existingShadowedFiles,
    materializedBundles: options.materializedBundles,
  });

  if (trackedTargetPaths.size === 0) {
    return {
      writes: [],
      deferredMaterializationTargets: trackedTargetPaths,
      untrackedTargetPaths: new Set(activeRootInstructionPaths),
      activeShadowPaths: trackedTargetPaths,
    };
  }

  const writes = Array.from(options.targetPaths)
    .filter((targetPath) => trackedTargetPaths.has(targetPath))
    .map((targetPath) =>
      renderTrackedRootInstructionShadowWrite({
        repoRoot: options.repoRoot,
        filePath: targetPath,
        overlayContent: activeOverlayContents[targetPath] ?? "",
        bundleName: options.bundleName,
        toolName: selectShadowToolForPath(options.toolNames, targetPath),
        strategy: options.rootInstructionMode ?? "append",
      }),
    );
  const untrackedTargetPaths = new Set(
    Array.from(activeRootInstructionPaths).filter(
      (targetPath) => !trackedTargetPaths.has(targetPath),
    ),
  );
  return {
    writes: [...writes, ...mcpWrites],
    deferredMaterializationTargets: trackedTargetPaths,
    untrackedTargetPaths,
    activeShadowPaths: trackedTargetPaths,
  };
}

/**
 * Plans shadows for MCP configuration files the repository commits.
 *
 * The overlay stored for each is the bundle's servers already translated into
 * the tool's vocabulary, so a later refresh can fold them into a new committed
 * base without needing the bundle cache again.
 */
function planTrackedMcpShadows(options: {
  repoRoot: string;
  bundleDir: string;
  manifest: CachedBundle["manifest"];
  toolNames: ToolName[];
  itemSelectors?: BundleItemSelector[];
  bundleName: string;
  libraryDir?: string;
}): PlannedTrackedShadow[] {
  if (!isMcpItemSelected(options.itemSelectors)) {
    return [];
  }

  const writes: PlannedTrackedShadow[] = [];
  // Tools may point at different declaration files, but most point at the same
  // one, so each is read and parsed at most once.
  const declarationsBySource = new Map<string, Record<string, McpServer>>();

  for (const toolName of options.toolNames) {
    const sourcePath = options.manifest.tools[toolName]?.mcp?.path;
    const filePath = resolveMcpRepoRelPath({
      toolName,
      repoRoot: options.repoRoot,
    });

    if (!sourcePath || !filePath) {
      continue;
    }

    // One inspection answers "is it tracked", "what is committed", and "is it
    // safe to shadow" together, which is what the tracked path needs anyway.
    const inspection = inspectTrackedShadowTarget({
      repoRoot: options.repoRoot,
      filePath,
    });

    if (!inspection.tracked) {
      continue;
    }

    // A tracked target Skul cannot shadow safely — no HEAD content, staged
    // changes, an unmerged entry — must stop the bundle rather than fall
    // through to a direct write that would dirty the committed file.
    assertTrackedShadowSafety({
      repoRoot: options.repoRoot,
      filePath,
      operation: "create",
    });

    const headBlob = inspection.headBlob;

    if (!headBlob) {
      continue;
    }

    let servers = declarationsBySource.get(sourcePath);

    if (!servers) {
      servers = readBundleMcpDeclarations({
        bundleDir: options.bundleDir,
        sourcePath,
      });
      declarationsBySource.set(sourcePath, servers);
    }

    const overlay = JSON.stringify(
      renderMcpServers({
        toolName,
        servers,
        pluginPaths: resolveMcpPluginPaths({
          bundleDir: options.bundleDir,
          ...(options.libraryDir ? { libraryDir: options.libraryDir } : {}),
        }),
      }),
    );
    const render = renderTrackedShadow({
      baseContent: headBlob.content,
      overlay,
      bundleName: options.bundleName,
      toolName,
      strategy: "merge",
      filePath,
    });

    writes.push({
      filePath,
      rendered: render.rendered,
      state: {
        tool: toolName,
        bundle: options.bundleName,
        strategy: "merge",
        base_blob: headBlob.objectId,
        overlay,
        overlay_fingerprint: render.overlayFingerprint,
        rendered_fingerprint: render.renderedFingerprint,
        skip_worktree: true,
      },
    });
  }

  return writes;
}

/** Rejects append/replace mixtures before any bundle files are removed or written. */
function assertRootInstructionModeCompatibility(options: {
  desiredState: DesiredBundleEntry[];
  materializedBundles: MaterializedState["bundles"];
  currentBundle: string;
  targetPaths: Set<string>;
  mode?: RootInstructionMode;
}): void {
  const mode = options.mode ?? "append";

  for (const entry of options.desiredState) {
    if (entry.bundle === options.currentBundle) {
      continue;
    }

    const materializedBundle = options.materializedBundles[entry.bundle];
    if (!materializedBundle) {
      continue;
    }

    const sharesRootPath = Object.values(materializedBundle.tools).some(
      (toolState) =>
        toolState.files.some((filePath) => options.targetPaths.has(filePath)),
    );
    if (!sharesRootPath) {
      continue;
    }

    const existingMode = entry.root_instruction_mode ?? "append";
    if (existingMode !== mode) {
      throw new Error(
        `Cannot compose shared root instructions with mixed modes: ${existingMode} and ${mode}`,
      );
    }
  }
}

function assertTrackedShadowConflicts(options: {
  targetPaths: Set<string>;
  bundleName: string;
  existingShadowedFiles: Record<string, ShadowedFileState>;
  materializedBundles: MaterializedState["bundles"];
}): void {
  for (const targetPath of options.targetPaths) {
    const existingShadow = options.existingShadowedFiles[targetPath];

    if (existingShadow && existingShadow.bundle !== options.bundleName) {
      throw new Error(
        `Cannot shadow the tracked file ${targetPath} for ${options.bundleName} because it is already shadowed by ${existingShadow.bundle}`,
      );
    }

    for (const [bundleName, bundleState] of Object.entries(
      options.materializedBundles,
    )) {
      if (bundleName === options.bundleName) {
        continue;
      }

      const ownsPath = Object.values(bundleState.tools).some((toolState) =>
        toolState.files.includes(targetPath),
      );

      if (ownsPath) {
        throw new Error(
          `Cannot shadow the tracked file ${targetPath} for ${options.bundleName} because it is already managed by ${bundleName}`,
        );
      }
    }
  }
}

function renderTrackedRootInstructionShadowWrite(options: {
  repoRoot: string;
  filePath: string;
  overlayContent: string;
  bundleName: string;
  toolName: ToolName;
  strategy: RootInstructionMode;
}): PlannedTrackedShadow {
  const inspection = inspectTrackedShadowTarget({
    repoRoot: options.repoRoot,
    filePath: options.filePath,
  });

  if (!inspection.headBlob) {
    throw new Error(
      `Cannot create a tracked shadow for ${options.filePath} because the target does not have HEAD content`,
    );
  }

  const render = renderTrackedRootInstructionShadow({
    baseContent: inspection.headBlob.content,
    overlayContent: options.overlayContent,
    bundleName: options.bundleName,
    toolName: options.toolName,
    strategy: options.strategy,
    allowReplace: options.strategy === "replace",
  });

  return {
    filePath: options.filePath,
    rendered: render.rendered,
    state: {
      tool: options.toolName,
      bundle: options.bundleName,
      strategy: options.strategy,
      base_blob: inspection.headBlob.objectId,
      overlay: options.overlayContent,
      overlay_fingerprint: render.overlayFingerprint,
      rendered_fingerprint: render.renderedFingerprint,
      skip_worktree: true,
    },
  };
}

function selectShadowToolForPath(
  toolNames: ToolName[],
  filePath: string,
): ToolName {
  const matchingTool = toolNames.find(
    (toolName) =>
      getToolDefinition(toolName)?.targets.root_instruction?.path === filePath,
  );

  if (matchingTool) {
    return matchingTool;
  }

  if (filePath === "AGENTS.md") {
    return "codex";
  }

  return toolNames.find((toolName) => toolName !== "codex") ?? "claude-code";
}

function applyTrackedShadowPlan(options: {
  repoRoot: string;
  bundleName: string;
  existingShadowedFiles: Record<string, ShadowedFileState>;
  plan: TrackedShadowPlan;
}): Record<string, ShadowedFileState> {
  const nextShadowedFiles = { ...options.existingShadowedFiles };

  for (const [filePath, shadowedFile] of Object.entries(
    options.existingShadowedFiles,
  )) {
    if (
      shadowedFile.bundle !== options.bundleName ||
      options.plan.activeShadowPaths.has(filePath)
    ) {
      continue;
    }

    assertTrackedShadowRetirementSafety({
      repoRoot: options.repoRoot,
      filePath,
      existingShadowedFile: shadowedFile,
    });
    restoreTrackedShadowTarget({
      repoRoot: options.repoRoot,
      filePath,
    });
    delete nextShadowedFiles[filePath];
  }

  for (const write of options.plan.writes) {
    const targetPath = path.join(options.repoRoot, write.filePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, write.rendered);
    setGitSkipWorktree({
      repoRoot: options.repoRoot,
      filePath: write.filePath,
    });
    nextShadowedFiles[write.filePath] = write.state;
  }

  return nextShadowedFiles;
}

function assertTrackedShadowPlanCanApply(options: {
  repoRoot: string;
  bundleName: string;
  existingShadowedFiles: Record<string, ShadowedFileState>;
  plan: TrackedShadowPlan;
}): void {
  for (const [filePath, shadowedFile] of Object.entries(
    options.existingShadowedFiles,
  )) {
    if (
      shadowedFile.bundle !== options.bundleName ||
      options.plan.activeShadowPaths.has(filePath)
    ) {
      continue;
    }

    assertTrackedShadowRetirementSafety({
      repoRoot: options.repoRoot,
      filePath,
      existingShadowedFile: shadowedFile,
    });
  }

  for (const write of options.plan.writes) {
    assertTrackedShadowWriteSafety({
      repoRoot: options.repoRoot,
      filePath: write.filePath,
      existingShadowedFile: options.existingShadowedFiles[write.filePath],
      operation: options.existingShadowedFiles[write.filePath]
        ? "refresh"
        : "create",
    });
  }
}

function assertTrackedShadowWriteSafety(options: {
  repoRoot: string;
  filePath: string;
  existingShadowedFile: ShadowedFileState | undefined;
  operation: "create" | "refresh";
}): void {
  assertTrackedShadowSafety({
    repoRoot: options.repoRoot,
    filePath: options.filePath,
    operation: options.operation,
  });

  if (!options.existingShadowedFile) {
    return;
  }

  const targetPath = path.join(options.repoRoot, options.filePath);

  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
    throw new Error(
      `Cannot refresh tracked shadow for ${options.filePath} because the current shadow file is missing`,
    );
  }

  if (
    fingerprintFile(targetPath) !==
    options.existingShadowedFile.rendered_fingerprint
  ) {
    throw new Error(
      `Cannot refresh tracked shadow for ${options.filePath} because the current worktree content no longer matches Skul's recorded render`,
    );
  }
}

function assertTrackedShadowRetirementSafety(options: {
  repoRoot: string;
  filePath: string;
  existingShadowedFile: ShadowedFileState;
}): void {
  const targetPath = path.join(options.repoRoot, options.filePath);

  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
    throw new Error(
      `Cannot retire the shadow of ${options.filePath} because the current shadow file is missing`,
    );
  }

  if (
    fingerprintFile(targetPath) !==
    options.existingShadowedFile.rendered_fingerprint
  ) {
    throw new Error(
      `Cannot retire the shadow of ${options.filePath} because the current worktree content no longer matches what Skul wrote`,
    );
  }
}

function retireTrackedShadows(options: {
  repoRoot: string;
  shadowedFiles: Record<string, ShadowedFileState>;
  filePaths: string[];
}): Record<string, ShadowedFileState> {
  const nextShadowedFiles = { ...options.shadowedFiles };

  for (const filePath of options.filePaths) {
    const shadowedFile = nextShadowedFiles[filePath];

    if (!shadowedFile) {
      continue;
    }

    assertTrackedShadowRetirementSafety({
      repoRoot: options.repoRoot,
      filePath,
      existingShadowedFile: shadowedFile,
    });
  }

  for (const filePath of options.filePaths) {
    const shadowedFile = nextShadowedFiles[filePath];

    if (!shadowedFile) {
      continue;
    }

    assertTrackedShadowRetirementSafety({
      repoRoot: options.repoRoot,
      filePath,
      existingShadowedFile: shadowedFile,
    });
    restoreTrackedShadowTarget({
      repoRoot: options.repoRoot,
      filePath,
    });
    delete nextShadowedFiles[filePath];
  }

  return nextShadowedFiles;
}

function restoreTrackedShadowTarget(options: {
  repoRoot: string;
  filePath: string;
}): void {
  const inspection = inspectTrackedShadowTarget({
    repoRoot: options.repoRoot,
    filePath: options.filePath,
  });

  if (!inspection.headBlob) {
    throw new Error(
      `Cannot restore the tracked shadow target for ${options.filePath} because the target does not have HEAD content`,
    );
  }

  const targetPath = path.join(options.repoRoot, options.filePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, inspection.headBlob.content);
  clearGitSkipWorktree({
    repoRoot: options.repoRoot,
    filePath: options.filePath,
  });
}

type FingerprintedRemovalState = ManagedRemovalState & {
  file_fingerprints: Record<string, string>;
};

function excludeShadowedTrackedTargets(
  state: FingerprintedRemovalState,
  deferredMaterializationTargets: Set<string>,
): FingerprintedRemovalState {
  if (deferredMaterializationTargets.size === 0) {
    return state;
  }

  const files = state.files.filter(
    (filePath) => !deferredMaterializationTargets.has(filePath),
  );
  const fileFingerprints = Object.fromEntries(
    Object.entries(state.file_fingerprints).filter(
      ([filePath]) => !deferredMaterializationTargets.has(filePath),
    ),
  );

  return {
    files,
    file_fingerprints: fileFingerprints,
    ...(state.directories !== undefined
      ? { directories: state.directories }
      : {}),
    mcp_servers: state.mcp_servers,
  };
}

function isDesiredBundleMaterialized(options: {
  desiredEntry: DesiredBundleEntry;
  materializedBundleState: MaterializedBundleState;
  availableTools: ToolName[];
}): boolean {
  const expectedTools = options.desiredEntry.tools ?? options.availableTools;

  return (
    expectedTools.every(
      (toolName) =>
        toolName in options.materializedBundleState.tools &&
        bundleItemSelectionsEqual(
          options.desiredEntry.items,
          options.materializedBundleState.tools[toolName]?.items,
        ),
    ) &&
    (options.desiredEntry.resolved_commit === undefined ||
      options.materializedBundleState.resolved_commit ===
        options.desiredEntry.resolved_commit)
  );
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

  if (
    options.desiredEntry.resolved_commit !== undefined &&
    options.materializedBundleState.resolved_commit !==
      options.desiredEntry.resolved_commit
  ) {
    return options.desiredEntry.tools ?? options.availableTools;
  }

  const existingTools = options.materializedBundleState.tools;

  return expectedTools.filter(
    (toolName) =>
      !(toolName in existingTools) ||
      !bundleItemSelectionsEqual(
        options.desiredEntry.items,
        existingTools[toolName]?.items,
      ),
  );
}

// Flatten all files and directories from every tool within a single bundle
function flattenBundleState(
  bundleState: MaterializedBundleState,
): FingerprintedRemovalState & { directories: string[] } {
  const files = new Set<string>();
  const file_fingerprints: Record<string, string> = {};
  const directories = new Set<string>();
  const toolEntries = Object.entries(bundleState.tools) as Array<
    [ToolName, (typeof bundleState.tools)[string]]
  >;

  for (const [, toolState] of toolEntries) {
    for (const file of toolState.files) {
      files.add(file);
    }
    if (toolState.file_fingerprints)
      Object.assign(file_fingerprints, toolState.file_fingerprints);
    if (toolState.directories) {
      for (const directory of toolState.directories) {
        directories.add(directory);
      }
    }
  }

  return {
    files: Array.from(files),
    file_fingerprints,
    directories: Array.from(directories),
    mcp_servers: mergeMcpServerOwnership(
      toolEntries.map(([toolName, toolState]) =>
        Object.entries(toolState.mcp_servers ?? {}).map(
          ([filePath, servers]) => ({
            tool: toolName,
            path: filePath,
            servers,
          }),
        ),
      ),
    ),
  };
}

/**
 * The MCP servers a bundle already holds, for a re-materialization to replace.
 *
 * Materialization looks these up by configuration path, so the shape it wants
 * is not the one a removal wants; converting here keeps that difference out of
 * every caller that re-applies a bundle.
 */
function ownedMcpServers(
  bundleState?: MaterializedBundleState,
): Record<string, string[]> {
  if (!bundleState) {
    return {};
  }

  return Object.fromEntries(
    flattenBundleState(bundleState).mcp_servers.map((ownership) => [
      ownership.path,
      ownership.servers,
    ]),
  );
}

function selectExistingBundleToolState(
  bundleState: MaterializedBundleState,
  toolNames: ToolName[],
): MaterializedBundleState {
  return {
    ...(bundleState.source !== undefined ? { source: bundleState.source } : {}),
    ...(bundleState.resolved_commit !== undefined
      ? { resolved_commit: bundleState.resolved_commit }
      : {}),
    tools: Object.fromEntries(
      toolNames.flatMap((toolName) => {
        const toolState = bundleState.tools[toolName];
        return toolState ? [[toolName, toolState]] : [];
      }),
    ),
  };
}

// Build per-tool registry entries from a materialization result
function buildMaterializedToolStates(
  repoRoot: string,
  result: MaterializeBundleResult,
  selectedItems?: BundleItemSelector[],
): Record<string, MaterializedToolState> {
  return Object.fromEntries(
    Object.entries(result.byTool).map(([toolName, toolResult]) => [
      toolName,
      {
        files: toolResult.files,
        file_fingerprints: captureManagedFileFingerprints(
          repoRoot,
          toolResult.files.filter(
            (filePath) => !toolResult.sharedFiles.includes(filePath),
          ),
        ),
        ...(toolResult.directories.length > 0
          ? { directories: toolResult.directories }
          : {}),
        ...(selectedItems !== undefined ? { items: selectedItems } : {}),
        ...(Object.keys(toolResult.mcpServers).length > 0
          ? { mcp_servers: toolResult.mcpServers }
          : {}),
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
  selectedItems?: BundleItemSelector[];
}): MaterializedBundleState {
  const preservedTools =
    options.existingBundleState && options.selectedTools
      ? Object.fromEntries(
          Object.entries(options.existingBundleState.tools).filter(
            ([toolName]) =>
              !options.selectedTools!.includes(toolName as ToolName),
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
      ...buildMaterializedToolStates(
        options.repoRoot,
        options.materializedResult,
        options.selectedItems,
      ),
    },
  };
}

// Collect all files across every bundle and tool for git-exclude configuration
/**
 * Collects every path Skul writes to, for the `.git/info/exclude` block.
 *
 * Shared MCP configuration counts even though Skul does not own those files:
 * while Skul's servers are merged in, the file carries expanded absolute paths
 * from the machine it was materialized on, which should not turn up in
 * `git status` waiting to be committed. Removal takes the servers back out and
 * the path leaves the block with them.
 */
function collectExcludedPaths(materializedState: MaterializedState): string[] {
  return Array.from(
    new Set([
      ...listManagedFiles(materializedState.bundles),
      ...Object.values(materializedState.bundles).flatMap((bundleState) =>
        Object.values(bundleState.tools).flatMap((toolState) =>
          Object.keys(toolState.mcp_servers ?? {}),
        ),
      ),
    ]),
  );
}

/**
 * Warns once about files Skul materialized that the repository has committed.
 *
 * `.git/info/exclude` keeps them out of `git status`, but `git add -f`, another
 * worktree, or a global `add -A` alias all get past that. What lands in history
 * is machine-specific: `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` expand to absolute
 * paths under the home directory of whoever materialized the bundle, so every
 * other clone pulls a configuration that resolves nowhere.
 *
 * Only paths recorded in `files` qualify. A configuration that was already
 * tracked when Skul first saw it is carried by the shadow lifecycle and never
 * recorded there, which leaves this scan to the one case it is about: a file
 * Skul created that the repository has since committed.
 */
function warnAboutCommittedManagedFiles(options: {
  repoRoot: string;
  bundles: MaterializedState["bundles"];
}): void {
  const committedPaths = Array.from(
    listCommittedPaths({
      repoRoot: options.repoRoot,
      filePaths: listManagedFiles(options.bundles),
    }),
  )
    .filter((filePath) => !reportedCommittedPaths.has(filePath))
    .sort();

  if (committedPaths.length === 0) {
    return;
  }

  for (const filePath of committedPaths) {
    reportedCommittedPaths.add(filePath);
  }

  console.warn(
    `[skul] Committed by the repository, but written by Skul: ${committedPaths.join(", ")}`,
  );
  console.warn(
    "[skul] These hold absolute paths from this machine, so another clone cannot resolve them.",
  );
  console.warn(formatUntrackHint(committedPaths));
}

/** Every repo-relative file path the given bundles have materialized. */
function listManagedFiles(bundles: MaterializedState["bundles"]): string[] {
  return Array.from(
    new Set(
      Object.values(bundles).flatMap((bundleState) =>
        Object.values(bundleState.tools).flatMap(
          (toolState) => toolState.files,
        ),
      ),
    ),
  );
}

/**
 * Subtracts a bundle's MCP servers from the shared configuration files holding
 * them, returning the paths whose files may now be deleted outright.
 *
 * The subtracted document is always written back. Deletion is reserved for a
 * file Skul itself created that now holds nothing else: a configuration that
 * was already on disk belongs to the user even once Skul's servers leave it,
 * and deleting it would discard their own settings along with ours.
 */
function releaseManagedMcpServers(options: {
  repoRoot: string;
  mcpServers: ManagedMcpOwnership[];
  mcpOwnership: McpMaterializationOwnership;
  warnings?: CommandWarningCollector;
}): { releasablePaths: Set<string>; failedMcpServers: ManagedMcpOwnership[] } {
  const releasablePaths = new Set<string>();
  const failedMcpServers: ManagedMcpOwnership[] = [];

  for (const {
    tool: toolName,
    path: relativePath,
    servers: serverNames,
  } of options.mcpServers) {
    const targetPath = path.join(options.repoRoot, ...relativePath.split("/"));

    if (!fs.existsSync(targetPath)) {
      releasablePaths.add(relativePath);
      options.mcpOwnership.removeCreatedFile(relativePath);
      continue;
    }

    // Removal must always be able to finish. A configuration Skul cannot parse
    // — a JSONC comment in .vscode/mcp.json, say — is left for the user to fix
    // rather than blocking `skul remove` and `skul reset` with no way out. The
    // servers are named because this is the last moment Skul knows them.
    let result: McpSubtractResult;
    try {
      result = subtractMcpConfigServers({
        toolName,
        existingContent: fs.readFileSync(targetPath, "utf8"),
        serverNames,
        configPath: relativePath,
      });
    } catch (error) {
      reportCommandWarning(
        `[skul] Leaving ${relativePath} untouched: ${
          error instanceof Error ? error.message : String(error)
        }\n[skul] Remove these MCP servers by hand once it parses: ${serverNames.join(", ")}`,
        options.warnings,
      );
      failedMcpServers.push({
        tool: toolName,
        path: relativePath,
        servers: serverNames,
      });
      continue;
    }

    if (result.emptied && options.mcpOwnership.hasCreatedFile(relativePath)) {
      releasablePaths.add(relativePath);
      options.mcpOwnership.removeCreatedFile(relativePath);
      continue;
    }

    writeFileAtomic(targetPath, result.content);
  }

  return { releasablePaths, failedMcpServers };
}

/**
 * Deletes a bundle's managed paths and subtracts its servers from shared ones.
 *
 * With `restoreCommitted`, a managed file the repository has since committed is
 * checked back out of `HEAD` instead of being deleted. Skul wrote the file, but
 * committing it made it the repository's; deleting it would only leave a
 * pending deletion for the user to resolve by hand. Callers working in a Git
 * worktree ask for it; the global flows write under a home directory that is
 * not a repository root, which is the only root `HEAD` can be read against.
 */
function removeManagedPaths(
  repoRoot: string,
  state: Parameters<typeof listManagedPathsForRemoval>[0] &
    Pick<ManagedRemovalState, "mcp_servers">,
  options: {
    restoreCommitted: boolean;
    mcpOwnership: McpMaterializationOwnership;
    warnings?: CommandWarningCollector;
  },
): { failedMcpServers: ManagedMcpOwnership[] } {
  const releaseResult = releaseManagedMcpServers({
    repoRoot,
    mcpServers: state.mcp_servers,
    mcpOwnership: options.mcpOwnership,
    warnings: options.warnings,
  });
  const releasableMcpPaths = releaseResult.releasablePaths;
  const retainedMcpPaths = new Set(
    state.mcp_servers
      .map((ownership) => ownership.path)
      .filter((filePath) => !releasableMcpPaths.has(filePath)),
  );
  const removableFiles = new Set([...state.files, ...releasableMcpPaths]);
  const removableDirectories = new Set([
    ...(state.directories ?? []),
    ...options.mcpOwnership.listCreatedDirectories(),
  ]);
  const committedPaths = options.restoreCommitted
    ? listCommittedPaths({ repoRoot, filePaths: Array.from(removableFiles) })
    : new Set<string>();
  const restoredPaths: string[] = [];

  for (const relativePath of listManagedPathsForRemoval({
    files: Array.from(removableFiles),
    directories: Array.from(removableDirectories),
  })) {
    if (retainedMcpPaths.has(relativePath)) {
      continue;
    }

    // Ahead of the existence check: a committed file already deleted from the
    // worktree is restored too, since that deletion is itself pending in Git.
    if (committedPaths.has(relativePath)) {
      restoredPaths.push(relativePath);
      continue;
    }

    const targetPath = path.join(repoRoot, relativePath);

    if (!fs.existsSync(targetPath)) {
      options.mcpOwnership.removeCreatedDirectory(relativePath);
      continue;
    }

    const stats = fs.lstatSync(targetPath);

    if (stats.isDirectory()) {
      try {
        fs.rmdirSync(targetPath);
        options.mcpOwnership.removeCreatedDirectory(relativePath);
      } catch (error) {
        if (!isDirectoryNotEmptyError(error)) {
          throw error;
        }
      }
      continue;
    }

    fs.rmSync(targetPath, { force: true });
  }

  reportCommittedRemovalOutcome({
    repoRoot,
    restoredPaths,
    modifiedPaths: Array.from(retainedMcpPaths).filter((filePath) =>
      committedPaths.has(filePath),
    ),
    warnings: options.warnings,
  });

  return { failedMcpServers: releaseResult.failedMcpServers };
}

function retainFailedMcpBundleState(
  bundleState: MaterializedBundleState,
  failedMcpServers: ManagedMcpOwnership[],
): MaterializedBundleState | undefined {
  const failedByTool = new Map<string, Set<string>>();
  for (const ownership of failedMcpServers) {
    const paths = failedByTool.get(ownership.tool) ?? new Set<string>();
    paths.add(ownership.path);
    failedByTool.set(ownership.tool, paths);
  }

  const tools = Object.fromEntries(
    Object.entries(bundleState.tools).flatMap(([toolName, toolState]) => {
      const failedPaths = failedByTool.get(toolName);
      const mcpServers = Object.fromEntries(
        Object.entries(toolState.mcp_servers ?? {}).filter(([filePath]) =>
          failedPaths?.has(filePath),
        ),
      );
      return Object.keys(mcpServers).length > 0
        ? [
            [
              toolName,
              {
                files: [],
                mcp_servers: mcpServers,
              } satisfies MaterializedToolState,
            ],
          ]
        : [];
    }),
  );

  return Object.keys(tools).length > 0
    ? {
        ...(bundleState.source !== undefined
          ? { source: bundleState.source }
          : {}),
        ...(bundleState.resolved_commit !== undefined
          ? { resolved_commit: bundleState.resolved_commit }
          : {}),
        tools,
      }
    : undefined;
}

function retainFailedMcpBundleStates(
  bundleStates: Record<string, MaterializedBundleState>,
  failedMcpServers: ManagedMcpOwnership[],
): Record<string, MaterializedBundleState> {
  return Object.fromEntries(
    Object.entries(bundleStates).flatMap(([bundleName, bundleState]) => {
      const retained = retainFailedMcpBundleState(
        bundleState,
        failedMcpServers,
      );
      return retained ? [[bundleName, retained]] : [];
    }),
  );
}

/**
 * Restores the committed paths a removal declined to delete, and says so.
 *
 * A path whose file still holds another owner's servers cannot be restored —
 * subtraction has already rewritten it and that content is now correct — so it
 * is only reported, keeping the modification from going by unexplained.
 */
function reportCommittedRemovalOutcome(options: {
  repoRoot: string;
  restoredPaths: string[];
  modifiedPaths: string[];
  warnings?: CommandWarningCollector;
}): void {
  const restoredPaths = [...options.restoredPaths].sort();
  const modifiedPaths = [...options.modifiedPaths].sort();
  const restored =
    restoredPaths.length > 0 &&
    restoreCommittedPaths({
      repoRoot: options.repoRoot,
      filePaths: restoredPaths,
    });

  if (restored) {
    reportCommandWarning(
      `[skul] Committed by the repository, so checked out from HEAD instead of deleted: ${restoredPaths.join(", ")}`,
      options.warnings,
    );
    reportCommandWarning(
      "[skul] They now hold exactly what HEAD has; any local edits to them are gone.",
      options.warnings,
    );
  } else if (restoredPaths.length > 0) {
    reportCommandWarning(
      `[skul] Left in place but could not be checked out from HEAD: ${restoredPaths.join(", ")}`,
      options.warnings,
    );
  }

  if (modifiedPaths.length > 0) {
    reportCommandWarning(
      `[skul] Committed by the repository and left modified, because other servers remain in ${modifiedPaths.length === 1 ? "it" : "them"}: ${modifiedPaths.join(", ")}`,
      options.warnings,
    );
  }

  const untrackPaths = [...restoredPaths, ...modifiedPaths];

  if (untrackPaths.length > 0) {
    reportCommandWarning(formatUntrackHint(untrackPaths), options.warnings);
  }
}

/** The line every committed-managed-file warning ends on. */
function formatUntrackHint(relativePaths: string[]): string {
  return `[skul] Untrack with: git rm --cached ${relativePaths.join(" ")}`;
}

function isDirectoryNotEmptyError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && error.code === "ENOTEMPTY"
  );
}

function requireGitContext(
  cwd: string,
  command:
    | "add"
    | "apply"
    | "status"
    | "check"
    | "update"
    | "shadow"
    | "sync"
    | "reset"
    | "remove",
) {
  const gitContext = detectGitContext({ cwd });

  if (!gitContext) {
    throw new Error(
      `skul ${command} requires a Git repository. Run "git init" to initialize one`,
    );
  }

  return gitContext;
}

/**
 * Throws when Skul is about to create or refresh a tracked root-instruction
 * shadow on top of a Git path that is not in a safe state to overwrite.
 *
 * Callers typically run it before removing existing managed files and again as
 * a write-time backstop during materialization.
 */
export function assertTrackedShadowSafety(options: {
  repoRoot: string;
  filePath: string;
  operation: "create" | "refresh";
}): void {
  assertTrackedShadowSafetyForAction({
    repoRoot: options.repoRoot,
    filePath: options.filePath,
    action: options.operation,
  });
}

function assertTrackedShadowSafetyForAction(options: {
  repoRoot: string;
  filePath: string;
  action: "create" | "refresh" | "suspend";
}): void {
  const inspection = inspectTrackedShadowTarget({
    repoRoot: options.repoRoot,
    filePath: options.filePath,
  });

  if (!inspection.tracked) {
    return;
  }

  const actionLabel = options.action;

  if (inspection.issues.includes("unmerged")) {
    throw new Error(
      `Cannot ${actionLabel} tracked shadow for ${options.filePath} because the target has unmerged index entries`,
    );
  }

  if (inspection.issues.includes("missing-head")) {
    throw new Error(
      `Cannot ${actionLabel} tracked shadow for ${options.filePath} because the target does not have HEAD content`,
    );
  }

  if (inspection.issues.includes("staged-changes")) {
    throw new Error(
      `Cannot ${actionLabel} tracked shadow for ${options.filePath} because the target has staged changes`,
    );
  }

  if (inspection.issues.includes("unstaged-changes")) {
    throw new Error(
      `Cannot ${actionLabel} tracked shadow for ${options.filePath} because the target has unstaged changes`,
    );
  }

  if (inspection.issues.includes("incompatible-index-flags")) {
    throw new Error(
      `Cannot ${actionLabel} tracked shadow for ${options.filePath} because the target has incompatible index flags: ${inspection.indexFlags.join(", ")}`,
    );
  }
}

function assertTrackedRootInstructionShadowSafetyForPaths(options: {
  repoRoot: string;
  operation: "create" | "refresh";
  filePaths: string[];
}): void {
  for (const filePath of options.filePaths) {
    if (!isRootInstructionPath(filePath)) {
      continue;
    }

    assertTrackedShadowSafety({
      repoRoot: options.repoRoot,
      filePath,
      operation: options.operation,
    });
  }
}

/**
 * Vetoes writes to shared files Skul cannot safely modify in place.
 *
 * Both root instructions and MCP configuration reach committed files through the
 * tracked-shadow lifecycle, so only the root-instruction safety rules need
 * asserting here before a direct write.
 */
function createManagedWriteSafetyAssertion(options: {
  repoRoot: string;
  operation: "create" | "refresh";
}): (repoRelativePath: string) => void {
  return (repoRelativePath: string) => {
    if (isRootInstructionPath(repoRelativePath)) {
      assertTrackedShadowSafety({
        repoRoot: options.repoRoot,
        filePath: repoRelativePath,
        operation: options.operation,
      });
      return;
    }
  };
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
    throw new Error(
      `Bundle not found in active set: ${bundle}. Run "skul status" to see configured bundles`,
    );
  }

  return [matchingEntry];
}

function mergeDesiredTools(options: {
  existingEntry?: DesiredBundleEntry;
  requestedTools?: ToolName[];
  replace?: boolean;
}): ToolName[] | undefined {
  if (options.requestedTools === undefined) {
    return undefined;
  }

  if (options.replace || options.existingEntry?.tools === undefined) {
    return [...options.requestedTools];
  }

  return Array.from(
    new Set([...options.existingEntry.tools, ...options.requestedTools]),
  ).sort((left, right) => left.localeCompare(right)) as ToolName[];
}

function upsertDesiredEntryPreservingOrder(
  desiredState: DesiredBundleEntry[],
  nextEntry: DesiredBundleEntry,
): DesiredBundleEntry[] {
  const existingIndex = desiredState.findIndex(
    (entry) => entry.bundle === nextEntry.bundle,
  );

  if (existingIndex === -1) {
    return [...desiredState, nextEntry];
  }

  return desiredState.map((entry, index) =>
    index === existingIndex ? nextEntry : entry,
  );
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

function formatCommitTransition(
  currentCommit: string | undefined,
  nextCommit: string,
): string {
  return currentCommit
    ? ` ${shortCommit(currentCommit)} -> ${shortCommit(nextCommit)}`
    : ` to ${shortCommit(nextCommit)}`;
}

function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

function resolveDesiredCachedBundle(
  libraryDir: string,
  entry: DesiredBundleEntry,
) {
  return findCachedBundleWithGuidance({
    libraryDir,
    bundle: entry.bundle,
    source: entry.source,
  });
}

function readRegistryWithGuidance(registryFile: string) {
  try {
    return readRegistryFile(registryFile);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Registry is corrupted (${detail}). Please repair or remove ${registryFile} and try again.`,
    );
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
      const availableBundles = listCachedBundles({
        libraryDir: options.libraryDir,
      }).map((bundle) => bundle.bundle);

      if (availableBundles.length === 0) {
        throw new Error(
          `${error.message}\n\nNo bundles are cached yet. Add one from a Git source:\n  skul add github.com/<owner>/<repo> <bundle-name>`,
        );
      }

      throw new Error(
        `${error.message}\nAvailable bundles:\n${Array.from(
          new Set(availableBundles),
        )
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
    const confirmed = await prompts.confirmManagedFileRemoval(
      relativePath,
      operation,
    );

    if (!confirmed) {
      return false;
    }
  }

  return true;
}

/** Warns before replace mode discards an existing root instruction file. */
async function confirmRootInstructionReplacements(options: {
  repoRoot: string;
  targetPaths: Set<string>;
  mode?: RootInstructionMode;
  prompts: PromptClient;
}): Promise<void> {
  if (options.mode !== "replace") {
    return;
  }

  for (const relativePath of options.targetPaths) {
    const targetPath = path.join(options.repoRoot, relativePath);
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
      continue;
    }

    await options.prompts.resolveFileConflict(relativePath);
  }
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

async function applyBundleGlobal(options: {
  homeDir: string;
  prompts: PromptClient;
  registryFile: string;
  libraryDir: string;
  bundle: string;
  source?: string;
  protocol: "https" | "ssh";
  agents: ToolName[];
  includeItems: BundleItemSelector[];
  selectItems: boolean;
  dryRun: boolean;
  ref?: string;
  inferredBundleFromSource?: true;
  replaceItems?: boolean;
  refreshedSources?: Set<string>;
  refreshedSourceUpdates?: Map<string, RefreshedSourceUpdate>;
  disableModelInvocation?: boolean;
  rootInstructionMode?: RootInstructionMode;
  warnings?: CommandWarningCollector;
}): Promise<string> {
  const supportedTools = globalCapableToolNames();

  if (options.agents.length > 0) {
    const unsupported = options.agents.filter(
      (t) => !supportedTools.includes(t),
    );
    if (unsupported.length > 0) {
      throw new Error(
        `Global mode only supports: ${supportedTools.join(", ")}. Unsupported: ${unsupported.join(", ")}`,
      );
    }
  }

  const repoRelPathRemapper =
    GLOBAL_TOOL_MATERIALIZATION_LAYOUT.remapRepoRelPath;

  let registry = readRegistryWithGuidance(options.registryFile);
  const existingGlobal = registry.global;

  if (shouldApplySelectedItemsAcrossSourceBundles(options)) {
    return applySelectedItemsAcrossGlobalSourceBundles({
      homeDir: options.homeDir,
      prompts: options.prompts,
      registryFile: options.registryFile,
      libraryDir: options.libraryDir,
      source: options.source!,
      protocol: options.protocol,
      agents:
        options.agents.length > 0
          ? options.agents.filter((toolName) =>
              supportedTools.includes(toolName),
            )
          : [],
      includeItems: options.includeItems,
      dryRun: options.dryRun,
      ref: options.ref,
      existingDesiredState: existingGlobal?.desired_state ?? [],
      disableModelInvocation: options.disableModelInvocation,
    });
  }

  // When no --agent is specified, auto-select all globally-capable tools that
  // the bundle actually supports, rather than requesting all supported tools
  // upfront (which would fail validation for bundles that don't cover every tool).
  const globalAutoSelectPrompts: PromptClient = {
    ...options.prompts,
    selectAgents: async (availableAgents) =>
      availableAgents.filter((t) => supportedTools.includes(t)),
  };

  // Skip cloning in dry-run: when a remote source is specified and not yet
  // cached, return a preview message immediately so no network I/O occurs.
  if (options.dryRun && options.source) {
    const { cached } = readCachedSourceRevision({
      source: options.source,
      libraryDir: options.libraryDir,
      protocol: options.protocol,
    });
    if (!cached) {
      const toolsLabel =
        options.agents.length > 0
          ? options.agents.join(", ")
          : "globally supported tools";
      return [
        pc.dim(`(would clone ${options.source})`),
        `${pc.yellow("DRY RUN:")} Would apply ${options.bundle} globally for ${toolsLabel}`,
      ].join("\n");
    }
  }

  const preparedBundle = await prepareApplyBundle({
    bundle: options.bundle,
    source: options.source,
    protocol: options.protocol,
    requestedTools:
      options.agents.length > 0
        ? options.agents.filter((t) => supportedTools.includes(t))
        : [],
    requestedItems: options.includeItems,
    selectItems: options.selectItems,
    replaceItems: options.replaceItems,
    existingDesiredState: existingGlobal?.desired_state ?? [],
    libraryDir: options.libraryDir,
    ref: options.ref,
    prompts:
      options.agents.length > 0 ? options.prompts : globalAutoSelectPrompts,
    preBundlePrompts: options.prompts,
    inferredBundleFromSource: options.inferredBundleFromSource,
    refreshedSources: options.refreshedSources,
    refreshedSourceUpdates: options.refreshedSourceUpdates,
  });

  const availableGlobalTools = preparedBundle.nextToolNames.filter((t) =>
    supportedTools.includes(t),
  );

  if (availableGlobalTools.length === 0) {
    const bundleTools = Object.keys(preparedBundle.cachedBundle.manifest.tools);
    throw new Error(
      `Bundle "${preparedBundle.cachedBundle.bundle}" has no globally installable tools (bundle provides: ${bundleTools.join(", ")}; global mode supports: ${supportedTools.join(", ")})`,
    );
  }

  // Warn when auto-selecting (no --agent) and the bundle contains tools that
  // aren't globally installable — they were silently dropped by globalAutoSelectPrompts.
  const skippedTools =
    options.agents.length === 0
      ? Object.keys(preparedBundle.cachedBundle.manifest.tools).filter(
          (t) => !(supportedTools as string[]).includes(t),
        )
      : [];
  const mcpSkipNotes = formatGlobalMcpSkipNotes({
    manifest: preparedBundle.cachedBundle.manifest,
    tools: availableGlobalTools,
    itemSelectors: preparedBundle.selectedItems,
  });

  if (options.dryRun) {
    return [
      ...preparedBundle.cloneLines,
      `${pc.yellow("DRY RUN:")} Would ${formatApplyGlobalBundleMessage({
        bundle: preparedBundle.cachedBundle.bundle,
        toolLabel: availableGlobalTools.join(", "),
        items: preparedBundle.replacesItemSelection
          ? preparedBundle.selectedItems
          : undefined,
      })}`,
      ...mcpSkipNotes,
    ].join("\n");
  }

  let rootInstructionBaseContents =
    existingGlobal?.materialized_state.root_instruction_base_contents;
  const mcpOwnership = createMcpMaterializationOwnership(
    existingGlobal?.materialized_state,
  );
  const existingBundleState =
    existingGlobal?.materialized_state.bundles[
      preparedBundle.cachedBundle.bundle
    ];
  const existingDesiredState = existingGlobal?.desired_state ?? [];
  const effectiveRootInstructionMode =
    options.rootInstructionMode ??
    preparedBundle.cachedBundle.manifest.root_instruction_mode;

  const resolvedBundleItemRefs = await resolveBundleItemRefs({
    bundleDir: path.dirname(preparedBundle.cachedBundle.manifestFile),
    manifest: preparedBundle.cachedBundle.manifest,
    tools: availableGlobalTools,
    itemSelectors: preparedBundle.selectedItems,
    libraryDir: options.libraryDir,
    protocol: options.protocol,
  });
  const materializationScope: BundleMaterializationScope = {
    repoRoot: options.homeDir,
    bundleDir: path.dirname(preparedBundle.cachedBundle.manifestFile),
    manifest: preparedBundle.cachedBundle.manifest,
    tools: availableGlobalTools,
    pathLayout: GLOBAL_TOOL_MATERIALIZATION_LAYOUT,
    itemSelectors: preparedBundle.selectedItems,
    disableModelInvocation: options.disableModelInvocation,
    resolvedBundleItemRefs,
  };
  const plannedWriteTargets =
    previewMaterializeBundleWriteTargets(materializationScope);

  const plannedRootInstructionTargets = new Set(
    plannedWriteTargets.filter((p) => isRootInstructionPath(p)),
  );
  assertRootInstructionModeCompatibility({
    desiredState: existingDesiredState,
    materializedBundles: existingGlobal?.materialized_state.bundles ?? {},
    currentBundle: preparedBundle.cachedBundle.bundle,
    targetPaths: plannedRootInstructionTargets,
    mode: effectiveRootInstructionMode,
  });

  const existingBundles = existingGlobal?.materialized_state.bundles ?? {};

  rootInstructionBaseContents = captureRootInstructionBaseContents({
    repoRoot: options.homeDir,
    targetPaths: plannedRootInstructionTargets,
    existingBaseContents: rootInstructionBaseContents,
    managedTargetPaths: collectManagedRootInstructionTargets(existingBundles),
  });
  await confirmRootInstructionReplacements({
    repoRoot: options.homeDir,
    targetPaths: plannedRootInstructionTargets,
    mode: effectiveRootInstructionMode,
    prompts: options.prompts,
  });

  assertManagedRootInstructionSyncSourcesCached({
    desiredState: existingDesiredState,
    materializedBundles: existingBundles,
    targetPaths: plannedRootInstructionTargets,
    resolveCachedBundle: (entry) =>
      resolveDesiredCachedBundle(options.libraryDir, entry),
  });

  let pathsToReplace: ReturnType<typeof excludeShadowedTrackedTargets> | null =
    null;

  if (existingBundleState) {
    const toolsToReplace =
      options.agents.length > 0
        ? options.agents.filter((t) => t in existingBundleState.tools)
        : (Object.keys(existingBundleState.tools) as ToolName[]);

    pathsToReplace = flattenBundleState({
      tools: Object.fromEntries(
        toolsToReplace.map((t) => [t, existingBundleState.tools[t]!]),
      ),
    });

    const replacementAllowed = await confirmManagedFileRemovals(
      options.homeDir,
      pathsToReplace,
      options.prompts,
      "replace",
    );

    if (!replacementAllowed) {
      throw new Error(
        "Replacement aborted because a modified managed file was kept",
      );
    }
  }

  const sharedRootInstructionState = collectSharedRootInstructionState(
    existingBundles,
    plannedWriteTargets,
    preparedBundle.cachedBundle.bundle,
  );

  if (sharedRootInstructionState.files.length > 0) {
    const replacementAllowed = await confirmManagedFileRemovals(
      options.homeDir,
      sharedRootInstructionState,
      options.prompts,
      "replace",
    );
    if (!replacementAllowed) {
      throw new Error(
        "Replacement aborted because a modified managed file was kept",
      );
    }
  }

  if (pathsToReplace) {
    removeManagedPaths(options.homeDir, pathsToReplace, {
      restoreCommitted: false,
      mcpOwnership,
      warnings: options.warnings,
    });
  }

  const materializedResult = await materializeBundle({
    ...materializationScope,
    bundleName: preparedBundle.cachedBundle.bundle,
    bundleSource: preparedBundle.bundleSource,
    rootInstructionBaseContents,
    rootInstructionMode: effectiveRootInstructionMode,
    resolveFileConflict: options.prompts.resolveFileConflict,
    libraryDir: options.libraryDir,
    existingMcpServers: ownedMcpServers(existingBundleState),
  });
  mcpOwnership.recordMaterialization(materializedResult);

  const newBundleState = buildMaterializedBundleState({
    existingBundleState,
    materializedResult,
    repoRoot: options.homeDir,
    source: preparedBundle.bundleSource,
    resolvedCommit: preparedBundle.sourceRevision?.currentCommit,
    selectedTools: availableGlobalTools,
    selectedItems: preparedBundle.selectedItems,
  });

  const newDesiredEntry = buildDesiredEntryForAppliedBundle({
    existingDesiredState,
    cachedBundle: preparedBundle.cachedBundle,
    requestedSource: options.source,
    requestedProtocol: options.protocol,
    requestedRef: options.ref,
    requestedTools: availableGlobalTools,
    replaceRequestedTools: options.agents.length === 0,
    requestedItems: preparedBundle.selectedItems,
    replaceRequestedItems: preparedBundle.replacesItemSelection,
    sourceRevision: preparedBundle.sourceRevision,
    disableModelInvocation: options.disableModelInvocation,
    rootInstructionMode: effectiveRootInstructionMode,
  });

  const newDesiredState = [
    ...upsertDesiredEntryPreservingOrder(existingDesiredState, newDesiredEntry),
  ];

  const newBundles: Record<string, MaterializedBundleState> = {
    ...existingBundles,
    [preparedBundle.cachedBundle.bundle]: newBundleState,
  };

  const syncedRootInstructionPaths = syncManagedRootInstructionFiles({
    repoRoot: options.homeDir,
    desiredState: newDesiredState,
    materializedBundles: newBundles,
    rootInstructionBaseContents,
    targetPaths: plannedRootInstructionTargets,
    resolveCachedBundle: (entry) =>
      resolveDesiredCachedBundle(options.libraryDir, entry),
    repoRelPathRemapper,
    resolvedBundleItemRefsByBundle:
      await resolveMaterializedBundleItemRefsByBundle({
        desiredState: newDesiredState,
        materializedBundles: newBundles,
        libraryDir: options.libraryDir,
        seed: new Map([
          [preparedBundle.cachedBundle.bundle, resolvedBundleItemRefs],
        ]),
        itemSelectors: ["root-instruction"],
      }),
  });

  const refreshedBundles = refreshManagedFileFingerprintsForPaths(
    options.homeDir,
    newBundles,
    syncedRootInstructionPaths,
  );

  const newGlobalState: GlobalState = {
    desired_state: newDesiredState,
    materialized_state: {
      bundles: refreshedBundles,
      ...mcpOwnership.toRegistryFields(),
      ...(rootInstructionBaseContents !== undefined
        ? { root_instruction_base_contents: rootInstructionBaseContents }
        : {}),
    },
  };

  registry = upsertGlobalState(registry, newGlobalState);
  writeRegistryFile(options.registryFile, registry);

  const lines = [
    ...preparedBundle.cloneLines,
    pc.green(
      formatAppliedGlobalBundleMessage({
        bundle: preparedBundle.cachedBundle.bundle,
        toolLabel: availableGlobalTools.join(", "),
        items: preparedBundle.replacesItemSelection
          ? preparedBundle.selectedItems
          : undefined,
        updated: preparedBundle.sourceUpdated,
      }),
    ),
  ];

  if (skippedTools.length > 0) {
    lines.push(
      pc.yellow(
        `Note: ${skippedTools.join(", ")} ${skippedTools.length === 1 ? "is" : "are"} not supported in global mode and ${skippedTools.length === 1 ? "was" : "were"} skipped`,
      ),
    );
  }

  lines.push(...mcpSkipNotes);

  return lines.join("\n");
}

/**
 * Says which tools a global install cannot place a bundle's MCP servers for.
 *
 * A bundle declares its servers once and Skul writes them per tool, so a tool
 * with no global MCP location drops them. That is a deliberate omission, not a
 * failure — the remaining tools are still installed — but it leaves the bundle
 * partly unconfigured, so the run says so rather than letting it pass. Every
 * tool `--global` currently accepts has such a location, which is what keeps
 * this quiet; it speaks up if that ever stops being true.
 */
function formatGlobalMcpSkipNotes(options: {
  manifest: BundleManifest;
  tools: ToolName[];
  itemSelectors?: BundleItemSelector[];
}): string[] {
  if (!isMcpItemSelected(options.itemSelectors)) {
    return [];
  }

  const placeable = globalMcpCapableToolNames();
  const skipped = options.tools.filter(
    (toolName) =>
      options.manifest.tools[toolName]?.mcp !== undefined &&
      !placeable.includes(toolName),
  );

  if (skipped.length === 0) {
    return [];
  }

  return [
    pc.yellow(
      `Note: MCP servers were skipped for ${skipped.join(", ")}: global mode writes MCP configuration only for ${placeable.join(", ")}`,
    ),
  ];
}

function formatAppliedGlobalBundleMessage(options: {
  bundle: string;
  toolLabel: string;
  items?: BundleItemSelector[];
  updated?: boolean;
}): string {
  return formatApplyGlobalBundleMessage({
    bundle: options.bundle,
    toolLabel: options.toolLabel,
    items: options.items,
    updated: options.updated,
    action: "Applied",
  });
}

function formatApplyGlobalBundleMessage(options: {
  bundle: string;
  toolLabel: string;
  items?: BundleItemSelector[];
  updated?: boolean;
  action?: "Applied";
}): string {
  const itemLabel =
    options.items !== undefined && options.items.length > 0
      ? `: ${options.items.join(", ")}`
      : "";
  const updatedLabel = options.updated ? " (Updated)" : "";

  return `${options.action ?? "apply"} ${options.bundle} globally for ${options.toolLabel}${itemLabel}${updatedLabel}`;
}

async function applySelectedItemsAcrossGlobalSourceBundles(options: {
  homeDir: string;
  prompts: PromptClient;
  registryFile: string;
  libraryDir: string;
  source: string;
  protocol: "https" | "ssh";
  agents: ToolName[];
  includeItems: BundleItemSelector[];
  dryRun: boolean;
  ref?: string;
  existingDesiredState: DesiredBundleEntry[];
  disableModelInvocation?: boolean;
}): Promise<string> {
  const refreshedSources = new Set<string>();
  const refreshedSourceUpdates = new Map<string, RefreshedSourceUpdate>();
  const cloneLines = await refreshBundleSourceForApply(
    {
      source: options.source,
      libraryDir: options.libraryDir,
      protocol: options.protocol,
      ref: options.ref,
    },
    refreshedSources,
    refreshedSourceUpdates,
  );
  const selection = await selectSourceBundleItemApplyTargets({
    libraryDir: options.libraryDir,
    source: options.source,
    requestedTools: options.agents,
    requestedItems: options.includeItems,
    prompts: options.prompts,
    existingDesiredState: options.existingDesiredState,
    global: true,
    sourceUpdate: getRefreshedSourceUpdate(
      refreshedSourceUpdates,
      options.source,
    ),
  });
  const outputLines: string[] = [];

  for (const target of selection.removeTargets) {
    outputLines.push(
      await removeGlobalBundle({
        homeDir: options.homeDir,
        prompts: options.prompts,
        registryFile: options.registryFile,
        libraryDir: options.libraryDir,
        bundle: target.bundle,
        source: target.source,
        includeItems: [],
        selectItems: false,
        dryRun: options.dryRun,
      }),
    );
  }

  for (const target of selection.applyTargets) {
    outputLines.push(
      await applyBundleGlobal({
        homeDir: options.homeDir,
        prompts: options.prompts,
        registryFile: options.registryFile,
        libraryDir: options.libraryDir,
        bundle: target.bundle,
        source: target.source,
        protocol: options.protocol,
        agents: target.tools,
        includeItems: target.items,
        selectItems: false,
        replaceItems: true,
        dryRun: options.dryRun,
        ref: options.ref,
        refreshedSources,
        refreshedSourceUpdates,
        disableModelInvocation: options.disableModelInvocation,
      }),
    );
  }

  return [...cloneLines, ...outputLines].filter(Boolean).join("\n");
}

function renderGlobalStatus(options: {
  registryFile: string;
  json: boolean;
}): string {
  const registry = readRegistryWithGuidance(options.registryFile);
  const globalState = registry.global;

  if (options.json) {
    return JSON.stringify(
      {
        desired_state: globalState?.desired_state ?? [],
        materialized: {
          bundles: Object.fromEntries(
            Object.entries(globalState?.materialized_state.bundles ?? {}).map(
              ([bundleName, bundleState]) => [
                bundleName,
                {
                  tools: Object.fromEntries(
                    Object.entries(bundleState.tools).map(([t, s]) => [
                      t,
                      { files: s.files },
                    ]),
                  ),
                },
              ],
            ),
          ),
        },
      },
      null,
      2,
    );
  }

  const lines: string[] = [pc.bold("Global Desired State")];

  if (globalState && globalState.desired_state.length > 0) {
    for (const entry of globalState.desired_state) {
      lines.push(`Bundle: ${pc.cyan(entry.bundle)}`);
    }
  } else {
    lines.push(pc.dim("Configured: no"));
    lines.push(pc.dim('Run "skul add --global <bundle>" to get started'));
  }

  lines.push("", pc.bold("Global Materialized State"));

  if (
    !globalState ||
    Object.keys(globalState.materialized_state.bundles).length === 0
  ) {
    lines.push(pc.dim("Materialized: no"));
    return lines.join("\n");
  }

  lines.push(pc.green("Materialized: yes"), "", "Files:");

  for (const [bundleName, bundleState] of Object.entries(
    globalState.materialized_state.bundles,
  )) {
    lines.push(`  Bundle: ${pc.cyan(bundleName)}`);
    for (const [toolName, toolState] of Object.entries(bundleState.tools)) {
      lines.push(`    Tool: ${toolName}`);
      for (const file of toolState.files) {
        lines.push(`      ${file}`);
      }
    }
  }

  return lines.join("\n");
}

async function removeGlobalBundle(options: {
  homeDir: string;
  prompts: PromptClient;
  registryFile: string;
  libraryDir: string;
  bundle?: string;
  source?: string;
  includeItems: BundleItemSelector[];
  selectItems: boolean;
  dryRun: boolean;
  inferredBundleFromSource?: true;
  warnings?: CommandWarningCollector;
}): Promise<string> {
  const repoRelPathRemapper =
    GLOBAL_TOOL_MATERIALIZATION_LAYOUT.remapRepoRelPath;

  let registry = readRegistryWithGuidance(options.registryFile);
  const globalState = registry.global;

  if (shouldRemoveItemsAcrossBundles(options)) {
    return removeGlobalBundleItemsAcrossActiveBundles({
      homeDir: options.homeDir,
      prompts: options.prompts,
      registryFile: options.registryFile,
      libraryDir: options.libraryDir,
      globalState,
      source: options.source,
      bundle: options.inferredBundleFromSource ? undefined : options.bundle,
      includeItems: options.includeItems,
      selectItems: options.selectItems,
      dryRun: options.dryRun,
      warnings: options.warnings,
    });
  }

  const selection = await resolveRemoveGlobalBundleSelection({
    requestedBundle: options.bundle,
    requestedSource: options.source,
    inferredBundleFromSource: options.inferredBundleFromSource,
    globalState,
    prompts: options.prompts,
  });
  const bundle = selection.bundle;
  const source = selection.source;
  const isInDesiredState =
    globalState?.desired_state.some(
      (e) => e.bundle === bundle && matchesOptionalSource(e.source, source),
    ) ?? false;
  const desiredEntry = globalState?.desired_state.find(
    (e) => e.bundle === bundle && matchesOptionalSource(e.source, source),
  );
  const bundleMaterializedState = findGlobalMaterializedBundleState({
    globalState,
    bundle,
    source,
  });

  if (!isInDesiredState && !bundleMaterializedState) {
    const configured =
      globalState?.desired_state
        .filter((entry) => matchesOptionalSource(entry.source, source))
        .map((e) => e.bundle) ?? [];
    const hint =
      configured.length > 0
        ? `Configured global bundles: ${configured.join(", ")}`
        : `No global bundles configured. Run "skul add --global <bundle>" to add one`;
    throw new Error(
      `Bundle not found in global active set: ${bundle}. ${hint}`,
    );
  }

  if (options.includeItems.length > 0 || options.selectItems) {
    const itemRemoval = await removeGlobalBundleItems({
      homeDir: options.homeDir,
      prompts: options.prompts,
      registryFile: options.registryFile,
      libraryDir: options.libraryDir,
      registry,
      globalState,
      desiredEntry,
      bundle,
      source,
      includeItems: options.includeItems,
      selectItems: options.selectItems,
      dryRun: options.dryRun,
      warnings: options.warnings,
    });

    if (itemRemoval.kind === "completed") {
      return itemRemoval.output;
    }
  }

  if (options.dryRun) {
    if (bundleMaterializedState) {
      const { files, mcp_servers } = flattenBundleState(
        bundleMaterializedState,
      );
      const removableFiles = Array.from(
        new Set([
          ...files,
          ...mcp_servers.map(({ path: filePath }) => filePath),
        ]),
      );
      const lines = [
        `${pc.yellow("DRY RUN:")} Would remove global ${bundle} (${removableFiles.length} file(s))`,
      ];
      for (const file of removableFiles) lines.push(`  ${file}`);
      return lines.join("\n");
    }
    return `${pc.yellow("DRY RUN:")} Would remove ${bundle} from global desired state`;
  }

  if (bundleMaterializedState) {
    const bundlePaths = flattenBundleState(bundleMaterializedState);
    const mcpOwnership = createMcpMaterializationOwnership(
      globalState?.materialized_state,
    );
    const rootInstructionBaseContents =
      globalState?.materialized_state.root_instruction_base_contents;
    const removedRootInstructionPaths = new Set(
      bundlePaths.files.filter((p) => isRootInstructionPath(p)),
    );
    const remainingBundles = { ...globalState!.materialized_state.bundles };
    delete remainingBundles[bundle];
    const remainingDesiredState =
      globalState?.desired_state.filter(
        (entry) => !matchesBundleIdentity(entry, bundle, source),
      ) ?? [];
    const rewrittenRootInstructionPaths = new Set(
      Array.from(collectManagedRootInstructionTargets(remainingBundles)).filter(
        (p) => removedRootInstructionPaths.has(p),
      ),
    );

    assertManagedRootInstructionSyncSourcesCached({
      desiredState: remainingDesiredState,
      materializedBundles: remainingBundles,
      targetPaths: rewrittenRootInstructionPaths,
      resolveCachedBundle: (entry) =>
        resolveDesiredCachedBundle(options.libraryDir, entry),
    });

    const removeAllowed = await confirmManagedFileRemovals(
      options.homeDir,
      bundlePaths,
      options.prompts,
      "remove",
    );
    if (!removeAllowed) {
      throw new Error(
        "Removal aborted because a modified managed file was kept",
      );
    }

    const remainingRootInstructionRefs =
      Object.keys(remainingBundles).length > 0
        ? await resolveMaterializedBundleItemRefsByBundle({
            desiredState: remainingDesiredState,
            materializedBundles: remainingBundles,
            libraryDir: options.libraryDir,
            itemSelectors: ["root-instruction"],
          })
        : undefined;

    const removalResult = removeManagedPaths(options.homeDir, bundlePaths, {
      restoreCommitted: false,
      mcpOwnership,
      warnings: options.warnings,
    });
    const failedBundleState = retainFailedMcpBundleState(
      bundleMaterializedState,
      removalResult.failedMcpServers,
    );

    const remainingRootInstructionTargets =
      collectManagedRootInstructionTargets(remainingBundles);
    const restoredRootInstructionPaths = new Set(
      Array.from(removedRootInstructionPaths).filter(
        (p) => !remainingRootInstructionTargets.has(p),
      ),
    );
    restoreRootInstructionBaseContents({
      repoRoot: options.homeDir,
      baseContents: rootInstructionBaseContents,
      targetPaths: restoredRootInstructionPaths,
    });

    const nextRootInstructionBaseContents = rootInstructionBaseContents
      ? Object.fromEntries(
          Object.entries(rootInstructionBaseContents).filter(
            ([p]) => !restoredRootInstructionPaths.has(p),
          ),
        )
      : undefined;

    if (Object.keys(remainingBundles).length > 0) {
      const syncedRootInstructionPaths = syncManagedRootInstructionFiles({
        repoRoot: options.homeDir,
        desiredState: remainingDesiredState,
        materializedBundles: remainingBundles,
        rootInstructionBaseContents: nextRootInstructionBaseContents,
        targetPaths: rewrittenRootInstructionPaths,
        resolveCachedBundle: (entry) =>
          resolveDesiredCachedBundle(options.libraryDir, entry),
        repoRelPathRemapper,
        resolvedBundleItemRefsByBundle: remainingRootInstructionRefs,
      });
      const refreshedBundles = refreshManagedFileFingerprintsForPaths(
        options.homeDir,
        remainingBundles,
        syncedRootInstructionPaths,
      );

      const newGlobalState: GlobalState = {
        desired_state: remainingDesiredState,
        materialized_state: {
          bundles: failedBundleState
            ? { ...refreshedBundles, [bundle]: failedBundleState }
            : refreshedBundles,
          ...mcpOwnership.toRegistryFields(),
          ...(nextRootInstructionBaseContents &&
          Object.keys(nextRootInstructionBaseContents).length > 0
            ? {
                root_instruction_base_contents: nextRootInstructionBaseContents,
              }
            : {}),
        },
      };
      registry = upsertGlobalState(registry, newGlobalState);
    } else {
      if (remainingDesiredState.length > 0 || failedBundleState) {
        registry = upsertGlobalState(registry, {
          desired_state: remainingDesiredState,
          materialized_state: {
            bundles: failedBundleState ? { [bundle]: failedBundleState } : {},
            ...mcpOwnership.toRegistryFields(),
          },
        });
      } else {
        registry = { ...registry, global: undefined };
      }
    }
  } else if (isInDesiredState && globalState) {
    const newDesiredState = globalState.desired_state.filter(
      (entry) => !matchesBundleIdentity(entry, bundle, source),
    );
    if (
      newDesiredState.length > 0 ||
      Object.keys(globalState.materialized_state.bundles).length > 0
    ) {
      registry = upsertGlobalState(registry, {
        ...globalState,
        desired_state: newDesiredState,
      });
    } else {
      registry = { ...registry, global: undefined };
    }
  }

  writeRegistryFile(options.registryFile, registry);
  return pc.green(`Removed global ${bundle}`);
}

async function removeGlobalBundleItemsAcrossActiveBundles(options: {
  homeDir: string;
  prompts: PromptClient;
  registryFile: string;
  libraryDir: string;
  globalState?: GlobalState;
  source?: string;
  bundle?: string;
  includeItems: BundleItemSelector[];
  selectItems: boolean;
  dryRun: boolean;
  warnings?: CommandWarningCollector;
}): Promise<string> {
  if (!options.globalState || options.globalState.desired_state.length === 0) {
    throw new Error(
      options.source
        ? `No active global bundles found for ${options.source}. Run "skul add --global ${options.source} <bundle>" to add one first`
        : 'No active global bundles found. Run "skul add --global <bundle>" to add one first',
    );
  }

  const choices = listActiveGlobalBundleItemRemovalChoices({
    libraryDir: options.libraryDir,
    desiredState: options.globalState.desired_state,
    source: options.source,
    bundle: options.bundle,
  });
  const requestedItems = normalizeBundleItemSelectors(options.includeItems);
  const selectedValues = options.selectItems
    ? await promptForBundleItemRemovalChoices({
        prompts: options.prompts,
        choices,
        requestedItems,
      })
    : selectRequestedBundleItemRemovalChoices({
        choices,
        requestedItems,
      });
  const removalPlan = planBundleItemRemovals({
    desiredState: options.globalState.desired_state,
    choices,
    selectedValues,
  });

  if (options.dryRun) {
    return `${pc.yellow("DRY RUN:")} Would remove ${formatBundleItemRemovalSummary(removalPlan.removedItems)} from global bundles`;
  }

  for (const target of groupBundleItemRemovalTargets(
    removalPlan.removedItems,
  )) {
    await removeGlobalBundle({
      homeDir: options.homeDir,
      prompts: options.prompts,
      registryFile: options.registryFile,
      libraryDir: options.libraryDir,
      bundle: target.bundle,
      source: target.source,
      includeItems: target.items,
      selectItems: false,
      dryRun: false,
      warnings: options.warnings,
    });
  }

  return pc.green(
    `Removed ${formatBundleItemRemovalSummary(removalPlan.removedItems)} from global bundles`,
  );
}

function listActiveGlobalBundleItemRemovalChoices(options: {
  libraryDir: string;
  desiredState: DesiredBundleEntry[];
  source?: string;
  bundle?: string;
}): BundleItemRemovalChoice[] {
  const choices = options.desiredState.flatMap((entry) => {
    if (!matchesOptionalSource(entry.source, options.source)) return [];
    if (options.bundle !== undefined && entry.bundle !== options.bundle) {
      return [];
    }

    return listDesiredGlobalBundleItemRemovalChoices({
      libraryDir: options.libraryDir,
      desiredEntry: entry,
    });
  });

  if (choices.length === 0) {
    throw new Error(
      options.source
        ? `No active global bundle items found for ${options.source}`
        : "No active global bundle items found",
    );
  }

  return choices;
}

function listDesiredGlobalBundleItemRemovalChoices(options: {
  libraryDir: string;
  desiredEntry: DesiredBundleEntry;
}): BundleItemRemovalChoice[] {
  const cachedBundle = findCachedBundleWithGuidance({
    libraryDir: options.libraryDir,
    bundle: options.desiredEntry.bundle,
    source: options.desiredEntry.source,
  });
  const selectedTools =
    options.desiredEntry.tools ??
    (Object.keys(cachedBundle.manifest.tools).filter((toolName) =>
      globalCapableToolNames().includes(toolName as ToolName),
    ) as ToolName[]);
  const availableItems = listSelectableBundleItems({
    bundleDir: path.dirname(cachedBundle.manifestFile),
    manifest: cachedBundle.manifest,
    tools: selectedTools,
  });
  const activeItems = options.desiredEntry.items ?? availableItems;

  return activeItems.map((item) => ({
    value: encodeBundleItemRemovalChoice({
      bundle: options.desiredEntry.bundle,
      source: options.desiredEntry.source,
      item,
    }),
    label: formatBundleItemRemovalChoiceLabel({
      bundle: options.desiredEntry.bundle,
      source: options.desiredEntry.source,
      item,
    }),
    bundle: options.desiredEntry.bundle,
    source: options.desiredEntry.source,
    item,
    activeItems,
  }));
}

async function resolveRemoveGlobalBundleSelection(options: {
  requestedBundle?: string;
  requestedSource?: string;
  inferredBundleFromSource?: true;
  globalState?: GlobalState;
  prompts: PromptClient;
}): Promise<{ bundle: string; source?: string }> {
  if (
    options.requestedBundle &&
    isGlobalRemoveBundleActive({
      globalState: options.globalState,
      bundle: options.requestedBundle,
      source: options.requestedSource,
    })
  ) {
    return {
      bundle: options.requestedBundle,
      ...(options.requestedSource !== undefined
        ? { source: options.requestedSource }
        : {}),
    };
  }

  if (options.requestedBundle && !options.inferredBundleFromSource) {
    return {
      bundle: options.requestedBundle,
      ...(options.requestedSource !== undefined
        ? { source: options.requestedSource }
        : {}),
    };
  }

  if (
    options.requestedSource !== undefined &&
    options.inferredBundleFromSource
  ) {
    return promptForActiveGlobalRemoveBundleSelection({
      globalState: options.globalState,
      prompts: options.prompts,
      source: options.requestedSource,
    });
  }

  if (options.requestedBundle !== undefined) {
    return { bundle: options.requestedBundle };
  }

  return promptForActiveGlobalRemoveBundleSelection({
    globalState: options.globalState,
    prompts: options.prompts,
  });
}

async function promptForActiveGlobalRemoveBundleSelection(options: {
  globalState?: GlobalState;
  prompts: PromptClient;
  source?: string;
}): Promise<{ bundle: string; source?: string }> {
  const activeSelections = listActiveGlobalRemoveBundleSelections({
    globalState: options.globalState,
    source: options.source,
  });

  if (activeSelections.length === 0) {
    throw new Error(
      options.source
        ? `No active global bundles found for ${options.source}. Run "skul add --global ${options.source} <bundle>" to add one first`
        : 'No active global bundles found. Run "skul add --global <bundle>" to add one first',
    );
  }

  if (activeSelections.length === 1) {
    return activeSelections[0]!;
  }

  const selection = await options.prompts.selectBundleFromSelections(
    activeSelections,
    options.source,
  );

  return {
    bundle: selection.bundle,
    ...(selection.source !== undefined ? { source: selection.source } : {}),
  };
}

function listActiveGlobalRemoveBundleSelections(options: {
  globalState?: GlobalState;
  source?: string;
}): BundleSelection[] {
  const selections: BundleSelection[] = [];
  const seen = new Set<string>();

  for (const entry of options.globalState?.desired_state ?? []) {
    if (!matchesOptionalSource(entry.source, options.source)) continue;
    addActiveRemoveBundleSelection(selections, seen, {
      bundle: entry.bundle,
      ...(entry.source !== undefined ? { source: entry.source } : {}),
      protocol: entry.protocol,
    });
  }

  for (const [bundle, state] of Object.entries(
    options.globalState?.materialized_state.bundles ?? {},
  )) {
    if (!matchesOptionalSource(state.source, options.source)) continue;
    addActiveRemoveBundleSelection(selections, seen, {
      bundle,
      ...(state.source !== undefined ? { source: state.source } : {}),
    });
  }

  return selections.sort(compareBundleSelections);
}

function isGlobalRemoveBundleActive(options: {
  globalState?: GlobalState;
  bundle: string;
  source?: string;
}): boolean {
  const desiredMatch =
    options.globalState?.desired_state.some(
      (entry) =>
        entry.bundle === options.bundle &&
        matchesOptionalSource(entry.source, options.source),
    ) ?? false;

  return (
    desiredMatch ||
    findGlobalMaterializedBundleState({
      globalState: options.globalState,
      bundle: options.bundle,
      source: options.source,
    }) !== undefined
  );
}

function findGlobalMaterializedBundleState(options: {
  globalState?: GlobalState;
  bundle: string;
  source?: string;
}): MaterializedBundleState | undefined {
  const bundleState =
    options.globalState?.materialized_state.bundles[options.bundle];

  if (
    !bundleState ||
    !matchesOptionalSource(bundleState.source, options.source)
  ) {
    return undefined;
  }

  return bundleState;
}

async function removeGlobalBundleItems(options: {
  homeDir: string;
  prompts: PromptClient;
  registryFile: string;
  libraryDir: string;
  registry: Registry;
  globalState?: GlobalState;
  desiredEntry?: DesiredBundleEntry;
  bundle: string;
  source?: string;
  includeItems: BundleItemSelector[];
  selectItems: boolean;
  dryRun: boolean;
  warnings?: CommandWarningCollector;
}): Promise<{ kind: "completed"; output: string } | { kind: "remove-bundle" }> {
  if (!options.globalState || !options.desiredEntry) {
    throw new Error(
      `Cannot remove selected items from global ${options.bundle} because it is not in desired state`,
    );
  }

  const cachedBundle = findCachedBundleWithGuidance({
    libraryDir: options.libraryDir,
    bundle: options.bundle,
    source: options.desiredEntry.source ?? options.source,
  });
  const selectedTools =
    options.desiredEntry.tools ??
    (Object.keys(cachedBundle.manifest.tools).filter((toolName) =>
      globalCapableToolNames().includes(toolName as ToolName),
    ) as ToolName[]);
  const availableItems = listSelectableBundleItems({
    bundleDir: path.dirname(cachedBundle.manifestFile),
    manifest: cachedBundle.manifest,
    tools: selectedTools,
  });
  const currentItems = options.desiredEntry.items ?? availableItems;
  const requestedItems = normalizeBundleItemSelectors(options.includeItems);

  assertBundleSupportsRequestedItems({
    requestedItems,
    availableItems,
  });

  const inactiveRequestedItems = requestedItems.filter(
    (item) => !currentItems.includes(item),
  );
  if (inactiveRequestedItems.length > 0) {
    throw new Error(
      `Bundle item(s) are not active in global ${options.bundle}: ${inactiveRequestedItems.join(", ")}`,
    );
  }

  const selectedItems = options.selectItems
    ? await options.prompts.selectBundleItems(
        currentItems,
        requestedItems,
        "remove",
      )
    : requestedItems;
  const normalizedSelectedItems = normalizeBundleItemSelectors(selectedItems);
  const inactiveItems = normalizedSelectedItems.filter(
    (item) => !currentItems.includes(item),
  );

  if (inactiveItems.length > 0) {
    throw new Error(
      `Bundle item(s) are not active in global ${options.bundle}: ${inactiveItems.join(", ")}`,
    );
  }

  const selectedItemSet = new Set(normalizedSelectedItems);
  const remainingItems = currentItems.filter(
    (item) => !selectedItemSet.has(item),
  );

  if (remainingItems.length === 0) {
    return { kind: "remove-bundle" };
  }

  if (options.dryRun) {
    return {
      kind: "completed",
      output: `${pc.yellow("DRY RUN:")} Would remove ${normalizedSelectedItems.join(", ")} from global ${options.bundle}`,
    };
  }

  const nextRegistry = upsertGlobalState(options.registry, {
    ...options.globalState,
    desired_state: options.globalState.desired_state.map((entry) =>
      entry.bundle === options.bundle &&
      matchesOptionalSource(entry.source, options.source)
        ? { ...entry, items: remainingItems }
        : entry,
    ),
  });

  writeRegistryFile(options.registryFile, nextRegistry);

  try {
    await applyGlobal({
      homeDir: options.homeDir,
      prompts: options.prompts,
      registryFile: options.registryFile,
      libraryDir: options.libraryDir,
      dryRun: false,
      warnings: options.warnings,
    });
  } catch (error) {
    writeRegistryFile(options.registryFile, options.registry);
    throw error;
  }

  return {
    kind: "completed",
    output: pc.green(
      `Removed ${normalizedSelectedItems.join(", ")} from global ${options.bundle}`,
    ),
  };
}

async function resetGlobal(options: {
  homeDir: string;
  prompts: PromptClient;
  registryFile: string;
  dryRun: boolean;
  warnings?: CommandWarningCollector;
}): Promise<string> {
  let registry = readRegistryWithGuidance(options.registryFile);
  const globalState = registry.global;

  if (
    !globalState ||
    Object.keys(globalState.materialized_state.bundles).length === 0
  ) {
    return "No globally materialized Skul bundles found";
  }

  const allBundleEntries = Object.entries(
    globalState.materialized_state.bundles,
  );
  const allBundlePaths = allBundleEntries.map(([, bundleState]) =>
    flattenBundleState(bundleState),
  );
  const mcpOwnership = createMcpMaterializationOwnership(
    globalState.materialized_state,
  );
  const allFiles = Array.from(
    new Set(
      allBundlePaths.flatMap((bp) => [
        ...bp.files,
        ...bp.mcp_servers.map(({ path: filePath }) => filePath),
      ]),
    ),
  );

  if (options.dryRun) {
    const lines = [
      `${pc.yellow("DRY RUN:")} Would remove ${allFiles.length} globally managed file(s)`,
    ];
    for (const file of allFiles) lines.push(`  ${file}`);
    return lines.join("\n");
  }

  for (const bundlePaths of allBundlePaths) {
    const resetAllowed = await confirmManagedFileRemovals(
      options.homeDir,
      bundlePaths,
      options.prompts,
      "reset",
    );
    if (!resetAllowed) {
      throw new Error("Reset aborted because a modified managed file was kept");
    }
  }

  const failedBundleStates: Record<string, MaterializedBundleState> = {};
  for (const [bundleName, bundleState] of allBundleEntries) {
    const removalResult = removeManagedPaths(
      options.homeDir,
      flattenBundleState(bundleState),
      {
        restoreCommitted: false,
        mcpOwnership,
        warnings: options.warnings,
      },
    );
    const retained = retainFailedMcpBundleState(
      bundleState,
      removalResult.failedMcpServers,
    );
    if (retained) failedBundleStates[bundleName] = retained;
  }

  // reset --global removes all bundle materialization entirely; shared root-instruction files
  // (e.g. .claude/CLAUDE.md) are not re-composed for remaining bundles — base content is restored
  // as-is. Run `apply --global` afterward to re-materialize from desired state.
  restoreRootInstructionBaseContents({
    repoRoot: options.homeDir,
    baseContents: globalState.materialized_state.root_instruction_base_contents,
    targetPaths: collectManagedRootInstructionTargets(
      globalState.materialized_state.bundles,
    ),
  });

  registry = upsertGlobalState(registry, {
    desired_state: globalState.desired_state,
    materialized_state: {
      bundles: failedBundleStates,
      ...mcpOwnership.toRegistryFields(),
    },
  });
  writeRegistryFile(options.registryFile, registry);

  return pc.green("Reset globally managed Skul files");
}

async function applyGlobal(options: {
  homeDir: string;
  prompts: PromptClient;
  registryFile: string;
  libraryDir: string;
  dryRun: boolean;
  warnings?: CommandWarningCollector;
}): Promise<string> {
  const registry = readRegistryWithGuidance(options.registryFile);
  const globalState = registry.global;

  if (!globalState || globalState.desired_state.length === 0) {
    return `No global bundles configured. Run "skul add --global <bundle>" to add one`;
  }

  const outputLines: string[] = [];
  const toApply = globalState.desired_state.filter((entry) => {
    const mat = globalState.materialized_state.bundles[entry.bundle];
    if (!mat) return true;
    if (
      !isDesiredBundleMaterialized({
        desiredEntry: entry,
        materializedBundleState: mat,
        availableTools: globalCapableToolNames(),
      })
    )
      return true;
    if (
      entry.source &&
      !readCachedSourceRevision({
        source: entry.source,
        libraryDir: options.libraryDir,
      }).cached
    )
      return true;
    return false;
  });

  if (toApply.length === 0) {
    return options.dryRun
      ? "DRY RUN: All global bundles are already materialized"
      : "All global bundles are already materialized";
  }

  if (options.dryRun) {
    return toApply
      .map((e) => `${pc.yellow("DRY RUN:")} Would apply ${e.bundle} globally`)
      .join("\n");
  }

  for (const entry of toApply) {
    try {
      const result = await applyBundleGlobal({
        homeDir: options.homeDir,
        prompts: options.prompts,
        registryFile: options.registryFile,
        libraryDir: options.libraryDir,
        bundle: entry.bundle,
        source: entry.source,
        protocol: entry.protocol,
        agents: entry.tools ?? [],
        includeItems: entry.items ?? [],
        selectItems: false,
        dryRun: false,
        ref: entry.ref,
        warnings: options.warnings,
      });
      outputLines.push(result);
    } catch (err) {
      outputLines.push(
        `${pc.red("ERROR:")} Failed to apply ${entry.bundle}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return outputLines.join("\n");
}

function assertUnreachable(_value: never): never {
  throw new Error("Unhandled command");
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
