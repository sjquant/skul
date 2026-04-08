import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type BundleManifest } from "./bundle-manifest";
import { materializeBundle } from "./bundle-materialization";
import { type ToolName } from "./tool-mapping";

const tempDirs: string[] = [];
// Each tuple: [toolName, nativeTargetPath]
// nativeTargetPath is BOTH the expected destination root AND the manifest source path
// so that materializeBundle copies verbatim (native dotdir pass-through).
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
  it.each(skillCases)("materializes skills for %s into %s", async (tool, nativePath) => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");

    // Bundle files live under the tool's native dotdir path so materializeBundle
    // copies them verbatim (native pass-through, no canonical transforms).
    writeFile(path.join(bundleDir, nativePath, "react", "SKILL.md"), "# react\n");
    writeFile(path.join(bundleDir, nativePath, "react", "assets", "context.md"), "context\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "react-expert",
        tools: { [tool]: { skills: { path: nativePath } } } as BundleManifest["tools"],
      },
    });

    // Then
    expect(result.files).toEqual([
      `${nativePath}/react/SKILL.md`,
      `${nativePath}/react/assets/context.md`,
    ]);
    expect(
      fs.readFileSync(path.join(repoRoot, nativePath, "react", "SKILL.md"), "utf8"),
    ).toBe("# react\n");
    expect(
      fs.readFileSync(path.join(repoRoot, nativePath, "react", "assets", "context.md"), "utf8"),
    ).toBe("context\n");
  });

  it("tracks created nested directories for deterministic cleanup", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");

    writeFile(path.join(repoRoot, ".claude", "skills", ".keep"), "");
    writeFile(path.join(bundleDir, ".claude", "skills", "react", "SKILL.md"), "# react\n");
    writeFile(path.join(bundleDir, ".claude", "skills", "react", "assets", "context.md"), "context\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "react-expert",
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
      },
    });

    // Then
    expect(result.directories).toEqual([
      ".claude/skills/react/assets",
      ".claude/skills/react",
    ]);
  });

  it.each(commandCases)("materializes commands for %s into %s", async (tool, nativePath) => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");

    writeFile(path.join(bundleDir, nativePath, "review.md"), "# review\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "review-pack",
        tools: { [tool]: { commands: { path: nativePath } } } as BundleManifest["tools"],
      },
    });

    // Then
    expect(result.files).toEqual([`${nativePath}/review.md`]);
    expect(fs.readFileSync(path.join(repoRoot, nativePath, "review.md"), "utf8")).toBe(
      "# review\n",
    );
  });

  it.each(agentCases)("materializes agents for %s into %s", async (tool, nativePath) => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");

    writeFile(path.join(bundleDir, nativePath, "reviewer.md"), "# reviewer\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "review-pack",
        tools: { [tool]: { agents: { path: nativePath } } } as BundleManifest["tools"],
      },
    });

    // Then
    expect(result.files).toEqual([`${nativePath}/reviewer.md`]);
    expect(fs.readFileSync(path.join(repoRoot, nativePath, "reviewer.md"), "utf8")).toBe(
      "# reviewer\n",
    );
  });

  it("renames an incoming file when the destination already exists", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "user file\n");
    writeFile(path.join(bundleDir, ".claude", "skills", "react", "SKILL.md"), "# react\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "react-expert",
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
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
    writeFile(path.join(bundleDir, ".claude", "skills", "react", "SKILL.md"), "# react\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "react-expert",
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
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
    writeFile(path.join(bundleDir, ".claude", "skills", "react", "SKILL.md"), "# react\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "react-expert",
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
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
            tools: { "claude-code": { skills: { path: ".claude/skills" } } },
          },
        }),
      /bundle target path does not exist/i,
    ],
    [
      "declared target path that is a file instead of a directory",
      (repoRoot: string, bundleDir: string) => {
        writeFile(path.join(bundleDir, ".claude", "skills"), "not a directory\n");

        return materializeBundle({
          repoRoot,
          bundleDir,
          manifest: {
            name: "react-expert",
            tools: { "claude-code": { skills: { path: ".claude/skills" } } },
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

  it("re-prompts when a rename destination is already reserved by a prior file in the same run", async () => {
    // Given: two bundle files; the second conflicts and user first tries to rename it to the
    // first file's destination (already reserved), then renames to a free path.
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(bundleDir, ".claude", "skills", "a.md"), "# a\n");
    writeFile(path.join(bundleDir, ".claude", "skills", "b.md"), "# b\n");
    writeFile(path.join(repoRoot, ".claude", "skills", "b.md"), "user file\n");

    const resolutions = [
      { action: "rename" as const, destination: "a.md" },   // reserved — triggers re-prompt
      { action: "rename" as const, destination: "b-new.md" }, // free — accepted
    ];
    let callCount = 0;

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "react-expert",
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
      },
      resolveFileConflict: async () => resolutions[callCount++],
    });

    // Then
    expect(callCount).toBe(2);
    expect(result.files).toContain(".claude/skills/b-new.md");
  });

  it("throws on conflict when no resolveFileConflict callback is provided", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "user file\n");
    writeFile(path.join(bundleDir, ".claude", "skills", "react", "SKILL.md"), "# react\n");

    // When / Then
    await expect(
      materializeBundle({
        repoRoot,
        bundleDir,
        manifest: {
          name: "react-expert",
          tools: { "claude-code": { skills: { path: ".claude/skills" } } },
        },
      }),
    ).rejects.toThrowError(/conflict detected/i);
  });

  it("materializes files into each tool's native directory for a multi-tool manifest", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    // Each tool has its own native copy of the file (pre-authored native format).
    writeFile(path.join(bundleDir, ".claude", "skills", "react", "SKILL.md"), "# react\n");
    writeFile(path.join(bundleDir, ".cursor", "skills", "react", "SKILL.md"), "# react\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "react-expert",
        tools: {
          "claude-code": { skills: { path: ".claude/skills" } },
          cursor: { skills: { path: ".cursor/skills" } },
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

  it("materializes only the selected tool when tools filter is provided", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(bundleDir, ".claude", "skills", "react", "SKILL.md"), "# react\n");
    writeFile(path.join(bundleDir, ".cursor", "skills", "react", "SKILL.md"), "# react\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "react-expert",
        tools: {
          "claude-code": { skills: { path: ".claude/skills" } },
          cursor: { skills: { path: ".cursor/skills" } },
        },
      },
      tools: ["claude-code"],
    });

    // Then
    expect(result.files).toEqual([".claude/skills/react/SKILL.md"]);
    expect(
      fs.readFileSync(path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"), "utf8"),
    ).toBe("# react\n");
    expect(fs.existsSync(path.join(repoRoot, ".cursor", "skills", "react", "SKILL.md"))).toBe(false);
  });

  it("materializes all tools when tools filter is empty", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(bundleDir, ".claude", "skills", "react", "SKILL.md"), "# react\n");
    writeFile(path.join(bundleDir, ".cursor", "skills", "react", "SKILL.md"), "# react\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        name: "react-expert",
        tools: {
          "claude-code": { skills: { path: ".claude/skills" } },
          cursor: { skills: { path: ".cursor/skills" } },
        },
      },
      tools: [],
    });

    // Then
    expect(result.files).toEqual([
      ".claude/skills/react/SKILL.md",
      ".cursor/skills/react/SKILL.md",
    ]);
  });

  it("throws when the bundle contains a symlink", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    fs.mkdirSync(path.join(bundleDir, ".claude", "skills"), { recursive: true });
    fs.symlinkSync("/etc/passwd", path.join(bundleDir, ".claude", "skills", "SKILL.md"));

    // When / Then
    await expect(
      materializeBundle({
        repoRoot,
        bundleDir,
        manifest: {
          name: "react-expert",
          tools: { "claude-code": { skills: { path: ".claude/skills" } } },
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
    fs.mkdirSync(path.join(bundleDir, ".claude", "skills"), { recursive: true });
    fs.symlinkSync(realDir, path.join(bundleDir, ".claude", "skills", "subdir"));

    // When / Then
    await expect(
      materializeBundle({
        repoRoot,
        bundleDir,
        manifest: {
          name: "react-expert",
          tools: { "claude-code": { skills: { path: ".claude/skills" } } },
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
    fs.mkdirSync(path.join(bundleDir, ".claude"), { recursive: true });
    fs.symlinkSync(realDir, path.join(bundleDir, ".claude", "skills"));

    // When / Then
    await expect(
      materializeBundle({
        repoRoot,
        bundleDir,
        manifest: {
          name: "react-expert",
          tools: { "claude-code": { skills: { path: ".claude/skills" } } },
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
