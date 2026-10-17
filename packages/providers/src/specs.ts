import { ModelId, ProviderId, type ModelInfo } from "@click/contracts";
import type { OpenAiCompatibleSpec } from "./openaiCompatible.js";

function info(
  provider: string,
  id: string,
  name: string,
  contextWindow: number,
  options: { tools?: boolean; images?: boolean; thinking?: boolean } = {},
): ModelInfo {
  return {
    id: ModelId.make(id),
    name,
    provider: ProviderId.make(provider),
    contextWindow,
    maxOutputTokens: 16_384,
    supportsTools: options.tools ?? true,
    supportsImages: options.images ?? false,
    supportsThinking: options.thinking ?? false,
    supportsStreaming: true,
  };
}

export const OPENAI_SPEC: OpenAiCompatibleSpec = {
  id: "openai",
  name: "OpenAI",
  badge: "O",
  accent: "#10a37f",
  description: "GPT models from OpenAI. For a chat-only gateway, use OpenAI-compatible instead.",
  defaultBaseUrl: "https://api.openai.com/v1",
  envVarNames: ["OPENAI_API_KEY"],
  requiresApiKey: true,
  supportsCustomBaseUrl: true,
  // Native OpenAI prefers the Responses API; see protocol.ts.
  defaultProtocol: "responses",
  defaultModels: [
    info("openai", "gpt-5.1", "GPT-5.1", 400_000, { images: true, thinking: true }),
    info("openai", "gpt-5", "GPT-5", 400_000, { images: true, thinking: true }),
    info("openai", "gpt-5-mini", "GPT-5 mini", 400_000, { images: true, thinking: true }),
    info("openai", "gpt-4.1", "GPT-4.1", 1_047_576, { images: true }),
  ],
};

export const XAI_SPEC: OpenAiCompatibleSpec = {
  id: "xai",
  name: "xAI",
  badge: "X",
  accent: "#111111",
  description: "Grok models from xAI.",
  defaultBaseUrl: "https://api.x.ai/v1",
  envVarNames: ["XAI_API_KEY", "GROK_API_KEY"],
  requiresApiKey: true,
  supportsCustomBaseUrl: true,
  defaultModels: [
    info("xai", "grok-4", "Grok 4", 256_000, { images: true, thinking: true }),
    info("xai", "grok-4-fast", "Grok 4 Fast", 2_000_000, { images: true }),
    info("xai", "grok-code-fast-1", "Grok Code Fast 1", 256_000),
  ],
};

export const DEEPSEEK_SPEC: OpenAiCompatibleSpec = {
  id: "deepseek",
  name: "DeepSeek",
  badge: "D",
  accent: "#4d6bfe",
  description: "DeepSeek models, including reasoning variants.",
  defaultBaseUrl: "https://api.deepseek.com/v1",
  envVarNames: ["DEEPSEEK_API_KEY"],
  requiresApiKey: true,
  supportsCustomBaseUrl: true,
  defaultModels: [
    info("deepseek", "deepseek-chat", "DeepSeek V4.1 Chat", 128_000),
    info("deepseek", "deepseek-reasoner", "DeepSeek V4.1 Reasoner", 128_000, { thinking: true }),
  ],
};

export const MISTRAL_SPEC: OpenAiCompatibleSpec = {
  id: "mistral",
  name: "Mistral",
  badge: "M",
  accent: "#fa500f",
  description: "Mistral and Codestral models.",
  defaultBaseUrl: "https://api.mistral.ai/v1",
  envVarNames: ["MISTRAL_API_KEY"],
  requiresApiKey: true,
  supportsCustomBaseUrl: true,
  defaultModels: [
    info("mistral", "mistral-large-latest", "Mistral Large", 131_072),
    info("mistral", "codestral-latest", "Codestral", 256_000),
    info("mistral", "mistral-medium-latest", "Mistral Medium", 131_072),
  ],
};

export const OLLAMA_SPEC: OpenAiCompatibleSpec = {
  id: "ollama",
  name: "Ollama",
  badge: "◒",
  accent: "#8a8a8a",
  description: "Local models served by Ollama.",
  defaultBaseUrl: "http://localhost:11434/v1",
  envVarNames: ["OLLAMA_API_KEY"],
  requiresApiKey: false,
  supportsCustomBaseUrl: true,
  defaultModels: [
    info("ollama", "qwen2.5-coder:7b", "Qwen2.5 Coder 7B", 32_768),
    info("ollama", "llama3.3", "Llama 3.3", 131_072),
  ],
};

export const OPENAI_COMPATIBLE_SPEC: OpenAiCompatibleSpec = {
  id: "openai-compatible",
  name: "OpenAI-compatible",
  badge: "◈",
  accent: "#a855f7",
  description: "Any OpenAI-compatible endpoint: vLLM, LM Studio, OpenRouter, a gateway, or your own server.",
  defaultBaseUrl: "",
  envVarNames: ["OPENAI_COMPATIBLE_API_KEY"],
  requiresApiKey: false,
  supportsCustomBaseUrl: true,
  defaultModels: [],
  modelsPath: "/models",
};
