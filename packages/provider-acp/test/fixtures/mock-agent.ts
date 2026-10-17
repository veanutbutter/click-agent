/**
 * A minimal but protocol-faithful ACP agent used by Click's tests and by
 * `click probe`. It speaks newline-delimited JSON-RPC 2.0 over stdio.
 *
 * Behaviour, keyed off the prompt text:
 *   - always: streams a thought chunk, then an echo of the prompt
 *   - "TOOL":     emits a tool_call update
 *   - "READ <p>": requests fs/read_text_file for <p> and reports the length
 *   - "PERM <p>": requests session/request_permission and reports the decision
 *   - "NOSTOP":   never returns (used to test cancellation)
 *
 * Run: tsx packages/provider-acp/test/fixtures/mock-agent.ts
 */
import readline from "node:readline";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const pending = new Map<number, Pending>();
let nextRequestId = 1000;
let sessionCounter = 0;

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id: number | string, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function notify(method: string, params: unknown): void {
  send({ jsonrpc: "2.0", method, params });
}

function request(method: string, params: unknown): Promise<unknown> {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function update(sessionId: string, body: Record<string, unknown>): void {
  notify("session/update", { sessionId, update: body });
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }

  // Response to one of our outgoing requests.
  if (message.method === undefined && message.id !== undefined) {
    const entry = pending.get(message.id as number);
    if (entry) {
      pending.delete(message.id as number);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    }
    return;
  }

  void handleRequest(message);
});

async function handleRequest(message: Record<string, unknown>): Promise<void> {
  const id = message.id as number | string;
  const method = message.method as string;
  const params = (message.params ?? {}) as Record<string, unknown>;

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        authMethods: [],
        agentInfo: { name: "mock-agent", title: "Mock ACP Agent", version: "0.1.0" },
      });
      return;

    case "authenticate":
      respond(id, {});
      return;

    case "session/new":
      sessionCounter += 1;
      respond(id, { sessionId: `mock-session-${sessionCounter}` });
      return;

    case "session/cancel":
      respond(id, {});
      return;

    case "session/prompt": {
      const sessionId = String(params.sessionId ?? "mock-session-0");
      const prompt = Array.isArray(params.prompt) ? params.prompt : [];
      const promptText = prompt
        .map((part) => (part && typeof part === "object" ? String((part as { text?: string }).text ?? "") : ""))
        .join("");

      update(sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Considering the request…" },
      });

      if (promptText.includes("TOOL")) {
        update(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "Read file",
          kind: "read",
          status: "pending",
        });
        update(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
        });
      }

      if (promptText.includes("NOSTOP")) {
        // Deliberately never respond, to exercise cancellation.
        return;
      }

      let extra = "";
      if (promptText.startsWith("READ ")) {
        const target = promptText.slice(5).trim();
        try {
          const result = (await request("fs/read_text_file", { sessionId, path: target })) as {
            content?: string;
          };
          extra = ` [read ${result?.content?.length ?? 0} chars]`;
        } catch (error) {
          extra = ` [read failed: ${error instanceof Error ? error.message : String(error)}]`;
        }
      }

      if (promptText.startsWith("PERM ")) {
        try {
          const result = (await request("session/request_permission", {
            sessionId,
            toolCall: { toolCallId: "call-perm", title: "Edit file" },
            options: [
              { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "reject-once", name: "Reject", kind: "reject_once" },
            ],
          })) as { outcome?: { optionId?: string } };
          extra = ` [permission ${result?.outcome?.optionId ?? "unknown"}]`;
        } catch (error) {
          extra = ` [permission failed: ${error instanceof Error ? error.message : String(error)}]`;
        }
      }

      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `Echo: ${promptText}${extra}` },
      });
      respond(id, { stopReason: "end_turn" });
      return;
    }

    default:
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
  }
}
