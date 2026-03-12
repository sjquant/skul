import { createHelpText, parseCliArgs } from "./cli";

export async function run(argv: string[]): Promise<string> {
  const parsed = await parseCliArgs(argv);

  if (parsed.kind === "help") {
    return createHelpText();
  }

  return `Command ${parsed.command} is defined but not implemented yet.`;
}

if (require.main === module) {
  void run(process.argv.slice(2))
    .then((output) => {
      console.log(output);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    });
}
