import { DEFAULT_AGENT_DELEGATION } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
// @effect-diagnostics nodeBuiltinImport:off - the shared fixture writes real temp files.
import * as NodeFSP from "node:fs/promises";

import {
  decodeAgentDefinition,
  decodeAgentDefinitionYaml,
  MAX_AGENT_DEFINITION_BYTES,
  validateAgentPaths,
} from "./AgentDefinition.ts";
import { agentYaml, createAgentFixture } from "./AgentRegistry.testkit.ts";

const path = "C:/agents/my-agent.yaml";

const decode = (contents: string) => decodeAgentDefinition({ path, contents });

const messages = (contents: string): string =>
  decode(contents)
    .issues.map((issue) => issue.message)
    .join("\n");

const validYaml = `schemaVersion: 1
id: my-reviewer
name: My Reviewer
description: Reviews a diff read-only and returns prioritized findings.
provider:
  instance: codex
  model: gpt-5
  options:
    effort: high
    fast: true
prompt: You are a strict code reviewer.
delegation:
  enabled: true
  allowedAgents: [t3-coder]
  maxDepth: 2
  maxParallel: 3
  defaultIsolation: worktree
  defaultMode: wait
runtimeMode: approval-required
interactionMode: plan
`;

describe("decodeAgentDefinition", () => {
  it("decodes a complete definition", () => {
    const result = decode(validYaml);
    expect(result.issues).toEqual([]);
    expect(result.definition).toMatchObject({
      schemaVersion: 1,
      id: "my-reviewer",
      name: "My Reviewer",
      provider: {
        instance: "codex",
        model: "gpt-5",
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      delegation: {
        enabled: true,
        allowedAgents: ["t3-coder"],
        maxDepth: 2,
        maxParallel: 3,
        defaultIsolation: "worktree",
        defaultMode: "wait",
      },
    });
    expect(result.definition?.provider?.options).toEqual([
      { id: "effort", value: "high" },
      { id: "fast", value: true },
    ]);
  });

  it("defaults delegation when it is omitted or partial", () => {
    const omitted = decode(agentYaml({ id: "plain-agent" }));
    expect(omitted.definition?.delegation).toEqual(DEFAULT_AGENT_DELEGATION);

    const partial = decode(
      agentYaml({ id: "partial-agent", delegation: "enabled: true\nmaxParallel: 5" }),
    );
    expect(partial.definition?.delegation).toEqual({
      ...DEFAULT_AGENT_DELEGATION,
      enabled: true,
      maxParallel: 5,
    });
  });

  it("accepts a provider driver when no instance is set", () => {
    const result = decode(agentYaml({ id: "driver-agent", provider: "driver: claudeAgent" }));
    expect(result.issues).toEqual([]);
    expect(result.definition?.provider).toEqual({ driver: "claudeAgent" });
  });

  it("accepts an instance and driver that agree", () => {
    const result = decode(
      agentYaml({ id: "matching-agent", provider: "instance: codex\ndriver: codex" }),
    );
    expect(result.issues).toEqual([]);
  });

  it("rejects an instance and driver that disagree", () => {
    const result = decode(
      agentYaml({ id: "mismatch-agent", provider: "instance: codex\ndriver: claudeAgent" }),
    );
    expect(result.definition).toBeUndefined();
    expect(result.issues[0]?.message).toContain("does not match provider.instance");
  });

  it("rejects unknown keys at every level", () => {
    expect(messages(agentYaml({ id: "top-level", extra: "colour: red" }))).toContain(
      "colour: Expected no excess property",
    );
    expect(messages(agentYaml({ id: "nested", provider: "instance: codex\nowner: me" }))).toContain(
      "provider.owner: Expected no excess property",
    );
    expect(
      messages(
        agentYaml({
          id: "delegation-nested",
          delegation: "enabled: true\nsurprise: yes",
        }),
      ),
    ).toContain("delegation.surprise: Expected no excess property");
  });

  it("rejects a missing schema version and a bad id", () => {
    expect(
      messages(agentYaml({ id: "missing-version" }).replace("schemaVersion: 1\n", "")),
    ).toContain("schemaVersion");
    expect(messages(agentYaml({ id: "Bad Id" }))).toContain("id");
    expect(messages(agentYaml({ id: "a..b" }))).toContain("consecutive dots");
  });

  it("enforces the string limits", () => {
    expect(messages(agentYaml({ id: "long-name", name: "n".repeat(81) }))).toContain("at most 80");
    expect(messages(agentYaml({ id: "long-description", description: "d".repeat(241) }))).toContain(
      "at most 240",
    );
    expect(messages(agentYaml({ id: "long-prompt", prompt: "p".repeat(20_001) }))).toContain(
      "at most 20000",
    );
    expect(messages(agentYaml({ id: "blank-prompt", prompt: "   " }))).toContain("non-blank");
  });

  it("enforces delegation bounds and allowed-agent count", () => {
    expect(
      messages(agentYaml({ id: "deep-agent", delegation: "enabled: true\nmaxDepth: 6" })),
    ).toContain("between 1 and 5");
    expect(
      messages(agentYaml({ id: "wide-agent", delegation: "enabled: true\nmaxParallel: 9" })),
    ).toContain("between 1 and 8");
    const allowedAgents = Array.from({ length: 33 }, (_, index) => `agent-${index}`).join(", ");
    expect(
      messages(
        agentYaml({
          id: "many-children",
          delegation: `enabled: true\nallowedAgents: [${allowedAgents}]`,
        }),
      ),
    ).toContain("at most 32");
  });

  it("rejects multiple documents and reports YAML positions", () => {
    const multiple = decode(`${agentYaml({ id: "first" })}---\nid: second\n`);
    expect(multiple.definition).toBeUndefined();
    expect(multiple.issues[0]?.message).toContain("exactly one YAML document");

    const malformed = decode("schemaVersion: 1\nid: [\n");
    expect(malformed.definition).toBeUndefined();
    expect(malformed.issues[0]?.line).toBeGreaterThan(0);
    expect(malformed.issues[0]?.column).toBeGreaterThan(0);
  });

  it("rejects a file over 256 KiB", () => {
    const oversized = `prompt: ${"x".repeat(MAX_AGENT_DEFINITION_BYTES)}\n`;
    const result = decode(oversized);
    expect(result.definition).toBeUndefined();
    expect(result.issues[0]?.message).toContain("256 KiB");
  });

  it.effect("fails decodeAgentDefinitionYaml with the file path", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decodeAgentDefinitionYaml({ path, contents: "schemaVersion: 1\n" }),
      );
      expect(error.reason).toBe("invalid");
      expect(error.path).toBe(path);
    }),
  );

  it.effect("returns the definition from decodeAgentDefinitionYaml", () =>
    Effect.gen(function* () {
      const definition = yield* decodeAgentDefinitionYaml({
        path,
        contents: agentYaml({ id: "effect-agent" }),
      });
      expect(definition.id).toBe("effect-agent");
    }),
  );
});

