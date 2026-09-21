## Summary

- File W1-T3939 as a separate implementation task for the stale blocked-task NEEDS-ME warning.
- Preserve W1-T3934's scope-aware, fail-open detector and the existing report-only contract.
- Keep the implementation non-blocking: only the advisory projection changes; dispatch, credit, PR state, and retirement remain untouched.

## Evidence

The current `origin/main` status board reports 26 uncredited-build rows; 18 belong to tasks whose plan status is already `blocked`, which `src/lib/drain.ts` unconditionally refuses. The board text therefore says those tasks remain dispatchable when they do not. W1-T3939 records the narrow implementation and the queued-task control so the cleanup cannot hide live work.

## Acceptance

- claim: "the follow-up task records the blocked-warning implementation"
  proof: "grep: id: W1-T3939 in plan/tasks.d/W1-T3939-uncredited-build-detection.yaml"
- claim: "the follow-up task declares the exact source and regression-test scope"
  proof: "grep: src/lib/status.ts in plan/tasks.d/W1-T3939-uncredited-build-detection.yaml"
