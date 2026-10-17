/**
 * Chat context: the files, folders and selections a user attaches to a message.
 *
 * Two ways in, both landing in the same shape:
 *   - `@` in the composer picks a file or folder,
 *   - Ctrl+L (rebound from VS Code's "expand line selection") adds the current
 *     selection, or the whole file when nothing is selected.
 *
 * The item type lives in `@click/bridge` because both halves of the UI need it;
 * the formatting lives here, away from the editor API, so what the model
 * actually receives is testable.
 */

import type { ChatContextItem, ChatContextKind } from "@click/bridge";

export type { ChatContextItem, ChatContextKind };

/** A short human label, e.g. `src/app.ts:12-18` or `src/`. */
export function describeContext(item: ChatContextItem): string {
  if (item.kind === "selection" && item.startLine !== undefined && item.endLine !== undefined) {
    const range =
      item.startLine === item.endLine
        ? `${item.startLine}`
        : `${item.startLine}-${item.endLine}`;
    return `${item.label}:${range}`;
  }
  return item.kind === "folder" ? `${item.label}/` : item.label;
}

/**
 * Render the attached context as text appended to the prompt.
 *
 * A selection carries its own text, because the whole point of adding a few
 * lines is that the model should see exactly those lines. A file or folder is
 * named rather than inlined — the agent has `read_file` and can open it, and
 * inlining whole files would blow the context window for no benefit.
 */
export function formatContext(items: readonly ChatContextItem[]): string {
  if (items.length === 0) return "";
  const parts: string[] = ["Context the user attached:"];

  for (const item of items) {
    if (item.kind === "selection" && item.text !== undefined) {
      parts.push(`\n${describeContext(item)}\n\`\`\`\n${item.text}\n\`\`\``);
      continue;
    }
    parts.push(`\n- ${describeContext(item)} (${item.kind})`);
  }

  return parts.join("");
}

/** De-duplicate, keeping the last mention of a path (the newest wins). */
export function mergeContext(
  existing: readonly ChatContextItem[],
  incoming: ChatContextItem,
): ChatContextItem[] {
  const key = (item: ChatContextItem): string =>
    `${item.path}:${item.startLine ?? ""}-${item.endLine ?? ""}`;
  const kept = existing.filter((item) => key(item) !== key(incoming));
  return [...kept, incoming];
}
