import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BundleManifest } from "./bundle-manifest";
import {
  materializeBundle,
  previewMaterializeBundleWriteTargets,
} from "./bundle-materialization";
import type { ToolName } from "./tool-mapping";
import {
  formatExpectedRootInstructionDocument,
  formatRootInstructionBundleBlock,
} from "./utils/testing";

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
  ["cursor", ".cursor/agents"],
  ["opencode", ".opencode/agents"],
  ["codex", ".codex/agents"],
];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("materializeBundle", () => {
  it.each(
    skillCases,
  )("materializes skills for %s into %s", async (tool, nativePath) => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");

    // Bundle files live under the tool's native dotdir path so materializeBundle
    // copies them verbatim (native pass-through, no canonical transforms).
    writeFile(
      path.join(bundleDir, nativePath, "react", "SKILL.md"),
      "# react\n",
    );
    writeFile(
      path.join(bundleDir, nativePath, "react", "assets", "context.md"),
      "context\n",
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: {
          [tool]: { skills: { path: nativePath } },
        } as BundleManifest["tools"],
      },
    });

    // Then
    expect(result.byTool[tool]!.files).toEqual([
      `${nativePath}/react/SKILL.md`,
      `${nativePath}/react/assets/context.md`,
    ]);
    expect(
      fs.readFileSync(
        path.join(repoRoot, nativePath, "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
    expect(
      fs.readFileSync(
        path.join(repoRoot, nativePath, "react", "assets", "context.md"),
        "utf8",
      ),
    ).toBe("context\n");
  });

  it("tracks created nested directories for deterministic cleanup", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");

    writeFile(path.join(repoRoot, ".claude", "skills", ".keep"), "");
    writeFile(
      path.join(bundleDir, ".claude", "skills", "react", "SKILL.md"),
      "# react\n",
    );
    writeFile(
      path.join(
        bundleDir,
        ".claude",
        "skills",
        "react",
        "assets",
        "context.md",
      ),
      "context\n",
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
      },
    });

    // Then
    expect(result.byTool["claude-code"]!.directories).toEqual([
      ".claude/skills/react/assets",
      ".claude/skills/react",
    ]);
  });

  it.each(
    commandCases,
  )("materializes commands for %s into %s", async (tool, nativePath) => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");

    writeFile(path.join(bundleDir, nativePath, "review.md"), "# review\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: {
          [tool]: { commands: { path: nativePath } },
        } as BundleManifest["tools"],
      },
    });

    // Then
    expect(result.byTool[tool]!.files).toEqual([`${nativePath}/review.md`]);
    expect(
      fs.readFileSync(path.join(repoRoot, nativePath, "review.md"), "utf8"),
    ).toBe("# review\n");
  });

  it.each(
    agentCases,
  )("materializes agents for %s into %s", async (tool, nativePath) => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");

    writeFile(path.join(bundleDir, nativePath, "reviewer.md"), "# reviewer\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: {
          [tool]: { agents: { path: nativePath } },
        } as BundleManifest["tools"],
      },
    });

    // Then
    expect(result.byTool[tool]!.files).toEqual([`${nativePath}/reviewer.md`]);
    expect(
      fs.readFileSync(path.join(repoRoot, nativePath, "reviewer.md"), "utf8"),
    ).toBe("# reviewer\n");
  });

  it("overwrites the existing file when the user confirms", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
      "user file\n",
    );
    writeFile(
      path.join(bundleDir, ".claude", "skills", "react", "SKILL.md"),
      "# react\n",
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
      },
      resolveFileConflict: async () => ({ action: "overwrite" }),
    });

    // Then
    expect(result.byTool["claude-code"]!.files).toEqual([
      ".claude/skills/react/SKILL.md",
    ]);
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
  });

  it("appends codex root instructions onto an existing AGENTS.md file", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");

    writeFile(path.join(repoRoot, "AGENTS.md"), "user file\n");
    writeFile(path.join(bundleDir, "CLAUDE.md"), "bundle root instruction\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { codex: { root_instruction: { path: "CLAUDE.md" } } },
      },
    });

    // Then
    expect(result.byTool.codex!.files).toEqual(["AGENTS.md"]);
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      formatExpectedRootInstructionDocument(
        "user file\n",
        formatRootInstructionBundleBlock("bundle", "bundle root instruction\n"),
      ),
    );
  });

  it("appends claude-code root instructions onto an existing CLAUDE.md file", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");

    writeFile(path.join(repoRoot, "CLAUDE.md"), "user file\n");
    writeFile(path.join(bundleDir, "AGENTS.md"), "bundle root instruction\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { "claude-code": { root_instruction: { path: "AGENTS.md" } } },
      },
    });

    // Then
    expect(result.byTool["claude-code"]!.files).toEqual(["CLAUDE.md"]);
    expect(fs.readFileSync(path.join(repoRoot, "CLAUDE.md"), "utf8")).toBe(
      formatExpectedRootInstructionDocument(
        "user file\n",
        formatRootInstructionBundleBlock("bundle", "bundle root instruction\n"),
      ),
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
            tools: { "claude-code": { skills: { path: ".claude/skills" } } },
          },
        }),
      /bundle target path does not exist/i,
    ],
    [
      "declared target path that is a file instead of a directory",
      (repoRoot: string, bundleDir: string) => {
        writeFile(
          path.join(bundleDir, ".claude", "skills"),
          "not a directory\n",
        );

        return materializeBundle({
          repoRoot,
          bundleDir,
          manifest: {
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

  it("passes the relative conflict path to the callback", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
      "user file\n",
    );
    writeFile(
      path.join(bundleDir, ".claude", "skills", "react", "SKILL.md"),
      "# react\n",
    );
    let capturedConflictPath: string | undefined;

    // When
    await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
      },
      resolveFileConflict: async (conflictPath) => {
        capturedConflictPath = conflictPath;
        return { action: "overwrite" };
      },
    });

    // Then — path is relative to the tool target root
    expect(capturedConflictPath).toBe("react/SKILL.md");
  });

  it("throws without calling the callback when the destination is already reserved by a prior file in the same run", async () => {
    // Given — the resolveFileConflict callback writes to a path that's already claimed
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(bundleDir, ".claude", "skills", "a.md"), "# a\n");
    writeFile(path.join(bundleDir, ".claude", "skills", "b.md"), "# b\n");
    // b.md conflicts with user file; the resolveFileConflict callback overwrites it.
    // Ensure the callback is only called once — a.md is free, b.md triggers the callback.
    writeFile(
      path.join(repoRoot, ".claude", "skills", "b.md"),
      "user b\n",
    );

    let callCount = 0;

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
      },
      resolveFileConflict: async () => {
        callCount++;
        return { action: "overwrite" };
      },
    });

    // Then — callback called exactly once (for b.md); a.md has no conflict
    expect(callCount).toBe(1);
    expect(result.byTool["claude-code"]!.files).toContain(
      ".claude/skills/a.md",
    );
    expect(result.byTool["claude-code"]!.files).toContain(
      ".claude/skills/b.md",
    );
  });

  it("throws on conflict when no resolveFileConflict callback is provided", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
      "user file\n",
    );
    writeFile(
      path.join(bundleDir, ".claude", "skills", "react", "SKILL.md"),
      "# react\n",
    );

    // When / Then
    await expect(
      materializeBundle({
        repoRoot,
        bundleDir,
        manifest: {
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
    writeFile(
      path.join(bundleDir, ".claude", "skills", "react", "SKILL.md"),
      "# react\n",
    );
    writeFile(
      path.join(bundleDir, ".cursor", "skills", "react", "SKILL.md"),
      "# react\n",
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: {
          "claude-code": { skills: { path: ".claude/skills" } },
          cursor: { skills: { path: ".cursor/skills" } },
        },
      },
    });

    // Then
    expect(result.byTool["claude-code"]!.files).toEqual([
      ".claude/skills/react/SKILL.md",
    ]);
    expect(result.byTool["cursor"]!.files).toEqual([
      ".cursor/skills/react/SKILL.md",
    ]);
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".cursor", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
  });

  it("materializes only the selected tool when tools filter is provided", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, ".claude", "skills", "react", "SKILL.md"),
      "# react\n",
    );
    writeFile(
      path.join(bundleDir, ".cursor", "skills", "react", "SKILL.md"),
      "# react\n",
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: {
          "claude-code": { skills: { path: ".claude/skills" } },
          cursor: { skills: { path: ".cursor/skills" } },
        },
      },
      tools: ["claude-code"],
    });

    // Then
    expect(result.byTool["claude-code"]!.files).toEqual([
      ".claude/skills/react/SKILL.md",
    ]);
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# react\n");
    expect(
      fs.existsSync(
        path.join(repoRoot, ".cursor", "skills", "react", "SKILL.md"),
      ),
    ).toBe(false);
  });

  it("materializes all tools when tools filter is empty", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, ".claude", "skills", "react", "SKILL.md"),
      "# react\n",
    );
    writeFile(
      path.join(bundleDir, ".cursor", "skills", "react", "SKILL.md"),
      "# react\n",
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: {
          "claude-code": { skills: { path: ".claude/skills" } },
          cursor: { skills: { path: ".cursor/skills" } },
        },
      },
      tools: [],
    });

    // Then
    expect(result.byTool["claude-code"]!.files).toEqual([
      ".claude/skills/react/SKILL.md",
    ]);
    expect(result.byTool["cursor"]!.files).toEqual([
      ".cursor/skills/react/SKILL.md",
    ]);
  });

  it("throws when the bundle contains a symlink", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    fs.mkdirSync(path.join(bundleDir, ".claude", "skills"), {
      recursive: true,
    });
    fs.symlinkSync(
      "/etc/passwd",
      path.join(bundleDir, ".claude", "skills", "SKILL.md"),
    );

    // When / Then
    await expect(
      materializeBundle({
        repoRoot,
        bundleDir,
        manifest: {
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
    fs.mkdirSync(path.join(bundleDir, ".claude", "skills"), {
      recursive: true,
    });
    fs.symlinkSync(
      realDir,
      path.join(bundleDir, ".claude", "skills", "subdir"),
    );

    // When / Then
    await expect(
      materializeBundle({
        repoRoot,
        bundleDir,
        manifest: {
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
          tools: { "claude-code": { skills: { path: ".claude/skills" } } },
        },
      }),
    ).rejects.toThrowError(/symlink/i);
  });
});

// ---------------------------------------------------------------------------
// Canonical-path materialization — exercises materializeCanonicalTarget, which
// translates content from the canonical `skills/`, `commands/`, `agents/`
// directories into tool-specific output files.  All tests above use native
// dotdir paths and bypass this translation path entirely.
// ---------------------------------------------------------------------------

describe("materializeBundle – canonical skill source", () => {
  it("translates a canonical skill to claude-code format", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "skills", "react", "SKILL.md"),
      [
        "---",
        "name: react",
        "description: React development patterns",
        "---",
        "",
        "Use React best practices.",
        "",
      ].join("\n"),
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { "claude-code": { skills: { path: "skills" } } },
      },
    });

    // Then — canonical source `skills/` → `.claude/skills/<name>/SKILL.md`
    expect(result.byTool["claude-code"]!.files).toEqual([
      ".claude/skills/react/SKILL.md",
    ]);
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
        "utf8",
      ),
    ).toBe(
      [
        "---",
        "name: react",
        "description: React development patterns",
        "---",
        "Use React best practices.",
        "",
      ].join("\n"),
    );
  });

  it("translates a canonical skill to cursor format", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "skills", "react", "SKILL.md"),
      [
        "---",
        "name: react",
        "description: React development patterns",
        "---",
        "",
        "Use React best practices.",
        "",
      ].join("\n"),
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { cursor: { skills: { path: "skills" } } },
      },
    });

    // Then — canonical `skills/` → `.cursor/skills/<name>/SKILL.md`
    expect(result.byTool.cursor!.files).toEqual([
      ".cursor/skills/react/SKILL.md",
    ]);
    expect(
      fs.existsSync(
        path.join(repoRoot, ".cursor", "skills", "react", "SKILL.md"),
      ),
    ).toBe(true);
  });

  it("translates a canonical skill to codex format including policy file", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "skills", "next-task", "SKILL.md"),
      [
        "---",
        "name: next-task",
        "description: Handle next queued task",
        "disable-model-invocation: true",
        "---",
        "",
        "Follow TASKS.md.",
        "",
      ].join("\n"),
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { codex: { skills: { path: "skills" } } },
      },
    });

    // Then — manual-only skill → policy file is included
    expect(result.byTool.codex!.files).toEqual([
      ".agents/skills/next-task/SKILL.md",
      ".agents/skills/next-task/agents/openai.yaml",
    ]);
    expect(
      fs.readFileSync(
        path.join(
          repoRoot,
          ".agents",
          "skills",
          "next-task",
          "agents",
          "openai.yaml",
        ),
        "utf8",
      ),
    ).toMatch(/allow_implicit_invocation:\s*false/);
  });

  it("translates a canonical skill to opencode as a skill file", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "skills", "react", "SKILL.md"),
      [
        "---",
        "name: react",
        "description: React development patterns",
        "---",
        "",
        "Use React best practices.",
        "",
      ].join("\n"),
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { opencode: { skills: { path: "skills" } } },
      },
    });

    // Then — non-manual skill → opencode skill (not command)
    expect(result.byTool.opencode!.files).toEqual([
      ".opencode/skills/react/SKILL.md",
    ]);
  });

  it("materializes canonical skills for multiple tools at once", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "skills", "react", "SKILL.md"),
      [
        "---",
        "name: react",
        "description: React development patterns",
        "---",
        "",
        "Use React best practices.",
        "",
      ].join("\n"),
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: {
          "claude-code": { skills: { path: "skills" } },
          cursor: { skills: { path: "skills" } },
          codex: { skills: { path: "skills" } },
        },
      },
    });

    // Then — each tool gets its own translated output
    expect(result.byTool["claude-code"]!.files).toEqual([
      ".claude/skills/react/SKILL.md",
    ]);
    expect(result.byTool.cursor!.files).toEqual([
      ".cursor/skills/react/SKILL.md",
    ]);
    expect(result.byTool.codex!.files).toContain(
      ".agents/skills/react/SKILL.md",
    );
    expect(
      fs.existsSync(
        path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(repoRoot, ".cursor", "skills", "react", "SKILL.md"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(repoRoot, ".agents", "skills", "react", "SKILL.md"),
      ),
    ).toBe(true);
  });

  it("translates a canonical skill to kiro format", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "skills", "react", "SKILL.md"),
      [
        "---",
        "name: react",
        "description: React development patterns",
        "---",
        "",
        "Use React best practices.",
        "",
      ].join("\n"),
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { kiro: { skills: { path: "skills" } } },
      },
    });

    // Then — canonical `skills/` → `.kiro/skills/<name>/SKILL.md`
    expect(result.byTool.kiro!.files).toEqual([
      ".kiro/skills/react/SKILL.md",
    ]);
    expect(
      fs.existsSync(
        path.join(repoRoot, ".kiro", "skills", "react", "SKILL.md"),
      ),
    ).toBe(true);
  });
});

