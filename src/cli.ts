import { Command, CommanderError } from "commander";
import {
  detectSourceProtocol,
  normalizeBundleSource,
} from "./bundle-discovery";
import {
  type BundleItemSelector,
  normalizeBundleItemSelector,
} from "./bundle-items";
import { listToolDefinitions, type ToolName } from "./tool-mapping";

const VALID_TOOL_NAMES = new Set<string>(
  listToolDefinitions().map((t) => t.name),
);

export type CommandName =
  | "add"
  | "list"
  | "status"
  | "check"
  | "update"
  | "prune"
  | "shadow"
  | "sync"
  | "reset"
  | "remove"
  | "apply"
  | "clear-cache";

export type CliParseResult =
  | { kind: "help"; command?: CommandName }
  | {
      kind: "command";
      command: "list";
      options: { json: boolean; source?: string };
    }
  | {
      kind: "command";
      command: "status";
      options: { json: boolean; global: boolean };
    }
  | {
      kind: "command";
      command: "check";
      options: { bundle?: string; json: boolean };
    }
  | {
      kind: "command";
      command: "update";
      options: { bundle?: string; dryRun: boolean };
    }
  | { kind: "command"; command: "prune"; options: Record<string, never> }
  | {
      kind: "command";
      command: "shadow";
      options: { action: "suspend" | "refresh" };
    }
  | { kind: "command"; command: "sync"; options: Record<string, never> }
  | {
      kind: "command";
      command: "apply";
      options: { dryRun: boolean; global: boolean };
    }
  | {
      kind: "command";
      command: "reset";
      options: { dryRun: boolean; global: boolean };
    }
  | {
      kind: "command";
      command: "clear-cache";
      options: { source?: string; all: boolean; dryRun: boolean };
    }
  | {
      kind: "command";
      command: "add";
      options: {
        bundle: string;
        source?: string;
        protocol: "https" | "ssh";
        agents: ToolName[];
        includeItems?: BundleItemSelector[];
        selectItems?: boolean;
        dryRun: boolean;
        ref?: string;
        inferredBundleFromSource?: true;
        global: boolean;
      };
    }
  | {
      kind: "command";
      command: "remove";
      options: {
        bundle?: string;
        source?: string;
        includeItems?: BundleItemSelector[];
        selectItems?: boolean;
        dryRun: boolean;
        inferredBundleFromSource?: true;
        global: boolean;
      };
    };

export type FileConflictResolution = { action: "overwrite" };

export interface BundleSelection {
  bundle: string;
  source?: string;
  protocol?: "https" | "ssh";
}

export interface BundleItemChoice {
  value: string;
  label: string;
}

export interface PromptClient {
  selectBundle(
    source?: string,
    requestedTools?: ToolName[],
  ): Promise<BundleSelection>;
  selectBundleFromSelections(
    availableBundles: BundleSelection[],
    source?: string,
  ): Promise<BundleSelection>;
  selectBundleItems(
    availableItems: BundleItemSelector[],
    selectedItems: BundleItemSelector[],
    purpose?: "install" | "remove",
  ): Promise<BundleItemSelector[]>;
  selectBundleItemChoices(
    availableItems: BundleItemChoice[],
    selectedItems: string[],
    purpose?: "install" | "remove",
  ): Promise<string[]>;
  selectAgents(availableAgents: ToolName[]): Promise<ToolName[]>;
  resolveFileConflict(conflictPath: string): Promise<FileConflictResolution>;
  confirmManagedFileRemoval(
    conflictPath: string,
    operation: "reset" | "replace" | "remove",
  ): Promise<boolean>;
}

