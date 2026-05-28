import { escapeRegExp } from "./fs-utils";
import {
  getToolDefinition,
  type ToolName,
  type ToolTargetName,
} from "./tool-mapping";

type ScalarValue = string | boolean;
type MetadataValue = ScalarValue | MetadataMap | string[];

interface MetadataMap {
  [key: string]: MetadataValue;
}

type SkillTool =
  | "claude"
  | "cursor"
  | "codex"
  | "opencode"
  | "copilot"
  | "kiro"
  | "antigravity";
type CommandTool = "claude" | "cursor" | "opencode" | "antigravity";
type AgentTool =
  | "claude"
  | "cursor"
  | "codex"
  | "opencode"
  | "copilot"
  | "kiro";
type RootInstructionTool =
  | "claude"
  | "cursor"
  | "codex"
  | "opencode"
  | "copilot"
  | "kiro"
  | "antigravity";

interface MarkdownDocument {
  metadata: MetadataMap;
  body: string;
}

interface SkillModel {
  name: string;
  description: string;
  body: string;
  manualOnly: boolean;
  openCodeCompatibility: boolean;
}

interface CommandModel {
  body: string;
  description?: string;
  agent?: string;
  model?: string;
  manualOnly: boolean;
}

interface AgentModel {
  name: string;
  description: string;
  body: string;
  model?: string;
  mode?: string;
}

interface CodexAgentDocument {
  name: string;
  description: string;
  developerInstructions: string;
  model?: string;
  sandboxMode?: string;
}

export interface BundleTranslationOptions {
  name?: string;
  description?: string;
}

/** Translates a canonical skill bundle into one target tool's skill file layout. */
export function translateSkill(options: {
  sourceTool: SkillTool;
  targetTool: SkillTool;
  files: Record<string, string>;
  options?: BundleTranslationOptions;
}): Record<string, string> {
  const model = parseSkill(options.sourceTool, options.files);
  return renderSkill(options.targetTool, model, options.options, options.files);
}

/** Translates a canonical command document into one target tool's command layout. */
export function translateCommand(options: {
  sourceTool: CommandTool;
  targetTool: CommandTool | "codex";
  source: string;
  options?: BundleTranslationOptions;
}): Record<string, string> {
  const model = parseCommand(options.sourceTool, options.source);
  return renderCommand(options.targetTool, model, options.options);
}

/** Translates a canonical agent document into one target tool's agent layout. */
export function translateAgent(options: {
  sourceTool: AgentTool;
  targetTool: AgentTool;
  source: string;
}): Record<string, string> {
  const model = parseAgent(options.sourceTool, options.source);
  return renderAgent(options.targetTool, model);
}

/** Translates one root-instruction source into target-tool root files such as `AGENTS.md`. */
export function translateRootInstruction(options: {
  targetTool: RootInstructionTool;
  source: string;
}): Record<string, string> {
  return {
    [rootInstructionFilePath(options.targetTool)]: options.source,
  };
}

function parseSkill(
  sourceTool: SkillTool,
  files: Record<string, string>,
): SkillModel {
  const skillSource = findFileBySuffix(files, "SKILL.md");

  if (!skillSource) {
    throw new Error("SKILL.md is required");
  }

  const document = parseMarkdownDocument(skillSource);
  const name = coerceRequiredString(document.metadata.name, "name");
  const description = coerceRequiredString(
    document.metadata.description,
    "description",
  );

  if (sourceTool === "codex") {
    return {
      name,
      description,
      body: document.body,
      manualOnly:
        parseCodexSkillPolicy(findFileBySuffix(files, "agents/openai.yaml")) ===
        false,
      openCodeCompatibility: false,
    };
  }

  if (sourceTool === "opencode") {
    return {
      name,
      description,
      body: document.body,
      manualOnly: false,
      openCodeCompatibility: document.metadata.compatibility === "opencode",
    };
  }

  // claude, cursor, copilot, kiro, antigravity — all use the same SKILL.md format
  return {
    name,
    description,
    body: document.body,
    manualOnly: document.metadata["disable-model-invocation"] === true,
    openCodeCompatibility: false,
  };
}

