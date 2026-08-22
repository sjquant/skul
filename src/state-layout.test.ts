import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveBundleDataDir, resolveGlobalStateLayout } from "./state-layout";

describe("resolveGlobalStateLayout", () => {
  it("builds the canonical ~/.skul layout from a home directory", () => {
    const layout = resolveGlobalStateLayout({ homeDir: "/Users/dev" });

    expect(layout).toMatchObject({
      rootDir: path.join("/Users/dev", ".skul"),
      registryFile: path.join("/Users/dev", ".skul", "registry.json"),
      libraryDir: path.join("/Users/dev", ".skul", "library"),
    });
    expect(layout.resolveLibraryPath).toBeTypeOf("function");
  });

  it("composes library cache paths beneath the library directory", () => {
    const layout = resolveGlobalStateLayout({ homeDir: "/Users/dev" });

    expect(layout.resolveLibraryPath("github.com", "user", "ai-vault")).toBe(
      path.join(
        "/Users/dev",
        ".skul",
        "library",
        "github.com",
        "user",
        "ai-vault",
      ),
    );
  });

  it("rejects an empty home directory", () => {
    expect(() => resolveGlobalStateLayout({ homeDir: "" })).toThrowError(
      /home directory is required/,
    );
  });
});

describe("resolveBundleDataDir", () => {
  const libraryDir = path.join("/Users/dev", ".skul", "library");

  it("mirrors a bundle's library path under the data root", () => {
    // Given a bundle cached in the library
    const bundleDir = path.join(libraryDir, "github.com", "acme", "react");

    // When its data directory is resolved
    const dataDir = resolveBundleDataDir({ libraryDir, bundleDir });

    // Then it sits at the same relative path under data
    expect(dataDir).toBe(
      path.join("/Users/dev", ".skul", "data", "github.com", "acme", "react"),
    );
  });

  it.each([
    ["outside the library", path.join("/Users/dev", "elsewhere", "react")],
    ["the library itself", libraryDir],
  ])("rejects a bundle directory %s", (_label, bundleDir) => {
    // Given a bundle directory the data root cannot mirror
    // When its data directory is resolved / Then it fails instead of escaping
    expect(() => resolveBundleDataDir({ libraryDir, bundleDir })).toThrowError(
      /outside the library/,
    );
  });
});
