import path from "node:path";

export type ToolName = "claude-code" | "cursor" | "opencode" | "codex";
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
];

/** Returns a defensive copy of all supported tool definitions. */
export function listToolDefinitions(): ToolDefinition[] {
  return TOOL_DEFINITIONS.map(cloneToolDefinition);
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
