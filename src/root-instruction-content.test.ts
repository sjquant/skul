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
    const bundleDir = createTempDir();
    writeFile(path.join(bundleDir, "CLAUDE.md"), "# instructions\n");

    const manifest: BundleManifest = {
      tools: {
        "claude-code": { root_instruction: { path: "CLAUDE.md" } },
      },
    };

    const result = collectComposedRootInstructionContents({
      bundleDir,
      manifest,
      toolNames: ["claude-code"],
      itemSelectors: ["skills/react"], // root-instruction not selected
    });

    expect(result).toEqual({});
  });

  it("collects content for a single tool and maps it to the tool's root instruction path", () => {
    const bundleDir = createTempDir();
    writeFile(path.join(bundleDir, "CLAUDE.md"), "# My rules\n");

    const manifest: BundleManifest = {
      tools: {
        "claude-code": { root_instruction: { path: "CLAUDE.md" } },
      },
    };

    const result = collectComposedRootInstructionContents({
      bundleDir,
      manifest,
      toolNames: ["claude-code"],
    });

    // claude-code's root instruction lands at CLAUDE.md
    expect(result["CLAUDE.md"]).toBeDefined();
    expect(result["CLAUDE.md"]).toContain("# My rules");
  });

  it("maps each tool to its own root instruction path when they differ", () => {
    const bundleDir = createTempDir();
    // Both tools share the same source file
    writeFile(path.join(bundleDir, "CLAUDE.md"), "# Shared rules\n");

    const manifest: BundleManifest = {
      tools: {
        "claude-code": { root_instruction: { path: "CLAUDE.md" } },
      },
    };

    // claude-code → CLAUDE.md; cursor also targets AGENTS.md from a separate source
    const resultClaudeOnly = collectComposedRootInstructionContents({
      bundleDir,
      manifest,
      toolNames: ["claude-code"],
    });

    expect(Object.keys(resultClaudeOnly)).toContain("CLAUDE.md");
  });

  it("deduplicates content when two tools share the same source path and output path", () => {
    // Both cursor and codex use AGENTS.md as source and write to AGENTS.md.
    // Without deduplication the same content would appear twice.
    const bundleDir = createTempDir();
    writeFile(path.join(bundleDir, "AGENTS.md"), "# Shared rules\n");

    const manifest: BundleManifest = {
      tools: {
        cursor: { root_instruction: { path: "AGENTS.md" } },
        codex: { root_instruction: { path: "AGENTS.md" } },
      },
    };

    const result = collectComposedRootInstructionContents({
      bundleDir,
      manifest,
      toolNames: ["cursor", "codex"],
    });

    // AGENTS.md should exist and contain the content exactly once
    expect(result["AGENTS.md"]).toBeDefined();
    const occurrences = (result["AGENTS.md"]!.match(/# Shared rules/g) ?? [])
      .length;
    expect(occurrences).toBe(1);
  });

  it("filters to the specified targetPaths", () => {
    const bundleDir = createTempDir();
    writeFile(path.join(bundleDir, "CLAUDE.md"), "# Claude rules\n");

    const manifest: BundleManifest = {
      tools: {
        "claude-code": { root_instruction: { path: "CLAUDE.md" } },
        cursor: { root_instruction: { path: "CLAUDE.md" } },
      },
    };

    // Only collect for CLAUDE.md, not AGENTS.md
    const result = collectComposedRootInstructionContents({
      bundleDir,
      manifest,
      toolNames: ["claude-code", "cursor"],
      targetPaths: new Set(["CLAUDE.md"]),
    });

    expect(result["CLAUDE.md"]).toBeDefined();
    expect(result["AGENTS.md"]).toBeUndefined();
  });

  it("returns an empty object when no tool in toolNames has a root_instruction target", () => {
    const bundleDir = createTempDir();

    const manifest: BundleManifest = {
      tools: {
        "claude-code": { skills: { path: "skills" } },
      },
    };

    const result = collectComposedRootInstructionContents({
      bundleDir,
      manifest,
      toolNames: ["claude-code"],
    });

    expect(result).toEqual({});
  });

  it("includes content when itemSelectors is undefined (whole bundle selected)", () => {
    const bundleDir = createTempDir();
    writeFile(path.join(bundleDir, "CLAUDE.md"), "# rules\n");

    const manifest: BundleManifest = {
      tools: {
        "claude-code": { root_instruction: { path: "CLAUDE.md" } },
      },
    };

    const result = collectComposedRootInstructionContents({
      bundleDir,
      manifest,
      toolNames: ["claude-code"],
      itemSelectors: undefined,
    });

    expect(result["CLAUDE.md"]).toBeDefined();
  });
});
