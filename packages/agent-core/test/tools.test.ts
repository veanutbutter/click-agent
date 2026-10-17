import { mkdtemp, writeFile as fsWrite, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtInTools, selectTools, type Tool } from "../src/index.js";
import { Workspace } from "../src/workspace.js";
import type { ToolContext } from "../src/tools/types.js";

let root: string;
let workspace: Workspace;
let ctx: ToolContext;

function tool(name: string): Tool {
  const found = builtInTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "click-tools-"));
  workspace = new Workspace(root);
  ctx = { workspace };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("selectTools", () => {
  it("filters by name", () => {
    expect(selectTools(["read_file"]).map((entry) => entry.name)).toEqual(["read_file"]);
  });

  it("returns every tool when given no list", () => {
    expect(selectTools()).toHaveLength(builtInTools().length);
  });

  it("marks mutating tools", () => {
    const mutating = builtInTools()
      .filter((entry) => entry.mutating)
      .map((entry) => entry.name);
    expect(mutating.sort()).toEqual(["edit_file", "run_command", "write_file"]);
  });
});

describe("workspace containment", () => {
  it("resolves paths inside the root", () => {
    expect(workspace.resolve("src/app.ts")).toBe(path.join(root, "src", "app.ts"));
  });

  it("rejects escapes", () => {
    expect(() => workspace.resolve("../outside.txt")).toThrow(/outside/i);
    expect(() => workspace.resolve(path.join(root, "..", "x"))).toThrow();
  });

  it("accepts the root itself", () => {
    expect(workspace.resolve(".")).toBe(path.resolve(root));
  });
});

describe("file tools", () => {
  it("writes and reads files with line numbers", async () => {
    await tool("write_file").run({ path: "notes/a.txt", content: "alpha\nbeta" }, ctx);
    const result = await tool("read_file").run({ path: "notes/a.txt" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("1: alpha");
    expect(result.content).toContain("2: beta");
  });

  it("returns an error for missing files", async () => {
    const result = await tool("read_file").run({ path: "nope.txt" }, ctx);
    expect(result.isError).toBe(true);
  });

  it("refuses writes outside the workspace", async () => {
    await expect(
      tool("write_file").run({ path: "../escape.txt", content: "x" }, ctx),
    ).rejects.toThrow();
  });

  it("edits a unique occurrence", async () => {
    await tool("write_file").run({ path: "a.txt", content: "hello world" }, ctx);
    const result = await tool("edit_file").run(
      { path: "a.txt", old_string: "world", new_string: "there" },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("hello there");
  });

  it("refuses an ambiguous edit", async () => {
    await tool("write_file").run({ path: "a.txt", content: "x x" }, ctx);
    const result = await tool("edit_file").run(
      { path: "a.txt", old_string: "x", new_string: "y" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/multiple|ambiguous|more than once/i);
  });

  it("errors when the edit target is absent", async () => {
    await tool("write_file").run({ path: "a.txt", content: "hello" }, ctx);
    const result = await tool("edit_file").run(
      { path: "a.txt", old_string: "zzz", new_string: "y" },
      ctx,
    );
    expect(result.isError).toBe(true);
  });

  it("lists directories and hides noise", async () => {
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await fsWrite(path.join(root, "node_modules", "junk.js"), "x");
    await fsWrite(path.join(root, "index.ts"), "x");
    await mkdir(path.join(root, "src"), { recursive: true });
    const result = await tool("list_dir").run({ path: "." }, ctx);
    expect(result.content).toContain("index.ts");
    expect(result.content).toContain("src/");
    expect(result.content).not.toContain("node_modules");
  });

  it("searches file contents", async () => {
    await fsWrite(path.join(root, "a.ts"), "const needle = 1;");
    await fsWrite(path.join(root, "b.ts"), "const other = 2;");
    const result = await tool("search").run({ query: "needle" }, ctx);
    expect(result.content).toContain("a.ts");
    expect(result.content).not.toContain("b.ts");
  });
});

describe("run_command", () => {
  it("executes and reports output", async () => {
    const result = await tool("run_command").run({ command: "echo click" }, ctx);
    expect(result.content).toContain("click");
    expect(result.isError).toBe(false);
  });

  it("flags a non-zero exit", async () => {
    const result = await tool("run_command").run({ command: "exit 3" }, ctx);
    expect(result.isError).toBe(true);
  });
});
