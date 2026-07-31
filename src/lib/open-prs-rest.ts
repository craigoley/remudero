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
export interface RestPullRow {
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
  /** The PR title (W1-T184's RECENT decoration). Absent only on a malformed row. */
  title?: string;
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

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * THE BOARD GATEWAY'S ENUMERATION (W1-T265) — the SECOND consumer of this module.
 *
 * The sweep's enumeration above needs OPEN PRs plus each head's checks. The board gateway
 * (`buildBatchedGithub`, lib/status.ts) needs something different and much larger: EVERY PR in
 * every state, with `body` (the `Remudero-Task:` trailer index) and `title`, and no checks at
 * all. Its call was still `gh pr list --state all --limit 1000 --json …` — GraphQL.
 *
 * MEASURED, 2026-07-31, running that exact command against this repo: 687 PRs, 2,888,862 bytes,
 * 12 GraphQL points. The gateway's TTL is 15 s and the console polls every 3 s, so ONE open
 * browser tab drives 240 fetches/hour = 2,880 of the account's 5,000 GraphQL points — ~58% of
 * the whole budget, spent re-downloading a set that is 686/687 immutable. When it runs out the
 * fetch throws, merged-ness becomes underivable, and long-merged tasks sit pinned at the head of
 * UP NEXT until the hourly reset (state/recon-BV-console-visibility.md, Q5/Q6).
 *
 * WHY NOT JUST `fetchOpenPrsRest`. It is open-only, it carries no `title`, and it pays 1+2N
 * requests for the check rollups the board never reads. The three translations that ARE shared —
 * `mapRestPr`, `prStateFromRest`, `RestPullRow` — are reused verbatim below rather than
 * re-derived, which is the whole reason this lives in this module and not a new one.
 *
 * WHY A DELTA. A naive full REST paginate is 7 requests and 13,658,113 bytes per poll (measured,
 * same day) — better on points than GraphQL but 4.7x WORSE on bytes, and 1,680 core points/hour.
 * Trading a starved GraphQL budget for a starved core budget is not a fix. So the cold pass runs
 * once and every refresh after it reads only what changed. See {@link fetchBoardPrsRest}.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The board's list argv for ONE page of one state.
 *
 * `sort=updated&direction=desc` is LOAD-BEARING, not cosmetic — it is the entire basis of the
 * delta's early stop. `page`/`per_page` rather than `--paginate` for the same reason
 * {@link openPrsRestArgs} avoids it: bare `--paginate` emits one JSON array per page, which
 * `JSON.parse` rejects, and the `--slurp` that fixes that cannot be combined with `--jq`.
 */
export function boardPrsRestArgs(owner: string, repo: string, state: "open" | "closed", page: number, perPage: number): string[] {
  return ["api", `repos/${owner}/${repo}/pulls?state=${state}&sort=updated&direction=desc&per_page=${perPage}&page=${page}`];
}

/**
 * One board row — structurally what `gh pr list --json number,url,state,headRefName,body,
 * autoMergeRequest,title` produced, plus the `updatedAt` the delta stops on.
 */
export interface BoardPrRest {
  number: number;
  url: string;
  /** UPPERCASE "OPEN" | "CLOSED" | "MERGED", via {@link prStateFromRest}. */
  state: string;
  headRefName: string;
  body: string;
  autoMergeRequest: unknown;
  title: string;
  /** REST's `updated_at`. Not rendered — the delta's stop key. */
  updatedAt: string;
}

/**
 * Translate one REST pull row to the board's row shape.
 *
 * Everything except `state` and `title` comes from {@link mapRestPr}, so the four load-bearing
 * translations documented there (html_url, `body ?? ""`, `headRefName ?? ""`, verbatim
 * `auto_merge`) hold here by construction rather than by a second copy of the same reasoning.
 * Two more are added:
 *
 *  5. `state` runs through {@link prStateFromRest}, NOT `state.toUpperCase()`. REST reports a
 *     merged PR as `{state: "closed", merged: true}`; the board's index does
 *     `all.filter((p) => p.state === "MERGED")` to build `mergedNewestFirst`, which backs
 *     `findMergedByTrailer` / `findMergedByHeadBranch` / `listMergedHeadBranches` — i.e. every
 *     merged-ness answer the board renders. A plain upper-case would make that filter match
 *     NOTHING and every merged task would render as still queued.
 *  6. `title` normalises absent to `""`. `PrRef.title` is optional, so `undefined` renders as an
 *     undecorated RECENT row rather than an error — silent, which is why it is pinned here.
 */
export function mapBoardPr(row: RestPullRow): BoardPrRest {
  const base = mapRestPr(row);
  return {
    number: base.number,
    url: base.url,
    state: prStateFromRest(row),
    headRefName: base.headRefName,
    body: base.body,
    autoMergeRequest: base.autoMergeRequest,
    title: row.title ?? "",
    updatedAt: base.updatedAt,
  };
}

/** Cold pass page size — 687 PRs is 7 requests. */
const BOARD_FULL_PAGE_SIZE = 100;
/**
 * Delta page size. Smaller because a steady-state refresh only has to reach the first row it
 * already holds unchanged, which in practice is row 1 or 2 — a 100-row page would move ~2.2 MB
 * to learn that nothing happened. Page size must be constant WITHIN a run (mixing sizes across
 * `page=` offsets would skip rows), so a delta that somehow needs a second page pays 30 again.
 */
const BOARD_DELTA_PAGE_SIZE = 30;
/** Runaway guard: 50 pages is 5,000 PRs at the full size. Reported, never silent. */
const BOARD_MAX_PAGES = 50;

/** What a board fetch cost, for the ledger — the point of the exercise is that this stays small. */
export interface BoardFetchResult {
  rows: BoardPrRest[];
  /** REST requests issued. Steady state is 2. */
  calls: number;
  mode: "full" | "delta";
  /** True if {@link BOARD_MAX_PAGES} stopped the walk — a truncated view, never silent. */
  truncated: boolean;
}

/**
 * Every PR in the repo, over REST, re-reading only what can have changed.
 *
 * TWO HALVES, because they have different mutability:
 *
 *   HOT — every OPEN PR, re-read unconditionally on every call. Open PRs are the only ones whose
 *   rendered fields can still move, and this repo runs 1–10 of them, so it is one small request
 *   (15,490 bytes measured). Doing it unconditionally is deliberate belt-and-braces: it does not
 *   depend on GitHub bumping `updated_at` for the mutation in question, which matters most for
 *   `auto_merge` — arming is exactly the kind of state change whose `updated_at` behaviour I did
 *   not want the armed/unarmed badge to rest on.
 *
 *   COLD — CLOSED and MERGED PRs, walked newest-updated-first and stopped at the first row
 *   already held with an identical `updated_at`.
 *
 * WHY THE STOP IS SOUND, stated because a wrong stop silently freezes a row forever. The cache is
 * complete as of the last successful call at time F. Anything that changed after F has
 * `updated_at > F`; anything unchanged has `updated_at <= F`. The walk is sorted by `updated_at`
 * descending, so every changed row sorts strictly above every unchanged one. The first row whose
 * `updated_at` matches the cache is therefore unchanged, and so is everything below it. The base
 * case is the cold pass, which walks to the end with no cache to stop on.
 *
 * ROWS THE WALK NEVER REACHES KEEP THEIR CACHED VALUES. That is the point: a merged PR's number,
 * url, state, head ref, body, title and auto-merge record are all frozen at merge.
 *
 * THROWS on any failed page, exactly as the `gh pr list` call it replaces threw, and WITHOUT
 * mutating the caller's cache — so a failure leaves the previous complete snapshot intact and the
 * next successful call is still a cheap delta rather than a cold re-walk. Swallowing here would
 * turn an outage into "the repo has zero PRs", which is the W1-T181 hazard this codebase already
 * paid for once.
 */
export function fetchBoardPrsRest(
  owner: string,
  repo: string,
  fetch: GhApiFetcher,
  known?: ReadonlyMap<number, BoardPrRest>,
): BoardFetchResult {
  const mode: "full" | "delta" = known && known.size > 0 ? "delta" : "full";
  const perPage = mode === "delta" ? BOARD_DELTA_PAGE_SIZE : BOARD_FULL_PAGE_SIZE;
  const out = new Map<number, BoardPrRest>(known ?? []);
  let calls = 0;
  let truncated = false;

  // HOT half. Paginated properly rather than assuming one page: a repo that ever holds >100 open
  // PRs must not silently drop the tail of them.
  for (let page = 1; page <= BOARD_MAX_PAGES; page += 1) {
    const rows = fetch(boardPrsRestArgs(owner, repo, "open", page, perPage)) as RestPullRow[];
    calls += 1;
    for (const row of rows) {
      const pr = mapBoardPr(row);
      out.set(pr.number, pr);
    }
    if (rows.length < perPage) break;
    if (page === BOARD_MAX_PAGES) truncated = true;
  }

  // COLD half.
  for (let page = 1; page <= BOARD_MAX_PAGES; page += 1) {
    const rows = fetch(boardPrsRestArgs(owner, repo, "closed", page, perPage)) as RestPullRow[];
    calls += 1;
    let reachedKnown = false;
    for (const row of rows) {
      if (known?.get(row.number)?.updatedAt === row.updated_at) {
        reachedKnown = true;
        break;
      }
      const pr = mapBoardPr(row);
      out.set(pr.number, pr);
    }
    if (reachedKnown || rows.length < perPage) break;
    if (page === BOARD_MAX_PAGES) truncated = true;
  }

  return { rows: [...out.values()], calls, mode, truncated };
}
