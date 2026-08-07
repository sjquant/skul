import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inferBundleManifest } from "./bundle-manifest";
import { materializeBundle } from "./bundle-materialization";
import type { ToolName } from "./tool-mapping";
import {
  formatExpectedRootInstructionDocument,
  formatRootInstructionBundleBlock,
} from "./utils/testing";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// inferBundleManifest
// ---------------------------------------------------------------------------

describe("inferBundleManifest", () => {
  it("infers all tools that support skills from a canonical skills/ directory", () => {
    // Given
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(bundleDir, "skills", "react", "SKILL.md"), "# react\n");

    // When
    const manifest = inferBundleManifest(bundleDir);

    // Then – every tool that supports skills should be included
    expect(manifest.tools["claude-code"]).toEqual({
      skills: { path: "skills" },
    });
    expect(manifest.tools["cursor"]).toEqual({ skills: { path: "skills" } });
    expect(manifest.tools["opencode"]).toEqual({ skills: { path: "skills" } });
    expect(manifest.tools["codex"]).toEqual({ skills: { path: "skills" } });
    expect(manifest.tools["copilot"]).toEqual({ skills: { path: "skills" } });
    expect(manifest.tools["kiro"]).toEqual({ skills: { path: "skills" } });
  });

  it("infers commands only for tools that support commands", () => {
    // Given
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(bundleDir, "commands", "review.md"), "# review\n");

    // When
    const manifest = inferBundleManifest(bundleDir);

    // Then
    expect(manifest.tools["claude-code"]).toEqual({
      commands: { path: "commands" },
    });
    expect(manifest.tools["cursor"]).toEqual({
      commands: { path: "commands" },
    });
    expect(manifest.tools["opencode"]).toEqual({
      commands: { path: "commands" },
    });
    expect(manifest.tools["codex"]).toBeUndefined(); // no commands target
    expect(manifest.tools["copilot"]).toBeUndefined(); // no commands target
    expect(manifest.tools["kiro"]).toBeUndefined(); // no commands target
  });

  it("infers agents for all tools that support agents when an agents/ directory is present", () => {
    // Given
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(bundleDir, "agents", "reviewer.md"), "# reviewer\n");

    // When
    const manifest = inferBundleManifest(bundleDir);

    // Then
    expect(manifest.tools["claude-code"]).toEqual({
      agents: { path: "agents" },
    });
    expect(manifest.tools["cursor"]).toEqual({ agents: { path: "agents" } });
    expect(manifest.tools["opencode"]).toEqual({ agents: { path: "agents" } });
    expect(manifest.tools["codex"]).toEqual({ agents: { path: "agents" } });
    expect(manifest.tools["copilot"]).toEqual({ agents: { path: "agents" } });
    expect(manifest.tools["kiro"]).toEqual({ agents: { path: "agents" } });
  });

  it("infers a CLAUDE.md root instruction for all root-instruction tools", () => {
    // Given
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(bundleDir, "CLAUDE.md"), "# team instructions\n");

    // When
    const manifest = inferBundleManifest(bundleDir);

    // Then
    expect(manifest.tools["claude-code"]).toEqual({
      root_instruction: { path: "CLAUDE.md" },
    });
    expect(manifest.tools["cursor"]).toEqual({
      root_instruction: { path: "CLAUDE.md" },
    });
    expect(manifest.tools["opencode"]).toEqual({
      root_instruction: { path: "CLAUDE.md" },
    });
    expect(manifest.tools["codex"]).toEqual({
      root_instruction: { path: "CLAUDE.md" },
    });
    expect(manifest.tools["copilot"]).toEqual({
      root_instruction: { path: "CLAUDE.md" },
    });
    expect(manifest.tools["kiro"]).toEqual({
      root_instruction: { path: "CLAUDE.md" },
    });
  });

  it("infers an AGENTS.md root instruction for all root-instruction tools", () => {
    // Given
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(bundleDir, "AGENTS.md"), "# codex instructions\n");

    // When
    const manifest = inferBundleManifest(bundleDir);

    // Then
    expect(manifest.tools["claude-code"]).toEqual({
      root_instruction: { path: "AGENTS.md" },
    });
    expect(manifest.tools["cursor"]).toEqual({
      root_instruction: { path: "AGENTS.md" },
    });
    expect(manifest.tools["opencode"]).toEqual({
      root_instruction: { path: "AGENTS.md" },
    });
    expect(manifest.tools["codex"]).toEqual({
      root_instruction: { path: "AGENTS.md" },
    });
    expect(manifest.tools["copilot"]).toEqual({
      root_instruction: { path: "AGENTS.md" },
    });
    expect(manifest.tools["kiro"]).toEqual({
      root_instruction: { path: "AGENTS.md" },
    });
  });

  it("uses native dotdir path when a native directory exists", () => {
    // Given
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, ".cursor", "skills", "react", "SKILL.md"),
      "# raw\n",
    );

    // When
    const manifest = inferBundleManifest(bundleDir);

    // Then
    expect(manifest.tools["cursor"]).toEqual({
      skills: { path: ".cursor/skills" },
    });
    // Other tools are absent because neither canonical nor their native dirs exist
    expect(manifest.tools["claude-code"]).toBeUndefined();
  });

  it("infers Antigravity CLI skills and nested agents from .agents", () => {
    // Given
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, ".agents", "skills", "reviewer", "SKILL.md"),
      "# native skill\n",
    );
    writeFile(
      path.join(bundleDir, ".agents", "agents", "reviewer", "agent.md"),
      "# native agent\n",
    );

    // When
    const manifest = inferBundleManifest(bundleDir);

    // Then
    expect(manifest.tools.antigravity).toEqual({
      skills: { path: ".agents/skills" },
      agents: { path: ".agents/agents" },
    });
  });

  it("native dotdir overrides canonical path for the same tool + target", () => {
    // Given: canonical skills/ AND .cursor/skills/ both present
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "skills", "react", "SKILL.md"),
      "# canonical\n",
    );
    writeFile(
      path.join(bundleDir, ".cursor", "skills", "react", "SKILL.md"),
      "# native\n",
    );

    // When
    const manifest = inferBundleManifest(bundleDir);

    // Then – cursor uses native path, others use canonical
    expect(manifest.tools["cursor"]?.skills?.path).toBe(".cursor/skills");
    expect(manifest.tools["claude-code"]?.skills?.path).toBe("skills");
    expect(manifest.tools["opencode"]?.skills?.path).toBe("skills");
    expect(manifest.tools["codex"]?.skills?.path).toBe("skills");
  });

  it("merges canonical and native entries for the same tool across different targets", () => {
    // Given: canonical commands/ + native .claude/skills/ for claude-code
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(bundleDir, "commands", "review.md"), "# review\n");
    writeFile(
      path.join(bundleDir, ".claude", "skills", "react", "SKILL.md"),
      "# native skill\n",
    );

    // When
    const manifest = inferBundleManifest(bundleDir);

    // Then – claude-code has native skills + canonical commands
    expect(manifest.tools["claude-code"]).toEqual({
      skills: { path: ".claude/skills" },
      commands: { path: "commands" },
    });
  });

  it("merges canonical directories with a root instruction file for the same tool", () => {
    // Given
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "skills", "react", "SKILL.md"),
      "# canonical\n",
    );
    writeFile(path.join(bundleDir, "CLAUDE.md"), "# root instructions\n");

    // When
    const manifest = inferBundleManifest(bundleDir);

    // Then
    expect(manifest.tools["claude-code"]).toEqual({
      skills: { path: "skills" },
      root_instruction: { path: "CLAUDE.md" },
    });
    expect(manifest.tools["cursor"]).toEqual({
      skills: { path: "skills" },
      root_instruction: { path: "CLAUDE.md" },
    });
    expect(manifest.tools["opencode"]).toEqual({
      skills: { path: "skills" },
      root_instruction: { path: "CLAUDE.md" },
    });
    expect(manifest.tools["codex"]).toEqual({
      skills: { path: "skills" },
      root_instruction: { path: "CLAUDE.md" },
    });
    expect(manifest.tools["copilot"]).toEqual({
      skills: { path: "skills" },
      root_instruction: { path: "CLAUDE.md" },
    });
    expect(manifest.tools["kiro"]).toEqual({
      skills: { path: "skills" },
      root_instruction: { path: "CLAUDE.md" },
    });
  });

  it("materializes a CLAUDE root instruction into AGENTS.md for codex", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(bundleDir, "CLAUDE.md"), "# shared rules\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { codex: { root_instruction: { path: "CLAUDE.md" } } },
      },
    });

    // Then
    expect(result.byTool["codex"]!.files).toEqual(["AGENTS.md"]);
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      formatExpectedRootInstructionDocument(
        formatRootInstructionBundleBlock("bundle", "# shared rules\n"),
      ),
    );
  });

  it("materializes an AGENTS root instruction into CLAUDE.md for claude-code", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(bundleDir, "AGENTS.md"), "# shared rules\n");

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
        formatRootInstructionBundleBlock("bundle", "# shared rules\n"),
      ),
    );
  });

  it("returns empty tools for a bundle dir with no recognisable structure", () => {
    // Given
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(bundleDir, "README.md"), "# hello\n");

    // When
    const manifest = inferBundleManifest(bundleDir);

    // Then
    expect(Object.keys(manifest.tools)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// materializeBundle — canonical → cursor
// ---------------------------------------------------------------------------

describe("materializeBundle: canonical → cursor", () => {
  it("translates a canonical skill into the cursor skills directory", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "skills", "react", "SKILL.md"),
      "---\nname: react\ndescription: React skills\n---\nReact content\n",
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { cursor: { skills: { path: "skills" } } },
      },
    });

    // Then
    expect(result.byTool["cursor"]!.files).toEqual([
      ".cursor/skills/react/SKILL.md",
    ]);
    const content = fs.readFileSync(
      path.join(repoRoot, ".cursor", "skills", "react", "SKILL.md"),
      "utf8",
    );
    expect(content).toContain("name: react");
    expect(content).toContain("description: React skills");
    expect(content).toContain("React content");
  });

  it("translates a canonical command into the cursor commands directory as plain text", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "commands", "review.md"),
      "---\ndescription: Review code\n---\nReview the diff.\n",
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { cursor: { commands: { path: "commands" } } },
      },
    });

    // Then
    expect(result.byTool["cursor"]!.files).toEqual([
      ".cursor/commands/review.md",
    ]);
    const content = fs.readFileSync(
      path.join(repoRoot, ".cursor", "commands", "review.md"),
      "utf8",
    );
    // Cursor commands are plain text — frontmatter is stripped
    expect(content).toBe("Review the diff.\n");
    expect(content).not.toContain("description:");
  });
});

