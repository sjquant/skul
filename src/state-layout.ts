import path from "node:path";

const STATE_DIR_NAME = ".skul";
const REGISTRY_FILE_NAME = "registry.json";
const LIBRARY_DIR_NAME = "library";
const DATA_DIR_NAME = "data";

export interface GlobalStateLayout {
  rootDir: string;
  registryFile: string;
  libraryDir: string;
  resolveLibraryPath(...segments: string[]): string;
}

export interface ResolveGlobalStateLayoutOptions {
  homeDir: string;
}

/** Resolves the on-disk layout Skul uses for global state under one home directory. */
export function resolveGlobalStateLayout(
  options: ResolveGlobalStateLayoutOptions,
): GlobalStateLayout {
  const homeDir = options.homeDir.trim();

  if (!homeDir) {
    throw new Error(
      "A home directory is required to resolve the global state layout",
    );
  }

  const rootDir = path.join(homeDir, STATE_DIR_NAME);
  const libraryDir = path.join(rootDir, LIBRARY_DIR_NAME);

  return {
    rootDir,
    registryFile: path.join(rootDir, REGISTRY_FILE_NAME),
    libraryDir,
    resolveLibraryPath: (...segments: string[]) =>
      path.join(libraryDir, ...segments),
  };
}

/**
 * Maps a cached bundle directory to the persistent data directory Skul assigns
 * it, mirroring the bundle's `host/owner/repo/bundle` path under the data root.
 *
 * Skul resolves the path but never creates it: the directory belongs to the MCP
 * server process that the tool launches, not to materialization.
 */
export function resolveBundleDataDir(options: {
  libraryDir: string;
  bundleDir: string;
}): string {
  const bundleRelPath = path.relative(options.libraryDir, options.bundleDir);

  // A bundle outside the library would mirror to a path outside the data root,
  // which is worth failing on rather than silently pointing a server there.
  if (bundleRelPath === "" || bundleRelPath.split(path.sep)[0] === "..") {
    throw new Error(
      `Cannot resolve a data directory for a bundle outside the library: ${options.bundleDir}`,
    );
  }

  return path.join(
    path.dirname(options.libraryDir),
    DATA_DIR_NAME,
    bundleRelPath,
  );
}
