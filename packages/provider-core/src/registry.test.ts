import { describe, expect, it } from "vitest";
import {
  normalizeSettings,
  type ChatStreamEvent,
  type ModelInfo,
  type ProviderDescriptor,
} from "@click/contracts";
import type { ChatProvider, ProviderContext, ProviderFactory } from "./chatProvider.js";
import { ProviderRegistry, collectModels, findModel } from "./registry.js";

const ctx: ProviderContext = { env: {}, fetch: globalThis.fetch, cwd: process.cwd() };

function descriptor(id: string, models: string[] = ["m1"]): ProviderDescriptor {
  return {
    id: id as ProviderDescriptor["id"],
    name: id,
    kind: "api-key",
    badge: id.slice(0, 1).toUpperCase(),
    accent: "#000000",
    description: `${id} provider`,
    requiresApiKey: true,
    supportsCustomBaseUrl: false,
    models: models.map((model) => ({
      id: model as ModelInfo["id"],
      name: model,
      provider: id as ModelInfo["provider"],
      contextWindow: 1000,
      supportsTools: true,
      supportsImages: false,
      supportsThinking: false,
      supportsStreaming: true,
    })),
  };
}

class StubProvider implements ChatProvider {
  readonly id: ProviderDescriptor["id"];
  readonly descriptor: ProviderDescriptor;
  disposed = false;
  constructor(readonly desc: ProviderDescriptor) {
    this.id = desc.id;
    this.descriptor = desc;
  }
  async listModels(): Promise<ModelInfo[]> {
    return this.descriptor.models;
  }
  async check() {
    return { ok: true };
  }
  async *stream(): AsyncIterable<ChatStreamEvent> {
    yield { type: "stop", reason: "end_turn" };
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function factoryFor(desc: ProviderDescriptor, requireKey = true): ProviderFactory {
  return {
    descriptor: desc,
    create(config) {
      if (requireKey) {
        const key = (config as { apiKey?: string } | null)?.apiKey;
        if (!key) return null;
      }
      return new StubProvider(desc);
    },
  };
}

describe("ProviderRegistry", () => {
  it("rejects duplicate registrations", () => {
    const registry = new ProviderRegistry().register(factoryFor(descriptor("a")));
    expect(() => registry.register(factoryFor(descriptor("a")))).toThrow(/already registered/);
  });

  it("reports unusable configuration as a skip instead of throwing", () => {
    const registry = new ProviderRegistry().register(factoryFor(descriptor("a")));
    const settings = normalizeSettings({ providers: { a: { type: "api-key" } } });
    const report = registry.build(settings, ctx);
    expect(report.providers).toHaveLength(0);
    expect(report.skipped).toEqual([
      { id: "a", reason: "insufficient configuration (missing credentials?)" },
    ]);
  });

  it("builds configured providers", () => {
    const registry = new ProviderRegistry().register(factoryFor(descriptor("a")));
    const settings = normalizeSettings({
      providers: { a: { type: "api-key", apiKey: "k" } },
    });
    const report = registry.build(settings, ctx);
    expect(report.providers.map((provider) => provider.id)).toEqual(["a"]);
    expect(report.skipped).toHaveLength(0);
  });

  it("skips providers with no registered factory", () => {
    const registry = new ProviderRegistry();
    const settings = normalizeSettings({ providers: { ghost: { type: "api-key" } } });
    expect(registry.build(settings, ctx).skipped).toEqual([
      { id: "ghost", reason: "no factory registered" },
    ]);
  });

  it("never throws when a factory itself throws", () => {
    const registry = new ProviderRegistry().register({
      descriptor: descriptor("boom"),
      create() {
        throw new Error("kaboom");
      },
    });
    const settings = normalizeSettings({ providers: { boom: { type: "api-key" } } });
    expect(registry.build(settings, ctx).skipped).toEqual([{ id: "boom", reason: "kaboom" }]);
  });

  it("disposes every provider", async () => {
    const provider = new StubProvider(descriptor("a"));
    await new ProviderRegistry().disposeAll([provider]);
    expect(provider.disposed).toBe(true);
  });
});

describe("model helpers", () => {
  const models = descriptor("a", ["m1", "m2"]).models;

  it("prefers live models over declared ones", async () => {
    const provider = new StubProvider(descriptor("a", ["m1"]));
    expect(await collectModels(provider)).toHaveLength(1);
  });

  it("finds a model by selection", () => {
    expect(findModel(models, { provider: "a" as never, model: "m2" as never })?.id).toBe("m2");
    expect(findModel(models, { provider: "a" as never, model: "missing" as never })).toBeUndefined();
  });
});
