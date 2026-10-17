import { ModelId, ProviderId } from "@click/contracts";
import type { ClickBridge, ClickSettings, ProviderSummary } from "@click/bridge";
import { useCallback, useEffect, useState } from "react";

import { errorMessage } from "../format";

export interface SettingsStore {
  /** Null until the first load finishes. */
  settings: ClickSettings | null;
  providers: ProviderSummary[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  clearError(): void;
  reload(): Promise<void>;
  /** Persists `next` and refreshes provider availability. */
  save(next: ClickSettings): Promise<boolean>;
  setDefaultModel(providerId: string, modelId: string): Promise<boolean>;
}

export function useSettings(bridge: ClickBridge): SettingsStore {
  const [settings, setSettings] = useState<ClickSettings | null>(null);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [nextSettings, nextProviders] = await Promise.all([
        bridge.getSettings(),
        bridge.listProviders(),
      ]);
      setSettings(nextSettings);
      setProviders(nextProviders);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (next: ClickSettings): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        const persisted = await bridge.saveSettings(next);
        setSettings(persisted);
        // Provider availability depends on settings, so re-read the catalogue.
        setProviders(await bridge.listProviders());
        return true;
      } catch (cause) {
        setError(errorMessage(cause));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [bridge],
  );

  const setDefaultModel = useCallback(
    async (providerId: string, modelId: string): Promise<boolean> => {
      if (!settings) return false;
      if (!ProviderId.is(providerId) || !ModelId.is(modelId)) return false;
      return save({
        ...settings,
        defaultModel: { provider: ProviderId.make(providerId), model: ModelId.make(modelId) },
      });
    },
    [save, settings],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    settings,
    providers,
    loading,
    saving,
    error,
    clearError,
    reload,
    save,
    setDefaultModel,
  };
}
