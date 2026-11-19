#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Runs one fake T3 thread per agent-definition case and grades the transcript structurally.
 * Persona prompts come from the built-in definitions; the model, model calls, and simulated
 * child reports are this eval's own. See README.md for how to run it and add a case.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { DEFAULT_AGENT_DELEGATION } from "@t3tools/contracts";
import { composeAgentInstruction } from "@t3tools/shared/agentInstruction";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { toAgentSummary } from "../../apps/server/src/agents/AgentRegistry.ts";
import { BUILTIN_AGENTS } from "../../apps/server/src/agents/builtin.ts";
import { NO_PERSONA_AGENT_ID, agentDefinitionCases } from "./cases.ts";
import {
  type AgentCase,
  type AgentCaseOutput,
  gradeAgentCase,
  type AgentCaseResult,
} from "./grading.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string" },
    case: { type: "string", multiple: true },
    baseline: { type: "string" },
    // Unset: 2 samples per case, and a 3rd when those 2 disagree.
    samples: { type: "string" },
  },
});

if (values.out === undefined || values.model === undefined) {
  throw new Error(
    "Use --model <configured-model> --out <directory> [--case <id>] [--baseline <results.json>] [--samples <n>].",
  );
}
const model = values.model;
const outputDirectory = values.out;
const samplesPerCase = values.samples === undefined ? 2 : Number(values.samples);
const adaptiveSamples = values.samples === undefined;
if (!Number.isSafeInteger(samplesPerCase) || samplesPerCase < 1) {
  throw new Error("--samples needs a positive whole number.");
}
const apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
if (apiKey.length === 0) {
  throw new Error(
    "Set ANTHROPIC_API_KEY in the repo root .env or the environment. This runner calls the Anthropic Messages API.",
  );
}

const wanted = values.case?.flatMap((value) => value.split(",")).map((id) => id.trim());
const selected = agentDefinitionCases.filter(
  (testCase) => wanted === undefined || wanted.includes(testCase.id),
);
for (const id of wanted ?? []) {
  if (!agentDefinitionCases.some((testCase) => testCase.id === id)) {
    throw new Error(`Unknown case id: ${id}.`);
  }
}
if (selected.length === 0) {
  throw new Error("No case matches --case.");
}
for (const testCase of selected) {
  if (
    testCase.agentId !== NO_PERSONA_AGENT_ID &&
    !BUILTIN_AGENTS.some((definition) => definition.id === testCase.agentId)
  ) {
    throw new Error(`${testCase.id}: no built-in agent named ${testCase.agentId}.`);
  }
}

const REVIEWER_AGENT_ID = "t3-reviewer";
const PARENT_PROVIDER = "claudeAgent";
const MAX_STEPS = 10;
const MAX_TOKENS = 4_096;
const SYSTEM = [
  "You are an agent in a T3 Code thread on the project at /home/user/app.",
  "You have tools to read and edit project files, inspect the uncommitted diff, run tests, list providers and agents, and delegate work to other agents.",
  "Work on the user's request and end your turn with a report for the user.",
].join("\n");

const RETRY_BUGGY = `export async function retry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 1; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`;

const RETRY_REVIEWED = `export async function retry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
`;

const RETRY_TEST = `import { describe, expect, it } from "vitest";

import { retry } from "./retry.ts";

describe("retry", () => {
  it("retries until the operation succeeds", async () => {
    let calls = 0;
    const result = await retry(async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });
});
`;

const PACKAGE_JSON = `{
  "name": "retry-demo",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^3.0.0"
  }
}
`;

const RETRY_DIFF = `diff --git a/src/retry.ts b/src/retry.ts
index 3a2c9e1..8b4d0f2 100644
--- a/src/retry.ts
+++ b/src/retry.ts
@@ -1,12 +1,13 @@
 export async function retry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
   let lastError: unknown;
-  for (let attempt = 0; attempt < 1; attempt++) {
+  for (let attempt = 0; attempt < attempts; attempt++) {
     try {
       return await operation();
     } catch (error) {
+      if (attempt === attempts - 1) throw error;
       lastError = error;
     }
   }
   throw lastError;
 }
`;

const BASE_FILES: Readonly<Record<string, string>> = {
  "src/retry.ts": RETRY_BUGGY,
  "src/retry.test.ts": RETRY_TEST,
  "package.json": PACKAGE_JSON,
};
const REVIEW_FILES: Readonly<Record<string, string>> = {
  ...BASE_FILES,
  "src/retry.ts": RETRY_REVIEWED,
};

