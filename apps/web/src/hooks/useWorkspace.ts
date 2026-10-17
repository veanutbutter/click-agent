import type { ClickBridge, FileNode, WorkspaceInfo } from "@click/bridge";
import { useCallback, useEffect, useRef, useState } from "react";

import { compareNodes, errorMessage } from "../format";

const LAST_WORKSPACE_KEY = "click.web.lastWorkspace";

export interface WorkspaceStore {
  workspace: WorkspaceInfo | null;
  /** The workspace from the previous session, offered when none is open. */
  lastWorkspace: WorkspaceInfo | null;
  /** Directory listing cache, keyed by directory path. */
  entries: Record<string, FileNode[]>;
  loadingDirs: Record<string, boolean>;
  opening: boolean;
  error: string | null;
  clearError(): void;
  pick(): Promise<void>;
  reopen(root: string): Promise<void>;
  loadDir(dir: string): Promise<void>;
  refresh(): Promise<void>;
  closeWorkspace(): void;
}

function readLastWorkspace(): WorkspaceInfo | null {
  try {
    const raw = localStorage.getItem(LAST_WORKSPACE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as { root?: unknown; name?: unknown };
    if (typeof candidate.root !== "string" || typeof candidate.name !== "string") return null;
    return { root: candidate.root, name: candidate.name };
  } catch {
    return null;
  }
}

function writeLastWorkspace(workspace: WorkspaceInfo): void {
  try {
    localStorage.setItem(LAST_WORKSPACE_KEY, JSON.stringify(workspace));
  } catch {
    // Storage may be unavailable; the session still works.
  }
}

export function useWorkspace(bridge: ClickBridge): WorkspaceStore {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [lastWorkspace, setLastWorkspace] = useState<WorkspaceInfo | null>(null);
  const [entries, setEntries] = useState<Record<string, FileNode[]>>({});
  const [loadingDirs, setLoadingDirs] = useState<Record<string, boolean>>({});
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef<Set<string>>(new Set());

  useEffect(() => {
    setLastWorkspace(readLastWorkspace());
  }, []);

  const loadDir = useCallback(
    async (dir: string): Promise<void> => {
      if (loaded.current.has(dir)) return;
      loaded.current.add(dir);
      setLoadingDirs((prev) => ({ ...prev, [dir]: true }));
      try {
        const children = await bridge.listDir(dir);
        setEntries((prev) => ({ ...prev, [dir]: [...children].sort(compareNodes) }));
      } catch (cause) {
        loaded.current.delete(dir);
        setError(errorMessage(cause));
      } finally {
        setLoadingDirs((prev) => ({ ...prev, [dir]: false }));
      }
    },
    [bridge],
  );

  const applyWorkspace = useCallback(
    async (next: WorkspaceInfo): Promise<void> => {
      setWorkspace(next);
      setLastWorkspace(next);
      writeLastWorkspace(next);
      setEntries({});
      loaded.current = new Set<string>();
      await loadDir(next.root);
    },
    [loadDir],
  );

  const pick = useCallback(async (): Promise<void> => {
    setOpening(true);
    setError(null);
    try {
      const picked = await bridge.chooseWorkspace();
      if (picked) await applyWorkspace(picked);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setOpening(false);
    }
  }, [applyWorkspace, bridge]);

  const reopen = useCallback(
    async (root: string): Promise<void> => {
      setOpening(true);
      setError(null);
      try {
        const next = await bridge.openWorkspace(root);
        await applyWorkspace(next);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setOpening(false);
      }
    },
    [applyWorkspace, bridge],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const known = [...loaded.current];
    if (known.length === 0) return;
    loaded.current = new Set<string>();
    setEntries({});
    await Promise.all(known.map((dir) => loadDir(dir)));
  }, [loadDir]);

  const closeWorkspace = useCallback((): void => {
    setWorkspace(null);
    setEntries({});
    setError(null);
    loaded.current = new Set<string>();
  }, []);

  const clearError = useCallback((): void => setError(null), []);

  return {
    workspace,
    lastWorkspace,
    entries,
    loadingDirs,
    opening,
    error,
    clearError,
    pick,
    reopen,
    loadDir,
    refresh,
    closeWorkspace,
  };
}
