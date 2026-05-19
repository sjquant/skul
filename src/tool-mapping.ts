import path from "node:path";

export type ToolName = "claude-code" | "cursor" | "opencode" | "codex" | "copilot" | "kiro";
export type ToolTargetName =
  | "skills"
  | "commands"
  | "agents"
  | "root_instruction";
export type ToolTargetEntryKind = "directory" | "file";

export interface ToolTargetDefinition {
  path: string;
  kind: ToolTargetEntryKind;
}

export interface ToolDefinition {
  name: ToolName;
  targets: Partial<Record<ToolTargetName, ToolTargetDefinition>>;
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "claude-code",
    targets: {
      skills: { path: ".claude/skills", kind: "directory" },
      commands: { path: ".claude/commands", kind: "directory" },
      agents: { path: ".claude/agents", kind: "directory" },
      root_instruction: { path: "CLAUDE.md", kind: "file" },
    },
  },
  {
    name: "cursor",
    targets: {
      skills: { path: ".cursor/skills", kind: "directory" },
      commands: { path: ".cursor/commands", kind: "directory" },
      agents: { path: ".cursor/agents", kind: "directory" },
      root_instruction: { path: "CLAUDE.md", kind: "file" },
    },
  },
  {
    name: "opencode",
    targets: {
      skills: { path: ".opencode/skills", kind: "directory" },
      commands: { path: ".opencode/commands", kind: "directory" },
      agents: { path: ".opencode/agents", kind: "directory" },
      root_instruction: { path: "CLAUDE.md", kind: "file" },
    },
  },
  {
    name: "codex",
    targets: {
      skills: { path: ".agents/skills", kind: "directory" },
      agents: { path: ".codex/agents", kind: "directory" },
      root_instruction: { path: "AGENTS.md", kind: "file" },
    },
  },
  {
    name: "copilot",
    targets: {
      skills: { path: ".github/skills", kind: "directory" },
      agents: { path: ".github/agents", kind: "directory" },
      root_instruction: { path: ".github/copilot-instructions.md", kind: "file" },
    },
  },
  {
    name: "kiro",
    targets: {
      skills: { path: ".kiro/skills", kind: "directory" },
      agents: { path: ".kiro/agents", kind: "directory" },
      root_instruction: { path: "AGENTS.md", kind: "file" },
    },
  },
];

// Skills/commands/agents paths are identical between project and global mode for claude-code
// (both use .claude/skills etc.), so buildGlobalRepoRelPathRemapper only needs to remap
// root_instruction paths. If a future tool definition changes this, update the remapper.
const GLOBAL_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "claude-code",
    targets: {
      skills: { path: ".claude/skills", kind: "directory" },
      commands: { path: ".claude/commands", kind: "directory" },
      agents: { path: ".claude/agents", kind: "directory" },
      root_instruction: { path: ".claude/CLAUDE.md", kind: "file" },
    },
  },
];

/** Returns a defensive copy of all supported tool definitions. */
export function listToolDefinitions(): ToolDefinition[] {
  return TOOL_DEFINITIONS.map(cloneToolDefinition);
}

/** Returns all tool definitions for global (~/) materialization. Only claude-code supported. */
export function listGlobalToolDefinitions(): ToolDefinition[] {
  return GLOBAL_TOOL_DEFINITIONS.map(cloneToolDefinition);
}

/** Returns the global tool definition for one tool, or null if not supported globally.
 * Exported for use by external consumers inspecting global installation layout. */
export function getGlobalToolDefinition(name: string): ToolDefinition | null {
  const tool = GLOBAL_TOOL_DEFINITIONS.find((t) => t.name === name);
  return tool ? cloneToolDefinition(tool) : null;
}

/** Returns the names of tools that support global installation. */
export function globalCapableToolNames(): ToolName[] {
  return GLOBAL_TOOL_DEFINITIONS.map((t) => t.name);
}

/** Builds a path remapper for global mode: maps project-mode root-instruction paths to their
 * global equivalents (e.g. "CLAUDE.md" → ".claude/CLAUDE.md"). */
export function buildGlobalRepoRelPathRemapper(): (p: string) => string {
  const map = new Map<string, string>();
  for (const projDef of listToolDefinitions()) {
    const globalDef = getGlobalToolDefinition(projDef.name);
    const projPath = projDef.targets.root_instruction?.path;
    const globalPath = globalDef?.targets.root_instruction?.path;
    if (projPath && globalPath && projPath !== globalPath) {
      map.set(projPath, globalPath);
    }
  }
  return (p) => map.get(p) ?? p;
}

/** Looks up one tool definition by name and returns a defensive copy when found. */
export function getToolDefinition(name: string): ToolDefinition | null {
  const tool = TOOL_DEFINITIONS.find((definition) => definition.name === name);

  return tool ? cloneToolDefinition(tool) : null;
}

/** Resolves the absolute target root path for one tool target inside a repository. */
export function resolveToolTargetPath(
  toolName: string,
  targetName: ToolTargetName,
  repoRoot: string,
): string | null {
  const target = getToolDefinition(toolName)?.targets[targetName];

  return target ? path.join(repoRoot, target.path) : null;
}

function cloneToolDefinition(definition: ToolDefinition): ToolDefinition {
  return {
    name: definition.name,
    targets: Object.fromEntries(
      Object.entries(definition.targets).map(([targetName, target]) => [
        targetName,
        { ...target },
      ]),
    ),
  };
}
