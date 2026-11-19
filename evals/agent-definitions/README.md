# Agent definitions

Measures whether T3's built-in agent personas change what a model does on the same task: delegate
before editing, stay read-only when told, put a debate on two providers, and cite a deep-research
report. A no-persona baseline is the control.

Prompt text is imported from `apps/server/src/agents/builtin.ts` on every run. This eval never
copies a persona prompt; a prompt edit changes the paid run without touching this directory.

## What it measures

One fake thread per sample. Every case gets the same checkout (`/home/user/app`), the same file,
test, diff and delegation tools, and a simulated child that returns a canned completed result
immediately. Nothing runs on the machine, and no child agent runs.

| Case               | Persona          | The structural grade                                                                                                         |
| ------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `baseline`         | none             | edits a file, delegates to nobody, reports. The control.                                                                     |
| `t3-tech-lead`     | T3 Tech Lead     | delegates to `t3-coder` and `t3-reviewer` before its own first edit, with the reviewer on a different provider, and reports. |
| `t3-coder`         | T3 Coder         | edits, runs the tests, reports their result, delegates to nobody.                                                            |
| `t3-reviewer`      | T3 Reviewer      | edits nothing, delegates to nobody, reports findings.                                                                        |
| `t3-debate`        | T3 Debate        | at least two `delegate_task` calls in one assistant turn, on two providers, and reports.                                     |
| `t3-deep-research` | T3 Deep Research | 3–6 researcher sub-queries, at least three citations, no edits, and reports.                                                 |

`grading.ts` is a pure structural grader. It checks the transcript's calls and final text, never a
model's opinion of another model. `run.test.ts` runs it in CI. `review.md` from a paid run holds each
final answer: a person reads report quality and, for `t3-debate`, confirms the two sides converge.

The runner does not simulate runtime or interaction modes. Every persona gets the same file and
delegation tools, so the read-only checks measure whether the persona text steers the model, not
whether T3 would block a tool call.

## Run

Put `ANTHROPIC_API_KEY` in the repo root `.env` (gitignored; the eval script loads it). From
`evals/`:

```sh
pnpm agent-definitions --model claude-haiku-5-5 --out runs/agent-definitions
pnpm agent-definitions --model claude-haiku-5-5 --out runs/agent-definitions --case t3-coder --samples 1
```

- `--out <directory>` is required and receives `results.json`, `summary.md`, and `review.md`.
- `--model <id>` is required. This runner calls the Anthropic Messages API directly; use a Claude
  model. There is no proxy or Codex replay here.
- `--case <id>` is repeatable (also comma-separated) and limits a run while iterating.
- `--baseline <results.json>` compares per-case pass rates with an earlier run of the same model.
  A baseline recorded on another model is rejected before the paid calls start.
- `--samples <n>` overrides the default of 2 samples per case. Without the flag, a case whose two
  samples disagree gets a third to settle it, as `evals/README.md` asks.
- A failed sample is a failed sample, not an excluded one: errors count against its case and are
  listed in `summary.md`. Rate-limit and overload responses are retried with backoff.

The fake world has `src/retry.ts` with a retry loop that ignores its `attempts` argument, its
failing test, and a candidate diff for the reviewer. `--case` names are the ids in the table.

## Models

Prices are the ones `run.ts` uses to estimate a run. An unpriced model still runs; its results
record tokens without a dollar cost.

| Model               | Input $/M | Output $/M | Notes                                            |
| ------------------- | --------- | ---------- | ------------------------------------------------ |
| `claude-haiku-5-5`  | 0.10      | 0.50       | Cheapest acceptable model; use it for iteration. |
| `claude-sonnet-5-5` | 2.00      | 10.00      | One full run before a persona change merges.     |
| `claude-opus-5-5`   | 4.00      | 20.00      | A stronger check when a Sonnet case is close.    |

## Sample count and cost

Two samples per case by default, with a third when the first two disagree. A full run is therefore
6 cases × 2–3 samples, each at most 10 model calls.

**Not yet measured.** This lane could not start the paid run: the checkout has no
`ANTHROPIC_API_KEY` (no root `.env`), and at the foundation commit the built-in prompts are still
placeholders owned by `agents/registry`, so the persona cases would grade the placeholder rather
than the final text. The baseline control can run as soon as a key exists:

```sh
cd evals
pnpm agent-definitions --model claude-haiku-5-5 --out runs/agent-definitions --case baseline --samples 1
```

The full run to record after integration, on the same model:

```sh
cd evals
pnpm agent-definitions --model claude-haiku-5-5 --out runs/agent-definitions
```

Estimated cost for that full run: roughly $0.05–$0.50 on Haiku, $1–$5 on Sonnet, and $2–$10 on Opus,
depending on how long each report and tool result runs. The low end assumes short answers; the
ceiling is 6 cases × 3 samples × 10 calls × 4K output tokens. A single-case check is a few cents on
Haiku. Replace this paragraph with the measured model, sample count, and summary cost after the
first full run.

## Add a case

1. Add an object to `cases.ts`. `id` is the `--case` name, `source` says which persona or report it
   came from, and `agentId` is a built-in id or `none` for no persona. `task` is the user's message.
2. Put the checks in `expect`. Available: `editsFiles`, `readOnly`, `noDelegation`,
   `delegatesBeforeEditing`, `allowedAgents`, `minimumDelegations`, `differentProviderAgents`,
   `distinctProviders`, `sameTurnDispatches`, `testEvidence`,
   `minimumCitations`, `subQueries`, and `reports`. Extend `grading.ts` only for a case that needs a
   check the shape does not have.
3. Run `vp test run evals/agent-definitions/run.test.ts` from the repo root. Then run the new case
   on the text before the change, where it must fail, and after, where it must pass. Use
   `--baseline` to compare a small run with an earlier full one.
4. Keep prompts out of `cases.ts`. The runner imports `BUILTIN_AGENTS` and composes the first
   message with `composeAgentInstruction`, so the case always sees the current definition.

## Results

`results.json` is one row per sample: the case, the output the grader saw, failures, token usage,
estimated cost, stop reason, the final answer, and the tool calls. `summary.md` is the per-case pass
table, baseline delta, cost, and failures. `review.md` is for a person. `runs/` is gitignored; do
not commit a run.
