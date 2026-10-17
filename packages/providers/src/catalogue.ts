import { ModelId, ProviderId, type ModelInfo, type ProviderDescriptor } from "@click/contracts";
import type { ChatProvider, ProviderFactory } from "@click/provider-core";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import { OpenAiCompatibleProvider, buildDescriptor } from "./openaiCompatible.js";
import type { ApiKeyProviderConfig, ChatRequest, ChatStreamEvent } from "@click/contracts";
import type { ProviderContext, ProviderHealth } from "@click/provider-core";

/**
 * The provider catalogue.
 *
 * Zed and T3 Code each ship their own provider set, and the two sets overlap
 * only partly. This module is the union of both, expressed declaratively:
 * every entry names a wire protocol and the client that speaks it, so adding a
 * provider is a table row rather than a new class.
 *
 * A handful of entries cannot work without vendor-specific authentication
 * (AWS SigV4 signing, GitHub Copilot's token exchange, subscription logins).
 * They are listed with `protocol: "unavailable"` and a reason rather than
 * quietly omitted, so the UI shows the whole landscape honestly.
 */

export type ProviderProtocol = "openai" | "anthropic" | "google" | "unavailable";

export interface CatalogueEntry {
  id: string;
  name: string;
  badge: string;
  accent: string;
  description: string;
  protocol: ProviderProtocol;
  defaultBaseUrl: string;
  envVarNames: readonly string[];
  requiresApiKey: boolean;
  supportsCustomBaseUrl: boolean;
  modelsPath?: string;
  defaultModels: readonly ModelInfo[];
  /** Which reference implementation this entry comes from. */
  source: "zed" | "t3code" | "both";
  unavailableReason?: string;
}

function m(
  provider: string,
  id: string,
  name: string,
  contextWindow: number,
  options: Partial<Omit<ModelInfo, "id" | "name" | "provider" | "contextWindow">> = {},
): ModelInfo {
  return {
    id: ModelId.make(id),
    name,
    provider: ProviderId.make(provider),
    contextWindow,
    supportsTools: options.supportsTools ?? true,
    supportsImages: options.supportsImages ?? false,
    supportsThinking: options.supportsThinking ?? false,
    supportsStreaming: options.supportsStreaming ?? true,
    ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
    ...(options.pricing !== undefined ? { pricing: options.pricing } : {}),
    ...(options.deprecated !== undefined ? { deprecated: options.deprecated } : {}),
  };
}

/**
 * Providers that speak a protocol Click already implements.
 * Local servers first (no credentials), then hosted gateways.
 */
