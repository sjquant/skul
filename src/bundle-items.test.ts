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
    expect(normalizeBundleItemSelector("root-instruction")).toBe(
      "root-instruction",
    );
  });

  it("normalizes CLAUDE.md alias to root-instruction", () => {
    expect(normalizeBundleItemSelector("CLAUDE.md")).toBe("root-instruction");
  });

  it("normalizes AGENTS.md alias to root-instruction", () => {
    expect(normalizeBundleItemSelector("AGENTS.md")).toBe("root-instruction");
  });

  it("normalizes GEMINI.md alias to root-instruction", () => {
    expect(normalizeBundleItemSelector("GEMINI.md")).toBe("root-instruction");
  });

  it("normalizes .github/copilot-instructions.md alias to root-instruction", () => {
    expect(
      normalizeBundleItemSelector(".github/copilot-instructions.md"),
    ).toBe("root-instruction");
  });

  it("accepts a plain skills selector with no extension", () => {
    expect(normalizeBundleItemSelector("skills/react")).toBe("skills/react");
  });

  it("accepts a plain commands selector", () => {
    expect(normalizeBundleItemSelector("commands/review")).toBe(
      "commands/review",
    );
  });

  it("accepts a plain agents selector", () => {
    expect(normalizeBundleItemSelector("agents/reviewer")).toBe(
      "agents/reviewer",
    );
  });

  it("strips .md extension", () => {
    expect(normalizeBundleItemSelector("skills/react.md")).toBe("skills/react");
  });

  it("strips .toml extension", () => {
    expect(normalizeBundleItemSelector("agents/reviewer.toml")).toBe(
      "agents/reviewer",
    );
  });

  it("strips .yaml extension", () => {
    expect(normalizeBundleItemSelector("commands/deploy.yaml")).toBe(
      "commands/deploy",
    );
  });

  it("strips .yml extension", () => {
    expect(normalizeBundleItemSelector("commands/deploy.yml")).toBe(
      "commands/deploy",
    );
  });

  it("strips .json extension", () => {
    expect(normalizeBundleItemSelector("skills/config.json")).toBe(
      "skills/config",
    );
  });

  it("strips .agent.md extension before the generic .md rule", () => {
    expect(normalizeBundleItemSelector("agents/reviewer.agent.md")).toBe(
      "agents/reviewer",
    );
  });

  it("normalizes Windows backslashes to forward slashes", () => {
    expect(normalizeBundleItemSelector("skills\\react")).toBe("skills/react");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeBundleItemSelector("  skills/react  ")).toBe("skills/react");
  });

  it("throws for a nested path with more than one segment after the target", () => {
    expect(() =>
      normalizeBundleItemSelector("skills/react/SKILL.md"),
    ).toThrow("must target one top-level item");
  });

  it("throws for an unrecognised target prefix", () => {
    expect(() => normalizeBundleItemSelector("unknown/foo")).toThrow(
      "must start with skills/, commands/, agents/",
    );
  });

  it("throws when the item name is absent after the target slash", () => {
    expect(() => normalizeBundleItemSelector("skills/")).toThrow(
      "missing an item name",
    );
  });

  it("throws when the item name is a single dot", () => {
    expect(() => normalizeBundleItemSelector("skills/.")).toThrow(
      "missing an item name",
    );
  });

  it("throws when the item name is double-dot", () => {
    expect(() => normalizeBundleItemSelector("skills/..")).toThrow(
      "missing an item name",
    );
  });
});

// ---------------------------------------------------------------------------
// normalizeBundleItemSelectors
// ---------------------------------------------------------------------------

