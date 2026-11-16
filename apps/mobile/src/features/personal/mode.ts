import Constants from "expo-constants";
import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";

interface PersonalExtra {
  readonly personalOnly?: unknown;
  readonly personalRelayUrl?: unknown;
  readonly hostedAppUrl?: unknown;
}

function personalExtra(): PersonalExtra {
  return (Constants.expoConfig?.extra ?? {}) as PersonalExtra;
}

export function isPersonalOnlyBuild(): boolean {
  return personalExtra().personalOnly === true;
}

export function configuredPersonalRelayUrl(): string | null {
  const value = personalExtra().personalRelayUrl;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Personal builds always show the setup; other builds only when a relay was configured. */
export function personalNetworkAvailable(): boolean {
  return isPersonalOnlyBuild() || configuredPersonalRelayUrl() !== null;
}

/** Copied thread links point at the personal portal in personal builds. */
export function configuredHostedAppUrl(): string {
  const value = personalExtra().hostedAppUrl;
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_HOSTED_APP_URL;
}
