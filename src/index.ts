#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createColors, isColorSupported } from "picocolors";

import { detectSourceProtocol, findCachedBundle, listCachedBundles, type CachedBundle } from "./bundle-discovery";
import {
  clearAllCachedSources,
  clearCachedSource,
  type CachedSourceRevision,
  fetchRemoteSource,
  inspectRemoteSource,
  listCachedSources,
  removeCachedRemoteSource,
  readCachedSourceRevision,
  restoreCachedRemoteSourceRevision,
  updateCachedRemoteSource,
} from "./bundle-fetch";
import {
  materializeBundle,
  previewMaterializeBundleWriteTargets,
  type MaterializeBundleResult,
} from "./bundle-materialization";
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
import {
  clearGitSkipWorktree,
  inspectRootInstructionShadowTarget,
  setGitSkipWorktree,
} from "./git-index";
import { configureSkulExcludeBlock, hasSkulExcludeBlock, removeSkulExcludeBlock } from "./git-exclude";
import {
  type DesiredBundleEntry,
  type MaterializedBundleState,
  type MaterializedState,
  type ShadowedFileState,
  type MaterializedToolState,
  listManagedPathsForRemoval,
  readRegistryFile,
  removeWorktreeState,
  upsertRepoState,
  upsertWorktreeState,
  writeRegistryFile,
} from "./registry";
import { collectComposedRootInstructionContents } from "./root-instruction-content";
import { isRootInstructionPath, renderTrackedRootInstructionShadow } from "./root-instruction-render";
import {
  assertManagedRootInstructionSyncSourcesCached,
  captureRootInstructionBaseContents,
  collectManagedRootInstructionTargets,
  collectSharedRootInstructionState,
  refreshManagedFileFingerprintsForPaths,
  restoreRootInstructionBaseContents,
  syncManagedRootInstructionFiles,
} from "./root-instruction-state";
import { resolveGlobalStateLayout } from "./state-layout";
import { getToolDefinition, type ToolName } from "./tool-mapping";

// Lazily evaluated so that SKUL_NO_TUI set after module load (e.g. in tests) is respected.
const pc = new Proxy({} as ReturnType<typeof createColors>, {
  get(_t, prop: string) {
    return createColors(isColorSupported && !isHeadlessMode())[prop as keyof ReturnType<typeof createColors>];
  },
});

export interface RunOptions {
  homeDir?: string;
  cwd?: string;
  prompts?: PromptClient;
}

