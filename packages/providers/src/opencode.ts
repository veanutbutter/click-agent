import { ModelId, ProviderId, type ModelInfo, type WireProtocol } from "@click/contracts";
import { requestJson, type ProviderContext } from "@click/provider-core";
import {
  OpenAiCompatibleProvider,
  buildDescriptor,
  type OpenAiCompatibleSpec,
} from "./openaiCompatible.js";
import { DEFAULT_EFFORT_LEVELS } from "./protocol.js";
import type { ChatProvider, ProviderFactory, ProviderHealth } from "@click/provider-core";
import type { ApiKeyProviderConfig, ChatRequest, ChatStreamEvent } from "@click/contracts";

/**
 * OpenCode ships two OpenAI-compatible inference gateways plus a public model
 * registry. The gateways mostly speak plain OpenAI chat completions, so all the
 * plumbing lives in {@link OpenAiCompatibleProvider}; this module adds the part
 * OpenCode does differently: a model list that comes from a remote registry
 * rather than from the gateway itself.
 *
 * Some registry models are not OpenAI-shaped at all. Their `provider.api` points
 * at an `/anthropic/` or `/google/` path and their `provider.npm` names the
 * native AI SDK package; both are carried onto the model so the provider layer
 * can route the request to the right client (see `openaiCompatible.ts`).
 */

/** OpenCode Zen — the main gateway. */
export const OPENCODE_BASE_URL = "https://opencode.ai/inference/openai/v1";
/** OpenCode Go — a second subscription with its own model set. */
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
/**
 * Native-protocol endpoints for OpenCode's non-OpenAI models. These mirror the
 * registry's per-model `provider.api`; the fallback model lists use them when
 * the registry cannot be reached.
 */
export const OPENCODE_ANTHROPIC_BASE_URL = "https://opencode.ai/inference/anthropic/v1";
export const OPENCODE_GO_ANTHROPIC_BASE_URL = "https://opencode.ai/inference/go/anthropic/v1";
export const OPENCODE_GOOGLE_BASE_URL = "https://opencode.ai/inference/google/v1beta";
export const OPENCODE_GO_GOOGLE_BASE_URL = "https://opencode.ai/inference/go/google/v1beta";
/** The public registry (models.dev format) that describes every OpenCode model. */
export const OPENCODE_CATALOG_URL = "https://models.opencode.ai/api.json";
export const OPENCODE_ENV_VARS = ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"];

/** One `reasoning_options` entry inside the OpenCode registry. */
export interface OpenCodeReasoningOption {
  /** `toggle`, `effort` or `budget_tokens`. */
  type?: string;
  /** The levels an `effort` option allows, in registry order. */
  values?: unknown;
  min?: number;
  max?: number;
}

/** A model entry inside the OpenCode registry. */
export interface OpenCodeCatalogModel {
  id?: string;
  name?: string;
  description?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
  /** Some registry builds carry an explicit wire-protocol hint. */
  protocol?: string;
  /** Per-model reasoning capabilities; `effort` entries carry the levels. */
  reasoning_options?: OpenCodeReasoningOption[];
  /** Per-model routing overrides; `npm` names the AI SDK package. */
  provider?: { npm?: string; api?: string };
}

/** One provider entry inside the OpenCode registry. */
export interface OpenCodeCatalogEntry {
  id?: string;
  name?: string;
  api?: string;
  npm?: string;
  models?: Record<string, OpenCodeCatalogModel>;
}

export type OpenCodeCatalog = Record<string, OpenCodeCatalogEntry>;

/**
 * Map an OpenCode registry hint to a Click wire protocol.
 *
 * The registry does not always carry a literal `protocol`; where it does, it is
 * read first. Otherwise the transport is implied by the AI SDK package: Zed maps
 * `@ai-sdk/openai` to the Responses API, `@ai-sdk/openai-compatible` to chat,
 * `@ai-sdk/anthropic` to the Messages API and `@ai-sdk/google` to the Gemini API
 * (`crates/language_models/src/provider/opencode.rs:1165-1173`). A model's own
 * `provider.npm` wins over the provider entry's `npm`. `undefined` means "not a
 * protocol Click can speak here" — callers fall back to the provider default.
 */
