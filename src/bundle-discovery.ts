import fs from "node:fs";
import path from "node:path";

import { parseBundleManifest, resolveCachedBundleLayout, type BundleManifest } from "./bundle-manifest";

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

  return manifestFiles
    .flatMap((manifestFile) => {
      try {
        const manifest = parseBundleManifest(JSON.parse(fs.readFileSync(manifestFile, "utf8")) as unknown);
        const relativeManifestFile = path.relative(options.libraryDir, manifestFile);
        const segments = relativeManifestFile.split(path.sep);

        if (segments.length < 4 || segments.at(-1) !== MANIFEST_FILE_NAME) {
          return [];
        }

        const bundle = segments.at(-2)!;
        const source = segments.slice(0, -2).join("/");

        return [{ source, bundle, manifestFile, manifest }];
      } catch {
        return [];
      }
    })
    .sort((left, right) =>
      left.source.localeCompare(right.source) || left.bundle.localeCompare(right.bundle),
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

    if (!fs.existsSync(layout.manifestFile)) {
      throw new Error(`Bundle not found: ${options.bundle}`);
    }

    return {
      source,
      bundle: options.bundle,
      manifestFile: layout.manifestFile,
      manifest: parseBundleManifest(JSON.parse(fs.readFileSync(layout.manifestFile, "utf8")) as unknown),
    };
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
