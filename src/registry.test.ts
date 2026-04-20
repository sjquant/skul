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

// Shared fixture builders
const REPO_FINGERPRINT = "repo_abc123";
const WORKTREE_ID = "worktree_xyz789";

function makeRepoEntry(overrides: object = {}) {
  return {
    repo_root: "/Users/dev/project",
    desired_state: [{ bundle: "react-expert", protocol: "https" }],
    ...overrides,
  };
}

function makeWorktreeEntry(overrides: object = {}) {
  return {
    repo_fingerprint: REPO_FINGERPRINT,
    path: "/Users/dev/project",
    materialized_state: {
      bundles: {
        "react-expert": {
          tools: {
            "claude-code": {
              files: [".claude/skills/react/SKILL.md"],
            },
          },
        },
      },
      exclude_configured: true,
    },
    ...overrides,
  };
}

function makeRegistry(overrides: object = {}) {
  return {
    version: 1,
    repos: { [REPO_FINGERPRINT]: makeRepoEntry() },
    worktrees: { [WORKTREE_ID]: makeWorktreeEntry() },
    ...overrides,
  };
}

describe("createEmptyRegistry", () => {
  it("returns an empty registry shape", () => {
    expect(createEmptyRegistry()).toEqual({
      version: 1,
      repos: {},
      worktrees: {},
    });
  });
});

