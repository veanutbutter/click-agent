import { describe, expect, it } from "vitest";
import { ModelId, ProviderId, userMessage, type ChatStreamEvent, type ModelInfo } from "@click/contracts";
import type { ProviderContext } from "@click/provider-core";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import { OpenAiCompatibleProvider } from "./openaiCompatible.js";
import { OPENAI_COMPATIBLE_SPEC, OPENAI_SPEC } from "./specs.js";
import type { OpenAiCompatibleSpec } from "./openaiCompatible.js";

/**
 * Native OpenAI now defaults to the Responses API, so the chat-completions
 * client is exercised through a chat-defaulting variant of the same spec. The
 * `/responses` default is covered in `openaiResponses.test.ts`.
 */
const CHAT_SPEC: OpenAiCompatibleSpec = { ...OPENAI_SPEC, defaultProtocol: "chat" };

interface Recorded {
  url: string;
  init: RequestInit;
}

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
}

function recordingFetch(handler: (url: string, init: RequestInit) => Response): {
  ctx: ProviderContext;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof globalThis.fetch;
  return { ctx: { env: {}, fetch: fetchImpl, cwd: process.cwd() }, calls };
}

async function collect(events: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function textOf(events: ChatStreamEvent[]): string {
  return events
    .filter((event): event is { type: "text_delta"; text: string } => event.type === "text_delta")
    .map((event) => event.text)
    .join("");
}

describe("OpenAiCompatibleProvider", () => {
  const frame = (choices: unknown, usage?: unknown): string =>
    `data: ${JSON.stringify({ choices, ...(usage ? { usage } : {}) })}\n\n`;

  it("streams text from an OpenAI-compatible endpoint", async () => {
    const { ctx, calls } = recordingFetch(() =>
      sseResponse([
        frame([{ delta: { content: "Hel" } }]),
        frame([{ delta: { content: "lo" } }]),
        frame([{ delta: {}, finish_reason: "stop" }], { prompt_tokens: 3, completion_tokens: 2 }),
        "data: [DONE]\n\n",
      ]),
    );

    const provider = new OpenAiCompatibleProvider(
      CHAT_SPEC,
      { type: "api-key", apiKey: "test-key" },
      ctx,
    );
    const events = await collect(
      provider.stream({ provider: "openai", model: "gpt-5.1", messages: [userMessage("hi")] }),
    );

    expect(textOf(events)).toBe("Hello");
    expect(events[0]).toEqual({ type: "start" });
    expect(events.at(-1)).toEqual({ type: "stop", reason: "end_turn" });
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 3, outputTokens: 2 } });

    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.init.method).toBe("POST");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("gpt-5.1");
    expect(body.stream).toBe(true);
  });

  it("maps reasoning deltas to thinking events", async () => {
    const { ctx } = recordingFetch(() =>
      sseResponse([frame([{ delta: { reasoning_content: "hmm" } }]), frame([{ delta: {} }])]),
    );
    const provider = new OpenAiCompatibleProvider(
      CHAT_SPEC,
      { type: "api-key", apiKey: "k" },
      ctx,
    );
    const events = await collect(
      provider.stream({ provider: "openai", model: "gpt-5.1", messages: [userMessage("hi")] }),
    );
    expect(events).toContainEqual({ type: "thinking_delta", text: "hmm" });
  });

  it("assembles streamed tool calls", async () => {
    const { ctx } = recordingFetch(() =>
      sseResponse([
        frame([
          { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"a' } }] } },
        ]),
        frame([{ delta: { tool_calls: [{ index: 0, function: { arguments: '.txt"}' } }] }, finish_reason: "tool_calls" }]),
      ]),
    );
    const provider = new OpenAiCompatibleProvider(
      CHAT_SPEC,
      { type: "api-key", apiKey: "k" },
      ctx,
    );
    const events = await collect(
      provider.stream({ provider: "openai", model: "gpt-5.1", messages: [userMessage("hi")] }),
    );
    const call = events.find((event) => event.type === "tool_call");
    expect(call).toEqual({
      type: "tool_call",
      call: { id: "call_1", name: "read_file", input: { path: "a.txt" } },
    });
    expect(events.at(-1)).toEqual({ type: "stop", reason: "tool_use" });
  });

  it("sends tool definitions and tool_choice when tools are provided", async () => {
    const { ctx, calls } = recordingFetch(() => sseResponse([frame([{ delta: {} }])]));
    const provider = new OpenAiCompatibleProvider(
      CHAT_SPEC,
      { type: "api-key", apiKey: "k" },
      ctx,
    );
    await collect(
      provider.stream({
        provider: "openai",
        model: "gpt-5.1",
        messages: [userMessage("hi")],
        tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }],
      }),
    );
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.tool_choice).toBe("auto");
    expect((body.tools as unknown[])[0]).toEqual({
      type: "function",
      function: { name: "read_file", description: "Read", parameters: { type: "object" } },
    });
  });

  it("honours a custom base URL", async () => {
    const { ctx, calls } = recordingFetch(() => sseResponse([frame([{ delta: {} }])]));
    const provider = new OpenAiCompatibleProvider(
      CHAT_SPEC,
      { type: "api-key", apiKey: "k", baseUrl: "http://localhost:8080/v1/" },
      ctx,
    );
    await collect(provider.stream({ provider: "openai", model: "x", messages: [userMessage("hi")] }));
    expect(calls[0]?.url).toBe("http://localhost:8080/v1/chat/completions");
  });

  it("reports auth failures from check()", async () => {
    const { ctx } = recordingFetch(() => new Response("nope", { status: 401 }));
    const provider = new OpenAiCompatibleProvider(
      CHAT_SPEC,
      { type: "api-key", apiKey: "bad" },
      ctx,
    );
    const health = await provider.check();
    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/401/);
  });

  it("requires an API key unless the spec allows anonymous access", () => {
    const { ctx } = recordingFetch(() => sseResponse([]));
    const gated = new OpenAiCompatibleProvider(OPENAI_SPEC, { type: "api-key" }, ctx);
    expect(gated.descriptor.requiresApiKey).toBe(true);
    const open = new OpenAiCompatibleProvider(OPENAI_COMPATIBLE_SPEC, { type: "api-key" }, ctx);
    expect(open.descriptor.requiresApiKey).toBe(false);
  });

  it("reads the key from the environment when config omits it", async () => {
    const { ctx, calls } = recordingFetch(() => sseResponse([frame([{ delta: {} }])]));
    const withEnv: ProviderContext = { ...ctx, env: { OPENAI_API_KEY: "env-key" } };
    const provider = new OpenAiCompatibleProvider(CHAT_SPEC, { type: "api-key" }, withEnv);
    await collect(provider.stream({ provider: "openai", model: "x", messages: [userMessage("hi")] }));
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer env-key");
  });
});

