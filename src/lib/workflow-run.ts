/**
 * ONE WORKFLOW RUN, AS THE SWEEP OBSERVES IT (W1-T2340).
 *
 * A LEAF MODULE, AND THAT IS THE WHOLE REASON IT EXISTS. This type is read by the predicate in
 * `lib/sweep.ts` and written by the producer in `lib/open-prs-rest.ts`. `sweep.ts` already imports
 * `open-prs-rest.js` for a value (`GhPaceFloorStandDownError`), so declaring it in `sweep.ts` and
 * importing it back into `open-prs-rest.ts` would close a NEW module cycle — and
 * `.dependency-cruiser.cjs`'s own `no-circular` note names `open-prs-rest` <-> `sweep` as the
 * cheapest cycle to CUT, not one to add to. This file imports nothing, so both ends can depend on
 * it and neither depends on the other.
 *
 * The precedent is exact: `lib/merge-state.ts` holds `MergeConflictEvidence` for the identical
 * reason, `sweep.ts` re-exports it, and `open-prs-rest.ts`'s `hydrateMergeConflictEvidence`
 * produces it. This is that shape, one field over.
 */

/** One job of a run; `name`/`id` (W1-T2947) are the single-job requeue's target, absent when unusable. */
export interface WorkflowRunJobObservation {
  status?: string;
  name?: string;
  id?: string;
}

/** One workflow RUN plus its jobs' OWN statuses — the raw input the stalled-run predicate reads. */
export interface WorkflowRunObservation {
  activeCiRerun?: { headSha: string; runId: number; attempt: number; startedAt: string };
  /** The run's OWN conclusion — GitHub populates this ONLY once the run itself has concluded
   *  (`"success"`, `"failure"`, `"cancelled"`, `"startup_failure"`, ...). `undefined`/empty means
   *  the run has not concluded — still queued or in progress. */
  conclusion?: string;
  /** Each job this run scheduled, with its OWN status — independent of the run's own conclusion.
   *  `undefined` means the jobs could not be read (or were not fetched because the run had not
   *  concluded, so they could not change the answer) — never degraded to `[]`, which would read as
   *  "GitHub scheduled nothing" instead of "we did not check". */
  jobs?: ReadonlyArray<WorkflowRunJobObservation>;
}

export function activeCiRerunEvidence(raw: unknown, headSha: string): WorkflowRunObservation["activeCiRerun"] {
  if (raw === null || typeof raw !== "object") return undefined;
  const run = raw as Record<string, unknown>;
  if (!/^[a-f0-9]{40}$/.test(headSha) || run.head_sha !== headSha ||
      run.path !== ".github/workflows/ci.yml" || run.status !== "in_progress" ||
      (run.conclusion !== null && run.conclusion !== undefined && run.conclusion !== "") ||
      typeof run.id !== "number" || !Number.isSafeInteger(run.id) || run.id <= 0 ||
      typeof run.run_attempt !== "number" || !Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 1 ||
      typeof run.run_started_at !== "string" || !Number.isFinite(Date.parse(run.run_started_at))) return undefined;
  return { headSha, runId: run.id, attempt: run.run_attempt, startedAt: run.run_started_at };
}
