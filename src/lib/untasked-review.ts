/** W1-T14902: the untasked-review classification, a leaf so the one task-hold reader and the arm can share it with the
 *  review lane without an import cycle (tick-read-worker, status and review re-export what moved here). */

/** W1-T5839 — what `taskIdFromRunBranch` recovers from every `run-unfiled-<epochMs>` head: a branch-shape SENTINEL that
 *  every ad-hoc PR shares, never a task (W1-T3535), so it owns neither supersession nor a review verdict. */
export const UNFILED_RUN_SENTINEL = "unfiled";

/** Extract the task id a fleet-dispatched run branch claims, or `undefined`. The ONE named extractor for a
 *  shape tested three other ways: {@link ownsBranch} VERIFIES a known id and cannot discover one, and
 *  run-task.ts's predicate is a boolean shape test with no capture group (W1-T453). */
export function taskIdFromRunBranch(head: string | undefined): string | undefined {
  const m = /^run-(.+)-\d+$/.exec(head ?? "");
  if (!m) return undefined;
  // W1-T3042 — THE CAPTURE MUST LOOK LIKE A TASK ID, or this invents one.
  //
  // `(.+)` is greedy and the shape has no second anchor, so any extra hyphenated segment before the
  // epoch is swallowed whole: `run-W1-T3030-build-<epochMs>` yielded `W1-T3030-build`. That is
  // not a failure to credit — it is a CREDIT FOR A TASK THAT DOES NOT EXIST, which is worse,
  // because a phantom id enters the merged set while the real task stays uncredited and eligible
  // for re-dispatch.
  //
  // MEASURED 2026-09-07 over 255 merged pull requests: 100 run-shaped heads, 92 extracting a valid
  // id and 8 a phantom — five from a `-file-`/`-build-` pairing used that day. Returning `undefined`
  // costs those five nothing: they never credited a real task, so no credit is lost, and a caller
  // can now SAY the branch names no task instead of acting on an id nobody minted. (The other three
  // of the 8, TRIAGE feedback branches, were never phantom in the first place — see `namesATask`.)
  return namesATask(m[1]) ? m[1] : undefined;
}

/** Reject a stapled-on suffix, not unfamiliar id formats. Hyphen-free ids are accepted.
 *  Canonical-only validation rejected fixture ids `A`/`D` and broke four suites, including the
 *  pushed-branch in-flight guard; hyphen-free-or-canonical also broke auto-triage's guard.
 *  Strip a trailing word: `W1-T3030-build` leaves a whole id and is rejected;
 *  `TRIAGE-fb-1785792135748-755f93` leaves a non-id and is accepted. */
function namesATask(capture: string): boolean {
  // Letter-suffix ids such as `W1-T12a` also remain valid; do not replace suffix detection with a whitelist.
  const suffixed = /^(.+)-[A-Za-z][A-Za-z0-9]*$/.exec(capture);
  if (suffixed && TASK_ID_SHAPE.test(suffixed[1])) return false;
  return true;
}

/** The canonical minted shape — `W<n>-T<n>` with an optional split-out letter (`W1-T12a`,
 *  `W1-T1C`). Used ONLY to recognise an id that has had a suffix appended, never as a whitelist:
 *  1457 of 1457 plan ids match it, and ids that do NOT (TRIAGE runs) are still real. */
const TASK_ID_SHAPE = /^[A-Za-z]+\d*-T\d+[A-Za-z]*$/;

/** A hand PR pushed before it had a number carries the trailer `PR-pending`; it names no shard, so on its own
 *  `run-PR-pending-<epoch>` head it is reviewed like a trailerless PR instead of refusing setup every pass. */
export const PR_PENDING_PLACEHOLDER = { taskId: "PR-pending", branch: /^run-PR-pending-\d+$/, rule: "W1-T11258" } as const;

/** Generated lanes have correlation ids, not filed task records; keep their bounded semantic review.
 *  A synthetic `PR-<n>` id (a hand-fix PR's trailer) names no shard either: it gets the defaults a trailerless PR
 *  gets, on any branch, so the trailer can never cost a review (#13305: refused on every pass for 4.5 h). */
export function usesUntaskedReviewMetadata(taskId: string | undefined, headRefName: string): boolean {
  if (taskId === undefined || taskId === UNFILED_RUN_SENTINEL || /^PR-[1-9]\d*$/.test(taskId)) return true;
  if (taskId === PR_PENDING_PLACEHOLDER.taskId) return PR_PENDING_PLACEHOLDER.branch.test(headRefName);
  if (headRefName === `run-${taskId}` && /^RETRO-\d+$/.test(taskId)) return true;
  return taskIdFromRunBranch(headRefName) === taskId &&
    /^(?:RETRO(?:-.+)?|TRIAGE-.+|PLAN-.+|APPROVE-.+|main-repair-(?:(?:ratchet|revert)-)?[0-9a-f]{12})$/.test(taskId);
}
