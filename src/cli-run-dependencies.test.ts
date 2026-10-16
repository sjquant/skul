import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { createPromptClientStub } from "./cli.test-stubs";
import {
  createHomeDir,
  createRemoteBundleSource,
  createRepository,
  runGit,
  updateRemoteBundleSource,
  writeBundleFile,
  writeManifest,
} from "./cli.test-support";
import { run } from "./index";
import { readRegistryFile } from "./registry";

const SHARED_SOURCE = "github.com/acme/shared";
const VAULT_SOURCE = "github.com/user/ai-vault";

/** Publishes `shared` with one skill, `git`, that bundles in the vault can require. */
function createSharedSource(homeDir: string): void {
  createRemoteBundleSource(homeDir, {
    source: SHARED_SOURCE,
    bundle: "shared",
    manifest: {
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    },
    files: {
      ".claude/skills/git/SKILL.md": "# git\n",
      ".claude/skills/unused/SKILL.md": "# unused\n",
    },
  });
}

/** Writes a vault bundle whose deploy skill requires the shared `git` skill. */
function createOpsBundle(homeDir: string, bundle: string): void {
  writeManifest(homeDir, VAULT_SOURCE, bundle, {
    name: bundle,
    requires: {
      [`skills/deploy-${bundle}`]: [
        { source: SHARED_SOURCE, item: "skills/git" },
      ],
    },
    tools: { "claude-code": { skills: { path: ".claude/skills" } } },
  });
  writeBundleFile(
    homeDir,
    VAULT_SOURCE,
    bundle,
    `.claude/skills/deploy-${bundle}/SKILL.md`,
    `# deploy ${bundle}\n`,
  );
}

/** Like `createOpsBundle`, with the requirement pinned to `ref`. */
function createOpsBundleRequiringRef(
  homeDir: string,
  bundle: string,
  ref: string,
): void {
  writeManifest(homeDir, VAULT_SOURCE, bundle, {
    name: bundle,
    requires: {
      [`skills/deploy-${bundle}`]: [
        { source: SHARED_SOURCE, item: "skills/git", ref },
      ],
    },
    tools: { "claude-code": { skills: { path: ".claude/skills" } } },
  });
  writeBundleFile(
    homeDir,
    VAULT_SOURCE,
    bundle,
    `.claude/skills/deploy-${bundle}/SKILL.md`,
    `# deploy ${bundle}\n`,
  );
}

