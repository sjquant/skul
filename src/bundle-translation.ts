import { getToolDefinition, type ToolName, type ToolTargetName } from "./tool-mapping";

type ScalarValue = string | boolean;
type MetadataValue = ScalarValue | MetadataMap;

interface MetadataMap {
  [key: string]: MetadataValue;
}

type SkillTool = "claude" | "cursor" | "codex" | "opencode";
type CommandTool = "claude" | "cursor" | "opencode";
type AgentTool = "claude" | "codex" | "opencode";

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

export function translateSkill(options: {
  sourceTool: SkillTool;
  targetTool: SkillTool;
  files: Record<string, string>;
  options?: BundleTranslationOptions;
}): Record<string, string> {
  const model = parseSkill(options.sourceTool, options.files);
  return renderSkill(options.targetTool, model, options.options);
}

export function translateCommand(options: {
  sourceTool: CommandTool;
  targetTool: CommandTool | "codex";
  source: string;
  options?: BundleTranslationOptions;
}): Record<string, string> {
  const model = parseCommand(options.sourceTool, options.source);
  return renderCommand(options.targetTool, model, options.options);
}

export function translateAgent(options: {
  sourceTool: AgentTool;
  targetTool: AgentTool;
  source: string;
}): Record<string, string> {
  const model = parseAgent(options.sourceTool, options.source);
  return renderAgent(options.targetTool, model);
}

function parseSkill(sourceTool: SkillTool, files: Record<string, string>): SkillModel {
  const skillSource = findFileBySuffix(files, "SKILL.md");

  if (!skillSource) {
    throw new Error("SKILL.md is required");
  }

  const document = parseMarkdownDocument(skillSource);

  if (sourceTool === "claude" || sourceTool === "cursor") {
    return {
      name: coerceRequiredString(document.metadata.name, "name"),
      description: coerceRequiredString(document.metadata.description, "description"),
      body: document.body,
      manualOnly: document.metadata["disable-model-invocation"] === true,
      openCodeCompatibility: false,
    };
  }

  if (sourceTool === "codex") {
    return {
      name: coerceRequiredString(document.metadata.name, "name"),
      description: coerceRequiredString(document.metadata.description, "description"),
      body: document.body,
      manualOnly: parseCodexSkillPolicy(findFileBySuffix(files, "agents/openai.yaml")) === false,
      openCodeCompatibility: false,
    };
  }

  return {
    name: coerceRequiredString(document.metadata.name, "name"),
    description: coerceRequiredString(document.metadata.description, "description"),
    body: document.body,
    manualOnly: false,
    openCodeCompatibility: document.metadata.compatibility === "opencode",
  };
}

function renderSkill(
  targetTool: SkillTool,
  model: SkillModel,
  options: BundleTranslationOptions = {},
): Record<string, string> {
  if (targetTool === "claude") {
    const metadata: MetadataMap = {
      name: model.name,
      description: model.description,
    };

    if (model.manualOnly) {
      metadata["disable-model-invocation"] = true;
    }

    return {
      [skillFilePath("claude", model.name)]: renderMarkdownDocument({ metadata, body: model.body }),
    };
  }

  if (targetTool === "cursor") {
    const metadata: MetadataMap = {
      name: model.name,
      description: model.description,
    };

    if (model.manualOnly) {
      metadata["disable-model-invocation"] = true;
    }

    return {
      [skillFilePath("cursor", model.name)]: renderMarkdownDocument({ metadata, body: model.body }),
    };
  }

  if (targetTool === "codex") {
    const skillBasePath = skillDirectoryPath("codex", model.name);
    const files: Record<string, string> = {
      [`${skillBasePath}/SKILL.md`]: renderMarkdownDocument({
        metadata: {
          name: model.name,
          description: model.description,
        },
        body: model.body,
      }),
    };

    if (model.manualOnly) {
      files[`${skillBasePath}/agents/openai.yaml`] = renderCodexSkillPolicy(false);
    }

    return files;
  }

  if (targetTool === "opencode") {
    if (model.manualOnly) {
      return {
        [commandFilePath("opencode", model.name)]: renderMarkdownDocument({
          metadata: {
            description: model.description,
          },
          body: model.body,
        }),
      };
    }

    return {
      [skillFilePath("opencode", model.name)]: renderMarkdownDocument({
        metadata: {
          name: model.name,
          description: model.description,
          compatibility: "opencode",
        },
        body: model.body,
      }),
    };
  }

  throw new Error(`Unsupported skill target: ${targetTool}`);
}