// ---------------------------------------------------------------------------
// materializeBundle — canonical → codex
// ---------------------------------------------------------------------------

describe("materializeBundle: canonical → codex", () => {
  it("translates a canonical skill into codex SKILL.md inside .agents/skills/", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Code review\n---\nReview carefully.\n",
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { codex: { skills: { path: "skills" } } },
      },
    });

    // Then
    expect(result.byTool["codex"]!.files).toContain(
      ".agents/skills/review/SKILL.md",
    );
    const content = fs.readFileSync(
      path.join(repoRoot, ".agents", "skills", "review", "SKILL.md"),
      "utf8",
    );
    expect(content).toContain("name: review");
    expect(content).toContain("description: Code review");
    expect(content).toContain("Review carefully.");
  });

  it("emits agents/openai.yaml alongside SKILL.md for a manualOnly skill", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "skills", "next-task", "SKILL.md"),
      "---\nname: next-task\ndescription: Handle next task\ndisable-model-invocation: true\n---\nRun tasks.\n",
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { codex: { skills: { path: "skills" } } },
      },
    });

    // Then
    expect(result.byTool["codex"]!.files).toContain(
      ".agents/skills/next-task/SKILL.md",
    );
    expect(result.byTool["codex"]!.files).toContain(
      ".agents/skills/next-task/agents/openai.yaml",
    );
    const yaml = fs.readFileSync(
      path.join(
        repoRoot,
        ".agents",
        "skills",
        "next-task",
        "agents",
        "openai.yaml",
      ),
      "utf8",
    );
    expect(yaml).toContain("allow_implicit_invocation: false");
  });

  it("translates a canonical agent to TOML in .codex/agents/", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: Code reviewer\n---\nReview every PR carefully.\n",
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { codex: { agents: { path: "agents" } } },
      },
    });

    // Then
    expect(result.byTool["codex"]!.files).toEqual([
      ".codex/agents/reviewer.toml",
    ]);
    const content = fs.readFileSync(
      path.join(repoRoot, ".codex", "agents", "reviewer.toml"),
      "utf8",
    );
    expect(content).toContain('name = "reviewer"');
    expect(content).toContain('description = "Code reviewer"');
    expect(content).toContain("Review every PR carefully.");
  });
});

