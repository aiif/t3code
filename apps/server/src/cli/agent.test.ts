// @effect-diagnostics nodeBuiltinImport:off - the shared fixture writes real temp files.
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import {
  AgentId,
  DEFAULT_AGENT_DELEGATION,
  ProviderInstanceId,
  type AgentDefinition,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import * as AgentRegistryModule from "../agents/AgentRegistry.ts";
import { type AgentFixture, createAgentFixture } from "../agents/AgentRegistry.testkit.ts";
import { BUILTIN_AGENTS } from "../agents/builtin.ts";
import { makeAgentCommand, type ValidateAgentPaths } from "./agent.ts";

const AgentRegistry = AgentRegistryModule.AgentRegistry;
const toAgentSummary = AgentRegistryModule.toAgentSummary;
type ResolvedAgentDefinition = AgentRegistryModule.ResolvedAgentDefinition;

type AgentManagerFixture = AgentFixture & { readonly path: typeof NodePath };

const makeAgentManagerFixture = () =>
  Effect.acquireRelease(
    Effect.promise(() => createAgentFixture()),
    (fixture) => Effect.promise(() => fixture.dispose()),
  ).pipe(Effect.map((fixture) => ({ ...fixture, path: NodePath })));

const runtimeLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  NetService.layer,
  TestConsole.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
);

const runCli = (command: ReturnType<typeof makeAgentCommand>, args: ReadonlyArray<string>) =>
  Command.runWith(command, { version: "0.0.0" })(args);

const coder = BUILTIN_AGENTS.find((definition) => definition.id === "t3-coder")!;

const globalDefinition = (): AgentDefinition => ({
  schemaVersion: 1,
  id: AgentId.make("global-reviewer"),
  name: "Global Reviewer",
  description: "Reviews changes from the global scope.",
  provider: {
    instance: ProviderInstanceId.make("claude-code"),
    model: "claude-sonnet-4-6",
    options: [{ id: "effort", value: "high" }],
  },
  prompt: "You are the global reviewer. Report findings.",
  delegation: {
    ...DEFAULT_AGENT_DELEGATION,
    enabled: true,
    allowedAgents: [AgentId.make("t3-coder")],
    maxDepth: 2,
    maxParallel: 3,
  },
  runtimeMode: "approval-required",
  interactionMode: "plan",
});

const projectDefinition = (): AgentDefinition => ({
  schemaVersion: 1,
  id: AgentId.make("project-helper"),
  name: "Project Helper",
  description: "Helps with this project.",
  prompt: "You are the project helper.",
});

const resolvedAgents = (fixture: AgentManagerFixture): ReadonlyArray<ResolvedAgentDefinition> => [
  { definition: coder, source: "builtin" },
  {
    definition: globalDefinition(),
    source: "global",
    path: fixture.path.join(fixture.globalAgentsDir, "global-reviewer.yaml"),
  },
  {
    definition: projectDefinition(),
    source: "project",
    path: fixture.path.join(fixture.projectAgentsDir, "project-helper.yaml"),
  },
];

describe("t3 agent list", () => {
  it.effect("prints aligned id, source, provider/model, and description columns", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAgentManagerFixture();
      const command = makeAgentCommand({
        registryLayer: AgentRegistryModule.layerStatic(resolvedAgents(fixture)),
      });

      yield* runCli(command, ["list", "--project", fixture.projectRoot]);

      const rows = (yield* TestConsole.logLines)
        .map(String)
        .join("\n")
        .split("\n")
        .map((line) => line.split(/\s{2,}/));
      assert.deepEqual(
        rows.map((row) => row[0]),
        ["t3-coder", "global-reviewer", "project-helper"],
      );
      assert.deepEqual(
        rows.map((row) => row[1]),
        ["builtin", "global", "project"],
      );
      assert.deepEqual(
        rows.map((row) => row[2]),
        ["inherit", "claude-code/claude-sonnet-4-6", "inherit"],
      );
      assert.deepEqual(
        rows.map((row) => row[3]),
        [coder.description, "Reviews changes from the global scope.", "Helps with this project."],
      );
    }).pipe(Effect.scoped, Effect.provide(runtimeLayer)),
  );

  it.effect("--json returns summaries and registry warnings", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAgentManagerFixture();
      const summaries = resolvedAgents(fixture).map(toAgentSummary);
      const layer = Layer.succeed(
        AgentRegistry,
        AgentRegistry.of({
          list: Effect.fn("test.agentRegistry.list")(() =>
            Effect.succeed({
              agents: summaries,
              warnings: ["global-reviewer.yaml: unknown key: tools"],
            }),
          ),
          read: Effect.fn("test.agentRegistry.read")(() =>
            Effect.die("t3 agent list should not read one agent"),
          ),
        }),
      );
      const command = makeAgentCommand({ registryLayer: layer });

      yield* runCli(command, ["list", "--json", "--project", fixture.projectRoot]);

      const printed = JSON.parse(String((yield* TestConsole.logLines).at(-1)));
      assert.deepEqual(printed, {
        agents: summaries,
        warnings: ["global-reviewer.yaml: unknown key: tools"],
      });
    }).pipe(Effect.scoped, Effect.provide(runtimeLayer)),
  );
});

