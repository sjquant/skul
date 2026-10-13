import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveBundleItemRefs } from "./bundle-item-refs";

const tempDirs: string[] = [];
const NESTED_SOURCE = "github.com/getsentry/cli";
const NESTED_SOURCE_PATH = "packages/cli";
const NESTED_PLUGIN_PATH = `${NESTED_SOURCE_PATH}/plugins/sentry-cli`;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeRefsFile(bundleDir: string, refs: object[]): void {
  writeFile(path.join(bundleDir, "skul.refs.json"), JSON.stringify({ refs }));
}

function writeCachedSkill(options: {
  libraryDir: string;
  source: string;
  bundle: string;
  skillName: string;
  skillsPath?: string;
}): void {
  const skillsPath = options.skillsPath ?? "skills";
  const bundleDir = path.join(
    options.libraryDir,
    ...options.source.split("/"),
    options.bundle,
  );
  writeFile(
    path.join(bundleDir, skillsPath, options.skillName, "SKILL.md"),
    [
      "---",
      `name: ${options.skillName}`,
      "description: An externally referenced skill",
      "---",
      "",
      "Do the thing.",
      "",
    ].join("\n"),
  );
}

function writeCachedAgent(options: {
  libraryDir: string;
  source: string;
  bundle: string;
  agentName: string;
}): void {
  const bundleDir = path.join(
    options.libraryDir,
    ...options.source.split("/"),
    options.bundle,
  );
  writeFile(
    path.join(bundleDir, "agents", `${options.agentName}.md`),
    [
      "---",
      `name: ${options.agentName}`,
      "description: Review changes",
      "---",
      "",
      "Review the diff.",
      "",
    ].join("\n"),
  );
}

function writeCachedCommand(options: {
  libraryDir: string;
  source: string;
  bundle: string;
  commandName: string;
}): void {
  const bundleDir = path.join(
    options.libraryDir,
    ...options.source.split("/"),
    options.bundle,
  );
  writeFile(
    path.join(bundleDir, "commands", `${options.commandName}.md`),
    "Review the diff.\n",
  );
}

function writeCachedRootInstruction(options: {
  libraryDir: string;
  source: string;
  bundle: string;
}): void {
  const bundleDir = path.join(
    options.libraryDir,
    ...options.source.split("/"),
    options.bundle,
  );
  writeFile(path.join(bundleDir, "AGENTS.md"), "Use the shared standards.\n");
}

