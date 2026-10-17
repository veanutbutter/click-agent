import type { ApprovalRequestMessage } from "@click/bridge";
import type { ReactElement } from "react";

import { prettyValue } from "../format";
import { Modal } from "./Modal";
import { IconCheck, IconCross, IconWarning } from "./Icons";

export interface ApprovalModalProps {
  approval: ApprovalRequestMessage;
  onRespond(approved: boolean): void;
}

/**
 * Blocking prompt shown when the agent wants to touch the machine. Denying is
 * the safe default: Escape and the backdrop both deny.
 */
export function ApprovalModal({ approval, onRespond }: ApprovalModalProps): ReactElement {
  return (
    <Modal
      title="Permission needed"
      role="alertdialog"
      size="md"
      dismissOnBackdrop={false}
      onClose={() => onRespond(false)}
      footer={
        <>
          <button type="button" className="btn btn-subtle" onClick={() => onRespond(false)}>
            <IconCross className="btn-icon" />
            <span>Deny</span>
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onRespond(true)}>
            <IconCheck className="btn-icon" />
            <span>Approve</span>
          </button>
        </>
      }
    >
      <p className="approval-lead">
        The agent wants to run <span className="mono approval-tool">{approval.tool}</span>.
      </p>
      <p className="approval-description">{approval.description}</p>
      <div className="tool-section">
        <span className="tool-section-label">Input</span>
        <pre className="code-block">{prettyValue(approval.input)}</pre>
      </div>
      <p className="approval-note">
        <IconWarning className="btn-icon" />
        <span>
          Denying does not end the turn — the agent is told the call was refused and can try something
          else. Turn on auto-approve to skip this prompt.
        </span>
      </p>
    </Modal>
  );
}
