import { describe, expect, it } from "vitest";

import { translateAgent, translateCommand, translateSkill } from "./bundle-translation";

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
      ".agents/skills/next-task/agents/openai.yaml": ["policy:", "  allow_implicit_invocation: false", ""].join("\n"),
    });
  });

  it("maps Codex invocation policy back to Claude skill frontmatter", () => {
    // Given
    const files = {
      "SKILL.md": ["---", "name: next-task", "description: Handle the next queued task", "---", "", "Body", ""].join(
        "\n",
      ),
      "agents/openai.yaml": ["policy:", "  allow_implicit_invocation: false", ""].join("\n"),
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
      ".agents/skills/next-task/agents/openai.yaml": ["policy:", "  allow_implicit_invocation: false", ""].join("\n"),
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
      ".agents/skills/next-task/agents/openai.yaml": ["policy:", "  allow_implicit_invocation: false", ""].join("\n"),
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
    ).toBe(["---", "name: reviewer", "description: Review changes", "---", "Review the current diff for bugs.", ""].join("\n"));
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
    ).toBe(["---", "name: repo-guide", "description: Explain repo conventions", "---", "Body", ""].join("\n"));
    expect(
      translateSkill({
        sourceTool: "opencode",
        targetTool: "cursor",
        files: openCodeSkill,
      })[".cursor/skills/repo-guide/SKILL.md"],
    ).toBe(["---", "name: repo-guide", "description: Explain repo conventions", "---", "Body", ""].join("\n"));
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
        options: { name: "review-changes", description: "Review changed files" },
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
      ".agents/skills/review-changes/agents/openai.yaml": ["policy:", "  allow_implicit_invocation: false", ""].join("\n"),
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
      ".cursor/commands/review-changes.md": "Review the changed files and summarize the risks.\n",
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
      ".agents/skills/review-changes/agents/openai.yaml": ["policy:", "  allow_implicit_invocation: false", ""].join("\n"),
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
      ".cursor/commands/review-changes.md": "Review the changed files and summarize the risks.\n",
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
      ".agents/skills/review-changes/agents/openai.yaml": ["policy:", "  allow_implicit_invocation: false", ""].join("\n"),
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
