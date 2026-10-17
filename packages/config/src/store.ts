import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeSettings,
  type ClickSettings,
  type ProviderConfig,
} from "@click/contracts";

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLICK_CONFIG_DIR ?? path.join(os.homedir(), ".click");
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), "settings.json");
}

/** Load settings from disk, returning defaults when the file is absent/invalid. */
export async function loadSettings(env: NodeJS.ProcessEnv = process.env): Promise<ClickSettings> {
  try {
    const raw = await fs.readFile(settingsPath(env), "utf8");
    return normalizeSettings(JSON.parse(raw) as Partial<ClickSettings>);
  } catch {
    return normalizeSettings(undefined);
  }
}

export async function saveSettings(
  settings: ClickSettings,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const dir = configDir(env);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(settingsPath(env), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

/** Set or replace a single provider's configuration. */
export async function setProvider(
  id: string,
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClickSettings> {
  const settings = await loadSettings(env);
  settings.providers = { ...settings.providers, [id]: config };
  await saveSettings(settings, env);
  return settings;
}

export async function removeProvider(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClickSettings> {
  const settings = await loadSettings(env);
  const { [id]: _removed, ...rest } = settings.providers;
  settings.providers = rest;
  await saveSettings(settings, env);
  return settings;
}

/** Redact secrets for display or logging. */
export function redactSettings(settings: ClickSettings): ClickSettings {
  const providers: Record<string, ProviderConfig> = {};
  for (const [id, config] of Object.entries(settings.providers)) {
    if (config.type === "api-key") {
      providers[id] = {
        ...config,
        apiKey: config.apiKey ? `***${config.apiKey.slice(-4)}` : undefined,
      };
    } else {
      providers[id] = config;
    }
  }
  return { ...settings, providers };
}
