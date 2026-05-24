import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BundleManifest } from "./bundle-manifest";
import { collectComposedRootInstructionContents } from "./root-instruction-content";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-ri-content-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// ---------------------------------------------------------------------------
// collectComposedRootInstructionContents
// ---------------------------------------------------------------------------

describe("collectComposedRootInstructionContents", () => {
  it("returns an empty object when itemSelectors excludes root-instruction", () => {
    // Given
    const bundleDir = createTempDir();
    writeFile(path.join(bundleDir, "CLAUDE.md"), "# instructions\n");
    const manifest: BundleManifest = {
      tools: {
        "claude-code": { root_instruction: { path: "CLAUDE.md" } },
      },
    };

    // When
    const result = collectComposedRootInstructionContents({
      bundleDir,
      manifest,
      toolNames: ["claude-code"],
      itemSelectors: ["skills/react"], // root-instruction not selected
    });

    // Then
    expect(result).toEqual({});
  });

  it("collects content for a single tool and maps it to the tool's root instruction path", () => {
    // Given
    const bundleDir = createTempDir();
    writeFile(path.join(bundleDir, "CLAUDE.md"), "# My rules\n");
    const manifest: BundleManifest = {
      tools: {
        "claude-code": { root_instruction: { path: "CLAUDE.md" } },
      },
    };

    // When
    const result = collectComposedRootInstructionContents({
      bundleDir,
      manifest,
      toolNames: ["claude-code"],
    });

    // Then: claude-code's root instruction lands at CLAUDE.md
    expect(result["CLAUDE.md"]).toBeDefined();
    expect(result["CLAUDE.md"]).toContain("# My rules");
  });

  it("deduplicates content when two tools share the same source path and output path", () => {
    // Given: both cursor and codex use AGENTS.md as source and target
    const bundleDir = createTempDir();
    writeFile(path.join(bundleDir, "AGENTS.md"), "# Shared rules\n");
    const manifest: BundleManifest = {
      tools: {
        cursor: { root_instruction: { path: "AGENTS.md" } },
        codex: { root_instruction: { path: "AGENTS.md" } },
      },
    };

    // When
    const result = collectComposedRootInstructionContents({
      bundleDir,
      manifest,
      toolNames: ["cursor", "codex"],
    });

    // Then: content appears exactly once despite two tools pointing at the same source
    expect(result["AGENTS.md"]).toBeDefined();
    const occurrences = (result["AGENTS.md"]?.match(/# Shared rules/g) ?? [])
      .length;
    expect(occurrences).toBe(1);
  });

  it("filters to the specified targetPaths", () => {
    // Given
    const bundleDir = createTempDir();
    writeFile(path.join(bundleDir, "CLAUDE.md"), "# Claude rules\n");
    const manifest: BundleManifest = {
      tools: {
        "claude-code": { root_instruction: { path: "CLAUDE.md" } },
        cursor: { root_instruction: { path: "CLAUDE.md" } },
      },
    };

    // When: restrict output to CLAUDE.md only
    const result = collectComposedRootInstructionContents({
      bundleDir,
      manifest,
      toolNames: ["claude-code", "cursor"],
      targetPaths: new Set(["CLAUDE.md"]),
    });

    // Then
    expect(result["CLAUDE.md"]).toBeDefined();
    expect(result["AGENTS.md"]).toBeUndefined();
  });

  it("returns an empty object when no tool in toolNames has a root_instruction target", () => {
    // Given
    const bundleDir = createTempDir();
    const manifest: BundleManifest = {
      tools: {
        "claude-code": { skills: { path: "skills" } },
      },
    };

    // When
    const result = collectComposedRootInstructionContents({
      bundleDir,
      manifest,
      toolNames: ["claude-code"],
    });

    // Then
    expect(result).toEqual({});
  });

  it("maps each tool to its own root instruction path when they differ", () => {
    // Given
    const bundleDir = createTempDir();
    writeFile(path.join(bundleDir, "CLAUDE.md"), "# Claude rules\n");
    writeFile(path.join(bundleDir, "AGENTS.md"), "# Agents rules\n");
    const manifest: BundleManifest = {
      tools: {
        "claude-code": { root_instruction: { path: "CLAUDE.md" } },
        codex: { root_instruction: { path: "AGENTS.md" } },
      },
    };

    // When
    const result = collectComposedRootInstructionContents({
      bundleDir,
      manifest,
      toolNames: ["claude-code", "codex"],
    });

    // Then: each tool's content lands at its own output path
    expect(result["CLAUDE.md"]).toContain("# Claude rules");
    expect(result["AGENTS.md"]).toContain("# Agents rules");
  });

  it("includes content when itemSelectors is undefined (whole bundle selected)", () => {
    // Given
    const bundleDir = createTempDir();
    writeFile(path.join(bundleDir, "CLAUDE.md"), "# rules\n");
    const manifest: BundleManifest = {
      tools: {
        "claude-code": { root_instruction: { path: "CLAUDE.md" } },
      },
    };

    // When
    const result = collectComposedRootInstructionContents({
      bundleDir,
      manifest,
      toolNames: ["claude-code"],
      itemSelectors: undefined,
    });

    // Then
    expect(result["CLAUDE.md"]).toBeDefined();
  });
});
