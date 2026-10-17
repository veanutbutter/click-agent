import type { ModelInfo, ProviderSummary } from "@click/bridge";
import type { ReactElement } from "react";

import { IconGear } from "./Icons";

export interface HeaderBarProps {
  provider: ProviderSummary | null;
  model: ModelInfo | null;
  isDesktop: boolean;
  platform: string;
  version: string;
  onOpenSettings(): void;
}

export function HeaderBar({
  provider,
  model,
  isDesktop,
  platform,
  version,
  onOpenSettings,
}: HeaderBarProps): ReactElement {
  return (
    <header className="app-header">
      <div className="brand">
        <span className="wordmark">Click</span>
        <span className="brand-sub">open AI code editor</span>
      </div>

      <div className="header-center">
        <span
          className={`bridge-pill ${isDesktop ? "is-desktop" : "is-mock"}`}
          title={
            isDesktop
              ? "Connected to the desktop shell through window.click"
              : "Running on the in-browser mock bridge — no files or keys are real"
          }
        >
          {isDesktop ? "Desktop bridge" : "Mock bridge"}
        </span>
        <span className="header-meta mono">{`${platform} · v${version}`}</span>
      </div>

      <div className="header-actions">
        <span className="chip" title="Provider and model in use">
          {provider ? (
            <>
              <span className="chip-dot" style={{ background: provider.accent }} aria-hidden="true" />
              <span className="chip-badge" style={{ color: provider.accent }}>
                {provider.badge}
              </span>
              <span className="chip-label">{provider.name}</span>
            </>
          ) : (
            <span className="chip-label dim">No provider</span>
          )}
          <span className="chip-sep" aria-hidden="true">
            /
          </span>
          <span className="chip-model mono">{model ? model.id : "no model"}</span>
        </span>
        <button type="button" className="btn btn-ghost" onClick={onOpenSettings}>
          <IconGear className="btn-icon" />
          <span>Settings</span>
        </button>
      </div>
    </header>
  );
}
