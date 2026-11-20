import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderOptionSelection, ProviderOptionSelectionValue } from "./model.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const AgentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(AGENT_ID_PATTERN),
).pipe(Schema.brand("AgentId"));
export type AgentId = typeof AgentId.Type;

/** Highest precedence first: a project definition shadows a global one, which shadows a built-in. */
export const AgentSource = Schema.Literals(["builtin", "global", "project"]);
export type AgentSource = typeof AgentSource.Type;

// YAML writes options as a map; tool calls and stored definitions use the array form.
const AgentProviderOptionsFromRecord = Schema.Record(
  Schema.String,
  ProviderOptionSelectionValue,
).pipe(
  Schema.decodeTo(
    Schema.Array(ProviderOptionSelection),
    SchemaTransformation.transformEffect({
      decode: (record) =>
        Effect.succeed(Object.entries(record).map(([id, value]) => ({ id, value }))),
      encode: (selections: ReadonlyArray<ProviderOptionSelection>) =>
        Effect.succeed(
          Object.fromEntries(selections.map((selection) => [selection.id, selection.value])),
        ),
    }),
  ),
);

export const AgentProviderOptions = Schema.Union([
  Schema.Array(ProviderOptionSelection),
  AgentProviderOptionsFromRecord,
]);
export type AgentProviderOptions = typeof AgentProviderOptions.Type;

export const AgentProviderDefaults = Schema.Struct({
  instance: Schema.optional(ProviderInstanceId),
  driver: Schema.optional(ProviderDriverKind),
  model: Schema.optional(TrimmedNonEmptyString),
  options: Schema.optional(AgentProviderOptions),
});
export type AgentProviderDefaults = typeof AgentProviderDefaults.Type;

export const AgentDelegation = Schema.Struct({
  enabled: Schema.Boolean,
  /** Omitted means any agent; an empty array means none. */
  allowedAgents: Schema.optional(Schema.Array(AgentId).check(Schema.isMaxLength(32))),
  /** Levels below this agent. Absolute runtime cap is 8. */
  maxDepth: PositiveInt.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  /** Active child tasks under one parent thread. Absolute runtime cap is 8. */
  maxParallel: PositiveInt.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  defaultIsolation: Schema.Literals(["shared", "worktree"]),
  defaultMode: Schema.Literals(["async", "wait"]),
});
export type AgentDelegation = typeof AgentDelegation.Type;

export const DEFAULT_AGENT_DELEGATION: AgentDelegation = {
  enabled: false,
  maxDepth: 1,
  maxParallel: 2,
  defaultIsolation: "shared",
  defaultMode: "async",
};

export const AgentDefinition = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: AgentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  provider: Schema.optional(AgentProviderDefaults),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  delegation: Schema.optional(AgentDelegation),
  runtimeMode: Schema.optional(Schema.Union([Schema.Literal("inherit"), RuntimeMode])),
  interactionMode: Schema.optional(
    Schema.Union([Schema.Literal("inherit"), ProviderInteractionMode]),
  ),
});
export type AgentDefinition = typeof AgentDefinition.Type;

export const AgentSummary = Schema.Struct({
  id: AgentId,
  name: Schema.String,
  description: Schema.String,
  source: AgentSource,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  driverKind: Schema.NullOr(ProviderDriverKind),
  model: Schema.NullOr(Schema.String),
  delegationEnabled: Schema.Boolean,
  allowedAgents: Schema.NullOr(Schema.Array(AgentId)),
  maxDepth: PositiveInt,
  maxParallel: PositiveInt,
  /** The YAML file's base name for global/project definitions; never an absolute path. */
  fileName: Schema.optional(Schema.String),
});
export type AgentSummary = typeof AgentSummary.Type;

export const AgentsListInput = Schema.Struct({
  /** Include this project's `.t3code/agents` scope. Omit for built-ins and the global scope. */
  projectRoot: Schema.optional(TrimmedNonEmptyString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(PositiveInt),
  cursor: Schema.optional(NonNegativeInt),
});
export type AgentsListInput = typeof AgentsListInput.Type;

export const AgentsListResult = Schema.Struct({
  agents: Schema.Array(AgentSummary),
  warnings: Schema.optional(Schema.Array(Schema.String)),
  nextCursor: Schema.optional(NonNegativeInt),
});
export type AgentsListResult = typeof AgentsListResult.Type;

export class AgentsListError extends Schema.TaggedError<AgentsListError>()("AgentsListError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
