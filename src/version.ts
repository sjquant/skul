import fs from "node:fs";
import path from "node:path";

export function getPackageVersion(): string {
  const packageJsonPath = path.resolve(__dirname, "..", "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    version?: unknown;
  };

  if (typeof packageJson.version !== "string") {
    throw new Error(`Package version is missing from ${packageJsonPath}`);
  }

  return packageJson.version;
}
