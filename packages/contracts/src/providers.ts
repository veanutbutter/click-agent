import type { ProviderId } from "./ids.js";
import type { ModelInfo } from "./model.js";

/** How Click reaches a provider. */
export type ProviderKind = "api-key" | "acp";

/** Static description of a provider for the UI and registry. */
export interface ProviderDescriptor {
  id: ProviderId;
  name: string;
  kind: ProviderKind;
  /** Single-glyph badge shown in the UI. */
  badge: string;
  /** Accent colour (hex) for the provider chip. */
  accent: string;
  description: string;
  /** Whether the provider needs an API key entered by the user. */
  requiresApiKey: boolean;
  /** Whether the user may override the base URL (self-hosted / gateway). */
  supportsCustomBaseUrl: boolean;
  /** Models offered when none are configured dynamically. */
  models: ModelInfo[];
}
