/** Server-Sent Events parser. Yields one event per blank-line-delimited frame. */

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

const SEPARATOR = /\r?\n\r?\n/;

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let match = SEPARATOR.exec(buffer);
      while (match) {
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const parsed = parseEvent(raw);
        if (parsed) yield parsed;
        match = SEPARATOR.exec(buffer);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const parsed = parseEvent(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

export function parseEvent(raw: string): SseEvent | null {
  const lines = raw.split(/\r?\n/);
  const data: string[] = [];
  let event = "message";
  let id: string | undefined;
  let retry: number | undefined;
  let sawField = false;

  for (const line of lines) {
    if (line.length === 0 || line.startsWith(":")) continue;
    sawField = true;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        data.push(value);
        break;
      case "id":
        id = value;
        break;
      case "retry": {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) retry = parsed;
        break;
      }
      default:
        break;
    }
  }

  if (!sawField || (data.length === 0 && event === "message")) return null;
  const result: SseEvent = { event, data: data.join("\n") };
  if (id !== undefined) result.id = id;
  if (retry !== undefined) result.retry = retry;
  return result;
}

/** Parse a `data:`-only SSE stream into JSON objects, skipping `[DONE]`. */
export async function* parseSseJson<T = unknown>(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<T> {
  for await (const event of parseSse(body)) {
    if (!event.data || event.data === "[DONE]") continue;
    try {
      yield JSON.parse(event.data) as T;
    } catch {
      // Ignore keep-alive / non-JSON frames.
    }
  }
}
