import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseBundleManifest, resolveCachedBundleLayout } from "./bundle-manifest";

describe("parseBundleManifest", () => {
  it("accepts a claude bundle manifest with relative content directories", () => {
    expect(
      parseBundleManifest({
        name: "react-expert",
        tool: "claude-code",
        targets: {
          skills: { path: "skills" },
          commands: { path: "commands" },
        },
      }),
    ).toEqual({
      name: "react-expert",
      tool: "claude-code",
      targets: {
        skills: { path: "skills" },
        commands: { path: "commands" },
      },
    });
  });

  it("accepts a codex bundle manifest with skills only", () => {
    expect(
      parseBundleManifest({
        name: "repo-standards",
        tool: "codex",
        targets: {
          skills: { path: "skills" },
        },
      }),
    ).toEqual({
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
    expect(() => parseBundleManifest(input)).toThrowError(expectedMessage);
  });
});

describe("resolveCachedBundleLayout", () => {
  it("derives a deterministic cache layout beneath the library directory", () => {
    const layout = resolveCachedBundleLayout({
      libraryDir: "/Users/dev/.skul/library",
      source: "github.com/user/ai-vault",
      bundle: "react-expert",
    });

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
    expect(layout.resolveBundlePath("skills", "react.md")).toBe(
      path.join(
        "/Users/dev/.skul/library",
        "github.com",
        "user",
        "ai-vault",
        "react-expert",
        "skills",
        "react.md",
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
    expect(() => resolveCachedBundleLayout(input)).toThrowError(expectedMessage);
  });
});
