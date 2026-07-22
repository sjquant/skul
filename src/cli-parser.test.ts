import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createHelpText,
  createPromptClientForSelections,
  parseCliArgs,
} from "./cli";
import {
  assertAgentsDocument,
  assertClaudeDocument,
  createHomeDir,
  createLinkedWorktree,
  createPromptClientStub,
  createRemoteBundleSource,
  createRepository,
  createSyncRepository,
  expectAgentsDocument,
  expectClaudeDocument,
  fingerprintFile,
  formatExpectedRootInstructionDocument,
  formatRootInstructionBundleBlock,
  formatTrackedRootInstructionShadowBlock,
  pathExists,
  pushSyncRepositoryUpdate,
  readGitIndexFlag,
  renderBundleListOutput,
  runGit,
  setupSharedRootInstructionBundles,
  tempDirs,
  updateRemoteBundleSource,
  writeBundleFile,
  writeManifest,
  writeRootInstructionBundleFixture,
} from "./cli.test-support";
import { detectGitContext } from "./git-context";
import { assertTrackedRootInstructionShadowSafety, run } from "./index";
import {
  createEmptyRegistry,
  readRegistryFile,
  upsertRepoState,
  upsertWorktreeState,
  writeRegistryFile,
} from "./registry";
import { renderTrackedRootInstructionShadow } from "./root-instruction-render";

