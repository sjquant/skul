import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseBundleManifest, resolveCachedBundleLayout } from "./bundle-manifest";

describe("parseBundleManifest", () => {
  it("accepts a claude bundle manifest with relative content directories", () => {
    // Given
    const manifest = {
      name: "react-expert",
      tool: "claude-code",
      targets: {
        skills: { path: "skills" },
        commands: { path: "commands" },
      },
    };

    // When
    const parsed = parseBundleManifest(manifest);

    // Then
    expect(parsed).toEqual({
      name: "react-expert",
      tool: "claude-code",
      targets: {
        skills: { path: "skills" },
        commands: { path: "commands" },
      },
    });
  });

  it("accepts a codex bundle manifest with skills only", () => {
    // Given
    const manifest = {
      name: "repo-standards",
      tool: "codex",
      targets: {
        skills: { path: "skills" },
      },
    };

    // When
    const parsed = parseBundleManifest(manifest);

    // Then
    expect(parsed).toEqual({
      name: "repo-standards",
      tool: "codex",
      targets: {
        skills: { path: "skills" },
      },
    });
  });

  it.each([
    [
      "unsupported tool",
      {
        name: "react-expert",
        tool: "copilot",
        targets: {
          skills: { path: "skills" },
        },
      },
      /tool must be one of/i,
    ],
    [
      "unsupported target for the selected tool",
      {
        name: "repo-standards",
        tool: "codex",
        targets: {
          commands: { path: "commands" },
        },
      },
      /targets\.commands is not supported for tool codex/i,
    ],
    [
      "absolute target content path",
      {
        name: "react-expert",
        tool: "claude-code",
        targets: {
          skills: { path: "/tmp/skills" },
        },
      },
      /targets\.skills\.path must be a relative path/i,
    ],
    [
      "target content path with parent traversal",
      {
        name: "react-expert",
        tool: "claude-code",
        targets: {
          skills: { path: "../skills" },
        },
      },
      /targets\.skills\.path must be a relative path/i,
    ],
  ])("rejects %s", (_label, input, expectedMessage) => {
    // Given
    const parse = () => parseBundleManifest(input);

    // When / Then
    expect(parse).toThrowError(expectedMessage);
  });
});

describe("resolveCachedBundleLayout", () => {
  it("derives a deterministic cache layout beneath the library directory", () => {
    // Given
    const options = {
      libraryDir: "/Users/dev/.skul/library",
      source: "github.com/user/ai-vault",
      bundle: "react-expert",
    };

    // When
    const layout = resolveCachedBundleLayout(options);

    // Then
    expect(layout).toMatchObject({
      sourceSegments: ["github.com", "user", "ai-vault"],
      sourceDir: path.join("/Users/dev/.skul/library", "github.com", "user", "ai-vault"),
      bundleDir: path.join("/Users/dev/.skul/library", "github.com", "user", "ai-vault", "react-expert"),
      manifestFile: path.join(
        "/Users/dev/.skul/library",
        "github.com",
        "user",
        "ai-vault",
        "react-expert",
        "manifest.json",
      ),
    });
    expect(layout.resolveBundlePath("skills", "react", "SKILL.md")).toBe(
      path.join(
        "/Users/dev/.skul/library",
        "github.com",
        "user",
        "ai-vault",
        "react-expert",
        "skills",
        "react",
        "SKILL.md",
      ),
    );
  });

  it.each([
    [
      "empty library dir",
      { libraryDir: "", source: "github.com/user/ai-vault", bundle: "react-expert" },
      /library directory is required/i,
    ],
    [
      "empty source",
      { libraryDir: "/Users/dev/.skul/library", source: "", bundle: "react-expert" },
      /source is required/i,
    ],
    [
      "bundle with path separators",
      {
        libraryDir: "/Users/dev/.skul/library",
        source: "github.com/user/ai-vault",
        bundle: "react/expert",
      },
      /bundle must be a single path segment/i,
    ],
  ])("rejects %s", (_label, input, expectedMessage) => {
    // Given
    const resolve = () => resolveCachedBundleLayout(input);

    // When / Then
    expect(resolve).toThrowError(expectedMessage);
  });
});