describe("t3 agent show", () => {
  it.effect("prints the source, path, and prompt in a fenced block", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAgentManagerFixture();
      const command = makeAgentCommand({
        registryLayer: AgentRegistryModule.layerStatic(resolvedAgents(fixture)),
      });

      yield* runCli(command, ["show", "global-reviewer", "--project", fixture.projectRoot]);

      const output = (yield* TestConsole.logLines).map(String).join("\n");
      assert.include(output, "global-reviewer  (global)");
      assert.include(output, "Provider: claude-code/claude-sonnet-4-6");
      assert.include(output, "Options: effort=high");
      assert.include(
        output,
        `Path: ${fixture.path.join(fixture.globalAgentsDir, "global-reviewer.yaml")}`,
      );
      assert.include(output, "Delegation: enabled (depth 2, parallel 3");
      assert.include(output, "Allowed agents: t3-coder");
      assert.include(output, "```text\nYou are the global reviewer. Report findings.\n```");
    }).pipe(Effect.scoped, Effect.provide(runtimeLayer)),
  );

  it.effect("--json returns the resolved definition", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAgentManagerFixture();
      const command = makeAgentCommand({
        registryLayer: AgentRegistryModule.layerStatic(resolvedAgents(fixture)),
      });

      yield* runCli(command, [
        "show",
        "project-helper",
        "--json",
        "--project",
        fixture.projectRoot,
      ]);

      const printed = JSON.parse(String((yield* TestConsole.logLines).at(-1)));
      assert.equal(printed.definition.id, "project-helper");
      assert.equal(printed.definition.prompt, "You are the project helper.");
      assert.equal(printed.source, "project");
      assert.equal(
        printed.path,
        fixture.path.join(fixture.projectAgentsDir, "project-helper.yaml"),
      );
    }).pipe(Effect.scoped, Effect.provide(runtimeLayer)),
  );

  it.effect("reports an unknown id with the CLI's own list hint", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAgentManagerFixture();
      const command = makeAgentCommand({
        registryLayer: AgentRegistryModule.layerStatic(resolvedAgents(fixture)),
      });

      const error = yield* runCli(command, [
        "show",
        "missing-agent",
        "--project",
        fixture.projectRoot,
      ]).pipe(Effect.flip);

      assert.equal(error._tag, "AgentRegistryError");
      assert.include((yield* TestConsole.errorLines).map(String).join("\n"), "Run t3 agent list.");
    }).pipe(Effect.scoped, Effect.provide(runtimeLayer)),
  );
});

describe("t3 agent path", () => {
  it.effect("prints the global and project agent directories", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAgentManagerFixture();
      const command = makeAgentCommand();

      yield* runCli(command, [
        "path",
        "--project",
        fixture.projectRoot,
        "--base-dir",
        fixture.home,
      ]);

      assert.deepEqual((yield* TestConsole.logLines).map(String), [
        `Global: ${fixture.path.join(fixture.home, "agents")}`,
        `Project: ${fixture.path.join(fixture.projectRoot, ".t3code", "agents")}`,
      ]);
    }).pipe(Effect.scoped, Effect.provide(runtimeLayer)),
  );
});

describe("t3 agent validate", () => {
  it.effect("passes files and directories through and prints path:line:column", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAgentManagerFixture();
      const nested = fixture.path.join(fixture.projectAgentsDir, "nested");
      const first = fixture.path.join(fixture.projectAgentsDir, "first.yaml");
      const second = fixture.path.join(nested, "second.yml");
      const calls: Array<ReadonlyArray<string>> = [];
      const validate: ValidateAgentPaths = (paths) => {
        calls.push(paths);
        return Effect.succeed({
          issues: [
            { path: first, line: 3, column: 7, message: "unknown key: tools" },
            { path: second, message: "prompt is empty" },
          ],
          fileCount: 2,
        });
      };
      const command = makeAgentCommand({ validateAgentPaths: validate });

      const error = yield* runCli(command, ["validate", first, fixture.projectAgentsDir]).pipe(
        Effect.flip,
      );

      assert.equal(error._tag, "AgentValidationFailedError");
      assert.deepEqual(calls, [[first, fixture.projectAgentsDir]]);
      assert.deepEqual((yield* TestConsole.errorLines).map(String), [
        `${first}:3:7: unknown key: tools`,
        `${second}:1:1: prompt is empty`,
      ]);
    }).pipe(Effect.scoped, Effect.provide(runtimeLayer)),
  );

  it.effect("--json reports the decoded issues and still fails on any error", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAgentManagerFixture();
      const file = fixture.path.join(fixture.projectAgentsDir, "broken.yaml");
      const validate: ValidateAgentPaths = () =>
        Effect.succeed({
          issues: [{ path: file, line: 2, column: 4, message: "bad\nindent" }],
          fileCount: 1,
        });
      const command = makeAgentCommand({ validateAgentPaths: validate });

      const error = yield* runCli(command, ["validate", file, "--json"]).pipe(Effect.flip);

      assert.equal(error._tag, "AgentValidationFailedError");
      assert.deepEqual(JSON.parse(String((yield* TestConsole.logLines).at(-1))), {
        errors: [{ path: file, line: 2, column: 4, message: "bad indent" }],
      });
    }).pipe(Effect.scoped, Effect.provide(runtimeLayer)),
  );

  it.effect("prints a quiet success line and exits zero for a clean scope", () =>
    Effect.gen(function* () {
      const fixture = yield* makeAgentManagerFixture();
      const file = fixture.path.join(fixture.projectAgentsDir, "valid.yaml");
      const command = makeAgentCommand({
        validateAgentPaths: () => Effect.succeed({ issues: [], fileCount: 1 }),
      });

      yield* runCli(command, ["validate", file]);

      assert.deepEqual((yield* TestConsole.logLines).map(String), ["No agent definition errors."]);
    }).pipe(Effect.scoped, Effect.provide(runtimeLayer)),
  );
});
