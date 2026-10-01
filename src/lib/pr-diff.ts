/**
 * THE REVIEWER'S DIFF, WITH A FLOOR UNDER IT.
 *
 * `gh pr diff` is the reviewer's only diff source, and GitHub REFUSES it above 300 changed files:
 * `HTTP 406 ... the diff exceeded the maximum number of files (300)`. `execFileSync` turns that into
 * a throw, so `rmd review` died with an unhandled `Command failed: gh pr diff …` and posted nothing
 * at all — no verdict, no refusal, no ledger row a later reader could attribute.
 */

/**
 * MEASURED 2026-09-07 on #4510, a 930-shard plan reconciliation: every review attempt crashed, so
 * the pull request could not be judged by any path and sat unreviewable rather than refused.
 *
 * TWO OUTCOMES, NEVER A CRASH. A local three-dot diff against the PR head is tried first when the
 * API declines — it has no file cap and is the SAME comparison `gh pr diff` renders. If that is also
 * unavailable (the head is not fetched, no git), the caller gets a NAMED refusal it can post, which
 * is what an unattributable exception was denying it.
 */
export interface PrDiffSource {
  /** `gh pr diff <url>` — the API path, refused above 300 files. */
  api: (prUrl: string) => string;
  /** `git diff <base>...<headSha>` in the checkout — no file cap. */
  local: (headSha: string) => string;
}

export type PrDiffOutcome =
  | { readonly kind: "ok"; readonly diff: string; readonly source: "api" | "local" }
  | { readonly kind: "refused"; readonly reason: string };

/** GitHub's own words for the cap, matched on the two stable halves rather than the whole sentence. */
export function isDiffTooLarge(message: string): boolean {
  return /\b406\b/.test(message) && /exceeded the maximum number of files/i.test(message);
}

/**
 * Fetch the diff, falling back to the local comparison when the API refuses it for SIZE ONLY.
 *
 * ANY OTHER API FAILURE IS REFUSED RATHER THAN RETRIED LOCALLY, and the distinction is the safety
 * property: an auth failure, a rate limit or a deleted PR must not be answered with a diff computed
 * from whatever this checkout happens to hold. Only the file cap has a locally-equivalent answer.
 */
export function fetchPrDiff(prUrl: string, headSha: string, source: PrDiffSource): PrDiffOutcome {
  try {
    return { kind: "ok", diff: source.api(prUrl), source: "api" };
  } catch (apiError) {
    const message = String((apiError as Error)?.message ?? apiError);
    if (!isDiffTooLarge(message)) {
      return { kind: "refused", reason: `could not read the diff for ${prUrl}: ${message}` };
    }
    try {
      return { kind: "ok", diff: source.local(headSha), source: "local" };
    } catch (localError) {
      return {
        kind: "refused",
        reason:
          `the diff for ${prUrl} exceeds GitHub's 300-file cap and the local fallback failed ` +
          `(${String((localError as Error)?.message ?? localError)}). Split the pull request, or fetch ` +
          `its head into this checkout so the comparison can be made without the API.`,
      };
    }
  }
}
