import type { ChatAttachment, ModelInfo, ProviderSummary, WorkspaceInfo } from "@click/bridge";
import type { ReactElement } from "react";
import { useState } from "react";

import type { ChatStore } from "../hooks/useChat";
import { extractMentions } from "../mention.js";
import { Composer } from "./Composer";
import { IconClose, IconGear, IconPlus, IconSparkle, IconWarning } from "./Icons";
import { ProviderPicker } from "./ProviderPicker";
import { Transcript } from "./Transcript";

export interface AgentPanelProps {
  providers: ProviderSummary[];
  provider: ProviderSummary | null;
  model: ModelInfo | null;
  workspace: WorkspaceInfo | null;
  chat: ChatStore;
  autoApprove: boolean;
  onAutoApproveChange(value: boolean): void;
  isDefaultModel: boolean;
  savingDefault: boolean;
  onSetDefaultModel(): void;
  onOpenSettings(): void;
  onProviderChange(providerId: string): void;
  onModelChange(modelId: string): void;
  /** Workspace paths offered by `@` in the composer. */
  mentionCandidates: string[];
  /** Called when a mention is picked, to attach it to the next message. */
  onMention(path: string): void;
  /** Called on send with every `@` path in the message. */
  onAttachMentions(paths: string[]): void;
}

/** The reasoning levels Zed and the provider layer use. */
const EFFORT_LEVELS = ["minimal", "low", "medium", "high"];

/** The centrepiece: providers, transcript and composer in one column. */
export function AgentPanel({
  providers,
  provider,
  model,
  workspace,
  chat,
  autoApprove,
  onAutoApproveChange,
  isDefaultModel,
  savingDefault,
  onSetDefaultModel,
  onOpenSettings,
  onProviderChange,
  onModelChange,
  mentionCandidates,
  onMention,
  onAttachMentions,
}: AgentPanelProps): ReactElement {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ChatAttachment[]>([]);
  const [mode, setMode] = useState("agent");
  const [effort, setEffort] = useState("");

  const notConfigured = provider !== null && !provider.configured;
  const canSend = provider !== null && !notConfigured && model !== null && draft.trim().length > 0;

  const blockedReason =
    provider === null
      ? "No provider is available from the host."
      : notConfigured
        ? `${provider.name} needs setup before it can be used.`
        : model === null
          ? "Pick a model to continue."
          : workspace === null
            ? "No folder open — the agent can still answer, but file tools need a workspace."
            : null;

  const handleSend = (): void => {
    const prompt = draft;
    if (prompt.trim().length === 0) return;
    // `@path` in the message becomes real context on the host, so the agent gets
    // the same treatment as a Ctrl+L selection.
    const mentioned = extractMentions(prompt);
    if (mentioned.length > 0) onAttachMentions(mentioned);
    void chat
      .send(prompt, {
        autoApprove,
        ...(images.length > 0 ? { images } : {}),
        ...(mode !== "agent" ? { mode } : {}),
        ...(effort ? { effort } : {}),
        ...(workspace ? { workspaceDir: workspace.root } : {}),
        ...(provider ? { providerId: provider.id } : {}),
        ...(model ? { model: String(model.id) } : {}),
      })
      .then((sent) => {
        if (sent) {
          setDraft("");
          setImages([]);
        }
      });
  };

  return (
    <section className="agent-pane" aria-label="Click agent">
      <header className="agent-head">
        <div className="agent-title">
          <IconSparkle className="agent-title-icon" />
          <h2 className="agent-heading">Click agent</h2>
          {chat.running ? (
            <span className="agent-badge is-running">
              <span className="pulse" aria-hidden="true" />
              <span>running</span>
            </span>
          ) : null}
        </div>
        <div className="agent-head-actions">
          <label className="toggle" title="Skip the approval prompt for file edits and shell commands">
            <input
              type="checkbox"
              checked={autoApprove}
              onChange={(event) => onAutoApproveChange(event.target.checked)}
            />
            <span className="toggle-label">Auto-approve</span>
          </label>
          <button
            type="button"
            className="icon-btn"
            onClick={() => chat.clear()}
            disabled={chat.running || chat.turns.length === 0}
            aria-label="Start a new conversation"
            title="New conversation"
          >
            <IconPlus />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={onOpenSettings}
            aria-label="Open settings"
            title="Settings"
          >
            <IconGear />
          </button>
        </div>
      </header>

      <ProviderPicker
        providers={providers}
        provider={provider}
        model={model}
        locked={chat.running}
        isDefault={isDefaultModel}
        savingDefault={savingDefault}
        onProviderChange={onProviderChange}
        onModelChange={onModelChange}
        onSetDefault={onSetDefaultModel}
        onOpenSettings={onOpenSettings}
      />

      <Transcript
        turns={chat.turns}
        workspaceName={workspace ? workspace.name : null}
        onSuggest={setDraft}
      />

      {chat.error ? (
        <div className="error-banner is-inline" role="alert">
          <IconWarning className="error-icon" />
          <div className="error-copy">
            <span className="error-kind">The agent hit a problem</span>
            <p className="error-message">{chat.error}</p>
          </div>
          <button type="button" className="icon-btn" onClick={chat.clearError} aria-label="Dismiss error">
            <IconClose />
          </button>
        </div>
      ) : null}

      <Composer
        value={draft}
        onChange={setDraft}
        onSend={handleSend}
        onStop={chat.stop}
        running={chat.running}
        canSend={canSend}
        blockedReason={blockedReason}
        provider={provider}
        model={model}
        mentionCandidates={mentionCandidates}
        onMention={onMention}
        images={images}
        onImagesChange={setImages}
        mode={mode}
        onModeChange={setMode}
        models={provider?.models ?? []}
        modelId={model ? String(model.id) : ""}
        onModelChange={onModelChange}
        effort={effort}
        onEffortChange={setEffort}
        effortOptions={EFFORT_LEVELS}
      />
    </section>
  );
}
