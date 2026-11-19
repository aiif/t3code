# Agent definitions

Measures whether the six built-in personas (tech lead, coder, reviewer, researcher, debate, deep
research) make the model do the right thing: delegate before editing, stay read-only when told,
put a debate on two providers, and cite a deep-research report.

Prompts are imported from `apps/server/src/agents/builtin.ts`; this eval never copies them.

## Run

```sh
cd evals
pnpm agent-definitions --model <cheapest acceptable model> --out runs/agent-definitions
pnpm agent-definitions --model <model> --out runs/agent-definitions --case t3-tech-lead
```

`--case <id>` limits a run while iterating. One full run per model before merge. Record its cost
here and keep `runs/` out of Git.

## Cases

Each case in `cases.ts` names its source, the agent id, the task, and an expectation in
`grading.ts`. `run.test.ts` covers the grader in CI; the paid run is manual.

- baseline: no persona, the model edits directly (control);
- tech lead: dispatches `delegate_task` before touching files and reviews on another provider;
- coder: edits in the task worktree, reports test evidence, never delegates;
- reviewer: findings only, no edits, no delegation;
- debate: two same-turn dispatches to different providers, then a converged recommendation;
- deep research: 3–6 sub-queries and a cited report.

## Cost

Not yet measured. Lane evals records the model, sample count, and cost of the first full run.
