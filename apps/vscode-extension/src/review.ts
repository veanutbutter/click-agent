import fs from "node:fs/promises";
import * as vscode from "vscode";

import { diffLines, reconstructBefore, summarize, type Hunk, type ProposedEdit } from "./reviewModel.js";

/**
 * The inline review layer — the reason this extension exists.
 *
 * When the agent edits a file, the change is shown *in the file*: added lines
 * are marked, the replaced lines are shown above them, and the user accepts or
 * rejects. Accept keeps what is on disk; reject restores the file to exactly what
 * it was, through a `WorkspaceEdit` so it lands on the normal undo stack.
 *
 * Note the ordering: by the time we hear about an edit, the agent has already
 * written it (OpenCode writes directly to disk — verified). So "accept" is a
 * no-op and "reject" is a restore. That is the same model Cursor uses: the edit
 * is applied, and review is the chance to take it back.
 *
 * All the diff logic lives in `reviewModel.ts`; this file only renders it.
 */

export interface PendingReview extends ProposedEdit {
  hunks: Hunk[];
}

export interface ReviewLogger {
  appendLine(value: string): void;
}

export class ReviewController implements vscode.Disposable {
  private readonly reviews = new Map<string, PendingReview>();
  private readonly addedDecoration: vscode.TextEditorDecorationType;
  private readonly removedDecoration: vscode.TextEditorDecorationType;
  private readonly status: vscode.StatusBarItem;

  constructor(private readonly log: ReviewLogger) {
    // Cursor shows the incoming lines tinted and the outgoing lines above them;
    // the diff editor's own theme colours are the closest native match.
    this.addedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    this.removedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      before: {
        color: new vscode.ThemeColor("diffEditor.removedTextForeground"),
        fontStyle: "italic",
        textDecoration: "line-through",
      },
    });
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.command = "click.review.accept";
    this.status.tooltip = "Click: review the agent's edits (accept, or run 'Click: Reject Edits')";
  }

  /** Record an edit and show it in the editor. Returns what is now pending. */
  async show(edit: ProposedEdit): Promise<PendingReview> {
    const hunks = diffLines(edit.before, edit.after);
    const review: PendingReview = { ...edit, hunks };
    this.reviews.set(edit.path, review);
    this.log.appendLine(
      `[review] ${edit.path}: ${hunks.length} hunk(s) ${summarize(hunks)}`,
    );
    if (hunks.length > 0) await this.render(review);
    this.updateStatus();
    return review;
  }

  /**
   * Review an edit the agent just made.
   *
   * The agent writes first and reports second, so the file on disk is already
   * the new version; the original is recovered by reversing the substitution it
   * reported. That is exact for an `oldString` → `newString` edit, which is what
   * both OpenCode's and our own edit tools produce.
   *
   * Returns `undefined` when there is nothing showable — a whole-file write we
   * cannot diff, or an edit that never landed — rather than showing an empty
   * review.
   */
  async showEdit(edit: {
    path: string;
    oldString: string;
    newString: string;
  }): Promise<PendingReview | undefined> {
    const after = await fs.readFile(edit.path, "utf8").catch(() => undefined);
    if (after === undefined) return undefined;

    const before =
      edit.oldString === "" ? "" : reconstructBefore(after, edit.oldString, edit.newString);
    if (before === after) return undefined;

    return this.show({ path: edit.path, before, after });
  }

  getPending(filePath: string): PendingReview | undefined {
    return this.reviews.get(filePath);
  }

  count(): number {
    return this.reviews.size;
  }

  /** Accept: the edit is already on disk, so this only clears the review. */
  accept(filePath: string): boolean {
    if (!this.reviews.has(filePath)) return false;
    this.clear(filePath);
    this.log.appendLine(`[review] accepted ${filePath}`);
    return true;
  }

  /** Reject: put the file back exactly as it was before the agent touched it. */
  async reject(filePath: string): Promise<boolean> {
    const review = this.reviews.get(filePath);
    if (!review) return false;

    const document = await vscode.workspace.openTextDocument(filePath);
    const lastLine = Math.max(0, document.lineCount - 1);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(0, 0, lastLine, document.lineAt(lastLine).text.length),
      review.before,
    );
    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) await document.save();

    this.clear(filePath);
    this.log.appendLine(`[review] rejected ${filePath} (restored)`);
    return applied;
  }

  /** Accept everything currently pending. */
  acceptAll(): number {
    const paths = [...this.reviews.keys()];
    for (const path of paths) this.accept(path);
    return paths.length;
  }

  /** Reject everything currently pending. */
  async rejectAll(): Promise<number> {
    const paths = [...this.reviews.keys()];
    for (const path of paths) await this.reject(path);
    return paths.length;
  }

  /** Re-render any pending review for the editor that just became active. */
  refresh(editor: vscode.TextEditor | undefined): void {
    if (!editor) return;
    const review = this.reviews.get(editor.document.fileName);
    if (review) this.decorate(editor, review);
  }

  dispose(): void {
    for (const path of [...this.reviews.keys()]) this.clear(path);
    this.addedDecoration.dispose();
    this.removedDecoration.dispose();
    this.status.dispose();
  }

  private clear(filePath: string): void {
    this.reviews.delete(filePath);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.fileName !== filePath) continue;
      editor.setDecorations(this.addedDecoration, []);
      editor.setDecorations(this.removedDecoration, []);
    }
    this.updateStatus();
  }

  private async render(review: PendingReview): Promise<void> {
    const document = await vscode.workspace.openTextDocument(review.path);
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: true,
    });
    this.decorate(editor, review);
  }

  private decorate(editor: vscode.TextEditor, review: PendingReview): void {
    const added: vscode.DecorationOptions[] = [];
    const removed: vscode.DecorationOptions[] = [];
    const lastLine = Math.max(0, editor.document.lineCount - 1);

    for (const hunk of review.hunks) {
      if (hunk.added.length > 0) {
        const start = Math.min(hunk.afterStart, lastLine);
        const end = Math.min(hunk.afterStart + hunk.added.length - 1, lastLine);
        added.push({ range: new vscode.Range(start, 0, end, 0) });
      }
      if (hunk.removed.length > 0) {
        // The outgoing text is attached above the incoming block, marked as
        // removed, so the before and after read together in place.
        const anchor = Math.min(hunk.afterStart, lastLine);
        removed.push({
          range: new vscode.Range(anchor, 0, anchor, 0),
          renderOptions: {
            before: { contentText: hunk.removed.map((line) => `− ${line}`).join("\n") },
          },
        });
      }
    }

    editor.setDecorations(this.addedDecoration, added);
    editor.setDecorations(this.removedDecoration, removed);
  }

  private updateStatus(): void {
    const total = this.reviews.size;
    if (total === 0) {
      this.status.hide();
      return;
    }
    const hunks = [...this.reviews.values()].reduce(
      (count, review) => count + review.hunks.length,
      0,
    );
    this.status.text = `$(diff) Click: ${hunks} edit${hunks === 1 ? "" : "s"} to review`;
    this.status.show();
  }
}
