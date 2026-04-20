import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { clearAllCachedSources, clearCachedSource, fetchRemoteSource, listCachedSources } from "./bundle-fetch";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.resetAllMocks();
});

function createLibraryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-fetch-"));
  tempDirs.push(dir);
  return dir;
}

describe("fetchRemoteSource", () => {
  it("returns cloned: false and skips git when target directory already exists", () => {
    // Given
    const libraryDir = createLibraryDir();
    const targetDir = path.join(libraryDir, "github.com", "user", "react-bundle");
    fs.mkdirSync(targetDir, { recursive: true });

    // When
    const result = fetchRemoteSource({ source: "github.com/user/react-bundle", libraryDir });

    // Then
    expect(result).toEqual({ cloned: false, targetDir });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("shallow-clones the repo and returns cloned: true when directory is missing", () => {
    // Given
    const libraryDir = createLibraryDir();
    const targetDir = path.join(libraryDir, "github.com", "user", "react-bundle");

    vi.mocked(execFileSync).mockImplementation(() => Buffer.from(""));

    // When
    const result = fetchRemoteSource({ source: "github.com/user/react-bundle", libraryDir });

    // Then
    expect(result).toEqual({ cloned: true, targetDir });
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["clone", "--depth=1", "https://github.com/user/react-bundle", targetDir],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("creates the parent directory before cloning so git has a place to write", () => {
    // Given
    const libraryDir = createLibraryDir();
    vi.mocked(execFileSync).mockImplementation(() => Buffer.from(""));

    // When
    fetchRemoteSource({ source: "github.com/user/react-bundle", libraryDir });

    // Then
    expect(fs.existsSync(path.join(libraryDir, "github.com", "user"))).toBe(true);
  });

  it("throws a helpful error when git is not installed", () => {
    // Given
    const libraryDir = createLibraryDir();
    const notFoundError = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    vi.mocked(execFileSync).mockImplementation(() => { throw notFoundError; });

    // When / Then
    expect(() => fetchRemoteSource({ source: "github.com/user/react-bundle", libraryDir }))
      .toThrowError(/git is not installed or not on PATH/);
  });

  it("surfaces stderr from a failed clone", () => {
    // Given
    const libraryDir = createLibraryDir();
    const cloneError = Object.assign(new Error("Command failed"), {
      stderr: Buffer.from("ERROR: Repository not found."),
    });
    vi.mocked(execFileSync).mockImplementation(() => { throw cloneError; });

    // When / Then
    expect(() => fetchRemoteSource({ source: "github.com/user/react-bundle", libraryDir }))
      .toThrowError(/Failed to clone https:\/\/github\.com\/user\/react-bundle[\s\S]*Repository not found/);
  });

  it("surfaces a plain error message when stderr is absent", () => {
    // Given
    const libraryDir = createLibraryDir();
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error("network timeout"); });

    // When / Then
    expect(() => fetchRemoteSource({ source: "github.com/user/react-bundle", libraryDir }))
      .toThrowError(/Failed to clone https:\/\/github\.com\/user\/react-bundle/);
  });

  it("removes the partial target directory when the clone fails", () => {
    // Given
    const libraryDir = createLibraryDir();
    const targetDir = path.join(libraryDir, "github.com", "user", "react-bundle");
    vi.mocked(execFileSync).mockImplementation(() => {
      // Simulate git creating an empty dir before failing
      fs.mkdirSync(targetDir, { recursive: true });
      throw new Error("clone failed");
    });

    // When
    expect(() => fetchRemoteSource({ source: "github.com/user/react-bundle", libraryDir }))
      .toThrowError(/Failed to clone/);

    // Then — no partial directory left behind
    expect(fs.existsSync(targetDir)).toBe(false);
  });

  it("shallow-clones via SSH when protocol is ssh", () => {
    // Given
    const libraryDir = createLibraryDir();
    const targetDir = path.join(libraryDir, "github.com", "user", "react-bundle");

    vi.mocked(execFileSync).mockImplementation(() => Buffer.from(""));

    // When
    const result = fetchRemoteSource({ source: "github.com/user/react-bundle", libraryDir, protocol: "ssh" });

    // Then
    expect(result).toEqual({ cloned: true, targetDir });
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["clone", "--depth=1", "git@github.com:user/react-bundle.git", targetDir],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("shallow-clones via HTTPS when protocol is https (explicit)", () => {
    // Given
    const libraryDir = createLibraryDir();
    const targetDir = path.join(libraryDir, "github.com", "user", "react-bundle");

    vi.mocked(execFileSync).mockImplementation(() => Buffer.from(""));

    // When
    fetchRemoteSource({ source: "github.com/user/react-bundle", libraryDir, protocol: "https" });

    // Then
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["clone", "--depth=1", "https://github.com/user/react-bundle", targetDir],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("includes the SSH clone URL in the error message when SSH clone fails", () => {
    // Given
    const libraryDir = createLibraryDir();
    const cloneError = Object.assign(new Error("Command failed"), {
      stderr: Buffer.from("Permission denied (publickey)."),
    });
    vi.mocked(execFileSync).mockImplementation(() => { throw cloneError; });

    // When / Then
    expect(() => fetchRemoteSource({ source: "github.com/user/react-bundle", libraryDir, protocol: "ssh" }))
      .toThrowError(/Failed to clone git@github\.com:user\/react-bundle\.git[\s\S]*Permission denied/);
  });

  it("appends an HTTPS hint when SSH authentication fails with publickey error", () => {
    // Given
    const libraryDir = createLibraryDir();
    const cloneError = Object.assign(new Error("Command failed"), {
      stderr: Buffer.from("git@github.com: Permission denied (publickey)."),
    });
    vi.mocked(execFileSync).mockImplementation(() => { throw cloneError; });

    // When / Then
    expect(() => fetchRemoteSource({ source: "github.com/user/react-bundle", libraryDir, protocol: "ssh" }))
      .toThrowError(/Hint: SSH authentication failed[\s\S]*skul add github\.com\/user\/react-bundle/);
  });

  it("appends an HTTPS hint when SSH authentication fails with 'could not read from remote' error", () => {
    // Given
    const libraryDir = createLibraryDir();
    const cloneError = Object.assign(new Error("Command failed"), {
      stderr: Buffer.from("fatal: Could not read from remote repository."),
    });
    vi.mocked(execFileSync).mockImplementation(() => { throw cloneError; });

    // When / Then
    expect(() => fetchRemoteSource({ source: "github.com/user/react-bundle", libraryDir, protocol: "ssh" }))
      .toThrowError(/Hint: SSH authentication failed/);
  });

  it("does not append an HTTPS hint for non-auth SSH failures", () => {
    // Given
    const libraryDir = createLibraryDir();
    const cloneError = Object.assign(new Error("Command failed"), {
      stderr: Buffer.from("ERROR: Repository 'git@github.com:user/react-bundle.git' not found."),
    });
    vi.mocked(execFileSync).mockImplementation(() => { throw cloneError; });

    // When
    let caught: Error | undefined;
    try {
      fetchRemoteSource({ source: "github.com/user/react-bundle", libraryDir, protocol: "ssh" });
    } catch (e) {
      caught = e as Error;
    }

    // Then — error is thrown but contains no HTTPS hint
    expect(caught?.message).toMatch(/Failed to clone git@github\.com/);
    expect(caught?.message).not.toMatch(/Hint/);
  });

  it("does not append an HTTPS hint for HTTPS clone failures", () => {
    // Given
    const libraryDir = createLibraryDir();
    const cloneError = Object.assign(new Error("Command failed"), {
      stderr: Buffer.from("Permission denied."),
    });
    vi.mocked(execFileSync).mockImplementation(() => { throw cloneError; });

    // When
    let caught: Error | undefined;
    try {
      fetchRemoteSource({ source: "github.com/user/react-bundle", libraryDir, protocol: "https" });
    } catch (e) {
      caught = e as Error;
    }

    // Then — HTTPS failures never show SSH-specific hint
    expect(caught?.message).toMatch(/Failed to clone https:\/\//);
    expect(caught?.message).not.toMatch(/Hint/);
  });

  it("rejects sources that do not match host/owner/repo format", () => {
    // Given
    const libraryDir = createLibraryDir();

    // When / Then
    expect(() => fetchRemoteSource({ source: "../../../etc/passwd", libraryDir }))
      .toThrowError(/Invalid bundle source/);
    expect(() => fetchRemoteSource({ source: "github.com/user", libraryDir }))
      .toThrowError(/Invalid bundle source/);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe("clearCachedSource", () => {
  it("removes an existing cached source directory", () => {
    // Given
    const libraryDir = createLibraryDir();
    const targetDir = path.join(libraryDir, "github.com", "user", "react-bundle");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "README.md"), "# cached\n");

    // When
    const result = clearCachedSource({ source: "github.com/user/react-bundle", libraryDir });

    // Then
    expect(result).toEqual({ cleared: true, targetDir });
    expect(fs.existsSync(targetDir)).toBe(false);
  });

  it("returns cleared: false when the cached source does not exist", () => {
    // Given
    const libraryDir = createLibraryDir();
    const targetDir = path.join(libraryDir, "github.com", "user", "react-bundle");

    // When
    const result = clearCachedSource({ source: "github.com/user/react-bundle", libraryDir });

    // Then
    expect(result).toEqual({ cleared: false, targetDir });
  });

  it("removes empty parent directories after clearing the cached source", () => {
    // Given
    const libraryDir = createLibraryDir();
    const ownerDir = path.join(libraryDir, "github.com", "user");
    const targetDir = path.join(ownerDir, "react-bundle");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "README.md"), "# cached\n");

    // When
    clearCachedSource({ source: "github.com/user/react-bundle", libraryDir });

    // Then
    expect(fs.existsSync(ownerDir)).toBe(false);
  });
});

describe("listCachedSources", () => {
  it("lists cached sources directly from the library layout", () => {
    // Given
    const libraryDir = createLibraryDir();
    fs.mkdirSync(path.join(libraryDir, "github.com", "user", "react-bundle"), { recursive: true });
    fs.mkdirSync(path.join(libraryDir, "github.com", "acme", "shared-bundles"), { recursive: true });

    // When
    const sources = listCachedSources(libraryDir);

    // Then
    expect(sources).toEqual([
      "github.com/acme/shared-bundles",
      "github.com/user/react-bundle",
    ]);
  });
});

describe("clearAllCachedSources", () => {
  it("removes every cached source directory from the global library", () => {
    // Given
    const libraryDir = createLibraryDir();
    fs.mkdirSync(path.join(libraryDir, "github.com", "user", "react-bundle"), { recursive: true });
    fs.mkdirSync(path.join(libraryDir, "github.com", "acme", "shared-bundles"), { recursive: true });

    // When
    const result = clearAllCachedSources({ libraryDir });

    // Then
    expect(result).toEqual({
      clearedSources: [
        "github.com/acme/shared-bundles",
        "github.com/user/react-bundle",
      ],
    });
    expect(listCachedSources(libraryDir)).toEqual([]);
  });
});
