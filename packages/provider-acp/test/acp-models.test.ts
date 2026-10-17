import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { ProviderContext } from "@click/provider-core";

import { makeAcpFactory } from "../src/index.js";

/**
 * The model picker must offer the models the agent actually has, not a
 * placeholder. OpenCode exposes its catalogue as a `select` config option on the
 * session, and that is what the provider now reads.
 */

function hasOpencode(): boolean {
  try {
    execFileSync("opencode", ["--version"], {
      stdio: "ignore",
      timeout: 20_000,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "click-acp-models-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* locked */
    }
  }
});

describe("OpenCode model catalogue over ACP", () => {
  it.skipIf(!available)(
    "offers the agent's real models, with the current one first",
    async () => {
      const cwd = workspace();
      const factory = makeAcpFactory({ id: "opencode-acp", name: "OpenCode (agent)" });
      const ctx: ProviderContext = { env: {}, fetch: globalThis.fetch, cwd };
      const provider = factory.create({ type: "acp", command: "opencode", args: ["acp"] }, ctx);
      expect(provider).not.toBeNull();

      try {
        const models = await provider!.listModels();
        console.log(`models: ${models.length}`);
        console.log(`first: ${JSON.stringify(models.slice(0, 3).map((m) => m.name))}`);

        // A real catalogue, not the single placeholder.
        expect(models.length).toBeGreaterThan(10);
        expect(models.every((model) => String(model.id).includes("/"))).toBe(true);
        // The agent's configured model comes first, so "the first model" is a
        // sensible default rather than a free one.
        expect(String(models[0]!.id)).toContain("deepseek");
      } finally {
        await provider!.dispose();
      }
    },
    240_000,
  );

  it.skipIf(!available)(
    "honours a model chosen through the provider",
    async () => {
      const cwd = workspace();
      const factory = makeAcpFactory({ id: "opencode-acp", name: "OpenCode (agent)" });
      const ctx: ProviderContext = { env: {}, fetch: globalThis.fetch, cwd };
      const provider = factory.create({ type: "acp", command: "opencode", args: ["acp"] }, ctx);
      expect(provider).not.toBeNull();

      try {
        const models = await provider!.listModels();
        const target = models[1];
        expect(target).toBeDefined();

        // A turn with an explicit model must not throw; the provider switches the
        // session's model option before prompting.
        const events: string[] = [];
        for await (const event of provider!.stream({
          provider: "opencode-acp",
          model: String(target!.id),
          messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: ok" }] }],
        })) {
          events.push(event.type);
        }
        console.log(`switched to ${String(target!.id)}; events: ${JSON.stringify(events)}`);
        expect(events.at(-1)).toBe("stop");
      } finally {
        await provider!.dispose();
      }
    },
    240_000,
  );
});
