import type { ToolCallId } from "./ids.js";

export type Role = "system" | "user" | "assistant" | "tool";

export type MessageContent =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; dataBase64: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; id: string; name: string; input: unknown }
  | { type: "toolResult"; toolCallId: string; content: string; isError?: boolean };

export interface ChatMessage {
  role: Role;
  content: MessageContent[];
}

export type JsonSchema = { type?: string } & Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ChatRequest {
  provider: string;
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Provider-specific request options (e.g. reasoning effort). */
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "aborted";

export interface ToolCallRequest {
  id: ToolCallId;
  name: string;
  input: unknown;
}

export type ChatStreamEvent =
  | { type: "start" }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "notice"; text: string }
  | { type: "tool_call"; call: ToolCallRequest }
  | { type: "usage"; usage: TokenUsage }
  /**
   * The agent changed a file. `oldString`/`newString` are the exact text it
   * replaced, which is what lets a host show the change for review — see
   * `reconstructBefore` in the extension's review model.
   */
  | { type: "edit"; path: string; oldString: string; newString: string }
  | { type: "stop"; reason: StopReason };

export const text = (value: string): MessageContent => ({ type: "text", text: value });
export const userMessage = (value: string): ChatMessage => ({
  role: "user",
  content: [text(value)],
});
export const systemMessage = (value: string): ChatMessage => ({
  role: "system",
  content: [text(value)],
});
export const assistantMessage = (content: MessageContent[]): ChatMessage => ({
  role: "assistant",
  content,
});

/** Flatten a message's content parts to plain text (diagram-free view). */
export function messageText(message: ChatMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}
