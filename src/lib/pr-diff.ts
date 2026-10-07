import { ghTextAsync, type GhAsyncExecutor } from "./github-transport.js";
import { boundGitCall, type AsyncGitRunner } from "./git-fetch-retry.js";
import { asyncGit } from "./self-sync.js";

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
  api: (prUrl: string) => string | Promise<string>;
  /** `git diff <base>...<headSha>` in the checkout — no file cap. */
  local: (headSha: string) => string | Promise<string>;
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
export async function fetchPrDiff(prUrl: string, headSha: string, source: PrDiffSource): Promise<PrDiffOutcome> {
  try {
    return { kind: "ok", diff: await source.api(prUrl), source: "api" };
  } catch (apiError) {
    const message = String((apiError as Error)?.message ?? apiError);
    if (!isDiffTooLarge(message)) {
      return { kind: "refused", reason: `could not read the diff for ${prUrl}: ${message}` };
    }
    try {
      return { kind: "ok", diff: await source.local(headSha), source: "local" };
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

/** BACKSTOP per awaited diff read: the sync `gh pr diff`'s own default bound. MEASURED 2026-10-06: that sync read
 *  held the daemon loop 3.5 s from the sweep's review reuse; a read still running at a minute is hung. */
export const PR_DIFF_READ_TIMEOUT_MS = 60_000;
/** The sync reads' own 64 MiB: a plan reconciliation's diff is megabytes. */
const PR_DIFF_MAX_BUFFER = 1 << 26;

/** `gh pr diff <url>` off the event loop through {@link ghTextAsync} (paced; SIGTERM, then SIGKILL past its bound).
 *  A read killed at the bound rejects NAMING it, so a caller refuses or falls back on a reason, never on a hang. */
export async function ghPrDiffAsync(prUrl: string, opts: { timeoutMs?: number; execAsync?: GhAsyncExecutor } = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? PR_DIFF_READ_TIMEOUT_MS;
  try {
    return await ghTextAsync(["pr", "diff", prUrl], { maxBuffer: PR_DIFF_MAX_BUFFER, timeout: timeoutMs }, opts.execAsync);
  } catch (e) {
    if ((e as { killed?: boolean }).killed) throw new Error(`gh pr diff timed out after ${timeoutMs}ms and was killed`);
    throw e;
  }
}

/** The local fallback, `git -C <repoRoot> diff origin/main...<headSha>`, awaited and killed past its bound
 *  (`boundGitCall` rejects naming it). */
export function localPrDiffAsync(
  repoRoot: string,
  headSha: string,
  opts: { timeoutMs?: number; git?: AsyncGitRunner } = {},
): Promise<string> {
  const git = opts.git ?? asyncGit(repoRoot, { maxBuffer: PR_DIFF_MAX_BUFFER });
  return boundGitCall(git, ["diff", `origin/main...${headSha}`], opts.timeoutMs ?? PR_DIFF_READ_TIMEOUT_MS);
}

/** The reviewer's production {@link PrDiffSource}: both reads awaited and bounded, never on the daemon loop. */
export function prDiffSourceAsync(repoRoot: string): PrDiffSource {
  return { api: (prUrl) => ghPrDiffAsync(prUrl), local: (headSha) => localPrDiffAsync(repoRoot, headSha) };
}
