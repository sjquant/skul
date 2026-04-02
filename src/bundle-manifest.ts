import path from "node:path";

import { getToolDefinition, listToolDefinitions, type ToolName, type ToolTargetName } from "./tool-mapping";

const MANIFEST_FILE_NAME = "manifest.json";

export interface BundleManifestTarget {
  path: string;
}

export interface BundleManifest {
  name: string;
  tools: Partial<Record<ToolName, Partial<Record<ToolTargetName, BundleManifestTarget>>>>;
}

export interface CachedBundleLayout {
  sourceSegments: string[];
  sourceDir: string;
  bundleDir: string;
  manifestFile: string;
  resolveBundlePath(...segments: string[]): string;
}

type UnknownRecord = Record<string, unknown>;

export function parseBundleManifest(input: unknown): BundleManifest {
  const manifest = expectRecord(input, "manifest");
  const toolsInput = expectRecord(manifest.tools, "tools");

  const tools = Object.fromEntries(
    Object.entries(toolsInput).map(([toolName, targetsInput]) => {
      const tool = parseToolName(toolName, `tools.${toolName}`);
      const supportedTool = getToolDefinition(tool)!;
      const toolTargetsInput = expectRecord(targetsInput, `tools.${toolName}`);

      if (Object.keys(toolTargetsInput).length === 0) {
        throw new Error(`tools.${toolName} must declare at least one target`);
      }

      const targets = Object.fromEntries(
        Object.entries(toolTargetsInput).map(([targetName, value]) => {
          if (!(targetName in supportedTool.targets)) {
            throw new Error(`tools.${toolName}.${targetName} is not supported for tool ${toolName}`);
          }

          return [targetName, parseBundleManifestTarget(value, `tools.${toolName}.${targetName}`)];
        }),
      ) as Partial<Record<ToolTargetName, BundleManifestTarget>>;

      return [tool, targets];
    }),
  ) as Partial<Record<ToolName, Partial<Record<ToolTargetName, BundleManifestTarget>>>>;

  if (Object.keys(tools).length === 0) {
    throw new Error("tools must declare at least one tool");
  }

  return {
    name: expectNonEmptyString(manifest.name, "name"),
    tools,
  };
}

export function resolveCachedBundleLayout(options: {
  libraryDir: string;
  source: string;
  bundle: string;
}): CachedBundleLayout {
  const libraryDir = expectNonEmptyString(options.libraryDir, "library directory");
  const source = expectNonEmptyString(options.source, "source");
  const bundle = expectSinglePathSegment(options.bundle, "bundle");
  const sourceSegments = source.split("/").map((segment) => expectSinglePathSegment(segment, "source"));
  const sourceDir = path.join(libraryDir, ...sourceSegments);
  const bundleDir = path.join(sourceDir, bundle);

  return {
    sourceSegments,
    sourceDir,
    bundleDir,
    manifestFile: path.join(bundleDir, MANIFEST_FILE_NAME),
    resolveBundlePath: (...segments: string[]) => path.join(bundleDir, ...segments),
  };
}

function parseBundleManifestTarget(input: unknown, label: string): BundleManifestTarget {
  const target = expectRecord(input, label);

  return {
    path: expectRelativePath(target.path, `${label}.path`),
  };
}

function parseToolName(input: unknown, label: string): ToolName {
  const value = expectNonEmptyString(input, label);
  const tools = listToolDefinitions();
  const supportedTool = tools.find((tool) => tool.name === value);

  if (supportedTool) {
    return supportedTool.name;
  }

  throw new Error(`${label} must be one of: ${tools.map((tool) => tool.name).join(", ")}`);
}

function expectRecord(input: unknown, label: string): UnknownRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }

  return input as UnknownRecord;
}

function expectNonEmptyString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error(`${label} is required`);
  }

  return input;
}

function expectSinglePathSegment(input: unknown, label: string): string {
  const value = expectNonEmptyString(input, label);

  if (value.includes("/") || value === "." || value === "..") {
    throw new Error(`${label} must be a single path segment`);
  }

  return value;
}

function expectRelativePath(input: unknown, label: string): string {
  const value = expectNonEmptyString(input, label);

  if (path.isAbsolute(value) || value === ".." || value.startsWith("../")) {
    throw new Error(`${label} must be a relative path`);
  }

  return value;
}
