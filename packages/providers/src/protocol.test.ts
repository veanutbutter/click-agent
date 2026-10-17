import { describe, expect, it } from "vitest";
import {
  DEFAULT_EFFORT_LEVELS,
  applyReasoningEffort,
  defaultProtocolFor,
  selectProtocol,
} from "./protocol.js";

describe("defaultProtocolFor", () => {
  it("defaults native OpenAI to the Responses API", () => {
    expect(defaultProtocolFor("openai")).toBe("responses");
  });

  it("defaults every OpenAI-compatible provider to chat completions", () => {
    for (const id of [
      "xai",
      "deepseek",
      "mistral",
      "ollama",
      "openai-compatible",
      "opencode",
      "opencode-go",
      "openrouter",
      "groq",
      "cerebras",
    ]) {
      expect(defaultProtocolFor(id)).toBe("chat");
    }
  });
});

describe("selectProtocol", () => {
  it("prefers model metadata over the provider default", () => {
    expect(selectProtocol({ protocol: "chat" }, "openai")).toBe("chat");
    expect(selectProtocol({ protocol: "responses" }, "opencode")).toBe("responses");
  });

  it("falls back to the provider default when metadata is absent", () => {
    expect(selectProtocol(undefined, "openai")).toBe("responses");
    expect(selectProtocol({}, "deepseek")).toBe("chat");
  });

  it("honours an explicit provider default over the id-based one", () => {
    expect(selectProtocol(undefined, "openai", "chat")).toBe("chat");
    expect(selectProtocol({ protocol: "responses" }, "openai", "chat")).toBe("responses");
  });

  it("carries the native anthropic and google protocols through", () => {
    expect(selectProtocol({ protocol: "anthropic" }, "opencode-go")).toBe("anthropic");
    expect(selectProtocol({ protocol: "google" }, "opencode")).toBe("google");
  });
});

describe("DEFAULT_EFFORT_LEVELS", () => {
  it("is Zed's ordered list, used when a registry declares none", () => {
    expect(DEFAULT_EFFORT_LEVELS).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});

describe("applyReasoningEffort", () => {
  it("writes reasoning_effort for chat completions", () => {
    const body: Record<string, unknown> = {};
    applyReasoningEffort(body, "chat", "high");
    expect(body).toEqual({ reasoning_effort: "high" });
  });

  it("writes reasoning.effort for the Responses API", () => {
    const body: Record<string, unknown> = {};
    applyReasoningEffort(body, "responses", "high");
    expect(body).toEqual({ reasoning: { effort: "high" } });
  });

  it("leaves the body untouched when no effort was supplied", () => {
    const body: Record<string, unknown> = {};
    applyReasoningEffort(body, "responses", undefined);
    applyReasoningEffort(body, "chat", "   ");
    expect(body).toEqual({});
  });

  it("writes no OpenAI effort field for the native protocols", () => {
    const body: Record<string, unknown> = {};
    applyReasoningEffort(body, "anthropic", "high");
    applyReasoningEffort(body, "google", "high");
    expect(body).toEqual({});
  });
});
