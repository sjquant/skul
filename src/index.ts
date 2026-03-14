import os from "node:os";

import { listCachedBundles } from "./bundle-discovery";
import { createHelpText, parseCliArgs } from "./cli";
import { resolveGlobalStateLayout } from "./state-layout";

export interface RunOptions {
  homeDir?: string;
}

export async function run(argv: string[], options: RunOptions = {}): Promise<string> {
  const parsed = await parseCliArgs(argv);
  const stateLayout = resolveGlobalStateLayout({ homeDir: options.homeDir ?? os.homedir() });

  if (parsed.kind === "help") {
    return createHelpText();
  }

  if (parsed.command === "list") {
    return renderBundleList({ libraryDir: stateLayout.libraryDir });
  }

  return `Command ${parsed.command} is defined but not implemented yet.`;
}

function renderBundleList(options: { libraryDir: string }): string {
  const bundles = listCachedBundles(options);

  if (bundles.length === 0) {
    return ["Available Bundles", "", "No cached bundles found."].join("\n");
  }

  return ["Available Bundles", "", ...bundles.map((bundle) => bundle.bundle)].join("\n");
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
