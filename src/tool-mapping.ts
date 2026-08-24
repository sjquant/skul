import path from "node:path";

export type ToolName =
  | "claude-code"
  | "cursor"
  | "opencode"
  | "codex"
  | "copilot"
  | "copilot-cli"
  | "kiro"
  | "antigravity";
export type ToolTargetName =
  | "skills"
  | "commands"
  | "agents"
  | "root_instruction"
  | "mcp";
export type ToolTargetEntryKind = "directory" | "file";

export interface ToolTargetDefinition {
  path: string;
  kind: ToolTargetEntryKind;
}

export interface ToolDefinition {
  name: ToolName;
  targets: Partial<Record<ToolTargetName, ToolTargetDefinition>>;
}

export interface ToolMaterializationLayout {
  remapRepoRelPath(toolName: string, repoRelPath: string): string;
  resolveToolTargetPath(
    toolName: string,
    targetName: ToolTargetName,
    rootDir: string,
  ): string | null;
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "claude-code",
    targets: {
      skills: { path: ".claude/skills", kind: "directory" },
      commands: { path: ".claude/commands", kind: "directory" },
      agents: { path: ".claude/agents", kind: "directory" },
      root_instruction: { path: "CLAUDE.md", kind: "file" },
      mcp: { path: ".mcp.json", kind: "file" },
    },
  },
  {
    name: "cursor",
    targets: {
      skills: { path: ".cursor/skills", kind: "directory" },
      commands: { path: ".cursor/commands", kind: "directory" },
      agents: { path: ".cursor/agents", kind: "directory" },
      root_instruction: { path: "AGENTS.md", kind: "file" },
      mcp: { path: ".cursor/mcp.json", kind: "file" },
    },
  },
  {
    name: "opencode",
    targets: {
      skills: { path: ".opencode/skills", kind: "directory" },
      commands: { path: ".opencode/commands", kind: "directory" },
      agents: { path: ".opencode/agents", kind: "directory" },
      root_instruction: { path: "AGENTS.md", kind: "file" },
      mcp: { path: "opencode.json", kind: "file" },
    },
  },
  {
    name: "codex",
    targets: {
      skills: { path: ".agents/skills", kind: "directory" },
      agents: { path: ".codex/agents", kind: "directory" },
      root_instruction: { path: "AGENTS.md", kind: "file" },
      mcp: { path: ".codex/config.toml", kind: "file" },
    },
  },
  {
    name: "copilot",
    targets: {
      skills: { path: ".github/skills", kind: "directory" },
      agents: { path: ".github/agents", kind: "directory" },
      root_instruction: { path: "AGENTS.md", kind: "file" },
      mcp: { path: ".vscode/mcp.json", kind: "file" },
    },
  },
  {
    // Copilot CLI reads the same repository files as Copilot in VS Code, so
    // only its MCP configuration sets it apart here: the CLI does not read
    // `.vscode/mcp.json`, and the file it does read speaks a different dialect.
    name: "copilot-cli",
    targets: {
      skills: { path: ".github/skills", kind: "directory" },
      agents: { path: ".github/agents", kind: "directory" },
      root_instruction: { path: "AGENTS.md", kind: "file" },
      mcp: { path: ".github/mcp.json", kind: "file" },
    },
  },
  {
    name: "kiro",
    targets: {
      skills: { path: ".kiro/skills", kind: "directory" },
      agents: { path: ".kiro/agents", kind: "directory" },
      root_instruction: { path: "AGENTS.md", kind: "file" },
      mcp: { path: ".kiro/settings/mcp.json", kind: "file" },
    },
  },
  {
    name: "antigravity",
    targets: {
      skills: { path: ".agents/skills", kind: "directory" },
      agents: { path: ".agents/agents", kind: "directory" },
      commands: { path: ".agent/workflows", kind: "directory" },
      root_instruction: { path: "AGENTS.md", kind: "file" },
      mcp: { path: ".agents/mcp_config.json", kind: "file" },
    },
  },
];

/**
 * Where each tool keeps its user-scope configuration, relative to the home directory.
 *
 * `mcp` is present for every tool that documents a user-scope MCP location under
 * the home directory. Copilot is the exception: the user configuration for the
 * surface Skul targets — VS Code, whose workspace file is `.vscode/mcp.json` —
 * is an `mcp.json` in the VS Code profile folder, whose path differs per
 * platform and per profile, so no home-relative path names it. VS Code also
 * documents `~/.copilot/mcp-config.json`, but that belongs to the Copilot CLI's
 * Agent Host, a different product with its own dialect, and writing a bundle's
 * servers there would silently install them into a tool the user did not ask
 * for. A bundle's servers for Copilot are reported as skipped instead.
 */
