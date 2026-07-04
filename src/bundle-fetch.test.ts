import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchRemoteSource } from "./bundle-fetch";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const tempDirs: string[] = [];

beforeEach(() => {
  // Given
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "SKUL_GITHUB_TRANSPORT"]) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

function createLibraryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-fetch-"));
  tempDirs.push(dir);
  return dir;
}

describe("fetchRemoteSource", () => {
  it("returns cloned: false and skips git when target directory already exists", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const targetDir = path.join(
      libraryDir,
      "github.com",
      "user",
      "react-bundle",
    );
    fs.mkdirSync(targetDir, { recursive: true });

    // When
    const result = await fetchRemoteSource({
      source: "github.com/user/react-bundle",
      libraryDir,
    });

    // Then
    expect(result).toEqual({ cloned: false, targetDir });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("shallow-clones the repo and returns cloned: true when directory is missing", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const targetDir = path.join(
      libraryDir,
      "github.com",
      "user",
      "react-bundle",
    );

    vi.mocked(execFileSync).mockImplementation(() => Buffer.from(""));

    // When
    const result = await fetchRemoteSource({
      source: "github.com/user/react-bundle",
      libraryDir,
    });

    // Then
    expect(result).toEqual({ cloned: true, targetDir });
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["clone", "--depth=1", "https://github.com/user/react-bundle", targetDir],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("checks out the requested ref after cloning with the git transport", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const targetDir = path.join(
      libraryDir,
      "github.com",
      "user",
      "react-bundle",
    );
    const commit = "1111111111111111111111111111111111111111";
    vi.mocked(execFileSync).mockImplementation((command, args) => {
      if (command === "git" && Array.isArray(args) && args[0] === "ls-remote") {
        return Buffer.from(`${commit}\trefs/heads/stable\n`);
      }

      return Buffer.from("");
    });

    // When
    await fetchRemoteSource({
      source: "github.com/user/react-bundle",
      libraryDir,
      ref: "stable",
    });

    // Then
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["clone", "--depth=1", "https://github.com/user/react-bundle", targetDir],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["-C", targetDir, "fetch", "--depth=1", "origin", "refs/heads/stable"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["-C", targetDir, "checkout", "-B", "stable", "FETCH_HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("resolves a short commit ref to its advertised full SHA before fetching", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const targetDir = path.join(
      libraryDir,
      "github.com",
      "user",
      "react-bundle",
    );
    const commit = "2714e72282b915c6983723652d0c365af08e9e1f";
    vi.mocked(execFileSync).mockImplementation((command, args) => {
      if (command !== "git" || !Array.isArray(args)) {
        return Buffer.from("");
      }

      if (args[0] === "ls-remote" && args[2] === "refs/heads/2714e72") {
        return Buffer.from("");
      }

      if (args[0] === "ls-remote" && args[2] === "refs/tags/2714e72") {
        return Buffer.from("");
      }

      if (args[0] === "ls-remote" && args.length === 2) {
        return Buffer.from(`${commit}\trefs/heads/main\n`);
      }

      if (args.includes("cat-file")) {
        throw new Error("missing object");
      }

      return Buffer.from("");
    });

    // When
    await fetchRemoteSource({
      source: "github.com/user/react-bundle",
      libraryDir,
      ref: "2714e72",
    });

    // Then
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["-C", targetDir, "fetch", "--depth=1", "origin", commit],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["-C", targetDir, "checkout", "--detach", commit],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("resolves an unadvertised short commit ref from fetched history", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const targetDir = path.join(
      libraryDir,
      "github.com",
      "user",
      "react-bundle",
    );
    const commit = "2714e72282b915c6983723652d0c365af08e9e1f";
    vi.mocked(execFileSync).mockImplementation((command, args) => {
      if (command !== "git" || !Array.isArray(args)) {
        return Buffer.from("");
      }

      if (args[0] === "ls-remote") {
        return Buffer.from("");
      }

      if (args.includes("--is-shallow-repository")) {
        return Buffer.from("true\n");
      }

      if (args.includes("rev-parse") && args.includes("--verify")) {
        return Buffer.from(`${commit}\n`);
      }

      return Buffer.from("");
    });

    // When
    await fetchRemoteSource({
      source: "github.com/user/react-bundle",
      libraryDir,
      ref: "2714e72",
    });

    // Then
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      [
        "-C",
        targetDir,
        "fetch",
        "--unshallow",
        "--tags",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["-C", targetDir, "checkout", "--detach", commit],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("creates the parent directory before cloning so git has a place to write", async () => {
    // Given
    const libraryDir = createLibraryDir();
    vi.mocked(execFileSync).mockImplementation(() => Buffer.from(""));

    // When
    await fetchRemoteSource({
      source: "github.com/user/react-bundle",
      libraryDir,
    });

    // Then
    expect(fs.existsSync(path.join(libraryDir, "github.com", "user"))).toBe(
      true,
    );
  });

  it("throws a helpful error when git is not installed", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const notFoundError = Object.assign(new Error("spawn git ENOENT"), {
      code: "ENOENT",
    });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw notFoundError;
    });

    // When / Then
    await expect(
      fetchRemoteSource({ source: "github.com/user/react-bundle", libraryDir }),
    ).rejects.toThrowError(/git is not installed or not on PATH/);
  });

  it("surfaces stderr from a failed clone", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const cloneError = Object.assign(new Error("Command failed"), {
      stderr: Buffer.from("ERROR: Repository not found."),
    });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw cloneError;
    });

    // When / Then
    await expect(
      fetchRemoteSource({ source: "github.com/user/react-bundle", libraryDir }),
    ).rejects.toThrowError(
      /Failed to clone https:\/\/github\.com\/user\/react-bundle[\s\S]*Repository not found/,
    );
  });

  it("surfaces a plain error message when stderr is absent", async () => {
    // Given
    const libraryDir = createLibraryDir();
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("network timeout");
    });

    // When / Then
    await expect(
      fetchRemoteSource({ source: "github.com/user/react-bundle", libraryDir }),
    ).rejects.toThrowError(
      /Failed to clone https:\/\/github\.com\/user\/react-bundle/,
    );
  });

  it("removes the partial target directory when the clone fails", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const targetDir = path.join(
      libraryDir,
      "github.com",
      "user",
      "react-bundle",
    );
    vi.mocked(execFileSync).mockImplementation(() => {
      // Simulate git creating an empty dir before failing
      fs.mkdirSync(targetDir, { recursive: true });
      throw new Error("clone failed");
    });

    // When
    await expect(
      fetchRemoteSource({ source: "github.com/user/react-bundle", libraryDir }),
    ).rejects.toThrowError(/Failed to clone/);

    // Then — no partial directory left behind
    expect(fs.existsSync(targetDir)).toBe(false);
  });

  it("shallow-clones via SSH when protocol is ssh", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const targetDir = path.join(
      libraryDir,
      "github.com",
      "user",
      "react-bundle",
    );

    vi.mocked(execFileSync).mockImplementation(() => Buffer.from(""));

    // When
    const result = await fetchRemoteSource({
      source: "github.com/user/react-bundle",
      libraryDir,
      protocol: "ssh",
    });

    // Then
    expect(result).toEqual({ cloned: true, targetDir });
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["clone", "--depth=1", "git@github.com:user/react-bundle.git", targetDir],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("shallow-clones via HTTPS when protocol is https (explicit)", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const targetDir = path.join(
      libraryDir,
      "github.com",
      "user",
      "react-bundle",
    );

    vi.mocked(execFileSync).mockImplementation(() => Buffer.from(""));

    // When
    await fetchRemoteSource({
      source: "github.com/user/react-bundle",
      libraryDir,
      protocol: "https",
    });

    // Then
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["clone", "--depth=1", "https://github.com/user/react-bundle", targetDir],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("requires a GitHub token when archive-first transport is requested", async () => {
    // Given
    const libraryDir = createLibraryDir();
    vi.stubEnv("SKUL_GITHUB_TRANSPORT", "archive");

    // When / Then
    await expect(
      fetchRemoteSource({
        source: "github.com/user/react-bundle",
        libraryDir,
      }),
    ).rejects.toThrowError(/requires GH_TOKEN or GITHUB_TOKEN/);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("rejects GitHub API base URL overrides outside tests", async () => {
    // Given
    const libraryDir = createLibraryDir();
    vi.stubEnv("GH_TOKEN", "github-token-value");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SKUL_GITHUB_API_BASE_URL", "http://127.0.0.1:1");
    vi.stubEnv("SKUL_GITHUB_TRANSPORT", "archive");

    // When / Then
    await expect(
      fetchRemoteSource({
        source: "github.com/user/react-bundle",
        libraryDir,
      }),
    ).rejects.toThrowError(
      /SKUL_GITHUB_API_BASE_URL is only supported in tests/,
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("does not add GH_TOKEN to git command args during the default clone transport", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const targetDir = path.join(
      libraryDir,
      "github.com",
      "user",
      "react-bundle",
    );
    vi.stubEnv("GH_TOKEN", "github-token-value");
    vi.mocked(execFileSync).mockImplementation(() => Buffer.from(""));

    // When
    await fetchRemoteSource({
      source: "github.com/user/react-bundle",
      libraryDir,
    });

    // Then
    const [, args] = vi.mocked(execFileSync).mock.calls[0] as [
      string,
      string[],
    ];
    expect(args).toEqual([
      "clone",
      "--depth=1",
      "https://github.com/user/react-bundle",
      targetDir,
    ]);
    expect(args.join(" ")).not.toContain("github-token-value");
  });

  it("includes the SSH clone URL in the error message when SSH clone fails", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const cloneError = Object.assign(new Error("Command failed"), {
      stderr: Buffer.from("Permission denied (publickey)."),
    });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw cloneError;
    });

    // When / Then
    await expect(
      fetchRemoteSource({
        source: "github.com/user/react-bundle",
        libraryDir,
        protocol: "ssh",
      }),
    ).rejects.toThrowError(
      /Failed to clone git@github\.com:user\/react-bundle\.git[\s\S]*Permission denied/,
    );
  });

  it("appends an HTTPS hint when SSH authentication fails with publickey error", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const cloneError = Object.assign(new Error("Command failed"), {
      stderr: Buffer.from("git@github.com: Permission denied (publickey)."),
    });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw cloneError;
    });

    // When / Then
    await expect(
      fetchRemoteSource({
        source: "github.com/user/react-bundle",
        libraryDir,
        protocol: "ssh",
      }),
    ).rejects.toThrowError(
      /Hint: SSH authentication failed[\s\S]*skul add github\.com\/user\/react-bundle/,
    );
  });

  it("appends an HTTPS hint when SSH authentication fails with 'could not read from remote' error", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const cloneError = Object.assign(new Error("Command failed"), {
      stderr: Buffer.from("fatal: Could not read from remote repository."),
    });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw cloneError;
    });

    // When / Then
    await expect(
      fetchRemoteSource({
        source: "github.com/user/react-bundle",
        libraryDir,
        protocol: "ssh",
      }),
    ).rejects.toThrowError(/Hint: SSH authentication failed/);
  });

  it("does not append an HTTPS hint for non-auth SSH failures", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const cloneError = Object.assign(new Error("Command failed"), {
      stderr: Buffer.from(
        "ERROR: Repository 'git@github.com:user/react-bundle.git' not found.",
      ),
    });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw cloneError;
    });

    // When
    let caught: Error | undefined;
    try {
      await fetchRemoteSource({
        source: "github.com/user/react-bundle",
        libraryDir,
        protocol: "ssh",
      });
    } catch (e) {
      caught = e as Error;
    }

    // Then — error is thrown but contains no HTTPS hint
    expect(caught?.message).toMatch(/Failed to clone git@github\.com/);
    expect(caught?.message).not.toMatch(/Hint/);
  });

  it("does not append an HTTPS hint for HTTPS clone failures", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const cloneError = Object.assign(new Error("Command failed"), {
      stderr: Buffer.from("Permission denied."),
    });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw cloneError;
    });

    // When
    let caught: Error | undefined;
    try {
      await fetchRemoteSource({
        source: "github.com/user/react-bundle",
        libraryDir,
        protocol: "https",
      });
    } catch (e) {
      caught = e as Error;
    }

    // Then — HTTPS failures never show SSH-specific hint
    expect(caught?.message).toMatch(/Failed to clone https:\/\//);
    expect(caught?.message).not.toMatch(/Hint/);
  });

  it("rejects sources that do not match host/owner/repo format", async () => {
    // Given
    const libraryDir = createLibraryDir();

    // When / Then
    await expect(
      fetchRemoteSource({ source: "../../../etc/passwd", libraryDir }),
    ).rejects.toThrowError(/Invalid bundle source/);
    await expect(
      fetchRemoteSource({ source: "github.com/user", libraryDir }),
    ).rejects.toThrowError(/Invalid bundle source/);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
