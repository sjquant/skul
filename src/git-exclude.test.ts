import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configureSkulExcludeBlock, hasSkulExcludeBlock, removeSkulExcludeBlock } from "./git-exclude";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("configureSkulExcludeBlock", () => {
  it("writes a Skul-owned exclude block for the provided files", () => {
    // Given
    const gitDir = createGitDir();

    // When
    const configured = configureSkulExcludeBlock({
      gitDir,
      files: [".claude/skills/react/SKILL.md", ".claude/commands/review.md"],
    });

    // Then
    expect(configured).toBe(true);
    expect(readExcludeFile(gitDir)).toBe(
      [
        "# >>> SKUL START",
        ".claude/commands/review.md",
        ".claude/skills/react/SKILL.md",
        "# <<< SKUL END",
        "",
      ].join("\n"),
    );
  });

  it("replaces an existing Skul block while preserving surrounding user entries", () => {
    // Given
    const gitDir = createGitDir();
    writeExcludeFile(
      gitDir,
      [
        "node_modules",
        "",
        "# >>> SKUL START",
        ".claude/skills/old/SKILL.md",
        "# <<< SKUL END",
        "",
        ".env.local",
        "",
      ].join("\n"),
    );

    // When
    const configured = configureSkulExcludeBlock({
      gitDir,
      files: [".claude/skills/new/SKILL.md"],
    });

    // Then
    expect(configured).toBe(true);
    expect(readExcludeFile(gitDir)).toBe(
      [
        "node_modules",
        "",
        ".env.local",
        "",
        "# >>> SKUL START",
        ".claude/skills/new/SKILL.md",
        "# <<< SKUL END",
        "",
      ].join("\n"),
    );
  });
});

describe("removeSkulExcludeBlock", () => {
  it("removes only the Skul-owned exclude block", () => {
    // Given
    const gitDir = createGitDir();
    writeExcludeFile(
      gitDir,
      [
        "node_modules",
        "",
        "# >>> SKUL START",
        ".claude/skills/react/SKILL.md",
        "# <<< SKUL END",
        "",
        ".env.local",
        "",
      ].join("\n"),
    );

    // When
    const removed = removeSkulExcludeBlock({ gitDir });

    // Then
    expect(removed).toBe(true);
    expect(readExcludeFile(gitDir)).toBe(["node_modules", "", ".env.local", ""].join("\n"));
  });
});

describe("hasSkulExcludeBlock", () => {
  it("reports whether the current exclude file contains a Skul block", () => {
    // Given
    const gitDir = createGitDir();
    writeExcludeFile(gitDir, "node_modules\n");

    // When / Then
    expect(hasSkulExcludeBlock({ gitDir })).toBe(false);
    configureSkulExcludeBlock({
      gitDir,
      files: [".claude/skills/react/SKILL.md"],
    });
    expect(hasSkulExcludeBlock({ gitDir })).toBe(true);
    removeSkulExcludeBlock({ gitDir });
    expect(hasSkulExcludeBlock({ gitDir })).toBe(false);
  });
});

function createGitDir(): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-git-"));
  const gitDir = path.join(rootDir, ".git");
  fs.mkdirSync(path.join(gitDir, "info"), { recursive: true });
  tempDirs.push(rootDir);
  return gitDir;
}

function readExcludeFile(gitDir: string): string {
  return fs.readFileSync(path.join(gitDir, "info", "exclude"), "utf8");
}

function writeExcludeFile(gitDir: string, content: string): void {
  fs.writeFileSync(path.join(gitDir, "info", "exclude"), content);
}