const COMMANDS: CommandName[] = [
  "add",
  "list",
  "status",
  "check",
  "update",
  "prune",
  "shadow",
  "sync",
  "reset",
  "remove",
  "apply",
  "clear-cache",
];
const COMMAND_ALIASES: Record<string, CommandName> = {
  gc: "prune",
};
const PROGRAM_HELP_DETAILS = [
  "",
  "Advanced commands (run 'skul <command> --help' for details):",
  "  check, update, sync, shadow, reset, clear-cache, prune",
  "  See docs/advanced.md for maintenance, recovery, and cleanup flows.",
  "",
  "Root instructions:",
  "  cursor, codex, opencode, kiro, copilot, and antigravity target AGENTS.md; globally, codex targets .codex/AGENTS.md, opencode targets .config/opencode/AGENTS.md, kiro targets .kiro/steering/AGENTS.md, copilot targets .github/copilot-instructions.md, and antigravity targets .gemini/GEMINI.md; claude-code targets CLAUDE.md.",
  "  Untracked root instructions are composed locally and hidden through .git/info/exclude.",
  "  Tracked root instructions are rendered from HEAD plus Skul overlay content and marked skip-worktree.",
  "",
  "Safety and recovery:",
  "  Use 'skul sync' for fast-forward pulls. For manual git updates, run 'skul shadow --suspend' before and 'skul shadow --refresh' after, as long as the root instruction file is still tracked.",
  "  Shadow refresh refuses staged changes, unstaged edits, unmerged files, incompatible index flags, and manual edits to the current shadow render.",
  "  'skul status' reports tracked shadow health; manual edits to shadowed root instruction files are a current limitation.",
].join("\n");
const ADD_HELP_DETAILS = [
  "",
  "Root instruction targets:",
  "  Bundles may contribute root instruction files alongside skills/ and commands/ content.",
  "  If the target root instruction file is already tracked, Skul creates a tracked shadow instead of leaving a visible git diff.",
].join("\n");
const SHADOW_HELP_DETAILS = [
  "",
  "Lifecycle:",
  "  --suspend restores tracked root instruction files from HEAD and clears skip-worktree.",
  "  --refresh rebuilds the effective shadow from the latest HEAD plus Skul overlay content and re-enables skip-worktree.",
  "  The manual suspend/refresh flow only works when the root instruction file is still tracked after the Git update.",
  "  Refresh refuses staged changes, unstaged edits, unmerged files, incompatible index flags, and manual edits to the current shadow render.",
  "",
  "Examples:",
  "  skul shadow --suspend",
  "  git pull --ff-only",
  "  skul shadow --refresh",
].join("\n");
const SYNC_HELP_DETAILS = [
  "",
  "Lifecycle:",
  "  Typical workflow: skul shadow --suspend -> git pull --ff-only -> skul shadow --refresh",
  "  Prefer this in headless automation so tracked root instruction shadows are suspended and restored in one step.",
  "  If git pull fails, Skul attempts to restore the prior shadow state before returning the error.",
  "  If upstream stops tracking a shadowed root instruction, sync retires the shadow and removes its local state.",
].join("\n");
let clackPromptsModulePromise:
  | Promise<typeof import("@clack/prompts")>
  | undefined;
// Commander is loaded in CommonJS mode for the CLI entrypoint, so use a tiny
// dynamic-import bridge for the ESM-only @clack/prompts package.
const loadEsmModule = new Function(
  "specifier",
  "return import(specifier);",
) as (specifier: string) => Promise<unknown>;

/**
 * Returns true if the CLI should run in headless (non-interactive) mode.
 * Detected via the SKUL_NO_TUI environment variable.
 */
export function isHeadlessMode(): boolean {
  return (
    process.env["SKUL_NO_TUI"] === "1" || process.env["SKUL_NO_TUI"] === "true"
  );
}

/**
 * Creates a prompt client that throws immediately instead of opening interactive
 * prompts. Use this when SKUL_NO_TUI is set so agents never block waiting for input.
 */
