import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings, redactSettings, removeProvider, setProvider, settingsPath } from "./store.js";

let dir: string;
let env: Record<string, string>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "click-config-"));
  env = { CLICK_CONFIG_DIR: dir };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("settings store", () => {
  it("resolves the settings path from CLICK_CONFIG_DIR", () => {
    expect(settingsPath(env)).toBe(path.join(dir, "settings.json"));
  });

  it("returns defaults when nothing is saved", async () => {
    const settings = await loadSettings(env);
    expect(settings.providers).toEqual({});
    expect(settings.agent.maxIterations).toBe(25);
  });

  it("round-trips a provider", async () => {
    await setProvider("openai", { type: "api-key", apiKey: "sk-test" }, env);
    const settings = await loadSettings(env);
    expect(settings.providers.openai).toEqual({ type: "api-key", apiKey: "sk-test" });

    const raw = await readFile(settingsPath(env), "utf8");
    expect(JSON.parse(raw).providers.openai.apiKey).toBe("sk-test");
  });

  it("round-trips an ACP provider", async () => {
    await setProvider("claude-code", { type: "acp", command: "npx", args: ["-y", "agent"] }, env);
    const settings = await loadSettings(env);
    expect(settings.providers["claude-code"]).toEqual({
      type: "acp",
      command: "npx",
      args: ["-y", "agent"],
    });
  });

  it("removes a provider", async () => {
    await setProvider("openai", { type: "api-key", apiKey: "k" }, env);
    await setProvider("anthropic", { type: "api-key", apiKey: "a" }, env);
    const settings = await removeProvider("openai", env);
    expect(Object.keys(settings.providers)).toEqual(["anthropic"]);
  });

  it("falls back to defaults when the file is corrupt", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(settingsPath(env), "{not json", "utf8");
    expect((await loadSettings(env)).providers).toEqual({});
  });

  it("redacts API keys for display", () => {
    const redacted = redactSettings({
      providers: { openai: { type: "api-key", apiKey: "sk-abcdef123456" } },
      agent: { maxIterations: 25, autoApprove: false, enabledTools: [] },
    });
    const config = redacted.providers.openai as { apiKey?: string };
    expect(config.apiKey).toBe("***3456");
    expect(config.apiKey).not.toContain("abcdef");
  });
});