function parseCommand(sourceTool: CommandTool, source: string): CommandModel {
  if (sourceTool === "cursor") {
    return {
      body: source,
      manualOnly: true,
    };
  }

  const document = parseMarkdownDocument(source);

  if (sourceTool === "claude") {
    return {
      body: document.body,
      description: coerceOptionalString(document.metadata.description),
      agent: coerceOptionalString(document.metadata.agent),
      model: coerceOptionalString(document.metadata.model),
      manualOnly: true,
    };
  }

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

  if (targetTool === "opencode") {
    const metadata: MetadataMap = {};

    if (options.description ?? model.description) {
      metadata.description = options.description ?? model.description!;
    }

    if (model.agent) {
      metadata.agent = model.agent;
    }

    if (model.model) {
      metadata.model = model.model;
    }

    return {
      [commandFilePath("opencode", commandName)]:
        Object.keys(metadata).length === 0
          ? model.body
          : renderMarkdownDocument({
              metadata,
              body: model.body,
            }),
    };
  }

  return {
    [`${skillDirectoryPath("codex", commandName)}/SKILL.md`]: renderMarkdownDocument({
      metadata: {
        name: commandName,
        description: options.description ?? model.description ?? "Translated command",
      },
      body: model.body,
    }),
    [`${skillDirectoryPath("codex", commandName)}/agents/openai.yaml`]: renderCodexSkillPolicy(false),
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
    description: coerceRequiredString(document.metadata.description, "description"),
    body: document.body,
    model: coerceOptionalString(document.metadata.model),
    mode: coerceOptionalString(document.metadata.mode),
  };
}

function renderAgent(targetTool: AgentTool, model: AgentModel): Record<string, string> {
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
  const stack: Array<{ indent: number; value: MetadataMap }> = [{ indent: -1, value: root }];

  for (const rawLine of source.split("\n")) {
    if (rawLine.trim() === "") {
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

    const parent = stack.at(-1)!.value;

    if (rawValue === "") {
      const child: MetadataMap = {};
      parent[key] = child;
      stack.push({ indent, value: child });
      continue;
    }

    parent[key] = parseScalarValue(rawValue);
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

  return value;
}

function parseCodexSkillPolicy(source?: string): boolean | undefined {
  if (!source) {
    return undefined;
  }

  const match = source.match(/allow_implicit_invocation:\s*(true|false)/);
  return match ? match[1] === "true" : undefined;
}

function findFileBySuffix(files: Record<string, string>, suffix: string): string | undefined {
  if (suffix in files) {
    return files[suffix];
  }

  const matches = Object.entries(files).filter(([filePath]) => filePath.endsWith(`/${suffix}`));

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

function skillFilePath(tool: Exclude<SkillTool, "codex">, name: string): string {
  return `${skillDirectoryPath(tool, name)}/SKILL.md`;
}

function commandFilePath(tool: CommandTool, name: string): string {
  return `${targetBasePath(tool, "commands")}/${name}.md`;
}

function agentFilePath(tool: AgentTool, name: string): string {
  return `${targetBasePath(tool, "agents")}/${name}.${tool === "codex" ? "toml" : "md"}`;
}

function targetBasePath(tool: SkillTool | CommandTool | AgentTool, target: ToolTargetName): string {
  const path = getToolDefinition(toToolMappingName(tool))?.targets[target]?.path;

  if (!path) {
    return unsupportedTargetPath(tool, target);
  }

  return path;
}

function unsupportedTargetPath(tool: string, target: string): never {
  throw new Error(`Unsupported ${target} target for ${tool}`);
}

function toToolMappingName(tool: SkillTool | CommandTool | AgentTool): ToolName {
  if (tool === "claude") {
    return "claude-code";
  }

  return tool;
}

function parseCodexAgent(source: string): CodexAgentDocument {
  return {
    name: parseTomlString(source, "name"),
    description: parseTomlString(source, "description"),
    developerInstructions: parseTomlMultilineString(source, "developer_instructions"),
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

  lines.push(`developer_instructions = ${renderTomlMultilineString(document.developerInstructions)}`, "");
  return lines.join("\n");
}

function parseTomlOptionalString(source: string, key: string): string | undefined {
  const match = source.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"]*)"`, "m"));
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

function coerceRequiredString(value: MetadataValue | undefined, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }

  return value;
}

function coerceOptionalString(value: MetadataValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function requireOption(value: string | undefined, label: string): string {
  if (!value || value.trim() === "") {
    throw new Error(`${label} is required`);
  }

  return value;
}

function isMetadataMap(value: MetadataValue): value is MetadataMap {
  return typeof value === "object" && value !== null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
