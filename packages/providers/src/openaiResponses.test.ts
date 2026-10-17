import { describe, expect, it } from "vitest";
import { ModelId, ProviderId, userMessage, type ChatStreamEvent } from "@click/contracts";
import type { ProviderContext } from "@click/provider-core";
import { OpenAiCompatibleProvider } from "./openaiCompatible.js";
import { OpenAiResponsesClient, buildResponsesBody } from "./openaiResponses.js";
import { parseOpenCodeCatalog } from "./opencode.js";
import { DEEPSEEK_SPEC, OPENAI_SPEC } from "./specs.js";

interface Recorded {
  url: string;
  init: RequestInit;
}

function sseResponse(events: unknown[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
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

/** A short but complete Responses stream: reasoning, text, a tool call, usage. */
const RESPONSES_EVENTS: unknown[] = [
  { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
  {
    type: "response.reasoning_summary_text.delta",
    item_id: "rs_1",
    output_index: 0,
    summary_index: 0,
    delta: "hmm",
  },
  { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1" } },
  {
    type: "response.output_text.delta",
    item_id: "msg_1",
    output_index: 1,
    content_index: 0,
    delta: "Hel",
  },
  {
    type: "response.output_text.delta",
    item_id: "msg_1",
    output_index: 1,
    content_index: 0,
    delta: "lo",
  },
  {
    type: "response.output_item.added",
    output_index: 2,
    item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file" },
  },
  {
    type: "response.function_call_arguments.delta",
    item_id: "fc_1",
    output_index: 2,
    delta: '{"path":',
  },
  {
    type: "response.function_call_arguments.delta",
    item_id: "fc_1",
    output_index: 2,
    delta: '"a.txt"}',
  },
  {
    type: "response.output_item.done",
    output_index: 2,
    item: {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "read_file",
      arguments: '{"path":"a.txt"}',
    },
  },
  {
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 4 } },
    },
  },
];

describe("buildResponsesBody", () => {
  it("builds the Responses wire shape", () => {
    const body = buildResponsesBody({
      provider: "openai",
      model: "gpt-5.1",
      system: "You are Click.",
      messages: [userMessage("hi")],
      tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }],
      temperature: 0.2,
      maxOutputTokens: 1234,
      options: { reasoningEffort: "high" },
    });

    expect(body).toEqual({
      model: "gpt-5.1",
      stream: true,
      input: [{ role: "user", content: "hi" }],
      instructions: "You are Click.",
      tools: [
        { type: "function", name: "read_file", description: "Read", parameters: { type: "object" } },
      ],
      tool_choice: "auto",
      temperature: 0.2,
      max_output_tokens: 1234,
      reasoning: { effort: "high" },
    });
  });
});

describe("OpenAiResponsesClient", () => {
  it("posts to /responses and maps the stream to ChatStreamEvents", async () => {
    const { ctx, calls } = recordingFetch(() => sseResponse(RESPONSES_EVENTS));
    const client = new OpenAiResponsesClient(ctx, {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      headers: (extra = {}) => ({ authorization: "Bearer test-key", ...extra }),
    });

    const events = await collect(
      client.stream({
        provider: "openai",
        model: "gpt-5.1",
        system: "You are Click.",
        messages: [userMessage("hi")],
        options: { reasoningEffort: "high" },
      }),
    );

    expect(calls[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0]?.init.method).toBe("POST");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("gpt-5.1");
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe("You are Click.");
    expect(body.reasoning).toEqual({ effort: "high" });

    expect(events).toEqual([
      { type: "start" },
      { type: "thinking_delta", text: "hmm" },
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      { type: "tool_call", call: { id: "call_1", name: "read_file", input: { path: "a.txt" } } },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 4 } },
      { type: "stop", reason: "tool_use" },
    ]);
  });

  it("emits a tool call when only the completed item is sent", async () => {
    const { ctx } = recordingFetch(() =>
      sseResponse([
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            call_id: "call_9",
            name: "read_file",
            arguments: '{"path":"b.txt"}',
          },
        },
        {
          type: "response.completed",
          response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
        },
      ]),
    );
    const client = new OpenAiResponsesClient(ctx, {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      headers: () => ({}),
    });
    const events = await collect(
      client.stream({ provider: "openai", model: "gpt-5.1", messages: [userMessage("hi")] }),
    );
    expect(events).toContainEqual({
      type: "tool_call",
      call: { id: "call_9", name: "read_file", input: { path: "b.txt" } },
    });
    expect(events.at(-1)).toEqual({ type: "stop", reason: "tool_use" });
  });

  it("surfaces a failed response as a ProviderError", async () => {
    const { ctx } = recordingFetch(() =>
      sseResponse([
        { type: "response.failed", response: { status: "failed" }, error: { message: "boom" } },
      ]),
    );
    const client = new OpenAiResponsesClient(ctx, {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      headers: () => ({}),
    });
    await expect(
      collect(client.stream({ provider: "openai", model: "gpt-5.1", messages: [userMessage("hi")] })),
    ).rejects.toThrow(/boom/);
  });
});

