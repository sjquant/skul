import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveGlobalStateLayout } from "./state-layout";

describe("resolveGlobalStateLayout", () => {
  it("builds the canonical ~/.skul layout from a home directory", () => {
    const layout = resolveGlobalStateLayout({ homeDir: "/Users/dev" });

    expect(layout).toMatchObject({
      rootDir: path.join("/Users/dev", ".skul"),
      registryFile: path.join("/Users/dev", ".skul", "registry.json"),
      libraryDir: path.join("/Users/dev", ".skul", "library"),
      configFile: path.join("/Users/dev", ".skul", "config.json"),
    });
    expect(layout.resolveLibraryPath).toBeTypeOf("function");
  });

  it("composes library cache paths beneath the library directory", () => {
    const layout = resolveGlobalStateLayout({ homeDir: "/Users/dev" });

    expect(layout.resolveLibraryPath("github.com", "user", "ai-vault")).toBe(
      path.join("/Users/dev", ".skul", "library", "github.com", "user", "ai-vault"),
    );
  });

  it("rejects an empty home directory", () => {
    expect(() => resolveGlobalStateLayout({ homeDir: "" })).toThrowError(
      /home directory is required/,
    );
  });
});
