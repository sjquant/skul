import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseCliArgs } from "./cli";
import { run } from "./index";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseCliArgs", () => {
  it("returns help when no command is provided", async () => {
    // Given
    const argv: string[] = [];

    // When / Then
    await expect(parseCliArgs(argv)).resolves.toEqual({ kind: "help" });
  });

  it("parses non-mutating commands without arguments", async () => {
    // Given
    const listArgs = ["list"];
    const statusArgs = ["status"];
    const cleanArgs = ["clean"];

    // When / Then
    await expect(parseCliArgs(listArgs)).resolves.toEqual({ kind: "command", command: "list" });
    await expect(parseCliArgs(statusArgs)).resolves.toEqual({ kind: "command", command: "status" });
    await expect(parseCliArgs(cleanArgs)).resolves.toEqual({ kind: "command", command: "clean" });
  });

  it("parses use in interactive, cached, and explicit source modes", async () => {
    // Given
    const selectBundle = vi.fn().mockResolvedValue("react-expert");

    // When / Then
    await expect(parseCliArgs([], { selectBundle })).resolves.toEqual({ kind: "help" });

    await expect(parseCliArgs(["use"], { selectBundle })).resolves.toEqual({
      kind: "command",
      command: "use",
      options: { mode: "stealth", bundle: "react-expert" },
    });
    expect(selectBundle).toHaveBeenCalledWith();

    await expect(parseCliArgs(["use", "react-expert"])).resolves.toEqual({
      kind: "command",
      command: "use",
      options: { mode: "stealth", bundle: "react-expert" },
    });

    await expect(parseCliArgs(["use", "github.com/user/ai-vault", "react-expert"])).resolves.toEqual({
      kind: "command",
      command: "use",
      options: {
        mode: "stealth",
        source: "github.com/user/ai-vault",
        bundle: "react-expert",
      },
    });
  });

  it("parses install with tracked mode", async () => {
    // Given
    const argv = ["install", "react-expert"];

    // When / Then
    await expect(parseCliArgs(argv)).resolves.toEqual({
      kind: "command",
      command: "install",
      options: { mode: "tracked", bundle: "react-expert" },
    });
  });

  it("rejects unknown commands and invalid arity", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["deploy"])).rejects.toThrowError(/Unknown command: deploy/);
    await expect(parseCliArgs(["list", "extra"])).rejects.toThrowError(
      /Command list does not accept positional arguments/,
    );
    await expect(parseCliArgs(["status", "extra"])).rejects.toThrowError(
      /Command status does not accept positional arguments/,
    );
    await expect(parseCliArgs(["clean", "extra"])).rejects.toThrowError(
      /Command clean does not accept positional arguments/,
    );
    await expect(parseCliArgs(["install"])).rejects.toThrowError(
      /Command install requires a bundle name/,
    );
    await expect(parseCliArgs(["use", "a", "b", "c"])).rejects.toThrowError(
      /Command use accepts at most 2 positional arguments/,
    );
  });
});

describe("run", () => {
  it("renders usage for bare invocations", async () => {
    // Given
    const argv: string[] = [];

    // When / Then
    await expect(run(argv)).resolves.toMatch(/^Usage: skul /);
  });

  it("lists cached bundles from the global library", async () => {
    // Given
    const homeDir = createHomeDir();

    writeManifest(homeDir, "github.com/user/ai-vault", "repo-standards", {
      name: "repo-standards",
      tool: "codex",
      targets: { skills: { path: "skills" } },
    });
    writeManifest(homeDir, "github.com/user/ai-vault", "react-expert", {
      name: "react-expert",
      tool: "claude-code",
      targets: { skills: { path: "skills" } },
    });

    // When / Then
    await expect(run(["list"], { homeDir })).resolves.toBe(renderBundleListOutput("react-expert", "repo-standards"));
  });

  it("reports when no cached bundles are available", async () => {
    // Given
    const homeDir = createHomeDir();

    // When / Then
    await expect(run(["list"], { homeDir })).resolves.toBe(renderBundleListOutput("No cached bundles found."));
  });
});

function createHomeDir(): string {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "skul-home-"));
  tempDirs.push(homeDir);
  return homeDir;
}

function writeManifest(homeDir: string, source: string, bundle: string, manifest: object): void {
  const bundleDir = path.join(homeDir, ".skul", "library", ...source.split("/"), bundle);
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

function renderBundleListOutput(...lines: string[]): string {
  return ["Available Bundles", "", ...lines].join("\n");
}
