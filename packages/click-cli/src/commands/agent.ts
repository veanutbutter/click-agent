import type { AgentEvent, ApprovalRequest } from "@click/agent-core";
import { loadSettings } from "@click/config";
import { runChat, providerContext } from "@click/runtime";
import { createInterface } from "node:readline/promises";
import { boolFlag, flag, type ParsedArgs } from "../args.js";

/** Runs a single agent turn, streaming events to the terminal. */
export async function commandAgent(args: ParsedArgs): Promise<void> {
  const prompt = args.positionals.join(" ").trim();
  if (!prompt) {
    process.stderr.write('Usage: click agent "<prompt>" [--provider id] [--model id] [--workspace dir] [--yes]\n');
    process.exitCode = 2;
    return;
  }

  const settings = await loadSettings();
  const workspaceDir = flag(args, "workspace") ?? process.cwd();
  const autoApprove = boolFlag(args, "yes") || settings.agent.autoApprove;
  const json = boolFlag(args, "json");
  const providerId = flag(args, "provider");
  const model = flag(args, "model");

  const rl = !json && !autoApprove && process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;

  const approve = async (request: ApprovalRequest): Promise<boolean> => {
    if (!rl) {
      process.stderr.write(`Denied ${request.description} (non-interactive; pass --yes to auto-approve).\n`);
      return false;
    }
    const answer = await rl.question(`\nApprove ${request.description}? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  };

  const renderer = json ? undefined : createRenderer();

  try {
    const outcome = await runChat({
      settings: { ...settings, agent: { ...settings.agent, autoApprove } },
      workspaceDir,
      prompt,
      ...(providerId ? { providerId } : {}),
      ...(model ? { model } : {}),
      ...(renderer ? { onEvent: renderer.onEvent } : {}),
      approve,
      ctx: providerContext({ cwd: workspaceDir }),
    });

    renderer?.finish();

    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: outcome.ok,
            providerId: outcome.providerId,
            model: outcome.model,
            reason: outcome.result?.reason,
            usage: outcome.result?.usage,
            text: outcome.result ? lastAssistantText(outcome.result.messages) : undefined,
            error: outcome.error,
          },
          null,
          2,
        )}\n`,
      );
      if (!outcome.ok) process.exitCode = 1;
      return;
    }

    if (!outcome.ok) {
      process.stderr.write(`\nclick agent failed: ${outcome.error ?? "unknown error"}\n`);
      process.exitCode = 1;
      return;
    }

    const usage = outcome.result?.usage;
    process.stdout.write(
      `\n— ${outcome.providerId}/${outcome.model} · ${outcome.result?.reason}` +
        (usage ? ` · ${usage.inputTokens}+${usage.outputTokens} tokens` : "") +
        `\n`,
    );
  } finally {
    rl?.close();
  }
}

interface Renderer {
  onEvent: (event: AgentEvent) => void;
  finish: () => void;
}

function createRenderer(): Renderer {
  const color = process.stdout.isTTY === true;
  const dim = (text: string) => (color ? `\u001b[2m${text}\u001b[0m` : text);
  const cyan = (text: string) => (color ? `\u001b[36m${text}\u001b[0m` : text);
  let atLineStart = true;

  const write = (text: string) => {
    process.stdout.write(text);
    atLineStart = text.endsWith("\n");
  };
  const line = (text: string) => {
    if (!atLineStart) write("\n");
    write(`${text}\n`);
  };

  return {
    onEvent(event: AgentEvent) {
      switch (event.type) {
        case "text":
          write(event.text);
          break;
        case "thinking":
          write(dim(event.text));
          break;
        case "notice":
          line(dim(`· ${event.text}`));
          break;
        case "tool_start":
          line(cyan(`→ ${event.tool} ${summarizeInput(event.input)}`));
          break;
        case "tool_end":
          line(dim(`  ${event.isError ? "✘" : "✔"} ${event.tool} (${event.result.length} chars)`));
          break;
        case "error":
          line(`✘ ${event.error.kind}: ${event.error.message}`);
          break;
        case "finished":
          break;
        case "iteration_start":
        case "usage":
          break;
      }
    },
    finish() {
      if (!atLineStart) write("\n");
    },
  };
}

function summarizeInput(input: Record<string, unknown>): string {
  const target = input.path ?? input.command ?? input.query ?? "";
  const text = String(target);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function lastAssistantText(messages: { role: string; content: { type: string; text?: string }[] }[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("");
  }
  return "";
}
