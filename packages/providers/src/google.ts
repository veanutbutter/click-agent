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
  type ToolCallId,
} from "@click/contracts";
import {
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

export const GOOGLE_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const PROVIDER_ID = "google";

export const GOOGLE_MODELS: ModelInfo[] = [
  model("gemini-2.5-pro", "Gemini 2.5 Pro", 1_048_576, true),
  model("gemini-2.5-flash", "Gemini 2.5 Flash", 1_048_576, true),
  model("gemini-2.0-flash", "Gemini 2.0 Flash", 1_048_576, false),
];

function model(id: string, name: string, contextWindow: number, supportsThinking: boolean): ModelInfo {
  return {
    id: ModelId.make(id),
    name,
    provider: ProviderId.make(PROVIDER_ID),
    contextWindow,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsImages: true,
    supportsThinking,
    supportsStreaming: true,
  };
}

interface GeminiChunk {
  candidates?: Array<{
    content?: { role?: string; parts?: Array<GeminiPart> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
}

export class GoogleProvider implements ChatProvider {
  readonly id: ProviderId = ProviderId.make(PROVIDER_ID);
  readonly descriptor: ProviderDescriptor;
  private readonly ctx: ProviderContext;
  private readonly apiKey: string | undefined;
  private readonly resolvedBaseUrl: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(config: ApiKeyProviderConfig, ctx: ProviderContext) {
    this.ctx = ctx;
    this.apiKey = resolveApiKey(config.apiKey, ctx.env, ["GEMINI_API_KEY", "GOOGLE_AI_API_KEY"]);
    this.resolvedBaseUrl = baseUrl(config.baseUrl, GOOGLE_DEFAULT_BASE_URL);
    this.extraHeaders = sanitizeHeaders(config.headers ?? {});
    this.descriptor = {
      id: this.id,
      name: "Google AI",
      kind: "api-key",
      badge: "G",
      accent: "#4285f4",
      description: "Gemini models from Google AI Studio.",
      requiresApiKey: true,
      supportsCustomBaseUrl: true,
      models: GOOGLE_MODELS,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.apiKey) return GOOGLE_MODELS;
    try {
      const payload = await requestJson<{ models?: Array<{ name?: string }> }>(
        this.ctx,
        joinUrl(this.resolvedBaseUrl, "/v1beta/models"),
        { method: "GET", headers: this.headers() },
        { provider: PROVIDER_ID, action: "list models" },
      );
      const ids = (payload.models ?? [])
        .map((entry) => entry.name?.replace(/^models\//, ""))
        .filter((id): id is string => typeof id === "string")
        .filter((id) => id.startsWith("gemini"));
      if (ids.length === 0) return GOOGLE_MODELS;
      const known = new Map(GOOGLE_MODELS.map((m) => [m.id as string, m]));
      return ids.map(
        (id) =>
          known.get(id) ?? {
            id: ModelId.make(id),
            name: id,
            provider: this.id,
            contextWindow: 1_048_576,
            supportsTools: true,
            supportsImages: true,
            supportsThinking: false,
            supportsStreaming: true,
          },
      );
    } catch {
      return GOOGLE_MODELS;
    }
  }

  async check(): Promise<ProviderHealth> {
    if (!this.apiKey) return { ok: false, detail: "No API key configured" };
    try {
      const response = await request(
        this.ctx,
        joinUrl(this.resolvedBaseUrl, "/v1beta/models"),
        { method: "GET", headers: this.headers() },
        { provider: PROVIDER_ID, action: "health check" },
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
    const url = joinUrl(
      this.resolvedBaseUrl,
      `/v1beta/models/${chatRequest.model}:streamGenerateContent?alt=sse`,
    );
    const response = await request(
      this.ctx,
      url,
      {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify(this.buildBody(chatRequest)),
        signal: chatRequest.signal,
      },
      { provider: PROVIDER_ID, model: chatRequest.model, action: "chat completion" },
    );
    await ensureOk(response, {
      provider: PROVIDER_ID,
      model: chatRequest.model,
      action: "chat completion",
    });

    yield { type: "start" };

    let stopReason: StopReason = "end_turn";
    const stream = response.body;
    if (!stream) {
      throw new ProviderError({ kind: "network", provider: PROVIDER_ID, message: "No response body" });
    }

    for await (const chunk of parseSseJson<GeminiChunk>(stream)) {
      if (chunk.usageMetadata) {
        yield {
          type: "usage",
          usage: {
            inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
            outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
          },
        };
      }
      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;
      for (const part of candidate.content?.parts ?? []) {
        if (part.text) {
          yield { type: "text_delta", text: part.text };
        } else if (part.functionCall) {
          yield {
            type: "tool_call",
            call: {
              id: `call_${part.functionCall.name}_${Math.random().toString(36).slice(2, 8)}` as ToolCallId,
              name: part.functionCall.name ?? "unknown",
              input: part.functionCall.args ?? {},
            },
          };
        }
      }
      if (candidate.finishReason) stopReason = mapFinishReason(candidate.finishReason);
    }

    yield { type: "stop", reason: stopReason };
  }

  async dispose(): Promise<void> {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const auth: Record<string, string> = this.apiKey ? { "x-goog-api-key": this.apiKey } : {};
    return mergeHeaders(auth, this.extraHeaders, extra);
  }

  private buildBody(chatRequest: ChatRequest): Record<string, unknown> {
    const nameById = new Map<string, string>();
    for (const message of chatRequest.messages) {
      for (const part of message.content) {
        if (part.type === "toolCall") nameById.set(part.id, part.name);
      }
    }
    const body: Record<string, unknown> = {
      contents: convertMessages(chatRequest.messages, nameById),
    };
    if (chatRequest.system && chatRequest.system.trim()) {
      body.systemInstruction = { parts: [{ text: chatRequest.system }] };
    }
    if (chatRequest.tools && chatRequest.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: chatRequest.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
        },
      ];
    }
    const generationConfig: Record<string, unknown> = {};
    if (chatRequest.temperature !== undefined) generationConfig.temperature = chatRequest.temperature;
    if (chatRequest.maxOutputTokens !== undefined) {
      generationConfig.maxOutputTokens = chatRequest.maxOutputTokens;
    }
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
    return body;
  }
}

export function makeGoogleFactory(): ProviderFactory {
  const descriptor = new GoogleProvider(
    { type: "api-key", apiKey: "placeholder" },
    { env: {}, fetch: globalThis.fetch },
  ).descriptor;
  return {
    descriptor,
    create(config, ctx) {
      if (!config || typeof config !== "object") return null;
      const typed = config as ApiKeyProviderConfig;
      if (typed.type !== undefined && typed.type !== "api-key") return null;
      const apiKey = resolveApiKey(typed.apiKey, ctx.env, ["GEMINI_API_KEY", "GOOGLE_AI_API_KEY"]);
      if (!apiKey) return null;
      return new GoogleProvider(typed, ctx);
    },
  };
}

function convertMessages(messages: ChatMessage[], nameById: Map<string, string>): unknown[] {
  const contents: unknown[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const parts = message.content.flatMap((part) => {
        if (part.type !== "toolResult") return [];
        const name = nameById.get(part.toolCallId) ?? part.toolCallId;
        return [
          {
            functionResponse: {
              name,
              response: { content: part.content, ...(part.isError ? { isError: true } : {}) },
            },
          },
        ];
      });
      if (parts.length > 0) contents.push({ role: "user", parts });
      continue;
    }
    const role = message.role === "assistant" ? "model" : "user";
    const parts = message.content.flatMap((part): unknown[] => {
      if (part.type === "text") return [{ text: part.text }];
      if (part.type === "image") {
        return [{ inlineData: { mimeType: part.mediaType, data: part.dataBase64 } }];
      }
      if (part.type === "toolCall") {
        return [{ functionCall: { name: part.name, args: (part.input ?? {}) as object } }];
      }
      return [];
    });
    if (parts.length > 0) contents.push({ role, parts });
  }
  return contents;
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    default:
      return "stop_sequence";
  }
}
