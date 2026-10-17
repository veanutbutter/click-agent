import fs from "node:fs/promises";
import path from "node:path";
import { isInside, type AgentEvent, type ApprovalRequest } from "@click/agent-core";
import {
  type ApprovalRequestMessage,
  type ChatEventEnvelope,
  type ChatStartRequest,
  type ChatStreamMessage,
  type FileNode,
  type ProviderSummary,
  type WorkspaceInfo,
} from "@click/bridge";
import { loadSettings, saveSettings } from "@click/config";
import type { ClickSettings } from "@click/contracts";
import { describeProviders, listProviderModels, providerContext, runChat } from "@click/runtime";

import { formatContext, mergeContext, type ChatContextItem } from "./context.js";

/**
 * The trusted half of the extension: it owns the filesystem, the provider
 * registry and the agent loop, and it never trusts a path the webview sends.
 *
 * This is the same contract the Electron shell implements (`ClickBridge`), so
 * the webview UI is identical in both hosts.
 */

const HIDDEN_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".next",
  "target",
]);

/**
 * This extension ships one provider on purpose: OpenCode's own agent, reached
 * over ACP (`opencode acp`). That brings its tool loop, its model access and its
 * MCP servers, and leaves us owning only the UI — including the inline review.
 *
 * The API-key provider layer is still there for the CLI and the gateway; only
 * the *choice* is narrowed here.
 */
const ENABLED_PROVIDERS = new Set(["opencode-acp"]);

/** The agent the extension runs unless a request names another. */
const DEFAULT_PROVIDER = "opencode-acp";

/**
 * The extension ships OpenCode as its agent, so it supplies that provider's
 * configuration itself. A user-provided entry for the same id wins, which lets
 * someone point it at a different ACP command without editing our code.
 */
function withBundledAgent(settings: ClickSettings): ClickSettings {
  if (settings.providers[DEFAULT_PROVIDER]) return settings;
  return {
    ...settings,
    providers: {
      ...settings.providers,
      [DEFAULT_PROVIDER]: { type: "acp", command: "opencode", args: ["acp"] },
    },
  };
}

export interface HostTransport {
  /** Sends an event to the webview (chat stream, approval request). */
  post(message: unknown): void;
  /**
   * Called when the agent changes a file, so a host can show the change for
   * review. The extension turns this into the inline diff; the Electron shell
   * and the CLI simply leave it out and let edits land.
   */
  onFileEdit?(edit: { path: string; oldString: string; newString: string }): void;
}

interface SessionState {
  controller: AbortController;
}

export class ClickHost {
  private readonly sessions = new Map<string, SessionState>();
  private readonly pendingApprovals = new Map<string, (approved: boolean) => void>();
  /** Files, folders and selections attached to the next message. */
  private context: ChatContextItem[] = [];
  private workspaceRoot: string;
  private disposed = false;

  constructor(
    private readonly transport: HostTransport,
    initialWorkspace: string | undefined,
  ) {
    this.workspaceRoot = initialWorkspace ?? process.cwd();
  }

  /** Called when the user switches the VS Code workspace folder. */
  setWorkspace(root: string): WorkspaceInfo {
    this.workspaceRoot = path.resolve(root);
    return { root: this.workspaceRoot, name: path.basename(this.workspaceRoot) };
  }

  currentWorkspace(): WorkspaceInfo | null {
    if (!this.workspaceRoot) return null;
    return { root: this.workspaceRoot, name: path.basename(this.workspaceRoot) };
  }

  dispose(): void {
    this.disposed = true;
    for (const session of this.sessions.values()) session.controller.abort();
    this.sessions.clear();
    this.pendingApprovals.clear();
  }

