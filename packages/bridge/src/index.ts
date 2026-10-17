import type {
  ClickSettings,
  ModelInfo,
  ProviderErrorKind,
  ProviderKind,
  TokenUsage,
} from "@click/contracts";

export type { ClickSettings, ModelInfo, ProviderErrorKind, ProviderKind, TokenUsage };

/**
 * The contract shared by the Click desktop shell (Electron main + preload) and
 * the Click renderer. It is deliberately free of Node imports so the renderer can
 * depend on it directly.
 */

export const CLICK_CHANNELS = {
  getSettings: "click:settings:get",
  saveSettings: "click:settings:save",
  listProviders: "click:providers:list",
  chooseWorkspace: "click:workspace:choose",
  openWorkspace: "click:workspace:open",
  readFile: "click:fs:read",
  writeFile: "click:fs:write",
  listDir: "click:fs:list",
  listFiles: "click:fs:list-files",
  addContext: "click:chat:context-add",
  getContext: "click:chat:context-get",
  clearContext: "click:chat:context-clear",
  startChat: "click:chat:start",
  cancelChat: "click:chat:cancel",
  chatEvent: "click:chat:event",
  approvalRequest: "click:chat:approval-request",
  approvalResponse: "click:chat:approval-response",
  openExternal: "click:shell:open-external",
} as const;

export interface WorkspaceInfo {
  root: string;
  name: string;
}

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

export interface ProviderSummary {
  id: string;
  name: string;
  kind: ProviderKind;
  badge: string;
  accent: string;
  description: string;
  configured: boolean;
  reason?: string;
  models: ModelInfo[];
}

/** Every message the agent sends to the renderer while a turn runs. */
export type ChatContextKind = "selection" | "file" | "folder";

/**
 * An image attached to a message. Base64, no data-URL prefix — the provider
 * layer builds the data URL per wire protocol.
 */
export interface ChatAttachment {
  /** e.g. `image/png`. */
  mediaType: string;
  /** Base64, without a data-URL prefix. */
  dataBase64: string;
  /** Display name, e.g. the pasted file's name. */
  name?: string;
}

/**
 * A file, folder or selection attached to a message. Produced by `@` mentions in
 * the composer and by the editor's "add selection to chat".
 */
export interface ChatContextItem {
  kind: ChatContextKind;
  /** Absolute path on disk. */
  path: string;
  /** Workspace-relative path for display, or the absolute path when outside. */
  label: string;
  /** 1-based, inclusive. Only for `selection`. */
  startLine?: number;
  endLine?: number;
  /** The selected text. Only for `selection`. */
  text?: string;
}

export type ChatStreamMessage =
  | { type: "iteration_start"; iteration: number }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "notice"; text: string }
  | { type: "tool_start"; id: string; tool: string; input: Record<string, unknown> }
  | { type: "tool_end"; id: string; tool: string; result: string; isError: boolean }
  | { type: "usage"; usage: TokenUsage }
  /** The agent changed a file; drives the inline review in the editor. */
  | { type: "edit"; path: string; oldString: string; newString: string }
  | { type: "error"; message: string; kind: ProviderErrorKind | "unknown" }
  | {
      type: "done";
      ok: boolean;
      reason: "completed" | "max_iterations" | "error" | "aborted";
      providerId?: string;
      model?: string;
      message?: string;
    };

export interface ChatStartRequest {
  requestId: string;
  prompt: string;
  workspaceDir?: string;
  providerId?: string;
  model?: string;
  autoApprove?: boolean;
  /** Images attached to this message. */
  images?: ChatAttachment[];
  /** Reasoning effort for models that expose it. */
  effort?: string;
  /** Inference mode: `agent`, `plan` or `ask`. */
  mode?: string;
}

export interface ChatEventEnvelope {
  requestId: string;
  event: ChatStreamMessage;
}

export interface ApprovalRequestMessage {
  requestId: string;
  tool: string;
  description: string;
  input: Record<string, unknown>;
}

export interface ApprovalResponseMessage {
  requestId: string;
  approved: boolean;
}

/** The API the preload script exposes as `window.click`. */
export interface ClickBridge {
  readonly platform: string;
  readonly version: string;
  getSettings(): Promise<ClickSettings>;
  saveSettings(settings: ClickSettings): Promise<ClickSettings>;
  listProviders(): Promise<ProviderSummary[]>;
  chooseWorkspace(): Promise<WorkspaceInfo | null>;
  openWorkspace(root: string): Promise<WorkspaceInfo>;
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  listDir(dirPath: string): Promise<FileNode[]>;
  /** Workspace-relative paths for the `@` picker; folders end in a slash. */
  listFiles(): Promise<string[]>;
  /** Attach a file, folder or selection to the next message. */
  addContext(item: ChatContextItem): Promise<ChatContextItem[]>;
  getContext(): Promise<ChatContextItem[]>;
  clearContext(): Promise<ChatContextItem[]>;
  startChat(request: ChatStartRequest): Promise<void>;
  cancelChat(requestId: string): Promise<void>;
  respondApproval(response: ApprovalResponseMessage): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** Subscribes to streamed agent output; returns an unsubscribe function. */
  onChatEvent(handler: (payload: ChatEventEnvelope) => void): () => void;
  onApprovalRequest(handler: (payload: ApprovalRequestMessage) => void): () => void;
}
