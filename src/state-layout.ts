import path from "node:path";

const STATE_DIR_NAME = ".skul";
const REGISTRY_FILE_NAME = "registry.json";
const LIBRARY_DIR_NAME = "library";

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
