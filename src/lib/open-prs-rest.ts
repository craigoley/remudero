/**
 * The sweep's open-PR enumeration, over REST ONLY.
 *
 * WHY THIS MODULE EXISTS. `buildOpenPrViews` (run-task.ts) built the sweep's whole observed
 * state from ONE `gh pr list --json number,url,…,statusCheckRollup`. `gh`'s `--json` flag is
 * implemented over GitHub's GraphQL API, so that single call put the ENTIRE sweep critical path
 * behind the GraphQL point budget. On 2026-07-28 that budget was exhausted mid-window and every
 * sweep pass from 16:59:58Z to 17:25Z died with, verbatim:
 *
 *   Command failed: gh pr list --repo craigoley/remudero --state open --limit 100 --json …
 *   GraphQL: API rate limit already exceeded for user ID 4397075.
 *
 * The failure mode is the bad one: the sweep did not degrade to a partial view, it went
 * completely blind — 22 consecutive minutes with ZERO PRs dispositioned, while the REST/core
 * budget sat healthy the whole time. PR #794 moved merge-state derivation to a batched
 * non-search gateway and PR #796 moved escalation reads to REST; this enumeration was the last
 * GraphQL dependency left in the sweep's critical path.
 *
 * WHAT THIS IS NOT. This module reproduces the EXISTING value bit-for-bit over a different
 * transport. It adds no retry, no alarming, no degraded mode, and no escalation — a fetch
 * failure still throws exactly as `ghJson` throws today, and the caller's existing handling is
 * unchanged. Widening the behaviour here would hide the transport swap inside a semantic change.
 *
 * THE COST TRADE, stated plainly. GraphQL answered the whole question in ONE request; REST needs
 * 1 + 2N (the list, then check-runs + combined-status per PR head). At this repo's steady-state
 * of ~3-10 open PRs that is 7-21 core requests per sweep pass against a 5000/hr core budget —
 * affordable at a 1-minute poll, and spent from the budget that was NEVER the one exhausted.
 */

/**
 * The open-PR list argv. `per_page=100` and NO `--paginate` is deliberate: it reproduces the
 * exact truncation `--limit 100` already had, so the migration changes transport and nothing
 * else. It also sidesteps the `--paginate` trap — bare `--paginate` emits one JSON array PER
 * PAGE, which `JSON.parse` rejects outright, and the `--slurp` that fixes that cannot be
 * combined with `--jq`.
 */
export function openPrsRestArgs(owner: string, repo: string): string[] {
  return ["api", `repos/${owner}/${repo}/pulls?state=open&per_page=100`];
}

/** The single-PR argv — the `rmd fix` path, which names one PR explicitly. */
export function singlePrRestArgs(owner: string, repo: string, prNumber: number): string[] {
  return ["api", `repos/${owner}/${repo}/pulls/${prNumber}`];
}

/**
 * Fetch one `gh api …` argv and return its parsed JSON. Injected so every parser and the two
 * orchestrators below are testable with zero network — the real caller passes `ghJson`.
 *
 * Declared HERE, sandwiched between two executed functions, rather than at the file head: the
 * v8 coverage channel stamps `DA:<line>,0` across a new module's leading and trailing
 * source-line records, so a type-only declaration parked at either end reads to diff-coverage as
 * uncovered "code".
 */
export type GhApiFetcher = (args: string[]) => unknown;

/**
 * Check-runs for a head SHA. REST defaults to `filter=latest` (one run per check NAME), which is
 * what GraphQL's rollup reports too — so reruns collapse identically on both transports.
 */
export function checkRunsRestArgs(owner: string, repo: string, sha: string): string[] {
  return ["api", `repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`];
}

/** The COMBINED commit status for a head SHA — where `remudero-review` (a commit status, not a
 *  check run) lives. The sweep's review lane is blind without this half. */
export function combinedStatusRestArgs(owner: string, repo: string, sha: string): string[] {
  return ["api", `repos/${owner}/${repo}/commits/${sha}/status`];
}

/** One check run as REST reports it (lowercase enums, snake_case keys). */
interface RestCheckRun {
  name?: string;
  /** "queued" | "in_progress" | "completed" — lowercase, where GraphQL reports "QUEUED" etc. */
  status?: string;
  /** "success" | "failure" | "neutral" | … — `null` while the run is still incomplete. */
  conclusion?: string | null;
  details_url?: string | null;
}

