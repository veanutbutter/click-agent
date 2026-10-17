import type { ClickBridge } from "@click/bridge";
import { useCallback, useEffect, useRef, useState } from "react";

import { baseName, errorMessage } from "../format";

export interface OpenDocument {
  path: string;
  name: string;
  content: string;
  /** The last content known to be on disk, used to derive the dirty flag. */
  saved: string;
  loading: boolean;
  error: string | null;
}

export interface EditorStore {
  documents: OpenDocument[];
  activePath: string | null;
  active: OpenDocument | null;
  error: string | null;
  savingPath: string | null;
  dirtyCount: number;
  open(filePath: string): Promise<void>;
  activate(filePath: string): void;
  update(filePath: string, content: string): void;
  save(filePath?: string): Promise<void>;
  reload(filePath: string): Promise<void>;
  close(filePath: string): void;
  clearError(): void;
}

export function useEditor(bridge: ClickBridge): EditorStore {
  const [documents, setDocuments] = useState<OpenDocument[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingPath, setSavingPath] = useState<string | null>(null);

  // Mirrors of the latest committed state, so callbacks can read it without
  // being re-created on every keystroke (and without side effects in updaters).
  const documentsRef = useRef<OpenDocument[]>(documents);
  const activePathRef = useRef<string | null>(activePath);
  const pending = useRef<Set<string>>(new Set());

  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);

  const open = useCallback(
    async (filePath: string): Promise<void> => {
      setActivePath(filePath);
      const alreadyOpen = documentsRef.current.some((document) => document.path === filePath);
      if (alreadyOpen) return;
      if (pending.current.has(filePath)) return;
      pending.current.add(filePath);
      setDocuments((prev) =>
        prev.some((document) => document.path === filePath)
          ? prev
          : [
              ...prev,
              {
                path: filePath,
                name: baseName(filePath),
                content: "",
                saved: "",
                loading: true,
                error: null,
              },
            ],
      );
      try {
        const content = await bridge.readFile(filePath);
        setDocuments((prev) =>
          prev.map((document) =>
            document.path === filePath
              ? { ...document, content, saved: content, loading: false, error: null }
              : document,
          ),
        );
      } catch (cause) {
        const message = errorMessage(cause);
        setError(message);
        setDocuments((prev) =>
          prev.map((document) =>
            document.path === filePath
              ? { ...document, loading: false, error: message }
              : document,
          ),
        );
      } finally {
        pending.current.delete(filePath);
      }
    },
    [bridge],
  );

  const activate = useCallback((filePath: string): void => {
    setActivePath(filePath);
  }, []);

  const update = useCallback((filePath: string, content: string): void => {
    setDocuments((prev) =>
      prev.map((document) =>
        document.path === filePath && document.content !== content
          ? { ...document, content }
          : document,
      ),
    );
  }, []);

  const save = useCallback(
    async (filePath?: string): Promise<void> => {
      const target = filePath ?? activePathRef.current;
      if (target === null) return;
      const document = documentsRef.current.find((candidate) => candidate.path === target);
      if (!document || document.loading) return;
      setSavingPath(target);
      setError(null);
      try {
        await bridge.writeFile(document.path, document.content);
        const written = document.content;
        setDocuments((prev) =>
          prev.map((candidate) =>
            candidate.path === document.path ? { ...candidate, saved: written } : candidate,
          ),
        );
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setSavingPath(null);
      }
    },
    [bridge],
  );

  const reload = useCallback(
    async (filePath: string): Promise<void> => {
      try {
        const content = await bridge.readFile(filePath);
        setDocuments((prev) =>
          prev.map((document) =>
            document.path === filePath
              ? { ...document, content, saved: content, loading: false, error: null }
              : document,
          ),
        );
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [bridge],
  );

  const close = useCallback((filePath: string): void => {
    const document = documentsRef.current.find((candidate) => candidate.path === filePath);
    if (document && document.content !== document.saved) {
      const confirmed = window.confirm(`Discard unsaved changes to ${document.name}?`);
      if (!confirmed) return;
    }
    setDocuments((prev) => prev.filter((candidate) => candidate.path !== filePath));
    setActivePath((current) => {
      if (current !== filePath) return current;
      const remaining = documentsRef.current.filter((candidate) => candidate.path !== filePath);
      const last = remaining[remaining.length - 1];
      return last ? last.path : null;
    });
  }, []);

  // Ctrl/Cmd+S saves the active document; Ctrl/Cmd+Shift+S saves every dirty tab.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      const openDocuments = documentsRef.current;
      if (event.shiftKey) {
        for (const document of openDocuments) {
          if (document.content !== document.saved) void save(document.path);
        }
        return;
      }
      void save();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [save]);

  const active = documents.find((document) => document.path === activePath) ?? null;
  const dirtyCount = documents.filter((document) => document.content !== document.saved).length;
  const clearError = useCallback((): void => setError(null), []);

  return {
    documents,
    activePath,
    active,
    error,
    savingPath,
    dirtyCount,
    open,
    activate,
    update,
    save,
    reload,
    close,
    clearError,
  };
}