describe("OpenAiCompatibleProvider protocol dispatch", () => {
  it("surfaces the protocol on descriptors", () => {
    const { ctx } = recordingFetch(() => sseResponse([]));
    const openai = new OpenAiCompatibleProvider(OPENAI_SPEC, { type: "api-key", apiKey: "k" }, ctx);
    expect(openai.descriptor.models.map((model) => model.protocol)).toEqual(
      openai.descriptor.models.map(() => "responses"),
    );
    const deepseek = new OpenAiCompatibleProvider(
      DEEPSEEK_SPEC,
      { type: "api-key", apiKey: "k" },
      ctx,
    );
    expect(deepseek.descriptor.models.every((model) => model.protocol === "chat")).toBe(true);
  });

  it("uses the Responses client for native OpenAI models", async () => {
    const { ctx, calls } = recordingFetch(() => sseResponse(RESPONSES_EVENTS));
    const provider = new OpenAiCompatibleProvider(
      OPENAI_SPEC,
      { type: "api-key", apiKey: "k" },
      ctx,
    );
    expect(provider.protocolFor("gpt-5.1")).toBe("responses");
    await collect(provider.stream({ provider: "openai", model: "gpt-5.1", messages: [userMessage("hi")] }));
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/responses");
  });

  it("uses chat completions for OpenAI-compatible providers", async () => {
    const { ctx, calls } = recordingFetch(() =>
      sseResponse([{ choices: [{ delta: { content: "hi" } }] }]),
    );
    const provider = new OpenAiCompatibleProvider(
      DEEPSEEK_SPEC,
      { type: "api-key", apiKey: "k" },
      ctx,
    );
    expect(provider.protocolFor("deepseek-chat")).toBe("chat");
    await collect(
      provider.stream({ provider: "deepseek", model: "deepseek-chat", messages: [userMessage("hi")] }),
    );
    expect(calls[0]?.url).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("honours registry metadata injected for a model", () => {
    const { ctx } = recordingFetch(() => sseResponse([]));
    const provider = new OpenAiCompatibleProvider(
      DEEPSEEK_SPEC,
      { type: "api-key", apiKey: "k" },
      ctx,
    );
    provider.setModelCatalog([
      {
        id: ModelId.make("some-model"),
        name: "Some Model",
        provider: ProviderId.make("deepseek"),
        contextWindow: 1000,
        supportsTools: true,
        supportsImages: false,
        supportsThinking: false,
        supportsStreaming: true,
        protocol: "responses",
      },
    ]);
    expect(provider.protocolFor("some-model")).toBe("responses");
  });
});

describe("OpenCode registry protocol metadata", () => {
  it("maps AI SDK packages and explicit protocol fields", () => {
    const json = {
      opencode: {
        npm: "@ai-sdk/openai-compatible",
        models: {
          "gpt-5.1": { id: "gpt-5.1", provider: { npm: "@ai-sdk/openai" } },
          "deepseek-v4.1-flash": { id: "deepseek-v4.1-flash" },
          "claude-sonnet-4-5": { id: "claude-sonnet-4-5", provider: { npm: "@ai-sdk/anthropic" } },
          "gemini-3-pro": { id: "gemini-3-pro", provider: { npm: "@ai-sdk/google" } },
          "explicit": { id: "explicit", protocol: "openai_responses" },
          "explicit-anthropic": { id: "explicit-anthropic", protocol: "anthropic" },
        },
      },
    };
    const byId = new Map(
      parseOpenCodeCatalog(json, "opencode", "opencode").map((model) => [model.id, model]),
    );
    expect(byId.get("gpt-5.1")?.protocol).toBe("responses");
    expect(byId.get("explicit")?.protocol).toBe("responses");
    expect(byId.get("explicit-anthropic")?.protocol).toBe("anthropic");
    // The entry's `@ai-sdk/openai-compatible` default makes chat the norm…
    expect(byId.get("deepseek-v4.1-flash")?.protocol).toBe("chat");
    // …while the native AI SDK packages now map to their own clients.
    expect(byId.get("claude-sonnet-4-5")?.protocol).toBe("anthropic");
    expect(byId.get("gemini-3-pro")?.protocol).toBe("google");
  });

  it("uses the provider entry's npm when a model has none", () => {
    const json = {
      opencode: {
        npm: "@ai-sdk/openai",
        models: { "some-openai-model": { id: "some-openai-model" } },
      },
    };
    const models = parseOpenCodeCatalog(json, "opencode", "opencode");
    expect(models[0]?.protocol).toBe("responses");
  });

  it("carries the per-model api, falling back to the entry api", () => {
    const json = {
      "opencode-go": {
        api: "https://opencode.ai/inference/go/openai/v1",
        models: {
          "claude-haiku-5-5": {
            id: "claude-haiku-5-5",
            provider: {
              npm: "@ai-sdk/anthropic",
              api: "https://opencode.ai/inference/go/anthropic/v1",
            },
          },
          "deepseek-v4.1-flash": { id: "deepseek-v4.1-flash" },
        },
      },
    };
    const byId = new Map(
      parseOpenCodeCatalog(json, "opencode-go", "opencode-go").map((model) => [model.id, model]),
    );
    expect(byId.get("claude-haiku-5-5")?.baseUrl).toBe(
      "https://opencode.ai/inference/go/anthropic/v1",
    );
    expect(byId.get("deepseek-v4.1-flash")?.baseUrl).toBe(
      "https://opencode.ai/inference/go/openai/v1",
    );
  });

  it("exposes the model's declared effort levels and toggle", () => {
    const json = {
      "opencode-go": {
        npm: "@ai-sdk/openai-compatible",
        models: {
          "qwen3.8-max": {
            id: "qwen3.8-max",
            reasoning: true,
            reasoning_options: [
              { type: "toggle" },
              { type: "effort", values: ["low", "medium", "xhigh"] },
              { type: "budget_tokens", max: 262144 },
            ],
          },
          "kimi-k3": {
            id: "kimi-k3",
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["max"] }],
          },
          "no-options": { id: "no-options", reasoning: true },
          "no-reasoning": { id: "no-reasoning", reasoning: false },
        },
      },
    };
    const byId = new Map(
      parseOpenCodeCatalog(json, "opencode-go", "opencode-go").map((model) => [model.id, model]),
    );
    expect(byId.get("qwen3.8-max")?.effortLevels).toEqual(["low", "medium", "xhigh"]);
    expect(byId.get("qwen3.8-max")?.supportsReasoningToggle).toBe(true);
    expect(byId.get("kimi-k3")?.effortLevels).toEqual(["max"]);
    expect(byId.get("kimi-k3")?.supportsReasoningToggle).toBeUndefined();
    // No reasoning_options: fall back to the default list for a reasoning model…
    expect(byId.get("no-options")?.effortLevels).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    // …but offer nothing for a model that does not reason at all.
    expect(byId.get("no-reasoning")?.effortLevels).toBeUndefined();
  });
});
