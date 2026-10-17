/**
 * Minimal ambient declaration of the parts of the `vscode` API this extension
 * uses. Declaring it locally keeps the extension buildable without pulling in
 * `@types/vscode`, and makes the exact API surface the extension relies on
 * explicit and reviewable.
 */
declare module "vscode" {
  export interface Disposable {
    dispose(): void;
  }

  export interface Uri {
    scheme: string;
    path: string;
    fsPath: string;
    toString(): string;
  }

  export const Uri: {
    file(path: string): Uri;
    parse(value: string): Uri;
    joinPath(base: Uri, ...segments: string[]): Uri;
  };

  export interface Webview {
    html: string;
    options: WebviewOptions;
    cspSource: string;
    asWebviewUri(uri: Uri): Uri;
    postMessage(message: unknown): Thenable<boolean>;
    onDidReceiveMessage(
      listener: (message: unknown) => void,
      thisArgs?: unknown,
    ): Disposable;
  }

  export interface WebviewOptions {
    enableScripts?: boolean;
    localResourceRoots?: readonly Uri[];
    retainContextWhenHidden?: boolean;
  }

  export interface WebviewView {
    readonly webview: Webview;
    readonly visible: boolean;
    show(preserveFocus?: boolean): void;
    onDidDispose(listener: () => void): Disposable;
  }

  export interface CancellationToken {
    readonly isCancellationRequested: boolean;
  }

  export interface WebviewViewProvider {
    resolveWebviewView(
      webviewView: WebviewView,
      context: WebviewViewResolveContext,
      token: CancellationToken,
    ): void | Thenable<void>;
  }

  export interface WebviewViewResolveContext {
    readonly state: unknown;
  }

  export interface ExtensionContext {
    readonly extensionUri: Uri;
    readonly subscriptions: { dispose(): unknown }[];
  }

  export interface WorkspaceFolder {
    readonly uri: Uri;
    readonly name: string;
    readonly index: number;
  }

  export const window: {
    registerWebviewViewProvider(
      viewId: string,
      provider: WebviewViewProvider,
      options?: { webviewOptions?: WebviewOptions },
    ): Disposable;
    showOpenDialog(options: OpenDialogOptions): Thenable<Uri[] | undefined>;
    showInputBox(options?: InputBoxOptions): Thenable<string | undefined>;
    showInformationMessage(message: string): Thenable<string | undefined>;
    showErrorMessage(message: string): Thenable<string | undefined>;
    createOutputChannel(name: string): { appendLine(value: string): void; dispose(): void };
    createTextEditorDecorationType(options: DecorationRenderOptions): TextEditorDecorationType;
    createStatusBarItem(alignment?: StatusBarAlignment, priority?: number): StatusBarItem;
    showTextDocument(
      document: TextDocument,
      options?: { preview?: boolean; preserveFocus?: boolean; viewColumn?: number },
    ): Thenable<TextEditor>;
    readonly activeTextEditor: TextEditor | undefined;
    readonly visibleTextEditors: readonly TextEditor[];
    onDidChangeActiveTextEditor(listener: (editor: TextEditor | undefined) => void): Disposable;
  };

  export interface InputBoxOptions {
    title?: string;
    prompt?: string;
    placeHolder?: string;
    /** Renders the input masked, for secrets such as API keys. */
    password?: boolean;
    ignoreFocusOut?: boolean;
    value?: string;
  }

  export interface OpenDialogOptions {
    canSelectFolders?: boolean;
    canSelectFiles?: boolean;
    canSelectMany?: boolean;
    openLabel?: string;
    defaultUri?: Uri;
  }

  export const commands: {
    registerCommand(command: string, callback: (...args: unknown[]) => unknown): Disposable;
    executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
  };

  export const env: {
    openExternal(uri: Uri): Thenable<boolean>;
  };

  export const workspace: {
    readonly workspaceFolders: readonly WorkspaceFolder[] | undefined;
    getConfiguration(section?: string): {
      get<T>(key: string, defaultValue?: T): T;
    };
    openTextDocument(options: { content?: string } | Uri | string): Thenable<TextDocument>;
    applyEdit(edit: WorkspaceEdit): Thenable<boolean>;
    onDidChangeTextDocument(
      listener: (event: TextDocumentChangeEvent) => void,
    ): Disposable;
  };

  export const ViewColumn: { readonly One: number };

  // --- editor surface, used by the review layer -----------------------------

  export class Position {
    constructor(line: number, character: number);
    readonly line: number;
    readonly character: number;
  }

  export class Range {
    constructor(start: Position, end: Position);
    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
    readonly start: Position;
    readonly end: Position;
  }

  export enum OverviewRulerLane {
    Left = 1,
    Center = 2,
    Right = 4,
    Full = 7,
  }

  export class ThemeColor {
    constructor(id: string);
  }

  export interface ThemableDecorationAttachmentRenderOptions {
    contentText?: string;
    contentIconPath?: Uri;
    color?: string | ThemeColor;
    backgroundColor?: string | ThemeColor;
    fontStyle?: string;
    fontWeight?: string;
    textDecoration?: string;
  }

  export interface DecorationRenderOptions {
    isWholeLine?: boolean;
    backgroundColor?: string | ThemeColor;
    borderColor?: string | ThemeColor;
    borderWidth?: string;
    borderStyle?: string;
    color?: string | ThemeColor;
    fontStyle?: string;
    textDecoration?: string;
    opacity?: string;
    overviewRulerColor?: string | ThemeColor;
    overviewRulerLane?: OverviewRulerLane;
    before?: ThemableDecorationAttachmentRenderOptions;
    after?: ThemableDecorationAttachmentRenderOptions;
    rangeBehavior?: number;
  }

  export interface TextEditorDecorationType {
    readonly key: string;
    dispose(): void;
  }

  export interface DecorationOptions {
    range: Range;
    hoverMessage?: string;
    renderOptions?: DecorationRenderOptions;
  }

  export interface TextLine {
    readonly lineNumber: number;
    readonly text: string;
    readonly range: Range;
    readonly rangeIncludingLineBreak: Range;
  }

  export interface TextDocument {
    readonly uri: Uri;
    readonly fileName: string;
    readonly lineCount: number;
    readonly isDirty: boolean;
    getText(): string;
    lineAt(line: number): TextLine;
    positionAt(offset: number): Position;
    offsetAt(position: Position): number;
    save(): Thenable<boolean>;
  }

  export interface TextEditor {
    readonly document: TextDocument;
    readonly selection: Selection;
    setDecorations(decorationType: TextEditorDecorationType, rangesOrOptions: readonly DecorationOptions[]): void;
    revealRange(range: Range, revealType?: number): void;
  }

  export interface Selection extends Range {
    readonly anchor: Position;
    readonly active: Position;
    readonly isEmpty: boolean;
  }

  export interface StatusBarItem {
    text: string;
    tooltip: string | undefined;
    command: string | undefined;
    show(): void;
    hide(): void;
    dispose(): void;
  }

  export enum StatusBarAlignment {
    Left = 1,
    Right = 2,
  }

  export const TextEditorRevealType: {
    readonly Default: number;
    readonly InCenter: number;
    readonly InCenterIfOutsideViewport: number;
    readonly AtTop: number;
  };

  export class WorkspaceEdit {
    replace(uri: Uri, range: Range, newText: string): void;
    insert(uri: Uri, position: Position, newText: string): void;
    delete(uri: Uri, range: Range): void;
    readonly size: number;
  }

  export interface TextDocumentChangeEvent {
    readonly document: TextDocument;
  }
}
