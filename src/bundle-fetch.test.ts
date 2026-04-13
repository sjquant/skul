import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchRemoteSource } from "./bundle-fetch";

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
      { stdio: "pipe" },
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
});
