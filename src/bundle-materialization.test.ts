import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { materializeBundle } from "./bundle-materialization";

const tempDirs: string[] = [];
const skillCases: Array<[string, string]> = [
  ["claude-code", ".claude/skills"],
  ["cursor", ".cursor/skills"],
  ["opencode", ".opencode/skills"],
  ["codex", ".agents/skills"],
];
const commandCases: Array<[string, string]> = [
  ["claude-code", ".claude/commands"],
  ["cursor", ".cursor/commands"],
  ["opencode", ".opencode/commands"],
];
const agentCases: Array<[string, string]> = [
  ["claude-code", ".claude/agents"],
  ["opencode", ".opencode/agents"],
];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("materializeBundle", () => {
  it.each(skillCases)("materializes skills for %s into %s", (tool, destinationRoot) => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");

    writeFile(path.join(bundleDir, "skills", "react", "SKILL.md"), "# react\n");
    writeFile(path.join(bundleDir, "skills", "react", "assets", "context.md"), "context\n");

    // When
    const result = materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "react-expert",
        tool: tool as "claude-code" | "cursor" | "opencode" | "codex",
        targets: {
          skills: { path: "skills" },
        },
      },
    });

    // Then
    expect(result.files).toEqual([
      `${destinationRoot}/react/SKILL.md`,
      `${destinationRoot}/react/assets/context.md`,
    ]);
    expect(
      fs.readFileSync(path.join(repoRoot, destinationRoot, "react", "SKILL.md"), "utf8"),
    ).toBe("# react\n");
    expect(
      fs.readFileSync(path.join(repoRoot, destinationRoot, "react", "assets", "context.md"), "utf8"),
    ).toBe("context\n");
  });

  it("tracks created nested directories for deterministic cleanup", () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");

    writeFile(path.join(repoRoot, ".claude", "skills", ".keep"), "");
    writeFile(path.join(bundleDir, "skills", "react", "SKILL.md"), "# react\n");
    writeFile(path.join(bundleDir, "skills", "react", "assets", "context.md"), "context\n");

    // When
    const result = materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "react-expert",
        tool: "claude-code",
        targets: {
          skills: { path: "skills" },
        },
      },
    });

    // Then
    expect(result.directories).toEqual([
      ".claude/skills/react/assets",
      ".claude/skills/react",
    ]);
  });

  it.each(commandCases)("materializes commands for %s into %s", (tool, destinationRoot) => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");

    writeFile(path.join(bundleDir, "commands", "review.md"), "# review\n");

    // When
    const result = materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "review-pack",
        tool: tool as "claude-code" | "cursor" | "opencode",
        targets: {
          commands: { path: "commands" },
        },
      },
    });

    // Then
    expect(result.files).toEqual([`${destinationRoot}/review.md`]);
    expect(fs.readFileSync(path.join(repoRoot, destinationRoot, "review.md"), "utf8")).toBe(
      "# review\n",
    );
  });

  it.each(agentCases)("materializes agents for %s into %s", (tool, destinationRoot) => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");

    writeFile(path.join(bundleDir, "agents", "reviewer.md"), "# reviewer\n");

    // When
    const result = materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "review-pack",
        tool: tool as "claude-code" | "opencode",
        targets: {
          agents: { path: "agents" },
        },
      },
    });

    // Then
    expect(result.files).toEqual([`${destinationRoot}/reviewer.md`]);
    expect(fs.readFileSync(path.join(repoRoot, destinationRoot, "reviewer.md"), "utf8")).toBe(
      "# reviewer\n",
    );
  });

  it.each([
    [
      "missing source directory for a declared target",
      (repoRoot: string, bundleDir: string) =>
        materializeBundle({
          repoRoot,
          bundleDir,
          manifest: {
            name: "react-expert",
            tool: "claude-code",
            targets: {
              skills: { path: "skills" },
            },
          },
        }),
      /bundle target path does not exist/i,
    ],
    [
      "declared target path that is a file instead of a directory",
      (repoRoot: string, bundleDir: string) => {
        writeFile(path.join(bundleDir, "skills"), "not a directory\n");

        return materializeBundle({
          repoRoot,
          bundleDir,
          manifest: {
            name: "react-expert",
            tool: "claude-code",
            targets: {
              skills: { path: "skills" },
            },
          },
        });
      },
      /bundle target path must be a directory/i,
    ],
  ])("rejects %s", (_label, action, expectedMessage) => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    const materialize = () => action(repoRoot, bundleDir);

    // When / Then
    expect(materialize).toThrowError(expectedMessage);
  });
});

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}
