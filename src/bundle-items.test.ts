import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertBundleSupportsRequestedItems,
  bundleItemSelectionsEqual,
  isDirectoryItemSelected,
  isRootInstructionItemSelected,
  listSelectableBundleItems,
  mergeDesiredBundleItems,
  normalizeBundleItemSelector,
  normalizeBundleItemSelectors,
} from "./bundle-items";
import type { BundleManifest } from "./bundle-manifest";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-items-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// ---------------------------------------------------------------------------
// normalizeBundleItemSelector
// ---------------------------------------------------------------------------

describe("normalizeBundleItemSelector", () => {
  it('passes "root-instruction" through unchanged', () => {
    // Given
    const selector = "root-instruction";

    // When
    const result = normalizeBundleItemSelector(selector);

    // Then
    expect(result).toBe("root-instruction");
  });

  it("normalizes CLAUDE.md alias to root-instruction", () => {
    // Given
    const selector = "CLAUDE.md";

    // When
    const result = normalizeBundleItemSelector(selector);

    // Then
    expect(result).toBe("root-instruction");
  });

  it("normalizes AGENTS.md alias to root-instruction", () => {
    // Given
    const selector = "AGENTS.md";

    // When
    const result = normalizeBundleItemSelector(selector);

    // Then
    expect(result).toBe("root-instruction");
  });

  it("normalizes GEMINI.md alias to root-instruction", () => {
    // Given
    const selector = "GEMINI.md";

    // When
    const result = normalizeBundleItemSelector(selector);

    // Then
    expect(result).toBe("root-instruction");
  });

  it("normalizes .github/copilot-instructions.md alias to root-instruction", () => {
    // Given
    const selector = ".github/copilot-instructions.md";

    // When
    const result = normalizeBundleItemSelector(selector);

    // Then
    expect(result).toBe("root-instruction");
  });

  it("accepts a plain skills selector with no extension", () => {
    // Given
    const selector = "skills/react";

    // When
    const result = normalizeBundleItemSelector(selector);

    // Then
    expect(result).toBe("skills/react");
  });

  it("accepts a plain commands selector", () => {
    // Given
    const selector = "commands/review";

    // When
    const result = normalizeBundleItemSelector(selector);

    // Then
    expect(result).toBe("commands/review");
  });

  it("accepts a plain agents selector", () => {
    // Given
    const selector = "agents/reviewer";

    // When
    const result = normalizeBundleItemSelector(selector);

    // Then
    expect(result).toBe("agents/reviewer");
  });

  it("strips .md extension", () => {
    // Given
    const selector = "skills/react.md";

    // When
    const result = normalizeBundleItemSelector(selector);

    // Then
    expect(result).toBe("skills/react");
  });

  it("strips .toml extension", () => {
    // Given
    const selector = "agents/reviewer.toml";

    // When
    const result = normalizeBundleItemSelector(selector);

    // Then
    expect(result).toBe("agents/reviewer");
  });

  it("strips .yaml extension", () => {
    // Given
    const selector = "commands/deploy.yaml";

    // When
    const result = normalizeBundleItemSelector(selector);

    // Then
    expect(result).toBe("commands/deploy");
  });

  it("strips .yml extension", () => {
    // Given
    const selector = "commands/deploy.yml";

    // When
    const result = normalizeBundleItemSelector(selector);

    // Then
    expect(result).toBe("commands/deploy");
  });

  it("strips .json extension", () => {
    // Given
    const selector = "skills/config.json";

    // When
    const result = normalizeBundleItemSelector(selector);

    // Then
    expect(result).toBe("skills/config");
  });

  it("strips .agent.md extension before the generic .md rule", () => {
    // Given
    const selector = "agents/reviewer.agent.md";

    // When
    const result = normalizeBundleItemSelector(selector);

    // Then
    expect(result).toBe("agents/reviewer");
  });

  it("normalizes Windows backslashes to forward slashes", () => {
    // Given
    const selector = "skills\\react";

    // When
    const result = normalizeBundleItemSelector(selector);

    // Then
    expect(result).toBe("skills/react");
  });

  it("trims surrounding whitespace", () => {
    // Given
    const selector = "  skills/react  ";

    // When
    const result = normalizeBundleItemSelector(selector);

    // Then
    expect(result).toBe("skills/react");
  });

  it("throws for a nested path with more than one segment after the target", () => {
    // Given
    const selector = "skills/react/SKILL.md";

    // When / Then
    expect(() => normalizeBundleItemSelector(selector)).toThrow(
      "must target one top-level item",
    );
  });

  it("throws for an unrecognised target prefix", () => {
    // Given
    const selector = "unknown/foo";

    // When / Then
    expect(() => normalizeBundleItemSelector(selector)).toThrow(
      "must start with skills/, commands/, agents/",
    );
  });

  it("throws when the item name is absent after the target slash", () => {
    // Given
    const selector = "skills/";

    // When / Then
    expect(() => normalizeBundleItemSelector(selector)).toThrow(
      "missing an item name",
    );
  });

  it("throws when the item name is a single dot", () => {
    // Given
    const selector = "skills/.";

    // When / Then
    expect(() => normalizeBundleItemSelector(selector)).toThrow(
      "missing an item name",
    );
  });

  it("throws when the item name is double-dot", () => {
    // Given
    const selector = "skills/..";

    // When / Then
    expect(() => normalizeBundleItemSelector(selector)).toThrow(
      "missing an item name",
    );
  });
});

