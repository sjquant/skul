import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildGlobalRepoRelPathRemapper,
  getGlobalToolDefinition,
  getToolDefinition,
  globalCapableToolNames,
  listToolDefinitions,
  resolveGlobalToolTargetPath,
  resolveToolTargetPath,
  type ToolTargetName,
} from "./tool-mapping";

describe("listToolDefinitions", () => {
  it("lists the supported tools in a stable order", () => {
    // Given / When / Then
    expect(listToolDefinitions().map((tool) => tool.name)).toEqual([
      "claude-code",
      "cursor",
      "opencode",
      "codex",
      "copilot",
      "kiro",
      "antigravity",
    ]);
  });
});

describe("getToolDefinition", () => {
  it.each([
    [
      "claude-code",
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
    ],
    [
      "cursor",
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
    ],
    [
      "opencode",
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
    ],
    [
      "codex",
      {
        name: "codex",
        targets: {
          skills: { path: ".agents/skills", kind: "directory" },
          agents: { path: ".codex/agents", kind: "directory" },
          root_instruction: { path: "AGENTS.md", kind: "file" },
        },
      },
    ],
    [
      "copilot",
      {
        name: "copilot",
        targets: {
          skills: { path: ".github/skills", kind: "directory" },
          agents: { path: ".github/agents", kind: "directory" },
          root_instruction: { path: "AGENTS.md", kind: "file" },
          mcp: { path: ".vscode/mcp.json", kind: "file" },
        },
      },
    ],
    [
      "kiro",
      {
        name: "kiro",
        targets: {
          skills: { path: ".kiro/skills", kind: "directory" },
          agents: { path: ".kiro/agents", kind: "directory" },
          root_instruction: { path: "AGENTS.md", kind: "file" },
          mcp: { path: ".kiro/settings/mcp.json", kind: "file" },
        },
      },
    ],
    [
      "antigravity",
      {
        name: "antigravity",
        targets: {
          skills: { path: ".agents/skills", kind: "directory" },
          agents: { path: ".agents/agents", kind: "directory" },
          commands: { path: ".agent/workflows", kind: "directory" },
          root_instruction: { path: "AGENTS.md", kind: "file" },
        },
      },
    ],
  ])("returns the exact target mapping for %s", (toolName, expectedDefinition) => {
    // Given / When / Then
    expect(getToolDefinition(toolName)).toEqual(expectedDefinition);
  });

  it("returns null for unsupported tools", () => {
    // Given / When / Then
    expect(getToolDefinition("unknown-tool")).toBeNull();
  });
});

describe("resolveToolTargetPath", () => {
  const cases: Array<[string, ToolTargetName, string]> = [
    ["claude-code", "skills", path.join("/repo", ".claude/skills")],
    ["claude-code", "commands", path.join("/repo", ".claude/commands")],
    ["claude-code", "agents", path.join("/repo", ".claude/agents")],
    ["cursor", "skills", path.join("/repo", ".cursor/skills")],
    ["cursor", "commands", path.join("/repo", ".cursor/commands")],
    ["cursor", "agents", path.join("/repo", ".cursor/agents")],
    ["cursor", "root_instruction", path.join("/repo", "AGENTS.md")],
    ["opencode", "skills", path.join("/repo", ".opencode/skills")],
    ["opencode", "commands", path.join("/repo", ".opencode/commands")],
    ["opencode", "agents", path.join("/repo", ".opencode/agents")],
    ["opencode", "root_instruction", path.join("/repo", "AGENTS.md")],
    ["codex", "skills", path.join("/repo", ".agents/skills")],
    ["codex", "agents", path.join("/repo", ".codex/agents")],
    ["claude-code", "root_instruction", path.join("/repo", "CLAUDE.md")],
    ["codex", "root_instruction", path.join("/repo", "AGENTS.md")],
    ["copilot", "skills", path.join("/repo", ".github/skills")],
    ["copilot", "agents", path.join("/repo", ".github/agents")],
    ["copilot", "root_instruction", path.join("/repo", "AGENTS.md")],
    ["kiro", "skills", path.join("/repo", ".kiro/skills")],
    ["kiro", "agents", path.join("/repo", ".kiro/agents")],
    ["kiro", "root_instruction", path.join("/repo", "AGENTS.md")],
    ["antigravity", "skills", path.join("/repo", ".agents/skills")],
    ["antigravity", "agents", path.join("/repo", ".agents/agents")],
    ["antigravity", "commands", path.join("/repo", ".agent/workflows")],
    ["antigravity", "root_instruction", path.join("/repo", "AGENTS.md")],
  ];

  it.each(
    cases,
  )("resolves %s %s beneath the repository root", (toolName, targetName, expectedPath) => {
    // Given / When / Then
    expect(resolveToolTargetPath(toolName, targetName, "/repo")).toBe(
      expectedPath,
    );
  });

  it.each([
    ["codex", "commands"],
    ["copilot", "commands"],
    ["kiro", "commands"],
  ] satisfies Array<
    [string, ToolTargetName]
  >)("returns null when %s does not define %s", (toolName, targetName) => {
    // Given / When / Then
    expect(resolveToolTargetPath(toolName, targetName, "/repo")).toBeNull();
  });

  it("returns null for unsupported tools", () => {
    // Given / When / Then
    expect(resolveToolTargetPath("unknown-tool", "skills", "/repo")).toBeNull();
  });
});