// Tool-specific sidecar files that must not be passed through verbatim to other
// tools. SKILL.md is handled separately (it is translated, not copied). The
// agents/openai.yaml file is a Codex-specific policy file that renderSkill
// re-synthesises from model.manualOnly; copying it to non-Codex targets would
// be wrong. Add entries here when a new tool introduces its own sidecar format.
const SKILL_TOOL_SIDECARS = ["SKILL.md", "agents/openai.yaml"] as const;

function isSkillSidecar(filePath: string, sidecar: string): boolean {
  return filePath === sidecar || filePath.endsWith(`/${sidecar}`);
}

function renderSkill(
  targetTool: SkillTool,
  model: SkillModel,
  options: BundleTranslationOptions = {},
  files: Record<string, string> = {},
): Record<string, string> {
  const name = options.name ?? model.name;
  const description = options.description ?? model.description;

  if (targetTool === "codex") {
    const skillBasePath = skillDirectoryPath("codex", name);
    const result: Record<string, string> = {
      [`${skillBasePath}/SKILL.md`]: renderMarkdownDocument({
        metadata: { name, description },
        body: model.body,
      }),
    };

    if (model.manualOnly) {
      result[`${skillBasePath}/agents/openai.yaml`] =
        renderCodexSkillPolicy(false);
    }

    return { ...result, ...passthroughSkillFiles(files, skillBasePath) };
  }

  if (targetTool === "opencode") {
    if (model.manualOnly) {
      return {
        [commandFilePath("opencode", name)]: renderMarkdownDocument({
          metadata: { description },
          body: model.body,
        }),
      };
    }

    const skillBasePath = skillDirectoryPath("opencode", name);
    return {
      [skillFilePath("opencode", name)]: renderMarkdownDocument({
        metadata: { name, description, compatibility: "opencode" },
        body: model.body,
      }),
      ...passthroughSkillFiles(files, skillBasePath),
    };
  }

  // claude, cursor, copilot, kiro, antigravity — all use the same SKILL.md format
  const metadata: MetadataMap = { name, description };

  if (model.manualOnly) {
    metadata["disable-model-invocation"] = true;
  }

  const skillBasePath = skillDirectoryPath(targetTool, name);
  return {
    [skillFilePath(targetTool, name)]: renderMarkdownDocument({
      metadata,
      body: model.body,
    }),
    ...passthroughSkillFiles(files, skillBasePath),
  };
}

function passthroughSkillFiles(
  files: Record<string, string>,
  targetSkillBasePath: string,
): Record<string, string> {
  const entries = Object.entries(files);

  // Derive the installed-path prefix from the SKILL.md entry in one pass.
  const prefix =
    "SKILL.md" in files
      ? ""
      : (entries
          .find(([k]) => k.endsWith("/SKILL.md"))?.[0]
          .slice(0, -"SKILL.md".length) ?? "");

  const result: Record<string, string> = {};

  for (const [filePath, content] of entries) {
    if (SKILL_TOOL_SIDECARS.some((s) => isSkillSidecar(filePath, s))) continue;
    const relPath = prefix ? filePath.slice(prefix.length) : filePath;
    result[`${targetSkillBasePath}/${relPath}`] = content;
  }

  return result;
}

function parseCommand(sourceTool: CommandTool, source: string): CommandModel {
  if (sourceTool === "cursor") {
    return {
      body: source,
      manualOnly: true,
    };
  }

  const document = parseMarkdownDocument(source);

  return {
    body: document.body,
    description: coerceOptionalString(document.metadata.description),
    agent: coerceOptionalString(document.metadata.agent),
    model: coerceOptionalString(document.metadata.model),
    manualOnly: true,
  };
}