  async invoke(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "getSettings":
        return loadSettings();
      case "saveSettings":
        return this.saveSettings(args[0] as ClickSettings);
      case "listProviders":
        return this.listProviders();
      case "getWorkspace":
        return this.currentWorkspace();
      case "addContext":
        return this.addContext(args[0] as ChatContextItem);
      case "clearContext":
        return this.clearContext();
      case "getContext":
        return this.context;
      case "listFiles":
        return this.listFiles();
      case "openWorkspace":
        return this.setWorkspace(String(args[0]));
      case "readFile":
        return fs.readFile(this.resolveRead(String(args[0])), "utf8");
      case "writeFile":
        return this.writeFile(String(args[0]), String(args[1]));
      case "listDir":
        return this.listDir(String(args[0]));
      case "startChat":
        return this.startChat(args[0] as ChatStartRequest);
      case "cancelChat":
        this.sessions.get(String(args[0]))?.controller.abort();
        return null;
      case "respondApproval":
        return this.respondApproval(args[0] as { requestId: string; approved: boolean });
      case "openExternal":
        return null; // handled by the extension host, which owns the vscode API
      default:
        throw new Error(`Unknown host method: ${method}`);
    }
  }

  private async saveSettings(next: ClickSettings): Promise<ClickSettings> {
    await saveSettings(next);
    return loadSettings();
  }

  private async listProviders(): Promise<ProviderSummary[]> {
    const settings = withBundledAgent(await loadSettings());
    const entries = describeProviders(settings, providerContext({ cwd: this.workspaceRoot })).filter(
      (entry) => ENABLED_PROVIDERS.has(String(entry.descriptor.id)),
    );

    // The descriptor's model list is static — for an ACP agent it is a single
    // placeholder. Ask the agent itself for its real catalogue so the picker
    // offers the models the user actually has.
    const enriched = await Promise.all(
      entries.map(async (entry) => {
        const id = String(entry.descriptor.id);
        const live = await listProviderModels(
          settings,
          id,
          providerContext({ cwd: this.workspaceRoot }),
        ).catch(() => undefined);
        return live && live.length > 0
          ? { ...entry, descriptor: { ...entry.descriptor, models: live } }
          : entry;
      }),
    );

    return enriched.map((entry) => ({
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
  }

  /**
   * Fold any attached context into the prompt and clear it, so a selection added
   * with Ctrl+L or an `@` mention applies to exactly the next message.
   */
  private withContext(prompt: string): string {
    const attached = formatContext(this.context);
    this.context = [];
    return attached ? `${attached}\n\n${prompt}` : prompt;
  }

  /** Attach a file, folder or selection to the next message. */
  addContext(item: ChatContextItem): ChatContextItem[] {
    // Mentions arrive workspace-relative; store an absolute path too, so the item
    // is usable without caring where it came from.
    const absolute = path.isAbsolute(item.path) ? item.path : this.resolveRead(item.path);
    this.context = mergeContext(this.context, { ...item, path: absolute });
    return this.context;
  }

  clearContext(): ChatContextItem[] {
    this.context = [];
    return this.context;
  }

  /**
   * Workspace-relative paths for the `@` picker: files and folders, folders
   * carrying a trailing slash. Bounded, because the picker is a convenience and
   * a huge repository should not stall the composer.
   */
  private async listFiles(limit = 2000): Promise<string[]> {
    const found: string[] = [];
    const relative = (absolute: string): string =>
      path.relative(this.workspaceRoot, absolute).split(path.sep).join("/");

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (found.length >= limit || depth > 8) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (found.length >= limit) return;
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (HIDDEN_DIRECTORIES.has(entry.name)) continue;
          found.push(`${relative(child)}/`);
          await walk(child, depth + 1);
          continue;
        }
        found.push(relative(child));
      }
    };

    await walk(this.workspaceRoot, 0);
    return found;
  }

  private confine(candidate: string): string {
    const absolute = path.resolve(this.workspaceRoot, candidate);
    if (absolute !== this.workspaceRoot && !isInside(this.workspaceRoot, absolute)) {
      throw new Error(`Refused to access a path outside the workspace: ${candidate}`);
    }
    return absolute;
  }

  /**
   * Reads may reach outside the workspace — a config, a sibling repo, a
   * dependency, a file the agent referenced. Writes never do: that is how an
   * agent damages a machine, so they stay behind {@link confine}.
   */
  private resolveRead(candidate: string): string {
    return path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(this.workspaceRoot, candidate);
  }

  private async writeFile(filePath: string, content: string): Promise<void> {
    const absolute = this.confine(filePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
  }

  private async listDir(dirPath: string): Promise<FileNode[]> {
    const absolute = this.resolveRead(dirPath);
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    return entries
      .filter((entry) => !(entry.isDirectory() && HIDDEN_DIRECTORIES.has(entry.name)))
      .map<FileNode>((entry) => {
        const child = path.join(absolute, entry.name);
        return {
          name: entry.name,
          path: child,
          type: entry.isDirectory() ? "directory" : "file",
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  private emit(requestId: string, event: ChatStreamMessage): void {
    if (this.disposed) return;
    const envelope: ChatEventEnvelope = { requestId, event };
    this.transport.post({ type: "chatEvent", payload: envelope });
  }

  private requestApproval(approval: ApprovalRequest): Promise<boolean> {
    return new Promise((resolve) => {
      const key = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.pendingApprovals.set(key, resolve);
      const message: ApprovalRequestMessage = {
        requestId: key,
        tool: approval.tool,
        description: approval.description,
        input: approval.input,
      };
      this.transport.post({ type: "approvalRequest", payload: message });
    });
  }

  private respondApproval(response: { requestId: string; approved: boolean }): void {
    const resolve = this.pendingApprovals.get(response.requestId);
    if (!resolve) return;
    this.pendingApprovals.delete(response.requestId);
    resolve(response.approved);
  }

  private async startChat(request: ChatStartRequest): Promise<void> {
    const controller = new AbortController();
    this.sessions.set(request.requestId, { controller });

    void (async () => {
      try {
        const settings = withBundledAgent(await loadSettings());
        if (request.autoApprove) settings.agent = { ...settings.agent, autoApprove: true };
        const outcome = await runChat({
          settings,
          workspaceDir: request.workspaceDir ?? this.workspaceRoot,
          // Reads may reach outside the workspace — a config, a sibling repo, a
          // dependency. Writes stay confined to the workspace root.
          allowOutsideReads: true,
          prompt: this.withContext(request.prompt),
          ...(request.images && request.images.length > 0 ? { images: request.images } : {}),
          ...(request.effort ? { effort: request.effort } : {}),
          ...(request.mode ? { mode: request.mode } : {}),
          // Default to the agent this extension ships rather than whatever the
          // settings file happens to name, so the product's provider is the one
          // that runs.
          providerId: request.providerId ?? DEFAULT_PROVIDER,
          ...(request.model ? { model: request.model } : {}),
          // Edits from our own tool loop are shown for review too, so the
          // behaviour is the same whichever agent is running.
          proposeFileChange: async (change) => {
            await fs.mkdir(path.dirname(change.absolute), { recursive: true });
            await fs.writeFile(change.absolute, change.after, "utf8");
            this.transport.onFileEdit?.({
              path: change.absolute,
              oldString: change.before,
              newString: change.after,
            });
            return true;
          },
          signal: controller.signal,
          onEvent: (event: AgentEvent) => {
            if (event.type === "edit") {
              // A host with a review UI shows the change; one without lets it land.
              this.transport.onFileEdit?.({
                path: event.path,
                oldString: event.oldString,
                newString: event.newString,
              });
            }
            const message = toMessage(event);
            if (message) this.emit(request.requestId, message);
          },
          approve: (approval) => this.requestApproval(approval),
        });

        const aborted = controller.signal.aborted;
        this.emit(request.requestId, {
          type: "done",
          ok: aborted ? false : outcome.ok,
          reason: aborted ? "aborted" : (outcome.result?.reason ?? "error"),
          ...(outcome.providerId ? { providerId: outcome.providerId } : {}),
          ...(outcome.model ? { model: outcome.model } : {}),
          ...(outcome.error ? { message: outcome.error } : {}),
        });
      } catch (error) {
        this.emit(request.requestId, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
          kind: "unknown",
        });
        this.emit(request.requestId, { type: "done", ok: false, reason: "error" });
      } finally {
        this.sessions.delete(request.requestId);
      }
    })();
  }
}

function toMessage(event: AgentEvent): ChatStreamMessage | null {
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
    case "edit":
      return { type: "edit", path: event.path, oldString: event.oldString, newString: event.newString };
    case "error":
      return { type: "error", message: event.error.message, kind: event.error.kind };
    case "finished":
      return null;
    default:
      return null;
  }
}