/** Parses CLI arguments and executes the selected Skul command. */
export async function run(argv: string[], options: RunOptions = {}): Promise<string> {
  const stateLayout = resolveGlobalStateLayout({ homeDir: options.homeDir ?? os.homedir() });
  const prompts = options.prompts ?? createDefaultPromptClient(stateLayout.libraryDir);
  const parsed = await parseCliArgs(argv, prompts);
  const cwd = options.cwd ?? process.cwd();

  if (parsed.kind === "help") {
    return createHelpText(parsed.command);
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

  if (parsed.command === "shadow") {
    return shadowWorktree({
      cwd,
      registryFile: stateLayout.registryFile,
      action: parsed.options.action,
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
      libraryDir: stateLayout.libraryDir,
      bundle: parsed.options.bundle,
      dryRun: parsed.options.dryRun,
    });
  }

  if (parsed.command === "clear-cache") {
    return clearBundleCache({
      source: parsed.options.source,
      all: parsed.options.all,
      libraryDir: stateLayout.libraryDir,
      dryRun: parsed.options.dryRun,
    });
  }

  if (parsed.command === "apply") {
    return applyWorktree({
      cwd,
      prompts,
      registryFile: stateLayout.registryFile,
      libraryDir: stateLayout.libraryDir,
      dryRun: parsed.options.dryRun,
    });
  }

  // All known commands are handled above — this branch is unreachable at runtime.
  return "Command not implemented";
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
    return "No tracked root-instruction shadows found in the current worktree";
  }

  const nextShadowedFiles =
    options.action === "suspend"
      ? suspendTrackedRootInstructionShadows({
          repoRoot: gitContext.worktreeRoot,
          shadowedFiles,
        })
      : refreshTrackedRootInstructionShadows({
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
  return `${actionLabel} tracked root-instruction shadows for ${shadowedFilePaths.sort().join(", ")}`;
}

function suspendTrackedRootInstructionShadows(options: {
  repoRoot: string;
  shadowedFiles: Record<string, ShadowedFileState>;
}): Record<string, ShadowedFileState> {
  const plans = Object.entries(options.shadowedFiles)
    .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
    .map(([filePath, shadowedFile]) => {
      assertTrackedRootInstructionShadowSafetyForAction({
        repoRoot: options.repoRoot,
        filePath,
        action: "suspend",
      });

      if (shadowedFile.skip_worktree) {
        assertTrackedRootInstructionShadowPristine({
          repoRoot: options.repoRoot,
          filePath,
          shadowedFile,
          action: "suspend",
        });
      }

      return { filePath, shadowedFile };
    });

  for (const plan of plans) {
    restoreTrackedRootInstructionShadowTarget({
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

function refreshTrackedRootInstructionShadows(options: {
  repoRoot: string;
  shadowedFiles: Record<string, ShadowedFileState>;
}): Record<string, ShadowedFileState> {
  const plans = Object.entries(options.shadowedFiles)
    .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
    .map(([filePath, shadowedFile]) => {
      assertTrackedRootInstructionShadowSafetyForAction({
        repoRoot: options.repoRoot,
        filePath,
        action: "refresh",
      });

      if (shadowedFile.skip_worktree) {
        assertTrackedRootInstructionShadowPristine({
          repoRoot: options.repoRoot,
          filePath,
          shadowedFile,
          action: "refresh",
        });
      }

      const headBlob = requireTrackedRootInstructionHeadBlob({
        repoRoot: options.repoRoot,
        filePath,
        action: "refresh",
      });
      const render = renderTrackedRootInstructionShadow({
        baseContent: headBlob.content,
        overlayContent: shadowedFile.overlay,
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

function requireTrackedRootInstructionHeadBlob(options: {
  repoRoot: string;
  filePath: string;
  action: "create" | "refresh" | "suspend";
}) {
  const inspection = inspectRootInstructionShadowTarget({
    repoRoot: options.repoRoot,
    filePath: options.filePath,
  });

  if (inspection.headBlob) {
    return inspection.headBlob;
  }

  throw new Error(
    `Cannot ${options.action} tracked root-instruction shadow for ${options.filePath} because the target does not have HEAD content`,
  );
}

function assertTrackedRootInstructionShadowPristine(options: {
  repoRoot: string;
  filePath: string;
  shadowedFile: ShadowedFileState;
  action: "refresh" | "suspend";
}): void {
  const targetPath = path.join(options.repoRoot, options.filePath);

  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
    return;
  }

  if (fingerprintFile(targetPath) === options.shadowedFile.rendered_fingerprint) {
    return;
  }

  throw new Error(
    `Cannot ${options.action} tracked root-instruction shadow for ${options.filePath} because the shadow file has local manual edits`,
  );
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
    return [
      pc.bold("Available Bundles"),
      "",
      "No cached bundles found.",
      "",
      pc.dim("Add one with: skul add github.com/<owner>/<repo> <bundle-name>"),
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

function clearBundleCache(options: {
  source?: string;
  all: boolean;
  libraryDir: string;
  dryRun: boolean;
}): string {
  if (options.all) {
    const cachedSources = listCachedSources(options.libraryDir);

    if (options.dryRun) {
      return cachedSources.length > 0
        ? `DRY RUN: Would clear cache for ${cachedSources.length} source(s)`
        : "DRY RUN: No cached sources found";
    }

    const result = clearAllCachedSources({ libraryDir: options.libraryDir });

    return result.clearedSources.length > 0
      ? `Cleared cache for ${result.clearedSources.length} source(s)`
      : "No cached sources found";
  }

  const revision = readCachedSourceRevision({
    source: options.source!,
    libraryDir: options.libraryDir,
  });

  if (options.dryRun) {
    return revision.cached
      ? `DRY RUN: Would clear cache for ${options.source!}`
      : `DRY RUN: No cached source found for ${options.source!}`;
  }

  const result = clearCachedSource({
    source: options.source!,
    libraryDir: options.libraryDir,
  });

  return result.cleared
    ? `Cleared cache for ${options.source!}`
    : `No cached source found for ${options.source!}`;
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
          shadowed_files: buildShadowedFilesJson(shadowedInstructionStatuses),
          git_exclude_configured: hasSkulExcludeBlock({ gitDir: gitContext.gitDir }),
        }
      : {
          path: gitContext.worktreeRoot,
          materialized: false,
          bundles: {},
          shadowed_files: buildShadowedFilesJson(shadowedInstructionStatuses),
          git_exclude_configured: hasSkulExcludeBlock({ gitDir: gitContext.gitDir }),
        };

    const suggestedAction =
      !hasMaterializedBundles && repoState && repoState.desired_state.length > 0 ? "skul apply" : null;

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

  lines.push("", pc.bold("Current Worktree"), `Path: ${gitContext.worktreeRoot}`);

  if (!hasMaterializedBundles) {
    lines.push(pc.dim("Materialized: no"));

    appendShadowedInstructionLines(lines, shadowedInstructionStatuses);

    if (repoState && repoState.desired_state.length > 0) {
      lines.push(pc.yellow('Suggested Action: run "skul apply"'));
    }

    return lines.join("\n");
  }

  lines.push(pc.green("Materialized: yes"), "", "Files:");

  for (const [bundleName, bundleState] of Object.entries(worktreeState.materialized_state.bundles)) {
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
  lines.push(`  ${hasSkulExcludeBlock({ gitDir: gitContext.gitDir }) ? pc.green("configured") : pc.yellow("missing")}`);

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
  const inspection = inspectRootInstructionShadowTarget({
    repoRoot: options.repoRoot,
    filePath: options.filePath,
  });
  const targetPath = path.join(options.repoRoot, options.filePath);
  const currentContent = readStatusTargetFile(targetPath);
  const overlay = extractTrackedRootInstructionOverlay({
    content: currentContent,
    bundleName: options.shadowedFile.bundle,
    strategy: options.shadowedFile.strategy,
  });

  return {
    path: options.filePath,
    ...options.shadowedFile,
    active: overlay !== null,
    base_fresh: inspection.headBlob?.objectId === options.shadowedFile.base_blob,
    overlay_fresh:
      overlay !== null &&
      fingerprintTextContent(overlay) === options.shadowedFile.overlay_fingerprint,
    skip_worktree_active: inspection.indexFlags.includes("S"),
    manual_edit_suspected:
      currentContent === null ||
      fingerprintTextContent(currentContent) !== options.shadowedFile.rendered_fingerprint,
  };
}

function buildShadowedFilesJson(shadowedInstructionStatuses: ShadowedInstructionStatus[]) {
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
    lines.push(`    Active: ${status.active ? pc.green("yes") : pc.yellow("no")}`);
    lines.push(`    Base: ${status.base_fresh ? pc.green("current") : pc.yellow("stale")}`);
    lines.push(`    Overlay: ${status.overlay_fresh ? pc.green("current") : pc.yellow("stale")}`);
    lines.push(`    Skip-worktree: ${status.skip_worktree_active ? pc.green("set") : pc.yellow("missing")}`);
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

function extractTrackedRootInstructionOverlay(options: {
  content: string | null;
  bundleName: string;
  strategy: ShadowedFileState["strategy"];
}): string | null {
  if (options.content === null) {
    return null;
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

function fingerprintTextContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function worktreeHasMaterializedBundles(materializedState: MaterializedState): boolean {
  return Object.keys(materializedState.bundles).length > 0;
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
    return `No bundles configured for this repository. Run "skul add <bundle>" to add one`;
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

  const lines = results.map((result) => {
    if (result.status === "local-only") {
      return `${pc.cyan(result.bundle)}: local-only (no remote source to check)`;
    }
    const updateSuffix =
      result.status === "update-available" && result.current_commit && result.latest_commit
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
  const entries = selectDesiredEntries(repoState?.desired_state ?? [], options.bundle, "update");

  if (entries.length === 0) {
    return `No bundles configured for this repository. Run "skul add <bundle>" to add one`;
  }

  const skippedLocalOnly: string[] = [];
  const updatePlans = entries.flatMap((entry) => {
    if (!entry.source) {
      skippedLocalOnly.push(entry.bundle);
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

  const localOnlyNote = skippedLocalOnly.length > 0
    ? `Skipped (local-only): ${skippedLocalOnly.join(", ")}`
    : "";

  if (updatePlans.length === 0) {
    if (skippedLocalOnly.length === entries.length) {
      return `No remote-backed bundles to update (${skippedLocalOnly.join(", ")} ${skippedLocalOnly.length === 1 ? "is" : "are"} local-only)`;
    }
    return [localOnlyNote, "All selected bundles are already up to date"].filter(Boolean).join("\n");
  }

  if (options.dryRun) {
    const dryLines = updatePlans.map(
      ({ entry, currentCommit, remoteStatus }) =>
        `${pc.yellow("DRY RUN:")} Would update ${entry.bundle}${formatCommitTransition(currentCommit, remoteStatus.remoteCommit)}`,
    );
    return [localOnlyNote, ...dryLines].filter(Boolean).join("\n");
  }

  const existingWorktreeState = registry.worktrees[gitContext.worktreeId]?.materialized_state;
  let currentBundles: MaterializedState["bundles"] = { ...(existingWorktreeState?.bundles ?? {}) };
  let currentShadowedFiles = { ...(worktreeState?.shadowed_files ?? {}) };
  const nextDesiredState = [...(repoState?.desired_state ?? [])];
  const outputLines: string[] = [];
  let rootInstructionBaseContents = worktreeState?.materialized_state.root_instruction_base_contents;

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
      ref: entry.ref,
    });

    try {
      const refreshed = updateCachedRemoteSource({
        source: entry.source!,
        libraryDir: options.libraryDir,
        protocol: entry.protocol,
        ref: entry.ref,
      });
      const cachedBundle = findCachedBundleWithGuidance({
        libraryDir: options.libraryDir,
        bundle: entry.bundle,
        source: entry.source,
      });

      const plannedWriteTargets = previewMaterializeBundleWriteTargets({
        repoRoot: gitContext.worktreeRoot,
        bundleDir: path.dirname(cachedBundle.manifestFile),
        manifest: cachedBundle.manifest,
        tools: toolsToRefresh,
      });
      const plannedRootInstructionTargets = new Set(
        plannedWriteTargets.filter((filePath) => isRootInstructionPath(filePath)),
      );
      const trackedRootInstructionShadowPlan = planTrackedRootInstructionShadows({
        repoRoot: gitContext.worktreeRoot,
        bundleDir: path.dirname(cachedBundle.manifestFile),
        manifest: cachedBundle.manifest,
        toolNames: selectTrackedRootInstructionShadowToolNames({
          existingBundleState,
          nextToolNames: toolsToRefresh ?? (Object.keys(cachedBundle.manifest.tools) as ToolName[]),
        }),
        targetPaths: plannedRootInstructionTargets,
        bundleName: entry.bundle,
        bundleSource: entry.source,
        existingShadowedFiles: currentShadowedFiles,
        materializedBundles: currentBundles,
      });

      if (existingBundleState) {
        const replacementAllowed = await confirmManagedFileRemovals(
          gitContext.worktreeRoot,
          excludeShadowedTrackedRootInstructionTargets(
            flattenBundleState(bundleStateToReplace),
            trackedRootInstructionShadowPlan.deferredMaterializationTargets,
          ),
          options.prompts,
          "replace",
        );

        if (!replacementAllowed) {
          throw new Error("Replacement aborted because a modified managed file was kept");
        }
      }
      assertTrackedRootInstructionShadowPlanCanApply({
        repoRoot: gitContext.worktreeRoot,
        bundleName: entry.bundle,
        existingShadowedFiles: currentShadowedFiles,
        plan: trackedRootInstructionShadowPlan,
      });

      rootInstructionBaseContents = captureRootInstructionBaseContents({
        repoRoot: gitContext.worktreeRoot,
        targetPaths: trackedRootInstructionShadowPlan.untrackedTargetPaths,
        existingBaseContents: rootInstructionBaseContents,
        managedTargetPaths: collectManagedRootInstructionTargets(currentBundles),
      });

      assertManagedRootInstructionSyncSourcesCached({
        desiredState: nextDesiredState,
        materializedBundles: currentBundles,
        targetPaths: trackedRootInstructionShadowPlan.untrackedTargetPaths,
        resolveCachedBundle: (entry) => resolveDesiredCachedBundle(options.libraryDir, entry),
      });

      if (existingBundleState) {
        assertTrackedRootInstructionShadowSafetyForPaths({
          repoRoot: gitContext.worktreeRoot,
          operation: "refresh",
          filePaths: plannedWriteTargets,
        });
      }
      const desiredIndex = nextDesiredState.findIndex((candidate) => candidate.bundle === entry.bundle);

      nextDesiredState[desiredIndex] = {
        ...nextDesiredState[desiredIndex]!,
        ...(refreshed.resolvedRef !== undefined ? { resolved_ref: refreshed.resolvedRef } : {}),
        resolved_commit: refreshed.currentCommit,
      };

      if (bundleStateToReplace) {
        removeManagedPaths(
          gitContext.worktreeRoot,
          excludeShadowedTrackedRootInstructionTargets(
            flattenBundleState(bundleStateToReplace),
            trackedRootInstructionShadowPlan.deferredMaterializationTargets,
          ),
        );
        const materializedResult = await materializeBundle({
          repoRoot: gitContext.worktreeRoot,
          bundleDir: path.dirname(cachedBundle.manifestFile),
          manifest: cachedBundle.manifest,
          tools: toolsToRefresh,
          bundleName: entry.bundle,
          bundleSource: entry.source,
          assertSafeWriteTarget: createTrackedRootInstructionShadowSafetyAssertion({
            repoRoot: gitContext.worktreeRoot,
            operation: existingBundleState ? "refresh" : "create",
          }),
          allowFileOverwriteTargets: collectManagedRootInstructionTargets(currentBundles),
          deferredWriteTargets: trackedRootInstructionShadowPlan.deferredMaterializationTargets,
          rootInstructionBaseContents,
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
        currentShadowedFiles = applyTrackedRootInstructionShadowPlan({
          repoRoot: gitContext.worktreeRoot,
          bundleName: entry.bundle,
          existingShadowedFiles: currentShadowedFiles,
          plan: trackedRootInstructionShadowPlan,
        });

        const syncedRootInstructionPaths = syncManagedRootInstructionFiles({
          repoRoot: gitContext.worktreeRoot,
          desiredState: nextDesiredState,
          materializedBundles: currentBundles,
          rootInstructionBaseContents,
          targetPaths: trackedRootInstructionShadowPlan.untrackedTargetPaths,
          resolveCachedBundle: (entry) => resolveDesiredCachedBundle(options.libraryDir, entry),
        });
        currentBundles = refreshManagedFileFingerprintsForPaths(
          gitContext.worktreeRoot,
          currentBundles,
          syncedRootInstructionPaths,
        );
      }

      outputLines.push(
        pc.green(`Updated ${entry.bundle}${formatCommitTransition(currentCommit, remoteStatus.remoteCommit)}`),
      );
    } catch (error) {
      if (!initialRevision.cached) {
        removeCachedRemoteSource({
          source: entry.source!,
          libraryDir: options.libraryDir,
          protocol: entry.protocol,
        });
      } else if (initialRevision.currentCommit) {
        restoreCachedRemoteSourceRevision({
          source: entry.source!,
          libraryDir: options.libraryDir,
          protocol: entry.protocol,
          ref: entry.ref,
          commit: initialRevision.currentCommit,
          refName: initialRevision.currentRef,
        });
      }

      throw error;
    }
  }

  registry = upsertRepoState(registry, gitContext.repoFingerprint, {
    repo_root: gitContext.repoRoot,
    desired_state: nextDesiredState,
  });

  if (registry.worktrees[gitContext.worktreeId] || Object.keys(currentBundles).length > 0) {
    const managedFiles = collectAllFiles({
      bundles: currentBundles,
      exclude_configured: false,
      ...(rootInstructionBaseContents !== undefined
        ? { root_instruction_base_contents: rootInstructionBaseContents }
        : {}),
    });
    const newMaterializedState: MaterializedState = {
      bundles: currentBundles,
      exclude_configured: managedFiles.length > 0,
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
    if (cloned) cloneLines.push(pc.dim(`Cloned ${options.source}`));
  }
  const cachedBundle = findCachedBundleWithGuidance({
    libraryDir: options.libraryDir,
    bundle: options.bundle,
    source: options.source,
  });
  const effectiveSource = options.source ?? cachedBundle.source;
  const sourceRevision = effectiveSource
    ? readCachedSourceRevision({
        source: effectiveSource,
        libraryDir: options.libraryDir,
      })
    : undefined;

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
    return [...cloneLines, `${pc.yellow("DRY RUN:")} Would apply ${cachedBundle.bundle} for ${toolLabel}`].join("\n");
  }

  let registry = readRegistryWithGuidance(options.registryFile);
  const existingWorktreeState = registry.worktrees[gitContext.worktreeId]?.materialized_state;
  let currentShadowedFiles = { ...(registry.worktrees[gitContext.worktreeId]?.shadowed_files ?? {}) };
  let rootInstructionBaseContents = existingWorktreeState?.root_instruction_base_contents;
  const existingBundleState = existingWorktreeState?.bundles[cachedBundle.bundle];
  const plannedWriteTargets = previewMaterializeBundleWriteTargets({
    repoRoot: gitContext.worktreeRoot,
    bundleDir: path.dirname(cachedBundle.manifestFile),
    manifest: cachedBundle.manifest,
    tools: hasToolSelection ? options.agents : undefined,
  });
  const plannedRootInstructionTargets = new Set(
    plannedWriteTargets.filter((filePath) => isRootInstructionPath(filePath)),
  );
  const trackedRootInstructionShadowPlan = planTrackedRootInstructionShadows({
    repoRoot: gitContext.worktreeRoot,
    bundleDir: path.dirname(cachedBundle.manifestFile),
    manifest: cachedBundle.manifest,
    toolNames: selectTrackedRootInstructionShadowToolNames({
      existingBundleState,
      nextToolNames: (hasToolSelection ? options.agents : availableTools) as ToolName[],
    }),
    targetPaths: plannedRootInstructionTargets,
    bundleName: cachedBundle.bundle,
    bundleSource: options.source ?? cachedBundle.source,
    existingShadowedFiles: currentShadowedFiles,
    materializedBundles: existingWorktreeState?.bundles ?? {},
  });
  rootInstructionBaseContents = captureRootInstructionBaseContents({
    repoRoot: gitContext.worktreeRoot,
    targetPaths: trackedRootInstructionShadowPlan.untrackedTargetPaths,
    existingBaseContents: rootInstructionBaseContents,
    managedTargetPaths: collectManagedRootInstructionTargets(existingWorktreeState?.bundles ?? {}),
  });
  const existingDesiredState = registry.repos[gitContext.repoFingerprint]?.desired_state ?? [];

  assertManagedRootInstructionSyncSourcesCached({
    desiredState: existingDesiredState,
    materializedBundles: existingWorktreeState?.bundles ?? {},
    targetPaths: trackedRootInstructionShadowPlan.untrackedTargetPaths,
    resolveCachedBundle: (entry) => resolveDesiredCachedBundle(options.libraryDir, entry),
  });

  let pathsToReplace: ReturnType<typeof excludeShadowedTrackedRootInstructionTargets> | null = null;

  if (existingBundleState) {
    assertTrackedRootInstructionShadowSafetyForPaths({
      repoRoot: gitContext.worktreeRoot,
      operation: "refresh",
      filePaths: plannedWriteTargets,
    });

    // When --agent is specified, only replace the selected agents; otherwise replace all agents for this bundle
    const toolsToReplace = hasToolSelection
      ? options.agents.filter((t) => t in existingBundleState.tools)
      : (Object.keys(existingBundleState.tools) as ToolName[]);

    pathsToReplace = excludeShadowedTrackedRootInstructionTargets(flattenBundleState({
      tools: Object.fromEntries(toolsToReplace.map((t) => [t, existingBundleState.tools[t]!])),
    }), trackedRootInstructionShadowPlan.deferredMaterializationTargets);

    const replacementAllowed = await confirmManagedFileRemovals(
      gitContext.worktreeRoot,
      pathsToReplace,
      options.prompts,
      "replace",
    );

    if (!replacementAllowed) {
      throw new Error("Replacement aborted because a modified managed file was kept");
    }
  }

  const sharedRootInstructionState = collectSharedRootInstructionState(
    existingWorktreeState?.bundles ?? {},
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
      throw new Error("Replacement aborted because a modified managed file was kept");
    }
  }
  assertTrackedRootInstructionShadowPlanCanApply({
    repoRoot: gitContext.worktreeRoot,
    bundleName: cachedBundle.bundle,
    existingShadowedFiles: currentShadowedFiles,
    plan: trackedRootInstructionShadowPlan,
  });

  assertTrackedRootInstructionShadowSafetyForPaths({
    repoRoot: gitContext.worktreeRoot,
    operation: existingBundleState ? "refresh" : "create",
    filePaths: plannedWriteTargets,
  });

  if (pathsToReplace) {
    removeManagedPaths(gitContext.worktreeRoot, pathsToReplace);
  }

  const materializedResult = await materializeBundle({
    repoRoot: gitContext.worktreeRoot,
    bundleDir: path.dirname(cachedBundle.manifestFile),
    manifest: cachedBundle.manifest,
    tools: hasToolSelection ? options.agents : undefined,
    bundleName: cachedBundle.bundle,
    bundleSource: options.source ?? cachedBundle.source,
    assertSafeWriteTarget: createTrackedRootInstructionShadowSafetyAssertion({
      repoRoot: gitContext.worktreeRoot,
      operation: existingBundleState ? "refresh" : "create",
    }),
    allowFileOverwriteTargets: collectManagedRootInstructionTargets(existingWorktreeState?.bundles ?? {}),
    deferredWriteTargets: trackedRootInstructionShadowPlan.deferredMaterializationTargets,
    rootInstructionBaseContents,
    resolveFileConflict: options.prompts.resolveFileConflict,
  });
  currentShadowedFiles = applyTrackedRootInstructionShadowPlan({
    repoRoot: gitContext.worktreeRoot,
    bundleName: cachedBundle.bundle,
    existingShadowedFiles: currentShadowedFiles,
    plan: trackedRootInstructionShadowPlan,
  });

  const newBundleState = buildMaterializedBundleState({
    existingBundleState,
    materializedResult,
    repoRoot: gitContext.worktreeRoot,
    source: options.source ?? cachedBundle.source,
    resolvedCommit: sourceRevision?.currentCommit,
    selectedTools: hasToolSelection ? options.agents : undefined,
  });

  // Append to desired_state if this bundle isn't already listed (idempotent add)
  const existingDesiredEntry = existingDesiredState.find((entry) => entry.bundle === cachedBundle.bundle);
  const mergedDesiredTools = mergeDesiredTools({
    existingEntry: existingDesiredEntry,
    requestedTools: hasToolSelection ? options.agents : undefined,
  });
  const preservesExistingRef =
    existingDesiredEntry?.ref !== undefined &&
    (options.source === undefined || options.source === existingDesiredEntry.source);
  const sourceProtocol =
    sourceRevision?.remoteUrl !== undefined
      ? detectSourceProtocol(sourceRevision.remoteUrl)
      : undefined;
  const desiredProtocol =
    options.source !== undefined
      ? options.protocol
      : existingDesiredEntry?.source !== undefined
        ? existingDesiredEntry.protocol ?? sourceProtocol ?? "https"
        : sourceProtocol ?? existingDesiredEntry?.protocol ?? "https";
  const newDesiredEntry: DesiredBundleEntry = {
    bundle: cachedBundle.bundle,
    ...(options.source !== undefined
      ? { source: options.source }
      : existingDesiredEntry?.source !== undefined
        ? { source: existingDesiredEntry.source }
        : cachedBundle.source !== undefined
          ? { source: cachedBundle.source }
        : {}),
    ...(mergedDesiredTools !== undefined ? { tools: mergedDesiredTools } : {}),
    protocol: desiredProtocol,
    ...(preservesExistingRef ? { ref: existingDesiredEntry.ref } : {}),
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
      [cachedBundle.bundle]: newBundleState,
    },
    exclude_configured: false,
    ...(rootInstructionBaseContents !== undefined
      ? { root_instruction_base_contents: rootInstructionBaseContents }
      : {}),
  };

  const syncedRootInstructionPaths = syncManagedRootInstructionFiles({
    repoRoot: gitContext.worktreeRoot,
    desiredState: newDesiredState,
    materializedBundles: newMatState.bundles,
    rootInstructionBaseContents,
    targetPaths: trackedRootInstructionShadowPlan.untrackedTargetPaths,
    resolveCachedBundle: (entry) => resolveDesiredCachedBundle(options.libraryDir, entry),
  });
  newMatState.bundles = refreshManagedFileFingerprintsForPaths(
    gitContext.worktreeRoot,
    newMatState.bundles,
    syncedRootInstructionPaths,
  );

  const managedFiles = collectAllFiles(newMatState);
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

  return [...cloneLines, pc.green(`Applied ${cachedBundle.bundle} for ${toolLabel}`)].join("\n");
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
  const hasMaterializedBundles = worktreeState
    ? worktreeHasMaterializedBundles(worktreeState.materialized_state)
    : false;
  const hasShadowedFiles = worktreeState ? Object.keys(worktreeState.shadowed_files).length > 0 : false;

  if (options.dryRun) {
    if (!hasMaterializedBundles && !hasShadowedFiles) {
      return `${pc.yellow("DRY RUN:")} No Skul-managed files found in the current worktree`;
    }

    const allFiles = Object.values(worktreeState.materialized_state.bundles).flatMap(
      (bundleState) => Object.values(bundleState.tools).flatMap((toolState) => toolState.files),
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

    const remainingShadowedFiles = retireTrackedRootInstructionShadows({
      repoRoot: gitContext.worktreeRoot,
      shadowedFiles: worktreeState.shadowed_files,
      filePaths: Object.keys(worktreeState.shadowed_files),
    });

    for (const bundlePaths of allBundlePaths) {
      removeManagedPaths(gitContext.worktreeRoot, bundlePaths);
    }

    restoreRootInstructionBaseContents({
      repoRoot: gitContext.worktreeRoot,
      baseContents: worktreeState.materialized_state.root_instruction_base_contents,
      targetPaths: collectManagedRootInstructionTargets(worktreeState.materialized_state.bundles),
    });

    if (Object.keys(remainingShadowedFiles).length > 0) {
      registry = upsertWorktreeState(registry, gitContext.worktreeId, {
        repo_fingerprint: gitContext.repoFingerprint,
        path: gitContext.worktreeRoot,
        materialized_state: {
          bundles: {},
          exclude_configured: false,
          ...(worktreeState.materialized_state.root_instruction_base_contents !== undefined
            ? {
                root_instruction_base_contents:
                  worktreeState.materialized_state.root_instruction_base_contents,
              }
            : {}),
        },
        shadowed_files: remainingShadowedFiles,
      });
    } else {
      registry = removeWorktreeState(registry, gitContext.worktreeId);
    }
    writeRegistryFile(options.registryFile, registry);
  }

  const excludeRemoved = removeSkulExcludeBlock({ gitDir: gitContext.gitDir });

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
  bundle: string;
  dryRun: boolean;
}): Promise<string> {
  const gitContext = requireGitContext(options.cwd, "remove");

  let registry = readRegistryWithGuidance(options.registryFile);
  const repoState = registry.repos[gitContext.repoFingerprint];
  const worktreeState = registry.worktrees[gitContext.worktreeId];

  const isInDesiredState = repoState?.desired_state.some((e) => e.bundle === options.bundle) ?? false;
  const bundleMaterializedState = worktreeState?.materialized_state.bundles[options.bundle];
  const shadowedFilesForBundle = Object.entries(worktreeState?.shadowed_files ?? {}).filter(
    ([, shadowedFile]) => shadowedFile.bundle === options.bundle,
  );

  if (!isInDesiredState && !bundleMaterializedState) {
    const configured = repoState?.desired_state.map((e) => e.bundle) ?? [];
    const hint = configured.length > 0
      ? `Configured bundles: ${configured.join(", ")}`
      : `No bundles are configured yet. Run "skul add <bundle>" to add one`;
    throw new Error(`Bundle not found in active set: ${options.bundle}. ${hint}`);
  }

  if (options.dryRun) {
    if (bundleMaterializedState || shadowedFilesForBundle.length > 0) {
      const files = bundleMaterializedState
        ? Object.values(bundleMaterializedState.tools).flatMap((toolState) => toolState.files)
        : [];
      const lines = [
        `${pc.yellow("DRY RUN:")} Would remove ${options.bundle} (${files.length + shadowedFilesForBundle.length} file(s))`,
      ];
      for (const file of files) {
        lines.push(`  ${file}`);
      }
      for (const [filePath] of shadowedFilesForBundle) {
        lines.push(`  ${filePath}`);
      }
      return lines.join("\n");
    }

    return `${pc.yellow("DRY RUN:")} Would remove ${options.bundle} from desired state (not yet materialized in this worktree)`;
  }

  let currentShadowedFiles = { ...(worktreeState?.shadowed_files ?? {}) };

  if (bundleMaterializedState || shadowedFilesForBundle.length > 0) {
    const bundlePaths = bundleMaterializedState
      ? flattenBundleState(bundleMaterializedState)
      : { files: [], file_fingerprints: {}, directories: [] };
    const rootInstructionBaseContents = worktreeState?.materialized_state.root_instruction_base_contents;
    const removedRootInstructionPaths = new Set(
      bundlePaths.files.filter((filePath) => isRootInstructionPath(filePath)),
    );
    const remainingBundles = { ...worktreeState!.materialized_state.bundles };
    delete remainingBundles[options.bundle];
    const remainingDesiredState = repoState?.desired_state.filter((e) => e.bundle !== options.bundle) ?? [];
    const rewrittenRootInstructionPaths = new Set(
      Array.from(collectManagedRootInstructionTargets(remainingBundles)).filter((filePath) =>
        removedRootInstructionPaths.has(filePath),
      ),
    );

    assertManagedRootInstructionSyncSourcesCached({
      desiredState: remainingDesiredState,
      materializedBundles: remainingBundles,
      targetPaths: rewrittenRootInstructionPaths,
      resolveCachedBundle: (entry) => resolveDesiredCachedBundle(options.libraryDir, entry),
    });

    const removeAllowed = await confirmManagedFileRemovals(
      gitContext.worktreeRoot,
      bundlePaths,
      options.prompts,
      "remove",
    );

    if (!removeAllowed) {
      throw new Error("Removal aborted because a modified managed file was kept");
    }

    currentShadowedFiles = retireTrackedRootInstructionShadows({
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

    removeManagedPaths(gitContext.worktreeRoot, bundlePaths);
    const remainingRootInstructionTargets = collectManagedRootInstructionTargets(remainingBundles);
    const restoredRootInstructionPaths = new Set(
      Array.from(removedRootInstructionPaths).filter((filePath) => !remainingRootInstructionTargets.has(filePath)),
    );
    restoreRootInstructionBaseContents({
      repoRoot: gitContext.worktreeRoot,
      baseContents: rootInstructionBaseContents,
      targetPaths: restoredRootInstructionPaths,
    });
    const nextRootInstructionBaseContents = rootInstructionBaseContents
      ? Object.fromEntries(
          Object.entries(rootInstructionBaseContents).filter(([filePath]) => !restoredRootInstructionPaths.has(filePath)),
        )
      : undefined;

    if (Object.keys(remainingBundles).length > 0) {

      const syncedRootInstructionPaths = syncManagedRootInstructionFiles({
        repoRoot: gitContext.worktreeRoot,
        desiredState: remainingDesiredState,
        materializedBundles: remainingBundles,
        rootInstructionBaseContents: nextRootInstructionBaseContents,
        targetPaths: rewrittenRootInstructionPaths,
        resolveCachedBundle: (entry) => resolveDesiredCachedBundle(options.libraryDir, entry),
      });
      const refreshedRemainingBundles = refreshManagedFileFingerprintsForPaths(
        gitContext.worktreeRoot,
        remainingBundles,
        syncedRootInstructionPaths,
      );
      const newMatState: MaterializedState = {
        bundles: refreshedRemainingBundles,
        exclude_configured: false,
        ...(nextRootInstructionBaseContents !== undefined && Object.keys(nextRootInstructionBaseContents).length > 0
          ? { root_instruction_base_contents: nextRootInstructionBaseContents }
          : {}),
      };

      const managedFiles = collectAllFiles(newMatState);
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
      removeSkulExcludeBlock({ gitDir: gitContext.gitDir });
      if (Object.keys(currentShadowedFiles).length > 0) {
        registry = upsertWorktreeState(registry, gitContext.worktreeId, {
          repo_fingerprint: gitContext.repoFingerprint,
          path: gitContext.worktreeRoot,
          materialized_state: {
            bundles: {},
            exclude_configured: false,
          },
          shadowed_files: currentShadowedFiles,
        });
      } else {
        registry = removeWorktreeState(registry, gitContext.worktreeId);
      }
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

  return pc.green(`Removed ${options.bundle}`);
}

async function applyWorktree(options: {
  cwd: string;
  prompts: PromptClient;
  registryFile: string;
  libraryDir: string;
  dryRun: boolean;
}): Promise<string> {
  const gitContext = requireGitContext(options.cwd, "apply");
  let registry = readRegistryWithGuidance(options.registryFile);
  const repoState = registry.repos[gitContext.repoFingerprint];

  if (!repoState || repoState.desired_state.length === 0) {
    return `No bundles configured for this repository. Run "skul add <bundle>" to add one`;
  }

  type ApplyPlan =
    | { uncached: true; entry: DesiredBundleEntry }
    | { uncached: false; entry: DesiredBundleEntry; sourceRevision: CachedSourceRevision | undefined; cachedBundle: CachedBundle; existingBundleState: MaterializedBundleState | undefined; availableTools: ToolName[] };

  const worktreeState = registry.worktrees[gitContext.worktreeId];
  const materializedBundles = worktreeState?.materialized_state.bundles ?? {};
  const cloneLines: string[] = [];
  const applyPlans: ApplyPlan[] = repoState.desired_state.flatMap((entry): ApplyPlan[] => {
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
        return [{ uncached: true, entry }];
      }
      // Non-dry-run: fetch the source so the manifest is available below.
      const { cloned } = fetchRemoteSource({ source: entry.source, libraryDir: options.libraryDir, protocol: entry.protocol });
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
      return [];
    }

    return [{
      uncached: false,
      entry,
      sourceRevision,
      cachedBundle,
      existingBundleState,
      availableTools: Object.keys(cachedBundle.manifest.tools) as ToolName[],
    }];
  });

  if (applyPlans.length === 0) {
    return options.dryRun ? "DRY RUN: All bundles are already materialized" : "All bundles are already materialized";
  }

  if (options.dryRun) {
    const lines = applyPlans.map((plan) => {
      if (plan.uncached) {
        return `DRY RUN: Would clone ${plan.entry.source!} then apply ${plan.entry.bundle}`;
      }
      const tools = plan.entry.tools ?? Object.keys(plan.cachedBundle.manifest.tools);
      return `DRY RUN: Would apply ${plan.entry.bundle} for ${tools.join(", ")}`;
    });
    return lines.join("\n");
  }

  let currentBundles: MaterializedState["bundles"] = { ...materializedBundles };
  let currentShadowedFiles = { ...(worktreeState?.shadowed_files ?? {}) };
  let rootInstructionBaseContents = worktreeState?.materialized_state.root_instruction_base_contents;

  for (const plan of applyPlans) {
    if (plan.uncached) continue;
    const { entry, sourceRevision, cachedBundle, existingBundleState, availableTools } = plan;
    const refreshesExistingBundle =
      existingBundleState !== undefined &&
      entry.resolved_commit !== undefined &&
      existingBundleState.resolved_commit !== entry.resolved_commit;
    const toolsToApply = getToolsToApply({
      desiredEntry: entry,
      materializedBundleState: existingBundleState,
      availableTools,
    });
    const plannedWriteTargets = previewMaterializeBundleWriteTargets({
      repoRoot: gitContext.worktreeRoot,
      bundleDir: path.dirname(cachedBundle.manifestFile),
      manifest: cachedBundle.manifest,
      tools: toolsToApply,
    });
    const plannedRootInstructionTargets = new Set(
      plannedWriteTargets.filter((filePath) => isRootInstructionPath(filePath)),
    );
    const trackedRootInstructionShadowPlan = planTrackedRootInstructionShadows({
      repoRoot: gitContext.worktreeRoot,
      bundleDir: path.dirname(cachedBundle.manifestFile),
      manifest: cachedBundle.manifest,
      toolNames: selectTrackedRootInstructionShadowToolNames({
        existingBundleState,
        nextToolNames: toolsToApply ?? availableTools,
      }),
      targetPaths: plannedRootInstructionTargets,
      bundleName: entry.bundle,
      bundleSource: entry.source,
      existingShadowedFiles: currentShadowedFiles,
      materializedBundles: currentBundles,
    });
    rootInstructionBaseContents = captureRootInstructionBaseContents({
      repoRoot: gitContext.worktreeRoot,
      targetPaths: trackedRootInstructionShadowPlan.untrackedTargetPaths,
      existingBaseContents: rootInstructionBaseContents,
      managedTargetPaths: collectManagedRootInstructionTargets(currentBundles),
    });

    assertManagedRootInstructionSyncSourcesCached({
      desiredState: repoState.desired_state,
      materializedBundles: currentBundles,
      targetPaths: trackedRootInstructionShadowPlan.untrackedTargetPaths,
      resolveCachedBundle: (entry) => resolveDesiredCachedBundle(options.libraryDir, entry),
    });

    if (refreshesExistingBundle && existingBundleState) {
      assertTrackedRootInstructionShadowSafetyForPaths({
        repoRoot: gitContext.worktreeRoot,
        operation: "refresh",
        filePaths: plannedWriteTargets,
      });

      const replacementAllowed = await confirmManagedFileRemovals(
        gitContext.worktreeRoot,
        excludeShadowedTrackedRootInstructionTargets(
          flattenBundleState(existingBundleState),
          trackedRootInstructionShadowPlan.deferredMaterializationTargets,
        ),
        options.prompts,
        "replace",
      );

      if (!replacementAllowed) {
        throw new Error("Replacement aborted because a modified managed file was kept");
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
        throw new Error("Replacement aborted because a modified managed file was kept");
      }
    }
    assertTrackedRootInstructionShadowPlanCanApply({
      repoRoot: gitContext.worktreeRoot,
      bundleName: entry.bundle,
      existingShadowedFiles: currentShadowedFiles,
      plan: trackedRootInstructionShadowPlan,
    });

    assertTrackedRootInstructionShadowSafetyForPaths({
      repoRoot: gitContext.worktreeRoot,
      operation: existingBundleState ? "refresh" : "create",
      filePaths: plannedWriteTargets,
    });

    if (refreshesExistingBundle && existingBundleState) {
      removeManagedPaths(
        gitContext.worktreeRoot,
        excludeShadowedTrackedRootInstructionTargets(
          flattenBundleState(existingBundleState),
          trackedRootInstructionShadowPlan.deferredMaterializationTargets,
        ),
      );
    }

    const materializedResult = await materializeBundle({
      repoRoot: gitContext.worktreeRoot,
      bundleDir: path.dirname(cachedBundle.manifestFile),
      manifest: cachedBundle.manifest,
      tools: toolsToApply,
      bundleName: entry.bundle,
      bundleSource: entry.source,
      assertSafeWriteTarget: createTrackedRootInstructionShadowSafetyAssertion({
        repoRoot: gitContext.worktreeRoot,
        operation: existingBundleState ? "refresh" : "create",
      }),
      allowFileOverwriteTargets: collectManagedRootInstructionTargets(currentBundles),
      deferredWriteTargets: trackedRootInstructionShadowPlan.deferredMaterializationTargets,
      rootInstructionBaseContents,
      resolveFileConflict: options.prompts.resolveFileConflict,
    });

    currentBundles = {
      ...currentBundles,
      [cachedBundle.bundle]: buildMaterializedBundleState({
        existingBundleState,
        materializedResult,
        repoRoot: gitContext.worktreeRoot,
        source: entry.source,
        resolvedCommit: entry.resolved_commit ?? sourceRevision?.currentCommit,
        selectedTools: refreshesExistingBundle ? undefined : toolsToApply,
      }),
    };
    currentShadowedFiles = applyTrackedRootInstructionShadowPlan({
      repoRoot: gitContext.worktreeRoot,
      bundleName: entry.bundle,
      existingShadowedFiles: currentShadowedFiles,
      plan: trackedRootInstructionShadowPlan,
    });

    const syncedRootInstructionPaths = syncManagedRootInstructionFiles({
      repoRoot: gitContext.worktreeRoot,
      desiredState: repoState.desired_state,
      materializedBundles: currentBundles,
      rootInstructionBaseContents,
      targetPaths: trackedRootInstructionShadowPlan.untrackedTargetPaths,
      resolveCachedBundle: (entry) => resolveDesiredCachedBundle(options.libraryDir, entry),
    });
    currentBundles = refreshManagedFileFingerprintsForPaths(
      gitContext.worktreeRoot,
      currentBundles,
      syncedRootInstructionPaths,
    );

    const newMatState: MaterializedState = {
      bundles: currentBundles,
      exclude_configured: false,
      ...(rootInstructionBaseContents !== undefined
        ? { root_instruction_base_contents: rootInstructionBaseContents }
        : {}),
    };

    const managedFiles = collectAllFiles(newMatState);
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

interface PlannedTrackedRootInstructionShadow {
  filePath: string;
  rendered: string;
  state: ShadowedFileState;
}

interface TrackedRootInstructionShadowPlan {
  writes: PlannedTrackedRootInstructionShadow[];
  deferredMaterializationTargets: Set<string>;
  untrackedTargetPaths: Set<string>;
  activeShadowPaths: Set<string>;
}

function selectTrackedRootInstructionShadowToolNames(options: {
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

function planTrackedRootInstructionShadows(options: {
  repoRoot: string;
  bundleDir: string;
  manifest: CachedBundle["manifest"];
  toolNames: ToolName[];
  targetPaths: Set<string>;
  bundleName: string;
  bundleSource?: string;
  existingShadowedFiles: Record<string, ShadowedFileState>;
  materializedBundles: MaterializedState["bundles"];
}): TrackedRootInstructionShadowPlan {
  const activeOverlayContents = collectComposedRootInstructionContents({
    bundleDir: options.bundleDir,
    manifest: options.manifest,
    toolNames: options.toolNames,
  });
  const activeRootInstructionPaths = new Set(
    Object.keys(activeOverlayContents).filter((targetPath) => isRootInstructionPath(targetPath)),
  );
  const trackedTargetPaths = new Set<string>();

  for (const targetPath of activeRootInstructionPaths) {
    const inspection = inspectRootInstructionShadowTarget({
      repoRoot: options.repoRoot,
      filePath: targetPath,
    });

    if (inspection.tracked) {
      trackedTargetPaths.add(targetPath);
    }
  }

  assertTrackedRootInstructionShadowConflicts({
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
    }),
  );
  const untrackedTargetPaths = new Set(
    Array.from(activeRootInstructionPaths).filter((targetPath) => !trackedTargetPaths.has(targetPath)),
  );

  return {
    writes,
    deferredMaterializationTargets: trackedTargetPaths,
    untrackedTargetPaths,
    activeShadowPaths: trackedTargetPaths,
  };
}

function assertTrackedRootInstructionShadowConflicts(options: {
  targetPaths: Set<string>;
  bundleName: string;
  existingShadowedFiles: Record<string, ShadowedFileState>;
  materializedBundles: MaterializedState["bundles"];
}): void {
  for (const targetPath of options.targetPaths) {
    const existingShadow = options.existingShadowedFiles[targetPath];

    if (existingShadow && existingShadow.bundle !== options.bundleName) {
      throw new Error(
        `Cannot create tracked root-instruction shadow for ${targetPath} because it is already shadowed by ${existingShadow.bundle}`,
      );
    }

    for (const [bundleName, bundleState] of Object.entries(options.materializedBundles)) {
      if (bundleName === options.bundleName) {
        continue;
      }

      const ownsPath = Object.values(bundleState.tools).some((toolState) =>
        toolState.files.includes(targetPath),
      );

      if (ownsPath) {
        throw new Error(
          `Cannot create tracked root-instruction shadow for ${targetPath} because it is already managed by ${bundleName}`,
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
}): PlannedTrackedRootInstructionShadow {
  const inspection = inspectRootInstructionShadowTarget({
    repoRoot: options.repoRoot,
    filePath: options.filePath,
  });

  if (!inspection.headBlob) {
    throw new Error(
      `Cannot create tracked root-instruction shadow for ${options.filePath} because the target does not have HEAD content`,
    );
  }

  const render = renderTrackedRootInstructionShadow({
    baseContent: inspection.headBlob.content,
    overlayContent: options.overlayContent,
    bundleName: options.bundleName,
    toolName: options.toolName,
    strategy: "append",
  });

  return {
    filePath: options.filePath,
    rendered: render.rendered,
    state: {
      tool: options.toolName,
      bundle: options.bundleName,
      strategy: "append",
      base_blob: inspection.headBlob.objectId,
      overlay: options.overlayContent,
      overlay_fingerprint: render.overlayFingerprint,
      rendered_fingerprint: render.renderedFingerprint,
      skip_worktree: true,
    },
  };
}

function selectShadowToolForPath(toolNames: ToolName[], filePath: string): ToolName {
  const matchingTool = toolNames.find(
    (toolName) => getToolDefinition(toolName)?.targets.root_instruction?.path === filePath,
  );

  if (matchingTool) {
    return matchingTool;
  }

  if (filePath === "AGENTS.md") {
    return "codex";
  }

  return toolNames.find((toolName) => toolName !== "codex") ?? "claude-code";
}

function applyTrackedRootInstructionShadowPlan(options: {
  repoRoot: string;
  bundleName: string;
  existingShadowedFiles: Record<string, ShadowedFileState>;
  plan: TrackedRootInstructionShadowPlan;
}): Record<string, ShadowedFileState> {
  const nextShadowedFiles = { ...options.existingShadowedFiles };

  for (const [filePath, shadowedFile] of Object.entries(options.existingShadowedFiles)) {
    if (shadowedFile.bundle !== options.bundleName || options.plan.activeShadowPaths.has(filePath)) {
      continue;
    }

    assertTrackedRootInstructionShadowRetirementSafety({
      repoRoot: options.repoRoot,
      filePath,
      existingShadowedFile: shadowedFile,
    });
    restoreTrackedRootInstructionShadowTarget({
      repoRoot: options.repoRoot,
      filePath,
    });
    delete nextShadowedFiles[filePath];
  }

  for (const write of options.plan.writes) {
    const targetPath = path.join(options.repoRoot, write.filePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, write.rendered);
    setGitSkipWorktree({ repoRoot: options.repoRoot, filePath: write.filePath });
    nextShadowedFiles[write.filePath] = write.state;
  }

  return nextShadowedFiles;
}

function assertTrackedRootInstructionShadowPlanCanApply(options: {
  repoRoot: string;
  bundleName: string;
  existingShadowedFiles: Record<string, ShadowedFileState>;
  plan: TrackedRootInstructionShadowPlan;
}): void {
  for (const [filePath, shadowedFile] of Object.entries(options.existingShadowedFiles)) {
    if (shadowedFile.bundle !== options.bundleName || options.plan.activeShadowPaths.has(filePath)) {
      continue;
    }

    assertTrackedRootInstructionShadowRetirementSafety({
      repoRoot: options.repoRoot,
      filePath,
      existingShadowedFile: shadowedFile,
    });
  }

  for (const write of options.plan.writes) {
    assertTrackedRootInstructionShadowWriteSafety({
      repoRoot: options.repoRoot,
      filePath: write.filePath,
      existingShadowedFile: options.existingShadowedFiles[write.filePath],
      operation: options.existingShadowedFiles[write.filePath] ? "refresh" : "create",
    });
  }
}

function assertTrackedRootInstructionShadowWriteSafety(options: {
  repoRoot: string;
  filePath: string;
  existingShadowedFile: ShadowedFileState | undefined;
  operation: "create" | "refresh";
}): void {
  assertTrackedRootInstructionShadowSafety({
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
      `Cannot refresh tracked root-instruction shadow for ${options.filePath} because the current shadow file is missing`,
    );
  }

  if (fingerprintFile(targetPath) !== options.existingShadowedFile.rendered_fingerprint) {
    throw new Error(
      `Cannot refresh tracked root-instruction shadow for ${options.filePath} because the current worktree content no longer matches Skul's recorded render`,
    );
  }
}

function assertTrackedRootInstructionShadowRetirementSafety(options: {
  repoRoot: string;
  filePath: string;
  existingShadowedFile: ShadowedFileState;
}): void {
  const targetPath = path.join(options.repoRoot, options.filePath);

  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
    throw new Error(
      `Cannot retire tracked root-instruction shadow for ${options.filePath} because the current shadow file is missing`,
    );
  }

  if (fingerprintFile(targetPath) !== options.existingShadowedFile.rendered_fingerprint) {
    throw new Error(
      `Cannot retire tracked root-instruction shadow for ${options.filePath} because the current worktree content no longer matches Skul's recorded render`,
    );
  }
}

function retireTrackedRootInstructionShadows(options: {
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

    assertTrackedRootInstructionShadowRetirementSafety({
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

    assertTrackedRootInstructionShadowRetirementSafety({
      repoRoot: options.repoRoot,
      filePath,
      existingShadowedFile: shadowedFile,
    });
    restoreTrackedRootInstructionShadowTarget({
      repoRoot: options.repoRoot,
      filePath,
    });
    delete nextShadowedFiles[filePath];
  }

  return nextShadowedFiles;
}

function restoreTrackedRootInstructionShadowTarget(options: {
  repoRoot: string;
  filePath: string;
}): void {
  const inspection = inspectRootInstructionShadowTarget({
    repoRoot: options.repoRoot,
    filePath: options.filePath,
  });

  if (!inspection.headBlob) {
    throw new Error(
      `Cannot restore tracked root-instruction shadow target for ${options.filePath} because the target does not have HEAD content`,
    );
  }

  const targetPath = path.join(options.repoRoot, options.filePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, inspection.headBlob.content);
  clearGitSkipWorktree({ repoRoot: options.repoRoot, filePath: options.filePath });
}

function excludeShadowedTrackedRootInstructionTargets(
  state: {
    files: string[];
    file_fingerprints: Record<string, string>;
    directories?: string[];
  },
  deferredMaterializationTargets: Set<string>,
): {
  files: string[];
  file_fingerprints: Record<string, string>;
  directories?: string[];
} {
  if (deferredMaterializationTargets.size === 0) {
    return state;
  }

  const files = state.files.filter((filePath) => !deferredMaterializationTargets.has(filePath));
  const fileFingerprints = Object.fromEntries(
    Object.entries(state.file_fingerprints).filter(([filePath]) => !deferredMaterializationTargets.has(filePath)),
  );

  return {
    files,
    file_fingerprints: fileFingerprints,
    ...(state.directories !== undefined ? { directories: state.directories } : {}),
  };
}

function isDesiredBundleMaterialized(options: {
  desiredEntry: DesiredBundleEntry;
  materializedBundleState: MaterializedBundleState;
  availableTools: ToolName[];
}): boolean {
  const expectedTools = options.desiredEntry.tools ?? options.availableTools;

  return (
    expectedTools.every((toolName) => toolName in options.materializedBundleState.tools) &&
    (
      options.desiredEntry.resolved_commit === undefined ||
      options.materializedBundleState.resolved_commit === options.desiredEntry.resolved_commit
    )
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
    options.materializedBundleState.resolved_commit !== options.desiredEntry.resolved_commit
  ) {
    return options.desiredEntry.tools ?? options.availableTools;
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
  const files = new Set<string>();
  const file_fingerprints: Record<string, string> = {};
  const directories = new Set<string>();

  for (const toolState of Object.values(bundleState.tools)) {
    for (const file of toolState.files) {
      files.add(file);
    }
    if (toolState.file_fingerprints) Object.assign(file_fingerprints, toolState.file_fingerprints);
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
  };
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
  return Array.from(
    new Set(
      Object.values(materializedState.bundles).flatMap((bundleState) =>
        Object.values(bundleState.tools).flatMap((toolState) => toolState.files),
      ),
    ),
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

function requireGitContext(
  cwd: string,
  command: "add" | "apply" | "status" | "check" | "update" | "shadow" | "reset" | "remove",
) {
  const gitContext = detectGitContext({ cwd });

  if (!gitContext) {
    throw new Error(`skul ${command} requires a Git repository. Run "git init" to initialize one`);
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
export function assertTrackedRootInstructionShadowSafety(options: {
  repoRoot: string;
  filePath: string;
  operation: "create" | "refresh";
}): void {
  assertTrackedRootInstructionShadowSafetyForAction({
    repoRoot: options.repoRoot,
    filePath: options.filePath,
    action: options.operation,
  });
}

function assertTrackedRootInstructionShadowSafetyForAction(options: {
  repoRoot: string;
  filePath: string;
  action: "create" | "refresh" | "suspend";
}): void {
  const inspection = inspectRootInstructionShadowTarget({
    repoRoot: options.repoRoot,
    filePath: options.filePath,
  });

  if (!inspection.tracked) {
    return;
  }

  const actionLabel = options.action;

  if (inspection.issues.includes("unmerged")) {
    throw new Error(
      `Cannot ${actionLabel} tracked root-instruction shadow for ${options.filePath} because the target has unmerged index entries`,
    );
  }

  if (inspection.issues.includes("missing-head")) {
    throw new Error(
      `Cannot ${actionLabel} tracked root-instruction shadow for ${options.filePath} because the target does not have HEAD content`,
    );
  }

  if (inspection.issues.includes("staged-changes")) {
    throw new Error(
      `Cannot ${actionLabel} tracked root-instruction shadow for ${options.filePath} because the target has staged changes`,
    );
  }

  if (inspection.issues.includes("unstaged-changes")) {
    throw new Error(
      `Cannot ${actionLabel} tracked root-instruction shadow for ${options.filePath} because the target has unstaged changes`,
    );
  }

  if (inspection.issues.includes("incompatible-index-flags")) {
    throw new Error(
      `Cannot ${actionLabel} tracked root-instruction shadow for ${options.filePath} because the target has incompatible index flags: ${inspection.indexFlags.join(", ")}`,
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

    assertTrackedRootInstructionShadowSafety({
      repoRoot: options.repoRoot,
      filePath,
      operation: options.operation,
    });
  }
}

function createTrackedRootInstructionShadowSafetyAssertion(options: {
  repoRoot: string;
  operation: "create" | "refresh";
}): (repoRelativePath: string) => void {
  return (repoRelativePath: string) => {
    if (!isRootInstructionPath(repoRelativePath)) {
      return;
    }

    assertTrackedRootInstructionShadowSafety({
      repoRoot: options.repoRoot,
      filePath: repoRelativePath,
      operation: options.operation,
    });
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
    throw new Error(`Bundle not found in active set: ${bundle}. Run "skul status" to see configured bundles`);
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

function upsertDesiredEntryPreservingOrder(
  desiredState: DesiredBundleEntry[],
  nextEntry: DesiredBundleEntry,
): DesiredBundleEntry[] {
  const existingIndex = desiredState.findIndex((entry) => entry.bundle === nextEntry.bundle);

  if (existingIndex === -1) {
    return [...desiredState, nextEntry];
  }

  return desiredState.map((entry, index) => (index === existingIndex ? nextEntry : entry));
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
    throw new Error(`Registry is corrupted (${detail}). Please repair or remove ${registryFile} and try again.`);
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
        throw new Error(
          `${error.message}\n\nNo bundles are cached yet. Add one from a Git source:\n  skul add github.com/<owner>/<repo> <bundle-name>`,
        );
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
  try {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    // On read failure treat the file as modified so callers prompt before deletion
    // rather than silently skipping a managed file that may still exist.
    return "";
  }
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
