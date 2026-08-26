import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, vi } from "vitest";

import type { PromptClient } from "./cli";
import {
  expectAgentsDocument as assertAgentsDocument,
  expectClaudeDocument as assertClaudeDocument,
  formatExpectedRootInstructionDocument,
  formatRootInstructionBundleBlock,
  formatTrackedRootInstructionShadowBlock,
  writeRootInstructionBundleFixture as writeRootInstructionBundle,
  setupSharedRootInstructionBundles as writeSharedRootInstructionBundles,
} from "./utils/testing";

export {
  assertAgentsDocument,
  assertClaudeDocument,
  formatExpectedRootInstructionDocument,
  formatRootInstructionBundleBlock,
  formatTrackedRootInstructionShadowBlock,
};

export const tempDirs: string[] = [];

// CLI suites drive real git subprocesses and temporary worktrees. Keep their
// generous budget local so pure-function suites retain Vitest's tight defaults.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

export function createHomeDir(): string {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-home-"));
  tempDirs.push(homeDir);
  return homeDir;
}

export function writeManifest(
  homeDir: string,
  source: string,
  bundle: string,
  manifest: object,
): void {
  const bundleDir = path.join(
    homeDir,
    ".skul",
    "library",
    ...source.split("/"),
    bundle,
  );
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(
    path.join(bundleDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}

export function writeBundleFile(
  homeDir: string,
  source: string | undefined,
  bundle: string,
  relativePath: string,
  content: string,
): void {
  const libraryDir = path.join(homeDir, ".skul", "library");
  const bundleDir = source
    ? path.join(libraryDir, ...source.split("/"), bundle)
    : path.join(libraryDir, bundle);
  const filePath = path.join(bundleDir, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

export function createRemoteBundleSource(
  homeDir: string,
  options: {
    source?: string;
    bundle: string;
    manifest: object;
    files: Record<string, string>;
  },
): {
  source: string;
  bundle: string;
  remoteRepoPath: string;
  initialCommit: string;
} {
  const source = options.source ?? "github.com/user/ai-vault";
  const remoteRepoPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "skul-remote-source-"),
  );
  tempDirs.push(remoteRepoPath);

  runGit(remoteRepoPath, ["init", "--initial-branch=main"]);
  runGit(remoteRepoPath, ["config", "user.name", "Skul Remote"]);
  runGit(remoteRepoPath, ["config", "user.email", "skul-remote@example.com"]);
  runGit(remoteRepoPath, ["config", "commit.gpgsign", "false"]);

  const bundleDir = path.join(remoteRepoPath, options.bundle);
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(
    path.join(bundleDir, "manifest.json"),
    `${JSON.stringify(options.manifest, null, 2)}\n`,
  );

  for (const [relativePath, content] of Object.entries(options.files)) {
    const targetPath = path.join(bundleDir, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content);
  }

  runGit(remoteRepoPath, ["add", "."]);
  runGit(remoteRepoPath, ["commit", "-m", "Initial bundle"]);

  const targetDir = path.join(
    homeDir,
    ".skul",
    "library",
    ...source.split("/"),
  );
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  runGit(path.dirname(targetDir), ["clone", remoteRepoPath, targetDir]);

  return {
    source,
    bundle: options.bundle,
    remoteRepoPath,
    initialCommit: runGit(remoteRepoPath, ["rev-parse", "HEAD"]),
  };
}

export function updateRemoteBundleSource(
  remoteRepoPath: string,
  bundle: string,
  files: Record<string, string>,
): string {
  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = path.join(
      remoteRepoPath,
      bundle,
      ...relativePath.split("/"),
    );
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content);
  }

  runGit(remoteRepoPath, ["add", "."]);
  runGit(remoteRepoPath, ["commit", "-m", "Update bundle"]);

  return runGit(remoteRepoPath, ["rev-parse", "HEAD"]);
}

