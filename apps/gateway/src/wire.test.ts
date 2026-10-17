import { describe, expect, it } from "vitest";
import {
  chunkFrame,
  finishReasonFor,
  qualifyModelId,
  splitModelId,
  toChatMessages,
  toChatRequest,
  toolCallDelta,
} from "./wire.js";
import type { OpenAiMessage } from "./wire.js";

describe("splitModelId", () => {
  it("splits provider and model", () => {
    expect(splitModelId("anthropic/claude-sonnet-4-5")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
  });

  it("keeps slashes inside the model id", () => {
    expect(splitModelId("openai-compatible/qwen/qwen2.5-coder:7b")).toEqual({
      provider: "openai-compatible",
      model: "qwen/qwen2.5-coder:7b",
    });
  });

  it("splits ACP model ids", () => {
    expect(splitModelId("claude-code/default")).toEqual({
      provider: "claude-code",
      model: "default",
    });
  });

  it("rejects ids without a provider", () => {
    expect(() => splitModelId("gpt-5.1")).toThrow(/provider\/model/);
    expect(() => splitModelId("/gpt-5.1")).toThrow(/provider\/model/);
    expect(() => splitModelId("openai/")).toThrow(/provider\/model/);
  });

  it("round-trips with qualifyModelId", () => {
    const id = qualifyModelId("deepseek", "deepseek-reasoner");
    expect(splitModelId(id)).toEqual({ provider: "deepseek", model: "deepseek-reasoner" });
  });
});

describe("toChatMessages", () => {
  it("hoists system messages out of the turn list", () => {
    const result = toChatMessages([
      { role: "system", content: "You are Click." },
      { role: "system", content: "Be terse." },
      { role: "user", content: "hello" },
    ]);
    expect(result.system).toBe("You are Click.\n\nBe terse.");
    expect(result.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  });

  it("treats developer messages as system messages", () => {
    const result = toChatMessages([{ role: "developer", content: "rules" }]);
    expect(result.system).toBe("rules");
    expect(result.messages).toEqual([]);
  });

  it("omits an empty system field", () => {
    expect(toChatMessages([{ role: "user", content: "hi" }]).system).toBeUndefined();
  });

  it("converts data-url images into image content", () => {
    const messages: OpenAiMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ];
    expect(toChatMessages(messages).messages[0]?.content).toEqual([
      { type: "text", text: "what is this" },
      { type: "image", mediaType: "image/png", dataBase64: "AAAA" },
    ]);
  });

  it("drops remote image urls it cannot inline", () => {
    const messages: OpenAiMessage[] = [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
      },
    ];
    expect(toChatMessages(messages).messages[0]?.content).toEqual([]);
  });

  it("converts assistant tool calls into toolCall parts", () => {
    const result = toChatMessages([
      {
        role: "assistant",
        content: "reading it",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
        ],
      },
    ]);
    expect(result.messages[0]?.content).toEqual([
      { type: "text", text: "reading it" },
      { type: "toolCall", id: "call_1", name: "read_file", input: { path: "a.txt" } },
    ]);
  });

  it("keeps unparseable tool arguments as raw text", () => {
    const result = toChatMessages([
      {
        role: "assistant",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read_file", arguments: "{oops" } },
        ],
      },
    ]);
    expect(result.messages[0]?.content[0]).toEqual({
      type: "toolCall",
      id: "call_1",
      name: "read_file",
      input: "{oops",
    });
  });

  it("converts tool results back to the tool role", () => {
    const result = toChatMessages([
      { role: "tool", tool_call_id: "call_1", content: "file contents" },
    ]);
    expect(result.messages[0]).toEqual({
      role: "tool",
      content: [{ type: "toolResult", toolCallId: "call_1", content: "file contents" }],
    });
  });
});

describe("toChatRequest", () => {
  it("maps an OpenAI body onto a ChatRequest", () => {
    const request = toChatRequest(
      {
        model: "anthropic/claude-sonnet-4-5",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.2,
        max_tokens: 4000,
        tools: [
          {
            type: "function",
            function: { name: "read_file", description: "Read a file", parameters: { type: "object" } },
          },
        ],
      },
      "anthropic",
      "claude-sonnet-4-5",
    );
    expect(request.provider).toBe("anthropic");
    expect(request.model).toBe("claude-sonnet-4-5");
    expect(request.temperature).toBe(0.2);
    expect(request.maxOutputTokens).toBe(4000);
    expect(request.tools).toEqual([
      { name: "read_file", description: "Read a file", inputSchema: { type: "object" } },
    ]);
  });

  it("prefers max_tokens but accepts max_completion_tokens", () => {
    const base = { model: "openai/gpt-5.1", messages: [] };
    expect(toChatRequest({ ...base, max_tokens: 10 }, "openai", "gpt-5.1").maxOutputTokens).toBe(10);
    expect(
      toChatRequest({ ...base, max_completion_tokens: 20 }, "openai", "gpt-5.1").maxOutputTokens,
    ).toBe(20);
  });

  it("omits tools when none were supplied", () => {
    const request = toChatRequest({ model: "openai/gpt-5.1", messages: [] }, "openai", "gpt-5.1");
    expect(request.tools).toBeUndefined();
  });
});

describe("response frames", () => {
  it("builds a delta chunk", () => {
    const frame = chunkFrame("chatcmpl-1", "anthropic/claude", 1000, { content: "hi" });
    expect(frame).toEqual({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1000,
      model: "anthropic/claude",
      choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
    });
  });

  it("builds a tool call delta with stringified arguments", () => {
    const delta = toolCallDelta({ id: "call_1", name: "read_file", input: { path: "a.txt" } }, 0) as {
      tool_calls: Array<{ index: number; function: { name: string; arguments: string } }>;
    };
    expect(delta.tool_calls[0]?.index).toBe(0);
    expect(delta.tool_calls[0]?.function.name).toBe("read_file");
    expect(JSON.parse(delta.tool_calls[0]?.function.arguments ?? "{}")).toEqual({ path: "a.txt" });
  });

  it("maps stop reasons onto OpenAI finish reasons", () => {
    expect(finishReasonFor("end_turn", false)).toBe("stop");
    expect(finishReasonFor("tool_use", true)).toBe("tool_calls");
    expect(finishReasonFor("max_tokens", false)).toBe("length");
    expect(finishReasonFor("end_turn", true)).toBe("tool_calls");
    expect(finishReasonFor("aborted", false)).toBe("stop");
  });
});

describe("toChatRequest", () => {
  const base = { model: "opencode-go/deepseek-v4.1-flash", messages: [{ role: "user" as const, content: "hi" }] };

  it("forwards reasoning_effort as a provider option", () => {
    const request = toChatRequest({ ...base, reasoning_effort: "high" }, "opencode-go", "deepseek-v4.1-flash");
    expect(request.options).toEqual({ reasoningEffort: "high" });
  });

  it("omits the option when no effort was sent", () => {
    const request = toChatRequest(base, "opencode-go", "deepseek-v4.1-flash");
    expect(request.options).toBeUndefined();
  });

  it("ignores a blank effort value", () => {
    const request = toChatRequest({ ...base, reasoning_effort: "   " }, "opencode-go", "deepseek-v4.1-flash");
    expect(request.options).toBeUndefined();
  });
});