describe("AnthropicProvider", () => {
  it("posts to the messages API with the right auth headers", async () => {
    const { ctx, calls } = recordingFetch(() =>
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );

    const provider = new AnthropicProvider({ type: "api-key", apiKey: "sk-ant" }, ctx);
    const events = await collect(
      provider.stream({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        messages: [userMessage("hi")],
      }),
    );

    expect(textOf(events)).toBe("Hi");
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.init.method).toBe("POST");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("claude-sonnet-4-5");
    expect(body.stream).toBe(true);
  });
});

describe("GoogleProvider", () => {
  it("streams twice from streamGenerateContent", async () => {
    const { ctx, calls } = recordingFetch(() =>
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"Ge"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"mini"}]},"finishReason":"STOP"}]}\n\n',
      ]),
    );

    const provider = new GoogleProvider({ type: "api-key", apiKey: "goog" }, ctx);
    const events = await collect(
      provider.stream({
        provider: "google",
        model: "gemini-2.5-flash",
        messages: [userMessage("hi")],
      }),
    );

    expect(textOf(events)).toBe("Gemini");
    expect(calls[0]?.url).toContain("/v1beta/models/gemini-2.5-flash:streamGenerateContent");
    expect(calls[0]?.url).toContain("alt=sse");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("goog");
  });
});

