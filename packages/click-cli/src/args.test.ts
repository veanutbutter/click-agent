import { describe, expect, it } from "vitest";
import { boolFlag, flag, flagList, parseArgs } from "./args.js";

describe("parseArgs", () => {
  it("collects positionals", () => {
    expect(parseArgs(["agent", "write a test"]).positionals).toEqual(["agent", "write a test"]);
  });

  it("reads --key=value", () => {
    expect(flag(parseArgs(["--provider=openai"]), "provider")).toBe("openai");
  });

  it("reads --key value", () => {
    expect(flag(parseArgs(["--model", "gpt-5.1"]), "model")).toBe("gpt-5.1");
  });

  it("treats a bare flag as true", () => {
    const args = parseArgs(["--json"]);
    expect(boolFlag(args, "json")).toBe(true);
    expect(boolFlag(args, "quiet")).toBe(false);
  });

  it("collects repeated flags", () => {
    const args = parseArgs(["--acp-arg", "-y", "--acp-arg", "@zed-industries/claude-code-acp"]);
    expect(flagList(args, "acp-arg")).toEqual(["-y", "@zed-industries/claude-code-acp"]);
  });

  it("does not swallow the next flag as a value", () => {
    const args = parseArgs(["--json", "--provider", "openai"]);
    expect(boolFlag(args, "json")).toBe(true);
    expect(flag(args, "provider")).toBe("openai");
  });

  it("returns undefined for unknown flags", () => {
    expect(flag(parseArgs([]), "nope")).toBeUndefined();
    expect(flagList(parseArgs([]), "nope")).toEqual([]);
  });
});
