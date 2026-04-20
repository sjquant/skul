import { Command, CommanderError } from "commander";
import { detectSourceProtocol, normalizeBundleSource } from "./bundle-discovery";
import {
  DEFAULT_CONFLICT_PREFIX,
  normalizeConflictDestination,
  normalizeConflictPrefix,
} from "./conflict-resolution";
import { type ToolName } from "./tool-mapping";

export type CommandName =
  | "add"
  | "list"
  | "status"
  | "check"
  | "update"
  | "reset"
  | "remove"
  | "apply"
  | "clear-cache";

export type CliParseResult =
  | { kind: "help" }
  | { kind: "command"; command: "list"; options: { json: boolean } }
  | { kind: "command"; command: "status"; options: { json: boolean } }
  | { kind: "command"; command: "check"; options: { bundle?: string; json: boolean } }
  | { kind: "command"; command: "update"; options: { bundle?: string; dryRun: boolean } }
  | { kind: "command"; command: "apply" }
  | { kind: "command"; command: "reset"; options: { dryRun: boolean } }
  | { kind: "command"; command: "clear-cache"; options: { source?: string; all: boolean; dryRun: boolean } }
  | {
      kind: "command";
      command: "add";
      options: { mode: "stealth"; bundle: string; source?: string; protocol: "https" | "ssh"; agents: ToolName[]; dryRun: boolean };
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

export interface BundleSelection {
  bundle: string;
  source?: string;
  protocol?: "https" | "ssh";
}

export interface PromptClient {
  selectBundle(source?: string): Promise<BundleSelection>;
  resolveFileConflict(conflictPath: string, suggestedDestination: string): Promise<FileConflictResolution>;
  confirmManagedFileRemoval(conflictPath: string, operation: "reset" | "replace" | "remove"): Promise<boolean>;
}

const COMMANDS: CommandName[] = ["add", "list", "status", "check", "update", "reset", "remove", "apply", "clear-cache"];
let clackPromptsModulePromise: Promise<typeof import("@clack/prompts")> | undefined;
const loadEsmModule = new Function("specifier", "return import(specifier);") as (
  specifier: string,
) => Promise<unknown>;

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
    async selectBundle(source?: string): Promise<BundleSelection> {
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
  const bundleSelections = availableBundles.map((bundle) => ({ bundle }));
  return createPromptClientForSelections(bundleSelections);
}

export function createPromptClientForSelections(availableBundles: BundleSelection[]): PromptClient {
  return {
    async selectBundle(source?: string): Promise<BundleSelection> {
      if (availableBundles.length === 0) {
        throw new Error(
          source
            ? `Interactive bundle selection is not available for source ${source} yet`
            : "Interactive bundle selection is not available until bundle discovery is implemented",
        );
      }

      const { isCancel, select } = await loadClackPromptsModule();
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
    async resolveFileConflict(
      conflictPath: string,
      suggestedDestination: string,
    ): Promise<FileConflictResolution> {
      const { isCancel, select, text } = await loadClackPromptsModule();
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
      const { confirm, isCancel } = await loadClackPromptsModule();
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

function loadClackPromptsModule(): Promise<typeof import("@clack/prompts")> {
  clackPromptsModulePromise ??= loadEsmModule("@clack/prompts") as Promise<typeof import("@clack/prompts")>;
  return clackPromptsModulePromise;
}

export function createHelpText(): string {
  return createProgram({
    selectBundle: async () => ({ bundle: "" }),
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

function collectOption(value: string, previous: ToolName[]): ToolName[] {
  return [...previous, value as ToolName];
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
    .description("Add a bundle to the active set and materialize its files")
    .argument("[source]", "Bundle source (e.g. github.com/user/repo)")
    .argument("[bundle]", "Bundle name")
    .option("-a, --agent <name>", "Select a specific agent to materialize (repeatable)", collectOption, [] as ToolName[])
    .option("-n, --dry-run", "Preview what would be written without making any changes")
    .option("-s, --ssh", "Clone the bundle source using SSH instead of HTTPS")
    .action(async (source: string | undefined, bundle: string | undefined, opts: { agent: ToolName[]; dryRun?: boolean; ssh?: boolean }) => {
      const agents = opts.agent;
      const dryRun = opts.dryRun ?? false;

      if (!source && !bundle) {
        const selection = await prompts.selectBundle();
        context.result = {
          kind: "command",
          command: "add",
          options: {
            mode: "stealth",
            ...(selection.source !== undefined ? { source: selection.source } : {}),
            bundle: selection.bundle,
            protocol: selection.protocol ?? "https",
            agents,
            dryRun,
          },
        };
        return;
      }

      if (source && !bundle) {
        // If the single argument looks like a git source (host/owner/repo), treat the
        // repo slug as the bundle name so `skul add github.com/user/react-bundle` works.
        try {
          const detectedProtocol = opts.ssh ? "ssh" : detectSourceProtocol(source);
          const normalizedSource = normalizeBundleSource(source);
          const repoSlug = normalizedSource.split("/").at(-1)!;
          context.result = {
            kind: "command",
            command: "add",
            options: { mode: "stealth", source: normalizedSource, bundle: repoSlug, protocol: detectedProtocol, agents, dryRun },
          };
        } catch {
          // Not a valid source — treat as a plain bundle name.
          context.result = {
            kind: "command",
            command: "add",
            options: { mode: "stealth", bundle: source, protocol: "https", agents, dryRun },
          };
        }
        return;
      }

      const explicitSource = source!;
      const detectedProtocol = opts.ssh ? "ssh" : detectSourceProtocol(explicitSource);
      const normalizedSource = normalizeBundleSource(explicitSource);

      context.result = {
        kind: "command",
        command: "add",
        options: { mode: "stealth", source: normalizedSource, bundle: bundle!, protocol: detectedProtocol, agents, dryRun },
      };
    });

  program
    .command("list")
    .description("List available bundles in the local library")
    .option("-j, --json", "Output as JSON (for scripting and agent use)")
    .action((opts: { json?: boolean }) => {
      context.result = { kind: "command", command: "list", options: { json: opts.json ?? false } };
    });

  program
    .command("status")
    .description("Show desired state and current worktree materialization")
    .option("-j, --json", "Output as JSON (for scripting and agent use)")
    .action((opts: { json?: boolean }) => {
      context.result = { kind: "command", command: "status", options: { json: opts.json ?? false } };
    });

  program
    .command("check")
    .description("Check remote-backed bundles for upstream updates")
    .argument("[bundle]", "Bundle name to check")
    .option("-j, --json", "Output as JSON (for scripting and agent use)")
    .action((bundle: string | undefined, opts: { json?: boolean }) => {
      context.result = {
        kind: "command",
        command: "check",
        options: { ...(bundle !== undefined ? { bundle } : {}), json: opts.json ?? false },
      };
    });

  program
    .command("update")
    .description("Update remote-backed bundles to the latest upstream revision")
    .argument("[bundle]", "Bundle name to update")
    .option("-n, --dry-run", "Preview what would be updated without making any changes")
    .action((bundle: string | undefined, opts: { dryRun?: boolean }) => {
      context.result = {
        kind: "command",
        command: "update",
        options: { ...(bundle !== undefined ? { bundle } : {}), dryRun: opts.dryRun ?? false },
      };
    });

  program
    .command("apply")
    .description("Materialize all desired-state bundles into the current worktree")
    .action(() => {
      context.result = { kind: "command", command: "apply" };
    });

  program
    .command("reset")
    .description("Remove all Skul-managed files from the current worktree")
    .option("-n, --dry-run", "Preview what would be deleted without removing any files")
    .action((opts: { dryRun?: boolean }) => {
      context.result = { kind: "command", command: "reset", options: { dryRun: opts.dryRun ?? false } };
    });

  program
    .command("remove")
    .description("Remove a bundle from the active set and delete its managed files")
    .argument("<bundle>", "Bundle name to remove")
    .option("-n, --dry-run", "Preview what would be deleted without removing any files")
    .action((bundle: string, opts: { dryRun?: boolean }) => {
      context.result = {
        kind: "command",
        command: "remove",
        options: { bundle, dryRun: opts.dryRun ?? false },
      };
    });

  program
    .command("clear-cache")
    .description("Remove a cached remote source from the global library")
    .argument("[source]", "Cached bundle source (e.g. github.com/user/repo)")
    .option("--all", "Remove every cached remote source from the global library")
    .option("-n, --dry-run", "Preview what would be deleted without removing any files")
    .action((source: string | undefined, opts: { all?: boolean; dryRun?: boolean }) => {
      if (opts.all && source) {
        throw new Error("Command clear-cache accepts either a source or --all");
      }

      if (!opts.all && !source) {
        throw new Error("Command clear-cache requires a source or --all");
      }

      context.result = {
        kind: "command",
        command: "clear-cache",
        options: {
          ...(source !== undefined ? { source: normalizeBundleSource(source) } : {}),
          all: opts.all ?? false,
          dryRun: opts.dryRun ?? false,
        },
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

    if (command === "clear-cache") {
      return new Error("Command clear-cache accepts at most 1 positional argument");
    }

    if (command === "check" || command === "update") {
      return new Error(`Command ${command} accepts at most 1 positional argument`);
    }

    return new Error(`Command ${command} does not accept positional arguments`);
  }

  return new Error(error.message.replace(/^error: /, ""));
}

function formatBundleSelectionLabel(
  selection: BundleSelection,
  availableBundles: BundleSelection[],
): string {
  const hasDuplicateBundleName = availableBundles.some(
    (bundle) => bundle.bundle === selection.bundle && bundle.source !== selection.source,
  );

  if (hasDuplicateBundleName && selection.source) {
    return `${selection.bundle} (${selection.source})`;
  }

  return selection.bundle;
}
