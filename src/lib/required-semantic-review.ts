import { createHash } from "node:crypto";

/** Explicit semantic requirements cannot replay decisions produced by the advisory-only policy. */
export function requiredSemanticDecisionDigest(digest: string, required: boolean): string {
  return required ? `required-semantic-v1:${createHash("sha256").update(digest).digest("hex")}` : digest;
}

/** W1-T14826: the reviewer outcome of a code PR that names no acceptance criteria. No reviewer is dispatched, since
 *  there is nothing to judge, and that is a FINAL fact about the head, not an unavailable evaluator: the binding floor
 *  fails it closed, so it posts one failure instead of a withheld verdict the sweep keeps re-running
 *  (craigoley/remudero-ops#706). */
export const NO_CRITERIA_REVIEWER_OUTCOME = "not_attempted_no_criteria";

/** W1-T14826: the posted summary of that failure. It names the remedy and fits the 140-char status description. */
export const NO_CRITERIA_FAIL_SUMMARY =
  "remudero-review: FAIL — no acceptance criteria to judge: name the task (Task: / Remudero-Task:) and its acceptance in the PR body";

/** An unavailable reviewer is an incomplete evaluation, not evidence that the code passed. */
export function requiredSemanticRefusal(input: {
  required: boolean; planOnly: boolean; outcome: string;
  criteriaCount: number; verdicts: readonly (boolean | undefined)[] | undefined;
  /** (W1-T11428) Per-criterion UNABLE markers. An UNABLE criterion is ANSWERED (the reviewer said it could not look),
   *  so it never makes the verdicts incomplete; the judge turns it into cannot-evaluate, not a withheld verdict. */
  unable?: readonly (string | undefined)[];
}): string | undefined {
  if (!input.required || input.planOnly) return undefined;
  // W1-T14826: no reviewer could supply a missing criterion, so nothing is withheld; the floor's no-criteria FAIL binds.
  if (input.outcome === NO_CRITERIA_REVIEWER_OUTCOME && input.criteriaCount === 0) return undefined;
  if (input.outcome !== "success") return `required-semantic-${input.outcome}`;
  if (input.criteriaCount <= 0 || input.verdicts === undefined || input.verdicts.length !== input.criteriaCount ||
      input.verdicts.some((value, i) => typeof value !== "boolean" && input.unable?.[i] === undefined)) {
    return "required-semantic-incomplete-verdicts";
  }
  return undefined;
}