describe("resolveBundleItemRefs", () => {
  it("returns an empty map when the bundle has no refs file", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");

    // When
    const result = await resolveBundleItemRefs({ bundleDir, libraryDir });

    // Then
    expect(result.size).toBe(0);
  });

  it("requires the refs file root to be an object with refs array", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const objectBundleDir = createTempDir("skul-object-bundle-");
    const arrayBundleDir = createTempDir("skul-array-bundle-");
    writeFile(path.join(objectBundleDir, "skul.refs.json"), "{}");
    writeFile(path.join(arrayBundleDir, "skul.refs.json"), "[]");

    // When / Then
    await expect(
      resolveBundleItemRefs({ bundleDir: objectBundleDir, libraryDir }),
    ).rejects.toThrowError(/must define "refs" as an array/);
    await expect(
      resolveBundleItemRefs({ bundleDir: arrayBundleDir, libraryDir }),
    ).rejects.toThrowError(/root must be an object/);
  });

  it("resolves a skill ref to a single-bundle referenced source by repo slug", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    writeCachedSkill({
      libraryDir,
      source: "github.com/fivetaku/insane-search",
      bundle: "insane-search",
      skillName: "insane-search",
    });
    writeRefsFile(bundleDir, [
      {
        target: "skills",
        name: "insane-search",
        source: "fivetaku/insane-search",
      },
    ]);

    // When
    const result = await resolveBundleItemRefs({ bundleDir, libraryDir });

    // Then
    expect(result.get("skills/insane-search")).toEqual({
      path: path.join(
        libraryDir,
        "github.com",
        "fivetaku",
        "insane-search",
        "insane-search",
        "skills",
        "insane-search",
      ),
    });
  });

  it("resolves a ref with explicit bundle and item alias", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    writeCachedSkill({
      libraryDir,
      source: "github.com/fivetaku/tools",
      bundle: "core",
      skillName: "other-name",
    });
    writeCachedSkill({
      libraryDir,
      source: "github.com/fivetaku/tools",
      bundle: "extra",
      skillName: "unused",
    });
    writeRefsFile(bundleDir, [
      {
        target: "skills",
        name: "search",
        source: "fivetaku/tools",
        bundle: "core",
        item: "skills/other-name",
      },
    ]);

    // When
    const result = await resolveBundleItemRefs({ bundleDir, libraryDir });

    // Then
    expect(result.get("skills/search")).toEqual({
      path: path.join(
        libraryDir,
        "github.com",
        "fivetaku",
        "tools",
        "core",
        "skills",
        "other-name",
      ),
    });
  });

  it("finds a referenced item in a multi-bundle Claude marketplace without an explicit bundle", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    const sourceDir = path.join(libraryDir, "github.com", "getsentry", "cli");
    const canonicalSkillDir = path.join(
      sourceDir,
      "plugins",
      "sentry-cli",
      "skills",
      "sentry-cli",
    );
    writeFile(
      path.join(canonicalSkillDir, "SKILL.md"),
      "---\nname: sentry-cli\ndescription: Sentry CLI\n---\n",
    );
    writeFile(
      path.join(canonicalSkillDir, "references", "issues.md"),
      "# Issues\n",
    );
    writeFile(
      path.join(sourceDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        plugins: [{ name: "sentry-cli", source: "./plugins/sentry-cli" }],
      }),
    );
    fs.mkdirSync(path.join(sourceDir, ".cursor", "skills", "sentry-cli"), {
      recursive: true,
    });
    fs.symlinkSync(
      path.join(canonicalSkillDir, "SKILL.md"),
      path.join(sourceDir, ".cursor", "skills", "sentry-cli", "SKILL.md"),
    );
    fs.symlinkSync(
      path.join(canonicalSkillDir, "references"),
      path.join(sourceDir, ".cursor", "skills", "sentry-cli", "references"),
    );
    writeFile(path.join(sourceDir, "src", "commands", "api.ts"), "");
    writeFile(path.join(sourceDir, "test", "commands", "api.test.ts"), "");
    writeRefsFile(bundleDir, [
      {
        target: "skills",
        name: "sentry-cli",
        source: "getsentry/cli",
      },
    ]);

    // When
    const result = await resolveBundleItemRefs({ bundleDir, libraryDir });

    // Then
    expect(result.get("skills/sentry-cli")).toEqual({
      path: canonicalSkillDir,
    });
  });

  it("falls back to a repo-root item absent from its Claude marketplace plugin", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    const sourceDir = path.join(
      libraryDir,
      "github.com",
      "upstash",
      "context7",
    );
    const canonicalSkillDir = path.join(sourceDir, "skills", "context7-cli");
    writeFile(
      path.join(canonicalSkillDir, "SKILL.md"),
      "---\nname: context7-cli\ndescription: Context7 CLI\n---\n",
    );
    writeFile(
      path.join(
        sourceDir,
        "plugins",
        "claude",
        "context7",
        "commands",
        "context7.md",
      ),
      "# Context7\n",
    );
    writeFile(
      path.join(sourceDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        plugins: [{ name: "context7", source: "./plugins/claude/context7" }],
      }),
    );
    writeRefsFile(bundleDir, [
      {
        target: "skills",
        name: "context7-cli",
        source: "upstash/context7",
      },
    ]);

    // When
    const result = await resolveBundleItemRefs({ bundleDir, libraryDir });

    // Then
    expect(result.get("skills/context7-cli")).toEqual({
      path: canonicalSkillDir,
    });
  });

  it("requires an explicit bundle when multiple bundles contain the referenced item", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    writeCachedSkill({
      libraryDir,
      source: "github.com/fivetaku/tools",
      bundle: "core",
      skillName: "search",
    });
    writeCachedSkill({
      libraryDir,
      source: "github.com/fivetaku/tools",
      bundle: "extra",
      skillName: "search",
    });
    writeRefsFile(bundleDir, [
      {
        target: "skills",
        name: "search",
        source: "fivetaku/tools",
      },
    ]);

    // When / Then
    await expect(
      resolveBundleItemRefs({ bundleDir, libraryDir }),
    ).rejects.toThrowError(
      /multiple bundles containing "skills\/search"; set "bundle"/,
    );
  });

  it("resolves the sole marketplace plugin without an explicit bundle instead of its symlink facade", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    const sourceDir = path.join(libraryDir, "github.com", "acme", "cli");
    const canonicalSkillDir = path.join(
      sourceDir,
      "plugins",
      "sentry-cli",
      "skills",
      "sentry-cli",
    );
    writeFile(
      path.join(canonicalSkillDir, "SKILL.md"),
      "---\nname: sentry-cli\ndescription: Sentry CLI\n---\n",
    );
    writeFile(
      path.join(canonicalSkillDir, "references", "issues.md"),
      "# Issues\n",
    );
    writeFile(
      path.join(sourceDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        plugins: [{ name: "sentry-cli", source: "./plugins/sentry-cli" }],
      }),
    );
    fs.mkdirSync(path.join(sourceDir, ".cursor", "skills", "sentry-cli"), {
      recursive: true,
    });
    fs.symlinkSync(
      path.join(canonicalSkillDir, "SKILL.md"),
      path.join(sourceDir, ".cursor", "skills", "sentry-cli", "SKILL.md"),
    );
    fs.symlinkSync(
      path.join(canonicalSkillDir, "references"),
      path.join(sourceDir, ".cursor", "skills", "sentry-cli", "references"),
    );
    writeRefsFile(bundleDir, [
      {
        target: "skills",
        name: "sentry-cli",
        source: "acme/cli",
      },
    ]);

    // When
    const result = await resolveBundleItemRefs({ bundleDir, libraryDir });

    // Then
    expect(result.get("skills/sentry-cli")).toEqual({
      path: canonicalSkillDir,
    });
  });

  it("resolves skill-only disable-model-invocation metadata from a skill ref", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    writeCachedSkill({
      libraryDir,
      source: "github.com/fivetaku/reviewer",
      bundle: "reviewer",
      skillName: "reviewer",
    });
    writeRefsFile(bundleDir, [
      {
        target: "skills",
        name: "reviewer",
        source: "fivetaku/reviewer",
        description: "Review changes only when requested",
        "disable-model-invocation": true,
      },
    ]);

    // When
    const result = await resolveBundleItemRefs({ bundleDir, libraryDir });

    // Then
    expect(result.get("skills/reviewer")).toEqual({
      path: path.join(
        libraryDir,
        "github.com",
        "fivetaku",
        "reviewer",
        "reviewer",
        "skills",
        "reviewer",
      ),
      description: "Review changes only when requested",
      disableModelInvocation: true,
    });
  });

  it("resolves agent and root instruction refs", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    writeCachedAgent({
      libraryDir,
      source: "github.com/fivetaku/agents",
      bundle: "agents",
      agentName: "reviewer",
    });
    writeCachedRootInstruction({
      libraryDir,
      source: "github.com/fivetaku/standards",
      bundle: "standards",
    });
    writeRefsFile(bundleDir, [
      {
        target: "agents",
        name: "reviewer",
        source: "fivetaku/agents",
        description: "Review pull requests as a subagent",
      },
      {
        target: "root-instruction",
        path: "AGENTS.md",
        source: "fivetaku/standards",
      },
    ]);

    // When
    const result = await resolveBundleItemRefs({
      bundleDir,
      libraryDir,
      manifest: {
        tools: {
          "claude-code": { agents: { path: "agents" } },
          codex: { root_instruction: { path: "AGENTS.md" } },
        },
      },
    });

    // Then
    expect(result.get("agents/reviewer")).toEqual({
      path: path.join(
        libraryDir,
        "github.com",
        "fivetaku",
        "agents",
        "agents",
        "agents",
        "reviewer.md",
      ),
      description: "Review pull requests as a subagent",
    });
    expect(result.get("root-instruction")).toEqual({
      path: path.join(
        libraryDir,
        "github.com",
        "fivetaku",
        "standards",
        "standards",
        "AGENTS.md",
      ),
    });
  });

  it("rejects disable-model-invocation on non-skill bundle item refs", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    writeRefsFile(bundleDir, [
      {
        target: "agents",
        name: "reviewer",
        source: "fivetaku/reviewer",
        "disable-model-invocation": true,
      },
    ]);

    // When / Then
    await expect(
      resolveBundleItemRefs({
        bundleDir,
        libraryDir,
        manifest: { tools: { "claude-code": { agents: { path: "agents" } } } },
      }),
    ).rejects.toThrowError(/skill-only option "disable-model-invocation"/);
  });

  it("allows descriptions on command refs and preserves root instruction refs", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const commandBundleDir = createTempDir("skul-command-bundle-");
    const rootBundleDir = createTempDir("skul-root-bundle-");
    writeCachedCommand({
      libraryDir,
      source: "github.com/fivetaku/commands",
      bundle: "commands",
      commandName: "review",
    });
    writeCachedRootInstruction({
      libraryDir,
      source: "github.com/fivetaku/standards",
      bundle: "standards",
    });
    writeRefsFile(commandBundleDir, [
      {
        target: "commands",
        name: "review",
        source: "fivetaku/commands",
        description: "Review changes",
      },
    ]);
    writeRefsFile(rootBundleDir, [
      {
        target: "root-instruction",
        source: "fivetaku/standards",
        description: "Repository standards",
      },
    ]);

    // When
    const commandResult = await resolveBundleItemRefs({
      bundleDir: commandBundleDir,
      libraryDir,
    });
    const rootResult = await resolveBundleItemRefs({
      bundleDir: rootBundleDir,
      libraryDir,
    });

    // Then
    expect(commandResult.get("commands/review")).toMatchObject({
      description: "Review changes",
    });
    expect(rootResult.get("root-instruction")).toMatchObject({
      description: "Repository standards",
    });
  });

  it("rejects multiline descriptions before rendering frontmatter", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    writeRefsFile(bundleDir, [
      {
        target: "skills",
        name: "reviewer",
        source: "fivetaku/reviewer",
        description: "Review\nchanges",
      },
    ]);

    // When / Then
    await expect(
      resolveBundleItemRefs({ bundleDir, libraryDir }),
    ).rejects.toThrowError(/description.*single line/);
  });

  it("ignores unselected refs without fetching them", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    writeCachedSkill({
      libraryDir,
      source: "github.com/fivetaku/insane-search",
      bundle: "insane-search",
      skillName: "insane-search",
    });
    writeRefsFile(bundleDir, [
      {
        target: "skills",
        name: "insane-search",
        source: "fivetaku/insane-search",
      },
      {
        target: "skills",
        name: "broken",
        source: "fivetaku/missing",
      },
    ]);

    // When
    const result = await resolveBundleItemRefs({
      bundleDir,
      libraryDir,
      manifest: { tools: { "claude-code": { skills: { path: "skills" } } } },
      itemSelectors: ["skills/insane-search"],
    });

    // Then
    expect(result.size).toBe(1);
    expect(result.has("skills/insane-search")).toBe(true);
  });

  it("ignores refs when no selected tool materializes their target", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    writeRefsFile(bundleDir, [
      { target: "skills", name: "broken", source: "fivetaku/missing" },
    ]);

    // When
    const result = await resolveBundleItemRefs({
      bundleDir,
      libraryDir,
      manifest: {
        tools: { codex: { root_instruction: { path: "AGENTS.md" } } },
      },
      tools: ["codex"],
    });

    // Then
    expect(result.size).toBe(0);
  });

  it("rejects duplicate local identities", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    writeRefsFile(bundleDir, [
      { target: "skills", name: "search", source: "fivetaku/search" },
      { target: "skills", name: "search", source: "fivetaku/other" },
    ]);

    // When / Then
    await expect(
      resolveBundleItemRefs({ bundleDir, libraryDir }),
    ).rejects.toThrowError(/Duplicate bundle item ref local identity/);
  });

  it("rejects refs that conflict with local bundle items", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, "skills", "search", "SKILL.md"),
      "---\nname: search\ndescription: Search\n---\n",
    );
    writeRefsFile(bundleDir, [
      { target: "skills", name: "search", source: "fivetaku/search" },
    ]);

    // When / Then
    await expect(
      resolveBundleItemRefs({ bundleDir, libraryDir }),
    ).rejects.toThrowError(/conflicts with a local bundle item/);
  });

  it("rejects refs that conflict with native local bundle items", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    writeFile(
      path.join(bundleDir, ".claude", "skills", "search", "SKILL.md"),
      "---\nname: search\ndescription: Search\n---\n",
    );
    writeRefsFile(bundleDir, [
      { target: "skills", name: "search", source: "fivetaku/search" },
    ]);

    // When / Then
    await expect(
      resolveBundleItemRefs({
        bundleDir,
        libraryDir,
        manifest: {
          tools: { "claude-code": { skills: { path: ".claude/skills" } } },
        },
      }),
    ).rejects.toThrowError(/conflicts with a local bundle item/);
  });

  it("throws when source is missing or pin is set", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const missingSourceBundleDir = createTempDir("skul-missing-source-");
    const pinBundleDir = createTempDir("skul-pin-");
    writeRefsFile(missingSourceBundleDir, [
      { target: "skills", name: "search" },
    ]);
    writeRefsFile(pinBundleDir, [
      {
        target: "skills",
        name: "search",
        source: "fivetaku/search",
        pin: "abc1234",
      },
    ]);

    // When / Then
    await expect(
      resolveBundleItemRefs({ bundleDir: missingSourceBundleDir, libraryDir }),
    ).rejects.toThrowError(/"source" is required/);
    await expect(
      resolveBundleItemRefs({ bundleDir: pinBundleDir, libraryDir }),
    ).rejects.toThrowError(/"pin" is not supported; use "ref" instead/);
  });

  it("rejects unsafe local names and root paths", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const badNameBundleDir = createTempDir("skul-bad-name-");
    const badPathBundleDir = createTempDir("skul-bad-path-");
    writeRefsFile(badNameBundleDir, [
      { target: "skills", name: "../search", source: "fivetaku/search" },
    ]);
    writeRefsFile(badPathBundleDir, [
      {
        target: "root-instruction",
        path: "../AGENTS.md",
        source: "fivetaku/standards",
      },
    ]);

    // When / Then
    await expect(
      resolveBundleItemRefs({ bundleDir: badNameBundleDir, libraryDir }),
    ).rejects.toThrowError(/must be a top-level skills item name/);
    await expect(
      resolveBundleItemRefs({ bundleDir: badPathBundleDir, libraryDir }),
    ).rejects.toThrowError(/must be a safe bundle-relative path/);
  });

  it("rejects unsafe external items and local target mismatches", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const emptyItemBundleDir = createTempDir("skul-empty-item-");
    const mismatchBundleDir = createTempDir("skul-mismatch-item-");
    writeRefsFile(emptyItemBundleDir, [
      {
        target: "skills",
        name: "search",
        source: "fivetaku/search",
        item: "skills/.md",
      },
    ]);
    writeRefsFile(mismatchBundleDir, [
      {
        target: "commands",
        name: "review",
        source: "fivetaku/search",
        item: "skills/search",
      },
    ]);

    // When / Then
    await expect(
      resolveBundleItemRefs({ bundleDir: emptyItemBundleDir, libraryDir }),
    ).rejects.toThrowError(/must target one top-level item/);
    await expect(
      resolveBundleItemRefs({ bundleDir: mismatchBundleDir, libraryDir }),
    ).rejects.toThrowError(/must match local target commands/);
  });

  it("throws when the referenced bundle item does not exist in the source bundle", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    writeCachedSkill({
      libraryDir,
      source: "github.com/fivetaku/insane-search",
      bundle: "insane-search",
      skillName: "insane-search",
    });
    writeRefsFile(bundleDir, [
      {
        target: "skills",
        name: "missing",
        source: "fivetaku/insane-search",
        item: "skills/does-not-exist",
      },
    ]);

    // When / Then
    await expect(
      resolveBundleItemRefs({ bundleDir, libraryDir }),
    ).rejects.toThrowError(
      /Referenced bundle item "skills\/does-not-exist" not found/,
    );
  });

  it("does not chain through a second-level bundle item ref", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    const referencedBundleDir = path.join(
      libraryDir,
      "github.com",
      "fivetaku",
      "insane-search",
      "insane-search",
    );
    writeFile(
      path.join(referencedBundleDir, "manifest.json"),
      JSON.stringify({
        tools: { "claude-code": { skills: { path: "skills" } } },
      }),
    );
    writeRefsFile(referencedBundleDir, [
      { target: "skills", name: "insane-search", source: "elsewhere/other" },
    ]);
    writeRefsFile(bundleDir, [
      {
        target: "skills",
        name: "insane-search",
        source: "fivetaku/insane-search",
      },
    ]);

    // When / Then
    await expect(
      resolveBundleItemRefs({ bundleDir, libraryDir }),
    ).rejects.toThrowError(
      /Referenced bundle item "skills\/insane-search" not found/,
    );
  });

  it("rejects a referenced skill item root that is a symlink", async () => {
    // Given
    const libraryDir = createTempDir("skul-library-");
    const bundleDir = createTempDir("skul-bundle-");
    writeCachedSkill({
      libraryDir,
      source: "github.com/fivetaku/insane-search",
      bundle: "insane-search",
      skillName: "real-skill",
    });
    const skillsDir = path.join(
      libraryDir,
      "github.com",
      "fivetaku",
      "insane-search",
      "insane-search",
      "skills",
    );
    fs.symlinkSync(
      path.join(skillsDir, "real-skill"),
      path.join(skillsDir, "linked-skill"),
    );
    writeRefsFile(bundleDir, [
      {
        target: "skills",
        name: "linked",
        source: "fivetaku/insane-search",
        item: "skills/linked-skill",
      },
    ]);

    // When / Then
    await expect(
      resolveBundleItemRefs({ bundleDir, libraryDir }),
    ).rejects.toThrowError(
      /Referenced bundle item "skills\/linked-skill" not found/,
    );
  });
});

