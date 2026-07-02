import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isSkillRefFileName,
  parseSkillRefFile,
  resolveBundleSkillRefs,
  skillRefNameFromFileName,
} from "./bundle-skill-refs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeSkillRef(filePath: string, ref: object): void {
  writeFile(filePath, JSON.stringify(ref));
}

// ---------------------------------------------------------------------------
// isSkillRefFileName / skillRefNameFromFileName
// ---------------------------------------------------------------------------

describe("isSkillRefFileName", () => {
  it("recognizes files ending in .ref.json", () => {
    // Given / When / Then
    expect(isSkillRefFileName("insane-search.ref.json")).toBe(true);
  });

  it("rejects a bare .ref.json filename with no local name", () => {
    // Given / When / Then
    expect(isSkillRefFileName(".ref.json")).toBe(false);
  });

  it("rejects regular skill directories and unrelated files", () => {
    // Given / When / Then
    expect(isSkillRefFileName("insane-search")).toBe(false);
    expect(isSkillRefFileName("manifest.json")).toBe(false);
  });
});

describe("skillRefNameFromFileName", () => {
  it("strips the .ref.json suffix", () => {
    // Given
    const fileName = "insane-search.ref.json";

    // When
    const result = skillRefNameFromFileName(fileName);

    // Then
    expect(result).toBe("insane-search");
  });
});

// ---------------------------------------------------------------------------
// parseSkillRefFile
// ---------------------------------------------------------------------------

describe("parseSkillRefFile", () => {
  it("defaults item to skills/<refName> when omitted", () => {
    // Given
    const dir = createTempDir("skul-ref-");
    const filePath = path.join(dir, "insane-search.ref.json");
    writeSkillRef(filePath, { source: "fivetaku/insane-search" });

    // When
    const result = parseSkillRefFile({ filePath, refName: "insane-search" });

    // Then
    expect(result).toEqual({
      source: "fivetaku/insane-search",
      item: "skills/insane-search",
    });
  });

  it("preserves an explicit item, bundle, and ref", () => {
    // Given
    const dir = createTempDir("skul-ref-");
    const filePath = path.join(dir, "search.ref.json");
    writeSkillRef(filePath, {
      source: "fivetaku/insane-search",
      bundle: "core",
      item: "skills/other-name",
      ref: "stable",
    });

    // When
    const result = parseSkillRefFile({ filePath, refName: "search" });

    // Then
    expect(result).toEqual({
      source: "fivetaku/insane-search",
      bundle: "core",
      item: "skills/other-name",
      ref: "stable",
    });
  });

  it("throws when source is missing", () => {
    // Given
    const dir = createTempDir("skul-ref-");
    const filePath = path.join(dir, "search.ref.json");
    writeSkillRef(filePath, {});

    // When / Then
    expect(() =>
      parseSkillRefFile({ filePath, refName: "search" }),
    ).toThrowError(/"source" is required/);
  });

  it("throws when both ref and pin are set", () => {
    // Given
    const dir = createTempDir("skul-ref-");
    const filePath = path.join(dir, "search.ref.json");
    writeSkillRef(filePath, {
      source: "fivetaku/insane-search",
      ref: "main",
      pin: "abc1234",
    });

    // When / Then
    expect(() =>
      parseSkillRefFile({ filePath, refName: "search" }),
    ).toThrowError(/cannot set both "ref" and "pin"/);
  });

  it("throws when item does not start with skills/", () => {
    // Given
    const dir = createTempDir("skul-ref-");
    const filePath = path.join(dir, "search.ref.json");
    writeSkillRef(filePath, {
      source: "fivetaku/insane-search",
      item: "commands/search",
    });

    // When / Then
    expect(() =>
      parseSkillRefFile({ filePath, refName: "search" }),
    ).toThrowError(/must be skills\/<name>/);
  });

  it("throws a clear error on invalid JSON", () => {
    // Given
    const dir = createTempDir("skul-ref-");
    const filePath = path.join(dir, "search.ref.json");
    writeFile(filePath, "{ not json");

    // When / Then
    expect(() =>
      parseSkillRefFile({ filePath, refName: "search" }),
    ).toThrowError(/Failed to parse skill reference/);
  });
});

// ---------------------------------------------------------------------------
// resolveBundleSkillRefs
// ---------------------------------------------------------------------------

