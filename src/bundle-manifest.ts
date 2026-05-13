import fs from "node:fs";
import path from "node:path";

import {
  listToolDefinitions,
  type ToolDefinition,
  type ToolName,
  type ToolTargetName,
} from "./tool-mapping";

export const MANIFEST_FILE_NAME = "manifest.json";

export interface BundleManifestTarget {
  path: string;
}

export interface BundleManifest {
  name?: string;
  tools: Partial<
    Record<ToolName, Partial<Record<ToolTargetName, BundleManifestTarget>>>
  >;
}

export interface CachedBundleLayout {
  sourceSegments: string[];
  sourceDir: string;
  bundleDir: string;
  manifestFile: string;
  resolveBundlePath(...segments: string[]): string;
}

type UnknownRecord = Record<string, unknown>;

/** Parses and validates a manifest JSON object into the internal bundle schema. */
export function parseBundleManifest(input: unknown): BundleManifest {
  const manifest = expectRecord(input, "manifest");
  const toolsInput = expectRecord(manifest.tools, "tools");

  const tools = Object.fromEntries(
    Object.entries(toolsInput).map(([toolName, targetsInput]) => {
      const toolDef = parseToolDefinition(toolName, `tools.${toolName}`);
      const toolTargetsInput = expectRecord(targetsInput, `tools.${toolName}`);

      if (Object.keys(toolTargetsInput).length === 0) {
        throw new Error(`tools.${toolName} must declare at least one target`);
      }

      const targets = Object.fromEntries(
        Object.entries(toolTargetsInput).map(([targetName, value]) => {
          if (!(targetName in toolDef.targets)) {
            throw new Error(
              `tools.${toolDef.name}.${targetName} is not supported for tool ${toolDef.name}`,
            );
          }

          return [
            targetName,
            parseBundleManifestTarget(
              value,
              `tools.${toolDef.name}.${targetName}`,
            ),
          ];
        }),
      ) as Partial<Record<ToolTargetName, BundleManifestTarget>>;

      return [toolDef.name, targets];
    }),
  ) as Partial<
    Record<ToolName, Partial<Record<ToolTargetName, BundleManifestTarget>>>
  >;

  if (Object.keys(tools).length === 0) {
    throw new Error("tools must declare at least one tool");
  }

  return expandRootInstructionTargets({
    ...(typeof manifest.name === "string" && manifest.name.trim() !== ""
      ? { name: manifest.name }
      : {}),
    tools,
  });
}

/** Infers a bundle manifest from canonical directories and native tool paths on disk. */
export function inferBundleManifest(bundleDir: string): BundleManifest {
  const tools: Partial<
    Record<ToolName, Partial<Record<ToolTargetName, BundleManifestTarget>>>
  > = {};
  const allTools = listToolDefinitions();
  const canonicalTargetNames: ToolTargetName[] = [
    "skills",
    "commands",
    "agents",
  ];

  // Process canonical directories (skills/, commands/, agents/) — Claude Code canonical format.
  // These apply to all tools that support the given target.
  for (const targetName of canonicalTargetNames) {
    if (isExistingDirectory(path.join(bundleDir, targetName))) {
      for (const toolDef of allTools) {
        const targetDef = toolDef.targets[targetName];

        if (targetDef?.kind === "directory") {
          if (!tools[toolDef.name]) tools[toolDef.name] = {};
          tools[toolDef.name]![targetName] = { path: targetName };
        }
      }
    }
  }

  // Process native dotdirs (.claude/skills/, .cursor/commands/, etc.) — pre-authored native format.
  // Native paths override canonical paths for the same tool + target.
  for (const toolDef of allTools) {
    for (const [targetName, targetDef] of Object.entries(toolDef.targets)) {
      if (
        isExistingToolTarget(
          path.join(bundleDir, targetDef.path),
          targetDef.kind,
        )
      ) {
        if (!tools[toolDef.name]) tools[toolDef.name] = {};
        tools[toolDef.name]![targetName as ToolTargetName] = {
          path: targetDef.path,
        };
      }
    }
  }

  return expandRootInstructionTargets({ tools });
}

function isExistingDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function isExistingToolTarget(
  targetPath: string,
  kind: "directory" | "file",
): boolean {
  try {
    const stat = fs.statSync(targetPath);
    return kind === "directory" ? stat.isDirectory() : stat.isFile();
  } catch {
    return false;
  }
}

function expandRootInstructionTargets(
  manifest: BundleManifest,
): BundleManifest {
  const sourcePath = selectRootInstructionSourcePath(manifest.tools);

  if (!sourcePath) {
    return manifest;
  }

  const expandedTools = Object.fromEntries(
    Object.entries(manifest.tools).map(([toolName, targets]) => [
      toolName,
      { ...targets },
    ]),
  ) as BundleManifest["tools"];

  for (const toolDef of listToolDefinitions()) {
    if (!toolDef.targets.root_instruction) {
      continue;
    }

    if (!expandedTools[toolDef.name]) {
      expandedTools[toolDef.name] = {};
    }

    if (!expandedTools[toolDef.name]!.root_instruction) {
      expandedTools[toolDef.name]!.root_instruction = { path: sourcePath };
    }
  }

  return {
    ...(manifest.name !== undefined ? { name: manifest.name } : {}),
    tools: expandedTools,
  };
}

function selectRootInstructionSourcePath(
  tools: BundleManifest["tools"],
): string | null {
  const preferredToolOrder: ToolName[] = [
    "claude-code",
    "cursor",
    "opencode",
    "codex",
  ];

  for (const toolName of preferredToolOrder) {
    const sourcePath = tools[toolName]?.root_instruction?.path;

    if (sourcePath) {
      return sourcePath;
    }
  }

  return null;
}

/** Resolves the cache paths Skul uses for one source/bundle pair. */
export function resolveCachedBundleLayout(options: {
  libraryDir: string;
  source: string;
  bundle: string;
}): CachedBundleLayout {
  const libraryDir = expectNonEmptyString(
    options.libraryDir,
    "library directory",
  );
  const source = expectNonEmptyString(options.source, "source");
  const bundle = expectSinglePathSegment(options.bundle, "bundle");
  const sourceSegments = source
    .split("/")
    .map((segment) => expectSinglePathSegment(segment, "source"));
  const sourceDir = path.join(libraryDir, ...sourceSegments);
  const bundleDir = path.join(sourceDir, bundle);

  return {
    sourceSegments,
    sourceDir,
    bundleDir,
    manifestFile: path.join(bundleDir, MANIFEST_FILE_NAME),
    resolveBundlePath: (...segments: string[]) =>
      path.join(bundleDir, ...segments),
  };
}

function parseBundleManifestTarget(
  input: unknown,
  label: string,
): BundleManifestTarget {
  const target = expectRecord(input, label);

  return {
    path: expectRelativePath(target.path, `${label}.path`),
  };
}

function parseToolDefinition(input: unknown, label: string): ToolDefinition {
  const value = expectNonEmptyString(input, label);
  const tools = listToolDefinitions();
  const toolDef = tools.find((t) => t.name === value);

  if (toolDef) {
    return toolDef;
  }

  throw new Error(
    `${label} must be one of: ${tools.map((t) => t.name).join(", ")}`,
  );
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
  const normalized = path.normalize(value);

  if (
    path.isAbsolute(value) ||
    normalized === "." ||
    normalized.startsWith("..")
  ) {
    throw new Error(`${label} must be a relative path`);
  }

  return normalized;
}
