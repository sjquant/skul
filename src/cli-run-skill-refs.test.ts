import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createHomeDir,
  createPromptClientStub,
  createRepository,
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

describe("run add — cross-repo skill references", () => {
  it("materializes a skill referenced from another cached bundle", async () => {
    // Given: a referenced skill cached under a separate source, and a bundle
    // that only carries a .ref.json pointer to it instead of a copy.
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
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "ghosts",
      "skills/insane-search.ref.json",
      JSON.stringify({ source: "fivetaku/insane-search" }),
    );

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

  it("surfaces a clear error when the referenced skill does not exist", async () => {
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
    writeBundleFile(
      homeDir,
      "github.com/user/ai-vault",
      "ghosts",
      "skills/missing.ref.json",
      JSON.stringify({
        source: "fivetaku/insane-search",
        item: "skills/does-not-exist",
      }),
    );

    // When / Then
    await expect(
      run(["add", "ghosts"], {
        homeDir,
        cwd: repoRoot,
        prompts: createPromptClientStub(),
      }),
    ).rejects.toThrowError(/Referenced skill "does-not-exist" not found/);
  });
});
