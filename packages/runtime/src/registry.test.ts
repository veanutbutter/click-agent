import { describe, expect, it } from "vitest";
import { normalizeSettings } from "@click/contracts";
import type { ProviderContext } from "@click/provider-core";
import { describeProviders, providerContext, resolveProvider } from "./registry.js";

const ctx: ProviderContext = { env: {}, fetch: globalThis.fetch, cwd: process.cwd() };

describe("providerContext", () => {
  it("defaults to the process environment", () => {
    const context = providerContext();
    expect(context.fetch).toBe(globalThis.fetch);
    expect(typeof context.cwd).toBe("string");
  });

  it("applies overrides", () => {
    expect(providerContext({ cwd: "/tmp/x" }).cwd).toBe("/tmp/x");
  });
});

describe("resolveProvider", () => {
  it("explains how to fix an empty configuration", () => {
    const result = resolveProvider({ settings: normalizeSettings(null), ctx });
    expect(result.resolved).toBeUndefined();
    expect(result.error).toMatch(/No usable providers/);
  });

  it("picks the only configured provider and its first model", () => {
    const settings = normalizeSettings({
      providers: { openai: { type: "api-key", apiKey: "k" } },
    });
    const result = resolveProvider({ settings, ctx });
    expect(result.resolved?.provider.id).toBe("openai");
    expect(result.resolved?.model).toBe("gpt-5.1");
  });

  it("honours an explicit model", () => {
    const settings = normalizeSettings({
      providers: { openai: { type: "api-key", apiKey: "k" } },
    });
    expect(resolveProvider({ settings, model: "gpt-4.1", ctx }).resolved?.model).toBe("gpt-4.1");
  });

  it("prefers settings.defaultModel when no provider is given", () => {
    const settings = normalizeSettings({
      providers: {
        openai: { type: "api-key", apiKey: "k" },
        anthropic: { type: "api-key", apiKey: "a" },
      },
      defaultModel: { provider: "anthropic" as never, model: "claude-haiku-4-5" as never },
    });
    const result = resolveProvider({ settings, ctx });
    expect(result.resolved?.provider.id).toBe("anthropic");
    expect(result.resolved?.model).toBe("claude-haiku-4-5");
  });

  it("errors when the requested provider is not configured", () => {
    const settings = normalizeSettings({
      providers: { openai: { type: "api-key", apiKey: "k" } },
    });
    const result = resolveProvider({ settings, providerId: "anthropic", ctx });
    expect(result.resolved).toBeUndefined();
    expect(result.error).toMatch(/anthropic/);
  });

  it("skips providers without credentials", () => {
    const settings = normalizeSettings({ providers: { anthropic: { type: "api-key" } } });
    const result = resolveProvider({ settings, ctx });
    expect(result.resolved).toBeUndefined();
    expect(result.report.skipped.map((entry) => entry.id)).toEqual(["anthropic"]);
  });
});

describe("describeProviders", () => {
  it("reports nothing configured by default", () => {
    const entries = describeProviders(normalizeSettings(null), ctx);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => !entry.configured)).toBe(true);
    expect(entries[0]?.reason).toBe("no credentials configured");
  });

  it("marks a provider ready once it has credentials", () => {
    const settings = normalizeSettings({
      providers: { openai: { type: "api-key", apiKey: "k" } },
    });
    const entries = describeProviders(settings, ctx);
    const openai = entries.find((entry) => entry.descriptor.id === "openai");
    const anthropic = entries.find((entry) => entry.descriptor.id === "anthropic");
    expect(openai?.configured).toBe(true);
    expect(openai?.reason).toBeUndefined();
    expect(anthropic?.configured).toBe(false);
  });

  it("exposes the built-in provider catalogue", () => {
    const ids = describeProviders(normalizeSettings(null), ctx).map((entry) => entry.descriptor.id);
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai-compatible");
    expect(ids).toContain("claude-code");
    expect(ids).toContain("acp-custom");
  });
});
