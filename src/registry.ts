import fs from "node:fs";
import path from "node:path";

import {
  type BundleItemSelector,
  normalizeBundleItemSelector,
} from "./bundle-items";
import { pathDepth } from "./fs-utils";
import { listToolDefinitions, type ToolName } from "./tool-mapping";

const KNOWN_TOOL_NAMES = new Set<ToolName>(
  listToolDefinitions().map((t) => t.name),
);

function isToolName(value: string): value is ToolName {
  return KNOWN_TOOL_NAMES.has(value as ToolName);
}

export interface DesiredBundleEntry {
  bundle: string;
  source?: string;
  tools?: ToolName[];
  /** Optional bundle-internal item selectors, such as skills/review or root-instruction. */
  items?: BundleItemSelector[];
  /** Clone protocol used when the bundle source was first fetched. */
  protocol: "https" | "ssh";
  /** Optional user-selected branch, tag, or commit selector for remote-backed bundles. */
  ref?: string;
  /** Last resolved branch or tag name when the selector was refreshed. */
  resolved_ref?: string;
  /** Last resolved commit SHA for the desired bundle source. */
  resolved_commit?: string;
}

export interface MaterializedToolState {
  files: string[];
  file_fingerprints?: Record<string, string>;
  directories?: string[];
  items?: BundleItemSelector[];
}

export interface MaterializedBundleState {
  source?: string;
  /** Commit SHA last materialized in this worktree for the bundle. */
  resolved_commit?: string;
  tools: Record<string, MaterializedToolState>;
}

export interface MaterializedState {
  bundles: Record<string, MaterializedBundleState>;
  exclude_configured: boolean;
  root_instruction_base_contents?: Record<string, string>;
}

export type ShadowStrategy = "append" | "prepend" | "replace";

export interface ShadowedFileState {
  tool: ToolName;
  bundle: string;
  strategy: ShadowStrategy;
  base_blob: string;
  overlay: string;
  overlay_fingerprint: string;
  rendered_fingerprint: string;
  skip_worktree: boolean;
}

export interface RepoState {
  repo_root: string;
  desired_state: DesiredBundleEntry[];
}

export interface WorktreeState {
  repo_fingerprint: string;
  path: string;
  materialized_state: MaterializedState;
  shadowed_files: Record<string, ShadowedFileState>;
}

export interface GlobalMaterializedState {
  bundles: Record<string, MaterializedBundleState>;
  root_instruction_base_contents?: Record<string, string>;
}

export interface GlobalState {
  desired_state: DesiredBundleEntry[];
  materialized_state: GlobalMaterializedState;
}

export interface Registry {
  version: 1;
  repos: Record<string, RepoState>;
  worktrees: Record<string, WorktreeState>;
  global?: GlobalState;
}

type UnknownRecord = Record<string, unknown>;

/** Creates an empty registry object at the current schema version. */
export function createEmptyRegistry(): Registry {
  return {
    version: 1,
    repos: {},
    worktrees: {},
  };
}

/** Reads the registry from disk, defaulting to an empty registry when it does not exist. */
export function readRegistryFile(registryFile: string): Registry {
  if (!fs.existsSync(registryFile)) {
    return createEmptyRegistry();
  }

  return parseRegistry(
    JSON.parse(fs.readFileSync(registryFile, "utf8")) as unknown,
  );
}

/** Persists the registry to disk using stable ordering and a trailing newline. */
export function writeRegistryFile(
  registryFile: string,
  registry: Registry,
): void {
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  fs.writeFileSync(
    registryFile,
    `${JSON.stringify(sortRegistry(registry), null, 2)}\n`,
  );
}

/** Replaces one repository entry in the registry while preserving all others. */
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
          ...(entry.items !== undefined ? { items: [...entry.items] } : {}),
          protocol: entry.protocol,
          ...(entry.ref !== undefined ? { ref: entry.ref } : {}),
          ...(entry.resolved_ref !== undefined
            ? { resolved_ref: entry.resolved_ref }
            : {}),
          ...(entry.resolved_commit !== undefined
            ? { resolved_commit: entry.resolved_commit }
            : {}),
        })),
      },
    },
    worktrees: { ...registry.worktrees },
  };
}

