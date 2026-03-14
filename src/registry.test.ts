import { describe, expect, it } from "vitest";

import { createEmptyRegistry, parseRegistry } from "./registry";

describe("createEmptyRegistry", () => {
  it("returns an empty registry shape", () => {
    expect(createEmptyRegistry()).toEqual({
      repos: {},
      worktrees: {},
    });
  });
});

describe("parseRegistry", () => {
  it("accepts a registry with repository intent and worktree materialization", () => {
    expect(
      parseRegistry({
        repos: {
          repo_abc123: {
            repo_root: "/Users/dev/project",
            remote_url: "git@github.com:org/project.git",
            desired_state: {
              tool: "claude-code",
              bundle: "react-expert",
              mode: "stealth",
            },
          },
        },
        worktrees: {
          worktree_xyz789: {
            repo_fingerprint: "repo_abc123",
            path: "/Users/dev/project",
            materialized_state: {
              tool: "claude-code",
              bundle: "react-expert",
              mode: "stealth",
              files: [".claude/skills/react/SKILL.md", ".claude/commands/review.md"],
              exclude_configured: true,
            },
          },
        },
      }),
    ).toEqual({
      repos: {
        repo_abc123: {
          repo_root: "/Users/dev/project",
          remote_url: "git@github.com:org/project.git",
          desired_state: {
            tool: "claude-code",
            bundle: "react-expert",
            mode: "stealth",
          },
        },
      },
      worktrees: {
        worktree_xyz789: {
          repo_fingerprint: "repo_abc123",
          path: "/Users/dev/project",
          materialized_state: {
            tool: "claude-code",
            bundle: "react-expert",
            mode: "stealth",
            files: [".claude/skills/react/SKILL.md", ".claude/commands/review.md"],
            exclude_configured: true,
          },
        },
      },
    });
  });

  it("allows repository entries without a remote url", () => {
    expect(
      parseRegistry({
        repos: {
          repo_abc123: {
            repo_root: "/Users/dev/project",
            desired_state: {
              tool: "cursor",
              bundle: "nextjs-minimal",
              mode: "tracked",
            },
          },
        },
        worktrees: {},
      }),
    ).toEqual({
      repos: {
        repo_abc123: {
          repo_root: "/Users/dev/project",
          desired_state: {
            tool: "cursor",
            bundle: "nextjs-minimal",
            mode: "tracked",
          },
        },
      },
      worktrees: {},
    });
  });

  it("rejects malformed top-level objects", () => {
    expect(() => parseRegistry(null)).toThrowError(/registry must be an object/i);
    expect(() => parseRegistry({ repos: [], worktrees: {} })).toThrowError(
      /repos must be an object/i,
    );
    expect(() => parseRegistry({ repos: {}, worktrees: [] })).toThrowError(
      /worktrees must be an object/i,
    );
  });

  it.each([
    [
      "repo desired state with an invalid mode",
      {
        repos: {
          repo_abc123: {
            repo_root: "/Users/dev/project",
            desired_state: {
              tool: "claude-code",
              bundle: "react-expert",
              mode: "hidden",
            },
          },
        },
        worktrees: {},
      },
      /repos\.repo_abc123\.desired_state\.mode must be "stealth" or "tracked"/i,
    ],
    [
      "worktree materialized state with a missing file list",
      {
        repos: {
          repo_abc123: {
            repo_root: "/Users/dev/project",
            desired_state: {
              tool: "claude-code",
              bundle: "react-expert",
              mode: "stealth",
            },
          },
        },
        worktrees: {
          worktree_xyz789: {
            repo_fingerprint: "repo_abc123",
            path: "/Users/dev/project",
            materialized_state: {
              tool: "claude-code",
              bundle: "react-expert",
              mode: "stealth",
              exclude_configured: true,
            },
          },
        },
      },
      /worktrees\.worktree_xyz789\.materialized_state\.files must be an array/i,
    ],
    [
      "worktree materialized state with an absolute managed file path",
      {
        repos: {
          repo_abc123: {
            repo_root: "/Users/dev/project",
            desired_state: {
              tool: "claude-code",
              bundle: "react-expert",
              mode: "stealth",
            },
          },
        },
        worktrees: {
          worktree_xyz789: {
            repo_fingerprint: "repo_abc123",
            path: "/Users/dev/project",
            materialized_state: {
              tool: "claude-code",
              bundle: "react-expert",
              mode: "stealth",
              files: ["/Users/dev/project/.claude/skills/react/SKILL.md"],
              exclude_configured: true,
            },
          },
        },
      },
      /worktrees\.worktree_xyz789\.materialized_state\.files\[0\] must be a relative path/i,
    ],
  ])("rejects %s", (_label, input, expectedMessage) => {
    expect(() => parseRegistry(input)).toThrowError(expectedMessage);
  });

  it("rejects worktrees that point at an unknown repository", () => {
    expect(() =>
      parseRegistry({
        repos: {},
        worktrees: {
          worktree_xyz789: {
            repo_fingerprint: "repo_missing",
            path: "/Users/dev/project",
            materialized_state: {
              tool: "claude-code",
              bundle: "react-expert",
              mode: "stealth",
              files: [".claude/skills/react/SKILL.md"],
              exclude_configured: true,
            },
          },
        },
      }),
    ).toThrowError(
      /worktrees\.worktree_xyz789\.repo_fingerprint must reference a repository entry/i,
    );
  });
});
