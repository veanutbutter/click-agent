import type { JsonSchema } from "@click/contracts";
import type { Workspace } from "../workspace.js";

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolContext {
  workspace: Workspace;
  signal?: AbortSignal;
  /**
   * When provided, mutating file tools hand the proposed content here instead of
   * writing it to disk. The host decides the outcome: `true` applies the change,
   * `false` rejects it.
   *
   * This is the seam that lets an editor show a change *for review* before it
   * lands — the agent proposes, the human accepts or rejects — while the CLI and
   * the gateway, which have no reviewer, simply omit it and write directly.
   */
  proposeFileChange?(change: ProposedFileChange): Promise<boolean>;
}

export interface ProposedFileChange {
  /** Workspace-relative path, for display. */
  path: string;
  /** Absolute path on disk. */
  absolute: string;
  /** Current contents ("" for a new file). */
  before: string;
  /** Proposed contents. */
  after: string;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Whether the tool mutates state and should require approval. */
  mutating: boolean;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw new Error(`Missing or invalid "${key}" (expected string)`);
  }
  return value;
}

export function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

export function optionalNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" ? value : undefined;
}