const PASSING_TESTS = "Tests  1 passed (1)\n  Duration  1.1s";
const FAILING_TESTS = "Tests  1 failed | 0 passed (1)\n  Duration  0.9s";

/** USD per million tokens. Cache writes use the 5-minute rate. */
const PRICES = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
} as const;
type PricedModel = keyof typeof PRICES;
const isPricedModel = (value: string): value is PricedModel => value in PRICES;

type Usage = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
};
type ApiUsage = {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens?: number | null | undefined;
  readonly cache_read_input_tokens?: number | null | undefined;
};
const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const addUsage = (total: Usage, usage: ApiUsage) => {
  total.input += usage.input_tokens;
  total.output += usage.output_tokens;
  total.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  total.cacheRead += usage.cache_read_input_tokens ?? 0;
};
const costOf = (usage: Usage): number | undefined => {
  if (!isPricedModel(model)) return undefined;
  const price = PRICES[model];
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheWrite * price.cacheWrite +
      usage.cacheRead * price.cacheRead) /
    1e6
  );
};

const Rest = [Schema.Record(Schema.String, Schema.Unknown)] as const;
const ContentBlock = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String,
    text: Schema.optional(Schema.String),
    id: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
    input: Schema.optional(Schema.Unknown),
  }),
  Rest,
);
const ApiResponse = Schema.Struct({
  content: Schema.Array(ContentBlock),
  stop_reason: Schema.NullOr(Schema.String),
  usage: Schema.Struct({
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
    cache_creation_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
    cache_read_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
});
type Block = typeof ContentBlock.Type;
type Message = { readonly role: "user" | "assistant"; readonly content: ReadonlyArray<unknown> };
const decodeApiResponse = Schema.decodeEffect(Schema.fromJsonString(ApiResponse));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isTextBlock = (block: Block): block is Block & { type: "text"; text: string } =>
  block.type === "text" && typeof block.text === "string";
const isToolUseBlock = (
  block: Block,
): block is Block & { type: "tool_use"; id: string; name: string; input?: unknown } =>
  block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string";

// Model calls share an organization's rate limits. Backing off for up to about 4 minutes lets
// a sample wait out a busy spell, with jitter so samples do not retry in step.
const RETRY = Schedule.min([Schedule.exponential("2 seconds"), Schedule.spaced("1 minute")]).pipe(
  Schedule.jittered,
);

const postModel = Effect.fn("evaluateAgentDefinitions.postModel")(function* (body: unknown) {
  const client = (yield* HttpClient.HttpClient).pipe(
    // Anthropic answers 529 when overloaded; retryTransient already retries 429 and 5xx.
    HttpClient.filterStatus((status) => status !== 529),
    HttpClient.retryTransient({
      retryOn: "errors-and-responses",
      while: (error) =>
        error.reason._tag === "StatusCodeError" && error.reason.response.status === 529,
      schedule: RETRY,
      times: 8,
    }),
  );
  const response = yield* HttpClientRequest.post("https://api.anthropic.com/v1/messages").pipe(
    HttpClientRequest.setHeaders({
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    }),
    HttpClientRequest.bodyJson(body),
    Effect.flatMap(client.execute),
  );
  const text = yield* response.text;
  if (response.status !== 200) {
    return yield* Effect.die(new Error(`Model API ${response.status}: ${redact(text)}`));
  }
  return yield* decodeApiResponse(text);
});
const redact = (value: string) => value.replaceAll(apiKey, "[redacted]");

type Provider = {
  readonly providerInstanceId: string;
  readonly driverKind: string;
  readonly displayName: string;
  readonly model: string;
};
const providersFor = (parentModel: string): ReadonlyArray<Provider> => [
  {
    providerInstanceId: "claudeAgent",
    driverKind: "claudeAgent",
    displayName: "Claude Code",
    model: parentModel,
  },
  {
    providerInstanceId: "codex",
    driverKind: "codex",
    displayName: "Codex",
    model: "gpt-6-luna",
  },
];

type ToolResult = { readonly content: string; readonly isError: boolean };
const ok = (content: string): ToolResult => ({ content, isError: false });
const failed = (message: string): ToolResult => ({ content: message, isError: true });
const mcpFailure = (code: string, message: string): ToolResult =>
  failed(JSON.stringify({ code, message }));

const toolSchema = (
  properties: Readonly<Record<string, unknown>>,
  required: ReadonlyArray<string> = [],
) => ({ type: "object", properties, required, additionalProperties: false });

const TOOLS: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  {
    name: "orchestrator_capabilities",
    description:
      "List this environment's providers, models, agents, and feature flags. Use it before delegating.",
    input_schema: toolSchema({ search: { type: "string" } }),
  },
  {
    name: "delegate_task",
    description:
      "Start a child task in a new thread with a named built-in agent. The child runs with the agent's prompt, provider, and modes; explicit target values override them. Its result returns here when it finishes.",
    input_schema: toolSchema(
      {
        task: { type: "string", description: "What the child should do." },
        agent: {
          type: "string",
          description: "Built-in agent id from orchestrator_capabilities.",
        },
        target: {
          type: "object",
          properties: {
            providerInstanceId: { type: "string" },
            driverKind: { type: "string" },
            model: { type: "string" },
          },
          additionalProperties: false,
        },
        role: {
          type: "string",
          enum: ["implementation", "research", "review", "design", "test", "general"],
        },
        isolation: { type: "string", enum: ["shared", "worktree"] },
        mode: { type: "string", enum: ["async", "wait"] },
      },
      ["task"],
    ),
  },
  {
    name: "read_file",
    description: "Read a project file.",
    input_schema: toolSchema({ path: { type: "string" } }, ["path"]),
  },
  {
    name: "read_diff",
    description: "Show the checkout's uncommitted diff.",
    input_schema: toolSchema({}),
  },
  {
    name: "edit_file",
    description: "Replace the first exact occurrence of a string in an existing project file.",
    input_schema: toolSchema(
      {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      ["path", "old_string", "new_string"],
    ),
  },
  {
    name: "write_file",
    description: "Write a project file, creating it if needed.",
    input_schema: toolSchema({ path: { type: "string" }, content: { type: "string" } }, [
      "path",
      "content",
    ]),
  },
  {
    name: "run_tests",
    description: "Run the project's test suite and return its output.",
    input_schema: toolSchema({}),
  },
];

const DelegateTaskInput = Schema.Struct({
  task: Schema.String,
  agent: Schema.optional(Schema.String),
  target: Schema.optional(
    Schema.Struct({
      providerInstanceId: Schema.optional(Schema.String),
      driverKind: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
    }),
  ),
  role: Schema.optional(Schema.String),
  isolation: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
});
const ReadFileInput = Schema.Struct({ path: Schema.String });
const EditFileInput = Schema.Struct({
  path: Schema.String,
  old_string: Schema.String,
  new_string: Schema.String,
});
const WriteFileInput = Schema.Struct({ path: Schema.String, content: Schema.String });
const decodeDelegateTaskInput = Schema.decodeUnknownOption(DelegateTaskInput);
const decodeReadFileInput = Schema.decodeUnknownOption(ReadFileInput);
const decodeEditFileInput = Schema.decodeUnknownOption(EditFileInput);
const decodeWriteFileInput = Schema.decodeUnknownOption(WriteFileInput);

type ToolCallRecord = {
  readonly turn: number;
  readonly tool: string;
  readonly input: unknown;
  readonly failed: boolean;
  readonly error?: string;
};
type SampleState = {
  readonly testCase: AgentCase;
  readonly files: Map<string, string>;
  readonly calls: Array<ToolCallRecord>;
  readonly editedFiles: Array<string>;
  readonly delegatedAgentIds: Array<string>;
  readonly completedAgentIds: Array<string>;
  readonly delegatedProviders: Array<string>;
  readonly delegations: Array<{ readonly agentId: string; readonly provider: string }>;
  nextTask: number;
  sequence: number;
  firstDelegationAt: number | undefined;
  firstEditAt: number | undefined;
  subQueryCount: number;
  maxSameTurnDispatches: number;
  testOutput: string | undefined;
};

const projectPath = (value: string) => {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/, "");
  return normalized.startsWith("/home/user/app/")
    ? normalized.slice("/home/user/app/".length)
    : normalized;
};
const truncate = (value: string, length = 160) =>
  value.length <= length ? value : `${value.slice(0, length - 3)}...`;
const summarizeInput = (input: unknown): unknown => {
  if (!isRecord(input)) return input;
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      typeof value === "string" ? truncate(value) : value,
    ]),
  );
};
const agentDefinitionFor = (agentId: string) =>
  BUILTIN_AGENTS.find((definition) => definition.id === agentId);

