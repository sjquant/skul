import fs from "node:fs";
import path from "node:path";

import {
  inferBundleManifest,
  parseBundleManifest,
  resolveCachedBundleLayout,
  type BundleManifest,
} from "./bundle-manifest";

const MANIFEST_FILE_NAME = "manifest.json";

export interface CachedBundle {
  source: string;
  bundle: string;
  manifestFile: string;
  manifest: BundleManifest;
}

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

    return normalizeSourceParts(url.hostname, url.pathname.replace(/^\//, "").replace(/\.git$/, ""));
  }

  const sshMatch = value.match(/^git@([^:]+):(.+)$/);

  if (sshMatch) {
    return normalizeSourceParts(sshMatch[1], sshMatch[2].replace(/\.git$/, ""));
  }

  if (value.includes("://") || value.includes("?") || value.includes("#")) {
    throw new Error(`Unsupported git source: ${input}`);
  }

  const [host, owner, repo, ...rest] = value.split("/");

  if (!host || !owner || !repo || rest.length > 0) {
    throw new Error(`Unsupported git source: ${input}`);
  }

  return `${host}/${owner}/${repo}`;
}

export function listCachedBundles(options: { libraryDir: string }): CachedBundle[] {
  if (!fs.existsSync(options.libraryDir)) {
    return [];
  }

  const manifestFiles = findManifestFiles(options.libraryDir);

  // Repos with any bundle subdirectory manifest are treated as multi-bundle
  // sources and excluded from repo-root inference.
  const sourceDirsWithSubdirectoryManifest = new Set<string>();

  for (const manifestFile of manifestFiles) {
    const relativeManifestFile = path.relative(options.libraryDir, manifestFile);
    const segments = relativeManifestFile.split(path.sep);

    if (segments.length === 5 && segments.at(-1) === MANIFEST_FILE_NAME) {
      sourceDirsWithSubdirectoryManifest.add(path.join(options.libraryDir, ...segments.slice(0, 3)));
    }
  }

  const explicit = manifestFiles.flatMap((manifestFile) => {
    try {
      const manifest = parseBundleManifest(JSON.parse(fs.readFileSync(manifestFile, "utf8")) as unknown);
      const relativeManifestFile = path.relative(options.libraryDir, manifestFile);
      const segments = relativeManifestFile.split(path.sep);

      if (segments.at(-1) !== MANIFEST_FILE_NAME) {
        return [];
      }

      // Subdirectory bundle: host/owner/repo/bundle-name/manifest.json (5 segments)
      if (segments.length === 5) {
        const source = segments.slice(0, 3).join("/");
        const bundle = segments[3]!;
        return [{ source, bundle, manifestFile, manifest }];
      }

      return [];
    } catch {
      return [];
    }
  });

  // Inferred repo-as-bundle: repos without subdirectory bundle manifests but with
  // recognisable bundle directories (skills/, commands/, agents/, .claude/, etc.).
  // The bundle name defaults to the repository slug.
  const inferred = findSourceDirs(options.libraryDir).flatMap((sourceDir) => {
    if (sourceDirsWithSubdirectoryManifest.has(sourceDir)) {
      return [];
    }

    try {
      const relativeSourceDir = path.relative(options.libraryDir, sourceDir);
      const sourceSegments = relativeSourceDir.split(path.sep);
      const bundleName = sourceSegments[2]!;
      const manifest = inferBundleManifest(sourceDir);

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

  return [...explicit, ...inferred].sort(
    (left, right) => left.source.localeCompare(right.source) || left.bundle.localeCompare(right.bundle),
  );
}

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
        manifest: parseBundleManifest(JSON.parse(fs.readFileSync(layout.manifestFile, "utf8")) as unknown),
      };
    }

    // Fall back to inferred repo-as-bundle: repo slug must match the requested bundle name,
    // and the repo must not expose subdirectory bundle manifests.
    const repoBundleManifestFile = path.join(layout.sourceDir, MANIFEST_FILE_NAME);
    const repoSlug = source.split("/").at(-1)!;
    if (repoSlug === options.bundle && fs.existsSync(layout.sourceDir)) {
      const hasSubdirectoryManifest = safeReaddirSync(layout.sourceDir).some(
        (entry) =>
          entry.isDirectory() &&
          fs.existsSync(path.join(layout.sourceDir, entry.name, MANIFEST_FILE_NAME)),
      );

      if (!hasSubdirectoryManifest) {
        const manifest = inferBundleManifest(layout.sourceDir);
        if (Object.keys(manifest.tools).length > 0) {
          return { source, bundle: repoSlug, manifestFile: repoBundleManifestFile, manifest };
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

function safeReaddirSync(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
