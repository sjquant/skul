import fs from "node:fs";
import path from "node:path";

import { listToolDefinitions, type ToolName } from "./tool-mapping";

const KNOWN_TOOL_NAMES = new Set(listToolDefinitions().map((t) => t.name));

export interface DesiredBundleEntry {
  bundle: string;
  source?: string;
  tools?: ToolName[];
}

export interface MaterializedToolState {
  files: string[];
  file_fingerprints?: Record<string, string>;
  directories?: string[];
}

export interface MaterializedBundleState {
  source?: string;
  tools: Record<string, MaterializedToolState>;
}

export interface MaterializedState {
  bundles: Record<string, MaterializedBundleState>;
  exclude_configured: boolean;
}

export interface RepoState {
  repo_root: string;
  remote_url?: string;
  desired_state: DesiredBundleEntry[];
}

export interface WorktreeState {
  repo_fingerprint: string;
  path: string;
  materialized_state: MaterializedState;
}

export interface Registry {
  version: 1;
  repos: Record<string, RepoState>;
  worktrees: Record<string, WorktreeState>;
}

type UnknownRecord = Record<string, unknown>;

export function createEmptyRegistry(): Registry {
  return {
    version: 1,
    repos: {},
    worktrees: {},
  };
}

export function readRegistryFile(registryFile: string): Registry {
  if (!fs.existsSync(registryFile)) {
    return createEmptyRegistry();
  }

  return parseRegistry(JSON.parse(fs.readFileSync(registryFile, "utf8")) as unknown);
}

export function writeRegistryFile(registryFile: string, registry: Registry): void {
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  fs.writeFileSync(registryFile, `${JSON.stringify(sortRegistry(registry), null, 2)}\n`);
}

export function upsertRepoState(
  registry: Registry,
  repoFingerprint: string,
  repoState: RepoState,
): Registry {
  return {
    version: 1,
    repos: {
      ...registry.repos,
      [repoFingerprint]: {
        ...repoState,
        desired_state: repoState.desired_state.map((entry) => ({
          bundle: entry.bundle,
          ...(entry.source !== undefined ? { source: entry.source } : {}),
          ...(entry.tools !== undefined ? { tools: [...entry.tools] } : {}),
        })),
      },
    },
    worktrees: { ...registry.worktrees },
  };
}

export function upsertWorktreeState(
  registry: Registry,
  worktreeId: string,
  worktreeState: WorktreeState,
): Registry {
  if (!(worktreeState.repo_fingerprint in registry.repos)) {
    throw new Error(`worktrees.${worktreeId}.repo_fingerprint must reference a repository entry`);
  }

  return {
    version: 1,
    repos: { ...registry.repos },
    worktrees: {
      ...registry.worktrees,
      [worktreeId]: cloneWorktreeState(worktreeState),
    },
  };
}

export function removeWorktreeState(registry: Registry, worktreeId: string): Registry {
  if (!(worktreeId in registry.worktrees)) {
    return {
      version: 1,
      repos: { ...registry.repos },
      worktrees: { ...registry.worktrees },
    };
  }

  const worktrees = { ...registry.worktrees };
  delete worktrees[worktreeId];

  return {
    version: 1,
    repos: { ...registry.repos },
    worktrees,
  };
}

export function listManagedPathsForRemoval(state: {
  files: string[];
  directories?: string[];
}): string[] {
  return [...state.files].sort(compareRemovalPath).concat(
    [...(state.directories ?? [])].sort(compareRemovalPath),
  );
}

export function parseRegistry(input: unknown): Registry {
  const registry = expectRecord(input, "registry");

  if (registry.version !== 1) {
    throw new Error(
      `registry.version must be 1 — found ${String(registry.version)}; repair or remove the registry file`,
    );
  }

  const reposInput = expectRecord(registry.repos, "repos");
  const worktreesInput = expectRecord(registry.worktrees, "worktrees");

  const repos = Object.fromEntries(
    Object.entries(reposInput).map(([repoFingerprint, value]) => [
      repoFingerprint,
      parseRepoState(value, `repos.${repoFingerprint}`),
    ]),
  );
  const worktrees = Object.fromEntries(
    Object.entries(worktreesInput).map(([worktreeId, value]) => [
      worktreeId,
      parseWorktreeState(value, `worktrees.${worktreeId}`),
    ]),
  );

  for (const [worktreeId, worktree] of Object.entries(worktrees)) {
    if (!(worktree.repo_fingerprint in repos)) {
      throw new Error(
        `worktrees.${worktreeId}.repo_fingerprint must reference a repository entry`,
      );
    }
  }

  return { version: 1, repos, worktrees };
}

