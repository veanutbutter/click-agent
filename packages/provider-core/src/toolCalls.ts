import { ProviderError, type ChatStreamEvent, type ToolCallId } from "@click/contracts";

/** Accumulates streamed tool-call argument fragments into complete calls. */
export class ToolCallAccumulator {
  private readonly partials = new Map<
    number,
    { id: string; name: string; args: string; emitted: boolean }
  >();

  push(index: number, delta: { id?: string; name?: string; argumentsFragment?: string }): void {
    const existing = this.partials.get(index) ?? { id: "", name: "", args: "", emitted: false };
    if (delta.id) existing.id = delta.id;
    if (delta.name) existing.name = delta.name;
    if (delta.argumentsFragment) existing.args += delta.argumentsFragment;
    this.partials.set(index, existing);
  }

  /** Emit tool calls whose arguments have fully arrived. */
  drain(completeIndices: number[]): ChatStreamEvent[] {
    const events: ChatStreamEvent[] = [];
    for (const index of completeIndices) {
      const partial = this.partials.get(index);
      if (!partial || partial.emitted) continue;
      partial.emitted = true;
      events.push({
        type: "tool_call",
        call: {
          id: (partial.id || `call_${index}`) as ToolCallId,
          name: partial.name,
          input: parseArgs(partial.args),
        },
      });
    }
    return events;
  }

  /** Flush remaining buffered calls (end of stream fallback). */
  flush(): ChatStreamEvent[] {
    return this.drain([...this.partials.keys()]);
  }
}

export function parseArgs(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new ProviderError({
      kind: "invalid_request",
      message: `Model produced malformed tool arguments: ${raw.slice(0, 200)}`,
    });
  }
}
