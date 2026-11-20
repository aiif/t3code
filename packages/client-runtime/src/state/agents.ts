import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * Named agent definitions for the composer and Settings -> Agents. Definitions are files, so a
 * short stale time keeps a newly saved YAML visible without polling.
 */
export function createAgentEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agents:list",
      tag: WS_METHODS.agentsList,
      staleTimeMs: 10_000,
      idleTtlMs: 5 * 60_000,
    }),
  };
}
