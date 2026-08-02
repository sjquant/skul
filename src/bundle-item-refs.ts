import fs from "node:fs";
import path from "node:path";

import {
  type CachedBundle,
  detectSourceProtocol,
  findCachedBundle,
  listCachedBundles,
  normalizeBundleSource,
} from "./bundle-discovery";
import { fetchRemoteSource, updateCachedRemoteSource } from "./bundle-fetch";
import {
  type BundleItemSelector,
  normalizeBundleItemSelector,
  stripKnownBundleItemExtension,
} from "./bundle-items";
import {
  type BundleManifest,
  inferBundleManifest,
  MANIFEST_FILE_NAME,
} from "./bundle-manifest";
import type { ToolName, ToolTargetName } from "./tool-mapping";

export const BUNDLE_ITEM_REFS_FILE_NAME = "skul.refs.json";

const ROOT_INSTRUCTION_SELECTOR = "root-instruction";
const DIRECTORY_TARGET_NAMES = ["skills", "commands", "agents"] as const;

type DirectoryTargetName = (typeof DIRECTORY_TARGET_NAMES)[number];
type BundleItemRefTarget =
  | DirectoryTargetName
  | typeof ROOT_INSTRUCTION_SELECTOR;

export interface BundleItemRef {
  target: BundleItemRefTarget;
  name?: string;
  path?: string;
  description?: string;
  source: string;
  bundle?: string;
  item: BundleItemSelector;
  ref?: string;
  disableModelInvocation?: boolean;
  localSelector: BundleItemSelector;
}

export interface ResolvedBundleItemRef {
  path: string;
  description?: string;
  disableModelInvocation?: boolean;
}

/** Resolves every selected entry in a bundle's top-level `skul.refs.json`. */
export async function resolveBundleItemRefs(options: {
  bundleDir: string;
  manifest?: BundleManifest;
  tools?: ToolName[];
  itemSelectors?: BundleItemSelector[];
  libraryDir: string;
  protocol?: "https" | "ssh";
}): Promise<Map<string, ResolvedBundleItemRef>> {
  const resolved = new Map<string, ResolvedBundleItemRef>();
  const candidates = listBundleItemRefCandidates({
    bundleDir: options.bundleDir,
    manifest: options.manifest,
    tools: options.tools,
    itemSelectors: options.itemSelectors,
  });

  for (const itemRef of candidates) {
    const source = normalizeBundleSource(itemRef.source);
    const protocol =
      detectSourceProtocol(itemRef.source) === "ssh"
        ? "ssh"
        : (options.protocol ?? "https");
    const ref = itemRef.ref;

    await ensureReferencedSourceRevision({
      source,
      libraryDir: options.libraryDir,
      protocol,
      ref,
      includeRootInstructions: itemRef.item === "root-instruction",
    });

    const cachedBundle = resolveReferencedCachedBundle({
      libraryDir: options.libraryDir,
      source,
      bundle: itemRef.bundle,
      item: itemRef.item,
      refFilePath: refsFilePath(options.bundleDir),
    });
    const resolvedPath = resolveReferencedItemPath({
      cachedBundleDir: path.dirname(cachedBundle.manifestFile),
      manifest: cachedBundle.manifest,
      item: itemRef.item,
      source,
      refFilePath: refsFilePath(options.bundleDir),
    });

    resolved.set(itemRef.localSelector, {
      path: resolvedPath,
      ...(itemRef.description ? { description: itemRef.description } : {}),
      ...(itemRef.disableModelInvocation
        ? { disableModelInvocation: true }
        : {}),
    });
  }

  return resolved;
}

export function listBundleItemRefSelectors(options: {
  bundleDir: string;
  manifest?: BundleManifest;
  tools?: ToolName[];
}): BundleItemSelector[] {
  return listBundleItemRefCandidates(options).map((ref) => ref.localSelector);
}

