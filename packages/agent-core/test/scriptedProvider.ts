import {
  ModelId,
  ProviderId,
  type ChatRequest,
  type ChatStreamEvent,
  type ModelInfo,
  type ProviderDescriptor,
} from "@click/contracts";
import type { ChatProvider, ProviderHealth } from "@click/provider-core";

export type TurnScript =
  | ChatStreamEvent[]
  | ((request: ChatRequest) => ChatStreamEvent[] | Promise<ChatStreamEvent[]>);

export interface ScriptedOptions {
  kind?: "api-key" | "acp";
  id?: string;
}

/**
 * A deterministic ChatProvider for tests: each call to `stream` yields the next
 * scripted turn, so agent loops can be exercised without any network access.
 */
export class ScriptedProvider implements ChatProvider {
  readonly id: ProviderId;
  readonly descriptor: ProviderDescriptor;
  readonly requests: ChatRequest[] = [];
  private readonly turns: TurnScript[];
  private index = 0;

  constructor(turns: TurnScript[], options: ScriptedOptions = {}) {
    this.turns = turns;
    this.id = ProviderId.make(options.id ?? "scripted");
    this.descriptor = {
      id: this.id,
      name: "Scripted",
      kind: options.kind ?? "api-key",
      badge: "S",
      accent: "#888888",
      description: "Deterministic test provider",
      requiresApiKey: false,
      supportsCustomBaseUrl: true,
      models: [
        {
          id: ModelId.make("scripted-1"),
          name: "Scripted 1",
          provider: this.id,
          contextWindow: 8192,
          supportsTools: true,
          supportsImages: false,
          supportsThinking: true,
          supportsStreaming: true,
        },
      ] satisfies ModelInfo[],
    };
  }

  get callCount(): number {
    return this.requests.length;
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.descriptor.models;
  }

  async check(): Promise<ProviderHealth> {
    return { ok: true };
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    this.requests.push(request);
    const turn = this.turns[this.index] ?? [];
    this.index += 1;
    const events = typeof turn === "function" ? await turn(request) : turn;
    for (const event of events) yield event;
  }

  async dispose(): Promise<void> {
    // nothing to release
  }
}

export function textTurn(text: string): ChatStreamEvent[] {
  return [
    { type: "start" },
    { type: "text_delta", text },
    { type: "stop", reason: "end_turn" },
  ];
}

export function toolTurn(call: {
  id: string;
  name: string;
  input: unknown;
  text?: string;
}): ChatStreamEvent[] {
  return [
    { type: "start" },
    ...(call.text ? [{ type: "text_delta" as const, text: call.text }] : []),
    {
      type: "tool_call",
      call: { id: call.id as never, name: call.name, input: call.input },
    },
    { type: "stop", reason: "tool_use" },
  ];
}
