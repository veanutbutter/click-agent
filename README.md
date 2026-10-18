# Click

Click is **the in-editor AI agent, and the provider layer behind it**. You point
it at **any** model provider: a hosted API with your own key, a local server, or
an external coding agent speaking the Agent Client Protocol (ACP). Nothing talks
to a first-party backend — no account, no proxy, no vendor lock-in. Every
provider is either an endpoint you supply or a process you launch.

This repository is the extension (`apps/vscode-extension`) plus the provider
layer, agent loop, gateway and CLI that it bundles and shares. A provider is
defined once and appears everywhere.

The extension's distinguishing feature is **in-file diff review**: when the agent
edits a file, the change is shown *in the file* — incoming lines tinted, the
replaced text struck through beside them — and the user keeps or reverts it. That
review lives in `apps/vscode-extension/src/review.ts` + `reviewModel.ts`, and the
logic that decides what "revert" means is unit-tested in plain Node.

The patched Cursor fork that can embed this extension as a built-in is a
**separate project** (`IDE Project\cursor-patch`); it consumes this repository and
nothing here depends on it.

---

## Quickstart

```bash
pnpm install
pnpm test          # 251 tests across 23 files
pnpm typecheck     # tsc -b
```

Then configure at least one provider and check it can reach the network:

```bash
pnpm providers set anthropic --api-key sk-ant-...
pnpm probe
```

`probe` health-checks every configured provider and exits non-zero if any of them
is unreachable, so it doubles as a CI check.

---

## Running the agent

The agent is OpenCode over ACP, so it brings its own tool loop, models and MCP
servers; Click owns the UI.

```powershell
pnpm --filter click-agent build:all        # webview, then the extension host
pnpm --filter click-agent test:vscode      # tests inside a real VS Code

# launch it in a real VS Code. ELECTRON_RUN_AS_NODE must be cleared first, or
# Code.exe runs as plain Node and rejects every flag.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" `
  --extensionDevelopmentPath="$PWD\apps\vscode-extension" "$PWD"
```

What the extension did is logged to
`%APPDATA%\Code\logs\<session>\window1\exthost\click-agent\Click Agent.log`,
whether or not the Output panel is open.

Two other hosts run the same provider layer:

**Standalone Electron shell.** A minimal shell that runs the renderer without
the fork:

```bash
pnpm build:web
pnpm --filter @click/desktop build
pnpm --filter @click/desktop start
```

**Live development.** Run Vite with hot reload and point the shell at it:

```bash
pnpm dev:web                                   # serves http://localhost:5273
CLICK_DEV_URL=http://localhost:5273 pnpm --filter @click/desktop dev
```

The renderer also runs standalone in a plain browser (`pnpm dev:web`). With no
desktop bridge present it transparently falls back to `src/mockBridge.ts`, a
fully scripted fake — 12 providers, a demo workspace, a streaming turn with a
tool call and an approval round-trip. That makes the whole UI developable and
reviewable without Electron or any credentials.

---

## Providers

Click ships two families of provider, both first-class.

### 1. API-key providers

Give Click a key (or a base URL) and it speaks the vendor's HTTP API directly.

| id | Provider | Key |
| --- | --- | --- |
| `anthropic` | Anthropic Claude | `ANTHROPIC_API_KEY` |
| `openai` | OpenAI | `OPENAI_API_KEY` |
| `google` | Google Gemini | `GEMINI_API_KEY` | 
| `xai` | xAI Grok | `XAI_API_KEY` or `GROK_API_KEY` |
| `deepseek` | DeepSeek | `DEEPSEEK_API_KEY` |
| `mistral` | Mistral | `MISTRAL_API_KEY` |
| `ollama` | Ollama (local, no key) | — |
| `openai-compatible` | Anything OpenAI-shaped | — |

Keys resolve in that order: the value stored in settings wins, then the
environment variable. So you can keep secrets in the environment and non-secret
configuration in the settings file.

```bash
# hosted
pnpm providers set openai --api-key sk-...
pnpm providers set google  --api-key AIza...

# local Ollama
pnpm providers set ollama --base-url http://localhost:11434/v1

# any OpenAI-compatible endpoint (vLLM, LM Studio, OpenRouter, a gateway, ...)
pnpm providers set openai-compatible \
  --base-url https://openrouter.ai/api/v1 \
  --api-key sk-or-... \
  --header "HTTP-Referer=https://example.com"
```

`openai-compatible` has no built-in model list — it discovers models from
`GET {base-url}/models` and uses whatever the endpoint reports.

### 2. ACP agents

Cursor-style agents are not the only option: Click can drive **any** external
coding agent that speaks the Agent Client Protocol over stdio. The agent runs as
a child process, brings its own model and its own tool loop, and Click renders
its stream.

```bash
pnpm acp
```

Bundled presets:

| id | Agent | Launches |
| --- | --- | --- |
| `claude-code` | Claude Code (ACP) | `npx -y @zed-industries/claude-code-acp` |
| `gemini-cli` | Gemini CLI | `npx -y @google/gemini-cli --experimental-acp` |
| `codex-acp` | Codex (ACP) | `npx -y @zed-industries/codex-acp` |
| `acp-custom` | Anything, including your own | you supply the command |

```bash
pnpm providers set claude-code \
  --acp-command npx --acp-arg -y --acp-arg @zed-industries/claude-code-acp
