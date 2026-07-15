import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createHomeDir,
  createLinkedWorktree,
  createPromptClientStub,
  createRemoteBundleSource,
  createRepository,
  runGit,
  updateRemoteBundleSource,
  writeBundleFile,
  writeManifest,
} from "./cli.test-support";
import { run } from "./index";

function writeCanonicalSkill(options: {
  homeDir: string;
  source: string;
  bundle: string;
  skillName: string;
}): void {
  writeBundleFile(
    options.homeDir,
    options.source,
    options.bundle,
    `skills/${options.skillName}/SKILL.md`,
    [
      "---",
      `name: ${options.skillName}`,
      "description: Search things fast",
      "---",
      "",
      "Search aggressively.",
      "",
    ].join("\n"),
  );
}

function writeCanonicalAgent(options: {
  homeDir: string;
  source: string;
  bundle: string;
  agentName: string;
}): void {
  writeManifest(options.homeDir, options.source, options.bundle, {
    name: options.bundle,
    tools: { "claude-code": { agents: { path: "agents" } } },
  });
  writeBundleFile(
    options.homeDir,
    options.source,
    options.bundle,
    `agents/${options.agentName}.md`,
    [
      "---",
      `name: ${options.agentName}`,
      "description: Review changes",
      "---",
      "",
      "Review externally sourced diffs.",
      "",
    ].join("\n"),
  );
}

function writeCanonicalCommand(options: {
  homeDir: string;
  source: string;
  bundle: string;
  commandName: string;
}): void {
  writeManifest(options.homeDir, options.source, options.bundle, {
    name: options.bundle,
    tools: { "claude-code": { commands: { path: "commands" } } },
  });
  writeBundleFile(
    options.homeDir,
    options.source,
    options.bundle,
    `commands/${options.commandName}.md`,
    "# Review\nRun the review checklist.\n",
  );
}

function writeCanonicalRootInstruction(options: {
  homeDir: string;
  source: string;
  bundle: string;
}): void {
  writeManifest(options.homeDir, options.source, options.bundle, {
    name: options.bundle,
    tools: { codex: { root_instruction: { path: "AGENTS.md" } } },
  });
  writeBundleFile(
    options.homeDir,
    options.source,
    options.bundle,
    "AGENTS.md",
    "Use externally sourced repo standards.\n",
  );
}

function writeBundleRefs(options: {
  homeDir: string;
  source: string;
  bundle: string;
  refs: object[];
}): void {
  writeBundleFile(
    options.homeDir,
    options.source,
    options.bundle,
    "skul.refs.json",
    JSON.stringify({ refs: options.refs }),
  );
}