async function ensureReferencedSourceRevision(options: {
  source: string;
  libraryDir: string;
  protocol: "https" | "ssh";
  ref?: string;
  includeRootInstructions?: boolean;
}): Promise<void> {
  if (options.ref) {
    await updateCachedRemoteSource(options);
    return;
  }

  await fetchRemoteSource(options);
}

function listBundleItemRefCandidates(options: {
  bundleDir: string;
  manifest?: BundleManifest;
  tools?: ToolName[];
  itemSelectors?: BundleItemSelector[];
}): BundleItemRef[] {
  const refs = readBundleItemRefs({
    bundleDir: options.bundleDir,
    manifest: options.manifest,
  });

  if (refs.length === 0) {
    return [];
  }

  const selectedTargets = listSelectedRefTargets({
    manifest: options.manifest,
    tools: options.tools,
  });
  const selectedRefs = refs.filter((ref) =>
    isRefTargetSelected(ref, selectedTargets),
  );

  return selectedRefs.filter(
    (ref) =>
      !options.itemSelectors ||
      options.itemSelectors.includes(ref.localSelector),
  );
}

function readBundleItemRefs(options: {
  bundleDir: string;
  manifest?: BundleManifest;
}): BundleItemRef[] {
  const filePath = refsFilePath(options.bundleDir);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  const refs = parseBundleItemRefsFile(filePath);
  assertUniqueLocalRefs(refs, filePath);
  assertNoLocalRefConflicts({
    bundleDir: options.bundleDir,
    manifest: options.manifest,
    refs,
    filePath,
  });
  return refs;
}

function refsFilePath(bundleDir: string): string {
  return path.join(bundleDir, BUNDLE_ITEM_REFS_FILE_NAME);
}

function parseBundleItemRefsFile(filePath: string): BundleItemRef[] {
  let raw: unknown;

  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to parse bundle item refs ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Bundle item refs root must be an object: ${filePath}`);
  }

  const record = raw as Record<string, unknown>;

  if (!Array.isArray(record.refs)) {
    throw new Error(
      `Bundle item refs must define "refs" as an array: ${filePath}`,
    );
  }

  return record.refs.map((entry, index) =>
    parseBundleItemRefEntry(entry, `${filePath}#refs[${index}]`),
  );
}

