import type { ReactElement } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { ChatAttachment, ModelInfo, ProviderSummary } from "@click/bridge";

import { activeMention, applyMention, rankCandidates } from "../mention.js";

/** Read the images out of a paste, as base64 with no data-URL prefix. */
async function clipboardImages(event: {
  clipboardData: DataTransfer | null;
}): Promise<{ mediaType: string; dataBase64: string; name: string }[]> {
  const files: File[] = [];
  for (const item of Array.from(event.clipboardData?.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return Promise.all(
    files.map(async (file) => ({
      mediaType: file.type || "image/png",
      dataBase64: await toBase64(file),
      name: file.name || "pasted image",
    })),
  );
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      // Strip the `data:image/png;base64,` prefix; the provider layer rebuilds it.
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export interface ComposerProps {
  value: string;
  onChange(value: string): void;
  onSend(): void;
  onStop(): void;
  running: boolean;
  canSend: boolean;
  blockedReason: string | null;
  provider: ProviderSummary | null;
  model: ModelInfo | null;
  /** Workspace-relative paths offered by `@`, folders ending in a slash. */
  mentionCandidates?: string[];
  /** Called when a mention is chosen, so the host can attach it to the message. */
  onMention?(path: string): void;
  /** Images attached to this message. */
  images?: ChatAttachment[];
  onImagesChange?(images: ChatAttachment[]): void;
  /** Inference mode: `agent`, `plan` or `ask`. */
  mode?: string;
  onModeChange?(mode: string): void;
  /** Reasoning effort, or "" for the model's default. */
  effort?: string;
  onEffortChange?(effort: string): void;
  /** Efforts the selected model accepts. */
  effortOptions?: string[];
}

/** The prompt box: Enter sends, Shift+Enter adds a newline, `@` picks a file. */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  running,
  canSend,
  blockedReason,
  provider,
  model,
  mentionCandidates = [],
  onMention,
  images = [],
  onImagesChange,
  mode = "agent",
  onModeChange,
  effort = "",
  onEffortChange,
  effortOptions = [],
}: ComposerProps): ReactElement {
  const inputId = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const caretRef = useRef(0);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [value]);

  const mention = useMemo(
    () => (dismissed ? null : activeMention(value, caret)),
    [value, caret, dismissed],
  );
  const suggestions = useMemo(
    () => (mention ? rankCandidates(mentionCandidates, mention.query) : []),
    [mention, mentionCandidates],
  );
  const open = mention !== null && suggestions.length > 0;

  useEffect(() => {
    setHighlight(0);
  }, [mention?.start, mention?.query]);

  function rememberCaret(element: HTMLTextAreaElement): void {
    caretRef.current = element.selectionStart ?? element.value.length;
    setCaret(caretRef.current);
  }

  function choose(path: string): void {
    if (!mention) return;
    const next = applyMention(value, mention, path, caretRef.current);
    onChange(next.text);
    onMention?.(path);
    // Put the caret after the inserted mention once React has re-rendered.
    queueMicrotask(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(next.caret, next.caret);
      caretRef.current = next.caret;
      setCaret(next.caret);
    });
  }

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (running) {
          onStop();
          return;
        }
        if (canSend) onSend();
      }}
    >
      <label className="sr-only" htmlFor={inputId}>
        Message the Click agent
      </label>

      {open ? (
        <ul className="mention-menu" role="listbox" aria-label="Attach a file">
          {suggestions.map((path, index) => (
            <li
              key={path}
              role="option"
              aria-selected={index === highlight}
              className={index === highlight ? "mention-item active" : "mention-item"}
              onMouseEnter={() => setHighlight(index)}
              onMouseDown={(event) => {
                // Keep focus in the textarea.
                event.preventDefault();
                choose(path);
              }}
            >
              {path}
            </li>
          ))}
        </ul>
      ) : null}

      {images.length > 0 ? (
        <ul className="attachment-strip" aria-label="Attached images">
          {images.map((image, index) => (
            <li key={`${image.name ?? "image"}-${index}`} className="attachment-chip">
              <img
                className="attachment-thumb"
                src={`data:${image.mediaType};base64,${image.dataBase64}`}
                alt={image.name ?? "attached image"}
              />
              <span className="attachment-name">{image.name ?? "image"}</span>
              <button
                type="button"
                className="attachment-remove"
                aria-label={`Remove ${image.name ?? "image"}`}
                onClick={() => onImagesChange?.(images.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <textarea
        id={inputId}
        ref={textareaRef}
        className="composer-input"
        value={value}
        rows={1}
        spellCheck={false}
        placeholder="Ask Click to explain, change or write code. Type @ to attach a file, paste an image."
        onPaste={(event) => {
          if (!onImagesChange) return;
          const items = Array.from(event.clipboardData?.items ?? []);
          if (!items.some((item) => item.kind === "file" && item.type.startsWith("image/"))) return;
          event.preventDefault();
          void clipboardImages(event).then((pasted) => {
            if (pasted.length > 0) onImagesChange([...images, ...pasted]);
          });
        }}
        onChange={(event) => {
          onChange(event.target.value);
          setDismissed(false);
          rememberCaret(event.target);
        }}
        onClick={(event) => rememberCaret(event.currentTarget)}
        onKeyUp={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter") return;
          rememberCaret(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (open) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlight((current) => (current + 1) % suggestions.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlight((current) => (current - 1 + suggestions.length) % suggestions.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              const chosen = suggestions[highlight];
              if (chosen) choose(chosen);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setDismissed(true);
              return;
            }
          }
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (running || !canSend) return;
          onSend();
        }}
      />
      <div className="composer-foot">
        <div className="composer-selects">
          <label className="composer-select">
            <span className="sr-only">Mode</span>
            <select
              value={mode}
              onChange={(event) => onModeChange?.(event.target.value)}
              title="How the agent should work"
            >
              <option value="agent">Agent</option>
              <option value="plan">Plan</option>
              <option value="ask">Ask</option>
            </select>
          </label>
          {effortOptions.length > 0 ? (
            <label className="composer-select">
              <span className="sr-only">Reasoning effort</span>
              <select
                value={effort}
                onChange={(event) => onEffortChange?.(event.target.value)}
                title="How much the model should think"
              >
                <option value="">Default effort</option>
                {effortOptions.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <span className={blockedReason ? "composer-blocked" : "composer-context mono"}>
          {blockedReason ??
            (provider
              ? `${provider.name}${model ? ` — ${model.id}` : ""}`
              : "No provider selected")}
        </span>
        <div className="composer-actions">
          <span className="composer-hint">Enter to send · @ to attach</span>
          {running ? (
            <button type="submit" className="btn btn-danger">
              Stop
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={!canSend}>
              Send
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