function renderCommand(
  targetTool: CommandTool | "codex",
  model: CommandModel,
  options: BundleTranslationOptions = {},
): Record<string, string> {
  const commandName = requireOption(options.name, "name");

  if (targetTool === "cursor") {
    return { [commandFilePath("cursor", commandName)]: model.body };
  }

  if (targetTool === "claude") {
    const metadata: MetadataMap = {};

    if (options.description ?? model.description) {
      metadata.description = options.description ?? model.description!;
    }

    if (model.manualOnly) {
      metadata["disable-model-invocation"] = true;
    }

    return {
      [commandFilePath("claude", commandName)]: renderMarkdownDocument({
        metadata,
        body: model.body,
      }),
    };
  }

  if (targetTool === "opencode" || targetTool === "antigravity") {
    const metadata: MetadataMap = {};

    if (options.description ?? model.description) {
      metadata.description = options.description ?? model.description!;
    }

    if (targetTool === "opencode") {
      if (model.agent) {
        metadata.agent = model.agent;
      }

      if (model.model) {
        metadata.model = model.model;
      }
    }

    return {
      [commandFilePath(targetTool, commandName)]:
        Object.keys(metadata).length === 0
          ? model.body
          : renderMarkdownDocument({
              metadata,
              body: model.body,
            }),
    };
  }

  return {
    [`${skillDirectoryPath("codex", commandName)}/SKILL.md`]:
      renderMarkdownDocument({
        metadata: {
          name: commandName,
          description:
            options.description ?? model.description ?? "Translated command",
        },
        body: model.body,
      }),
    [`${skillDirectoryPath("codex", commandName)}/agents/openai.yaml`]:
      renderCodexSkillPolicy(false),
  };
}

function parseAgent(sourceTool: AgentTool, source: string): AgentModel {
  if (sourceTool === "codex") {
    const agent = parseCodexAgent(source);
    return {
      name: agent.name,
      description: agent.description,
      body: agent.developerInstructions,
      model: agent.model,
    };
  }

  const document = parseMarkdownDocument(source);
  return {
    name: coerceRequiredString(document.metadata.name, "name"),
    description: coerceRequiredString(
      document.metadata.description,
      "description",
    ),
    body: document.body,
    model: coerceOptionalString(document.metadata.model),
    mode: coerceOptionalString(document.metadata.mode),
  };
}

function renderAgent(
  targetTool: AgentTool,
  model: AgentModel,
): Record<string, string> {
  if (targetTool === "codex") {
    return {
      [agentFilePath("codex", model.name)]: renderCodexAgent({
        name: model.name,
        description: model.description,
        developerInstructions: model.body,
        model: model.model,
      }),
    };
  }

  const metadata: MetadataMap = {
    name: model.name,
    description: model.description,
  };

  if (model.model) {
    metadata.model = model.model;
  }

  if (targetTool === "opencode") {
    metadata.mode = "subagent";
  }

  return {
    [agentFilePath(targetTool, model.name)]: renderMarkdownDocument({
      metadata,
      body: model.body,
    }),
  };
}

function parseMarkdownDocument(source: string): MarkdownDocument {
  if (!source.startsWith("---\n")) {
    return { metadata: {}, body: source };
  }

  const endMarkerIndex = source.indexOf("\n---\n", 4);

  if (endMarkerIndex === -1) {
    throw new Error("Document must contain a closing YAML frontmatter marker");
  }

  const frontmatter = source.slice(4, endMarkerIndex);
  const body = source.slice(endMarkerIndex + "\n---\n".length);
  return {
    metadata: parseYamlMap(frontmatter),
    body: body.replace(/^\n/, ""),
  };
}

function renderMarkdownDocument(document: MarkdownDocument): string {
  if (Object.keys(document.metadata).length === 0) {
    return document.body;
  }

  return `---\n${renderYamlMap(document.metadata)}\n---\n${document.body}`;
}

