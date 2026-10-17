import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { ChatMessage, ChatStreamEvent } from "@click/contracts";
import type { ProviderContext } from "@click/provider-core";

import { AcpClient, makeAcpFactory } from "../src/index.js";

/**
 * Drives the *real* OpenCode agent through our ACP client.
 *
 * This is the architecture the extension uses: OpenCode owns the agent loop,
 * the models and the MCP servers, and we own the UI. The test proves the two
 * halves actually meet — a prompt goes out over ACP and text comes back.
 *
 * Skipped when `opencode` is not installed.
 */

function hasOpencode(): boolean {
  try {
    execFileSync("opencode", ["--version"], {
      stdio: "ignore",
      timeout: 20_000,
      // npm installs a `.cmd` shim on Windows, which needs a shell.
      shell: process.platform === "win32",
    });
    return true;
  } catch {
    return false;
  }
}

const available = hasOpencode();
const dirs: string[] = [];

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "click-acp-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    // The spawned agent can still hold its cwd briefly after dispose; a locked
    // temp directory is not a test failure.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

const userMessage = (text: string): ChatMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});

describe("OpenCode over ACP", () => {
  it.skipIf(!available)(
    "answers a prompt through the ACP client",
    async () => {
      const cwd = workspace();
      const factory = makeAcpFactory({ id: "opencode-acp", name: "OpenCode (agent)" });
      const ctx: ProviderContext = { env: {}, fetch: globalThis.fetch, cwd };

      const provider = factory.create({ type: "acp", command: "opencode", args: ["acp"] }, ctx);
      expect(provider).not.toBeNull();

      const events: ChatStreamEvent[] = [];
      try {
        for await (const event of provider!.stream({
          provider: "opencode-acp",
          model: "default",
          messages: [userMessage("Reply with exactly: hello from opencode acp")],
        })) {
          events.push(event);
        }
      } finally {
        await provider!.dispose();
      }

      const text = events
        .filter((event): event is { type: "text_delta"; text: string } => event.type === "text_delta")
        .map((event) => event.text)
        .join("");

      console.log(`events: ${events.length}`);
      console.log(`event types: ${JSON.stringify(events.map((event) => event.type))}`);
      console.log(`events raw: ${JSON.stringify(events).slice(0, 1500)}`);
      expect(events.length).toBeGreaterThan(0);
      expect(events.at(-1)?.type).toBe("stop");
      expect(text.toLowerCase()).toContain("hello from opencode");
    },
    180_000,
  );

  it.skipIf(!available)(
    "reports the agent's own identity and capabilities",
    async () => {
      const cwd = workspace();
      const factory = makeAcpFactory({ id: "opencode-acp", name: "OpenCode (agent)" });
      const ctx: ProviderContext = { env: {}, fetch: globalThis.fetch, cwd };
      const provider = factory.create({ type: "acp", command: "opencode", args: ["acp"] }, ctx);
      expect(provider).not.toBeNull();
      const models = await provider!.listModels();
      console.log(`opencode acp models: ${models.length}`);
      expect(Array.isArray(models)).toBe(true);
      await provider!.dispose();
    },
    120_000,
  );

  /**
   * The decisive question for the review UI: when OpenCode edits a file, does the
   * write come to us (the client's `fs/write_text_file`) or does the agent write
   * to disk itself?
   *
   * If it comes to us, the inline diff review is a matter of intercepting that
   * one call. If it does not, we cannot see the edit at all and must use a
   * different mechanism.
   */
  it.skipIf(!available)(
    "reports whether file edits arrive through the client",
    async () => {
      const cwd = workspace();
      const target = path.join(cwd, "notes.txt");
      fs.writeFileSync(target, "alpha\n", "utf8");

      const clientWrites: { path: string; content: string }[] = [];
      const updates: string[] = [];

      const client = await AcpClient.connect(
        { command: "opencode", args: ["acp"], cwd },
        {
          readTextFile: async (file) => fs.readFileSync(file, "utf8"),
          writeTextFile: async (file, content) => {
            clientWrites.push({ path: file, content });
          },
          requestPermission: async () => "allow",
        },
      );

      try {
        const sessionId = await client.newSession(cwd);
        await client.prompt(
          sessionId,
          "Use your edit tool to append the line 'beta' to notes.txt. Then stop.",
          { onUpdate: (update) => updates.push(JSON.stringify(update)) },
        );
      } finally {
        client.kill();
      }

      const onDisk = fs.readFileSync(target, "utf8");
      const editUpdates = updates.filter((u) => u.includes('"kind":"edit"'));
      const withInput = editUpdates
        .map((raw) => JSON.parse(raw) as { rawInput?: Record<string, unknown> })
        .map((update) => update.rawInput)
        .filter((input): input is Record<string, unknown> => Boolean(input && input.oldString));

      console.log(`client fs/write_text_file calls: ${clientWrites.length}`);
      console.log(`notes.txt on disk: ${JSON.stringify(onDisk)}`);
      console.log(`edit updates: ${editUpdates.length}, carrying rawInput: ${withInput.length}`);
      console.log(`rawInput: ${JSON.stringify(withInput[0])}`);

      // The edit landed on disk…
      expect(onDisk).toContain("beta");
      // …and OpenCode writes directly, so `fs/write_text_file` is NOT our hook.
      expect(clientWrites.length).toBe(0);
      // …but the edit is delivered as data we can build a review from: the exact
      // old and new text, which is all an inline diff needs.
      expect(withInput.length).toBeGreaterThan(0);
      expect(withInput[0]?.oldString).toBe("alpha");
    },
    240_000,
  );

  /**
   * The wiring the review UI depends on: an edit made by the real agent must
   * surface as an `edit` stream event carrying the exact replaced text.
   */
  it.skipIf(!available)(
    "surfaces an agent edit as an edit event",
    async () => {
      const cwd = workspace();
      fs.writeFileSync(path.join(cwd, "notes.txt"), "alpha\n", "utf8");

      const factory = makeAcpFactory({ id: "opencode-acp", name: "OpenCode (agent)" });
      const ctx: ProviderContext = { env: {}, fetch: globalThis.fetch, cwd };
      const provider = factory.create({ type: "acp", command: "opencode", args: ["acp"] }, ctx);
      expect(provider).not.toBeNull();

      const events: ChatStreamEvent[] = [];
      try {
        for await (const event of provider!.stream({
          provider: "opencode-acp",
          model: "default",
          messages: [userMessage("Use your edit tool to append the line 'beta' to notes.txt.")],
        })) {
          events.push(event);
        }
      } finally {
        await provider!.dispose();
      }

      const edits = events.filter(
        (event): event is { type: "edit"; path: string; oldString: string; newString: string } =>
          event.type === "edit",
      );
      console.log(`edit events: ${edits.length}`);
      for (const edit of edits) {
        console.log(`  ${path.basename(edit.path)}: ${JSON.stringify(edit.oldString)} -> ${JSON.stringify(edit.newString)}`);
      }

      expect(edits.length).toBeGreaterThan(0);
      expect(path.basename(edits[0]!.path)).toBe("notes.txt");
      expect(edits[0]!.oldString).toBe("alpha");
      expect(edits[0]!.newString).toContain("beta");
    },
    240_000,
  );
});