describe("globalCapableToolNames", () => {
  it("returns tools that support global installation", () => {
    // Given / When / Then
    expect(globalCapableToolNames()).toEqual([
      "claude-code",
      "cursor",
      "opencode",
      "codex",
      "copilot",
      "kiro",
      "antigravity",
    ]);
  });
});

describe("getGlobalToolDefinition", () => {
  it.each([
    [
      "claude-code",
      {
        name: "claude-code",
        targets: {
          skills: { path: ".claude/skills", kind: "directory" },
          commands: { path: ".claude/commands", kind: "directory" },
          agents: { path: ".claude/agents", kind: "directory" },
          root_instruction: { path: ".claude/CLAUDE.md", kind: "file" },
        },
      },
    ],
    [
      "cursor",
      {
        name: "cursor",
        targets: {
          skills: { path: ".cursor/skills", kind: "directory" },
          commands: { path: ".cursor/commands", kind: "directory" },
          agents: { path: ".cursor/agents", kind: "directory" },
          root_instruction: { path: "AGENTS.md", kind: "file" },
        },
      },
    ],
    [
      "opencode",
      {
        name: "opencode",
        targets: {
          skills: { path: ".config/opencode/skills", kind: "directory" },
          commands: { path: ".config/opencode/commands", kind: "directory" },
          agents: { path: ".config/opencode/agents", kind: "directory" },
          root_instruction: {
            path: ".config/opencode/AGENTS.md",
            kind: "file",
          },
        },
      },
    ],
    [
      "codex",
      {
        name: "codex",
        targets: {
          skills: { path: ".agents/skills", kind: "directory" },
          agents: { path: ".codex/agents", kind: "directory" },
          root_instruction: { path: ".codex/AGENTS.md", kind: "file" },
        },
      },
    ],
    [
      "copilot",
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
    ],
    [
      "kiro",
      {
        name: "kiro",
        targets: {
          skills: { path: ".kiro/skills", kind: "directory" },
          agents: { path: ".kiro/agents", kind: "directory" },
          root_instruction: { path: ".kiro/steering/AGENTS.md", kind: "file" },
        },
      },
    ],
    [
      "antigravity",
      {
        name: "antigravity",
        targets: {
          skills: {
            path: ".gemini/antigravity-cli/skills",
            kind: "directory",
          },
          agents: { path: ".gemini/config/agents", kind: "directory" },
          commands: { path: ".agent/workflows", kind: "directory" },
          root_instruction: { path: ".gemini/GEMINI.md", kind: "file" },
        },
      },
    ],
  ])("returns the global definition for %s", (toolName, expectedDefinition) => {
    // Given / When / Then
    expect(getGlobalToolDefinition(toolName)).toEqual(expectedDefinition);
  });

  it("returns null for tools without global support", () => {
    // Given / When / Then
    expect(getGlobalToolDefinition("unknown-tool")).toBeNull();
  });
});

