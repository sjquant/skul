import path from "node:path";

export type InstallMode = "stealth" | "tracked";

export interface DesiredState {
  tool: string;
  bundle: string;
  mode: InstallMode;
}

export interface RepoState {
  repo_root: string;
  remote_url?: string;
  desired_state: DesiredState;
}

export interface MaterializedState extends DesiredState {
  files: string[];
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
    mode: parseInstallMode(desiredState.mode, `${label}.mode`),
  };
}

function parseMaterializedState(input: unknown, label: string): MaterializedState {
  const materializedState = expectRecord(input, label);
  const desiredState = parseDesiredState(materializedState, label);
  const files = expectArray(materializedState.files, `${label}.files`).map((value, index) =>
    expectRelativePath(value, `${label}.files[${index}]`),
  );

  return {
    ...desiredState,
    files,
    exclude_configured: expectBoolean(
      materializedState.exclude_configured,
      `${label}.exclude_configured`,
    ),
  };
}

function parseInstallMode(input: unknown, label: string): InstallMode {
  if (input === "stealth" || input === "tracked") {
    return input;
  }

  throw new Error(`${label} must be "stealth" or "tracked"`);
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
