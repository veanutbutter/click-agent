import type { ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { AgentPanel } from "./components/AgentPanel";
import { ApprovalModal } from "./components/ApprovalModal";
import { EditorPane } from "./components/EditorPane";
import { HeaderBar } from "./components/HeaderBar";
import { Modal } from "./components/Modal";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { useBridge } from "./hooks/useBridge";
import { useChat } from "./hooks/useChat";
import { useEditor } from "./hooks/useEditor";
import { useModelSelection } from "./hooks/useModelSelection";
import { useSettings } from "./hooks/useSettings";
import { useWorkspace } from "./hooks/useWorkspace";

export function App(): ReactElement {
  const { bridge, isDesktop } = useBridge();
  const [mentionCandidates, setMentionCandidates] = useState<string[]>([]);

  /** Attach one `@` mention to the next message. */
  const attachMention = useCallback(
    (path: string): void => {
      const folder = path.endsWith("/");
      const label = folder ? path.slice(0, -1) : path;
      void bridge
        .addContext({ kind: folder ? "folder" : "file", path: label, label })
        .catch(() => undefined);
    },
    [bridge],
  );

  const attachMentions = useCallback(
    (paths: string[]): void => {
      for (const path of paths) attachMention(path);
    },
    [attachMention],
  );
  const settings = useSettings(bridge);
  const workspace = useWorkspace(bridge);
  const editor = useEditor(bridge);
  const chat = useChat(bridge);
  const selection = useModelSelection(settings.providers, settings.settings);

  const [autoApprove, setAutoApprove] = useState(false);
  const autoApproveTouched = useRef(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);

  // Seed the session toggle from stored settings until the user touches it.
  useEffect(() => {
    if (autoApproveTouched.current || !settings.settings) return;
    setAutoApprove(settings.settings.agent.autoApprove);
  }, [settings.settings]);

  const handleAutoApproveChange = useCallback((value: boolean): void => {
    autoApproveTouched.current = true;
    setAutoApprove(value);
  }, []);

  const handleOpenFile = useCallback(
    (path: string): void => {
      void editor.open(path);
    },
    [editor.open],
  );

  const handleLoadDir = useCallback(
    (path: string): void => {
      void workspace.loadDir(path);
    },
    [workspace.loadDir],
  );

  const handleRefreshTree = useCallback((): void => {
    void workspace.refresh();
  }, [workspace.refresh]);

  const handleReopen = useCallback(
    (root: string): void => {
      void workspace.reopen(root);
    },
    [workspace.reopen],
  );

  // The `@` picker's candidates. Reloaded when the workspace changes, and kept
  // out of the render path so a large repository cannot stall the composer.
  useEffect(() => {
    let cancelled = false;
    void bridge
      .listFiles()
      .then((paths) => {
        if (!cancelled) setMentionCandidates(paths);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge, workspace.workspace?.root]);

  const handlePick = useCallback((): void => {
    void workspace.pick();
  }, [workspace.pick]);

  const handleSave = useCallback(
    (path: string): void => {
      void editor.save(path);
    },
    [editor.save],
  );

  const handleReload = useCallback(
    (path: string): void => {
      void editor.reload(path);
    },
    [editor.reload],
  );

  const defaultModel = settings.settings?.defaultModel ?? null;
  const isDefaultModel =
    defaultModel !== null &&
    selection.providerId !== null &&
    selection.modelId !== null &&
    defaultModel.provider === selection.providerId &&
    String(defaultModel.model) === selection.modelId;

  const handleSetDefaultModel = useCallback((): void => {
    if (selection.providerId === null || selection.modelId === null) return;
    setSavingDefault(true);
    void settings
      .setDefaultModel(selection.providerId, selection.modelId)
      .finally(() => setSavingDefault(false));
  }, [selection.providerId, selection.modelId, settings.setDefaultModel]);

  const openSettings = useCallback((): void => setSettingsOpen(true), []);
  const closeSettings = useCallback((): void => setSettingsOpen(false), []);

  return (
    <div className="app">
      <HeaderBar
        provider={selection.provider}
        model={selection.model}
        isDesktop={isDesktop}
        platform={bridge.platform}
        version={bridge.version}
        onOpenSettings={openSettings}
      />

      <main className="workspace-grid">
        <Sidebar
          workspace={workspace.workspace}
          lastWorkspace={workspace.lastWorkspace}
          entries={workspace.entries}
          loadingDirs={workspace.loadingDirs}
          opening={workspace.opening}
          error={workspace.error}
          activePath={editor.activePath}
          onPick={handlePick}
          onReopen={handleReopen}
          onRefresh={handleRefreshTree}
          onCloseWorkspace={workspace.closeWorkspace}
          onOpenFile={handleOpenFile}
          onLoadDir={handleLoadDir}
          onClearError={workspace.clearError}
        />

        <EditorPane
          documents={editor.documents}
          active={editor.active}
          activePath={editor.activePath}
          savingPath={editor.savingPath}
          onActivate={editor.activate}
          onClose={editor.close}
          onChange={editor.update}
          onSave={handleSave}
          onReload={handleReload}
        />

        <AgentPanel
          providers={settings.providers}
          provider={selection.provider}
          model={selection.model}
          workspace={workspace.workspace}
          chat={chat}
          autoApprove={autoApprove}
          onAutoApproveChange={handleAutoApproveChange}
          isDefaultModel={isDefaultModel}
          savingDefault={savingDefault}
          onSetDefaultModel={handleSetDefaultModel}
          onOpenSettings={openSettings}
          onProviderChange={selection.chooseProvider}
          onModelChange={selection.chooseModel}
          mentionCandidates={mentionCandidates}
          onMention={attachMention}
          onAttachMentions={attachMentions}
        />
      </main>

      <StatusBar
        workspace={workspace.workspace}
        active={editor.active}
        dirtyCount={editor.dirtyCount}
        provider={selection.provider}
        model={selection.model}
        running={chat.running}
        isDesktop={isDesktop}
        turnCount={chat.turns.length}
      />

      {settingsOpen && settings.settings ? (
        <SettingsModal
          settings={settings.settings}
          providers={settings.providers}
          saving={settings.saving}
          error={settings.error}
          onSave={settings.save}
          onClose={closeSettings}
        />
      ) : null}

      {settingsOpen && !settings.settings ? (
        <Modal title="Settings" onClose={closeSettings}>
          <p className="dim">Loading settings…</p>
        </Modal>
      ) : null}

      {chat.approval ? (
        <ApprovalModal approval={chat.approval} onRespond={chat.respond} />
      ) : null}
    </div>
  );
}