describe("run — requirements on other sources", () => {
  it("installs a required item of another source once and removes it with its last requirer", async () => {
    // Given: two bundles whose skills both require the shared git skill
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    createSharedSource(homeDir);
    for (const bundle of ["ops-a", "ops-b"]) {
      writeManifest(homeDir, VAULT_SOURCE, bundle, {
        name: bundle,
        requires: {
          [`skills/deploy-${bundle}`]: [
            { source: SHARED_SOURCE, item: "skills/git" },
          ],
        },
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
      });
      writeBundleFile(
        homeDir,
        VAULT_SOURCE,
        bundle,
        `.claude/skills/deploy-${bundle}/SKILL.md`,
        `# deploy ${bundle}\n`,
      );
    }
    const options = {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    };
    const gitSkill = path.join(repoRoot, ".claude/skills/git/SKILL.md");

    // When: the first bundle is added
    const output = await run(["add", "ops-a"], options);

    // Then: the required skill is installed and the output says why
    expect(output).toContain(
      `Installed dependency shared [${SHARED_SOURCE}] (required by ops-a@${VAULT_SOURCE})`,
    );
    expect(fs.readFileSync(gitSkill, "utf8")).toBe("# git\n");

    // And only the required item, not the rest of the dependency's bundle
    expect(
      fs.existsSync(path.join(repoRoot, ".claude/skills/unused/SKILL.md")),
    ).toBe(false);

    // And the registry records it as an implicit entry naming its requirer
    const registryFile = path.join(homeDir, ".skul", "registry.json");
    const desired = Object.values(readRegistryFile(registryFile).repos)[0]!
      .desired_state;
    expect(desired.find((entry) => entry.bundle === "shared")).toMatchObject({
      source: SHARED_SOURCE,
      implicit: true,
      required_by: [`ops-a@${VAULT_SOURCE}`],
      required_items: ["skills/git"],
    });

    // When: a second bundle needing the same skill is added and the first removed
    await run(["add", "ops-b"], options);
    await run(["remove", "ops-a", "-y"], options);

    // Then: the skill stays for the remaining requirer
    expect(fs.existsSync(gitSkill)).toBe(true);

    // When: the last requirer is removed
    const removal = await run(["remove", "ops-b", "-y"], options);

    // Then: the skill goes with it
    expect(removal).toContain(`Removed dependency shared [${SHARED_SOURCE}]`);
    expect(fs.existsSync(gitSkill)).toBe(false);
    expect(
      Object.values(readRegistryFile(registryFile).repos)[0]!.desired_state,
    ).toEqual([]);
  });

  it("refuses to remove a bundle that is installed only because another bundle requires it", async () => {
    // Given: a bundle installed together with its dependency
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    createSharedSource(homeDir);
    createOpsBundle(homeDir, "ops");
    const options = {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    };
    await run(["add", "ops"], options);

    // When / Then: removing the dependency directly is rejected, and it stays
    await expect(
      run(["remove", SHARED_SOURCE, "shared", "-y"], options),
    ).rejects.toThrow(
      `shared is installed because ops@${VAULT_SOURCE} requires it`,
    );
    expect(
      fs.existsSync(path.join(repoRoot, ".claude/skills/git/SKILL.md")),
    ).toBe(true);
  });

  it("keeps the requiring bundle installed when fetching a new source is declined", async () => {
    // Given: a bundle that requires an item from a source nothing was installed from
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    createSharedSource(homeDir);
    createOpsBundle(homeDir, "ops");

    // When: the user declines the new source
    await expect(
      run(["add", "ops"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({
          confirmDependencySources: async () => false,
        }),
      }),
    ).rejects.toThrow(`Dependency installation declined for: ${SHARED_SOURCE}`);

    // Then: the bundle itself is installed, and the dependency is not
    expect(
      fs.existsSync(path.join(repoRoot, ".claude/skills/deploy-ops/SKILL.md")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(repoRoot, ".claude/skills/git/SKILL.md")),
    ).toBe(false);
  });

  it("installs a requirement globally when the requiring bundle is installed globally, and shows who requires it", async () => {
    // Given: a bundle requiring a shared skill
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    createSharedSource(homeDir);
    createOpsBundle(homeDir, "ops");
    const options = {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    };

    // When: the bundle is installed globally
    await run(["add", "ops", "--global"], options);

    // Then: the skill lands in the global tool directory, not the project
    expect(
      fs.existsSync(path.join(homeDir, ".claude/skills/git/SKILL.md")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(repoRoot, ".claude/skills/git/SKILL.md")),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(homeDir, ".claude/skills/unused/SKILL.md")),
    ).toBe(false);

    // And status names the requirer
    await expect(run(["status", "--global"], options)).resolves.toContain(
      `shared (required by ops@${VAULT_SOURCE})`,
    );

    // When: the requirer is removed globally, the dependency goes too
    await run(["remove", "ops", "--global", "-y"], options);
    expect(
      fs.existsSync(path.join(homeDir, ".claude/skills/git/SKILL.md")),
    ).toBe(false);
  });

  it("needs --allow-new-sources, not --yes, to fetch a source the user never named in headless mode", async () => {
    // Given: a bundle requiring a source nothing was installed from, and no terminal
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    createSharedSource(homeDir);
    createOpsBundle(homeDir, "ops");
    process.env["SKUL_NO_TUI"] = "1";
    const gitSkill = path.join(repoRoot, ".claude/skills/git/SKILL.md");

    try {
      // When / Then: the dependency step fails and names the flag that allows it
      await expect(
        run(["add", "ops", "--agent", "claude-code"], {
          homeDir,
          cwd: repoRoot,
        }),
      ).rejects.toThrow(`headless mode): ${SHARED_SOURCE}`);

      // And --yes, which approves overwrites and removals, does not allow it
      await expect(
        run(["add", "ops", "--agent", "claude-code", "--yes"], {
          homeDir,
          cwd: repoRoot,
        }),
      ).rejects.toThrow("--allow-new-sources");
      expect(fs.existsSync(gitSkill)).toBe(false);

      // And --allow-new-sources installs it and says which source it allowed
      const output = await run(
        ["add", "ops", "--agent", "claude-code", "--allow-new-sources"],
        { homeDir, cwd: repoRoot },
      );
      expect(output).toContain(
        `Allowed new dependency sources: ${SHARED_SOURCE}`,
      );
      expect(fs.existsSync(gitSkill)).toBe(true);
    } finally {
      delete process.env["SKUL_NO_TUI"];
    }
  });

  it("installs a requirement pinned to a ref and records the ref", async () => {
    // Given: a bundle requiring a shared skill at an existing ref
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    createSharedSource(homeDir);
    createOpsBundleRequiringRef(homeDir, "ops", "main");
    const options = {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    };

    // When
    await run(["add", "ops"], options);

    // Then: the skill is installed from that ref and the entry keeps it
    expect(
      fs.existsSync(path.join(repoRoot, ".claude/skills/git/SKILL.md")),
    ).toBe(true);
    const desired = Object.values(
      readRegistryFile(path.join(homeDir, ".skul", "registry.json")).repos,
    )[0]!.desired_state;
    expect(desired.find((entry) => entry.bundle === "shared")).toMatchObject({
      ref: "main",
      resolved_commit: expect.any(String),
    });
  });

  it("reports two bundles that need different refs of one source without fetching either", async () => {
    // Given: ops-a is installed with the shared source pinned to main
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    createSharedSource(homeDir);
    createOpsBundleRequiringRef(homeDir, "ops-a", "main");
    createOpsBundleRequiringRef(homeDir, "ops-b", "release");
    const options = {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    };
    await run(["add", "ops-a"], options);

    // When / Then: a second bundle pinning another ref is reported as a
    // conflict, not as a missing ref, so that ref was never fetched
    await expect(run(["add", "ops-b"], options)).rejects.toThrow(
      `Cannot install ${SHARED_SOURCE}: ops-a@${VAULT_SOURCE} needs ref main but ops-b@${VAULT_SOURCE} needs ref release`,
    );
  });

  it("installs a requirement that a bundle starts declaring in an update", async () => {
    // Given: a vault bundle installed from a remote source, with no requirements
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    createSharedSource(homeDir);
    const vault = createRemoteBundleSource(homeDir, {
      source: "github.com/acme/vault",
      bundle: "ops",
      manifest: {
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
      },
      files: { ".claude/skills/deploy/SKILL.md": "# deploy\n" },
    });
    const options = {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    };
    await run(["add", vault.source, "ops"], options);
    const gitSkill = path.join(repoRoot, ".claude/skills/git/SKILL.md");
    expect(fs.existsSync(gitSkill)).toBe(false);

    // When: upstream declares a requirement and the user updates
    updateRemoteBundleSource(vault.remoteRepoPath, "ops", {
      "manifest.json": JSON.stringify({
        requires: {
          "skills/deploy": [{ source: SHARED_SOURCE, item: "skills/git" }],
        },
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
      }),
    });
    const output = await run(["update"], options);

    // Then: the new requirement is installed
    expect(output).toContain(`Installed dependency shared [${SHARED_SOURCE}]`);
    expect(fs.existsSync(gitSkill)).toBe(true);
  });

  it("installs what a dependency requires in turn", async () => {
    // Given: ops requires shared's git skill, which requires a lint skill elsewhere
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    createRemoteBundleSource(homeDir, {
      source: "github.com/acme/lint",
      bundle: "lint",
      manifest: {
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
      },
      files: { ".claude/skills/gitlint/SKILL.md": "# gitlint\n" },
    });
    createRemoteBundleSource(homeDir, {
      source: SHARED_SOURCE,
      bundle: "shared",
      manifest: {
        requires: {
          "skills/git": [
            { source: "github.com/acme/lint", item: "skills/gitlint" },
          ],
        },
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
      },
      files: { ".claude/skills/git/SKILL.md": "# git\n" },
    });
    createOpsBundle(homeDir, "ops");

    // When
    await run(["add", "ops"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // Then: both levels are installed
    for (const skill of ["git", "gitlint"]) {
      expect(
        fs.existsSync(path.join(repoRoot, ".claude/skills", skill, "SKILL.md")),
      ).toBe(true);
    }
  });

  it("warns and installs nothing when a dependency supports none of the requirer's tools", async () => {
    // Given: a dependency that only supports codex, required by a bundle installed for claude-code
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    createRemoteBundleSource(homeDir, {
      source: SHARED_SOURCE,
      bundle: "shared",
      manifest: { tools: { codex: { skills: { path: ".agents/skills" } } } },
      files: { ".agents/skills/git/SKILL.md": "# git\n" },
    });
    createOpsBundle(homeDir, "ops");

    // When
    const output = await run(["add", "ops", "--agent", "claude-code"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // Then: the requirer is installed, and the output says why the dependency is not
    expect(output).toContain(
      `Skipping dependency shared [${SHARED_SOURCE}]: it supports none of claude-code`,
    );
    expect(
      fs.existsSync(path.join(repoRoot, ".agents/skills/git/SKILL.md")),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(repoRoot, ".claude/skills/deploy-ops/SKILL.md")),
    ).toBe(true);
  });

  it("refuses a global add that would overwrite a file another global bundle manages", async () => {
    // Given: two vault bundles shipping the same skill path, the first installed globally
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    for (const bundle of ["first", "second"]) {
      writeManifest(homeDir, VAULT_SOURCE, bundle, {
        name: bundle,
        tools: { "claude-code": { skills: { path: ".claude/skills" } } },
      });
      writeBundleFile(
        homeDir,
        VAULT_SOURCE,
        bundle,
        ".claude/skills/notes/SKILL.md",
        `# ${bundle}\n`,
      );
    }
    const options = {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    };
    await run(["add", "first", "--global"], options);

    // When / Then: the second is refused and the first's file is untouched
    await expect(run(["add", "second", "--global"], options)).rejects.toThrow(
      "Cannot write .claude/skills/notes/SKILL.md for second because it is already managed by first",
    );
    expect(
      fs.readFileSync(
        path.join(homeDir, ".claude/skills/notes/SKILL.md"),
        "utf8",
      ),
    ).toBe("# first\n");
  });

  it("refuses an update that makes a bundle ship a file another bundle manages", async () => {
    // Given: two bundles installed from separate remote sources
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const manifest = {
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    };
    const first = createRemoteBundleSource(homeDir, {
      source: "github.com/acme/first",
      bundle: "first",
      manifest,
      files: { ".claude/skills/notes/SKILL.md": "# first\n" },
    });
    const second = createRemoteBundleSource(homeDir, {
      source: "github.com/acme/second",
      bundle: "second",
      manifest,
      files: { ".claude/skills/other/SKILL.md": "# other\n" },
    });
    const options = {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    };
    await run(["add", first.source, "first"], options);
    await run(["add", second.source, "second"], options);

    // When: the second bundle starts shipping the first's path upstream
    updateRemoteBundleSource(second.remoteRepoPath, "second", {
      ".claude/skills/notes/SKILL.md": "# second\n",
    });

    // Then: updating it is refused and the first bundle's file stays
    await expect(run(["update", "second"], options)).rejects.toThrow(
      "Cannot write .claude/skills/notes/SKILL.md for second because it is already managed by first",
    );
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude/skills/notes/SKILL.md"),
        "utf8",
      ),
    ).toBe("# first\n");
  });
});
