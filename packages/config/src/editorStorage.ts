import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApiKeyProviderConfig, ProviderConfig } from "@click/contracts";

/**
 * Reads the provider credentials a user entered in the editor's own
 * "LLM Providers" settings page.
 *
 * That page is Cursor's UI, and it persists into the workbench's reactive
 * storage — a VS Code `state.vscdb` SQLite database — under the
 * `applicationUser` key. Click's provider layer reads `~/.click/settings.json`,
 * so this module bridges the two: the gateway merges what the editor wrote over
 * what is on disk, which makes the settings page functional without asking the
 * user to edit JSON.
 *
 * Everything here is best-effort and read-only: a missing database, an older
 * Node without `node:sqlite`, or an unexpected shape all resolve to "no
 * configuration", never to an error.
 */

/** Candidate locations of the editor's global state database. */
export function editorStateDbPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const paths: string[] = [];
  const push = (value: string | undefined) => {
    if (value && !paths.includes(value)) paths.push(value);
  };
  push(env.CLICK_EDITOR_STATE_DB);
  const appData = env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  for (const folder of ["Click", "click", ".click", "Cursor"]) {
    push(path.join(appData, folder, "User", "globalStorage", "state.vscdb"));
  }
  return paths;
}

const APPLICATION_USER_SUFFIX = ".persistentStorage.applicationUser";

interface RawProviderEntry {
  apiKey?: unknown;
  baseUrl?: unknown;
  headers?: unknown;
  type?: unknown;
}

/** Parses the stored `applicationUser` JSON into Click provider configs. */
export function providerConfigsFromStorage(json: unknown): Record<string, ProviderConfig> {
  if (!json || typeof json !== "object") return {};
  const storage = json as Record<string, unknown>;
  const raw = storage.clickProviders;
  if (!raw || typeof raw !== "object") return {};

  const result: Record<string, ProviderConfig> = {};
  for (const [id, entry] of Object.entries(raw as Record<string, RawProviderEntry>)) {
    if (!entry || typeof entry !== "object") continue;
    // The page stores an explicit enable switch per provider.
    const enabled = storage[`clickUseProvider_${id}`];
    if (enabled === false) continue;

    const config: ApiKeyProviderConfig = { type: "api-key" };
    if (typeof entry.apiKey === "string" && entry.apiKey.trim().length > 0) {
      config.apiKey = entry.apiKey.trim();
    }
    if (typeof entry.baseUrl === "string" && entry.baseUrl.trim().length > 0) {
      config.baseUrl = entry.baseUrl.trim();
    }
    if (entry.headers && typeof entry.headers === "object") {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(entry.headers as Record<string, unknown>)) {
        if (value !== undefined && value !== null) headers[name] = String(value);
      }
      if (Object.keys(headers).length > 0) config.headers = headers;
    }
    // Only keep entries that carry something usable.
    if (config.apiKey !== undefined || config.baseUrl !== undefined || config.headers !== undefined) {
      result[id] = config;
    }
  }
  return result;
}

/** Reads the editor's settings-page provider configs, or `{}` when unavailable. */
export async function readEditorProviders(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, ProviderConfig>> {
  for (const dbPath of editorStateDbPaths(env)) {
    if (!fs.existsSync(dbPath)) continue;
    const configs = await readFromDatabase(dbPath);
    if (Object.keys(configs).length > 0) return configs;
  }
  return {};
}

async function readFromDatabase(dbPath: string): Promise<Record<string, ProviderConfig>> {
  let DatabaseSync: (new (file: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { all(...params: unknown[]): unknown[] };
    close(): void;
  }) | undefined;
  try {
    // `node:sqlite` is experimental; importing it lazily keeps older runtimes working.
    const mod = (await import("node:sqlite")) as unknown as { DatabaseSync: typeof DatabaseSync };
    DatabaseSync = mod.DatabaseSync;
  } catch {
    return {};
  }
  if (!DatabaseSync) return {};

  let db: InstanceType<typeof DatabaseSync> | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare("select key, value from ItemTable where key like ?")
      .all(`%${APPLICATION_USER_SUFFIX}`) as Array<{ key?: unknown; value?: unknown }>;
    for (const row of rows) {
      const value = row.value;
      const text =
        typeof value === "string"
          ? value
          : value instanceof Uint8Array
            ? Buffer.from(value).toString("utf8")
            : undefined;
      if (!text) continue;
      try {
        const parsed = providerConfigsFromStorage(JSON.parse(text));
        if (Object.keys(parsed).length > 0) return parsed;
      } catch {
        // Not JSON we understand; keep looking.
      }
    }
    return {};
  } catch {
    return {};
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Merges editor-page provider configs over file-based ones, per provider, so a
 * value the user typed in the UI wins while anything it does not mention (extra
 * headers, disabled models) is preserved.
 */
export function mergeProviderConfigs(
  base: Record<string, ProviderConfig>,
  overlay: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  const merged: Record<string, ProviderConfig> = { ...base };
  for (const [id, config] of Object.entries(overlay)) {
    const existing = merged[id];
    merged[id] =
      existing && existing.type === "api-key" && config.type === "api-key"
        ? { ...existing, ...config }
        : config;
  }
  return merged;
}