/** Replaces one worktree entry in the registry while preserving all others. */
export function upsertWorktreeState(
  registry: Registry,
  worktreeId: string,
  worktreeState: WorktreeState,
): Registry {
  if (!(worktreeState.repo_fingerprint in registry.repos)) {
    throw new Error(
      `worktrees.${worktreeId}.repo_fingerprint must reference a repository entry`,
    );
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

/** Removes one worktree entry from the registry. */
export function removeWorktreeState(
  registry: Registry,
  worktreeId: string,
): Registry {
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

/** Returns managed files and directories in a safe removal order. */
export function listManagedPathsForRemoval(state: {
  files: string[];
  directories?: string[];
}): string[] {
  return [...state.files]
    .sort(compareRemovalPath)
    .concat([...(state.directories ?? [])].sort(compareRemovalPath));
}

/** Validates and normalizes raw registry JSON into the typed schema. */
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

  const globalState = registry.global !== undefined
    ? parseGlobalState(registry.global, "global")
    : undefined;

  return { version: 1, repos, worktrees, ...(globalState !== undefined ? { global: globalState } : {}) };
}

function parseRepoState(input: unknown, label: string): RepoState {
  const repo = expectRecord(input, label);

  return {
    repo_root: expectAbsolutePath(repo.repo_root, `${label}.repo_root`),
    desired_state: parseDesiredState(
      repo.desired_state,
      `${label}.desired_state`,
    ),
  };
}

function parseDesiredState(
  input: unknown,
  label: string,
): DesiredBundleEntry[] {
  return expectArray(input, label).map((entry, index) =>
    parseDesiredBundleEntry(entry, `${label}[${index}]`),
  );
}

function parseDesiredBundleEntry(
  input: unknown,
  label: string,
): DesiredBundleEntry {
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
          if (!isToolName(name)) {
            throw new Error(
              `${label}.tools[${index}] must be one of: ${Array.from(KNOWN_TOOL_NAMES).join(", ")}`,
            );
          }
          return name;
        });
  const protocol = expectProtocol(entry.protocol, `${label}.protocol`);
  const items =
    entry.items === undefined
      ? undefined
      : expectArray(entry.items, `${label}.items`).map((value, index) =>
          normalizeBundleItemSelector(
            expectNonEmptyString(value, `${label}.items[${index}]`),
          ),
        );
  const ref =
    entry.ref === undefined
      ? undefined
      : expectNonEmptyString(entry.ref, `${label}.ref`);
  const resolvedRef =
    entry.resolved_ref === undefined
      ? undefined
      : expectNonEmptyString(entry.resolved_ref, `${label}.resolved_ref`);
  const resolvedCommit =
    entry.resolved_commit === undefined
      ? undefined
      : expectGitObjectId(entry.resolved_commit, `${label}.resolved_commit`);

  return {
    bundle,
    ...(source !== undefined ? { source } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(items !== undefined ? { items } : {}),
    protocol,
    ...(ref !== undefined ? { ref } : {}),
    ...(resolvedRef !== undefined ? { resolved_ref: resolvedRef } : {}),
    ...(resolvedCommit !== undefined
      ? { resolved_commit: resolvedCommit }
      : {}),
  };
}

function parseWorktreeState(input: unknown, label: string): WorktreeState {
  const worktree = expectRecord(input, label);

  return {
    repo_fingerprint: expectNonEmptyString(
      worktree.repo_fingerprint,
      `${label}.repo_fingerprint`,
    ),
    path: expectAbsolutePath(worktree.path, `${label}.path`),
    materialized_state: parseMaterializedState(
      worktree.materialized_state,
      `${label}.materialized_state`,
    ),
    shadowed_files: parseShadowedFiles(
      worktree.shadowed_files,
      `${label}.shadowed_files`,
    ),
  };
}

function parseMaterializedState(
  input: unknown,
  label: string,
): MaterializedState {
  const state = expectRecord(input, label);
  const bundlesInput = expectRecord(state.bundles, `${label}.bundles`);

  const bundles = Object.fromEntries(
    Object.entries(bundlesInput).map(([bundleName, bundleValue]) => [
      bundleName,
      parseMaterializedBundleState(
        bundleValue,
        `${label}.bundles.${bundleName}`,
      ),
    ]),
  );

  const rootInstructionBaseContents =
    state.root_instruction_base_contents === undefined
      ? undefined
      : parseRootInstructionBaseContents(
          state.root_instruction_base_contents,
          `${label}.root_instruction_base_contents`,
        );

  return {
    bundles,
    exclude_configured: expectBoolean(
      state.exclude_configured,
      `${label}.exclude_configured`,
    ),
    ...(rootInstructionBaseContents !== undefined
      ? { root_instruction_base_contents: rootInstructionBaseContents }
      : {}),
  };
}

function parseMaterializedBundleState(
  input: unknown,
  label: string,
): MaterializedBundleState {
  const bundle = expectRecord(input, label);
  const source =
    bundle.source === undefined
      ? undefined
      : expectNonEmptyString(bundle.source, `${label}.source`);
  const resolvedCommit =
    bundle.resolved_commit === undefined
      ? undefined
      : expectGitObjectId(bundle.resolved_commit, `${label}.resolved_commit`);
  const toolsInput = expectRecord(bundle.tools, `${label}.tools`);

  const tools = Object.fromEntries(
    Object.entries(toolsInput).map(([toolName, toolValue]) => {
      if (!isToolName(toolName)) {
        throw new Error(
          `${label}.tools.${toolName} must be one of: ${Array.from(KNOWN_TOOL_NAMES).join(", ")}`,
        );
      }
      return [
        toolName,
        parseMaterializedToolState(toolValue, `${label}.tools.${toolName}`),
      ];
    }),
  );

  return {
    ...(source !== undefined ? { source } : {}),
    ...(resolvedCommit !== undefined
      ? { resolved_commit: resolvedCommit }
      : {}),
    tools,
  };
}

function parseMaterializedToolState(
  input: unknown,
  label: string,
): MaterializedToolState {
  const toolState = expectRecord(input, label);
  const files = expectArray(toolState.files, `${label}.files`).map(
    (value, index) => expectRelativePath(value, `${label}.files[${index}]`),
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
      : expectArray(toolState.directories, `${label}.directories`).map(
          (value, index) =>
            expectRelativePath(value, `${label}.directories[${index}]`),
        );
  const items =
    toolState.items === undefined
      ? undefined
      : expectArray(toolState.items, `${label}.items`).map((value, index) =>
          normalizeBundleItemSelector(
            expectNonEmptyString(value, `${label}.items[${index}]`),
          ),
        );

  return {
    files,
    ...(fileFingerprints === undefined
      ? {}
      : { file_fingerprints: fileFingerprints }),
    ...(directories === undefined ? {} : { directories }),
    ...(items === undefined ? {} : { items }),
  };
}

function parseShadowedFiles(
  input: unknown,
  label: string,
): Record<string, ShadowedFileState> {
  if (input === undefined) {
    return {};
  }

  const record = expectRecord(input, label);

  return Object.fromEntries(
    Object.entries(record).map(([relativePath, value]) => [
      expectRelativePath(relativePath, `${label}.${relativePath}`),
      parseShadowedFileState(value, `${label}.${relativePath}`),
    ]),
  );
}

function parseShadowedFileState(
  input: unknown,
  label: string,
): ShadowedFileState {
  const shadowedFile = expectRecord(input, label);
  const tool = expectNonEmptyString(shadowedFile.tool, `${label}.tool`);

  if (!isToolName(tool)) {
    throw new Error(
      `${label}.tool must be one of: ${Array.from(KNOWN_TOOL_NAMES).join(", ")}`,
    );
  }

  return {
    tool,
    bundle: expectNonEmptyString(shadowedFile.bundle, `${label}.bundle`),
    strategy: expectShadowStrategy(shadowedFile.strategy, `${label}.strategy`),
    base_blob: expectGitObjectId(shadowedFile.base_blob, `${label}.base_blob`),
    overlay: expectNonEmptyString(shadowedFile.overlay, `${label}.overlay`),
    overlay_fingerprint: expectNonEmptyString(
      shadowedFile.overlay_fingerprint,
      `${label}.overlay_fingerprint`,
    ),
    rendered_fingerprint: expectNonEmptyString(
      shadowedFile.rendered_fingerprint,
      `${label}.rendered_fingerprint`,
    ),
    skip_worktree: expectBoolean(
      shadowedFile.skip_worktree,
      `${label}.skip_worktree`,
    ),
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
            desired_state: repoState.desired_state.map((entry) => ({
              bundle: entry.bundle,
              ...(entry.source !== undefined ? { source: entry.source } : {}),
              ...(entry.tools !== undefined ? { tools: [...entry.tools] } : {}),
              ...(entry.items !== undefined ? { items: [...entry.items] } : {}),
              protocol: entry.protocol,
              ...(entry.ref !== undefined ? { ref: entry.ref } : {}),
              ...(entry.resolved_ref !== undefined
                ? { resolved_ref: entry.resolved_ref }
                : {}),
              ...(entry.resolved_commit !== undefined
                ? { resolved_commit: entry.resolved_commit }
                : {}),
            })),
          },
        ]),
    ),
    worktrees: Object.fromEntries(
      Object.entries(registry.worktrees)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([worktreeId, worktreeState]) => [
          worktreeId,
          cloneWorktreeState(worktreeState),
        ]),
    ),
    ...(registry.global !== undefined
      ? {
          global: {
            desired_state: registry.global.desired_state.map((entry) => ({ ...entry })),
            materialized_state: {
              bundles: Object.fromEntries(
                Object.entries(registry.global.materialized_state.bundles)
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([name, state]) => [name, cloneMaterializedBundleState(state)]),
              ),
              ...(registry.global.materialized_state.root_instruction_base_contents !== undefined
                ? { root_instruction_base_contents: { ...registry.global.materialized_state.root_instruction_base_contents } }
                : {}),
            },
          },
        }
      : {}),
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
              ...(bundleState.source !== undefined
                ? { source: bundleState.source }
                : {}),
              ...(bundleState.resolved_commit !== undefined
                ? { resolved_commit: bundleState.resolved_commit }
                : {}),
              tools: Object.fromEntries(
                Object.entries(bundleState.tools).map(
                  ([toolName, toolState]) => [
                    toolName,
                    {
                      files: [...toolState.files],
                      ...(toolState.file_fingerprints !== undefined
                        ? {
                            file_fingerprints: {
                              ...toolState.file_fingerprints,
                            },
                          }
                        : {}),
                      ...(toolState.directories !== undefined
                        ? { directories: [...toolState.directories] }
                        : {}),
                      ...(toolState.items !== undefined
                        ? { items: [...toolState.items] }
                        : {}),
                    },
                  ],
                ),
              ),
            },
          ],
        ),
      ),
      exclude_configured: worktreeState.materialized_state.exclude_configured,
      ...(worktreeState.materialized_state.root_instruction_base_contents !==
      undefined
        ? {
            root_instruction_base_contents: {
              ...worktreeState.materialized_state
                .root_instruction_base_contents,
            },
          }
        : {}),
    },
    shadowed_files: Object.fromEntries(
      Object.entries(worktreeState.shadowed_files)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([relativePath, shadowedFile]) => [
          relativePath,
          { ...shadowedFile },
        ]),
    ),
  };
}

