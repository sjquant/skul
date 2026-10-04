import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHomeDir,
  createPromptClientStub,
  createRemoteBundleSource,
  createRepository,
  runGit,
  updateRemoteBundleSource,
  writeBundleFile,
  writeManifest,
} from "./cli.test-support";
import { run } from "./index";

const source = "github.com/getsentry/cli";
const sourcePath = "packages/cli";
const skillPath = "plugins/sentry-cli/skills/sentry-cli";
const initialSkill =
  "---\nname: sentry-cli\ndescription: Sentry CLI\n---\nInitial instructions.\n";

afterEach(() => vi.unstubAllEnvs());

function setup(ref?: string) {
  const homeDir = createHomeDir();
  const repoRoot = createRepository();
  const remote = createRemoteBundleSource(homeDir, {
    source,
    bundle: sourcePath,
    manifest: { tools: {} },
    files: {
      ".claude-plugin/marketplace.json": JSON.stringify({
        plugins: [{ name: "sentry-cli", source: "./plugins/sentry-cli" }],
      }),
      [`${skillPath}/SKILL.md`]: initialSkill,
      [`${skillPath}/references/issues.md`]:
        "# Issues\nRead the issue details.\n",
    },
  });
  const cachedSourceDir = path.join(
    homeDir,
    ".skul",
    "library",
    ...source.split("/"),
  );
  writeManifest(homeDir, "github.com/user/ai-vault", "ghosts", {
    tools: { "claude-code": { skills: { path: "skills" } } },
  });
  const writeRef = (revision?: string) =>
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "ghosts",
      "skul.refs.json",
      JSON.stringify({
        refs: [
          {
            target: "skills",
            name: "sentry",
            source: "getsentry/cli",
            sourcePath,
            bundle: "sentry-cli",
            item: "skills/sentry-cli",
            ...(revision ? { ref: revision } : {}),
          },
        ],
      }),
    );
  writeRef(ref);
  return { homeDir, repoRoot, remote, cachedSourceDir, writeRef };
}

function expectMaterialized(repoRoot: string) {
  const skillDir = path.join(repoRoot, ".claude", "skills", "sentry");
  const skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  expect(skill).toContain("name: sentry");
  expect(skill).toContain("Initial instructions.");
  expect(
    fs.readFileSync(path.join(skillDir, "references", "issues.md"), "utf8"),
  ).toBe("# Issues\nRead the issue details.\n");
}

describe("nested marketplace item refs", () => {
  it("fetches the current nested layout into a cold cache and reuses it", async () => {
    const { homeDir, repoRoot, remote, cachedSourceDir } = setup();
    fs.rmSync(cachedSourceDir, { recursive: true, force: true });
    const gitConfigFile = path.join(homeDir, "gitconfig");
    fs.writeFileSync(
      gitConfigFile,
      `[url "${remote.remoteRepoPath}"]\n\tinsteadOf = https://${source}\n`,
    );
    vi.stubEnv("GIT_CONFIG_GLOBAL", gitConfigFile);

    await run(["add", "ghosts"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    expectMaterialized(repoRoot);
    expect(runGit(cachedSourceDir, ["rev-parse", "HEAD"])).toBe(
      remote.initialCommit,
    );
    // No remote access is needed for a second unpinned install.
    runGit(cachedSourceDir, [
      "remote",
      "set-url",
      "origin",
      path.join(homeDir, "missing-remote"),
    ]);
    const secondRepo = createRepository();
    await run(["add", "ghosts"], {
      homeDir,
      cwd: secondRepo,
      prompts: createPromptClientStub(),
    });
    expectMaterialized(secondRepo);
  });

  it("aligns a nested ref to its pinned commit before copying supporting files", async () => {
    const { homeDir, repoRoot, remote, cachedSourceDir, writeRef } = setup();
    const latestCommit = updateRemoteBundleSource(
      remote.remoteRepoPath,
      sourcePath,
      {
        [`${skillPath}/SKILL.md`]: initialSkill.replace("Initial", "Latest"),
        [`${skillPath}/references/issues.md`]: "Changed reference.\n",
      },
    );
    runGit(cachedSourceDir, ["fetch", "origin", "main"]);
    runGit(cachedSourceDir, ["checkout", latestCommit]);
    writeRef(remote.initialCommit.slice(0, 7));

    await run(["add", "ghosts"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    expectMaterialized(repoRoot);
    expect(runGit(cachedSourceDir, ["rev-parse", "HEAD"])).toBe(
      remote.initialCommit,
    );
  });

  it("rejects symlinked supporting content without leaving materialized files", async () => {
    const { homeDir, repoRoot, cachedSourceDir } = setup();
    const references = path.join(
      cachedSourceDir,
      sourcePath,
      skillPath,
      "references",
    );
    fs.symlinkSync(
      path.join(repoRoot, "README.md"),
      path.join(references, "external.md"),
    );

    await expect(
      run(["add", "ghosts"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).rejects.toThrow(/symlink/i);
    expect(
      fs.existsSync(
        path.join(repoRoot, ".claude", "skills", "sentry", "SKILL.md"),
      ),
    ).toBe(false);
  });
});