describe("parseCliArgs", () => {
  it("returns help when no command is provided", async () => {
    // Given
    const argv: string[] = [];

    // When / Then
    await expect(parseCliArgs(argv)).resolves.toEqual({ kind: "help" });
  });

  it("returns version when a version flag is provided", async () => {
    // Given
    const longFlag = ["--version"];
    const shortFlag = ["-v"];

    // When / Then
    await expect(parseCliArgs(longFlag)).resolves.toEqual({ kind: "version" });
    await expect(parseCliArgs(shortFlag)).resolves.toEqual({ kind: "version" });
  });

  it("parses non-mutating commands without arguments", async () => {
    // Given
    const listArgs = ["list"];
    const statusArgs = ["status"];
    const checkArgs = ["check"];
    const updateArgs = ["update"];
    const syncArgs = ["sync"];
    const resetArgs = ["reset"];
    const applyArgs = ["apply"];

    // When / Then
    await expect(parseCliArgs(listArgs)).resolves.toEqual({
      kind: "command",
      command: "list",
      options: { json: false },
    });
    await expect(parseCliArgs(statusArgs)).resolves.toEqual({
      kind: "command",
      command: "status",
      options: { json: false, global: false },
    });
    await expect(parseCliArgs(checkArgs)).resolves.toEqual({
      kind: "command",
      command: "check",
      options: { json: false },
    });
    await expect(parseCliArgs(updateArgs)).resolves.toEqual({
      kind: "command",
      command: "update",
      options: { dryRun: false },
    });
    await expect(parseCliArgs(syncArgs)).resolves.toEqual({
      kind: "command",
      command: "sync",
      options: {},
    });
    await expect(parseCliArgs(resetArgs)).resolves.toEqual({
      kind: "command",
      command: "reset",
      options: { dryRun: false, global: false },
    });
    await expect(parseCliArgs(applyArgs)).resolves.toEqual({
      kind: "command",
      command: "apply",
      options: { dryRun: false, global: false },
    });
  });

  it("parses tracked shadow lifecycle commands", async () => {
    // Given
    const suspendArgs = ["shadow", "--suspend"];
    const refreshArgs = ["shadow", "--refresh"];

    // When / Then
    await expect(parseCliArgs(suspendArgs)).resolves.toEqual({
      kind: "command",
      command: "shadow",
      options: { action: "suspend" },
    });
    await expect(parseCliArgs(refreshArgs)).resolves.toEqual({
      kind: "command",
      command: "shadow",
      options: { action: "refresh" },
    });
  });

  it("requires exactly one tracked shadow action flag", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["shadow"])).rejects.toThrowError(
      /requires exactly one of --suspend or --refresh/i,
    );
    await expect(
      parseCliArgs(["shadow", "--suspend", "--refresh"]),
    ).rejects.toThrowError(/requires exactly one of --suspend or --refresh/i);
  });

  it("parses add in cached and explicit source modes", async () => {
    // Given
    const selectBundle = vi.fn().mockResolvedValue({ bundle: "react-expert" });
    const prompts = createPromptClientStub({ selectBundle });

    // When / Then
    await expect(parseCliArgs([], prompts)).resolves.toEqual({ kind: "help" });

    await expect(parseCliArgs(["add"], prompts)).rejects.toThrowError(
      /Command add requires a source or bundle name/,
    );
    expect(selectBundle).not.toHaveBeenCalled();

    await expect(parseCliArgs(["add", "react-expert"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        bundle: "react-expert",
        protocol: "https",
        agents: [],
        dryRun: false,
        global: false,
      },
    });

    await expect(
      parseCliArgs(["add", "github.com/user/ai-vault", "react-expert"]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        source: "github.com/user/ai-vault",
        bundle: "react-expert",
        protocol: "https",
        agents: [],
        dryRun: false,
        global: false,
      },
    });
  });

  it("parses the explicit root instruction replacement mode", async () => {
    // Given
    const argv = ["add", "react-expert", "--root-instruction-mode", "replace"];

    // When
    const result = await parseCliArgs(argv);

    // Then
    expect(result).toMatchObject({
      kind: "command",
      command: "add",
      options: { rootInstructionMode: "replace" },
    });
  });

  it("normalizes explicit HTTPS source URLs for add", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs([
        "add",
        "https://github.com/user/ai-vault.git",
        "react-expert",
      ]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        source: "github.com/user/ai-vault",
        bundle: "react-expert",
        protocol: "https",
        agents: [],
        dryRun: false,
        global: false,
      },
    });
  });

  it("defaults owner/repo sources to the GitHub registry for add", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs(["add", "sjquant/ghosts", "core", "--agent", "codex"]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        source: "github.com/sjquant/ghosts",
        bundle: "core",
        protocol: "https",
        agents: ["codex"],
        dryRun: false,
        global: false,
      },
    });
  });

  it("normalizes owner/repo.git sources to the GitHub registry for add", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs(["add", "sjquant/ghosts.git", "core", "--agent", "codex"]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        source: "github.com/sjquant/ghosts",
        bundle: "core",
        protocol: "https",
        agents: ["codex"],
        dryRun: false,
        global: false,
      },
    });
  });

  it("derives bundle name from repo slug when only a source URL is given", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs(["add", "github.com/user/react-bundle"]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        source: "github.com/user/react-bundle",
        bundle: "react-bundle",
        protocol: "https",
        agents: [],
        dryRun: false,
        inferredBundleFromSource: true,
        global: false,
      },
    });
  });

  it("derives bundle name from the repo slug when owner/repo.git shorthand is given", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["add", "sjquant/ghosts.git"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        source: "github.com/sjquant/ghosts",
        bundle: "ghosts",
        protocol: "https",
        agents: [],
        dryRun: false,
        inferredBundleFromSource: true,
        global: false,
      },
    });
  });

  it("derives bundle name from the repo slug when only owner/repo shorthand is given", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["add", "sjquant/ghosts"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        source: "github.com/sjquant/ghosts",
        bundle: "ghosts",
        protocol: "https",
        agents: [],
        dryRun: false,
        inferredBundleFromSource: true,
        global: false,
      },
    });
  });

  it("treats a single arg as a plain bundle name when it is not a valid source URL", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["add", "react-expert"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        bundle: "react-expert",
        protocol: "https",
        agents: [],
        dryRun: false,
        global: false,
      },
    });
  });

  it("parses --agent flag as a single selected agent", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs(["add", "react-expert", "--agent", "claude-code"]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        bundle: "react-expert",
        protocol: "https",
        agents: ["claude-code"],
        dryRun: false,
        global: false,
      },
    });
  });

  it("collects multiple --agent flags into an array", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs([
        "add",
        "react-expert",
        "--agent",
        "claude-code",
        "--agent",
        "cursor",
      ]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        bundle: "react-expert",
        protocol: "https",
        agents: ["claude-code", "cursor"],
        dryRun: false,
        global: false,
      },
    });
  });

  it("deduplicates repeated --agent flags for the same tool", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs([
        "add",
        "react-expert",
        "--agent",
        "claude-code",
        "--agent",
        "claude-code",
      ]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        bundle: "react-expert",
        protocol: "https",
        agents: ["claude-code"],
        dryRun: false,
        global: false,
      },
    });
  });

  it("accepts -a as shorthand for --agent", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs(["add", "react-expert", "-a", "claude-code"]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        bundle: "react-expert",
        protocol: "https",
        agents: ["claude-code"],
        dryRun: false,
        global: false,
      },
    });
  });

  it("collects multiple -a flags into an array", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs([
        "add",
        "react-expert",
        "-a",
        "claude-code",
        "-a",
        "cursor",
      ]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        bundle: "react-expert",
        protocol: "https",
        agents: ["claude-code", "cursor"],
        dryRun: false,
        global: false,
      },
    });
  });

  it("accepts -n as shorthand for --dry-run", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["add", "react-expert", "-n"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        bundle: "react-expert",
        protocol: "https",
        agents: [],
        dryRun: true,
        global: false,
      },
    });
  });

  it("accepts -s as shorthand for --ssh", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs(["add", "github.com/user/ai-vault", "react-expert", "-s"]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        source: "github.com/user/ai-vault",
        bundle: "react-expert",
        protocol: "ssh",
        agents: [],
        dryRun: false,
        global: false,
      },
    });
  });

  it("accepts -y as shorthand for --yes on add", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["add", "react-expert", "-y"])).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        bundle: "react-expert",
        protocol: "https",
        agents: [],
        dryRun: false,
        global: false,
        yes: true,
      },
    });
  });

  it("accepts -j as shorthand for --json on list and status", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["list", "-j"])).resolves.toEqual({
      kind: "command",
      command: "list",
      options: { json: true },
    });

    await expect(parseCliArgs(["status", "-j"])).resolves.toEqual({
      kind: "command",
      command: "status",
      options: { json: true, global: false },
    });

    await expect(parseCliArgs(["check", "-j"])).resolves.toEqual({
      kind: "command",
      command: "check",
      options: { json: true },
    });
  });

  it("parses remove with a required bundle argument", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["remove", "react-expert"])).resolves.toEqual({
      kind: "command",
      command: "remove",
      options: { bundle: "react-expert", dryRun: false, global: false },
    });
  });

  it("parses source-scoped remove with item selection flags", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs([
        "remove",
        "sjquant/ghosts",
        "core",
        "--include",
        "skills/review.md",
        "--select-items",
      ]),
    ).resolves.toEqual({
      kind: "command",
      command: "remove",
      options: {
        source: "github.com/sjquant/ghosts",
        bundle: "core",
        includeItems: ["skills/review"],
        selectItems: true,
        dryRun: false,
        global: false,
      },
    });
  });

  it("parses a single remove source as an inferred bundle selection", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["remove", "sjquant/ghosts"])).resolves.toEqual({
      kind: "command",
      command: "remove",
      options: {
        source: "github.com/sjquant/ghosts",
        bundle: "ghosts",
        dryRun: false,
        inferredBundleFromSource: true,
        global: false,
      },
    });
  });

  it("parses item-selected remove without requiring a bundle", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["remove", "--select-items"])).resolves.toEqual({
      kind: "command",
      command: "remove",
      options: {
        selectItems: true,
        dryRun: false,
        global: false,
      },
    });
  });

  it("parses included-item remove without requiring a bundle", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs(["remove", "--include", "skills/review.md"]),
    ).resolves.toEqual({
      kind: "command",
      command: "remove",
      options: {
        includeItems: ["skills/review"],
        dryRun: false,
        global: false,
      },
    });
  });

  it("parses --json flag on list and status", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["list", "--json"])).resolves.toEqual({
      kind: "command",
      command: "list",
      options: { json: true },
    });

    await expect(parseCliArgs(["status", "--json"])).resolves.toEqual({
      kind: "command",
      command: "status",
      options: { json: true, global: false },
    });

    await expect(parseCliArgs(["check", "--json"])).resolves.toEqual({
      kind: "command",
      command: "check",
      options: { json: true },
    });
  });

  it("parses bundle-scoped check and update commands", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["check", "react-expert"])).resolves.toEqual({
      kind: "command",
      command: "check",
      options: { bundle: "react-expert", json: false },
    });

    await expect(
      parseCliArgs(["update", "react-expert", "--dry-run"]),
    ).resolves.toEqual({
      kind: "command",
      command: "update",
      options: { bundle: "react-expert", dryRun: true },
    });
  });

  it("parses add ref selectors including commit SHAs", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs(["add", "react-expert", "--ref", "stable"]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        bundle: "react-expert",
        protocol: "https",
        agents: [],
        dryRun: false,
        ref: "stable",
        global: false,
      },
    });

    await expect(
      parseCliArgs([
        "add",
        "react-expert",
        "--ref",
        "2813b888fb134532be3749c71a38ee111b788e5b",
      ]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        bundle: "react-expert",
        protocol: "https",
        agents: [],
        dryRun: false,
        ref: "2813b888fb134532be3749c71a38ee111b788e5b",
        global: false,
      },
    });
  });

  it("parses list source filters", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs(["list", "--source", "sjquant/ghosts"]),
    ).resolves.toEqual({
      kind: "command",
      command: "list",
      options: { json: false, source: "github.com/sjquant/ghosts" },
    });
  });

  it("parses --ssh flag and sets protocol to ssh", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs([
        "add",
        "github.com/user/ai-vault",
        "react-expert",
        "--ssh",
      ]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        source: "github.com/user/ai-vault",
        bundle: "react-expert",
        protocol: "ssh",
        agents: [],
        dryRun: false,
        global: false,
      },
    });
  });

  it("auto-detects SSH protocol from a git@ source URL with explicit bundle", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs(["add", "git@github.com:user/ai-vault.git", "react-expert"]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        source: "github.com/user/ai-vault",
        bundle: "react-expert",
        protocol: "ssh",
        agents: [],
        dryRun: false,
        global: false,
      },
    });
  });

  it("auto-detects SSH protocol and derives bundle name from a git@ source URL", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs(["add", "git@github.com:user/react-bundle.git"]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        source: "github.com/user/react-bundle",
        bundle: "react-bundle",
        protocol: "ssh",
        agents: [],
        dryRun: false,
        inferredBundleFromSource: true,
        global: false,
      },
    });
  });

  it("parses --dry-run flag on add, remove, and reset", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs(["add", "react-expert", "--dry-run"]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        bundle: "react-expert",
        protocol: "https",
        agents: [],
        dryRun: true,
        global: false,
      },
    });

    await expect(
      parseCliArgs(["remove", "react-expert", "--dry-run"]),
    ).resolves.toEqual({
      kind: "command",
      command: "remove",
      options: { bundle: "react-expert", dryRun: true, global: false },
    });

    await expect(parseCliArgs(["reset", "--dry-run"])).resolves.toEqual({
      kind: "command",
      command: "reset",
      options: { dryRun: true, global: false },
    });
  });

  it("parses --yes on mutating confirmation commands", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["update", "--yes"])).resolves.toEqual({
      kind: "command",
      command: "update",
      options: { dryRun: false, yes: true },
    });

    await expect(parseCliArgs(["apply", "--yes"])).resolves.toEqual({
      kind: "command",
      command: "apply",
      options: { dryRun: false, global: false, yes: true },
    });

    await expect(parseCliArgs(["reset", "--yes"])).resolves.toEqual({
      kind: "command",
      command: "reset",
      options: { dryRun: false, global: false, yes: true },
    });

    await expect(
      parseCliArgs(["remove", "react-expert", "--yes"]),
    ).resolves.toEqual({
      kind: "command",
      command: "remove",
      options: {
        bundle: "react-expert",
        dryRun: false,
        global: false,
        yes: true,
      },
    });
  });

  it("parses --all on add and remove", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs(["add", "sjquant/ghosts", "--all"]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        source: "github.com/sjquant/ghosts",
        protocol: "https",
        agents: [],
        dryRun: false,
        global: false,
        all: true,
      },
    });

    await expect(parseCliArgs(["remove", "--all"])).resolves.toEqual({
      kind: "command",
      command: "remove",
      options: {
        dryRun: false,
        global: false,
        all: true,
      },
    });

    await expect(
      parseCliArgs(["remove", "sjquant/ghosts", "--all"]),
    ).resolves.toEqual({
      kind: "command",
      command: "remove",
      options: {
        source: "github.com/sjquant/ghosts",
        dryRun: false,
        global: false,
        all: true,
      },
    });
  });

  it("rejects invalid --all argument combinations", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["add", "--all"])).rejects.toThrowError(
      /Command add --all requires a source/,
    );
    await expect(
      parseCliArgs(["add", "sjquant/ghosts", "core", "--all"]),
    ).rejects.toThrowError(/Command add --all does not accept a bundle name/);
    await expect(
      parseCliArgs([
        "add",
        "sjquant/ghosts",
        "--all",
        "--include",
        "skills/review",
      ]),
    ).rejects.toThrowError(/--all and --include cannot be used together/);
    await expect(
      parseCliArgs(["remove", "sjquant/ghosts", "core", "--all"]),
    ).rejects.toThrowError(
      /Command remove --all does not accept a bundle name/,
    );
  });

  it("rejects unknown commands and invalid arity", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["deploy"])).rejects.toThrowError(
      /Unknown command: "deploy"/,
    );
    await expect(parseCliArgs(["list", "extra"])).rejects.toThrowError(
      /Command list does not accept positional arguments/,
    );
    await expect(parseCliArgs(["status", "extra"])).rejects.toThrowError(
      /Command status does not accept positional arguments/,
    );
    await expect(parseCliArgs(["reset", "extra"])).rejects.toThrowError(
      /Command reset does not accept positional arguments/,
    );
    await expect(parseCliArgs(["sync", "extra"])).rejects.toThrowError(
      /Command sync does not accept positional arguments/,
    );
    await expect(parseCliArgs(["apply", "extra"])).rejects.toThrowError(
      /Command apply does not accept positional arguments/,
    );
    await expect(parseCliArgs(["add", "a", "b", "c"])).rejects.toThrowError(
      /Command add accepts at most 2 positional arguments/,
    );
    await expect(parseCliArgs(["remove", "a", "b", "c"])).rejects.toThrowError(
      /Command remove accepts at most 2 positional arguments/,
    );
    await expect(parseCliArgs(["check", "a", "b"])).rejects.toThrowError(
      /Command check accepts at most 1 positional argument/,
    );
    await expect(parseCliArgs(["update", "a", "b"])).rejects.toThrowError(
      /Command update accepts at most 1 positional argument/,
    );
    await expect(parseCliArgs(["remove"])).rejects.toThrowError(
      /Command remove requires a source or bundle name/,
    );
  });

  it("parses --disable-model-invocation flag for the add command", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs([
        "add",
        "github.com/user/ai-vault",
        "react-expert",
        "--disable-model-invocation",
      ]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        source: "github.com/user/ai-vault",
        bundle: "react-expert",
        protocol: "https",
        agents: [],
        dryRun: false,
        global: false,
        disableModelInvocation: true,
      },
    });

    await expect(
      parseCliArgs(["add", "react-expert", "--disable-model-invocation"]),
    ).resolves.toEqual({
      kind: "command",
      command: "add",
      options: {
        bundle: "react-expert",
        protocol: "https",
        agents: [],
        dryRun: false,
        global: false,
        disableModelInvocation: true,
      },
    });
  });

  it("rejects --select-items combined with --disable-model-invocation", async () => {
    // Given / When / Then
    await expect(
      parseCliArgs([
        "add",
        "react-expert",
        "--select-items",
        "--disable-model-invocation",
      ]),
    ).rejects.toThrowError(
      /--select-items and --disable-model-invocation cannot be used together/,
    );
  });

  it("suggests a close command when an unknown command is typed", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["addd"])).rejects.toThrowError(
      /did you mean "add"\?/,
    );
    await expect(parseCliArgs(["statuss"])).rejects.toThrowError(
      /did you mean "status"\?/,
    );
  });

  it("does not suggest a command when the input is too different", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["foobar"])).rejects.toThrowError(
      /Unknown command: "foobar"$/,
    );
  });

  it("returns per-command help when --help follows a known command", async () => {
    // Given / When / Then
    await expect(parseCliArgs(["add", "--help"])).resolves.toEqual({
      kind: "help",
      command: "add",
    });
    await expect(parseCliArgs(["status", "--help"])).resolves.toEqual({
      kind: "help",
      command: "status",
    });
    await expect(parseCliArgs(["list", "-h"])).resolves.toEqual({
      kind: "help",
      command: "list",
    });
  });
});

