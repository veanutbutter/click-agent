import type { ModelSelection } from "./model.js";

export interface ApiKeyProviderConfig {
  type: "api-key";
  /** May be omitted when supplied through an environment variable. */
  apiKey?: string;
  /** Override the API base URL (gateways, self-hosted, proxies). */
  baseUrl?: string;
  /** Extra HTTP headers merged into every request. */
  headers?: Record<string, string>;
  /** User-declared models, used by openai-compatible providers. */
  models?: Array<{
    id: string;
    name?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    supportsTools?: boolean;
    supportsImages?: boolean;
    supportsThinking?: boolean;
  }>;
  /** Models the user has disabled in the picker. */
  disabledModels?: string[];
}

export interface AcpProviderConfig {
  type: "acp";
  /** Executable to launch (absolute path or PATH-resolved name). */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export type ProviderConfig = ApiKeyProviderConfig | AcpProviderConfig;

export interface AgentConfig {
  /** Hard cap on agent/tool loop iterations per turn. */
  maxIterations: number;
  /** Skip the approval prompt for file edits and shell commands. */
  autoApprove: boolean;
  /** Tools the agent may use. */
  enabledTools: string[];
}

export interface ClickSettings {
  providers: Record<string, ProviderConfig>;
  defaultModel?: ModelSelection;
  agent: AgentConfig;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  maxIterations: 25,
  autoApprove: false,
  enabledTools: ["read_file", "write_file", "list_dir", "run_command"],
};

export function defaultSettings(): ClickSettings {
  return {
    providers: {},
    agent: { ...DEFAULT_AGENT_CONFIG, enabledTools: [...DEFAULT_AGENT_CONFIG.enabledTools] },
  };
}

/** Merge persisted settings over defaults so new fields appear automatically. */
export function normalizeSettings(input: Partial<ClickSettings> | null | undefined): ClickSettings {
  const base = defaultSettings();
  if (!input) return base;
  return {
    providers: input.providers ?? {},
    defaultModel: input.defaultModel,
    agent: {
      maxIterations: input.agent?.maxIterations ?? base.agent.maxIterations,
      autoApprove: input.agent?.autoApprove ?? base.agent.autoApprove,
      enabledTools: input.agent?.enabledTools ?? base.agent.enabledTools,
    },
  };
}