// ---------------------------------------------------------------------------
// materializeBundle — canonical → opencode
// ---------------------------------------------------------------------------

describe("materializeBundle: canonical → opencode", () => {
  it("translates a canonical skill with opencode compatibility metadata", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "skills", "react", "SKILL.md"),
      "---\nname: react\ndescription: React skills\n---\nReact content\n",
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { opencode: { skills: { path: "skills" } } },
      },
    });

    // Then
    expect(result.byTool["opencode"]!.files).toEqual([
      ".opencode/skills/react/SKILL.md",
    ]);
    const content = fs.readFileSync(
      path.join(repoRoot, ".opencode", "skills", "react", "SKILL.md"),
      "utf8",
    );
    expect(content).toContain("compatibility: opencode");
    expect(content).toContain("React content");
  });

  it("converts a manualOnly canonical skill to an opencode command", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "skills", "fix", "SKILL.md"),
      "---\nname: fix\ndescription: Fix issues\ndisable-model-invocation: true\n---\nFix the reported issue.\n",
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { opencode: { skills: { path: "skills" } } },
      },
    });

    // Then – manualOnly skill lands in opencode's commands dir, not skills dir
    expect(result.byTool["opencode"]!.files).toEqual([
      ".opencode/commands/fix.md",
    ]);
    expect(
      fs.existsSync(
        path.join(repoRoot, ".opencode", "skills", "fix", "SKILL.md"),
      ),
    ).toBe(false);
    const content = fs.readFileSync(
      path.join(repoRoot, ".opencode", "commands", "fix.md"),
      "utf8",
    );
    expect(content).toContain("Fix the reported issue.");
  });

  it("translates a canonical command to the opencode commands directory", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "commands", "deploy.md"),
      "---\ndescription: Deploy the app\n---\nRun the deployment pipeline.\n",
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { opencode: { commands: { path: "commands" } } },
      },
    });

    // Then
    expect(result.byTool["opencode"]!.files).toEqual([
      ".opencode/commands/deploy.md",
    ]);
    const content = fs.readFileSync(
      path.join(repoRoot, ".opencode", "commands", "deploy.md"),
      "utf8",
    );
    expect(content).toContain("description: Deploy the app");
    expect(content).toContain("Run the deployment pipeline.");
  });
});