export const CATALOGUE: readonly CatalogueEntry[] = [
  // ---------------------------------------------------------------- local --
  {
    id: "lmstudio",
    name: "LM Studio",
    badge: "LM",
    accent: "#38bdf8",
    description: "Local LM Studio server. Models come from the running server.",
    protocol: "openai",
    defaultBaseUrl: "http://localhost:1234/v1",
    envVarNames: [],
    requiresApiKey: false,
    supportsCustomBaseUrl: true,
    defaultModels: [],
    source: "zed",
  },
  {
    id: "llama.cpp",
    name: "llama.cpp",
    badge: "LC",
    accent: "#facc15",
    description: "Local llama.cpp server (llama-server). Models come from the running server.",
    protocol: "openai",
    defaultBaseUrl: "http://localhost:8080/v1",
    envVarNames: [],
    requiresApiKey: false,
    supportsCustomBaseUrl: true,
    defaultModels: [],
    source: "zed",
  },

  // --------------------------------------------------------------- hosted --
  {
    id: "openrouter",
    name: "OpenRouter",
    badge: "OR",
    accent: "#6366f1",
    description: "One key for hundreds of models across every major lab.",
    protocol: "openai",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    envVarNames: ["OPENROUTER_API_KEY"],
    requiresApiKey: true,
    supportsCustomBaseUrl: true,
    defaultModels: [
      m("openrouter", "anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5", 200_000, { supportsImages: true, supportsThinking: true }),
      m("openrouter", "openai/gpt-5.1", "GPT-5.1", 400_000, { supportsImages: true, supportsThinking: true }),
      m("openrouter", "google/gemini-3-pro", "Gemini 3 Pro", 1_000_000, { supportsImages: true, supportsThinking: true }),
      m("openrouter", "deepseek/deepseek-chat", "DeepSeek Chat", 128_000),
      m("openrouter", "meta-llama/llama-3.3-70b-instruct", "Llama 3.3 70B", 128_000),
    ],
    source: "zed",
  },
  {
    id: "vercel-ai-gateway",
    name: "Vercel AI Gateway",
    badge: "VG",
    accent: "#e5e7eb",
    description: "Vercel's gateway to many labs behind one key, with usage analytics.",
    protocol: "openai",
    defaultBaseUrl: "https://ai-gateway.vercel.sh/v1",
    envVarNames: ["VERCEL_AI_GATEWAY_API_KEY", "AI_GATEWAY_API_KEY"],
    requiresApiKey: true,
    supportsCustomBaseUrl: true,
    defaultModels: [
      m("vercel-ai-gateway", "anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5", 200_000, { supportsImages: true, supportsThinking: true }),
      m("vercel-ai-gateway", "openai/gpt-5.1", "GPT-5.1", 400_000, { supportsImages: true, supportsThinking: true }),
      m("vercel-ai-gateway", "google/gemini-3-pro", "Gemini 3 Pro", 1_000_000, { supportsImages: true, supportsThinking: true }),
    ],
    source: "zed",
  },
  {
    id: "groq",
    name: "Groq",
    badge: "GQ",
    accent: "#fb7185",
    description: "Very fast inference on open-weight models.",
    protocol: "openai",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    envVarNames: ["GROQ_API_KEY"],
    requiresApiKey: true,
    supportsCustomBaseUrl: true,
    defaultModels: [
      m("groq", "llama-3.3-70b-versatile", "Llama 3.3 70B Versatile", 128_000),
      m("groq", "moonshotai/kimi-k2-instruct", "Kimi K2 Instruct", 200_000),
      m("groq", "qwen/qwen3-32b", "Qwen3 32B", 128_000, { supportsThinking: true }),
    ],
    source: "zed",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    badge: "CB",
    accent: "#f97316",
    description: "Wafer-scale inference with unusually low latency.",
    protocol: "openai",
    defaultBaseUrl: "https://api.cerebras.ai/v1",
    envVarNames: ["CEREBRAS_API_KEY"],
    requiresApiKey: true,
    supportsCustomBaseUrl: true,
    defaultModels: [
      m("cerebras", "llama-3.3-70b", "Llama 3.3 70B", 128_000),
      m("cerebras", "qwen-3-coder-480b", "Qwen3 Coder 480B", 131_072),
    ],
    source: "zed",
  },
  {
    id: "togetherai",
    name: "Together AI",
    badge: "TA",
    accent: "#22d3ee",
    description: "Hosted open-weight models, including large coding models.",
    protocol: "openai",
    defaultBaseUrl: "https://api.together.xyz/v1",
    envVarNames: ["TOGETHER_API_KEY"],
    requiresApiKey: true,
    supportsCustomBaseUrl: true,
    defaultModels: [
      m("togetherai", "Qwen/Qwen3-Coder-480B-A35B-Instruct", "Qwen3 Coder 480B", 262_144),
      m("togetherai", "deepseek-ai/DeepSeek-V3", "DeepSeek V3", 128_000),
      m("togetherai", "meta-llama/Llama-3.3-70B-Instruct-Turbo", "Llama 3.3 70B Turbo", 128_000),
    ],
    source: "zed",
  },
  {
    id: "fireworks-ai",
    name: "Fireworks AI",
    badge: "FW",
    accent: "#a3e635",
    description: "Fast hosted open-weight models.",
    protocol: "openai",
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    envVarNames: ["FIREWORKS_API_KEY"],
    requiresApiKey: true,
    supportsCustomBaseUrl: true,
    defaultModels: [
      m("fireworks-ai", "accounts/fireworks/models/deepseek-v3", "DeepSeek V3", 128_000),
      m("fireworks-ai", "accounts/fireworks/models/qwen3-coder-480b-a35b-instruct", "Qwen3 Coder 480B", 262_144),
    ],
    source: "zed",
  },
  {
    id: "deepinfra",
    name: "DeepInfra",
    badge: "DI",
    accent: "#60a5fa",
    description: "Cheap hosted open-weight inference.",
    protocol: "openai",
    defaultBaseUrl: "https://api.deepinfra.com/v1/openai",
    envVarNames: ["DEEPINFRA_API_KEY"],
    requiresApiKey: true,
    supportsCustomBaseUrl: true,
    defaultModels: [
      m("deepinfra", "deepseek-ai/DeepSeek-V3", "DeepSeek V3", 128_000),
      m("deepinfra", "Qwen/Qwen3-Coder-480B-A35B-Instruct", "Qwen3 Coder 480B", 262_144),
    ],
    source: "zed",
  },
  {
    id: "novita-ai",
    name: "Novita AI",
    badge: "NV",
    accent: "#c084fc",
    description: "Hosted open-weight models with a generous free tier.",
    protocol: "openai",
    defaultBaseUrl: "https://api.novita.ai/v3/openai",
    envVarNames: ["NOVITA_API_KEY"],
    requiresApiKey: true,
    supportsCustomBaseUrl: true,
    defaultModels: [
      m("novita-ai", "deepseek/deepseek-v3", "DeepSeek V3", 128_000),
      m("novita-ai", "qwen/qwen3-coder-480b-a35b-instruct", "Qwen3 Coder 480B", 262_144),
    ],
    source: "zed",
  },
  {
    id: "sambanova",
    name: "SambaNova",
    badge: "SN",
    accent: "#fdba74",
    description: "Fast hosted open-weight models.",
    protocol: "openai",
    defaultBaseUrl: "https://api.sambanova.ai/v1",
    envVarNames: ["SAMBANOVA_API_KEY"],
    requiresApiKey: true,
    supportsCustomBaseUrl: true,
    defaultModels: [
      m("sambanova", "Meta-Llama-3.3-70B-Instruct", "Llama 3.3 70B", 128_000),
      m("sambanova", "DeepSeek-V3-0324", "DeepSeek V3", 128_000),
    ],
    source: "zed",
  },
  {
    id: "ollama-cloud",
    name: "Ollama Cloud",
    badge: "OC",
    accent: "#94a3b8",
    description: "Ollama's hosted models, same API as the local server.",
    protocol: "openai",
    defaultBaseUrl: "https://ollama.com/v1",
    envVarNames: ["OLLAMA_API_KEY"],
    requiresApiKey: true,
    supportsCustomBaseUrl: true,
    defaultModels: [
      m("ollama-cloud", "qwen3-coder:480b", "Qwen3 Coder 480B", 262_144),
      m("ollama-cloud", "deepseek-v3.1:671b", "DeepSeek V3.1 671B", 128_000, { supportsThinking: true }),
    ],
    source: "zed",
  },
  {
    id: "mistral-openai",
    name: "Mistral (OpenAI API)",
    badge: "MS",
    accent: "#fbbf24",
    description: "Mistral's OpenAI-compatible endpoint, for clients that prefer it to the native API.",
    protocol: "openai",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    envVarNames: ["MISTRAL_API_KEY"],
    requiresApiKey: true,
    supportsCustomBaseUrl: true,
    defaultModels: [
      m("mistral-openai", "mistral-large-latest", "Mistral Large", 128_000),
      m("mistral-openai", "codestral-latest", "Codestral", 256_000),
    ],
    source: "zed",
  },

  // ------------------------------------------------------- compatible APIs --
  {
    id: "anthropic-compatible",
    name: "Anthropic-compatible",
    badge: "AC",
    accent: "#d97706",
    description: "Any endpoint speaking the Anthropic Messages API. Supply a base URL.",
    protocol: "anthropic",
    defaultBaseUrl: "",
    envVarNames: ["ANTHROPIC_API_KEY"],
    requiresApiKey: true,
    supportsCustomBaseUrl: true,
    defaultModels: [],
    source: "zed",
  },

  // ------------------------------------------------------------ unavailable --
  {
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    badge: "BR",
    accent: "#ff9900",
    description:
      "Not wired yet: Bedrock needs AWS SigV4 request signing and region resolution. Use openai-compatible with a Bedrock proxy in the meantime.",
    protocol: "unavailable",
    defaultBaseUrl: "",
    envVarNames: ["AWS_ACCESS_KEY_ID"],
    requiresApiKey: false,
    supportsCustomBaseUrl: false,
    defaultModels: [],
    source: "zed",
    unavailableReason: "requires AWS SigV4 signing, not implemented",
  },
  {
    id: "copilot-chat",
    name: "GitHub Copilot",
    badge: "GH",
    accent: "#a1a1aa",
    description:
      "Not wired yet: Copilot needs GitHub OAuth and a short-lived token exchange. Use openai-compatible with a Copilot proxy in the meantime.",
    protocol: "unavailable",
    defaultBaseUrl: "",
    envVarNames: [],
    requiresApiKey: false,
    supportsCustomBaseUrl: false,
    defaultModels: [],
    source: "zed",
    unavailableReason: "requires GitHub Copilot token exchange, not implemented",
  },
  {
    id: "zed-dev",
    name: "Zed Cloud",
    badge: "ZD",
    accent: "#8b5cf6",
    description: "Not applicable: this is Zed's own hosted service and requires a Zed account.",
    protocol: "unavailable",
    defaultBaseUrl: "",
    envVarNames: [],
    requiresApiKey: false,
    supportsCustomBaseUrl: false,
    defaultModels: [],
    source: "zed",
    unavailableReason: "vendor-specific hosted service",
  },
  {
    id: "openai-subscribed",
    name: "OpenAI (subscription)",
    badge: "OS",
    accent: "#10a37f",
    description:
      "Not wired yet: bills against a ChatGPT subscription rather than an API key, which needs a different auth flow.",
    protocol: "unavailable",
    defaultBaseUrl: "",
    envVarNames: [],
    requiresApiKey: false,
    supportsCustomBaseUrl: false,
    defaultModels: [],
    source: "zed",
    unavailableReason: "requires ChatGPT subscription auth, not implemented",
  },
  {
    id: "xai-subscribed",
    name: "xAI (subscription)",
    badge: "XS",
    accent: "#111827",
    description:
      "Not wired yet: bills against an xAI subscription rather than an API key, which needs a different auth flow.",
    protocol: "unavailable",
    defaultBaseUrl: "",
    envVarNames: [],
    requiresApiKey: false,
    supportsCustomBaseUrl: false,
    defaultModels: [],
    source: "zed",
    unavailableReason: "requires xAI subscription auth, not implemented",
  },
];