// ---------------------------------------------------------------------------
// normalizeBundleItemSelectors
// ---------------------------------------------------------------------------

describe("normalizeBundleItemSelectors", () => {
  it("normalizes every entry in the list", () => {
    // Given
    const selectors = ["skills/react.md", "commands/review"];

    // When
    const result = normalizeBundleItemSelectors(selectors);

    // Then
    expect(result).toEqual(["skills/react", "commands/review"]);
  });

  it("deduplicates selectors that normalize to the same value", () => {
    // Given
    const selectors = ["skills/react", "skills/react.md"];

    // When
    const result = normalizeBundleItemSelectors(selectors);

    // Then
    expect(result).toEqual(["skills/react"]);
  });

  it("deduplicates root-instruction aliases", () => {
    // Given
    const selectors = ["CLAUDE.md", "root-instruction"];

    // When
    const result = normalizeBundleItemSelectors(selectors);

    // Then
    expect(result).toEqual(["root-instruction"]);
  });

  it("returns an empty array for empty input", () => {
    // When
    const result = normalizeBundleItemSelectors([]);

    // Then
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isRootInstructionItemSelected
// ---------------------------------------------------------------------------

describe("isRootInstructionItemSelected", () => {
  it("returns true when selectors is undefined (whole bundle selected)", () => {
    // When
    const result = isRootInstructionItemSelected(undefined);

    // Then
    expect(result).toBe(true);
  });

  it("returns true when selectors includes root-instruction", () => {
    // Given
    const selectors = ["root-instruction", "skills/react"];

    // When
    const result = isRootInstructionItemSelected(selectors);

    // Then
    expect(result).toBe(true);
  });

  it("returns false when selectors does not include root-instruction", () => {
    // Given
    const selectors = ["skills/react"];

    // When
    const result = isRootInstructionItemSelected(selectors);

    // Then
    expect(result).toBe(false);
  });

  it("returns false for an empty selector list", () => {
    // When
    const result = isRootInstructionItemSelected([]);

    // Then
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDirectoryItemSelected
// ---------------------------------------------------------------------------

describe("isDirectoryItemSelected", () => {
  it("returns true when selectors is undefined (whole bundle)", () => {
    // When
    const result = isDirectoryItemSelected({
      selectors: undefined,
      targetName: "skills",
      entryName: "react",
    });

    // Then
    expect(result).toBe(true);
  });

  it("returns true when the selector list contains the normalised entry", () => {
    // Given
    const selectors = ["skills/react"];

    // When
    const result = isDirectoryItemSelected({
      selectors,
      targetName: "skills",
      entryName: "react",
    });

    // Then
    expect(result).toBe(true);
  });

  it("strips a known extension from the entry name before matching", () => {
    // Given
    const selectors = ["skills/react"];

    // When
    const result = isDirectoryItemSelected({
      selectors,
      targetName: "skills",
      entryName: "react.md",
    });

    // Then
    expect(result).toBe(true);
  });

  it("returns false when the entry is absent from the selector list", () => {
    // Given
    const selectors = ["skills/other"];

    // When
    const result = isDirectoryItemSelected({
      selectors,
      targetName: "skills",
      entryName: "react",
    });

    // Then
    expect(result).toBe(false);
  });

  it("returns false when the selector targets a different target type", () => {
    // Given
    const selectors = ["commands/react"];

    // When
    const result = isDirectoryItemSelected({
      selectors,
      targetName: "skills",
      entryName: "react",
    });

    // Then
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listSelectableBundleItems
// ---------------------------------------------------------------------------

describe("listSelectableBundleItems", () => {
  it("adds root-instruction when the manifest declares a root_instruction target", () => {
    // Given
    const bundleDir = createTempDir();
    writeFile(path.join(bundleDir, "CLAUDE.md"), "# instructions");
    const manifest: BundleManifest = {
      tools: { "claude-code": { root_instruction: { path: "CLAUDE.md" } } },
    };

    // When
    const items = listSelectableBundleItems({ bundleDir, manifest });

    // Then
    expect(items).toContain("root-instruction");
  });

  it("lists skills as directories only", () => {
    // Given: a directory is a valid skill; a loose file under skills/ is not
    const bundleDir = createTempDir();
    fs.mkdirSync(path.join(bundleDir, "skills", "react"), { recursive: true });
    writeFile(path.join(bundleDir, "skills", "react", "SKILL.md"), "# react");
    writeFile(path.join(bundleDir, "skills", "loose.md"), "# loose");
    const manifest: BundleManifest = {
      tools: { "claude-code": { skills: { path: "skills" } } },
    };

    // When
    const items = listSelectableBundleItems({ bundleDir, manifest });

    // Then
    expect(items).toEqual(["skills/react"]);
    expect(items).not.toContain("skills/loose");
  });

  it("lists skill reference files alongside skill directories", () => {
    // Given
    const bundleDir = createTempDir();
    fs.mkdirSync(path.join(bundleDir, "skills", "react"), { recursive: true });
    writeFile(path.join(bundleDir, "skills", "react", "SKILL.md"), "# react");
    writeFile(
      path.join(bundleDir, "skills", "insane-search.ref.json"),
      JSON.stringify({ source: "fivetaku/insane-search" }),
    );
    const manifest: BundleManifest = {
      tools: { "claude-code": { skills: { path: "skills" } } },
    };

    // When
    const items = listSelectableBundleItems({ bundleDir, manifest });

    // Then
    expect(items).toEqual(["skills/insane-search", "skills/react"]);
  });

  it("lists commands as files with extensions stripped", () => {
    // Given
    const bundleDir = createTempDir();
    writeFile(path.join(bundleDir, "commands", "review.md"), "# review");
    const manifest: BundleManifest = {
      tools: { "claude-code": { commands: { path: "commands" } } },
    };

    // When
    const items = listSelectableBundleItems({ bundleDir, manifest });

    // Then
    expect(items).toContain("commands/review");
    expect(items).not.toContain("commands/review.md");
  });

  it("returns a sorted, deduplicated list when multiple tools share the same canonical path", () => {
    // Given
    const bundleDir = createTempDir();
    fs.mkdirSync(path.join(bundleDir, "skills", "react"), { recursive: true });
    writeFile(path.join(bundleDir, "skills", "react", "SKILL.md"), "# react");
    fs.mkdirSync(path.join(bundleDir, "skills", "vue"), { recursive: true });
    writeFile(path.join(bundleDir, "skills", "vue", "SKILL.md"), "# vue");
    const manifest: BundleManifest = {
      tools: {
        "claude-code": { skills: { path: "skills" } },
        cursor: { skills: { path: "skills" } },
      },
    };

    // When
    const items = listSelectableBundleItems({ bundleDir, manifest });

    // Then: deduplicated and sorted
    expect(items).toEqual(["skills/react", "skills/vue"]);
  });

  it("filters to the specified tools when a tools array is provided", () => {
    // Given
    const bundleDir = createTempDir();
    fs.mkdirSync(path.join(bundleDir, "skills", "react"), { recursive: true });
    writeFile(path.join(bundleDir, "skills", "react", "SKILL.md"), "# react");
    writeFile(path.join(bundleDir, "commands", "review.md"), "# review");
    const manifest: BundleManifest = {
      tools: {
        "claude-code": {
          skills: { path: "skills" },
          commands: { path: "commands" },
        },
        cursor: { commands: { path: "commands" } },
      },
    };

    // When: ask only for cursor, which has no skills target
    const items = listSelectableBundleItems({
      bundleDir,
      manifest,
      tools: ["cursor"],
    });

    // Then
    expect(items).toContain("commands/review");
    expect(items).not.toContain("skills/react");
  });

  it("returns an empty list when the target directory does not exist", () => {
    // Given
    const bundleDir = createTempDir();
    const manifest: BundleManifest = {
      tools: { "claude-code": { skills: { path: "skills" } } },
    };

    // When
    const items = listSelectableBundleItems({ bundleDir, manifest });

    // Then
    expect(items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// assertBundleSupportsRequestedItems
// ---------------------------------------------------------------------------

describe("assertBundleSupportsRequestedItems", () => {
  it("does not throw when all requested items are available", () => {
    // Given
    const requestedItems = ["skills/react", "root-instruction"];
    const availableItems = [
      "root-instruction",
      "skills/react",
      "commands/review",
    ];

    // When / Then
    expect(() =>
      assertBundleSupportsRequestedItems({ requestedItems, availableItems }),
    ).not.toThrow();
  });

  it("does not throw when requestedItems is empty", () => {
    // Given
    const requestedItems: string[] = [];
    const availableItems = ["skills/react"];

    // When / Then
    expect(() =>
      assertBundleSupportsRequestedItems({ requestedItems, availableItems }),
    ).not.toThrow();
  });

  it("throws and names the missing item", () => {
    // Given
    const requestedItems = ["skills/missing"];
    const availableItems = ["skills/react"];

    // When / Then
    expect(() =>
      assertBundleSupportsRequestedItems({ requestedItems, availableItems }),
    ).toThrow("skills/missing");
  });

  it("includes the available items list in the error message", () => {
    // Given
    const requestedItems = ["skills/missing"];
    const availableItems = ["skills/react"];

    // When / Then
    expect(() =>
      assertBundleSupportsRequestedItems({ requestedItems, availableItems }),
    ).toThrow("skills/react");
  });

  it("throws when multiple requested items are missing", () => {
    // Given
    const requestedItems = ["skills/a", "commands/b"];
    const availableItems = ["skills/react"];

    // When / Then
    expect(() =>
      assertBundleSupportsRequestedItems({ requestedItems, availableItems }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// mergeDesiredBundleItems
// ---------------------------------------------------------------------------

describe("mergeDesiredBundleItems", () => {
  it("returns undefined when requestedItems is undefined (whole bundle)", () => {
    // Given
    const existingItems = ["skills/react"];

    // When
    const result = mergeDesiredBundleItems({
      requestedItems: undefined,
      existingItems,
    });

    // Then
    expect(result).toBeUndefined();
  });

  it("replaces existing items when replace is true", () => {
    // Given
    const existingItems = ["skills/react"];
    const requestedItems = ["commands/review"];

    // When
    const result = mergeDesiredBundleItems({
      existingItems,
      requestedItems,
      replace: true,
    });

    // Then
    expect(result).toEqual(["commands/review"]);
  });

  it("returns an empty array when replace is true and requestedItems is empty", () => {
    // Given
    const existingItems = ["skills/react"];

    // When
    const result = mergeDesiredBundleItems({
      existingItems,
      requestedItems: [],
      replace: true,
    });

    // Then
    expect(result).toEqual([]);
  });

  it("unions existing and requested items when replace is false", () => {
    // Given
    const existingItems = ["skills/react"];
    const requestedItems = ["commands/review"];

    // When
    const result = mergeDesiredBundleItems({ existingItems, requestedItems });

    // Then
    expect(result).toEqual(["skills/react", "commands/review"]);
  });

  it("deduplicates items already present in existingItems", () => {
    // Given
    const existingItems = ["skills/react"];
    const requestedItems = ["skills/react", "commands/review"];

    // When
    const result = mergeDesiredBundleItems({ existingItems, requestedItems });

    // Then
    expect(result).toEqual(["skills/react", "commands/review"]);
  });

  it("treats missing existingItems as an empty list", () => {
    // Given
    const requestedItems = ["skills/react"];

    // When
    const result = mergeDesiredBundleItems({ requestedItems });

    // Then
    expect(result).toEqual(["skills/react"]);
  });
});

// ---------------------------------------------------------------------------
// bundleItemSelectionsEqual
// ---------------------------------------------------------------------------

describe("bundleItemSelectionsEqual", () => {
  it("returns true when both are undefined", () => {
    // When
    const result = bundleItemSelectionsEqual(undefined, undefined);

    // Then
    expect(result).toBe(true);
  });

  it("returns false when left is undefined and right is not", () => {
    // When
    const result = bundleItemSelectionsEqual(undefined, ["skills/react"]);

    // Then
    expect(result).toBe(false);
  });

  it("returns false when right is undefined and left is not", () => {
    // When
    const result = bundleItemSelectionsEqual(["skills/react"], undefined);

    // Then
    expect(result).toBe(false);
  });

  it("returns true for two equal arrays in the same order", () => {
    // Given
    const left = ["skills/react", "commands/review"];
    const right = ["skills/react", "commands/review"];

    // When
    const result = bundleItemSelectionsEqual(left, right);

    // Then
    expect(result).toBe(true);
  });

  it("returns true for the same items in different order", () => {
    // Given
    const left = ["commands/review", "skills/react"];
    const right = ["skills/react", "commands/review"];

    // When
    const result = bundleItemSelectionsEqual(left, right);

    // Then
    expect(result).toBe(true);
  });

  it("returns false for arrays with different lengths", () => {
    // Given
    const left = ["skills/react"];
    const right = ["skills/react", "commands/review"];

    // When
    const result = bundleItemSelectionsEqual(left, right);

    // Then
    expect(result).toBe(false);
  });

  it("returns false for arrays with different items", () => {
    // Given
    const left = ["skills/react"];
    const right = ["skills/vue"];

    // When
    const result = bundleItemSelectionsEqual(left, right);

    // Then
    expect(result).toBe(false);
  });

  it("returns true for two empty arrays", () => {
    // When
    const result = bundleItemSelectionsEqual([], []);

    // Then
    expect(result).toBe(true);
  });
});
