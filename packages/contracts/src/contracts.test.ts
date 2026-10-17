import { describe, expect, it } from "vitest";
import { ModelId, ProviderId, ToolCallId } from "./ids.js";
import {
  ProviderError,
  isProviderError,
  isRetryableKind,
  kindFromStatus,
  toProviderError,
} from "./errors.js";
import { defaultSettings, normalizeSettings } from "./settings.js";
import { modelKey } from "./model.js";
import { messageText, text, userMessage, assistantMessage } from "./chat.js";

describe("ids", () => {
  it("accepts provider slugs", () => {
    expect(ProviderId.make("anthropic")).toBe("anthropic");
    expect(ProviderId.make("claude-code")).toBe("claude-code");
    expect(ProviderId.is("acp-custom")).toBe(true);
  });

  it("rejects invalid provider ids", () => {
    expect(() => ProviderId.make("has space")).toThrow(/Invalid provider id/);
    expect(() => ProviderId.make("1starts-with-digit")).toThrow();
    expect(ProviderId.is("openai/gpt")).toBe(false);
  });

  it("allows vendor model ids with separators", () => {
    // These come straight from real catalogues and must never be rejected.
    expect(ModelId.make("qwen2.5-coder:7b")).toBe("qwen2.5-coder:7b");
    expect(ModelId.make("openai/gpt-5")).toBe("openai/gpt-5");
    expect(ModelId.make("@cf/meta/llama-3")).toBe("@cf/meta/llama-3");
    expect(ModelId.is("gpt-5.1")).toBe(true);
    expect(ModelId.is("has space")).toBe(false);
  });

  it("makes tool call ids", () => {
    expect(ToolCallId.make("call_1")).toBe("call_1");
  });
});

describe("errors", () => {
  it("maps http statuses to kinds", () => {
    expect(kindFromStatus(401)).toBe("auth");
    expect(kindFromStatus(403)).toBe("auth");
    expect(kindFromStatus(404)).toBe("model_not_found");
    expect(kindFromStatus(408)).toBe("timeout");
    expect(kindFromStatus(413)).toBe("prompt_too_large");
    expect(kindFromStatus(429)).toBe("rate_limit");
    expect(kindFromStatus(400)).toBe("invalid_request");
    expect(kindFromStatus(422)).toBe("invalid_request");
    expect(kindFromStatus(503)).toBe("overloaded");
    expect(kindFromStatus(302)).toBe("unknown");
  });

  it("derives retryability from the kind", () => {
    expect(new ProviderError({ kind: "rate_limit", message: "slow down" }).retryable).toBe(true);
    expect(new ProviderError({ kind: "overloaded", message: "busy" }).retryable).toBe(true);
    expect(new ProviderError({ kind: "auth", message: "nope" }).retryable).toBe(false);
    expect(isRetryableKind("network")).toBe(true);
    expect(isRetryableKind("invalid_request")).toBe(false);
  });

  it("normalizes unknown errors", () => {
    const normalized = toProviderError(new Error("boom"), { provider: "openai" });
    expect(isProviderError(normalized)).toBe(true);
    expect(normalized.kind).toBe("network");
    expect(normalized.provider).toBe("openai");

    const abort = new Error("stopped");
    abort.name = "AbortError";
    expect(toProviderError(abort).kind).toBe("aborted");
  });

  it("returns existing provider errors unchanged", () => {
    const original = new ProviderError({ kind: "auth", message: "no key" });
    expect(toProviderError(original)).toBe(original);
  });
});

describe("settings", () => {
  it("starts with no providers configured", () => {
    expect(defaultSettings().providers).toEqual({});
  });

  it("fills defaults for partial input", () => {
    const settings = normalizeSettings({ providers: { openai: { type: "api-key" } } });
    expect(Object.keys(settings.providers)).toEqual(["openai"]);
    expect(settings.agent.maxIterations).toBe(25);
    expect(settings.agent.enabledTools).toContain("read_file");
  });

  it("survives null input", () => {
    expect(normalizeSettings(null).providers).toEqual({});
  });
});

describe("messages", () => {
  it("flattens text content", () => {
    expect(messageText(userMessage("hello"))).toBe("hello");
    expect(
      messageText(assistantMessage([text("a"), { type: "thinking", text: "hidden" }, text("b")])),
    ).toBe("ab");
  });

  it("keys a model selection", () => {
    expect(modelKey({ provider: ProviderId.make("openai"), model: ModelId.make("gpt-5.1") })).toBe(
      "openai/gpt-5.1",
    );
  });
});
