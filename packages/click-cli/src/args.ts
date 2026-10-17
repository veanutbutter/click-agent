export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string[]>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equals = body.indexOf("=");
      if (equals !== -1) {
        push(flags, body.slice(0, equals), body.slice(equals + 1));
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        push(flags, body, next);
        index += 1;
      } else {
        push(flags, body, "true");
      }
      continue;
    }
    positionals.push(token);
  }
  return { positionals, flags };
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

export function flag(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.[0];
}

export function flagList(args: ParsedArgs, name: string): string[] {
  return args.flags.get(name) ?? [];
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  const value = flag(args, name);
  return value === "true" || value === "1" || value === "yes";
}
