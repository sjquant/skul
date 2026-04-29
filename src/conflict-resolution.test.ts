import { describe, expect, it } from "vitest";

import {
  normalizeConflictDestination,
  normalizeConflictPrefix,
  suggestPrefixedDestination,
} from "./conflict-resolution";

describe("normalizeConflictDestination", () => {
  it("accepts a simple filename", () => {
    expect(normalizeConflictDestination("SKILL.md")).toBe("SKILL.md");
  });

  it("accepts a nested relative path", () => {
    expect(normalizeConflictDestination("react/SKILL.md")).toBe("react/SKILL.md");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeConflictDestination("  SKILL.md  ")).toBe("SKILL.md");
  });

  it("rejects an empty string", () => {
    expect(normalizeConflictDestination("")).toBeNull();
  });

  it("rejects an absolute path", () => {
    expect(normalizeConflictDestination("/etc/passwd")).toBeNull();
  });

  it("rejects a bare dot", () => {
    expect(normalizeConflictDestination(".")).toBeNull();
  });

  it("rejects a bare double dot", () => {
    expect(normalizeConflictDestination("..")).toBeNull();
  });

  it("rejects a path that escapes the tool target with ../", () => {
    expect(normalizeConflictDestination("../outside/SKILL.md")).toBeNull();
  });

  it("rejects a path with an embedded /../ traversal", () => {
    expect(normalizeConflictDestination("nested/../../../outside")).toBeNull();
  });
});

describe("normalizeConflictPrefix", () => {
  it("accepts a simple prefix word", () => {
    expect(normalizeConflictPrefix("p")).toBe("p");
  });

  it("accepts a multi-character prefix", () => {
    expect(normalizeConflictPrefix("next")).toBe("next");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeConflictPrefix("  my  ")).toBe("my");
  });

  it("rejects an empty string", () => {
    expect(normalizeConflictPrefix("")).toBeNull();
  });

  it("rejects a prefix containing a forward slash", () => {
    expect(normalizeConflictPrefix("a/b")).toBeNull();
  });

  it("rejects a bare dot", () => {
    expect(normalizeConflictPrefix(".")).toBeNull();
  });

  it("rejects a bare double dot", () => {
    expect(normalizeConflictPrefix("..")).toBeNull();
  });
});

describe("suggestPrefixedDestination", () => {
  it("prepends the prefix to a top-level file", () => {
    expect(suggestPrefixedDestination("SKILL.md", "p")).toBe("p-SKILL.md");
  });

  it("prepends the prefix to a nested file, only modifying the first segment", () => {
    expect(suggestPrefixedDestination("react/SKILL.md", "next")).toBe("next-react/SKILL.md");
  });

  it("preserves the extension when prefixing", () => {
    expect(suggestPrefixedDestination("review.md", "p")).toBe("p-review.md");
  });

  it("handles a file with no extension", () => {
    expect(suggestPrefixedDestination("SKILL", "p")).toBe("p-SKILL");
  });

  it("handles an empty first segment by returning the original path", () => {
    expect(suggestPrefixedDestination("", "p")).toBe("");
  });

  it("treats a dotfile as a basename with no extension and prefixes it", () => {
    expect(suggestPrefixedDestination(".md", "p")).toBe("p-.md");
  });
});
