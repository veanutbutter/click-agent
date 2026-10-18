# Click Agent

Provider-agnostic AI coding agent for VS Code, with **in-file diff review** —
the feature this whole project exists for.

The agent is **OpenCode**, reached over ACP (`opencode acp`). That is deliberate:
OpenCode brings its own tool loop, model access and MCP servers, so this
extension owns only the UI — the chat panel and the review experience — rather
than reimplementing an agent.

```
Click extension (VS Code)
  ├─ chat panel (webview, shared with the Electron shell)
  ├─ inline diff review        ← review.ts + reviewModel.ts
  └─ AcpProvider               ← spawns `opencode acp`
        │ ACP over stdio
        ▼
   opencode acp  ──►  models, tools, MCP servers, sessions
```

## The review experience

When the agent edits a file, the change is shown **in the file**: incoming lines
tinted, the replaced text struck through beside them, and a status bar item
offering to keep or revert.

```
Click: Keep Edits        accept the review on the active file
Click: Revert Edits      restore that file exactly as it was
Click: Keep All Edits    accept everything pending
Click: Revert All Edits  restore every pending file
```

The agent reports an edit **before** its write reaches disk (OpenCode writes
directly to disk, and announces the edit first - verified against its ACP
stream), so the review cannot be built by reading the file and reversing the
change: at that moment the file still holds the *old* text. `resolveEdit` in
`reviewModel.ts` treats the reported substitution as the ground truth and uses
the file only for the text around it, so the before/after pair is correct
whichever side of that race it lands on. **Accept** is therefore a no-op and
**revert** restores the file through a `WorkspaceEdit`, which lands on the normal
undo stack - the same model Cursor uses.

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
Excel are **not** supported: models take text and images, not binary documents,
so those need text extraction first.

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
src/extension.ts     activation, the webview view, commands, Ctrl+L
src/host.ts          ClickBridge implementation: settings, files, chat, context
src/review.ts        the inline diff: decorations, keep/revert
src/reviewModel.ts   diff hunks + resolveEdit + reconstructBefore  (pure, tested)
src/context.ts       attached context + prompt formatting      (pure, tested)
src/testing.ts       test-only entry the extension host loads
test/vscode/         tests that run inside a real VS Code
```

The webview is `apps/web` (`agent.html` + `src/agent.tsx` +
`src/webviewBridge.ts`), shared with the Electron shell. `@` mention parsing
lives in `apps/web/src/mention.ts` and is tested independently of React.

## Build and test

```bash
pnpm --filter click-agent build:all      # webview, then the host bundle
pnpm test                                # unit tests
pnpm --filter click-agent test:vscode    # extension-host tests, in real VS Code
```

`test:vscode` uses the VS Code already installed on the machine rather than
downloading another copy. **Clear `ELECTRON_RUN_AS_NODE` first** if it is set in
your environment, or `Code.exe` starts as plain Node and rejects every flag.

## Settings

`~/.click/settings.json`, the same file the CLI and the gateway read. The only
thing you normally set by hand is the API key:

```
Click: Set OpenCode Go API Key
```

Everything else — base URL, the model list, each model's wire protocol, effort
levels — is derived, and the model list is fetched live from OpenCode's registry
so preview models appear and disappear without a code change.