export function createHeadlessPromptClient(): PromptClient {
  return {
    async selectBundle(source?: string): Promise<BundleSelection> {
      const hint = source ? `skul add ${source} <bundle>` : "skul add <bundle>";
      throw new Error(
        `Bundle name is required in headless mode.\nHint: run '${hint}' to specify the bundle explicitly`,
      );
    },
    async selectBundleFromSelections(
      _availableBundles: BundleSelection[],
      source?: string,
    ): Promise<BundleSelection> {
      const hint = source
        ? `skul remove ${source} <bundle>`
        : "skul remove <bundle>";
      throw new Error(
        `Bundle name is required in headless mode.\nHint: run '${hint}' to specify the bundle explicitly`,
      );
    },
    async selectBundleItems(): Promise<BundleItemSelector[]> {
      throw new Error(
        "Bundle item selection requires an interactive terminal.\nHint: rerun with --include <item> instead of --select-items",
      );
    },
    async selectBundleItemChoices(): Promise<string[]> {
      throw new Error(
        "Bundle item selection requires an interactive terminal.\nHint: rerun with --include <item> instead of --select-items",
      );
    },
    async selectAgents(availableAgents: ToolName[]): Promise<ToolName[]> {
      throw new Error(
        `Agent selection is required in headless mode.\nHint: run 'skul add --agent <name>' to specify agents explicitly. Available: ${availableAgents.join(", ")}`,
      );
    },
    async resolveFileConflict(
      conflictPath: string,
    ): Promise<FileConflictResolution> {
      throw new Error(
        `Conflict on ${conflictPath}: file already exists (headless mode)\nHint: run interactively to confirm overwrite`,
      );
    },
    async confirmManagedFileRemoval(
      conflictPath: string,
      operation: "reset" | "replace" | "remove",
    ): Promise<boolean> {
      throw new Error(
        `Modified managed file blocks ${operation} in headless mode: ${conflictPath}\nHint: run 'skul status' to inspect managed files, or run the command interactively to confirm`,
      );
    },
  };
}

/** Creates the interactive prompt client used by the terminal UI. */
export function createPromptClient(
  availableBundles: string[] = [],
): PromptClient {
  const bundleSelections = availableBundles.map((bundle) => ({ bundle }));
  return createPromptClientForSelections(bundleSelections);
}

/** Creates an interactive prompt client from richer bundle selection metadata. */
export function createPromptClientForSelections(
  availableBundles: BundleSelection[],
  loadPrompts: () => Promise<
    typeof import("@clack/prompts")
  > = loadClackPromptsModule,
): PromptClient {
  return {
    async selectBundle(source?: string): Promise<BundleSelection> {
      if (availableBundles.length === 0) {
        throw new Error(
          source
            ? `No bundles cached for ${source}. Run 'skul add ${source} <bundle>' to fetch one first`
            : "No bundles cached. Run 'skul add <source> <bundle>' to fetch one first",
        );
      }

      const { isCancel, select } = await loadPrompts();
      const choice = await select({
        message: source ? `Select a bundle from ${source}` : "Select a bundle",
        options: availableBundles.map((bundle) => ({
          value: bundle,
          label: formatBundleSelectionLabel(bundle, availableBundles),
        })),
      });

      if (isCancel(choice)) {
        throw new Error("Interactive bundle selection was cancelled");
      }

      return choice;
    },
    async selectBundleFromSelections(
      availableSelections: BundleSelection[],
      source?: string,
    ): Promise<BundleSelection> {
      return createPromptClientForSelections(
        availableSelections,
        loadPrompts,
      ).selectBundle(source);
    },
    async selectBundleItems(
      availableItems: BundleItemSelector[],
      selectedItems: BundleItemSelector[],
      purpose: "install" | "remove" = "install",
    ): Promise<BundleItemSelector[]> {
      return promptForBundleItemChoices(
        availableItems.map((item) => ({ value: item, label: item })),
        selectedItems,
        purpose,
        loadPrompts,
      );
    },
    async selectBundleItemChoices(
      availableItems: BundleItemChoice[],
      selectedItems: string[],
      purpose: "install" | "remove" = "install",
    ): Promise<string[]> {
      return promptForBundleItemChoices(
        availableItems,
        selectedItems,
        purpose,
        loadPrompts,
      );
    },
    async selectAgents(availableAgents: ToolName[]): Promise<ToolName[]> {
      if (availableAgents.length === 0) {
        throw new Error("This bundle has no available agents");
      }

      const { isCancel, multiselect } = await loadPrompts();
      const selected = await multiselect<ToolName>({
        message:
          "Choose agents to install for (Space toggles choices; Enter confirms)",
        options: availableAgents.map((agent) => ({
          value: agent,
          label: agent,
        })),
        required: true,
      });

      if (isCancel(selected)) {
        throw new Error("Agent selection was cancelled");
      }

      return selected;
    },
    async resolveFileConflict(
      conflictPath: string,
    ): Promise<FileConflictResolution> {
      const { isCancel, confirm } = await loadPrompts();

      const shouldOverwrite = await confirm({
        message: `${conflictPath} already exists — overwrite it?`,
      });

      if (isCancel(shouldOverwrite) || !shouldOverwrite) {
        throw new Error(
          `Conflict not resolved: ${conflictPath} already exists`,
        );
      }

      return { action: "overwrite" };
    },
    async confirmManagedFileRemoval(
      conflictPath: string,
      operation: "reset" | "replace" | "remove",
    ): Promise<boolean> {
      const { confirm, isCancel } = await loadPrompts();
      const message =
        operation === "replace"
          ? `Managed file was modified and must be removed before replacement: ${conflictPath}`
          : operation === "remove"
            ? `Managed file was modified and must be removed during bundle removal: ${conflictPath}`
            : `Managed file was modified and must be removed during reset: ${conflictPath}`;
      const confirmed = await confirm({
        message,
        initialValue: false,
      });

      if (isCancel(confirmed)) {
        throw new Error("Managed file removal confirmation was cancelled");
      }

      return confirmed;
    },
  };
}

