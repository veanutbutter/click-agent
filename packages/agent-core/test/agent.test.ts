import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderError, type ChatMessage } from "@click/contracts";
import { runAgent, type AgentEvent } from "../src/agent.js";
import { Workspace } from "../src/workspace.js";
import { ScriptedProvider, textTurn, toolTurn } from "./scriptedProvider.js";

let root: string;
let workspace: Workspace;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "click-agent-"));
  workspace = new Workspace(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function assistantText(messages: ChatMessage[]): string {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content)
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

describe("runAgent", () => {
  it("executes a tool call and finishes with the model's text", async () => {
    const provider = new ScriptedProvider([
      toolTurn({ id: "c1", name: "write_file", input: { path: "hello.txt", content: "hi" } }),
      textTurn("All done."),
    ]);
    const events: AgentEvent[] = [];

    const result = await runAgent({
      provider,
      model: "scripted-1",
      workspace,
      autoApprove: true,
      onEvent: (event) => events.push(event),
    });

    expect(result.reason).toBe("completed");
    expect(await readFile(path.join(root, "hello.txt"), "utf8")).toBe("hi");
    expect(provider.callCount).toBe(2);
    expect(assistantText(result.messages)).toBe("All done.");
    expect(events.filter((event) => event.type === "tool_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_end")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("finished");
  });

  it("feeds tool output back to the provider", async () => {
    const provider = new ScriptedProvider([
      toolTurn({ id: "c1", name: "write_file", input: { path: "a.txt", content: "abc" } }),
      (request) => {
        const last = request.messages.at(-1);
        const part = last?.content[0];
        expect(last?.role).toBe("tool");
        expect(part && part.type === "toolResult" ? part.content : "").toMatch(/wrote|a\.txt|bytes/i);
        return textTurn("ok");
      },
    ]);

    await runAgent({ provider, model: "scripted-1", workspace, autoApprove: true });
    expect(provider.callCount).toBe(2);
  });

  it("sends tool definitions on the first turn only", async () => {
    const provider = new ScriptedProvider([textTurn("hi")]);
    await runAgent({ provider, model: "scripted-1", workspace, toolNames: ["read_file"] });
    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).toEqual(["read_file"]);
  });

  it("asks for approval before mutating tools and honours a denial", async () => {
    const provider = new ScriptedProvider([
      toolTurn({ id: "c1", name: "write_file", input: { path: "denied.txt", content: "x" } }),
      textTurn("stopped"),
    ]);
    const asked: string[] = [];

    const result = await runAgent({
      provider,
      model: "scripted-1",
      workspace,
      approve: async (request) => {
        asked.push(request.tool);
        return false;
      },
    });

    expect(asked).toEqual(["write_file"]);
    const toolMessage = result.messages.find((message) => message.role === "tool");
    const part = toolMessage?.content[0];
    expect(part && part.type === "toolResult" ? part.isError : false).toBe(true);
    await expect(readFile(path.join(root, "denied.txt"), "utf8")).rejects.toThrow();
  });

  it("does not ask for approval on read-only tools", async () => {
    const provider = new ScriptedProvider([
      toolTurn({ id: "c1", name: "list_dir", input: { path: "." } }),
      textTurn("done"),
    ]);
    let asked = 0;
    await runAgent({
      provider,
      model: "scripted-1",
      workspace,
      approve: async () => {
        asked += 1;
        return true;
      },
    });
    expect(asked).toBe(0);
  });

  it("stops at maxIterations", async () => {
    const provider = new ScriptedProvider([
      toolTurn({ id: "c1", name: "list_dir", input: { path: "." } }),
      toolTurn({ id: "c2", name: "list_dir", input: { path: "." } }),
      toolTurn({ id: "c3", name: "list_dir", input: { path: "." } }),
    ]);
    const result = await runAgent({
      provider,
      model: "scripted-1",
      workspace,
      maxIterations: 2,
    });
    expect(result.reason).toBe("max_iterations");
    expect(provider.callCount).toBe(2);
  });

  it("reports provider failures", async () => {
    const provider = new ScriptedProvider([
      () => {
        throw new ProviderError({ kind: "rate_limit", message: "slow down" });
      },
    ]);
    const events: AgentEvent[] = [];
    const result = await runAgent({
      provider,
      model: "scripted-1",
      workspace,
      onEvent: (event) => events.push(event),
    });

    expect(result.reason).toBe("error");
    const error = events.find((event) => event.type === "error");
    expect(error?.type === "error" && error.error.kind).toBe("rate_limit");
  });

  it("reports unknown tools instead of crashing", async () => {
    const provider = new ScriptedProvider([
      toolTurn({ id: "c1", name: "does_not_exist", input: {} }),
      textTurn("ok"),
    ]);
    const result = await runAgent({ provider, model: "scripted-1", workspace, autoApprove: true });
    const toolMessage = result.messages.find((message) => message.role === "tool");
    const part = toolMessage?.content[0];
    expect(part && part.type === "toolResult" ? part.content : "").toMatch(/Unknown tool/);
  });

  it("lets ACP agents run their own loop", async () => {
    const provider = new ScriptedProvider([textTurn("agent says hi")], { kind: "acp" });
    const result = await runAgent({ provider, model: "default", workspace, maxIterations: 5 });

    expect(result.reason).toBe("completed");
    expect(provider.callCount).toBe(1);
    // No tool definitions are offered: the ACP agent owns its tool loop.
    expect(provider.requests[0]?.tools).toEqual([]);
  });

  it("injects the Click system prompt", async () => {
    const provider = new ScriptedProvider([textTurn("hi")]);
    await runAgent({ provider, model: "scripted-1", workspace });
    expect(provider.requests[0]?.system).toMatch(/Click/);
  });
});
