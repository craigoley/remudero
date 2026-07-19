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

## 2026-07-19T00:00:00.000Z — W1-T1 re-dispatch: already satisfied, no-op close
- Options: (A) close as already-satisfied, no code change, no PR (RECOMMENDED) | (B) force a cosmetic/no-op commit to `src/run-task.ts` or `src/spike.ts` just to produce a PR
- Chosen (RECOMMENDED, auto): Option A — no functional code change.
- Rationale: `src/run-task.ts` was already extracted from the WS-0 spike (`src/spike.ts`) in
  commit `83ff9a8` ("WS-1 T1: rmd run-task — the proto-runner"), the first task ever landed on
  this plan, and ~250 PRs have built on it since. `HEAD` and `origin/main` were identical
  (`50ffe06`) with a clean tree at the time this run was dispatched — there was nothing to
  extract, diff, or PR. This entry itself is the only artifact of this run: a documentation-only
  record closing the run so the dispatcher stops re-issuing task W1-T1 as pending work.
- Rollback: revert this PR (removes only this DECISIONS.md entry; no runtime code touched).
