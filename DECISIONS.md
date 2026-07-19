# DECISIONS

Append-only log of machine-side auto-choose resolutions (MASTER-PLAN §4). Every
`DECISION_REQUEST` a worker emits is resolved to its RECOMMENDED option by the
control plane, recorded here with a rationale and a rollback pointer, and the
worker session is resumed with the choice. The PR boundary makes nearly every
decision reversible.

<!-- Entries below are appended verbatim by the runner. -->

## 2026-07-14T10:49:50.570Z — WS-0 spike filename
- Options: docs/spike.md | docs/spike-hello.md (RECOMMENDED) | docs/spike.md | docs/spike-hello.md (RECOMMENDED)
- Chosen (RECOMMENDED, auto): `docs/spike-hello.md`
- Rationale: auto-choose resolves DECISION_REQUEST to the RECOMMENDED option (§4).
- Rollback: revert the sandbox PR.

## 2026-07-19T10:43:00.000Z — W1-T1 re-dispatch: stale/duplicate task
- Options: No-op / report stale dispatch (RECOMMENDED) | Force a synthetic diff to satisfy the commit/PR contract
- Chosen (RECOMMENDED, operator-confirmed): No-op / report stale dispatch
- Rationale: task W1-T1 ("Extract run-task.ts from the spike lib (the proto-runner)")
  was already completed and merged as `remudero` PR #2 (`83ff9a8` — "WS-1 T1: rmd
  run-task — the proto-runner"), which `git merge-base --is-ancestor 83ff9a8 HEAD`
  confirms is already an ancestor of this run's branch. `plan/tasks.yaml`'s own W1-T1
  entry already carries `pr: 2  # merged PR #2 -> deriveStatus resolves this task as
  merged`. `src/run-task.ts` has 18+ commits layered on top of that origin commit
  (fleet control, escalation, drain, review gate, fix rungs, …) and `src/spike.ts`
  today holds only the WS-0 sandbox-proof script — there is no proto-runner logic
  left in it to extract. Making a synthetic edit to satisfy the commit/PR mechanics
  would land a purposeless change on a heavily-built-upon, load-bearing file for
  zero functional value. Suspected root cause: `plan/tasks.yaml`'s `status: queued`
  field on W1-T1 is explicitly documented in the same file as "decorative — real
  merge-state is DERIVED FROM GITHUB" (see header + `lib/status.ts`), so a dispatcher
  reading the decorative field instead of GitHub-derived status would re-queue an
  already-merged task.
- Rollback: none needed — no code changes were made; this entry and the throwaway
  `run-W1-T1-*` branch/worktree can simply be discarded.
