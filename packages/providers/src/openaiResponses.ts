import {
  ProviderError,
  type ChatMessage,
  type ChatRequest,
  type ChatStreamEvent,
  type StopReason,
} from "@click/contracts";
import {
  ToolCallAccumulator,
  ensureOk,
  joinUrl,
  request,
  type ProviderContext,
} from "@click/provider-core";
import { parseSseJson } from "@click/provider-core";
import { applyReasoningEffort } from "./protocol.js";

/**
 * OpenAI's Responses API (`POST {baseUrl}/responses`), streamed as SSE.
 *
 * This is the sibling of `openaiCompatible.ts`: same {@link ProviderContext},
 * same `request`/`ensureOk` helpers, same {@link ToolCallAccumulator}, same
 * abort support. It exists only because some models speak this protocol and not
 * chat completions; which models those are is decided in `protocol.ts`.
 */

/** The subset of a Responses stream event that Click consumes. */
interface ResponsesStreamEvent {
  type?: string;
  delta?: string;
  output_index?: number;
  item_id?: string;
  summary_index?: number;
  content_index?: number;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: Array<{ type?: string; text?: string }>;
    summary?: Array<{ type?: string; text?: string }>;
  };
  response?: {
    id?: string;
    status?: string;
    incomplete_details?: { reason?: string };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
  };
  error?: { message?: string };
  message?: string;
}

/** Everything the client needs that is not the request itself. */
export interface OpenAiResponsesOptions {
  provider: string;
  baseUrl: string;
  /** Build request headers (auth + content-type) for one call. */
  headers: (extra?: Record<string, string>) => Record<string, string>;
  /** Extra static body fields merged into every request. */
  extraBody?: Record<string, unknown>;
}

export class OpenAiResponsesClient {
  constructor(
    private readonly ctx: ProviderContext,
    private readonly options: OpenAiResponsesOptions,
  ) {}

  async *stream(chatRequest: ChatRequest): AsyncIterable<ChatStreamEvent> {
    const response = await request(
      this.ctx,
      joinUrl(this.options.baseUrl, "/responses"),
      {
        method: "POST",
        headers: this.options.headers({ "content-type": "application/json" }),
        body: JSON.stringify(buildResponsesBody(chatRequest, this.options.extraBody)),
        signal: chatRequest.signal,
      },
      { provider: this.options.provider, model: chatRequest.model, action: "responses completion" },
    );
    await ensureOk(response, {
      provider: this.options.provider,
      model: chatRequest.model,
      action: "responses completion",
    });

    yield { type: "start" };

    const stream = response.body;
    if (!stream) {
      throw new ProviderError({
        kind: "network",
        provider: this.options.provider,
        message: "Response had no body",
      });
    }

    const accumulator = new ToolCallAccumulator();
    const streamedArgs = new Set<number>();
    let stopReason: StopReason = "end_turn";
    let sawToolCall = false;

    for await (const event of parseSseJson<ResponsesStreamEvent>(stream)) {
      switch (event.type) {
        case "response.output_text.delta":
          if (event.delta) yield { type: "text_delta", text: event.delta };
          break;
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          if (event.delta) yield { type: "thinking_delta", text: event.delta };
          break;
        case "response.output_item.added": {
          const item = event.item;
          if (item?.type === "function_call" && event.output_index !== undefined) {
            accumulator.push(event.output_index, { id: item.call_id ?? item.id, name: item.name });
          }
          break;
        }
        case "response.function_call_arguments.delta":
          if (event.output_index !== undefined && event.delta) {
            streamedArgs.add(event.output_index);
            accumulator.push(event.output_index, { argumentsFragment: event.delta });
          }
          break;
        case "response.output_item.done": {
          const item = event.item;
          if (item?.type === "function_call" && event.output_index !== undefined) {
            sawToolCall = true;
            // Servers that send no argument deltas still send the full item here.
            if (!streamedArgs.has(event.output_index)) {
              accumulator.push(event.output_index, {
                id: item.call_id ?? item.id,
                name: item.name,
                argumentsFragment: item.arguments,
              });
            }
            for (const out of accumulator.drain([event.output_index])) yield out;
          }
          break;
        }
        case "response.completed": {
          const usage = event.response?.usage;
          if (usage) {
            yield {
              type: "usage",
              usage: {
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: usage.output_tokens ?? 0,
                ...(usage.input_tokens_details?.cached_tokens !== undefined
                  ? { cachedInputTokens: usage.input_tokens_details.cached_tokens }
                  : {}),
              },
            };
          }
          if (
            event.response?.status === "incomplete" &&
            event.response.incomplete_details?.reason === "max_output_tokens"
          ) {
            stopReason = "max_tokens";
          }
          break;
        }
        case "response.failed":
        case "error":
          throw new ProviderError({
            kind: "unknown",
            provider: this.options.provider,
            model: chatRequest.model,
            message: `responses completion failed: ${
              event.error?.message ?? event.message ?? "unknown error"
            }`,
          });
        default:
          break;
      }
    }

    // Any function call whose `output_item.done` never arrived.
    for (const out of accumulator.flush()) {
      if (out.type === "tool_call") sawToolCall = true;
      yield out;
    }
    if (sawToolCall && stopReason === "end_turn") stopReason = "tool_use";
    yield { type: "stop", reason: stopReason };
  }
}

