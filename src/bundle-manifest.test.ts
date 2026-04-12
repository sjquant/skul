import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseBundleManifest, resolveCachedBundleLayout } from "./bundle-manifest";

describe("parseBundleManifest", () => {
  it("accepts a single-tool bundle manifest", () => {
    // Given
    const manifest = {
      tools: {
        "claude-code": {
          skills: { path: "skills" },
          commands: { path: "commands" },
        },
      },
    };

    // When
    const parsed = parseBundleManifest(manifest);

    // Then
    expect(parsed).toEqual({
      tools: {
        "claude-code": {
          skills: { path: "skills" },
          commands: { path: "commands" },
        },
      },
    });
  });

  it("accepts a multi-tool bundle manifest", () => {
    // Given
    const manifest = {
      tools: {
        "claude-code": {
          skills: { path: "skills" },
          commands: { path: "commands" },
        },
        cursor: {
          skills: { path: "skills" },
        },
      },
    };

    // When
    const parsed = parseBundleManifest(manifest);

    // Then
    expect(parsed).toEqual({
      tools: {
        "claude-code": {
          skills: { path: "skills" },
          commands: { path: "commands" },
        },
        cursor: {
          skills: { path: "skills" },
        },
      },
    });
  });

  it.each([
    [
      "unsupported tool",
      {
        tools: {
          copilot: { skills: { path: "skills" } },
        },
      },
      /tools\.copilot must be one of/i,
    ],
    [
      "unsupported target for the selected tool",
      {
        tools: {
          codex: { commands: { path: "commands" } },
        },
      },
      /tools\.codex\.commands is not supported for tool codex/i,
    ],
    [
      "absolute target content path",
      {
        tools: {
          "claude-code": { skills: { path: "/tmp/skills" } },
        },
      },
      /tools\.claude-code\.skills\.path must be a relative path/i,
    ],
    [
      "target content path with parent traversal",
      {
        tools: {
          "claude-code": { skills: { path: "../skills" } },
        },
      },
      /tools\.claude-code\.skills\.path must be a relative path/i,
    ],
    [
      "empty tools map",
      {
        tools: {},
      },
      /tools must declare at least one tool/i,
    ],
    [
      "empty targets for a tool",
      {
        tools: { "claude-code": {} },
      },
      /tools\.claude-code must declare at least one target/i,
    ],
    [
      "target content path equal to dot",
      {
        tools: { "claude-code": { skills: { path: "." } } },
      },
      /tools\.claude-code\.skills\.path must be a relative path/i,
    ],
    [
      "target content path with embedded parent traversal",
      {
        tools: { "claude-code": { skills: { path: "foo/../../etc/passwd" } } },
      },
      /tools\.claude-code\.skills\.path must be a relative path/i,
    ],
    [
      "null input",
      null,
      /manifest must be an object/i,
    ],
    [
      "tools is an array",
      { tools: [{ "claude-code": { skills: { path: "skills" } } }] },
      /tools must be an object/i,
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