/** One commit status as REST reports it. */
interface RestStatus {
  context?: string;
  /** "success" | "failure" | "pending" | "error" — lowercase, where GraphQL reports "SUCCESS". */
  state?: string;
  target_url?: string | null;
}

/**
 * One composed rollup entry — GraphQL's `statusCheckRollup` union member, structurally.
 *
 * Deliberately NOT declared as `extends RollupCheckEntry` (lib/sweep.ts): that would need a
 * type-only import at the file HEAD, and the v8 coverage channel stamps `DA:<line>,0` across a
 * new module's leading source-line records, so diff-coverage reads a head-parked declaration as
 * uncovered code. sweep.ts's own doc already states the intended relationship — its
 * `RollupCheckEntry` names only the fields `checksStateFromRollup` reads, so this type is
 * structurally assignable to it WITHOUT an import. That assignability is compile-checked for
 * real: test/open-prs-rest.test.ts passes `rollupFromRest(...)` straight into
 * `checksStateFromRollup`, so a drift in either shape fails `tsc`.
 */
export interface RestRollupEntry {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

/**
 * UPPERCASE a REST enum the way GraphQL already reports it, preserving "absent" as absent.
 *
 * THIS IS LOAD-BEARING, not cosmetic. Every consumer resolves an entry's outcome as
 * `(state ?? conclusion ?? status ?? "").toUpperCase()`, so the `??` chain must fall through on
 * a missing value. REST sends `conclusion: null` for an incomplete run; mapping that to `""`
 * would make the chain STOP on the empty string instead of falling through to `status`, turning
 * a legitimately-queued required check into an empty outcome. Returning `undefined` keeps the
 * fall-through intact.
 */
function upper(v: string | null | undefined): string | undefined {
  return v == null || v === "" ? undefined : v.toUpperCase();
}

/**
 * Compose ONE GraphQL-shaped `statusCheckRollup` from REST's two halves.
 *
 * GraphQL's rollup is a union of CheckRun nodes (`name`/`status`/`conclusion`/`detailsUrl`) and
 * StatusContext nodes (`context`/`state`/`targetUrl`). REST splits that union across two
 * endpoints, so both must be read and concatenated — reading only `/check-runs` would drop
 * `remudero-review` entirely and make every reviewed PR look unreviewed.
 *
 * The combined-status endpoint's TOP-LEVEL `state` is deliberately IGNORED: it is GitHub's own
 * roll-up-of-a-rollup and reports "pending" for a commit with zero statuses. Synthesising an
 * entry from it would invent a pending check that GraphQL never reported, and (per
 * `checksStateFromRollup`) an invented entry on an otherwise-empty rollup flips "none" to
 * "pending". Only real `statuses[]` rows become entries.
 */
export function rollupFromRest(checkRuns: RestCheckRun[], statuses: RestStatus[]): RestRollupEntry[] {
  const fromRuns = checkRuns.map((c) => {
    const e: RestRollupEntry = { name: c.name ?? "" };
    const status = upper(c.status);
    const conclusion = upper(c.conclusion);
    if (status !== undefined) e.status = status;
    if (conclusion !== undefined) e.conclusion = conclusion;
    if (c.details_url) e.detailsUrl = c.details_url;
    return e;
  });
  const fromStatuses = statuses.map((s) => {
    const e: RestRollupEntry = { context: s.context ?? "" };
    const state = upper(s.state);
    if (state !== undefined) e.state = state;
    // `targetUrl`, NOT `detailsUrl`: GraphQL's StatusContext carries targetUrl, and
    // `fetchCiFailures` mines `detailsUrl` for an Actions job id. Surfacing a status's target
    // URL as `detailsUrl` would feed a non-Actions URL to that miner.
    if (s.target_url) e.targetUrl = s.target_url;
    return e;
  });
  return [...fromRuns, ...fromStatuses];
}

/** One pull request as REST's `/pulls` endpoint returns it — the wire shape, never a consumer's. */
interface RestPullRow {
  number: number;
  /** The api.github.com URL. DROPPED — consumers match on the github.com web URL. */
  url?: string;
  html_url: string;
  /** Lowercase "open"/"closed", where `gh --json state` reports "OPEN"/"CLOSED"/"MERGED". */
  state?: string;
  merged?: boolean;
  /** `null` on an empty body, where GraphQL reports "". */
  body?: string | null;
  updated_at: string;
  head?: { ref?: string; sha?: string };
  /** `null` unless auto-merge is armed. Consumed ONLY as a nullity test. */
  auto_merge?: unknown;
}

/** The enumeration's output row — structurally what `gh pr list --json …` produced. */
export interface OpenPrRest {
  number: number;
  url: string;
  headRefName: string;
  headRefOid: string;
  updatedAt: string;
  body: string;
  autoMergeRequest: unknown;
  statusCheckRollup?: RestRollupEntry[];
}

/**
 * Translate one REST pull row to the `gh --json` shape, WITHOUT its rollup (the caller attaches
 * that after fetching the head SHA's two check endpoints).
 *
 * FOUR translations are load-bearing:
 *  1. `url` comes from `html_url`, never REST's `url`. The sweep writes PR URLs into the ledger
 *     and matches on them; surfacing api.github.com would make every lookup miss SILENTLY.
 *  2. `body` normalises `null` to `""` — `RawOpenPr.body` is typed `string`, and the
 *     `Remudero-Task:` trailer regex runs against it.
 *  3. `headRefName` must survive as `""` rather than `undefined`, because the Dependabot routing
 *     predicate is `headRefName.startsWith("dependabot/")`.
 *  4. `autoMergeRequest` passes REST's `auto_merge` through VERBATIM rather than reshaping it.
 *     Its sole consumer is `autoMergeArmed: pr.autoMergeRequest != null`, so nullity is the
 *     entire contract; REST's object differs from GraphQL's in key names only, and no consumer
 *     reads a key.
 */
export function mapRestPr(row: RestPullRow): OpenPrRest {
  return {
    number: row.number,
    url: row.html_url,
    headRefName: row.head?.ref ?? "",
    headRefOid: row.head?.sha ?? "",
    updatedAt: row.updated_at,
    body: row.body ?? "",
    autoMergeRequest: row.auto_merge ?? null,
  };
}

/**
 * REST's open/closed/merged triple, collapsed to the single uppercase token
 * `terminalStateReason` compares against.
 *
 * MUST NOT be simplified to `state.toUpperCase()`. `terminalStateReason` treats ANY value other
 * than the literal `"OPEN"` as terminal, and REST reports a MERGED pull as
 * `{state: "closed", merged: true}` — so the `merged` flag has to be folded in here, exactly as
 * GraphQL's single `MERGED` token already folds it. Lower-cased "open" would also read as
 * terminal, which would make `rmd fix` refuse every live PR.
 */
export function prStateFromRest(row: { state?: string; merged?: boolean }): string {
  if (row.merged) return "MERGED";
  return (row.state ?? "").toUpperCase() || "UNKNOWN";
}

/** Fetch and attach one PR head's composed rollup. Split out so both orchestrators share it. */
function rollupFor(owner: string, repo: string, sha: string, fetch: GhApiFetcher): RestRollupEntry[] {
  const runs = fetch(checkRunsRestArgs(owner, repo, sha)) as { check_runs?: RestCheckRun[] };
  const combined = fetch(combinedStatusRestArgs(owner, repo, sha)) as { statuses?: RestStatus[] };
  return rollupFromRest(runs?.check_runs ?? [], combined?.statuses ?? []);
}

/**
 * The sweep's open-PR enumeration, REST only — a drop-in for the `gh pr list --json …` call.
 *
 * Throws on a failed fetch, exactly as the `ghJson` call it replaces threw. That is deliberate:
 * a swallowed error here would turn a total outage into a silent "zero open PRs", which the
 * sweep would read as a healthy empty queue — strictly worse than the blindness being fixed.
 */
export function fetchOpenPrsRest(owner: string, repo: string, fetch: GhApiFetcher): OpenPrRest[] {
  const rows = fetch(openPrsRestArgs(owner, repo)) as RestPullRow[];
  return rows.map((row) => {
    const pr = mapRestPr(row);
    return { ...pr, statusCheckRollup: rollupFor(owner, repo, pr.headRefOid, fetch) };
  });
}

/** The `rmd fix` single-PR read — same mapping, plus the `state` token `routeFix` gates on. */
export function fetchSinglePrRest(
  owner: string,
  repo: string,
  prNumber: number,
  fetch: GhApiFetcher,
): OpenPrRest & { state: string } {
  const row = fetch(singlePrRestArgs(owner, repo, prNumber)) as RestPullRow;
  const pr = mapRestPr(row);
  return {
    ...pr,
    state: prStateFromRest(row),
    statusCheckRollup: rollupFor(owner, repo, pr.headRefOid, fetch),
  };
}
