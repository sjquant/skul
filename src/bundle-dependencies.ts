import path from "node:path";

import { type CachedBundle, normalizeBundleSource } from "./bundle-discovery";
import { readCachedSourceRevision } from "./bundle-fetch";
import { locateExternalBundleItem } from "./bundle-item-refs";
import {
  type BundleItemSelector,
  listExternalBundleRequirements,
} from "./bundle-items";
import { listBundleToolNames } from "./bundle-manifest";
import { type BundleKey, bundleKey, type DesiredBundleEntry } from "./registry";
import type { SourceFetchProgress } from "./source-fetch-progress";
import type { ToolName } from "./tool-mapping";

/** An item of another source that installed bundles need, with everything that asks for it. */
export interface ResolvedDependency {
  bundle: string;
  source: string;
  protocol: "https" | "ssh";
  items: Set<BundleItemSelector>;
  requiredBy: Set<BundleKey>;
  /** Tools the requiring bundles install for; the dependency installs for the ones it supports. */
  tools: Set<ToolName>;
  ref?: string;
  /** Where the source's checkout stood when the dependency was located. */
  resolvedRef?: string;
  resolvedCommit?: string;
  cachedBundle: CachedBundle;
}

/** Everything required of other sources, by the registry key of the bundle that ships it. */
export type ResolvedDependencies = Map<BundleKey, ResolvedDependency>;

interface Requirer {
  key: BundleKey;
  cachedBundle: CachedBundle;
  items: BundleItemSelector[] | undefined;
  tools: ToolName[];
  protocol: "https" | "ssh";
}

/**
 * Finds every item of another source that the given bundles, and the bundles
 * those pull in, require.
 *
 * Two bundles asking for the same item resolve to one dependency, so it is
 * installed once. Sources no installed bundle came from are confirmed before
 * they are fetched, since a dependency is code the user never named.
 */
export async function resolveBundleDependencies(options: {
  /** The bundles the user installed, without dependency bookkeeping. */
  entries: DesiredBundleEntry[];
  /** Sources already installed from, which need no confirmation. */
  knownSources: Iterable<string>;
  resolveCachedBundle: (entry: DesiredBundleEntry) => CachedBundle;
  libraryDir: string;
  confirmNewSources: (sources: string[]) => Promise<void>;
  sourceFetchProgress?: SourceFetchProgress;
}): Promise<ResolvedDependencies> {
  const dependencies: ResolvedDependencies = new Map();
  const knownSources = new Set(
    Array.from(options.knownSources, (source) => normalizeBundleSource(source)),
  );
  const sourceRefs = new Map<string, { ref: string; requiredBy: BundleKey }>();

  for (const entry of options.entries) {
    if (entry.source !== undefined && entry.ref !== undefined) {
      sourceRefs.set(normalizeBundleSource(entry.source), {
        ref: entry.ref,
        requiredBy: bundleKey(entry),
      });
    }
  }

  let wave: Requirer[] = options.entries.map((entry) => {
    const cachedBundle = options.resolveCachedBundle(entry);

    return {
      key: bundleKey(entry),
      cachedBundle,
      items: entry.items,
      tools: entry.tools ?? listBundleToolNames(cachedBundle.manifest),
      protocol: entry.protocol,
    };
  });

  while (wave.length > 0) {
    const asks = wave.flatMap((requirer) =>
      listExternalBundleRequirements({
        bundleDir: path.dirname(requirer.cachedBundle.manifestFile),
        manifest: requirer.cachedBundle.manifest,
        itemSelectors: requirer.items,
      }).map((requirement) => ({ requirer, requirement })),
    );

    const newSources = Array.from(
      new Set(
        asks
          .map(({ requirement }) => normalizeBundleSource(requirement.source))
          .filter((source) => !knownSources.has(source)),
      ),
    );

    if (newSources.length > 0) {
      await options.confirmNewSources(newSources);
    }

    const changed = new Set<BundleKey>();

    // Every ref is checked before any source is fetched, so a conflict is
    // reported rather than hidden behind a fetch of whichever ref came first.
    for (const { requirer, requirement } of asks) {
      const normalizedSource = normalizeBundleSource(requirement.source);
      knownSources.add(normalizedSource);

      if (requirement.ref !== undefined) {
        const claimed = sourceRefs.get(normalizedSource);

        if (claimed !== undefined && claimed.ref !== requirement.ref) {
          throw new Error(
            `Cannot install ${normalizedSource}: ${claimed.requiredBy} needs ref ${claimed.ref} but ${requirer.key} needs ref ${requirement.ref}`,
          );
        }

        sourceRefs.set(normalizedSource, {
          ref: requirement.ref,
          requiredBy: requirer.key,
        });
      }
    }

    for (const { requirer, requirement } of asks) {
      const { source, cachedBundle } = await locateExternalBundleItem({
        source: requirement.source,
        bundle: requirement.bundle,
        item: requirement.item,
        ref: requirement.ref,
        libraryDir: options.libraryDir,
        protocol: requirer.protocol,
        origin: `required by ${requirer.key}`,
        sourceFetchProgress: options.sourceFetchProgress,
      });
      const key = bundleKey({ bundle: cachedBundle.bundle, source });

      const dependency = dependencies.get(key) ?? {
        bundle: cachedBundle.bundle,
        source,
        protocol: requirer.protocol,
        items: new Set<BundleItemSelector>(),
        requiredBy: new Set<BundleKey>(),
        tools: new Set<ToolName>(),
        cachedBundle,
      };
      dependencies.set(key, dependency);

      const revision = readCachedSourceRevision({
        source,
        libraryDir: options.libraryDir,
        protocol: requirer.protocol,
      });
      dependency.resolvedRef = revision.currentRef;
      dependency.resolvedCommit = revision.currentCommit;

      const grew = [
        addAll(dependency.items, [requirement.item]),
        addAll(dependency.requiredBy, [requirer.key]),
        addAll(dependency.tools, requirer.tools),
      ].some(Boolean);

      if (grew) {
        changed.add(key);
      }
    }

    // A dependency may need things in turn, so what changed is asked again.
    wave = Array.from(changed).map((key) => {
      const dependency = dependencies.get(key)!;
      const supported = listBundleToolNames(dependency.cachedBundle.manifest);

      return {
        key,
        cachedBundle: dependency.cachedBundle,
        items: Array.from(dependency.items),
        tools: supported.filter((tool) => dependency.tools.has(tool)),
        protocol: dependency.protocol,
      };
    });
  }

  // A source is installed at one ref, whichever requirement or installed
  // bundle named it, so the ref is read from the claims rather than per request.
  for (const dependency of dependencies.values()) {
    dependency.ref = sourceRefs.get(dependency.source)?.ref;
  }

  return dependencies;
}

/** Adds the values to the set, reporting whether any of them was new. */
function addAll<T>(set: Set<T>, values: Iterable<T>): boolean {
  const sizeBefore = set.size;

  for (const value of values) {
    set.add(value);
  }

  return set.size > sizeBefore;
}
