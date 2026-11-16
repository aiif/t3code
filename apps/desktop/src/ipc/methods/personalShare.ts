import { DesktopPersonalShareState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { SET_PERSONAL_SHARE_STATE_CHANNEL } from "../channels.ts";
import { updatePersonalShareTray } from "../../window/DesktopTray.ts";

const decodeState = Schema.decodeUnknownSync(DesktopPersonalShareState);

export const setPersonalShareState = {
  channel: SET_PERSONAL_SHARE_STATE_CHANNEL,
  handler: (raw: unknown) =>
    Effect.sync(() => {
      updatePersonalShareTray(decodeState(raw));
    }),
};
