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
  type WireProtocol,
} from "@click/contracts";
import {
  ToolCallAccumulator,
  baseUrl,
  ensureOk,
  joinUrl,
  request,
  requestJson,
  mergeHeaders,
  resolveApiKey,
  sanitizeHeaders,
  type ChatProvider,
  type ProviderContext,
  type ProviderFactory,
  type ProviderHealth,
} from "@click/provider-core";
import { parseSseJson } from "@click/provider-core";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import { OpenAiResponsesClient } from "./openaiResponses.js";
import { applyReasoningEffort, selectProtocol } from "./protocol.js";

/** Static configuration describing a concrete OpenAI-compatible provider. */
export interface OpenAiCompatibleSpec {
  id: string;
  name: string;
  badge: string;
  accent: string;
  description: string;
  defaultBaseUrl: string;
  envVarNames: string[];
  requiresApiKey: boolean;
  supportsCustomBaseUrl: boolean;
  defaultModels: ModelInfo[];
  /** Header carrying the credential. Defaults to `Authorization: Bearer`. */
  authHeader?: (apiKey: string) => Record<string, string>;
  /** Path used for model discovery. Empty string disables discovery. */
  modelsPath?: string;
  /** Parse a discovery response into a list of model ids. */
  parseModels?: (payload: unknown) => string[];
  /** Extra static body fields merged into every chat request. */
  extraBody?: Record<string, unknown>;
  /**
   * Protocol used when a model carries no protocol metadata. Defaults to
   * `"chat"`; only native OpenAI overrides it to `"responses"`.
   */
  defaultProtocol?: WireProtocol;
}

interface OpenAiChatChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiCompatibleProvider implements ChatProvider {
  readonly id: ProviderId;
  readonly descriptor: ProviderDescriptor;
  private readonly spec: OpenAiCompatibleSpec;
  private readonly config: ApiKeyProviderConfig;
  private readonly ctx: ProviderContext;
  private readonly apiKey: string | undefined;
  private readonly resolvedBaseUrl: string;
  private readonly extraHeaders: Record<string, string>;
  /** Models learned from discovery/registry; used to pick the wire protocol. */
  private discovered: ModelInfo[] | undefined;
  private responses: OpenAiResponsesClient | undefined;
  private responsesBaseUrl: string | undefined;
  /**
   * Native-protocol clients (Anthropic/Google), keyed by protocol + base URL.
   * Registry models can point at a different endpoint per model, so one shared
   * client is not enough.
   */
  private readonly native = new Map<string, ChatProvider>();

  constructor(spec: OpenAiCompatibleSpec, config: ApiKeyProviderConfig, ctx: ProviderContext) {
    this.spec = spec;
    this.config = config;
    this.ctx = ctx;
    this.id = ProviderId.make(spec.id);
    this.apiKey = resolveApiKey(config.apiKey, ctx.env, spec.envVarNames);
    this.resolvedBaseUrl = baseUrl(config.baseUrl, spec.defaultBaseUrl);
    this.extraHeaders = sanitizeHeaders(config.headers ?? {});
    this.descriptor = buildDescriptor(spec, config);
  }

  /**
   * Let a wrapper that discovers models elsewhere (OpenCode's registry) feed
   * them in, so `stream` can pick the protocol, base URL and effort levels from
   * the real metadata.
   */
  setModelCatalog(models: ModelInfo[]): void {
    this.discovered = models;
  }

  /** The model's metadata, from the registry/discovery first, else the descriptor. */
  private modelFor(modelId: string): ModelInfo | undefined {
    return (
      this.catalog().find((entry) => entry.id === modelId) ??
      this.descriptor.models.find((entry) => entry.id === modelId)
    );
  }

  /** The wire protocol for a model: its metadata first, then the provider default. */
  protocolFor(modelId: string): WireProtocol {
    return selectProtocol(this.modelFor(modelId), this.spec.id, this.spec.defaultProtocol);
  }