export function createRepository(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skul-repo-"));
  tempDirs.push(repoRoot);
  runGit(repoRoot, ["init", "--initial-branch=main"]);
  runGit(repoRoot, ["config", "user.name", "Skul Test"]);
  runGit(repoRoot, ["config", "user.email", "skul@example.com"]);
  runGit(repoRoot, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# test\n");
  runGit(repoRoot, ["add", "README.md"]);
  runGit(repoRoot, ["commit", "-m", "init"]);
  return repoRoot;
}

export function createSyncRepository(initialFiles: Record<string, string>): {
  repoRoot: string;
  upstreamRepoPath: string;
} {
  const remoteRepoPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "skul-sync-remote-"),
  );
  const upstreamRepoPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "skul-sync-upstream-"),
  );
  const cloneParentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "skul-sync-clone-"),
  );
  const repoRoot = path.join(cloneParentDir, "repo");
  tempDirs.push(remoteRepoPath, upstreamRepoPath, cloneParentDir);

  runGit(remoteRepoPath, ["init", "--bare", "--initial-branch=main"]);
  runGit(upstreamRepoPath, ["init", "--initial-branch=main"]);
  runGit(upstreamRepoPath, ["config", "user.name", "Skul Test"]);
  runGit(upstreamRepoPath, ["config", "user.email", "skul@example.com"]);
  runGit(upstreamRepoPath, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(upstreamRepoPath, "README.md"), "# test\n");

  for (const [relativePath, content] of Object.entries(initialFiles)) {
    const targetPath = path.join(upstreamRepoPath, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content);
  }

  runGit(upstreamRepoPath, ["add", "."]);
  runGit(upstreamRepoPath, ["commit", "-m", "init"]);
  runGit(upstreamRepoPath, ["remote", "add", "origin", remoteRepoPath]);
  runGit(upstreamRepoPath, ["push", "-u", "origin", "main"]);

  runGit(cloneParentDir, ["clone", remoteRepoPath, repoRoot]);
  runGit(repoRoot, ["config", "user.name", "Skul Test"]);
  runGit(repoRoot, ["config", "user.email", "skul@example.com"]);
  runGit(repoRoot, ["config", "commit.gpgsign", "false"]);

  return { repoRoot, upstreamRepoPath };
}

export function pushSyncRepositoryUpdate(
  upstreamRepoPath: string,
  files: Record<string, string>,
  message: string,
): string {
  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = path.join(upstreamRepoPath, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content);
  }

  runGit(upstreamRepoPath, ["add", "."]);
  runGit(upstreamRepoPath, ["commit", "-m", message]);
  runGit(upstreamRepoPath, ["push", "origin", "main"]);

  return runGit(upstreamRepoPath, ["rev-parse", "HEAD"]);
}

export function createLinkedWorktree(repoRoot: string): string {
  const parentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "skul-linked-worktree-"),
  );
  const worktreeRoot = path.join(parentDir, "linked-worktree");
  tempDirs.push(parentDir);
  runGit(repoRoot, ["worktree", "add", worktreeRoot]);
  return worktreeRoot;
}

export function runGit(
  cwd: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (options.allowFailure) {
      return "";
    }

    throw error;
  }
}

export function readGitIndexFlag(cwd: string, filePath: string): string {
  return runGit(cwd, ["ls-files", "-v", "--", filePath]).slice(0, 1);
}

export function pathExists(targetPath: string): boolean {
  return fs.existsSync(targetPath);
}

export function fingerprintFile(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function writeRootInstructionBundleFixture(
  homeDir: string,
  options: {
    bundle: string;
    content: string;
    source?: string;
    agent?: "codex" | "claude-code";
    filePath?: string;
    extraTools?: Record<string, object>;
    extraFiles?: Record<string, string>;
  },
): void {
  writeRootInstructionBundle(homeDir, options, {
    writeManifest,
    writeBundleFile,
  });
}

export function setupSharedRootInstructionBundles(
  homeDir: string,
  bundles: Array<{
    bundle: string;
    content: string;
    source?: string;
    agent?: "codex" | "claude-code";
    filePath?: string;
    extraTools?: Record<string, object>;
    extraFiles?: Record<string, string>;
  }>,
): void {
  writeSharedRootInstructionBundles(homeDir, bundles, {
    writeManifest,
    writeBundleFile,
  });
}

export function expectAgentsDocument(
  repoRoot: string,
  ...parts: string[]
): void {
  assertAgentsDocument(repoRoot, ...parts);
}

export function expectClaudeDocument(
  repoRoot: string,
  ...parts: string[]
): void {
  assertClaudeDocument(repoRoot, ...parts);
}

export function createPromptClientStub(
  overrides: Partial<PromptClient> = {},
): PromptClient {
  return {
    selectBundle: async () => ({ bundle: "react-expert" }),
    selectBundleFromSelections: async (availableBundles) => {
      if (availableBundles.length === 0) {
        throw new Error("selectBundleFromSelections received no bundles");
      }

      return availableBundles[0]!;
    },
    selectBundleItems: async (_availableItems, selectedItems) => selectedItems,
    selectBundleItemChoices: async (_availableItems, selectedItems) =>
      selectedItems,
    selectAgents: async (agents) => agents,
    resolveFileConflict: async () => ({ action: "overwrite" }),
    confirmManagedFileRemoval: async () => true,
    ...overrides,
  };
}

export function renderBundleListOutput(...lines: string[]): string {
  return ["Available Bundles", "", ...lines].join("\n");
}