async function promptForBundleItemChoices(
  availableItems: BundleItemChoice[],
  selectedItems: string[],
  purpose: "install" | "remove",
  loadPrompts: () => Promise<typeof import("@clack/prompts")>,
): Promise<string[]> {
  if (availableItems.length === 0) {
    throw new Error("This bundle has no selectable items");
  }

  const { isCancel, multiselect } = await loadPrompts();
  const choice = await multiselect({
    message: `Choose bundle items to ${purpose} (Space toggles choices; Enter confirms)`,
    options: availableItems,
    initialValues: selectedItems,
    required: true,
  });

  if (isCancel(choice)) {
    throw new Error("Interactive bundle item selection was cancelled");
  }

  return choice;
}

function loadClackPromptsModule(): Promise<typeof import("@clack/prompts")> {
  clackPromptsModulePromise ??= loadEsmModule("@clack/prompts") as Promise<
    typeof import("@clack/prompts")
  >;
  return clackPromptsModulePromise;
}

/** Renders CLI help text for either the full program or one subcommand. */
export function createHelpText(command?: CommandName): string {
  const output: string[] = [];
  const program = createProgram({
    selectBundle: async () => ({ bundle: "" }),
    selectBundleFromSelections: async (availableBundles) =>
      availableBundles[0] ?? { bundle: "" },
    selectBundleItems: async () => [],
    selectBundleItemChoices: async () => [],
    selectAgents: async (agents) => agents,
    resolveFileConflict: async () => ({ action: "overwrite" }),
    confirmManagedFileRemoval: async () => true,
  });
  const writeOutput = (chunk: string) => {
    output.push(chunk);
  };
  program.configureOutput({
    writeOut: writeOutput,
    writeErr: writeOutput,
  });

  if (command) {
    const subcommand = program.commands.find((c) => c.name() === command);
    if (subcommand) {
      subcommand.configureOutput({
        writeOut: writeOutput,
        writeErr: writeOutput,
      });
      subcommand.outputHelp();
      return output.join("");
    }
  }

  program.outputHelp();
  return output.join("");
}

