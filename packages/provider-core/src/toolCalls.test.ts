import { describe, expect, it } from "vitest";
import { ProviderError } from "@click/contracts";
import { ToolCallAccumulator, parseArgs } from "./toolCalls.js";

describe("parseArgs", () => {
  it("treats empty input as an empty object", () => {
    expect(parseArgs("")).toEqual({});
    expect(parseArgs("   ")).toEqual({});
  });

  it("parses JSON objects", () => {
    expect(parseArgs('{"path":"a.txt"}')).toEqual({ path: "a.txt" });
  });

  it("throws a provider error on malformed JSON", () => {
    expect(() => parseArgs("{oops")).toThrow(ProviderError);
    try {
      parseArgs("{oops");
    } catch (error) {
      expect((error as ProviderError).kind).toBe("invalid_request");
    }
  });
});

describe("ToolCallAccumulator", () => {
  it("joins argument fragments across deltas", () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.push(0, { id: "call_1", name: "write_file" });
    accumulator.push(0, { argumentsFragment: '{"path":"a' });
    accumulator.push(0, { argumentsFragment: '.txt","content":"hi"}' });

    const events = accumulator.drain([0]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "tool_call",
      call: { id: "call_1", name: "write_file", input: { path: "a.txt", content: "hi" } },
    });
  });

  it("emits each call only once", () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.push(0, { id: "call_1", name: "read_file", argumentsFragment: '{"path":"a"}' });
    expect(accumulator.drain([0])).toHaveLength(1);
    expect(accumulator.drain([0])).toHaveLength(0);
    expect(accumulator.flush()).toHaveLength(0);
  });

  it("synthesizes an id when the model omits one", () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.push(2, { name: "list_dir" });
    const [event] = accumulator.flush();
    expect(event?.type === "tool_call" && event.call.id).toBe("call_2");
  });

  it("keeps parallel calls separate by index", () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.push(0, { id: "a", name: "read_file", argumentsFragment: '{"path":"a"}' });
    accumulator.push(1, { id: "b", name: "read_file", argumentsFragment: '{"path":"b"}' });
    const events = accumulator.flush();
    expect(events).toHaveLength(2);
  });
});
