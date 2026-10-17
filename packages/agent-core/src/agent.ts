import {
  ProviderError,
  toProviderError,
  type ChatMessage,
  type ChatStreamEvent,
  type MessageContent,
  type TokenUsage,
} from "@click/contracts";
import type { ChatProvider } from "@click/provider-core";
import { buildSystemPrompt } from "./systemPrompt.js";
import { selectTools, type ProposedFileChange, type Tool } from "./tools/index.js";
import type { Workspace } from "./workspace.js";

export interface ApprovalRequest {
  tool: string;
  input: Record<string, unknown>;
  description: string;
}

export type AgentEvent =
  | { type: "iteration_start"; iteration: number }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "notice"; text: string }
  | { type: "tool_start"; id: string; tool: string; input: Record<string, unknown> }
  | { type: "tool_end"; id: string; tool: string; result: string; isError: boolean }
  | { type: "usage"; usage: TokenUsage }
  /** The agent changed a file; `oldString`/`newString` are the exact replaced text. */
  | { type: "edit"; path: string; oldString: string; newString: string }
  | { type: "error"; error: ProviderError }
  | { type: "finished"; reason: "completed" | "max_iterations" | "error"; messages: ChatMessage[] };

export interface AgentOptions {
  provider: ChatProvider;
  model: string;
  workspace: Workspace;
  history?: ChatMessage[];
  systemPrompt?: string;
  toolNames?: string[];
  maxIterations?: number;
  autoApprove?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Reasoning effort for models that expose it. Carried opaquely to the
   * provider, which writes the field each wire protocol actually wants
   * (`reasoning_effort` for chat completions, `reasoning.effort` for
   * responses) — see `protocol.ts`.
   */
  reasoningEffort?: string;
  /**
   * When set, mutating file tools propose their change here instead of writing
   * it, so a host can show it for review first.
   */
  proposeFileChange?: (change: ProposedFileChange) => Promise<boolean>;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  approve?: (request: ApprovalRequest) => Promise<boolean>;
}

export interface AgentRunResult {
  messages: ChatMessage[];
  reason: "completed" | "max_iterations" | "error";
  usage: TokenUsage;
}

/**
 * Runs a multi-turn tool-calling loop until the model stops requesting tools or
 * the iteration cap is reached.
 */
export async function runAgent(options: AgentOptions): Promise<AgentRunResult> {
  // ACP agents run their own tool loop; Click only relays their turn.
  const isAcp = options.provider.descriptor.kind === "acp";
  const tools = isAcp ? [] : selectTools(options.toolNames);
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const maxIterations = isAcp ? 1 : (options.maxIterations ?? 25);
  const emit = options.onEvent ?? (() => undefined);

  const messages: ChatMessage[] = [...(options.history ?? [])];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    emit({ type: "iteration_start", iteration });

    const collected: { text: string; thinking: string; calls: CollectedCall[] } = {
      text: "",
      thinking: "",
      calls: [],
    };

    try {
      for await (const event of options.provider.stream({
        provider: options.provider.id,
        model: options.model,
        system: buildSystemPrompt(options.systemPrompt),
        messages,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxOutputTokens !== undefined
          ? { maxOutputTokens: options.maxOutputTokens }
          : {}),
        ...(options.reasoningEffort
          ? { options: { reasoningEffort: options.reasoningEffort } }
          : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })) {
        handleStreamEvent(event, collected, emit, usage);
      }
    } catch (error) {
      const providerError = toProviderError(error, {
        provider: options.provider.id,
        model: options.model,
      });
      emit({ type: "error", error: providerError });
      emit({ type: "finished", reason: "error", messages });
      return { messages, reason: "error", usage };
    }

    const assistantContent: MessageContent[] = [];
    if (collected.thinking) assistantContent.push({ type: "thinking", text: collected.thinking });
    if (collected.text) assistantContent.push({ type: "text", text: collected.text });
    for (const call of collected.calls) {
      assistantContent.push({ type: "toolCall", id: call.id, name: call.name, input: call.input });
    }
    if (assistantContent.length > 0) {
      messages.push({ role: "assistant", content: assistantContent });
    }

    if (collected.calls.length === 0) {
      emit({ type: "finished", reason: "completed", messages });
      return { messages, reason: "completed", usage };
    }

    for (const call of collected.calls) {
      const tool = toolsByName.get(call.name);
      emit({ type: "tool_start", id: call.id, tool: call.name, input: call.input });

      const result = await executeTool(tool, call, options);
      emit({
        type: "tool_end",
        id: call.id,
        tool: call.name,
        result: result.content,
        isError: result.isError === true,
      });
      messages.push({
        role: "tool",
        content: [
          {
            type: "toolResult",
            toolCallId: call.id,
            content: result.content,
            ...(result.isError ? { isError: true } : {}),
          },
        ],
      });
    }
  }

  emit({ type: "finished", reason: "max_iterations", messages });
  return { messages, reason: "max_iterations", usage };
}

interface CollectedCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function handleStreamEvent(
  event: ChatStreamEvent,
  collected: { text: string; thinking: string; calls: CollectedCall[] },
  emit: (event: AgentEvent) => void,
  usage: TokenUsage,
): void {
  switch (event.type) {
    case "text_delta":
      collected.text += event.text;
      emit({ type: "text", text: event.text });
      break;
    case "thinking_delta":
      collected.thinking += event.text;
      emit({ type: "thinking", text: event.text });
      break;
    case "notice":
      emit({ type: "notice", text: event.text });
      break;
    case "edit":
      emit({ type: "edit", path: event.path, oldString: event.oldString, newString: event.newString });
      break;
    case "tool_call":
      collected.calls.push({
        id: event.call.id as string,
        name: event.call.name,
        input: normalizeInput(event.call.input),
      });
      break;
    case "usage":
      usage.inputTokens += event.usage.inputTokens;
      usage.outputTokens += event.usage.outputTokens;
      usage.cachedInputTokens =
        (usage.cachedInputTokens ?? 0) + (event.usage.cachedInputTokens ?? 0);
      emit({ type: "usage", usage });
      break;
    default:
      break;
  }
}

async function executeTool(
  tool: Tool | undefined,
  call: CollectedCall,
  options: AgentOptions,
): Promise<{ content: string; isError?: boolean }> {
  if (!tool) {
    return { content: `Unknown tool: ${call.name}`, isError: true };
  }
  if (tool.mutating && !options.autoApprove && options.approve) {
    const approved = await options.approve({
      tool: tool.name,
      input: call.input,
      description: describeCall(tool.name, call.input),
    });
    if (!approved) {
      return { content: "The user declined this action.", isError: true };
    }
  }
  try {
    const result = await tool.run(call.input, {
      workspace: options.workspace,
      ...(options.proposeFileChange ? { proposeFileChange: options.proposeFileChange } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { content: result.content, ...(result.isError ? { isError: true } : {}) };
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }
}

function normalizeInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

function describeCall(name: string, input: Record<string, unknown>): string {
  const target = input.path ?? input.command ?? input.query ?? "";
  return `${name}${target ? ` → ${String(target)}` : ""}`;
}
