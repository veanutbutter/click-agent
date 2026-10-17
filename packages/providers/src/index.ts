import type { ApiKeyProviderConfig } from "@click/contracts";
import { ProviderId } from "@click/contracts";
import type { ProviderFactory } from "@click/provider-core";
import { makeAnthropicFactory } from "./anthropic.js";
import { makeGoogleFactory } from "./google.js";
import { makeOpenAiCompatibleFactory, type OpenAiCompatibleSpec } from "./openaiCompatible.js";
import {
  DEEPSEEK_SPEC,
  MISTRAL_SPEC,
  OLLAMA_SPEC,
  OPENAI_COMPATIBLE_SPEC,
  OPENAI_SPEC,
  XAI_SPEC,
} from "./specs.js";
import { OPENCODE_GO_SPEC, OPENCODE_SPEC, makeOpenCodeFactory } from "./opencode.js";
import { catalogueFactories } from "./catalogue.js";

/** The generic gateway factory additionally requires a base URL to be usable. */
function makeGatewayFactory(spec: OpenAiCompatibleSpec): ProviderFactory {
  return {
    descriptor: makeOpenAiCompatibleFactory(spec).descriptor,
    create(config, ctx) {
      const typed = (config ?? {}) as ApiKeyProviderConfig;
      const hasBaseUrl =
        typeof typed.baseUrl === "string" &&
        typed.baseUrl.trim().length > 0 &&
        typed.baseUrl !== spec.defaultBaseUrl;
      if (!hasBaseUrl) return null;
      return makeOpenAiCompatibleFactory(spec).create(config, ctx);
    },
  };
}

/** Every provider Click knows about out of the box. */
export function builtInProviderFactories(): ProviderFactory[] {
  return [
    makeAnthropicFactory(),
    makeGoogleFactory(),
    makeOpenAiCompatibleFactory(OPENAI_SPEC),
    makeOpenAiCompatibleFactory(XAI_SPEC),
    makeOpenAiCompatibleFactory(DEEPSEEK_SPEC),
    makeOpenAiCompatibleFactory(MISTRAL_SPEC),
    makeOpenAiCompatibleFactory(OLLAMA_SPEC),
    makeGatewayFactory(OPENAI_COMPATIBLE_SPEC),
    makeOpenCodeFactory(OPENCODE_SPEC),
    makeOpenCodeFactory(OPENCODE_GO_SPEC),
    ...catalogueFactories(),
  ];
}

/** Provider ids that are openai-compatible (used by the settings UI). */
export const OPENAI_COMPATIBLE_IDS: ProviderId[] = [
  ProviderId.make("openai"),
  ProviderId.make("xai"),
  ProviderId.make("deepseek"),
  ProviderId.make("mistral"),
  ProviderId.make("ollama"),
  ProviderId.make("openai-compatible"),
  ProviderId.make("opencode"),
  ProviderId.make("opencode-go"),
];

export * from "./openaiCompatible.js";
export * from "./openaiResponses.js";
export * from "./protocol.js";
export * from "./anthropic.js";
export * from "./google.js";
export * from "./specs.js";
export * from "./opencode.js";
export * from "./catalogue.js";
