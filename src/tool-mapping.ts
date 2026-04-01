import path from "node:path";

export type ToolName = "claude-code" | "cursor" | "opencode" | "codex";
export type ToolTargetName = "skills" | "commands" | "agents";

export interface ToolTargetDefinition {
  path: string;
}

export interface ToolDefinition {
  name: ToolName;
  targets: Partial<Record<ToolTargetName, ToolTargetDefinition>>;
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "claude-code",
    targets: {
      skills: { path: ".claude/skills" },
      commands: { path: ".claude/commands" },
      agents: { path: ".claude/agents" },
    },
  },
  {
    name: "cursor",
    targets: {
      skills: { path: ".cursor/skills" },
      commands: { path: ".cursor/commands" },
    },
  },
  {
    name: "opencode",
    targets: {
      skills: { path: ".opencode/skills" },
      commands: { path: ".opencode/commands" },
      agents: { path: ".opencode/agents" },
    },
  },
  {
    name: "codex",
    targets: {
      skills: { path: ".agents/skills" },
      agents: { path: ".codex/agents" },
    },
  },
];

export function listToolDefinitions(): ToolDefinition[] {
  return TOOL_DEFINITIONS.map(cloneToolDefinition);
}

export function getToolDefinition(name: string): ToolDefinition | null {
  const tool = TOOL_DEFINITIONS.find((definition) => definition.name === name);

  return tool ? cloneToolDefinition(tool) : null;
}

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