const childSummary = (agentId: string, subQuery: number): string => {
  switch (agentId) {
    case "t3-coder":
      return "Implemented the retry fix in a task worktree. Tests: 1 passed (1). Changed files: src/retry.ts.";
    case "t3-reviewer":
      return [
        "Prioritized findings:",
        "1. (medium) src/retry.ts: the final attempt throws before `lastError` is assigned, so a rejecting final attempt is fine but the helper has no retry budget.",
        "2. (low) src/retry.test.ts: add a case for a rejecting final attempt.",
        "No blocking issues. No edits made.",
      ].join("\n");
    case "t3-researcher":
      return [
        `Research notes for sub-query ${subQuery}:`,
        "- Exponential backoff with full jitter spreads retries and reduces synchronized load.",
        "- Fixed intervals are simpler but can herd retries at the same moment.",
        "- A retry budget bounds total attempts and latency.",
        "Sources:",
        `[1] https://example.com/research/retry-backoff-${subQuery}`,
        `[2] https://example.com/research/retry-jitter-${subQuery}`,
        `[3] https://example.com/research/retry-budget-${subQuery}`,
      ].join("\n");
    case "t3-deep-research":
      return [
        "Report: compare backoff with jitter, fixed intervals, and retry budgets, with failure modes for each.",
        "Sources:",
        `[1] https://example.com/research/deep-backoff-${subQuery}`,
        `[2] https://example.com/research/deep-jitter-${subQuery}`,
        `[3] https://example.com/research/deep-budget-${subQuery}`,
      ].join("\n");
    default:
      return "Completed the task and reported the result.";
  }
};

