import {
  ModelId,
  ProviderError,
  ProviderId,
  type ApiKeyProviderConfig,
  type ChatMessage,
  type ChatRequest,
  type ChatStreamEvent,
  type ModelInfo,
  type ProviderDescriptor,
  type StopReason,
} from "@click/contracts";
import {
  ToolCallAccumulator,
  baseUrl,
  ensureOk,
  joinUrl,
  mergeHeaders,
  request,
  requestJson,
  resolveApiKey,
  sanitizeHeaders,
  type ChatProvider,
  type ProviderContext,
  type ProviderFactory,
  type ProviderHealth,
} from "@click/provider-core";
import { parseSseJson } from "@click/provider-core";

const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

export const ANTHROPIC_MODELS: ModelInfo[] = [
  model("claude-sonnet-4-5", "Claude Sonnet 4.5", 200_000, true, true),
  model("claude-opus-4-1", "Claude Opus 4.1", 200_000, true, true),
  model("claude-haiku-4-5", "Claude Haiku 4.5", 200_000, true, true),
];

function model(
  id: string,
  name: string,
  contextWindow: number,
  supportsTools: boolean,
  supportsThinking: boolean,
): ModelInfo {
  return {
    id: ModelId.make(id),
    name,
    provider: ProviderId.make("anthropic"),
    contextWindow,
    maxOutputTokens: 32_000,
    supportsTools,
    supportsImages: true,
    supportsThinking,
    supportsStreaming: true,
  };
}

interface AnthropicStreamChunk {
  type: string;
  index?: number;
  message?: { usage?: { input_tokens?: number } };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: { output_tokens?: number; input_tokens?: number };
}

export class AnthropicProvider implements ChatProvider {
  readonly id: ProviderId = ProviderId.make("anthropic");
  readonly descriptor: ProviderDescriptor;
  private readonly ctx: ProviderContext;
  private readonly apiKey: string | undefined;
  private readonly resolvedBaseUrl: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(config: ApiKeyProviderConfig, ctx: ProviderContext) {
    this.ctx = ctx;
    this.apiKey = resolveApiKey(config.apiKey, ctx.env, ["ANTHROPIC_API_KEY"]);
    this.resolvedBaseUrl = baseUrl(config.baseUrl, ANTHROPIC_DEFAULT_BASE_URL);
    this.extraHeaders = sanitizeHeaders(config.headers ?? {});
    this.descriptor = {
      id: this.id,
      name: "Anthropic",
      kind: "api-key",
      badge: "A",
      accent: "#d97757",
      description: "Claude models from Anthropic.",
      requiresApiKey: true,
      supportsCustomBaseUrl: true,
      models: ANTHROPIC_MODELS,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.apiKey) return ANTHROPIC_MODELS;
    try {
      const payload = await requestJson<{ data?: Array<{ id?: string }> }>(
        this.ctx,
        joinUrl(this.resolvedBaseUrl, "/v1/models"),
        { method: "GET", headers: this.headers() },
        { provider: "anthropic", action: "list models" },
      );
      const ids = (payload.data ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === "string");
      if (ids.length === 0) return ANTHROPIC_MODELS;
      const known = new Map(ANTHROPIC_MODELS.map((m) => [m.id as string, m]));
      return ids.map(
        (id) =>
          known.get(id) ?? {
            id: ModelId.make(id),
            name: id,
            provider: this.id,
            contextWindow: 200_000,
            supportsTools: true,
            supportsImages: true,
            supportsThinking: false,
            supportsStreaming: true,
          },
      );
    } catch {
      return ANTHROPIC_MODELS;
    }
  }

