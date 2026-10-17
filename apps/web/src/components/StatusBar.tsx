import type { ModelInfo, ProviderSummary, WorkspaceInfo } from "@click/bridge";
import type { ReactElement } from "react";

import type { OpenDocument } from "../hooks/useEditor";
import { IconSpinner } from "./Icons";

export interface StatusBarProps {
  workspace: WorkspaceInfo | null;
  active: OpenDocument | null;
  dirtyCount: number;
  provider: ProviderSummary | null;
  model: ModelInfo | null;
  running: boolean;
  isDesktop: boolean;
  turnCount: number;
}

export function StatusBar({
  workspace,
  active,
  dirtyCount,
  provider,
  model,
  running,
  isDesktop,
  turnCount,
}: StatusBarProps): ReactElement {
  return (
    <footer className="status-bar">
      <span className="status-item" title={workspace ? workspace.root : "No folder open"}>
        {workspace ? workspace.name : "no folder"}
      </span>
      <span className="status-sep" aria-hidden="true" />
      <span className="status-item mono">{active ? active.path : "no file"}</span>
      {dirtyCount > 0 ? (
        <>
          <span className="status-sep" aria-hidden="true" />
          <span className="status-item is-dirty">{dirtyCount === 1 ? "1 unsaved" : `${dirtyCount} unsaved`}</span>
        </>
      ) : null}

      <span className="status-spacer" />

      {turnCount > 0 ? (
        <span className="status-item dim">
          {turnCount === 1 ? "1 turn" : `${turnCount} turns`}
        </span>
      ) : null}
      <span className="status-item">
        {running ? (
          <>
            <IconSpinner className="status-spin spinner" />
            <span>agent running</span>
          </>
        ) : (
          <span className="dim">agent idle</span>
        )}
      </span>
      <span className="status-sep" aria-hidden="true" />
      <span className="status-item" title={provider ? provider.description : "No provider"}>
        {provider ? (
          <>
            <span className="chip-dot" style={{ background: provider.accent }} aria-hidden="true" />
            <span>
              {provider.name}
              {model ? ` · ${model.id}` : ""}
            </span>
          </>
        ) : (
          <span className="dim">no provider</span>
        )}
      </span>
      <span className="status-sep" aria-hidden="true" />
      <span className={`status-item ${isDesktop ? "" : "is-mock"}`}>
        {isDesktop ? "desktop" : "mock bridge"}
      </span>
    </footer>
  );
}
