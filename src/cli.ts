import { confirm, isCancel, select, text } from "@clack/prompts";
import { Command, CommanderError } from "commander";
import {
  DEFAULT_CONFLICT_PREFIX,
  normalizeConflictDestination,
  normalizeConflictPrefix,
} from "./conflict-resolution";
import { type ToolName } from "./tool-mapping";

export type CommandName = "add" | "list" | "status" | "reset" | "remove" | "apply";

export type CliParseResult =
  | { kind: "help" }
  | { kind: "command"; command: "list"; options: { json: boolean } }
  | { kind: "command"; command: "status"; options: { json: boolean } }
  | { kind: "command"; command: "apply" }
  | { kind: "command"; command: "reset"; options: { dryRun: boolean } }
  | {
      kind: "command";
      command: "add";
      options: { mode: "stealth"; bundle: string; source?: string; tools: ToolName[]; dryRun: boolean };
    }
  | {
      kind: "command";
      command: "remove";
      options: { bundle: string; dryRun: boolean };
    };

export type FileConflictResolution =
  | { action: "rename"; destination: string }
  | { action: "prefix"; prefix: string }
  | { action: "skip" };

export interface PromptClient {
  selectBundle(source?: string): Promise<string>;
  resolveFileConflict(conflictPath: string, suggestedDestination: string): Promise<FileConflictResolution>;
  confirmManagedFileRemoval(conflictPath: string, operation: "reset" | "replace" | "remove"): Promise<boolean>;
}

const COMMANDS: CommandName[] = ["add", "list", "status", "reset", "remove", "apply"];

/**
 * Returns true if the CLI should run in headless (non-interactive) mode.
 * Detected via the SKUL_NO_TUI environment variable.
 */
export function isHeadlessMode(): boolean {
  return process.env["SKUL_NO_TUI"] === "1" || process.env["SKUL_NO_TUI"] === "true";
}

/**
 * Creates a prompt client that throws immediately instead of opening interactive
 * prompts. Use this when SKUL_NO_TUI is set so agents never block waiting for input.
 */