  private catalog(): ModelInfo[] {
    return this.discovered ?? this.descriptor.models;
  }

  /**
   * The base URL a model's request goes to: the registry's per-model
   * `provider.api` when present, else the provider's configured base URL. The
   * native clients append the protocol version themselves, so a versioned
   * registry base is trimmed for them (`nativeBaseUrl`).
   */
  private endpointFor(modelId: string): string {
    return this.modelFor(modelId)?.baseUrl ?? this.resolvedBaseUrl;
  }

  private responsesClient(baseUrl: string): OpenAiResponsesClient {
    if (!this.responses || this.responsesBaseUrl !== baseUrl) {
      this.responses = new OpenAiResponsesClient(this.ctx, {
        provider: this.spec.id,
        baseUrl,
        headers: (extra) => this.headers(extra),
        ...(this.spec.extraBody ? { extraBody: this.spec.extraBody } : {}),
      });
      this.responsesBaseUrl = baseUrl;
    }
    return this.responses;
  }

  /**
   * A native client for a non-OpenAI protocol, built on the same context and
   * key as this provider. Anthropic-protocol models use the Messages API
   * (x-api-key + anthropic-version); Google-protocol models use the Gemini API
   * (x-goog-api-key). Both take the model's endpoint, not the OpenAI one.
   */
  private nativeClient(protocol: "anthropic" | "google", baseUrl: string): ChatProvider {
    const key = `${protocol}:${baseUrl}`;
    const existing = this.native.get(key);
    if (existing) return existing;
    const config: ApiKeyProviderConfig = {
      type: "api-key",
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
      baseUrl: nativeBaseUrl(baseUrl),
      ...(this.config.headers ? { headers: this.config.headers } : {}),
    };
    const client =
      protocol === "anthropic"
        ? new AnthropicProvider(config, this.ctx)
        : new GoogleProvider(config, this.ctx);
    this.native.set(key, client);
    return client;
  }

  async listModels(): Promise<ModelInfo[]> {
    const declared = this.descriptor.models;
    if (!this.spec.modelsPath) return declared;
    if (this.spec.requiresApiKey && !this.apiKey) return declared;
    try {
      const payload = await requestJson<unknown>(
        this.ctx,
        joinUrl(this.resolvedBaseUrl, this.spec.modelsPath),
        { method: "GET", headers: this.headers() },
        { provider: this.spec.id, action: "list models" },
      );
      const ids = this.spec.parseModels
        ? this.spec.parseModels(payload)
        : defaultParseModels(payload);
      if (ids.length === 0) return declared;
      const disabled = new Set(this.config.disabledModels ?? []);
      const byId = new Map(declared.map((model) => [model.id as string, model]));
      const models = ids
        .filter((id) => !disabled.has(id))
        .map(
          (id) =>
            byId.get(id) ?? defaultModelInfo(this.id, id, this.spec.defaultProtocol ?? "chat"),
        );
      this.discovered = models;
      return models;
    } catch {
      return declared;
    }
  }

