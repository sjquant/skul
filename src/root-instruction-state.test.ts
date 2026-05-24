import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CachedBundle } from "./bundle-discovery";
import type { BundleManifest } from "./bundle-manifest";
import type { DesiredBundleEntry, MaterializedState } from "./registry";
import {
  assertManagedRootInstructionSyncSourcesCached,
  captureRootInstructionBaseContents,
  collectManagedRootInstructionTargets,
  collectSharedRootInstructionState,
  refreshManagedFileFingerprintsForPaths,
  restoreRootInstructionBaseContents,
  syncManagedRootInstructionFiles,
} from "./root-instruction-state";
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

function createTempDir(prefix = "skul-ri-state-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Creates a minimal CachedBundle fixture with real files on disk. */
function makeCachedBundle(options: {
  cacheDir: string;
  bundleName: string;
  source?: string;
  manifest: BundleManifest;
  files: Record<string, string>;
}): CachedBundle {
  const bundleDir = path.join(options.cacheDir, options.bundleName);
  for (const [relPath, content] of Object.entries(options.files)) {
    writeFile(path.join(bundleDir, relPath), content);
  }
  const manifestFile = path.join(bundleDir, "manifest.json");
  fs.writeFileSync(manifestFile, JSON.stringify(options.manifest, null, 2));
  return {
    source: options.source ?? "github.com/user/vault",
    bundle: options.bundleName,
    manifestFile,
    manifest: options.manifest,
  };
}

function makeDesiredEntry(
  bundle: string,
  source = "github.com/user/vault",
): DesiredBundleEntry {
  return { bundle, source, protocol: "https" };
}

// ---------------------------------------------------------------------------
// captureRootInstructionBaseContents
// ---------------------------------------------------------------------------

describe("captureRootInstructionBaseContents", () => {
  it("captures the content of a pre-existing file", () => {
    // Given
    const repoRoot = createTempDir();
    writeFile(path.join(repoRoot, "CLAUDE.md"), "# My personal rules\n");

    // When
    const result = captureRootInstructionBaseContents({
      repoRoot,
      targetPaths: new Set(["CLAUDE.md"]),
    });

    // Then
    expect(result).toEqual({ "CLAUDE.md": "# My personal rules\n" });
  });

  it("returns undefined when no files exist at the target paths", () => {
    // Given
    const repoRoot = createTempDir();

    // When
    const result = captureRootInstructionBaseContents({
      repoRoot,
      targetPaths: new Set(["CLAUDE.md"]),
    });

    // Then
    expect(result).toBeUndefined();
  });

  it("skips a path that is already recorded in existingBaseContents", () => {
    // Given: CLAUDE.md on disk has new content, but it's already in the record
    const repoRoot = createTempDir();
    writeFile(path.join(repoRoot, "CLAUDE.md"), "# New content\n");

    // When
    const result = captureRootInstructionBaseContents({
      repoRoot,
      targetPaths: new Set(["CLAUDE.md"]),
      existingBaseContents: { "CLAUDE.md": "# Original content\n" },
    });

    // Then: the existing record is preserved verbatim
    expect(result?.["CLAUDE.md"]).toBe("# Original content\n");
  });

  it("skips a path that is already managed by Skul", () => {
    // Given
    const repoRoot = createTempDir();
    writeFile(path.join(repoRoot, "CLAUDE.md"), "<!-- SKUL managed -->\n");

    // When
    const result = captureRootInstructionBaseContents({
      repoRoot,
      targetPaths: new Set(["CLAUDE.md"]),
      managedTargetPaths: new Set(["CLAUDE.md"]),
    });

    // Then
    expect(result).toBeUndefined();
  });

  it("returns undefined when targetPaths is empty", () => {
    // Given
    const repoRoot = createTempDir();

    // When
    const result = captureRootInstructionBaseContents({
      repoRoot,
      targetPaths: new Set(),
    });

    // Then
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// syncManagedRootInstructionFiles
// ---------------------------------------------------------------------------

describe("syncManagedRootInstructionFiles", () => {
  it("writes bundle-wrapped content to the repo root and returns the written path", () => {
    // Given
    const repoRoot = createTempDir();
    const cacheDir = createTempDir();
    const manifest: BundleManifest = {
      tools: { "claude-code": { root_instruction: { path: "CLAUDE.md" } } },
    };
    const cachedBundle = makeCachedBundle({
      cacheDir,
      bundleName: "my-bundle",
      manifest,
      files: { "CLAUDE.md": "# My rules\n" },
    });
    const materializedBundles: MaterializedState["bundles"] = {
      "my-bundle": {
        tools: { "claude-code": { files: ["CLAUDE.md"] } },
      },
    };

    // When
    const written = syncManagedRootInstructionFiles({
      repoRoot,
      desiredState: [makeDesiredEntry("my-bundle")],
      materializedBundles,
      resolveCachedBundle: () => cachedBundle,
    });

    // Then
    expect(written).toEqual(new Set(["CLAUDE.md"]));
    const content = fs.readFileSync(path.join(repoRoot, "CLAUDE.md"), "utf8");
    expect(content).toBe(
      formatExpectedRootInstructionDocument(
        formatRootInstructionBundleBlock(
          "my-bundle",
          "# My rules\n",
          "github.com/user/vault",
        ),
      ),
    );
  });

  it("prepends pre-existing base content before the bundle block", () => {
    // Given
    const repoRoot = createTempDir();
    const cacheDir = createTempDir();
    const manifest: BundleManifest = {
      tools: { "claude-code": { root_instruction: { path: "CLAUDE.md" } } },
    };
    const cachedBundle = makeCachedBundle({
      cacheDir,
      bundleName: "my-bundle",
      manifest,
      files: { "CLAUDE.md": "# Bundle rules\n" },
    });
    const materializedBundles: MaterializedState["bundles"] = {
      "my-bundle": {
        tools: { "claude-code": { files: ["CLAUDE.md"] } },
      },
    };

    // When
    const written = syncManagedRootInstructionFiles({
      repoRoot,
      desiredState: [makeDesiredEntry("my-bundle")],
      materializedBundles,
      rootInstructionBaseContents: { "CLAUDE.md": "# My personal rules\n" },
      resolveCachedBundle: () => cachedBundle,
    });

    // Then
    expect(written).toContain("CLAUDE.md");
    const content = fs.readFileSync(path.join(repoRoot, "CLAUDE.md"), "utf8");
    expect(content).toBe(
      formatExpectedRootInstructionDocument(
        "# My personal rules\n",
        formatRootInstructionBundleBlock(
          "my-bundle",
          "# Bundle rules\n",
          "github.com/user/vault",
        ),
      ),
    );
  });

  it("remaps project-level root instruction paths in global mode", () => {
    // Given
    const repoRoot = createTempDir();
    const cacheDir = createTempDir();
    const manifest: BundleManifest = {
      tools: { "claude-code": { root_instruction: { path: "CLAUDE.md" } } },
    };
    const cachedBundle = makeCachedBundle({
      cacheDir,
      bundleName: "global-bundle",
      manifest,
      files: { "CLAUDE.md": "# Global rules\n" },
    });
    // In global mode, claude-code's CLAUDE.md → .claude/CLAUDE.md
    const materializedBundles: MaterializedState["bundles"] = {
      "global-bundle": {
        tools: { "claude-code": { files: [".claude/CLAUDE.md"] } },
      },
    };

    // When
    const written = syncManagedRootInstructionFiles({
      repoRoot,
      desiredState: [makeDesiredEntry("global-bundle")],
      materializedBundles,
      repoRelPathRemapper: (_tool, p) =>
        p === "CLAUDE.md" ? ".claude/CLAUDE.md" : p,
      resolveCachedBundle: () => cachedBundle,
    });

    // Then
    expect(written).toContain(".claude/CLAUDE.md");
    expect(fs.existsSync(path.join(repoRoot, ".claude", "CLAUDE.md"))).toBe(
      true,
    );
  });

  it("skips a bundle with no materialized state", () => {
    // Given
    const repoRoot = createTempDir();
    const cacheDir = createTempDir();
    const manifest: BundleManifest = {
      tools: { "claude-code": { root_instruction: { path: "CLAUDE.md" } } },
    };
    const cachedBundle = makeCachedBundle({
      cacheDir,
      bundleName: "ghost-bundle",
      manifest,
      files: { "CLAUDE.md": "# Ghost rules\n" },
    });

    // When
    const written = syncManagedRootInstructionFiles({
      repoRoot,
      desiredState: [makeDesiredEntry("ghost-bundle")],
      materializedBundles: {}, // nothing materialized
      resolveCachedBundle: () => cachedBundle,
    });

    // Then
    expect(written.size).toBe(0);
    expect(fs.existsSync(path.join(repoRoot, "CLAUDE.md"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// restoreRootInstructionBaseContents
// ---------------------------------------------------------------------------

describe("restoreRootInstructionBaseContents", () => {
  it("writes the saved base content back to disk and returns the path", () => {
    // Given
    const repoRoot = createTempDir();

    // When
    const restored = restoreRootInstructionBaseContents({
      repoRoot,
      baseContents: { "CLAUDE.md": "# My personal rules\n" },
      targetPaths: new Set(["CLAUDE.md"]),
    });

    // Then
    expect(restored).toEqual(new Set(["CLAUDE.md"]));
    expect(fs.readFileSync(path.join(repoRoot, "CLAUDE.md"), "utf8")).toBe(
      "# My personal rules\n",
    );
  });

  it("returns an empty set when baseContents is undefined", () => {
    // Given
    const repoRoot = createTempDir();

    // When
    const restored = restoreRootInstructionBaseContents({
      repoRoot,
      baseContents: undefined,
      targetPaths: new Set(["CLAUDE.md"]),
    });

    // Then
    expect(restored.size).toBe(0);
  });

  it("skips paths not present in baseContents", () => {
    // Given
    const repoRoot = createTempDir();

    // When
    const restored = restoreRootInstructionBaseContents({
      repoRoot,
      baseContents: { "AGENTS.md": "# AGENTS content\n" },
      targetPaths: new Set(["CLAUDE.md"]), // not in baseContents
    });

    // Then
    expect(restored.size).toBe(0);
    expect(fs.existsSync(path.join(repoRoot, "CLAUDE.md"))).toBe(false);
  });

  it("returns an empty set when targetPaths is empty", () => {
    // Given
    const repoRoot = createTempDir();

    // When
    const restored = restoreRootInstructionBaseContents({
      repoRoot,
      baseContents: { "CLAUDE.md": "# rules\n" },
      targetPaths: new Set(),
    });

    // Then
    expect(restored.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// refreshManagedFileFingerprintsForPaths
// ---------------------------------------------------------------------------

describe("refreshManagedFileFingerprintsForPaths", () => {
  it("returns the same bundles structure when filePaths is empty", () => {
    // Given
    const bundles: MaterializedState["bundles"] = {
      "my-bundle": {
        tools: {
          "claude-code": {
            files: ["CLAUDE.md"],
            file_fingerprints: { "CLAUDE.md": "old-hash" },
          },
        },
      },
    };

    // When
    const result = refreshManagedFileFingerprintsForPaths(
      "/repo",
      bundles,
      new Set(),
    );

    // Then
    expect(result).toEqual(bundles);
  });

  it("recomputes the fingerprint for a rewritten file", () => {
    // Given
    const repoRoot = createTempDir();
    const content = "# Updated rules\n";
    writeFile(path.join(repoRoot, "CLAUDE.md"), content);
    const bundles: MaterializedState["bundles"] = {
      "my-bundle": {
        tools: {
          "claude-code": {
            files: ["CLAUDE.md"],
            file_fingerprints: { "CLAUDE.md": "stale-hash" },
          },
        },
      },
    };

    // When
    const result = refreshManagedFileFingerprintsForPaths(
      repoRoot,
      bundles,
      new Set(["CLAUDE.md"]),
    );

    // Then
    expect(
      result["my-bundle"]?.tools["claude-code"]?.file_fingerprints?.[
        "CLAUDE.md"
      ],
    ).toBe(sha256(content));
  });

  it("records an empty string fingerprint when the file cannot be read", () => {
    // Given: CLAUDE.md does not exist on disk
    const repoRoot = createTempDir();
    const bundles: MaterializedState["bundles"] = {
      "my-bundle": {
        tools: {
          "claude-code": {
            files: ["CLAUDE.md"],
            file_fingerprints: { "CLAUDE.md": "stale-hash" },
          },
        },
      },
    };

    // When
    const result = refreshManagedFileFingerprintsForPaths(
      repoRoot,
      bundles,
      new Set(["CLAUDE.md"]),
    );

    // Then
    expect(
      result["my-bundle"]?.tools["claude-code"]?.file_fingerprints?.[
        "CLAUDE.md"
      ],
    ).toBe("");
  });
});

// ---------------------------------------------------------------------------
// collectManagedRootInstructionTargets
// ---------------------------------------------------------------------------

describe("collectManagedRootInstructionTargets", () => {
  it("returns the set of root instruction paths owned by materialized bundles", () => {
    // Given
    const bundles: MaterializedState["bundles"] = {
      "bundle-a": {
        tools: {
          "claude-code": {
            files: ["CLAUDE.md", ".claude/skills/react/SKILL.md"],
          },
        },
      },
      "bundle-b": {
        tools: {
          cursor: { files: ["AGENTS.md"] },
        },
      },
    };

    // When
    const targets = collectManagedRootInstructionTargets(bundles);

    // Then
    expect(targets).toContain("CLAUDE.md");
    expect(targets).toContain("AGENTS.md");
    expect(targets).not.toContain(".claude/skills/react/SKILL.md");
  });

  it("returns an empty set when no bundles are materialized", () => {
    // When
    const targets = collectManagedRootInstructionTargets({});

    // Then
    expect(targets).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// assertManagedRootInstructionSyncSourcesCached
// ---------------------------------------------------------------------------

describe("assertManagedRootInstructionSyncSourcesCached", () => {
  it("is a no-op when targetPaths is empty", () => {
    // Given
    const resolveCachedBundle = vi.fn();

    // When
    assertManagedRootInstructionSyncSourcesCached({
      desiredState: [makeDesiredEntry("my-bundle")],
      materializedBundles: {
        "my-bundle": { tools: { "claude-code": { files: ["CLAUDE.md"] } } },
      },
      targetPaths: new Set(),
      resolveCachedBundle,
    });

    // Then: resolver is never called when there are no target paths
    expect(resolveCachedBundle).not.toHaveBeenCalled();
  });

  it("is a no-op when the bundle does not own the target path", () => {
    // Given
    const resolveCachedBundle = vi.fn();

    // When
    assertManagedRootInstructionSyncSourcesCached({
      desiredState: [makeDesiredEntry("my-bundle")],
      materializedBundles: {
        "my-bundle": {
          tools: {
            "claude-code": { files: [".claude/skills/react/SKILL.md"] },
          },
        },
      },
      targetPaths: new Set(["CLAUDE.md"]),
      resolveCachedBundle,
    });

    // Then: resolver is not called because the bundle's files don't include CLAUDE.md
    expect(resolveCachedBundle).not.toHaveBeenCalled();
  });

  it("calls resolveCachedBundle for a bundle that owns the target path", () => {
    // Given
    const resolveCachedBundle = vi.fn(() => ({}) as CachedBundle);

    // When
    assertManagedRootInstructionSyncSourcesCached({
      desiredState: [makeDesiredEntry("my-bundle")],
      materializedBundles: {
        "my-bundle": { tools: { "claude-code": { files: ["CLAUDE.md"] } } },
      },
      targetPaths: new Set(["CLAUDE.md"]),
      resolveCachedBundle,
    });

    // Then
    expect(resolveCachedBundle).toHaveBeenCalledOnce();
  });

  it("propagates an error thrown by resolveCachedBundle", () => {
    // Given
    const resolveCachedBundle = vi.fn(() => {
      throw new Error("bundle not cached");
    });

    // When / Then
    expect(() =>
      assertManagedRootInstructionSyncSourcesCached({
        desiredState: [makeDesiredEntry("my-bundle")],
        materializedBundles: {
          "my-bundle": { tools: { "claude-code": { files: ["CLAUDE.md"] } } },
        },
        targetPaths: new Set(["CLAUDE.md"]),
        resolveCachedBundle,
      }),
    ).toThrow("bundle not cached");
  });
});

// ---------------------------------------------------------------------------
// collectSharedRootInstructionState
// ---------------------------------------------------------------------------

describe("collectSharedRootInstructionState", () => {
  it("collects root instruction paths owned by bundles other than the excluded one", () => {
    // Given
    const bundles: MaterializedState["bundles"] = {
      "bundle-a": {
        tools: {
          "claude-code": {
            files: ["CLAUDE.md"],
            file_fingerprints: { "CLAUDE.md": "hash-a" },
          },
        },
      },
      "bundle-b": {
        tools: {
          cursor: {
            files: ["AGENTS.md"],
            file_fingerprints: { "AGENTS.md": "hash-b" },
          },
        },
      },
    };

    // When
    const result = collectSharedRootInstructionState(
      bundles,
      ["CLAUDE.md", "AGENTS.md"],
      "bundle-a", // excluded
    );

    // Then: only bundle-b's path appears
    expect(result.files).toEqual(["AGENTS.md"]);
    expect(result.file_fingerprints["AGENTS.md"]).toBe("hash-b");
    expect(result.files).not.toContain("CLAUDE.md");
  });

  it("excludes non-root-instruction paths from the shared state", () => {
    // Given
    const bundles: MaterializedState["bundles"] = {
      "bundle-a": {
        tools: {
          "claude-code": { files: [".claude/skills/react/SKILL.md"] },
        },
      },
    };

    // When
    const result = collectSharedRootInstructionState(
      bundles,
      [".claude/skills/react/SKILL.md"],
      "bundle-b", // a different bundle is excluded; bundle-a is still checked
    );

    // Then: skill files are not root instruction paths
    expect(result.files).toEqual([]);
  });

  it("returns empty state when all bundles are excluded", () => {
    // Given
    const bundles: MaterializedState["bundles"] = {
      "bundle-a": {
        tools: {
          "claude-code": {
            files: ["CLAUDE.md"],
            file_fingerprints: { "CLAUDE.md": "hash-a" },
          },
        },
      },
    };

    // When
    const result = collectSharedRootInstructionState(
      bundles,
      ["CLAUDE.md"],
      "bundle-a",
    );

    // Then
    expect(result.files).toEqual([]);
    expect(result.file_fingerprints).toEqual({});
  });
});
