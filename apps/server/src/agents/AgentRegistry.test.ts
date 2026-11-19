import { AgentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
// @effect-diagnostics nodeBuiltinImport:off - the shared fixture writes real temp files.
import * as NodeFSP from "node:fs/promises";

import {
  builtinResolvedAgents,
  createAgentFixture,
  staticAgentRegistryLayer,
} from "./AgentRegistry.testkit.ts";
import { AgentRegistry, toAgentSummary } from "./AgentRegistry.ts";
import { BUILTIN_AGENT_IDS, BUILTIN_AGENTS } from "./builtin.ts";

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
