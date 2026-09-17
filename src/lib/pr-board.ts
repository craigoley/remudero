/**
 * src/lib/pr-board.ts — W1-T3685.
 *
 * Surveys open pull requests across the fleet's repositories. `rmd status` renders THIS
 * daemon's own board from local state; `rmd ci-failures` answers a narrower question (one
 * repo, by day). Neither reads GitHub cross-repo, which is the gap this module fills.
 *
 * INVARIANT (i): ONE `gh pr list` call per repository — `--json` already returns the check
 * rollup, so a per-PR follow-up read is refused by construction (secondary-rate-limit hazard).
 *
 * INVARIANT (ii): an UNREADABLE repository is never rendered as zero open.
 * {@link RepoPullRequestBoard} carries `available: false` with the read error, distinct from
 * an empty `pullRequests: []` — the two are opposite facts.
 *
 * INVARIANT (iii): this module never chooses which repositories to survey —
 * {@link surveyPullRequestBoard} takes the list as an argument; the caller (run-task.ts) owns
 * sourcing a default from configuration, never a hardcoded list here.
 *
 * PURE otherwise (Law 5): `fetch` is injected, defaulting to the real {@link ghJson}; this
 * module opens no socket, writes no file, and mints no id of its own.
 *
 * FALSIFIER: test/the-board-verb-distinguishes-empty-from-unreadable.test.ts.
 */

import { ghJson } from "./github-transport.js";
import type { GhApiFetcher } from "./open-prs-rest.js";
import { REQUIRED_CHECK_FAIL, REQUIRED_CHECK_OK, dedupeRollupByLatestAttempt, type RollupCheckEntry } from "./sweep.js";

/** The exact fields one `gh pr list` call needs to answer this verb — no more, since a wider
 *  projection is a cost this design has no use for and no proof requires. */
const PR_LIST_JSON_FIELDS = "number,title,isDraft,headRefName,statusCheckRollup";

/** PRIMARY CONTROL: bounds one repository's read to a page an operator can actually read. */
const PR_LIST_LIMIT = 100;

/** One open pull request, summarised for the board. `failingChecks`/`pendingChecks` name the
 *  check, never merely count it — an operator's first question after "is it red" is "which one". */
export interface PullRequestBoardEntry {
  number: number;
  title: string;
  isDraft: boolean;
  headRefName: string;
  failingChecks: string[];
  pendingChecks: string[];
}

/** One repository's board — READ or UNAVAILABLE, never collapsed into each other (design ii). */
export type RepoPullRequestBoard =
  | { repo: string; available: true; pullRequests: PullRequestBoardEntry[] }
  | { repo: string; available: false; error: string };

export interface PullRequestBoard {
  repos: RepoPullRequestBoard[];
}

/** A check's identity is its check-run NAME or its status CONTEXT — the same two-shape union
 *  `ci-failure-corpus.ts`'s `gateName` reads, copied rather than reinvented across a module
 *  boundary dependency-cruiser keeps this file out of (run-task.ts owns that one). */
function gateName(entry: RollupCheckEntry): string {
  return entry.name ?? entry.context ?? "";
}

/** The one state field a rollup entry actually carries, whichever shape it came from. */
function gateState(entry: RollupCheckEntry): string {
  return (entry.state ?? entry.conclusion ?? entry.status ?? "").toUpperCase();
}

/** Named checks in a rollup matching `want`, deduped to the latest attempt per check first so a
 *  superseded CANCELLED entry never outvotes its own later SUCCESS/FAILURE (the same dedupe
 *  `checksStateFromRollup` applies before judging). Entries with no name are dropped — an
 *  unnamed check cannot be reported by name. */
function namedChecksWhere(rollup: RollupCheckEntry[] | undefined, want: (state: string) => boolean): string[] {
  return dedupeRollupByLatestAttempt(rollup ?? [])
    .filter((c) => want(gateState(c)))
    .map(gateName)
    .filter((name) => name.length > 0);
}

/** One row as `gh pr list --json` reports it — only the fields this module reads. */
interface RawPullRequestRow {
  number?: number;
  title?: string;
  isDraft?: boolean;
  headRefName?: string;
  statusCheckRollup?: RollupCheckEntry[];
}

function summarizeRow(row: RawPullRequestRow): PullRequestBoardEntry {
  const rollup = row.statusCheckRollup;
  return {
    number: row.number ?? 0,
    title: row.title ?? "",
    isDraft: row.isDraft === true,
    headRefName: row.headRefName ?? "",
    // FAILING is the vetoing set REQUIRED_CHECK_FAIL names (sweep.ts, W1-T457) — the same red
    // vocabulary the fix rung itself gates on, so this board's "failing" agrees with the rung's.
    failingChecks: namedChecksWhere(rollup, (s) => REQUIRED_CHECK_FAIL.has(s)),
    // PENDING is everything that is neither a satisfying conclusion nor a vetoing one — a check
    // still queued or running, or a required context that has not registered on this head yet.
    pendingChecks: namedChecksWhere(rollup, (s) => !REQUIRED_CHECK_OK.has(s) && !REQUIRED_CHECK_FAIL.has(s)),
  };
}

function ghPrListArgv(repo: string): string[] {
  return ["pr", "list", "--repo", repo, "--state", "open", "--json", PR_LIST_JSON_FIELDS, "--limit", String(PR_LIST_LIMIT)];
}

/**
 * Survey every repository in `repos`, ONE `gh pr list` call each (design i). `fetch` defaults to
 * the real {@link ghJson}; a test (or a future caller reading REST instead) injects its own.
 *
 * A repository whose call THROWS is reported `available: false` with the thrown message — never
 * rendered as `pullRequests: []`, which would make an unreachable queue print identically to a
 * genuinely empty one (design ii, the falsifier this task's second acceptance test is built to
 * catch: "print zero open for an unreachable repository and the second [test] must fail").
 */
export function surveyPullRequestBoard(repos: readonly string[], fetch: GhApiFetcher = ghJson): PullRequestBoard {
  const boards: RepoPullRequestBoard[] = repos.map((repo) => {
    try {
      const rows = fetch(ghPrListArgv(repo));
      const list = Array.isArray(rows) ? (rows as RawPullRequestRow[]) : [];
      return { repo, available: true, pullRequests: list.map(summarizeRow) };
    } catch (e) {
      // UNREADABLE, not empty — see the module doc's design (ii) and this function's own note
      // above; the same distinction `ci-failures`/`loadCiFailureWindow` already carries for its
      // own repository read.
      return { repo, available: false, error: (e as Error).message };
    }
  });
  return { repos: boards };
}
