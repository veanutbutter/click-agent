import type { FileNode, WorkspaceInfo } from "@click/bridge";
import type { ReactElement } from "react";

import { FileTree } from "./FileTree";
import { IconClose, IconFolderOpen, IconRefresh, IconSpinner } from "./Icons";

export interface SidebarProps {
  workspace: WorkspaceInfo | null;
  lastWorkspace: WorkspaceInfo | null;
  entries: Record<string, FileNode[]>;
  loadingDirs: Record<string, boolean>;
  opening: boolean;
  error: string | null;
  activePath: string | null;
  onPick(): void;
  onReopen(root: string): void;
  onRefresh(): void;
  onCloseWorkspace(): void;
  onOpenFile(path: string): void;
  onLoadDir(path: string): void;
  onClearError(): void;
}

export function Sidebar({
  workspace,
  lastWorkspace,
  entries,
  loadingDirs,
  opening,
  error,
  activePath,
  onPick,
  onReopen,
  onRefresh,
  onCloseWorkspace,
  onOpenFile,
  onLoadDir,
  onClearError,
}: SidebarProps): ReactElement {
  return (
    <aside className="sidebar" aria-label="Explorer">
      <div className="sidebar-head">
        <h2 className="sidebar-title">Explorer</h2>
        <div className="sidebar-head-actions">
          {workspace ? (
            <>
              <button type="button" className="icon-btn" onClick={onRefresh} aria-label="Reload the file tree" title="Reload the file tree">
                <IconRefresh />
              </button>
              <button type="button" className="icon-btn" onClick={onCloseWorkspace} aria-label="Close the folder" title="Close the folder">
                <IconClose />
              </button>
            </>
          ) : null}
        </div>
      </div>

      {workspace ? (
        <div className="workspace-card">
          <div className="workspace-name" title={workspace.root}>
            {workspace.name}
          </div>
          <div className="workspace-path mono" title={workspace.root}>
            {workspace.root}
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="sidebar-error" role="alert">
          <span>{error}</span>
          <button type="button" className="icon-btn" onClick={onClearError} aria-label="Dismiss error">
            <IconClose />
          </button>
        </div>
      ) : null}

      {workspace ? (
        <div className="sidebar-scroll">
          <FileTree
            rootPath={workspace.root}
            entries={entries}
            loadingDirs={loadingDirs}
            activePath={activePath}
            onOpenFile={onOpenFile}
            onLoadDir={onLoadDir}
          />
        </div>
      ) : (
        <div className="sidebar-scroll">
          <div className="empty-state">
            <IconFolderOpen className="empty-icon" />
            <p className="empty-title">No folder open</p>
            <p className="empty-copy">
              Open a project folder and Click can read, search and edit it. Nothing leaves your machine
              until a prompt is sent to the provider you choose.
            </p>
            <button type="button" className="btn btn-primary" onClick={onPick} disabled={opening}>
              {opening ? <IconSpinner className="btn-icon spinner" /> : <IconFolderOpen className="btn-icon" />}
              <span>{opening ? "Opening…" : "Open Folder"}</span>
            </button>
            {lastWorkspace ? (
              <button
                type="button"
                className="btn btn-ghost btn-block"
                onClick={() => onReopen(lastWorkspace.root)}
                title={lastWorkspace.root}
              >
                Reopen {lastWorkspace.name}
              </button>
            ) : null}
          </div>
        </div>
      )}

      {workspace ? (
        <div className="sidebar-foot">
          <button type="button" className="btn btn-subtle btn-block" onClick={onPick} disabled={opening}>
            {opening ? <IconSpinner className="btn-icon spinner" /> : <IconFolderOpen className="btn-icon" />}
            <span>Open another folder…</span>
          </button>
        </div>
      ) : null}
    </aside>
  );
}
