import { PERSONAL_WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const personalRelayStatus = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:personal:status",
  tag: PERSONAL_WS_METHODS.relayStatus,
});

export const personalStartSharing = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:personal:start-sharing",
  tag: PERSONAL_WS_METHODS.startSharing,
});

export const personalStopSharing = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:personal:stop-sharing",
  tag: PERSONAL_WS_METHODS.stopSharing,
});

export const personalPauseSharing = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:personal:pause-sharing",
  tag: PERSONAL_WS_METHODS.pauseSharing,
});

export const personalResumeSharing = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:personal:resume-sharing",
  tag: PERSONAL_WS_METHODS.resumeSharing,
});

export const personalRotateSharingKey = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:personal:rotate-sharing-key",
  tag: PERSONAL_WS_METHODS.rotateSharingKey,
});

export const personalRevealSharingKey = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:personal:reveal-sharing-key",
  tag: PERSONAL_WS_METHODS.revealSharingKey,
});

export const personalResolveHostKey = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:personal:resolve-host-key",
  tag: PERSONAL_WS_METHODS.resolveHostKey,
});
