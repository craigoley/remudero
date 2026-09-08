/**
 * ONE PULL REQUEST'S CHECK ROLLUP, RENDERED THE WAY THE SWEEP ALREADY READS IT.
 *
 * WHY THIS EXISTS. `rollupFromRest` and `dedupeRollupByLatestAttempt` have always answered "is this
 * PR green" correctly, and until now had no caller outside the sweep and the HTTP console. Anyone at
 * a terminal hand-rolled a `gh pr view --json statusCheckRollup` query instead, and that query has
 * two failure modes that both read as a confident, wrong answer.
 */

/**
 * THE TWO WRONG ANSWERS, BOTH MEASURED 2026-09-07 and both from hand-rolled queries in one session:
 *
 * (a) A COMMIT STATUS IS NOT A CHECK RUN. `remudero-review` is a commit STATUS, carrying `state`
 * where a check run carries `conclusion`. A query reading `.conclusion` alone silently drops it —
 * #4493 was refused under Standing rule 25 and every board read showed `red=[]` until someone asked
 * the commit for its status directly.
 *
 * (b) A SHA ACCUMULATES ONE ENTRY PER ATTEMPT. Without the latest-attempt dedupe, a superseded
 * FAILURE outranks its own later SUCCESS forever — #4485 read red on `source-size` while that
 * check's only completed run was SUCCESS.
 *
 * Both are already solved in `src/lib/sweep.ts` and `src/lib/open-prs-rest.ts`. This module exists
 * so the answer has ONE derivation and a terminal caller, never a second query shape to get wrong.
 */
import { rollupFromRest, type RestRollupEntry } from "./open-prs-rest.js";
import { REQUIRED_CHECK_FAIL, REQUIRED_CHECK_OK, dedupeRollupByLatestAttempt } from "./sweep.js";

/** One check or status, after dedupe, reduced to the question a caller asks. */
export interface PrCheckVerdict {
  readonly name: string;
  readonly outcome: "green" | "red" | "pending";
  /** The raw GitHub word this was decided on — `conclusion` for a run, `state` for a status. */
  readonly raw: string | undefined;
  readonly url: string | undefined;
}

export interface PrChecksReport {
  readonly checks: readonly PrCheckVerdict[];
  readonly red: readonly string[];
  readonly pending: readonly string[];
  readonly green: readonly string[];
}

/**
 * PURE. Classify a rollup — no network, no git. `conclusion` is preferred over `state` because a
 * check run carries both (`status: COMPLETED`, `conclusion: SUCCESS`) while a status carries only
 * `state`; reading either alone is failure mode (a) above.
 *
 * ANYTHING NOT KNOWN-OK AND NOT KNOWN-FAIL IS PENDING, NEVER GREEN. An unrecognised word is a check
 * whose outcome this does not understand, and a required check must never pass a state it cannot
 * name — the same fail-closed reading `coverage-ratchet`'s own matrix guard states.
 */
export function classifyPrChecks(rollup: readonly RestRollupEntry[]): PrChecksReport {
  const checks: PrCheckVerdict[] = dedupeRollupByLatestAttempt(rollup).map((entry) => {
    const raw = entry.conclusion ?? entry.state;
    const outcome: PrCheckVerdict["outcome"] =
      raw !== undefined && REQUIRED_CHECK_FAIL.has(raw)
        ? "red"
        : raw !== undefined && REQUIRED_CHECK_OK.has(raw)
          ? "green"
          : "pending";
    return {
      name: entry.name ?? entry.context ?? "",
      outcome,
      raw,
      url: entry.detailsUrl ?? entry.targetUrl,
    };
  });
  const of = (o: PrCheckVerdict["outcome"]): string[] => checks.filter((c) => c.outcome === o).map((c) => c.name);
  return { checks, red: of("red"), pending: of("pending"), green: of("green") };
}

/** Build the rollup from the two REST payloads, then classify. Kept beside the classifier so a
 *  caller cannot union one half and forget the other — which is failure mode (a). */
export function reportPrChecks(
  checkRuns: Parameters<typeof rollupFromRest>[0],
  statuses: Parameters<typeof rollupFromRest>[1],
): PrChecksReport {
  return classifyPrChecks(rollupFromRest(checkRuns, statuses));
}