describe("parseRegistry", () => {
  it("accepts a registry with repository intent and worktree materialization", () => {
    expect(
      parseRegistry({
        version: 1,
        repos: {
          [REPO_FINGERPRINT]: {
            repo_root: "/Users/dev/project",
            remote_url: "git@github.com:org/project.git",
            desired_state: [{ bundle: "react-expert", protocol: "https" }],
          },
        },
        worktrees: {
          [WORKTREE_ID]: {
            repo_fingerprint: REPO_FINGERPRINT,
            path: "/Users/dev/project",
            materialized_state: {
              bundles: {
                "react-expert": {
                  tools: {
                    "claude-code": {
                      files: [".claude/skills/react/SKILL.md", ".claude/commands/review.md"],
                    },
                  },
                },
              },
              exclude_configured: true,
            },
          },
        },
      }),
    ).toEqual({
      version: 1,
      repos: {
        [REPO_FINGERPRINT]: {
          repo_root: "/Users/dev/project",
          remote_url: "git@github.com:org/project.git",
          desired_state: [{ bundle: "react-expert", protocol: "https" }],
        },
      },
      worktrees: {
        [WORKTREE_ID]: {
          repo_fingerprint: REPO_FINGERPRINT,
          path: "/Users/dev/project",
          materialized_state: {
            bundles: {
              "react-expert": {
                tools: {
                  "claude-code": {
                    files: [".claude/skills/react/SKILL.md", ".claude/commands/review.md"],
                  },
                },
              },
            },
            exclude_configured: true,
          },
        },
      },
    });
  });

  it("accepts desired_state entries with source, tools, and protocol", () => {
    expect(
      parseRegistry({
        version: 1,
        repos: {
          [REPO_FINGERPRINT]: {
            repo_root: "/Users/dev/project",
            desired_state: [
              { bundle: "react-expert", source: "github.com/user/ai-vault", tools: ["claude-code", "cursor"], protocol: "https" },
            ],
          },
        },
        worktrees: {},
      }),
    ).toMatchObject({
      repos: {
        [REPO_FINGERPRINT]: {
          desired_state: [
            { bundle: "react-expert", source: "github.com/user/ai-vault", tools: ["claude-code", "cursor"], protocol: "https" },
          ],
        },
      },
    });
  });

  it("accepts remote tracking metadata on desired and materialized bundle state", () => {
    // Given
    const input = {
      version: 1,
      repos: {
        [REPO_FINGERPRINT]: {
          repo_root: "/Users/dev/project",
          desired_state: [
            {
              bundle: "react-expert",
              source: "github.com/user/ai-vault",
              protocol: "https",
              ref: "main",
              resolved_ref: "main",
              resolved_commit: "2813b888fb134532be3749c71a38ee111b788e5b",
            },
          ],
        },
      },
      worktrees: {
        [WORKTREE_ID]: {
          repo_fingerprint: REPO_FINGERPRINT,
          path: "/Users/dev/project",
          materialized_state: {
            bundles: {
              "react-expert": {
                source: "github.com/user/ai-vault",
                resolved_commit: "2813b888fb134532be3749c71a38ee111b788e5b",
                tools: {
                  "claude-code": {
                    files: [".claude/skills/react/SKILL.md"],
                  },
                },
              },
            },
            exclude_configured: true,
          },
        },
      },
    };

    // When
    const parsed = parseRegistry(input);

    // Then
    expect(parsed.repos[REPO_FINGERPRINT]?.desired_state[0]).toMatchObject({
      ref: "main",
      resolved_ref: "main",
      resolved_commit: "2813b888fb134532be3749c71a38ee111b788e5b",
    });
    expect(
      parsed.worktrees[WORKTREE_ID]?.materialized_state.bundles["react-expert"],
    ).toMatchObject({
      resolved_commit: "2813b888fb134532be3749c71a38ee111b788e5b",
    });
  });

  it("parses and round-trips protocol field on desired_state entries", () => {
    // Given
    const input = {
      version: 1,
      repos: {
        [REPO_FINGERPRINT]: {
          repo_root: "/Users/dev/project",
          desired_state: [
            { bundle: "react-expert", source: "github.com/user/ai-vault", protocol: "ssh" },
          ],
        },
      },
      worktrees: {},
    };

    // When
    const parsed = parseRegistry(input);

    // Then — protocol is preserved
    expect(parsed.repos[REPO_FINGERPRINT]?.desired_state[0]).toMatchObject({
      bundle: "react-expert",
      source: "github.com/user/ai-vault",
      protocol: "ssh",
    });
  });

  it("rejects a desired_state entry with a missing protocol field", () => {
    expect(() =>
      parseRegistry({
        version: 1,
        repos: {
          [REPO_FINGERPRINT]: {
            repo_root: "/Users/dev/project",
            desired_state: [{ bundle: "react-expert", source: "github.com/user/ai-vault" }],
          },
        },
        worktrees: {},
      }),
    ).toThrowError(/protocol.*must be "https" or "ssh"/i);
  });

  it("rejects invalid protocol values", () => {
    expect(() =>
      parseRegistry({
        version: 1,
        repos: {
          [REPO_FINGERPRINT]: {
            repo_root: "/Users/dev/project",
            desired_state: [{ bundle: "react-expert", protocol: "ftp" }],
          },
        },
        worktrees: {},
      }),
    ).toThrowError(/protocol.*must be "https" or "ssh"/i);
  });

  it("rejects invalid resolved commit metadata", () => {
    // Given
    const input = {
      version: 1,
      repos: {
        [REPO_FINGERPRINT]: {
          repo_root: "/Users/dev/project",
          desired_state: [
            {
              bundle: "react-expert",
              protocol: "https",
              resolved_commit: "not-a-commit",
            },
          ],
        },
      },
      worktrees: {},
    };

    // When / Then
    expect(() => parseRegistry(input)).toThrowError(/resolved_commit.*commit SHA/i);
  });

  it("allows repository entries without a remote url", () => {
    expect(
      parseRegistry({
        version: 1,
        repos: {
          [REPO_FINGERPRINT]: {
            repo_root: "/Users/dev/project",
            desired_state: [{ bundle: "nextjs-minimal", protocol: "https" }],
          },
        },
        worktrees: {},
      }),
    ).toMatchObject({
      repos: {
        [REPO_FINGERPRINT]: {
          desired_state: [{ bundle: "nextjs-minimal", protocol: "https" }],
        },
      },
    });
  });

  it("preserves explicit ownership directories for worktree cleanup", () => {
    expect(
      parseRegistry({
        version: 1,
        repos: { [REPO_FINGERPRINT]: makeRepoEntry() },
        worktrees: {
          [WORKTREE_ID]: makeWorktreeEntry({
            materialized_state: {
              bundles: {
                "react-expert": {
                  tools: {
                    "claude-code": {
                      files: [".claude/skills/react/SKILL.md"],
                      directories: [".claude/skills/react"],
                    },
                  },
                },
              },
              exclude_configured: true,
            },
          }),
        },
      }),
    ).toMatchObject({
      worktrees: {
        [WORKTREE_ID]: {
          materialized_state: {
            bundles: {
              "react-expert": {
                tools: { "claude-code": { directories: [".claude/skills/react"] } },
              },
            },
          },
        },
      },
    });
  });

  it("accepts tracked file fingerprints for modified-file protection", () => {
    expect(
      parseRegistry({
        version: 1,
        repos: { [REPO_FINGERPRINT]: makeRepoEntry() },
        worktrees: {
          [WORKTREE_ID]: makeWorktreeEntry({
            materialized_state: {
              bundles: {
                "react-expert": {
                  tools: {
                    "claude-code": {
                      files: [".claude/skills/react/SKILL.md"],
                      file_fingerprints: { ".claude/skills/react/SKILL.md": "abc123" },
                    },
                  },
                },
              },
              exclude_configured: true,
            },
          }),
        },
      }),
    ).toMatchObject({
      worktrees: {
        [WORKTREE_ID]: {
          materialized_state: {
            bundles: {
              "react-expert": {
                tools: {
                  "claude-code": {
                    file_fingerprints: { ".claude/skills/react/SKILL.md": "abc123" },
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  it("rejects a registry without version 1", () => {
    expect(() => parseRegistry({ version: 2, repos: {}, worktrees: {} })).toThrowError(
      /registry\.version must be 1/i,
    );
    expect(() => parseRegistry({ repos: {}, worktrees: {} })).toThrowError(
      /registry\.version must be 1/i,
    );
  });

  it("rejects unknown tool names in desired_state tools array", () => {
    expect(() =>
      parseRegistry({
        version: 1,
        repos: {
          [REPO_FINGERPRINT]: {
            repo_root: "/Users/dev/project",
            desired_state: [{ bundle: "react-expert", tools: ["claude-code", "unknown-tool"], protocol: "https" }],
          },
        },
        worktrees: {},
      }),
    ).toThrowError(/must be one of:/i);
  });

  it("rejects unknown tool names in materialized_state tools object", () => {
    expect(() =>
      parseRegistry(
        makeRegistry({
          worktrees: {
            [WORKTREE_ID]: makeWorktreeEntry({
              materialized_state: {
                bundles: {
                  "react-expert": {
                    tools: {
                      "claude-cod": { files: [".claude/skills/react/SKILL.md"] },
                    },
                  },
                },
                exclude_configured: true,
              },
            }),
          },
        }),
      ),
    ).toThrowError(/must be one of:/i);
  });

  it("rejects malformed top-level objects", () => {
    expect(() => parseRegistry(null)).toThrowError(/registry must be an object/i);
    expect(() => parseRegistry({ version: 1, repos: [], worktrees: {} })).toThrowError(
      /repos must be an object/i,
    );
    expect(() => parseRegistry({ version: 1, repos: {}, worktrees: [] })).toThrowError(
      /worktrees must be an object/i,
    );
  });

  it.each([
    [
      "worktree materialized state with a missing files list",
      makeRegistry({
        worktrees: {
          [WORKTREE_ID]: makeWorktreeEntry({
            materialized_state: {
              bundles: {
                "react-expert": {
                  tools: { "claude-code": { exclude_configured: true } },
                },
              },
              exclude_configured: true,
            },
          }),
        },
      }),
      /\.files must be an array/i,
    ],
    [
      "worktree materialized state with an absolute managed file path",
      makeRegistry({
        worktrees: {
          [WORKTREE_ID]: makeWorktreeEntry({
            materialized_state: {
              bundles: {
                "react-expert": {
                  tools: {
                    "claude-code": {
                      files: ["/Users/dev/project/.claude/skills/react/SKILL.md"],
                    },
                  },
                },
              },
              exclude_configured: true,
            },
          }),
        },
      }),
      /\.files\[0\] must be a relative path/i,
    ],
    [
      "worktree materialized state with a fingerprint for an unknown file",
      makeRegistry({
        worktrees: {
          [WORKTREE_ID]: makeWorktreeEntry({
            materialized_state: {
              bundles: {
                "react-expert": {
                  tools: {
                    "claude-code": {
                      files: [".claude/skills/react/SKILL.md"],
                      file_fingerprints: { ".claude/skills/other/SKILL.md": "abc123" },
                    },
                  },
                },
              },
              exclude_configured: true,
            },
          }),
        },
      }),
      /\.file_fingerprints\..+ must reference a tracked file/i,
    ],
  ])("rejects %s", (_label, input, expectedMessage) => {
    expect(() => parseRegistry(input)).toThrowError(expectedMessage);
  });

  it("rejects worktrees that point at an unknown repository", () => {
    expect(() =>
      parseRegistry({
        version: 1,
        repos: {},
        worktrees: {
          [WORKTREE_ID]: makeWorktreeEntry({ repo_fingerprint: "repo_missing" }),
        },
      }),
    ).toThrowError(/repo_fingerprint must reference a repository entry/i);
  });
});

describe("registry persistence", () => {
  it("returns an empty registry when the registry file is missing", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-registry-"));
    const registryFile = path.join(homeDir, ".skul", "registry.json");

    expect(readRegistryFile(registryFile)).toEqual(createEmptyRegistry());

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("writes and reads repository intent and worktree ownership records", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-registry-"));
    const registryFile = path.join(homeDir, ".skul", "registry.json");

    const withRepoState = upsertRepoState(createEmptyRegistry(), REPO_FINGERPRINT, {
      repo_root: "/Users/dev/project",
      desired_state: [{ bundle: "react-expert", protocol: "https" }],
    });
    const withWorktreeState = upsertWorktreeState(withRepoState, WORKTREE_ID, {
      repo_fingerprint: REPO_FINGERPRINT,
      path: "/Users/dev/project",
      materialized_state: {
        bundles: {
          "react-expert": {
            tools: {
              "claude-code": {
                files: [".claude/skills/react/SKILL.md"],
                file_fingerprints: { ".claude/skills/react/SKILL.md": "abc123" },
                directories: [".claude/skills/react"],
              },
            },
          },
        },
        exclude_configured: true,
      },
    });

    writeRegistryFile(registryFile, withWorktreeState);
    expect(readRegistryFile(registryFile)).toEqual(withWorktreeState);

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("persists and reloads the protocol field on desired_state entries", () => {
    // Given
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-registry-"));
    const registryFile = path.join(homeDir, ".skul", "registry.json");

    const registry = upsertRepoState(createEmptyRegistry(), REPO_FINGERPRINT, {
      repo_root: "/Users/dev/project",
      desired_state: [{ bundle: "react-expert", source: "github.com/user/ai-vault", protocol: "ssh" }],
    });

    // When
    writeRegistryFile(registryFile, registry);
    const reloaded = readRegistryFile(registryFile);

    // Then
    expect(reloaded.repos[REPO_FINGERPRINT]?.desired_state[0]).toMatchObject({
      bundle: "react-expert",
      source: "github.com/user/ai-vault",
      protocol: "ssh",
    });

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("persists and reloads remote tracking metadata", () => {
    // Given
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-registry-"));
    const registryFile = path.join(homeDir, ".skul", "registry.json");
    const registry = upsertRepoState(createEmptyRegistry(), REPO_FINGERPRINT, {
      repo_root: "/Users/dev/project",
      desired_state: [
        {
          bundle: "react-expert",
          source: "github.com/user/ai-vault",
          protocol: "https",
          ref: "main",
          resolved_ref: "main",
          resolved_commit: "2813b888fb134532be3749c71a38ee111b788e5b",
        },
      ],
    });
    const withWorktreeState = upsertWorktreeState(registry, WORKTREE_ID, {
      repo_fingerprint: REPO_FINGERPRINT,
      path: "/Users/dev/project",
      materialized_state: {
        bundles: {
          "react-expert": {
            source: "github.com/user/ai-vault",
            resolved_commit: "2813b888fb134532be3749c71a38ee111b788e5b",
            tools: {
              "claude-code": {
                files: [".claude/skills/react/SKILL.md"],
              },
            },
          },
        },
        exclude_configured: true,
      },
    });

    // When
    writeRegistryFile(registryFile, withWorktreeState);
    const reloaded = readRegistryFile(registryFile);

    // Then
    expect(reloaded.repos[REPO_FINGERPRINT]?.desired_state[0]).toMatchObject({
      ref: "main",
      resolved_ref: "main",
      resolved_commit: "2813b888fb134532be3749c71a38ee111b788e5b",
    });
    expect(
      reloaded.worktrees[WORKTREE_ID]?.materialized_state.bundles["react-expert"],
    ).toMatchObject({
      resolved_commit: "2813b888fb134532be3749c71a38ee111b788e5b",
    });

    fs.rmSync(homeDir, { recursive: true, force: true });
  });
});

describe("ownership helpers", () => {
  it("rejects worktree ownership records that reference unknown repositories", () => {
    expect(() =>
      upsertWorktreeState(createEmptyRegistry(), WORKTREE_ID, {
        repo_fingerprint: "repo_missing",
        path: "/Users/dev/project",
        materialized_state: {
          bundles: {
            "react-expert": {
              tools: { "claude-code": { files: [".claude/skills/react/SKILL.md"] } },
            },
          },
          exclude_configured: true,
        },
      }),
    ).toThrowError(/repo_fingerprint must reference a repository entry/i);
  });

  it("lists only registry-owned paths in removal order", () => {
    expect(
      listManagedPathsForRemoval({
        files: [
          ".claude/commands/review.md",
          ".claude/skills/react/assets/context.md",
          ".claude/skills/react/SKILL.md",
        ],
        directories: [".claude/skills/react", ".claude/skills/react/assets"],
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
    const registry = parseRegistry({
      version: 1,
      repos: { [REPO_FINGERPRINT]: makeRepoEntry() },
      worktrees: {
        worktree_first: makeWorktreeEntry(),
        worktree_second: makeWorktreeEntry({ path: "/Users/dev/project-second" }),
      },
    });

    expect(removeWorktreeState(registry, "worktree_first")).toEqual({
      version: 1,
      repos: registry.repos,
      worktrees: { worktree_second: registry.worktrees.worktree_second },
    });
  });
});
