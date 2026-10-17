import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadSettings } from "@click/config";

import { ClickHost } from "../src/host.js";

/**
 * End-to-end verification of the extension's host half, run in plain Node.
 *
 * `ClickHost` deliberately does not import `vscode` — the editor API is only used
 * by `extension.ts` — so the whole chat path (settings, provider registry, agent
 * loop, approvals, event stream) can be exercised without launching an editor.
 * That makes the run path verifiable by a command rather than by hand.
 *
 * The chat test makes a real request to OpenCode Go, so it needs a key in
 * `~/.click/settings.json` (or OPENCODE_API_KEY). It is skipped when absent.
 */

interface Captured {
  type: string;
  payload?: Record<string, unknown>;
}

function makeHost(workspace: string) {
  const captured: Captured[] = [];
  const host = new ClickHost({ post: (message) => captured.push(message as Captured) }, workspace);
  return { host, captured };
}

/** Resolve once the host reports the chat finished. */
function waitForDone(captured: Captured[], timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const done = captured.find((m) => m.type === "chatEvent" && m.payload?.event);
      const events = captured
        .filter((m) => m.type === "chatEvent")
        .map((m) => (m.payload as { event?: Record<string, unknown> }).event ?? {});
      const finished = events.find((event) => event.type === "done");
      if (finished) {
        clearInterval(timer);
        resolve(finished);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`chat did not finish within ${timeoutMs}ms; saw ${events.length} event(s)`));
        return;
      }
      void done;
    }, 100);
  });
}

const dirs: string[] = [];
function tempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "click-host-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    // The spawned agent can still hold its cwd briefly after the turn ends; a
    // locked temp directory is not a test failure.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("ClickHost", () => {
  it("offers only the OpenCode agent", async () => {
    const { host } = makeHost(tempWorkspace());
    const providers = (await host.invoke("listProviders", [])) as { id: string }[];
    expect(providers.map((provider) => provider.id)).toEqual(["opencode-acp"]);
    host.dispose();
  });

  it("reports the workspace it is bound to", async () => {
    const workspace = tempWorkspace();
    const { host } = makeHost(workspace);
    const info = (await host.invoke("getWorkspace", [])) as { root: string };
    expect(info.root).toBe(path.resolve(workspace));
    host.dispose();
  });

  it("reads outside the workspace when asked", async () => {
    // Reads are deliberately not confined: a config, a sibling repo or a
    // dependency outside the opened folder is a normal thing to inspect.
    const outside = path.join(os.homedir(), ".click", "settings.json");
    if (!fs.existsSync(outside)) return;
    const { host } = makeHost(tempWorkspace());
    const contents = (await host.invoke("readFile", [outside])) as string;
    expect(contents.length).toBeGreaterThan(0);
    host.dispose();
  });

  it("refuses to WRITE outside the workspace", async () => {
    // Writes stay confined even though reads do not.
    const { host } = makeHost(tempWorkspace());
    await expect(
      host.invoke("writeFile", ["../../click-escape.txt", "nope"]),
    ).rejects.toThrow(/outside the workspace/);
    host.dispose();
  });

  it("holds attached context until the next message, then clears it", async () => {
    const { host } = makeHost(tempWorkspace());
    const item = { kind: "file" as const, path: "C:/repo/app.ts", label: "app.ts" };

    const after = (await host.invoke("addContext", [item])) as unknown[];
    expect(after).toHaveLength(1);
    expect(await host.invoke("getContext", [])).toHaveLength(1);

    // Attaching the same file twice does not duplicate it.
    await host.invoke("addContext", [item]);
    expect(await host.invoke("getContext", [])).toHaveLength(1);

    await host.invoke("clearContext", []);
    expect(await host.invoke("getContext", [])).toHaveLength(0);
    host.dispose();
  });

  it("writes and reads a file inside the workspace", async () => {
    const workspace = tempWorkspace();
    const { host } = makeHost(workspace);
    await host.invoke("writeFile", ["notes/hello.txt", "hi"]);
    expect(await host.invoke("readFile", ["notes/hello.txt"])).toBe("hi");
    host.dispose();
  });

  it("runs the agent and reports its file edits for review", async () => {
    const workspace = tempWorkspace();
    fs.writeFileSync(path.join(workspace, "notes.txt"), "alpha\n", "utf8");

    const captured: Captured[] = [];
    const edits: { path: string; oldString: string; newString: string }[] = [];
    const host = new ClickHost(
      {
        post: (message) => captured.push(message as Captured),
        onFileEdit: (edit) => edits.push(edit),
      },
      workspace,
    );

    const done = waitForDone(captured, 240_000);
    await host.invoke("startChat", [
      {
        requestId: "acp-1",
        prompt: "Use your edit tool to append the line 'beta' to notes.txt.",
        workspaceDir: workspace,
        autoApprove: true,
      },
    ]);

    const finished = await done;
    console.log(`chat finished: ${JSON.stringify(finished)}`);
    console.log(`edits reported for review: ${JSON.stringify(edits)}`);

    expect(finished.ok).toBe(true);
    // The edit landed…
    expect(fs.readFileSync(path.join(workspace, "notes.txt"), "utf8")).toContain("beta");
    // …and the host told us about it, which is what drives the inline review.
    expect(edits.length).toBeGreaterThan(0);
    expect(path.basename(edits[0]!.path)).toBe("notes.txt");
    expect(edits[0]!.oldString).toBe("alpha");
    expect(edits[0]!.newString).toContain("beta");

    host.dispose();
  }, 300_000);
});
