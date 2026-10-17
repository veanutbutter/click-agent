import { ACP_AGENT_PRESETS } from "@click/runtime";
import { boolFlag, type ParsedArgs } from "../args.js";

/** Lists the ACP agents Click can drive, with their launch commands. */
export async function commandAcp(args: ParsedArgs): Promise<void> {
  if (boolFlag(args, "json")) {
    process.stdout.write(`${JSON.stringify(ACP_AGENT_PRESETS, null, 2)}\n`);
    return;
  }

  process.stdout.write("Click ACP agents\n");
  process.stdout.write("Agent Client Protocol lets Click drive any compatible coding agent.\n\n");
  for (const preset of ACP_AGENT_PRESETS) {
    process.stdout.write(`  ${preset.id.padEnd(14)} ${preset.name}\n`);
    if (preset.command) {
      process.stdout.write(`      ${[preset.command, ...preset.args].join(" ")}\n`);
    } else {
      process.stdout.write(`      (custom command required)\n`);
    }
    if (preset.hint) process.stdout.write(`      ${preset.hint}\n`);
  }
  process.stdout.write(
    `\nConfigure one:\n  click providers set claude-code --acp-command npx --acp-arg -y --acp-arg @zed-industries/claude-code-acp\n`,
  );
}
