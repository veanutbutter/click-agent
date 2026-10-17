/**
 * `@` mentions in the composer.
 *
 * A mention is a path the user typed with an `@` in front, e.g. `@src/app.ts` or
 * `@src/`. The token is kept in the draft as plain text — so it reads naturally
 * and survives an edit — and is turned into a real context item when the message
 * is sent.
 *
 * The parsing lives here, apart from React, so the awkward parts (a caret in the
 * middle of a word, an `@` inside an email address, a path with spaces) are
 * testable.
 */

export interface ActiveMention {
  /** Index of the `@` in the text. */
  start: number;
  /** What the user has typed after it. */
  query: string;
}

/** Characters that end a mention token. */
const TERMINATORS = /[\s@()[\]{}"'`,;]/;

/**
 * The mention being typed at the caret, if any.
 *
 * Returns `null` when the `@` is part of something else — `user@host` and
 * `npm i @scope/pkg` are not mentions, because a mention must start at a word
 * boundary.
 */
export function activeMention(text: string, caret: number): ActiveMention | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const start = before.lastIndexOf("@");
  if (start === -1) return null;

  const previous = start > 0 ? before[start - 1]! : "";
  if (previous !== "" && !/[\s([{]/.test(previous)) return null;

  const query = before.slice(start + 1);
  if (TERMINATORS.test(query)) return null;
  return { start, query };
}

/**
 * Replace the mention at the caret with the chosen path, and say where the caret
 * should land so typing can continue naturally.
 */
export function applyMention(
  text: string,
  mention: ActiveMention,
  chosen: string,
  caret: number,
): { text: string; caret: number } {
  const tail = text.slice(Math.max(mention.start, caret));
  const inserted = `@${chosen} `;
  return {
    text: text.slice(0, mention.start) + inserted + tail,
    caret: mention.start + inserted.length,
  };
}

/** Every mention in the text, in order, de-duplicated. */
export function extractMentions(text: string): string[] {
  const found: string[] = [];
  const pattern = /(?:^|[\s([{])@([^\s@()[\]{}"'`,;]+)/g;
  for (const match of text.matchAll(pattern)) {
    const path = match[1];
    if (path && !found.includes(path)) found.push(path);
  }
  return found;
}

/** Whether a mentioned path should be treated as a folder. */
export function looksLikeFolder(path: string): boolean {
  return path.endsWith("/");
}

/** Rank candidate paths for a query: prefix matches first, then substring. */
export function rankCandidates(candidates: readonly string[], query: string, limit = 8): string[] {
  const needle = query.toLowerCase();
  if (needle === "") return candidates.slice(0, limit);
  const scored: { path: string; score: number }[] = [];
  for (const path of candidates) {
    const haystack = path.toLowerCase();
    const index = haystack.indexOf(needle);
    if (index === -1) continue;
    // Prefer a match at the start of the path, then the start of a segment.
    const score = index === 0 ? 0 : path[index - 1] === "/" ? 1 : 2;
    scored.push({ path, score });
  }
  scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((entry) => entry.path);
}
