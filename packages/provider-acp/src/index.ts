export {
  AcpClient,
  ACP_PROTOCOL_VERSION,
  CLIENT_NAME,
  CLIENT_VERSION,
  type AcpClientHandlers,
  type AcpPermissionRequest,
  type AcpSessionUpdate,
  type AcpSpawnOptions,
  type AcpStopReason,
  type AcpToolCall,
  type PermissionDecision,
} from "./acpClient.js";
export { AcpProvider, makeAcpFactory } from "./acpProvider.js";
export { JsonRpcConnection, JsonRpcError, type JsonRpcResponse } from "./jsonrpc.js";
export {
  loadMcpServers,
  mcpConfigPaths,
  parseMcpConfig,
  toAcpServer,
  type AcpMcpServer,
} from "./mcpConfig.js";

import { makeAcpFactory } from "./acpProvider.js";
import type { ProviderFactory } from "@click/provider-core";

/**
 * Well-known ACP agents. Each entry's `command`/`args` are defaults the user can
 * override; nothing is installed or run until the user configures it.
 */
export interface AcpAgentPreset {
  id: string;
  name: string;
  command: string;
  args: string[];
  hint: string;
}

export const ACP_AGENT_PRESETS: AcpAgentPreset[] = [
  {
    // Distinct from the `opencode` API-key provider: this one is OpenCode's own
    // *agent*, reached over ACP, so it brings its tool loop and MCP servers.
    id: "opencode-acp",
    name: "OpenCode (agent)",
    command: "opencode",
    args: ["acp"],
    hint: "OpenCode's own agent over ACP. Brings its models, its tools and its MCP servers.",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    command: "npx",
    args: ["-y", "@zed-industries/claude-code-acp"],
    hint: "Anthropic's Claude Code agent, bridged to ACP.",
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    command: "npx",
    args: ["-y", "@google/gemini-cli", "--experimental-acp"],
    hint: "Google's Gemini CLI in ACP mode.",
  },
  {
    id: "codex-acp",
    name: "Codex",
    command: "npx",
    args: ["-y", "@zed-industries/codex-acp"],
    hint: "OpenAI Codex bridged to ACP.",
  },
  {
    id: "acp-custom",
    name: "Custom ACP agent",
    command: "",
    args: [],
    hint: "Any executable that speaks ACP over stdio.",
  },
];

/** Build ACP provider factories for every preset. */
export function acpProviderFactories(): ProviderFactory[] {
  return ACP_AGENT_PRESETS.map((preset) =>
    makeAcpFactory({ id: preset.id, name: preset.name }),
  );
}
