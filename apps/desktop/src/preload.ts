import { createRequire } from "node:module";
import {
  CLICK_CHANNELS,
  type ApprovalRequestMessage,
  type ApprovalResponseMessage,
  type ChatContextItem,
  type ChatEventEnvelope,
  type ChatStartRequest,
  type ClickBridge,
  type ClickSettings,
  type FileNode,
  type ProviderSummary,
  type WorkspaceInfo,
} from "@click/bridge";

const require = createRequire(import.meta.url);
const { contextBridge, ipcRenderer } = require("electron") as {
  contextBridge: { exposeInMainWorld(key: string, api: unknown): void };
  ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    on(channel: string, listener: (event: unknown, payload: never) => void): void;
    removeListener(channel: string, listener: (event: unknown, payload: never) => void): void;
  };
};

const bridge: ClickBridge = {
  platform: process.platform,
  version: process.versions["electron"] ?? "unknown",

  getSettings: () => ipcRenderer.invoke(CLICK_CHANNELS.getSettings) as Promise<ClickSettings>,
  saveSettings: (settings) =>
    ipcRenderer.invoke(CLICK_CHANNELS.saveSettings, settings) as Promise<ClickSettings>,
  listProviders: () =>
    ipcRenderer.invoke(CLICK_CHANNELS.listProviders) as Promise<ProviderSummary[]>,
  chooseWorkspace: () =>
    ipcRenderer.invoke(CLICK_CHANNELS.chooseWorkspace) as Promise<WorkspaceInfo | null>,
  openWorkspace: (root) =>
    ipcRenderer.invoke(CLICK_CHANNELS.openWorkspace, root) as Promise<WorkspaceInfo>,
  readFile: (filePath) => ipcRenderer.invoke(CLICK_CHANNELS.readFile, filePath) as Promise<string>,
  writeFile: (filePath, content) =>
    ipcRenderer.invoke(CLICK_CHANNELS.writeFile, filePath, content) as Promise<void>,
  listDir: (dirPath) => ipcRenderer.invoke(CLICK_CHANNELS.listDir, dirPath) as Promise<FileNode[]>,
  listFiles: () =>
    ipcRenderer.invoke(CLICK_CHANNELS.listFiles) as Promise<string[]>,
  addContext: (item) =>
    ipcRenderer.invoke(CLICK_CHANNELS.addContext, item) as Promise<ChatContextItem[]>,
  getContext: () =>
    ipcRenderer.invoke(CLICK_CHANNELS.getContext) as Promise<ChatContextItem[]>,
  clearContext: () =>
    ipcRenderer.invoke(CLICK_CHANNELS.clearContext) as Promise<ChatContextItem[]>,
  startChat: (request: ChatStartRequest) =>
    ipcRenderer.invoke(CLICK_CHANNELS.startChat, request) as Promise<void>,
  cancelChat: (requestId) =>
    ipcRenderer.invoke(CLICK_CHANNELS.cancelChat, requestId) as Promise<void>,
  respondApproval: (response: ApprovalResponseMessage) =>
    ipcRenderer.invoke(CLICK_CHANNELS.approvalResponse, response) as Promise<void>,
  openExternal: (url) => ipcRenderer.invoke(CLICK_CHANNELS.openExternal, url) as Promise<void>,

  onChatEvent: (handler) => {
    const listener = (_event: unknown, payload: ChatEventEnvelope): void => handler(payload);
    ipcRenderer.on(CLICK_CHANNELS.chatEvent, listener as never);
    return () => ipcRenderer.removeListener(CLICK_CHANNELS.chatEvent, listener as never);
  },
  onApprovalRequest: (handler) => {
    const listener = (_event: unknown, payload: ApprovalRequestMessage): void => handler(payload);
    ipcRenderer.on(CLICK_CHANNELS.approvalRequest, listener as never);
    return () => ipcRenderer.removeListener(CLICK_CHANNELS.approvalRequest, listener as never);
  },
};

contextBridge.exposeInMainWorld("click", bridge);
