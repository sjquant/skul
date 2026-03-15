import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findCachedBundle, listCachedBundles } from "./bundle-discovery";
import { materializeBundle } from "./bundle-materialization";
import { createHelpText, createPromptClient, type PromptClient, parseCliArgs } from "./cli";
import { detectGitContext } from "./git-context";
import { configureSkulExcludeBlock, hasSkulExcludeBlock, removeSkulExcludeBlock } from "./git-exclude";
import {
  listManagedPathsForRemoval,
  readRegistryFile,
  removeWorktreeState,
  upsertRepoState,
  upsertWorktreeState,
  writeRegistryFile,
} from "./registry";
import { resolveGlobalStateLayout } from "./state-layout";

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

  if (parsed.command === "use") {
    return applyBundle({
      cwd,
      prompts,
      registryFile: stateLayout.registryFile,
      libraryDir: stateLayout.libraryDir,
      bundle: parsed.options.bundle,
      source: parsed.options.source,
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
      registryFile: stateLayout.registryFile,
    });
  }

  return `Command ${parsed.command} is defined but not implemented yet.`;
}

function renderBundleList(options: { libraryDir: string }): string {
  const bundles = listCachedBundles(options);

  if (bundles.length === 0) {
    return ["Available Bundles", "", "No cached bundles found."].join("\n");
  }

  return ["Available Bundles", "", ...bundles.map((bundle) => bundle.bundle)].join("\n");
}

function renderStatus(options: {
  cwd: string;
  registryFile: string;
}): string {
  const gitContext = requireGitContext(options.cwd, "status");

  const registry = readRegistryFile(options.registryFile);
  const repoState = registry.repos[gitContext.repoFingerprint];
  const worktreeState = registry.worktrees[gitContext.worktreeId];
  const lines: string[] = ["Repository Desired State"];

  if (repoState) {
    lines.push(`Tool: ${repoState.desired_state.tool}`);
    lines.push(`Bundle: ${repoState.desired_state.bundle}`);
  } else {
    lines.push("Configured: no");
  }

  lines.push("", "Current Worktree", `Path: ${gitContext.worktreeRoot}`);

  if (!worktreeState) {
    lines.push("Materialized: no");

    if (repoState) {
      lines.push('Suggested Action: run "skul use"');
    }

    return lines.join("\n");
  }

  lines.push("Materialized: yes", "", "Files:");

  for (const file of worktreeState.materialized_state.files) {
    lines.push(`  ${file}`);
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
}): Promise<string> {
  const gitContext = requireGitContext(options.cwd, "use");

  const cachedBundle = findCachedBundle({
    libraryDir: options.libraryDir,
    bundle: options.bundle,
    source: options.source,
  });
  let registry = readRegistryFile(options.registryFile);
  const existingState = registry.worktrees[gitContext.worktreeId]?.materialized_state;

  if (existingState && existingState.tool !== cachedBundle.manifest.tool) {
    throw new Error(
      `Replacing ${existingState.tool} with ${cachedBundle.manifest.tool} is not implemented yet`,
    );
  }

  registry = upsertRepoState(registry, gitContext.repoFingerprint, {
    repo_root: gitContext.repoRoot,
    desired_state: {
      tool: cachedBundle.manifest.tool,
      bundle: cachedBundle.bundle,
    },
  });

  if (existingState) {
    removeManagedPaths(gitContext.worktreeRoot, existingState);
  }

  const materializedState = await materializeBundle({
    repoRoot: gitContext.worktreeRoot,
    bundleDir: path.dirname(cachedBundle.manifestFile),
    manifest: cachedBundle.manifest,
    resolveFileConflict: options.prompts.resolveFileConflict,
  });

  configureSkulExcludeBlock({
    gitDir: gitContext.gitDir,
    files: materializedState.files,
  });

  registry = upsertWorktreeState(registry, gitContext.worktreeId, {
    repo_fingerprint: gitContext.repoFingerprint,
    path: gitContext.worktreeRoot,
    materialized_state: {
      tool: cachedBundle.manifest.tool,
      bundle: cachedBundle.bundle,
      files: materializedState.files,
      directories: materializedState.directories,
      exclude_configured: true,
    },
  });
  writeRegistryFile(options.registryFile, registry);

  return `Applied ${cachedBundle.bundle} for ${cachedBundle.manifest.tool}`;
}

function cleanWorktree(options: {
  cwd: string;
  registryFile: string;
}): string {
  const gitContext = requireGitContext(options.cwd, "clean");

  let registry = readRegistryFile(options.registryFile);
  const worktreeState = registry.worktrees[gitContext.worktreeId];

  if (worktreeState) {
    removeManagedPaths(gitContext.worktreeRoot, worktreeState.materialized_state);
    registry = removeWorktreeState(registry, gitContext.worktreeId);
    writeRegistryFile(options.registryFile, registry);
  }

  const excludeRemoved = removeSkulExcludeBlock({ gitDir: gitContext.gitDir });

  if (!worktreeState && !excludeRemoved) {
    return "No Skul-managed files found in the current worktree";
  }

  return "Cleaned Skul-managed files from the current worktree";
}

function removeManagedPaths(repoRoot: string, materializedState: Parameters<typeof listManagedPathsForRemoval>[0]): void {
  for (const relativePath of listManagedPathsForRemoval(materializedState)) {
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

function requireGitContext(cwd: string, command: "use" | "status" | "clean") {
  const gitContext = detectGitContext({ cwd });

  if (!gitContext) {
    throw new Error(`skul ${command} requires a Git repository`);
  }

  return gitContext;
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