// ---------------------------------------------------------------------------
// materializeBundle — native dotdir passthrough
// ---------------------------------------------------------------------------

describe("materializeBundle: native dotdir passthrough", () => {
  const nativeCases: Array<[ToolName, string, string, string]> = [
    ["claude-code", ".claude/skills", "react/SKILL.md", "# raw claude skill\n"],
    ["cursor", ".cursor/skills", "react/SKILL.md", "# raw cursor skill\n"],
    ["cursor", ".cursor/commands", "review.md", "# raw cursor command\n"],
    ["cursor", ".cursor/agents", "reviewer.md", "# raw cursor agent\n"],
    [
      "opencode",
      ".opencode/skills",
      "react/SKILL.md",
      "# raw opencode skill\n",
    ],
    ["codex", ".agents/skills", "react/SKILL.md", "# raw codex skill\n"],
    ["codex", ".codex/agents", "reviewer.toml", 'name = "reviewer"\n'],
  ];

  it.each(
    nativeCases,
  )("copies %s native %s/%s verbatim", async (toolName, nativePath, fileName, rawContent) => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    const targetName = nativePath.split("/")[1] as
      | "skills"
      | "commands"
      | "agents";
    writeFile(path.join(bundleDir, nativePath, fileName), rawContent);

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { [toolName]: { [targetName]: { path: nativePath } } } as any,
      },
    });

    // Then
    const expectedFile = `${nativePath}/${fileName}`;
    expect(result.byTool[toolName]!.files).toContain(expectedFile);
    const writtenContent = fs.readFileSync(
      path.join(repoRoot, expectedFile),
      "utf8",
    );
    expect(writtenContent).toBe(rawContent);
  });
});

