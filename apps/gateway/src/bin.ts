#!/usr/bin/env node
import { createGateway } from "./server.js";

const USAGE = `click-gateway — an OpenAI-compatible front door for every Click provider.

Cursor (and anything else that speaks OpenAI) points at this server, and it
routes each request to the provider named in the model id ("anthropic/claude-...",
"openai/gpt-5.1", "claude-code/default", ...).

Usage: click-gateway [--port N] [--host H] [--workspace DIR]

  GET  /v1/models              every model from every configured provider
  POST /v1/chat/completions    streaming + non-streaming chat
  POST /refresh                rebuild the provider catalogue
  GET  /health                 which providers are ready, and why others are not

Set CLICK_CONFIG_DIR to change where providers are read from (~/.click).
`;

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }

  const portArg = argValue(args, "--port");
  const gateway = await createGateway({
    ...(portArg ? { port: Number.parseInt(portArg, 10) } : {}),
    ...(argValue(args, "--host") ? { host: argValue(args, "--host") as string } : {}),
    ...(argValue(args, "--workspace") ? { workspaceDir: argValue(args, "--workspace") as string } : {}),
    log: (message) => process.stdout.write(`${message}\n`),
  });

  process.stdout.write(`Click gateway listening on ${gateway.url}\n`);
  process.stdout.write(`Point Cursor's openAIBaseUrl at ${gateway.url}\n`);

  const shutdown = (): void => {
    void gateway.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
