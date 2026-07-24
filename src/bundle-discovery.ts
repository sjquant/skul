import fs from "node:fs";
import path from "node:path";

import {
  type BundleManifest,
  inferBundleManifest,
  MANIFEST_FILE_NAME,
  mergeBundleManifests,
  parseBundleManifest,
  resolveCachedBundleLayout,
} from "./bundle-manifest";
import { safeReaddirSync } from "./fs-utils";

export interface CachedBundle {
  source: string;
  bundle: string;
  manifestFile: string;
  manifest: BundleManifest;
}

const CLAUDE_MARKETPLACE_FILE = path.join(".claude-plugin", "marketplace.json");

/**
 * Infers the preferred clone protocol from a raw user-supplied source string.
 *
 * Returns "ssh" when the input starts with `git@` (the standard SCP-style SSH
 * syntax, e.g. `git@github.com:owner/repo.git`). All other forms — HTTPS URLs
 * (`https://…`) and plain source shorthand — return "https".
 *
 * This function operates on the *raw* input before normalization, so the `git@`
 * prefix is still present and unambiguous.
 */
export function detectSourceProtocol(input: string): "https" | "ssh" {
  return /^git@/.test(input.trim()) ? "ssh" : "https";
}

/** Normalizes a user-supplied git source into `host/owner/repo` form. */
export function normalizeBundleSource(input: string): string {
  const value = input.trim();

  if (!value) {
    throw new Error("source is required");
  }

  if (/^https?:\/\//.test(value)) {
    const url = new URL(value);

    if (url.search || url.hash) {
      throw new Error(`Unsupported git source: ${input}`);
    }

    return normalizeSourceParts(
      url.hostname,
      url.pathname.replace(/^\//, "").replace(/\.git$/, ""),
    );
  }

  const sshMatch = value.match(/^git@([^:]+):(.+)$/);

  if (sshMatch) {
    return normalizeSourceParts(sshMatch[1], sshMatch[2].replace(/\.git$/, ""));
  }

  if (value.includes("://") || value.includes("?") || value.includes("#")) {
    throw new Error(`Unsupported git source: ${input}`);
  }

  const shorthandSource = normalizeGitHubShortcut(value);

  if (shorthandSource) {
    return shorthandSource;
  }

  const [host, owner, repo, ...rest] = value.split("/");

  if (!host || !owner || !repo || rest.length > 0) {
    throw new Error(`Unsupported git source: ${input}`);
  }

  return `${host}/${owner}/${repo}`;
}

function normalizeGitHubShortcut(input: string): string | undefined {
  const [owner, repo, ...rest] = input.split("/");

  if (!owner || !repo || rest.length > 0) {
    return undefined;
  }

  if (owner.includes(".") || owner.includes(":")) {
    return undefined;
  }

  const normalizedRepo = repo.replace(/\.git$/, "");

  if (!normalizedRepo) {
    return undefined;
  }

  return `github.com/${owner}/${normalizedRepo}`;
}

/** Lists every bundle currently discoverable in the local cache. */
export function listCachedBundles(options: {
  libraryDir: string;
}): CachedBundle[] {
  if (!fs.existsSync(options.libraryDir)) {
    return [];
  }

  const manifestFiles = findManifestFiles(options.libraryDir);

  const explicit = manifestFiles.flatMap((manifestFile) => {
    try {
      const manifest = parseBundleManifest(
        JSON.parse(fs.readFileSync(manifestFile, "utf8")) as unknown,
      );
      const relativeManifestFile = path.relative(
        options.libraryDir,
        manifestFile,
      );
      const segments = relativeManifestFile.split(path.sep);

      if (segments.at(-1) !== MANIFEST_FILE_NAME) {
        return [];
      }

      // Subdirectory bundle: host/owner/repo/bundle-name/manifest.json (5 segments)
      if (segments.length === 5) {
        const source = segments.slice(0, 3).join("/");
        const bundle = segments[3]!;
        const mergedManifest = mergeBundleManifests(
          inferBundleManifest(path.dirname(manifestFile)),
          manifest,
        );
        if (Object.keys(mergedManifest.tools).length === 0) {
          return [];
        }
        return [
          {
            source,
            bundle,
            manifestFile,
            manifest: mergedManifest,
          },
        ];
      }

      return [];
    } catch {
      return [];
    }
  });

  const explicitBundleKeys = new Set(
    explicit.map((bundle) => `${bundle.source}::${bundle.bundle}`),
  );

  const sourceDirs = findSourceDirs(options.libraryDir);
  const marketplace = sourceDirs.flatMap((sourceDir) =>
    inferClaudeMarketplaceBundles(sourceDir, explicitBundleKeys),
  );

  const declaredBundleKeys = new Set([
    ...explicitBundleKeys,
    ...marketplace.map((bundle) => `${bundle.source}::${bundle.bundle}`),
  ]);

  const inferredSubdirectory = sourceDirs.flatMap((sourceDir) =>
    inferSubdirectoryBundles(sourceDir, declaredBundleKeys),
  );

  // Repos with any valid or inferred bundle subdirectory are treated as multi-bundle
  // sources and excluded from repo-root inference.
  const sourceDirsWithSubdirectoryBundle = new Set(
    [...explicit, ...marketplace, ...inferredSubdirectory].map((bundle) =>
      path.join(options.libraryDir, ...bundle.source.split("/")),
    ),
  );

  // Inferred repo-as-bundle: repos without subdirectory bundle manifests but with
  // recognisable bundle directories (skills/, commands/, agents/, .claude/, etc.).
  // The bundle name defaults to the repository slug.
  const inferred = sourceDirs.flatMap((sourceDir) => {
    if (sourceDirsWithSubdirectoryBundle.has(sourceDir)) {
      return [];
    }

    try {
      const relativeSourceDir = path.relative(options.libraryDir, sourceDir);
      const sourceSegments = relativeSourceDir.split(path.sep);
      const bundleName = sourceSegments[2]!;
      const manifest = loadBundleManifestOrInfer(sourceDir);

      if (Object.keys(manifest.tools).length === 0) {
        return [];
      }

      return [
        {
          source: sourceSegments.join("/"),
          bundle: bundleName,
          manifestFile: path.join(sourceDir, MANIFEST_FILE_NAME),
          manifest,
        },
      ];
    } catch {
      return [];
    }
  });

  return [
    ...explicit,
    ...marketplace,
    ...inferredSubdirectory,
    ...inferred,
  ].sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.bundle.localeCompare(right.bundle),
  );
}

