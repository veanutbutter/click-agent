import type { ModelInfo, WireProtocol } from "@click/contracts";

/**
 * The single protocol-selection site.
 *
 * Zed decides the wire protocol per model, from capability data, with no global
 * switch: the native OpenAI provider uses the Responses API
 * (`crates/open_ai/src/open_ai.rs:387`, `uses_responses_api`) while the
 * OpenAI-compatible provider defaults to chat completions and only switches on
 * an explicit `capabilities.chat_completions == false`
 * (`crates/language_models/src/provider/open_ai_compatible.rs:301`). OpenCode
 * carries the same idea as a per-model `protocol`
 * (`crates/language_models/src/provider/opencode.rs:404-423`).
 *
 * Click keeps exactly one function for this so "why did this request use
 * `/responses`?" has a single answer. The protocol is always model metadata;
 * there is deliberately no setting and no UI for it.
 */

/**
 * Providers whose own models speak OpenAI's Responses API by default.
 *
 * Only native OpenAI: it is the one provider Click ships whose first-party
 * endpoint prefers `/responses` (`OPENAI_SPEC` in `specs.ts`). Every other
 * OpenAI-compatible provider — xAI, DeepSeek, Mistral, Ollama, OpenCode, the
 * generic `openai-compatible` gateway and the whole `CATALOGUE` — defaults to
 * chat completions, matching Zed's OpenAI-compatible default.
 */
const RESPONSES_BY_DEFAULT: ReadonlySet<string> = new Set(["openai"]);

/** The default protocol for a provider when a model carries no metadata. */
export function defaultProtocolFor(providerId: string): WireProtocol {
  return RESPONSES_BY_DEFAULT.has(providerId) ? "responses" : "chat";
}

/**
 * Effort levels offered when a model declares reasoning but the registry lists
 * no explicit `reasoning_options`. This is Zed's list, in order, matching the
 * catalogue generator (`cursor-patch/gen-model-catalog.mjs`), so the picker and
 * the wire agree.
 */
export const DEFAULT_EFFORT_LEVELS: readonly string[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Choose the wire protocol for one model: its own metadata first, then an
 * explicit provider default, then the id-based default. This is the whole
 * decision.
 */
export function selectProtocol(
  model: Pick<ModelInfo, "protocol"> | undefined,
  providerId: string,
  providerDefault?: WireProtocol,
): WireProtocol {
  return model?.protocol ?? providerDefault ?? defaultProtocolFor(providerId);
}

/**
 * Write the reasoning-effort control in the shape the wire protocol expects.
 *
 * Chat completions take a top-level `reasoning_effort` string
 * (`crates/open_ai/src/completion.rs:258`); the Responses API takes a nested
 * `reasoning: { effort }` object (`crates/open_ai/src/completion.rs:359-380`).
 * The native `anthropic`/`google` clients own their own thinking configuration
 * (budget tokens / thinking config) and never call this, so their bodies are
 * left untouched rather than being given an OpenAI field they would reject.
 * A blank or absent effort leaves the body untouched.
 */
export function applyReasoningEffort(
  body: Record<string, unknown>,
  protocol: WireProtocol,
  effort: unknown,
): void {
  if (typeof effort !== "string" || effort.trim().length === 0) return;
  switch (protocol) {
    case "responses":
      body.reasoning = { effort };
      return;
    case "chat":
      body.reasoning_effort = effort;
      return;
    default:
      // anthropic | google: no OpenAI effort field.
      return;
  }
}
