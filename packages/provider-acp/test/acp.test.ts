import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userMessage, type ChatStreamEvent } from "@click/contracts";
import type { ProviderContext } from "@click/provider-core";
import { AcpClient, makeAcpFactory } from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/mock-agent.ts", import.meta.url));
// Resolve the TS loader to an absolute URL so the child can load it regardless of
// the working directory it inherits.
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

// The spawned agent deliberately keeps the parent's cwd so the temporary workspace
// is never locked as a child's working directory (Windows refuses to remove those).
const spawnOptions = { command: process.execPath, args: ["--import", TSX_LOADER, FIXTURE] };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "click-acp-"));
  await writeFile(path.join(dir, "inside.txt"), "abc", "utf8");
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Windows can hold the directory briefly after the child exits; leakage in a
    // temp folder is harmless.
  }
});

describe("AcpClient", () => {
  it(
    "initializes the agent and opens a session",
    async () => {
      const client = await AcpClient.connect(spawnOptions);
      try {
        expect(client.agentInfo?.name).toBe("mock-agent");
        expect(client.initializeResponse?.protocolVersion).toBe(1);
        const sessionId = await client.newSession(dir);
        expect(sessionId).toMatch(/^mock-session-/);
      } finally {
        client.kill();
      }
    },
    30_000,
  );

  it(
    "streams agent updates for a prompt",
    async () => {
      const client = await AcpClient.connect(spawnOptions);
      try {
        const sessionId = await client.newSession(dir);
        const updates: unknown[] = [];
        const stopReason = await client.prompt(sessionId, "hello world", {
          onUpdate: (update) => updates.push(update),
        });

        expect(stopReason).toBe("end_turn");
        expect(JSON.stringify(updates)).toContain("Echo: hello world");
        expect(JSON.stringify(updates)).toContain("agent_thought_chunk");
      } finally {
        client.kill();
      }
    },
    30_000,
  );

  it(
    "surfaces agent tool calls",
    async () => {
      const client = await AcpClient.connect(spawnOptions);
      try {
        const sessionId = await client.newSession(dir);
        const updates: unknown[] = [];
        await client.prompt(sessionId, "please TOOL now", {
          onUpdate: (update) => updates.push(update),
        });
        const serialized = JSON.stringify(updates);
        expect(serialized).toContain("tool_call");
        expect(serialized).toContain("call-1");
      } finally {
        client.kill();
      }
    },
    30_000,
  );

  it(
    "serves fs/read_text_file requests from the agent",
    async () => {
      const client = await AcpClient.connect(spawnOptions, {
        readTextFile: (target) => readFile(target, "utf8"),
      });
      try {
        const sessionId = await client.newSession(dir);
        const updates: unknown[] = [];
        await client.prompt(sessionId, `READ ${path.join(dir, "inside.txt")}`, {
          onUpdate: (update) => updates.push(update),
        });
        expect(JSON.stringify(updates)).toContain("[read 3 chars]");
      } finally {
        client.kill();
      }
    },
    30_000,
  );

  it(
    "answers permission requests",
    async () => {
      const client = await AcpClient.connect(spawnOptions);
      try {
        const sessionId = await client.newSession(dir);
        const updates: unknown[] = [];
        await client.prompt(sessionId, "PERM edit", {
          onUpdate: (update) => updates.push(update),
        });
        const serialized = JSON.stringify(updates);
        expect(serialized).toContain("[permission ");
        expect(serialized).not.toContain("permission failed");
      } finally {
        client.kill();
      }
    },
    30_000,
  );
});

describe("AcpProvider", () => {
  function provider(workspace = dir) {
    const factory = makeAcpFactory({ id: "mock-acp", name: "Mock ACP" });
    const ctx: ProviderContext = { env: {}, fetch: globalThis.fetch, cwd: workspace };
    return factory.create({ type: "acp", ...spawnOptions }, ctx);
  }

  async function promptFor(instance: NonNullable<ReturnType<typeof provider>>, text: string) {
    const events: ChatStreamEvent[] = [];
    for await (const event of instance.stream({
      provider: "mock-acp",
      model: "default",
      messages: [userMessage(text)],
    })) {
      events.push(event);
    }
    return events;
  }

  it(
    "drives the agent end to end through the ChatProvider interface",
    async () => {
      const instance = provider();
      expect(instance).not.toBeNull();
      const events = await promptFor(instance!, "integration");

      const text = events
        .filter((event): event is { type: "text_delta"; text: string } => event.type === "text_delta")
        .map((event) => event.text)
        .join("");
      expect(text).toContain("Echo: integration");
      expect(events.at(-1)?.type).toBe("stop");
      await instance!.dispose();
    },
    30_000,
  );

  it(
    "confines agent file reads to the workspace",
    async () => {
      const instance = provider();
      try {
        const ok = await promptFor(instance!, `READ ${path.join(dir, "inside.txt")}`);
        expect(JSON.stringify(ok)).toContain("[read 3 chars]");

        const escaped = await promptFor(instance!, `READ ${path.join(dir, "..", "outside.txt")}`);
        expect(JSON.stringify(escaped)).toContain("read failed");
      } finally {
        await instance?.dispose();
      }
    },
    30_000,
  );

  it(
    "translates agent tool activity into notices",
    async () => {
      const instance = provider();
      try {
        const events = await promptFor(instance!, "TOOL please");
        const notices = events.filter(
          (event): event is { type: "notice"; text: string } => event.type === "notice",
        );
        expect(notices.length).toBeGreaterThan(0);
      } finally {
        await instance?.dispose();
      }
    },
    30_000,
  );

  it("refuses to build an ACP provider without a command", () => {
    const factory = makeAcpFactory({ id: "mock-acp", name: "Mock ACP" });
    expect(factory.create({ type: "acp" }, { env: {}, fetch: globalThis.fetch })).toBeNull();
  });
});
