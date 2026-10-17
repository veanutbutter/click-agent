import {
  configDir,
  loadSettings,
  redactSettings,
  removeProvider,
  setProvider,
  settingsPath,
} from "@click/config";
import { ProviderId } from "@click/contracts";
import { describeProviders, providerContext } from "@click/runtime";
import { boolFlag, flag, flagList, type ParsedArgs } from "../args.js";

export async function commandProviders(args: ParsedArgs): Promise<void> {
  const action = args.positionals[0];
  if (action === "set") {
    await setProviderCommand(args);
    return;
  }
  if (action === "remove") {
    await removeProviderCommand(args);
    return;
  }
  await listProviders(args);
}

async function listProviders(args: ParsedArgs): Promise<void> {
  const settings = await loadSettings();
  const entries = describeProviders(settings, providerContext());

  if (boolFlag(args, "json")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          configDir: configDir(),
          settingsPath: settingsPath(),
          settings: redactSettings(settings),
          providers: entries.map((entry) => ({
            id: entry.descriptor.id,
            name: entry.descriptor.name,
            kind: entry.descriptor.kind,
            configured: entry.configured,
            ...(entry.reason ? { reason: entry.reason } : {}),
            models: entry.descriptor.models.map((model) => ({
              id: model.id,
              name: model.name,
              contextWindow: model.contextWindow,
            })),
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(`Click providers  (settings: ${settingsPath()})\n\n`);
  for (const entry of entries) {
    const status = entry.configured ? "ready" : "not configured";
    process.stdout.write(
      `  ${entry.descriptor.id.padEnd(20)} ${entry.descriptor.name.padEnd(22)} [${entry.descriptor.kind}] ${status}\n`,
    );
    if (entry.reason) process.stdout.write(`      ↳ ${entry.reason}\n`);
    const models = entry.descriptor.models.map((model) => model.id).join(", ");
    if (models) process.stdout.write(`      models: ${models}\n`);
  }
  process.stdout.write(
    `\nConfigure one:\n  click providers set anthropic --api-key sk-...\n  click providers set claude-code --acp-command npx --acp-arg -y --acp-arg @zed-industries/claude-code-acp\n`,
  );
}

async function setProviderCommand(args: ParsedArgs): Promise<void> {
  const id = args.positionals[1];
  if (!id) {
    process.stderr.write("Usage: click providers set <id> [--api-key K] [--base-url U] [--header K=V]\n");
    process.exitCode = 2;
    return;
  }
  if (!ProviderId.is(id)) {
    process.stderr.write(`Invalid provider id: ${id}\n`);
    process.exitCode = 2;
    return;
  }

  const apiKey = flag(args, "api-key");
  const baseUrl = flag(args, "base-url");
  const acpCommand = flag(args, "acp-command");

  if (acpCommand) {
    const acpArgs = flagList(args, "acp-arg");
    const settings = await setProvider(id, {
      type: "acp",
      command: acpCommand,
      ...(acpArgs.length > 0 ? { args: acpArgs } : {}),
    });
    process.stdout.write(`Configured ACP provider "${id}".\n`);
    process.stdout.write(`Saved to ${settingsPath()}. Providers: ${Object.keys(settings.providers).join(", ")}\n`);
    return;
  }

  const headers: Record<string, string> = {};
  for (const raw of flagList(args, "header")) {
    const equals = raw.indexOf("=");
    if (equals > 0) headers[raw.slice(0, equals)] = raw.slice(equals + 1);
  }

  const settings = await setProvider(id, {
    type: "api-key",
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });
  process.stdout.write(`Configured API-key provider "${id}".\n`);
  process.stdout.write(`Saved to ${settingsPath()}. Providers: ${Object.keys(settings.providers).join(", ")}\n`);
}

async function removeProviderCommand(args: ParsedArgs): Promise<void> {
  const id = args.positionals[1];
  if (!id) {
    process.stderr.write("Usage: click providers remove <id>\n");
    process.exitCode = 2;
    return;
  }
  const settings = await removeProvider(id);
  process.stdout.write(`Removed "${id}". Remaining: ${Object.keys(settings.providers).join(", ") || "(none)"}\n`);
}
