// src/lib/fix-rung-classify.ts — W1-T2891 (decomposition step 8).
//
// The fix rung (`runFixRung`, src/run-task.ts) is 2,011 lines and unreadable partly because four
// PURE text-to-verdict classifiers it consults sat between its halves in the same file:
// `classifyUpdateBranchFailure`, `detectReviewFalseBlock`, `detectCiLogVerdictUnchanged` (plus the
// two private helpers only it uses) and `classifyNoPrShape`. None of the four reads process state
// — each is a pure function of its argument — so they move here with their implementations
// unchanged; two of the four doc comments are compacted to satisfy comment-load-ratchet's 25-line
// added-block cap (docs/comment-standard.md), never dropping the invariant/trap/falsifier each
// stated. run-task.ts imports and RE-EXPORTS the same names so every existing caller and test
// resolves exactly as before the move.

import type { CiFailure } from "./sweep.js";
import type { ReviewVerdict } from "./review.js";

/**
 * W1-T528: PURE classifier for a failed update-branch request (W1-T1208: the REST `gh api` PUT,
 * not the `gh pr update-branch` subcommand), same shape as {@link armFailureAction} directly
 * above. Design clause (v): this shard does NOT pretend to have
 * observed a real 422/diverged response — it was never called against a live PR (a call on a
 * real PR discards a real verdict). Anything that plausibly names a conflict or a divergence is
 * classified `"conflict"` — reported and never retried by {@link updateBranchViaGh}'s own caller;
 * everything else is `"error"` — informational, retried only by a LATER pass's own fresh
 * selection, never by this call. Exported so a future task can correct this classification
 * against `gh`'s ACTUAL response shape without guessing here first.
 */
export function classifyUpdateBranchFailure(stderrText: string): "conflict" | "error" {
  return /conflict|divergent|diverged|422/i.test(stderrText) ? "conflict" : "error";
}

/**
 * W1-T168 (#349/#360): does THIS round's review verdict show a REVIEW FALSE-BLOCK the fix rung
 * cannot resolve by dispatching more code, so it must escalate instead of spending an ordinary
 * strike? Two OR'd signals (either alone is sufficient):
 *  (a) NO-PROGRESS — this round posted against the SAME head sha the fix worker was dispatched
 *      to resolve, with the SAME unmet criteria (by claim text): striking again against
 *      identical code can only reproduce the identical verdict.
 *  (b) FLOOR-VS-REVIEWER DISAGREEMENT (the SHARPEST signal) — the deterministic floor
 *      ({@link ReviewVerdict.floorState}) passed while the advisory reviewer still blocks,
 *      regardless of (a).
 *
 * A GENUINE deficiency trips NEITHER: a changed diff whose floor also still fails falls through
 * to `undefined`, so the caller strikes normally — the escape never weakens the rung for real
 * work still owed.
 *
 * Pure and exported so both signals are unit-testable independent of the rung's plumbing.
 */
export function detectReviewFalseBlock(check: {
  /** The head sha the review THIS ROUND'S fix worker was dispatched to resolve carried. */
  priorHeadSha: string;
  /** The unmet criteria (by `claim` text) that same prior review posted. */
  priorUnmetClaims: ReadonlySet<string>;
  /** The verdict `runReview` just computed for this round's (possibly unchanged) head. */
  current: ReviewVerdict & { headSha: string };
}): string | undefined {
  const { priorHeadSha, priorUnmetClaims, current } = check;
  if (current.state === "success") return undefined;

  // (b) — checked first: it is the sharper signal and needs no diff-change
  // evidence at all.
  if (current.floorState === "success") {
    return "review false-block: deterministic floor passes while the spawned reviewer blocks";
  }

  // (a)
  const currentUnmetClaims = new Set(current.criteria.filter((c) => !c.met).map((c) => c.claim));
  const sameCriteria =
    currentUnmetClaims.size > 0 &&
    currentUnmetClaims.size === priorUnmetClaims.size &&
    [...currentUnmetClaims].every((c) => priorUnmetClaims.has(c));
  if (current.headSha === priorHeadSha && sameCriteria) {
    return "review false-block: same criterion re-blocked on unchanged code (no diff change this strike)";
  }
  return undefined;
}

/**
 * W1-T2328 (the "inert fix" defect — a strike whose push landed but changed nothing a re-check
 * could see): the ci-log SIBLING of {@link detectReviewFalseBlock} — does THIS round's freshly
 * refreshed failing-check evidence show the SAME findings the strike that just ran was dispatched
 * to fix?
 *
 * DROPS the head-sha conjunct ON PURPOSE: the rung already pushed and CI already re-ran against a
 * new head before this is ever called, so an identical finding set after that landed push IS the
 * evidence on its own — requiring the sha to also be unchanged would make this never fire on the
 * shape it exists for.
 *
 * COMPARES THE ANNOTATION MESSAGE SET, never the log tail or the conclusion: the conclusion alone
 * can only ever prove "fixed"; the log tail is unusable as the comparison key
 * ({@link CiFailure.logUnavailable} documents a denied read once behaving exactly as if nothing
 * had failed). The annotation set (`tailSource === "annotations"`, {@link CiFailure.logTail}
 * split into lines, normalised, compared as a SET) is the one surface `fetchCiFailures` names as
 * load-bearing evidence rather than a best-effort blob.
 *
 * ABSTAINS (`undefined`, strike normally) on anything short of two directly comparable annotation
 * sets for EVERY still-failing check name shared between the two rounds: the failing NAME SET
 * itself moved, either round carries no evidence, or any shared check's tail did not come from
 * annotations on BOTH sides. Design rule: fail toward spending the strike, never a false stand-down.
 *
 * Pure and exported — mirrors {@link detectReviewFalseBlock}'s own reason for being pure.
 */