function parseYamlMap(source: string): MetadataMap {
  const root: MetadataMap = {};
  const stack: Array<{
    indent: number;
    map: MetadataMap;
    lastKey?: string;
    lastKeyIndent?: number;
  }> = [{ indent: -1, map: root }];

  for (const rawLine of source.split("\n")) {
    if (rawLine.trim() === "") {
      continue;
    }

    const listMatch = rawLine.match(/^(\s*)- (.+)$/);
    if (listMatch) {
      const listIndent = listMatch[1].length;
      const item = String(parseScalarValue(listMatch[2].trim()));
      // Walk back to the deepest frame whose key was set at a lesser indent
      // than the list item (so a bare `- item` at column 0 never attaches to
      // a key that also lives at column 0).
      for (let i = stack.length - 1; i >= 0; i--) {
        const frame = stack[i];
        if (
          frame.lastKey !== undefined &&
          frame.lastKeyIndent !== undefined &&
          frame.lastKeyIndent < listIndent
        ) {
          const existing = frame.map[frame.lastKey];
          if (Array.isArray(existing)) {
            existing.push(item);
          } else {
            frame.map[frame.lastKey] = [item];
            // Drop the MetadataMap placeholder pushed for this key.
            while (stack.length > i + 1) stack.pop();
          }
          break;
        }
      }
      continue;
    }

    const match = rawLine.match(/^(\s*)([^:]+):(.*)$/);

    if (!match) {
      throw new Error(`Invalid frontmatter line: ${rawLine}`);
    }

    const indent = match[1].length;
    const key = match[2].trim();
    const rawValue = match[3].trim();

    while (stack.at(-1)!.indent >= indent) {
      stack.pop();
    }

    const frame = stack.at(-1)!;
    frame.lastKey = key;
    frame.lastKeyIndent = indent;

    if (rawValue === "") {
      const child: MetadataMap = {};
      frame.map[key] = child;
      stack.push({ indent, map: child });
      continue;
    }

    frame.map[key] = parseScalarValue(rawValue);
  }

  return root;
}

function renderYamlMap(map: MetadataMap, indent = 0): string {
  return Object.entries(map)
    .map(([key, value]) => {
      const prefix = `${" ".repeat(indent)}${key}:`;

      if (isMetadataMap(value)) {
        return `${prefix}\n${renderYamlMap(value, indent + 2)}`;
      }

      if (Array.isArray(value)) {
        const items = value
          .map((item) => `${" ".repeat(indent + 2)}- ${item}`)
          .join("\n");
        return `${prefix}\n${items}`;
      }

      return `${prefix} ${String(value)}`;
    })
    .join("\n");
}

