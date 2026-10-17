import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Loads MCP servers from the editor's own configuration and converts them to
 * the shape the Agent Client Protocol expects in `session/new`.
 *
 * The editor (Cursor/Click) stores servers in `mcp.json` files — a user-level
 * one and a per-workspace one — using the Claude-compatible schema:
 *
 *   { "mcpServers": {
 *       "fs":     { "command": "npx", "args": ["-y", "…"], "env": { "K": "V" } },
 *       "remote": { "url": "https://…/mcp", "headers": { "Authorization": "…" } }
 *   } }
 *
 * ACP wants a list, with `env`/`headers` as `{name,value}` pairs, so this module
 * is purely a translation plus the file lookup. It never throws: a missing or
 * malformed file simply contributes nothing.
 */

export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
  | { name: string; url: string; headers: Array<{ name: string; value: string }> };

/** Where an editor keeps `mcp.json`, most specific last. */
export function mcpConfigPaths(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = os.homedir();
  const paths: string[] = [];
  const push = (value: string | undefined) => {
    if (value && !paths.includes(value)) paths.push(value);
  };

  // User level. `.click` is this fork's data folder; `.cursor` is the original
  // name, kept so an existing configuration keeps working.
  push(path.join(home, ".click", "mcp.json"));
  push(path.join(home, ".cursor", "mcp.json"));

  // Workspace level, which overrides the user level.
  push(path.join(cwd, ".click", "mcp.json"));
  push(path.join(cwd, ".cursor", "mcp.json"));

  // An explicit override for tests or unusual layouts.
  if (env.CLICK_MCP_CONFIG) push(env.CLICK_MCP_CONFIG);
  return paths;
}

function toPairs(value: unknown): Array<{ name: string; value: string }> {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([name, v]) => ({ name, value: String(v) }));
}

/** Converts one `mcpServers` map entry, or null when it is not usable. */
export function toAcpServer(name: string, entry: unknown): AcpMcpServer | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  // A disabled server is expressed by Cursor as `"disabled": true`.
  if (record.disabled === true) return null;

  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (command.length > 0) {
    const args = Array.isArray(record.args) ? record.args.map((a) => String(a)) : [];
    return { name, command, args, env: toPairs(record.env) };
  }

  const url = typeof record.url === "string" ? record.url.trim() : "";
  if (url.length > 0) {
    return { name, url, headers: toPairs(record.headers) };
  }

  return null;
}

/** Converts a parsed `mcp.json` document into ACP servers. */
export function parseMcpConfig(json: unknown): AcpMcpServer[] {
  if (!json || typeof json !== "object") return [];
  const servers = (json as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object") return [];
  const result: AcpMcpServer[] = [];
  for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
    const converted = toAcpServer(name, entry);
    if (converted) result.push(converted);
  }
  return result;
}

/**
 * Reads every known `mcp.json`, later files winning on a name collision, and
 * returns the combined ACP server list.
 */
export async function loadMcpServers(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AcpMcpServer[]> {
  const merged = new Map<string, AcpMcpServer>();
  for (const file of mcpConfigPaths(cwd, env)) {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const server of parseMcpConfig(parsed)) merged.set(server.name, server);
  }
  return [...merged.values()];
}
