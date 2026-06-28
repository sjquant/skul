import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { updateCachedRemoteSource } from "./bundle-fetch";

const tempDirs: string[] = [];
const MUTATED_ENV_NAMES = [
  "ALL_PROXY",
  "FAKE_CURRENT_COMMIT",
  "FAKE_EXPECTED_TOKEN",
  "FAKE_FAIL_ON_PROXY",
  "FAKE_REMOTE_COMMIT",
  "FAKE_REMOTE_URL",
  "FAKE_REQUIRE_PROXY",
  "FAKE_REQUIRE_TOKEN",
  "FAKE_STATE_FILE",
  "GH_TOKEN",
  "GIT_SSH",
  "GITHUB_TOKEN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "PATH",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;
let previousEnv: Partial<Record<(typeof MUTATED_ENV_NAMES)[number], string>>;

beforeEach(() => {
  // Given
  previousEnv = snapshotEnv();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  restoreEnv(previousEnv);
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

  it("uses GH_TOKEN while inspecting and fetching a cached GitHub source", () => {
    // Given
    const libraryDir = createLibraryDir();
    const source = "github.com/user/react-bundle";
    const remoteCommit = "2222222222222222222222222222222222222222";
    seedFakeCachedRemoteSource(libraryDir, source);
    installFakeGit(libraryDir, {
      currentCommit: "1111111111111111111111111111111111111111",
      expectedToken: "github-token-value",
      remoteCommit,
      remoteUrl: `https://${source}`,
      requireToken: true,
    });
    process.env.GH_TOKEN = "github-token-value";

    // When
    const result = updateCachedRemoteSource({ source, libraryDir });

    // Then
    expect(result).toMatchObject({
      currentCommit: remoteCommit,
      remoteCommit,
      updated: true,
    });
  });

  it("scrubs loopback proxy settings while inspecting and fetching a GitHub source", () => {
    // Given
    const libraryDir = createLibraryDir();
    const source = "github.com/user/react-bundle";
    const remoteCommit = "3333333333333333333333333333333333333333";
    seedFakeCachedRemoteSource(libraryDir, source);
    installFakeGit(libraryDir, {
      currentCommit: "1111111111111111111111111111111111111111",
      failOnProxy: true,
      remoteCommit,
      remoteUrl: `https://${source}`,
    });
    process.env.HTTPS_PROXY = "http://127.0.0.1:3210";

    // When
    const result = updateCachedRemoteSource({ source, libraryDir });

    // Then
    expect(result.currentCommit).toBe(remoteCommit);
    expect(result.updated).toBe(true);
  });

  it("keeps loopback proxy settings for non-GitHub HTTPS sources", () => {
    // Given
    const libraryDir = createLibraryDir();
    const source = "gitlab.example.com/user/react-bundle";
    const remoteCommit = "4444444444444444444444444444444444444444";
    seedFakeCachedRemoteSource(libraryDir, source);
    installFakeGit(libraryDir, {
      currentCommit: "1111111111111111111111111111111111111111",
      remoteCommit,
      remoteUrl: `https://${source}`,
      requireProxy: true,
    });
    process.env.HTTPS_PROXY = "http://127.0.0.1:3210";

    // When
    const result = updateCachedRemoteSource({ source, libraryDir });

    // Then
    expect(result.currentCommit).toBe(remoteCommit);
    expect(result.updated).toBe(true);
  });
});

function snapshotEnv(): Partial<
  Record<(typeof MUTATED_ENV_NAMES)[number], string>
> {
  return Object.fromEntries(
    MUTATED_ENV_NAMES.map((name) => [name, process.env[name]]),
  );
}

function restoreEnv(
  env: Partial<Record<(typeof MUTATED_ENV_NAMES)[number], string>>,
): void {
  for (const name of MUTATED_ENV_NAMES) {
    const value = env[name];

    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

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

function seedFakeCachedRemoteSource(
  libraryDir: string,
  source: string,
): string {
  const targetDir = path.join(libraryDir, ...source.split("/"));
  fs.mkdirSync(targetDir, { recursive: true });

  return targetDir;
}

function installFakeGit(
  libraryDir: string,
  options: {
    currentCommit: string;
    expectedToken?: string;
    failOnProxy?: boolean;
    remoteCommit: string;
    remoteUrl: string;
    requireProxy?: boolean;
    requireToken?: boolean;
  },
): void {
  const fakeGitPath = path.join(libraryDir, "git");
  const stateFile = path.join(libraryDir, "fake-git-head");
  fs.writeFileSync(stateFile, options.currentCommit);
  fs.writeFileSync(fakeGitPath, getFakeGitScript());
  fs.chmodSync(fakeGitPath, 0o755);

  process.env.PATH = `${libraryDir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.FAKE_CURRENT_COMMIT = options.currentCommit;
  process.env.FAKE_EXPECTED_TOKEN = options.expectedToken ?? "";
  process.env.FAKE_FAIL_ON_PROXY = options.failOnProxy ? "1" : "";
  process.env.FAKE_REMOTE_COMMIT = options.remoteCommit;
  process.env.FAKE_REMOTE_URL = options.remoteUrl;
  process.env.FAKE_REQUIRE_PROXY = options.requireProxy ? "1" : "";
  process.env.FAKE_REQUIRE_TOKEN = options.requireToken ? "1" : "";
  process.env.FAKE_STATE_FILE = stateFile;
}

function getFakeGitScript(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");

const args = process.argv.slice(2);
let index = 0;

while (index < args.length) {
  if (args[index] === "-c") {
    index += 2;
    continue;
  }

  if (args[index] === "-C") {
    index += 2;
    continue;
  }

  break;
}

const command = args[index];
const rest = args.slice(index + 1);

function head() {
  try {
    return fs.readFileSync(process.env.FAKE_STATE_FILE, "utf8").trim();
  } catch {
    return process.env.FAKE_CURRENT_COMMIT;
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function hasProxyEnv() {
  return Boolean(
    process.env.HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.ALL_PROXY ||
      process.env.http_proxy ||
      process.env.https_proxy ||
      process.env.all_proxy,
  );
}

function assertRemoteEnvironment() {
  if (
    process.env.FAKE_REQUIRE_TOKEN === "1" &&
    process.env.SKUL_GIT_AUTH_TOKEN !== process.env.FAKE_EXPECTED_TOKEN
  ) {
    fail("missing expected token");
  }

  if (process.env.FAKE_FAIL_ON_PROXY === "1" && hasProxyEnv()) {
    fail("proxy environment leaked");
  }

  if (process.env.FAKE_REQUIRE_PROXY === "1" && !hasProxyEnv()) {
    fail("proxy environment was unexpectedly scrubbed");
  }
}

if (command === "rev-parse") {
  console.log(head());
} else if (command === "symbolic-ref") {
  console.log("main");
} else if (command === "remote" && rest[0] === "get-url") {
  console.log(process.env.FAKE_REMOTE_URL);
} else if (command === "ls-remote") {
  assertRemoteEnvironment();

  if (rest.includes("--symref")) {
    console.log("ref: refs/heads/main\\tHEAD");
    console.log(process.env.FAKE_REMOTE_COMMIT + "\\tHEAD");
  } else {
    console.log(process.env.FAKE_REMOTE_COMMIT + "\\t" + rest.at(-1));
  }
} else if (command === "fetch") {
  assertRemoteEnvironment();
} else if (command === "checkout") {
  fs.writeFileSync(process.env.FAKE_STATE_FILE, process.env.FAKE_REMOTE_COMMIT);
} else {
  fail("unsupported fake git command: " + args.join(" "));
}
`;
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
