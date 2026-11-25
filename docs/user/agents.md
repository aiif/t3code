# Agent definitions

An agent definition is a named persona for a thread: its prompt, optional provider and model
defaults, permission modes, and whether it may delegate. T3 Code ships six built-ins, and you can
add your own as YAML files. Definitions belong to an environment, so a machine you control remotely
uses the files on that machine.

Agent definitions are local configuration, not accounts. They choose how a thread starts; they do
not grant access or change what a provider may do beyond the thread's permission mode.

## Where definitions live

T3 Code reads two directories:

- **Project:** `<projectRoot>/.t3code/agents/*.yaml`
- **Global:** `<T3 home>/agents/*.yaml`, by default `~/.t3/agents` (Windows:
  `%USERPROFILE%\.t3\agents`)

Run `t3 agent path` to print the exact directories for the current project and T3 home.

A project definition lives at the project root, not in a thread's worktree. A thread that runs in a
worktree still reads the project's definitions, and a definition checked into a worktree is not
picked up.

Resolution is by id, highest precedence first:

1. project
2. global
3. built-in

A project definition shadows a global definition with the same id, which shadows a built-in. The
whole definition is replaced, not merged field by field. Two files in one directory that define the
same id are an error, not a tie-break; remove or rename one.

The id is what threads store. Renaming an id creates a new agent; threads that already started keep
the old id.

## Write a definition

```yaml
schemaVersion: 1
id: careful-reviewer
name: Careful reviewer
description: Reviews a change read-only and returns prioritized findings.
prompt: |
  You review code changes. Read the diff, then the surrounding code before judging it.

  Return findings only, most serious first. Each finding names the file and line, the problem,
  and a concrete fix. Do not edit files, run commands that change state, or delegate work.
provider:
  instance: claudeAgent
  model: claude-sonnet-4-5
  options:
    effort: high
delegation:
  enabled: false
  maxDepth: 1
  maxParallel: 2
  defaultIsolation: shared
  defaultMode: async
runtimeMode: approval-required
interactionMode: plan
```

| Key               | Required | Meaning                                                                                                |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `schemaVersion`   | yes      | Must be `1`.                                                                                           |
| `id`              | yes      | Lowercase letters, digits, `.`, `_`, and `-`; starts with a letter or digit; at most 64 characters.    |
| `name`            | yes      | Shown in lists and the first-message chip; at most 80 characters.                                      |
| `description`     | yes      | One sentence for lists; at most 240 characters.                                                        |
| `prompt`          | yes      | The persona text sent with the first message; at most 20,000 characters.                               |
| `provider`        | no       | Defaults for the provider instance, driver, model, and provider options.                               |
| `delegation`      | no       | Whether this agent may start child tasks, which agents it may use, and its limits. Omitted means none. |
| `runtimeMode`     | no       | `inherit` or a permission mode: `approval-required`, `auto-accept-edits`, `auto`, `full-access`.       |
| `interactionMode` | no       | `inherit`, `default`, or `plan`.                                                                       |

Ready-to-copy examples for a reviewer, a coder, and a researcher live in
[`examples/agents`](../../examples/agents).

`provider` accepts:

- `instance`: a provider instance id from **Settings → Providers**. Use this to pin a specific
  account.
- `driver`: a driver kind such as `claudeAgent` or `codex`, for the environment's default instance
  of that driver.
- `model`: a model id from that provider.
- `options`: a map of provider option ids to string or boolean values, as shown in the provider's
  settings.

A definition with no `provider` block inherits the parent thread's provider and model for a
delegated child, or uses the project's default for a new thread. If you pin an instance or driver
but leave out `model`, T3 Code uses a model that provider offers. A definition that pins an
instance or model this machine does not have fails with `provider_unavailable` or
`model_unavailable`; fix the definition or the provider setup.

`delegation` accepts:

- `enabled`: whether this agent may start child tasks. It says nothing about whether other agents
  may delegate to it.
- `allowedAgents`: ids this agent may delegate to. Omit for any agent; use `[]` for none. At most
  32 ids.
- `maxDepth`: levels of descendants, from `1` to `5`. The runtime has an absolute cap of 8 levels.
- `maxParallel`: active child tasks under one parent thread, from `1` to `8`. The runtime has an
  absolute cap of 8.
- `defaultIsolation`: `shared` or `worktree`, used when a child does not choose.
- `defaultMode`: `async` or `wait`, used when a child does not choose.

Delegation does not widen permissions. A child cannot run with broader permission modes than the
thread that started it. Exceeding the depth or parallel limit fails with `agent_depth_exceeded` or
`agent_parallel_limit_reached`.

`runtimeMode` and `interactionMode` default to the parent thread's modes when omitted or set to
`inherit`.

## Built-in agents