/** Parses CLI arguments into a normalized command payload. */
export async function parseCliArgs(
  argv: string[],
  prompts: PromptClient = createPromptClient(),
): Promise<CliParseResult> {
  const [rawCommand] = argv;
  const command = rawCommand
    ? (COMMAND_ALIASES[rawCommand] ?? rawCommand)
    : rawCommand;

  if (
    !command ||
    command === "help" ||
    command === "-h" ||
    command === "--help"
  ) {
    return { kind: "help" };
  }

  if (!COMMANDS.includes(command as CommandName)) {
    const suggestion = findClosestCommand(command, COMMANDS);
    const hint = suggestion ? `, did you mean "${suggestion}"?` : "";
    throw new Error(`Unknown command: "${command}"${hint}`);
  }

  const normalizedArgv =
    rawCommand && rawCommand !== command ? [command, ...argv.slice(1)] : argv;
  const restArgs = normalizedArgv.slice(1);
  if (restArgs.includes("--help") || restArgs.includes("-h")) {
    return { kind: "help", command: command as CommandName };
  }

  const context: { result?: CliParseResult } = {};
  const program = createProgram(prompts, context);

  try {
    await program.parseAsync(normalizedArgv, { from: "user" });
  } catch (error) {
    throw normalizeParseError(error, command);
  }

  return context.result ?? { kind: "help" };
}

function collectToolOption(value: string, previous: ToolName[]): ToolName[] {
  if (!VALID_TOOL_NAMES.has(value)) {
    throw new Error(
      `Unknown tool: ${value}\nValid tools: ${Array.from(VALID_TOOL_NAMES).sort().join(", ")}`,
    );
  }

  if (previous.includes(value as ToolName)) {
    return previous;
  }

  return [...previous, value as ToolName];
}

function collectBundleItemOption(
  value: string,
  previous: BundleItemSelector[],
): BundleItemSelector[] {
  const normalized = normalizeBundleItemSelector(value);

  if (previous.includes(normalized)) {
    return previous;
  }

  return [...previous, normalized];
}

function normalizeRefSelector(value: string): string {
  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new Error("Ref selector must be a non-empty string");
  }

  return normalizedValue;
}

function normalizePinnedCommit(value: string): string {
  const normalizedValue = normalizeRefSelector(value);

  if (!/^[0-9a-f]{7,40}$/i.test(normalizedValue)) {
    throw new Error("--pin requires a 7-40 character hexadecimal commit SHA");
  }

  return normalizedValue;
}

function resolveRequestedRefSelector(options: {
  ref?: string;
  pin?: string;
}): string | undefined {
  if (options.ref !== undefined && options.pin !== undefined) {
    throw new Error("Command add accepts either --ref or --pin, not both");
  }

  if (options.pin !== undefined) {
    return normalizePinnedCommit(options.pin);
  }

  if (options.ref !== undefined) {
    return normalizeRefSelector(options.ref);
  }

  return undefined;
}