function parseRepoState(input: unknown, label: string): RepoState {
  const repo = expectRecord(input, label);
  const remoteUrl =
    repo.remote_url === undefined
      ? undefined
      : expectNonEmptyString(repo.remote_url, `${label}.remote_url`);

  return {
    repo_root: expectAbsolutePath(repo.repo_root, `${label}.repo_root`),
    desired_state: parseDesiredState(repo.desired_state, `${label}.desired_state`),
    ...(remoteUrl === undefined ? {} : { remote_url: remoteUrl }),
  };
}

function parseDesiredState(input: unknown, label: string): DesiredBundleEntry[] {
  return expectArray(input, label).map((entry, index) =>
    parseDesiredBundleEntry(entry, `${label}[${index}]`),
  );
}

function parseDesiredBundleEntry(input: unknown, label: string): DesiredBundleEntry {
  const entry = expectRecord(input, label);
  const bundle = expectNonEmptyString(entry.bundle, `${label}.bundle`);
  const source =
    entry.source === undefined
      ? undefined
      : expectNonEmptyString(entry.source, `${label}.source`);
  const tools =
    entry.tools === undefined
      ? undefined
      : expectArray(entry.tools, `${label}.tools`).map((value, index) => {
          const name = expectNonEmptyString(value, `${label}.tools[${index}]`);
          if (!KNOWN_TOOL_NAMES.has(name)) {
            throw new Error(
              `${label}.tools[${index}] must be one of: ${Array.from(KNOWN_TOOL_NAMES).join(", ")}`,
            );
          }
          return name as ToolName;
        });

  return {
    bundle,
    ...(source !== undefined ? { source } : {}),
    ...(tools !== undefined ? { tools } : {}),
  };
}

function parseWorktreeState(input: unknown, label: string): WorktreeState {
  const worktree = expectRecord(input, label);

  return {
    repo_fingerprint: expectNonEmptyString(worktree.repo_fingerprint, `${label}.repo_fingerprint`),
    path: expectAbsolutePath(worktree.path, `${label}.path`),
    materialized_state: parseMaterializedState(
      worktree.materialized_state,
      `${label}.materialized_state`,
    ),
  };
}

function parseMaterializedState(input: unknown, label: string): MaterializedState {
  const state = expectRecord(input, label);
  const bundlesInput = expectRecord(state.bundles, `${label}.bundles`);

  const bundles = Object.fromEntries(
    Object.entries(bundlesInput).map(([bundleName, bundleValue]) => [
      bundleName,
      parseMaterializedBundleState(bundleValue, `${label}.bundles.${bundleName}`),
    ]),
  );

  return {
    bundles,
    exclude_configured: expectBoolean(state.exclude_configured, `${label}.exclude_configured`),
  };
}

function parseMaterializedBundleState(input: unknown, label: string): MaterializedBundleState {
  const bundle = expectRecord(input, label);
  const source =
    bundle.source === undefined
      ? undefined
      : expectNonEmptyString(bundle.source, `${label}.source`);
  const toolsInput = expectRecord(bundle.tools, `${label}.tools`);

  const tools = Object.fromEntries(
    Object.entries(toolsInput).map(([toolName, toolValue]) => {
      if (!KNOWN_TOOL_NAMES.has(toolName)) {
        throw new Error(
          `${label}.tools.${toolName} must be one of: ${Array.from(KNOWN_TOOL_NAMES).join(", ")}`,
        );
      }
      return [toolName, parseMaterializedToolState(toolValue, `${label}.tools.${toolName}`)];
    }),
  );

  return {
    ...(source !== undefined ? { source } : {}),
    tools,
  };
}

