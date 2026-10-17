import type { ModelId, ProviderId } from "./ids.js";

/**
 * Which wire protocol a model speaks.
 *
 * This is model metadata, chosen from a catalogue/registry (or the provider's
 * own default) — never a user setting and never a UI knob. See
 * `selectProtocol` in `@click/providers` for the single selection site.
 *
 * The four values mirror Zed's `protocol` exactly: `chat`/`responses` are the
 * two OpenAI shapes (`openai_chat`/`openai_responses`), `anthropic` is the
 * Messages API and `google` is the Gemini API.
 */
export type WireProtocol = "chat" | "responses" | "anthropic" | "google";

/** USD per million tokens. */
export interface ModelPricing {
  inputPerMTok?: number;
  outputPerMTok?: number;
}

/** Capabilities and limits of a single model. Plain data, no behaviour. */
export interface ModelInfo {
  id: ModelId;
  name: string;
  provider: ProviderId;
  /** Total context window in tokens. */
  /**
   * How much context the model accepts. Optional on purpose: for an external
   * agent the *agent* owns the model, so we often genuinely do not know, and
   * inventing a number is worse than saying nothing.
   */
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsTools: boolean;
  supportsImages: boolean;
  supportsThinking: boolean;
  supportsStreaming: boolean;
  /**
   * Which wire protocol this model speaks. Chosen from model metadata, never by
   * the user. Absent means "use the provider's default" (`selectProtocol`).
   */
  protocol?: WireProtocol;
  /**
   * Per-model endpoint override from the registry (`provider.api`), used when a
   * model's protocol needs a different host/path from the provider default
   * (e.g. Anthropic-protocol models on an OpenAI-shaped gateway). Metadata only:
   * never a user setting. Absent means "use the provider's base URL".
   */
  baseUrl?: string;
  /**
   * Reasoning-effort levels this model declares, in registry order. Metadata
   * only, never a user setting; the picker offers exactly these and clamps to
   * them (matching Zed). Absent means "unknown" — the caller may fall back to a
   * default list.
   */
  effortLevels?: string[];
  /** Whether the model declares a plain reasoning on/off toggle. */
  supportsReasoningToggle?: boolean;
  /** Soft-avoid these for the provider's "default" pick. */
  deprecated?: boolean;
  pricing?: ModelPricing;
}

/** A fully-qualified choice of provider + model. */
export interface ModelSelection {
  provider: ProviderId;
  model: ModelId;
}

export function modelKey(selection: ModelSelection): string {
  return `${selection.provider}/${selection.model}`;
}
