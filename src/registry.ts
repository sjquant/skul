import fs from "node:fs";
import path from "node:path";

export interface DesiredState {
  tool: string;
  bundle: string;
}

export interface RepoState {
  repo_root: string;
  remote_url?: string;
  desired_state: DesiredState;
}

export interface MaterializedState extends DesiredState {
  files: string[];
  file_fingerprints?: Record<string, string>;
  directories?: string[];
  exclude_configured: boolean;
}

export interface WorktreeState {
  repo_fingerprint: string;
  path: string;
  materialized_state: MaterializedState;
}

export interface Registry {
  repos: Record<string, RepoState>;
  worktrees: Record<string, WorktreeState>;
}

type UnknownRecord = Record<string, unknown>;

export function createEmptyRegistry(): Registry {
  return {
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
    repos: {
      ...registry.repos,
      [repoFingerprint]: { ...repoState, desired_state: { ...repoState.desired_state } },
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
      repos: { ...registry.repos },
      worktrees: { ...registry.worktrees },
    };
  }

  const worktrees = { ...registry.worktrees };
  delete worktrees[worktreeId];

  return {
    repos: { ...registry.repos },
    worktrees,
  };
}

export function listManagedPathsForRemoval(materializedState: MaterializedState): string[] {
  return [...materializedState.files].sort(compareRemovalPath).concat(
    [...(materializedState.directories ?? [])].sort(compareRemovalPath),
  );
}

export function parseRegistry(input: unknown): Registry {
  const registry = expectRecord(input, "registry");
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

  return { repos, worktrees };
}

function parseRepoState(input: unknown, label: string): RepoState {
  const repo = expectRecord(input, label);
  const remoteUrl =
    repo.remote_url === undefined ? undefined : expectNonEmptyString(repo.remote_url, `${label}.remote_url`);

  return {
    repo_root: expectAbsolutePath(repo.repo_root, `${label}.repo_root`),
    desired_state: parseDesiredState(repo.desired_state, `${label}.desired_state`),
    ...(remoteUrl === undefined ? {} : { remote_url: remoteUrl }),
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

function parseDesiredState(input: unknown, label: string): DesiredState {
  const desiredState = expectRecord(input, label);

  return {
    tool: expectNonEmptyString(desiredState.tool, `${label}.tool`),
    bundle: expectNonEmptyString(desiredState.bundle, `${label}.bundle`),
  };
}

function parseMaterializedState(input: unknown, label: string): MaterializedState {
  const materializedState = expectRecord(input, label);
  const desiredState = parseDesiredState(materializedState, label);
  const files = expectArray(materializedState.files, `${label}.files`).map((value, index) =>
    expectRelativePath(value, `${label}.files[${index}]`),
  );
  const fileFingerprints =
    materializedState.file_fingerprints === undefined
      ? undefined
      : parseFileFingerprints(materializedState.file_fingerprints, files, `${label}.file_fingerprints`);
  const directories =
    materializedState.directories === undefined
      ? undefined
      : expectArray(materializedState.directories, `${label}.directories`).map((value, index) =>
          expectRelativePath(value, `${label}.directories[${index}]`),
        );

  return {
    ...desiredState,
    files,
    ...(fileFingerprints === undefined ? {} : { file_fingerprints: fileFingerprints }),
    ...(directories === undefined ? {} : { directories }),
    exclude_configured: expectBoolean(
      materializedState.exclude_configured,
      `${label}.exclude_configured`,
    ),
  };
}

function sortRegistry(registry: Registry): Registry {
  return {
    repos: Object.fromEntries(
      Object.entries(registry.repos)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([repoFingerprint, repoState]) => [
          repoFingerprint,
          {
            ...repoState,
            desired_state: { ...repoState.desired_state },
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
      ...worktreeState.materialized_state,
      files: [...worktreeState.materialized_state.files],
      ...(worktreeState.materialized_state.file_fingerprints === undefined
        ? {}
        : { file_fingerprints: { ...worktreeState.materialized_state.file_fingerprints } }),
      ...(worktreeState.materialized_state.directories === undefined
        ? {}
        : { directories: [...worktreeState.materialized_state.directories] }),
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
