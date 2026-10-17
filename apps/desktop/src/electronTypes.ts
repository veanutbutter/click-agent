/**
 * A deliberately small, hand-written description of the Electron surface Click
 * uses. Keeping it local means the workspace typechecks without downloading the
 * Electron distribution, while `require("electron")` still resolves to the real
 * module at runtime inside the Electron main process.
 */

export interface ElectronWebContents {
  send(channel: string, payload?: unknown): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

export interface ElectronBrowserWindow {
  webContents: ElectronWebContents;
  isDestroyed(): boolean;
  setTitle(title: string): void;
  show(): void;
  loadURL(url: string): Promise<void>;
  loadFile(filePath: string): Promise<void>;
  once(event: string, listener: (...args: unknown[]) => void): void;
}

export type ElectronIpcMainInvokeEvent = unknown;

export interface ElectronIpcMain {
  handle(channel: string, listener: (event: ElectronIpcMainInvokeEvent, ...args: any[]) => unknown): void;
}

export interface ElectronDialog {
  showOpenDialog(
    window: ElectronBrowserWindow,
    options: Record<string, unknown>,
  ): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export interface ElectronShell {
  openExternal(url: string): Promise<void>;
}

export interface ElectronApp {
  whenReady(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  quit(): void;
  getVersion(): string;
  getName(): string;
}

export interface ElectronModule {
  app: ElectronApp;
  BrowserWindow: new (options: Record<string, unknown>) => ElectronBrowserWindow;
  dialog: ElectronDialog;
  ipcMain: ElectronIpcMain;
  shell: ElectronShell;
}