describe("createHelpText", () => {
  it("documents root instruction support and recovery in the top-level help", () => {
    // Given
    const command: undefined = undefined;

    // When
    const helpText = createHelpText(command);

    // Then
    expect(helpText).toContain(
      "cursor, codex, opencode, kiro, copilot, and antigravity target AGENTS.md; globally, codex targets .codex/AGENTS.md, opencode targets .config/opencode/AGENTS.md, kiro targets .kiro/steering/AGENTS.md, copilot targets .github/copilot-instructions.md, and antigravity targets .gemini/GEMINI.md; claude-code targets CLAUDE.md.",
    );
    expect(helpText).toContain(
      "Untracked root instructions are composed locally and hidden through .git/info/exclude.",
    );
    expect(helpText).toContain(
      "Tracked root instructions are rendered from HEAD plus Skul overlay content and marked skip-worktree.",
    );
    expect(helpText).toContain(
      "Use 'skul sync' for fast-forward pulls. For manual git updates, run 'skul shadow --suspend' before and 'skul shadow --refresh' after, as long as the root instruction file is still tracked.",
    );
    expect(helpText).toContain(
      "'skul status' reports tracked shadow health; manual edits to shadowed root instruction files are a current limitation.",
    );
  });

  it("documents root-instruction lifecycle details in add, shadow, and sync help", () => {
    // Given
    const addCommand = "add";
    const shadowCommand = "shadow";
    const syncCommand = "sync";

    // When
    const addHelpText = createHelpText(addCommand);
    const shadowHelpText = createHelpText(shadowCommand);
    const syncHelpText = createHelpText(syncCommand);

    // Then
    expect(addHelpText).toContain(
      "Bundles may contribute root instruction files alongside skills/ and commands/ content.",
    );
    expect(addHelpText).toContain(
      "If the target root instruction file is already tracked, Skul creates a tracked shadow instead of leaving a visible git diff.",
    );
    expect(shadowHelpText).toContain(
      "Suspend or refresh tracked root instruction shadows",
    );
    expect(shadowHelpText).toContain(
      "--suspend restores tracked root instruction files from HEAD and clears skip-worktree.",
    );
    expect(shadowHelpText).toContain(
      "--refresh rebuilds the effective shadow from the latest HEAD plus Skul overlay content and re-enables skip-worktree.",
    );
    expect(shadowHelpText).toContain(
      "The manual suspend/refresh flow only works when the root instruction file is still tracked after the Git update.",
    );
    expect(shadowHelpText).toContain("skul shadow --suspend");
    expect(syncHelpText).toContain(
      "Safely pull git updates around tracked root instruction shadows",
    );
    expect(syncHelpText).toContain(
      "Typical workflow: skul shadow --suspend -> git pull --ff-only -> skul shadow --refresh",
    );
    expect(syncHelpText).toContain(
      "Prefer this in headless automation so tracked root instruction shadows are suspended and restored in one step.",
    );
    expect(syncHelpText).toContain(
      "If git pull fails, Skul attempts to restore the prior shadow state before returning the error.",
    );
  });
});
