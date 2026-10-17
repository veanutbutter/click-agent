import type { ChatRequest, ChatStreamEvent, ProviderDescriptor, ProviderId, ModelInfo } from "@click/contracts";

export interface ProviderHealth {
  ok: boolean;
  detail?: string;
}

/**
 * The single interface every Click provider implements.
 *
 * API-key providers (Anthropic, OpenAI, ...) and ACP providers both satisfy it,
 * so the agent loop and UI never branch on transport.
 */
export interface ChatProvider {
  readonly id: ProviderId;
  readonly descriptor: ProviderDescriptor;
  /** Models currently offered; may hit the network for dynamic providers. */
  listModels(): Promise<ModelInfo[]>;
  /** Cheap credential/reachability check. Never throws. */
  check(): Promise<ProviderHealth>;
  /** Stream a completion. Throws {@link ProviderError} on failure. */
  stream(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
  dispose(): Promise<void>;
}

export interface ProviderContext {
  env: Record<string, string | undefined>;
  fetch: typeof globalThis.fetch;
  /** Working directory the app was started in (used by ACP agents). */
  cwd?: string;
}

/**
 * A provider factory. Registered once per provider id; `create` decides whether
 * the current configuration is sufficient to build a usable provider.
 */
export interface ProviderFactory {
  readonly descriptor: ProviderDescriptor;
  create(config: unknown, ctx: ProviderContext): ChatProvider | null;
}
