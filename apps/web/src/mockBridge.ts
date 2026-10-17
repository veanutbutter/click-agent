import type {
  ApprovalRequestMessage,
  ChatContextItem,
  ChatEventEnvelope,
  ChatStartRequest,
  ChatStreamMessage,
  ClickBridge,
  ClickSettings,
  FileNode,
  ProviderSummary,
  WorkspaceInfo,
} from "@click/bridge";
import {
  ModelId,
  ProviderId,
  defaultSettings,
  normalizeSettings,
} from "@click/contracts";
import type { ModelInfo, ProviderConfig, ProviderKind } from "@click/contracts";

/**
 * An in-browser stand-in for the desktop preload bridge, so `pnpm dev:web` gives
 * a fully explorable UI in a normal browser. Nothing here touches the disk; the
 * file tree and chat are scripted, but every bridge member behaves like the real
 * thing: async, cancellable and event-driven.
 */

const MOCK_VERSION = "0.1.0-mock";
const SETTINGS_STORAGE_KEY = "click.mock.settings";
const ROOT = "/Users/dev/click-demo";

// ---------------------------------------------------------------------------
// Scripted workspace
// ---------------------------------------------------------------------------

let mockContext: ChatContextItem[] = [];

const FILES: Record<string, string> = {
  [`${ROOT}/.gitignore`]: ["node_modules", "dist", "*.log", ".env", ""].join("\n"),
  [`${ROOT}/README.md`]: [
    "# click-demo",
    "",
    "A tiny HTTP service used to exercise the Click agent panel.",
    "",
    "## Scripts",
    "",
    "- `pnpm start` — run the server on `PORT` (default `5273`).",
    "- `pnpm test` — run the unit tests.",
    "",
    "## Layout",
    "",
    "- `src/index.ts` — entry point.",
    "- `src/server.ts` — request handling.",
    "- `src/utils/format.ts` — logging helpers.",
    "",
  ].join("\n"),
  [`${ROOT}/package.json`]: [
    "{",
    '  "name": "click-demo",',
    '  "private": true,',
    '  "type": "module",',
    '  "scripts": { "start": "node dist/index.js", "test": "node --test" }',
    "}",
    "",
  ].join("\n"),
  [`${ROOT}/tsconfig.json`]: [
    "{",
    '  "compilerOptions": {',
    '    "target": "ES2022",',
    '    "module": "NodeNext",',
    '    "strict": true,',
    '    "outDir": "dist"',
    "  },",
    '  "include": ["src"]',
    "}",
    "",
  ].join("\n"),
  [`${ROOT}/src/index.ts`]: [
    'import { createServer } from "./server";',
    'import { formatRequest } from "./utils/format";',
    "",
    'const PORT = Number(process.env["PORT"] ?? 5273);',
    "",
    "const server = createServer({",
    "  onRequest: (request) => {",
    "    console.log(formatRequest(request));",
    '    return { status: 200, body: "ok" };',
    "  },",
    "});",
    "",
    "server.listen(PORT, () => {",
    "  console.log(`listening on :${PORT}`);",
    "});",
    "",
  ].join("\n"),
  [`${ROOT}/src/server.ts`]: [
    'import { createServer as createHttpServer } from "node:http";',
    "",
    "export interface RequestSummary {",
    "  method: string;",
    "  path: string;",
    "  durationMs: number;",
    "}",
    "",
    "export interface HandlerResult {",
    "  status: number;",
    "  body: string;",
    "}",
    "",
    "export interface ServerOptions {",
    "  onRequest(summary: RequestSummary): HandlerResult;",
    "}",
    "",
    "/** Wrap the handler so every route gets timing and a default 404. */",
    "export function createServer(options: ServerOptions) {",
    "  const started = Date.now();",
    "  return createHttpServer((req, res) => {",
    "    const summary: RequestSummary = {",
    '      method: req.method ?? "GET",',
    '      path: req.url ?? "/",',
    "      durationMs: Date.now() - started,",
    "    };",
    "    const result = options.onRequest(summary);",
    "    res.writeHead(result.status, { \"content-type\": \"text/plain\" });",
    "    res.end(result.body);",
    "  });",
    "}",
    "",
  ].join("\n"),
  [`${ROOT}/src/utils/format.ts`]: [
    'import type { RequestSummary } from "../server";',
    "",
    "export function formatRequest(summary: RequestSummary): string {",
    '  const ms = `${summary.durationMs}ms`;',
    "  return `${summary.method} ${summary.path} — ${ms}`;",
    "}",
    "",
    "export function shortPath(value: string, max = 48): string {",
    "  return value.length <= max ? value : `…${value.slice(value.length - max)}`;",
    "}",
    "",
  ].join("\n"),
  [`${ROOT}/docs/architecture.md`]: [
    "# Architecture",
    "",
    "```",
    "client ──▶ src/server.ts ──▶ onRequest handler",
    "                 │",
    "                 └──▶ src/utils/format.ts (logging)",
    "```",
    "",
    "The server is intentionally synchronous per request so the tests stay deterministic.",
    "",
  ].join("\n"),
  [`${ROOT}/assets/logo.svg`]: [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="click-demo">',
    '  <rect width="32" height="32" rx="8" fill="#4fd1b5" />',
    '  <path d="M12 10h8M12 16h8M12 22h5" stroke="#0d0f13" stroke-width="2.5" stroke-linecap="round" />',
    "</svg>",
    "",
  ].join("\n"),
};

