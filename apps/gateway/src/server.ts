import http from "node:http";
import type { AddressInfo } from "node:net";
import { loadSettings, mergeProviderConfigs, readEditorProviders } from "@click/config";
import { type ChatProvider } from "@click/provider-core";
import { createProviderRegistry, providerContext } from "@click/runtime";
import {
  SSE_DONE,
  chunkFrame,
  finishReasonFor,
  qualifyModelId,
  sseFrame,
  splitModelId,
  toolCallDelta,
  toChatRequest,
  type OpenAiChatRequest,
} from "./wire.js";

export interface GatewayOptions {
  host?: string;
  port?: number;
  /** Workspace the ACP providers treat as their confinement root. */
  workspaceDir?: string;
  /**
   * Provider that catches requests whose model id is not namespaced — e.g. a
   * client that sends `gpt-5.1` rather than `opencode/gpt-5.1`. Defaults to
   * the CLICK_GATEWAY_DEFAULT_PROVIDER environment variable.
   */
  defaultProvider?: string;
  log?: (message: string) => void;
}

export interface GatewayHandle {
  readonly url: string;
  readonly port: number;
  refresh(): Promise<void>;
  close(): Promise<void>;
}

interface Catalogue {
  providers: Map<string, ChatProvider>;
  skipped: Array<{ id: string; reason: string }>;
}

const DEFAULT_PORT = 8787;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
  });
  res.end(payload);
}

function errorBody(message: string, type = "invalid_request_error"): unknown {
  return { error: { message, type, code: null, param: null } };
}

