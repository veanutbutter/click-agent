import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import { formatClock, formatCount, formatUsage } from "../format";
import type { AssistantTurn, DoneReason, Turn, TurnBlock, TurnError } from "../transcript";
import { describeDoneReason } from "../transcript";
import { IconChevronDown, IconChevronRight, IconSparkle, IconWarning } from "./Icons";
import { ToolCard } from "./ToolCard";

export interface TranscriptProps {
  turns: Turn[];
  workspaceName: string | null;
  onSuggest(prompt: string): void;
}

const SUGGESTIONS = [
  "Explain how this project is wired together.",
  "Add a test for the request handler.",
  "Find every place we read an environment variable.",
  "Summarise the open file in five bullet points.",
];

const ERROR_KIND_LABELS: Record<string, string> = {
  auth: "Authentication failed",
  rate_limit: "Rate limited",
  overloaded: "Provider overloaded",
  invalid_request: "Invalid request",
  prompt_too_large: "Prompt too large",
  model_not_found: "Model not found",
  network: "Network error",
  timeout: "Timed out",
  aborted: "Aborted",
  unsupported: "Unsupported request",
  unknown: "Unknown failure",
};

function ThinkingBlock({ text, defaultOpen }: { text: string; defaultOpen: boolean }): ReactElement {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="thinking">
      <button
        type="button"
        className="thinking-head"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
      >
        <IconSparkle className="thinking-icon" />
        <span className="thinking-label">Thinking</span>
        <span className="thinking-meta mono">{formatCount(text.length)} chars</span>
        {open ? <IconChevronDown className="thinking-caret" /> : <IconChevronRight className="thinking-caret" />}
      </button>
      {open ? <div className="thinking-body">{text}</div> : null}
    </div>
  );
}

function ErrorBanner({ error }: { error: TurnError }): ReactElement {
  const label = ERROR_KIND_LABELS[error.kind] ?? `Failure (${error.kind})`;
  return (
    <div className="error-banner" role="alert">
      <IconWarning className="error-icon" />
      <div className="error-copy">
        <span className="error-kind">
          {label}
          <span className="error-kind-raw mono"> · {error.kind}</span>
        </span>
        <p className="error-message">{error.message}</p>
      </div>
    </div>
  );
}

function BlockView({
  block,
  isLast,
  streaming,
}: {
  block: TurnBlock;
  isLast: boolean;
  streaming: boolean;
}): ReactElement {
  switch (block.kind) {
    case "iteration":
      return (
        <p className="iteration">
          <span className="iteration-label mono">iteration {block.iteration}</span>
        </p>
      );
    case "text":
      return <div className="block-text">{block.text}</div>;
    case "thinking":
      return <ThinkingBlock text={block.text} defaultOpen={streaming && isLast} />;
    case "notice":
      return (
        <p className="notice">
          <span className="notice-dot" aria-hidden="true" />
          <span className="notice-text mono">{block.text}</span>
        </p>
      );
    case "tool":
      return <ToolCard run={block.run} />;
    case "usage":
      return <p className="usage-line mono">{formatUsage(block.usage)}</p>;
    default:
      return <p className="notice dim">Unsupported message.</p>;
  }
}

function TurnFooter({ turn }: { turn: AssistantTurn }): ReactElement {
  if (turn.status === "streaming") {
    return (
      <p className="turn-footer is-working">
        <span className="pulse" aria-hidden="true" />
        <span>Working…</span>
      </p>
    );
  }

  const reason: DoneReason | undefined = turn.doneReason;
  const origin = turn.providerId
    ? `${turn.providerId}${turn.model ? ` / ${turn.model}` : ""}`
    : turn.model ?? null;

  return (
    <p className={`turn-footer is-${turn.status}`}>
      <span className="turn-footer-reason">{describeDoneReason(reason ?? (turn.status === "failed" ? "error" : undefined))}</span>
      {origin ? <span className="turn-footer-origin mono">{origin}</span> : null}
      {turn.doneMessage ? <span className="turn-footer-note">· {turn.doneMessage}</span> : null}
    </p>
  );
}

function UserTurnView({ turn }: { turn: Extract<Turn, { role: "user" }> }): ReactElement {
  return (
    <article className="turn turn-user">
      <div className="turn-label">
        <span className="turn-label-text">You</span>
        <span className="turn-label-meta mono">{formatClock(turn.at)}</span>
      </div>
      <div className="user-bubble">{turn.text}</div>
    </article>
  );
}

function AssistantTurnView({ turn }: { turn: AssistantTurn }): ReactElement {
  const lastIndex = turn.blocks.length - 1;

  return (
    <article className="turn turn-assistant">
      <div className="turn-label">
        <span className="agent-dot" aria-hidden="true" />
        <span className="turn-label-text">Click</span>
        <span className="turn-label-meta mono">{formatClock(turn.at)}</span>
      </div>

      {turn.blocks.length === 0 && turn.status === "streaming" ? (
        <p className="turn-waiting">
          <span className="pulse" aria-hidden="true" />
          <span>Contacting the provider…</span>
        </p>
      ) : null}

      <div className="turn-blocks">
        {turn.blocks.map((block, index) => (
          <BlockView
            key={block.id}
            block={block}
            isLast={index === lastIndex}
            streaming={turn.status === "streaming"}
          />
        ))}
      </div>

      {turn.error ? <ErrorBanner error={turn.error} /> : null}
      <TurnFooter turn={turn} />
    </article>
  );
}

function EmptyTranscript({
  workspaceName,
  onSuggest,
}: {
  workspaceName: string | null;
  onSuggest(prompt: string): void;
}): ReactElement {
  return (
    <div className="transcript-empty">
      <h3 className="empty-title">Ask Click about your code</h3>
      <p className="empty-copy">
        {workspaceName
          ? `Working in ${workspaceName}. The agent can read, search and edit files, and run commands when you allow it.`
          : "No folder is open yet. Open one from the explorer so the agent can read and edit your files."}
      </p>
      <div className="suggestions">
        {SUGGESTIONS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="suggestion"
            onClick={() => onSuggest(prompt)}
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Transcript({ turns, workspaceName, onSuggest }: TranscriptProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !stick.current) return;
    element.scrollTop = element.scrollHeight;
  });

  return (
    <div
      className="transcript"
      ref={scrollRef}
      role="log"
      aria-live="polite"
      aria-label="Conversation with the Click agent"
      onScroll={(event) => {
        const element = event.currentTarget;
        stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
      }}
    >
      {turns.length === 0 ? (
        <EmptyTranscript workspaceName={workspaceName} onSuggest={onSuggest} />
      ) : (
        turns.map((turn) =>
          turn.role === "user" ? (
            <UserTurnView key={turn.id} turn={turn} />
          ) : (
            <AssistantTurnView key={turn.id} turn={turn} />
          ),
        )
      )}
    </div>
  );
}