  async check(): Promise<ProviderHealth> {
    if (this.spec.requiresApiKey && !this.apiKey) {
      return { ok: false, detail: "No API key configured" };
    }
    try {
      const response = await request(
        this.ctx,
        joinUrl(this.resolvedBaseUrl, this.spec.modelsPath || "/models"),
        { method: "GET", headers: this.headers() },
        { provider: this.spec.id, action: "health check" },
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
    // The whole protocol decision: model metadata first, provider default next.
    // One switch, so "why did this request go to /messages?" has one answer.
    const baseUrl = this.endpointFor(chatRequest.model);
    switch (this.protocolFor(chatRequest.model)) {
      case "anthropic":
        yield* this.nativeClient("anthropic", baseUrl).stream(chatRequest);
        return;
      case "google":
        yield* this.nativeClient("google", baseUrl).stream(chatRequest);
        return;
      case "responses":
        yield* this.responsesClient(baseUrl).stream(chatRequest);
        return;
      default:
        yield* this.streamChatCompletions(chatRequest, baseUrl);
    }
  }

  private async *streamChatCompletions(
    chatRequest: ChatRequest,
    baseUrl: string,
  ): AsyncIterable<ChatStreamEvent> {
    const body = this.buildBody(chatRequest);
    const response = await request(
      this.ctx,
      joinUrl(baseUrl, "/chat/completions"),
      {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify(body),
        signal: chatRequest.signal,
      },
      { provider: this.spec.id, model: chatRequest.model, action: "chat completion" },
    );
    await ensureOk(response, {
      provider: this.spec.id,
      model: chatRequest.model,
      action: "chat completion",
    });

    yield { type: "start" };

    const accumulator = new ToolCallAccumulator();
    let stopReason: StopReason = "end_turn";

    const stream = response.body;
    if (!stream) {
      throw new ProviderError({
        kind: "network",
        provider: this.spec.id,
        message: "Response had no body",
      });
    }

    for await (const chunk of parseSseJson<OpenAiChatChunk>(stream)) {
      if (chunk.usage) {
        yield {
          type: "usage",
          usage: {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          },
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const thinking = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
      if (thinking) yield { type: "thinking_delta", text: thinking };
      if (choice.delta?.content) yield { type: "text_delta", text: choice.delta.content };

      for (const call of choice.delta?.tool_calls ?? []) {
        accumulator.push(call.index, {
          id: call.id,
          name: call.function?.name,
          argumentsFragment: call.function?.arguments,
        });
      }

      if (choice.finish_reason) {
        stopReason = mapFinishReason(choice.finish_reason);
        if (choice.finish_reason === "tool_calls") {
          for (const event of accumulator.flush()) yield event;
        }
      }
    }

    for (const event of accumulator.flush()) yield event;
    yield { type: "stop", reason: stopReason };
  }

  async dispose(): Promise<void> {
    // No persistent resources for HTTP providers beyond the native clients.
    for (const client of this.native.values()) await client.dispose();
    this.native.clear();
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const auth: Record<string, string> = this.apiKey
      ? (this.spec.authHeader?.(this.apiKey) ?? { authorization: `Bearer ${this.apiKey}` })
      : {};
    return mergeHeaders(auth, this.extraHeaders, extra);
  }

  private buildBody(chatRequest: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: chatRequest.model,
      stream: true,
      messages: convertMessages(chatRequest),
      ...(this.spec.extraBody ?? {}),
    };
    if (chatRequest.tools && chatRequest.tools.length > 0) {
      body.tools = chatRequest.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
      body.tool_choice = "auto";
    }
    if (chatRequest.temperature !== undefined) body.temperature = chatRequest.temperature;
    if (chatRequest.maxOutputTokens !== undefined) body.max_tokens = chatRequest.maxOutputTokens;
    applyReasoningEffort(body, "chat", chatRequest.options?.reasoningEffort);
    return body;
  }
}

export function makeOpenAiCompatibleFactory(spec: OpenAiCompatibleSpec): ProviderFactory {
  return {
    descriptor: buildDescriptor(spec, {}),
    create(config, ctx) {
      if (!config || typeof config !== "object") return null;
      const typed = config as ApiKeyProviderConfig;
      if (typed.type !== undefined && typed.type !== "api-key") return null;
      const apiKey = resolveApiKey(typed.apiKey, ctx.env, spec.envVarNames);
      if (spec.requiresApiKey && !apiKey) return null;
      return new OpenAiCompatibleProvider(spec, typed, ctx);
    },
  };
}

function convertMessages(chatRequest: ChatRequest): unknown[] {
  const result: unknown[] = [];
  if (chatRequest.system && chatRequest.system.trim()) {
    result.push({ role: "system", content: chatRequest.system });
  }
  for (const message of chatRequest.messages) {
    if (message.role === "system") {
      result.push({ role: "system", content: textOf(message) });
      continue;
    }
    if (message.role === "user") {
      result.push({ role: "user", content: convertUserContent(message) });
      continue;
    }
    if (message.role === "assistant") {
      result.push(convertAssistant(message));
      continue;
    }
    const toolResult = message.content.find((part) => part.type === "toolResult");
    if (toolResult && toolResult.type === "toolResult") {
      result.push({
        role: "tool",
        tool_call_id: toolResult.toolCallId,
        content: toolResult.content,
      });
    }
  }
  return result;
}

function convertUserContent(message: ChatMessage): unknown {
  const hasImage = message.content.some((part) => part.type === "image");
  if (!hasImage) return textOf(message);
  return message.content.flatMap((part): unknown[] => {
    if (part.type === "text") return [{ type: "text", text: part.text }];
    if (part.type === "image") {
      return [
        {
          type: "image_url",
          image_url: { url: `data:${part.mediaType};base64,${part.dataBase64}` },
        },
      ];
    }
    return [];
  });
}

function convertAssistant(message: ChatMessage): unknown {
  const toolCalls = message.content.filter((part) => part.type === "toolCall");
  if (toolCalls.length === 0) return { role: "assistant", content: textOf(message) };
  return {
    role: "assistant",
    content: textOf(message) || null,
    tool_calls: toolCalls.map((part) =>
      part.type === "toolCall"
        ? {
            id: part.id,
            type: "function",
            function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
          }
        : null,
    ),
  };
}

function textOf(message: ChatMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function mapFinishReason(reason: string): "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
      return "end_turn";
    default:
      return "stop_sequence";
  }
}

export function buildDescriptor(
  spec: OpenAiCompatibleSpec,
  config: Partial<ApiKeyProviderConfig>,
): ProviderDescriptor {
  const fallback: WireProtocol = spec.defaultProtocol ?? "chat";
  const declared = spec.defaultModels.map((model) => withProtocol(model, fallback));
  const custom = (config.models ?? []).map((model) => ({
    id: ModelId.make(model.id),
    name: model.name ?? model.id,
    provider: ProviderId.make(spec.id),
    contextWindow: model.contextWindow ?? 128_000,
    ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
    supportsTools: model.supportsTools ?? true,
    supportsImages: model.supportsImages ?? false,
    supportsThinking: model.supportsThinking ?? false,
    supportsStreaming: true,
    protocol: fallback,
  }));
  return {
    id: ProviderId.make(spec.id),
    name: spec.name,
    kind: "api-key",
    badge: spec.badge,
    accent: spec.accent,
    description: spec.description,
    requiresApiKey: spec.requiresApiKey,
    supportsCustomBaseUrl: spec.supportsCustomBaseUrl,
    models: [...declared, ...custom],
  };
}

/** Surface the protocol on a descriptor model, without clobbering metadata. */
function withProtocol(model: ModelInfo, fallback: WireProtocol): ModelInfo {
  return model.protocol ? model : { ...model, protocol: fallback };
}

/**
 * Registry bases are versioned (`…/anthropic/v1`, `…/google/v1beta`), but
 * Click's native clients append the version themselves (`/v1/messages`,
 * `/v1beta/models/…`). Drop a trailing version segment so both agree; a base
 * with no version is returned unchanged.
 */
function nativeBaseUrl(api: string): string {
  return api.replace(/\/v\d+(?:beta|alpha)?$/i, "");
}

function defaultParseModels(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) =>
      entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"
        ? (entry as { id: string }).id
        : undefined,
    )
    .filter((id): id is string => typeof id === "string");
}

function defaultModelInfo(provider: ProviderId, id: string, protocol: WireProtocol): ModelInfo {
  return {
    id: ModelId.make(id),
    name: id,
    provider,
    contextWindow: 128_000,
    supportsTools: true,
    supportsImages: false,
    supportsThinking: false,
    supportsStreaming: true,
    protocol,
  };
}
