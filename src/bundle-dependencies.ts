import path from "node:path";

import { type CachedBundle, normalizeBundleSource } from "./bundle-discovery";
import { locateExternalBundleItem } from "./bundle-item-refs";
import {
  type BundleItemSelector,
  listExternalBundleRequirements,
} from "./bundle-items";
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
  cachedBundle: CachedBundle;
}

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
}): Promise<Map<BundleKey, ResolvedDependency>> {
  const dependencies = new Map<BundleKey, ResolvedDependency>();
  const knownSources = new Set(
    Array.from(options.knownSources, (source) => normalizeBundleSource(source)),
  );
  const sourceRefs = new Map<string, { ref: string; requiredBy: BundleKey }>();

  for (const entry of options.entries) {
    if (entry.source !== undefined && entry.ref !== undefined) {
      sourceRefs.set(entry.source, {
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
      tools: entry.tools ?? bundleTools(cachedBundle),
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

      const sizeBefore =
        dependency.items.size +
        dependency.tools.size +
        dependency.requiredBy.size;
      dependency.items.add(requirement.item);
      dependency.requiredBy.add(requirer.key);
      for (const tool of requirer.tools) {
        dependency.tools.add(tool);
      }
      if (requirement.ref !== undefined) {
        dependency.ref = requirement.ref;
      }

      if (
        dependency.items.size +
          dependency.tools.size +
          dependency.requiredBy.size >
        sizeBefore
      ) {
        changed.add(key);
      }
    }

    // A dependency may need things in turn, so what changed is asked again.
    wave = Array.from(changed).map((key) => {
      const dependency = dependencies.get(key)!;
      const supported = bundleTools(dependency.cachedBundle);

      return {
        key,
        cachedBundle: dependency.cachedBundle,
        items: Array.from(dependency.items),
        tools: supported.filter((tool) => dependency.tools.has(tool)),
        protocol: dependency.protocol,
      };
    });
  }

  for (const key of dependencies.keys()) {
    const ref = sourceRefs.get(dependencies.get(key)!.source)?.ref;

    if (ref !== undefined) {
      dependencies.get(key)!.ref = ref;
    }
  }

  return dependencies;
}

function bundleTools(cachedBundle: CachedBundle): ToolName[] {
  return Object.keys(cachedBundle.manifest.tools) as ToolName[];
}