```

Because an ACP agent is a separate process, Click treats it as untrusted. Every
file the agent asks to read or write is resolved against the workspace root and
**refused** if it escapes — see `confine()` in
`packages/provider-acp/src/acpProvider.ts`. Agents can probe for a file that does
not exist, but they cannot wander outside the folder you opened.

### Choosing a model

`defaultModel` in settings is the default for new chats; the picker in the UI
overrides it per conversation, and both CLI and UI fall back sensibly when a
provider reports no model list.

---

## Settings

`~/.click/settings.json` (override the directory with `CLICK_CONFIG_DIR`):

```json
{
  "providers": {
    "anthropic": { "type": "api-key", "apiKey": "sk-ant-..." },
    "ollama": { "type": "api-key", "baseUrl": "http://localhost:11434/v1" },
    "claude-code": {
      "type": "acp",
      "command": "npx",
      "args": ["-y", "@zed-industries/claude-code-acp"]
    }
  },
  "defaultModel": { "provider": "anthropic", "model": "claude-sonnet-4-5" },
  "agent": {
    "maxIterations": 25,
    "autoApprove": false,
    "enabledTools": ["read_file", "write_file", "list_dir", "run_command"]
  }
}
```

`agent.enabledTools` is the allow-list the model may call:
`read_file`, `write_file`, `edit_file`, `list_dir`, `search`, `run_command`.
Mutating tools (`write_file`, `edit_file`, `run_command`) always ask for
approval unless `autoApprove` is on.

---

## CLI

```
click providers                          list every provider and whether it is ready
click providers set <id> --api-key K     configure an API-key provider
click providers set <id> --acp-command C configure an ACP provider
click providers remove <id>
click probe [--provider id] [--json]     health-check; exit 1 if any fail
click agent "<prompt>" [--workspace D]   run one turn in a workspace
                       [--provider id] [--model m] [--yes] [--json]
click acp                                list ACP presets and their commands
```

`--yes` auto-approves tool use. Without it, and without a TTY, mutating tools are
refused rather than silently allowed — a non-interactive run cannot mutate your
files by accident.

---

## Architecture

```
packages/contracts      Types only: messages, stream events, errors, settings
packages/provider-core  The ChatProvider contract + registry + SSE/tool-call/http helpers
packages/providers      API-key providers (Anthropic, OpenAI, Google, xAI, ...)
packages/provider-acp   ACP client (JSON-RPC over stdio) + ACP-backed provider
packages/agent-core     The agent loop, workspace confinement, and the six tools
packages/config         ~/.click/settings.json read/write, redaction
packages/runtime        Wires registry + provider + agent into one runChat() call
packages/bridge         The IPC contract shared by the desktop shell and the UI
packages/click-cli      The `click` command
apps/desktop            Electron main + preload (owns the filesystem and the agent)
apps/vscode-extension   The product: the in-editor agent and in-file diff review
apps/gateway            OpenAI-compatible front door for every provider
apps/web                React + CodeMirror renderer (the extension's webview)
```

The layering matters, and there is one rule behind it: **the renderer never
touches the filesystem or a provider directly.** Everything it does goes through
`ClickBridge` (in `packages/bridge`), which the Electron main process implements.
That keeps the security boundary in one place — path confinement, the tool
allow-list, and approval decisions all live on the trusted side.

The second rule is that **every provider looks the same from above.** A hosted
API and a spawned ACP agent both surface as one `ChatProvider`:

```ts
interface ChatProvider {
  id: string;
  descriptor: ProviderDescriptor;
  listModels(): Promise<ModelInfo[]>;
  check(): Promise<ProviderHealth>;
  stream(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
  dispose(): Promise<void>;
}
```

Adding a provider means writing one of these and registering it. Nothing in the
agent loop, the CLI, or the UI changes. The two implementations differ only in
transport: HTTP + SSE for API keys, JSON-RPC over a child process's stdio for ACP.

The one asymmetry is deliberate: an ACP agent runs **its own** tool loop, so
Click disables its own tools and runs a single turn when driving one (see the
`isAcp` branch in `packages/agent-core/src/agent.ts`). The agent's tool activity
still reaches the UI — as `notice` events — rather than being silently dropped.

---

## Testing

```bash
pnpm test           # once
pnpm test:watch
```

251 tests. The suite covers the parts where being wrong is expensive:

- **In-file diff review** — what "revert" restores, and the race that matters:
  an ACP agent announces an edit *before* its write lands, so the review is
  resolved from the reported substitution rather than from the file alone. The
  extension-host suite (`pnpm --filter click-agent test:vscode`) drives the
  review layer inside a real VS Code.
- **Streaming and parsing** — SSE frame splitting across chunk boundaries,
  multi-line `data:`, streamed tool-call fragments reassembled into one call.
- **Provider request shapes** — asserted against a fake `fetch`, including exact
  URLs, auth headers, and bodies for OpenAI-compatible, Anthropic, and Google.
- **The agent loop** — a scripted fake provider drives real tool execution:
  approval is requested only for mutating tools, denial blocks the write, tool
  output is fed back, `maxIterations` stops the loop, and an ACP provider is
  driven with `tools: []` in a single turn.
- **Workspace confinement** — escapes are rejected, at both the tool layer and
  the ACP file layer.
- **ACP end-to-end** — the suite spawns a real mock ACP agent
  (`packages/provider-acp/test/fixtures/mock-agent.ts`, runnable on its own with
  `pnpm acp:mock`) and exercises the initialize handshake, streaming, tool
  visibility, permission requests, and file-access confinement over an actual
  child process and a real JSON-RPC pipe.

`pnpm probe` is the other half: it verifies the environment rather than the code,
confirming each configured provider actually authenticates and lists models.

---

## Notes

- Node 20+ and pnpm 9.
- The renderer build warns about a >500 kB chunk (CodeMirror). It is a warning,
  not a problem; the bundle is ~328 kB gzipped.
- `pnpm dev:desktop` runs `tsc -b` before launching Electron, so the shell is
  always running compiled output.
