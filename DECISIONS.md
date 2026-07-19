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

## 2026-07-19T00:00:00.000Z — W1-T1 re-dispatch (third occurrence): already-satisfied, no-op close
- Options: (A) close as already-satisfied, no functional code change (RECOMMENDED) | (B) force a
  cosmetic edit to `src/run-task.ts` or `src/spike.ts` just to produce a non-empty diff
- Chosen (RECOMMENDED, auto): Option A — no functional code change.
- Rationale: `src/run-task.ts` (4,343 lines) was already extracted from the WS-0 spike
  (`src/spike.ts`, 308 lines, which today holds only the sandbox smoke-test proto-runner and no
  proto-runner logic left to extract) in commit `83ff9a8` ("WS-1 T1: rmd run-task — the
  proto-runner"), merged as `remudero` PR #2. `plan/tasks.yaml`'s own W1-T1 entry already carries
  `pr: 2  # merged PR #2 -> deriveStatus resolves this task as merged`, and ~250 PRs (through
  `50ffe06`, W1-T47) have built on `run-task.ts` since. At dispatch time `HEAD` equaled
  `origin/main` (`50ffe06`) with a clean tree — there was nothing to extract, diff, or PR. This is
  also the THIRD time this exact task has been re-dispatched: two earlier no-op closures
  (`d61c66e`, `83272b1`, on abandoned `run-W1-T1-*` branches never merged to `main`) already
  reached the same conclusion and named the likely root cause — `tasks.yaml`'s `status: queued`
  field is documented in the same file as "decorative — real merge-state is DERIVED FROM GITHUB"
  (see file header + `lib/status.ts`), so a dispatcher keying off that decorative field instead of
  GitHub-derived status re-queues an already-merged task. Fixing that dispatcher logic is outside
  this task's one-concern scope (this task is the extraction, not the dispatcher) and is left for a
  separate task against the dispatch/drain path.
- Rollback: revert this PR (removes only this DECISIONS.md entry; no runtime code touched).

## 2026-07-19T13:23:00.000Z — W1-T1 re-dispatch (fourth occurrence): already-satisfied, no-op close
- Options: (A) close as already-satisfied, no functional code change (RECOMMENDED) | (B) force a
  cosmetic edit to `src/run-task.ts` or `src/spike.ts` just to produce a non-empty diff
- Chosen (RECOMMENDED, auto): Option A — no functional code change.
- Rationale: re-verified from a fresh worktree (`run-W1-T1-1784481756467`) at dispatch time:
  `src/run-task.ts` (4,343 lines, with `test/run-task.test.ts`, 1,381 lines) already exists and was
  extracted from the WS-0 spike in commit `83ff9a8` ("WS-1 T1: rmd run-task — the proto-runner").
  `src/spike.ts` (308 lines, unchanged) still holds only the sandbox smoke-test proto-runner —
  worker spawn/probe/implement steps against `craigoley/remudero-sandbox` via `src/lib/worker.ts`
  — with no proto-runner logic left to extract into `run-task.ts`. `git status` showed a clean
  tree and local `HEAD` matched `origin/main` (`bca5cd0`) before this entry was appended, so there
  was nothing to extract, diff, or PR. This is the FOURTH re-dispatch of this exact task; the third
  (`bca5cd0`, PR #255) already closed as no-op and named the likely root cause (a dispatcher keying
  off `tasks.yaml`'s decorative `status` field instead of GitHub-derived merge status re-queues an
  already-merged task — see `lib/status.ts`). That dispatcher fix remains outside this task's
  one-concern scope and is still owed as a separate task against the dispatch/drain path; every
  re-dispatch until it lands will keep reaching this same conclusion.
- Rollback: revert this PR (removes only this DECISIONS.md entry; no runtime code touched).