function inferClaudeMarketplaceBundles(
  sourceDir: string,
  excludedBundleKeys: Set<string>,
): CachedBundle[] {
  const marketplaceFile = path.join(sourceDir, CLAUDE_MARKETPLACE_FILE);
  const source = path.normalize(sourceDir).split(path.sep).slice(-3).join("/");
  const bundleKeys = new Set(excludedBundleKeys);
  let marketplace: unknown;

  try {
    marketplace = JSON.parse(fs.readFileSync(marketplaceFile, "utf8"));
  } catch {
    return [];
  }

  if (
    !marketplace ||
    typeof marketplace !== "object" ||
    Array.isArray(marketplace)
  ) {
    return [];
  }

  const plugins = (marketplace as Record<string, unknown>).plugins;
  if (!Array.isArray(plugins)) {
    return [];
  }

  return plugins.flatMap((plugin) => {
    if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) {
      return [];
    }

    const { name, source: pluginSource } = plugin as Record<string, unknown>;
    const bundle = typeof name === "string" ? name.trim() : "";
    if (
      !bundle ||
      bundle.includes("/") ||
      bundle === "." ||
      bundle === ".." ||
      typeof pluginSource !== "string"
    ) {
      return [];
    }

    const bundleKey = `${source}::${bundle}`;
    if (bundleKeys.has(bundleKey)) {
      return [];
    }

    const bundleDir = resolveLocalMarketplaceSource(sourceDir, pluginSource);
    if (!bundleDir) {
      return [];
    }

    let manifest: BundleManifest;
    try {
      manifest = loadBundleManifest(bundleDir);
    } catch {
      manifest = inferBundleManifest(bundleDir);
    }
    if (Object.keys(manifest.tools).length === 0) {
      return [];
    }
    bundleKeys.add(bundleKey);

    return [
      {
        source,
        bundle,
        manifestFile: path.join(bundleDir, MANIFEST_FILE_NAME),
        manifest,
      },
    ];
  });
}