function parseRootInstructionBaseContents(
  input: unknown,
  label: string,
): Record<string, string> {
  const record = expectRecord(input, label);

  return Object.fromEntries(
    Object.entries(record).map(([filePath, value]) => {
      if (filePath !== "AGENTS.md" && filePath !== "CLAUDE.md") {
        throw new Error(`${label}.${filePath} must be AGENTS.md or CLAUDE.md`);
      }

      if (typeof value !== "string") {
        throw new Error(`${label}.${filePath} must be a string`);
      }

      return [filePath, value];
    }),
  );
}

function parseGlobalRootInstructionBaseContents(
  input: unknown,
  label: string,
): Record<string, string> {
  const record = expectRecord(input, label);
  const ALLOWED = new Set(["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"]);

  return Object.fromEntries(
    Object.entries(record).map(([filePath, value]) => {
      if (!ALLOWED.has(filePath)) {
        throw new Error(`${label}.${filePath} must be a known root instruction path`);
      }

      if (typeof value !== "string") {
        throw new Error(`${label}.${filePath} must be a string`);
      }

      return [filePath, value];
    }),
  );
}

function parseGlobalState(input: unknown, label: string): GlobalState {
  const state = expectRecord(input, label);
  return {
    desired_state: parseDesiredState(state.desired_state, `${label}.desired_state`),
    materialized_state: parseGlobalMaterializedState(state.materialized_state, `${label}.materialized_state`),
  };
}