const DIRECTORIES: Record<string, string[]> = {
  [ROOT]: [".gitignore", "README.md", "package.json", "tsconfig.json", "src", "docs", "assets"],
  [`${ROOT}/src`]: ["index.ts", "server.ts", "utils"],
  [`${ROOT}/src/utils`]: ["format.ts"],
  [`${ROOT}/docs`]: ["architecture.md"],
  [`${ROOT}/assets`]: ["logo.svg"],
};

const MOCK_WORKSPACE: WorkspaceInfo = { root: ROOT, name: "click-demo" };

// ---------------------------------------------------------------------------
// Provider catalogue
// ---------------------------------------------------------------------------

interface CapabilitySeed {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens?: number;
  tools?: boolean;
  images?: boolean;
  thinking?: boolean;
  streaming?: boolean;
  deprecated?: boolean;
}

function buildModels(provider: string, seeds: CapabilitySeed[]): ModelInfo[] {
  return seeds.map((seed) => ({
    id: ModelId.make(seed.id),
    name: seed.name,
    provider: ProviderId.make(provider),
    contextWindow: seed.contextWindow,
    ...(seed.maxOutputTokens === undefined ? {} : { maxOutputTokens: seed.maxOutputTokens }),
    supportsTools: seed.tools ?? true,
    supportsImages: seed.images ?? false,
    supportsThinking: seed.thinking ?? false,
    supportsStreaming: seed.streaming ?? true,
    ...(seed.deprecated ? { deprecated: true } : {}),
  }));
}

interface ProviderSeed {
  id: string;
  name: string;
  kind: ProviderKind;
  badge: string;
  accent: string;
  description: string;
  /** Pre-configured out of the box, simulating keys in the environment. */
  preset: boolean;
  missingReason?: string;
  models: CapabilitySeed[];
}