const capabilities = (parentModel: string) => ({
  parentThreadId: null,
  inheritedProviderInstanceId: PARENT_PROVIDER,
  inheritedModel: parentModel,
  runtimeMode: "approval-required",
  interactionMode: "default",
  providers: providersFor(parentModel).map((provider) => ({
    providerInstanceId: provider.providerInstanceId,
    driverKind: provider.driverKind,
    displayName: provider.displayName,
    models: [{ id: provider.model }],
    runtimeModes: ["approval-required", "auto", "full-access"],
    canRunChildTask: true,
    canRunCrossProviderChildTask: true,
    constraints: [],
  })),
  agents: BUILTIN_AGENTS.map((definition) => toAgentSummary({ definition, source: "builtin" })),
  features: {
    appOwnedSubagents: true,
    asyncPolling: true,
    cancellation: true,
    batchThreadCreation: true,
    threadManagement: true,
    incrementalThreadRead: true,
    scheduledTasks: true,
    maxBatchThreads: 10,
    agentDefinitions: true,
    agentDelegation: true,
    maxAgents: 20,
  },
});

const executeTool = (
  state: SampleState,
  parentModel: string,
  use: { readonly id: string; readonly name: string; readonly input: unknown },
  turn: { readonly index: number; delegations: number },
): ToolResult => {
  const at = ++state.sequence;
  switch (use.name) {
    case "orchestrator_capabilities":
      return ok(JSON.stringify(capabilities(parentModel)));
    case "delegate_task": {
      // Count the attempt even when the arguments do not decode: a coder must not try either.
      const requestedAgent = isRecord(use.input) ? use.input.agent : undefined;
      const requested =
        typeof requestedAgent === "string" && requestedAgent.trim() !== ""
          ? requestedAgent.trim()
          : "default";
      state.delegatedAgentIds.push(requested);
      const input = Option.getOrUndefined(decodeDelegateTaskInput(use.input));
      if (input === undefined) {
        return failed("delegate_task arguments are invalid.");
      }
      const definition = agentDefinitionFor(requested);
      if (definition === undefined) {
        return mcpFailure("agent_not_found", `No agent named ${requested}.`);
      }
      const parentDefinition =
        state.testCase.agentId === NO_PERSONA_AGENT_ID
          ? undefined
          : agentDefinitionFor(state.testCase.agentId);
      const delegation = parentDefinition?.delegation ?? DEFAULT_AGENT_DELEGATION;
      if (!delegation.enabled) {
        return mcpFailure("agent_forbidden", "This agent cannot delegate.");
      }
      if (
        delegation.allowedAgents !== undefined &&
        !delegation.allowedAgents.some((agentId) => agentId === requested)
      ) {
        return mcpFailure("agent_forbidden", `${requested} is not an allowed child agent.`);
      }
      // Children return immediately, so this turn's dispatches stand in for the live parallel set.
      if (turn.delegations >= delegation.maxParallel) {
        return mcpFailure(
          "agent_parallel_limit_reached",
          `At most ${delegation.maxParallel} children can run at once.`,
        );
      }
      const providers = providersFor(parentModel);
      const requestedProvider = input.target?.providerInstanceId?.trim();
      const requestedDriver = input.target?.driverKind?.trim();
      const requestedModel = input.target?.model?.trim();
      const provider =
        requestedProvider !== undefined
          ? providers.find((entry) => entry.providerInstanceId === requestedProvider)
          : requestedDriver !== undefined
            ? providers.find((entry) => entry.driverKind === requestedDriver)
            : requestedModel !== undefined
              ? providers.find((entry) => entry.model === requestedModel)
              : providers.find((entry) => entry.providerInstanceId === PARENT_PROVIDER);
      if (provider === undefined) {
        return mcpFailure("provider_unavailable", "That provider is not configured.");
      }
      turn.delegations += 1;
      const childModel = requestedModel ?? provider.model;
      state.completedAgentIds.push(requested);
      state.delegatedProviders.push(`${provider.providerInstanceId}:${childModel}`);
      state.delegations.push({
        agentId: requested,
        provider: provider.providerInstanceId,
      });
      if (requested === "t3-researcher" || requested === "t3-deep-research") {
        state.subQueryCount += 1;
      }
      if (state.firstDelegationAt === undefined) state.firstDelegationAt = at;
      const taskNumber = state.nextTask++;
      const summary = childSummary(requested, taskNumber);
      return ok(
        JSON.stringify({
          taskId: `task-${taskNumber}`,
          agentId: requested,
          childThreadId: `thread-${taskNumber}`,
          childRunId: `run-${taskNumber}`,
          childNodeId: `node-${taskNumber}`,
          status: "completed",
          workState: "result_available",
          hasPendingChildRuns: false,
          latestTerminalRunId: `run-${taskNumber}`,
          latestTerminalStatus: "completed",
          latestTerminalSummary: summary,
          latestTerminalResultContextTransferId: null,
          providerInstanceId: provider.providerInstanceId,
          model: childModel,
          executedModel: childModel,
          summary,
          resultContextTransferId: null,
          hasPendingQuestion: false,
          pendingApproval: null,
          waitTimedOut: false,
        }),
      );
    }
    case "read_file": {
      const input = Option.getOrUndefined(decodeReadFileInput(use.input));
      if (input === undefined) return failed("read_file needs a path.");
      const path = projectPath(input.path);
      const content = state.files.get(path);
      return content === undefined ? failed(`No file at ${path}.`) : ok(content);
    }
    case "read_diff":
      return ok(RETRY_DIFF);
    case "edit_file": {
      const input = Option.getOrUndefined(decodeEditFileInput(use.input));
      if (input === undefined) return failed("edit_file needs path, old_string, and new_string.");
      const path = projectPath(input.path);
      const content = state.files.get(path);
      if (content === undefined) return failed(`No file at ${path}.`);
      if (input.old_string.length === 0) return failed("old_string must not be empty.");
      const index = content.indexOf(input.old_string);
      if (index < 0) return failed(`old_string was not found in ${path}.`);
      state.files.set(
        path,
        content.slice(0, index) + input.new_string + content.slice(index + input.old_string.length),
      );
      if (!state.editedFiles.includes(path)) state.editedFiles.push(path);
      if (state.firstEditAt === undefined) state.firstEditAt = at;
      return ok(`Edited ${path}.`);
    }
    case "write_file": {
      const input = Option.getOrUndefined(decodeWriteFileInput(use.input));
      if (input === undefined) return failed("write_file needs path and content.");
      const path = projectPath(input.path);
      state.files.set(path, input.content);
      if (!state.editedFiles.includes(path)) state.editedFiles.push(path);
      if (state.firstEditAt === undefined) state.firstEditAt = at;
      return ok(`Wrote ${path}.`);
    }
    case "run_tests": {
      // The reviewer's checkout already holds the candidate fix; everyone else must edit first.
      const passing = state.editedFiles.length > 0 || state.testCase.agentId === REVIEWER_AGENT_ID;
      state.testOutput = passing ? PASSING_TESTS : FAILING_TESTS;
      return ok(state.testOutput);
    }
    default:
      return failed(`Unknown tool ${use.name}.`);
  }
};