/**
 * Wraps an inner provider so a catalogue entry can present its own identity
 * while reusing an existing client (Anthropic's and Google's clients are built
 * around their own ids).
 */
class RelabelledProvider implements ChatProvider {
  constructor(
    private readonly inner: ChatProvider,
    readonly id: ProviderId,
    readonly descriptor: ProviderDescriptor,
  ) {}

  listModels(): Promise<ModelInfo[]> {
    return this.inner.listModels();
  }

  check(): Promise<ProviderHealth> {
    return this.inner.check();
  }

  stream(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    return this.inner.stream(request);
  }

  async dispose(): Promise<void> {
    await this.inner.dispose();
  }
}

function descriptorFor(entry: CatalogueEntry, models: readonly ModelInfo[]): ProviderDescriptor {
  return {
    id: ProviderId.make(entry.id),
    name: entry.name,
    kind: "api-key",
    badge: entry.badge,
    accent: entry.accent,
    description: entry.description,
    requiresApiKey: entry.requiresApiKey,
    supportsCustomBaseUrl: entry.supportsCustomBaseUrl,
    models: [...models],
  };
}

function openAiSpec(entry: CatalogueEntry) {
  return {
    id: entry.id,
    name: entry.name,
    badge: entry.badge,
    accent: entry.accent,
    description: entry.description,
    defaultBaseUrl: entry.defaultBaseUrl,
    envVarNames: [...entry.envVarNames],
    requiresApiKey: entry.requiresApiKey,
    supportsCustomBaseUrl: entry.supportsCustomBaseUrl,
    defaultModels: [...entry.defaultModels],
  };
}