/**
 * The OpenAI-compatible provider is also the dispatcher: a registry model whose
 * protocol is `anthropic`/`google` is served by the native client, at the
 * model's own endpoint. These tests pin that routing.
 */
describe("OpenAiCompatibleProvider native-protocol routing", () => {
  const NATIVE_SPEC: OpenAiCompatibleSpec = {
    id: "opencode-go",
    name: "OpenCode Go",
    badge: "GO",
    accent: "#f472b6",
    description: "OpenCode Go test spec",
    defaultBaseUrl: "https://opencode.ai/inference/go/openai/v1",
    envVarNames: ["OPENCODE_API_KEY"],
    requiresApiKey: true,
    supportsCustomBaseUrl: true,
    defaultModels: [],
  };

  function registryModel(overrides: Partial<ModelInfo>): ModelInfo {
    return {
      id: ModelId.make("some-model"),
      name: "Some Model",
      provider: ProviderId.make("opencode-go"),
      contextWindow: 200_000,
      supportsTools: true,
      supportsImages: true,
      supportsThinking: true,
      supportsStreaming: true,
      ...overrides,
    };
  }

  it("streams anthropic-protocol models through the Messages API at the model's base URL", async () => {
    const { ctx, calls } = recordingFetch(() =>
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
      ]),
    );
    const provider = new OpenAiCompatibleProvider(
      NATIVE_SPEC,
      { type: "api-key", apiKey: "go-key" },
      ctx,
    );
    provider.setModelCatalog([
      registryModel({
        id: ModelId.make("claude-haiku-5-5"),
        protocol: "anthropic",
        baseUrl: "https://opencode.ai/inference/go/anthropic/v1",
      }),
    ]);

    expect(provider.protocolFor("claude-haiku-5-5")).toBe("anthropic");
    const events = await collect(
      provider.stream({
        provider: "opencode-go",
        model: "claude-haiku-5-5",
        messages: [userMessage("hi")],
      }),
    );

    expect(textOf(events)).toBe("Hi");
    // The registry's per-model endpoint, not the OpenAI gateway.
    expect(calls[0]?.url).toBe("https://opencode.ai/inference/go/anthropic/v1/messages");
    expect(calls[0]?.init.method).toBe("POST");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("go-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(8192);
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  it("streams google-protocol models through the Gemini API at the model's base URL", async () => {
    const { ctx, calls } = recordingFetch(() =>
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"Ge"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"mini"}]},"finishReason":"STOP"}]}\n\n',
      ]),
    );
    const provider = new OpenAiCompatibleProvider(
      NATIVE_SPEC,
      { type: "api-key", apiKey: "go-key" },
      ctx,
    );
    provider.setModelCatalog([
      registryModel({
        id: ModelId.make("gemini-4-argon"),
        protocol: "google",
        baseUrl: "https://opencode.ai/inference/go/google/v1beta",
      }),
    ]);

    expect(provider.protocolFor("gemini-4-argon")).toBe("google");
    const events = await collect(
      provider.stream({
        provider: "opencode-go",
        model: "gemini-4-argon",
        messages: [userMessage("hi")],
      }),
    );

    expect(textOf(events)).toBe("Gemini");
    expect(calls[0]?.url).toBe(
      "https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse",
    );
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("go-key");
  });

  it("keeps chat models on the OpenAI gateway", async () => {
    const { ctx, calls } = recordingFetch(() =>
      sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`]),
    );
    const provider = new OpenAiCompatibleProvider(
      NATIVE_SPEC,
      { type: "api-key", apiKey: "go-key" },
      ctx,
    );
    provider.setModelCatalog([
      registryModel({
        id: ModelId.make("deepseek-v4.1-flash"),
        protocol: "chat",
        baseUrl: "https://opencode.ai/inference/go/openai/v1",
      }),
    ]);
    await collect(
      provider.stream({
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        messages: [userMessage("hi")],
      }),
    );
    expect(calls[0]?.url).toBe(
      "https://opencode.ai/inference/go/openai/v1/chat/completions",
    );
  });
});
