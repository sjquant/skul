import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { updateCachedRemoteSource } from "./bundle-fetch";

const tempDirs: string[] = [];
let previousGitSsh: string | undefined;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (previousGitSsh === undefined) {
    delete process.env["GIT_SSH"];
  } else {
    process.env["GIT_SSH"] = previousGitSsh;
  }

  previousGitSsh = undefined;
});

describe("updateCachedRemoteSource integration", () => {
  it("normalizes SSH authentication failures raised while resolving the requested remote ref", () => {
    // Given
    const libraryDir = createLibraryDir();
    const source = "github.com/user/react-bundle";
    const targetDir = seedCachedRemoteSource(libraryDir, source);
    runGit(targetDir, [
      "remote",
      "set-url",
      "origin",
      "git@github.com:user/react-bundle.git",
    ]);
    previousGitSsh = process.env["GIT_SSH"];
    process.env["GIT_SSH"] = createFakeSshCommand(libraryDir);

    // When / Then
    expect(() =>
      updateCachedRemoteSource({
        source,
        libraryDir,
        protocol: "ssh",
        ref: "stable",
      }),
    ).toThrowError(
      /Failed to update github\.com\/user\/react-bundle[\s\S]*Hint: SSH authentication failed/,
    );
  });
});

function createLibraryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-fetch-integration-"));
  tempDirs.push(dir);
  return dir;
}

function seedCachedRemoteSource(libraryDir: string, source: string): string {
  const remoteRepoPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "skul-fetch-remote-"),
  );
  tempDirs.push(remoteRepoPath);
  runGit(remoteRepoPath, ["init", "--initial-branch=main"]);
  runGit(remoteRepoPath, ["config", "user.name", "Skul Remote"]);
  runGit(remoteRepoPath, ["config", "user.email", "skul-remote@example.com"]);
  runGit(remoteRepoPath, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(remoteRepoPath, "README.md"), "# remote\n");
  runGit(remoteRepoPath, ["add", "README.md"]);
  runGit(remoteRepoPath, ["commit", "-m", "init"]);
  runGit(remoteRepoPath, ["branch", "stable"]);

  const targetDir = path.join(libraryDir, ...source.split("/"));
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  runGit(path.dirname(targetDir), ["clone", remoteRepoPath, targetDir]);

  return targetDir;
}

function createFakeSshCommand(libraryDir: string): string {
  const fakeSshPath = path.join(libraryDir, "fake-ssh.sh");
  fs.writeFileSync(
    fakeSshPath,
    "#!/bin/sh\necho 'git@github.com: Permission denied (publickey).' 1>&2\nexit 255\n",
  );
  fs.chmodSync(fakeSshPath, 0o755);

  return fakeSshPath;
}

function runGit(cwd: string, args: string[]): string {
  return String(
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ).trim();
}
