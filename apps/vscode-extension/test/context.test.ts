import { describe, expect, it } from "vitest";

import { describeContext, formatContext, mergeContext, type ChatContextItem } from "../src/context.js";

const selection: ChatContextItem = {
  kind: "selection",
  path: "C:/repo/src/app.ts",
  label: "src/app.ts",
  startLine: 12,
  endLine: 18,
  text: "const a = 1;\nconst b = 2;",
};

const file: ChatContextItem = {
  kind: "file",
  path: "C:/repo/package.json",
  label: "package.json",
};

const folder: ChatContextItem = { kind: "folder", path: "C:/repo/src", label: "src" };

describe("describeContext", () => {
  it("labels a multi-line selection with its range", () => {
    expect(describeContext(selection)).toBe("src/app.ts:12-18");
  });

  it("collapses a single-line selection to one number", () => {
    expect(describeContext({ ...selection, startLine: 7, endLine: 7 })).toBe("src/app.ts:7");
  });

  it("marks a folder with a trailing slash", () => {
    expect(describeContext(folder)).toBe("src/");
  });

  it("labels a file plainly", () => {
    expect(describeContext(file)).toBe("package.json");
  });
});

describe("formatContext", () => {
  it("is empty when nothing is attached", () => {
    expect(formatContext([])).toBe("");
  });

  it("inlines a selection, because those exact lines are the point", () => {
    const text = formatContext([selection]);
    expect(text).toContain("Context the user attached:");
    expect(text).toContain("src/app.ts:12-18");
    expect(text).toContain("const a = 1;");
    expect(text).toContain("```");
  });

  it("names a file rather than inlining it", () => {
    const text = formatContext([file]);
    expect(text).toContain("package.json (file)");
    expect(text).not.toContain("```");
  });

  it("names a folder as a folder", () => {
    expect(formatContext([folder])).toContain("src/ (folder)");
  });

  it("includes every attached item", () => {
    const text = formatContext([selection, file, folder]);
    expect(text).toContain("src/app.ts:12-18");
    expect(text).toContain("package.json");
    expect(text).toContain("src/");
  });
});

describe("mergeContext", () => {
  it("appends a new item", () => {
    expect(mergeContext([], file)).toEqual([file]);
  });

  it("does not duplicate the same file", () => {
    expect(mergeContext([file], file)).toHaveLength(1);
  });

  it("replaces an earlier mention of the same range", () => {
    const updated = { ...selection, text: "changed" };
    const merged = mergeContext([selection], updated);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe("changed");
  });

  it("keeps a file and a selection from that same file separate", () => {
    const fromSameFile: ChatContextItem = {
      kind: "selection",
      path: file.path,
      label: file.label,
      startLine: 1,
      endLine: 2,
      text: "{}",
    };
    expect(mergeContext([file], fromSameFile)).toHaveLength(2);
  });
});
