import fs from "node:fs/promises";
import path from "node:path";
import { isInside, type AgentEvent, type ApprovalRequest } from "@click/agent-core";
import {
  CLICK_CHANNELS,
  type ApprovalRequestMessage,
  type ChatContextItem,
  type ChatEventEnvelope,
  type ChatStartRequest,
  type ChatStreamMessage,
  type FileNode,
  type ProviderSummary,
  type WorkspaceInfo,
} from "@click/bridge";
import { loadSettings, saveSettings } from "@click/config";
import type { ClickSettings } from "@click/contracts";
import { describeProviders, providerContext, runChat } from "@click/runtime";
import type { ElectronBrowserWindow, ElectronModule } from "./electronTypes.js";

interface SessionState {
  controller: AbortController;
}

const HIDDEN_DIRECTORIES = new Set(["node_modules", ".git", "dist", "out", "build", ".next", "target"]);

/**
 * Registers every IPC handler the renderer can call and wires streamed agent
 * output back to it. Also enforces that all file access stays inside the folder
 * the user opened.
 */
export function registerIpcHandlers(electron: ElectronModule, window: ElectronBrowserWindow): void {
  const { ipcMain, dialog, shell } = electron;
  const sessions = new Map<string, SessionState>();
  const pendingApprovals = new Map<string, (approved: boolean) => void>();
  let workspaceRoot = process.cwd();

  const send = (channel: string, payload: unknown): void => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  };

  const emit = (requestId: string, event: ChatStreamMessage): void => {
    const envelope: ChatEventEnvelope = { requestId, event };
    send(CLICK_CHANNELS.chatEvent, envelope);
  };

  /** Resolves a renderer-supplied path, refusing anything outside the workspace. */
  const confine = (candidate: string): string => {
    const absolute = path.resolve(workspaceRoot, candidate);
    if (absolute !== workspaceRoot && !isInside(workspaceRoot, absolute)) {
      throw new Error(`Refused to access a path outside the workspace: ${candidate}`);
    }
    return absolute;
  };

  const toMessage = (event: AgentEvent): ChatStreamMessage | null => {
    switch (event.type) {
      case "iteration_start":
        return { type: "iteration_start", iteration: event.iteration };
      case "text":
        return { type: "text", text: event.text };
      case "thinking":
        return { type: "thinking", text: event.text };
      case "notice":
        return { type: "notice", text: event.text };
      case "tool_start":
        return { type: "tool_start", id: event.id, tool: event.tool, input: event.input };
      case "tool_end":
        return {
          type: "tool_end",
          id: event.id,
          tool: event.tool,
          result: event.result,
          isError: event.isError,
        };
      case "usage":
        return { type: "usage", usage: event.usage };
      case "error":
        return { type: "error", message: event.error.message, kind: event.error.kind };
      case "finished":
        return null;
      default:
        return null;
    }
  };

  const requestApproval = (approval: ApprovalRequest): Promise<boolean> =>
    new Promise((resolve) => {
      const key = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      pendingApprovals.set(key, resolve);
      const message: ApprovalRequestMessage = {
        requestId: key,
        tool: approval.tool,
        description: approval.description,
        input: approval.input,
      };
      send(CLICK_CHANNELS.approvalRequest, message);
    });

  ipcMain.handle(CLICK_CHANNELS.getSettings, async (): Promise<ClickSettings> => loadSettings());

  ipcMain.handle(
    CLICK_CHANNELS.saveSettings,
    async (_event, settings: ClickSettings): Promise<ClickSettings> => {
      await saveSettings(settings);
      return loadSettings();
    },
  );

  ipcMain.handle(CLICK_CHANNELS.listProviders, async (): Promise<ProviderSummary[]> => {
    const settings = await loadSettings();
    return describeProviders(settings, providerContext({ cwd: workspaceRoot })).map((entry) => ({
      id: String(entry.descriptor.id),
      name: entry.descriptor.name,
      kind: entry.descriptor.kind,
      badge: entry.descriptor.badge,
      accent: entry.descriptor.accent,
      description: entry.descriptor.description,
      configured: entry.configured,
      ...(entry.reason ? { reason: entry.reason } : {}),
      models: entry.descriptor.models,
    }));
  });

  ipcMain.handle(CLICK_CHANNELS.chooseWorkspace, async (): Promise<WorkspaceInfo | null> => {
    const result = await dialog.showOpenDialog(window, {
      title: "Open a folder in Click",
      properties: ["openDirectory", "createDirectory"],
    });
    const picked = result.filePaths[0];
    if (result.canceled || !picked) return null;
    workspaceRoot = path.resolve(picked);
    return { root: workspaceRoot, name: path.basename(workspaceRoot) };
  });

  ipcMain.handle(CLICK_CHANNELS.openWorkspace, async (_event, root: string): Promise<WorkspaceInfo> => {
    const absolute = path.resolve(root);
    const stats = await fs.stat(absolute);
    if (!stats.isDirectory()) throw new Error(`Not a directory: ${root}`);
    workspaceRoot = absolute;
    return { root: absolute, name: path.basename(absolute) };
  });

  ipcMain.handle(CLICK_CHANNELS.readFile, async (_event, filePath: string): Promise<string> => {
    return fs.readFile(confine(filePath), "utf8");
  });

  ipcMain.handle(
    CLICK_CHANNELS.writeFile,
    async (_event, filePath: string, content: string): Promise<void> => {
      const absolute = confine(filePath);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, content, "utf8");
    },
  );

  // Context attached to the next message (@-mentions, add-selection).
  let chatContext: ChatContextItem[] = [];

  ipcMain.handle(CLICK_CHANNELS.listFiles, async (): Promise<string[]> => {
    const found: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (found.length >= 2000 || depth > 8) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (found.length >= 2000) return;
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (HIDDEN_DIRECTORIES.has(entry.name)) continue;
          found.push(`${path.relative(workspaceRoot, child).split(path.sep).join("/")}/`);
          await walk(child, depth + 1);
          continue;
        }
        found.push(path.relative(workspaceRoot, child).split(path.sep).join("/"));
      }
    };
    await walk(workspaceRoot, 0);
    return found;
  });

  ipcMain.handle(CLICK_CHANNELS.addContext, async (_event, item: ChatContextItem) => {
    chatContext = [...chatContext.filter((entry) => entry.path !== item.path), item];
    return chatContext;
  });

  ipcMain.handle(CLICK_CHANNELS.getContext, async () => chatContext);

  ipcMain.handle(CLICK_CHANNELS.clearContext, async () => {
    chatContext = [];
    return chatContext;
  });

  ipcMain.handle(CLICK_CHANNELS.listDir, async (_event, dirPath: string): Promise<FileNode[]> => {
    const absolute = confine(dirPath);
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    return entries
      .filter((entry) => !(entry.isDirectory() && HIDDEN_DIRECTORIES.has(entry.name)))
      .map<FileNode>((entry) => {
        const child = path.join(absolute, entry.name);
        return { name: entry.name, path: child, type: entry.isDirectory() ? "directory" : "file" };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  });

  ipcMain.handle(CLICK_CHANNELS.startChat, async (_event, request: ChatStartRequest): Promise<void> => {
    const controller = new AbortController();
    sessions.set(request.requestId, { controller });

    void (async () => {
      try {
        const settings = await loadSettings();
        if (request.autoApprove) {
          settings.agent = { ...settings.agent, autoApprove: true };
        }
        const outcome = await runChat({
          settings,
          workspaceDir: request.workspaceDir ?? workspaceRoot,
          prompt: request.prompt,
          ...(request.providerId ? { providerId: request.providerId } : {}),
          ...(request.model ? { model: request.model } : {}),
          signal: controller.signal,
          onEvent: (event) => {
            const message = toMessage(event);
            if (message) emit(request.requestId, message);
          },
          approve: (approval) => requestApproval(approval),
        });

        const aborted = controller.signal.aborted;
        emit(request.requestId, {
          type: "done",
          ok: aborted ? false : outcome.ok,
          reason: aborted ? "aborted" : (outcome.result?.reason ?? "error"),
          ...(outcome.providerId ? { providerId: outcome.providerId } : {}),
          ...(outcome.model ? { model: outcome.model } : {}),
          ...(outcome.error ? { message: outcome.error } : {}),
        });
      } catch (error) {
        emit(request.requestId, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
          kind: "unknown",
        });
        emit(request.requestId, { type: "done", ok: false, reason: "error" });
      } finally {
        sessions.delete(request.requestId);
      }
    })();
  });

  ipcMain.handle(CLICK_CHANNELS.cancelChat, async (_event, requestId: string): Promise<void> => {
    sessions.get(requestId)?.controller.abort();
  });

  ipcMain.handle(
    CLICK_CHANNELS.approvalResponse,
    async (_event, response: { requestId: string; approved: boolean }): Promise<void> => {
      const resolve = pendingApprovals.get(response.requestId);
      if (resolve) {
        pendingApprovals.delete(response.requestId);
        resolve(response.approved);
      }
    },
  );

  ipcMain.handle(CLICK_CHANNELS.openExternal, async (_event, url: string): Promise<void> => {
    await shell.openExternal(url);
  });
}
