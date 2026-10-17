import type { ModelInfo, ProviderSummary } from "@click/bridge";
import type { ReactElement } from "react";

import { formatCount } from "../format";
import { IconGear, IconStar } from "./Icons";

export interface ProviderPickerProps {
  providers: ProviderSummary[];
  provider: ProviderSummary | null;
  model: ModelInfo | null;
  /** True while a turn is running: switching mid-turn would be misleading. */
  locked: boolean;
  isDefault: boolean;
  savingDefault: boolean;
  onProviderChange(providerId: string): void;
  onModelChange(modelId: string): void;
  onSetDefault(): void;
  onOpenSettings(): void;
}

function capabilityChips(model: ModelInfo): Array<{ key: string; label: string; on: boolean }> {
  return [
    { key: "tools", label: "tools", on: model.supportsTools },
    { key: "thinking", label: "reasoning", on: model.supportsThinking },
    { key: "images", label: "images", on: model.supportsImages },
    { key: "streaming", label: "streaming", on: model.supportsStreaming },
  ];
}

/** Provider + model selection, with everything needed to explain the choice. */
export function ProviderPicker({
  providers,
  provider,
  model,
  locked,
  isDefault,
  savingDefault,
  onProviderChange,
  onModelChange,
  onSetDefault,
  onOpenSettings,
}: ProviderPickerProps): ReactElement {
  if (providers.length === 0) {
    return (
      <div className="picker">
        <p className="dim">Loading providers…</p>
      </div>
    );
  }

  const ready = providers.filter((candidate) => candidate.configured);
  const missing = providers.filter((candidate) => !candidate.configured);

  return (
    <div className="picker">
      <div className="picker-row">
        <label className="field">
          <span className="field-label">Provider</span>
          <select
            className="select"
            value={provider ? provider.id : ""}
            disabled={locked}
            onChange={(event) => onProviderChange(event.target.value)}
          >
            {ready.length > 0 ? (
              <optgroup label="Ready to use">
                {ready.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {`${candidate.badge} · ${candidate.name} (${candidate.kind})`}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {missing.length > 0 ? (
              <optgroup label="Needs setup — open Settings">
                {missing.map((candidate) => (
                  <option key={candidate.id} value={candidate.id} disabled>
                    {`${candidate.badge} · ${candidate.name} — ${candidate.reason ?? "not configured"}`}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>

        <label className="field">
          <span className="field-label">Model</span>
          <select
            className="select"
            value={model ? String(model.id) : ""}
            disabled={locked || provider === null}
            onChange={(event) => onModelChange(event.target.value)}
          >
            {provider
              ? provider.models.map((candidate) => (
                  <option key={String(candidate.id)} value={String(candidate.id)}>
                    {`${candidate.name}${candidate.deprecated ? " (deprecated)" : ""}`}
                  </option>
                ))
              : null}
          </select>
        </label>

        <button
          type="button"
          className="btn btn-subtle btn-star"
          onClick={onSetDefault}
          disabled={savingDefault || !provider || !model}
          title={
            isDefault
              ? "This is the stored default model"
              : "Store this provider and model as the default in ~/.click/settings.json"
          }
        >
          <IconStar className="btn-icon" />
          <span>{savingDefault ? "Saving…" : isDefault ? "Default" : "Set default"}</span>
        </button>
      </div>

      {provider ? (
        <div className="provider-detail">
          <div className="provider-detail-head">
            <span className="chip-dot" style={{ background: provider.accent }} aria-hidden="true" />
            <span className="provider-detail-name" style={{ color: provider.accent }}>
              {provider.badge}
            </span>
            <span className="provider-detail-title">{provider.name}</span>
            <span className="provider-kind mono">{provider.kind}</span>
            {!provider.configured ? (
              <button type="button" className="btn btn-subtle btn-tiny" onClick={onOpenSettings}>
                <IconGear className="btn-icon" />
                <span>Set up</span>
              </button>
            ) : null}
          </div>
          <p className="provider-detail-copy">{provider.description}</p>
          {!provider.configured ? (
            <p className="provider-detail-warning">{provider.reason ?? "This provider is not configured yet."}</p>
          ) : null}
          {model ? (
            <div className="model-caps">
              {capabilityChips(model).map((chip) => (
                <span key={chip.key} className={`cap ${chip.on ? "is-on" : "is-off"}`}>
                  {chip.label}
                </span>
              ))}
              {model.contextWindow === undefined ? null : (
                <span className="cap is-plain">{`${formatCount(model.contextWindow)} token context`}</span>
              )}
              {model.maxOutputTokens === undefined ? null : (
                <span className="cap is-plain">{`${formatCount(model.maxOutputTokens)} max out`}</span>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