/**
 * Build a Responses request body from Click's neutral request.
 *
 * The wire shape differs from chat completions in three ways that matter here:
 * the conversation is an `input` item list (not `messages`), the system prompt
 * is a top-level `instructions` string, and tools are flat `{type:"function",
 * name, parameters}` objects rather than nested under `function`.
 */
export function buildResponsesBody(
  chatRequest: ChatRequest,
  extraBody: Record<string, unknown> = {},
): Record<string, unknown> {
  const { instructions, input } = convertResponsesInput(chatRequest);
  const body: Record<string, unknown> = {
    model: chatRequest.model,
    stream: true,
    input,
    ...extraBody,
  };
  if (instructions) body.instructions = instructions;
  if (chatRequest.tools && chatRequest.tools.length > 0) {
    body.tools = chatRequest.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
    body.tool_choice = "auto";
  }
  if (chatRequest.temperature !== undefined) body.temperature = chatRequest.temperature;
  if (chatRequest.maxOutputTokens !== undefined) body.max_output_tokens = chatRequest.maxOutputTokens;
  applyReasoningEffort(body, "responses", chatRequest.options?.reasoningEffort);
  return body;
}

function convertResponsesInput(chatRequest: ChatRequest): {
  instructions?: string;
  input: unknown[];
} {
  const instructions: string[] = [];
  if (chatRequest.system && chatRequest.system.trim()) instructions.push(chatRequest.system);

  const input: unknown[] = [];
  for (const message of chatRequest.messages) {
    if (message.role === "system") {
      const value = textOf(message);
      if (value.trim()) instructions.push(value);
      continue;
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "toolResult") {
          input.push({
            type: "function_call_output",
            call_id: part.toolCallId,
            output: part.content,
          });
        }
      }
      continue;
    }
    if (message.role === "assistant") {
      const value = textOf(message);
      if (value) input.push({ role: "assistant", content: [{ type: "output_text", text: value }] });
      for (const part of message.content) {
        if (part.type === "toolCall") {
          input.push({
            type: "function_call",
            call_id: part.id,
            name: part.name,
            arguments:
              typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {}),
          });
        }
      }
      continue;
    }
    input.push({ role: "user", content: convertUserContent(message) });
  }

  return instructions.length > 0 ? { instructions: instructions.join("\n\n"), input } : { input };
}

function convertUserContent(message: ChatMessage): unknown {
  const hasImage = message.content.some((part) => part.type === "image");
  if (!hasImage) return textOf(message);
  return message.content.flatMap((part): unknown[] => {
    if (part.type === "text") return [{ type: "input_text", text: part.text }];
    if (part.type === "image") {
      return [
        { type: "input_image", image_url: `data:${part.mediaType};base64,${part.dataBase64}` },
      ];
    }
    return [];
  });
}

function textOf(message: ChatMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}
