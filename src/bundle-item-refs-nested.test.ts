import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveBundleItemRefs } from "./bundle-item-refs";

const tempDirs: string[] = [];
const SOURCE = "github.com/getsentry/cli";
const SOURCE_PATH = "packages/cli";
const PLUGIN_PATH = `${SOURCE_PATH}/plugins/sentry-cli`;

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skul-nested-refs-"));
  tempDirs.push(root);
  const libraryDir = path.join(root, "library");
  const repositoryDir = path.join(libraryDir, ...SOURCE.split("/"));
  const bundleDir = path.join(root, "consumer");
  const sourceDir = path.join(repositoryDir, SOURCE_PATH);
  const pluginDir = path.join(repositoryDir, PLUGIN_PATH);
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
            source: SOURCE,
            sourcePath: SOURCE_PATH,
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("nested bundle item refs", () => {
  it.each([
    undefined,
    "sentry-cli",
  ])("resolves a nested marketplace plugin with bundle %s and preserves supporting files", async (bundle) => {
    const fixture = createFixture();
    fixture.writeRefs({ bundle });

    const resolved = await fixture.resolve();

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
    const fixture = createFixture();
    fixture.writeRefs({ sourcePath: PLUGIN_PATH, bundle });

    expect((await fixture.resolve()).get("skills/sentry")?.path).toBe(
      fixture.skillDir,
    );
  });

  it.each([
    { target: "agents", item: "agents/reviewer", file: "agents/reviewer.md" },
    { target: "commands", item: "commands/review", file: "commands/review.md" },
    { target: "root-instruction", item: "root-instruction", file: "AGENTS.md" },
  ])("resolves nested $target refs", async ({ target, item, file }) => {
    const fixture = createFixture();
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
    expect((await fixture.resolve()).get(selector)?.path).toBe(itemPath);
  });

  it("uses explicit target paths from the nested bundle manifest", async () => {
    const fixture = createFixture();
    const customSkillDir = path.join(fixture.pluginDir, "custom", "sentry-cli");
    writeFile(path.join(customSkillDir, "SKILL.md"), "Custom skill.\n");
    writeFile(
      path.join(fixture.pluginDir, "manifest.json"),
      JSON.stringify({
        tools: { "claude-code": { skills: { path: "custom" } } },
      }),
    );

    expect((await fixture.resolve()).get("skills/sentry")?.path).toBe(
      customSkillDir,
    );
  });

  it("allows a marketplace plugin source to reach a sibling inside its repository", async () => {
    const fixture = createFixture();
    fixture.writeMarketplace([{ name: "sentry-cli", source: "../shared" }]);
    const skillDir = path.join(
      fixture.repositoryDir,
      "packages/shared/skills/sentry-cli",
    );
    writeFile(path.join(skillDir, "SKILL.md"), "Shared skill.\n");

    expect((await fixture.resolve()).get("skills/sentry")?.path).toBe(skillDir);
  });

  it("requires bundle when two nested plugins contain the selected item", async () => {
    const fixture = createFixture();
    const otherDir = path.join(fixture.sourceDir, "plugins", "other");
    writeFile(
      path.join(otherDir, "skills", "sentry-cli", "SKILL.md"),
      "Other.\n",
    );
    fixture.writeMarketplace([
      { name: "sentry-cli", source: "./plugins/sentry-cli" },
      { name: "other", source: "./plugins/other" },
    ]);

    await expect(fixture.resolve()).rejects.toThrow(
      /multiple bundles.*set "bundle"/,
    );
    fixture.writeRefs({ bundle: "sentry-cli" });
    expect((await fixture.resolve()).get("skills/sentry")?.path).toBe(
      fixture.skillDir,
    );
  });

  it.each([
    undefined,
    "sentry-cli",
  ])("rejects duplicate marketplace names with bundle %s", async (bundle) => {
    const fixture = createFixture();
    fixture.writeMarketplace([
      { name: "sentry-cli", source: "./plugins/sentry-cli" },
      { name: "sentry-cli", source: "./plugins/sentry-cli" },
    ]);
    fixture.writeRefs({ bundle });

    await expect(fixture.resolve()).rejects.toThrow(/ambiguous plugin name/);
  });

  it("does not fall back to a repository-root item outside sourcePath", async () => {
    const fixture = createFixture();
    writeFile(
      path.join(fixture.repositoryDir, "skills/root-only/SKILL.md"),
      "Root only.\n",
    );
    fixture.writeRefs({ item: "skills/root-only" });

    await expect(fixture.resolve()).rejects.toThrow(
      /Referenced bundle item.*not found/,
    );
  });

  it("reports an unknown bundle in the selected sourcePath", async () => {
    const fixture = createFixture();
    fixture.writeRefs({ bundle: "missing-plugin" });

    await expect(fixture.resolve()).rejects.toThrow(
      /No bundle "missing-plugin".*sourcePath "packages\/cli"/,
    );
  });

  it("does not select a direct bundle with a different name", async () => {
    const fixture = createFixture();
    fixture.writeRefs({ sourcePath: PLUGIN_PATH, bundle: "missing-plugin" });

    await expect(fixture.resolve()).rejects.toThrow(
      /No bundle "missing-plugin"/,
    );
  });

  it.each([
    SOURCE_PATH,
    PLUGIN_PATH,
  ])("identifies a malformed selected manifest at %s", async (sourcePath) => {
    const fixture = createFixture();
    fixture.writeRefs({ sourcePath });
    const manifestFile = path.join(fixture.pluginDir, "manifest.json");
    writeFile(manifestFile, "{broken");

    await expect(fixture.resolve()).rejects.toThrow(
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
    const fixture = createFixture();
    fixture.writeRefs({ sourcePath });

    await expect(fixture.resolve()).rejects.toThrow(/"sourcePath"/);
  });

  it.each([
    "packages/missing",
    `${PLUGIN_PATH}/skills/sentry-cli/SKILL.md`,
  ])("rejects a nonexistent or file-valued sourcePath %s", async (sourcePath) => {
    const fixture = createFixture();
    fixture.writeRefs({ sourcePath });

    await expect(fixture.resolve()).rejects.toThrow(
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
    const fixture = createFixture();
    fixture.writeMarketplace([{ name: "sentry-cli", source }]);
    fixture.writeRefs({ bundle: "sentry-cli" });

    await expect(fixture.resolve()).rejects.toThrow(
      /repository-relative directory|within the fetched repository/,
    );
  });

  it.each([
    "./missing",
    "./plugins/sentry-cli/skills/sentry-cli/SKILL.md",
  ])("rejects a missing or file-valued marketplace source %s", async (source) => {
    const fixture = createFixture();
    fixture.writeMarketplace([{ name: "sentry-cli", source }]);

    await expect(fixture.resolve()).rejects.toThrow(
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
    const fixture = createFixture();
    writeFile(fixture.marketplaceFile, content);

    await expect(fixture.resolve()).rejects.toThrow(
      /Invalid Claude marketplace/,
    );
  });

  it("rejects a malformed explicit nested bundle manifest", async () => {
    const fixture = createFixture();
    writeFile(path.join(fixture.pluginDir, "manifest.json"), "{");

    await expect(fixture.resolve()).rejects.toThrow();
  });

  it.each([
    undefined,
    "sentry-cli",
  ])("ignores unrelated remote marketplace plugins with bundle %s", async (bundle) => {
    const fixture = createFixture();
    fixture.writeMarketplace([
      { name: "remote", source: { source: "github", repo: "example/plugin" } },
      { name: "sentry-cli", source: "./plugins/sentry-cli" },
    ]);
    fixture.writeRefs({ bundle });

    expect((await fixture.resolve()).get("skills/sentry")?.path).toBe(
      fixture.skillDir,
    );
  });

  it("does not validate an unrelated local plugin when bundle is explicit", async () => {
    const fixture = createFixture();
    fixture.writeMarketplace([
      { name: "unsafe-unselected", source: "../../../../outside" },
      { name: "sentry-cli", source: "./plugins/sentry-cli" },
    ]);
    fixture.writeRefs({ bundle: "sentry-cli" });

    expect((await fixture.resolve()).get("skills/sentry")?.path).toBe(
      fixture.skillDir,
    );
  });

  it.each([
    { label: "sourcePath ancestor", entry: "packages" },
    { label: "plugin ancestor", entry: `${SOURCE_PATH}/plugins` },
    { label: "item ancestor", entry: `${PLUGIN_PATH}/skills` },
    { label: "marketplace parent", entry: `${SOURCE_PATH}/.claude-plugin` },
  ])("rejects a symlink in the $label", async ({ entry }) => {
    const fixture = createFixture();
    const link = path.join(fixture.repositoryDir, entry);
    const externalDir = path.join(fixture.root, "outside");
    fs.renameSync(link, externalDir);
    fs.symlinkSync(externalDir, link, "dir");

    await expect(fixture.resolve()).rejects.toThrow(
      /must not contain a symlink/,
    );
  });

  it.each([
    {
      label: "marketplace manifest",
      entry: `${SOURCE_PATH}/.claude-plugin/marketplace.json`,
      content: "{}",
    },
    {
      label: "bundle manifest",
      entry: `${PLUGIN_PATH}/manifest.json`,
      content: "{}",
    },
    {
      label: "bundle refs",
      entry: `${PLUGIN_PATH}/skul.refs.json`,
      content: '{"refs":[]}',
    },
  ])("rejects a symlinked $label", async ({ entry, content }) => {
    const fixture = createFixture();
    const link = path.join(fixture.repositoryDir, entry);
    const externalFile = path.join(fixture.root, "outside.json");
    writeFile(externalFile, content);
    fs.rmSync(link, { force: true });
    fs.symlinkSync(externalFile, link, "file");

    await expect(fixture.resolve()).rejects.toThrow(
      /must not contain a symlink/,
    );
  });

  it("rejects a symlinked item root", async () => {
    const fixture = createFixture();
    const externalDir = path.join(fixture.root, "outside");
    fs.renameSync(fixture.skillDir, externalDir);
    fs.symlinkSync(externalDir, fixture.skillDir, "dir");

    await expect(fixture.resolve()).rejects.toThrow(
      /Referenced bundle item.*not found/,
    );
  });
});