function parseMaterializedToolState(input: unknown, label: string): MaterializedToolState {
  const toolState = expectRecord(input, label);
  const files = expectArray(toolState.files, `${label}.files`).map((value, index) =>
    expectRelativePath(value, `${label}.files[${index}]`),
  );
  const fileFingerprints =
    toolState.file_fingerprints === undefined
      ? undefined
      : parseFileFingerprints(
          toolState.file_fingerprints,
          files,
          `${label}.file_fingerprints`,
        );
  const directories =
    toolState.directories === undefined
      ? undefined
      : expectArray(toolState.directories, `${label}.directories`).map((value, index) =>
          expectRelativePath(value, `${label}.directories[${index}]`),
        );

  return {
    files,
    ...(fileFingerprints === undefined ? {} : { file_fingerprints: fileFingerprints }),
    ...(directories === undefined ? {} : { directories }),
  };
}

function sortRegistry(registry: Registry): Registry {
  return {
    version: 1,
    repos: Object.fromEntries(
      Object.entries(registry.repos)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([repoFingerprint, repoState]) => [
          repoFingerprint,
          {
            ...repoState,
            desired_state: repoState.desired_state.map((entry) => ({ ...entry })),
          },
        ]),
    ),
    worktrees: Object.fromEntries(
      Object.entries(registry.worktrees)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([worktreeId, worktreeState]) => [worktreeId, cloneWorktreeState(worktreeState)]),
    ),
  };
}

function cloneWorktreeState(worktreeState: WorktreeState): WorktreeState {
  return {
    ...worktreeState,
    materialized_state: {
      bundles: Object.fromEntries(
        Object.entries(worktreeState.materialized_state.bundles).map(
          ([bundleName, bundleState]) => [
            bundleName,
            {
              ...(bundleState.source !== undefined ? { source: bundleState.source } : {}),
              tools: Object.fromEntries(
                Object.entries(bundleState.tools).map(([toolName, toolState]) => [
                  toolName,
                  {
                    files: [...toolState.files],
                    ...(toolState.file_fingerprints !== undefined
                      ? { file_fingerprints: { ...toolState.file_fingerprints } }
                      : {}),
                    ...(toolState.directories !== undefined
                      ? { directories: [...toolState.directories] }
                      : {}),
                  },
                ]),
              ),
            },
          ],
        ),
      ),
      exclude_configured: worktreeState.materialized_state.exclude_configured,
    },
  };
}

function compareRemovalPath(left: string, right: string): number {
  const depthDifference = pathDepth(right) - pathDepth(left);
  return depthDifference !== 0 ? depthDifference : left.localeCompare(right);
}

function expectRecord(input: unknown, label: string): UnknownRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }

  return input as UnknownRecord;
}

function expectArray(input: unknown, label: string): unknown[] {
  if (!Array.isArray(input)) {
    throw new Error(`${label} must be an array`);
  }

  return input;
}

function expectNonEmptyString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }

  return input;
}

function expectAbsolutePath(input: unknown, label: string): string {
  const value = expectNonEmptyString(input, label);

  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }

  return value;
}

function expectRelativePath(input: unknown, label: string): string {
  const value = expectNonEmptyString(input, label);

  if (path.isAbsolute(value) || value.startsWith("../") || value === "..") {
    throw new Error(`${label} must be a relative path`);
  }

  return value;
}

function expectBoolean(input: unknown, label: string): boolean {
  if (typeof input !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }

  return input;
}

function pathDepth(value: string): number {
  return value.split(path.sep).length;
}

function parseFileFingerprints(
  input: unknown,
  files: string[],
  label: string,
): Record<string, string> {
  const record = expectRecord(input, label);
  const knownFiles = new Set(files);

  return Object.fromEntries(
    Object.entries(record).map(([relativePath, fingerprint]) => {
      if (!knownFiles.has(relativePath)) {
        throw new Error(`${label}.${relativePath} must reference a tracked file`);
      }

      return [relativePath, expectNonEmptyString(fingerprint, `${label}.${relativePath}`)];
    }),
  );
}
