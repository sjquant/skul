import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearAndRefetchCachedRemoteSource,
  fetchRemoteSource,
  inspectRemoteSource,
  readCachedSourceRevision,
  restoreCachedRemoteSourceRevision,
  updateCachedRemoteSource,
} from "./bundle-fetch";

const tempDirs: string[] = [];
const fakeGithubServers: Server[] = [];
const MUTATED_ENV_NAMES = [
  "GH_TOKEN",
  "GIT_SSH",
  "GITHUB_TOKEN",
  "PATH",
  "SKUL_GITHUB_API_BASE_URL",
  "SKUL_GITHUB_TRANSPORT",
] as const;
let previousEnv: Partial<Record<(typeof MUTATED_ENV_NAMES)[number], string>>;

interface FakeGithubState {
  archives: Record<string, string>;
  branches: Record<string, string>;
  commits: string[];
  defaultBranch: string;
  failArchiveFor?: string;
  owner: string;
  repo: string;
  requests: string[];
  tagObjects: Record<string, { object: { sha: string; type: string } }>;
  tags: Record<string, { object: { sha: string; type: string } }>;
  token: string;
}

beforeEach(() => {
  // Given
  previousEnv = snapshotEnv();
});

afterEach(async () => {
  await Promise.all(fakeGithubServers.splice(0).map(closeServer));

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  restoreEnv(previousEnv);
});

