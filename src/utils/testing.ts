import fs from "node:fs";
import path from "node:path";

import { expect } from "vitest";

/** Formats one expected root-instruction bundle block with Skul boundary markers. */
export function formatRootInstructionBundleBlock(
  bundle: string,
  content: string,
  source?: string,
): string {
  const label = source ? `${bundle} (${source})` : bundle;
  const normalizedContent = content.replace(/\s+$/, "");
  return `<!-- BEGIN SKUL BUNDLE: ${label} -->\n${normalizedContent}\n<!-- END SKUL BUNDLE: ${label} -->`;
}

/** Formats one expected tracked root-instruction shadow block. */
export function formatTrackedRootInstructionShadowBlock(
  bundle: string,
  content: string,
): string {
  const normalizedContent = content.replace(/\s+$/, "");
  return `<!-- SKUL SHADOW START bundle=${bundle} -->\n${normalizedContent}\n<!-- SKUL SHADOW END -->`;
}

/** Joins expected root-instruction document parts using the production document layout. */
export function formatExpectedRootInstructionDocument(
  ...parts: string[]
): string {
  return `${parts
    .map((part) => part.replace(/\s+$/, ""))
    .filter((part) => part.length > 0)
    .join("\n\n")}\n`;
}

/** Writes one root-instruction test bundle fixture into the local cache layout. */
export function writeRootInstructionBundleFixture(
  homeDir: string,
  options: {
    bundle: string;
    content: string;
    source?: string;
    agent?: "codex" | "claude-code";
    filePath?: string;
    extraTools?: Record<string, object>;
    extraFiles?: Record<string, string>;
  },
  helpers: {
    writeManifest: (
      homeDir: string,
      source: string,
      bundle: string,
      manifest: object,
    ) => void;
    writeBundleFile: (
      homeDir: string,
      source: string | undefined,
      bundle: string,
      relativePath: string,
      content: string,
    ) => void;
  },
): void {
  const source = options.source ?? "github.com/user/ai-vault";
  const agent = options.agent ?? "codex";
  const filePath =
    options.filePath ?? (agent === "codex" ? "AGENTS.md" : "CLAUDE.md");

  helpers.writeManifest(homeDir, source, options.bundle, {
    name: options.bundle,
    tools: {
      ...options.extraTools,
      [agent]: { root_instruction: { path: filePath } },
    },
  });
  helpers.writeBundleFile(
    homeDir,
    source,
    options.bundle,
    filePath,
    options.content,
  );

  for (const [relativePath, content] of Object.entries(
    options.extraFiles ?? {},
  )) {
    helpers.writeBundleFile(
      homeDir,
      source,
      options.bundle,
      relativePath,
      content,
    );
  }
}

/** Writes multiple shared root-instruction test bundle fixtures into the local cache layout. */
export function setupSharedRootInstructionBundles(
  homeDir: string,
  bundles: Array<{
    bundle: string;
    content: string;
    source?: string;
    agent?: "codex" | "claude-code";
    filePath?: string;
    extraTools?: Record<string, object>;
    extraFiles?: Record<string, string>;
  }>,
  helpers: {
    writeManifest: (
      homeDir: string,
      source: string,
      bundle: string,
      manifest: object,
    ) => void;
    writeBundleFile: (
      homeDir: string,
      source: string | undefined,
      bundle: string,
      relativePath: string,
      content: string,
    ) => void;
  },
): void {
  for (const bundle of bundles) {
    writeRootInstructionBundleFixture(homeDir, bundle, helpers);
  }
}

/** Asserts the exact rendered contents of one managed root-instruction file. */
export function expectRootInstructionDocument(
  repoRoot: string,
  fileName: "AGENTS.md" | "CLAUDE.md",
  ...parts: string[]
): void {
  expect(fs.readFileSync(path.join(repoRoot, fileName), "utf8")).toBe(
    formatExpectedRootInstructionDocument(...parts),
  );
}

/** Asserts the exact rendered contents of `AGENTS.md`. */
export function expectAgentsDocument(
  repoRoot: string,
  ...parts: string[]
): void {
  expectRootInstructionDocument(repoRoot, "AGENTS.md", ...parts);
}

/** Asserts the exact rendered contents of `CLAUDE.md`. */
export function expectClaudeDocument(
  repoRoot: string,
  ...parts: string[]
): void {
  expectRootInstructionDocument(repoRoot, "CLAUDE.md", ...parts);
}
