import path from "node:path";

const STATE_DIR_NAME = ".skul";
const REGISTRY_FILE_NAME = "registry.json";
const LIBRARY_DIR_NAME = "library";
const CONFIG_FILE_NAME = "config.json";

export interface GlobalStateLayout {
  rootDir: string;
  registryFile: string;
  libraryDir: string;
  configFile: string;
  resolveLibraryPath(...segments: string[]): string;
}

export interface ResolveGlobalStateLayoutOptions {
  homeDir: string;
}

export function resolveGlobalStateLayout(
  options: ResolveGlobalStateLayoutOptions,
): GlobalStateLayout {
  const homeDir = options.homeDir.trim();

  if (!homeDir) {
    throw new Error("A home directory is required to resolve the global state layout");
  }

  const rootDir = path.join(homeDir, STATE_DIR_NAME);
  const libraryDir = path.join(rootDir, LIBRARY_DIR_NAME);

  return {
    rootDir,
    registryFile: path.join(rootDir, REGISTRY_FILE_NAME),
    libraryDir,
    configFile: path.join(rootDir, CONFIG_FILE_NAME),
    resolveLibraryPath: (...segments: string[]) => path.join(libraryDir, ...segments),
  };
}
