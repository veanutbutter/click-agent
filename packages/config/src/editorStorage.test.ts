import { describe, expect, it } from "vitest";

import { mergeProviderConfigs, providerConfigsFromStorage } from "./editorStorage.js";

describe("providerConfigsFromStorage", () => {
  it("reads api key, base url and headers from the editor's settings page", () => {
    const configs = providerConfigsFromStorage({
      clickProviders: {
        openai: { apiKey: "sk-1", baseUrl: "https://api.openai.com/v1" },
        openrouter: { apiKey: "or-1", headers: { "HTTP-Referer": "https://x" } },
      },
    });
    expect(configs.openai).toEqual({
      type: "api-key",
      apiKey: "sk-1",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(configs.openrouter).toEqual({
      type: "api-key",
      apiKey: "or-1",
      headers: { "HTTP-Referer": "https://x" },
    });
  });

  it("honours the per-provider enable switch", () => {
    const configs = providerConfigsFromStorage({
      clickProviders: { openai: { apiKey: "sk-1" } },
      clickUseProvider_openai: false,
    });
    expect(configs.openai).toBeUndefined();
  });

  it("drops entries that carry nothing usable", () => {
    const configs = providerConfigsFromStorage({
      clickProviders: { openai: {}, ollama: { baseUrl: "http://localhost:11434/v1" } },
    });
    expect(configs.openai).toBeUndefined();
    expect(configs.ollama).toEqual({ type: "api-key", baseUrl: "http://localhost:11434/v1" });
  });

  it("tolerates missing or malformed storage", () => {
    expect(providerConfigsFromStorage(null)).toEqual({});
    expect(providerConfigsFromStorage({})).toEqual({});
    expect(providerConfigsFromStorage({ clickProviders: [] })).toEqual({});
  });
});

describe("mergeProviderConfigs", () => {
  it("lets the editor override a key while preserving extra fields", () => {
    const merged = mergeProviderConfigs(
      { "opencode-go": { type: "api-key", apiKey: "old", disabledModels: ["grok-4.7"] } },
      { "opencode-go": { type: "api-key", apiKey: "new" } },
    );
    expect(merged["opencode-go"]).toEqual({
      type: "api-key",
      apiKey: "new",
      disabledModels: ["grok-4.7"],
    });
  });

  it("adds providers that only exist in the editor", () => {
    const merged = mergeProviderConfigs({}, { groq: { type: "api-key", apiKey: "g" } });
    expect(merged.groq).toEqual({ type: "api-key", apiKey: "g" });
  });
});
