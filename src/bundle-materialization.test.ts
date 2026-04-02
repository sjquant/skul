import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type BundleManifest } from "./bundle-manifest";
import { materializeBundle } from "./bundle-materialization";
import { type ToolName } from "./tool-mapping";

const tempDirs: string[] = [];
const skillCases: Array<[ToolName, string]> = [
  ["claude-code", ".claude/skills"],
  ["cursor", ".cursor/skills"],
  ["opencode", ".opencode/skills"],
  ["codex", ".agents/skills"],
];
const commandCases: Array<[ToolName, string]> = [
  ["claude-code", ".claude/commands"],
  ["cursor", ".cursor/commands"],
  ["opencode", ".opencode/commands"],
];
const agentCases: Array<[ToolName, string]> = [
  ["claude-code", ".claude/agents"],
  ["opencode", ".opencode/agents"],
  ["codex", ".codex/agents"],
];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("materializeBundle", () => {
  it.each(skillCases)("materializes skills for %s into %s", async (tool, destinationRoot) => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");

    writeFile(path.join(bundleDir, "skills", "react", "SKILL.md"), "# react\n");
    writeFile(path.join(bundleDir, "skills", "react", "assets", "context.md"), "context\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "react-expert",
        tools: { [tool]: { skills: { path: "skills" } } } as BundleManifest["tools"],
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

  it("tracks created nested directories for deterministic cleanup", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");

    writeFile(path.join(repoRoot, ".claude", "skills", ".keep"), "");
    writeFile(path.join(bundleDir, "skills", "react", "SKILL.md"), "# react\n");
    writeFile(path.join(bundleDir, "skills", "react", "assets", "context.md"), "context\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "react-expert",
        tools: { "claude-code": { skills: { path: "skills" } } },
      },
    });

    // Then
    expect(result.directories).toEqual([
      ".claude/skills/react/assets",
      ".claude/skills/react",
    ]);
  });

  it.each(commandCases)("materializes commands for %s into %s", async (tool, destinationRoot) => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");

    writeFile(path.join(bundleDir, "commands", "review.md"), "# review\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "review-pack",
        tools: { [tool]: { commands: { path: "commands" } } } as BundleManifest["tools"],
      },
    });

    // Then
    expect(result.files).toEqual([`${destinationRoot}/review.md`]);
    expect(fs.readFileSync(path.join(repoRoot, destinationRoot, "review.md"), "utf8")).toBe(
      "# review\n",
    );
  });

  it.each(agentCases)("materializes agents for %s into %s", async (tool, destinationRoot) => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");

    writeFile(path.join(bundleDir, "agents", "reviewer.md"), "# reviewer\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "review-pack",
        tools: { [tool]: { agents: { path: "agents" } } } as BundleManifest["tools"],
      },
    });

    // Then
    expect(result.files).toEqual([`${destinationRoot}/reviewer.md`]);
    expect(fs.readFileSync(path.join(repoRoot, destinationRoot, "reviewer.md"), "utf8")).toBe(
      "# reviewer\n",
    );
  });

  it("renames an incoming file when the destination already exists", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "user file\n");
    writeFile(path.join(bundleDir, "skills", "react", "SKILL.md"), "# react\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "react-expert",
        tools: { "claude-code": { skills: { path: "skills" } } },
      },
      resolveFileConflict: async () => ({
        action: "rename",
        destination: "custom-react/SKILL.md",
      }),
    });

    // Then
    expect(result.files).toEqual([".claude/skills/custom-react/SKILL.md"]);
    expect(fs.readFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "utf8")).toBe(
      "user file\n",
    );
    expect(
      fs.readFileSync(path.join(repoRoot, ".claude", "skills", "custom-react", "SKILL.md"), "utf8"),
    ).toBe("# react\n");
  });

  it("applies the suggested prefix when a file conflict is resolved with prefix", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "user file\n");
    writeFile(path.join(bundleDir, "skills", "react", "SKILL.md"), "# react\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "react-expert",
        tools: { "claude-code": { skills: { path: "skills" } } },
      },
      resolveFileConflict: async () => ({ action: "prefix", prefix: "bundle" }),
    });

    // Then
    expect(result.files).toEqual([".claude/skills/bundle-react/SKILL.md"]);
    expect(
      fs.readFileSync(path.join(repoRoot, ".claude", "skills", "bundle-react", "SKILL.md"), "utf8"),
    ).toBe("# react\n");
  });

  it("skips an incoming file when the user chooses skip", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "user file\n");
    writeFile(path.join(bundleDir, "skills", "react", "SKILL.md"), "# react\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "react-expert",
        tools: { "claude-code": { skills: { path: "skills" } } },
      },
      resolveFileConflict: async () => ({ action: "skip" }),
    });

    // Then
    expect(result.files).toEqual([]);
    expect(fs.readFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "utf8")).toBe(
      "user file\n",
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
            tools: { "claude-code": { skills: { path: "skills" } } },
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
            tools: { "claude-code": { skills: { path: "skills" } } },
          },
        });
      },
      /bundle target path must be a directory/i,
    ],
  ])("rejects %s", async (_label, action, expectedMessage) => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    const materialize = action(repoRoot, bundleDir);

    // When / Then
    await expect(materialize).rejects.toThrowError(expectedMessage);
  });

  it("throws on conflict when no resolveFileConflict callback is provided", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "user file\n");
    writeFile(path.join(bundleDir, "skills", "react", "SKILL.md"), "# react\n");

    // When / Then
    await expect(
      materializeBundle({
        repoRoot,
        bundleDir,
        manifest: {
          name: "react-expert",
          tools: { "claude-code": { skills: { path: "skills" } } },
        },
      }),
    ).rejects.toThrowError(/conflict detected/i);
  });

  it("materializes files into each tool's native directory for a multi-tool manifest", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(bundleDir, "skills", "react", "SKILL.md"), "# react\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "react-expert",
        tools: {
          "claude-code": { skills: { path: "skills" } },
          cursor: { skills: { path: "skills" } },
        },
      },
    });

    // Then
    expect(result.files).toEqual([
      ".claude/skills/react/SKILL.md",
      ".cursor/skills/react/SKILL.md",
    ]);
    expect(fs.readFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "utf8")).toBe("# react\n");
    expect(fs.readFileSync(path.join(repoRoot, ".cursor", "skills", "react", "SKILL.md"), "utf8")).toBe("# react\n");
  });

  it("throws when the bundle contains a symlink", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    fs.mkdirSync(path.join(bundleDir, "skills"), { recursive: true });
    fs.symlinkSync("/etc/passwd", path.join(bundleDir, "skills", "SKILL.md"));

    // When / Then
    await expect(
      materializeBundle({
        repoRoot,
        bundleDir,
        manifest: {
          name: "react-expert",
          tools: { "claude-code": { skills: { path: "skills" } } },
        },
      }),
    ).rejects.toThrowError(/symlink/i);
  });

  it("throws when a bundle entry is a symlink to a directory", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    const realDir = createTempDir("skul-real-");
    writeFile(path.join(realDir, "SKILL.md"), "# real\n");
    fs.mkdirSync(path.join(bundleDir, "skills"), { recursive: true });
    fs.symlinkSync(realDir, path.join(bundleDir, "skills", "subdir"));

    // When / Then
    await expect(
      materializeBundle({
        repoRoot,
        bundleDir,
        manifest: {
          name: "react-expert",
          tools: { "claude-code": { skills: { path: "skills" } } },
        },
      }),
    ).rejects.toThrowError(/symlink/i);
  });

  it("throws when a bundle target path is itself a symlink to a directory", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    const realDir = createTempDir("skul-real-");
    writeFile(path.join(realDir, "SKILL.md"), "# real\n");
    fs.symlinkSync(realDir, path.join(bundleDir, "skills"));

    // When / Then
    await expect(
      materializeBundle({
        repoRoot,
        bundleDir,
        manifest: {
          name: "react-expert",
          tools: { "claude-code": { skills: { path: "skills" } } },
        },
      }),
    ).rejects.toThrowError(/symlink/i);
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