  async check(): Promise<ProviderHealth> {
    if (!this.apiKey) return { ok: false, detail: "No API key configured" };
    try {
      const response = await request(
        this.ctx,
        joinUrl(this.resolvedBaseUrl, "/v1/models"),
        { method: "GET", headers: this.headers() },
        { provider: "anthropic", action: "health check" },
      );
      if (response.ok) return { ok: true };
      if (response.status === 401 || response.status === 403) {
        return { ok: false, detail: `Authentication failed (HTTP ${response.status})` };
      }
      return { ok: true, detail: `Reachable (HTTP ${response.status})` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async *stream(chatRequest: ChatRequest): AsyncIterable<ChatStreamEvent> {
    const response = await request(
      this.ctx,
      joinUrl(this.resolvedBaseUrl, "/v1/messages"),
      {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify(this.buildBody(chatRequest)),
        signal: chatRequest.signal,
      },
      { provider: "anthropic", model: chatRequest.model, action: "chat completion" },
    );
    await ensureOk(response, {
      provider: "anthropic",
      model: chatRequest.model,
      action: "chat completion",
    });

    yield { type: "start" };

    const accumulator = new ToolCallAccumulator();
    let stopReason: StopReason = "end_turn";
    let inputTokens = 0;

    const stream = response.body;
    if (!stream) {
      throw new ProviderError({ kind: "network", provider: "anthropic", message: "No response body" });
    }

    for await (const chunk of parseSseJson<AnthropicStreamChunk>(stream)) {
      switch (chunk.type) {
        case "message_start":
          inputTokens = chunk.message?.usage?.input_tokens ?? 0;
          break;
        case "content_block_start":
          if (chunk.content_block?.type === "tool_use" && chunk.index !== undefined) {
            accumulator.push(chunk.index, {
              id: chunk.content_block.id,
              name: chunk.content_block.name,
            });
          }
          break;
        case "content_block_delta": {
          const delta = chunk.delta;
          if (delta?.type === "text_delta" && delta.text) {
            yield { type: "text_delta", text: delta.text };
          } else if (delta?.type === "thinking_delta" && delta.thinking) {
            yield { type: "thinking_delta", text: delta.thinking };
          } else if (
            delta?.type === "input_json_delta" &&
            chunk.index !== undefined &&
            delta.partial_json
          ) {
            accumulator.push(chunk.index, { argumentsFragment: delta.partial_json });
          }
          break;
        }
        case "content_block_stop":
          if (chunk.index !== undefined) {
            for (const event of accumulator.drain([chunk.index])) yield event;
          }
          break;
        case "message_delta":
          if (chunk.delta?.stop_reason) stopReason = mapStopReason(chunk.delta.stop_reason);
          if (chunk.usage?.output_tokens !== undefined) {
            yield {
              type: "usage",
              usage: { inputTokens, outputTokens: chunk.usage.output_tokens },
            };
          }
          break;
        default:
          break;
      }
    }

    for (const event of accumulator.flush()) yield event;
    yield { type: "stop", reason: stopReason };
  }

  async dispose(): Promise<void> {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const auth: Record<string, string> = this.apiKey ? { "x-api-key": this.apiKey } : {};
    return mergeHeaders(auth, { "anthropic-version": ANTHROPIC_VERSION }, this.extraHeaders, extra);
  }

  private buildBody(chatRequest: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: chatRequest.model,
      max_tokens: chatRequest.maxOutputTokens ?? 8192,
      stream: true,
      messages: convertMessages(chatRequest.messages),
    };
    if (chatRequest.system && chatRequest.system.trim()) body.system = chatRequest.system;
    if (chatRequest.tools && chatRequest.tools.length > 0) {
      body.tools = chatRequest.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }
    if (chatRequest.temperature !== undefined) body.temperature = chatRequest.temperature;
    return body;
  }
}

export function makeAnthropicFactory(): ProviderFactory {
  const descriptor = new AnthropicProvider(
    { type: "api-key", apiKey: "placeholder" },
    { env: {}, fetch: globalThis.fetch },
  ).descriptor;
  return {
    descriptor,
    create(config, ctx) {
      if (!config || typeof config !== "object") return null;
      const typed = config as ApiKeyProviderConfig;
      if (typed.type !== undefined && typed.type !== "api-key") return null;
      const apiKey = resolveApiKey(typed.apiKey, ctx.env, ["ANTHROPIC_API_KEY"]);
      if (!apiKey) return null;
      return new AnthropicProvider(typed, ctx);
    },
  };
}

function convertMessages(messages: ChatMessage[]): unknown[] {
  const result: unknown[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const toolResults = message.content.filter((part) => part.type === "toolResult");
      if (toolResults.length > 0) {
        result.push({
          role: "user",
          content: toolResults.map((part) =>
            part.type === "toolResult"
              ? {
                  type: "tool_result",
                  tool_use_id: part.toolCallId,
                  content: part.content,
                  ...(part.isError ? { is_error: true } : {}),
                }
              : null,
          ),
        });
      }
      continue;
    }
    const blocks = message.content.flatMap((part): unknown[] => {
      if (part.type === "text") return [{ type: "text", text: part.text }];
      if (part.type === "image") {
        return [
          {
            type: "image",
            source: { type: "base64", media_type: part.mediaType, data: part.dataBase64 },
          },
        ];
      }
      if (part.type === "toolCall") {
        return [
          { type: "tool_use", id: part.id, name: part.name, input: part.input ?? {} },
        ];
      }
      if (part.type === "thinking") return [{ type: "thinking", thinking: part.text }];
      return [];
    });
    if (blocks.length > 0) result.push({ role: message.role, content: blocks });
  }
  return result;
}

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "end_turn":
    default:
      return "end_turn";
  }
}
