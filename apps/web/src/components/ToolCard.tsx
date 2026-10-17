import type { ReactElement } from "react";
import { useState } from "react";

import { clampText, prettyValue, summarizeToolInput } from "../format";
import type { ToolRun } from "../transcript";
import { IconCheck, IconChevronDown, IconChevronRight, IconCross, IconSpinner } from "./Icons";

const COLLAPSED_RESULT_LIMIT = 600;
const EXPANDED_RESULT_LIMIT = 20_000;

export interface ToolCardProps {
  run: ToolRun;
}

function statusWord(run: ToolRun): string {
  if (run.status === "running") return "running";
  return run.status === "ok" ? "succeeded" : "failed";
}

/** One agent tool call: name, a gist of its input, status, and the result. */
export function ToolCard({ run }: ToolCardProps): ReactElement {
  const [open, setOpen] = useState(false);
  const limit = open ? EXPANDED_RESULT_LIMIT : COLLAPSED_RESULT_LIMIT;
  const { text: resultText, clipped } = clampText(run.result, limit);
  const hasResult = run.result.trim().length > 0;

  return (
    <div className={`tool-card is-${run.status}`}>
      <button
        type="button"
        className="tool-head"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
      >
        <span className="tool-status" aria-hidden="true">
          {run.status === "running" ? (
            <IconSpinner className="spinner" />
          ) : run.status === "ok" ? (
            <IconCheck />
          ) : (
            <IconCross />
          )}
        </span>
        <span className="tool-name mono">{run.tool}</span>
        <span className="tool-summary mono" title={prettyValue(run.input)}>
          {summarizeToolInput(run.input)}
        </span>
        <span className="sr-only">{statusWord(run)}</span>
        {open ? <IconChevronDown className="tool-caret" /> : <IconChevronRight className="tool-caret" />}
      </button>

      {open ? (
        <div className="tool-body">
          <div className="tool-section">
            <span className="tool-section-label">Input</span>
            <pre className="code-block">{prettyValue(run.input)}</pre>
          </div>
          <div className="tool-section">
            <span className="tool-section-label">Result</span>
            {hasResult ? (
              <>
                <pre className="code-block">{resultText}</pre>
                {clipped ? (
                  <p className="tool-note dim">Output truncated for display.</p>
                ) : null}
              </>
            ) : (
              <p className="tool-note dim">
                {run.status === "running" ? "Waiting for the agent…" : "No output."}
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
