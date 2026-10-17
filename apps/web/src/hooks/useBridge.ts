import { useMemo } from "react";

import type { ClickBridge } from "@click/bridge";

import { getBridge, hasDesktopBridge } from "../bridge";

export interface BridgeAccess {
  bridge: ClickBridge;
  /** False when the in-browser mock bridge is in use. */
  isDesktop: boolean;
}

/** Resolves the host bridge once per mount. */
export function useBridge(): BridgeAccess {
  return useMemo(() => ({ bridge: getBridge(), isDesktop: hasDesktopBridge() }), []);
}