function resolveLocalMarketplaceSource(
  sourceDir: string,
  pluginSource: string,
): string | undefined {
  const value = pluginSource.trim();
  if (!value || path.isAbsolute(value)) {
    return undefined;
  }

  const bundleDir = path.resolve(sourceDir, value);
  const relativeBundleDir = path.relative(sourceDir, bundleDir);
  if (
    relativeBundleDir === ".." ||
    relativeBundleDir.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeBundleDir)
  ) {
    return undefined;
  }

  try {
    if (!fs.lstatSync(bundleDir).isDirectory()) {
      return undefined;
    }

    const realSourceDir = fs.realpathSync(sourceDir);
    const realBundleDir = fs.realpathSync(bundleDir);
    const relativeRealBundleDir = path.relative(realSourceDir, realBundleDir);
    if (
      relativeRealBundleDir === ".." ||
      relativeRealBundleDir.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeRealBundleDir)
    ) {
      return undefined;
    }

    return bundleDir;
  } catch {
    return undefined;
  }
}

/** Resolves one cached bundle by source and bundle name, inferring repo bundles when needed. */
export function findCachedBundle(options: {
  libraryDir: string;
  bundle: string;
  source?: string;
}): CachedBundle {
  if (options.source) {
    const source = normalizeBundleSource(options.source);
    const layout = resolveCachedBundleLayout({
      libraryDir: options.libraryDir,
      source,
      bundle: options.bundle,
    });

    // Try subdirectory bundle first: libraryDir/host/owner/repo/bundle-name/manifest.json
    if (fs.existsSync(layout.manifestFile)) {
      return {
        source,
        bundle: options.bundle,
        manifestFile: layout.manifestFile,
        manifest: loadBundleManifest(layout.bundleDir),
      };
    }

    if (fs.existsSync(layout.bundleDir)) {
      const manifest = loadBundleManifest(layout.bundleDir);
      if (Object.keys(manifest.tools).length > 0) {
        return {
          source,
          bundle: options.bundle,
          manifestFile: layout.manifestFile,
          manifest,
        };
      }
    }

    const marketplaceBundle = inferClaudeMarketplaceBundles(
      layout.sourceDir,
      new Set(),
    ).find((bundle) => bundle.bundle === options.bundle);
    if (marketplaceBundle) {
      return marketplaceBundle;
    }

    // Fall back to inferred repo-as-bundle: repo slug must match the requested bundle name,
    // and the repo must not expose another named bundle.
    const repoBundleManifestFile = path.join(
      layout.sourceDir,
      MANIFEST_FILE_NAME,
    );
    const repoSlug = source.split("/").at(-1)!;
    if (repoSlug === options.bundle && fs.existsSync(layout.sourceDir)) {
      const hasNamedBundle = hasAnyNamedBundle(layout.sourceDir);

      if (!hasNamedBundle) {
        const manifest = loadBundleManifestOrInfer(layout.sourceDir);
        if (Object.keys(manifest.tools).length > 0) {
          return {
            source,
            bundle: repoSlug,
            manifestFile: repoBundleManifestFile,
            manifest,
          };
        }
      }
    }

    throw new Error(`Bundle not found: ${options.bundle}`);
  }

  const matches = listCachedBundles({ libraryDir: options.libraryDir }).filter(
    (bundle) => bundle.bundle === options.bundle,
  );

  if (matches.length === 0) {
    throw new Error(`Bundle not found: ${options.bundle}`);
  }

  if (matches.length > 1) {
    throw new Error(`Bundle name is ambiguous: ${options.bundle}`);
  }

  return matches[0];
}

