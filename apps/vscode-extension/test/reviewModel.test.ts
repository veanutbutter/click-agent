import { describe, expect, it } from "vitest";

import { diffLines, isNoop, reconstructBefore, resolveEdit, summarize } from "../src/reviewModel.js";
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

describe("resolveEdit", () => {
  /**
   * The real timing, verified against OpenCode's ACP stream: the edit is
   * announced before the write lands, so the file read at that moment is the
   * *pre-edit* text. Reversing the substitution cannot work on it, and doing
   * that silently showed nothing at all.
   */
  it("uses the file as 'before' when the write has not landed yet", () => {
    const resolved = resolveEdit(
      "this is a test, try changing it",
      "this is a test, try changing it",
      "this is a test, and I changed it",
    );
    expect(resolved).toEqual({
      before: "this is a test, try changing it",
      after: "this is a test, and I changed it",
    });
    // …and the pair diffs as the change the agent made.
    const hunks = diffLines(resolved!.before, resolved!.after);
    expect(hunks[0]?.removed).toEqual(["this is a test, try changing it"]);
    expect(hunks[0]?.added).toEqual(["this is a test, and I changed it"]);
  });

  it("recovers 'before' when the write already landed", () => {
    expect(
      resolveEdit("this is a test, and I changed it", "this is a test", "this is a test, and I changed it"),
    ).toEqual({ before: "this is a test", after: "this is a test, and I changed it" });
  });

  it("prefers the landed reading when newString still contains oldString", () => {
    // "alpha" → "alpha\nbeta": both sides are in the text once it lands.
    expect(resolveEdit("alpha\nbeta\n", "alpha", "alpha\nbeta")).toEqual({
      before: "alpha\n",
      after: "alpha\nbeta\n",
    });
  });

  it("resolves only the reported occurrence, not a later identical line", () => {
    expect(resolveEdit("same\nsame\n", "same", "changed")).toEqual({
      before: "same\nsame\n",
      after: "changed\nsame\n",
    });
  });

  it("treats an unreadable file as a new file being written", () => {
    expect(resolveEdit(undefined, "", "brand new\n")).toEqual({ before: "", after: "brand new\n" });
  });

  it("keeps the existing contents as 'before' for a whole-file write", () => {
    expect(resolveEdit("old contents\n", "", "new contents\n")).toEqual({
      before: "old contents\n",
      after: "new contents\n",
    });
  });

  it("refuses to guess when a whole-file write has already landed", () => {
    // The original is gone; showing it as an empty file would let "revert"
    // destroy the file rather than restore it.
    expect(resolveEdit("new contents\n", "", "new contents\n")).toBeUndefined();
  });

  it("has nothing to show when the file matches neither side", () => {
    expect(resolveEdit("unrelated\n", "alpha", "beta")).toBeUndefined();
  });

  it("has nothing to show when the edit is a no-op", () => {
    expect(resolveEdit("same\n", "same", "same")).toBeUndefined();
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
