import type { ApprovalRequestMessage, ClickBridge } from "@click/bridge";
import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage } from "../format";
import { applyEvent, createAssistantTurn, createUserTurn, markAborted } from "../transcript";
import type { ChatAttachment } from "@click/bridge";
import type { Turn } from "../transcript";

export interface SendOptions {
  autoApprove: boolean;
  workspaceDir?: string;
  providerId?: string;
  model?: string;
  /** Images attached to this message. */
  images?: ChatAttachment[];
  /** Reasoning effort for models that expose it. */
  effort?: string;
  /** Inference mode: `agent`, `plan` or `ask`. */
  mode?: string;
}

export interface ChatStore {
  turns: Turn[];
  running: boolean;
  /** Set while an agent tool call is waiting for the user's decision. */
  approval: ApprovalRequestMessage | null;
  error: string | null;
  clearError(): void;
  send(prompt: string, options: SendOptions): Promise<boolean>;
  stop(): void;
  respond(approved: boolean): void;
  clear(): void;
}

function makeRequestId(): string {
  const source = typeof crypto === "undefined" ? undefined : crypto;
  if (source && typeof source.randomUUID === "function") return `req_${source.randomUUID()}`;
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Owns the conversation. Nothing is persisted by the host, so the transcript is
 * accumulated here and folded one streamed event at a time.
 */
export function useChat(bridge: ClickBridge): ChatStore {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [running, setRunning] = useState(false);
  const [approval, setApproval] = useState<ApprovalRequestMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeRequest = useRef<string | null>(null);
  const approvalRef = useRef<ApprovalRequestMessage | null>(null);

  useEffect(() => {
    const unsubscribe = bridge.onChatEvent(({ requestId, event }) => {
      setTurns((prev) =>
        prev.map((turn): Turn =>
          turn.role === "assistant" && turn.requestId === requestId ? applyEvent(turn, event) : turn,
        ),
      );
      if (event.type === "done" && activeRequest.current === requestId) {
        activeRequest.current = null;
        setRunning(false);
      }
    });
    return unsubscribe;
  }, [bridge]);

  useEffect(() => {
    const unsubscribe = bridge.onApprovalRequest((payload) => {
      approvalRef.current = payload;
      setApproval(payload);
    });
    return unsubscribe;
  }, [bridge]);

  const send = useCallback(
    async (prompt: string, options: SendOptions): Promise<boolean> => {
      const trimmed = prompt.trim();
      if (trimmed.length === 0 || activeRequest.current !== null) return false;
      const requestId = makeRequestId();
      activeRequest.current = requestId;
      setRunning(true);
      setError(null);
      setTurns((prev) => [
        ...prev,
        createUserTurn(trimmed, {
          ...(options.providerId ? { providerId: options.providerId } : {}),
          ...(options.model ? { model: options.model } : {}),
        }),
        createAssistantTurn(requestId),
      ]);
      try {
        await bridge.startChat({
          requestId,
          prompt: trimmed,
          autoApprove: options.autoApprove,
          ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
          ...(options.providerId ? { providerId: options.providerId } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.images && options.images.length > 0 ? { images: options.images } : {}),
          ...(options.effort ? { effort: options.effort } : {}),
          ...(options.mode ? { mode: options.mode } : {}),
        });
        return true;
      } catch (cause) {
        const message = errorMessage(cause);
        setError(message);
        setTurns((prev) =>
          prev.map((turn): Turn =>
            turn.role === "assistant" && turn.requestId === requestId
              ? applyEvent(turn, { type: "error", message, kind: "unknown" })
              : turn,
          ),
        );
        activeRequest.current = null;
        setRunning(false);
        return false;
      }
    },
    [bridge],
  );

  const stop = useCallback((): void => {
    const requestId = activeRequest.current;
    if (requestId === null) return;
    activeRequest.current = null;
    setRunning(false);
    setTurns((prev) =>
      prev.map((turn): Turn =>
        turn.role === "assistant" && turn.requestId === requestId ? markAborted(turn) : turn,
      ),
    );
    void bridge.cancelChat(requestId).catch((cause: unknown) => {
      setError(errorMessage(cause));
    });
  }, [bridge]);

  const respond = useCallback(
    (approved: boolean): void => {
      const payload = approvalRef.current;
      if (!payload) return;
      approvalRef.current = null;
      setApproval(null);
      void bridge.respondApproval({ requestId: payload.requestId, approved }).catch((cause: unknown) => {
        setError(errorMessage(cause));
      });
    },
    [bridge],
  );

  const clear = useCallback((): void => {
    setTurns([]);
    setError(null);
  }, []);

  const clearError = useCallback((): void => setError(null), []);

  return {
    turns,
    running,
    approval,
    error,
    clearError,
    send,
    stop,
    respond,
    clear,
  };
}