function normalizeSourceParts(host: string, repoPath: string): string {
  const normalizedRepoPath = repoPath.replace(/^\/+|\/+$/g, "");
  const [owner, repo, ...rest] = normalizedRepoPath.split("/");

  if (!host || !owner || !repo || rest.length > 0) {
    throw new Error(`Unsupported git source: ${host}/${repoPath}`);
  }

  return `${host}/${owner}/${repo}`;
}

function findSourceDirs(libraryDir: string): string[] {
  const sourceDirs: string[] = [];

  for (const hostEntry of safeReaddirSync(libraryDir)) {
    if (!hostEntry.isDirectory()) continue;
    const hostDir = path.join(libraryDir, hostEntry.name);

    for (const ownerEntry of safeReaddirSync(hostDir)) {
      if (!ownerEntry.isDirectory()) continue;
      const ownerDir = path.join(hostDir, ownerEntry.name);

      for (const repoEntry of safeReaddirSync(ownerDir)) {
        if (!repoEntry.isDirectory()) continue;
        sourceDirs.push(path.join(ownerDir, repoEntry.name));
      }
    }
  }

  return sourceDirs;
}

function findManifestFiles(rootDir: string): string[] {
  const manifestFiles: string[] = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.shift()!;

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }

      if (entry.isFile() && entry.name === MANIFEST_FILE_NAME) {
        manifestFiles.push(entryPath);
      }
    }
  }

  return manifestFiles;
}

function inferSubdirectoryBundles(
  sourceDir: string,
  explicitBundleKeys: Set<string>,
): CachedBundle[] {
  const sourceSegments = path.normalize(sourceDir).split(path.sep).slice(-3);
  const source = sourceSegments.join("/");

  return safeReaddirSync(sourceDir).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      return [];
    }

    const bundleDir = path.join(sourceDir, entry.name);
    let manifest: BundleManifest;
    try {
      manifest = loadBundleManifest(bundleDir);
    } catch {
      manifest = inferBundleManifest(bundleDir);
    }

    if (Object.keys(manifest.tools).length === 0) {
      return [];
    }

    const bundleKey = `${source}::${entry.name}`;
    if (explicitBundleKeys.has(bundleKey)) {
      return [];
    }

    return [
      {
        source,
        bundle: entry.name,
        manifestFile: path.join(bundleDir, MANIFEST_FILE_NAME),
        manifest,
      },
    ];
  });
}

/** Loads a bundle's inferred filesystem manifest and overlays explicit metadata. */
function loadBundleManifest(bundleDir: string): BundleManifest {
  const inferred = inferBundleManifest(bundleDir);
  const manifestFile = path.join(bundleDir, MANIFEST_FILE_NAME);

  if (!fs.existsSync(manifestFile)) {
    return inferred;
  }

  const explicit = parseBundleManifest(
    JSON.parse(fs.readFileSync(manifestFile, "utf8")) as unknown,
  );
  return mergeBundleManifests(inferred, explicit);
}

/** Preserves discovery's fallback behavior when an optional root manifest is invalid. */
function loadBundleManifestOrInfer(bundleDir: string): BundleManifest {
  try {
    return loadBundleManifest(bundleDir);
  } catch {
    return inferBundleManifest(bundleDir);
  }
}

function hasAnyNamedBundle(sourceDir: string): boolean {
  return (
    hasValidSubdirectoryBundleManifest(sourceDir) ||
    inferClaudeMarketplaceBundles(sourceDir, new Set()).length > 0 ||
    inferSubdirectoryBundles(sourceDir, new Set()).length > 0
  );
}

function hasValidSubdirectoryBundleManifest(sourceDir: string): boolean {
  return safeReaddirSync(sourceDir).some((entry) => {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      return false;
    }

    const manifestFile = path.join(sourceDir, entry.name, MANIFEST_FILE_NAME);
    if (!fs.existsSync(manifestFile)) {
      return false;
    }

    try {
      const manifest = parseBundleManifest(
        JSON.parse(fs.readFileSync(manifestFile, "utf8")) as unknown,
      );
      return (
        Object.keys(
          mergeBundleManifests(
            inferBundleManifest(path.dirname(manifestFile)),
            manifest,
          ).tools,
        ).length > 0
      );
    } catch {
      return false;
    }
  });
}
