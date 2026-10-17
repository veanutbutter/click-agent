import { describe, expect, it } from "vitest";

import { diffLines, isNoop, reconstructBefore, summarize } from "../src/reviewModel.js";
describe("diffLines", () => {
  it("reports no hunks for identical text", () => {
    expect(diffLines("alpha\nbeta\n", "alpha\nbeta\n")).toEqual([]);
  });

  it("groups an appended line into one hunk", () => {
    const hunks = diffLines("alpha\n", "alpha\nbeta\n");
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.removed).toEqual([]);
    expect(hunks[0]?.added).toEqual(["beta"]);
  });

  it("groups a replacement as removed plus added", () => {
    const hunks = diffLines("one\ntwo\nthree\n", "one\nTWO\nthree\n");
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.removed).toEqual(["two"]);
    expect(hunks[0]?.added).toEqual(["TWO"]);
    expect(hunks[0]?.beforeStart).toBe(1);
    expect(hunks[0]?.afterStart).toBe(1);
  });

  it("keeps distant changes as separate hunks", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const after = ["A", "b", "c", "d", "e", "f", "G"].join("\n");
    const hunks = diffLines(before, after);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.removed).toEqual(["a"]);
    expect(hunks[1]?.removed).toEqual(["g"]);
  });

  it("treats a new file as one added hunk", () => {
    const hunks = diffLines("", "line one\nline two\n");
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.removed).toEqual([]);
    expect(hunks[0]?.added).toEqual(["line one", "line two"]);
  });

  it("treats a deleted file as one removed hunk", () => {
    const hunks = diffLines("gone\n", "");
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.removed).toEqual(["gone"]);
    expect(hunks[0]?.added).toEqual([]);
  });

  it("handles CRLF without spurious hunks", () => {
    expect(diffLines("a\r\nb\r\n", "a\nb\n")).toEqual([]);
  });

  it("describes the exact OpenCode edit shape from the ACP stream", () => {
    // rawInput was { oldString: "alpha", newString: "alpha\nbeta" }.
    const hunks = diffLines("alpha\n", "alpha\nbeta\n");
    expect(summarize(hunks)).toBe("+1 −0");
  });
});

describe("isNoop", () => {
  it("is true when nothing changed", () => {
    expect(isNoop({ path: "a.ts", before: "x", after: "x" })).toBe(true);
  });

  it("is false when the text changed", () => {
    expect(isNoop({ path: "a.ts", before: "x", after: "y" })).toBe(false);
  });
});

describe("reconstructBefore", () => {
  it("recovers the original from the edit the agent reported", () => {
    // The real ACP payload: oldString "alpha", newString "alpha\nbeta".
    expect(reconstructBefore("alpha\nbeta\n", "alpha", "alpha\nbeta")).toBe("alpha\n");
  });

  it("recovers a replacement", () => {
    expect(reconstructBefore("keep\nchanged\n", "change me", "changed")).toBe("keep\nchange me\n");
  });

  it("returns the text unchanged when the substitution is not present", () => {
    expect(reconstructBefore("something else\n", "alpha", "beta")).toBe("something else\n");
  });

  it("is a no-op when old and new are identical", () => {
    expect(reconstructBefore("same\n", "same", "same")).toBe("same\n");
  });

  it("round-trips with the diff, so the review shows the real change", () => {
    const after = "alpha\nbeta\n";
    const before = reconstructBefore(after, "alpha", "alpha\nbeta");
    const hunks = diffLines(before, after);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.added).toEqual(["beta"]);
  });
});

describe("summarize", () => {
  it("counts added and removed lines across hunks", () => {
    // "a" is replaced by "A" (one removed, one added) and "d" is appended.
    const hunks = diffLines("a\nb\nc\n", "A\nb\nc\nd\n");
    expect(summarize(hunks)).toBe("+2 −1");
  });

  it("reports zeroes when nothing changed", () => {
    expect(summarize(diffLines("same", "same"))).toBe("+0 −0");
  });
});