const PROVIDER_SEEDS: ProviderSeed[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    kind: "api-key",
    badge: "A",
    accent: "#d97757",
    description: "Claude models over the Messages API. Reads ANTHROPIC_API_KEY when no key is set here.",
    preset: true,
    models: [
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200_000, maxOutputTokens: 64_000, images: true, thinking: true },
      { id: "claude-opus-4-1", name: "Claude Opus 4.1", contextWindow: 200_000, maxOutputTokens: 32_000, images: true, thinking: true },
      { id: "claude-haiku-3-5", name: "Claude Haiku 3.5", contextWindow: 200_000, images: true },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    kind: "api-key",
    badge: "O",
    accent: "#10a37f",
    description: "GPT and reasoning models over the Responses API.",
    preset: true,
    models: [
      { id: "gpt-5.1", name: "GPT-5.1", contextWindow: 400_000, maxOutputTokens: 128_000, images: true, thinking: true },
      { id: "gpt-5.1-mini", name: "GPT-5.1 mini", contextWindow: 400_000, images: true, thinking: true },
      { id: "o4-mini", name: "o4-mini", contextWindow: 200_000, thinking: true },
    ],
  },
  {
    id: "google",
    name: "Google AI",
    kind: "api-key",
    badge: "G",
    accent: "#4285f4",
    description: "Gemini models via Google AI Studio. A Gemini key is required.",
    preset: false,
    missingReason: "No API key stored. Add one in Settings, or export GOOGLE_API_KEY.",
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1_048_576, images: true, thinking: true },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1_048_576, images: true, thinking: true },
    ],
  },
  {
    id: "xai",
    name: "xAI",
    kind: "api-key",
    badge: "X",
    accent: "#b9c2cf",
    description: "Grok models. Long context, cheap tool calling.",
    preset: false,
    missingReason: "No API key stored. Add one in Settings.",
    models: [
      { id: "grok-4", name: "Grok 4", contextWindow: 256_000, images: true, thinking: true },
      { id: "grok-4-fast", name: "Grok 4 Fast", contextWindow: 2_000_000, thinking: true },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    kind: "api-key",
    badge: "D",
    accent: "#4d6bfe",
    description: "DeepSeek V4.1 chat and reasoner models.",
    preset: true,
    models: [
      { id: "deepseek-v4.1", name: "DeepSeek V4.1", contextWindow: 128_000, thinking: true },
      { id: "deepseek-v4.1-reasoner", name: "DeepSeek V4.1 Reasoner", contextWindow: 128_000, thinking: true },
    ],
  },
  {
    id: "mistral",
    name: "Mistral",
    kind: "api-key",
    badge: "M",
    accent: "#ff7000",
    description: "Mistral and Codestral models.",
    preset: false,
    missingReason: "No API key stored. Add one in Settings, or export MISTRAL_API_KEY.",
    models: [
      { id: "mistral-large-3", name: "Mistral Large 3", contextWindow: 256_000 },
      { id: "codestral-2", name: "Codestral 2", contextWindow: 256_000 },
    ],
  },
  {
    id: "ollama",
    name: "Ollama",
    kind: "api-key",
    badge: "L",
    accent: "#9aa7b8",
    description: "Local models served by Ollama on 127.0.0.1:11434. No key needed.",
    preset: true,
    models: [
      { id: "qwen2.5-coder:32b", name: "Qwen2.5 Coder 32B", contextWindow: 32_768, tools: true },
      { id: "llama3.3:70b", name: "Llama 3.3 70B", contextWindow: 131_072, tools: false },
    ],
  },
  {
    id: "openai-compatible",
    name: "OpenAI-compatible gateway",
    kind: "api-key",
    badge: "+",
    accent: "#7cc4f8",
    description: "Any OpenAI-shaped endpoint — LiteLLM, OpenRouter, vLLM, a corporate gateway.",
    preset: true,
    models: [
      { id: "gateway/gpt-4o-mini", name: "gateway/gpt-4o-mini", contextWindow: 128_000, images: true },
      { id: "local/qwen2.5-coder-7b", name: "local/qwen2.5-coder-7b", contextWindow: 32_768, tools: true, streaming: false },
    ],
  },
  {
    id: "claude-code",
    name: "Claude Code (ACP)",
    kind: "acp",
    badge: "C",
    accent: "#d97757",
    description: "Drive the Claude Code agent over the Agent Client Protocol.",
    preset: true,
    models: [
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200_000, images: true, thinking: true },
      { id: "claude-opus-4-1", name: "Claude Opus 4.1", contextWindow: 200_000, images: true, thinking: true },
    ],
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI (ACP)",
    kind: "acp",
    badge: "g",
    accent: "#4285f4",
    description: "Google's terminal agent, spoken to over ACP.",
    preset: false,
    missingReason: "Command not found on PATH: gemini. Set the executable in Settings.",
    models: [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1_048_576, images: true, thinking: true }],
  },
  {
    id: "codex",
    name: "Codex ACP",
    kind: "acp",
    badge: "K",
    accent: "#10a37f",
    description: "An ACP adapter around an OpenAI Codex-style agent.",
    preset: false,
    missingReason: "Command not found on PATH: codex-acp. Set the executable in Settings.",
    models: [{ id: "gpt-5.1-codex", name: "GPT-5.1 Codex", contextWindow: 400_000, thinking: true }],
  },
  {
    id: "custom-acp",
    name: "Custom ACP agent",
    kind: "acp",
    badge: "*",
    accent: "#4fd1b5",
    description: "Point Click at any executable that speaks the Agent Client Protocol over stdio.",
    preset: false,
    missingReason: "No command configured. Add one in Settings.",
    models: [{ id: "custom-agent", name: "Agent default model", contextWindow: 128_000, thinking: true }],
  },
];

