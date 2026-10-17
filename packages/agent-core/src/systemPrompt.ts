import { promises as fs } from "node:fs";
import path from "node:path";

export const DEFAULT_SYSTEM_PROMPT = `You are Click, an AI coding agent embedded in a code editor.

You help the user understand, write, and modify code in their open workspace.

Rules:
- Use the provided tools to inspect the workspace before making claims about it. Never invent file contents.
- Prefer small, surgical edits. Use edit_file for targeted changes and write_file for new files.
- After making changes, verify them with run_command when a build, test, or linter is available.
- Keep responses concise and focused on the user's request. Use markdown for code and lists.
- If a request is ambiguous or would be destructive, ask before proceeding.
- Reads may reach outside the workspace when the user asks for them; writes must stay inside it.`;

export function buildSystemPrompt(extra?: string): string {
  if (!extra || !extra.trim()) return DEFAULT_SYSTEM_PROMPT;
  return `${DEFAULT_SYSTEM_PROMPT}\n\nProject context:\n${extra.trim()}`;
}

/**
 * Rule files, in the order the ecosystem uses them. These are the user's
 * standing instructions — "stay in the lane" — and they are read from the
 * workspace, so a repo can carry its own.
 */
const RULE_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules", "CLICK.md"];

/** Directories whose `*.md` files are all rule files. */
const RULE_DIRS = [".cursor/rules", ".click/rules", ".github/instructions"];

const MAX_RULE_BYTES = 64_000;
/** How many parent directories above the workspace to look in. */
const PARENT_LEVELS = 2;

/**
 * Collect the user's standing instructions for a workspace: `AGENTS.md` and
 * friends at the workspace root, then the same in up to two parent directories
 * (so a monorepo's rules apply to a nested folder), then any rule directories.
 *
 * Later files do not override earlier ones; they are concatenated in a stable
 * order so the result is deterministic. Returns `undefined` when there is
 * nothing to add.
 */
export async function loadProjectRules(workspaceRoot: string): Promise<string | undefined> {
  const sections: string[] = [];
  const seen = new Set<string>();

  const roots: string[] = [];
  let current = path.resolve(workspaceRoot);
  for (let level = 0; level <= PARENT_LEVELS; level += 1) {
    roots.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Nearest rules last, so the closest file has the final word in the prompt.
  roots.reverse();

  for (const root of roots) {
    for (const name of RULE_FILES) {
      const file = path.join(root, name);
      if (seen.has(file)) continue;
      seen.add(file);
      const text = await readText(file);
      if (text) sections.push(`# ${name} (${path.relative(workspaceRoot, file) || "."})\n${text}`);
    }
    for (const dir of RULE_DIRS) {
      const absolute = path.join(root, dir);
      const entries = await fs.readdir(absolute).catch(() => [] as string[]);
      for (const entry of entries.sort()) {
        if (!entry.endsWith(".md")) continue;
        const file = path.join(absolute, entry);
        if (seen.has(file)) continue;
        seen.add(file);
        const text = await readText(file);
        if (text) sections.push(`# ${dir}/${entry}\n${text}`);
      }
    }
  }

  if (sections.length === 0) return undefined;
  return sections.join("\n\n");
}

async function readText(file: string): Promise<string | undefined> {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat || !stat.isFile() || stat.size === 0) return undefined;
  if (stat.size > MAX_RULE_BYTES) {
    return `(file is ${stat.size} bytes; only the first ${MAX_RULE_BYTES} are included)\n${(
      await fs.readFile(file, "utf8")
    ).slice(0, MAX_RULE_BYTES)}`;
  }
  return (await fs.readFile(file, "utf8").catch(() => undefined))?.trim() || undefined;
}
