import { AgentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
// @effect-diagnostics nodeBuiltinImport:off - the shared fixture writes real temp files.
import * as NodeFSP from "node:fs/promises";

import {
  type AgentFixture,
  agentRegistryLayer,
  agentYaml,
  builtinResolvedAgents,
  createAgentFixture,
  staticAgentRegistryLayer,
} from "./AgentRegistry.testkit.ts";
import { AgentRegistry, toAgentSummary } from "./AgentRegistry.ts";
import { BUILTIN_AGENT_IDS, BUILTIN_AGENTS } from "./builtin.ts";

const withRegistry = <A, E>(
  use: (fixture: AgentFixture, registry: AgentRegistry["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fixture = yield* Effect.acquireRelease(
      Effect.promise(() => createAgentFixture()),
      (value) => Effect.promise(() => value.dispose()),
    );
    return yield* Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      return yield* use(fixture, registry);
    }).pipe(Effect.provide(agentRegistryLayer(fixture)));
  }).pipe(Effect.scoped);

const layer = staticAgentRegistryLayer();

describe("built-in agents", () => {
  it("ships all six reserved ids in list order", () => {
    expect(BUILTIN_AGENTS.map((definition) => definition.id)).toEqual([
      "t3-tech-lead",
      "t3-coder",
      "t3-reviewer",
      "t3-researcher",
      "t3-debate",
      "t3-deep-research",
    ]);
    expect(BUILTIN_AGENT_IDS).toEqual(BUILTIN_AGENTS.map((definition) => definition.id));
  });

  it("freezes delegation values", () => {
    const lead = BUILTIN_AGENTS.find((definition) => definition.id === "t3-tech-lead");
    expect(lead?.delegation).toMatchObject({
      enabled: true,
      maxDepth: 2,
      maxParallel: 4,
      defaultIsolation: "worktree",
    });
    const coder = BUILTIN_AGENTS.find((definition) => definition.id === "t3-coder");
    expect(coder?.delegation?.enabled).toBe(false);
  });
});

