const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const vscode = require("vscode");
const testing = require("../../dist/testing.js");

/**
 * Extension-host tests: run inside a real VS Code window.
 *
 * These cover the parts that cannot be exercised in plain Node — decoration
 * types, opening a document, and applying a `WorkspaceEdit`. The diff logic
 * itself is unit-tested separately in `test/reviewModel.test.ts`.
 */

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "click-review-"));
}

async function showReview(controller, file, before, after) {
  fs.writeFileSync(file, after, "utf8");
  return controller.show({ path: file, before, after });
}

async function run() {
  const logger = { appendLine: () => {} };
  const dir = tempDir();
  const controller = new testing.ReviewController(logger);

  try {
    // --- an appended line is reviewed, then rejected -------------------------
    const appended = path.join(dir, "appended.txt");
    const review = await showReview(controller, appended, "alpha\n", "alpha\nbeta\n");
    assert.strictEqual(review.hunks.length, 1, "one hunk for an appended line");
    assert.deepStrictEqual(review.hunks[0].added, ["beta"]);
    assert.strictEqual(controller.count(), 1, "review is pending");

    const rejected = await controller.reject(appended);
    assert.strictEqual(rejected, true, "reject applies an edit");
    assert.strictEqual(
      fs.readFileSync(appended, "utf8"),
      "alpha\n",
      "reject restores the file exactly",
    );
    assert.strictEqual(controller.count(), 0, "review is cleared after reject");

    // --- accept keeps what the agent wrote ----------------------------------
    const accepted = path.join(dir, "accepted.txt");
    await showReview(controller, accepted, "one\n", "one\ntwo\n");
    assert.strictEqual(controller.accept(accepted), true);
    assert.strictEqual(
      fs.readFileSync(accepted, "utf8"),
      "one\ntwo\n",
      "accept leaves the agent's edit in place",
    );
    assert.strictEqual(controller.count(), 0);

    // --- a replacement keeps the untouched lines ----------------------------
    const replaced = path.join(dir, "replaced.txt");
    const replacement = await showReview(
      controller,
      replaced,
      "keep\nchange me\nalso keep\n",
      "keep\nchanged\nalso keep\n",
    );
    assert.deepStrictEqual(replacement.hunks[0].removed, ["change me"]);
    assert.deepStrictEqual(replacement.hunks[0].added, ["changed"]);
    assert.strictEqual(replacement.hunks[0].afterStart, 1, "hunk anchors on the right line");
    await controller.reject(replaced);
    assert.strictEqual(fs.readFileSync(replaced, "utf8"), "keep\nchange me\nalso keep\n");

    // --- a new file can be rejected back to nothing -------------------------
    const created = path.join(dir, "created.txt");
    await showReview(controller, created, "", "brand new\n");
    await controller.reject(created);
    assert.strictEqual(fs.readFileSync(created, "utf8"), "", "new file reverts to empty");

    // --- decorations actually apply to a live editor ------------------------
    const decorated = path.join(dir, "decorated.txt");
    const shown = await showReview(controller, decorated, "alpha\n", "alpha\nbeta\n");
    const document = await vscode.workspace.openTextDocument(decorated);
    const editor = await vscode.window.showTextDocument(document);
    assert.ok(editor, "the file opened in an editor");
    assert.strictEqual(shown.hunks.length, 1);
    // No throw means the decoration types and ranges are accepted by the editor.
    controller.refresh(editor);
    assert.strictEqual(controller.count(), 1, "review survives a re-render");
    controller.accept(decorated);

    // --- Ctrl+L: the command exists and attaches the selection ---------------
    const contextFile = path.join(dir, "context.txt");
    fs.writeFileSync(contextFile, "first\nsecond\nthird\n", "utf8");
    const contextDocument = await vscode.workspace.openTextDocument(contextFile);
    const contextEditor = await vscode.window.showTextDocument(contextDocument);
    assert.ok(contextEditor, "the file opened so there is an active editor");
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("click.addToChat"), "Click: Add Selection to Chat is registered");
    assert.ok(commands.includes("click.review.accept"), "Click: Keep Edits is registered");
    assert.ok(commands.includes("click.review.reject"), "Click: Revert Edits is registered");
    await vscode.commands.executeCommand("click.addToChat");

    // --- the agent host still works inside the real extension host ----------
    const host = new testing.ClickHost({ post: () => {} }, dir);
    const providers = await host.invoke("listProviders", []);
    assert.deepStrictEqual(
      providers.map((provider) => provider.id),
      ["opencode-acp"],
      "the host offers exactly the OpenCode agent",
    );
    host.dispose();

    console.log("extension-host tests passed");
  } finally {
    controller.dispose();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a locked temp dir is not a failure */
    }
  }
}

module.exports = { run };
