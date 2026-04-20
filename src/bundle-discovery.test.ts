import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  detectSourceProtocol,
  findCachedBundle,
  listCachedBundles,
  normalizeBundleSource,
} from "./bundle-discovery";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("detectSourceProtocol", () => {
  it.each([
    ["git@github.com:user/repo.git", "ssh"],
    ["git@gitlab.com:user/repo", "ssh"],
    ["https://github.com/user/repo.git", "https"],
    ["github.com/user/repo", "https"],
    ["user/repo", "https"],
  ])("detects protocol for %s as %s", (input, expected) => {
    expect(detectSourceProtocol(input)).toBe(expected);
  });
});

describe("normalizeBundleSource", () => {
  it.each([
    ["github.com/user/ai-vault", "github.com/user/ai-vault"],
    ["user/ai-vault", "github.com/user/ai-vault"],
    ["https://github.com/user/ai-vault.git", "github.com/user/ai-vault"],
    ["git@github.com:user/ai-vault.git", "github.com/user/ai-vault"],
  ])("normalizes %s", (input, expected) => {
    // Given
    const source = input;

    // When
    const normalized = normalizeBundleSource(source);

    // Then
    expect(normalized).toBe(expected);
  });

  it.each([
    ["empty source", "", /source is required/i],
    ["source with query string", "https://github.com/user/ai-vault?ref=main", /unsupported git source/i],
    ["source without owner and repo", "github.com/user", /unsupported git source/i],
  ])("rejects %s", (_label, input, expectedMessage) => {
    // Given
    const normalize = () => normalizeBundleSource(input);

    // When / Then
    expect(normalize).toThrowError(expectedMessage);
  });
});