describe("resolveGlobalToolTargetPath", () => {
  it.each([
    ["cursor", "commands", path.join("/home", ".cursor/commands")],
    ["opencode", "skills", path.join("/home", ".config/opencode/skills")],
    ["codex", "root_instruction", path.join("/home", ".codex/AGENTS.md")],
    ["kiro", "agents", path.join("/home", ".kiro/agents")],
    [
      "antigravity",
      "skills",
      path.join("/home", ".gemini/antigravity-cli/skills"),
    ],
    ["antigravity", "agents", path.join("/home", ".gemini/config/agents")],
  ] satisfies Array<
    [string, ToolTargetName, string]
  >)("resolves global %s %s beneath the home directory", (toolName, targetName, expectedPath) => {
    // Given / When / Then
    expect(resolveGlobalToolTargetPath(toolName, targetName, "/home")).toBe(
      expectedPath,
    );
  });

  it("returns null when the global tool does not define the target", () => {
    // Given / When / Then
    expect(
      resolveGlobalToolTargetPath("codex", "commands", "/home"),
    ).toBeNull();
  });
});

describe("buildGlobalRepoRelPathRemapper", () => {
  it("remaps claude-code root instruction from CLAUDE.md to .claude/CLAUDE.md", () => {
    const remap = buildGlobalRepoRelPathRemapper();
    expect(remap("claude-code", "CLAUDE.md")).toBe(".claude/CLAUDE.md");
  });

  it("remaps copilot root instruction from AGENTS.md to .github/copilot-instructions.md", () => {
    const remap = buildGlobalRepoRelPathRemapper();
    expect(remap("copilot", "AGENTS.md")).toBe(
      ".github/copilot-instructions.md",
    );
  });

  it("remaps antigravity root instruction from AGENTS.md to .gemini/GEMINI.md", () => {
    const remap = buildGlobalRepoRelPathRemapper();
    expect(remap("antigravity", "AGENTS.md")).toBe(".gemini/GEMINI.md");
  });

  it("remaps antigravity project skill and agent paths to CLI global paths", () => {
    const remap = buildGlobalRepoRelPathRemapper();

    expect(remap("antigravity", ".agents/skills/reviewer/SKILL.md")).toBe(
      ".gemini/antigravity-cli/skills/reviewer/SKILL.md",
    );
    expect(remap("antigravity", ".agents/agents/reviewer/agent.md")).toBe(
      ".gemini/config/agents/reviewer/agent.md",
    );
  });

  it("remaps opencode canonical paths to the global config directory", () => {
    const remap = buildGlobalRepoRelPathRemapper();
    expect(remap("opencode", ".opencode/skills/review/SKILL.md")).toBe(
      ".config/opencode/skills/review/SKILL.md",
    );
    expect(remap("opencode", "AGENTS.md")).toBe(".config/opencode/AGENTS.md");
  });

  it("remaps codex and kiro root instructions to their global locations", () => {
    const remap = buildGlobalRepoRelPathRemapper();
    expect(remap("codex", "AGENTS.md")).toBe(".codex/AGENTS.md");
    expect(remap("kiro", "AGENTS.md")).toBe(".kiro/steering/AGENTS.md");
  });

  it("does not cross-contaminate: copilot and antigravity remap to different global paths", () => {
    const remap = buildGlobalRepoRelPathRemapper();
    expect(remap("copilot", "AGENTS.md")).not.toBe(
      remap("antigravity", "AGENTS.md"),
    );
  });

  it("returns the path unchanged for tools with matching global paths", () => {
    const remap = buildGlobalRepoRelPathRemapper();
    expect(remap("cursor", "AGENTS.md")).toBe("AGENTS.md");
    expect(remap("codex", ".agents/skills/review/SKILL.md")).toBe(
      ".agents/skills/review/SKILL.md",
    );
  });

  it("returns the path unchanged for non-root-instruction paths", () => {
    const remap = buildGlobalRepoRelPathRemapper();
    expect(remap("claude-code", ".claude/skills/foo/SKILL.md")).toBe(
      ".claude/skills/foo/SKILL.md",
    );
  });
});
