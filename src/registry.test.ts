import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createEmptyRegistry,
  type DesiredBundleEntry,
  listManagedPathsForRemoval,
  parseRegistry,
  readRegistryFile,
  removeWorktreeState,
  type ShadowedFileState,
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
    desired_state: [
      {
        bundle: "react-expert",
        protocol: "https",
      } satisfies DesiredBundleEntry,
    ],
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
    shadowed_files: {},
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

function makeShadowedFileEntry(
  overrides: Partial<ShadowedFileState> = {},
): ShadowedFileState {
  return {
    tool: "codex",
    bundle: "personal-rules",
    strategy: "append",
    base_blob: "2813b888fb134532be3749c71a38ee111b788e5b",
    overlay:
      "<!-- SKUL SHADOW START bundle=personal-rules -->\n# Personal rules\n<!-- SKUL SHADOW END -->",
    overlay_fingerprint: "overlay-abc123",
    rendered_fingerprint: "rendered-def456",
    skip_worktree: true,
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
                      files: [
                        ".claude/skills/react/SKILL.md",
                        ".claude/commands/review.md",
                      ],
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
                    files: [
                      ".claude/skills/react/SKILL.md",
                      ".claude/commands/review.md",
                    ],
                  },
                },
              },
            },
            exclude_configured: true,
          },
          shadowed_files: {},
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
              {
                bundle: "react-expert",
                source: "github.com/user/ai-vault",
                tools: ["claude-code", "cursor"],
                protocol: "https",
              },
            ],
          },
        },
        worktrees: {},
      }),
    ).toMatchObject({
      repos: {
        [REPO_FINGERPRINT]: {
          desired_state: [
            {
              bundle: "react-expert",
              source: "github.com/user/ai-vault",
              tools: ["claude-code", "cursor"],
              protocol: "https",
            },
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
            {
              bundle: "react-expert",
              source: "github.com/user/ai-vault",
              protocol: "ssh",
            },
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
            desired_state: [
              { bundle: "react-expert", source: "github.com/user/ai-vault" },
            ],
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
    expect(() => parseRegistry(input)).toThrowError(
      /resolved_commit.*Git object id/i,
    );
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
                tools: {
                  "claude-code": { directories: [".claude/skills/react"] },
                },
              },
            },
          },
        },
      },
    });
  });

  it("defaults missing shadowed_files to an empty object for older registries", () => {
    // Given
    const input = {
      version: 1,
      repos: { [REPO_FINGERPRINT]: makeRepoEntry() },
      worktrees: {
        [WORKTREE_ID]: {
          repo_fingerprint: REPO_FINGERPRINT,
          path: "/Users/dev/project",
          materialized_state: {
            bundles: {},
            exclude_configured: false,
          },
        },
      },
    };

    // When
    const parsed = parseRegistry(input);

    // Then
    expect(parsed.worktrees[WORKTREE_ID]?.shadowed_files).toEqual({});
  });

  it("parses shadowed_files separately from materialized file ownership", () => {
    // Given
    const input = {
      version: 1,
      repos: { [REPO_FINGERPRINT]: makeRepoEntry() },
      worktrees: {
        [WORKTREE_ID]: makeWorktreeEntry({
          shadowed_files: {
            "AGENTS.md": makeShadowedFileEntry(),
          },
        }),
      },
    };

    // When
    const parsed = parseRegistry(input);

    // Then
    expect(parsed.worktrees[WORKTREE_ID]).toMatchObject({
      shadowed_files: {
        "AGENTS.md": makeShadowedFileEntry(),
      },
    });
  });

  it("rejects worktree file paths that escape the repository via parent traversal", () => {
    // Given / When / Then
    expect(() =>
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
                      files: ["managed/../../outside.txt"],
                    },
                  },
                },
              },
              exclude_configured: true,
            },
          }),
        },
      }),
    ).toThrowError(/must be a relative path/);
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
                      file_fingerprints: {
                        ".claude/skills/react/SKILL.md": "abc123",
                      },
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
                    file_fingerprints: {
                      ".claude/skills/react/SKILL.md": "abc123",
                    },
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
    expect(() =>
      parseRegistry({ version: 2, repos: {}, worktrees: {} }),
    ).toThrowError(/registry\.version must be 1/i);
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
            desired_state: [
              {
                bundle: "react-expert",
                tools: ["claude-code", "unknown-tool"],
                protocol: "https",
              },
            ],
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
                      "claude-cod": {
                        files: [".claude/skills/react/SKILL.md"],
                      },
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
    expect(() => parseRegistry(null)).toThrowError(
      /registry must be an object/i,
    );
    expect(() =>
      parseRegistry({ version: 1, repos: [], worktrees: {} }),
    ).toThrowError(/repos must be an object/i);
    expect(() =>
      parseRegistry({ version: 1, repos: {}, worktrees: [] }),
    ).toThrowError(/worktrees must be an object/i);
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
                      files: [
                        "/Users/dev/project/.claude/skills/react/SKILL.md",
                      ],
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
                      file_fingerprints: {
                        ".claude/skills/other/SKILL.md": "abc123",
                      },
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
    [
      "shadowed file metadata with an absolute path",
      makeRegistry({
        worktrees: {
          [WORKTREE_ID]: makeWorktreeEntry({
            shadowed_files: {
              "/Users/dev/project/AGENTS.md": makeShadowedFileEntry(),
            },
          }),
        },
      }),
      /shadowed_files\..+ must be a relative path/i,
    ],
    [
      "shadowed file metadata with an unsupported strategy",
      makeRegistry({
        worktrees: {
          [WORKTREE_ID]: makeWorktreeEntry({
            shadowed_files: {
              "AGENTS.md": makeShadowedFileEntry({
                strategy: "merge" as never,
              }),
            },
          }),
        },
      }),
      /\.strategy must be "append", "prepend", or "replace"/i,
    ],
    [
      "shadowed file metadata with an invalid base blob id",
      makeRegistry({
        worktrees: {
          [WORKTREE_ID]: makeWorktreeEntry({
            shadowed_files: {
              "AGENTS.md": makeShadowedFileEntry({ base_blob: "not-a-sha" }),
            },
          }),
        },
      }),
      /\.base_blob must be a 7-40 character hexadecimal Git object id/i,
    ],
    [
      "shadowed file metadata with an empty overlay body",
      makeRegistry({
        worktrees: {
          [WORKTREE_ID]: makeWorktreeEntry({
            shadowed_files: {
              "AGENTS.md": makeShadowedFileEntry({ overlay: "" }),
            },
          }),
        },
      }),
      /\.overlay must be a non-empty string/i,
    ],
    [
      "shadowed file metadata with an empty overlay fingerprint",
      makeRegistry({
        worktrees: {
          [WORKTREE_ID]: makeWorktreeEntry({
            shadowed_files: {
              "AGENTS.md": makeShadowedFileEntry({ overlay_fingerprint: "" }),
            },
          }),
        },
      }),
      /\.overlay_fingerprint must be a non-empty string/i,
    ],
    [
      "shadowed file metadata with an empty rendered fingerprint",
      makeRegistry({
        worktrees: {
          [WORKTREE_ID]: makeWorktreeEntry({
            shadowed_files: {
              "AGENTS.md": makeShadowedFileEntry({ rendered_fingerprint: "" }),
            },
          }),
        },
      }),
      /\.rendered_fingerprint must be a non-empty string/i,
    ],
    [
      "shadowed file metadata with an unknown tool name",
      makeRegistry({
        worktrees: {
          [WORKTREE_ID]: makeWorktreeEntry({
            shadowed_files: {
              "AGENTS.md": makeShadowedFileEntry({
                tool: "unknown-tool" as never,
              }),
            },
          }),
        },
      }),
      /\.tool must be one of:/i,
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
          [WORKTREE_ID]: makeWorktreeEntry({
            repo_fingerprint: "repo_missing",
          }),
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

    const withRepoState = upsertRepoState(
      createEmptyRegistry(),
      REPO_FINGERPRINT,
      {
        repo_root: "/Users/dev/project",
        desired_state: [{ bundle: "react-expert", protocol: "https" }],
      },
    );
    const withWorktreeState = upsertWorktreeState(withRepoState, WORKTREE_ID, {
      repo_fingerprint: REPO_FINGERPRINT,
      path: "/Users/dev/project",
      materialized_state: {
        bundles: {
          "react-expert": {
            tools: {
              "claude-code": {
                files: [".claude/skills/react/SKILL.md"],
                file_fingerprints: {
                  ".claude/skills/react/SKILL.md": "abc123",
                },
                directories: [".claude/skills/react"],
              },
            },
          },
        },
        exclude_configured: true,
      },
      shadowed_files: {
        "AGENTS.md": makeShadowedFileEntry(),
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
      desired_state: [
        {
          bundle: "react-expert",
          source: "github.com/user/ai-vault",
          protocol: "ssh",
        },
      ],
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
      shadowed_files: {
        "AGENTS.md": makeShadowedFileEntry(),
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
      reloaded.worktrees[WORKTREE_ID]?.materialized_state.bundles[
        "react-expert"
      ],
    ).toMatchObject({
      resolved_commit: "2813b888fb134532be3749c71a38ee111b788e5b",
    });
    expect(reloaded.worktrees[WORKTREE_ID]?.shadowed_files).toMatchObject({
      "AGENTS.md": makeShadowedFileEntry(),
    });

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("writes shadowed_files entries in sorted path order", () => {
    // Given
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-registry-"));
    const registryFile = path.join(homeDir, ".skul", "registry.json");
    const registry = upsertWorktreeState(
      upsertRepoState(createEmptyRegistry(), REPO_FINGERPRINT, makeRepoEntry()),
      WORKTREE_ID,
      {
        repo_fingerprint: REPO_FINGERPRINT,
        path: "/Users/dev/project",
        materialized_state: {
          bundles: {},
          exclude_configured: false,
        },
        shadowed_files: {
          "CLAUDE.md": makeShadowedFileEntry({ tool: "claude-code" }),
          "AGENTS.md": makeShadowedFileEntry(),
        },
      },
    );

    // When
    writeRegistryFile(registryFile, registry);
    const fileContent = fs.readFileSync(registryFile, "utf8");

    // Then
    expect(fileContent.indexOf('"AGENTS.md"')).toBeLessThan(
      fileContent.indexOf('"CLAUDE.md"'),
    );

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
              tools: {
                "claude-code": { files: [".claude/skills/react/SKILL.md"] },
              },
            },
          },
          exclude_configured: true,
        },
        shadowed_files: {},
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
        worktree_second: makeWorktreeEntry({
          path: "/Users/dev/project-second",
        }),
      },
    });

    expect(removeWorktreeState(registry, "worktree_first")).toEqual({
      version: 1,
      repos: registry.repos,
      worktrees: { worktree_second: registry.worktrees.worktree_second },
    });
  });
});
