import type { PersonalRelayState } from "@t3tools/contracts";
import { useEffect } from "react";

import { registerMenuAction } from "../shortcuts/dispatcher";
import { usePrimaryEnvironment } from "../state/environments";
import {
  personalPauseSharing,
  personalRelayStatus,
  personalResumeSharing,
} from "../state/personal";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Keeps the desktop tray's sharing status current and lets its Pause/Resume
 * items drive the host connector. Renders nothing.
 */
export function PersonalShareCoordinator() {
  const primary = usePrimaryEnvironment();
  const environmentId = primary?.environmentId ?? null;
  const status = useAtomCommand(personalRelayStatus, { reportFailure: false });
  const pause = useAtomCommand(personalPauseSharing, { reportFailure: false });
  const resume = useAtomCommand(personalResumeSharing, { reportFailure: false });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors connector state into the Electron tray and close behavior
  useEffect(() => {
    if (environmentId === null || window.desktopBridge?.setPersonalShareState === undefined) {
      return;
    }
    let cancelled = false;
    const sync = async () => {
      const result = await status({ environmentId, input: {} });
      if (cancelled || result._tag !== "Success") return;
      const value = result.value as PersonalRelayState;
      await window.desktopBridge?.setPersonalShareState?.({
        enabled: value.enabled,
        paused: value.paused,
        online: value.online,
      });
    };
    void sync();
    const timer = window.setInterval(() => void sync(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [environmentId, status]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tray menu items are process-wide commands
  useEffect(() => {
    if (environmentId === null) return;
    const disposers = [
      registerMenuAction("personal.pause-sharing", () => void pause({ environmentId, input: {} })),
      registerMenuAction(
        "personal.resume-sharing",
        () => void resume({ environmentId, input: {} }),
      ),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [environmentId, pause, resume]);

  return null;
}
