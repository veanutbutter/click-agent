/**
 * The review model: turning a proposed edit into hunks, and deciding what
 * "accept" and "reject" mean.
 *
 * This is deliberately free of any editor API. The rendering layer
 * (`review.ts`) is then thin enough to read in one sitting, and the part with
 * the actual logic — what changed, and what reverting means — is testable in
 * plain Node.
 *
 * The edits come from OpenCode over ACP as `{ path, oldString, newString }`,
 * but the model works on whole files, so a new file or a full rewrite is the
 * same shape (`before` is simply empty).
 */

export interface ProposedEdit {
  /** Absolute path on disk. */
  path: string;
  /** Contents before the edit ("" for a new file). */
  before: string;
  /** Contents after the edit. */
  after: string;
}

export interface Hunk {
  /** 0-based line index in `before` where this hunk begins. */
  beforeStart: number;
  /** 0-based line index in `after` where this hunk begins. */
  afterStart: number;
  /** Lines that were removed. */
  removed: string[];
  /** Lines that were added in their place. */
  added: string[];
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  // A trailing newline is a terminator, not an empty final line — without this
  // every file that ends in a newline diffs as if a blank line were added.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Longest common subsequence of two line arrays, as index pairs. Standard
 * dynamic programming — files are small enough (the editor is showing them) that
 * the O(n·m) table is not worth optimising away for cleverness.
 */
function commonSubsequence(a: string[], b: string[]): [number, number][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * Line-level diff between two versions of a file. Consecutive removals and
 * additions are grouped into one hunk, so a changed block reads as a single
 * before/after pair rather than as alternating single-line edits.
 */
export function diffLines(before: string, after: string): Hunk[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const pairs = commonSubsequence(a, b);

  const hunks: Hunk[] = [];
  let ai = 0;
  let bi = 0;

  const flush = (beforeStart: number, afterStart: number): void => {
    if (pendingRemoved.length === 0 && pendingAdded.length === 0) return;
    hunks.push({ beforeStart, afterStart, removed: pendingRemoved, added: pendingAdded });
  };

  let pendingStart = -1;
  let pendingAfterStart = -1;
  let pendingRemoved: string[] = [];
  let pendingAdded: string[] = [];

  const close = (): void => {
    if (pendingStart >= 0) {
      flush(pendingStart, pendingAfterStart);
      pendingStart = -1;
      pendingAfterStart = -1;
      pendingRemoved = [];
      pendingAdded = [];
    }
  };

  for (const [pi, pj] of pairs) {
    const removed: string[] = [];
    const added: string[] = [];
    while (ai < pi) removed.push(a[ai++]!);
    while (bi < pj) added.push(b[bi++]!);
    if (removed.length > 0 || added.length > 0) {
      if (pendingStart < 0) {
        pendingStart = ai - removed.length;
        pendingAfterStart = bi - added.length;
      }
      pendingRemoved.push(...removed);
      pendingAdded.push(...added);
    } else {
      close();
    }
    ai = pi + 1;
    bi = pj + 1;
  }

  const tailRemoved: string[] = [];
  const tailAdded: string[] = [];
  while (ai < a.length) tailRemoved.push(a[ai++]!);
  while (bi < b.length) tailAdded.push(b[bi++]!);
  if (tailRemoved.length > 0 || tailAdded.length > 0) {
    if (pendingStart < 0) {
      pendingStart = ai - tailRemoved.length;
      pendingAfterStart = bi - tailAdded.length;
    }
    pendingRemoved.push(...tailRemoved);
    pendingAdded.push(...tailAdded);
  }
  close();

  return hunks;
}

export function isNoop(edit: ProposedEdit): boolean {
  return edit.before === edit.after;
}

/**
 * Reconstruct what a file looked like *before* an edit, given the file as it is
 * now and the exact text the agent replaced.
 *
 * This is needed because the agent writes first and tells us second (OpenCode
 * writes directly to disk — verified), so the only way to recover the original
 * is to reverse the substitution. That is exact for a `oldString` → `newString`
 * replacement, which is how both OpenCode's and our own edit tools work.
 *
 * Returns `after` unchanged when the substitution cannot be found, which the
 * caller treats as "nothing to review".
 */
export function reconstructBefore(after: string, oldString: string, newString: string): string {
  if (oldString === newString) return after;
  const at = after.indexOf(newString);
  if (at === -1) return after;
  return after.slice(0, at) + oldString + after.slice(at + newString.length);
}

/** A one-line summary for the review control, e.g. "+3 −1". */
export function summarize(hunks: Hunk[]): string {
  const added = hunks.reduce((total, hunk) => total + hunk.added.length, 0);
  const removed = hunks.reduce((total, hunk) => total + hunk.removed.length, 0);
  return `+${added} −${removed}`;
}