export function detectCiLogVerdictUnchanged(check: {
  /** The ci-log evidence THIS round's fix worker was dispatched to resolve. */
  priorFailures: readonly CiFailure[];
  /** The SAME check names' evidence, freshly refetched after this round's push landed and CI
   *  re-ran. */
  currentFailures: readonly CiFailure[];
}): string | undefined {
  const { priorFailures, currentFailures } = check;
  if (priorFailures.length === 0 || currentFailures.length === 0) return undefined;

  const priorNames = priorFailures.map((f) => f.name).slice().sort();
  const currentNames = currentFailures.map((f) => f.name).slice().sort();
  if (priorNames.length !== currentNames.length || priorNames.some((n, i) => n !== currentNames[i])) {
    return undefined; // the failing set itself moved — real ground moved, never "unchanged"
  }

  const priorByName = new Map(priorFailures.map((f) => [f.name, f] as const));
  const currentByName = new Map(currentFailures.map((f) => [f.name, f] as const));
  for (const name of priorNames) {
    const priorSet = comparableAnnotationSet(priorByName.get(name));
    const currentSet = comparableAnnotationSet(currentByName.get(name));
    if (!priorSet || !currentSet || !annotationSetsEqual(priorSet, currentSet)) {
      return undefined; // not comparable, or genuinely different — abstain, strike normally
    }
  }
  return (
    `ci-log false-block: ${priorNames.join(", ")} — identical annotation finding set both before ` +
    `and after this strike's landed push (no verdict movement to show for it)`
  );
}

/**
 * W1-T2328: the normalised, order-insensitive annotation MESSAGE SET a {@link CiFailure} carries —
 * `undefined` (never comparable) unless its tail was actually sourced from annotations
 * (`tailSource === "annotations"`) and that tail is non-empty. A readable LOG tail
 * (`tailSource === "log"`), an unread log with no annotation fallback reached, or an annotation
 * fallback that came back `empty`/`failed` are all "not comparable" by this same test — never
 * silently treated as an empty (and therefore falsely "equal") set.
 */
function comparableAnnotationSet(failure: CiFailure | undefined): Set<string> | undefined {
  if (!failure || failure.tailSource !== "annotations") return undefined;
  const lines = failure.logTail
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return lines.length > 0 ? new Set(lines) : undefined;
}

/** Order-insensitive set equality — `annotationSetsEqual` never cares which order two runs of
 *  the same gate reported their findings in. */
function annotationSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * (W1-T465) WHICH KIND of `no_pr` this was, read off the worker's own closing report.
 *
 * THE DISTINCTION THIS EXISTS TO MAKE, and why nothing cheaper works. Of the eight `no_pr` runs
 * that carry a `report_excerpt` at all (the field arrived with #1584; the ~99 older rows are
 * unexplained and always will be), FIVE on the mini and THREE measured independently on Azure
 * ended mid-wait — the worker backgrounded a long job and stopped issuing tool calls, expecting a
 * notification that a headless run can never deliver. The other three concluded, correctly, that
 * there was nothing left to do. **ALL of them carry `commits_ahead: 0` AND `subtype: "success"`**,
 * so neither field separates the two: a rung keyed on those would re-dispatch work that was right
 * to produce no PR, which is this repo's recurring "a bound fires on a healthy condition" defect.
 *
 * THIS IS A PROSE MATCHER, AND THAT IS A REAL WEAKNESS RATHER THAN AN ACCEPTABLE ONE. The five
 * mini excerpts say the same thing five different ways; A SIXTH PHRASING WILL NOT MATCH and the row
 * will read `unclassified`, which is indistinguishable from an honest no-op at a glance. A signal
 * the RUN emits would be strictly better and was looked for: the sanctioned `ALREADY_SATISFIED:`
 * marker cannot serve, because the honest runs did NOT emit it — that is exactly why they landed
 * `no_pr` instead of `already_satisfied`. None was found, so the fragility is written down here
 * rather than left to be discovered.
 *
 * CLASSIFICATION ONLY. This label is recorded for a reader and consulted by NO scheduling path —
 * see `test/worker-no-wait-contract.test.ts`, which asserts that `drain.ts` and `daemon.ts` never
 * reference it. Retrying `no_pr` is deliberately out of scope (W1-T465 design (iv)): `no_pr` stays
 * drain-halting, and `already_satisfied` remains the sanctioned exit for an honest no-op.
 */
export function classifyNoPrShape(reportExcerpt: string | undefined): "awaiting-notification" | "unclassified" {
  const text = String(reportExcerpt ?? "");
  if (!text) return "unclassified";
  // Three independent shapes, because the eight real excerpts use three different constructions.
  const waitsOnBackground = /\b(wait(ing|s)?\s+for|await(ing)?)\b[^.]{0,60}\bbackground\b/i.test(text);
  const expectsNotification = /\b(notified|notification)\b/i.test(text);
  const refusesToPoll = /\b(won'?t|will not|no need to)\s+poll\b/i.test(text);
  return waitsOnBackground || expectsNotification || refusesToPoll ? "awaiting-notification" : "unclassified";
}
