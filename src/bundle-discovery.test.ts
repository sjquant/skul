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