describe("run add — cross-repo bundle item references", () => {
  it("materializes a bundle item referenced from another cached bundle", async () => {
    // Given: a referenced skill item cached under a separate source, and a bundle
    // that only carries a skul.refs.json pointer to it instead of a copy.
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeCanonicalSkill({
      homeDir,
      source: "github.com/fivetaku/insane-search",
      bundle: "insane-search",
      skillName: "insane-search",
    });

    writeManifest(homeDir, "github.com/user/ai-vault", "ghosts", {
      name: "ghosts",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleRefs({
      homeDir,
      source: "github.com/user/ai-vault",
      bundle: "ghosts",
      refs: [
        {
          target: "skills",
          name: "insane-search",
          source: "fivetaku/insane-search",
        },
      ],
    });

    // When
    await run(["add", "ghosts"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // Then
    const materializedPath = path.join(
      repoRoot,
      ".claude",
      "skills",
      "insane-search",
      "SKILL.md",
    );
    expect(fs.existsSync(materializedPath)).toBe(true);
    expect(fs.readFileSync(materializedPath, "utf8")).toContain(
      "Search aggressively.",
    );
  });

  it("materializes bundle item refs from multiple sources into a cold cache", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const searchSource = createRemoteBundleSource(homeDir, {
      source: "github.com/fivetaku/insane-search",
      bundle: "insane-search",
      manifest: {
        tools: { "claude-code": { skills: { path: "skills" } } },
      },
      files: {
        "skills/insane-search/SKILL.md":
          "---\nname: insane-search\ndescription: Search\n---\nSearch aggressively.\n",
      },
    });
    const reviewSource = createRemoteBundleSource(homeDir, {
      source: "github.com/fivetaku/reviewer",
      bundle: "reviewer",
      manifest: {
        tools: { "claude-code": { skills: { path: "skills" } } },
      },
      files: {
        "skills/reviewer/SKILL.md":
          "---\nname: reviewer\ndescription: Review\n---\nReview carefully.\n",
      },
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "ghosts", {
      name: "ghosts",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleRefs({
      homeDir,
      source: "github.com/user/ai-vault",
      bundle: "ghosts",
      refs: [
        {
          target: "skills",
          name: "insane-search",
          source: searchSource.source,
        },
        {
          target: "skills",
          name: "reviewer",
          source: reviewSource.source,
        },
      ],
    });
    fs.rmSync(
      path.join(homeDir, ".skul", "library", ...searchSource.source.split("/")),
      { recursive: true, force: true },
    );
    fs.rmSync(
      path.join(homeDir, ".skul", "library", ...reviewSource.source.split("/")),
      { recursive: true, force: true },
    );
    const previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    const gitConfigFile = path.join(homeDir, "gitconfig");
    fs.writeFileSync(
      gitConfigFile,
      [
        `[url "${searchSource.remoteRepoPath}"]`,
        `\tinsteadOf = https://${searchSource.source}`,
        `[url "${reviewSource.remoteRepoPath}"]`,
        `\tinsteadOf = https://${reviewSource.source}`,
        "",
      ].join("\n"),
    );
    process.env.GIT_CONFIG_GLOBAL = gitConfigFile;

    // When
    try {
      await run(["add", "ghosts"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      });
    } finally {
      if (previousGitConfigGlobal === undefined) {
        delete process.env.GIT_CONFIG_GLOBAL;
      } else {
        process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal;
      }
    }

    // Then
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "insane-search", "SKILL.md"),
        "utf8",
      ),
    ).toContain("Search aggressively.");
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "reviewer", "SKILL.md"),
        "utf8",
      ),
    ).toContain("Review carefully.");
  });

  it("surfaces a clear error when the referenced bundle item does not exist", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeCanonicalSkill({
      homeDir,
      source: "github.com/fivetaku/insane-search",
      bundle: "insane-search",
      skillName: "insane-search",
    });

    writeManifest(homeDir, "github.com/user/ai-vault", "ghosts", {
      name: "ghosts",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleRefs({
      homeDir,
      source: "github.com/user/ai-vault",
      bundle: "ghosts",
      refs: [
        {
          target: "skills",
          name: "missing",
          source: "fivetaku/insane-search",
          item: "skills/does-not-exist",
        },
      ],
    });

    // When / Then
    await expect(
      run(["add", "ghosts"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).rejects.toThrowError(
      /Referenced bundle item "skills\/does-not-exist" not found/,
    );
  });

  it("materializes a bundle item reference with CLI disable-model-invocation forced", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeCanonicalSkill({
      homeDir,
      source: "github.com/fivetaku/insane-search",
      bundle: "insane-search",
      skillName: "insane-search",
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "ghosts", {
      name: "ghosts",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleRefs({
      homeDir,
      source: "github.com/user/ai-vault",
      bundle: "ghosts",
      refs: [
        {
          target: "skills",
          name: "insane-search",
          source: "fivetaku/insane-search",
        },
      ],
    });

    // When
    await run(["add", "ghosts", "--disable-model-invocation"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // Then
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "insane-search", "SKILL.md"),
        "utf8",
      ),
    ).toContain("disable-model-invocation: true");
  });

  it("materializes a referenced skill with ref disable-model-invocation forced", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeCanonicalSkill({
      homeDir,
      source: "github.com/fivetaku/insane-search",
      bundle: "insane-search",
      skillName: "insane-search",
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "ghosts", {
      name: "ghosts",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleRefs({
      homeDir,
      source: "github.com/user/ai-vault",
      bundle: "ghosts",
      refs: [
        {
          target: "skills",
          name: "insane-search",
          source: "fivetaku/insane-search",
          "disable-model-invocation": true,
        },
      ],
    });

    // When
    await run(["add", "ghosts"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // Then
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "insane-search", "SKILL.md"),
        "utf8",
      ),
    ).toContain("disable-model-invocation: true");
  });

  it("materializes an agent referenced from another cached bundle", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeCanonicalAgent({
      homeDir,
      source: "github.com/fivetaku/reviewers",
      bundle: "reviewers",
      agentName: "reviewer",
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "ghosts", {
      name: "ghosts",
      tools: { "claude-code": { agents: { path: "agents" } } },
    });
    writeBundleRefs({
      homeDir,
      source: "github.com/user/ai-vault",
      bundle: "ghosts",
      refs: [
        {
          target: "agents",
          name: "reviewer",
          source: "fivetaku/reviewers",
        },
      ],
    });

    // When
    await run(["add", "ghosts"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // Then
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "agents", "reviewer.md"),
        "utf8",
      ),
    ).toContain("Review externally sourced diffs.");
  });

  it("materializes a command referenced from another cached bundle", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeCanonicalCommand({
      homeDir,
      source: "github.com/fivetaku/commands",
      bundle: "commands",
      commandName: "review",
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "ghosts", {
      name: "ghosts",
      tools: { "claude-code": { commands: { path: "commands" } } },
    });
    writeBundleRefs({
      homeDir,
      source: "github.com/user/ai-vault",
      bundle: "ghosts",
      refs: [
        {
          target: "commands",
          name: "review",
          source: "fivetaku/commands",
        },
      ],
    });

    // When
    await run(["add", "ghosts"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // Then
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "commands", "review.md"),
        "utf8",
      ),
    ).toContain("Run the review checklist.");
  });

  it("materializes a referenced skill into a native-layout target", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeCanonicalSkill({
      homeDir,
      source: "github.com/fivetaku/insane-search",
      bundle: "insane-search",
      skillName: "insane-search",
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "ghosts", {
      name: "ghosts",
      tools: { "claude-code": { skills: { path: ".claude/skills" } } },
    });
    writeBundleRefs({
      homeDir,
      source: "github.com/user/ai-vault",
      bundle: "ghosts",
      refs: [
        {
          target: "skills",
          name: "insane-search",
          source: "fivetaku/insane-search",
        },
      ],
    });

    // When
    await run(["add", "ghosts"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // Then
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "insane-search", "SKILL.md"),
        "utf8",
      ),
    ).toContain("Search aggressively.");
  });

  it("materializes a manifest-free refs-only bundle", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeCanonicalSkill({
      homeDir,
      source: "github.com/fivetaku/insane-search",
      bundle: "insane-search",
      skillName: "insane-search",
    });
    writeBundleRefs({
      homeDir,
      source: "github.com/user/ai-vault",
      bundle: "ghosts",
      refs: [
        {
          target: "skills",
          name: "insane-search",
          source: "fivetaku/insane-search",
        },
      ],
    });

    // When
    await run(["add", "ghosts"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // Then
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "insane-search", "SKILL.md"),
        "utf8",
      ),
    ).toContain("Search aggressively.");
  });

  it("materializes a root instruction referenced from another cached bundle", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeCanonicalRootInstruction({
      homeDir,
      source: "github.com/fivetaku/standards",
      bundle: "standards",
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "ghosts", {
      name: "ghosts",
      tools: { codex: { root_instruction: { path: "AGENTS.md" } } },
    });
    writeBundleRefs({
      homeDir,
      source: "github.com/user/ai-vault",
      bundle: "ghosts",
      refs: [
        {
          target: "root-instruction",
          path: "AGENTS.md",
          source: "fivetaku/standards",
        },
      ],
    });

    // When
    await run(["add", "ghosts"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // Then
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toContain(
      "Use externally sourced repo standards.",
    );
  });

  it("does not resolve an unselected broken bundle item reference", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeManifest(homeDir, "github.com/user/ai-vault", "ghosts", {
      name: "ghosts",
      tools: {
        codex: {
          root_instruction: { path: "AGENTS.md" },
          skills: { path: "skills" },
        },
      },
    });
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "ghosts",
      "AGENTS.md",
      "Use the repo standards.",
    );
    writeBundleRefs({
      homeDir,
      source: "github.com/user/ai-vault",
      bundle: "ghosts",
      refs: [
        {
          target: "skills",
          name: "broken",
          source: "fivetaku/missing",
        },
      ],
    });

    // When
    await run(["add", "ghosts", "--include", "root-instruction"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // Then
    expect(fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")).toContain(
      "Use the repo standards.",
    );
    expect(fs.existsSync(path.join(repoRoot, ".agents", "skills"))).toBe(false);
  });

  it("checks out a commit ref referenced source even when another revision is cached", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const remoteSource = createRemoteBundleSource(homeDir, {
      source: "github.com/fivetaku/insane-search",
      bundle: "insane-search",
      manifest: {
        tools: { "claude-code": { skills: { path: "skills" } } },
      },
      files: {
        "skills/insane-search/SKILL.md":
          "---\nname: insane-search\ndescription: Search\n---\nInitial search.\n",
      },
    });
    const latestCommit = updateRemoteBundleSource(
      remoteSource.remoteRepoPath,
      remoteSource.bundle,
      {
        "skills/insane-search/SKILL.md":
          "---\nname: insane-search\ndescription: Search\n---\nLatest search.\n",
      },
    );
    const cachedSourceDir = path.join(
      homeDir,
      ".skul",
      "library",
      "github.com",
      "fivetaku",
      "insane-search",
    );
    runGit(cachedSourceDir, ["fetch", "origin", "main"]);
    runGit(cachedSourceDir, ["checkout", latestCommit]);
    writeManifest(homeDir, "github.com/user/ai-vault", "ghosts", {
      name: "ghosts",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleRefs({
      homeDir,
      source: "github.com/user/ai-vault",
      bundle: "ghosts",
      refs: [
        {
          target: "skills",
          name: "insane-search",
          source: "fivetaku/insane-search",
          ref: remoteSource.initialCommit.slice(0, 7),
        },
      ],
    });

    // When
    await run(["add", "ghosts"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // Then
    const materialized = fs.readFileSync(
      path.join(repoRoot, ".claude", "skills", "insane-search", "SKILL.md"),
      "utf8",
    );
    expect(materialized).toContain("Initial search.");
    expect(materialized).not.toContain("Latest search.");
  });

  it("materializes a referenced skill item when apply runs in a new worktree", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();
    const linkedWorktree = createLinkedWorktree(repoRoot);

    writeCanonicalSkill({
      homeDir,
      source: "github.com/fivetaku/insane-search",
      bundle: "insane-search",
      skillName: "insane-search",
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "ghosts", {
      name: "ghosts",
      tools: { "claude-code": { skills: { path: "skills" } } },
    });
    writeBundleRefs({
      homeDir,
      source: "github.com/user/ai-vault",
      bundle: "ghosts",
      refs: [
        {
          target: "skills",
          name: "insane-search",
          source: "fivetaku/insane-search",
        },
      ],
    });
    await run(["add", "ghosts"], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });

    // When
    await expect(
      run(["apply"], { homeDir, cwd: linkedWorktree }),
    ).resolves.toBe("Applied ghosts");

    // Then
    expect(
      fs.readFileSync(
        path.join(
          linkedWorktree,
          ".claude",
          "skills",
          "insane-search",
          "SKILL.md",
        ),
        "utf8",
      ),
    ).toContain("Search aggressively.");
  });

  it("materializes a referenced skill item introduced by update", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeCanonicalSkill({
      homeDir,
      source: "github.com/fivetaku/insane-search",
      bundle: "insane-search",
      skillName: "insane-search",
    });
    const remoteSource = createRemoteBundleSource(homeDir, {
      bundle: "ghosts",
      manifest: {
        tools: { "claude-code": { skills: { path: "skills" } } },
      },
      files: {
        "skills/local/SKILL.md":
          "---\nname: local\ndescription: Local skill\n---\nLocal only.\n",
      },
    });
    await run(["add", remoteSource.source, remoteSource.bundle], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    updateRemoteBundleSource(remoteSource.remoteRepoPath, remoteSource.bundle, {
      "skul.refs.json": JSON.stringify({
        refs: [
          {
            target: "skills",
            name: "insane-search",
            source: "fivetaku/insane-search",
          },
        ],
      }),
    });

    // When
    await expect(
      run(["update"], { homeDir, cwd: repoRoot }),
    ).resolves.toContain("Updated ghosts");

    // Then
    expect(
      fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", "insane-search", "SKILL.md"),
        "utf8",
      ),
    ).toContain("Search aggressively.");
  });

  it("materializes a referenced skill item during global add", async () => {
    // Given
    const homeDir = createHomeDir();

    writeCanonicalSkill({
      homeDir,
      source: "github.com/fivetaku/insane-search",
      bundle: "insane-search",
      skillName: "insane-search",
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "ghosts", {
      name: "ghosts",
      tools: { codex: { skills: { path: "skills" } } },
    });
    writeBundleRefs({
      homeDir,
      source: "github.com/user/ai-vault",
      bundle: "ghosts",
      refs: [
        {
          target: "skills",
          name: "insane-search",
          source: "fivetaku/insane-search",
        },
      ],
    });

    // When
    await expect(
      run(["add", "ghosts", "--global"], {
        homeDir,
        prompts: createPromptClientStub(),
      }),
    ).resolves.toBe("Applied ghosts globally for codex");

    // Then
    expect(
      fs.readFileSync(
        path.join(homeDir, ".agents", "skills", "insane-search", "SKILL.md"),
        "utf8",
      ),
    ).toContain("Search aggressively.");
  });

  it("marks a changed bundle item reference file during item selection", async () => {
    // Given
    const homeDir = createHomeDir();
    const repoRoot = createRepository();

    writeCanonicalSkill({
      homeDir,
      source: "github.com/fivetaku/insane-search",
      bundle: "insane-search",
      skillName: "insane-search",
    });
    const remoteSource = createRemoteBundleSource(homeDir, {
      bundle: "ghosts",
      manifest: {
        tools: { "claude-code": { skills: { path: "skills" } } },
      },
      files: {
        "skul.refs.json": JSON.stringify({
          refs: [
            {
              target: "skills",
              name: "search",
              source: "fivetaku/insane-search",
              item: "skills/insane-search",
            },
          ],
        }),
      },
    });
    await run(["add", remoteSource.source, remoteSource.bundle], {
      homeDir,
      cwd: repoRoot,
      prompts: createPromptClientStub(),
    });
    updateRemoteBundleSource(remoteSource.remoteRepoPath, remoteSource.bundle, {
      "skul.refs.json": JSON.stringify({
        refs: [
          {
            target: "skills",
            name: "search",
            source: "fivetaku/insane-search",
            item: "skills/insane-search",
            bundle: "insane-search",
          },
        ],
      }),
    });
    const selectBundleItemChoices = vi.fn(
      async (choices: Array<{ value: string }>) =>
        choices.map((choice) => choice.value),
    );

    // When
    await run(
      ["add", remoteSource.source, remoteSource.bundle, "--select-items"],
      {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub({ selectBundleItemChoices }),
      },
    );

    // Then
    expect(selectBundleItemChoices).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          label: "skills/search",
          hint: "Updated",
        }),
      ],
      [],
      "install",
    );
  });
});