export function protocolFromOpenCodeMetadata(
  entry: OpenCodeCatalogModel,
  entryNpm?: string,
): WireProtocol | undefined {
  return protocolFromToken(entry.protocol ?? entry.provider?.npm ?? entryNpm);
}

function protocolFromToken(token: string | undefined): WireProtocol | undefined {
  switch (token) {
    case "responses":
    case "openai_responses":
    case "openai-responses":
    case "@ai-sdk/openai":
      return "responses";
    case "chat":
    case "openai_chat":
    case "openai-chat":
    case "@ai-sdk/openai-compatible":
      return "chat";
    case "anthropic":
    case "anthropic_messages":
    case "anthropic-messages":
    case "@ai-sdk/anthropic":
      return "anthropic";
    case "google":
    case "google_generative_ai":
    case "google-generative-ai":
    case "@ai-sdk/google":
      return "google";
    default:
      return undefined;
  }
}

/**
 * Read the model's declared reasoning options. `effort` entries give the exact
 * levels the picker may offer; a `toggle` entry means the model has an on/off
 * reasoning switch. Where the registry lists nothing, fall back to
 * {@link DEFAULT_EFFORT_LEVELS} for a model that does reason at all.
 */
function reasoningMetadata(entry: OpenCodeCatalogModel): {
  effortLevels?: string[];
  supportsReasoningToggle?: boolean;
} {
  const options = Array.isArray(entry.reasoning_options) ? entry.reasoning_options : [];
  const supportsReasoningToggle = options.some((option) => option?.type === "toggle");
  const declared = [
    ...new Set(
      options
        .filter((option) => option?.type === "effort")
        .flatMap((option) => (Array.isArray(option.values) ? option.values : []))
        .filter((value): value is string => typeof value === "string"),
    ),
  ];
  const levels =
    declared.length > 0
      ? declared
      : options.length === 0 && entry.reasoning === true
        ? [...DEFAULT_EFFORT_LEVELS]
        : [];
  return {
    ...(levels.length > 0 ? { effortLevels: levels } : {}),
    ...(supportsReasoningToggle ? { supportsReasoningToggle: true } : {}),
  };
}

function modelInfo(
  providerId: string,
  id: string,
  entry: OpenCodeCatalogModel,
  entryNpm?: string,
  entryApi?: string,
): ModelInfo {
  const context = entry.limit?.context ?? 128_000;
  const output = entry.limit?.output;
  const pricing =
    entry.cost && (entry.cost.input !== undefined || entry.cost.output !== undefined)
      ? { inputPerMTok: entry.cost.input, outputPerMTok: entry.cost.output }
      : undefined;
  const protocol = protocolFromOpenCodeMetadata(entry, entryNpm);
  // The registry gives a per-model endpoint; fall back to the provider entry's.
  const modelBaseUrl = entry.provider?.api ?? entryApi;
  const reasoning = reasoningMetadata(entry);
  return {
    id: ModelId.make(id),
    name: entry.name ?? id,
    provider: ProviderId.make(providerId),
    contextWindow: context,
    ...(output !== undefined ? { maxOutputTokens: output } : {}),
    supportsTools: entry.tool_call ?? true,
    supportsImages: entry.attachment ?? false,
    supportsThinking: entry.reasoning ?? false,
    supportsStreaming: true,
    ...(protocol ? { protocol } : {}),
    ...(modelBaseUrl ? { baseUrl: modelBaseUrl } : {}),
    ...reasoning,
    ...(pricing ? { pricing } : {}),
  };
}

/**
 * Reads the OpenCode registry and returns the models for one subscription.
 * Unknown shapes return an empty list rather than throwing, so callers can fall
 * back to their declared models.
 */
