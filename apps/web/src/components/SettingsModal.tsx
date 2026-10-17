import type { ClickSettings, ProviderSummary } from "@click/bridge";
import { DEFAULT_AGENT_CONFIG } from "@click/contracts";
import type { AcpProviderConfig, ApiKeyProviderConfig, ProviderConfig } from "@click/contracts";
import type { ReactElement } from "react";
import { useState } from "react";

import { Modal } from "./Modal";
import { IconCheck, IconGear, IconSpinner, IconWarning } from "./Icons";

/** The tools the agent may be allowed to call. */
export const AGENT_TOOLS = [
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "search",
  "run_command",
] as const;

const TOOL_DESCRIPTIONS: Record<string, string> = {
  read_file: "Read a file from the workspace.",
  write_file: "Create or replace a whole file.",
  edit_file: "Apply a targeted edit to an existing file.",
  list_dir: "List the contents of a directory.",
  search: "Search workspace text for a pattern.",
  run_command: "Run a shell command in the workspace.",
};

export interface SettingsModalProps {
  settings: ClickSettings;
  providers: ProviderSummary[];
  saving: boolean;
  error: string | null;
  onSave(next: ClickSettings): Promise<boolean>;
  onClose(): void;
}

interface ProviderDraft {
  /** Only ever holds a freshly typed key; a stored key is never displayed. */
  apiKey: string;
  baseUrl: string;
  headers: string;
  command: string;
  args: string;
}

function emptyDraft(): ProviderDraft {
  return { apiKey: "", baseUrl: "", headers: "", command: "", args: "" };
}

function draftFrom(config: ProviderConfig | undefined): ProviderDraft {
  const draft = emptyDraft();
  if (!config) return draft;
  if (config.type === "acp") {
    return { ...draft, command: config.command, args: (config.args ?? []).join("\n") };
  }
  return {
    ...draft,
    baseUrl: config.baseUrl ?? "",
    headers: Object.entries(config.headers ?? {})
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n"),
  };
}

function parseHeaderLines(raw: string): { headers: Record<string, string>; error: string | null } {
  const headers: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const colon = trimmed.indexOf(":");
    const index = colon >= 0 ? colon : trimmed.indexOf("=");
    if (index <= 0) return { headers: {}, error: `Could not read “${trimmed}”. Use one Name: value pair per line.` };
    const name = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (name.length === 0) return { headers: {}, error: `Missing a header name in “${trimmed}”.` };
    headers[name] = value;
  }
  return { headers, error: null };
}

