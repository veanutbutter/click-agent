import type { TokenUsage } from "@click/bridge";

/** The trailing segment of a path, for display. Paths are treated opaquely. */
export function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter((part) => part.length > 0);
  const last = parts.length > 0 ? parts[parts.length - 1] : undefined;
  return last && last.length > 0 ? last : filePath;
}

/** Lower-cased extension without the dot, or "" when there is none. */
export function extensionOf(filePath: string): string {
  const name = baseName(filePath);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** Ordering used by the file tree: directories first, then alphabetical. */
export function compareNodes(
  a: { name: string; type: "file" | "directory" },
  b: { name: string; type: "file" | "directory" },
): number {
  if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US");
}

export function formatUsage(usage: TokenUsage): string {
  const parts = [`${formatCount(usage.inputTokens)} in`, `${formatCount(usage.outputTokens)} out`];
  const cached = usage.cachedInputTokens;
  if (typeof cached === "number" && cached > 0) parts.push(`${formatCount(cached)} cached`);
  return parts.join(" · ");
}

/** Clamp long text for display, reporting whether anything was dropped. */
export function clampText(text: string, max: number): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  return { text: text.slice(0, max), clipped: true };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

/** Pretty-print arbitrary JSON-ish values without ever throwing. */
export function prettyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "";
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

const INPUT_KEY_ORDER = [
  "path",
  "file_path",
  "filePath",
  "absolute_path",
  "directory",
  "dir",
  "command",
  "cmd",
  "query",
  "pattern",
  "url",
  "content",
  "text",
] as const;

/**
 * A one-line gist of a tool call input, so a tool card reads well while folded.
 */
export function summarizeToolInput(input: Record<string, unknown>): string {
  for (const key of INPUT_KEY_ORDER) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      const single = value.replace(/\s+/g, " ").trim();
      const { text, clipped } = clampText(single, 110);
      return `${key} = ${text}${clipped ? "…" : ""}`;
    }
  }
  const keys = Object.keys(input);
  if (keys.length === 0) return "no arguments";
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "number" || typeof value === "boolean") return `${key} = ${String(value)}`;
  }
  const json = JSON.stringify(input);
  const { text, clipped } = clampText(json === undefined ? "" : json, 110);
  return clipped ? `${text}…` : text;
}

/** "in 12s" / "just now" style relative stamps for the transcript. */
export function formatClock(at: number): string {
  const date = new Date(at);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}