describe("listCachedBundles", () => {
  it("discovers cached bundle manifests beneath the library directory", () => {
    // Given
    const libraryDir = createLibraryDir();

    writeManifest(libraryDir, "github.com/user/ai-vault", "react-expert", {
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeManifest(libraryDir, "github.com/user/ai-vault", "repo-standards", {
      tools: { codex: { skills: { path: "skills" } } },
    });

    // When
    const bundles = listCachedBundles({ libraryDir });

    // Then
    expect(bundles).toEqual([
      {
        bundle: "react-expert",
        source: "github.com/user/ai-vault",
        manifestFile: path.join(
          libraryDir,
          "github.com",
          "user",
          "ai-vault",
          "react-expert",
          "manifest.json",
        ),
        manifest: {
          tools: { "claude-code": { skills: { path: "skills" } } },
        },
      },
      {
        bundle: "repo-standards",
        source: "github.com/user/ai-vault",
        manifestFile: path.join(
          libraryDir,
          "github.com",
          "user",
          "ai-vault",
          "repo-standards",
          "manifest.json",
        ),
        manifest: {
          tools: { codex: { skills: { path: "skills" } } },
        },
      },
    ]);
  });

  it("ignores directories without a valid manifest file", () => {
    // Given
    const libraryDir = createLibraryDir();
    const bundleDir = path.join(libraryDir, "github.com", "user", "ai-vault", "broken-bundle");
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "manifest.json"), "{not json");

    // When
    const bundles = listCachedBundles({ libraryDir });

    // Then
    expect(bundles).toEqual([]);
  });

  it("ignores a broken manifest at the repository root and still infers the bundle from the repo slug", () => {
    // Given
    const libraryDir = createLibraryDir();
    const repoDir = path.join(libraryDir, "github.com", "user", "broken-repo");
    fs.mkdirSync(path.join(repoDir, "skills", "react"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "skills", "react", "SKILL.md"), "# react\n");
    fs.writeFileSync(path.join(repoDir, "manifest.json"), "{not json");

    // When
    const bundles = listCachedBundles({ libraryDir });

    // Then
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatchObject({
      source: "github.com/user/broken-repo",
      bundle: "broken-repo",
    });
  });

  it("ignores a broken subdirectory manifest and still infers the repo-root bundle", () => {
    // Given — broken subdir manifest + canonical skills/ dir at the repo root.
    const libraryDir = createLibraryDir();
    const repoDir = path.join(libraryDir, "github.com", "user", "mixed-repo");
    fs.mkdirSync(path.join(repoDir, "broken-bundle"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "broken-bundle", "manifest.json"), "{not json");
    fs.mkdirSync(path.join(repoDir, "skills", "react"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "skills", "react", "SKILL.md"), "# react\n");

    // When
    const bundles = listCachedBundles({ libraryDir });

    // Then — broken child manifests do not block repo-root inference
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatchObject({
      source: "github.com/user/mixed-repo",
      bundle: "mixed-repo",
    });
  });

  it("ignores an unrelated child manifest.json and still infers the repo-root bundle", () => {
    // Given
    const libraryDir = createLibraryDir();
    const repoDir = path.join(libraryDir, "github.com", "user", "site-bundle");
    fs.mkdirSync(path.join(repoDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "docs", "manifest.json"), JSON.stringify({ name: "pwa" }));
    fs.mkdirSync(path.join(repoDir, "skills", "react"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "skills", "react", "SKILL.md"), "# react\n");

    // When
    const bundles = listCachedBundles({ libraryDir });

    // Then
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatchObject({
      source: "github.com/user/site-bundle",
      bundle: "site-bundle",
    });
  });

  it("infers a repo-as-bundle from canonical directories when no manifest.json exists", () => {
    // Given
    const libraryDir = createLibraryDir();
    const repoDir = path.join(libraryDir, "github.com", "user", "react-bundle");
    fs.mkdirSync(path.join(repoDir, "skills", "react"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "skills", "react", "SKILL.md"), "# react\n");

    // When
    const bundles = listCachedBundles({ libraryDir });

    // Then — bundle name defaults to the repo slug
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatchObject({
      source: "github.com/user/react-bundle",
      bundle: "react-bundle",
    });
    expect(Object.keys(bundles[0]!.manifest.tools).length).toBeGreaterThan(0);
  });

  it("infers a manifest-free subdirectory bundle from canonical directories", () => {
    // Given
    const libraryDir = createLibraryDir();
    const bundleDir = path.join(libraryDir, "github.com", "user", "ghosts", "core");
    fs.mkdirSync(path.join(bundleDir, "skills", "wdd"), { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "skills", "wdd", "SKILL.md"), "# wdd\n");

    // When
    const bundles = listCachedBundles({ libraryDir });

    // Then
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatchObject({
      source: "github.com/user/ghosts",
      bundle: "core",
    });
    expect(Object.keys(bundles[0]!.manifest.tools).length).toBeGreaterThan(0);
  });

  it("does not misclassify a repo-root native dotdir as a subdirectory bundle", () => {
    // Given
    const libraryDir = createLibraryDir();
    const repoDir = path.join(libraryDir, "github.com", "user", "native-root");
    fs.mkdirSync(path.join(repoDir, ".claude", "skills", "react"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, ".claude", "skills", "react", "SKILL.md"), "# react\n");

    // When
    const bundles = listCachedBundles({ libraryDir });

    // Then
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatchObject({
      source: "github.com/user/native-root",
      bundle: "native-root",
    });
  });

  it("ignores a repo-root manifest and still infers the bundle from the repo slug", () => {
    // Given
    const libraryDir = createLibraryDir();
    const repoDir = path.join(libraryDir, "github.com", "user", "react-bundle");
    fs.mkdirSync(path.join(repoDir, "skills", "react"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "skills", "react", "SKILL.md"), "# react\n");
    writeManifestAtRepoRoot(libraryDir, "github.com/user/react-bundle", {
      tools: { codex: { skills: { path: "ignored" } } },
    });

    // When
    const bundles = listCachedBundles({ libraryDir });

    // Then
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatchObject({
      source: "github.com/user/react-bundle",
      bundle: "react-bundle",
    });
  });

  it("ignores a repo dir that has no recognisable bundle directories", () => {
    // Given
    const libraryDir = createLibraryDir();
    const repoDir = path.join(libraryDir, "github.com", "user", "no-structure");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, "README.md"), "# hello\n");

    // When
    const bundles = listCachedBundles({ libraryDir });

    // Then
    expect(bundles).toEqual([]);
  });

  it("does not produce an inferred bundle for a multi-bundle repo that already has subdirectory bundles", () => {
    // Given — a typical "bundle library" repo with named subdirs and a canonical dir at the root
    const libraryDir = createLibraryDir();

    writeManifest(libraryDir, "github.com/user/ai-vault", "react-expert", {
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    // A skills/ dir at the repo root would normally trigger inference
    const repoDir = path.join(libraryDir, "github.com", "user", "ai-vault");
    fs.mkdirSync(path.join(repoDir, "skills", "shared"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "skills", "shared", "SKILL.md"), "# shared\n");

    // When
    const bundles = listCachedBundles({ libraryDir });

    // Then — only the explicit subdir bundle, no ghost inferred bundle
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.bundle).toBe("react-expert");
  });
});

