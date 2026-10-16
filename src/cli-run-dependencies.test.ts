import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { createPromptClientStub } from "./cli.test-stubs";
import {
  createHomeDir,
  createRemoteBundleSource,
  createRepository,
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

  it("fails without --yes in headless mode before fetching a source the user never named", async () => {
    // Given: a bundle requiring a source nothing was installed from, and no terminal
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    createSharedSource(homeDir);
    createOpsBundle(homeDir, "ops");
    process.env["SKUL_NO_TUI"] = "1";

    try {
      // When / Then: the dependency step fails and says how to allow it
      await expect(
        run(["add", "ops", "--agent", "claude-code"], {
          homeDir,
          cwd: repoRoot,
        }),
      ).rejects.toThrow(`headless mode): ${SHARED_SOURCE}`);

      // And with --yes the same command installs it
      await run(["add", "ops", "--agent", "claude-code", "--yes"], {
        homeDir,
        cwd: repoRoot,
      });
      expect(
        fs.existsSync(path.join(repoRoot, ".claude/skills/git/SKILL.md")),
      ).toBe(true);
    } finally {
      delete process.env["SKUL_NO_TUI"];
    }
  });

  it("rejects two bundles that need different refs of one source before fetching it", async () => {
    // Given: ops-a pins the shared source to one ref and ops-b to another
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    createSharedSource(homeDir);
    for (const [bundle, ref] of [
      ["ops-a", "v1"],
      ["ops-b", "v2"],
    ] as const) {
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
    const options = {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    };
    await run(["add", "ops-a"], options).catch(() => undefined);

    // When / Then: adding the second reports the conflict instead of picking one
    await expect(run(["add", "ops-b"], options)).rejects.toThrow(
      `Cannot install ${SHARED_SOURCE}`,
    );
  });
});
