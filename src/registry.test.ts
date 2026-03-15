import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createEmptyRegistry,
  listManagedPathsForRemoval,
  parseRegistry,
  readRegistryFile,
  removeWorktreeState,
  upsertRepoState,
  upsertWorktreeState,
  writeRegistryFile,
} from "./registry";

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
            },
          },
        },
        worktrees: {},
    });
  });

  it("preserves explicit ownership directories for worktree cleanup", () => {
    expect(
      parseRegistry({
        repos: {
          repo_abc123: {
            repo_root: "/Users/dev/project",
            desired_state: {
              tool: "claude-code",
              bundle: "react-expert",
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
              files: [".claude/skills/react/SKILL.md"],
              directories: [".claude/skills/react"],
              exclude_configured: true,
            },
          },
        },
      }),
    ).toMatchObject({
      worktrees: {
        worktree_xyz789: {
          materialized_state: {
            directories: [".claude/skills/react"],
          },
        },
      },
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
      "worktree materialized state with a missing file list",
      {
        repos: {
          repo_abc123: {
            repo_root: "/Users/dev/project",
            desired_state: {
              tool: "claude-code",
              bundle: "react-expert",
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

describe("registry persistence", () => {
  it("returns an empty registry when the registry file is missing", () => {
    // Given
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-registry-"));
    const registryFile = path.join(homeDir, ".skul", "registry.json");

    // When / Then
    expect(readRegistryFile(registryFile)).toEqual(createEmptyRegistry());

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("writes and reads repository intent and worktree ownership records", () => {
    // Given
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-registry-"));
    const registryFile = path.join(homeDir, ".skul", "registry.json");

    const withRepoState = upsertRepoState(createEmptyRegistry(), "repo_abc123", {
      repo_root: "/Users/dev/project",
      desired_state: {
        tool: "claude-code",
        bundle: "react-expert",
      },
    });
    const withWorktreeState = upsertWorktreeState(withRepoState, "worktree_xyz789", {
      repo_fingerprint: "repo_abc123",
      path: "/Users/dev/project",
      materialized_state: {
        tool: "claude-code",
        bundle: "react-expert",
        files: [".claude/skills/react/SKILL.md"],
        directories: [".claude/skills/react"],
        exclude_configured: true,
      },
    });

    // When
    writeRegistryFile(registryFile, withWorktreeState);

    // Then
    expect(readRegistryFile(registryFile)).toEqual(withWorktreeState);

    fs.rmSync(homeDir, { recursive: true, force: true });
  });
});

describe("ownership helpers", () => {
  it("rejects worktree ownership records that reference unknown repositories", () => {
    // Given / When / Then
    expect(() =>
      upsertWorktreeState(createEmptyRegistry(), "worktree_xyz789", {
        repo_fingerprint: "repo_missing",
        path: "/Users/dev/project",
        materialized_state: {
          tool: "claude-code",
          bundle: "react-expert",
          files: [".claude/skills/react/SKILL.md"],
          exclude_configured: true,
        },
      }),
    ).toThrowError(
      /worktrees\.worktree_xyz789\.repo_fingerprint must reference a repository entry/i,
    );
  });

  it("lists only registry-owned paths in removal order", () => {
    // Given / When / Then
    expect(
      listManagedPathsForRemoval({
        tool: "claude-code",
        bundle: "react-expert",
        files: [
          ".claude/commands/review.md",
          ".claude/skills/react/assets/context.md",
          ".claude/skills/react/SKILL.md",
        ],
        directories: [
          ".claude/skills/react",
          ".claude/skills/react/assets",
        ],
        exclude_configured: true,
      }),
    ).toEqual([
      ".claude/skills/react/assets/context.md",
      ".claude/skills/react/SKILL.md",
      ".claude/commands/review.md",
      ".claude/skills/react/assets",
      ".claude/skills/react",
    ]);
  });

  it("removes only the targeted worktree record", () => {
    // Given
    const registry = parseRegistry({
      repos: {
        repo_abc123: {
          repo_root: "/Users/dev/project",
          desired_state: {
            tool: "claude-code",
            bundle: "react-expert",
          },
        },
      },
      worktrees: {
        worktree_first: {
          repo_fingerprint: "repo_abc123",
          path: "/Users/dev/project",
          materialized_state: {
            tool: "claude-code",
            bundle: "react-expert",
            files: [".claude/skills/react/SKILL.md"],
            exclude_configured: true,
          },
        },
        worktree_second: {
          repo_fingerprint: "repo_abc123",
          path: "/Users/dev/project-second",
          materialized_state: {
            tool: "claude-code",
            bundle: "react-expert",
            files: [".claude/skills/react/SKILL.md"],
            exclude_configured: true,
          },
        },
      },
    });

    // When / Then
    expect(removeWorktreeState(registry, "worktree_first")).toEqual({
      repos: registry.repos,
      worktrees: {
        worktree_second: registry.worktrees.worktree_second,
      },
    });
  });
});
