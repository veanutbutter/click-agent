import type { ChatMessage, ClickSettings } from "@click/contracts";
import {
  Workspace,
  findMode,
  loadProjectRules,
  runAgent,
  type AgentEvent,
  type AgentRunResult,
  type ApprovalRequest,
  type ProposedFileChange,
} from "@click/agent-core";
import { resolveProvider, providerContext, type ResolveResult } from "./registry.js";
import type { ProviderContext } from "@click/provider-core";

export interface ChatOptions {
  settings: ClickSettings;
  workspaceDir: string;
  /**
   * Allow the agent's *read* tools to reach outside the workspace. Writes stay
   * confined regardless — see `Workspace.allowOutsideReads`.
   */
  allowOutsideReads?: boolean;
  prompt: string;
  /**
   * Images attached to this message. Sent as image content blocks, which every
   * wire protocol maps (see `openaiCompatible`, `openaiResponses`, `anthropic`,
   * `google`).
   */
  images?: ChatAttachment[];
  history?: ChatMessage[];
  providerId?: string;
  model?: string;
  /** Reasoning effort, passed through to whichever protocol the model uses. */
  effort?: string;
  /**
   * Inference mode (`agent` / `plan` / `ask`). Chooses the tool allow-list and
   * the instructions the model runs under — see `AGENT_MODES`.
   */
  mode?: string;
  /**
   * When set, file edits are proposed here instead of written, so the host can
   * show them for review. Returning `false` rejects the change.
   */
  proposeFileChange?: (change: ProposedFileChange) => Promise<boolean>;
  /** Extra system-prompt context. Project rule files are added automatically. */
  systemPrompt?: string;
  onEvent?: (event: AgentEvent) => void;
  approve?: (request: ApprovalRequest) => Promise<boolean>;
  signal?: AbortSignal;
  ctx?: ProviderContext;
}

export interface ChatAttachment {
  /** e.g. `image/png`. */
  mediaType: string;
  /** Base64, without a data-URL prefix. */
  dataBase64: string;
}

export interface ChatOutcome {
  ok: boolean;
  providerId?: string;
  model?: string;
  result?: AgentRunResult;
  error?: string;
  resolve: ResolveResult;
}

/** Run one agent turn end-to-end against the selected provider. */
export async function runChat(options: ChatOptions): Promise<ChatOutcome> {
  const ctx = options.ctx ?? providerContext({ cwd: options.workspaceDir });
  const resolve = resolveProvider({
    settings: options.settings,
    ...(options.providerId ? { providerId: options.providerId } : {}),
    ...(options.model ? { model: options.model } : {}),
    ctx,
  });

  if (!resolve.resolved) {
    return { ok: false, error: resolve.error ?? "No provider available", resolve };
  }

  const { provider, model } = resolve.resolved;
  const workspace = new Workspace(options.workspaceDir);
  // Reads may reach outside the workspace; writes never do. See Workspace.
  workspace.allowOutsideReads = options.allowOutsideReads === true;
  const history: ChatMessage[] = [
    ...(options.history ?? []),
    {
      role: "user",
      content: [
        { type: "text", text: options.prompt },
        ...(options.images ?? []).map((image) => ({
          type: "image" as const,
          mediaType: image.mediaType,
          dataBase64: image.dataBase64,
        })),
      ],
    },
  ];

  // The mode picks the tool allow-list and the instructions; the project's own
  // rule files (AGENTS.md and friends) are appended so the agent stays in the
  // lane the repository defines.
  const mode = findMode(options.mode);
  const rules = await loadProjectRules(options.workspaceDir);
  const systemPrompt = [
    options.systemPrompt,
    mode?.promptAddendum,
    rules ? `The project defines these standing instructions. Follow them.\n\n${rules}` : undefined,
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("\n\n");

  const toolNames = mode?.toolNames ?? options.settings.agent.enabledTools;

  try {
    const result = await runAgent({
      provider,
      model,
      workspace,
      history,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(toolNames ? { toolNames } : {}),
      maxIterations: options.settings.agent.maxIterations,
      autoApprove: options.settings.agent.autoApprove,
      ...(options.effort ? { reasoningEffort: options.effort } : {}),
      ...(options.proposeFileChange ? { proposeFileChange: options.proposeFileChange } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.approve ? { approve: options.approve } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { ok: result.reason !== "error", providerId: provider.id, model, result, resolve };
  } catch (error) {
    return {
      ok: false,
      providerId: provider.id,
      model,
      error: error instanceof Error ? error.message : String(error),
      resolve,
    };
  } finally {
    await provider.dispose().catch(() => undefined);
  }
}