function parseGlobalMaterializedState(input: unknown, label: string): GlobalMaterializedState {
  const state = expectRecord(input, label);
  const bundlesInput = expectRecord(state.bundles, `${label}.bundles`);
  const bundles = Object.fromEntries(
    Object.entries(bundlesInput).map(([bundleName, bundleValue]) => [
      bundleName,
      parseMaterializedBundleState(bundleValue, `${label}.bundles.${bundleName}`),
    ]),
  );
  const rootInstructionBaseContents =
    state.root_instruction_base_contents === undefined
      ? undefined
      : parseGlobalRootInstructionBaseContents(state.root_instruction_base_contents, `${label}.root_instruction_base_contents`);

  return {
    bundles,
    ...(rootInstructionBaseContents !== undefined ? { root_instruction_base_contents: rootInstructionBaseContents } : {}),
  };
}

export function upsertGlobalState(
  registry: Registry,
  globalState: GlobalState,
): Registry {
  return {
    version: 1,
    repos: { ...registry.repos },
    worktrees: { ...registry.worktrees },
    global: {
      desired_state: globalState.desired_state.map((entry) => ({ ...entry })),
      materialized_state: {
        bundles: Object.fromEntries(
          Object.entries(globalState.materialized_state.bundles).map(
            ([name, state]) => [name, cloneMaterializedBundleState(state)],
          ),
        ),
        ...(globalState.materialized_state.root_instruction_base_contents !== undefined
          ? { root_instruction_base_contents: { ...globalState.materialized_state.root_instruction_base_contents } }
          : {}),
      },
    },
  };
}

