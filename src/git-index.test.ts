import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearGitSkipWorktree,
  inspectGitIndexStages,
  inspectRootInstructionShadowTarget,
  isTrackedGitPath,
  readGitHeadBlob,
  readGitIndexFlags,
  setGitSkipWorktree,
} from "./git-index";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("git index primitives", () => {
  it("detects a tracked root instruction file and reads its HEAD blob", () => {
    // Given
    const repoRoot = createRepository();
    writeFile(repoRoot, "AGENTS.md", "# team policy\n");
    commitTrackedFile(repoRoot, "AGENTS.md");

    // When
    const tracked = isTrackedGitPath({ repoRoot, filePath: "AGENTS.md" });
    const headBlob = readGitHeadBlob({ repoRoot, filePath: "AGENTS.md" });
    const stageEntries = inspectGitIndexStages({
      repoRoot,
      filePath: "AGENTS.md",
    });
    const flags = readGitIndexFlags({ repoRoot, filePath: "AGENTS.md" });

    // Then
    expect(tracked).toBe(true);
    expect(headBlob).toMatchObject({
      content: "# team policy\n",
    });
    expect(headBlob?.objectId).toMatch(/^[0-9a-f]+$/);
    expect(stageEntries).toEqual([
      {
        mode: "100644",
        objectId: headBlob!.objectId,
        stage: 0,
        path: "AGENTS.md",
      },
    ]);
    expect(flags).toEqual(["H"]);
  });

  it("reports no tracked state for an untracked root instruction file", () => {
    // Given
    const repoRoot = createRepository();
    writeFile(repoRoot, "AGENTS.md", "# local only\n");

    // When
    const tracked = isTrackedGitPath({ repoRoot, filePath: "AGENTS.md" });
    const headBlob = readGitHeadBlob({ repoRoot, filePath: "AGENTS.md" });
    const stageEntries = inspectGitIndexStages({
      repoRoot,
      filePath: "AGENTS.md",
    });
    const flags = readGitIndexFlags({ repoRoot, filePath: "AGENTS.md" });

    // Then
    expect(tracked).toBe(false);
    expect(headBlob).toBeNull();
    expect(stageEntries).toEqual([]);
    expect(flags).toEqual([]);
  });

  it("reports no tracked state for a missing root instruction file", () => {
    // Given
    const repoRoot = createRepository();

    // When
    const tracked = isTrackedGitPath({ repoRoot, filePath: "AGENTS.md" });
    const headBlob = readGitHeadBlob({ repoRoot, filePath: "AGENTS.md" });
    const stageEntries = inspectGitIndexStages({
      repoRoot,
      filePath: "AGENTS.md",
    });
    const flags = readGitIndexFlags({ repoRoot, filePath: "AGENTS.md" });

    // Then
    expect(tracked).toBe(false);
    expect(headBlob).toBeNull();
    expect(stageEntries).toEqual([]);
    expect(flags).toEqual([]);
  });

  it("keeps a staged-for-deletion root instruction file classified as tracked", () => {
    // Given
    const repoRoot = createRepository();
    writeFile(repoRoot, "AGENTS.md", "# team policy\n");
    commitTrackedFile(repoRoot, "AGENTS.md");
    runGit(repoRoot, ["rm", "--cached", "--", "AGENTS.md"]);

    // When
    const tracked = isTrackedGitPath({ repoRoot, filePath: "AGENTS.md" });
    const headBlob = readGitHeadBlob({ repoRoot, filePath: "AGENTS.md" });
    const stageEntries = inspectGitIndexStages({
      repoRoot,
      filePath: "AGENTS.md",
    });
    const flags = readGitIndexFlags({ repoRoot, filePath: "AGENTS.md" });

    // Then
    expect(tracked).toBe(true);
    expect(headBlob).toMatchObject({
      content: "# team policy\n",
    });
    expect(stageEntries).toEqual([]);
    expect(flags).toEqual([]);
  });

  it("surfaces all merge stages for an unmerged root instruction file", () => {
    // Given
    const repoRoot = createRepository();
    writeFile(repoRoot, "AGENTS.md", "# base\n");
    commitTrackedFile(repoRoot, "AGENTS.md");

    runGit(repoRoot, ["checkout", "-b", "feature"]);
    writeFile(repoRoot, "AGENTS.md", "# feature\n");
    runGit(repoRoot, ["commit", "-am", "feature change"]);

    runGit(repoRoot, ["checkout", "main"]);
    writeFile(repoRoot, "AGENTS.md", "# main\n");
    runGit(repoRoot, ["commit", "-am", "main change"]);
    runGit(repoRoot, ["merge", "feature"], { allowFailure: true });

    // When
    const tracked = isTrackedGitPath({ repoRoot, filePath: "AGENTS.md" });
    const stageEntries = inspectGitIndexStages({
      repoRoot,
      filePath: "AGENTS.md",
    });
    const flags = readGitIndexFlags({ repoRoot, filePath: "AGENTS.md" });
    const headBlob = readGitHeadBlob({ repoRoot, filePath: "AGENTS.md" });

    // Then
    expect(tracked).toBe(true);
    expect(stageEntries).toHaveLength(3);
    expect(stageEntries.map((entry) => entry.stage)).toEqual([1, 2, 3]);
    expect(stageEntries.every((entry) => entry.path === "AGENTS.md")).toBe(
      true,
    );
    expect(flags).toEqual(["M", "M", "M"]);
    expect(headBlob).toMatchObject({
      content: "# main\n",
    });
  });

  it("reports dirty shadow safety issues for staged and unstaged tracked targets", () => {
    // Given
    const repoRoot = createRepository();
    writeFile(repoRoot, "AGENTS.md", "# team policy\n");
    commitTrackedFile(repoRoot, "AGENTS.md");

    writeFile(repoRoot, "AGENTS.md", "# first local change\n");
    runGit(repoRoot, ["add", "--", "AGENTS.md"]);
    writeFile(repoRoot, "AGENTS.md", "# second local change\n");

    // When
    const inspection = inspectRootInstructionShadowTarget({
      repoRoot,
      filePath: "AGENTS.md",
    });

    // Then
    expect(inspection.tracked).toBe(true);
    expect(inspection.issues).toEqual(["staged-changes", "unstaged-changes"]);
  });

  it("reports missing HEAD content for index-only tracked targets", () => {
    // Given
    const repoRoot = createRepository();
    writeFile(repoRoot, "AGENTS.md", "# staged only\n");
    runGit(repoRoot, ["add", "--", "AGENTS.md"]);

    // When
    const inspection = inspectRootInstructionShadowTarget({
      repoRoot,
      filePath: "AGENTS.md",
    });

    // Then
    expect(inspection.tracked).toBe(true);
    expect(inspection.issues).toEqual(["missing-head", "staged-changes"]);
  });

  it("reports incompatible index flags for assume-unchanged tracked targets", () => {
    // Given
    const repoRoot = createRepository();
    writeFile(repoRoot, "AGENTS.md", "# team policy\n");
    commitTrackedFile(repoRoot, "AGENTS.md");
    runGit(repoRoot, ["update-index", "--assume-unchanged", "--", "AGENTS.md"]);

    // When
    const inspection = inspectRootInstructionShadowTarget({
      repoRoot,
      filePath: "AGENTS.md",
    });

    // Then
    expect(inspection.tracked).toBe(true);
    expect(inspection.indexFlags).toEqual(["h"]);
    expect(inspection.issues).toEqual(["incompatible-index-flags"]);
  });

  it("sets the skip-worktree flag for a tracked root instruction file", () => {
    // Given
    const repoRoot = createRepository();
    writeFile(repoRoot, "AGENTS.md", "# team policy\n");
    commitTrackedFile(repoRoot, "AGENTS.md");

    // When
    setGitSkipWorktree({ repoRoot, filePath: "AGENTS.md" });

    // Then
    expect(readGitIndexFlags({ repoRoot, filePath: "AGENTS.md" })).toEqual([
      "S",
    ]);
  });

  it("clears the skip-worktree flag for a tracked root instruction file", () => {
    // Given
    const repoRoot = createRepository();
    writeFile(repoRoot, "AGENTS.md", "# team policy\n");
    commitTrackedFile(repoRoot, "AGENTS.md");
    setGitSkipWorktree({ repoRoot, filePath: "AGENTS.md" });

    // When
    clearGitSkipWorktree({ repoRoot, filePath: "AGENTS.md" });

    // Then
    expect(readGitIndexFlags({ repoRoot, filePath: "AGENTS.md" })).toEqual([
      "H",
    ]);
  });
});

function createRepository(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skul-git-index-"));
  tempDirs.push(repoRoot);

  runGit(repoRoot, ["init", "--initial-branch=main"]);
  runGit(repoRoot, ["config", "user.name", "Skul Test"]);
  runGit(repoRoot, ["config", "user.email", "skul@example.com"]);
  runGit(repoRoot, ["config", "commit.gpgsign", "false"]);

  writeFile(repoRoot, "README.md", "# test\n");
  runGit(repoRoot, ["add", "README.md"]);
  runGit(repoRoot, ["commit", "-m", "init"]);

  return repoRoot;
}

function commitTrackedFile(repoRoot: string, filePath: string): void {
  runGit(repoRoot, ["add", "--", filePath]);
  runGit(repoRoot, ["commit", "-m", `track ${filePath}`]);
}

function writeFile(repoRoot: string, filePath: string, content: string): void {
  fs.writeFileSync(path.join(repoRoot, filePath), content);
}

function runGit(
  repoRoot: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): string {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (options.allowFailure) {
      return "";
    }

    throw error;
  }
}
