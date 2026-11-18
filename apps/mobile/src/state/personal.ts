import { PERSONAL_WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const personalGuestRoutes = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:personal:guest-routes",
  tag: PERSONAL_WS_METHODS.guestRoutes,
});
