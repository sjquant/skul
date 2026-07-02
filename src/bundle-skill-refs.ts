import fs from "node:fs";
import path from "node:path";

import {
  detectSourceProtocol,
  findCachedBundle,
  listCachedBundles,
  normalizeBundleSource,
} from "./bundle-discovery";
import { fetchRemoteSource } from "./bundle-fetch";
import type { BundleManifest } from "./bundle-manifest";

export const SKILL_REF_SUFFIX = ".ref.json";

export interface SkillRef {
  source: string;
  bundle?: string;
  item: string;
  ref?: string;
  pin?: string;
}

/** Returns true when a filename is a skill reference file (e.g. `insane-search.ref.json`). */
export function isSkillRefFileName(name: string): boolean {
  return (
    name.endsWith(SKILL_REF_SUFFIX) && name.length > SKILL_REF_SUFFIX.length
  );
}

/** Strips the `.ref.json` suffix, returning the reference's local item name. */
export function skillRefNameFromFileName(name: string): string {
  return name.slice(0, -SKILL_REF_SUFFIX.length);
}

/** Parses and validates one skill reference file's contents. */
export function parseSkillRefFile(options: {
  filePath: string;
  refName: string;
}): SkillRef {
  let raw: unknown;

  try {
    raw = JSON.parse(fs.readFileSync(options.filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to parse skill reference ${options.filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Skill reference must be an object: ${options.filePath}`);
  }

  const record = raw as Record<string, unknown>;
  const source = expectNonEmptyString(
    record.source,
    "source",
    options.filePath,
  );
  const bundle = expectOptionalNonEmptyString(
    record.bundle,
    "bundle",
    options.filePath,
  );
  const ref = expectOptionalNonEmptyString(record.ref, "ref", options.filePath);
  const pin = expectOptionalNonEmptyString(record.pin, "pin", options.filePath);

  if (ref && pin) {
    throw new Error(
      `Skill reference cannot set both "ref" and "pin": ${options.filePath}`,
    );
  }

  const item =
    expectOptionalNonEmptyString(record.item, "item", options.filePath) ??
    `skills/${options.refName}`;

  if (!item.startsWith("skills/") || item === "skills/") {
    throw new Error(
      `Skill reference "item" must be skills/<name>: ${options.filePath}`,
    );
  }

  return {
    source,
    ...(bundle ? { bundle } : {}),
    item,
    ...(ref ? { ref } : {}),
    ...(pin ? { pin } : {}),
  };
}

/**
 * Resolves every `.ref.json` skill reference directly inside a bundle's `skills/`
 * directory to an absolute directory path in the local library cache.
 *
 * Fetches referenced sources into the library cache when not already present.
 * Returns a map keyed by the reference file's bundle-relative path
 * (e.g. `skills/insane-search.ref.json`) to the resolved skill's absolute directory.
 */
export async function resolveBundleSkillRefs(options: {
  bundleDir: string;
  libraryDir: string;
  protocol?: "https" | "ssh";
}): Promise<Map<string, string>> {
  const skillsDir = path.join(options.bundleDir, "skills");
  const resolved = new Map<string, string>();

  if (!fs.existsSync(skillsDir)) {
    return resolved;
  }

  const refEntries = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isSkillRefFileName(entry.name));

  for (const entry of refEntries) {
    const refFilePath = path.join(skillsDir, entry.name);
    const refName = skillRefNameFromFileName(entry.name);
    const skillRef = parseSkillRefFile({ filePath: refFilePath, refName });
    const source = normalizeBundleSource(skillRef.source);
    const protocol =
      detectSourceProtocol(skillRef.source) === "ssh"
        ? "ssh"
        : (options.protocol ?? "https");

    await fetchRemoteSource({
      source,
      libraryDir: options.libraryDir,
      protocol,
      ref: skillRef.pin ?? skillRef.ref,
    });

    const cachedBundle = resolveReferencedCachedBundle({
      libraryDir: options.libraryDir,
      source,
      bundle: skillRef.bundle,
      refFilePath,
    });

    const skillName = skillRef.item.slice("skills/".length);
    const resolvedSkillDir = resolveSkillSourceDir({
      cachedBundleDir: path.dirname(cachedBundle.manifestFile),
      manifest: cachedBundle.manifest,
      skillName,
      source,
      refFilePath,
    });

    resolved.set(`skills/${entry.name}`, resolvedSkillDir);
  }

  return resolved;
}

function resolveReferencedCachedBundle(options: {
  libraryDir: string;
  source: string;
  bundle?: string;
  refFilePath: string;
}): ReturnType<typeof findCachedBundle> {
  if (options.bundle) {
    return findCachedBundle({
      libraryDir: options.libraryDir,
      source: options.source,
      bundle: options.bundle,
    });
  }

  const repoSlug = options.source.split("/").at(-1)!;

  try {
    return findCachedBundle({
      libraryDir: options.libraryDir,
      source: options.source,
      bundle: repoSlug,
    });
  } catch {
    // Fall through to scanning for a unique bundle in this source below.
  }

  const matches = listCachedBundles({ libraryDir: options.libraryDir }).filter(
    (candidate) => candidate.source === options.source,
  );

  if (matches.length === 1) {
    return matches[0]!;
  }

  if (matches.length === 0) {
    throw new Error(
      `No bundle found in ${options.source} for skill reference: ${options.refFilePath}`,
    );
  }

  throw new Error(
    `${options.source} has multiple bundles; set "bundle" in the skill reference: ${options.refFilePath}`,
  );
}

function resolveSkillSourceDir(options: {
  cachedBundleDir: string;
  manifest: BundleManifest;
  skillName: string;
  source: string;
  refFilePath: string;
}): string {
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

  throw new Error(
    `Referenced skill "${options.skillName}" not found in ${options.source}: ${options.refFilePath}`,
  );
}

function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function expectNonEmptyString(
  value: unknown,
  field: string,
  filePath: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Skill reference "${field}" is required: ${filePath}`);
  }

  return value;
}

function expectOptionalNonEmptyString(
  value: unknown,
  field: string,
  filePath: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectNonEmptyString(value, field, filePath);
}