// ---------------------------------------------------------------------------
// materializeBundle — canonical multi-tool in a single pass
// ---------------------------------------------------------------------------

describe("materializeBundle: canonical multi-tool materialization", () => {
  it("translates the same canonical skill into multiple tools simultaneously", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "skills", "react", "SKILL.md"),
      "---\nname: react\ndescription: React skills\n---\nReact content\n",
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

    // Then – each tool gets its own translated copy
    expect(result.byTool["claude-code"]!.files).toContain(
      ".claude/skills/react/SKILL.md",
    );
    expect(result.byTool["cursor"]!.files).toContain(
      ".cursor/skills/react/SKILL.md",
    );
    expect(result.byTool["codex"]!.files).toContain(
      ".agents/skills/react/SKILL.md",
    );
  });
});

// ---------------------------------------------------------------------------
// materializeBundle — copilot and kiro
// ---------------------------------------------------------------------------

describe("materializeBundle: copilot", () => {
  it("materializes a canonical skill into the Copilot skills directory", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "skills", "react", "SKILL.md"),
      [
        "---",
        "name: react",
        "description: React expert",
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
      manifest: { tools: { copilot: { skills: { path: "skills" } } } },
    });

    // Then
    expect(result.byTool["copilot"]!.files).toContain(
      ".github/skills/react/SKILL.md",
    );
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".github/skills/react/SKILL.md"),
        "utf8",
      ),
    ).toContain("name: react");
  });

  it("translates a canonical agent into .github/agents/ with .agent.md extension", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: Code reviewer\n---\nReview every PR carefully.\n",
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: { tools: { copilot: { agents: { path: "agents" } } } },
    });

    // Then
    expect(result.byTool["copilot"]!.files).toEqual([
      ".github/agents/reviewer.agent.md",
    ]);
    const content = fs.readFileSync(
      path.join(repoRoot, ".github/agents/reviewer.agent.md"),
      "utf8",
    );
    expect(content).toContain("name: reviewer");
    expect(content).toContain("description: Code reviewer");
    expect(content).toContain("Review every PR carefully.");
  });

  it("materializes a root instruction into AGENTS.md for copilot", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(bundleDir, "CLAUDE.md"), "# Coding standards\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { copilot: { root_instruction: { path: "CLAUDE.md" } } },
      },
    });

    // Then
    expect(result.byTool["copilot"]!.files).toEqual(["AGENTS.md"]);
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      formatExpectedRootInstructionDocument(
        formatRootInstructionBundleBlock("bundle", "# Coding standards\n"),
      ),
    );
  });
});