const citationPatterns = [
  /https?:\/\/[^\s<>"'`)\]]+/g,
  /\b[\w./-]+\.(?:[cm]?[jt]sx?|json|md|yml|yaml):\d+\b/g,
];
const citationsIn = (text: string) => {
  const found = new Set<string>();
  for (const pattern of citationPatterns) {
    for (const match of text.matchAll(pattern)) {
      found.add(match[0].replace(/[.,;:]+$/, ""));
    }
  }
  return [...found];
};
const reportsTestEvidence = (output: string, finalText: string) =>
  /1 passed/.test(output) &&
  /\b(?:1|one)\s+(?:test\s+)?pass(?:ed|es|ing)?\b|\btests?\b[^.\n]{0,30}\bpass(?:ed|es|ing)?\b|all\s+tests?\s+pass/i.test(
    finalText,
  );

type SampleResult = {
  readonly output: AgentCaseOutput;
  readonly grade: AgentCaseResult;
  readonly usage: Usage;
  readonly stopReason: string;
  readonly finalText: string;
  readonly toolCalls: ReadonlyArray<ToolCallRecord>;
};

const runSample = Effect.fn("evaluateAgentDefinitions.runSample")(function* (
  testCase: AgentCase,
  usage: Usage,
) {
  const definition =
    testCase.agentId === NO_PERSONA_AGENT_ID ? undefined : agentDefinitionFor(testCase.agentId);
  const firstMessage =
    definition === undefined
      ? testCase.task
      : composeAgentInstruction({
          agentId: definition.id,
          prompt: definition.prompt,
          text: testCase.task,
        });
  const state: SampleState = {
    testCase,
    files: new Map(
      Object.entries(testCase.agentId === REVIEWER_AGENT_ID ? REVIEW_FILES : BASE_FILES),
    ),
    calls: [],
    editedFiles: [],
    delegatedAgentIds: [],
    completedAgentIds: [],
    delegatedProviders: [],
    delegations: [],
    nextTask: 1,
    sequence: 0,
    firstDelegationAt: undefined,
    firstEditAt: undefined,
    subQueryCount: 0,
    maxSameTurnDispatches: 0,
    testOutput: undefined,
  };
  const messages: Array<Message> = [
    { role: "user", content: [{ type: "text", text: firstMessage }] },
  ];
  let finalText = "";
  let stopReason = "max_steps";
  for (let step = 0; step < MAX_STEPS; step++) {
    const response = yield* postModel({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });
    addUsage(usage, response.usage);
    messages.push({ role: "assistant", content: response.content });
    const uses = response.content.filter(isToolUseBlock);
    if (response.stop_reason !== "tool_use" || uses.length === 0) {
      stopReason = response.stop_reason ?? "end_turn";
      finalText = response.content
        .filter(isTextBlock)
        .map((block) => block.text)
        .join("\n\n");
      break;
    }
    const turn = { index: step, delegations: 0 };
    state.maxSameTurnDispatches = Math.max(
      state.maxSameTurnDispatches,
      uses.filter((use) => use.name === "delegate_task").length,
    );
    const results: Array<Record<string, unknown>> = [];
    for (const use of uses) {
      const result = executeTool(state, model, { ...use, input: use.input ?? {} }, turn);
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      });
      state.calls.push({
        turn: step + 1,
        tool: use.name,
        input: summarizeInput(use.input),
        failed: result.isError,
        ...(result.isError ? { error: truncate(result.content, 300) } : {}),
      });
    }
    messages.push({ role: "user", content: results });
  }
  const output: AgentCaseOutput = {
    delegatedAgentIds: state.delegatedAgentIds,
    completedAgentIds: state.completedAgentIds,
    editedFiles: state.editedFiles,
    delegatedProviders: state.delegatedProviders,
    citations: citationsIn(finalText),
    subQueryCount: state.subQueryCount,
    reported: finalText.trim().length > 0 && stopReason !== "max_steps",
    maxSameTurnDispatches: state.maxSameTurnDispatches,
    delegationPrecededEdits:
      state.firstEditAt === undefined ||
      (state.firstDelegationAt !== undefined && state.firstDelegationAt < state.firstEditAt),
    testEvidence:
      state.testOutput !== undefined && reportsTestEvidence(state.testOutput, finalText),
    delegations: state.delegations,
  };
  return {
    output,
    grade: gradeAgentCase({ expectation: testCase.expect, output }),
    usage,
    stopReason,
    finalText,
    toolCalls: state.calls,
  } satisfies SampleResult;
});

