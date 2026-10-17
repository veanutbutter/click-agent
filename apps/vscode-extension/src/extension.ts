import fs from "node:fs";
import * as vscode from "vscode";

import { loadSettings, setProvider } from "@click/config";
import { describeProviders, providerContext } from "@click/runtime";

import { ClickHost } from "./host.js";
import { describeContext, type ChatContextItem } from "./context.js";
import { ReviewController } from "./review.js";

/** The text of a selection, line by line, without the editor's line breaks. */
function selectedText(document: vscode.TextDocument, selection: vscode.Selection): string {
  const lines: string[] = [];
  for (let line = selection.start.line; line <= selection.end.line; line += 1) {
    const text = document.lineAt(line).text;
    if (line === selection.start.line && line === selection.end.line) {
      lines.push(text.slice(selection.start.character, selection.end.character));
    } else if (line === selection.start.line) {
      lines.push(text.slice(selection.start.character));
    } else if (line === selection.end.line) {
      lines.push(text.slice(0, selection.end.character));
    } else {
      lines.push(text);
    }
  }
  return lines.join("\n");
}

/**
 * The Click agent extension.
 *
 * It ships inside the editor fork as a built-in extension and is the only AI
 * surface in the product: Cursor's own services are stripped out, and this
 * panel drives whichever provider the user configures (`~/.click/settings.json`),
 * exactly like Zed's assistant panel or T3 Code's agent view.
 */

const VIEW_ID = "click.agent";

class ClickViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private host: ClickHost | undefined;
  private readonly pendingContext: ChatContextItem[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: { appendLine(value: string): void },
    private readonly review: ReviewController,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const distRoot = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [distRoot],
    };
    view.webview.html = this.renderHtml(view.webview, distRoot);

    const folders = vscode.workspace.workspaceFolders;
    const initial = folders && folders.length > 0 ? folders[0]?.uri.fsPath : undefined;
    const host = new ClickHost(
      {
        post: (message) => void view.webview.postMessage(message),
        // Every edit the agent makes is shown in the file for review.
        onFileEdit: (edit) => void this.review.showEdit(edit),
      },
      initial,
    );
    this.host = host;

    // Anything attached (Ctrl+L) before the panel was opened applies now.
    for (const item of this.pendingContext.splice(0)) void host.invoke("addContext", [item]);

    view.webview.onDidReceiveMessage((raw) => {
      void this.onMessage(raw);
    });

    view.onDidDispose(() => {
      host.dispose();
      if (this.host === host) this.host = undefined;
    });
  }

  /** Updates the workspace root when the user switches folder in VS Code. */
  setWorkspace(root: string): void {
    this.host?.setWorkspace(root);
  }

  /**
   * Attach context to the next message. Called by Ctrl+L, which can fire before
   * the panel has ever been opened, so anything attached before the host exists
   * is held and applied when it does.
   */
  addContext(item: ChatContextItem): void {
    if (this.host) {
      void this.host.invoke("addContext", [item]);
      return;
    }
    this.pendingContext.push(item);
  }

  /** Sends a host-originated message (e.g. "new chat") to the webview. */
  post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  focus(): void {
    this.view?.show(true);
  }

  private async onMessage(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== "object") return;
    const message = raw as { id?: unknown; method?: unknown; args?: unknown };
    if (typeof message.method !== "string") return;
    const args = Array.isArray(message.args) ? message.args : [];

    // Fire-and-forget diagnostics from the webview (no id, no reply).
    if (message.method === "log") {
      this.log.appendLine(`[webview] ${String(args[0])}`);
      return;
    }
    if (typeof message.id !== "number") return;

    const webview = this.view?.webview;
    const reply = (payload: unknown): void => {
      void webview?.postMessage({ id: message.id, ...(payload as object) });
    };

    try {
      if (message.method === "openExternal") {
        await vscode.env.openExternal(vscode.Uri.parse(String(args[0])));
        reply({ result: null });
        return;
      }
      const result = await this.host?.invoke(message.method, args);
      reply({ result: result ?? null });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.log.appendLine(`[click-agent] ${message.method} failed: ${text}`);
      reply({ error: text });
    }
  }

  private renderHtml(webview: vscode.Webview, distRoot: vscode.Uri): string {
    const htmlPath = vscode.Uri.joinPath(distRoot, "agent.html").fsPath;
    const raw = fs.readFileSync(htmlPath, "utf8");
    const withAssets = raw
      // `crossorigin` on module scripts can make the webview scheme refuse the
      // fetch; the resources are same-origin webview URIs, so drop it.
      .replace(/\s+crossorigin(="[^"]*")?/g, "")
      .replace(
        /(src|href)="\.?\/?(assets\/[^"]+)"/g,
        (_match, attr: string, rel: string) =>
          `${attr}="${webview.asWebviewUri(uriForPath(distRoot, rel))}"`,
      );
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src ${webview.cspSource}`,
      "connect-src 'none'",
    ].join("; ");
    return withAssets.replace(
      "<head>",
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
    );
  }
}

function uriForPath(distRoot: vscode.Uri, relative: string): vscode.Uri {
  const segments = relative.split("/").filter((segment) => segment.length > 0);
  return vscode.Uri.joinPath(distRoot, ...segments);
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("Click Agent");
  const review = new ReviewController(log);
  const provider = new ClickViewProvider(context.extensionUri, log, review);

  context.subscriptions.push(
    review,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("click.focusAgent", () => provider.focus()),
    vscode.commands.registerCommand("click.newChat", () => {
      provider.focus();
      provider.post({ type: "newChat" });
    }),
    vscode.commands.registerCommand("click.addToChat", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage("Click: open a file first.");
        return;
      }
      const document = editor.document;
      const selection = editor.selection;
      const folders = vscode.workspace.workspaceFolders;
      const root = folders && folders.length > 0 ? folders[0]!.uri.fsPath : undefined;
      const label = (absolute: string): string =>
        root && absolute.startsWith(root)
          ? absolute.slice(root.length).replace(/^[\\/]/, "").split("\\").join("/")
          : absolute;

      const item: ChatContextItem = selection.isEmpty
        ? { kind: "file", path: document.fileName, label: label(document.fileName) }
        : {
            kind: "selection",
            path: document.fileName,
            label: label(document.fileName),
            startLine: selection.start.line + 1,
            endLine: selection.end.line + 1,
            text: selectedText(document, selection),
          };

      provider.addContext(item);
      provider.focus();
      log.appendLine(`[click-agent] attached ${describeContext(item)}`);
    }),
    // Review actions. They act on the file in the active editor, which is the
    // file the review was shown in.
    vscode.commands.registerCommand("click.review.accept", () => {
      const file = vscode.window.activeTextEditor?.document.fileName;
      if (file) review.accept(file);
    }),
    vscode.commands.registerCommand("click.review.reject", async () => {
      const file = vscode.window.activeTextEditor?.document.fileName;
      if (file) await review.reject(file);
    }),
    vscode.commands.registerCommand("click.review.acceptAll", () => {
      const count = review.acceptAll();
      if (count > 0) void vscode.window.showInformationMessage(`Click: kept ${count} edit(s).`);
    }),
    vscode.commands.registerCommand("click.review.rejectAll", async () => {
      const count = await review.rejectAll();
      if (count > 0) void vscode.window.showInformationMessage(`Click: reverted ${count} edit(s).`);
    }),
    // Switching files must not lose the markers on the one being shown.
    vscode.window.onDidChangeActiveTextEditor((editor) => review.refresh(editor)),
    // The only setup this extension needs: one API key. The base URL, the model
    // list, each model's wire protocol and its effort levels all come from the
    // provider layer and OpenCode's registry.
    vscode.commands.registerCommand("click.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        title: "Click — OpenCode Go API key",
        prompt: "Paste your OpenCode Go API key. It is stored locally in ~/.click/settings.json.",
        placeHolder: "opencode-go API key",
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined || key.trim().length === 0) return;
      await setProvider("opencode-go", { type: "api-key", apiKey: key.trim() });
      provider.post({ type: "settingsChanged" });
      log.appendLine("[click-agent] OpenCode Go key saved");
      void vscode.window.showInformationMessage("Click: OpenCode Go API key saved.");
    }),
    log,
  );

  log.appendLine("[click-agent] activated");

  // The agent is the product's AI surface, so show it on startup by default.
  const config = vscode.workspace.getConfiguration("click");
  if (config.get<boolean>("agent.openOnStartup", true)) {
    void vscode.commands.executeCommand("click.agent.focus");
  }

  // Report the agent this extension actually runs. It is OpenCode over ACP, and
  // the extension supplies that provider's configuration itself, so there is
  // nothing the user has to set up beyond an API key inside OpenCode.
  void (async () => {
    try {
      const settings = await loadSettings();
      const entry = describeProviders(settings, providerContext()).find(
        (candidate) => String(candidate.descriptor.id) === "opencode-acp",
      );
      if (!entry) {
        log.appendLine("[click-agent] the OpenCode ACP agent is not available in the provider layer");
        return;
      }
      log.appendLine(
        "[click-agent] ready — agent is OpenCode over ACP (opencode acp); " +
          "models, tools and MCP servers come from OpenCode",
      );
    } catch (error) {
      log.appendLine(
        `[click-agent] provider scan failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();
}

export function deactivate(): void {
  // Nothing global to tear down; per-view state is disposed with the view.
}
