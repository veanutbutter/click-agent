import type { WorkspaceInfo } from "@click/bridge";
import type { ReactElement } from "react";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { AgentPanel } from "./components/AgentPanel";
import { ApprovalModal } from "./components/ApprovalModal";
import { Modal } from "./components/Modal";
import { SettingsModal } from "./components/SettingsModal";
import { useBridge } from "./hooks/useBridge";
import { useChat } from "./hooks/useChat";
import { useModelSelection } from "./hooks/useModelSelection";
import { useSettings } from "./hooks/useSettings";
import { installWebviewBridge } from "./webviewBridge";

import "./styles.css";
import "./agent.css";

// Must run before the first `getBridge()` call, which caches its result.
installWebviewBridge();

/**
 * The in-editor agent surface: just the agent panel and its modals, embedded in
 * a VS Code webview. The file tree, editor and status bar are the host
 * editor's job, so this view stays focused on the provider-backed agent.
 */
export function AgentApp(): ReactElement {
  const { bridge } = useBridge();
  const settings = useSettings(bridge);
  const chat = useChat(bridge);
  const selection = useModelSelection(settings.providers, settings.settings);

  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [autoApprove, setAutoApprove] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);
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

  // The `@` picker's candidates, loaded once per workspace.
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
  }, [bridge, workspace?.root]);

  useEffect(() => {
    void bridge
      .chooseWorkspace()
      .then(setWorkspace)
      .catch(() => setWorkspace(null));
  }, [bridge]);

  useEffect(() => {
    if (!settings.settings) return;
    setAutoApprove(settings.settings.agent.autoApprove);
  }, [settings.settings]);

  useEffect(() => {
    const subscribe = window.clickAgent?.onNewChat;
    if (!subscribe) return undefined;
    return subscribe(() => chat.clear());
  }, [chat.clear]);

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

  const closeSettings = useCallback((): void => setSettingsOpen(false), []);
  const openSettings = useCallback((): void => setSettingsOpen(true), []);

  return (
    <div className="agent-webview">
      <AgentPanel
        providers={settings.providers}
        provider={selection.provider}
        model={selection.model}
        workspace={workspace}
        chat={chat}
        autoApprove={autoApprove}
        onAutoApproveChange={setAutoApprove}
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

      {chat.approval ? <ApprovalModal approval={chat.approval} onRespond={chat.respond} /> : null}
    </div>
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("Click agent could not start: the #root element is missing.");
}

createRoot(container).render(
  <StrictMode>
    <AgentApp />
  </StrictMode>,
);

// A single line in the extension's output channel confirms the panel actually
// mounted (rather than merely having its HTML handed to the webview).
queueMicrotask(() => window.clickAgent?.log("agent panel mounted"));
