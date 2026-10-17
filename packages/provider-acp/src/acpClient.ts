import { spawn, type ChildProcess } from "node:child_process";
import { JsonRpcConnection, JsonRpcError } from "./jsonrpc.js";
import type { AcpMcpServer } from "./mcpConfig.js";

export const ACP_PROTOCOL_VERSION = 1;
export const CLIENT_NAME = "click";
export const CLIENT_VERSION = "0.1.0";

export interface AcpSpawnOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface AcpAgentInfo {
  name?: string;
  title?: string;
  version?: string;
}

export interface AcpAuthMethod {
  id: string;
  name?: string;
  description?: string;
}

export interface AcpInitializeResult {
  protocolVersion?: number;
  agentCapabilities?: Record<string, unknown>;
  authMethods?: AcpAuthMethod[];
  agentInfo?: AcpAgentInfo;
}

export interface AcpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface AcpToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  content?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: unknown;
}

export interface AcpSessionUpdate {
  sessionUpdate?: string;
  content?: AcpContentBlock;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  /** Files a tool call touched, when the agent reports them. */
  locations?: { path?: string }[];
  /** The tool's own arguments, e.g. an edit's `oldString`/`newString`. */
  rawInput?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall?: AcpToolCall;
  options?: AcpPermissionOption[];
}

export type PermissionDecision = "allow" | "deny";

export interface AcpClientHandlers {
  readTextFile?(path: string, line?: number, limit?: number): Promise<string>;
  writeTextFile?(path: string, content: string): Promise<void>;
  /** Decide how to answer a permission request from the agent. */
  requestPermission?(request: AcpPermissionRequest): Promise<PermissionDecision>;
  onStderr?(chunk: string): void;
}

export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export interface AcpPromptHandlers {
  onUpdate(update: AcpSessionUpdate): void;
}

/** A live ACP agent process, spoken to over newline-delimited JSON-RPC on stdio. */
export class AcpClient {
  private initializeResult: AcpInitializeResult = {};
  private readonly stderrChunks: string[] = [];
  private permissionHandler:
    | ((request: AcpPermissionRequest) => Promise<PermissionDecision>)
    | undefined;
  private updateHandler: ((update: AcpSessionUpdate) => void) | undefined;
  private exited = false;

  private constructor(
    readonly child: ChildProcess,
    private readonly conn: JsonRpcConnection,
    private readonly handlers: AcpClientHandlers,
  ) {}

  get agentInfo(): AcpAgentInfo {
    return this.initializeResult.agentInfo ?? {};
  }

  get authMethods(): AcpAuthMethod[] {
    return this.initializeResult.authMethods ?? [];
  }

  get initializeResponse(): AcpInitializeResult {
    return this.initializeResult;
  }

  get stderr(): string {
    return this.stderrChunks.join("");
  }

  get isClosed(): boolean {
    return this.exited || this.conn.isClosed;
  }

  /** Spawn an agent, wire up client-side handlers, and perform the handshake. */
  static async connect(
    options: AcpSpawnOptions,
    handlers: AcpClientHandlers = {},
  ): Promise<AcpClient> {
    // On Windows an npm-installed tool (`opencode`, `npx`, `claude`) is a
    // `.cmd` shim, which CreateProcess cannot execute directly — it needs a
    // shell. Detect that here rather than only for an explicit `.cmd` path,
    // since presets name the tool, not its shim.
    const absolute = /^([A-Za-z]:[\\/]|\\\\|\/)/.test(options.command);
    const useShell =
      process.platform === "win32" &&
      (/\.(cmd|bat)$/i.test(options.command) ||
        (!absolute && !/\.exe$/i.test(options.command)));
    const args = (options.args ?? []).map((arg) =>
      useShell && /\s/.test(arg) ? `"${arg}"` : arg,
    );
    const child = spawn(options.command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(useShell ? { shell: true } : {}),
    });

    if (!child.stdin || !child.stdout) {
      child.kill();
      throw new Error(`Failed to spawn ACP agent: ${options.command}`);
    }

    const conn = new JsonRpcConnection(child.stdout, child.stdin);
    const client = new AcpClient(child, conn, handlers);

    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on("data", (chunk: string | Buffer) => {
      const text = chunk.toString();
      client.stderrChunks.push(text);
      handlers.onStderr?.(text);
    });
    child.on("error", () => {
      client.exited = true;
    });
    conn.onClosed(() => {
      client.exited = true;
    });

