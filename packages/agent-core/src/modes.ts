/**
 * Agent modes — the inference *shape*, the way Cursor offers Agent / Ask / Plan.
 *
 * A mode is deliberately not a model setting: it decides which tools the model
 * may reach for, what it is told to do with them, and whether changes need
 * approval. That keeps the mode meaningful for any provider, because every
 * provider goes through the same tool loop.
 *
 * Mirrors the reference behaviour: Zed's agent panel has an equivalent split
 * between "ask a question" and "make a change", and T3 Code models per-turn
 * options the same way — as capabilities, not as a different backend.
 */

export interface AgentMode {
  id: AgentModeId;
  label: string;
  /** One line, shown in the picker. */
  description: string;
  /**
   * Tool allow-list. `undefined` means every tool. Read-only modes simply omit
   * the mutating tools, so the model cannot edit even if it tries.
   */
  toolNames?: string[];
  /** Appended to the system prompt to set expectations for this mode. */
  promptAddendum: string;
}

export type AgentModeId = "agent" | "plan" | "ask";

const READ_ONLY_TOOLS = ["read_file", "list_dir", "search"];

export const AGENT_MODES: AgentMode[] = [
  {
    id: "agent",
    label: "Agent",
    description: "Make changes to your code",
    promptAddendum:
      "You are in Agent mode: carry the task through to completion, making the edits it needs. Verify your work with the available tools before reporting it done.",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Investigate and propose, without editing",
    promptAddendum:
      "You are in Plan mode: investigate and produce a concrete plan. Do NOT modify files. Finish with an ordered list of the edits you would make, naming the files and the changes, so the user can approve the approach before any of it is applied.",
    toolNames: READ_ONLY_TOOLS,
  },
  {
    id: "ask",
    label: "Ask",
    description: "Answer questions about the code",
    promptAddendum:
      "You are in Ask mode: answer the user's question about the codebase. Do NOT modify files. Cite the files and line numbers you relied on.",
    toolNames: READ_ONLY_TOOLS,
  },
];

export function findMode(id: string | undefined): AgentMode | undefined {
  if (!id) return undefined;
  return AGENT_MODES.find((mode) => mode.id === id);
}