function parseScalarValue(value: string): ScalarValue {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function parseCodexSkillPolicy(source?: string): boolean | undefined {
  if (!source) {
    return undefined;
  }

  const match = source.match(/allow_implicit_invocation:\s*(true|false)/);
  return match ? match[1] === "true" : undefined;
}

function findFileBySuffix(
  files: Record<string, string>,
  suffix: string,
): string | undefined {
  if (suffix in files) {
    return files[suffix];
  }

  const matches = Object.entries(files).filter(([filePath]) =>
    filePath.endsWith(`/${suffix}`),
  );

  if (matches.length === 0) {
    return undefined;
  }

  if (matches.length > 1) {
    throw new Error(`Expected exactly one ${suffix} file`);
  }

  return matches[0][1];
}

function renderCodexSkillPolicy(allowImplicitInvocation: boolean): string {
  return `policy:\n  allow_implicit_invocation: ${allowImplicitInvocation}\n`;
}

function skillDirectoryPath(tool: SkillTool, name: string): string {
  return `${targetBasePath(tool, "skills")}/${name}`;
}

function skillFilePath(
  tool: Exclude<SkillTool, "codex">,
  name: string,
): string {
  return `${skillDirectoryPath(tool, name)}/SKILL.md`;
}

function commandFilePath(tool: CommandTool, name: string): string {
  return `${targetBasePath(tool, "commands")}/${name}.md`;
}

function agentFilePath(tool: AgentTool, name: string): string {
  if (tool === "codex") return `${targetBasePath(tool, "agents")}/${name}.toml`;
  if (tool === "copilot")
    return `${targetBasePath(tool, "agents")}/${name}.agent.md`;
  return `${targetBasePath(tool, "agents")}/${name}.md`;
}

function rootInstructionFilePath(tool: RootInstructionTool): string {
  return targetBasePath(tool, "root_instruction");
}

function targetBasePath(
  tool: SkillTool | CommandTool | AgentTool | RootInstructionTool,
  target: ToolTargetName,
): string {
  const path = getToolDefinition(toToolMappingName(tool))?.targets[target]
    ?.path;

  if (!path) {
    return unsupportedTargetPath(tool, target);
  }

  return path;
}

function unsupportedTargetPath(tool: string, target: string): never {
  throw new Error(`Unsupported ${target} target for ${tool}`);
}

/** Maps a ToolName (e.g. "claude-code") to the internal translation name (e.g. "claude"). */
export function toTranslationToolName(toolName: ToolName): SkillTool {
  if (toolName === "claude-code") return "claude";
  return toolName;
}

function toToolMappingName(
  tool: SkillTool | CommandTool | AgentTool | RootInstructionTool,
): ToolName {
  if (tool === "claude") {
    return "claude-code";
  }

  return tool as ToolName;
}

function parseCodexAgent(source: string): CodexAgentDocument {
  return {
    name: parseTomlString(source, "name"),
    description: parseTomlString(source, "description"),
    developerInstructions: parseTomlMultilineString(
      source,
      "developer_instructions",
    ),
    model: parseTomlOptionalString(source, "model"),
    sandboxMode: parseTomlOptionalString(source, "sandbox_mode"),
  };
}

function renderCodexAgent(document: CodexAgentDocument): string {
  const lines = [
    `name = ${renderTomlString(document.name)}`,
    `description = ${renderTomlString(document.description)}`,
  ];

  if (document.model) {
    lines.push(`model = ${renderTomlString(document.model)}`);
  }

  if (document.sandboxMode) {
    lines.push(`sandbox_mode = ${renderTomlString(document.sandboxMode)}`);
  }

  lines.push(
    `developer_instructions = ${renderTomlMultilineString(document.developerInstructions)}`,
    "",
  );
  return lines.join("\n");
}

function parseTomlOptionalString(
  source: string,
  key: string,
): string | undefined {
  const match = source.match(
    new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"]*)"`, "m"),
  );
  return match?.[1];
}

function parseTomlString(source: string, key: string): string {
  const value = parseTomlOptionalString(source, key);

  if (!value) {
    throw new Error(`${key} is required`);
  }

  return value;
}

function parseTomlMultilineString(source: string, key: string): string {
  const match = source.match(
    new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"""\\n([\\s\\S]*?)"""`, "m"),
  );

  if (!match) {
    throw new Error(`${key} is required`);
  }

  return match[1];
}

function renderTomlString(value: string): string {
  return JSON.stringify(value);
}

function renderTomlMultilineString(value: string): string {
  return `"""\n${value.replaceAll('"""', '\\"\\"\\"')}"""`;
}

function coerceRequiredString(
  value: MetadataValue | undefined,
  label: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }

  return value;
}

function coerceOptionalString(
  value: MetadataValue | undefined,
): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function requireOption(value: string | undefined, label: string): string {
  if (!value || value.trim() === "") {
    throw new Error(`${label} is required`);
  }

  return value;
}

function isMetadataMap(value: MetadataValue): value is MetadataMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
