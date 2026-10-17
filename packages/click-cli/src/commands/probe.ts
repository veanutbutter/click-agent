import { loadSettings } from "@click/config";
import { createProviderRegistry, providerContext } from "@click/runtime";
import { boolFlag, flag, type ParsedArgs } from "../args.js";

interface ProbeResult {
  id: string;
  name: string;
  kind: string;
  ok: boolean;
  detail?: string;
  models: string[];
}

/**
 * Health-checks every provider that is actually configured. Providers that are
 * merely unconfigured are reported but do not fail the run.
 */
export async function commandProbe(args: ParsedArgs): Promise<void> {
  const settings = await loadSettings();
  const workspace = flag(args, "workspace");
  const ctx = providerContext(workspace ? { cwd: workspace } : {});
  const registry = createProviderRegistry();
  const report = registry.build(settings, ctx);

  const only = flag(args, "provider");
  const targets = only ? report.providers.filter((entry) => String(entry.id) === only) : report.providers;
  const json = boolFlag(args, "json");

  if (only && targets.length === 0) {
    process.stderr.write(`Provider "${only}" is not configured. Run \`click providers\` to see options.\n`);
    process.exitCode = 1;
    return;
  }

  const results: ProbeResult[] = [];
  for (const provider of targets) {
    const descriptor = provider.descriptor;
    const base: ProbeResult = {
      id: String(provider.id),
      name: descriptor.name,
      kind: descriptor.kind,
      ok: false,
      models: [],
    };
    try {
      const health = await provider.check();
      base.ok = health.ok;
      if (health.detail) base.detail = health.detail;
      if (health.ok) {
        const models = await provider.listModels();
        base.models = models.map((model) => String(model.id));
      }
    } catch (error) {
      base.ok = false;
      base.detail = error instanceof Error ? error.message : String(error);
    }
    results.push(base);
    if (!json) printResult(base);
  }

  const failed = results.filter((result) => !result.ok);
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: failed.length === 0,
          providers: results,
          skipped: report.skipped.map((entry) => ({ id: entry.id, reason: entry.reason })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    if (report.skipped.length > 0) {
      process.stdout.write(`\nNot configured (skipped):\n`);
      for (const entry of report.skipped) {
        process.stdout.write(`  · ${entry.id}: ${entry.reason}\n`);
      }
    }
    if (results.length === 0) {
      process.stdout.write(
        `No providers are configured yet. Try:\n  click providers set anthropic --api-key sk-...\n`,
      );
    } else {
      process.stdout.write(
        `\n${results.length - failed.length}/${results.length} configured provider(s) healthy.\n`,
      );
    }
  }

  if (failed.length > 0) process.exitCode = 1;
}

function printResult(result: ProbeResult): void {
  const mark = result.ok ? "ok  " : "FAIL";
  process.stdout.write(`[${mark}] ${result.id} (${result.name}, ${result.kind})\n`);
  if (result.detail) process.stdout.write(`       ${result.detail}\n`);
  if (result.models.length > 0) {
    const preview = result.models.slice(0, 6).join(", ");
    const more = result.models.length > 6 ? ` (+${result.models.length - 6} more)` : "";
    process.stdout.write(`       models: ${preview}${more}\n`);
  }
}
