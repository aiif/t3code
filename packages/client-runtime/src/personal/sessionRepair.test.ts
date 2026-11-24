import { describe, expect, it } from "vite-plus/test";

import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  ConnectionTransientError,
} from "../connection/model.ts";
import { isPersonalHostAuthenticationBlocked } from "./sessionRepair.ts";

const blocked = (reason: "authentication" | "permission") =>
  new ConnectionBlockedError({ reason, detail: "blocked" });

describe("isPersonalHostAuthenticationBlocked", () => {
  it("repairs a blocked host whose session was rejected", () => {
    expect(
      isPersonalHostAuthenticationBlocked({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "blocked",
        lastFailure: blocked("authentication"),
      }),
    ).toBe(true);
  });

  it.each([
    { name: "another blocked reason", lastFailure: blocked("permission"), phase: "blocked" },
    {
      name: "a transient failure",
      lastFailure: new ConnectionTransientError({ reason: "network", detail: "offline" }),
      phase: "backoff",
    },
    { name: "a live connection", lastFailure: null, phase: "connected" },
  ] as const)("leaves $name alone", ({ lastFailure, phase }) => {
    expect(
      isPersonalHostAuthenticationBlocked({
        ...AVAILABLE_CONNECTION_STATE,
        phase,
        lastFailure,
      }),
    ).toBe(false);
  });
});