describe("materializeBundle: kiro", () => {
  it("materializes a canonical skill into the Kiro skills directory", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "skills", "react", "SKILL.md"),
      [
        "---",
        "name: react",
        "description: React expert",
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
      manifest: { tools: { kiro: { skills: { path: "skills" } } } },
    });

    // Then
    expect(result.byTool["kiro"]!.files).toContain(
      ".kiro/skills/react/SKILL.md",
    );
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".kiro/skills/react/SKILL.md"),
        "utf8",
      ),
    ).toContain("name: react");
  });

  it("translates a canonical agent into .kiro/agents/ with .md extension", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: Code reviewer\n---\nReview every PR carefully.\n",
    );

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: { tools: { kiro: { agents: { path: "agents" } } } },
    });

    // Then
    expect(result.byTool["kiro"]!.files).toEqual([".kiro/agents/reviewer.md"]);
    const content = fs.readFileSync(
      path.join(repoRoot, ".kiro/agents/reviewer.md"),
      "utf8",
    );
    expect(content).toContain("name: reviewer");
    expect(content).toContain("description: Code reviewer");
    expect(content).toContain("Review every PR carefully.");
  });

  it("materializes a root instruction into AGENTS.md", async () => {
    // Given
    const repoRoot = createTempDir("skul-repo-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(bundleDir, "AGENTS.md"), "# Coding standards\n");

    // When
    const result = await materializeBundle({
      repoRoot,
      bundleDir,
      manifest: {
        tools: { kiro: { root_instruction: { path: "AGENTS.md" } } },
      },
    });

    // Then
    expect(result.byTool["kiro"]!.files).toEqual(["AGENTS.md"]);
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toBe(
      formatExpectedRootInstructionDocument(
        formatRootInstructionBundleBlock("bundle", "# Coding standards\n"),
      ),
    );
  });
});

describe("inferBundleManifest: copilot and kiro native paths", () => {
  it("detects a native Copilot skills directory", () => {
    // Given
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, ".github", "skills", "react", "SKILL.md"),
      "# skill\n",
    );

    // When
    const manifest = inferBundleManifest(bundleDir);

    // Then
    expect(manifest.tools["copilot"]).toEqual({
      skills: { path: ".github/skills" },
    });
    expect(manifest.tools["claude-code"]).toBeUndefined();
  });

  it("detects a native Kiro skills directory", () => {
    // Given
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, ".kiro", "skills", "react", "SKILL.md"),
      "# skill\n",
    );

    // When
    const manifest = inferBundleManifest(bundleDir);

    // Then
    expect(manifest.tools["kiro"]).toEqual({
      skills: { path: ".kiro/skills" },
    });
    expect(manifest.tools["claude-code"]).toBeUndefined();
  });

  it("detects a native Copilot agents directory", () => {
    // Given
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, ".github", "agents", "reviewer.agent.md"),
      "# agent\n",
    );

    // When
    const manifest = inferBundleManifest(bundleDir);

    // Then
    expect(manifest.tools["copilot"]).toEqual({
      agents: { path: ".github/agents" },
    });
    expect(manifest.tools["claude-code"]).toBeUndefined();
  });

  it("detects a native Kiro agents directory", () => {
    // Given
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, ".kiro", "agents", "reviewer.md"),
      "# agent\n",
    );

    // When
    const manifest = inferBundleManifest(bundleDir);

    // Then
    expect(manifest.tools["kiro"]).toEqual({
      agents: { path: ".kiro/agents" },
    });
    expect(manifest.tools["claude-code"]).toBeUndefined();
  });

  it("detects AGENTS.md as copilot's root instruction", () => {
    // Given
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(path.join(bundleDir, "AGENTS.md"), "# instructions\n");

    // When
    const manifest = inferBundleManifest(bundleDir);

    // Then
    expect(manifest.tools["copilot"]).toEqual({
      root_instruction: { path: "AGENTS.md" },
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}
