import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool } from "./types.js";
import { requireString } from "./types.js";
import type { Workspace } from "../workspace.js";

const MAX_READ_BYTES = 512_000;
const MAX_LIST_ENTRIES = 400;
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "out", "build", ".next", "target"]);

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a UTF-8 text file from the workspace. Optionally provide 1-based start_line and end_line to read a range.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path." },
      start_line: { type: "number", description: "First line to include (1-based)." },
      end_line: { type: "number", description: "Last line to include (inclusive)." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const relative = requireString(input, "path");
    const absolute = ctx.workspace.resolveRead(relative);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat || !stat.isFile()) {
      return { content: `File not found: ${relative}`, isError: true };
    }
    if (stat.size > MAX_READ_BYTES) {
      return {
        content: `File is ${stat.size} bytes, larger than the ${MAX_READ_BYTES} byte read limit.`,
        isError: true,
      };
    }
    const raw = await fs.readFile(absolute, "utf8");
    const lines = raw.split(/\r?\n/);
    const start = typeof input.start_line === "number" ? Math.max(1, input.start_line) : 1;
    const end = typeof input.end_line === "number" ? input.end_line : lines.length;
    const slice = lines.slice(start - 1, end);
    const numbered = slice
      .map((line, index) => `${start + index}: ${line}`)
      .join("\n");
    return { content: numbered || "(empty file)" };
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Create or overwrite a UTF-8 text file in the workspace. Parent directories are created automatically.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path." },
      content: { type: "string", description: "Full file contents to write." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const relative = requireString(input, "path");
    const content = requireString(input, "content");
    const absolute = ctx.workspace.resolve(relative);
    const existing = await fs.readFile(absolute, "utf8").catch(() => null);
    const existed = existing !== null;

    if (ctx.proposeFileChange) {
      const accepted = await ctx.proposeFileChange({
        path: relative,
        absolute,
        before: existing ?? "",
        after: content,
      });
      if (!accepted) return { content: `Change to ${relative} was rejected.` };
      // The host applied it; report without touching disk a second time.
      return { content: `${existed ? "Updated" : "Created"} ${relative} (${content.length} bytes)` };
    }

    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
    return { content: `${existed ? "Updated" : "Created"} ${relative} (${content.length} bytes)` };
  },
};

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Replace the first exact occurrence of `old_string` with `new_string` in a workspace file. Fails if the text is not found or is ambiguous.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const relative = requireString(input, "path");
    const oldString = requireString(input, "old_string");
    const newString = requireString(input, "new_string");
    const absolute = ctx.workspace.resolve(relative);
    const raw = await fs.readFile(absolute, "utf8").catch(() => null);
    if (raw === null) return { content: `File not found: ${relative}`, isError: true };
    const first = raw.indexOf(oldString);
    if (first === -1) {
      return { content: `Text to replace was not found in ${relative}`, isError: true };
    }
    if (raw.indexOf(oldString, first + 1) !== -1) {
      return {
        content: `Text occurs more than once in ${relative}; provide more surrounding context.`,
        isError: true,
      };
    }
    const next = raw.slice(0, first) + newString + raw.slice(first + oldString.length);

    if (ctx.proposeFileChange) {
      const accepted = await ctx.proposeFileChange({
        path: relative,
        absolute,
        before: raw,
        after: next,
      });
      if (!accepted) return { content: `Change to ${relative} was rejected.` };
      return { content: `Edited ${relative}` };
    }

    await fs.writeFile(absolute, next, "utf8");
    return { content: `Edited ${relative}` };
  },
};

export const listDirTool: Tool = {
  name: "list_dir",
  description:
    "List files and directories inside the workspace. Directory names end with a slash. Common build/vendor directories are skipped.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative directory (defaults to root)." },
    },
    additionalProperties: false,
  },
  async run(input, ctx) {
    const relative = input.path === undefined ? "." : requireString(input, "path");
    const absolute = ctx.workspace.resolveRead(relative);
    const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => null);
    if (!entries) return { content: `Directory not found: ${relative}`, isError: true };
    const lines = entries
      .filter((entry) => !IGNORED_DIRS.has(entry.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, MAX_LIST_ENTRIES)
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    return { content: lines.join("\n") || "(empty directory)" };
  },
};

export const searchTool: Tool = {
  name: "search",
  description:
    "Search workspace text files for a literal substring. Returns matching file paths with line numbers.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      path: { type: "string", description: "Directory to search (defaults to root)." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const query = requireString(input, "query");
    const relative = input.path === undefined ? "." : requireString(input, "path");
    const startDir = ctx.workspace.resolveRead(relative);
    const matches: string[] = [];
    await walk(startDir, ctx.workspace, query, matches, 0);
    return { content: matches.slice(0, 200).join("\n") || "No matches." };
  },
};

async function walk(
  dir: string,
  workspace: Workspace,
  query: string,
  matches: string[],
  depth: number,
): Promise<void> {
  if (depth > 12 || matches.length >= 200) return;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (matches.length >= 200) return;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), workspace, query, matches, depth + 1);
      continue;
    }
    if (!/\.(ts|tsx|js|jsx|json|md|css|html|py|rs|go|java|rb|toml|yml|yaml|txt)$/i.test(entry.name)) {
      continue;
    }
    const absolute = path.join(dir, entry.name);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat || stat.size > 256_000) continue;
    const content = await fs.readFile(absolute, "utf8").catch(() => null);
    if (content === null) continue;
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.includes(query) && matches.length < 200) {
        matches.push(`${workspace.relative(absolute)}:${index + 1}: ${line.trim().slice(0, 200)}`);
      }
    });
  }
}