function storedKey(config: ProviderConfig | undefined): string | undefined {
  if (!config || config.type !== "api-key") return undefined;
  const key = config.apiKey;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

function splitLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function initialDrafts(
  providers: ProviderSummary[],
  settings: ClickSettings,
): Record<string, ProviderDraft> {
  const drafts: Record<string, ProviderDraft> = {};
  for (const provider of providers) {
    drafts[provider.id] = draftFrom(settings.providers[provider.id]);
  }
  return drafts;
}

function initialToolState(enabledTools: string[]): Record<string, boolean> {
  const state: Record<string, boolean> = {};
  for (const tool of AGENT_TOOLS) {
    state[tool] = enabledTools.includes(tool);
  }
  return state;
}

export function SettingsModal({
  settings,
  providers,
  saving,
  error,
  onSave,
  onClose,
}: SettingsModalProps): ReactElement {
  const [tab, setTab] = useState<"providers" | "agent">("providers");
  const [selectedId, setSelectedId] = useState<string>(providers[0]?.id ?? "");
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>(() =>
    initialDrafts(providers, settings),
  );
  const [maxIterations, setMaxIterations] = useState<string>(String(settings.agent.maxIterations));
  const [autoApprove, setAutoApprove] = useState<boolean>(settings.agent.autoApprove);
  const [toolState, setToolState] = useState<Record<string, boolean>>(() =>
    initialToolState(settings.agent.enabledTools),
  );
  const [localError, setLocalError] = useState<string | null>(null);

  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0] ?? null;

  const updateDraft = (id: string, patch: Partial<ProviderDraft>): void => {
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? emptyDraft()), ...patch } }));
  };

  /** Merge the current drafts over the stored settings, dropping nothing. */
  const buildSettings = (): ClickSettings => {
    const nextProviders: Record<string, ProviderConfig> = { ...settings.providers };

    for (const provider of providers) {
      const draft = drafts[provider.id] ?? emptyDraft();
      const existing = settings.providers[provider.id];

      if (provider.kind === "api-key") {
        const existingApiKey = existing && existing.type === "api-key" ? existing.apiKey : undefined;
        const typed = draft.apiKey.trim();
        const apiKey = typed.length > 0 ? typed : existingApiKey;
        const baseUrl = draft.baseUrl.trim();
        const { headers } = parseHeaderLines(draft.headers);

        const config: ApiKeyProviderConfig = { type: "api-key" };
        if (apiKey !== undefined) config.apiKey = apiKey;
        if (baseUrl.length > 0) config.baseUrl = baseUrl;
        if (Object.keys(headers).length > 0) config.headers = headers;
        if (existing && existing.type === "api-key") {
          if (existing.models) config.models = existing.models;
          if (existing.disabledModels) config.disabledModels = existing.disabledModels;
        }

        const meaningful =
          config.apiKey !== undefined || config.baseUrl !== undefined || config.headers !== undefined;
        if (meaningful || existing !== undefined) {
          nextProviders[provider.id] = config;
        } else {
          delete nextProviders[provider.id];
        }
        continue;
      }

      const command = draft.command.trim();
      if (command.length === 0) {
        delete nextProviders[provider.id];
        continue;
      }
      const config: AcpProviderConfig = { type: "acp", command };
      const args = splitLines(draft.args);
      if (args.length > 0) config.args = args;
      if (existing && existing.type === "acp") {
        if (existing.env) config.env = existing.env;
        if (existing.cwd) config.cwd = existing.cwd;
      }
      nextProviders[provider.id] = config;
    }

    const parsedIterations = Number.parseInt(maxIterations, 10);
    const extras = settings.agent.enabledTools.filter(
      (tool: string) => !(AGENT_TOOLS as readonly string[]).includes(tool),
    );

    return {
      providers: nextProviders,
      ...(settings.defaultModel ? { defaultModel: settings.defaultModel } : {}),
      agent: {
        maxIterations:
          Number.isFinite(parsedIterations) && parsedIterations > 0
            ? Math.min(parsedIterations, 500)
            : DEFAULT_AGENT_CONFIG.maxIterations,
        autoApprove,
        enabledTools: [...AGENT_TOOLS.filter((tool) => toolState[tool] === true), ...extras],
      },
    };
  };

  const handleSave = async (): Promise<void> => {
    for (const provider of providers) {
      if (provider.kind !== "api-key") continue;
      const draft = drafts[provider.id];
      if (!draft) continue;
      const { error: headerError } = parseHeaderLines(draft.headers);
      if (headerError) {
        setLocalError(`${provider.name} headers: ${headerError}`);
        return;
      }
    }
    setLocalError(null);
    const saved = await onSave(buildSettings());
    if (saved) onClose();
  };

  return (
    <Modal
      title="Settings"
      size="xl"
      onClose={onClose}
      footer={
        <>
          <span className="settings-foot-note">
            Stored in <code className="mono">~/.click/settings.json</code>
          </span>
          <button type="button" className="btn btn-subtle" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? <IconSpinner className="btn-icon spinner" /> : <IconCheck className="btn-icon" />}
            <span>{saving ? "Saving…" : "Save settings"}</span>
          </button>
        </>
      }
    >
      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "providers"}
          className={`settings-tab ${tab === "providers" ? "is-active" : ""}`}
          onClick={() => setTab("providers")}
        >
          Providers
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "agent"}
          className={`settings-tab ${tab === "agent" ? "is-active" : ""}`}
          onClick={() => setTab("agent")}
        >
          Agent
        </button>
      </div>

      {error ? (
        <div className="error-banner" role="alert">
          <IconWarning className="error-icon" />
          <div className="error-copy">
            <span className="error-kind">Could not load or save settings</span>
            <p className="error-message">{error}</p>
          </div>
        </div>
      ) : null}
      {localError ? (
        <div className="error-banner" role="alert">
          <IconWarning className="error-icon" />
          <div className="error-copy">
            <span className="error-kind">Nothing was saved</span>
            <p className="error-message">{localError}</p>
          </div>
        </div>
      ) : null}

      {tab === "providers" ? (
        <div className="settings-split">
          <div className="settings-rail" aria-label="Providers">
            {providers.map((provider) => {
              const hasKey = storedKey(settings.providers[provider.id]) !== undefined;
              const ready = provider.configured;
              const isSelected = provider.id === selected?.id;
              return (
                <button
                  key={provider.id}
                  type="button"
                  aria-pressed={isSelected}
                  className={`settings-item ${isSelected ? "is-active" : ""}`}
                  onClick={() => setSelectedId(provider.id)}
                >
                  <span className="chip-dot" style={{ background: provider.accent }} aria-hidden="true" />
                  <span className="settings-item-body">
                    <span className="settings-item-name">{provider.name}</span>
                    <span className="settings-item-meta">
                      {provider.kind === "acp" ? "acp" : hasKey ? "key stored" : "no key"}
                      {ready ? " · ready" : " · needs setup"}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="settings-main">
            {selected ? (
              <>
                <header className="settings-main-head">
                  <h3 className="settings-provider-name">{selected.name}</h3>
                  <span className={`badge ${selected.configured ? "badge-ok" : "badge-warn"}`}>
                    {selected.configured ? "Ready" : "Needs setup"}
                  </span>
                </header>
                <p className="settings-provider-copy">{selected.description}</p>
                {!selected.configured && selected.reason ? (
                  <p className="provider-detail-warning">{selected.reason}</p>
                ) : null}

                {selected.kind === "api-key" ? (
                  <>
                    <label className="field">
                      <span className="field-label">API key</span>
                      <input
                        className="input"
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        value={drafts[selected.id]?.apiKey ?? ""}
                        placeholder={
                          storedKey(settings.providers[selected.id])
                            ? "A key is stored — type a new one to replace it"
                            : "Paste the API key, or leave blank to use the environment"
                        }
                        onChange={(event) => updateDraft(selected.id, { apiKey: event.target.value })}
                      />
                      <span className="field-hint">
                        {storedKey(settings.providers[selected.id])
                          ? "The stored key is never shown. Leaving this blank keeps it unchanged."
                          : "Leaving this blank leaves the key unset; most providers then fall back to an environment variable."}
                      </span>
                    </label>

                    <label className="field">
                      <span className="field-label">Base URL (optional)</span>
                      <input
                        className="input mono"
                        type="text"
                        spellCheck={false}
                        value={drafts[selected.id]?.baseUrl ?? ""}
                        placeholder="https://api.example.com/v1"
                        onChange={(event) => updateDraft(selected.id, { baseUrl: event.target.value })}
                      />
                      <span className="field-hint">
                        Point Click at a gateway, proxy or self-hosted deployment of this API.
                      </span>
                    </label>

                    <label className="field">
                      <span className="field-label">Extra headers (optional)</span>
                      <textarea
                        className="input textarea mono"
                        rows={4}
                        spellCheck={false}
                        value={drafts[selected.id]?.headers ?? ""}
                        placeholder={"X-Org-Id: team-42\nX-Region: eu-west-1"}
                        onChange={(event) => updateDraft(selected.id, { headers: event.target.value })}
                      />
                      <span className="field-hint">One Name: value pair per line, merged into every request.</span>
                    </label>

                    <p className="settings-note">
                      Custom model lists for this provider are not editable here — add them to{" "}
                      <code className="mono">~/.click/settings.json</code> under{" "}
                      <code className="mono">providers.{selected.id}.models</code>.
                    </p>
                  </>
                ) : (
                  <>
                    <label className="field">
                      <span className="field-label">Command</span>
                      <input
                        className="input mono"
                        type="text"
                        spellCheck={false}
                        value={drafts[selected.id]?.command ?? ""}
                        placeholder="claude-agent-acp"
                        onChange={(event) => updateDraft(selected.id, { command: event.target.value })}
                      />
                      <span className="field-hint">
                        The executable Click launches and talks to over the Agent Client Protocol.
                      </span>
                    </label>

                    <label className="field">
                      <span className="field-label">Arguments (one per line)</span>
                      <textarea
                        className="input textarea mono"
                        rows={5}
                        spellCheck={false}
                        value={drafts[selected.id]?.args ?? ""}
                        placeholder={"--stdio\n--workspace\n."}
                        onChange={(event) => updateDraft(selected.id, { args: event.target.value })}
                      />
                      <span className="field-hint">
                        Passed to the command in order. Blank lines are ignored.
                      </span>
                    </label>

                    <p className="settings-note">
                      Any environment variables or working directory an existing ACP provider already had
                      are preserved. They stay editable only in{" "}
                      <code className="mono">~/.click/settings.json</code>.
                    </p>
                  </>
                )}
              </>
            ) : (
              <p className="dim">No providers were reported by the host.</p>
            )}
          </div>
        </div>
      ) : (
        <div className="settings-agent">
          <div className="settings-grid">
            <label className="field">
              <span className="field-label">Maximum iterations per turn</span>
              <input
                className="input"
                type="number"
                min={1}
                max={500}
                step={1}
                value={maxIterations}
                onChange={(event) => setMaxIterations(event.target.value)}
              />
              <span className="field-hint">
                How many agent/tool round trips one prompt may take before Click stops the turn. Default{" "}
                {DEFAULT_AGENT_CONFIG.maxIterations}.
              </span>
            </label>

            <div className="field">
              <span className="field-label">Auto-approve</span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={autoApprove}
                  onChange={(event) => setAutoApprove(event.target.checked)}
                />
                <span className="switch-track" aria-hidden="true">
                  <span className="switch-thumb" />
                </span>
                <span className="switch-label">
                  {autoApprove
                    ? "File edits and commands run without asking"
                    : "Ask before every file edit and command"}
                </span>
              </label>
              <span className="field-hint">
                The agent panel has its own toggle for the current session; this is the stored default.
              </span>
            </div>
          </div>

          <fieldset className="tool-list">
            <legend className="field-label">Enabled tools</legend>
            {AGENT_TOOLS.map((tool) => (
              <label key={tool} className="tool-option">
                <input
                  type="checkbox"
                  checked={toolState[tool] === true}
                  onChange={(event) =>
                    setToolState((prev) => ({ ...prev, [tool]: event.target.checked }))
                  }
                />
                <span className="tool-option-body">
                  <span className="tool-option-name mono">{tool}</span>
                  <span className="tool-option-copy">{TOOL_DESCRIPTIONS[tool] ?? ""}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <p className="settings-note">
            <IconGear className="btn-icon" />
            <span>
              Settings live in <code className="mono">~/.click/settings.json</code>. API keys are read from
              there or from environment variables — nothing is sent anywhere except to the provider you
              select.
            </span>
          </p>
        </div>
      )}
    </Modal>
  );
}