/** The API key a client supplied on this request, if any. */
function bearerToken(req: http.IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : undefined;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function createGateway(options: GatewayOptions = {}): Promise<GatewayHandle> {
  const log = options.log ?? (() => {});
  const registry = createProviderRegistry();
  // One context for the whole gateway: every provider instance (built from
  // settings or created per request from an incoming API key) shares it.
  const ctx = providerContext({ cwd: options.workspaceDir ?? process.cwd() });
  // Instances created on demand from a request's bearer token. They live only
  // until the next refresh/close, which keeps a client-supplied key from
  // being cached anywhere on disk.
  const ephemeral = new Set<ChatProvider>();
  let catalogue: Catalogue = { providers: new Map(), skipped: [] };

  async function refresh(): Promise<void> {
    const previous = Array.from(catalogue.providers.values());
    const settings = await loadSettings();
    // Providers the user configured in the editor's own settings page live in
    // the workbench storage DB, not in settings.json; merge them so the page is
    // functional (see packages/config/src/editorStorage.ts).
    const editorProviders = await readEditorProviders().catch(() => ({}));
    const effective = {
      ...settings,
      providers: mergeProviderConfigs(settings.providers, editorProviders),
    };
    const report = registry.build(effective, ctx);
    catalogue = {
      providers: new Map(report.providers.map((provider) => [String(provider.id), provider])),
      skipped: report.skipped,
    };
    // Only dispose providers that were replaced or removed.
    const kept = new Set(catalogue.providers.values());
    const stale = previous.filter((provider) => !kept.has(provider));
    await registry.disposeAll(stale);
    await registry.disposeAll(Array.from(ephemeral));
    ephemeral.clear();
    log(
      `providers ready: ${Array.from(catalogue.providers.keys()).join(", ") || "(none)"}` +
        (catalogue.skipped.length > 0
          ? ` | skipped: ${catalogue.skipped.map((entry) => `${entry.id} (${entry.reason})`).join(", ")}`
          : ""),
    );
  }

  await refresh();

  /**
   * Every model Click can serve — not just the configured ones — so a client
   * that supplies its own API key still gets a full menu to choose from.
   * Models from unconfigured providers are marked `configured: false`.
   */
  async function listModels(): Promise<unknown> {
    const data: unknown[] = [];
    const created = Math.floor(Date.now() / 1000);
    for (const descriptor of registry.descriptors()) {
      const id = String(descriptor.id);
      const built = catalogue.providers.get(id);
      const named = built ? built.descriptor : descriptor;
      // A configured provider is asked for its live list — the analogue of
      // Zed's `provided_models()`, which returns the models discovered from the
      // OpenCode registry rather than a hand-written set. The declared models
      // are only a fallback for when the registry cannot be reached.
      let listed = named.models;
      if (built) {
        try {
          const live = await built.listModels();
          if (live.length > 0) listed = live;
        } catch {
          // Keep the declared list.
        }
      }
      for (const model of listed) {
        data.push({
          id: qualifyModelId(id, model.id),
          object: "model",
          created,
          owned_by: named.name,
          click: {
            provider: id,
            model: model.id,
            name: model.name,
            // The wire protocol chosen for this model (metadata, never a user
            // setting). Routing stays provider/model based; this is informational.
            protocol: model.protocol,
            context_window: model.contextWindow,
            supports_tools: model.supportsTools,
            supports_images: model.supportsImages,
            supports_thinking: model.supportsThinking,
            // Exactly the effort levels the model declares, so the picker offers
            // (and clamps to) those and nothing else. Absent means "unknown".
            effort_levels: model.effortLevels,
            supports_reasoning_toggle: model.supportsReasoningToggle === true,
            configured: built !== undefined,
          },
        });
      }
    }
    return { object: "list", data };
  }

  async function handleCompletion(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: OpenAiChatRequest;
    try {
      body = JSON.parse(await readBody(req)) as OpenAiChatRequest;
    } catch {
      json(res, 400, errorBody("Request body must be valid JSON."));
      return;
    }

    let provider: ChatProvider | undefined;
    let model: string;
    let providerId: string;
    try {
      const raw = (body.model ?? "").trim();
      let split: { provider: string; model: string };
      try {
        split = splitModelId(raw);
      } catch (error) {
        // A client that does not namespace its model ids — Cursor's BYOK path
        // sends bare names like "gpt-5.1" — still gets routed, provided a
        // default provider is configured.
        const fallback = options.defaultProvider ?? process.env.CLICK_GATEWAY_DEFAULT_PROVIDER;
        if (!fallback || !raw) throw error;
        split = { provider: fallback, model: raw };
      }
      providerId = split.provider;
      model = split.model;
      provider = catalogue.providers.get(providerId);
      if (!provider) {
        // Not configured locally — if the client sent a key, use it for this
        // request only. This is what lets a user paste their own key into the
        // editor and have it reach the upstream provider.
        const token = bearerToken(req);
        const factory = token ? registry.getFactory(providerId) : undefined;
        const created = factory ? factory.create({ type: "api-key", apiKey: token }, ctx) : null;
        if (created) {
          provider = created;
          ephemeral.add(created);
        }
      }
    } catch (error) {
      json(res, 400, errorBody(error instanceof Error ? error.message : "Invalid model id."));
      return;
    }

    if (!provider) {
      const reason = catalogue.skipped.find((entry) => entry.id === providerId)?.reason;
      json(
        res,
        404,
        errorBody(
          `Provider "${providerId}" is not available${reason ? `: ${reason}` : " (not configured)."}`,
          "model_not_found",
        ),
      );
      return;
    }

    const controller = new AbortController();
    req.on("close", () => controller.abort());
    // Request log: makes it obvious whether Cursor's chat is reaching the
    // gateway, and which provider/model it asked for.
    log(`chat -> ${providerId}/${model}${body.stream === false ? " (non-stream)" : ""}`);
    const request = { ...toChatRequest(body, providerId, model), signal: controller.signal };
    const streamId = `chatcmpl-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    const wantsStream = body.stream !== false;

    if (!wantsStream) {
      const text: string[] = [];
      const calls: Array<{ id: string; name: string; arguments: string; index: number }> = [];
      try {
        for await (const event of provider.stream(request)) {
          if (event.type === "text_delta") text.push(event.text);
          else if (event.type === "tool_call") {
            calls.push({
              index: calls.length,
              id: event.call.id,
              name: event.call.name,
              arguments:
                typeof event.call.input === "string"
                  ? event.call.input
                  : JSON.stringify(event.call.input ?? {}),
            });
          }
        }
      } catch (error) {
        log(`chat error: ${message(error)}`);
        json(res, 502, errorBody(message(error), "api_error"));
        return;
      }
      json(res, 200, {
        id: streamId,
        object: "chat.completion",
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: text.join("") || null,
              ...(calls.length > 0
                ? {
                    tool_calls: calls.map((call) => ({
                      id: call.id,
                      type: "function",
                      function: { name: call.name, arguments: call.arguments },
                    })),
                  }
                : {}),
            },
            finish_reason: calls.length > 0 ? "tool_calls" : "stop",
          },
        ],
      });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });

    let sawToolCall = false;
    let toolIndex = 0;
    try {
      res.write(sseFrame(chunkFrame(streamId, body.model, created, { role: "assistant" })));
      for await (const event of provider.stream(request)) {
        switch (event.type) {
          case "text_delta":
            res.write(sseFrame(chunkFrame(streamId, body.model, created, { content: event.text })));
            break;
          case "thinking_delta":
            res.write(
              sseFrame(chunkFrame(streamId, body.model, created, { reasoning_content: event.text })),
            );
            break;
          case "notice":
            break;
          case "tool_call":
            sawToolCall = true;
            res.write(
              sseFrame(chunkFrame(streamId, body.model, created, toolCallDelta(event.call, toolIndex))),
            );
            toolIndex += 1;
            break;
          case "usage":
            res.write(
              sseFrame({
                ...chunkFrame(streamId, body.model, created, {}),
                usage: {
                  prompt_tokens: event.usage.inputTokens,
                  completion_tokens: event.usage.outputTokens,
                  total_tokens: event.usage.inputTokens + event.usage.outputTokens,
                },
              }),
            );
            break;
          case "stop":
            res.write(
              sseFrame(
                chunkFrame(streamId, body.model, created, {}, finishReasonFor(event.reason, sawToolCall)),
              ),
            );
            break;
          case "start":
            break;
        }
      }
      res.write(SSE_DONE);
      res.end();
    } catch (error) {
      // Headers are gone; surface the failure as a stream error frame.
      log(`chat stream error: ${message(error)}`);
      res.write(sseFrame(errorBody(message(error), "api_error")));
      res.write(SSE_DONE);
      res.end();
    }
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      try {
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET,POST,OPTIONS",
            "access-control-allow-headers": "authorization,content-type",
          });
          res.end();
          return;
        }
        if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
          log(`models -> ${registry.descriptors().length} provider descriptor(s)`);
          json(res, 200, await listModels());
          return;
        }
        if (req.method === "POST" && url.pathname === "/refresh") {
          await refresh();
          json(res, 200, { ok: true, providers: Array.from(catalogue.providers.keys()) });
          return;
        }
        if (req.method === "GET" && url.pathname === "/health") {
          json(res, 200, {
            ok: catalogue.providers.size > 0,
            providers: Array.from(catalogue.providers.values()).map((provider) => ({
              id: String(provider.id),
              name: provider.descriptor.name,
              kind: provider.descriptor.kind,
              models: provider.descriptor.models.map((model) => model.id),
            })),
            skipped: catalogue.skipped,
          });
          return;
        }
        if (
          req.method === "POST" &&
          (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")
        ) {
          await handleCompletion(req, res);
          return;
        }
        json(res, 404, errorBody(`No route for ${req.method} ${url.pathname}.`, "not_found"));
      } catch (error) {
        if (!res.headersSent) json(res, 500, errorBody(message(error), "api_error"));
        else res.end();
      }
    })();
  });

  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? DEFAULT_PORT;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => resolve());
  });

  const address = server.address() as AddressInfo;

  return {
    url: `http://${host}:${address.port}/v1`,
    port: address.port,
    refresh,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await registry.disposeAll(Array.from(ephemeral));
      await registry.disposeAll(Array.from(catalogue.providers.values()));
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
