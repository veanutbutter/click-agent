import type {
  ChatMessage,
  ChatRequest,
  JsonSchema,
  MessageContent,
  ToolDefinition,
  ToolCallRequest,
} from "@click/contracts";

/**
 * Translation between the OpenAI wire format and Click's provider-neutral types.
 *
 * Cursor speaks OpenAI to whatever `openAIBaseUrl` points at, so the gateway has
 * to be OpenAI-shaped on the outside while remaining provider-agnostic inside.
 * Everything in this file is pure so it can be tested without a network.
 */

export interface OpenAiTextPart {
  type: "text";
  text: string;
}

export interface OpenAiImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type OpenAiContentPart = OpenAiTextPart | OpenAiImagePart;

export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAiMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | OpenAiContentPart[] | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAiTool {
  type: "function";
  function: { name: string; description?: string; parameters?: JsonSchema };
}

export interface OpenAiChatRequest {
  model: string;
  messages: OpenAiMessage[];
  stream?: boolean;
  tools?: OpenAiTool[];
  tool_choice?: unknown;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  /** Reasoning/effort control, as sent by Cursor's model picker and others. */
  reasoning_effort?: string;
}

/**
 * Model ids are namespaced `provider/model` so a single OpenAI-shaped endpoint
 * can advertise every configured provider at once. Provider ids never contain a
 * slash, so splitting on the first one is unambiguous even when the model id
 * itself does (e.g. `openai-compatible/qwen/qwen2.5-coder:7b`).
 */
export function splitModelId(id: string): { provider: string; model: string } {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) {
    throw new Error(
      `Model id must be namespaced as "provider/model" (received "${id}").`,
    );
  }
  return { provider: id.slice(0, slash), model: id.slice(slash + 1) };
}

export function qualifyModelId(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function parseDataUrl(url: string): MessageContent | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!match) return null;
  return { type: "image", mediaType: match[1] ?? "application/octet-stream", dataBase64: match[2] ?? "" };
}

export function parseContent(content: OpenAiMessage["content"]): MessageContent[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  const parts: MessageContent[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      const image = parseDataUrl(part.image_url.url);
      if (image) parts.push(image);
    }
  }
  return parts;
}

export function toChatMessages(messages: OpenAiMessage[]): {
  system?: string;
  messages: ChatMessage[];
} {
  const systemParts: string[] = [];
  const converted: ChatMessage[] = [];

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const parts = parseContent(message.content);
      for (const part of parts) {
        if (part.type === "text") systemParts.push(part.text);
      }
      continue;
    }

    if (message.role === "tool") {
      const parts = parseContent(message.content).filter(
        (part): part is { type: "text"; text: string } => part.type === "text",
      );
      converted.push({
        role: "tool",
        content: [
          {
            type: "toolResult",
            toolCallId: message.tool_call_id ?? "",
            content: parts.map((part) => part.text).join(""),
          },
        ],
      });
      continue;
    }

    if (message.role === "assistant") {
      const content: MessageContent[] = parseContent(message.content);
      for (const call of message.tool_calls ?? []) {
        content.push({
          type: "toolCall",
          id: call.id,
          name: call.function.name,
          input: safeParseJson(call.function.arguments),
        });
      }
      if (content.length === 0) content.push({ type: "text", text: "" });
      converted.push({ role: "assistant", content });
      continue;
    }

    converted.push({ role: "user", content: parseContent(message.content) });
  }

  const system = systemParts.join("\n\n").trim();
  return system.length > 0 ? { system, messages: converted } : { messages: converted };
}

function safeParseJson(raw: string): unknown {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function toToolDefinitions(tools: OpenAiTool[] | undefined): ToolDefinition[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? "",
    inputSchema: tool.function.parameters ?? { type: "object" },
  }));
}

export function toChatRequest(
  body: OpenAiChatRequest,
  provider: string,
  model: string,
): ChatRequest {
  const { system, messages } = toChatMessages(body.messages ?? []);
  const tools = toToolDefinitions(body.tools);
  return {
    provider,
    model,
    ...(system !== undefined ? { system } : {}),
    messages,
    ...(tools !== undefined ? { tools } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.max_tokens !== undefined
      ? { maxOutputTokens: body.max_tokens }
      : body.max_completion_tokens !== undefined
        ? { maxOutputTokens: body.max_completion_tokens }
        : {}),
    // Forward the client's effort control so a provider that supports it
    // (reasoning models) receives it; providers that ignore it are unaffected.
    ...(typeof body.reasoning_effort === "string" && body.reasoning_effort.trim().length > 0
      ? { options: { reasoningEffort: body.reasoning_effort } }
      : {}),
  };
}

/** One `choices[0].delta` frame. */
export function chunkFrame(
  id: string,
  model: string,
  created: number,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function toolCallDelta(call: ToolCallRequest, index: number): Record<string, unknown> {
  return {
    tool_calls: [
      {
        index,
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments:
            typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {}),
        },
      },
    ],
  };
}

export function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";

/** Maps Click's stop reasons onto the OpenAI `finish_reason` vocabulary. */
export function finishReasonFor(reason: string, sawToolCall: boolean): string {
  switch (reason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "aborted":
      return "stop";
    case "end_turn":
    case "stop_sequence":
      return sawToolCall ? "tool_calls" : "stop";
    default:
      return "stop";
  }
}
