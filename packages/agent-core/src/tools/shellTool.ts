import { spawn } from "node:child_process";
import type { Tool, ToolResult } from "./types.js";
import { optionalNumber, optionalString, requireString } from "./types.js";

const MAX_OUTPUT_CHARS = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export const runCommandTool: Tool = {
  name: "run_command",
  description:
    "Run a shell command in the workspace and return its combined stdout/stderr. Use for builds, tests, git, and package managers.",
  mutating: true,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute." },
      cwd: { type: "string", description: "Workspace-relative working directory." },
      timeout_ms: { type: "number", description: "Timeout in milliseconds (default 120000)." },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async run(input, ctx): Promise<ToolResult> {
    const command = requireString(input, "command");
    const cwd =
      input.cwd === undefined
        ? ctx.workspace.root
        : ctx.workspace.resolve(requireString(input, "cwd"));
    const timeoutMs = optionalNumber(input, "timeout_ms") ?? DEFAULT_TIMEOUT_MS;
    const shellHint = optionalString(input, "shell");

    return new Promise<ToolResult>((resolve) => {
      const child = spawn(command, {
        cwd,
        shell: shellHint ?? true,
        windowsHide: true,
        env: process.env,
      });

      let output = "";
      let settled = false;
      const finish = (result: ToolResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };

      const timer = setTimeout(() => {
        child.kill();
        finish({
          content: `${truncate(output)}\n\n[command timed out after ${timeoutMs}ms]`,
          isError: true,
        });
      }, timeoutMs);

      const onAbort = (): void => {
        child.kill();
        finish({ content: "Command aborted.", isError: true });
      };
      ctx.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (chunk: Buffer) => {
        if (output.length < MAX_OUTPUT_CHARS) output += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (output.length < MAX_OUTPUT_CHARS) output += chunk.toString("utf8");
      });

      child.on("error", (error) => {
        finish({ content: `Failed to run command: ${error.message}`, isError: true });
      });

      child.on("close", (code) => {
        const suffix = code === 0 ? "" : `\n\n[exit code ${code ?? "unknown"}]`;
        finish({ content: `${truncate(output) || "(no output)"}${suffix}`, isError: code !== 0 });
      });
    });
  },
};

function truncate(value: string): string {
  return value.length <= MAX_OUTPUT_CHARS
    ? value
    : `${value.slice(0, MAX_OUTPUT_CHARS)}\n…[output truncated]`;
}