function cloneMaterializedBundleState(state: MaterializedBundleState): MaterializedBundleState {
  return {
    ...(state.source !== undefined ? { source: state.source } : {}),
    ...(state.resolved_commit !== undefined ? { resolved_commit: state.resolved_commit } : {}),
    tools: Object.fromEntries(
      Object.entries(state.tools).map(([toolName, toolState]) => [
        toolName,
        {
          files: [...toolState.files],
          ...(toolState.file_fingerprints !== undefined ? { file_fingerprints: { ...toolState.file_fingerprints } } : {}),
          ...(toolState.directories !== undefined ? { directories: [...toolState.directories] } : {}),
        },
      ]),
    ),
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
  const normalized = path.normalize(value);

  if (
    path.isAbsolute(value) ||
    normalized === "." ||
    normalized.startsWith("..")
  ) {
    throw new Error(`${label} must be a relative path`);
  }

  return normalized;
}

function expectBoolean(input: unknown, label: string): boolean {
  if (typeof input !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }

  return input;
}

function expectProtocol(input: unknown, label: string): "https" | "ssh" {
  if (input !== "https" && input !== "ssh") {
    throw new Error(`${label} must be "https" or "ssh"`);
  }
  return input;
}

function expectShadowStrategy(input: unknown, label: string): ShadowStrategy {
  if (input !== "append" && input !== "prepend" && input !== "replace") {
    throw new Error(`${label} must be "append", "prepend", or "replace"`);
  }

  return input;
}

function expectGitObjectId(input: unknown, label: string): string {
  const value = expectNonEmptyString(input, label);

  if (!/^[0-9a-f]{7,40}$/i.test(value)) {
    throw new Error(
      `${label} must be a 7-40 character hexadecimal Git object id`,
    );
  }

  return value;
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
        throw new Error(
          `${label}.${relativePath} must reference a tracked file`,
        );
      }

      return [
        relativePath,
        expectNonEmptyString(fingerprint, `${label}.${relativePath}`),
      ];
    }),
  );
}
