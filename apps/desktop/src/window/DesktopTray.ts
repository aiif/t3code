import type { DesktopPersonalShareState } from "@t3tools/contracts";
import type * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import {
  readPersonalShareState,
  setPersonalShareState,
  setTrayAvailable,
} from "./DesktopTrayState.ts";

interface TrayActions {
  readonly reveal: () => void;
  readonly dispatchMenuAction: (action: string) => void;
  readonly quit: () => void;
}

let tray: Electron.Tray | null = null;
let actions: TrayActions | null = null;

function sendMenuAction(action: string): void {
  actions?.dispatchMenuAction(action);
}

function buildMenu(Electron: typeof import("electron")): Electron.Menu {
  const state = readPersonalShareState();
  const items: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Open T3 Code",
      click: () => actions?.reveal(),
    },
    { type: "separator" },
    {
      label: sharingStatusLabel(state),
      enabled: false,
    },
  ];
  if (state.enabled) {
    items.push(
      state.paused
        ? {
            label: "Resume sharing",
            click: () => sendMenuAction("personal.resume-sharing"),
          }
        : {
            label: "Pause sharing",
            click: () => sendMenuAction("personal.pause-sharing"),
          },
    );
  }
  items.push(
    { type: "separator" },
    {
      label: "Quit T3 Code",
      click: () => actions?.quit(),
    },
  );
  return Electron.Menu.buildFromTemplate(items);
}

function sharingStatusLabel(state: DesktopPersonalShareState): string {
  if (!state.enabled) return "Sharing: off";
  if (state.paused) return "Sharing: paused";
  return state.online ? "Sharing: online" : "Sharing: connecting";
}

function refreshMenu(Electron: typeof import("electron")): void {
  if (tray === null || tray.isDestroyed()) return;
  tray.setContextMenu(buildMenu(Electron));
  tray.setToolTip(`T3 Code - ${sharingStatusLabel(readPersonalShareState())}`);
}

/** Rebuilds the menu after the renderer reports a new sharing state. */
export function updatePersonalShareTray(state: DesktopPersonalShareState): void {
  setPersonalShareState(state);
  void import("electron").then((Electron) => refreshMenu(Electron));
}

export interface InstallTrayInput {
  readonly iconPaths: DesktopAssets.DesktopIconPaths;
  readonly platform: NodeJS.Platform;
  readonly isPersonalOnly: boolean;
  readonly reveal: () => void;
  readonly dispatchMenuAction: (action: string) => void;
  readonly quit: () => void;
}

export const installDesktopTray = Effect.fn("desktop.tray.install")(function* (
  input: InstallTrayInput,
) {
  if (!input.isPersonalOnly) return;
  // @effect-diagnostics-next-line processEnvInEffect:off -- opt-out flag for headless Linux tray launches
  if (input.platform === "linux" && process.env.T3CODE_NO_TRAY === "1") return;
  const Electron = yield* Effect.promise(() => import("electron"));
  const icon = Option.getOrUndefined(input.iconPaths[input.platform === "win32" ? "ico" : "png"]);
  if (icon === undefined) {
    yield* Effect.logWarning("desktop tray has no icon; close-to-tray stays off");
    return;
  }
  if (tray !== null) {
    tray.destroy();
    tray = null;
  }
  actions = {
    reveal: input.reveal,
    dispatchMenuAction: input.dispatchMenuAction,
    quit: input.quit,
  };
  tray = new Electron.Tray(Electron.nativeImage.createFromPath(icon));
  tray.on("double-click", () => input.reveal());
  setTrayAvailable(true);
  refreshMenu(Electron);
});

export function destroyDesktopTray(): void {
  setTrayAvailable(false);
  actions = null;
  if (tray !== null && !tray.isDestroyed()) {
    tray.destroy();
  }
  tray = null;
}
