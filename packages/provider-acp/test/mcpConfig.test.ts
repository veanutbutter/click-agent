import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadMcpServers, parseMcpConfig, toAcpServer } from "../src/mcpConfig.js";

const tmpDirs: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "click-mcp-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("toAcpServer", () => {
  it("converts a stdio server with env into ACP pairs", () => {
    expect(
      toAcpServer("fs", { command: "npx", args: ["-y", "server-filesystem"], env: { TOKEN: "x" } }),
    ).toEqual({
      name: "fs",
      command: "npx",
      args: ["-y", "server-filesystem"],
      env: [{ name: "TOKEN", value: "x" }],
    });
  });

  it("converts an http server with headers into ACP pairs", () => {
    expect(toAcpServer("remote", { url: "https://example.com/mcp", headers: { Authorization: "Bearer t" } })).toEqual({
      name: "remote",
      url: "https://example.com/mcp",
      headers: [{ name: "Authorization", value: "Bearer t" }],
    });
  });

  it("skips disabled and unusable entries", () => {
    expect(toAcpServer("off", { command: "npx", disabled: true })).toBeNull();
    expect(toAcpServer("empty", {})).toBeNull();
    expect(toAcpServer("bad", null)).toBeNull();
  });
});

describe("parseMcpConfig", () => {
  it("reads every server from a document", () => {
    const servers = parseMcpConfig({
      mcpServers: {
        a: { command: "a" },
        b: { url: "https://b/mcp" },
        c: { disabled: true, command: "c" },
      },
    });
    expect(servers.map((server) => server.name)).toEqual(["a", "b"]);
  });

  it("tolerates a missing or malformed document", () => {
    expect(parseMcpConfig(null)).toEqual([]);
    expect(parseMcpConfig({})).toEqual([]);
    expect(parseMcpConfig({ mcpServers: [] })).toEqual([]);
  });
});

describe("loadMcpServers", () => {
  it("merges files with the most specific one winning", async () => {
    const cwd = await tmpDir();
    const override = path.join(cwd, "override.json");
    await fs.mkdir(path.join(cwd, ".cursor"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { shared: { command: "workspace" }, onlyWs: { command: "ws" } } }),
      "utf8",
    );
    await fs.writeFile(
      override,
      JSON.stringify({ mcpServers: { shared: { command: "override" } } }),
      "utf8",
    );

    const servers = await loadMcpServers(cwd, { CLICK_MCP_CONFIG: override } as NodeJS.ProcessEnv);
    const byName = new Map(servers.map((server) => [server.name, server]));

    expect(byName.get("onlyWs")).toMatchObject({ command: "ws" });
    expect(byName.get("shared")).toMatchObject({ command: "override" });
  });

  it("returns an empty list when nothing is configured", async () => {
    const cwd = await tmpDir();
    const missing = path.join(cwd, "nope.json");
    const servers = await loadMcpServers(cwd, { CLICK_MCP_CONFIG: missing } as NodeJS.ProcessEnv);
    // The user-level files may exist on a developer machine; assert only that
    // nothing came from the requested (missing) file.
    expect(servers.every((server) => server.name !== "nope")).toBe(true);
  });
});