describe("nested bundle item refs", () => {
  it.each([
    undefined,
    "sentry-cli",
  ])("resolves a nested marketplace plugin with bundle %s and preserves supporting files", async (bundle) => {
    // Given
    const fixture = createNestedFixture();
    fixture.writeRefs({ bundle });

    // When
    const resolved = await fixture.resolve();

    // Then
    expect(resolved.get("skills/sentry")?.path).toBe(fixture.skillDir);
    expect(
      fs.readFileSync(
        path.join(fixture.skillDir, "references", "issues.md"),
        "utf8",
      ),
    ).toBe("Find issues.\n");
    expect((await fixture.resolve()).get("skills/sentry")?.path).toBe(
      fixture.skillDir,
    );
  });

  it.each([
    undefined,
    "sentry-cli",
  ])("resolves a direct nested bundle with bundle %s", async (bundle) => {
    // Given
    const fixture = createNestedFixture();
    fixture.writeRefs({ sourcePath: NESTED_PLUGIN_PATH, bundle });

    // When
    const resolved = await fixture.resolve();

    // Then
    expect(resolved.get("skills/sentry")?.path).toBe(fixture.skillDir);
  });

  it.each([
    { target: "agents", item: "agents/reviewer", file: "agents/reviewer.md" },
    { target: "commands", item: "commands/review", file: "commands/review.md" },
    { target: "root-instruction", item: "root-instruction", file: "AGENTS.md" },
  ])("resolves nested $target refs", async ({ target, item, file }) => {
    // Given
    const fixture = createNestedFixture();
    const itemPath = path.join(fixture.pluginDir, file);
    writeFile(itemPath, "Shared instructions.\n");
    fixture.writeRefs({
      target,
      name: target === "root-instruction" ? undefined : "shared",
      path: target === "root-instruction" ? "AGENTS.md" : undefined,
      item,
      bundle: "sentry-cli",
    });
    const selector =
      target === "root-instruction" ? target : `${target}/shared`;

    // When
    const resolved = await fixture.resolve();

    // Then
    expect(resolved.get(selector)?.path).toBe(itemPath);
  });

  it("uses explicit target paths from the nested bundle manifest", async () => {
    // Given
    const fixture = createNestedFixture();
    const customSkillDir = path.join(fixture.pluginDir, "custom", "sentry-cli");
    writeFile(path.join(customSkillDir, "SKILL.md"), "Custom skill.\n");
    writeFile(
      path.join(fixture.pluginDir, "manifest.json"),
      JSON.stringify({
        tools: { "claude-code": { skills: { path: "custom" } } },
      }),
    );

    // When
    const resolved = await fixture.resolve();

    // Then
    expect(resolved.get("skills/sentry")?.path).toBe(customSkillDir);
  });

  it("allows a marketplace plugin source to reach a sibling inside its repository", async () => {
    // Given
    const fixture = createNestedFixture();
    fixture.writeMarketplace([{ name: "sentry-cli", source: "../shared" }]);
    const skillDir = path.join(
      fixture.repositoryDir,
      "packages/shared/skills/sentry-cli",
    );
    writeFile(path.join(skillDir, "SKILL.md"), "Shared skill.\n");

    // When
    const resolved = await fixture.resolve();

    // Then
    expect(resolved.get("skills/sentry")?.path).toBe(skillDir);
  });

  it("requires bundle when two nested plugins contain the selected item", async () => {
    // Given
    const fixture = createNestedFixture();
    const otherDir = path.join(fixture.sourceDir, "plugins", "other");
    writeFile(
      path.join(otherDir, "skills", "sentry-cli", "SKILL.md"),
      "Other.\n",
    );
    fixture.writeMarketplace([
      { name: "sentry-cli", source: "./plugins/sentry-cli" },
      { name: "other", source: "./plugins/other" },
    ]);

    // When / Then: an unqualified ref is ambiguous
    await expect(fixture.resolve()).rejects.toThrow(
      /multiple bundles.*set "bundle"/,
    );

    // When / Then: naming the bundle selects its item
    fixture.writeRefs({ bundle: "sentry-cli" });
    expect((await fixture.resolve()).get("skills/sentry")?.path).toBe(
      fixture.skillDir,
    );
  });

  it.each([
    undefined,
    "sentry-cli",
  ])("rejects duplicate marketplace names with bundle %s", async (bundle) => {
    // Given
    const fixture = createNestedFixture();
    fixture.writeMarketplace([
      { name: "sentry-cli", source: "./plugins/sentry-cli" },
      { name: "sentry-cli", source: "./plugins/sentry-cli" },
    ]);
    fixture.writeRefs({ bundle });

    // When
    const resolving = fixture.resolve();

    // Then
    await expect(resolving).rejects.toThrow(/ambiguous plugin name/);
  });

  it("does not fall back to a repository-root item outside sourcePath", async () => {
    // Given
    const fixture = createNestedFixture();
    writeFile(
      path.join(fixture.repositoryDir, "skills/root-only/SKILL.md"),
      "Root only.\n",
    );
    fixture.writeRefs({ item: "skills/root-only" });

    // When
    const resolving = fixture.resolve();

    // Then
    await expect(resolving).rejects.toThrow(
      /Referenced bundle item "skills\/root-only" not found.*at sourcePath "packages\/cli"/,
    );
  });

  it("reports an unknown bundle in the selected sourcePath", async () => {
    // Given
    const fixture = createNestedFixture();
    fixture.writeRefs({ bundle: "missing-plugin" });

    // When
    const resolving = fixture.resolve();

    // Then
    await expect(resolving).rejects.toThrow(
      /No bundle "missing-plugin".*sourcePath "packages\/cli"/,
    );
  });

  it("does not select a direct bundle with a different name", async () => {
    // Given
    const fixture = createNestedFixture();
    fixture.writeRefs({
      sourcePath: NESTED_PLUGIN_PATH,
      bundle: "missing-plugin",
    });

    // When
    const resolving = fixture.resolve();

    // Then
    await expect(resolving).rejects.toThrow(/No bundle "missing-plugin"/);
  });

  it.each([
    NESTED_SOURCE_PATH,
    NESTED_PLUGIN_PATH,
  ])("identifies a malformed selected manifest at %s", async (sourcePath) => {
    // Given
    const fixture = createNestedFixture();
    fixture.writeRefs({ sourcePath });
    const manifestFile = path.join(fixture.pluginDir, "manifest.json");
    writeFile(manifestFile, "{broken");

    // When
    const resolving = fixture.resolve();

    // Then
    await expect(resolving).rejects.toThrow(
      `Invalid bundle manifest ${manifestFile}`,
    );
  });

  it.each([
    "",
    " ",
    null,
    1,
    "/tmp/plugin",
    "C:/plugins/example",
    "C:plugins/example",
    "\\\\server\\plugins",
    "packages\\cli",
    ".",
    "..",
    "./packages/cli",
    "packages/../cli",
    "packages//cli",
    "packages/cli/",
    "packages/cli\0",
  ])("rejects unsafe sourcePath %j", async (sourcePath) => {
    // Given
    const fixture = createNestedFixture();
    fixture.writeRefs({ sourcePath });

    // When
    const resolving = fixture.resolve();

    // Then
    await expect(resolving).rejects.toThrow(/"sourcePath"/);
  });

  it.each([
    "packages/missing",
    `${NESTED_PLUGIN_PATH}/skills/sentry-cli/SKILL.md`,
    `${NESTED_PLUGIN_PATH}/skills/sentry-cli/SKILL.md/nested`,
  ])("rejects a nonexistent or file-valued sourcePath %s", async (sourcePath) => {
    // Given
    const fixture = createNestedFixture();
    fixture.writeRefs({ sourcePath });

    // When
    const resolving = fixture.resolve();

    // Then
    await expect(resolving).rejects.toThrow(
      /sourcePath must be an existing directory/,
    );
  });

  it.each([
    "../../../../outside",
    "/tmp/plugin",
    "C:/plugins/example",
    "C:plugins/example",
    "plugins\\sentry-cli",
    "plugins/sentry-cli\0",
    "https://example.com/plugin.git",
    "",
  ])("rejects unsafe selected marketplace source %j", async (source) => {
    // Given
    const fixture = createNestedFixture();
    fixture.writeMarketplace([{ name: "sentry-cli", source }]);
    fixture.writeRefs({ bundle: "sentry-cli" });

    // When
    const resolving = fixture.resolve();

    // Then
    await expect(resolving).rejects.toThrow(
      /repository-relative directory|within the fetched repository/,
    );
  });

  it.each([
    "./missing",
    "./plugins/sentry-cli/skills/sentry-cli/SKILL.md",
    "./plugins/sentry-cli/skills/sentry-cli/SKILL.md/nested",
  ])("rejects a missing or file-valued marketplace source %s", async (source) => {
    // Given
    const fixture = createNestedFixture();
    fixture.writeMarketplace([{ name: "sentry-cli", source }]);

    // When
    const resolving = fixture.resolve();

    // Then
    await expect(resolving).rejects.toThrow(
      /Marketplace plugin source must be an existing directory/,
    );
  });

  it.each([
    "{",
    "null",
    "[]",
    "{}",
    '{"plugins":{}}',
  ])("reports invalid nested marketplace %s", async (content) => {
    // Given
    const fixture = createNestedFixture();
    writeFile(fixture.marketplaceFile, content);

    // When
    const resolving = fixture.resolve();

    // Then
    await expect(resolving).rejects.toThrow(/Invalid Claude marketplace/);
  });

  it("reports a malformed plugin entry when no bundle is selected", async () => {
    // Given
    const fixture = createNestedFixture();
    fixture.writeMarketplace([
      null,
      { name: "sentry-cli", source: "./plugins/sentry-cli" },
    ]);

    // When
    const resolving = fixture.resolve();

    // Then
    await expect(resolving).rejects.toThrow(/each plugin must be an object/);
  });

  it.each([
    undefined,
    "sentry-cli",
  ])("ignores unrelated remote marketplace plugins with bundle %s", async (bundle) => {
    // Given
    const fixture = createNestedFixture();
    fixture.writeMarketplace([
      { name: "remote", source: { source: "github", repo: "example/plugin" } },
      { name: "sentry-cli", source: "./plugins/sentry-cli" },
    ]);
    fixture.writeRefs({ bundle });

    // When
    const resolved = await fixture.resolve();

    // Then
    expect(resolved.get("skills/sentry")?.path).toBe(fixture.skillDir);
  });

  it.each([
    {
      label: "unsafe local plugin",
      entry: {
        name: "unsafe-unselected",
        source: "../../../../outside",
      },
    },
    { label: "malformed plugin entry", entry: null },
  ])("does not validate an unrelated $label when bundle is explicit", async ({
    entry,
  }) => {
    // Given
    const fixture = createNestedFixture();
    fixture.writeMarketplace([
      entry,
      { name: "sentry-cli", source: "./plugins/sentry-cli" },
    ]);
    fixture.writeRefs({ bundle: "sentry-cli" });

    // When
    const resolved = await fixture.resolve();

    // Then
    expect(resolved.get("skills/sentry")?.path).toBe(fixture.skillDir);
  });

  it.each([
    { label: "sourcePath ancestor", entry: "packages" },
    { label: "plugin ancestor", entry: `${NESTED_SOURCE_PATH}/plugins` },
    { label: "item ancestor", entry: `${NESTED_PLUGIN_PATH}/skills` },
    {
      label: "marketplace parent",
      entry: `${NESTED_SOURCE_PATH}/.claude-plugin`,
    },
  ])("rejects a symlink in the $label", async ({ entry }) => {
    // Given: the entry is moved outside the repository and linked back in
    const fixture = createNestedFixture();
    const link = path.join(fixture.repositoryDir, entry);
    const externalDir = path.join(fixture.root, "outside");
    fs.renameSync(link, externalDir);
    fs.symlinkSync(externalDir, link, "dir");

    // When
    const resolving = fixture.resolve();

    // Then
    await expect(resolving).rejects.toThrow(/must not contain a symlink/);
  });

  it("rejects a symlinked item ancestor for a ref without sourcePath", async () => {
    // Given: a repository-root skills directory linked to content outside it
    const fixture = createNestedFixture();
    const externalDir = path.join(fixture.root, "outside");
    writeFile(
      path.join(externalDir, "root-only", "SKILL.md"),
      "---\nname: root-only\ndescription: Root only\n---\nOutside.\n",
    );
    fs.symlinkSync(
      externalDir,
      path.join(fixture.repositoryDir, "skills"),
      "dir",
    );
    fixture.writeRefs({ sourcePath: undefined, item: "skills/root-only" });

    // When
    const resolving = fixture.resolve();

    // Then
    await expect(resolving).rejects.toThrow(/must not contain a symlink/);
  });

  it.each([
    {
      label: "marketplace manifest",
      entry: `${NESTED_SOURCE_PATH}/.claude-plugin/marketplace.json`,
      content: "{}",
    },
    {
      label: "bundle manifest",
      entry: `${NESTED_PLUGIN_PATH}/manifest.json`,
      content: "{}",
    },
    {
      label: "bundle refs",
      entry: `${NESTED_PLUGIN_PATH}/skul.refs.json`,
      content: '{"refs":[]}',
    },
  ])("rejects a symlinked $label", async ({ entry, content }) => {
    // Given
    const fixture = createNestedFixture();
    const link = path.join(fixture.repositoryDir, entry);
    const externalFile = path.join(fixture.root, "outside.json");
    writeFile(externalFile, content);
    fs.rmSync(link, { force: true });
    fs.symlinkSync(externalFile, link, "file");

    // When
    const resolving = fixture.resolve();

    // Then
    await expect(resolving).rejects.toThrow(/must not contain a symlink/);
  });

  it("rejects a symlinked item root", async () => {
    // Given
    const fixture = createNestedFixture();
    const externalDir = path.join(fixture.root, "outside");
    fs.renameSync(fixture.skillDir, externalDir);
    fs.symlinkSync(externalDir, fixture.skillDir, "dir");

    // When
    const resolving = fixture.resolve();

    // Then
    await expect(resolving).rejects.toThrow(
      /Referenced bundle item.*not found/,
    );
  });
});

