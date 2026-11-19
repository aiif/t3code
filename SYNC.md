# SYNC.md — the upstream sync prompt

This file is the standing procedure for absorbing `upstream/main`
([pingdotgg/t3code](https://github.com/pingdotgg/t3code)) into this fork. The
owner triggers a sync by pointing an agent at this file. Read all of it before
merging; do not improvise a different process.

Policy in one line: **absorb as much upstream change as possible; where a
conflict touches fork behavior, this repository wins.**

## Before you start

- Merge on `main` with a clean tree. Commit or stash other work first.
- Never push, never create or move tags, never start servers, never touch
  `~/.t3/userdata` (the owner's live database). Commit the merge; the owner
  decides when to push.
- `git remote -v` still shows SSH URLs. The machine's global git config
  rewrites GitHub SSH URLs to HTTPS, so fetches work transparently. If a
  transfer dies mid-stream, retry it.

## Derive the fork's surface — never trust a memorized list

Every sync starts from fresh data. No file list in this document is
authoritative; if a remembered list and a command disagree, the command wins.

```sh
git fetch upstream
# Three-dot = since the merge base. After every successful sync the merge
# base moves forward, so these answers refresh themselves.
git diff --name-status upstream/main...main
```

- Rows `A` are fork-added files. The merge must never delete or overwrite
  them. If upstream introduces a file at the same path, stop and ask the owner.
- Rows `M` are upstream files the fork hooks into — the seams. Conflicts can
  only occur here; where both sides appended, keep both.
- Limit that diff to `apps/server/src/persistence/Migrations/` to list the
  fork-owned migrations for the id rule below.

Recognize fork behavior inside any conflict by these conventions:

- paths or imports containing `personal` (`apps/server/src/personal/`,
  `packages/contracts/src/personal.ts`, `apps/web/src/personal/`);
- `PERSONAL_WS_METHODS`, `Personal*` contract types, `personalGuest` and
  host-key session claims;
- `T3CODE_PERSONAL_*` and `VITE_T3CODE_PERSONAL_ONLY` build flags,
  `T3CODE_FRPC_PATH` / `T3CODE_CLOUDFLARED_PATH` connector overrides;
- the `@aiif/` npm scope, bundled `frpc`/`cloudflared`, the fork release
  workflows (`release-fork`, `publish-t3relay`, `publish-t3cf`).

A hunk that matches any of these is fork behavior: keep it intact, re-apply
upstream's intent around it. `GOAL.md` is an untracked working log for the
personal-network project; read it for context, never commit it.

## Procedure

1. Preview the real conflict set (read-only, no working-tree changes):

   ```sh
   git merge-tree --write-tree --name-only main upstream/main
   ```

   The paths printed after the tree OID are the only files needing manual
   resolution; everything else auto-merges. This output supersedes anything
   remembered from previous syncs.

2. Merge:

   ```sh
   git merge upstream/main
   ```

3. Resolve conflicts, most specific rule first:

   - `pnpm-lock.yaml`: take upstream's side wholesale; never hand-merge. After
     resolving everything else, run `vp i` and stage the regenerated lock.
   - Migration id collisions: follow the next section.
   - Append-only registries among the `M` files (RPC dispatch tables, contract
     definitions): union both sides' entries.
   - Everything else: absorb upstream's version, then re-apply only the fork
     lines it displaced, using the recognition criteria above. The fork wins
     only where its behavior is actually at stake.

4. Check: `vp run check:changed`, plus the focused suites for every seam you
   touched in step 3.

5. Commit the merge (suggested title: `chore(sync): absorb upstream/main
   through <date>`). Report to the owner: conflicts resolved, migration
   renumbers performed, DB repairs recorded, check results. Do not push unless
   the owner asks.

## Migration id collision rule

Both upstream and this fork number SQLite migrations from 1, so collisions
recur; the rule is the same every time:

- Derive the fork's migrations with the Migrations diff above. If upstream
  shipped an id the fork already uses, renumber the fork's migration above
  upstream's new maximum, preserving the fork's relative order: rename the
  file, the `Migration00XX` symbol, and both `Migrations.ts` entries (the
  import and the `[id, "Name"]` row).
- Never renumber upstream's migrations into fork space. The fork gives way.
- Fork migrations must be idempotent (`CREATE TABLE IF NOT EXISTS` style), so
  a renumber always re-runs as a no-op and table data survives.
- Append the DB repair to the ledger below and name it in your report: every
  database that ran the old id needs that DELETE line before starting the
  merged build. The owner applies it to their machines.

### DB repair ledger

Append-only. Never edit old entries. Pending items live above the entries and
move into the ledger once performed.

Pending: the first sync after 2026-11-19 renumbers `095_AuthPersonalKeyState`
past upstream's `099` (upstream's `095_TurnItemInlineWorkOutput` takes the old
slot).

- _none recorded yet_