| Id                 | What it does                                                                | Delegation                                                                                      |
| ------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `t3-tech-lead`     | Plans work, splits it up, reviews results, and reports.                     | `t3-coder`, `t3-reviewer`, `t3-researcher`, `t3-deep-research`; 4 at once, 2 levels, worktrees. |
| `t3-coder`         | Implements one scoped task and reports the diff and test evidence.          | None.                                                                                           |
| `t3-reviewer`      | Reviews a diff read-only and returns prioritized findings.                  | None. Runs with `approval-required` and `plan`.                                                 |
| `t3-researcher`    | Investigates a question and returns a cited summary.                        | None. Runs with `approval-required` and `plan`.                                                 |
| `t3-debate`        | Asks two providers the same question, presents both, then converges.        | `t3-researcher` only; 2 at once, 1 level.                                                       |
| `t3-deep-research` | Plans sub-queries, fans out read-only research, and returns a cited report. | `t3-researcher` only; 4 at once, 1 level.                                                       |

A team is just an agent with delegation enabled: its `allowedAgents` are its specialists, and
starting a thread with it is enough to launch the team. The lead stays the only conversation you
address; each delegated task is its own child thread, and the lead is woken when one finishes. The
thread's **Team** panel lists those children with their status and provider, and opens one when you
want to watch or steer it.

To shadow a built-in, define the same id in a project or global directory. The file replaces the
built-in completely, so copy any fields you want to keep. The
[`t3-reviewer.yaml`](../../examples/agents/t3-reviewer.yaml) example does this. `t3 agent show`
reports whether the definition came from a project, the global directory, or the built-ins.

## Use an agent

From the CLI:

```sh
t3 agent list                 # id, source, provider/model, description
t3 agent show t3-reviewer     # full definition, including the prompt
t3 agent validate <path>      # check one YAML file
t3 agent path                 # directories searched for this project
t3 thread start . "Review the uncommitted diff" --agent t3-reviewer
```

Run these from the project directory so project definitions are in scope.

From the app, **Settings → Agents** lists the built-ins plus the selected project's definitions, with
each one's source, provider and model, delegation limits, and copyable id. In a new thread, the chip
beside the model picker groups the choices:

- **Default** runs a plain thread with the provider's normal behavior.
- **Team leads** plan the work and delegate it to the specialists in their definition.
- **Specialists** run one scoped task and cannot delegate; a team lead usually starts them.

Pick a team lead when you want it to split the work, run children in parallel, and review the
result. Pick a specialist only when you want that one worker to run the task directly.

The picker is on by default; **Settings → Labs → Agent picker** hides it. Picking an agent also
switches to its provider and model when the definition pins one.

From a thread, the built-in MCP tools expose definitions:

1. `t3_agent_list` lists ids with their source and delegation summary.
2. `t3_agent_read` returns one definition in full, including its prompt.
3. `delegate_task({ agent: "t3-reviewer", task: "Review this change." })` starts a child with that
   definition. `create_threads` accepts the same `agent` id for a new top-level thread.

The definition supplies defaults: prompt, provider and model, permission modes, isolation, and
whether the child waits. An explicit `target`, `model`, `runtimeMode`, `interactionMode`,
`isolation`, or `mode` on the call overrides them.

A thread whose agent cannot delegate does not see the delegation tools, and the server rejects a
direct call with `agent_forbidden`.

When a thread starts with an agent, its prompt goes into a collapsed block above your first message,
and that message shows a chip with the agent's name; open the chip to read the prompt. Follow-up
turns do not reapply the prompt.
Editing the YAML after a thread starts does not change that thread; it affects new threads and
delegated tasks.

## Limits and errors

| Error                          | What it means                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `agent_not_found`              | No definition has that id in this environment. Run `t3 agent list`.                   |
| `agent_invalid`                | A definition does not match the schema, or a directory defines one id twice.          |
| `agent_forbidden`              | The calling thread's agent may not delegate, or its `allowedAgents` excludes this id. |
| `agent_depth_exceeded`         | The child would sit below the definition's `maxDepth` or the absolute depth cap.      |
| `agent_parallel_limit_reached` | The parent already has the maximum active child tasks.                                |
| `provider_unavailable`         | The pinned provider instance is not installed or not enabled here.                    |
| `model_unavailable`            | The pinned model is not offered by that provider.                                     |

Run `t3 agent validate` after editing a file, and `t3 agent path` when a definition does not
appear where you expect it.

## Security

Agent definitions are trusted local configuration, like `t3.json` or project code. Anyone who can
write these files can change an agent's prompt and defaults, so treat a repository's
`.t3code/agents` with the same care as its scripts.

Do not put secrets in a definition. Prompts and provider options are plain files and `t3 agent show`
prints them; provider credentials belong to the provider or to [Secrets](./secrets.md).

The marker around the prompt in a message is display metadata. Editing or forging it does not
choose an agent, grant delegation, or change a thread's permissions; the server uses the agent id
stored on the thread.

Agent definitions do not include a tool allowlist or a sandbox. The thread's permission mode and
the provider's own configuration decide what the agent can do.