const BUILDERS = new Map<string, ModelInfo[]>();
for (const seed of PROVIDER_SEEDS) {
  BUILDERS.set(seed.id, buildModels(seed.id, seed.models));
}

// ---------------------------------------------------------------------------
// Settings persistence (module-level + localStorage)
// ---------------------------------------------------------------------------

let settingsCache: ClickSettings | null = null;

function readStoredSettings(): ClickSettings {
  if (settingsCache) return settingsCache;
  const fallback = defaultSettings();
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    parsed = raw === null ? undefined : JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  settingsCache =
    typeof parsed === "object" && parsed !== null
      ? normalizeSettings(parsed as Partial<ClickSettings>)
      : fallback;
  return settingsCache;
}

function writeStoredSettings(settings: ClickSettings): void {
  settingsCache = settings;
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (private mode, quota); the cache still works.
  }
}

function isProviderConfigured(id: string, kind: ProviderKind, settings: ClickSettings): boolean {
  const config: ProviderConfig | undefined = settings.providers[id];
  if (!config) return false;
  if (config.type === "acp") return config.command.trim().length > 0;
  return typeof config.apiKey === "string" && config.apiKey.trim().length > 0;
}

function summarizeProvider(seed: ProviderSeed, settings: ClickSettings): ProviderSummary {
  const configured = seed.preset || isProviderConfigured(seed.id, seed.kind, settings);
  const models = BUILDERS.get(seed.id) ?? [];
  return {
    id: seed.id,
    name: seed.name,
    kind: seed.kind,
    badge: seed.badge,
    accent: seed.accent,
    description: seed.description,
    configured,
    ...(configured
      ? {}
      : {
          reason:
            seed.missingReason ??
            (seed.kind === "acp"
              ? "No command configured. Add one in Settings."
              : "No API key stored. Add one in Settings."),
        }),
    models,
  };
}

// ---------------------------------------------------------------------------
// Scripted chat
// ---------------------------------------------------------------------------

const CANCELLED: unique symbol = Symbol("click.mock.cancelled");

interface MockRun {
  requestId: string;
  cancelled: boolean;
  cancelFns: Set<() => void>;
  providerId: string;
  model: string;
}

const runs = new Map<string, MockRun>();
const chatHandlers = new Set<(payload: ChatEventEnvelope) => void>();
const approvalHandlers = new Set<(payload: ApprovalRequestMessage) => void>();
const pendingApprovals = new Map<string, (approved: boolean) => void>();

let toolSeq = 0;
let approvalSeq = 0;

function deliver(requestId: string, event: ChatStreamMessage): void {
  const envelope: ChatEventEnvelope = { requestId, event };
  for (const handler of chatHandlers) handler(envelope);
}

/** Send an event only while the run is still live. */
function emit(run: MockRun, event: ChatStreamMessage): void {
  if (run.cancelled) return;
  if (runs.get(run.requestId) !== run) return;
  deliver(run.requestId, event);
}

function sleep(run: MockRun, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (run.cancelled) {
      reject(CANCELLED);
      return;
    }
    let timer = 0;
    const cancel = (): void => {
      window.clearTimeout(timer);
      run.cancelFns.delete(cancel);
      reject(CANCELLED);
    };
    timer = window.setTimeout(() => {
      run.cancelFns.delete(cancel);
      resolve();
    }, ms);
    run.cancelFns.add(cancel);
  });
}

function settleApprovals(prefix: string, approved: boolean): void {
  for (const [key, resolve] of [...pendingApprovals]) {
    if (key.startsWith(prefix)) {
      pendingApprovals.delete(key);
      resolve(approved);
    }
  }
}

async function askForApproval(
  run: MockRun,
  tool: string,
  description: string,
  input: Record<string, unknown>,
): Promise<boolean> {
  approvalSeq += 1;
  const key = `mock_approval_${run.requestId}_${approvalSeq}`;
  return new Promise<boolean>((resolve) => {
    pendingApprovals.set(key, resolve);
    const payload: ApprovalRequestMessage = { requestId: key, tool, description, input };
    for (const handler of approvalHandlers) handler(payload);
  });
}

function shortenPrompt(prompt: string): string {
  const single = prompt.replace(/\s+/g, " ").trim();
  return single.length <= 64 ? single : `${single.slice(0, 64)}…`;
}