type ResultRow = {
  readonly id: string;
  readonly source: string;
  readonly agentId: string;
  readonly model: string;
  readonly sample: number;
  readonly pass: boolean;
  readonly failures: ReadonlyArray<string>;
  readonly output: AgentCaseOutput | undefined;
  readonly usage: Usage;
  readonly costUsd: number | undefined;
  readonly stopReason: string;
  readonly finalText: string;
  readonly toolCalls: ReadonlyArray<ToolCallRecord>;
  readonly error: string | undefined;
};

const runOne = (
  testCase: AgentCase,
  sample: number,
): Effect.Effect<ResultRow, never, HttpClient.HttpClient> => {
  const usage = emptyUsage();
  return runSample(testCase, usage).pipe(
    Effect.matchCause({
      onFailure: (cause) => {
        const error = redact(Cause.pretty(cause));
        return {
          id: testCase.id,
          source: testCase.source,
          agentId: testCase.agentId,
          model,
          sample: sample + 1,
          pass: false,
          failures: ["run failed."],
          output: undefined,
          usage,
          costUsd: costOf(usage),
          stopReason: "error",
          finalText: "",
          toolCalls: [],
          error,
        };
      },
      onSuccess: (result) => ({
        id: testCase.id,
        source: testCase.source,
        agentId: testCase.agentId,
        model,
        sample: sample + 1,
        pass: result.grade.pass,
        failures: result.grade.failures,
        output: result.output,
        usage: result.usage,
        costUsd: costOf(result.usage),
        stopReason: result.stopReason,
        finalText: result.finalText,
        toolCalls: result.toolCalls,
        error: undefined,
      }),
    }),
    Effect.tap((row) =>
      Effect.log(`${row.id} sample ${row.sample}: ${row.pass ? "pass" : "fail"}`),
    ),
  );
};

