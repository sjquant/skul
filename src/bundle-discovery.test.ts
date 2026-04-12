import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
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

describe("normalizeBundleSource", () => {
  it.each([
    ["github.com/user/ai-vault", "github.com/user/ai-vault"],
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
      name: "react-expert",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeManifest(libraryDir, "github.com/user/ai-vault", "repo-standards", {
      name: "repo-standards",
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
          name: "react-expert",
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
          name: "repo-standards",
          tools: { codex: { skills: { path: "skills" } } },
        },
      },
    ]);
  });

  it("discovers a repo-as-bundle manifest at the repository root", () => {
    // Given
    const libraryDir = createLibraryDir();

    writeManifestAtRepoRoot(libraryDir, "github.com/user/single-bundle-repo", {
      name: "my-bundle",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });

    // When
    const bundles = listCachedBundles({ libraryDir });

    // Then
    expect(bundles).toEqual([
      {
        bundle: "my-bundle",
        source: "github.com/user/single-bundle-repo",
        manifestFile: path.join(libraryDir, "github.com", "user", "single-bundle-repo", "manifest.json"),
        manifest: {
          name: "my-bundle",
          tools: { "claude-code": { skills: { path: "skills" } } },
        },
      },
    ]);
  });

  it("discovers both repo-as-bundle and subdirectory bundles from the same source", () => {
    // Given
    const libraryDir = createLibraryDir();

    writeManifestAtRepoRoot(libraryDir, "github.com/user/ai-vault", {
      name: "root-bundle",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeManifest(libraryDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });

    // When
    const bundles = listCachedBundles({ libraryDir });

    // Then
    expect(bundles).toHaveLength(2);
    expect(bundles.map((b) => b.bundle)).toEqual(["react-expert", "root-bundle"]);
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

  it("ignores a broken manifest at the repository root and does not infer a bundle for that repo", () => {
    // Given — broken root manifest + canonical skills/ dir that would trigger inference if the
    // manifest file were absent.  The broken file must still suppress inference.
    const libraryDir = createLibraryDir();
    const repoDir = path.join(libraryDir, "github.com", "user", "broken-repo");
    fs.mkdirSync(path.join(repoDir, "skills", "react"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "skills", "react", "SKILL.md"), "# react\n");
    fs.writeFileSync(path.join(repoDir, "manifest.json"), "{not json");

    // When
    const bundles = listCachedBundles({ libraryDir });

    // Then
    expect(bundles).toEqual([]);
  });

  it("does not infer a bundle for a repo that has a broken subdirectory manifest", () => {
    // Given — broken subdir manifest + canonical skills/ dir at the repo root.
    // The broken file marks the repo as having an explicit manifest, so inference is suppressed.
    const libraryDir = createLibraryDir();
    const repoDir = path.join(libraryDir, "github.com", "user", "mixed-repo");
    fs.mkdirSync(path.join(repoDir, "broken-bundle"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "broken-bundle", "manifest.json"), "{not json");
    fs.mkdirSync(path.join(repoDir, "skills", "react"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "skills", "react", "SKILL.md"), "# react\n");

    // When
    const bundles = listCachedBundles({ libraryDir });

    // Then — no inferred bundle, no explicit bundle (broken manifest is skipped)
    expect(bundles).toEqual([]);
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

  it("does not produce a duplicate inferred bundle for a repo that already has an explicit root manifest", () => {
    // Given
    const libraryDir = createLibraryDir();

    writeManifestAtRepoRoot(libraryDir, "github.com/user/react-bundle", {
      name: "my-bundle",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    // Also add a real skills/ dir that would trigger inference if the manifest were absent
    const repoDir = path.join(libraryDir, "github.com", "user", "react-bundle");
    fs.mkdirSync(path.join(repoDir, "skills", "react"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "skills", "react", "SKILL.md"), "# react\n");

    // When
    const bundles = listCachedBundles({ libraryDir });

    // Then — only the explicit manifest bundle, no duplicate
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.bundle).toBe("my-bundle");
  });

  it("does not produce an inferred bundle for a multi-bundle repo that already has subdirectory bundles", () => {
    // Given — a typical "bundle library" repo with named subdirs and a canonical dir at the root
    const libraryDir = createLibraryDir();

    writeManifest(libraryDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
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
      name: "react-expert",
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

  it("finds a repo-as-bundle by explicit source and manifest name", () => {
    // Given
    const libraryDir = createLibraryDir();

    writeManifestAtRepoRoot(libraryDir, "github.com/user/single-bundle-repo", {
      name: "my-bundle",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });

    // When
    const bundle = findCachedBundle({
      libraryDir,
      source: "github.com/user/single-bundle-repo",
      bundle: "my-bundle",
    });

    // Then
    expect(bundle).toMatchObject({
      source: "github.com/user/single-bundle-repo",
      bundle: "my-bundle",
      manifestFile: path.join(libraryDir, "github.com", "user", "single-bundle-repo", "manifest.json"),
    });
  });

  it("rejects a repo-as-bundle when the root manifest name does not match the requested bundle", () => {
    // Given
    const libraryDir = createLibraryDir();

    writeManifestAtRepoRoot(libraryDir, "github.com/user/single-bundle-repo", {
      name: "actual-name",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });

    // When
    const findBundle = () =>
      findCachedBundle({
        libraryDir,
        source: "github.com/user/single-bundle-repo",
        bundle: "requested-name",
      });

    // Then
    expect(findBundle).toThrowError(/bundle not found/i);
  });

  it("prefers a subdirectory bundle over a repo-as-bundle when both exist for the same source and name", () => {
    // Given
    const libraryDir = createLibraryDir();

    writeManifestAtRepoRoot(libraryDir, "github.com/user/ai-vault", {
      name: "react-expert",
      tools: { "claude-code": { commands: { path: "commands" } } },
    });
    writeManifest(libraryDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });

    // When
    const bundle = findCachedBundle({
      libraryDir,
      source: "github.com/user/ai-vault",
      bundle: "react-expert",
    });

    // Then — subdirectory bundle wins
    expect(bundle.manifestFile).toBe(
      path.join(libraryDir, "github.com", "user", "ai-vault", "react-expert", "manifest.json"),
    );
  });

  it("finds a uniquely named bundle without an explicit source", () => {
    // Given
    const libraryDir = createLibraryDir();

    writeManifest(libraryDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
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

  it("finds a uniquely named repo-as-bundle without an explicit source", () => {
    // Given
    const libraryDir = createLibraryDir();

    writeManifestAtRepoRoot(libraryDir, "github.com/user/single-bundle-repo", {
      name: "my-bundle",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });

    // When
    const bundle = findCachedBundle({ libraryDir, bundle: "my-bundle" });

    // Then
    expect(bundle).toMatchObject({
      source: "github.com/user/single-bundle-repo",
      bundle: "my-bundle",
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
      name: "react-expert",
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

  it("does not find an inferred bundle via source when the repo has an explicit root manifest", () => {
    // Given — root manifest exists but its name doesn't match the repo slug
    const libraryDir = createLibraryDir();

    writeManifestAtRepoRoot(libraryDir, "github.com/user/ai-vault", {
      name: "custom-name",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    const repoDir = path.join(libraryDir, "github.com", "user", "ai-vault");
    fs.mkdirSync(path.join(repoDir, "commands"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "commands", "deploy.md"), "Deploy\n");

    // When — request by repo slug (which differs from manifest.name)
    const findBundle = () =>
      findCachedBundle({
        libraryDir,
        source: "github.com/user/ai-vault",
        bundle: "ai-vault",
      });

    // Then — must throw, not infer
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
          name: "react-expert",
          tools: { "claude-code": { skills: { path: "skills" } } },
        });
        writeManifest(libraryDir, "github.com/acme/shared-bundles", "react-expert", {
          name: "react-expert",
          tools: { "claude-code": { skills: { path: "skills" } } },
        });

        return findCachedBundle({ libraryDir, bundle: "react-expert" });
      },
      /bundle name is ambiguous/i,
    ],
    [
      "ambiguous bundle name across repo-as-bundles",
      (libraryDir: string) => {
        writeManifestAtRepoRoot(libraryDir, "github.com/user/repo1", {
          name: "shared-name",
          tools: { "claude-code": { skills: { path: "skills" } } },
        });
        writeManifestAtRepoRoot(libraryDir, "github.com/user/repo2", {
          name: "shared-name",
          tools: { "claude-code": { skills: { path: "skills" } } },
        });

        return findCachedBundle({ libraryDir, bundle: "shared-name" });
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
