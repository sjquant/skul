import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearGitSkipWorktree,
  inspectGitIndexStages,
  inspectTrackedShadowTarget,
  isTrackedGitPath,
  listCommittedPaths,
  readGitHeadBlob,
  readGitIndexFlags,
  restoreCommittedPaths,
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
    const inspection = inspectTrackedShadowTarget({
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
    const inspection = inspectTrackedShadowTarget({
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
    const inspection = inspectTrackedShadowTarget({
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

  it("reports only the given paths that HEAD records", () => {
    // Given a repository committing two of three candidate paths
    const repoRoot = createRepository();
    writeFile(repoRoot, ".mcp.json", "{}\n");
    commitTrackedFile(repoRoot, ".mcp.json");
    writeFile(repoRoot, ".cursor/mcp.json", "{}\n");
    commitTrackedFile(repoRoot, ".cursor/mcp.json");
    writeFile(repoRoot, "opencode.json", "{}\n");

    // When the three are looked up together
    const committed = listCommittedPaths({
      repoRoot,
      filePaths: [".mcp.json", ".cursor/mcp.json", "opencode.json"],
    });

    // Then the uncommitted one is absent and the nested one is found
    expect(Array.from(committed).sort()).toEqual([
      ".cursor/mcp.json",
      ".mcp.json",
    ]);
  });

  it("restores only the named path when its name contains glob characters", () => {
    // Given a committed file whose name reads as a pattern, and a second file
    // that pattern would match, both edited since
    const repoRoot = createRepository();
    writeFile(repoRoot, "a*.json", "committed star\n");
    writeFile(repoRoot, "abc.json", "committed abc\n");
    runGit(repoRoot, ["add", "--", "a*.json", "abc.json"]);
    runGit(repoRoot, ["commit", "-m", "track both"]);
    writeFile(repoRoot, "a*.json", "edited star\n");
    writeFile(repoRoot, "abc.json", "edited abc\n");

    // When only the pattern-named path is restored
    restoreCommittedPaths({ repoRoot, filePaths: ["a*.json"] });

    // Then the other file keeps the edit the user has not committed
    expect(fs.readFileSync(path.join(repoRoot, "a*.json"), "utf8")).toBe(
      "committed star\n",
    );
    expect(fs.readFileSync(path.join(repoRoot, "abc.json"), "utf8")).toBe(
      "edited abc\n",
    );
  });

  it("reports nothing for a directory outside any repository", () => {
    // Given a plain directory
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-plain-"));
    tempDirs.push(outsideDir);
    writeFile(outsideDir, ".mcp.json", "{}\n");

    // When committed paths are requested
    const committed = listCommittedPaths({
      repoRoot: outsideDir,
      filePaths: [".mcp.json"],
    });

    // Then the absence of a HEAD is reported as nothing committed
    expect(Array.from(committed)).toEqual([]);
  });

  it("checks committed paths back out, preserving mode and leaving the index alone", () => {
    // Given a committed executable file, edited and staged for removal
    const repoRoot = createRepository();
    writeFile(repoRoot, "run.sh", "echo original\n");
    fs.chmodSync(path.join(repoRoot, "run.sh"), 0o755);
    commitTrackedFile(repoRoot, "run.sh");
    writeFile(repoRoot, "run.sh", "echo edited\n");
    fs.chmodSync(path.join(repoRoot, "run.sh"), 0o644);
    runGit(repoRoot, ["rm", "--cached", "--", "run.sh"]);

    // When the path is restored
    const restored = restoreCommittedPaths({
      repoRoot,
      filePaths: ["run.sh"],
    });

    // Then the committed content and mode are back
    expect(restored).toBe(true);
    expect(fs.readFileSync(path.join(repoRoot, "run.sh"), "utf8")).toBe(
      "echo original\n",
    );
    expect(fs.statSync(path.join(repoRoot, "run.sh")).mode & 0o111).not.toBe(0);

    // And the staged removal the user asked for still stands
    expect(runGit(repoRoot, ["diff", "--cached", "--name-only"]).trim()).toBe(
      "run.sh",
    );
  });

  it("recreates a committed path that has been deleted from the worktree", () => {
    // Given a committed file deleted from the worktree
    const repoRoot = createRepository();
    writeFile(repoRoot, ".mcp.json", '{ "mcpServers": {} }\n');
    commitTrackedFile(repoRoot, ".mcp.json");
    fs.rmSync(path.join(repoRoot, ".mcp.json"));

    // When the path is restored
    const restored = restoreCommittedPaths({
      repoRoot,
      filePaths: [".mcp.json"],
    });

    // Then the file is back and nothing is pending
    expect(restored).toBe(true);
    expect(runGit(repoRoot, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("reports failure when a path cannot be restored", () => {
    // Given a repository that has never committed the path
    const repoRoot = createRepository();

    // When restoring it is attempted
    const restored = restoreCommittedPaths({
      repoRoot,
      filePaths: ["never-committed.json"],
    });

    // Then the caller is told rather than left assuming success
    expect(restored).toBe(false);
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
  const targetPath = path.join(repoRoot, filePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content);
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
