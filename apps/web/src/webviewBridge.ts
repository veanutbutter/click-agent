import type {
  ApprovalRequestMessage,
  ChatContextItem,
  ChatEventEnvelope,
  ChatStartRequest,
  ClickBridge,
  ClickSettings,
  FileNode,
  ProviderSummary,
  WorkspaceInfo,
} from "@click/bridge";

/**
 * A `ClickBridge` that runs over VS Code's webview `postMessage` channel.
 *
 * The webview UI (`App`, hooks, components) is written against `window.click`,
 * which the Electron preload normally provides. Inside a VS Code webview there
 * is no preload, so this module builds the same object on top of the extension
 * host's request/response protocol. Nothing else in the UI changes.
 */

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

interface HostRpcResponse {
  id: number;
  result?: unknown;
  error?: string;
}

type EventName = "chatEvent" | "approvalRequest" | "newChat";

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
    clickAgent?: {
      getWorkspace(): Promise<WorkspaceInfo | null>;
      onNewChat(handler: () => void): () => void;
      log(message: string): void;
    };
  }
}

const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const listeners: Record<EventName, Set<(payload: unknown) => void>> = {
  chatEvent: new Set(),
  approvalRequest: new Set(),
  newChat: new Set(),
};

let api: VsCodeApi | undefined;
let sequence = 0;

function call(method: string, ...args: unknown[]): Promise<unknown> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    api?.postMessage({ id, method, args });
  });
}

function subscribe(event: EventName, handler: (payload: unknown) => void): () => void {
  listeners[event].add(handler);
  return () => listeners[event].delete(handler);
}

function handleMessage(data: unknown): void {
  if (!data || typeof data !== "object") return;
  const message = data as HostRpcResponse & { type?: EventName; payload?: unknown };
  if (typeof message.id === "number") {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error !== undefined) entry.reject(new Error(message.error));
    else entry.resolve(message.result);
    return;
  }
  if (message.type && message.type in listeners) {
    for (const handler of listeners[message.type]) handler(message.payload);
  }
}

function createBridge(): ClickBridge {
  return {
    platform: "vscode",
    version: "0.1.0",
    getSettings: () => call("getSettings") as Promise<ClickSettings>,
    saveSettings: (settings: ClickSettings) => call("saveSettings", settings) as Promise<ClickSettings>,
    listProviders: () => call("listProviders") as Promise<ProviderSummary[]>,
    chooseWorkspace: () => call("getWorkspace") as Promise<WorkspaceInfo | null>,
    openWorkspace: (root: string) => call("openWorkspace", root) as Promise<WorkspaceInfo>,
    readFile: (filePath: string) => call("readFile", filePath) as Promise<string>,
    writeFile: (filePath: string, content: string) =>
      call("writeFile", filePath, content) as Promise<void>,
    listDir: (dirPath: string) => call("listDir", dirPath) as Promise<FileNode[]>,
    listFiles: () => call("listFiles") as Promise<string[]>,
    addContext: (item: ChatContextItem) =>
        call("addContext", item) as Promise<ChatContextItem[]>,
    getContext: () => call("getContext") as Promise<ChatContextItem[]>,
    clearContext: () => call("clearContext") as Promise<ChatContextItem[]>,
    startChat: (request: ChatStartRequest) => call("startChat", request) as Promise<void>,
    cancelChat: (requestId: string) => call("cancelChat", requestId) as Promise<void>,
    respondApproval: (response: { requestId: string; approved: boolean }) =>
      call("respondApproval", response) as Promise<void>,
    openExternal: (url: string) => call("openExternal", url) as Promise<void>,
    onChatEvent: (handler: (payload: ChatEventEnvelope) => void) =>
      subscribe("chatEvent", handler as (payload: unknown) => void),
    onApprovalRequest: (handler: (payload: ApprovalRequestMessage) => void) =>
      subscribe("approvalRequest", handler as (payload: unknown) => void),
  };
}

/**
 * Installs `window.click` (and `window.clickAgent`) when running inside a VS
 * Code webview. A no-op elsewhere, so the same bundle still runs in a browser
 * against the mock bridge.
 */
export function installWebviewBridge(): void {
  if (typeof window === "undefined") return;
  if (typeof window.acquireVsCodeApi !== "function") return;
  if (window.click) return;

  api = window.acquireVsCodeApi();
  window.addEventListener("message", (event: MessageEvent) => handleMessage(event.data));

  const post = (method: string, ...args: unknown[]): void => {
    api?.postMessage({ method, args });
  };

  // Surface anything the panel throws into the extension's output channel, so a
  // blank webview is diagnosable instead of silent.
  window.addEventListener("error", (event) => post("log", `webview error: ${event.message}`));
  window.addEventListener("unhandledrejection", (event) =>
    post("log", `webview rejection: ${String(event.reason)}`),
  );

  window.click = createBridge();
  window.clickAgent = {
    getWorkspace: () => call("getWorkspace") as Promise<WorkspaceInfo | null>,
    onNewChat: (handler: () => void) => subscribe("newChat", handler as (payload: unknown) => void),
    log: (message: string) => post("log", message),
  };
}