function createProgram(
  prompts: PromptClient,
  context: { result?: CliParseResult } = {},
): Command {
  const program = new Command();

  program
    .name("skul")
    .description(
      "Manage project-scoped AI configuration bundles\n\nEnv vars:\n  SKUL_NO_TUI=1   Run in headless/non-interactive mode (auto-resolves prompts)",
    )
    .addHelpText("after", PROGRAM_HELP_DETAILS)
    .helpCommand(false)
    .configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined,
    })
    .exitOverride();

  program
    .command("add")
    .description(
      "Add a bundle to the active set and materialize its files or root instructions",
    )
    .argument("[source]", "Bundle source (e.g. github.com/user/repo)")
    .argument("[bundle]", "Bundle name")
    .option(
      "-a, --agent <name>",
      "Select a specific tool to materialize (repeatable)",
      collectToolOption,
      [] as ToolName[],
    )
    .option(
      "--ref <selector>",
      "Track a specific branch, tag, or commit instead of remote HEAD",
    )
    .option("--pin <commit>", "Pin the bundle to an exact commit SHA")
    .option(
      "--include <item>",
      "Install only a bundle item such as skills/name, agents/name, commands/name, or root-instruction (repeatable)",
      collectBundleItemOption,
      [] as BundleItemSelector[],
    )
    .option(
      "--select-items",
      "Choose bundle items interactively before installing",
    )
    .option(
      "-n, --dry-run",
      "Preview what would be written without making any changes",
    )
    .option("-s, --ssh", "Clone the bundle source using SSH instead of HTTPS")
    .option("-g, --global", "Install to global tool config under ~/")
    .addHelpText("after", ADD_HELP_DETAILS)
    .action(
      async (
        source: string | undefined,
        bundle: string | undefined,
        opts: {
          agent: ToolName[];
          ref?: string;
          pin?: string;
          include: BundleItemSelector[];
          selectItems?: boolean;
          dryRun?: boolean;
          ssh?: boolean;
          global?: boolean;
        },
      ) => {
        const agents = opts.agent;
        const includeItems = opts.include;
        const selectItems = opts.selectItems ?? false;
        const dryRun = opts.dryRun ?? false;
        const global = opts.global ?? false;
        const ref = resolveRequestedRefSelector(opts);

        if (!source && !bundle) {
          throw new Error(
            "Command add requires a source or bundle name\nHint: run 'skul add <source>' to select a bundle from that source, or 'skul add <bundle>' for a cached unique bundle",
          );
        }

        if (source && !bundle) {
          // If the single argument looks like a git source (host/owner/repo), treat the
          // repo slug as the bundle name so `skul add github.com/user/react-bundle` works.
          try {
            const detectedProtocol = opts.ssh
              ? "ssh"
              : detectSourceProtocol(source);
            const normalizedSource = normalizeBundleSource(source);
            const repoSlug = normalizedSource.split("/").at(-1)!;
            context.result = {
              kind: "command",
              command: "add",
              options: {
                source: normalizedSource,
                bundle: repoSlug,
                protocol: detectedProtocol,
                agents,
                ...(includeItems.length > 0 ? { includeItems } : {}),
                ...(selectItems ? { selectItems } : {}),
                dryRun,
                ...(ref !== undefined ? { ref } : {}),
                inferredBundleFromSource: true,
                global,
              },
            };
          } catch {
            // Not a valid source — treat as a plain bundle name.
            context.result = {
              kind: "command",
              command: "add",
              options: {
                bundle: source,
                protocol: "https",
                agents,
                ...(includeItems.length > 0 ? { includeItems } : {}),
                ...(selectItems ? { selectItems } : {}),
                dryRun,
                ...(ref !== undefined ? { ref } : {}),
                global,
              },
            };
          }
          return;
        }

        const explicitSource = source!;
        const detectedProtocol = opts.ssh
          ? "ssh"
          : detectSourceProtocol(explicitSource);
        const normalizedSource = normalizeBundleSource(explicitSource);

        context.result = {
          kind: "command",
          command: "add",
          options: {
            source: normalizedSource,
            bundle: bundle!,
            protocol: detectedProtocol,
            agents,
            ...(includeItems.length > 0 ? { includeItems } : {}),
            ...(selectItems ? { selectItems } : {}),
            dryRun,
            ...(ref !== undefined ? { ref } : {}),
            global,
          },
        };
      },
    );

  program
    .command("list")
    .description("List available bundles in the local library")
    .option("-j, --json", "Output as JSON (for scripting and agent use)")
    .option("-s, --source <source>", "Filter results to a single cached source")
    .action((opts: { json?: boolean; source?: string }) => {
      context.result = {
        kind: "command",
        command: "list",
        options: {
          json: opts.json ?? false,
          ...(opts.source !== undefined
            ? { source: normalizeBundleSource(opts.source) }
            : {}),
        },
      };
    });

  program
    .command("status")
    .description(
      "Show desired state, current worktree materialization, and tracked root-instruction shadow health",
    )
    .option("-j, --json", "Output as JSON (for scripting and agent use)")
    .option("-g, --global", "Show global tool config state")
    .action((opts: { json?: boolean; global?: boolean }) => {
      context.result = {
        kind: "command",
        command: "status",
        options: { json: opts.json ?? false, global: opts.global ?? false },
      };
    });

  program
    .command("check", { hidden: true })
    .description("Check remote-backed bundles for upstream updates")
    .argument("[bundle]", "Bundle name to check")
    .option("-j, --json", "Output as JSON (for scripting and agent use)")
    .action((bundle: string | undefined, opts: { json?: boolean }) => {
      context.result = {
        kind: "command",
        command: "check",
        options: {
          ...(bundle !== undefined ? { bundle } : {}),
          json: opts.json ?? false,
        },
      };
    });

  program
    .command("update", { hidden: true })
    .description("Update remote-backed bundles to the latest upstream revision")
    .argument("[bundle]", "Bundle name to update")
    .option(
      "-n, --dry-run",
      "Preview what would be updated without making any changes",
    )
    .action((bundle: string | undefined, opts: { dryRun?: boolean }) => {
      context.result = {
        kind: "command",
        command: "update",
        options: {
          ...(bundle !== undefined ? { bundle } : {}),
          dryRun: opts.dryRun ?? false,
        },
      };
    });

  program
    .command("prune", { hidden: true })
    .alias("gc")
    .description(
      "Remove stale registry entries for deleted worktrees and orphaned repositories",
    )
    .action(() => {
      context.result = { kind: "command", command: "prune", options: {} };
    });
  const shadowCommand = program
    .command("shadow", { hidden: true })
    .description("Suspend or refresh tracked root instruction shadows")
    .option(
      "--suspend",
      "Restore tracked root instructions from HEAD and clear skip-worktree",
    )
    .option(
      "--refresh",
      "Rebuild tracked root-instruction shadows from HEAD and re-enable skip-worktree",
    )
    .addHelpText("after", SHADOW_HELP_DETAILS)
    .action((opts: { suspend?: boolean; refresh?: boolean }) => {
      if (opts.suspend === opts.refresh) {
        throw new Error(
          "Command shadow requires exactly one of --suspend or --refresh",
        );
      }

      context.result = {
        kind: "command",
        command: "shadow",
        options: { action: opts.suspend ? "suspend" : "refresh" },
      };
    });

  const syncCommand = program
    .command("sync", { hidden: true })
    .description(
      "Safely pull git updates around tracked root instruction shadows",
    )
    .addHelpText("after", SYNC_HELP_DETAILS)
    .action(() => {
      context.result = { kind: "command", command: "sync", options: {} };
    });

  program
    .command("apply")
    .description(
      "Materialize all desired-state bundles into the current worktree",
    )
    .option(
      "-n, --dry-run",
      "Preview what would be written without making any changes",
    )
    .option("-g, --global", "Apply global desired-state bundles")
    .action((opts: { dryRun?: boolean; global?: boolean }) => {
      context.result = {
        kind: "command",
        command: "apply",
        options: { dryRun: opts.dryRun ?? false, global: opts.global ?? false },
      };
    });

  program
    .command("reset", { hidden: true })
    .description(
      "Remove all Skul-managed files and restore tracked root instructions in the current worktree",
    )
    .option(
      "-n, --dry-run",
      "Preview what would be deleted without removing any files",
    )
    .option("-g, --global", "Reset globally managed tool config")
    .action((opts: { dryRun?: boolean; global?: boolean }) => {
      context.result = {
        kind: "command",
        command: "reset",
        options: { dryRun: opts.dryRun ?? false, global: opts.global ?? false },
      };
    });

  program
    .command("remove")
    .description(
      "Remove a bundle from the active set and recompose or restore any root instructions it owns",
    )
    .argument("[source]", "Bundle source (e.g. github.com/user/repo)")
    .argument("[bundle]", "Bundle name to remove")
    .option(
      "--include <item>",
      "Remove only a bundle item such as skills/name, agents/name, commands/name, or root-instruction (repeatable)",
      collectBundleItemOption,
      [] as BundleItemSelector[],
    )
    .option(
      "--select-items",
      "Choose bundle items interactively before removing",
    )
    .option(
      "-n, --dry-run",
      "Preview what would be deleted without removing any files",
    )
    .option("-g, --global", "Remove from globally managed tool config")
    .action(
      (
        source: string | undefined,
        bundle: string | undefined,
        opts: {
          include: BundleItemSelector[];
          selectItems?: boolean;
          dryRun?: boolean;
          global?: boolean;
        },
      ) => {
        const includeItems = opts.include;
        const selectItems = opts.selectItems ?? false;
        const dryRun = opts.dryRun ?? false;
        const global = opts.global ?? false;

        if (!source && !bundle) {
          if (selectItems || includeItems.length > 0) {
            context.result = {
              kind: "command",
              command: "remove",
              options: {
                ...(includeItems.length > 0 ? { includeItems } : {}),
                ...(selectItems ? { selectItems } : {}),
                dryRun,
                global,
              },
            };
            return;
          }

          throw new Error(
            "Command remove requires a source or bundle name\nHint: run 'skul remove <source>' to select a bundle from that source, or 'skul remove <bundle>' for an active bundle",
          );
        }

        if (source && !bundle) {
          try {
            const normalizedSource = normalizeBundleSource(source);
            const repoSlug = normalizedSource.split("/").at(-1)!;
            context.result = {
              kind: "command",
              command: "remove",
              options: {
                source: normalizedSource,
                bundle: repoSlug,
                ...(includeItems.length > 0 ? { includeItems } : {}),
                ...(selectItems ? { selectItems } : {}),
                dryRun,
                inferredBundleFromSource: true,
                global,
              },
            };
          } catch {
            context.result = {
              kind: "command",
              command: "remove",
              options: {
                bundle: source,
                ...(includeItems.length > 0 ? { includeItems } : {}),
                ...(selectItems ? { selectItems } : {}),
                dryRun,
                global,
              },
            };
          }
          return;
        }

        context.result = {
          kind: "command",
          command: "remove",
          options: {
            source: normalizeBundleSource(source!),
            bundle: bundle!,
            ...(includeItems.length > 0 ? { includeItems } : {}),
            ...(selectItems ? { selectItems } : {}),
            dryRun,
            global,
          },
        };
      },
    );

  program
    .command("clear-cache", { hidden: true })
    .description("Remove a cached remote source from the global library")
    .argument("[source]", "Cached bundle source (e.g. github.com/user/repo)")
    .option(
      "--all",
      "Remove every cached remote source from the global library",
    )
    .option(
      "-n, --dry-run",
      "Preview what would be deleted without removing any files",
    )
    .action(
      (
        source: string | undefined,
        opts: { all?: boolean; dryRun?: boolean },
      ) => {
        if (opts.all && source) {
          throw new Error(
            "Command clear-cache accepts either a source or --all",
          );
        }

        if (!opts.all && !source) {
          throw new Error("Command clear-cache requires a source or --all");
        }

        context.result = {
          kind: "command",
          command: "clear-cache",
          options: {
            ...(source !== undefined
              ? { source: normalizeBundleSource(source) }
              : {}),
            all: opts.all ?? false,
            dryRun: opts.dryRun ?? false,
          },
        };
      },
    );

  return program;
}

