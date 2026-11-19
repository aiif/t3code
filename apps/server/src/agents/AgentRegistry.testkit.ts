// @effect-diagnostics nodeBuiltinImport:off - tests need real temp directories on disk.
import {
  AgentId,
  type AgentDefinition,
  DEFAULT_AGENT_DELEGATION,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
} from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { BUILTIN_AGENTS } from "./builtin.ts";
import { type ResolvedAgentDefinition, layerStatic } from "./AgentRegistry.ts";

export interface AgentFixture {
  readonly root: string;
  readonly home: string;
  readonly globalAgentsDir: string;
  readonly projectRoot: string;
  readonly projectAgentsDir: string;
  readonly writeGlobal: (fileName: string, contents: string) => Promise<string>;
  readonly writeProject: (fileName: string, contents: string) => Promise<string>;
  readonly dispose: () => Promise<void>;
}

/** Temp T3 home plus temp project root, each with its own agents directory. */
export async function createAgentFixture(prefix = "t3-agents-"): Promise<AgentFixture> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  const home = NodePath.join(root, "home");
  const globalAgentsDir = NodePath.join(home, "agents");
  const projectRoot = NodePath.join(root, "project");
  const projectAgentsDir = NodePath.join(projectRoot, ".t3code", "agents");
  await Promise.all([
    NodeFSP.mkdir(globalAgentsDir, { recursive: true }),
    NodeFSP.mkdir(projectAgentsDir, { recursive: true }),
  ]);
  const write = async (directory: string, fileName: string, contents: string) => {
    const filePath = NodePath.join(directory, fileName);
    await NodeFSP.writeFile(filePath, contents, "utf8");
    return filePath;
  };
  return {
    root,
    home,
    globalAgentsDir,
    projectRoot,
    projectAgentsDir,
    writeGlobal: (fileName, contents) => write(globalAgentsDir, fileName, contents),
    writeProject: (fileName, contents) => write(projectAgentsDir, fileName, contents),
    dispose: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}

export const builtinResolvedAgents = (
  source: ResolvedAgentDefinition["source"] = "builtin",
): ReadonlyArray<ResolvedAgentDefinition> =>
  BUILTIN_AGENTS.map((definition) => ({ definition, source }));

export const exampleAgentDefinition = (id: string): AgentDefinition => ({
  schemaVersion: 1,
  id: AgentId.make(id),
  name: `Agent ${id}`,
  description: `Test agent ${id}.`,
  prompt: `You are ${id}. Do the task.`,
  delegation: { ...DEFAULT_AGENT_DELEGATION },
});

/** A fixed registry layer; omit entries to serve the built-ins. */
export const staticAgentRegistryLayer = (
  entries: ReadonlyArray<ResolvedAgentDefinition> = builtinResolvedAgents(),
) => layerStatic(entries);

export function fakeProviderSnapshot(input: {
  readonly instanceId?: ProviderInstanceId;
  readonly driver?: ProviderDriverKind;
  readonly model?: string;
  readonly enabled?: boolean;
  readonly optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor>;
}): ServerProvider {
  const model = input.model ?? "test-model";
  return {
    instanceId: input.instanceId ?? ProviderInstanceId.make("test-provider"),
    driver: input.driver ?? ProviderDriverKind.make("opencode"),
    enabled: input.enabled ?? true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-19T00:00:00.000Z",
    models: [
      {
        slug: model,
        name: model,
        isCustom: false,
        capabilities:
          input.optionDescriptors === undefined
            ? null
            : { optionDescriptors: input.optionDescriptors },
      },
    ],
    slashCommands: [],
    skills: [],
  };
}