const GLOBAL_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "claude-code",
    targets: {
      skills: { path: ".claude/skills", kind: "directory" },
      commands: { path: ".claude/commands", kind: "directory" },
      agents: { path: ".claude/agents", kind: "directory" },
      root_instruction: { path: ".claude/CLAUDE.md", kind: "file" },
      mcp: { path: ".claude.json", kind: "file" },
    },
  },
  {
    name: "cursor",
    targets: {
      skills: { path: ".cursor/skills", kind: "directory" },
      commands: { path: ".cursor/commands", kind: "directory" },
      agents: { path: ".cursor/agents", kind: "directory" },
      root_instruction: { path: "AGENTS.md", kind: "file" },
      mcp: { path: ".cursor/mcp.json", kind: "file" },
    },
  },
  {
    name: "opencode",
    targets: {
      skills: { path: ".config/opencode/skills", kind: "directory" },
      commands: { path: ".config/opencode/commands", kind: "directory" },
      agents: { path: ".config/opencode/agents", kind: "directory" },
      root_instruction: { path: ".config/opencode/AGENTS.md", kind: "file" },
      mcp: { path: ".config/opencode/opencode.json", kind: "file" },
    },
  },
  {
    name: "codex",
    targets: {
      skills: { path: ".agents/skills", kind: "directory" },
      agents: { path: ".codex/agents", kind: "directory" },
      root_instruction: { path: ".codex/AGENTS.md", kind: "file" },
      mcp: { path: ".codex/config.toml", kind: "file" },
    },
  },
  {
    name: "copilot",
    targets: {
      skills: { path: ".github/skills", kind: "directory" },
      agents: { path: ".github/agents", kind: "directory" },
      root_instruction: {
        path: ".github/copilot-instructions.md",
        kind: "file",
      },
    },
  },
  {
    // Unlike Copilot in VS Code, the CLI keeps its user-scope configuration in
    // one documented home directory, so every target has a global location.
    name: "copilot-cli",
    targets: {
      skills: { path: ".copilot/skills", kind: "directory" },
      agents: { path: ".copilot/agents", kind: "directory" },
      root_instruction: {
        path: ".copilot/copilot-instructions.md",
        kind: "file",
      },
      mcp: { path: ".copilot/mcp-config.json", kind: "file" },
    },
  },
  {
    name: "kiro",
    targets: {
      skills: { path: ".kiro/skills", kind: "directory" },
      agents: { path: ".kiro/agents", kind: "directory" },
      root_instruction: { path: ".kiro/steering/AGENTS.md", kind: "file" },
      mcp: { path: ".kiro/settings/mcp.json", kind: "file" },
    },
  },
  {
    name: "antigravity",
    targets: {
      skills: { path: ".gemini/antigravity-cli/skills", kind: "directory" },
      agents: { path: ".gemini/config/agents", kind: "directory" },
      commands: { path: ".agent/workflows", kind: "directory" },
      root_instruction: { path: ".gemini/GEMINI.md", kind: "file" },
      mcp: { path: ".gemini/config/mcp_config.json", kind: "file" },
    },
  },
];

/** Returns a defensive copy of all supported tool definitions. */
export function listToolDefinitions(): ToolDefinition[] {
  return TOOL_DEFINITIONS.map(cloneToolDefinition);
}

/** Returns all tool definitions for global (~/) materialization. */
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

// Computed once at module load: maps each globally-capable tool name to its
// project→global target path pairs. Keyed by tool name (not project path) to
// avoid collisions when multiple tools share the same project path (e.g.
// copilot and antigravity both use AGENTS.md at project level).
const GLOBAL_REPO_REL_PATH_REMAP = (() => {
  const map = new Map<string, Array<{ from: string; to: string }>>();
  for (const projDef of TOOL_DEFINITIONS) {
    const globalDef = GLOBAL_TOOL_DEFINITIONS.find(
      (g) => g.name === projDef.name,
    );

    if (!globalDef) {
      continue;
    }

    for (const [targetName, projTarget] of Object.entries(projDef.targets)) {
      const globalPath = globalDef.targets[targetName as ToolTargetName]?.path;
      if (projTarget.path && globalPath && projTarget.path !== globalPath) {
        const entries = map.get(projDef.name) ?? [];
        entries.push({ from: projTarget.path, to: globalPath });
        map.set(projDef.name, entries);
      }
    }
  }
  return map;
})();

/** Returns the path remapper for global mode. Takes the tool name so that tools sharing
 * the same project path (e.g. AGENTS.md) can each remap to their own global path. */
export function buildGlobalRepoRelPathRemapper(): (
  toolName: string,
  p: string,
) => string {
  return (toolName, p) => {
    const entries = GLOBAL_REPO_REL_PATH_REMAP.get(toolName) ?? [];
    const entry = entries.find(
      (candidate) => p === candidate.from || p.startsWith(`${candidate.from}/`),
    );

    if (!entry) {
      return p;
    }

    return p === entry.from
      ? entry.to
      : `${entry.to}/${p.slice(entry.from.length + 1)}`;
  };
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

/** Resolves the absolute target root path for one global tool target under a home directory. */
export function resolveGlobalToolTargetPath(
  toolName: string,
  targetName: ToolTargetName,
  homeDir: string,
): string | null {
  const target = getGlobalToolDefinition(toolName)?.targets[targetName];

  return target ? path.join(homeDir, target.path) : null;
}

export const PROJECT_TOOL_MATERIALIZATION_LAYOUT: ToolMaterializationLayout = {
  remapRepoRelPath: (_toolName, repoRelPath) => repoRelPath,
  resolveToolTargetPath,
};

export const GLOBAL_TOOL_MATERIALIZATION_LAYOUT: ToolMaterializationLayout = {
  remapRepoRelPath: buildGlobalRepoRelPathRemapper(),
  resolveToolTargetPath: resolveGlobalToolTargetPath,
};

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
