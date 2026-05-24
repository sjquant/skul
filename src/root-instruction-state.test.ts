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
    const repoRoot = createTempDir();
    writeFile(path.join(repoRoot, "CLAUDE.md"), "# My personal rules\n");

    const result = captureRootInstructionBaseContents({
      repoRoot,
      targetPaths: new Set(["CLAUDE.md"]),
    });

    expect(result).toEqual({ "CLAUDE.md": "# My personal rules\n" });
  });

  it("returns undefined when no files exist at the target paths", () => {
    const repoRoot = createTempDir();

    const result = captureRootInstructionBaseContents({
      repoRoot,
      targetPaths: new Set(["CLAUDE.md"]),
    });

    expect(result).toBeUndefined();
  });

  it("skips a path that is already recorded in existingBaseContents", () => {
    const repoRoot = createTempDir();
    writeFile(path.join(repoRoot, "CLAUDE.md"), "# New content\n");

    const result = captureRootInstructionBaseContents({
      repoRoot,
      targetPaths: new Set(["CLAUDE.md"]),
      existingBaseContents: { "CLAUDE.md": "# Original content\n" },
    });

    // The existing record is preserved verbatim
    expect(result!["CLAUDE.md"]).toBe("# Original content\n");
  });

  it("skips a path that is already managed by Skul", () => {
    const repoRoot = createTempDir();
    writeFile(path.join(repoRoot, "CLAUDE.md"), "<!-- SKUL managed -->\n");

    const result = captureRootInstructionBaseContents({
      repoRoot,
      targetPaths: new Set(["CLAUDE.md"]),
      managedTargetPaths: new Set(["CLAUDE.md"]),
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined when targetPaths is empty", () => {
    const repoRoot = createTempDir();

    const result = captureRootInstructionBaseContents({
      repoRoot,
      targetPaths: new Set(),
    });

    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// syncManagedRootInstructionFiles
// ---------------------------------------------------------------------------

describe("syncManagedRootInstructionFiles", () => {
  it("writes bundle-wrapped content to the repo root and returns the written path", () => {
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

    const written = syncManagedRootInstructionFiles({
      repoRoot,
      desiredState: [makeDesiredEntry("my-bundle")],
      materializedBundles,
      resolveCachedBundle: () => cachedBundle,
    });

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

    const written = syncManagedRootInstructionFiles({
      repoRoot,
      desiredState: [makeDesiredEntry("my-bundle")],
      materializedBundles,
      rootInstructionBaseContents: { "CLAUDE.md": "# My personal rules\n" },
      resolveCachedBundle: () => cachedBundle,
    });

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

    const written = syncManagedRootInstructionFiles({
      repoRoot,
      desiredState: [makeDesiredEntry("global-bundle")],
      materializedBundles,
      repoRelPathRemapper: (_tool, p) =>
        p === "CLAUDE.md" ? ".claude/CLAUDE.md" : p,
      resolveCachedBundle: () => cachedBundle,
    });

    expect(written).toContain(".claude/CLAUDE.md");
    expect(fs.existsSync(path.join(repoRoot, ".claude", "CLAUDE.md"))).toBe(
      true,
    );
  });

  it("skips a bundle with no materialized state", () => {
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

    const written = syncManagedRootInstructionFiles({
      repoRoot,
      desiredState: [makeDesiredEntry("ghost-bundle")],
      materializedBundles: {}, // nothing materialized
      resolveCachedBundle: () => cachedBundle,
    });

    expect(written.size).toBe(0);
    expect(fs.existsSync(path.join(repoRoot, "CLAUDE.md"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// restoreRootInstructionBaseContents
// ---------------------------------------------------------------------------

describe("restoreRootInstructionBaseContents", () => {
  it("writes the saved base content back to disk and returns the path", () => {
    const repoRoot = createTempDir();

    const restored = restoreRootInstructionBaseContents({
      repoRoot,
      baseContents: { "CLAUDE.md": "# My personal rules\n" },
      targetPaths: new Set(["CLAUDE.md"]),
    });

    expect(restored).toEqual(new Set(["CLAUDE.md"]));
    expect(fs.readFileSync(path.join(repoRoot, "CLAUDE.md"), "utf8")).toBe(
      "# My personal rules\n",
    );
  });

  it("returns an empty set when baseContents is undefined", () => {
    const repoRoot = createTempDir();

    const restored = restoreRootInstructionBaseContents({
      repoRoot,
      baseContents: undefined,
      targetPaths: new Set(["CLAUDE.md"]),
    });

    expect(restored.size).toBe(0);
  });

  it("skips paths not present in baseContents", () => {
    const repoRoot = createTempDir();

    const restored = restoreRootInstructionBaseContents({
      repoRoot,
      baseContents: { "AGENTS.md": "# AGENTS content\n" },
      targetPaths: new Set(["CLAUDE.md"]), // not in baseContents
    });

    expect(restored.size).toBe(0);
    expect(fs.existsSync(path.join(repoRoot, "CLAUDE.md"))).toBe(false);
  });

  it("returns an empty set when targetPaths is empty", () => {
    const repoRoot = createTempDir();

    const restored = restoreRootInstructionBaseContents({
      repoRoot,
      baseContents: { "CLAUDE.md": "# rules\n" },
      targetPaths: new Set(),
    });

    expect(restored.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// refreshManagedFileFingerprintsForPaths
// ---------------------------------------------------------------------------

describe("refreshManagedFileFingerprintsForPaths", () => {
  it("returns the same bundles structure when filePaths is empty", () => {
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

    const result = refreshManagedFileFingerprintsForPaths(
      "/repo",
      bundles,
      new Set(),
    );

    expect(result).toEqual(bundles);
  });

  it("recomputes the fingerprint for a rewritten file", () => {
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

    const result = refreshManagedFileFingerprintsForPaths(
      repoRoot,
      bundles,
      new Set(["CLAUDE.md"]),
    );

    const expectedHash = sha256(content);
    expect(
      result["my-bundle"]!.tools["claude-code"]!.file_fingerprints![
        "CLAUDE.md"
      ],
    ).toBe(expectedHash);
  });

  it("records an empty string fingerprint when the file cannot be read", () => {
    const repoRoot = createTempDir();
    // CLAUDE.md does not exist on disk

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

    const result = refreshManagedFileFingerprintsForPaths(
      repoRoot,
      bundles,
      new Set(["CLAUDE.md"]),
    );

    expect(
      result["my-bundle"]!.tools["claude-code"]!.file_fingerprints![
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

    const targets = collectManagedRootInstructionTargets(bundles);

    expect(targets).toContain("CLAUDE.md");
    expect(targets).toContain("AGENTS.md");
    // Non-root-instruction paths are excluded
    expect(targets).not.toContain(".claude/skills/react/SKILL.md");
  });

  it("returns an empty set when no bundles are materialized", () => {
    expect(collectManagedRootInstructionTargets({})).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// assertManagedRootInstructionSyncSourcesCached
// ---------------------------------------------------------------------------

describe("assertManagedRootInstructionSyncSourcesCached", () => {
  it("is a no-op when targetPaths is empty", () => {
    const resolveCachedBundle = vi.fn();

    assertManagedRootInstructionSyncSourcesCached({
      desiredState: [makeDesiredEntry("my-bundle")],
      materializedBundles: {
        "my-bundle": { tools: { "claude-code": { files: ["CLAUDE.md"] } } },
      },
      targetPaths: new Set(),
      resolveCachedBundle,
    });

    expect(resolveCachedBundle).not.toHaveBeenCalled();
  });

  it("is a no-op when the bundle does not own the target path", () => {
    const resolveCachedBundle = vi.fn();

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

    // The bundle's files don't include CLAUDE.md, so no resolution needed
    expect(resolveCachedBundle).not.toHaveBeenCalled();
  });

  it("calls resolveCachedBundle for a bundle that owns the target path", () => {
    const cachedBundle = {} as CachedBundle;
    const resolveCachedBundle = vi.fn(() => cachedBundle);

    assertManagedRootInstructionSyncSourcesCached({
      desiredState: [makeDesiredEntry("my-bundle")],
      materializedBundles: {
        "my-bundle": { tools: { "claude-code": { files: ["CLAUDE.md"] } } },
      },
      targetPaths: new Set(["CLAUDE.md"]),
      resolveCachedBundle,
    });

    expect(resolveCachedBundle).toHaveBeenCalledOnce();
  });

  it("propagates an error thrown by resolveCachedBundle", () => {
    const resolveCachedBundle = vi.fn(() => {
      throw new Error("bundle not cached");
    });

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

    const result = collectSharedRootInstructionState(
      bundles,
      ["CLAUDE.md", "AGENTS.md"],
      "bundle-a", // excluded
    );

    // Only bundle-b's path should appear
    expect(result.files).toEqual(["AGENTS.md"]);
    expect(result.file_fingerprints["AGENTS.md"]).toBe("hash-b");
    expect(result.files).not.toContain("CLAUDE.md");
  });

  it("excludes non-root-instruction paths from the shared state", () => {
    const bundles: MaterializedState["bundles"] = {
      "bundle-a": {
        tools: {
          "claude-code": {
            files: [".claude/skills/react/SKILL.md"],
          },
        },
      },
    };

    const result = collectSharedRootInstructionState(
      bundles,
      [".claude/skills/react/SKILL.md"],
      "bundle-b", // excluded (different bundle)
    );

    // Skill files are not root instruction paths
    expect(result.files).toEqual([]);
  });

  it("returns empty state when all bundles are excluded", () => {
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

    const result = collectSharedRootInstructionState(
      bundles,
      ["CLAUDE.md"],
      "bundle-a",
    );

    expect(result.files).toEqual([]);
    expect(result.file_fingerprints).toEqual({});
  });
});