async function runTurn(request: ChatStartRequest, run: MockRun): Promise<void> {
  const providerId = run.providerId;
  const kind = PROVIDER_SEEDS.find((seed) => seed.id === providerId)?.kind ?? "api-key";
  const filePath = `${ROOT}/src/index.ts`;
  const source = FILES[filePath] ?? "(file is empty)";
  toolSeq += 1;
  const toolId = `mock_tool_${toolSeq}`;

  try {
    emit(run, { type: "iteration_start", iteration: 1 });
    await sleep(run, 240);

    if (kind === "acp") {
      emit(run, { type: "notice", text: `acp · session started (${run.model})` });
      await sleep(run, 180);
    }

    for (const chunk of [
      "Let me look at the entry point before answering.",
      " The prompt points at the request path, so `src/index.ts` is the right place to start.",
    ]) {
      emit(run, { type: "thinking", text: chunk });
      await sleep(run, 260);
    }

    emit(run, { type: "tool_start", id: toolId, tool: "read_file", input: { path: filePath } });
    await sleep(run, 320);

    let approved = true;
    if (!request.autoApprove) {
      if (kind === "acp") {
        emit(run, { type: "notice", text: `acp · permission requested for read_file` });
      }
      approved = await askForApproval(run, "read_file", `Read ${filePath} from the workspace`, {
        path: filePath,
      });
    }

    if (!approved) {
      emit(run, {
        type: "tool_end",
        id: toolId,
        tool: "read_file",
        result: "Denied by the user. The file was not read.",
        isError: true,
      });
      emit(run, {
        type: "text",
        text: "You denied the `read_file` call, so I stopped there. Re-run with auto-approve on, or approve the tool next time and I will continue.",
      });
      emit(run, { type: "usage", usage: { inputTokens: 512, outputTokens: 64, cachedInputTokens: 128 } });
      emit(run, { type: "done", ok: true, reason: "completed", providerId, model: run.model });
      return;
    }

    emit(run, {
      type: "tool_end",
      id: toolId,
      tool: "read_file",
      result: source.slice(0, 900),
      isError: false,
    });
    await sleep(run, 220);

    for (const chunk of [
      `I read \`src/index.ts\` while working on “${shortenPrompt(request.prompt)}”.`,
      " It creates the server with `createServer`, funnels every request through `formatRequest`, and listens on `PORT` (5273 by default).",
      "\n\nHere is the change I would make:\n\n1. Extract the inline handler into a named `handleRequest` function in `src/server.ts`.\n2. Add a `--watch` flag that restarts the listener on file changes.\n3. Cover the 200 response with a test so the refactor stays honest.\n\nSay the word and I will apply it (I will ask before writing files).",
    ]) {
      emit(run, { type: "text", text: chunk });
      await sleep(run, 300);
    }

    emit(run, {
      type: "usage",
      usage: { inputTokens: 3_482, outputTokens: 412, cachedInputTokens: 2_048 },
    });
    await sleep(run, 160);
    emit(run, { type: "done", ok: true, reason: "completed", providerId, model: run.model });
  } catch (error) {
    if (error === CANCELLED) return;
    emit(run, {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      kind: "unknown",
    });
    emit(run, { type: "done", ok: false, reason: "error", providerId, model: run.model });
  } finally {
    if (runs.get(run.requestId) === run) runs.delete(run.requestId);
  }
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

function mockPlatform(): string {
  if (typeof navigator === "undefined") return "web";
  return navigator.platform.length > 0 ? navigator.platform : "web";
}

export function createMockBridge(): ClickBridge {
  const bridge: ClickBridge = {
    platform: mockPlatform(),
    version: MOCK_VERSION,

    getSettings(): Promise<ClickSettings> {
      return Promise.resolve(readStoredSettings());
    },

    saveSettings(settings: ClickSettings): Promise<ClickSettings> {
      writeStoredSettings(settings);
      // The real bridge normalizes on the way out; echoing keeps the renderer honest.
      return Promise.resolve(settings);
    },

    listProviders(): Promise<ProviderSummary[]> {
      const settings = readStoredSettings();
      return Promise.resolve(PROVIDER_SEEDS.map((seed) => summarizeProvider(seed, settings)));
    },

    chooseWorkspace(): Promise<WorkspaceInfo | null> {
      return new Promise((resolve) => {
        window.setTimeout(() => resolve(MOCK_WORKSPACE), 220);
      });
    },

    openWorkspace(root: string): Promise<WorkspaceInfo> {
      return Promise.resolve(
        Object.hasOwn(DIRECTORIES, root)
          ? { root, name: baseNameOf(root) }
          : { root: MOCK_WORKSPACE.root, name: MOCK_WORKSPACE.name },
      );
    },

    readFile(filePath: string): Promise<string> {
      const content = FILES[filePath];
      if (content === undefined) {
        return Promise.reject(new Error(`Mock bridge: no such file in the demo workspace: ${filePath}`));
      }
      return new Promise((resolve) => {
        window.setTimeout(() => resolve(content), 120);
      });
    },

    writeFile(filePath: string, content: string): Promise<void> {
      FILES[filePath] = content;
      return new Promise((resolve) => {
        window.setTimeout(() => resolve(), 160);
      });
    },

    listFiles(): Promise<string[]> {
      return Promise.resolve(Object.keys(FILES).map((file) => file.replace(/^mock:/, "")));
      },

    addContext(item: ChatContextItem): Promise<ChatContextItem[]> {
      mockContext = [...mockContext.filter((entry) => entry.path !== item.path), item];
      return Promise.resolve([...mockContext]);
      },

    getContext(): Promise<ChatContextItem[]> {
      return Promise.resolve([...mockContext]);
      },

    clearContext(): Promise<ChatContextItem[]> {
      mockContext = [];
      return Promise.resolve([]);
      },

    listDir(dirPath: string): Promise<FileNode[]> {
      const names = DIRECTORIES[dirPath];
      if (!names) {
        return Promise.reject(new Error(`Mock bridge: not a directory: ${dirPath}`));
      }
      const nodes = names.map<FileNode>((name) => {
        const childPath = `${dirPath}/${name}`;
        return {
          name,
          path: childPath,
          type: Object.hasOwn(DIRECTORIES, childPath) ? "directory" : "file",
        };
      });
      return new Promise((resolve) => {
        window.setTimeout(() => resolve(nodes), 90);
      });
    },

    startChat(request: ChatStartRequest): Promise<void> {
      const fallback = defaultModelFromSettings(readStoredSettings());
      const run: MockRun = {
        requestId: request.requestId,
        cancelled: false,
        cancelFns: new Set(),
        providerId: request.providerId ?? fallback.providerId,
        model: request.model ?? fallback.model,
      };
      runs.set(request.requestId, run);
      void runTurn(request, run);
      return Promise.resolve();
    },

    cancelChat(requestId: string): Promise<void> {
      const run = runs.get(requestId);
      if (!run) return Promise.resolve();
      run.cancelled = true;
      settleApprovals(`mock_approval_${requestId}_`, false);
      for (const cancel of [...run.cancelFns]) cancel();
      run.cancelFns.clear();
      runs.delete(requestId);
      // Emitted outside the liveness guard: the run is gone by design here.
      deliver(requestId, {
        type: "done",
        ok: false,
        reason: "aborted",
        providerId: run.providerId,
        model: run.model,
      });
      return Promise.resolve();
    },

    respondApproval(response): Promise<void> {
      const resolve = pendingApprovals.get(response.requestId);
      if (resolve) {
        pendingApprovals.delete(response.requestId);
        resolve(response.approved);
      }
      return Promise.resolve();
    },

    openExternal(url: string): Promise<void> {
      if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
      return Promise.resolve();
    },

    onChatEvent(handler: (payload: ChatEventEnvelope) => void): () => void {
      chatHandlers.add(handler);
      return () => {
        chatHandlers.delete(handler);
      };
    },

    onApprovalRequest(handler: (payload: ApprovalRequestMessage) => void): () => void {
      approvalHandlers.add(handler);
      return () => {
        approvalHandlers.delete(handler);
      };
    },
  };

  return bridge;
}

function baseNameOf(root: string): string {
  const parts = root.split("/").filter((part) => part.length > 0);
  return parts.length > 0 ? (parts[parts.length - 1] ?? root) : root;
}

function defaultModelFromSettings(settings: ClickSettings): { providerId: string; model: string } {
  const preferred = settings.defaultModel;
  if (preferred) return { providerId: String(preferred.provider), model: String(preferred.model) };
  const first = PROVIDER_SEEDS[0];
  if (!first) return { providerId: "anthropic", model: "claude-sonnet-4-5" };
  const model = BUILDERS.get(first.id)?.[0];
  return { providerId: first.id, model: model ? String(model.id) : "claude-sonnet-4-5" };
}
