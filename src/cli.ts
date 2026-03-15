import path from "node:path";

import { isCancel, select, text } from "@clack/prompts";
import { Command, CommanderError } from "commander";

export type CommandName = "use" | "list" | "status" | "clean";

export type CliParseResult =
  | { kind: "help" }
  | { kind: "command"; command: "list" | "status" | "clean" }
  | {
      kind: "command";
      command: "use";
      options: { mode: "stealth"; bundle: string; source?: string };
    };

export type FileConflictResolution =
  | { action: "rename"; destination: string }
  | { action: "prefix"; prefix: string }
  | { action: "skip" };

export interface PromptClient {
  selectBundle(source?: string): Promise<string>;
  resolveFileConflict(conflictPath: string, suggestedDestination: string): Promise<FileConflictResolution>;
}

const COMMANDS: CommandName[] = ["use", "list", "status", "clean"];

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
          defaultValue: "p",
          placeholder: "p",
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
  };
}

export function createHelpText(): string {
  return createProgram({
    selectBundle: async () => "",
    resolveFileConflict: async () => ({ action: "prefix", prefix: "p" }),
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
    .command("use")
    .description("Apply bundle in stealth mode")
    .argument("[source]")
    .argument("[bundle]")
    .action(async (source?: string, bundle?: string) => {
      if (!source && !bundle) {
        context.result = {
          kind: "command",
          command: "use",
          options: { mode: "stealth", bundle: await prompts.selectBundle() },
        };
        return;
      }

      if (source && !bundle) {
        context.result = {
          kind: "command",
          command: "use",
          options: { mode: "stealth", bundle: source },
        };
        return;
      }

      context.result = {
        kind: "command",
        command: "use",
        options: { mode: "stealth", source, bundle: bundle! },
      };
    });

  for (const command of ["list", "status", "clean"] as const) {
    program
      .command(command)
      .description("Placeholder command")
      .action(() => {
        context.result = { kind: "command", command };
      });
  }

  return program;
}

function normalizeParseError(error: unknown, command: string): Error {
  if (!(error instanceof CommanderError)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  if (error.code === "commander.excessArguments") {
    if (command === "use") {
      return new Error("Command use accepts at most 2 positional arguments");
    }

    return new Error(`Command ${command} does not accept positional arguments`);
  }

  return new Error(error.message.replace(/^error: /, ""));
}

function normalizeConflictDestination(input: string): string | null {
  const normalizedValue = input.trim().split(path.sep).join("/");

  if (
    !normalizedValue ||
    path.isAbsolute(normalizedValue) ||
    normalizedValue === "." ||
    normalizedValue === ".." ||
    normalizedValue.startsWith("../") ||
    normalizedValue.includes("/../")
  ) {
    return null;
  }

  return normalizedValue;
}

function normalizeConflictPrefix(input: string): string | null {
  const normalizedValue = input.trim();

  if (
    !normalizedValue ||
    normalizedValue.includes("/") ||
    normalizedValue.includes(path.sep) ||
    normalizedValue === "." ||
    normalizedValue === ".."
  ) {
    return null;
  }

  return normalizedValue;
}
