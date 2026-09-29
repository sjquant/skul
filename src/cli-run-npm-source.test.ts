import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http, { type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHomeDir,
  createPromptClientStub,
  createRepository,
  pathExists,
  tempDirs,
} from "./cli.test-support";
import { run } from "./index";

const servers: Server[] = [];

interface FakeNpmRegistry {
  packageName: string;
  distTags: Record<string, string>;
  versions: Record<string, Buffer>;
  requests: { url: string; authorization?: string }[];
  tarballBaseUrl: string;
  shasumOverride?: string;
}

beforeEach(() => {
  for (const name of [
    "SKUL_NPM_REGISTRY",
    "SKUL_NPM_TOKEN",
    "npm_config_registry",
  ]) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  vi.unstubAllEnvs();
});

describe("npm bundle sources", () => {
  it("adds a scoped npm package as a bundle from its latest dist-tag", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const registry = await startFakeNpmRegistry("@acme/react-skills", {
      "1.0.0": { "skills/react/SKILL.md": skill("v1") },
    });

    // When
    const output = await run(
      ["add", "npm:@acme/react-skills", "-a", "claude-code", "-y"],
      { homeDir, cwd: repoRoot, prompts: createPromptClientStub() },
    );

    // Then
    expect(output).toContain("react-skills");
    expect(readSkill(repoRoot)).toContain("v1");
    expect(
      fs.existsSync(
        path.join(
          homeDir,
          ".skul",
          "library",
          "npm",
          "acme",
          "react-skills",
          "skills",
          "react",
          "SKILL.md",
        ),
      ),
    ).toBe(true);
    expect(registry.requests.map((request) => request.url)).toEqual(
      expect.arrayContaining([
        "/@acme%2freact-skills",
        "/@acme/react-skills/-/react-skills-1.0.0.tgz",
      ]),
    );
  });

  it("updates an npm bundle when its dist-tag moves to a new version", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const registry = await startFakeNpmRegistry("@acme/react-skills", {
      "1.0.0": { "skills/react/SKILL.md": skill("v1") },
    });
    await run(["add", "npm:@acme/react-skills", "-a", "claude-code", "-y"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    publishVersion(registry, "1.1.0", { "skills/react/SKILL.md": skill("v2") });

    // When
    const checkOutput = await run(["check"], { homeDir, cwd: repoRoot });
    await run(["update", "-y"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // Then
    expect(checkOutput).toContain("update-available");
    expect(readSkill(repoRoot)).toContain("v2");
  });

  it("pins an npm bundle to the version given inline in the source", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const registry = await startFakeNpmRegistry("react-skills", {
      "1.0.0": { "skills/react/SKILL.md": skill("v1") },
      "2.0.0": { "skills/react/SKILL.md": skill("v2") },
    });

    // When
    await run(["add", "npm:react-skills@1.0.0", "-a", "claude-code", "-y"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    const checkOutput = await run(["check"], { homeDir, cwd: repoRoot });

    // Then
    expect(readSkill(repoRoot)).toContain("v1");
    expect(checkOutput).toContain("pinned");
    expect(registry.requests.map((request) => request.url)).toContain(
      "/react-skills/-/react-skills-1.0.0.tgz",
    );
  });

  it("sends the configured token to registry-hosted tarballs", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const registry = await startFakeNpmRegistry("react-skills", {
      "1.0.0": { "skills/react/SKILL.md": skill("v1") },
    });
    vi.stubEnv("SKUL_NPM_TOKEN", "secret-token");

    // When
    await run(["add", "npm:react-skills", "-a", "claude-code", "-y"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // Then
    expect(registry.requests.length).toBeGreaterThan(0);
    for (const request of registry.requests) {
      expect(request.authorization).toBe("Bearer secret-token");
    }
  });

  it("does not send the configured token to a tarball on another origin", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const registry = await startFakeNpmRegistry(
      "react-skills",
      { "1.0.0": { "skills/react/SKILL.md": skill("v1") } },
      { separateTarballOrigin: true },
    );
    vi.stubEnv("SKUL_NPM_TOKEN", "secret-token");

    // When
    await run(["add", "npm:react-skills", "-a", "claude-code", "-y"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // Then
    const tarballRequests = registry.requests.filter((request) =>
      request.url.endsWith(".tgz"),
    );
    expect(tarballRequests).toHaveLength(1);
    expect(tarballRequests[0]!.authorization).toBeUndefined();
    expect(readSkill(repoRoot)).toContain("v1");
  });

  it("rejects a tarball whose digest does not match the registry metadata", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const registry = await startFakeNpmRegistry("react-skills", {
      "1.0.0": { "skills/react/SKILL.md": skill("v1") },
    });
    registry.shasumOverride = "0".repeat(40);

    // When / Then
    await expect(
      run(["add", "npm:react-skills", "-a", "claude-code", "-y"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).rejects.toThrowError(/shasum mismatch/);
    expect(pathExists(path.join(repoRoot, ".claude"))).toBe(false);
  });

  it("reports a missing npm version", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    await startFakeNpmRegistry("react-skills", {
      "1.0.0": { "skills/react/SKILL.md": skill("v1") },
    });

    // When / Then
    await expect(
      run(["add", "npm:react-skills", "--ref", "9.9.9", "-y"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).rejects.toThrowError(
      /npm version or dist-tag not found for react-skills: 9\.9\.9/,
    );
  });

  it("rejects an inline npm version combined with --ref", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    // When / Then
    await expect(
      run(["add", "npm:react-skills@1.0.0", "--ref", "latest"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).rejects.toThrowError(
      /An npm source version and --ref cannot be used together/,
    );
  });
});

function skill(body: string): string {
  return `---\nname: react\ndescription: React skill\n---\n\n# ${body}\n`;
}

function readSkill(repoRoot: string): string {
  return fs.readFileSync(
    path.join(repoRoot, ".claude", "skills", "react", "SKILL.md"),
    "utf8",
  );
}

async function startFakeNpmRegistry(
  packageName: string,
  versions: Record<string, Record<string, string>>,
  options: { separateTarballOrigin?: boolean } = {},
): Promise<FakeNpmRegistry> {
  const registry: FakeNpmRegistry = {
    packageName,
    distTags: {},
    versions: {},
    requests: [],
    tarballBaseUrl: "",
  };
  for (const [version, files] of Object.entries(versions)) {
    publishVersion(registry, version, files);
  }

  const registryBaseUrl = await startServer((request, response) => {
    recordRequest(registry, request);

    if (request.url === `/${packageName.replace("/", "%2f")}`) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(createPackument(registry)));
      return;
    }

    serveTarball(registry, request, response);
  });
  registry.tarballBaseUrl = options.separateTarballOrigin
    ? await startServer((request, response) => {
        recordRequest(registry, request);
        serveTarball(registry, request, response);
      })
    : registryBaseUrl;
  vi.stubEnv("SKUL_NPM_REGISTRY", registryBaseUrl);

  return registry;
}

async function startServer(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake npm registry did not bind to a port");
  }

  return `http://127.0.0.1:${address.port}`;
}

function recordRequest(
  registry: FakeNpmRegistry,
  request: http.IncomingMessage,
): void {
  registry.requests.push({
    url: request.url ?? "",
    ...(request.headers.authorization !== undefined
      ? { authorization: request.headers.authorization }
      : {}),
  });
}

function serveTarball(
  registry: FakeNpmRegistry,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): void {
  const version = Object.keys(registry.versions).find(
    (candidate) => request.url === tarballPath(registry.packageName, candidate),
  );
  if (!version) {
    response.writeHead(404);
    response.end();
    return;
  }

  response.writeHead(200, { "Content-Type": "application/octet-stream" });
  response.end(registry.versions[version]);
}

function publishVersion(
  registry: FakeNpmRegistry,
  version: string,
  files: Record<string, string>,
): void {
  registry.versions[version] = createPackageTarball(files);
  registry.distTags.latest = version;
}

function createPackument(registry: FakeNpmRegistry): object {
  return {
    name: registry.packageName,
    "dist-tags": registry.distTags,
    versions: Object.fromEntries(
      Object.entries(registry.versions).map(([version, tarball]) => [
        version,
        {
          name: registry.packageName,
          version,
          dist: {
            shasum: registry.shasumOverride ?? createPackageShasum(tarball),
            tarball: `${registry.tarballBaseUrl}${tarballPath(registry.packageName, version)}`,
          },
        },
      ]),
    ),
  };
}

function tarballPath(packageName: string, version: string): string {
  return `/${packageName}/-/${packageName.split("/").at(-1)}-${version}.tgz`;
}

function createPackageTarball(files: Record<string, string>): Buffer {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-npm-package-"));
  tempDirs.push(workDir);
  const packageDir = path.join(workDir, "package");

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(packageDir, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  fs.writeFileSync(path.join(packageDir, "package.json"), "{}\n");
  const tarballFile = path.join(workDir, "package.tgz");
  execFileSync("tar", ["-czf", tarballFile, "-C", workDir, "package"]);

  return fs.readFileSync(tarballFile);
}

function createPackageShasum(tarball: Buffer): string {
  return createHash("sha1").update(tarball).digest("hex");
}