describe("AgentRegistry static layer", () => {
  it.effect("lists built-ins and filters by search", () =>
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const page = yield* registry.list({});
      expect(page.agents).toHaveLength(6);
      const filtered = yield* registry.list({ search: "prioritized" });
      expect(filtered.agents.map((agent) => agent.id)).toEqual(["t3-reviewer"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads a definition by id and refuses an unknown id", () =>
    Effect.gen(function* () {
      const registry = yield* AgentRegistry;
      const resolved = yield* registry.read({ agentId: AgentId.make("t3-coder") });
      expect(resolved.source).toBe("builtin");
      const error = yield* Effect.flip(registry.read({ agentId: AgentId.make("not-an-agent") }));
      expect(error.reason).toBe("not_found");
    }).pipe(Effect.provide(layer)),
  );

  it("summarizes delegation and provider defaults", () => {
    const summary = toAgentSummary(builtinResolvedAgents()[0]!);
    expect(summary).toMatchObject({
      id: "t3-tech-lead",
      source: "builtin",
      providerInstanceId: null,
      driverKind: null,
      model: null,
      delegationEnabled: true,
      maxDepth: 2,
      maxParallel: 4,
    });
  });
});

describe("AgentRegistry file loader", () => {
  it("ships six built-ins with non-empty prompts", () => {
    expect(BUILTIN_AGENTS).toHaveLength(6);
    for (const definition of BUILTIN_AGENTS) {
      expect(definition.prompt.trim().length).toBeGreaterThan(0);
    }
  });

  it.effect("merges built-ins, global, and project with project winning", () =>
    withRegistry((fixture, registry) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          fixture.writeGlobal(
            "custom.yaml",
            agentYaml({ id: "my-agent", name: "Global Agent", description: "Global." }),
          ),
        );
        yield* Effect.promise(() =>
          fixture.writeProject(
            "custom.yaml",
            agentYaml({ id: "my-agent", name: "Project Agent", description: "Project." }),
          ),
        );

        const page = yield* registry.list({ projectRoot: fixture.projectRoot });
        expect(page.agents.map((agent) => agent.id)).toEqual([
          ...BUILTIN_AGENTS.map((definition) => definition.id),
          "my-agent",
        ]);
        const project = page.agents.find((agent) => agent.id === "my-agent");
        expect(project).toMatchObject({
          name: "Project Agent",
          source: "project",
        });
      }),
    ),
  );

  it.effect("lets a project file shadow a built-in without duplicating it", () =>
    withRegistry((fixture, registry) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          fixture.writeProject(
            "coder.yaml",
            agentYaml({ id: "t3-coder", name: "Project Coder", description: "Project coder." }),
          ),
        );

        const page = yield* registry.list({ projectRoot: fixture.projectRoot });
        expect(page.agents).toHaveLength(6);
        const coder = page.agents[1];
        expect(coder).toMatchObject({ id: "t3-coder", name: "Project Coder", source: "project" });
        expect(page.agents.filter((agent) => agent.id === "t3-coder")).toHaveLength(1);
      }),
    ),
  );

  it.effect("warns about duplicate ids inside one scope", () =>
    withRegistry((fixture, registry) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          fixture.writeGlobal("a.yaml", agentYaml({ id: "duplicate-agent", name: "First" })),
        );
        yield* Effect.promise(() =>
          fixture.writeGlobal("b.yaml", agentYaml({ id: "duplicate-agent", name: "Second" })),
        );

        const page = yield* registry.list({ projectRoot: fixture.projectRoot });
        expect(page.agents.filter((agent) => agent.id === "duplicate-agent")).toHaveLength(1);
        expect(page.agents.find((agent) => agent.id === "duplicate-agent")?.name).toBe("First");
        expect(page.warnings?.some((warning) => warning.includes("duplicate agent id"))).toBe(true);
      }),
    ),
  );

  it.effect("skips bad files and reports them as warnings", () =>
    withRegistry((fixture, registry) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fixture.writeGlobal("bad.yaml", "schemaVersion: 1\n"));
        yield* Effect.promise(() =>
          fixture.writeGlobal("good.yaml", agentYaml({ id: "good-agent" })),
        );

        const page = yield* registry.list({ projectRoot: fixture.projectRoot });
        expect(page.agents.some((agent) => agent.id === "good-agent")).toBe(true);
        expect(page.warnings?.some((warning) => warning.includes("bad.yaml"))).toBe(true);
      }),
    ),
  );

  it.effect("reloads a file after its mtime changes", () =>
    withRegistry((fixture, registry) =>
      Effect.gen(function* () {
        const filePath = yield* Effect.promise(() =>
          fixture.writeGlobal("reload.yaml", agentYaml({ id: "reload-agent", name: "Agent One" })),
        );
        const first = yield* registry.read({
          agentId: AgentId.make("reload-agent"),
          projectRoot: fixture.projectRoot,
        });
        expect(first.definition.name).toBe("Agent One");

        yield* Effect.promise(() =>
          fixture.writeGlobal("reload.yaml", agentYaml({ id: "reload-agent", name: "Agent Two" })),
        );
        yield* Effect.promise(() => NodeFSP.utimes(filePath, 1_893_456_000, 1_893_456_000));

        const second = yield* registry.read({
          agentId: AgentId.make("reload-agent"),
          projectRoot: fixture.projectRoot,
        });
        expect(second.definition.name).toBe("Agent Two");
      }),
    ),
  );

  it.effect("ignores project files without a projectRoot", () =>
    withRegistry((fixture, registry) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          fixture.writeProject("project-only.yaml", agentYaml({ id: "project-only" })),
        );

        const withoutProject = yield* registry.list({});
        expect(withoutProject.agents.some((agent) => agent.id === "project-only")).toBe(false);
        const missing = yield* Effect.flip(
          registry.read({ agentId: AgentId.make("project-only") }),
        );
        expect(missing.reason).toBe("not_found");

        const withProject = yield* registry.read({
          agentId: AgentId.make("project-only"),
          projectRoot: fixture.projectRoot,
        });
        expect(withProject.source).toBe("project");
        expect(withProject.path?.startsWith(fixture.projectAgentsDir)).toBe(true);
      }),
    ),
  );

  it.effect("reads a global definition with its absolute path", () =>
    withRegistry((fixture, registry) =>
      Effect.gen(function* () {
        const filePath = yield* Effect.promise(() =>
          fixture.writeGlobal("global.yaml", agentYaml({ id: "global-agent" })),
        );

        const resolved = yield* registry.read({
          agentId: AgentId.make("global-agent"),
          projectRoot: fixture.projectRoot,
        });
        expect(resolved.source).toBe("global");
        expect(resolved.path).toBe(filePath);
      }),
    ),
  );
});

describe("agent fixture", () => {
  it("writes definitions under the project root and the T3 home", async () => {
    const fixture = await createAgentFixture();
    try {
      const projectPath = await fixture.writeProject("agent.yaml", "schemaVersion: 1\n");
      expect(projectPath.startsWith(fixture.projectAgentsDir)).toBe(true);
      expect(await NodeFSP.readFile(projectPath, "utf8")).toContain("schemaVersion");
      const globalPath = await fixture.writeGlobal("agent.yaml", "schemaVersion: 1\n");
      expect(globalPath.startsWith(fixture.globalAgentsDir)).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });
});
