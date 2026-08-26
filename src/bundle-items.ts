import fs from "node:fs";
import path from "node:path";
import { listBundleItemRefSelectors } from "./bundle-item-refs";
import type { BundleManifest } from "./bundle-manifest";
import {
  getToolDefinition,
  type ToolName,
  type ToolTargetName,
} from "./tool-mapping";

export type BundleItemSelector = string;

const ROOT_INSTRUCTION_SELECTOR = "root-instruction";
const MCP_SELECTOR = "mcp";
const DIRECTORY_TARGET_NAMES = new Set<ToolTargetName>([
  "skills",
  "commands",
  "agents",
]);

/** Normalizes one user-facing bundle item selector. */
export function normalizeBundleItemSelector(
  selector: string,
): BundleItemSelector {
  const value = selector.trim().replaceAll("\\", "/");

  if (
    value === ROOT_INSTRUCTION_SELECTOR ||
    value === "AGENTS.md" ||
    value === "CLAUDE.md" ||
    value === "GEMINI.md" ||
    value === ".github/copilot-instructions.md"
  ) {
    return ROOT_INSTRUCTION_SELECTOR;
  }

  if (value === MCP_SELECTOR || value === "mcp.json") {
    return MCP_SELECTOR;
  }

  const [targetName, itemName, ...rest] = value.split("/");

  if (rest.length > 0) {
    throw new Error(
      `Bundle item selector must target one top-level item: ${selector}`,
    );
  }

  if (!isDirectoryTargetName(targetName)) {
    throw new Error(
      `Bundle item selector must start with skills/, commands/, agents/, or be root-instruction or mcp: ${selector}`,
    );
  }

  return `${targetName}/${normalizeBundleItemName(itemName, selector)}`;
}

function isDirectoryTargetName(
  value: string | undefined,
): value is ToolTargetName {
  return (
    value !== undefined && DIRECTORY_TARGET_NAMES.has(value as ToolTargetName)
  );
}

function normalizeBundleItemName(
  value: string | undefined,
  originalSelector: string,
): string {
  if (!value || value === "." || value === "..") {
    throw new Error(
      `Bundle item selector is missing an item name: ${originalSelector}`,
    );
  }

  return stripKnownItemExtension(value);
}

function stripKnownItemExtension(value: string): string {
  if (value.endsWith(".agent.md")) {
    return value.slice(0, -".agent.md".length);
  }

  return value.replace(/\.(md|toml|yaml|yml|json)$/i, "");
}

/** Normalizes and deduplicates bundle item selectors while preserving order. */
export function normalizeBundleItemSelectors(
  selectors: string[],
): BundleItemSelector[] {
  const normalized = selectors.map(normalizeBundleItemSelector);
  return Array.from(new Set(normalized));
}

/** Returns true when a root-instruction target should be materialized. */
export function isRootInstructionItemSelected(
  selectors: BundleItemSelector[] | undefined,
): boolean {
  return !selectors || selectors.includes(ROOT_INSTRUCTION_SELECTOR);
}

/** Returns true when a bundle's MCP servers should be materialized. */
export function isMcpItemSelected(
  selectors: BundleItemSelector[] | undefined,
): boolean {
  return !selectors || selectors.includes(MCP_SELECTOR);
}

/** Lists installable item selectors available from a cached bundle. */
export function listSelectableBundleItems(options: {
  bundleDir: string;
  manifest: BundleManifest;
  tools?: ToolName[];
}): BundleItemSelector[] {
  const selectors = new Set<BundleItemSelector>();
  const toolEntries = selectManifestToolEntries(
    options.manifest,
    options.tools,
  );

  for (const [toolName, targets] of toolEntries) {
    for (const [targetName, target] of Object.entries(targets)) {
      if (targetName === "root_instruction") {
        selectors.add(ROOT_INSTRUCTION_SELECTOR);
        continue;
      }

      if (targetName === "mcp") {
        selectors.add(MCP_SELECTOR);
        continue;
      }

      if (!isDirectoryTargetName(targetName)) {
        continue;
      }

      const targetDefinition = getToolDefinition(toolName)?.targets[targetName];

      if (targetDefinition?.kind !== "directory") {
        continue;
      }

      for (const itemName of listTargetItemNames({
        sourceDir: path.join(options.bundleDir, target.path),
        targetName,
      })) {
        selectors.add(`${targetName}/${itemName}`);
      }
    }
  }

  for (const selector of listBundleItemRefSelectors({
    bundleDir: options.bundleDir,
    manifest: options.manifest,
    tools: options.tools,
  })) {
    selectors.add(selector);
  }

  return Array.from(selectors).sort((left, right) => left.localeCompare(right));
}

function selectManifestToolEntries(
  manifest: BundleManifest,
  tools: ToolName[] | undefined,
): Array<[ToolName, NonNullable<BundleManifest["tools"][ToolName]>]> {
  return (
    tools && tools.length > 0
      ? Object.entries(manifest.tools).filter(([toolName]) =>
          tools.includes(toolName as ToolName),
        )
      : Object.entries(manifest.tools)
  ) as Array<[ToolName, NonNullable<BundleManifest["tools"][ToolName]>]>;
}

function listTargetItemNames(options: {
  sourceDir: string;
  targetName: ToolTargetName;
}): string[] {
  if (!fs.existsSync(options.sourceDir)) {
    return [];
  }

  return fs
    .readdirSync(options.sourceDir, { withFileTypes: true })
    .filter((entry) => isSelectableBundleItemEntry(entry, options.targetName))
    .map((entry) => stripKnownBundleItemExtension(entry.name));
}

export function isSelectableBundleItemEntry(
  entry: fs.Dirent,
  targetName: ToolTargetName,
): boolean {
  if (targetName === "skills") {
    return entry.isDirectory();
  }

  if (targetName === "agents") {
    return entry.isFile() || entry.isDirectory();
  }

  return entry.isFile();
}

export function stripKnownBundleItemExtension(value: string): string {
  return stripKnownItemExtension(value);
}

/** Throws when requested item selectors are not present in the selected bundle scope. */
export function assertBundleSupportsRequestedItems(options: {
  requestedItems: BundleItemSelector[];
  availableItems: BundleItemSelector[];
}): void {
  const unsupportedItems = options.requestedItems.filter(
    (item) => !options.availableItems.includes(item),
  );

  if (unsupportedItems.length === 0) {
    return;
  }

  throw new Error(
    `Bundle does not include item(s): ${unsupportedItems.join(", ")}\nAvailable items: ${options.availableItems.join(", ")}`,
  );
}

/** Merges item selections, returning undefined when the whole bundle is selected. */
export function mergeDesiredBundleItems(options: {
  existingItems?: BundleItemSelector[];
  requestedItems?: BundleItemSelector[];
  replace?: boolean;
}): BundleItemSelector[] | undefined {
  if (options.requestedItems === undefined) {
    return undefined;
  }

  if (options.replace) {
    return [...options.requestedItems];
  }

  return Array.from(
    new Set([...(options.existingItems ?? []), ...options.requestedItems]),
  );
}

/** Returns true when two optional selector lists describe the same bundle item set. */
export function bundleItemSelectionsEqual(
  left?: BundleItemSelector[],
  right?: BundleItemSelector[],
): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right || left.length !== right.length) {
    return false;
  }

  const rightSet = new Set(right);
  return left.every((item) => rightSet.has(item));
}