function normalizeParseError(error: unknown, command: string): Error {
  if (!(error instanceof CommanderError)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  if (error.code === "commander.excessArguments") {
    if (command === "add") {
      return new Error("Command add accepts at most 2 positional arguments");
    }

    if (command === "remove") {
      return new Error("Command remove accepts at most 2 positional arguments");
    }

    if (command === "clear-cache") {
      return new Error(
        "Command clear-cache accepts at most 1 positional argument",
      );
    }

    if (command === "check" || command === "update") {
      return new Error(
        `Command ${command} accepts at most 1 positional argument`,
      );
    }

    return new Error(`Command ${command} does not accept positional arguments`);
  }

  return new Error(error.message.replace(/^error: /, ""));
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

function findClosestCommand(
  input: string,
  commands: readonly string[],
): string | undefined {
  const MAX_DISTANCE = 3;
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const cmd of commands) {
    const d = levenshtein(input, cmd);
    if (d < bestDistance) {
      bestDistance = d;
      best = cmd;
    }
  }
  return bestDistance <= MAX_DISTANCE ? best : undefined;
}

function formatBundleSelectionLabel(
  selection: BundleSelection,
  availableBundles: BundleSelection[],
): string {
  const hasDuplicateBundleName = availableBundles.some(
    (bundle) =>
      bundle.bundle === selection.bundle && bundle.source !== selection.source,
  );

  if (hasDuplicateBundleName && selection.source) {
    return `${selection.bundle} (${selection.source})`;
  }

  return selection.bundle;
}
