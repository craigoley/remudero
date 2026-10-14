- **NAME A SESSION BRANCH `run-<taskId>-<epochMs>` WHEN BUILDING A FILED TASK.** It is the only thing
  that makes session work visible to the fleet: `isDispatchEligible` (`drain.ts`) consults
  `opts.isOpenPr`, and `projectPlan` attributes an OPEN PR by `/^run-(.+)-\d+$/` against
  `headRefName` — NOT by the trailer — so a PR on `fix/…`, `docs/…`, `chore/…` or `claude/…` is
  invisible to dispatch however it is trailered. MEASURED 2026-08-12: 70 merges, 29 `run-*` heads and
  41 session-shaped — a MAJORITY invisible. The convention costs one branch name and does double duty:
  visible to dispatch while open, credited on merge even when the body forgets the trailer (#1657). *(#984; the branch-name credit path and both commands added 2026-08-12)*