function parseBundleItemRefEntry(
  entry: unknown,
  location: string,
): BundleItemRef {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Bundle item ref entry must be an object: ${location}`);
  }

  const record = entry as Record<string, unknown>;
  const target = expectTarget(record.target, location);
  const name =
    target === ROOT_INSTRUCTION_SELECTOR
      ? expectForbiddenName(record.name, location)
      : expectLocalName(record.name, target, location);
  const localPath =
    target === ROOT_INSTRUCTION_SELECTOR
      ? expectOptionalRootInstructionPath(record.path, location)
      : expectForbiddenPath(record.path, target, location);
  const source = expectNonEmptyString(record.source, "source", location);
  const description = expectOptionalNonEmptyString(
    record.description,
    "description",
    location,
  );
  const bundle = expectOptionalNonEmptyString(
    record.bundle,
    "bundle",
    location,
  );
  const ref = expectOptionalNonEmptyString(record.ref, "ref", location);
  assertNoPin(record, location);
  const hasDisableModelInvocation = Object.hasOwn(
    record,
    "disable-model-invocation",
  );
  const disableModelInvocation = hasDisableModelInvocation
    ? expectBoolean(
        record["disable-model-invocation"],
        "disable-model-invocation",
        location,
      )
    : undefined;

  if (hasDisableModelInvocation && target !== "skills") {
    throw new Error(
      `Bundle item ref skill-only option "disable-model-invocation" is only valid for skills: ${location}`,
    );
  }

  if (description !== undefined && target !== "skills" && target !== "agents") {
    throw new Error(
      `Bundle item ref "description" is only valid for skills and agents: ${location}`,
    );
  }

  const localSelector =
    target === ROOT_INSTRUCTION_SELECTOR ? target : `${target}/${name}`;
  const item = normalizeRefItem(
    expectOptionalNonEmptyString(record.item, "item", location) ??
      localSelector,
    location,
  );
  assertCompatibleRefItemTarget({ target, item, location });

  return {
    target,
    ...(name ? { name } : {}),
    ...(localPath ? { path: localPath } : {}),
    ...(description ? { description } : {}),
    source,
    ...(bundle ? { bundle } : {}),
    item,
    ...(ref ? { ref } : {}),
    ...(disableModelInvocation ? { disableModelInvocation: true } : {}),
    localSelector,
  };
}

function assertNoPin(record: Record<string, unknown>, location: string): void {
  if (Object.hasOwn(record, "pin")) {
    throw new Error(
      `Bundle item ref "pin" is not supported; use "ref" instead: ${location}`,
    );
  }
}

function expectTarget(value: unknown, location: string): BundleItemRefTarget {
  if (
    value === "skills" ||
    value === "agents" ||
    value === "commands" ||
    value === ROOT_INSTRUCTION_SELECTOR
  ) {
    return value;
  }

  throw new Error(
    `Bundle item ref "target" must be skills, agents, commands, or root-instruction: ${location}`,
  );
}

function expectLocalName(
  value: unknown,
  target: DirectoryTargetName,
  location: string,
): string {
  const name = expectNonEmptyString(value, "name", location);
  const normalized = stripKnownBundleItemExtension(name);

  if (
    normalized !== name ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized === "." ||
    normalized === ".."
  ) {
    throw new Error(
      `Bundle item ref "name" must be a top-level ${target} item name: ${location}`,
    );
  }

  return normalized;
}

function expectForbiddenName(value: unknown, location: string): undefined {
  if (value !== undefined) {
    throw new Error(
      `Bundle item ref "name" is only valid for skills, agents, and commands: ${location}`,
    );
  }
}

function expectOptionalRootInstructionPath(
  value: unknown,
  location: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const rootPath = expectNonEmptyString(value, "path", location);

  if (
    path.isAbsolute(rootPath) ||
    rootPath.includes("\\") ||
    rootPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(
      `Bundle item ref "path" must be a safe bundle-relative path: ${location}`,
    );
  }

  return rootPath;
}

function expectForbiddenPath(
  value: unknown,
  target: DirectoryTargetName,
  location: string,
): undefined {
  if (value !== undefined) {
    throw new Error(
      `Bundle item ref "path" is only valid for root-instruction refs, not ${target}: ${location}`,
    );
  }
}

function normalizeRefItem(item: string, location: string): BundleItemSelector {
  const value = item.trim();

  if (value.includes("\\")) {
    throw new Error(
      `Bundle item ref "item" must target one top-level item: ${location}`,
    );
  }

  let selector: BundleItemSelector;
  try {
    selector = normalizeBundleItemSelector(value);
  } catch {
    throw new Error(
      `Bundle item ref "item" must target one top-level item: ${location}`,
    );
  }

  if (selector === ROOT_INSTRUCTION_SELECTOR) {
    return selector;
  }

  const [, itemName] = selector.split("/");
  if (!itemName || itemName === "." || itemName === "..") {
    throw new Error(
      `Bundle item ref "item" must target one top-level item: ${location}`,
    );
  }

  return selector;
}

function assertCompatibleRefItemTarget(options: {
  target: BundleItemRefTarget;
  item: BundleItemSelector;
  location: string;
}): void {
  if (options.target === ROOT_INSTRUCTION_SELECTOR) {
    if (options.item === ROOT_INSTRUCTION_SELECTOR) {
      return;
    }

    throw new Error(
      `Bundle item ref "item" must match local target root-instruction: ${options.location}`,
    );
  }

  if (options.item.startsWith(`${options.target}/`)) {
    return;
  }

  throw new Error(
    `Bundle item ref "item" must match local target ${options.target}: ${options.location}`,
  );
}

function assertUniqueLocalRefs(refs: BundleItemRef[], filePath: string): void {
  const seen = new Set<BundleItemSelector>();

  for (const ref of refs) {
    if (seen.has(ref.localSelector)) {
      throw new Error(
        `Duplicate bundle item ref local identity "${ref.localSelector}": ${filePath}`,
      );
    }

    seen.add(ref.localSelector);
  }
}

function assertNoLocalRefConflicts(options: {
  bundleDir: string;
  manifest?: BundleManifest;
  refs: BundleItemRef[];
  filePath: string;
}): void {
  for (const ref of options.refs) {
    if (
      ref.target === ROOT_INSTRUCTION_SELECTOR
        ? hasLocalRootInstructionConflict(
            options.bundleDir,
            options.manifest,
            ref,
          )
        : hasLocalDirectoryItemConflict(
            options.bundleDir,
            options.manifest,
            ref,
          )
    ) {
      throw new Error(
        `Bundle item ref "${ref.localSelector}" conflicts with a local bundle item: ${options.filePath}`,
      );
    }
  }
}

function hasLocalRootInstructionConflict(
  bundleDir: string,
  manifest: BundleManifest | undefined,
  ref: BundleItemRef,
): boolean {
  const candidatePaths = ref.path
    ? [ref.path]
    : listRootInstructionConflictPaths(manifest);

  return candidatePaths.some((candidate) =>
    isFile(path.join(bundleDir, candidate)),
  );
}

function listRootInstructionConflictPaths(
  manifest: BundleManifest | undefined,
): string[] {
  if (!manifest) {
    return [
      "AGENTS.md",
      "CLAUDE.md",
      "GEMINI.md",
      ".github/copilot-instructions.md",
    ];
  }

  return Array.from(
    new Set(
      Object.values(manifest.tools).flatMap((targets) =>
        targets.root_instruction ? [targets.root_instruction.path] : [],
      ),
    ),
  );
}

function hasLocalDirectoryItemConflict(
  bundleDir: string,
  manifest: BundleManifest | undefined,
  ref: BundleItemRef,
): boolean {
  if (
    !ref.name ||
    ref.target === ROOT_INSTRUCTION_SELECTOR ||
    !isDirectoryTargetName(ref.target)
  ) {
    return false;
  }

  const targetName = ref.target;

  return listDirectoryConflictPaths(manifest, targetName).some((targetPath) => {
    const sourceDir = path.join(bundleDir, targetPath);

    if (!isDirectory(sourceDir)) {
      return false;
    }

    return fs
      .readdirSync(sourceDir, { withFileTypes: true })
      .some(
        (entry) =>
          isLocalItemEntry(entry, targetName) &&
          stripKnownBundleItemExtension(entry.name) === ref.name,
      );
  });
}

function listDirectoryConflictPaths(
  manifest: BundleManifest | undefined,
  targetName: DirectoryTargetName,
): string[] {
  if (!manifest) {
    return [targetName];
  }

  const paths = Object.values(manifest.tools).flatMap((targets) => {
    const target = targets[targetName as ToolTargetName];
    return target ? [target.path] : [];
  });

  return Array.from(new Set(paths));
}

function isLocalItemEntry(
  entry: fs.Dirent,
  target: DirectoryTargetName,
): boolean {
  if (target === "skills") {
    return entry.isDirectory();
  }

  return entry.isFile();
}

function listSelectedRefTargets(options: {
  manifest?: BundleManifest;
  tools?: ToolName[];
}): Set<BundleItemRefTarget> {
  if (!options.manifest) {
    return new Set([...DIRECTORY_TARGET_NAMES, ROOT_INSTRUCTION_SELECTOR]);
  }

  const selectedToolNames = options.tools;
  const selectedTools =
    selectedToolNames && selectedToolNames.length > 0
      ? Object.entries(options.manifest.tools).filter(([toolName]) =>
          selectedToolNames.includes(toolName as ToolName),
        )
      : Object.entries(options.manifest.tools);
  const targets = new Set<BundleItemRefTarget>();

  for (const [, toolTargets] of selectedTools) {
    for (const [targetName] of Object.entries(toolTargets)) {
      if (targetName === "root_instruction") {
        targets.add(ROOT_INSTRUCTION_SELECTOR);
        continue;
      }

      if (isDirectoryTargetName(targetName)) {
        targets.add(targetName);
      }
    }
  }

  return targets;
}

function isRefTargetSelected(
  ref: BundleItemRef,
  selectedTargets: Set<BundleItemRefTarget>,
): boolean {
  return selectedTargets.has(ref.target);
}

function isDirectoryTargetName(
  value: string | undefined,
): value is DirectoryTargetName {
  return DIRECTORY_TARGET_NAMES.includes(value as DirectoryTargetName);
}

function resolveReferencedCachedBundle(options: {
  libraryDir: string;
  source: string;
  bundle?: string;
  item: BundleItemSelector;
  refFilePath: string;
}): ReturnType<typeof findCachedBundle> {
  if (options.bundle) {
    return findCachedBundle({
      libraryDir: options.libraryDir,
      source: options.source,
      bundle: options.bundle,
    });
  }

  const matches = listCachedBundles({
    libraryDir: options.libraryDir,
  }).filter((bundle) => bundle.source === options.source);
  const itemMatches = matches.filter((bundle) =>
    findReferencedItemPath({
      cachedBundleDir: path.dirname(bundle.manifestFile),
      manifest: bundle.manifest,
      item: options.item,
    }),
  );

  if (itemMatches.length === 1) {
    return itemMatches[0]!;
  }

  if (itemMatches.length === 0) {
    const repoRootBundle = findReferencedRepoRootBundle(options);
    if (repoRootBundle) {
      return repoRootBundle;
    }

    if (matches.length === 0) {
      throw new Error(
        `No bundle found in ${options.source} for bundle item ref: ${options.refFilePath}`,
      );
    }

    throw new Error(
      `Referenced bundle item "${options.item}" not found in ${options.source}: ${options.refFilePath}`,
    );
  }

  throw new Error(
    `${options.source} has multiple bundles containing "${options.item}"; set "bundle" in the bundle item ref: ${options.refFilePath}`,
  );
}

function findReferencedRepoRootBundle(options: {
  libraryDir: string;
  source: string;
  item: BundleItemSelector;
}): CachedBundle | undefined {
  const cachedBundleDir = path.join(
    options.libraryDir,
    ...options.source.split("/"),
  );

  try {
    const manifest = inferBundleManifest(cachedBundleDir);
    if (
      !findReferencedItemPath({
        cachedBundleDir,
        manifest,
        item: options.item,
      })
    ) {
      return undefined;
    }

    return {
      source: options.source,
      bundle: options.source.split("/").at(-1)!,
      manifestFile: path.join(cachedBundleDir, MANIFEST_FILE_NAME),
      manifest,
    };
  } catch {
    return undefined;
  }
}

function resolveReferencedItemPath(options: {
  cachedBundleDir: string;
  manifest: BundleManifest;
  item: BundleItemSelector;
  source: string;
  refFilePath: string;
}): string {
  const resolvedPath = findReferencedItemPath(options);

  if (resolvedPath) {
    return resolvedPath;
  }

  throw new Error(
    `Referenced bundle item "${options.item}" not found in ${options.source}: ${options.refFilePath}`,
  );
}

function findReferencedItemPath(options: {
  cachedBundleDir: string;
  manifest: BundleManifest;
  item: BundleItemSelector;
}): string | undefined {
  if (options.item === ROOT_INSTRUCTION_SELECTOR) {
    return findRootInstructionSourceFile(options);
  }

  const [targetName, itemName] = options.item.split("/") as [
    DirectoryTargetName,
    string,
  ];

  if (targetName === "skills") {
    return findSkillSourceDir({
      cachedBundleDir: options.cachedBundleDir,
      manifest: options.manifest,
      skillName: itemName,
    });
  }

  return findDirectoryItemSourceFile({
    cachedBundleDir: options.cachedBundleDir,
    manifest: options.manifest,
    targetName,
    itemName,
  });
}

function findRootInstructionSourceFile(options: {
  cachedBundleDir: string;
  manifest: BundleManifest;
}): string | undefined {
  const candidatePaths = new Set<string>();

  for (const targets of Object.values(options.manifest.tools)) {
    const rootInstructionTarget = targets.root_instruction;
    if (rootInstructionTarget) {
      candidatePaths.add(rootInstructionTarget.path);
    }
  }

  for (const candidate of candidatePaths) {
    const filePath = path.join(options.cachedBundleDir, candidate);

    if (isFile(filePath)) {
      return filePath;
    }
  }

  return undefined;
}

function findSkillSourceDir(options: {
  cachedBundleDir: string;
  manifest: BundleManifest;
  skillName: string;
}): string | undefined {
  const candidatePaths = new Set<string>();

  for (const targets of Object.values(options.manifest.tools)) {
    const skillsTarget = targets.skills;
    if (skillsTarget) {
      candidatePaths.add(skillsTarget.path);
    }
  }

  for (const candidate of candidatePaths) {
    const dir = path.join(
      options.cachedBundleDir,
      candidate,
      options.skillName,
    );

    if (isDirectory(dir)) {
      return dir;
    }
  }

  return undefined;
}

function findDirectoryItemSourceFile(options: {
  cachedBundleDir: string;
  manifest: BundleManifest;
  targetName: Exclude<DirectoryTargetName, "skills">;
  itemName: string;
}): string | undefined {
  const candidatePaths = new Set<string>();

  for (const targets of Object.values(options.manifest.tools)) {
    const target = targets[options.targetName as ToolTargetName];
    if (target) {
      candidatePaths.add(target.path);
    }
  }

  for (const candidate of candidatePaths) {
    const dir = path.join(options.cachedBundleDir, candidate);
    const filePath = findTopLevelItemFile({
      dir,
      targetName: options.targetName,
      itemName: options.itemName,
    });

    if (filePath) {
      return filePath;
    }
  }

  return undefined;
}

function findTopLevelItemFile(options: {
  dir: string;
  targetName: Exclude<DirectoryTargetName, "skills">;
  itemName: string;
}): string | undefined {
  if (!isDirectory(options.dir)) {
    return undefined;
  }

  for (const entry of fs.readdirSync(options.dir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }

    if (stripKnownBundleItemExtension(entry.name) !== options.itemName) {
      continue;
    }

    if (
      (options.targetName === "commands" && !entry.name.endsWith(".md")) ||
      (options.targetName === "agents" &&
        !entry.name.endsWith(".md") &&
        !entry.name.endsWith(".agent.md"))
    ) {
      continue;
    }

    const filePath = path.join(options.dir, entry.name);

    if (isFile(filePath)) {
      return filePath;
    }
  }

  return undefined;
}

function isDirectory(dirPath: string): boolean {
  try {
    return fs.lstatSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function isFile(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function expectNonEmptyString(
  value: unknown,
  field: string,
  location: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Bundle item ref "${field}" is required: ${location}`);
  }

  return value;
}

function expectOptionalNonEmptyString(
  value: unknown,
  field: string,
  location: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectNonEmptyString(value, field, location);
}

function expectBoolean(
  value: unknown,
  field: string,
  location: string,
): boolean {
  if (typeof value !== "boolean") {
    throw new Error(
      `Bundle item ref "${field}" must be a boolean: ${location}`,
    );
  }

  return value;
}
