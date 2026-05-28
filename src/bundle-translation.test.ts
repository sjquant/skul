import { describe, expect, it } from "vitest";

import {
  translateAgent,
  translateCommand,
  translateRootInstruction,
  translateSkill,
} from "./bundle-translation";

describe("translateSkill", () => {
  it("maps Claude skill invocation control to Codex policy", () => {
    // Given
    const source = {
      "SKILL.md": [
        "---",
        "name: next-task",
        "description: Handle the next queued task",
        "disable-model-invocation: true",
        "---",
        "",
        "Follow the workflow in TASKS.md.",
        "",
      ].join("\n"),
    };

    // When
    const transformed = translateSkill({
      sourceTool: "claude",
      targetTool: "codex",
      files: source,
    });

    // Then
    expect(transformed).toEqual({
      ".agents/skills/next-task/SKILL.md": [
        "---",
        "name: next-task",
        "description: Handle the next queued task",
        "---",
        "Follow the workflow in TASKS.md.",
        "",
      ].join("\n"),
      ".agents/skills/next-task/agents/openai.yaml": [
        "policy:",
        "  allow_implicit_invocation: false",
        "",
      ].join("\n"),
    });
  });

  it("maps Codex invocation policy back to Claude skill frontmatter", () => {
    // Given
    const files = {
      "SKILL.md": [
        "---",
        "name: next-task",
        "description: Handle the next queued task",
        "---",
        "",
        "Body",
        "",
      ].join("\n"),
      "agents/openai.yaml": [
        "policy:",
        "  allow_implicit_invocation: false",
        "",
      ].join("\n"),
    };

    // When
    const transformed = translateSkill({
      sourceTool: "codex",
      targetTool: "claude",
      files,
    });

    // Then
    expect(transformed).toEqual({
      ".claude/skills/next-task/SKILL.md": [
        "---",
        "name: next-task",
        "description: Handle the next queued task",
        "disable-model-invocation: true",
        "---",
        "Body",
        "",
      ].join("\n"),
    });
  });

  it("accepts installed Claude skill paths as source input", () => {
    // Given
    const files = {
      ".claude/skills/reviewer/SKILL.md": [
        "---",
        "name: reviewer",
        "description: Review changes",
        "---",
        "",
        "Review the current diff for bugs.",
        "",
      ].join("\n"),
    };

    // When
    const transformed = translateSkill({
      sourceTool: "claude",
      targetTool: "cursor",
      files,
    });

    // Then
    expect(transformed).toEqual({
      ".cursor/skills/reviewer/SKILL.md": [
        "---",
        "name: reviewer",
        "description: Review changes",
        "---",
        "Review the current diff for bugs.",
        "",
      ].join("\n"),
    });
  });

  it("accepts installed Codex skill paths as source input", () => {
    // Given
    const files = {
      ".agents/skills/next-task/SKILL.md": [
        "---",
        "name: next-task",
        "description: Handle the next queued task",
        "---",
        "",
        "Follow the workflow in TASKS.md.",
        "",
      ].join("\n"),
      ".agents/skills/next-task/agents/openai.yaml": [
        "policy:",
        "  allow_implicit_invocation: false",
        "",
      ].join("\n"),
    };

    // When
    const transformed = translateSkill({
      sourceTool: "codex",
      targetTool: "claude",
      files,
    });

    // Then
    expect(transformed).toEqual({
      ".claude/skills/next-task/SKILL.md": [
        "---",
        "name: next-task",
        "description: Handle the next queued task",
        "disable-model-invocation: true",
        "---",
        "Follow the workflow in TASKS.md.",
        "",
      ].join("\n"),
    });
  });

  it("treats Cursor skills as native skills when translating to Codex", () => {
    // Given
    const files = {
      "SKILL.md": [
        "---",
        "name: next-task",
        "description: Handle the next queued task",
        "disable-model-invocation: true",
        "---",
        "",
        "Follow the workflow in TASKS.md.",
        "",
      ].join("\n"),
    };

    // When
    const transformed = translateSkill({
      sourceTool: "cursor",
      targetTool: "codex",
      files,
    });

    // Then
    expect(transformed).toEqual({
      ".agents/skills/next-task/SKILL.md": [
        "---",
        "name: next-task",
        "description: Handle the next queued task",
        "---",
        "Follow the workflow in TASKS.md.",
        "",
      ].join("\n"),
      ".agents/skills/next-task/agents/openai.yaml": [
        "policy:",
        "  allow_implicit_invocation: false",
        "",
      ].join("\n"),
    });
  });

  it("renders a native Cursor skill", () => {
    // Given
    const skill = {
      "SKILL.md": [
        "---",
        "name: reviewer",
        "description: Review changes",
        "---",
        "",
        "Review the current diff for bugs.",
        "",
      ].join("\n"),
    };

    // When / Then
    expect(
      translateSkill({
        sourceTool: "claude",
        targetTool: "cursor",
        files: skill,
      })[".cursor/skills/reviewer/SKILL.md"],
    ).toBe(
      [
        "---",
        "name: reviewer",
        "description: Review changes",
        "---",
        "Review the current diff for bugs.",
        "",
      ].join("\n"),
    );
  });

  it("renders OpenCode commands for manual-only skills and OpenCode skills otherwise", () => {
    // Given
    const claudeSkill = {
      "SKILL.md": [
        "---",
        "name: repo-guide",
        "description: Explain repo conventions",
        "disable-model-invocation: true",
        "---",
        "",
        "Use the established naming patterns.",
        "",
      ].join("\n"),
    };
    const openCodeSkill = {
      "SKILL.md": [
        "---",
        "name: repo-guide",
        "description: Explain repo conventions",
        "compatibility: opencode",
        "metadata:",
        "  owner: docs",
        "---",
        "",
        "Use the established naming patterns.",
        "",
      ].join("\n"),
    };

    // When / Then
    expect(
      translateSkill({
        sourceTool: "claude",
        targetTool: "opencode",
        files: claudeSkill,
      })[".opencode/commands/repo-guide.md"],
    ).toBe(
      [
        "---",
        "description: Explain repo conventions",
        "---",
        "Use the established naming patterns.",
        "",
      ].join("\n"),
    );
    expect(
      translateSkill({
        sourceTool: "opencode",
        targetTool: "codex",
        files: openCodeSkill,
      })[".agents/skills/repo-guide/SKILL.md"],
    ).toBe(
      [
        "---",
        "name: repo-guide",
        "description: Explain repo conventions",
        "---",
        "Use the established naming patterns.",
        "",
      ].join("\n"),
    );
  });

  it("renders OpenCode-compatible skills and strips unsupported metadata when needed", () => {
    // Given
    const claudeSkill = {
      "SKILL.md": [
        "---",
        "name: repo-guide",
        "description: Explain repo conventions",
        "---",
        "",
        "Use the established naming patterns.",
        "",
      ].join("\n"),
    };
    const openCodeSkill = {
      "SKILL.md": [
        "---",
        "name: repo-guide",
        "description: Explain repo conventions",
        "compatibility: opencode",
        "metadata:",
        "  owner: docs",
        "---",
        "",
        "Use the established naming patterns.",
        "",
      ].join("\n"),
    };

    // When / Then
    expect(
      translateSkill({
        sourceTool: "claude",
        targetTool: "opencode",
        files: claudeSkill,
      })[".opencode/skills/repo-guide/SKILL.md"],
    ).toBe(
      [
        "---",
        "name: repo-guide",
        "description: Explain repo conventions",
        "compatibility: opencode",
        "---",
        "Use the established naming patterns.",
        "",
      ].join("\n"),
    );
    expect(
      translateSkill({
        sourceTool: "opencode",
        targetTool: "codex",
        files: openCodeSkill,
      })[".agents/skills/repo-guide/SKILL.md"],
    ).toBe(
      [
        "---",
        "name: repo-guide",
        "description: Explain repo conventions",
        "---",
        "Use the established naming patterns.",
        "",
      ].join("\n"),
    );
  });

  it("renders native Cursor skills from Codex and OpenCode skills", () => {
    // Given
    const codexSkill = {
      ".agents/skills/repo-guide/SKILL.md": [
        "---",
        "name: repo-guide",
        "description: Explain repo conventions",
        "---",
        "",
        "Body",
        "",
      ].join("\n"),
    };
    const openCodeSkill = {
      "SKILL.md": [
        "---",
        "name: repo-guide",
        "description: Explain repo conventions",
        "compatibility: opencode",
        "---",
        "",
        "Body",
        "",
      ].join("\n"),
    };

    // When / Then
    expect(
      translateSkill({
        sourceTool: "codex",
        targetTool: "cursor",
        files: codexSkill,
      })[".cursor/skills/repo-guide/SKILL.md"],
    ).toBe(
      [
        "---",
        "name: repo-guide",
        "description: Explain repo conventions",
        "---",
        "Body",
        "",
      ].join("\n"),
    );
    expect(
      translateSkill({
        sourceTool: "opencode",
        targetTool: "cursor",
        files: openCodeSkill,
      })[".cursor/skills/repo-guide/SKILL.md"],
    ).toBe(
      [
        "---",
        "name: repo-guide",
        "description: Explain repo conventions",
        "---",
        "Body",
        "",
      ].join("\n"),
    );
  });

  it("renders a native Antigravity skill", () => {
    // Given
    const skill = {
      "SKILL.md": [
        "---",
        "name: reviewer",
        "description: Review changes",
        "---",
        "",
        "Review the current diff for bugs.",
        "",
      ].join("\n"),
    };

    // When / Then
    expect(
      translateSkill({
        sourceTool: "claude",
        targetTool: "antigravity",
        files: skill,
      })[".agent/skills/reviewer/SKILL.md"],
    ).toBe(
      [
        "---",
        "name: reviewer",
        "description: Review changes",
        "---",
        "Review the current diff for bugs.",
        "",
      ].join("\n"),
    );
  });

  it("applies name and description overrides from options", () => {
    // Given
    const files = {
      "SKILL.md": [
        "---",
        "name: react",
        "description: React patterns",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    };

    // When
    const translated = translateSkill({
      sourceTool: "claude",
      targetTool: "claude",
      files,
      options: { name: "react-v2", description: "Updated React patterns" },
    });

    // Then — overridden name used for directory path and metadata
    expect(Object.keys(translated)).toEqual([".claude/skills/react-v2/SKILL.md"]);
    expect(translated[".claude/skills/react-v2/SKILL.md"]).toContain(
      "name: react-v2",
    );
    expect(translated[".claude/skills/react-v2/SKILL.md"]).toContain(
      "description: Updated React patterns",
    );
  });

  it("applies name override for codex target", () => {
    // Given
    const files = {
      "SKILL.md": [
        "---",
        "name: react",
        "description: React patterns",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    };

    // When
    const translated = translateSkill({
      sourceTool: "claude",
      targetTool: "codex",
      files,
      options: { name: "react-v2" },
    });

    // Then — overridden name used for skill directory path
    expect(translated[".agents/skills/react-v2/SKILL.md"]).toBeDefined();
    expect(translated[".agents/skills/react-v2/SKILL.md"]).toContain(
      "name: react-v2",
    );
  });

  it("passes through extra files to the target skill directory", () => {
    // Given
    const files = {
      "SKILL.md": [
        "---",
        "name: react",
        "description: React patterns",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
      "assets/context.md": "Additional context\n",
      "templates/example.ts": "const x = 1;\n",
    };

    // When
    const translated = translateSkill({
      sourceTool: "claude",
      targetTool: "claude",
      files,
    });

    // Then
    expect(translated[".claude/skills/react/assets/context.md"]).toBe(
      "Additional context\n",
    );
    expect(translated[".claude/skills/react/templates/example.ts"]).toBe(
      "const x = 1;\n",
    );
  });

  it("passes through extra files when translating across tools", () => {
    // Given
    const files = {
      "SKILL.md": [
        "---",
        "name: react",
        "description: React patterns",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
      "assets/context.md": "Additional context\n",
    };

    // When / Then
    expect(
      translateSkill({ sourceTool: "claude", targetTool: "cursor", files })[
        ".cursor/skills/react/assets/context.md"
      ],
    ).toBe("Additional context\n");
    expect(
      translateSkill({ sourceTool: "claude", targetTool: "codex", files })[
        ".agents/skills/react/assets/context.md"
      ],
    ).toBe("Additional context\n");
    expect(
      translateSkill({ sourceTool: "claude", targetTool: "copilot", files })[
        ".github/skills/react/assets/context.md"
      ],
    ).toBe("Additional context\n");
    expect(
      translateSkill({ sourceTool: "claude", targetTool: "kiro", files })[
        ".kiro/skills/react/assets/context.md"
      ],
    ).toBe("Additional context\n");
    expect(
      translateSkill({ sourceTool: "claude", targetTool: "antigravity", files })[
        ".agent/skills/react/assets/context.md"
      ],
    ).toBe("Additional context\n");
    expect(
      translateSkill({ sourceTool: "claude", targetTool: "opencode", files })[
        ".opencode/skills/react/assets/context.md"
      ],
    ).toBe("Additional context\n");
  });

  it("strips the installed-path prefix from extra files during translation", () => {
    // Given — files keyed by their installed Claude Code paths
    const files = {
      ".claude/skills/react/SKILL.md": [
        "---",
        "name: react",
        "description: React patterns",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
      ".claude/skills/react/assets/context.md": "Additional context\n",
    };

    // When
    const translated = translateSkill({
      sourceTool: "claude",
      targetTool: "cursor",
      files,
    });

    // Then — prefix is stripped; file lands at the cursor skill path
    expect(translated[".cursor/skills/react/assets/context.md"]).toBe(
      "Additional context\n",
    );
  });

  it("excludes agents/openai.yaml from passthrough to non-codex targets", () => {
    // Given — source includes Codex policy file
    const files = {
      "SKILL.md": [
        "---",
        "name: react",
        "description: React patterns",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
      "agents/openai.yaml": "policy:\n  allow_implicit_invocation: false\n",
      "assets/context.md": "Additional context\n",
    };

    // When
    const translated = translateSkill({
      sourceTool: "codex",
      targetTool: "claude",
      files,
    });

    // Then — policy file is not copied; extra file is preserved
    expect(
      translated[".claude/skills/react/agents/openai.yaml"],
    ).toBeUndefined();
    expect(translated[".claude/skills/react/assets/context.md"]).toBe(
      "Additional context\n",
    );
  });

  it("does not pass through extra files for manual-only opencode skills (command output)", () => {
    // Given — manual-only skills render to a single .opencode/commands file
    const files = {
      "SKILL.md": [
        "---",
        "name: deploy",
        "description: Deploy the app",
        "disable-model-invocation: true",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
      "assets/context.md": "Additional context\n",
    };

    // When
    const translated = translateSkill({
      sourceTool: "claude",
      targetTool: "opencode",
      files,
    });

    // Then — single command file only; extra files are not included
    expect(Object.keys(translated)).toEqual([
      ".opencode/commands/deploy.md",
    ]);
  });
});

describe("translateCommand", () => {
  it("wraps a Cursor command into Claude and Codex manual-only surfaces", () => {
    // Given
    const source = "Review the changed files and summarize the risks.\n";

    // When / Then
    expect(
      translateCommand({
        sourceTool: "cursor",
        targetTool: "claude",
        source,
        options: {
          name: "review-changes",
          description: "Review changed files",
        },
      }),
    ).toEqual({
      ".claude/commands/review-changes.md": [
        "---",
        "description: Review changed files",
        "disable-model-invocation: true",
        "---",
        "Review the changed files and summarize the risks.",
        "",
      ].join("\n"),
    });
    expect(
      translateCommand({
        sourceTool: "cursor",
        targetTool: "codex",
        source,
        options: {
          name: "review-changes",
          description: "Review changed files",
        },
      }),
    ).toEqual({
      ".agents/skills/review-changes/SKILL.md": [
        "---",
        "name: review-changes",
        "description: Review changed files",
        "---",
        "Review the changed files and summarize the risks.",
        "",
      ].join("\n"),
      ".agents/skills/review-changes/agents/openai.yaml": [
        "policy:",
        "  allow_implicit_invocation: false",
        "",
      ].join("\n"),
    });
  });

  it("converts a Claude command to Cursor, OpenCode, and Codex forms", () => {
    // Given
    const source = [
      "---",
      "description: Review changed files",
      "disable-model-invocation: true",
      "agent: reviewer",
      "model: sonnet",
      "---",
      "",
      "Review the changed files and summarize the risks.",
      "",
    ].join("\n");

    // When / Then
    expect(
      translateCommand({
        sourceTool: "claude",
        targetTool: "cursor",
        source,
        options: { name: "review-changes" },
      }),
    ).toEqual({
      ".cursor/commands/review-changes.md":
        "Review the changed files and summarize the risks.\n",
    });
    expect(
      translateCommand({
        sourceTool: "claude",
        targetTool: "opencode",
        source,
        options: { name: "review-changes" },
      }),
    ).toEqual({
      ".opencode/commands/review-changes.md": [
        "---",
        "description: Review changed files",
        "agent: reviewer",
        "model: sonnet",
        "---",
        "Review the changed files and summarize the risks.",
        "",
      ].join("\n"),
    });
    expect(
      translateCommand({
        sourceTool: "claude",
        targetTool: "codex",
        source,
        options: { name: "review-changes" },
      }),
    ).toEqual({
      ".agents/skills/review-changes/SKILL.md": [
        "---",
        "name: review-changes",
        "description: Review changed files",
        "---",
        "Review the changed files and summarize the risks.",
        "",
      ].join("\n"),
      ".agents/skills/review-changes/agents/openai.yaml": [
        "policy:",
        "  allow_implicit_invocation: false",
        "",
      ].join("\n"),
    });
  });

  it("converts an OpenCode command to Claude, Cursor, and Codex forms", () => {
    // Given
    const source = [
      "---",
      "description: Review changed files",
      "agent: reviewer",
      "---",
      "",
      "Review the changed files and summarize the risks.",
      "",
    ].join("\n");

    // When / Then
    expect(
      translateCommand({
        sourceTool: "opencode",
        targetTool: "claude",
        source,
        options: { name: "review-changes" },
      }),
    ).toEqual({
      ".claude/commands/review-changes.md": [
        "---",
        "description: Review changed files",
        "disable-model-invocation: true",
        "---",
        "Review the changed files and summarize the risks.",
        "",
      ].join("\n"),
    });
    expect(
      translateCommand({
        sourceTool: "opencode",
        targetTool: "cursor",
        source,
        options: { name: "review-changes" },
      }),
    ).toEqual({
      ".cursor/commands/review-changes.md":
        "Review the changed files and summarize the risks.\n",
    });
    expect(
      translateCommand({
        sourceTool: "opencode",
        targetTool: "codex",
        source,
        options: { name: "review-changes" },
      }),
    ).toEqual({
      ".agents/skills/review-changes/SKILL.md": [
        "---",
        "name: review-changes",
        "description: Review changed files",
        "---",
        "Review the changed files and summarize the risks.",
        "",
      ].join("\n"),
      ".agents/skills/review-changes/agents/openai.yaml": [
        "policy:",
        "  allow_implicit_invocation: false",
        "",
      ].join("\n"),
    });
  });

  it("renders an OpenCode command from Cursor markdown", () => {
    // Given
    const source = "Run tests and summarize any failures.\n";

    // When
    const transformed = translateCommand({
      sourceTool: "cursor",
      targetTool: "opencode",
      source,
      options: { name: "run-tests", description: "Run tests" },
    });

    // Then
    expect(transformed).toEqual({
      ".opencode/commands/run-tests.md": [
        "---",
        "description: Run tests",
        "---",
        "Run tests and summarize any failures.",
        "",
      ].join("\n"),
    });
  });

  it("renders an Antigravity workflow from a Claude command", () => {
    // Given
    const source = [
      "---",
      "description: Review changed files",
      "---",
      "",
      "Review the changed files and summarize the risks.",
      "",
    ].join("\n");

    // When
    const transformed = translateCommand({
      sourceTool: "claude",
      targetTool: "antigravity",
      source,
      options: { name: "review-changes" },
    });

    // Then
    expect(transformed).toEqual({
      ".agent/workflows/review-changes.md": [
        "---",
        "description: Review changed files",
        "---",
        "Review the changed files and summarize the risks.",
        "",
      ].join("\n"),
    });
  });

  it("renders a plain Antigravity workflow when there is no description", () => {
    // Given
    const source = "Review the changed files and summarize the risks.\n";

    // When
    const transformed = translateCommand({
      sourceTool: "cursor",
      targetTool: "antigravity",
      source,
      options: { name: "review-changes" },
    });

    // Then
    expect(transformed).toEqual({
      ".agent/workflows/review-changes.md":
        "Review the changed files and summarize the risks.\n",
    });
  });

  it("converts an Antigravity workflow back into a Claude command", () => {
    // Given
    const source = [
      "---",
      "description: Review changed files",
      "---",
      "Review the changed files and summarize the risks.",
      "",
    ].join("\n");

    // When
    const transformed = translateCommand({
      sourceTool: "antigravity",
      targetTool: "claude",
      source,
      options: { name: "review-changes" },
    });

    // Then
    expect(transformed).toEqual({
      ".claude/commands/review-changes.md": [
        "---",
        "description: Review changed files",
        "disable-model-invocation: true",
        "---",
        "Review the changed files and summarize the risks.",
        "",
      ].join("\n"),
    });
  });

  it("requires a command name for targets with named command output", () => {
    // Given
    const source = "Review the changed files and summarize the risks.\n";

    // When / Then
    expect(() =>
      translateCommand({
        sourceTool: "cursor",
        targetTool: "claude",
        source,
        options: { description: "Review changed files" },
      }),
    ).toThrow("name is required");
    expect(() =>
      translateCommand({
        sourceTool: "cursor",
        targetTool: "cursor",
        source,
      }),
    ).toThrow("name is required");
    expect(() =>
      translateCommand({
        sourceTool: "cursor",
        targetTool: "opencode",
        source,
      }),
    ).toThrow("name is required");
    expect(() =>
      translateCommand({
        sourceTool: "cursor",
        targetTool: "codex",
        source,
      }),
    ).toThrow("name is required");
  });
});

describe("translateAgent", () => {
  it("renders a Codex custom agent TOML file from Claude subagent markdown", () => {
    // Given
    const source = [
      "---",
      "name: code-reviewer",
      "description: Review code for bugs and risks",
      "model: sonnet",
      "---",
      "",
      "Review the diff for correctness and missing tests.",
      "",
    ].join("\n");

    // When
    const transformed = translateAgent({
      sourceTool: "claude",
      targetTool: "codex",
      source,
    });

    // Then
    expect(transformed).toEqual({
      ".codex/agents/code-reviewer.toml": [
        'name = "code-reviewer"',
        'description = "Review code for bugs and risks"',
        'model = "sonnet"',
        'developer_instructions = """',
        "Review the diff for correctness and missing tests.",
        '"""',
        "",
      ].join("\n"),
    });
  });

  it("converts a Codex agent back into Claude markdown", () => {
    // Given
    const source = [
      'name = "code-reviewer"',
      'description = "Review code for bugs and risks"',
      'model = "gpt-5.4"',
      'developer_instructions = """',
      "Review the diff for correctness and missing tests.",
      '"""',
      "",
    ].join("\n");

    // When
    const transformed = translateAgent({
      sourceTool: "codex",
      targetTool: "claude",
      source,
    });

    // Then
    expect(transformed).toEqual({
      ".claude/agents/code-reviewer.md": [
        "---",
        "name: code-reviewer",
        "description: Review code for bugs and risks",
        "model: gpt-5.4",
        "---",
        "Review the diff for correctness and missing tests.",
        "",
      ].join("\n"),
    });
  });

  it("converts Claude and Codex agents into OpenCode markdown agents", () => {
    // When / Then
    expect(
      translateAgent({
        sourceTool: "claude",
        targetTool: "opencode",
        source: [
          "---",
          "name: code-reviewer",
          "description: Review code for bugs and risks",
          "model: sonnet",
          "---",
          "",
          "Review the diff for correctness and missing tests.",
          "",
        ].join("\n"),
      }),
    ).toEqual({
      ".opencode/agents/code-reviewer.md": [
        "---",
        "name: code-reviewer",
        "description: Review code for bugs and risks",
        "model: sonnet",
        "mode: subagent",
        "---",
        "Review the diff for correctness and missing tests.",
        "",
      ].join("\n"),
    });
    expect(
      translateAgent({
        sourceTool: "codex",
        targetTool: "opencode",
        source: [
          'name = "code-reviewer"',
          'description = "Review code for bugs and risks"',
          'model = "gpt-5.4"',
          'developer_instructions = """',
          "Review the diff for correctness and missing tests.",
          '"""',
          "",
        ].join("\n"),
      }),
    ).toEqual({
      ".opencode/agents/code-reviewer.md": [
        "---",
        "name: code-reviewer",
        "description: Review code for bugs and risks",
        "model: gpt-5.4",
        "mode: subagent",
        "---",
        "Review the diff for correctness and missing tests.",
        "",
      ].join("\n"),
    });
  });

  it("converts Claude and Codex agents into Cursor markdown agents", () => {
    // When / Then
    expect(
      translateAgent({
        sourceTool: "claude",
        targetTool: "cursor",
        source: [
          "---",
          "name: code-reviewer",
          "description: Review code for bugs and risks",
          "model: sonnet",
          "---",
          "",
          "Review the diff for correctness and missing tests.",
          "",
        ].join("\n"),
      }),
    ).toEqual({
      ".cursor/agents/code-reviewer.md": [
        "---",
        "name: code-reviewer",
        "description: Review code for bugs and risks",
        "model: sonnet",
        "---",
        "Review the diff for correctness and missing tests.",
        "",
      ].join("\n"),
    });
    expect(
      translateAgent({
        sourceTool: "codex",
        targetTool: "cursor",
        source: [
          'name = "code-reviewer"',
          'description = "Review code for bugs and risks"',
          'model = "gpt-5.4"',
          'developer_instructions = """',
          "Review the diff for correctness and missing tests.",
          '"""',
          "",
        ].join("\n"),
      }),
    ).toEqual({
      ".cursor/agents/code-reviewer.md": [
        "---",
        "name: code-reviewer",
        "description: Review code for bugs and risks",
        "model: gpt-5.4",
        "---",
        "Review the diff for correctness and missing tests.",
        "",
      ].join("\n"),
    });
  });

  it("converts an OpenCode agent into Claude and Codex agent forms", () => {
    // Given
    const source = [
      "---",
      "name: code-reviewer",
      "description: Review code for bugs and risks",
      "mode: subagent",
      "model: sonnet",
      "---",
      "",
      "Review the diff for correctness and missing tests.",
      "",
    ].join("\n");

    // When / Then
    expect(
      translateAgent({
        sourceTool: "opencode",
        targetTool: "claude",
        source,
      }),
    ).toEqual({
      ".claude/agents/code-reviewer.md": [
        "---",
        "name: code-reviewer",
        "description: Review code for bugs and risks",
        "model: sonnet",
        "---",
        "Review the diff for correctness and missing tests.",
        "",
      ].join("\n"),
    });
    expect(
      translateAgent({
        sourceTool: "opencode",
        targetTool: "codex",
        source,
      }),
    ).toEqual({
      ".codex/agents/code-reviewer.toml": [
        'name = "code-reviewer"',
        'description = "Review code for bugs and risks"',
        'model = "sonnet"',
        'developer_instructions = """',
        "Review the diff for correctness and missing tests.",
        '"""',
        "",
      ].join("\n"),
    });
  });
});

describe("copilot agent translation", () => {
  it("renders a Claude agent as a Copilot agent with .agent.md extension", () => {
    // Given
    const source = [
      "---",
      "name: code-reviewer",
      "description: Review code for bugs and risks",
      "model: sonnet",
      "---",
      "",
      "Review the diff for correctness and missing tests.",
      "",
    ].join("\n");

    // When
    const translated = translateAgent({
      sourceTool: "claude",
      targetTool: "copilot",
      source,
    });

    // Then
    expect(translated).toEqual({
      ".github/agents/code-reviewer.agent.md": [
        "---",
        "name: code-reviewer",
        "description: Review code for bugs and risks",
        "model: sonnet",
        "---",
        "Review the diff for correctness and missing tests.",
        "",
      ].join("\n"),
    });
  });

  it("converts a Copilot agent back into a Claude agent", () => {
    // Given
    const source = [
      "---",
      "name: code-reviewer",
      "description: Review code for bugs and risks",
      "---",
      "",
      "Review the diff for correctness and missing tests.",
      "",
    ].join("\n");

    // When
    const translated = translateAgent({
      sourceTool: "copilot",
      targetTool: "claude",
      source,
    });

    // Then
    expect(translated).toEqual({
      ".claude/agents/code-reviewer.md": [
        "---",
        "name: code-reviewer",
        "description: Review code for bugs and risks",
        "---",
        "Review the diff for correctness and missing tests.",
        "",
      ].join("\n"),
    });
  });
});

describe("kiro agent translation", () => {
  it("renders a Claude agent as a Kiro agent with .md extension", () => {
    // Given
    const source = [
      "---",
      "name: code-reviewer",
      "description: Review code for bugs and risks",
      "model: sonnet",
      "---",
      "",
      "Review the diff for correctness and missing tests.",
      "",
    ].join("\n");

    // When
    const translated = translateAgent({
      sourceTool: "claude",
      targetTool: "kiro",
      source,
    });

    // Then
    expect(translated).toEqual({
      ".kiro/agents/code-reviewer.md": [
        "---",
        "name: code-reviewer",
        "description: Review code for bugs and risks",
        "model: sonnet",
        "---",
        "Review the diff for correctness and missing tests.",
        "",
      ].join("\n"),
    });
  });

  it("converts a Kiro agent back into a Claude agent", () => {
    // Given
    const source = [
      "---",
      "name: code-reviewer",
      "description: Review code for bugs and risks",
      "---",
      "",
      "Review the diff for correctness and missing tests.",
      "",
    ].join("\n");

    // When
    const translated = translateAgent({
      sourceTool: "kiro",
      targetTool: "claude",
      source,
    });

    // Then
    expect(translated).toEqual({
      ".claude/agents/code-reviewer.md": [
        "---",
        "name: code-reviewer",
        "description: Review code for bugs and risks",
        "---",
        "Review the diff for correctness and missing tests.",
        "",
      ].join("\n"),
    });
  });
});

describe("copilot ↔ kiro agent round-trip", () => {
  it("translates a Copilot agent to Kiro and back", () => {
    // Given
    const source = [
      "---",
      "name: code-reviewer",
      "description: Review code for bugs and risks",
      "model: sonnet",
      "---",
      "",
      "Review the diff for correctness and missing tests.",
      "",
    ].join("\n");

    // The markdown parser strips the leading blank line from the body on render
    const rendered = [
      "---",
      "name: code-reviewer",
      "description: Review code for bugs and risks",
      "model: sonnet",
      "---",
      "Review the diff for correctness and missing tests.",
      "",
    ].join("\n");

    // When
    const toKiro = translateAgent({
      sourceTool: "copilot",
      targetTool: "kiro",
      source,
    });
    const backToCopilot = translateAgent({
      sourceTool: "kiro",
      targetTool: "copilot",
      source: toKiro[".kiro/agents/code-reviewer.md"]!,
    });

    // Then
    expect(toKiro).toEqual({ ".kiro/agents/code-reviewer.md": rendered });
    expect(backToCopilot).toEqual({
      ".github/agents/code-reviewer.agent.md": rendered,
    });
  });

  it("translates a Copilot agent to OpenCode (adds mode: subagent)", () => {
    // Given
    const source = [
      "---",
      "name: code-reviewer",
      "description: Review code for bugs and risks",
      "---",
      "",
      "Review the diff for correctness and missing tests.",
      "",
    ].join("\n");

    // When
    const translated = translateAgent({
      sourceTool: "copilot",
      targetTool: "opencode",
      source,
    });

    // Then
    expect(translated).toEqual({
      ".opencode/agents/code-reviewer.md": [
        "---",
        "name: code-reviewer",
        "description: Review code for bugs and risks",
        "mode: subagent",
        "---",
        "Review the diff for correctness and missing tests.",
        "",
      ].join("\n"),
    });
  });
});

describe("copilot skill translation", () => {
  it("renders a canonical Claude skill to a Copilot skill", () => {
    // Given
    const files = {
      "SKILL.md": [
        "---",
        "name: reviewer",
        "description: Review changes for bugs",
        "---",
        "",
        "Review the current diff for correctness.",
        "",
      ].join("\n"),
    };

    // When
    const translated = translateSkill({
      sourceTool: "claude",
      targetTool: "copilot",
      files,
    });

    // Then
    expect(translated).toEqual({
      ".github/skills/reviewer/SKILL.md": [
        "---",
        "name: reviewer",
        "description: Review changes for bugs",
        "---",
        "Review the current diff for correctness.",
        "",
      ].join("\n"),
    });
  });

  it("preserves disable-model-invocation when translating to Copilot", () => {
    // Given
    const files = {
      "SKILL.md": [
        "---",
        "name: next-task",
        "description: Handle the next queued task",
        "disable-model-invocation: true",
        "---",
        "",
        "Follow the workflow in TASKS.md.",
        "",
      ].join("\n"),
    };

    // When
    const translated = translateSkill({
      sourceTool: "claude",
      targetTool: "copilot",
      files,
    });

    // Then
    expect(translated).toEqual({
      ".github/skills/next-task/SKILL.md": [
        "---",
        "name: next-task",
        "description: Handle the next queued task",
        "disable-model-invocation: true",
        "---",
        "Follow the workflow in TASKS.md.",
        "",
      ].join("\n"),
    });
  });

  it("accepts installed Copilot skill paths as source input", () => {
    // Given
    const files = {
      ".github/skills/reviewer/SKILL.md": [
        "---",
        "name: reviewer",
        "description: Review changes for bugs",
        "---",
        "",
        "Review the current diff for correctness.",
        "",
      ].join("\n"),
    };

    // When
    const translated = translateSkill({
      sourceTool: "copilot",
      targetTool: "claude",
      files,
    });

    // Then
    expect(translated).toEqual({
      ".claude/skills/reviewer/SKILL.md": [
        "---",
        "name: reviewer",
        "description: Review changes for bugs",
        "---",
        "Review the current diff for correctness.",
        "",
      ].join("\n"),
    });
  });

  it("round-trips a skill between Copilot and Codex", () => {
    // Given
    const files = {
      "SKILL.md": [
        "---",
        "name: deploy",
        "description: Run the deployment pipeline",
        "---",
        "",
        "Execute deploy.sh and verify the health check.",
        "",
      ].join("\n"),
    };

    // When
    const toCopilot = translateSkill({
      sourceTool: "claude",
      targetTool: "copilot",
      files,
    });
    const toCodex = translateSkill({
      sourceTool: "copilot",
      targetTool: "codex",
      files: toCopilot,
    });

    // Then
    expect(toCopilot[".github/skills/deploy/SKILL.md"]).toBeDefined();
    expect(toCodex[".agents/skills/deploy/SKILL.md"]).toBeDefined();
  });
});

describe("kiro skill translation", () => {
  it("renders a canonical Claude skill to a Kiro skill", () => {
    // Given
    const files = {
      "SKILL.md": [
        "---",
        "name: reviewer",
        "description: Review changes for bugs",
        "---",
        "",
        "Review the current diff for correctness.",
        "",
      ].join("\n"),
    };

    // When
    const translated = translateSkill({
      sourceTool: "claude",
      targetTool: "kiro",
      files,
    });

    // Then
    expect(translated).toEqual({
      ".kiro/skills/reviewer/SKILL.md": [
        "---",
        "name: reviewer",
        "description: Review changes for bugs",
        "---",
        "Review the current diff for correctness.",
        "",
      ].join("\n"),
    });
  });

  it("accepts installed Kiro skill paths as source input", () => {
    // Given
    const files = {
      ".kiro/skills/reviewer/SKILL.md": [
        "---",
        "name: reviewer",
        "description: Review changes for bugs",
        "---",
        "",
        "Review the current diff for correctness.",
        "",
      ].join("\n"),
    };

    // When
    const translated = translateSkill({
      sourceTool: "kiro",
      targetTool: "claude",
      files,
    });

    // Then
    expect(translated).toEqual({
      ".claude/skills/reviewer/SKILL.md": [
        "---",
        "name: reviewer",
        "description: Review changes for bugs",
        "---",
        "Review the current diff for correctness.",
        "",
      ].join("\n"),
    });
  });
});

describe("YAML frontmatter parser", () => {
  it("strips double quotes from scalar values", () => {
    // Given
    const files = {
      "SKILL.md": [
        "---",
        'name: "my-skill"',
        'description: "Handle the next queued task"',
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    };

    // When
    const translated = translateSkill({
      sourceTool: "claude",
      targetTool: "cursor",
      files,
    });

    // Then
    expect(translated).toEqual({
      ".cursor/skills/my-skill/SKILL.md": [
        "---",
        "name: my-skill",
        "description: Handle the next queued task",
        "---",
        "Body.",
        "",
      ].join("\n"),
    });
  });

  it("strips single quotes from scalar values", () => {
    // Given
    const files = {
      "SKILL.md": [
        "---",
        "name: 'my-skill'",
        "description: 'Handle the next queued task'",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    };

    // When
    const translated = translateSkill({
      sourceTool: "claude",
      targetTool: "cursor",
      files,
    });

    // Then
    expect(translated).toEqual({
      ".cursor/skills/my-skill/SKILL.md": [
        "---",
        "name: my-skill",
        "description: Handle the next queued task",
        "---",
        "Body.",
        "",
      ].join("\n"),
    });
  });

  it("preserves colons inside values", () => {
    // Given
    const files = {
      "SKILL.md": [
        "---",
        "name: my-skill",
        "description: Task: handle the next queued task",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    };

    // When
    const translated = translateSkill({
      sourceTool: "claude",
      targetTool: "cursor",
      files,
    });

    // Then
    expect(translated).toEqual({
      ".cursor/skills/my-skill/SKILL.md": [
        "---",
        "name: my-skill",
        "description: Task: handle the next queued task",
        "---",
        "Body.",
        "",
      ].join("\n"),
    });
  });

  it("does not corrupt a scalar value when a bare list item appears at column 0 after a root-level key", () => {
    // Given — malformed YAML: `- item` with no leading spaces after a root-level key.
    // Without the lastKeyIndent guard this would silently replace `name` with an array.
    const files = {
      "SKILL.md": [
        "---",
        "name: my-skill",
        "- stray",
        "description: My description",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    };

    // When
    const translated = translateSkill({
      sourceTool: "claude",
      targetTool: "cursor",
      files,
    });

    // Then — name is the original scalar; the stray list item is ignored
    expect(translated[".cursor/skills/my-skill/SKILL.md"]).toContain(
      "name: my-skill",
    );
    expect(translated[".cursor/skills/my-skill/SKILL.md"]).toContain(
      "description: My description",
    );
  });

  it("does not throw on list fields in frontmatter and preserves scalar fields", () => {
    // Given — list fields are not used by any model parser but must not crash
    const files = {
      "SKILL.md": [
        "---",
        "name: my-skill",
        "description: My description",
        "tags:",
        "  - tag1",
        "  - tag2",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    };

    // When
    const translated = translateSkill({
      sourceTool: "claude",
      targetTool: "cursor",
      files,
    });

    // Then — name and description survive the round-trip regardless of the list field
    expect(translated[".cursor/skills/my-skill/SKILL.md"]).toContain(
      "name: my-skill",
    );
    expect(translated[".cursor/skills/my-skill/SKILL.md"]).toContain(
      "description: My description",
    );
  });
});

describe("translateRootInstruction", () => {
  it("writes content to AGENTS.md for antigravity", () => {
    // Given / When / Then
    expect(
      translateRootInstruction({
        targetTool: "antigravity",
        source: "Follow the repo conventions.\n",
      }),
    ).toEqual({
      "AGENTS.md": "Follow the repo conventions.\n",
    });
  });

  it("writes content to CLAUDE.md for claude", () => {
    // Given / When / Then
    expect(
      translateRootInstruction({
        targetTool: "claude",
        source: "Follow the repo conventions.\n",
      }),
    ).toEqual({
      "CLAUDE.md": "Follow the repo conventions.\n",
    });
  });

  it("writes content to AGENTS.md for codex", () => {
    // Given / When / Then
    expect(
      translateRootInstruction({
        targetTool: "codex",
        source: "Follow the repo conventions.\n",
      }),
    ).toEqual({
      "AGENTS.md": "Follow the repo conventions.\n",
    });
  });
});