    client.registerHandlers();
    client.initializeResult = await client.initialize();
    return client;
  }

  private registerHandlers(): void {
    this.conn.handleRequest("fs/read_text_file", async (params) => {
      const p = (params ?? {}) as { path?: string; line?: number; limit?: number };
      if (!p.path) throw new JsonRpcError(-32602, "path is required");
      const content = this.handlers.readTextFile
        ? await this.handlers.readTextFile(p.path, p.line, p.limit)
        : "";
      return { content };
    });

    this.conn.handleRequest("fs/write_text_file", async (params) => {
      const p = (params ?? {}) as { path?: string; content?: string };
      if (!p.path) throw new JsonRpcError(-32602, "path is required");
      if (this.handlers.writeTextFile) {
        await this.handlers.writeTextFile(p.path, p.content ?? "");
      }
      return {};
    });

    this.conn.handleRequest("session/request_permission", async (params) => {
      const request = (params ?? {}) as AcpPermissionRequest;
      const decision: PermissionDecision = this.permissionHandler
        ? await this.permissionHandler(request)
        : this.handlers.requestPermission
          ? await this.handlers.requestPermission(request)
          : "allow";
      const option = pickOption(request.options ?? [], decision);
      if (!option) return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId: option.optionId } };
    });

    this.conn.onNotification((method, params) => {
      if (method !== "session/update") return;
      const p = (params ?? {}) as { update?: AcpSessionUpdate };
      if (p.update) this.updateHandler?.(p.update);
    });
  }

  private async initialize(): Promise<AcpInitializeResult> {
    try {
      return await this.conn.request<AcpInitializeResult>("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
        },
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      });
    } catch (error) {
      const detail = this.stderr.trim();
      const suffix = detail ? `\nAgent stderr:\n${detail.slice(-1500)}` : "";
      throw new Error(
        `ACP initialize failed: ${error instanceof Error ? error.message : String(error)}${suffix}`,
      );
    }
  }

  async authenticate(methodId: string): Promise<void> {
    await this.conn.request("authenticate", { methodId });
  }

  async newSession(cwd: string, mcpServers: AcpMcpServer[] = []): Promise<string> {
    const result = await this.conn.request<{ sessionId?: string }>("session/new", {
      cwd,
      mcpServers,
    });
    if (!result?.sessionId) throw new Error("Agent did not return a session id");
    return result.sessionId;
  }

  async prompt(
    sessionId: string,
    content: AcpContentBlock[] | string,
    handlers: AcpPromptHandlers,
  ): Promise<AcpStopReason> {
    this.updateHandler = handlers.onUpdate;
    // A string is the common case; anything else is passed through so image
    // blocks reach the agent rather than being dropped on the floor.
    const prompt: AcpContentBlock[] =
      typeof content === "string" ? [{ type: "text", text: content }] : content;
    try {
      const result = await this.conn.request<{ stopReason?: string }>("session/prompt", {
        sessionId,
        prompt,
      });
      return normalizeStopReason(result?.stopReason);
    } finally {
      this.updateHandler = undefined;
    }
  }

  cancel(sessionId: string): void {
    this.conn.notify("session/cancel", { sessionId });
  }

  setPermissionHandler(
    handler: ((request: AcpPermissionRequest) => Promise<PermissionDecision>) | undefined,
  ): void {
    this.permissionHandler = handler;
  }

  kill(): void {
    this.conn.close();
    if (!this.exited) {
      try {
        this.child.kill();
      } catch {
        // Already gone.
      }
    }
  }
}

function pickOption(
  options: AcpPermissionOption[],
  decision: PermissionDecision,
): AcpPermissionOption | undefined {
  if (options.length === 0) return undefined;
  const prefers = (option: AcpPermissionOption): boolean => {
    const kind = (option.kind ?? "").toLowerCase();
    const name = (option.name ?? "").toLowerCase();
    if (decision === "allow") {
      return kind.includes("allow") || name.includes("allow") || name.includes("yes");
    }
    return kind.includes("reject") || kind.includes("deny") || name.includes("no");
  };
  return options.find(prefers) ?? options[0];
}

function normalizeStopReason(reason: string | undefined): AcpStopReason {
  switch (reason) {
    case "max_tokens":
      return "max_tokens";
    case "max_turn_requests":
      return "max_turn_requests";
    case "refusal":
      return "refusal";
    case "cancelled":
      return "cancelled";
    default:
      return "end_turn";
  }
}
