# Click

An AI coding agent for VS Code whose whole reason for existing is the **review
experience**: when the agent edits a file, the change is shown **in the file** —
incoming lines tinted, the replaced lines shown above them — and you keep it or
revert it.

It runs on **any model provider**. The agent is [OpenCode](https://opencode.ai),
reached over the Agent Client Protocol (`opencode acp`), so its tool loop, model
access and MCP servers come from OpenCode and this project owns only the UI.

```
Click extension (VS Code)
  ├─ chat panel (webview, shared with the Electron shell)
  ├─ inline diff review        ← the feature this project exists for
  └─ AcpProvider               ← spawns `opencode acp`
        │ ACP over stdio
        ▼
   opencode acp  ──►  models, tools, MCP servers, sessions
```

## The review experience

The agent writes first and reports second (OpenCode writes directly to disk —
verified), so **keep** is a no-op and **revert** restores the file through a
`WorkspaceEdit`, landing on the normal undo stack. That is the same model Cursor
uses: the edit is applied, and review is the chance to take it back.

| Command | Does |
| --- | --- |
| `Click: Keep Edits` | accept the review on the active file |
| `Click: Revert Edits` | restore that file exactly as it was |
| `Click: Keep All Edits` | accept everything pending |
| `Click: Revert All Edits` | restore every pending file |

## Attaching context

| How | What it does |
| --- | --- |
| `@` in the composer | picks a file or folder from the workspace |
| `Ctrl+L` | adds the selection, or the whole file when nothing is selected |
| paste | attaches an image |

A selection is inlined into the prompt, because those exact lines are the point.
A file or folder is only *named* — the agent can open it with its own tools, and
inlining whole files would blow the context window for no benefit.

Images go through as image content blocks, which every wire protocol maps
(`openaiCompatible`, `openaiResponses`, `anthropic`, `google`). PDF, Word and
Excel are **not** supported: models take text and images, not binary documents.

## Modes

| Mode | Tools | Behaviour |
| --- | --- | --- |
| Agent | all | carries the task through, edits files |
| Plan | read, list, search | investigates, returns a plan, **no edits** |
| Ask | read, list, search | answers questions, cites files, **no edits** |

A mode is a tool allow-list plus instructions, so the model cannot edit in Plan
or Ask even if it tries — it is not merely a prompt hint.

## Project rules

`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `CLICK.md` and the rule directories
`.cursor/rules`, `.click/rules`, `.github/instructions` are read from the
workspace (and up to two parent directories) and appended to the system prompt.
Nearest file last, so the closest one wins.

## Layout

```
apps/vscode-extension   the product: chat panel, inline review, commands
apps/web                the renderer, shared with the Electron shell
apps/gateway            OpenAI-compatible front door for the provider layer
apps/desktop            an Electron shell for the renderer
packages/contracts      messages, stream events, errors, settings
packages/provider-core  the ChatProvider contract, registry, SSE/tool-call helpers
packages/providers      the provider implementations and wire protocols
packages/provider-acp   the ACP client, and the agent presets built on it
packages/agent-core     the agent loop, workspace confinement, tools, modes
packages/config         ~/.click/settings.json
packages/runtime        wires a provider and the agent loop into one turn
packages/bridge         the IPC contract shared by every host
packages/click-cli      the `click` command
```

Two rules hold this together: the renderer never touches the filesystem or a
provider directly — everything goes through `ClickBridge` — and every provider
surfaces as one `ChatProvider` (`id`, `descriptor`, `listModels`, `check`,
`stream`, `dispose`).

## Build and test

```bash
pnpm install
pnpm typecheck
pnpm test                                  # unit tests

pnpm --filter click-agent build:all        # webview, then the extension host
pnpm --filter click-agent test:vscode      # tests inside a real VS Code
```

`test:vscode` uses the VS Code already installed on the machine rather than
downloading another copy. **Clear `ELECTRON_RUN_AS_NODE` first** if it is set in
your environment, or `Code.exe` starts as plain Node and rejects every flag.

To run the extension during development:

```bash
code --extensionDevelopmentPath="$PWD/apps/vscode-extension" <folder>
```

## Configuration

`~/.click/settings.json` is the single source of truth, read by the extension,
the CLI and the gateway alike. The only thing you normally set by hand is the
API key:

```
Click: Set OpenCode Go API Key
```

Everything else — base URL, the model list, each model's wire protocol, effort
levels — is derived, and the model list is fetched live from OpenCode's registry
so preview models appear and disappear without a code change.

## Status

Working and tested: the agent runs over ACP, edits are reviewed in the file,
`@` mentions, `Ctrl+L`, image paste, modes, effort, project rules.

Not done: the MCP settings page (OpenCode owns MCP, so this would be a thin
editor over its config), and PDF/Word/Excel attachments (needs text extraction).

`LICENSE` — see the file.