describe("validateAgentPaths", () => {
  it.effect("collects issues from every file and expands directories", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.promise(() => createAgentFixture()),
        (value) => Effect.promise(() => value.dispose()),
      );
      yield* Effect.promise(() =>
        fixture.writeGlobal("valid.yaml", agentYaml({ id: "valid-agent" })),
      );
      yield* Effect.promise(() =>
        fixture.writeGlobal(
          "invalid.yaml",
          agentYaml({ id: "invalid-agent", extra: "colour: red" }),
        ),
      );
      yield* Effect.promise(() =>
        fixture.writeGlobal("duplicate.yaml", agentYaml({ id: "valid-agent" })),
      );
      const nestedDir = `${fixture.globalAgentsDir}/nested`;
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(nestedDir, { recursive: true });
        await NodeFSP.writeFile(`${nestedDir}/deep.yml`, agentYaml({ id: "nested-agent" }), "utf8");
        await NodeFSP.writeFile(`${nestedDir}/ignored.txt`, "not yaml", "utf8");
      });

      const result = yield* validateAgentPaths([fixture.globalAgentsDir]);
      expect(result.fileCount).toBe(4);
      expect(result.issues.some((issue) => issue.message.includes("colour"))).toBe(true);
      expect(result.issues.some((issue) => issue.message.includes("Duplicate agent id"))).toBe(
        true,
      );
      expect(result.issues.some((issue) => issue.path.endsWith("invalid.yaml"))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("reports a scope over 100 files", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.promise(() => createAgentFixture()),
        (value) => Effect.promise(() => value.dispose()),
      );
      yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 101 }, (_, index) =>
            fixture.writeGlobal(`agent-${index}.yaml`, agentYaml({ id: `agent-${index}` })),
          ),
        ),
      );

      const result = yield* validateAgentPaths([fixture.globalAgentsDir]);
      expect(result.fileCount).toBe(101);
      expect(result.issues.some((issue) => issue.message.includes("limit is 100"))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("reports a file over 256 KiB", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.acquireRelease(
        Effect.promise(() => createAgentFixture()),
        (value) => Effect.promise(() => value.dispose()),
      );
      yield* Effect.promise(() =>
        fixture.writeGlobal("huge.yaml", `prompt: ${"x".repeat(MAX_AGENT_DEFINITION_BYTES)}\n`),
      );

      const result = yield* validateAgentPaths([fixture.globalAgentsDir]);
      expect(result.fileCount).toBe(1);
      expect(result.issues[0]?.message).toContain("256 KiB");
    }).pipe(Effect.scoped),
  );
});
