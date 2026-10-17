import {
  ModelId,
  ProviderError,
  ProviderId,
  type AcpProviderConfig,
  type ChatRequest,
  type ChatStreamEvent,
  type ModelInfo,
  type ProviderDescriptor,
  type StopReason,
} from "@click/contracts";
import { AsyncQueue, type ChatProvider, type ProviderContext, type ProviderFactory, type ProviderHealth } from "@click/provider-core";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  AcpClient,
  type AcpConfigOption,
  type AcpContentBlock,
  type AcpPermissionRequest,
  type AcpSessionUpdate,
} from "./acpClient.js";
import { loadMcpServers } from "./mcpConfig.js";

/** The config option OpenCode exposes its model catalogue under. */
const MODEL_CONFIG_ID = "model";

const DEFAULT_MODEL_ID = "default";

/**
 * Bridges an external ACP agent (Claude Code, Gemini CLI, Codex, a custom
 * binary, ...) to Click's provider interface. The agent owns its own tool loop;
 * Click relays its streamed updates and services filesystem access requests.
 */
export class AcpProvider implements ChatProvider {
  readonly id: ProviderId;
  readonly descriptor: ProviderDescriptor;
  private client: AcpClient | undefined;
  private sessionId: string | undefined;
  /** The agent's own options for this session, including the model catalogue. */
  private configOptions: AcpConfigOption[] = [];
  private permissionPolicy:
    | ((request: AcpPermissionRequest) => Promise<"allow" | "deny">)
    | undefined;

  constructor(
    id: string,
    name: string,
    private readonly config: AcpProviderConfig,
    private readonly ctx: ProviderContext,
  ) {
    this.id = ProviderId.make(id);
    this.descriptor = {
      id: this.id,
      name,
      kind: "acp",
      badge: name.slice(0, 1).toUpperCase(),
      accent: "#22c55e",
      description: `External agent over the Agent Client Protocol (${config.command})`,
      requiresApiKey: false,
      supportsCustomBaseUrl: false,
      models: [defaultModel(this.id, name)],
    };
  }

  /** Override the default allow-all permission policy (used by the desktop app). */
  setPermissionPolicy(
    handler: ((request: AcpPermissionRequest) => Promise<"allow" | "deny">) | undefined,
  ): void {
    this.permissionPolicy = handler;
  }

  /**
   * The agent's real model catalogue, read from its own config options.
   *
   * ACP gives the agent a `select` option (OpenCode uses id `model`) whose
   * `options` are every model it can run. That is the list the user should see —
   * the placeholder in the descriptor is only a fallback for an agent that
   * exposes nothing.
   */
  async listModels(): Promise<ModelInfo[]> {
    try {
      const client = await this.ensureClient();
      await this.ensureSession(client);
      const models = this.modelsFromConfig();
      return models.length > 0 ? models : this.descriptor.models;
    } catch {
      return this.descriptor.models;
    }
  }

  private modelsFromConfig(): ModelInfo[] {
    const option = this.configOptions.find((entry) => entry.id === MODEL_CONFIG_ID);
    const values = (option?.options ?? []).filter(
      (entry): entry is { value: string; name?: string } => typeof entry.value === "string",
    );
    // Put the agent's current model first, so a UI that defaults to "the first
    // model" defaults to the one the user configured rather than a free one.
    const current = typeof option?.currentValue === "string" ? option.currentValue : undefined;
    const ordered = current
      ? [...values.filter((entry) => entry.value === current), ...values.filter((entry) => entry.value !== current)]
      : values;
    return ordered.map((entry) => ({
      id: ModelId.make(entry.value),
      name: entry.name ?? entry.value,
      provider: this.id,
      supportsTools: true,
      supportsImages: true,
      supportsThinking: true,
      supportsStreaming: true,
    }));
  }

  /** The model the agent is currently set to use, if it says. */
  currentModelId(): string | undefined {
    const option = this.configOptions.find((entry) => entry.id === MODEL_CONFIG_ID);
    return typeof option?.currentValue === "string" ? option.currentValue : undefined;
  }