describe("findCachedBundle", () => {
  it("finds a bundle by explicit Git source after normalization", () => {
    // Given
    const libraryDir = createLibraryDir();

    writeManifest(libraryDir, "github.com/user/ai-vault", "react-expert", {
      tools: { "claude-code": { skills: { path: "skills" } } },
    });

    // When
    const bundle = findCachedBundle({
      libraryDir,
      source: "git@github.com:user/ai-vault.git",
      bundle: "react-expert",
    });

    // Then
    expect(bundle).toMatchObject({
      source: "github.com/user/ai-vault",
      bundle: "react-expert",
    });
  });

  it("finds a uniquely named bundle without an explicit source", () => {
    // Given
    const libraryDir = createLibraryDir();

    writeManifest(libraryDir, "github.com/user/ai-vault", "react-expert", {
      tools: { "claude-code": { skills: { path: "skills" } } },
    });

    // When
    const bundle = findCachedBundle({ libraryDir, bundle: "react-expert" });

    // Then
    expect(bundle).toMatchObject({
      source: "github.com/user/ai-vault",
      bundle: "react-expert",
    });
  });

  it("finds an inferred repo-as-bundle by source when bundle name equals the repo slug", () => {
    // Given
    const libraryDir = createLibraryDir();
    const repoDir = path.join(libraryDir, "github.com", "user", "react-bundle");
    fs.mkdirSync(path.join(repoDir, "skills", "react"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "skills", "react", "SKILL.md"), "# react\n");

    // When
    const bundle = findCachedBundle({
      libraryDir,
      source: "github.com/user/react-bundle",
      bundle: "react-bundle",
    });

    // Then
    expect(bundle).toMatchObject({
      source: "github.com/user/react-bundle",
      bundle: "react-bundle",
    });
    expect(Object.keys(bundle.manifest.tools).length).toBeGreaterThan(0);
  });

  it("finds an inferred manifest-free subdirectory bundle by source", () => {
    // Given
    const libraryDir = createLibraryDir();
    const bundleDir = path.join(libraryDir, "github.com", "user", "ghosts", "core");
    fs.mkdirSync(path.join(bundleDir, "skills", "wdd"), { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "skills", "wdd", "SKILL.md"), "# wdd\n");

    // When
    const bundle = findCachedBundle({
      libraryDir,
      source: "github.com/user/ghosts",
      bundle: "core",
    });

    // Then
    expect(bundle).toMatchObject({
      source: "github.com/user/ghosts",
      bundle: "core",
    });
    expect(Object.keys(bundle.manifest.tools).length).toBeGreaterThan(0);
  });

  it("does not find an inferred repo-root bundle via source when only manifest-free subdirectory bundles exist", () => {
    // Given
    const libraryDir = createLibraryDir();
    const repoDir = path.join(libraryDir, "github.com", "user", "ghosts");
    fs.mkdirSync(path.join(repoDir, "core", "skills", "wdd"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "core", "skills", "wdd", "SKILL.md"), "# wdd\n");
    fs.mkdirSync(path.join(repoDir, "skills", "shared"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "skills", "shared", "SKILL.md"), "# shared\n");

    // When
    const findBundle = () =>
      findCachedBundle({
        libraryDir,
        source: "github.com/user/ghosts",
        bundle: "ghosts",
      });

    // Then
    expect(findBundle).toThrowError(/bundle not found/i);
  });

  it("finds an inferred repo-as-bundle by source even when a root manifest exists", () => {
    // Given
    const libraryDir = createLibraryDir();
    const repoDir = path.join(libraryDir, "github.com", "user", "react-bundle");
    fs.mkdirSync(path.join(repoDir, "skills", "react"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "skills", "react", "SKILL.md"), "# react\n");
    writeManifestAtRepoRoot(libraryDir, "github.com/user/react-bundle", {
      tools: { codex: { skills: { path: "ignored" } } },
    });

    // When
    const bundle = findCachedBundle({
      libraryDir,
      source: "github.com/user/react-bundle",
      bundle: "react-bundle",
    });

    // Then
    expect(bundle).toMatchObject({
      source: "github.com/user/react-bundle",
      bundle: "react-bundle",
    });
  });

  it("finds an inferred repo-as-bundle by source when a child manifest.json is unrelated", () => {
    // Given
    const libraryDir = createLibraryDir();
    const repoDir = path.join(libraryDir, "github.com", "user", "site-bundle");
    fs.mkdirSync(path.join(repoDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "docs", "manifest.json"), JSON.stringify({ name: "pwa" }));
    fs.mkdirSync(path.join(repoDir, "skills", "react"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "skills", "react", "SKILL.md"), "# react\n");

    // When
    const bundle = findCachedBundle({
      libraryDir,
      source: "github.com/user/site-bundle",
      bundle: "site-bundle",
    });

    // Then
    expect(bundle).toMatchObject({
      source: "github.com/user/site-bundle",
      bundle: "site-bundle",
    });
  });

  it("finds an inferred repo-as-bundle without an explicit source", () => {
    // Given
    const libraryDir = createLibraryDir();
    const repoDir = path.join(libraryDir, "github.com", "user", "react-bundle");
    fs.mkdirSync(path.join(repoDir, "skills", "react"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "skills", "react", "SKILL.md"), "# react\n");

    // When
    const bundle = findCachedBundle({ libraryDir, bundle: "react-bundle" });

    // Then
    expect(bundle).toMatchObject({
      source: "github.com/user/react-bundle",
      bundle: "react-bundle",
    });
  });

  it("does not find an inferred repo-as-bundle when the requested name differs from the repo slug", () => {
    // Given
    const libraryDir = createLibraryDir();
    const repoDir = path.join(libraryDir, "github.com", "user", "react-bundle");
    fs.mkdirSync(path.join(repoDir, "skills", "react"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "skills", "react", "SKILL.md"), "# react\n");

    // When
    const findBundle = () =>
      findCachedBundle({
        libraryDir,
        source: "github.com/user/react-bundle",
        bundle: "different-name",
      });

    // Then
    expect(findBundle).toThrowError(/bundle not found/i);
  });

  it("does not find an inferred bundle via source when the repo has subdirectory bundles", () => {
    // Given — multi-bundle repo: explicit subdir bundle + canonical dir at root
    const libraryDir = createLibraryDir();

    writeManifest(libraryDir, "github.com/user/ai-vault", "react-expert", {
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    const repoDir = path.join(libraryDir, "github.com", "user", "ai-vault");
    fs.mkdirSync(path.join(repoDir, "skills", "shared"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "skills", "shared", "SKILL.md"), "# shared\n");

    // When — try to find an inferred bundle by repo slug
    const findBundle = () =>
      findCachedBundle({
        libraryDir,
        source: "github.com/user/ai-vault",
        bundle: "ai-vault",
      });

    // Then — must throw, consistent with listCachedBundles which also skips inference here
    expect(findBundle).toThrowError(/bundle not found/i);
  });

  it.each([
    [
      "missing bundle",
      (libraryDir: string) => findCachedBundle({ libraryDir, bundle: "missing" }),
      /bundle not found/i,
    ],
    [
      "ambiguous bundle name across sources",
      (libraryDir: string) => {
        writeManifest(libraryDir, "github.com/user/ai-vault", "react-expert", {
          tools: { "claude-code": { skills: { path: "skills" } } },
        });
        writeManifest(libraryDir, "github.com/acme/shared-bundles", "react-expert", {
          tools: { "claude-code": { skills: { path: "skills" } } },
        });

        return findCachedBundle({ libraryDir, bundle: "react-expert" });
      },
      /bundle name is ambiguous/i,
    ],
    [
      "ambiguous bundle name across inferred repo-as-bundles",
      (libraryDir: string) => {
        const repo1Dir = path.join(libraryDir, "github.com", "user", "react-bundle");
        const repo2Dir = path.join(libraryDir, "github.com", "acme", "react-bundle");
        fs.mkdirSync(path.join(repo1Dir, "skills", "react"), { recursive: true });
        fs.mkdirSync(path.join(repo2Dir, "skills", "react"), { recursive: true });
        fs.writeFileSync(path.join(repo1Dir, "skills", "react", "SKILL.md"), "# react\n");
        fs.writeFileSync(path.join(repo2Dir, "skills", "react", "SKILL.md"), "# react\n");

        return findCachedBundle({ libraryDir, bundle: "react-bundle" });
      },
      /bundle name is ambiguous/i,
    ],
  ])("rejects %s", (_label, action, expectedMessage) => {
    // Given
    const libraryDir = createLibraryDir();
    const findBundle = () => action(libraryDir);

    // When / Then
    expect(findBundle).toThrowError(expectedMessage);
  });
});

function createLibraryDir(): string {
  const libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-library-"));
  tempDirs.push(libraryDir);
  return libraryDir;
}

function writeManifest(
  libraryDir: string,
  source: string,
  bundle: string,
  manifest: object,
): void {
  const bundleDir = path.join(libraryDir, ...source.split("/"), bundle);
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

function writeManifestAtRepoRoot(
  libraryDir: string,
  source: string,
  manifest: object,
): void {
  const sourceDir = path.join(libraryDir, ...source.split("/"));
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}