export function parseOpenCodeCatalog(
  json: unknown,
  catalogKey: string,
  providerId: string,
): ModelInfo[] {
  if (!json || typeof json !== "object") return [];
  const entry = (json as OpenCodeCatalog)[catalogKey];
  if (!entry || typeof entry !== "object" || !entry.models) return [];
  const models = entry.models;
  if (typeof models !== "object") return [];
  const entryNpm = typeof entry.npm === "string" ? entry.npm : undefined;
  const entryApi = typeof entry.api === "string" ? entry.api : undefined;
  const result: ModelInfo[] = [];
  for (const [key, value] of Object.entries(models)) {
    if (!value || typeof value !== "object") continue;
    result.push(modelInfo(providerId, value.id ?? key, value, entryNpm, entryApi));
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export interface OpenCodeSpec {
  id: string;
  name: string;
  badge: string;
  accent: string;
  description: string;
  /** Provider key inside the OpenCode registry, e.g. `opencode` or `opencode-go`. */
  catalogKey: string;
  defaultBaseUrl: string;
  envVarNames: readonly string[];
  /** Used when the registry cannot be reached. */
  defaultModels: readonly ModelInfo[];
}

/**
 * Wraps the OpenAI-compatible client and layers the remote registry on top: the
 * gateway needs no model list of its own, but the registry tells us context
 * windows and capabilities that a bare `/models` response cannot.
 */
export class OpenCodeProvider implements ChatProvider {
  readonly id: ProviderId;
  readonly descriptor;
  private readonly spec: OpenCodeSpec;
  private readonly ctx: ProviderContext;
  private readonly inner: OpenAiCompatibleProvider;
  private cached: ModelInfo[] | undefined;

  constructor(spec: OpenCodeSpec, config: ApiKeyProviderConfig, ctx: ProviderContext) {
    this.spec = spec;
    this.ctx = ctx;
    this.id = ProviderId.make(spec.id);
    const innerSpec: OpenAiCompatibleSpec = {
      id: spec.id,
      name: spec.name,
      badge: spec.badge,
      accent: spec.accent,
      description: spec.description,
      defaultBaseUrl: spec.defaultBaseUrl,
      envVarNames: [...spec.envVarNames],
      requiresApiKey: true,
      supportsCustomBaseUrl: true,
      defaultModels: [...spec.defaultModels],
    };
    this.inner = new OpenAiCompatibleProvider(innerSpec, config, ctx);
    this.descriptor = {
      ...this.inner.descriptor,
      // The inner descriptor stamps the default protocol on declared models.
      models: [...this.inner.descriptor.models],
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.cached) {
      this.cached = await this.loadModels();
      // Hand the registry's per-model protocol to the client that streams.
      this.inner.setModelCatalog(this.cached);
    }
    return this.cached;
  }

  private async loadModels(): Promise<ModelInfo[]> {
    try {
      const json = await requestJson<unknown>(
        this.ctx,
        OPENCODE_CATALOG_URL,
        {},
        { provider: this.id, action: "list models" },
      );
      const models = parseOpenCodeCatalog(json, this.spec.catalogKey, this.spec.id);
      if (models.length > 0) return models;
    } catch {
      // Offline or the registry changed shape — fall through to declared models.
    }
    return [...this.spec.defaultModels];
  }

  check(): Promise<ProviderHealth> {
    return this.inner.check();
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    // The registry decides chat vs responses per model; load it (once) first.
    await this.listModels();
    yield* this.inner.stream(request);
  }

  async dispose(): Promise<void> {
    await this.inner.dispose();
  }
}

export function makeOpenCodeFactory(spec: OpenCodeSpec): ProviderFactory {
  return {
    descriptor: buildDescriptor(
      {
        id: spec.id,
        name: spec.name,
        badge: spec.badge,
        accent: spec.accent,
        description: spec.description,
        defaultBaseUrl: spec.defaultBaseUrl,
        envVarNames: [...spec.envVarNames],
        requiresApiKey: true,
        supportsCustomBaseUrl: true,
        defaultModels: [...spec.defaultModels],
      },
      {},
    ),
    create(config, ctx) {
      if (!config || typeof config !== "object") return null;
      const typed = config as ApiKeyProviderConfig;
      if (typed.type !== undefined && typed.type !== "api-key") return null;
      return new OpenCodeProvider(spec, typed, ctx);
    },
  };
}

export const OPENCODE_SPEC: OpenCodeSpec = {
  id: "opencode",
  name: "OpenCode Zen",
  badge: "OC",
  accent: "#a78bfa",
  description: "OpenCode's Zen inference gateway, OpenAI-compatible, with a large model registry.",
  catalogKey: "opencode",
  defaultBaseUrl: OPENCODE_BASE_URL,
  envVarNames: OPENCODE_ENV_VARS,
  defaultModels: [
    modelInfo("opencode", "claude-sonnet-4-5", { limit: { context: 200_000, output: 64_000 }, tool_call: true, attachment: true, reasoning: true, protocol: "anthropic", provider: { api: OPENCODE_ANTHROPIC_BASE_URL } }),
    modelInfo("opencode", "claude-opus-4-5", { limit: { context: 200_000, output: 64_000 }, tool_call: true, attachment: true, reasoning: true, protocol: "anthropic", provider: { api: OPENCODE_ANTHROPIC_BASE_URL } }),
    // The registry routes these two through `@ai-sdk/openai`, i.e. the Responses API.
    modelInfo("opencode", "gpt-5.1", { limit: { context: 400_000, output: 128_000 }, tool_call: true, attachment: true, reasoning: true, protocol: "responses" }),
    modelInfo("opencode", "gemini-3-pro", { limit: { context: 1_000_000, output: 65_536 }, tool_call: true, attachment: true, reasoning: true, protocol: "google", provider: { api: OPENCODE_GOOGLE_BASE_URL } }),
    modelInfo("opencode", "grok-4.7", { limit: { context: 256_000, output: 64_000 }, tool_call: true, attachment: true, reasoning: true, protocol: "responses" }),
    modelInfo("opencode", "deepseek-v4.1-flash", { limit: { context: 1_000_000, output: 393_216 }, tool_call: true, attachment: true, reasoning: true }),
    modelInfo("opencode", "qwen3-coder", { limit: { context: 262_144, output: 65_536 }, tool_call: true, attachment: false, reasoning: false }),
    modelInfo("opencode", "kimi-k2.5", { limit: { context: 262_144, output: 65_536 }, tool_call: true, attachment: false, reasoning: true }),
    modelInfo("opencode", "glm-5", { limit: { context: 200_000, output: 65_536 }, tool_call: true, attachment: false, reasoning: true }),
    modelInfo("opencode", "minimax-m3", { limit: { context: 1_000_000, output: 131_072 }, tool_call: true, attachment: true, reasoning: true }),
  ],
};

export const OPENCODE_GO_SPEC: OpenCodeSpec = {
  id: "opencode-go",
  name: "OpenCode Go",
  badge: "GO",
  accent: "#f472b6",
  description: "OpenCode's Go subscription gateway, a narrower OpenAI-compatible model set.",
  catalogKey: "opencode-go",
  defaultBaseUrl: OPENCODE_GO_BASE_URL,
  envVarNames: OPENCODE_ENV_VARS,
  defaultModels: [
    modelInfo("opencode-go", "mimo-v2.6-pro", { limit: { context: 1_048_576, output: 131_072 }, tool_call: true, attachment: true, reasoning: true }),
    modelInfo("opencode-go", "grok-4.7", { limit: { context: 256_000, output: 64_000 }, tool_call: true, attachment: true, reasoning: true, protocol: "responses" }),
    modelInfo("opencode-go", "kimi-k3", { limit: { context: 262_144, output: 65_536 }, tool_call: true, attachment: false, reasoning: true }),
    modelInfo("opencode-go", "deepseek-v4.1-flash", { limit: { context: 1_000_000, output: 393_216 }, tool_call: true, attachment: true, reasoning: true }),
    modelInfo("opencode-go", "gpt-5.6-luna", { limit: { context: 400_000, output: 128_000 }, tool_call: true, attachment: true, reasoning: true, protocol: "responses" }),
    modelInfo("opencode-go", "claude-haiku-5-5", { limit: { context: 200_000, output: 64_000 }, tool_call: true, attachment: true, reasoning: true, protocol: "anthropic", provider: { api: OPENCODE_GO_ANTHROPIC_BASE_URL } }),
    modelInfo("opencode-go", "qwen3.8-max", { limit: { context: 1_000_000, output: 131_072 }, tool_call: true, attachment: true, reasoning: true, protocol: "anthropic", provider: { api: OPENCODE_GO_ANTHROPIC_BASE_URL } }),
  ],
};
