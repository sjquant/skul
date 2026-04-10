import fs from "node:fs";
import path from "node:path";

export interface SkulConfig {
  defaultSource?: string;
}

export function readSkulConfig(configFile: string): SkulConfig {
  if (!fs.existsSync(configFile)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(configFile, "utf8")) as SkulConfig;
  } catch {
    return {};
  }
}

export function writeSkulConfig(configFile: string, config: SkulConfig): void {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
}