describe("updateCachedRemoteSource integration", () => {
  it("normalizes SSH authentication failures raised while resolving the requested remote ref", async () => {
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
    process.env.GIT_SSH = createFakeSshCommand(libraryDir);

    // When / Then
    await expect(
      updateCachedRemoteSource({
        source,
        libraryDir,
        protocol: "ssh",
        ref: "stable",
      }),
    ).rejects.toThrowError(
      /Failed to update github\.com\/user\/react-bundle[\s\S]*Hint: SSH authentication failed/,
    );
  });

  it("falls back to a GitHub archive cache when git clone fails with proxy 403", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const source = "github.com/user/react-bundle";
    const commit = "1111111111111111111111111111111111111111";
    const argsFile = installProxyForbiddenGit(libraryDir);
    await configureFakeGithubApi(
      libraryDir,
      createFakeGithubState({
        archives: {
          [commit]: createArchive(libraryDir, commit, {
            "AGENTS.md": "# archive bundle\n",
          }),
        },
        branches: { main: commit },
        commits: [commit],
      }),
    );
    process.env.GH_TOKEN = "github-token-value";

    // When
    const result = await fetchRemoteSource({ source, libraryDir });

    // Then
    const metadata = readArchiveMetadata(result.targetDir);
    expect(result.cloned).toBe(true);
    expect(fs.existsSync(path.join(result.targetDir, ".git"))).toBe(false);
    expect(
      fs.readFileSync(path.join(result.targetDir, "AGENTS.md"), "utf8"),
    ).toBe("# archive bundle\n");
    expect(metadata).toMatchObject({
      requested_ref: null,
      resolved_commit: commit,
      resolved_ref: "main",
      source,
      transport: "github-archive",
    });
    expect(fs.readFileSync(argsFile, "utf8")).not.toContain(
      "github-token-value",
    );
  });

  it("falls back to a GitHub archive cache when cached git refresh hits proxy 403", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const source = "github.com/user/react-bundle";
    const targetDir = seedCachedRemoteSource(libraryDir, source);
    const commit = "1111111111111111111111111111111111111111";
    const argsFile = installProxyForbiddenGit(libraryDir);
    await configureFakeGithubApi(
      libraryDir,
      createFakeGithubState({
        archives: {
          [commit]: createArchive(libraryDir, commit, {
            "AGENTS.md": "# fallback refresh\n",
          }),
        },
        branches: { main: commit },
        commits: [commit],
      }),
    );
    process.env.GH_TOKEN = "github-token-value";

    // When
    await clearAndRefetchCachedRemoteSource({ source, libraryDir });

    // Then
    expect(fs.existsSync(path.join(targetDir, ".git"))).toBe(false);
    expect(fs.readFileSync(path.join(targetDir, "AGENTS.md"), "utf8")).toBe(
      "# fallback refresh\n",
    );
    expect(readArchiveMetadata(targetDir)).toMatchObject({
      requested_ref: null,
      resolved_commit: commit,
      resolved_ref: "main",
    });
    expect(fs.readFileSync(argsFile, "utf8")).not.toContain(
      "github-token-value",
    );
  });

  it("inspects an archive cache through the GitHub API instead of git ls-remote", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const source = "github.com/user/react-bundle";
    const initialCommit = "1111111111111111111111111111111111111111";
    const remoteCommit = "2222222222222222222222222222222222222222";
    const laterCommit = "3333333333333333333333333333333333333333";
    const { state } = await configureFakeGithubApi(
      libraryDir,
      createFakeGithubState({
        archives: {
          [initialCommit]: createArchive(libraryDir, initialCommit, {
            "AGENTS.md": "# initial\n",
          }),
          [remoteCommit]: createArchive(libraryDir, remoteCommit, {
            "AGENTS.md": "# remote\n",
          }),
          [laterCommit]: createArchive(libraryDir, laterCommit, {
            "AGENTS.md": "# later\n",
          }),
        },
        branches: { main: initialCommit },
        commits: [initialCommit, remoteCommit, laterCommit],
      }),
    );
    process.env.GH_TOKEN = "github-token-value";
    process.env.SKUL_GITHUB_TRANSPORT = "archive";
    await fetchRemoteSource({ source, libraryDir });
    updateFakeGithubState(state, (state) => {
      state.branches.main = remoteCommit;
    });

    // When
    const status = await inspectRemoteSource({ source, libraryDir });

    // Then
    expect(status.currentCommit).toBe(initialCommit);
    expect(status.remoteCommit).toBe(remoteCommit);
  });

  it("follows the current default branch for archive caches fetched without an explicit ref", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const source = "github.com/user/react-bundle";
    const initialCommit = "1111111111111111111111111111111111111111";
    const laterCommit = "2222222222222222222222222222222222222222";
    const { state } = await configureFakeGithubApi(
      libraryDir,
      createFakeGithubState({
        archives: {
          [initialCommit]: createArchive(libraryDir, initialCommit, {
            "AGENTS.md": "# initial\n",
          }),
          [laterCommit]: createArchive(libraryDir, laterCommit, {
            "AGENTS.md": "# trunk\n",
          }),
        },
        branches: { main: initialCommit, trunk: laterCommit },
        commits: [initialCommit, laterCommit],
      }),
    );
    process.env.GH_TOKEN = "github-token-value";
    process.env.SKUL_GITHUB_TRANSPORT = "archive";
    await fetchRemoteSource({ source, libraryDir });
    updateFakeGithubState(state, (state) => {
      state.defaultBranch = "trunk";
    });

    // When
    const status = await inspectRemoteSource({ source, libraryDir });

    // Then
    expect(status.remoteCommit).toBe(laterCommit);
    expect(status.resolvedRef).toBe("trunk");
  });

  it("updates an archive cache by replacing it with a newer downloaded archive", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const source = "github.com/user/react-bundle";
    const initialCommit = "1111111111111111111111111111111111111111";
    const remoteCommit = "2222222222222222222222222222222222222222";
    const { state } = await configureFakeGithubApi(
      libraryDir,
      createFakeGithubState({
        archives: {
          [initialCommit]: createArchive(libraryDir, initialCommit, {
            "AGENTS.md": "# initial\n",
          }),
          [remoteCommit]: createArchive(libraryDir, remoteCommit, {
            "AGENTS.md": "# remote\n",
          }),
        },
        branches: { main: initialCommit },
        commits: [initialCommit, remoteCommit],
      }),
    );
    process.env.GH_TOKEN = "github-token-value";
    process.env.SKUL_GITHUB_TRANSPORT = "archive";
    await fetchRemoteSource({ source, libraryDir });
    updateFakeGithubState(state, (state) => {
      state.branches.main = remoteCommit;
    });

    // When
    const result = await updateCachedRemoteSource({ source, libraryDir });

    // Then
    const targetDir = path.join(libraryDir, ...source.split("/"));
    expect(result).toMatchObject({
      currentCommit: remoteCommit,
      previousCommit: initialCommit,
      remoteCommit,
      updated: true,
    });
    expect(fs.readFileSync(path.join(targetDir, "AGENTS.md"), "utf8")).toBe(
      "# remote\n",
    );
    expect(readArchiveMetadata(targetDir).resolved_commit).toBe(remoteCommit);
  });

  it("replaces an archive cache with an SSH git clone when SSH is requested", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const source = "github.com/user/react-bundle";
    const commit = "1111111111111111111111111111111111111111";
    await configureFakeGithubApi(
      libraryDir,
      createFakeGithubState({
        archives: {
          [commit]: createArchive(libraryDir, commit, {
            "AGENTS.md": "# archive\n",
          }),
        },
        branches: { main: commit },
        commits: [commit],
      }),
    );
    process.env.GH_TOKEN = "github-token-value";
    process.env.SKUL_GITHUB_TRANSPORT = "archive";
    const { targetDir } = await fetchRemoteSource({ source, libraryDir });
    const argsFile = installSuccessfulCloneGit(libraryDir);
    delete process.env.SKUL_GITHUB_TRANSPORT;

    // When
    await clearAndRefetchCachedRemoteSource({
      source,
      libraryDir,
      protocol: "ssh",
    });

    // Then
    expect(fs.existsSync(path.join(targetDir, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, ".skul-source.json"))).toBe(
      false,
    );
    expect(fs.readFileSync(argsFile, "utf8")).toContain(
      "clone --depth=1 git@github.com:user/react-bundle.git",
    );
  });

  it("uses GITHUB_TOKEN and resolves annotated tags for archive-first fetches", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const source = "github.com/user/react-bundle";
    const commit = "3333333333333333333333333333333333333333";
    await configureFakeGithubApi(
      libraryDir,
      createFakeGithubState({
        archives: {
          [commit]: createArchive(libraryDir, commit, {
            "AGENTS.md": "# tagged\n",
          }),
        },
        branches: {},
        commits: [commit],
        tagObjects: {
          aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: {
            object: { sha: commit, type: "commit" },
          },
        },
        tags: {
          "v1.0.0": {
            object: {
              sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              type: "tag",
            },
          },
        },
      }),
    );
    process.env.GITHUB_TOKEN = "github-token-value";
    process.env.SKUL_GITHUB_TRANSPORT = "archive";

    // When
    const result = await fetchRemoteSource({
      source,
      libraryDir,
      ref: "v1.0.0",
    });

    // Then
    const metadata = readArchiveMetadata(result.targetDir);
    expect(
      fs.readFileSync(path.join(result.targetDir, "AGENTS.md"), "utf8"),
    ).toBe("# tagged\n");
    expect(metadata).toMatchObject({
      requested_ref: "v1.0.0",
      resolved_commit: commit,
      resolved_ref: "v1.0.0",
    });
  });

  it("preserves the existing archive cache when an update download fails", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const source = "github.com/user/react-bundle";
    const initialCommit = "1111111111111111111111111111111111111111";
    const remoteCommit = "2222222222222222222222222222222222222222";
    const { state } = await configureFakeGithubApi(
      libraryDir,
      createFakeGithubState({
        archives: {
          [initialCommit]: createArchive(libraryDir, initialCommit, {
            "AGENTS.md": "# initial\n",
          }),
        },
        branches: { main: initialCommit },
        commits: [initialCommit, remoteCommit],
      }),
    );
    process.env.GH_TOKEN = "github-token-value";
    process.env.SKUL_GITHUB_TRANSPORT = "archive";
    await fetchRemoteSource({ source, libraryDir });
    updateFakeGithubState(state, (state) => {
      state.branches.main = remoteCommit;
      state.failArchiveFor = remoteCommit;
    });

    // When
    await expect(
      updateCachedRemoteSource({ source, libraryDir }),
    ).rejects.toThrowError(/Failed to fetch github\.com\/user\/react-bundle/);

    // Then
    const targetDir = path.join(libraryDir, ...source.split("/"));
    expect(fs.readFileSync(path.join(targetDir, "AGENTS.md"), "utf8")).toBe(
      "# initial\n",
    );
    expect(readArchiveMetadata(targetDir)).toMatchObject({
      requested_ref: null,
      resolved_commit: initialCommit,
      resolved_ref: "main",
    });
  });

  it("does not leak tokens through git args or archive fallback errors", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const source = "github.com/user/react-bundle";
    const argsFile = installProxyForbiddenGit(libraryDir);
    await configureFakeGithubApi(
      libraryDir,
      createFakeGithubState({
        archives: {},
        branches: {},
        commits: [],
        token: "different-token",
      }),
    );
    process.env.GH_TOKEN = "github-token-value";

    // When
    let caught: Error | undefined;
    try {
      await fetchRemoteSource({ source, libraryDir });
    } catch (error) {
      caught = error as Error;
    }

    // Then
    expect(caught?.message).not.toContain("github-token-value");
    expect(fs.readFileSync(argsFile, "utf8")).not.toContain(
      "github-token-value",
    );
  });

  it("ignores repository-owned archive metadata in a git cache", () => {
    // Given
    const libraryDir = createLibraryDir();
    const source = "github.com/user/react-bundle";
    const targetDir = seedCachedRemoteSource(libraryDir, source);
    const currentCommit = runGit(targetDir, ["rev-parse", "HEAD"]);
    fs.writeFileSync(
      path.join(targetDir, ".skul-source.json"),
      `${JSON.stringify({
        transport: "github-archive",
        source,
        requested_ref: null,
        resolved_commit: "0000000000000000000000000000000000000000",
        resolved_ref: "main",
        fetched_at: new Date().toISOString(),
      })}\n`,
    );

    // When
    const revision = readCachedSourceRevision({ source, libraryDir });

    // Then
    expect(revision.currentCommit).toBe(currentCommit);
  });

  it("fails clearly when archive metadata is invalid", () => {
    // Given
    const libraryDir = createLibraryDir();
    const source = "github.com/user/react-bundle";
    const targetDir = path.join(libraryDir, ...source.split("/"));
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, ".skul-source.json"), "{");

    // When / Then
    expect(() => readCachedSourceRevision({ source, libraryDir })).toThrowError(
      /Invalid GitHub archive metadata/,
    );
  });

  it("restores an archive cache to a previous commit", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const source = "github.com/user/react-bundle";
    const initialCommit = "1111111111111111111111111111111111111111";
    const remoteCommit = "2222222222222222222222222222222222222222";
    const laterCommit = "3333333333333333333333333333333333333333";
    const { state } = await configureFakeGithubApi(
      libraryDir,
      createFakeGithubState({
        archives: {
          [initialCommit]: createArchive(libraryDir, initialCommit, {
            "AGENTS.md": "# initial\n",
          }),
          [remoteCommit]: createArchive(libraryDir, remoteCommit, {
            "AGENTS.md": "# remote\n",
          }),
          [laterCommit]: createArchive(libraryDir, laterCommit, {
            "AGENTS.md": "# later\n",
          }),
        },
        branches: { main: initialCommit },
        commits: [initialCommit, remoteCommit, laterCommit],
      }),
    );
    process.env.GH_TOKEN = "github-token-value";
    process.env.SKUL_GITHUB_TRANSPORT = "archive";
    await fetchRemoteSource({ source, libraryDir });
    updateFakeGithubState(state, (state) => {
      state.branches.main = remoteCommit;
    });
    await updateCachedRemoteSource({ source, libraryDir });

    // When
    await restoreCachedRemoteSourceRevision({
      source,
      libraryDir,
      commit: initialCommit,
      refName: "main",
    });

    // Then
    const targetDir = path.join(libraryDir, ...source.split("/"));
    expect(fs.readFileSync(path.join(targetDir, "AGENTS.md"), "utf8")).toBe(
      "# initial\n",
    );
    expect(readArchiveMetadata(targetDir)).toMatchObject({
      requested_ref: null,
      resolved_commit: initialCommit,
      resolved_ref: "main",
    });
    updateFakeGithubState(state, (state) => {
      state.branches.main = laterCommit;
    });
    expect(
      (await inspectRemoteSource({ source, libraryDir })).remoteCommit,
    ).toBe(laterCommit);
  });

  it("refreshes an archive cache without an explicit ref", async () => {
    // Given
    const libraryDir = createLibraryDir();
    const source = "github.com/user/react-bundle";
    const initialCommit = "1111111111111111111111111111111111111111";
    const remoteCommit = "2222222222222222222222222222222222222222";
    const { state } = await configureFakeGithubApi(
      libraryDir,
      createFakeGithubState({
        archives: {
          [initialCommit]: createArchive(libraryDir, initialCommit, {
            "AGENTS.md": "# initial\n",
          }),
          [remoteCommit]: createArchive(libraryDir, remoteCommit, {
            "AGENTS.md": "# remote\n",
          }),
        },
        branches: { main: initialCommit },
        commits: [initialCommit, remoteCommit],
      }),
    );
    process.env.GH_TOKEN = "github-token-value";
    process.env.SKUL_GITHUB_TRANSPORT = "archive";
    await fetchRemoteSource({ source, libraryDir });
    updateFakeGithubState(state, (state) => {
      state.branches.main = remoteCommit;
    });

    // When
    await clearAndRefetchCachedRemoteSource({ source, libraryDir });

    // Then
    const targetDir = path.join(libraryDir, ...source.split("/"));
    expect(fs.readFileSync(path.join(targetDir, "AGENTS.md"), "utf8")).toBe(
      "# remote\n",
    );
    expect(readArchiveMetadata(targetDir).resolved_commit).toBe(remoteCommit);
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

async function configureFakeGithubApi(
  _libraryDir: string,
  state: FakeGithubState,
): Promise<{ state: FakeGithubState }> {
  const server = http.createServer((request, response) => {
    handleFakeGithubApiRequest(request, response, state);
  });
  fakeGithubServers.push(server);

  const url = await listen(server);
  process.env.SKUL_GITHUB_API_BASE_URL = url;

  return { state };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();

      if (!address || typeof address === "string") {
        reject(new Error("Fake GitHub API server did not bind to a port"));
        return;
      }

      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function createFakeGithubState(
  overrides: Partial<FakeGithubState>,
): FakeGithubState {
  return {
    archives: {},
    branches: {},
    commits: [],
    defaultBranch: "main",
    owner: "user",
    repo: "react-bundle",
    requests: [],
    tagObjects: {},
    tags: {},
    token: "github-token-value",
    ...overrides,
  };
}

function updateFakeGithubState(
  state: FakeGithubState,
  update: (state: FakeGithubState) => void,
): void {
  update(state);
}

function handleFakeGithubApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: FakeGithubState,
): void {
  if (!requireFakeGithubHeaders(request, response, state)) {
    return;
  }

  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const prefix = `/repos/${state.owner}/${state.repo}`;
  const pathname = decodeURIComponent(url.pathname);
  state.requests.push(pathname);

  if (pathname === prefix) {
    writeJson(response, 200, { default_branch: state.defaultBranch });
    return;
  }

  if (pathname.startsWith(`${prefix}/git/ref/heads/`)) {
    const branch = pathname.slice(`${prefix}/git/ref/heads/`.length);
    const sha = state.branches[branch];
    writeJson(
      response,
      sha ? 200 : 404,
      sha ? { object: { sha, type: "commit" } } : { message: "Not Found" },
    );
    return;
  }

  if (pathname.startsWith(`${prefix}/git/ref/tags/`)) {
    const tag = pathname.slice(`${prefix}/git/ref/tags/`.length);
    const value = state.tags[tag];
    writeJson(response, value ? 200 : 404, value ?? { message: "Not Found" });
    return;
  }

  if (pathname.startsWith(`${prefix}/git/tags/`)) {
    const sha = pathname.slice(`${prefix}/git/tags/`.length);
    const value = state.tagObjects[sha];
    writeJson(response, value ? 200 : 404, value ?? { message: "Not Found" });
    return;
  }

  if (pathname.startsWith(`${prefix}/commits/`)) {
    const sha = pathname.slice(`${prefix}/commits/`.length);
    writeJson(
      response,
      state.commits.includes(sha) ? 200 : 404,
      state.commits.includes(sha) ? { sha } : { message: "Not Found" },
    );
    return;
  }

  if (pathname.startsWith(`${prefix}/tarball/`)) {
    const ref = pathname.slice(`${prefix}/tarball/`.length);

    if (state.failArchiveFor === ref) {
      writeJson(response, 403, { message: "archive forbidden" });
      return;
    }

    const archive = state.archives[ref];
    if (!archive) {
      writeJson(response, 404, { message: "Not Found" });
      return;
    }

    response.writeHead(200, { "content-type": "application/x-gzip" });
    fs.createReadStream(archive).pipe(response);
    return;
  }

  writeJson(response, 404, { message: "Not Found" });
}

function requireFakeGithubHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  state: FakeGithubState,
): boolean {
  if (request.headers.authorization !== `Bearer ${state.token}`) {
    writeJson(response, 401, {
      message: `Bad credentials for ${request.headers.authorization}`,
    });
    return false;
  }

  if (request.headers.accept !== "application/vnd.github+json") {
    writeJson(response, 400, { message: "missing accept header" });
    return false;
  }

  if (!request.headers["x-github-api-version"]) {
    writeJson(response, 400, { message: "missing api version header" });
    return false;
  }

  if (!request.headers["user-agent"]) {
    writeJson(response, 400, { message: "missing user agent" });
    return false;
  }

  return true;
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function createArchive(
  libraryDir: string,
  commit: string,
  files: Record<string, string>,
): string {
  const archiveRoot = fs.mkdtempSync(path.join(libraryDir, "archive-root-"));
  const wrapperDir = path.join(
    archiveRoot,
    `user-react-bundle-${commit.slice(0, 7)}`,
  );
  const archiveFile = path.join(libraryDir, `${commit}.tar.gz`);
  fs.mkdirSync(wrapperDir, { recursive: true });

  for (const [filePath, content] of Object.entries(files)) {
    const absolutePath = path.join(wrapperDir, filePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }

  execFileSync("tar", [
    "-czf",
    archiveFile,
    "-C",
    archiveRoot,
    path.basename(wrapperDir),
  ]);
  fs.rmSync(archiveRoot, { recursive: true, force: true });

  return archiveFile;
}

function installProxyForbiddenGit(libraryDir: string): string {
  const fakeGitPath = path.join(libraryDir, "git");
  const argsFile = path.join(libraryDir, "git-args.log");
  fs.writeFileSync(
    fakeGitPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(argsFile)}, process.argv.slice(2).join(" ") + "\\n");
console.error("fatal: unable to access 'https://github.com/user/react-bundle/': Received HTTP code 403 from proxy after CONNECT");
process.exit(128);
`,
  );
  fs.chmodSync(fakeGitPath, 0o755);
  process.env.PATH = `${libraryDir}${path.delimiter}${process.env.PATH ?? ""}`;

  return argsFile;
}

function installSuccessfulCloneGit(libraryDir: string): string {
  const fakeGitPath = path.join(libraryDir, "git");
  const argsFile = path.join(libraryDir, "git-args.log");
  fs.writeFileSync(
    fakeGitPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsFile)}, args.join(" ") + "\\n");
if (args[0] !== "clone") {
  console.error("unexpected git command: " + args.join(" "));
  process.exit(1);
}
const targetDir = args[args.length - 1];
fs.mkdirSync(path.join(targetDir, ".git"), { recursive: true });
fs.writeFileSync(path.join(targetDir, "README.md"), "# ssh clone\\n");
`,
  );
  fs.chmodSync(fakeGitPath, 0o755);
  process.env.PATH = `${libraryDir}${path.delimiter}${process.env.PATH ?? ""}`;

  return argsFile;
}

function readArchiveMetadata(targetDir: string): {
  requested_ref: string | null;
  resolved_commit: string;
  resolved_ref: string | null;
  source: string;
  transport: string;
} {
  return JSON.parse(
    fs.readFileSync(path.join(targetDir, ".skul-source.json"), "utf8"),
  ) as {
    requested_ref: string | null;
    resolved_commit: string;
    resolved_ref: string | null;
    source: string;
    transport: string;
  };
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