describe("materializeBundle – canonical command source", () => {
  it("translates a canonical command to claude-code format", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "commands", "review.md"),
      [
        "---",
        "description: Review staged changes",
        "---",
        "",
        "Review the staged changes.",
        "",
      ].join("\n"),
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { "claude-code": { commands: { path: "commands" } } },
      },
    });

    // Then — canonical `commands/` → `.claude/commands/<name>.md`
    expect(result.byTool["claude-code"]!.files).toEqual([
      ".claude/commands/review.md",
    ]);
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "commands", "review.md"),
        "utf8",
      ),
    ).toContain("Review the staged changes.");
  });

  it("translates a canonical command to cursor format (strips frontmatter)", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "commands", "review.md"),
      [
        "---",
        "description: Review staged changes",
        "---",
        "",
        "Review the staged changes.",
        "",
      ].join("\n"),
    );

    // When
    await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { cursor: { commands: { path: "commands" } } },
      },
    });

    // Then — Cursor commands have no frontmatter (raw body only)
    const content = fs.readFileSync(
      path.join(repoRoot, ".cursor", "commands", "review.md"),
      "utf8",
    );
    expect(content).not.toContain("---");
    expect(content).toContain("Review the staged changes.");
  });
});

describe("materializeBundle – canonical agent source", () => {
  it("translates a canonical agent to claude-code format", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "agents", "reviewer.md"),
      [
        "---",
        "name: code-reviewer",
        "description: Review code for correctness",
        "---",
        "",
        "Review the diff.",
        "",
      ].join("\n"),
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { "claude-code": { agents: { path: "agents" } } },
      },
    });

    // Then — canonical `agents/` → `.claude/agents/<name>.md`
    expect(result.byTool["claude-code"]!.files).toEqual([
      ".claude/agents/code-reviewer.md",
    ]);
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "agents", "code-reviewer.md"),
        "utf8",
      ),
    ).toContain("name: code-reviewer");
  });

  it("translates a canonical agent to codex TOML format", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "agents", "reviewer.md"),
      [
        "---",
        "name: code-reviewer",
        "description: Review code for correctness",
        "---",
        "",
        "Review the diff.",
        "",
      ].join("\n"),
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { codex: { agents: { path: "agents" } } },
      },
    });

    // Then — canonical `agents/` → `.codex/agents/<name>.toml`
    expect(result.byTool.codex!.files).toEqual([
      ".codex/agents/code-reviewer.toml",
    ]);
    const tomlContent = fs.readFileSync(
      path.join(repoRoot, ".codex", "agents", "code-reviewer.toml"),
      "utf8",
    );
    expect(tomlContent).toContain('name = "code-reviewer"');
    expect(tomlContent).toContain('developer_instructions = """');
  });
});

