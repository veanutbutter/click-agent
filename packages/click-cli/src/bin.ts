#!/usr/bin/env node
import { ACP_AGENT_PRESETS } from "@click/runtime";
import { parseArgs } from "./args.js";
import { commandProviders } from "./commands/providers.js";
import { commandProbe } from "./commands/probe.js";
import { commandAgent } from "./commands/agent.js";
import { commandAcp } from "./commands/acp.js";

const USAGE = `Click — an open, provider-agnostic AI code editor.

Usage: click <command> [options]

Commands:
  providers              List every provider Click knows about.
  providers set <id>     Configure a provider (api key or ACP command).
  providers remove <id>  Remove a provider's configuration.
  probe                  Health-check configured providers (exit 1 on failure).
  agent "<prompt>"       Run one agent turn in a workspace.
  acp                    List known ACP agents and their launch commands.

Common options:
  --json                 Machine-readable output (probe/providers).
  --provider <id>        Select a provider.
  --model <id>           Select a model.
  --workspace <dir>      Workspace root (default: cwd).
  --yes                  Auto-approve mutating tools.

Settings live in ~/.click/settings.json (override with CLICK_CONFIG_DIR).
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case "providers":
      await commandProviders(args);
      return;
    case "probe":
      await commandProbe(args);
      return;
    case "agent":
      await commandAgent(args);
      return;
    case "acp":
      await commandAcp(args);
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

export { ACP_AGENT_PRESETS };
