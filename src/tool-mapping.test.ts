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
  ])("returns the exact target mapping for %s", (toolName, expectedDefinition) => {
    // Given / When / Then
    expect(getToolDefinition(toolName)).toEqual(expectedDefinition);
  });

  it("returns null for unsupported tools", () => {
    // Given / When / Then
    expect(getToolDefinition("copilot")).toBeNull();
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
    ["opencode", "skills", path.join("/repo", ".opencode/skills")],
    ["opencode", "commands", path.join("/repo", ".opencode/commands")],
    ["opencode", "agents", path.join("/repo", ".opencode/agents")],
    ["codex", "skills", path.join("/repo", ".agents/skills")],
    ["codex", "agents", path.join("/repo", ".codex/agents")],
    ["claude-code", "root_instruction", path.join("/repo", "CLAUDE.md")],
    ["codex", "root_instruction", path.join("/repo", "AGENTS.md")],
  ];

  it.each(cases)("resolves %s %s beneath the repository root", (toolName, targetName, expectedPath) => {
    // Given / When / Then
    expect(resolveToolTargetPath(toolName, targetName, "/repo")).toBe(expectedPath);
  });

  it.each([
    ["codex", "commands"],
    ["cursor", "root_instruction"],
    ["opencode", "root_instruction"],
  ] satisfies Array<[string, ToolTargetName]>)(
    "returns null when %s does not define %s",
    (toolName, targetName) => {
      // Given / When / Then
      expect(resolveToolTargetPath(toolName, targetName, "/repo")).toBeNull();
    },
  );

  it("returns null for unsupported tools", () => {
    // Given / When / Then
    expect(resolveToolTargetPath("copilot", "skills", "/repo")).toBeNull();
  });
});