function writeCachedSkill(options: {
  libraryDir: string;
  source: string;
  bundle: string;
  skillName: string;
  skillsPath?: string;
}): void {
  const skillsPath = options.skillsPath ?? "skills";
  const bundleDir = path.join(
    options.libraryDir,
    ...options.source.split("/"),
    options.bundle,
  );
  writeFile(
    path.join(bundleDir, skillsPath, options.skillName, "SKILL.md"),
    [
      "---",
      `name: ${options.skillName}`,
      "description: An externally referenced skill",
      "---",
      "",
      "Do the thing.",
      "",
    ].join("\n"),
  );
}

describe("resolveBundleSkillRefs", () => {
  it("returns an empty map when the bundle has no skills directory", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");

    // When
    const result = await resolveBundleSkillRefs({ bundleDir, libraryDir });

    // Then
    expect(result.size).toBe(0);
  });

  it("returns an empty map when the skills directory has no ref files", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "skills", "local", "SKILL.md"),
      "---\nname: local\ndescription: local skill\n---\n",
    );

    // When
    const result = await resolveBundleSkillRefs({ bundleDir, libraryDir });

    // Then
    expect(result.size).toBe(0);
  });

  it("resolves a ref to a single-bundle referenced source by repo slug", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    writeCachedSkill({
      libraryDir,
      source: "github.com/fivetaku/insane-search",
      bundle: "insane-search",
      skillName: "insane-search",
    });
    writeSkillRef(path.join(bundleDir, "skills", "insane-search.ref.json"), {
      source: "fivetaku/insane-search",
    });

    // When
    const result = await resolveBundleSkillRefs({ bundleDir, libraryDir });

    // Then
    expect(result.size).toBe(1);
    expect(result.get("skills/insane-search.ref.json")).toBe(
      path.join(
        libraryDir,
        "github.com",
        "fivetaku",
        "insane-search",
        "insane-search",
        "skills",
        "insane-search",
      ),
    );
  });

  it("resolves a ref with an explicit bundle field against a multi-bundle source", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    writeCachedSkill({
      libraryDir,
      source: "github.com/fivetaku/tools",
      bundle: "core",
      skillName: "insane-search",
    });
    writeCachedSkill({
      libraryDir,
      source: "github.com/fivetaku/tools",
      bundle: "extra",
      skillName: "other",
    });
    writeSkillRef(path.join(bundleDir, "skills", "insane-search.ref.json"), {
      source: "fivetaku/tools",
      bundle: "core",
    });

    // When
    const result = await resolveBundleSkillRefs({ bundleDir, libraryDir });

    // Then
    expect(result.get("skills/insane-search.ref.json")).toBe(
      path.join(
        libraryDir,
        "github.com",
        "fivetaku",
        "tools",
        "core",
        "skills",
        "insane-search",
      ),
    );
  });

  it("throws when the referenced source has multiple bundles and none is specified", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    writeCachedSkill({
      libraryDir,
      source: "github.com/fivetaku/tools",
      bundle: "core",
      skillName: "insane-search",
    });
    writeCachedSkill({
      libraryDir,
      source: "github.com/fivetaku/tools",
      bundle: "extra",
      skillName: "insane-search",
    });
    writeSkillRef(path.join(bundleDir, "skills", "insane-search.ref.json"), {
      source: "fivetaku/tools",
    });

    // When / Then
    await expect(
      resolveBundleSkillRefs({ bundleDir, libraryDir }),
    ).rejects.toThrowError(/multiple bundles/);
  });

  it("throws when the referenced skill does not exist in the source bundle", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    writeCachedSkill({
      libraryDir,
      source: "github.com/fivetaku/insane-search",
      bundle: "insane-search",
      skillName: "insane-search",
    });
    writeSkillRef(path.join(bundleDir, "skills", "missing.ref.json"), {
      source: "fivetaku/insane-search",
      item: "skills/does-not-exist",
    });

    // When / Then
    await expect(
      resolveBundleSkillRefs({ bundleDir, libraryDir }),
    ).rejects.toThrowError(/Referenced skill "does-not-exist" not found/);
  });

  it("does not chain through a second-level skill reference", async () => {
    // Given: the referenced bundle's own "skills/insane-search" is itself only
    // a ref file, not a real skill directory, so it can't be used as a source.
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    writeSkillRef(
      path.join(
        libraryDir,
        "github.com",
        "fivetaku",
        "insane-search",
        "insane-search",
        "skills",
        "insane-search.ref.json",
      ),
      { source: "someone-else/other" },
    );
    writeSkillRef(path.join(bundleDir, "skills", "insane-search.ref.json"), {
      source: "fivetaku/insane-search",
    });

    // When / Then
    await expect(
      resolveBundleSkillRefs({ bundleDir, libraryDir }),
    ).rejects.toThrowError(/Referenced skill "insane-search" not found/);
  });
});
