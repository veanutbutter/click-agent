import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderContext } from "@click/provider-core";

import { runChat } from "../src/session.js";

/**
 * Verifies the three things the runtime adds on top of the raw provider:
 * reasoning effort reaches the request, project rule files reach the system
 * prompt, and the mode decides which tools the model can even see.
 *
 * Only `fetch` is stubbed, so the real OpenCode Go provider builds the request
 * exactly as it would in production — the assertions read the outgoing body.
 */

interface Captured {
  url?: string;
  body?: Record<string, unknown>;
}

const SSE_BODY = [
  'data: {"choices":[{"delta":{"content":"done"}}]}',
  "",
  "data: [DONE]",
  "",
].join("\n");

function fakeContext(captured: Captured): ProviderContext {
  return {
    env: {},
    cwd: process.cwd(),
    fetch: (async (url: string | URL, init?: { body?: string }) => {
      captured.url = String(url);
      captured.body = init?.body ? JSON.parse(init.body) : undefined;
      return new Response(SSE_BODY, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch,
  };
}

const settings = {
  providers: { "opencode-go": { type: "api-key", apiKey: "test-key" } },
  defaultModel: { provider: "opencode-go", model: "deepseek-v4.1-flash" },
  agent: { autoApprove: true, maxIterations: 5 },
} as never;

const dirs: string[] = [];
function workspaceWith(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "click-session-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function run(
  workspaceDir: string,
  extra: {
    effort?: string;
    mode?: string;
    images?: { mediaType: string; dataBase64: string }[];
  } = {},
): Promise<Captured> {
  const captured: Captured = {};
  await runChat({
    settings,
    workspaceDir,
    prompt: "hi",
    providerId: "opencode-go",
    model: "deepseek-v4.1-flash",
    allowOutsideReads: true,
    ...extra,
    ctx: fakeContext(captured),
  });
  return captured;
}

function systemText(body: Record<string, unknown> | undefined): string {
  const messages = (body?.messages ?? []) as { role: string; content: unknown }[];
  const system = messages.filter((message) => message.role === "system");
  return system
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : ((message.content ?? []) as { text?: string }[])
            .map((part) => part.text ?? "")
            .join(""),
    )
    .join("\n");
}

function toolNames(body: Record<string, unknown> | undefined): string[] {
  const tools = (body?.tools ?? []) as { function?: { name?: string }; name?: string }[];
  return tools.map((tool) => tool.function?.name ?? tool.name ?? "");
}

describe("runChat", () => {
  it("sends an attached image as an image content block", async () => {
    const captured = await run(workspaceWith(), {
      images: [{ mediaType: "image/png", dataBase64: "aGVsbG8=" }],
    });
    const messages = (captured.body?.messages ?? []) as { role: string; content: unknown }[];
    const user = messages.find((message) => message.role === "user");
    const parts = (user?.content ?? []) as { type: string; image_url?: { url?: string } }[];
    const image = parts.find((part) => part.type === "image_url");
    expect(image?.image_url?.url).toBe("data:image/png;base64,aGVsbG8=");
  });

  it("sends a plain string when no image is attached", async () => {
    const captured = await run(workspaceWith());
    const messages = (captured.body?.messages ?? []) as { role: string; content: unknown }[];
    const user = messages.find((message) => message.role === "user");
    expect(typeof user?.content === "string").toBe(true);
  });

  it("passes reasoning effort through to the request", async () => {
    const captured = await run(workspaceWith(), { effort: "high" });
    expect(captured.body?.reasoning_effort).toBe("high");
  });

  it("omits effort when none was chosen", async () => {
    const captured = await run(workspaceWith());
    expect(captured.body?.reasoning_effort).toBeUndefined();
  });

  it("loads AGENTS.md into the system prompt", async () => {
    const dir = workspaceWith({ "AGENTS.md": "Always use tabs. Never touch generated files." });
    const captured = await run(dir);
    expect(systemText(captured.body)).toContain("Always use tabs");
    expect(systemText(captured.body)).toContain("standing instructions");
  });

  it("loads rule files from a rules directory", async () => {
    const dir = workspaceWith({ ".cursor/rules/style.md": "Prefer early returns." });
    const captured = await run(dir);
    expect(systemText(captured.body)).toContain("Prefer early returns");
  });

  it("gives plan mode read-only tools and plan instructions", async () => {
    const captured = await run(workspaceWith(), { mode: "plan" });
    expect(toolNames(captured.body).sort()).toEqual(["list_dir", "read_file", "search"]);
    expect(systemText(captured.body)).toContain("Plan mode");
  });

  it("gives agent mode every tool", async () => {
    const captured = await run(workspaceWith(), { mode: "agent" });
    expect(toolNames(captured.body)).toContain("write_file");
    expect(toolNames(captured.body)).toContain("edit_file");
    expect(toolNames(captured.body)).toContain("run_command");
  });

  it("gives ask mode no way to mutate anything", async () => {
    const captured = await run(workspaceWith(), { mode: "ask" });
    expect(toolNames(captured.body)).not.toContain("run_command");
    expect(toolNames(captured.body)).not.toContain("write_file");
    expect(systemText(captured.body)).toContain("Ask mode");
  });
});