export function createHeadlessPromptClient(): PromptClient {
  return {
    async selectBundle(source?: string): Promise<string> {
      const hint = source
        ? `skul add ${source} <bundle>`
        : "skul add <bundle>";
      throw new Error(
        `Bundle name is required in headless mode.\nHint: run '${hint}' to specify the bundle explicitly`,
      );
    },
    async resolveFileConflict(
      conflictPath: string,
      suggestedDestination: string,
    ): Promise<FileConflictResolution> {
      // In headless mode, auto-apply the default prefix to avoid blocking.
      return { action: "prefix", prefix: DEFAULT_CONFLICT_PREFIX };
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

export function createPromptClient(availableBundles: string[] = []): PromptClient {
  return {
    async selectBundle(source?: string): Promise<string> {
      if (availableBundles.length === 0) {
        throw new Error(
          source
            ? `Interactive bundle selection is not available for source ${source} yet`
            : "Interactive bundle selection is not available until bundle discovery is implemented",
        );
      }

      const choice = await select({
        message: source ? `Select a bundle from ${source}` : "Select a bundle",
        options: availableBundles.map((bundle) => ({
          value: bundle,
          label: bundle,
        })),
      });

      if (isCancel(choice)) {
        throw new Error("Interactive bundle selection was cancelled");
      }

      return choice;
    },
    async resolveFileConflict(
      conflictPath: string,
      suggestedDestination: string,
    ): Promise<FileConflictResolution> {
      const action = await select({
        message: `Conflict detected: ${conflictPath} already exists`,
        options: [
          { value: "rename", label: "Rename incoming file" },
          { value: "prefix", label: `Apply prefix (${suggestedDestination})` },
          { value: "skip", label: "Skip file" },
        ],
      });

      if (isCancel(action)) {
        throw new Error("Conflict resolution was cancelled");
      }

      if (action === "rename") {
        const destination = await text({
          message: "Enter a new destination relative to the tool target",
          defaultValue: suggestedDestination,
          placeholder: suggestedDestination,
          validate(value) {
            if (typeof value !== "string" || value.trim() === "") {
              return "A destination is required";
            }

            const normalizedValue = normalizeConflictDestination(value);

            if (!normalizedValue) {
              return "Destination must stay inside the tool target";
            }

            return undefined;
          },
        });

        if (isCancel(destination)) {
          throw new Error("Conflict resolution was cancelled");
        }

        return {
          action: "rename",
          destination: normalizeConflictDestination(destination)!,
        };
      }

      if (action === "prefix") {
        const prefix = await text({
          message: "Enter a prefix for the incoming file name",
          defaultValue: DEFAULT_CONFLICT_PREFIX,
          placeholder: DEFAULT_CONFLICT_PREFIX,
          validate(value) {
            if (typeof value !== "string" || value.trim() === "") {
              return "A prefix is required";
            }

            const normalizedValue = normalizeConflictPrefix(value);

            if (!normalizedValue) {
              return "Prefix must be a single filename-safe segment";
            }

            return undefined;
          },
        });

        if (isCancel(prefix)) {
          throw new Error("Conflict resolution was cancelled");
        }

        return {
          action: "prefix",
          prefix: normalizeConflictPrefix(prefix)!,
        };
      }

      return { action };
    },
    async confirmManagedFileRemoval(
      conflictPath: string,
      operation: "reset" | "replace" | "remove",
    ): Promise<boolean> {
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

export function createHelpText(): string {
  return createProgram({
    selectBundle: async () => "",
    resolveFileConflict: async () => ({ action: "prefix", prefix: DEFAULT_CONFLICT_PREFIX }),
    confirmManagedFileRemoval: async () => true,
  }).helpInformation();
}

export async function parseCliArgs(
  argv: string[],
  prompts: PromptClient = createPromptClient(),
): Promise<CliParseResult> {
  const [command] = argv;

  if (!command || command === "help" || command === "-h" || command === "--help") {
    return { kind: "help" };
  }

  if (!COMMANDS.includes(command as CommandName)) {
    throw new Error(`Unknown command: ${command}`);
  }

  const context: { result?: CliParseResult } = {};
  const program = createProgram(prompts, context);

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    throw normalizeParseError(error, command);
  }

  return context.result ?? { kind: "help" };
}

function collectOption(value: ToolName, previous: ToolName[]): ToolName[] {
  return [...previous, value];
}

function createProgram(
  prompts: PromptClient,
  context: { result?: CliParseResult } = {},
): Command {
  const program = new Command();

  program
    .name("skul")
    .description("Manage project-scoped AI configuration bundles")
    .helpCommand(false)
    .configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined,
    })
    .exitOverride();

  program
    .command("add")
    .description(
      "Add a bundle to the active set and materialize its files\n\n" +
      "Writes the bundle's AI configuration assets into tool-native directories\n" +
      "(.claude/, .cursor/, .opencode/, .agents/) and registers them in\n" +
      "~/.skul/registry.json. Files are hidden from Git via .git/info/exclude.\n\n" +
      "If the bundle is already active, it is re-materialized (idempotent).\n" +
      "Use --tool to limit materialization to specific AI tools.",
    )
    .argument("[source]", "Bundle source (e.g. github.com/user/repo)")
    .argument("[bundle]", "Bundle name")
    .option("--tool <name>", "Select a specific tool to materialize (repeatable)", collectOption, [] as ToolName[])
    .option("--dry-run", "Preview what would be written without making any changes")
    .addHelpText(
      "after",
      "\nExamples:\n" +
      "  skul add react-expert                          # add from local library\n" +
      "  skul add github.com/user/vault react-expert    # add from remote source\n" +
      "  skul add react-expert --tool claude-code       # materialize for one tool only\n" +
      "  skul add react-expert --dry-run                # preview without writing files\n",
    )
    .action(async (source: string | undefined, bundle: string | undefined, opts: { tool: ToolName[]; dryRun?: boolean }) => {
      const tools = opts.tool;
      const dryRun = opts.dryRun ?? false;

      if (!source && !bundle) {
        context.result = {
          kind: "command",
          command: "add",
          options: { mode: "stealth", bundle: await prompts.selectBundle(), tools, dryRun },
        };
        return;
      }

      if (source && !bundle) {
        context.result = {
          kind: "command",
          command: "add",
          options: { mode: "stealth", bundle: source, tools, dryRun },
        };
        return;
      }

      context.result = {
        kind: "command",
        command: "add",
        options: { mode: "stealth", source, bundle: bundle!, tools, dryRun },
      };
    });

  program
    .command("list")
    .description(
      "List available bundles in the local library\n\n" +
      "Shows all bundles cached in ~/.skul/library/ along with the AI tools\n" +
      "each bundle supports. Use --json for machine-readable output.",
    )
    .option("--json", "Output as JSON (for scripting and agent use)")
    .addHelpText(
      "after",
      "\nExamples:\n" +
      "  skul list               # human-readable table\n" +
      "  skul list --json        # JSON array for agent consumption\n",
    )
    .action((opts: { json?: boolean }) => {
      context.result = { kind: "command", command: "list", options: { json: opts.json ?? false } };
    });

  program
    .command("status")
    .description(
      "Show desired state and current worktree materialization\n\n" +
      "Displays the repository's configured bundle set (desired state) and\n" +
      "the files actually written into the current Git worktree (materialized\n" +
      "state). Use --json for structured output suitable for agent inspection.",
    )
    .option("--json", "Output as JSON (for scripting and agent use)")
    .addHelpText(
      "after",
      "\nExamples:\n" +
      "  skul status             # human-readable summary\n" +
      "  skul status --json      # structured JSON for agent inspection\n",
    )
    .action((opts: { json?: boolean }) => {
      context.result = { kind: "command", command: "status", options: { json: opts.json ?? false } };
    });

  program
    .command("apply")
    .description(
      "Materialize all desired-state bundles into the current worktree\n\n" +
      "Reads the repository's desired bundle set and writes any bundles that\n" +
      "are not yet materialized in the current worktree. Safe to run multiple\n" +
      "times — already-materialized bundles are skipped.",
    )
    .addHelpText(
      "after",
      "\nExamples:\n" +
      "  skul apply              # materialize all pending bundles\n",
    )
    .action(() => {
      context.result = { kind: "command", command: "apply" };
    });

  program
    .command("reset")
    .description(
      "Remove all Skul-managed files from the current worktree\n\n" +
      "Deletes every file owned by Skul in this worktree, removes the\n" +
      ".git/info/exclude block, and clears the worktree's registry entry.\n" +
      "Does not modify the repository's desired state — run 'skul apply'\n" +
      "to re-materialize.",
    )
    .option("--dry-run", "Preview what would be deleted without removing any files")
    .addHelpText(
      "after",
      "\nExamples:\n" +
      "  skul reset              # remove all managed files\n" +
      "  skul reset --dry-run    # preview deletions without touching files\n",
    )
    .action((opts: { dryRun?: boolean }) => {
      context.result = { kind: "command", command: "reset", options: { dryRun: opts.dryRun ?? false } };
    });

  program
    .command("remove")
    .description(
      "Remove a bundle from the active set and delete its managed files\n\n" +
      "Removes the named bundle from the repository's desired state and\n" +
      "deletes its materialized files from the current worktree. Prompts\n" +
      "before deleting any files that were modified since Skul wrote them.",
    )
    .argument("<bundle>", "Bundle name to remove")
    .option("--dry-run", "Preview what would be deleted without removing any files")
    .addHelpText(
      "after",
      "\nExamples:\n" +
      "  skul remove react-expert            # remove bundle and its files\n" +
      "  skul remove react-expert --dry-run  # preview without deleting\n",
    )
    .action((bundle: string, opts: { dryRun?: boolean }) => {
      context.result = {
        kind: "command",
        command: "remove",
        options: { bundle, dryRun: opts.dryRun ?? false },
      };
    });

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
      return new Error("Command remove accepts exactly 1 positional argument");
    }

    return new Error(`Command ${command} does not accept positional arguments`);
  }

  return new Error(error.message.replace(/^error: /, ""));
}
