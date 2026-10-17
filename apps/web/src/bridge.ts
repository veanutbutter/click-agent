import type { ClickBridge } from "@click/bridge";

import { createMockBridge } from "./mockBridge";

declare global {
  interface Window {
    /** Injected by the desktop preload script; absent in a plain browser. */
    click?: ClickBridge;
  }
}

let resolved: ClickBridge | null = null;

/** True when the renderer runs inside the Click desktop shell. */
export function hasDesktopBridge(): boolean {
  if (typeof window === "undefined") return false;
  return typeof window.click === "object" && window.click !== null;
}

/**
 * The single entry point to the host. In the desktop shell this is the preload
 * bridge; in a browser (`pnpm dev:web`) it is an in-memory fake so the whole UI
 * stays explorable.
 */
export function getBridge(): ClickBridge {
  if (resolved) return resolved;
  const desktop = typeof window === "undefined" ? undefined : window.click;
  resolved = desktop ?? createMockBridge();
  return resolved;
}
