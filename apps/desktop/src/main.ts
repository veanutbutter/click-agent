import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronModule } from "./electronTypes.js";
import { registerIpcHandlers } from "./handlers.js";

const require = createRequire(import.meta.url);
const electron = require("electron") as ElectronModule;
const { app, BrowserWindow } = electron;

const dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_SERVER_URL = process.env.CLICK_DEV_URL ?? "";

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    title: "Click",
    backgroundColor: "#0b0b0f",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  registerIpcHandlers(electron, window);

  if (DEV_SERVER_URL) {
    await window.loadURL(DEV_SERVER_URL);
  } else {
    await window.loadFile(path.join(dirname, "..", "..", "web", "dist", "index.html"));
  }
}

void app.whenReady().then(async () => {
  await createWindow();
  app.on("activate", () => {
    void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