/** Builds one factory per usable catalogue entry. */
export function catalogueFactories(): ProviderFactory[] {
  const factories: ProviderFactory[] = [];
  for (const entry of CATALOGUE) {
    if (entry.protocol === "unavailable") continue;

    if (entry.protocol === "openai") {
      const spec = openAiSpec(entry);
      factories.push({
        descriptor: buildDescriptor(spec, {}),
        create(config, ctx) {
          if (!config || typeof config !== "object") return null;
          const typed = config as ApiKeyProviderConfig;
          if (typed.type !== undefined && typed.type !== "api-key") return null;
          const base = typed.baseUrl?.trim();
          if (entry.requiresApiKey) {
            const key = typed.apiKey?.trim() || entry.envVarNames.map((n) => ctx.env[n]).find((v) => v && v.trim());
            if (!key) return null;
          }
          if (!entry.defaultBaseUrl && !base) return null;
          return new OpenAiCompatibleProvider(spec, typed, ctx);
        },
      });
      continue;
    }

    if (entry.protocol === "anthropic") {
      factories.push({
        descriptor: descriptorFor(entry, entry.defaultModels),
        create(config, ctx) {
          if (!config || typeof config !== "object") return null;
          const typed = config as ApiKeyProviderConfig;
          if (typed.type !== undefined && typed.type !== "api-key") return null;
          const base = typed.baseUrl?.trim() || entry.defaultBaseUrl;
          if (!base) return null;
          const key = typed.apiKey?.trim() || entry.envVarNames.map((n) => ctx.env[n]).find((v) => v && v.trim());
          if (entry.requiresApiKey && !key) return null;
          const inner = new AnthropicProvider({ ...typed, baseUrl: base }, ctx);
          return new RelabelledProvider(inner, ProviderId.make(entry.id), descriptorFor(entry, entry.defaultModels));
        },
      });
      continue;
    }

    if (entry.protocol === "google") {
      factories.push({
        descriptor: descriptorFor(entry, entry.defaultModels),
        create(config, ctx) {
          if (!config || typeof config !== "object") return null;
          const typed = config as ApiKeyProviderConfig;
          if (typed.type !== undefined && typed.type !== "api-key") return null;
          const base = typed.baseUrl?.trim() || entry.defaultBaseUrl;
          if (!base) return null;
          const key = typed.apiKey?.trim() || entry.envVarNames.map((n) => ctx.env[n]).find((v) => v && v.trim());
          if (entry.requiresApiKey && !key) return null;
          const inner = new GoogleProvider({ ...typed, baseUrl: base }, ctx);
          return new RelabelledProvider(inner, ProviderId.make(entry.id), descriptorFor(entry, entry.defaultModels));
        },
      });
    }
  }
  return factories;
}

/** Entries we deliberately do not register, with the reason. */
export function unavailableProviders(): { id: string; name: string; reason: string }[] {
  return CATALOGUE.filter((entry) => entry.protocol === "unavailable").map((entry) => ({
    id: entry.id,
    name: entry.name,
    reason: entry.unavailableReason ?? "not implemented",
  }));
}