const runCase = Effect.fn("evaluateAgentDefinitions.runCase")(function* (testCase: AgentCase) {
  const first = yield* Effect.forEach(
    Array.from({ length: samplesPerCase }, (_, sample) => sample),
    (sample) => runOne(testCase, sample),
  );
  const split = adaptiveSamples && new Set(first.map((row) => row.pass)).size > 1;
  return split ? [...first, yield* runOne(testCase, samplesPerCase)] : first;
});

const BaselineRow = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    sample: Schema.Number,
    pass: Schema.Boolean,
    model: Schema.optional(Schema.String),
  }),
  Rest,
);
const decodeBaseline = Schema.decodeUnknownSync(Schema.Array(BaselineRow));

const baselineRates = (): ReadonlyMap<string, number> | undefined => {
  if (values.baseline === undefined) return undefined;
  const rows = decodeBaseline(JSON.parse(NodeFS.readFileSync(values.baseline, "utf8")));
  const models = new Set(rows.flatMap((row) => (row.model === undefined ? [] : [row.model])));
  if (models.size > 1 || (models.size === 1 && !models.has(model))) {
    throw new Error(
      `Baseline was recorded on ${[...models].join(", ")}; compare on the same model as this run (${model}).`,
    );
  }
  const byId = new Map<string, Array<{ readonly pass: boolean }>>();
  for (const row of rows) {
    const own = byId.get(row.id) ?? [];
    own.push(row);
    byId.set(row.id, own);
  }
  return new Map(
    [...byId].map(([id, own]) => [
      id,
      own.filter((row) => row.pass).length / Math.max(own.length, 1),
    ]),
  );
};