describe("previewMaterializeBundleWriteTargets", () => {
  it("returns sorted repo-relative paths for a native-path skill bundle", () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, ".claude", "skills", "react", "SKILL.md"),
      "# react\n",
    );
    writeFile(
      path.join(bundleDir, ".claude", "skills", "vue", "SKILL.md"),
      "# vue\n",
    );

    // When
    const targets = previewMaterializeBundleWriteTargets({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
      },
    });

    // Then
    expect(targets).toEqual([
      ".claude/skills/react/SKILL.md",
      ".claude/skills/vue/SKILL.md",
    ]);
  });

  it("returns translated paths for a canonical skill bundle", () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "skills", "react", "SKILL.md"),
      [
        "---",
        "name: react",
        "description: React patterns",
        "---",
        "",
        "Use React.",
        "",
      ].join("\n"),
    );

    // When
    const targets = previewMaterializeBundleWriteTargets({
      repoRoot,
      bundleDir,
      manifest: {
        tools: {
          "claude-code": { skills: { path: "skills" } },
          cursor: { skills: { path: "skills" } },
        },
      },
    });

    // Then — both tools' translated paths appear
    expect(targets).toContain(".claude/skills/react/SKILL.md");
    expect(targets).toContain(".cursor/skills/react/SKILL.md");
  });

  it("respects the tools filter", () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, ".claude", "skills", "react", "SKILL.md"),
      "# react\n",
    );
    writeFile(
      path.join(bundleDir, ".cursor", "skills", "react", "SKILL.md"),
      "# react\n",
    );

    // When
    const targets = previewMaterializeBundleWriteTargets({
      repoRoot,
      bundleDir,
      manifest: {
        tools: {
          "claude-code": { skills: { path: ".claude/skills" } },
          cursor: { skills: { path: ".cursor/skills" } },
        },
      },
      tools: ["claude-code"],
    });

    // Then — only claude-code paths returned
    expect(targets).toEqual([".claude/skills/react/SKILL.md"]);
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
