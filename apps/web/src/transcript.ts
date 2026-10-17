import type { ChatStreamMessage, TokenUsage } from "@click/bridge";

/** Live state of one tool invocation inside an assistant turn. */
export interface ToolRun {
  /** The id the agent used for this call (`tool_start`/`tool_end` pair it up). */
  id: string;
  tool: string;
  input: Record<string, unknown>;
  status: "running" | "ok" | "error";
  result: string;
}

export type TurnBlock =
  | { kind: "iteration"; id: string; iteration: number }
  | { kind: "text"; id: string; text: string }
  | { kind: "thinking"; id: string; text: string }
  | { kind: "notice"; id: string; text: string }
  | { kind: "tool"; id: string; run: ToolRun }
  | { kind: "usage"; id: string; usage: TokenUsage };

export interface UserTurn {
  role: "user";
  id: string;
  at: number;
  text: string;
  providerId?: string;
  model?: string;
}

export type TurnStatus = "streaming" | "done" | "aborted" | "failed";
export type DoneReason = "completed" | "max_iterations" | "error" | "aborted";

export interface TurnError {
  kind: string;
  message: string;
}

export interface AssistantTurn {
  role: "assistant";
  id: string;
  /** Correlates streamed events with this turn. */
  requestId: string;
  at: number;
  blocks: TurnBlock[];
  status: TurnStatus;
  error?: TurnError;
  doneReason?: DoneReason;
  doneMessage?: string;
  providerId?: string;
  model?: string;
}

export type Turn = UserTurn | AssistantTurn;

let blockSeq = 0;

function nextBlockId(prefix: string): string {
  blockSeq += 1;
  return `${prefix}-${blockSeq}`;
}

export function createAssistantTurn(requestId: string): AssistantTurn {
  return {
    role: "assistant",
    id: nextBlockId("turn"),
    requestId,
    at: Date.now(),
    blocks: [],
    status: "streaming",
  };
}

export function createUserTurn(
  text: string,
  selection: { providerId?: string; model?: string } = {},
): UserTurn {
  return {
    role: "user",
    id: nextBlockId("turn"),
    at: Date.now(),
    text,
    ...(selection.providerId ? { providerId: selection.providerId } : {}),
    ...(selection.model ? { model: selection.model } : {}),
  };
}

function appendText(blocks: readonly TurnBlock[], kind: "text" | "thinking", text: string): TurnBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === kind) {
    const merged: TurnBlock = { kind, id: last.id, text: last.text + text };
    return [...blocks.slice(0, -1), merged];
  }
  return [...blocks, { kind, id: nextBlockId(kind), text }];
}

function appendNotice(blocks: readonly TurnBlock[], text: string): TurnBlock[] {
  return [...blocks, { kind: "notice", id: nextBlockId("notice"), text }];
}

function mergeUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const cached = (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
  };
}

function appendUsage(blocks: readonly TurnBlock[], usage: TokenUsage): TurnBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === "usage") {
    const merged: TurnBlock = { kind: "usage", id: last.id, usage: mergeUsage(last.usage, usage) };
    return [...blocks.slice(0, -1), merged];
  }
  return [...blocks, { kind: "usage", id: nextBlockId("usage"), usage }];
}

/** Fold one streamed agent message into the turn it belongs to. */
export function applyEvent(turn: AssistantTurn, event: ChatStreamMessage): AssistantTurn {
  switch (event.type) {
    case "iteration_start":
      return {
        ...turn,
        blocks: [...turn.blocks, { kind: "iteration", id: nextBlockId("iter"), iteration: event.iteration }],
      };
    case "text":
      return { ...turn, blocks: appendText(turn.blocks, "text", event.text) };
    case "thinking":
      return { ...turn, blocks: appendText(turn.blocks, "thinking", event.text) };
    case "notice":
      return { ...turn, blocks: appendNotice(turn.blocks, event.text) };
    case "tool_start": {
      const block: TurnBlock = {
        kind: "tool",
        id: nextBlockId("tool"),
        run: { id: event.id, tool: event.tool, input: event.input, status: "running", result: "" },
      };
      return { ...turn, blocks: [...turn.blocks, block] };
    }
    case "tool_end": {
      const index = turn.blocks.findIndex(
        (block) => block.kind === "tool" && block.run.id === event.id,
      );
      const existing = index >= 0 ? turn.blocks[index] : undefined;
      if (!existing || existing.kind !== "tool") {
        // A result with no matching start still deserves to be visible.
        const block: TurnBlock = {
          kind: "tool",
          id: nextBlockId("tool"),
          run: {
            id: event.id,
            tool: event.tool,
            input: {},
            status: event.isError ? "error" : "ok",
            result: event.result,
          },
        };
        return { ...turn, blocks: [...turn.blocks, block] };
      }
      const blocks = turn.blocks.slice();
      blocks[index] = {
        ...existing,
        run: { ...existing.run, status: event.isError ? "error" : "ok", result: event.result },
      };
      return { ...turn, blocks };
    }
    case "usage":
      return { ...turn, blocks: appendUsage(turn.blocks, event.usage) };
    case "error":
      return { ...turn, status: "failed", error: { kind: event.kind, message: event.message } };
    case "done":
      return {
        ...turn,
        status: event.ok ? "done" : event.reason === "aborted" ? "aborted" : "failed",
        doneReason: event.reason,
        ...(event.message ? { doneMessage: event.message } : {}),
        ...(event.providerId ? { providerId: event.providerId } : {}),
        ...(event.model ? { model: event.model } : {}),
      };
    default:
      return turn;
  }
}

/** Stop a still-running turn locally, e.g. right after the user hits Stop. */
export function markAborted(turn: AssistantTurn): AssistantTurn {
  if (turn.status !== "streaming") return turn;
  return { ...turn, status: "aborted", doneReason: "aborted" };
}

export function describeDoneReason(reason: DoneReason | undefined): string {
  switch (reason) {
    case "completed":
      return "Completed";
    case "max_iterations":
      return "Stopped at the iteration limit";
    case "aborted":
      return "Stopped";
    case "error":
      return "Failed";
    default:
      return "Finished";
  }
}
