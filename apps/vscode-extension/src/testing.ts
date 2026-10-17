/**
 * Test-only entry point.
 *
 * The extension host test (`test/vscode/run.js`) runs inside a real VS Code, so
 * it needs to reach the review layer and the host through the built bundle. This
 * re-exports exactly the pieces the tests drive — nothing here is used by the
 * extension at runtime.
 */

export { ReviewController, type PendingReview } from "./review.js";
export { diffLines, summarize, isNoop, type Hunk, type ProposedEdit } from "./reviewModel.js";
export { ClickHost } from "./host.js";
