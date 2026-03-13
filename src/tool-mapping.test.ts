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
          skills: { path: ".claude/skills" },
          commands: { path: ".claude/commands" },
          agents: { path: ".claude/agents" },
        },
      },
    ],
    [
      "cursor",
      {
        name: "cursor",
        targets: {
          skills: { path: ".cursor/skills" },
          commands: { path: ".cursor/commands" },
        },
      },
    ],
    [
      "opencode",
      {
        name: "opencode",
        targets: {
          skills: { path: ".opencode/skills" },
          commands: { path: ".opencode/commands" },
          agents: { path: ".opencode/agents" },
        },
      },
    ],
    [
      "codex",
      {
        name: "codex",
        targets: {
          skills: { path: ".agents/skills" },
        },
      },
    ],
  ])("returns the exact target mapping for %s", (toolName, expectedDefinition) => {
    expect(getToolDefinition(toolName)).toEqual(expectedDefinition);
  });

  it("returns null for unsupported tools", () => {
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
    ["opencode", "skills", path.join("/repo", ".opencode/skills")],
    ["opencode", "commands", path.join("/repo", ".opencode/commands")],
    ["opencode", "agents", path.join("/repo", ".opencode/agents")],
    ["codex", "skills", path.join("/repo", ".agents/skills")],
  ];

  it.each(cases)("resolves %s %s beneath the repository root", (toolName, targetName, expectedPath) => {
    expect(resolveToolTargetPath(toolName, targetName, "/repo")).toBe(expectedPath);
  });

  it.each([
    ["cursor", "agents"],
    ["codex", "commands"],
  ] satisfies Array<[string, ToolTargetName]>)(
    "returns null when %s does not define %s",
    (toolName, targetName) => {
      expect(resolveToolTargetPath(toolName, targetName, "/repo")).toBeNull();
    },
  );

  it("returns null for unsupported tools", () => {
    expect(resolveToolTargetPath("copilot", "skills", "/repo")).toBeNull();
  });
});
