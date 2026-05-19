import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  getToolDefinition,
  listToolDefinitions,
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
          root_instruction: { path: "CLAUDE.md", kind: "file" },
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
          root_instruction: { path: "CLAUDE.md", kind: "file" },
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
    ["cursor", "root_instruction", path.join("/repo", "CLAUDE.md")],
    ["opencode", "skills", path.join("/repo", ".opencode/skills")],
    ["opencode", "commands", path.join("/repo", ".opencode/commands")],
    ["opencode", "agents", path.join("/repo", ".opencode/agents")],
    ["opencode", "root_instruction", path.join("/repo", "CLAUDE.md")],
    ["codex", "skills", path.join("/repo", ".agents/skills")],
    ["codex", "agents", path.join("/repo", ".codex/agents")],
    ["claude-code", "root_instruction", path.join("/repo", "CLAUDE.md")],
    ["codex", "root_instruction", path.join("/repo", "AGENTS.md")],
    ["copilot", "skills", path.join("/repo", ".github/skills")],
    ["copilot", "agents", path.join("/repo", ".github/agents")],
    [
      "copilot",
      "root_instruction",
      path.join("/repo", ".github/copilot-instructions.md"),
    ],
    ["kiro", "skills", path.join("/repo", ".kiro/skills")],
    ["kiro", "agents", path.join("/repo", ".kiro/agents")],
    ["kiro", "root_instruction", path.join("/repo", "AGENTS.md")],
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
