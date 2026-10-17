import type { ClickSettings, ModelInfo, ProviderSummary } from "@click/bridge";
import { useCallback, useMemo, useState } from "react";

export interface ModelChoice {
  /** The provider actually in effect (never a provider that has vanished). */
  provider: ProviderSummary | null;
  model: ModelInfo | null;
  /** Ids safe to pass straight back to the bridge. */
  providerId: string | null;
  modelId: string | null;
  chooseProvider(providerId: string): void;
  chooseModel(modelId: string): void;
}

function preferredProvider(
  providers: ProviderSummary[],
  settings: ClickSettings | null,
): ProviderSummary | null {
  const requestedId = settings?.defaultModel?.provider;
  if (requestedId !== undefined) {
    const requested = providers.find((provider) => provider.id === requestedId);
    if (requested) return requested;
  }
  return (
    providers.find((provider) => provider.configured) ?? providers[0] ?? null
  );
}

function preferredModel(provider: ProviderSummary, settings: ClickSettings | null): ModelInfo | null {
  const requestedId =
    settings?.defaultModel && settings.defaultModel.provider === provider.id
      ? settings.defaultModel.model
      : undefined;
  if (requestedId !== undefined) {
    const requested = provider.models.find((model) => model.id === requestedId);
    if (requested) return requested;
  }
  return (
    provider.models.find((model) => !model.deprecated) ?? provider.models[0] ?? null
  );
}

/**
 * The provider/model in effect. The picks are treated as *requests*: if a chosen
 * provider disappears from the catalogue the selection silently falls back, so
 * the panel can never point at something that does not exist.
 */
export function useModelSelection(
  providers: ProviderSummary[],
  settings: ClickSettings | null,
): ModelChoice {
  const [requestedProviderId, setRequestedProviderId] = useState<string | null>(null);
  const [requestedModelId, setRequestedModelId] = useState<string | null>(null);

  const provider = useMemo(() => {
    const requested =
      requestedProviderId === null
        ? undefined
        : providers.find((candidate) => candidate.id === requestedProviderId);
    return requested ?? preferredProvider(providers, settings);
  }, [providers, requestedProviderId, settings]);

  const model = useMemo(() => {
    if (!provider) return null;
    const requested =
      requestedModelId === null
        ? undefined
        : provider.models.find((candidate) => candidate.id === requestedModelId);
    return requested ?? preferredModel(provider, settings);
  }, [provider, requestedModelId, settings]);

  const chooseProvider = useCallback((providerId: string): void => {
    setRequestedProviderId(providerId);
    // Let the new provider's own default model take over.
    setRequestedModelId(null);
  }, []);

  const chooseModel = useCallback((modelId: string): void => {
    setRequestedModelId(modelId);
  }, []);

  return {
    provider,
    model,
    providerId: provider ? provider.id : null,
    modelId: model ? String(model.id) : null,
    chooseProvider,
    chooseModel,
  };
}
