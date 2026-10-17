import {
  ProviderId,
  modelKey,
  type ClickSettings,
  type ModelInfo,
  type ModelSelection,
  type ProviderDescriptor,
} from "@click/contracts";
import {
  ProviderRegistry,
  type BuildReport,
  type ChatProvider,
  type ProviderContext,
} from "@click/provider-core";
import { builtInProviderFactories } from "@click/providers";
import { acpProviderFactories, ACP_AGENT_PRESETS } from "@click/provider-acp";

/** A registry preloaded with every provider Click ships with. */
export function createProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry().registerAll([
    ...builtInProviderFactories(),
    ...acpProviderFactories(),
  ]);
}

export function providerContext(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    env: process.env,
    fetch: globalThis.fetch,
    cwd: process.cwd(),
    ...overrides,
  };
}

export { ACP_AGENT_PRESETS };

export interface ResolvedProvider {
  provider: ChatProvider;
  model: string;
}

export interface ResolveOptions {
  settings: ClickSettings;
  providerId?: string;
  model?: string;
  ctx?: ProviderContext;
}

export interface ResolveResult {
  resolved?: ResolvedProvider;
  report: BuildReport;
  error?: string;
}

/** Pick a concrete provider + model from settings, with helpful failure detail. */
export function resolveProvider(options: ResolveOptions): ResolveResult {
  const registry = createProviderRegistry();
  const ctx = options.ctx ?? providerContext();
  const report = registry.build(options.settings, ctx);

  if (report.providers.length === 0) {
    const reasons = report.skipped.map((entry) => `${entry.id}: ${entry.reason}`).join("; ");
    return {
      report,
      error: `No usable providers are configured.${
        reasons ? ` Skipped — ${reasons}` : " Add one with `click providers` guidance or the (id) settings UI."
      }`,
    };
  }

  let provider: ChatProvider | undefined;
  if (options.providerId) {
    provider = report.providers.find((entry) => entry.id === ProviderId.make(options.providerId as string));
    if (!provider) {
      return {
        report,
        error: `Provider "${options.providerId}" is not configured or not usable. Available: ${report.providers
          .map((entry) => entry.id)
          .join(", ")}`,
      };
    }
  } else if (options.settings.defaultModel) {
    provider = report.providers.find(
      (entry) => entry.id === options.settings.defaultModel?.provider,
    );
  }
  provider = provider ?? report.providers[0];
  if (!provider) {
    return { report, error: "No provider could be selected." };
  }

  const model =
    options.model ??
    (options.settings.defaultModel?.provider === provider.id
      ? (options.settings.defaultModel.model as string)
      : undefined) ??
    (provider.descriptor.models[0]?.id as string | undefined) ??
    "default";

  return { resolved: { provider, model }, report };
}

export function describeProviders(
  settings: ClickSettings,
  ctx: ProviderContext = providerContext(),
): Array<{ descriptor: ProviderDescriptor; configured: boolean; reason?: string }> {
  const registry = createProviderRegistry();
  const { providers, skipped } = registry.build(settings, ctx);
  const readyIds = new Set(providers.map((provider) => String(provider.id)));
  const skipById = new Map(skipped.map((entry) => [String(entry.id), entry.reason]));
  return registry.descriptors().map((descriptor) => {
    const id = String(descriptor.id);
    const configured = readyIds.has(id);
    const reason = configured ? undefined : (skipById.get(id) ?? "no credentials configured");
    return {
      descriptor,
      configured,
      ...(reason ? { reason } : {}),
    };
  });
}

export function selectionLabel(selection: ModelSelection): string {
  return modelKey(selection);
}

/**
 * The live model list for one provider, when it can report one.
 *
 * A provider's descriptor carries a static list (or, for an ACP agent, a single
 * placeholder), but the real catalogue is only known at runtime — for OpenCode
 * it is every model the agent offers. The provider instance is disposed here
 * because this is a separate, short-lived build of the registry.
 */
export async function listProviderModels(
  settings: ClickSettings,
  providerId: string,
  ctx: ProviderContext = providerContext(),
): Promise<ModelInfo[] | undefined> {
  const registry = createProviderRegistry();
  const { providers } = registry.build(settings, ctx);
  const provider = providers.find((entry) => String(entry.id) === providerId);
  if (!provider) return undefined;
  try {
    const models = await provider.listModels();
    return models.length > 0 ? models : undefined;
  } catch {
    return undefined;
  } finally {
    await provider.dispose().catch(() => undefined);
  }
}
