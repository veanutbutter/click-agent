import { describe, expect, it } from "vitest";
import { parseEvent, parseSse, parseSseJson } from "./stream.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

describe("parseEvent", () => {
  it("reads data, event, id and retry fields", () => {
    const event = parseEvent("event: delta\nid: 7\nretry: 1500\ndata: {\"a\":1}");
    expect(event).toEqual({ event: "delta", data: '{"a":1}', id: "7", retry: 1500 });
  });

  it("joins multi-line data with newlines", () => {
    expect(parseEvent("data: one\ndata: two")?.data).toBe("one\ntwo");
  });

  it("ignores comments and empty frames", () => {
    expect(parseEvent(": keep-alive")).toBeNull();
    expect(parseEvent("")).toBeNull();
  });
});

describe("parseSse", () => {
  it("splits frames even when chunk boundaries fall mid-frame", async () => {
    const events = await collect(
      parseSse(streamOf(["data: fir", "st\n\ndata: sec", "ond\n\n"])),
    );
    expect(events.map((event) => event.data)).toEqual(["first", "second"]);
  });

  it("flushes a trailing frame with no terminating blank line", async () => {
    const events = await collect(parseSse(streamOf(["data: tail"])));
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("tail");
  });
});

describe("parseSseJson", () => {
  it("yields parsed JSON and skips [DONE] plus junk", async () => {
    const payloads = await collect(
      parseSseJson(streamOf(['data: {"a":1}\n\n', "data: not-json\n\n", "data: [DONE]\n\n", 'data: {"a":2}\n\n'])),
    );
    expect(payloads).toEqual([{ a: 1 }, { a: 2 }]);
  });
});