function createNestedFixture() {
  const root = createTempDir("skul-nested-refs-");
  const libraryDir = path.join(root, "library");
  const repositoryDir = path.join(libraryDir, ...NESTED_SOURCE.split("/"));
  const bundleDir = path.join(root, "consumer");
  const sourceDir = path.join(repositoryDir, NESTED_SOURCE_PATH);
  const pluginDir = path.join(repositoryDir, NESTED_PLUGIN_PATH);
  const skillDir = path.join(pluginDir, "skills", "sentry-cli");
  const marketplaceFile = path.join(
    sourceDir,
    ".claude-plugin",
    "marketplace.json",
  );

  function writeMarketplace(plugins: unknown[]) {
    writeFile(marketplaceFile, JSON.stringify({ plugins }));
  }

  function writeRefs(overrides: Record<string, unknown> = {}) {
    writeFile(
      path.join(bundleDir, "skul.refs.json"),
      JSON.stringify({
        refs: [
          {
            target: "skills",
            name: "sentry",
            source: NESTED_SOURCE,
            sourcePath: NESTED_SOURCE_PATH,
            item: "skills/sentry-cli",
            ...overrides,
          },
        ],
      }),
    );
  }

  writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: sentry-cli\ndescription: Sentry CLI\n---\nUse references/issues.md.\n",
  );
  writeFile(path.join(skillDir, "references", "issues.md"), "Find issues.\n");
  writeMarketplace([{ name: "sentry-cli", source: "./plugins/sentry-cli" }]);
  writeRefs();

  return {
    root,
    libraryDir,
    repositoryDir,
    bundleDir,
    sourceDir,
    pluginDir,
    skillDir,
    marketplaceFile,
    writeMarketplace,
    writeRefs,
    resolve: () => resolveBundleItemRefs({ bundleDir, libraryDir }),
  };
}