  async check(): Promise<ProviderHealth> {
    try {
      const client = await this.ensureClient();
      const info = client.agentInfo;
      const label = info.title ?? info.name ?? this.config.command;
      return { ok: true, detail: `Connected to ${label}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    const client = await this.ensureClient();
    const sessionId = await this.ensureSession(client);
    // Honour the model the user picked, before the turn runs.
    await this.selectModel(client, sessionId, request.model).catch(() => undefined);

    // ACP sessions keep their own history, so relay only the newest user turn —
    // but relay *all* of it: images must reach the agent, not just the text.
    const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
    const content: AcpContentBlock[] = [];
    if (lastUser) {
      for (const part of lastUser.content) {
        if (part.type === "text" && part.text.trim().length > 0) {
          content.push({ type: "text", text: part.text });
          continue;
        }
        if (part.type === "image") {
          content.push({
            type: "image",
            data: part.dataBase64,
            mimeType: part.mediaType,
          });
        }
      }
    }

    if (content.length === 0) {
      throw new ProviderError({
        kind: "invalid_request",
        provider: this.id,
        message: "ACP prompt was empty",
      });
    }

    yield { type: "start" };

    const queue = new AsyncQueue<ChatStreamEvent>();
    client.setPermissionHandler(async (permission) =>
      this.permissionPolicy ? this.permissionPolicy(permission) : "allow",
    );

    const completion = client
      .prompt(sessionId, content, {
        onUpdate: (update) => {
          for (const event of mapUpdate(update)) queue.push(event);
        },
      })
      .then((reason) => {
        queue.push({ type: "stop", reason: normalizeAcpStop(reason) });
      })
      .catch((error: unknown) => {
        queue.push({
          type: "notice",
          text: `ACP error: ${error instanceof Error ? error.message : String(error)}`,
        });
        queue.push({ type: "stop", reason: "end_turn" });
      })
      .finally(() => {
        client.setPermissionHandler(undefined);
        queue.close();
      });

    for await (const event of queue) {
      yield event;
    }
    await completion;
  }

  async dispose(): Promise<void> {
    this.client?.kill();
    this.client = undefined;
    this.sessionId = undefined;
  }

  private async ensureClient(): Promise<AcpClient> {
    if (this.client && !this.client.isClosed) return this.client;
    const root = this.rootCwd();
    this.client = await AcpClient.connect(
      {
        command: this.config.command,
        ...(this.config.args ? { args: this.config.args } : {}),
        ...(this.config.env ? { env: this.config.env } : {}),
        cwd: root,
      },
      {
        readTextFile: (filePath, line, limit) => this.readTextFile(filePath, line, limit),
        writeTextFile: (filePath, content) => this.writeTextFile(filePath, content),
      },
    );
    this.sessionId = undefined;
    return this.client;
  }

  private async ensureSession(client: AcpClient): Promise<string> {
    if (this.sessionId) return this.sessionId;
    // Servers configured in the editor's own mcp.json are handed to the agent,
    // so its tool loop can use them.
    const mcpServers = await loadMcpServers(this.rootCwd(), this.ctx.env).catch(() => []);
    // The raw result carries the agent's config options, which is where its real
    // model catalogue lives.
    const result = await client.newSessionRaw(this.rootCwd(), mcpServers);
    if (!result?.sessionId) throw new Error("Agent did not return a session id");
    this.configOptions = result.configOptions ?? [];
    this.sessionId = result.sessionId;
    return this.sessionId;
  }

  /**
   * Point the session at the requested model, if the agent offers a model option
   * and the choice differs from what it is already using. A model id we do not
   * recognise is ignored rather than fatal — the agent's own default is a
   * reasonable answer, and the placeholder id is exactly that case.
   */
  private async selectModel(client: AcpClient, sessionId: string, model: string): Promise<void> {
    if (!model || model === DEFAULT_MODEL_ID) return;
    const option = this.configOptions.find((entry) => entry.id === MODEL_CONFIG_ID);
    if (!option) return;
    if (option.currentValue === model) return;
    if (!(option.options ?? []).some((entry) => entry.value === model)) return;
    this.configOptions = await client.setConfigOption(sessionId, MODEL_CONFIG_ID, model);
  }

  private rootCwd(): string {
    return this.config.cwd ?? this.ctx.cwd ?? process.cwd();
  }

  /**
   * Resolves an agent-supplied path inside the workspace root, refusing anything
   * that escapes it. Agents are external processes, so their file requests must
   * never reach outside the folder the user opened.
   */
  private confine(filePath: string): string {
    const root = path.resolve(this.rootCwd());
    const absolute = path.resolve(root, filePath);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new ProviderError({
        kind: "invalid_request",
        provider: this.id,
        message: `Refused to access a path outside the workspace: ${filePath}`,
      });
    }
    return absolute;
  }

  private async readTextFile(filePath: string, line?: number, limit?: number): Promise<string> {
    const absolute = this.confine(filePath);
    const raw = await fs.readFile(absolute, "utf8").catch(() => "");
    if (line === undefined && limit === undefined) return raw;
    const lines = raw.split(/\r?\n/);
    const start = line !== undefined ? Math.max(0, line - 1) : 0;
    const end = limit !== undefined ? start + limit : lines.length;
    return lines.slice(start, end).join("\n");
  }

  private async writeTextFile(filePath: string, content: string): Promise<void> {
    const absolute = this.confine(filePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
  }
}

export function makeAcpFactory(definition: { id: string; name: string }): ProviderFactory {
  const providerId = ProviderId.make(definition.id);
  return {
    descriptor: {
      id: providerId,
      name: definition.name,
      kind: "acp",
      badge: definition.name.slice(0, 1).toUpperCase(),
      accent: "#22c55e",
      description: "External agent over the Agent Client Protocol.",
      requiresApiKey: false,
      supportsCustomBaseUrl: false,
      models: [defaultModel(providerId, definition.name)],
    },
    create(config, ctx) {
      if (!config || typeof config !== "object") return null;
      const typed = config as AcpProviderConfig;
      if (typed.type !== "acp") return null;
      if (typeof typed.command !== "string" || typed.command.trim().length === 0) return null;
      return new AcpProvider(definition.id, definition.name, typed, ctx);
    },
  };
}

function defaultModel(provider: ProviderId, name: string): ModelInfo {
  return {
    id: ModelId.make(DEFAULT_MODEL_ID),
    name: `${name} (agent default)`,
    provider,
    // No `contextWindow`: the agent owns the model, so we do not know its limit
    // and will not invent one. The UI omits the badge rather than lying.
    supportsTools: true,
    // Images are forwarded to the agent as ACP image content blocks.
    supportsImages: true,
    supportsThinking: true,
    supportsStreaming: true,
  };
}

function mapUpdate(update: AcpSessionUpdate): ChatStreamEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const value = update.content?.text;
      return value ? [{ type: "text_delta", text: value }] : [];
    }
    case "agent_thought_chunk": {
      const value = update.content?.text;
      return value ? [{ type: "thinking_delta", text: value }] : [];
    }
    case "tool_call":
      return [{ type: "notice", text: `⚙ ${update.title ?? update.kind ?? "tool"}` }];
    case "tool_call_update": {
      // An edit carries the exact text the agent replaced, which is what lets a
      // host show the change for review. Without it the user only sees a notice.
      const input = update.rawInput as
        | { path?: string; oldString?: string; newString?: string; content?: string }
        | undefined;
      if (update.kind === "edit" || update.kind === "write") {
        const target = update.locations?.[0]?.path;
        if (target && typeof input?.oldString === "string" && typeof input.newString === "string") {
          return [
            { type: "edit", path: target, oldString: input.oldString, newString: input.newString },
          ];
        }
        if (target && typeof input?.content === "string") {
          // A whole-file write: the "old" text is everything, so an empty
          // oldString marks it as a full replacement.
          return [{ type: "edit", path: target, oldString: "", newString: input.content }];
        }
      }
      return update.status ? [{ type: "notice", text: `⚙ ${update.status}` }] : [];
    }
    case "plan":
      return [{ type: "notice", text: "▤ plan updated" }];
    default:
      return [];
  }
}

function normalizeAcpStop(reason: string): StopReason {
  switch (reason) {
    case "max_tokens":
      return "max_tokens";
    case "cancelled":
      return "aborted";
    default:
      return "end_turn";
  }
}
