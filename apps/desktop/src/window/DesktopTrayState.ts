import type { DesktopPersonalShareState } from "@t3tools/contracts";

/**
 * Process-wide tray state. The renderer owns the authoritative sharing status
 * and pushes it here; the window close handler and tray menu read it
 * synchronously. This is deliberately a singleton, like Electron's tray.
 */
const DEFAULT_STATE: DesktopPersonalShareState = {
  enabled: false,
  paused: false,
  online: false,
};

let state: DesktopPersonalShareState = DEFAULT_STATE;
let trayAvailable = false;

export function readPersonalShareState(): DesktopPersonalShareState {
  return state;
}

export function setPersonalShareState(next: DesktopPersonalShareState): void {
  state = next;
}

export function setTrayAvailable(available: boolean): void {
  trayAvailable = available;
}

/** Close hides only when sharing is planned to survive the window, and a tray can restore it. */
export function shouldHideWindowOnClose(personalOnly: boolean): boolean {
  return personalOnly && trayAvailable && state.enabled;
}
