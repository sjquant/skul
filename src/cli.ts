import { isCancel, select } from "@clack/prompts";
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

export interface PromptClient {
  selectBundle(source?: string): Promise<string>;
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
  };
}

export function createHelpText(): string {
  return createProgram({ selectBundle: async () => "" }).helpInformation();
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
