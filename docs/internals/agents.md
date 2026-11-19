# Agent definitions

An agent definition is environment-local configuration that chooses a thread's launch defaults: a
prompt, provider and model defaults, permission modes, and delegation limits. The
[contract](../../packages/contracts/src/agentDefinition.ts) owns the shape; the server resolves
files, turns one into a launch, and stores the chosen id on the thread. Clients only read summaries.

## Resolution and precedence

The registry reads `<projectRoot>/.t3code/agents` and `<T3 home>/agents`. For one id, project beats
global beats built-in, and the winning definition replaces the others whole. Fields are never
merged. Two files in one directory with the same id are a configuration error, not an order to
resolve; the registry reports it rather than picking one.

The id inside the file is the identity. File names do not matter. Built-in ids are reserved in the
sense that a user definition may shadow them, not that they are protected. The project directory is
the project's workspace root, never a thread worktree, so a checked-in copy in a worktree is
ignored.

List order is built-ins first, then project, then global. That is presentation only; precedence is
still project over global over built-in.

## Files are the source of truth

There is no agent-definitions table and no migration or backfill. The registry parses YAML on
demand and caches parsed definitions and directory listings by file and directory modification
time, so an edit is visible to the next launch without a restart or an event. The database stores
the chosen `agentId` on the thread, not a copy of the definition; a local delegated launch also
carries the composed `agentInstruction`. That keeps history about work rather than configuration
and lets a definition change without rewriting old threads.

Do not put the resolved absolute path in a capability, list, or summary sent to a client. The
registry exposes `path` for local callers; `AgentSummary` deliberately has no path or prompt.
`AgentRegistryError` separates `not_found`, `invalid`, `unreadable`, and `too_many_files`; a bad
file must surface as a path and reason, never as a silently missing agent.

## Stored identity, not the marker

`OrchestrationV2AppThread.agentId`, the thread shell, and `OrchestrationV2Subagent` carry the
stored choice. Thread creation records it, and `delegated_task.request` carries the agent id plus
the resolved `agentInstruction` so the provider turn does not depend on a later file read.

The first-message block from
[`composeAgentInstruction`](../../packages/shared/src/agentInstruction.ts) is display and replay
metadata. It is idempotent, and `parseAgentInstruction` returns the id and prompt for rendering.
Never authorize from the parsed marker. A forged or edited `<!-- t3:agent:... -->` block grants no
agent, no delegation, and no permissions; MCP credentials and delegation checks read the stored
thread, not message text.

Identity is fixed at launch. The prompt is composed into the first message only; follow-up turns
never reapply it. Editing, shadowing, or deleting a definition affects future launches, not a
thread that already started. A thread that loses its definition still has its stored id and
instruction and must not be silently rewritten.

## Delegation guardrails

`AgentDelegation` in the contract separates configuration limits from absolute runtime limits.
`maxDepth` accepts `1`–`5` but the runtime refuses a chain deeper than 8 levels. `maxParallel`
accepts `1`–`8` and the runtime allows at most 8 active children under one parent thread.
Definitions can narrow these limits, never raise the absolute caps.

`allowedAgents` listed means those ids only; omitted means any agent; an empty array means none.
`enabled` gates whether this agent may start children at all; it does not decide whether other
agents may name it. `defaultIsolation` and `defaultMode` are defaults for a child, not policy.

The resolver rejects an unknown id (`agent_not_found`), an invalid definition or request
(`agent_invalid`), an agent outside the caller's allowlist or a caller whose agent has delegation
off (`agent_forbidden`), an over-depth chain (`agent_depth_exceeded`), and a saturated parent
(`agent_parallel_limit_reached`). `McpInvocationContext.hiddenFromAgentsWithoutDelegation` hides
delegation tools from a non-delegating thread for discovery only; the handler re-checks the same
flag. `McpThreadCaller.agentId` and `delegationAllowed` come from the stored thread, never from the
marker.

A child still cannot exceed the parent's runtime or interaction mode. An explicit `target`,
`model`, `runtimeMode`, `interactionMode`, `isolation`, or `mode` overrides the definition's
defaults, but not that ceiling or the absolute caps.

## Capability boundary

Definitions are environment-local, so a linked environment resolves its own files and ids in a
call mean that environment's ids. A remote delegated request carries the id, not the prompt, so the
destination resolves it there. Do not resolve another environment's definitions on the client or
send a prompt across the wire to avoid a lookup there.

`EnvironmentCapabilities.threadAgentDefinitions` is the client boundary. Older servers and
environments without the capability must not show agent UI. The MCP `orchestrator_capabilities`
result carries `agents` as summaries, `omittedAgents` when the list is truncated, and
`features.agentDefinitions`, `features.agentDelegation`, and `features.maxAgents`. Prompts stay in
`t3_agent_read`; the list is short by design.

## Where the code lives

- Contract and capability fields: [`agentDefinition.ts`](../../packages/contracts/src/agentDefinition.ts),
  [`orchestratorMcp.ts`](../../packages/contracts/src/orchestratorMcp.ts),
  [`orchestrationV2.ts`](../../packages/contracts/src/orchestrationV2.ts), and
  [`environment.ts`](../../packages/contracts/src/environment.ts).
- Built-ins and reserved ids: [`builtin.ts`](../../apps/server/src/agents/builtin.ts).
- File resolution, precedence, cache, and summaries:
  [`AgentRegistry.ts`](../../apps/server/src/agents/AgentRegistry.ts).
- Definition-to-launch defaults: [`AgentTaskResolver.ts`](../../apps/server/src/mcp/AgentTaskResolver.ts).
- First-message marker: [`agentInstruction.ts`](../../packages/shared/src/agentInstruction.ts).
- Invocation scope and delegation visibility: [`McpInvocationContext.ts`](../../apps/server/src/mcp/McpInvocationContext.ts)
  and [`McpSessionRegistry.ts`](../../apps/server/src/mcp/McpSessionRegistry.ts).
- CLI commands: the agent and thread modules under [`apps/server/src/cli`](../../apps/server/src/cli).
