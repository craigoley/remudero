// src/lib/companion-paths.ts — W1-T2547.
//
// The companion/generated-ledger path TABLE and its predicate, extracted from task-linter.ts so
// BOTH task-linter.ts and review.ts can read it without importing each other.
//
// WHY IT LIVES HERE RATHER THAN IN EITHER CONSUMER. task-linter.ts already imports review.ts, so
// review.ts importing task-linter.ts back closes a ring — measured: `npm run cycle-ratchet` went
// from 13 cycles (main, at its ceiling of 13) to 15, and BLOCKED. The table is pure data plus a
// one-line predicate with no dependency on either module, so the ring is cut by ownership rather
// than paid for by raising the architecture-fitness ceiling.
//
// task-linter.ts re-exports these, so every existing importer of it is unchanged.

/**
 * W1-T2543 — COMPANION path classes: a path that is not a concern OF ITS OWN when the task also
 * declares the thing it accompanies. Distinct from {@link DATA_ARTIFACT_CLASSES}, which discounts
 * unconditionally: a companion is discounted ONLY while some non-companion file survives, so a
 * task declaring nothing but companions still counts them and never scores zero concerns.
 *
 * WHY THIS EXISTS, MEASURED ON THIS TREE. `moduleIdFromPath` derives a concern id from a BASENAME,
 * and naming a suite after the claim it proves rather than the module it covers is the house
 * convention here — 747 of 865 test files (86.3%) carry a basename matching no `src/` module. So a
 * change to `src/lib/X.ts` plus the suite written to test it scored TWO concerns roughly six times
 * in seven, and Rule 19 refused it at risk:medium. The advisory rubric fired the same way on two
 * PRs within one hour (#3400 `sweep`/`sweep-conflicted-disposition`, #3403 `daemon`/
 * `entrypoint-boot`), and an arm that fires on nearly every well-formed PR trains its readers to
 * skim past it — which is where a REAL finding is lost.
 *
 * THIS DOES NOT WEAKEN RULE 19. Only the companion is discounted; every SOURCE stem still counts,
 * so a task genuinely spanning two subsystems still scores two and still reports.
 */
export interface CompanionPathClass {
  tag: string;
  pathPattern: RegExp;
}

export const COMPANION_PATH_CLASSES: ReadonlyArray<CompanionPathClass> = [
  { tag: "test-suite", pathPattern: /^test\// },
];

/** True iff `path` belongs to some companion class — see {@link COMPANION_PATH_CLASSES}. */
export function isCompanionPath(
  path: string,
  classes: ReadonlyArray<CompanionPathClass> = COMPANION_PATH_CLASSES,
): boolean {
  return classes.some((c) => c.pathPattern.test(path));
}

/**
 * W1-T2547 — GENERATED LEDGER path classes: a path whose whole content is a recorded
 * measurement (a per-file size table, a knowledge-budget derivation) rather than a user-visible
 * surface. Consumed by {@link isCompanionPath} — the SAME injected-table mechanism W1-T2543's own
 * test already celebrates ("the discount is a TABLE, so a later path class needs no change to the
 * counting function" — test/a-suite-is-not-a-second-concern.test.ts) — but as its OWN table, not a
 * new row on {@link COMPANION_PATH_CLASSES}: `subsystemsOf`'s default classes stay untouched, so a
 * size ledger keeps counting as its own Rule 19 concern exactly as pinned ("the suite no longer
 * counts; the baseline still does", same suite). This table answers a DIFFERENT question for a
 * DIFFERENT consumer — `checkDocsAwareness` (src/lib/review.ts): whether a path is a user-visible
 * SURFACE a missing `docs/` update should be caught on. A generated ledger is neither.
 *
 * NARROW ON PURPOSE, AND CITED RATHER THAN INVENTED. Exactly the two paths this repo already
 * treats as ledgers-not-floors elsewhere — review.ts's `ENTANGLEMENT_EXEMPT_INSTRUMENTS` (W1-T2526
 * / W1-T941), reasoned there as recording "how long a file is" / a derivation, and grading no
 * falsifier. A coverage/mutation/learnings-budget baseline is NOT in this table: it still grades a
 * falsifier (lower it and a weakened suite passes), so it stays on the user-visible surface exactly
 * as before this task.
 */
export const GENERATED_LEDGER_CLASSES: ReadonlyArray<CompanionPathClass> = [
  {
    tag: "generated-ledger",
    pathPattern: /^scripts\/(?:source-size|knowledge-budget)-baseline\.json$/,
  },
];