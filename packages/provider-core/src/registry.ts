import type {
  ClickSettings,
  ModelInfo,
  ModelSelection,
  ProviderDescriptor,
  ProviderId,
} from "@click/contracts";
import { ProviderId as ProviderIdUtil } from "@click/contracts";
import type { ChatProvider, ProviderContext, ProviderFactory } from "./chatProvider.js";

export interface SkippedProvider {
  id: ProviderId;
  reason: string;
}

export interface BuildReport {
  providers: ChatProvider[];
  skipped: SkippedProvider[];
}

/**
 * Holds provider factories and builds live providers from settings.
 *
 * Mirrors the t3code `ProviderInstanceRegistry` idea: an unusable configuration
 * degrades to a reported skip instead of throwing.
 */
export class ProviderRegistry {
  private readonly factories = new Map<ProviderId, ProviderFactory>();

  register(factory: ProviderFactory): this {
    const id = factory.descriptor.id;
    if (this.factories.has(id)) {
      throw new Error(`Provider "${id}" is already registered`);
    }
    this.factories.set(id, factory);
    return this;
  }

  registerAll(factories: ProviderFactory[]): this {
    for (const factory of factories) this.register(factory);
    return this;
  }

  has(id: string): boolean {
    return this.factories.has(ProviderIdUtil.make(id));
  }

  getFactory(id: string): ProviderFactory | undefined {
    return this.factories.get(ProviderIdUtil.make(id));
  }

  /** All registered provider descriptors, regardless of configuration. */
  descriptors(): ProviderDescriptor[] {
    return [...this.factories.values()].map((factory) => factory.descriptor);
  }

  /** Build live providers for every provider id present in settings. */
  build(settings: ClickSettings, ctx: ProviderContext): BuildReport {
    const providers: ChatProvider[] = [];
    const skipped: SkippedProvider[] = [];

    for (const [rawId, config] of Object.entries(settings.providers)) {
      if (!ProviderIdUtil.is(rawId)) {
        skipped.push({ id: rawId as ProviderId, reason: "invalid provider id" });
        continue;
      }
      const id = rawId;
      const factory = this.factories.get(id);
      if (!factory) {
        skipped.push({ id, reason: "no factory registered" });
        continue;
      }
      let provider: ChatProvider | null = null;
      try {
        provider = factory.create(config, ctx);
      } catch (error) {
        skipped.push({ id, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (!provider) {
        skipped.push({ id, reason: "insufficient configuration (missing credentials?)" });
        continue;
      }
      providers.push(provider);
    }

    return { providers, skipped };
  }

  async disposeAll(providers: ChatProvider[]): Promise<void> {
    await Promise.all(providers.map((provider) => provider.dispose().catch(() => undefined)));
  }
}

/** Union of static descriptor models and any dynamic models a provider reports. */
export async function collectModels(provider: ChatProvider): Promise<ModelInfo[]> {
  const declared = provider.descriptor.models;
  try {
    const live = await provider.listModels();
    if (live.length > 0) return live;
  } catch {
    // Fall back to the declared catalogue when discovery fails.
  }
  return declared;
}

export function findModel(models: ModelInfo[], selection: ModelSelection): ModelInfo | undefined {
  return models.find(
    (model) => model.provider === selection.provider && model.id === selection.model,
  );
}