const commit = (() => {
  try {
    return NodeChildProcess.execFileSync("git", ["describe", "--always", "--dirty"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
})();

const percent = (rate: number) => `${Math.round(rate * 100)}%`;
const byCase = (rows: ReadonlyArray<ResultRow>) => {
  const grouped = new Map<string, Array<ResultRow>>();
  for (const row of rows) {
    const own = grouped.get(row.id) ?? [];
    own.push(row);
    grouped.set(row.id, own);
  }
  return grouped;
};

const program = Effect.gen(function* () {
  // Read and validate the baseline before spending on model calls.
  const before = baselineRates();
  const rows = (yield* Effect.forEach(selected, (testCase) => runCase(testCase), {
    concurrency: 3,
  })).flat();
  const grouped = byCase(rows);
  const cases = selected.map((testCase) => {
    const own = grouped.get(testCase.id) ?? [];
    const passes = own.filter((row) => row.pass).length;
    const rate = passes / Math.max(own.length, 1);
    const previous = before?.get(testCase.id);
    return { testCase, own, passes, rate, pass: rate > 0.5, previous };
  });
  const errors = rows.filter((row) => row.error !== undefined);
  const priced = rows.filter((row) => row.costUsd !== undefined);
  const totalCost = priced.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  const tokens = rows.reduce(
    (total, row) => ({
      input: total.input + row.usage.input,
      output: total.output + row.usage.output,
      cacheWrite: total.cacheWrite + row.usage.cacheWrite,
      cacheRead: total.cacheRead + row.usage.cacheRead,
    }),
    emptyUsage(),
  );
  const sampleCounts = [...new Set(cases.map((entry) => entry.own.length))].sort();
  const costLine =
    priced.length === rows.length
      ? `- Estimated cost $${totalCost.toFixed(2)} for ${rows.length} samples ($${(totalCost / Math.max(rows.length, 1)).toFixed(3)} per sample).`
      : `- Cost: ${priced.length} of ${rows.length} samples priced; \`${model}\` has no price in run.ts. Tokens: input ${tokens.input}, output ${tokens.output}, cache write ${tokens.cacheWrite}, cache read ${tokens.cacheRead}.`;
  const summary = [
    "# Agent definitions eval",
    "",
    `- Commit \`${commit}\`, model \`${model}\`, ${sampleCounts.join("-")} samples per case, ${selected.length} cases.`,
    `- Pass: ${cases.filter((entry) => entry.pass).length}/${cases.length} cases, ${rows.filter((row) => row.pass).length}/${rows.length} samples.`,
    costLine,
    "- Persona prompts are imported from `apps/server/src/agents/builtin.ts`; no prompt text is copied into this eval.",
    "- The structural grader checks process, not report quality. Read `review.md` for each final answer; for the debate case, a person confirms the two sides converge.",
    "",
    "| Case | Pass | Samples | Baseline | Delta |",
    "| --- | --- | --- | --- | --- |",
    ...cases.map(({ testCase, pass, passes, own, previous, rate }) => {
      const delta =
        previous === undefined
          ? "new | |"
          : `${percent(previous)} | ${Math.round((rate - previous) * 100)} pts |`;
      return `| ${testCase.id} | ${pass ? "pass" : "fail"} | ${passes}/${own.length} | ${delta}`;
    }),
  ];
  if (cases.some((entry) => !entry.pass)) {
    summary.push("", "## Failures", "");
    for (const row of rows.filter((entry) => !entry.pass)) {
      summary.push(
        `- \`${row.id}\` sample ${row.sample}: ${row.error === undefined ? row.failures.join(" ") : "run failed; see Errors."}`,
      );
    }
  }
  if (errors.length > 0) {
    summary.push("", "## Errors", "");
    for (const row of errors) {
      summary.push(`- \`${row.id}\` sample ${row.sample}: ${truncate(row.error ?? "", 400)}`);
    }
  }
  const review = [
    "# Agent definitions review",
    "",
    `Model \`${model}\`, ${rows.length} samples. Read the final answers; \`summary.md\` has the structural grade.`,
    "",
  ];
  for (const testCase of selected) {
    review.push(
      `## ${testCase.id}`,
      "",
      `Source: ${testCase.source}`,
      `Agent: ${testCase.agentId === NO_PERSONA_AGENT_ID ? "none (control)" : testCase.agentId}`,
      `Task: ${testCase.task}`,
      "",
    );
    if (testCase.id === "t3-debate") {
      review.push(
        "Convergence: confirm the answer presents both sides and ends with one recommendation; the grader only checks the dispatch shape.",
        "",
      );
    }
    for (const row of grouped.get(testCase.id) ?? []) {
      const output = row.output;
      review.push(
        `### Sample ${row.sample}: ${row.pass ? "pass" : "fail"}`,
        "",
        `- Delegated: ${output?.delegatedAgentIds.length ? output.delegatedAgentIds.join(", ") : "none"}`,
        `- Providers: ${output?.delegatedProviders.length ? output.delegatedProviders.join(", ") : "none"}`,
        `- Edited: ${output?.editedFiles.length ? output.editedFiles.join(", ") : "none"}`,
        `- Test evidence: ${output?.testEvidence === true ? "yes" : "no"}`,
        `- Citations: ${output?.citations.length ?? 0}`,
        `- Failures: ${row.error === undefined ? (row.failures.length > 0 ? row.failures.join(" ") : "none") : "run failed; see results.json."}`,
        "",
        "Final answer:",
        "",
        "````text",
        row.finalText.trim() || "(none)",
        "````",
        "",
      );
    }
  }
  return {
    rows,
    summary: `${summary.join("\n")}\n`,
    review: `${review.join("\n")}\n`,
  };
});

const result = await Effect.runPromise(program.pipe(Effect.provide(FetchHttpClient.layer)));
NodeFS.mkdirSync(outputDirectory, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(outputDirectory, "results.json"),
  `${JSON.stringify(result.rows, null, 2)}\n`,
);
NodeFS.writeFileSync(NodePath.join(outputDirectory, "summary.md"), result.summary);
NodeFS.writeFileSync(NodePath.join(outputDirectory, "review.md"), result.review);
process.stdout.write(
  `Wrote ${result.rows.length} samples to ${outputDirectory}.\n\n${result.summary}`,
);