describe("normalizeBundleItemSelectors", () => {
  it("normalizes every entry in the list", () => {
    expect(
      normalizeBundleItemSelectors(["skills/react.md", "commands/review"]),
    ).toEqual(["skills/react", "commands/review"]);
  });

  it("deduplicates selectors that normalize to the same value", () => {
    expect(
      normalizeBundleItemSelectors(["skills/react", "skills/react.md"]),
    ).toEqual(["skills/react"]);
  });

  it("deduplicates root-instruction aliases", () => {
    expect(
      normalizeBundleItemSelectors(["CLAUDE.md", "root-instruction"]),
    ).toEqual(["root-instruction"]);
  });

  it("returns an empty array for empty input", () => {
    expect(normalizeBundleItemSelectors([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isRootInstructionItemSelected
// ---------------------------------------------------------------------------

describe("isRootInstructionItemSelected", () => {
  it("returns true when selectors is undefined (whole bundle selected)", () => {
    expect(isRootInstructionItemSelected(undefined)).toBe(true);
  });

  it("returns true when selectors includes root-instruction", () => {
    expect(
      isRootInstructionItemSelected(["root-instruction", "skills/react"]),
    ).toBe(true);
  });

  it("returns false when selectors does not include root-instruction", () => {
    expect(isRootInstructionItemSelected(["skills/react"])).toBe(false);
  });

  it("returns false for an empty selector list", () => {
    expect(isRootInstructionItemSelected([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDirectoryItemSelected
// ---------------------------------------------------------------------------

describe("isDirectoryItemSelected", () => {
  it("returns true when selectors is undefined (whole bundle)", () => {
    expect(
      isDirectoryItemSelected({
        selectors: undefined,
        targetName: "skills",
        entryName: "react",
      }),
    ).toBe(true);
  });

  it("returns true when the selector list contains the normalised entry", () => {
    expect(
      isDirectoryItemSelected({
        selectors: ["skills/react"],
        targetName: "skills",
        entryName: "react",
      }),
    ).toBe(true);
  });

  it("strips a known extension from the entry name before matching", () => {
    expect(
      isDirectoryItemSelected({
        selectors: ["skills/react"],
        targetName: "skills",
        entryName: "react.md",
      }),
    ).toBe(true);
  });

  it("returns false when the entry is absent from the selector list", () => {
    expect(
      isDirectoryItemSelected({
        selectors: ["skills/other"],
        targetName: "skills",
        entryName: "react",
      }),
    ).toBe(false);
  });

  it("returns false when the selector targets a different target type", () => {
    expect(
      isDirectoryItemSelected({
        selectors: ["commands/react"],
        targetName: "skills",
        entryName: "react",
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listSelectableBundleItems
// ---------------------------------------------------------------------------

describe("listSelectableBundleItems", () => {
  it("adds root-instruction when the manifest declares a root_instruction target", () => {
    const bundleDir = createTempDir();
    writeFile(path.join(bundleDir, "CLAUDE.md"), "# instructions");

    const manifest: BundleManifest = {
      tools: { "claude-code": { root_instruction: { path: "CLAUDE.md" } } },
    };

    const items = listSelectableBundleItems({ bundleDir, manifest });
    expect(items).toContain("root-instruction");
  });

  it("lists skills as directories only", () => {
    const bundleDir = createTempDir();
    // A directory is a valid skill
    fs.mkdirSync(path.join(bundleDir, "skills", "react"), { recursive: true });
    writeFile(
      path.join(bundleDir, "skills", "react", "SKILL.md"),
      "# react",
    );
    // A loose file directly under skills/ is not selectable
    writeFile(path.join(bundleDir, "skills", "loose.md"), "# loose");

    const manifest: BundleManifest = {
      tools: { "claude-code": { skills: { path: "skills" } } },
    };

    const items = listSelectableBundleItems({ bundleDir, manifest });
    expect(items).toEqual(["skills/react"]);
    expect(items).not.toContain("skills/loose");
  });

  it("lists commands as files with extensions stripped", () => {
    const bundleDir = createTempDir();
    writeFile(path.join(bundleDir, "commands", "review.md"), "# review");

    const manifest: BundleManifest = {
      tools: { "claude-code": { commands: { path: "commands" } } },
    };

    const items = listSelectableBundleItems({ bundleDir, manifest });
    expect(items).toContain("commands/review");
    expect(items).not.toContain("commands/review.md");
  });

  it("returns a sorted, deduplicated list when multiple tools share the same canonical path", () => {
    const bundleDir = createTempDir();
    fs.mkdirSync(path.join(bundleDir, "skills", "react"), { recursive: true });
    writeFile(
      path.join(bundleDir, "skills", "react", "SKILL.md"),
      "# react",
    );
    fs.mkdirSync(path.join(bundleDir, "skills", "vue"), { recursive: true });
    writeFile(path.join(bundleDir, "skills", "vue", "SKILL.md"), "# vue");

    const manifest: BundleManifest = {
      tools: {
        "claude-code": { skills: { path: "skills" } },
        cursor: { skills: { path: "skills" } },
      },
    };

    const items = listSelectableBundleItems({ bundleDir, manifest });
    expect(items).toEqual(["skills/react", "skills/vue"]);
  });

  it("filters to the specified tools when a tools array is provided", () => {
    const bundleDir = createTempDir();
    fs.mkdirSync(path.join(bundleDir, "skills", "react"), { recursive: true });
    writeFile(
      path.join(bundleDir, "skills", "react", "SKILL.md"),
      "# react",
    );
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

    // Ask only for cursor — it only has commands, not skills
    const items = listSelectableBundleItems({
      bundleDir,
      manifest,
      tools: ["cursor"],
    });
    expect(items).toContain("commands/review");
    expect(items).not.toContain("skills/react");
  });

  it("returns an empty list when the target directory does not exist", () => {
    const bundleDir = createTempDir();
    const manifest: BundleManifest = {
      tools: { "claude-code": { skills: { path: "skills" } } },
    };
    expect(listSelectableBundleItems({ bundleDir, manifest })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// assertBundleSupportsRequestedItems
// ---------------------------------------------------------------------------

describe("assertBundleSupportsRequestedItems", () => {
  it("does not throw when all requested items are available", () => {
    expect(() =>
      assertBundleSupportsRequestedItems({
        requestedItems: ["skills/react", "root-instruction"],
        availableItems: ["root-instruction", "skills/react", "commands/review"],
      }),
    ).not.toThrow();
  });

  it("does not throw when requestedItems is empty", () => {
    expect(() =>
      assertBundleSupportsRequestedItems({
        requestedItems: [],
        availableItems: ["skills/react"],
      }),
    ).not.toThrow();
  });

  it("throws and names the missing item", () => {
    expect(() =>
      assertBundleSupportsRequestedItems({
        requestedItems: ["skills/missing"],
        availableItems: ["skills/react"],
      }),
    ).toThrow("skills/missing");
  });

  it("includes the available items list in the error message", () => {
    expect(() =>
      assertBundleSupportsRequestedItems({
        requestedItems: ["skills/missing"],
        availableItems: ["skills/react"],
      }),
    ).toThrow("skills/react");
  });

  it("throws when multiple requested items are missing", () => {
    expect(() =>
      assertBundleSupportsRequestedItems({
        requestedItems: ["skills/a", "commands/b"],
        availableItems: ["skills/react"],
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// mergeDesiredBundleItems
// ---------------------------------------------------------------------------

describe("mergeDesiredBundleItems", () => {
  it("returns undefined when requestedItems is undefined (whole bundle)", () => {
    expect(
      mergeDesiredBundleItems({
        requestedItems: undefined,
        existingItems: ["skills/react"],
      }),
    ).toBeUndefined();
  });

  it("replaces existing items when replace is true", () => {
    expect(
      mergeDesiredBundleItems({
        existingItems: ["skills/react"],
        requestedItems: ["commands/review"],
        replace: true,
      }),
    ).toEqual(["commands/review"]);
  });

  it("returns an empty array when replace is true and requestedItems is empty", () => {
    expect(
      mergeDesiredBundleItems({
        existingItems: ["skills/react"],
        requestedItems: [],
        replace: true,
      }),
    ).toEqual([]);
  });

  it("unions existing and requested items when replace is false", () => {
    expect(
      mergeDesiredBundleItems({
        existingItems: ["skills/react"],
        requestedItems: ["commands/review"],
      }),
    ).toEqual(["skills/react", "commands/review"]);
  });

  it("deduplicates items already present in existingItems", () => {
    expect(
      mergeDesiredBundleItems({
        existingItems: ["skills/react"],
        requestedItems: ["skills/react", "commands/review"],
      }),
    ).toEqual(["skills/react", "commands/review"]);
  });

  it("treats missing existingItems as an empty list", () => {
    expect(
      mergeDesiredBundleItems({ requestedItems: ["skills/react"] }),
    ).toEqual(["skills/react"]);
  });
});

// ---------------------------------------------------------------------------
// bundleItemSelectionsEqual
// ---------------------------------------------------------------------------

describe("bundleItemSelectionsEqual", () => {
  it("returns true when both are undefined", () => {
    expect(bundleItemSelectionsEqual(undefined, undefined)).toBe(true);
  });

  it("returns false when left is undefined and right is not", () => {
    expect(bundleItemSelectionsEqual(undefined, ["skills/react"])).toBe(false);
  });

  it("returns false when right is undefined and left is not", () => {
    expect(bundleItemSelectionsEqual(["skills/react"], undefined)).toBe(false);
  });

  it("returns true for two equal arrays in the same order", () => {
    expect(
      bundleItemSelectionsEqual(
        ["skills/react", "commands/review"],
        ["skills/react", "commands/review"],
      ),
    ).toBe(true);
  });

  it("returns true for the same items in different order", () => {
    expect(
      bundleItemSelectionsEqual(
        ["commands/review", "skills/react"],
        ["skills/react", "commands/review"],
      ),
    ).toBe(true);
  });

  it("returns false for arrays with different lengths", () => {
    expect(
      bundleItemSelectionsEqual(
        ["skills/react"],
        ["skills/react", "commands/review"],
      ),
    ).toBe(false);
  });

  it("returns false for arrays with different items", () => {
    expect(
      bundleItemSelectionsEqual(["skills/react"], ["skills/vue"]),
    ).toBe(false);
  });

  it("returns true for two empty arrays", () => {
    expect(bundleItemSelectionsEqual([], [])).toBe(true);
  });
});
