import { describe, expect, it, vi } from "vitest";

import { parseCliArgs } from "./cli";
import { run } from "./index";

describe("parseCliArgs", () => {
  it("returns help when no command is provided", async () => {
    await expect(parseCliArgs([])).resolves.toEqual({ kind: "help" });
  });

  it("parses non-mutating commands without arguments", async () => {
    await expect(parseCliArgs(["list"])).resolves.toEqual({ kind: "command", command: "list" });
    await expect(parseCliArgs(["status"])).resolves.toEqual({ kind: "command", command: "status" });
    await expect(parseCliArgs(["clean"])).resolves.toEqual({ kind: "command", command: "clean" });
  });

  it("parses use in interactive, cached, and explicit source modes", async () => {
    const selectBundle = vi.fn().mockResolvedValue("react-expert");

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
    await expect(parseCliArgs(["install", "react-expert"])).resolves.toEqual({
      kind: "command",
      command: "install",
      options: { mode: "tracked", bundle: "react-expert" },
    });
  });

  it("rejects unknown commands and invalid arity", async () => {
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
    await expect(run([])).resolves.toMatch(/^Usage: skul /);
  });
});
