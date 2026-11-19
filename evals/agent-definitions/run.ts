#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeUtil from "node:util";

import { agentDefinitionCases } from "./cases.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    model: { type: "string" },
    case: { type: "string", multiple: true },
    out: { type: "string" },
    baseline: { type: "string" },
  },
});

if (values.out === undefined) throw new Error("Use --model <configured-model> --out <directory>.");

for (const id of values.case ?? []) {
  if (!agentDefinitionCases.some((testCase) => testCase.id === id)) {
    throw new Error(`Unknown case id: ${id}.`);
  }
}

if (agentDefinitionCases.length === 0) {
  process.stdout.write(
    "No agent-definition cases are defined yet. Lane evals fills cases.ts, then reruns this harness.\n",
  );
  process.exit(0);
}

// Lane evals replaces this with the paid model runner: one fake thread per case,
// a real provider turn, and a transcript reader that feeds grading.ts.
throw new Error(
  "The agent-definitions paid runner is not implemented yet; lane evals owns run.ts.",
);
