/**
 * The sweep's open-PR enumeration, over REST only.
 *
 * Invariant: nothing here reads GraphQL. `gh`'s `--json` flag is implemented over GraphQL, so the
 * single `gh pr list --json …` call this replaced put the whole sweep critical path behind the
 * GraphQL point budget; when it emptied on 2026-07-28 the sweep went blind for 22 minutes while
 * the core budget sat healthy (CLAUDE.md, "CI and merging"; PR #794, PR #796).
 *
 * The module reproduces the existing value bit for bit over a different transport: no retry, no
 * alarming, no degraded mode, no escalation. The trade is 1 + 2N requests where GraphQL asked once
 * — 7-21 core a pass, from the budget that was never exhausted (docs/forensics/open-prs-rest.md).
 */

import type { ConflictFileDiff, MergeConflictEvidence, MergeState, RedundantRefixEvidence } from "./merge-state.js";
import type { WorkflowRunObservation } from "./workflow-run.js";
// W1-T2384: from the LEAF, never from sweep.js. dependency-cruiser reads a type-only import as
// a dependency (MEASURED: importing this off sweep.js took it 13 -> 24 warnings), and sweep.ts
// imports a VALUE back off this module — see supersession.ts's own header.
import type { SupersessionVerdict } from "./supersession.js";
import { withGhBudgetReading, type GhBudgetReading } from "./github-transport.js";
export {
  createGhCallPacer,
  DEFAULT_GH_PACE_FLOOR_FRACTION,
  DEFAULT_GH_PACE_LOW_WATER_FRACTION,
  DEFAULT_GH_PACE_MIN_GAP_MS,
  DEFAULT_GH_PACE_RATE_LIMIT_GAP_MS,
  DEFAULT_GH_REFUSAL_BACKOFF_FLOOR_MS,
  DEFAULT_GH_REFUSAL_BACKOFF_JITTER_FRACTION,
  DEFAULT_GH_REFUSAL_BACKOFF_MAX_ATTEMPTS,
  defaultGhRetryAfterSeconds,
  GhPaceFloorStandDownError,
  paceGhEntry,
  type GhBudgetReading,
  type GhCallPacer,
  type GhRefusalBackoffOpts,
} from "./github-transport.js";

/** W1-T2779: injected from run-task.ts, which already owns the shared isInPlanScope import. Keeping
 * this leaf unaware of plan-architect avoids closing three runtime dependency cycles. */
export type PlanPathPredicate = (path: string) => boolean;

/** The open-PR list argv. `per_page=100` with no `--paginate` reproduces the exact truncation
 *  `--limit 100` had. Trap: bare `--paginate` emits one JSON array per page, which `JSON.parse`
 *  rejects, and the `--slurp` that fixes that cannot be combined with `--jq`. */
export function openPrsRestArgs(owner: string, repo: string): string[] {
  return ["api", `repos/${owner}/${repo}/pulls?state=open&per_page=100`];
}

/** The single-PR argv — the `rmd fix` path, which names one PR explicitly. */
export function singlePrRestArgs(owner: string, repo: string, prNumber: number): string[] {
  return ["api", `repos/${owner}/${repo}/pulls/${prNumber}`];
}

/** Fetch one `gh api …` argv and return its parsed JSON. Injected so every parser and both
 *  orchestrators are testable with no network; the real caller passes `ghJson`.
 *
 *  Trap: declared between two executed functions, not at the file head — the v8 coverage channel
 *  stamps `DA:<line>,0` across a module's leading and trailing source-line records, so a type-only
 *  declaration parked at either end reads to diff-coverage as uncovered code. `onRateLimit` restates
 *  `ghJson`'s optional second parameter structurally, because this module never imports from
 *  worker.ts; a fixture ignoring it is unaffected (W1-T1008). */
export type GhApiFetcher = (
  args: string[],
  onRateLimit?: (reading: { remaining?: number; limit?: number; resource?: string }) => void,
) => unknown;

/** Narrow `ghJson`'s all-optional reading to the {@link GhBudgetReading} that can arm the floor.
 *  Invariant: a reading missing any of the three fields yields no budget at all — never a partial or
 *  zeroed one, which could read as "empty" and stand every following call down on a fluke. */
function budgetFromRateLimitLikeReading(reading: {
  remaining?: number;
  limit?: number;
  resource?: string;
}): GhBudgetReading | undefined {
  const { remaining, limit, resource } = reading;
  if (remaining === undefined || limit === undefined || resource === undefined) return undefined;
  if (!Number.isFinite(remaining) || !Number.isFinite(limit)) return undefined;
  return { remaining, limit, resource };
}

/** Check-runs for a head SHA. REST defaults to `filter=latest` (one run per check name), which is what
 *  GraphQL's rollup reports too — so reruns collapse identically on both transports. */
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
  /** W1-T2300 — ISO8601 start of this attempt, on every entry a live response carries. Mirrored to
   *  {@link RestRollupEntry.startedAt} by {@link rollupFromRest}. */
  started_at?: string | null;
}

/** One commit status as REST reports it. */
interface RestStatus {
  context?: string;
  /** "success" | "failure" | "pending" | "error" — lowercase, where GraphQL reports "SUCCESS". */
  state?: string;
  target_url?: string | null;
  /** W1-T2300 — ISO8601 creation time. A status context carries no `started_at`, so this is the key
   *  {@link RestRollupEntry.startedAt} is mapped from, as in the real `gh` gateway. */
  created_at?: string | null;
}

/** One composed rollup entry — GraphQL's `statusCheckRollup` union member, structurally. Not declared
 *  as `extends RollupCheckEntry` (lib/sweep.ts): that needs a type-only import at the file head, which
 *  diff-coverage reads as uncovered code. Falsifier: test/open-prs-rest.test.ts passes
 *  `rollupFromRest(...)` into `checksStateFromRollup`, so drift in either shape fails `tsc`. */
export interface RestRollupEntry {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
  /** W1-T2300 — when this attempt started, mapped by {@link rollupFromRest} from a check run's
   *  `started_at` or a status context's `created_at`; absent only on a malformed row.
   *  `dedupeRollupByLatestAttempt` sorts on it and `staleCiGateTransition` needs it to fire — an entry
   *  carrying none sorted as though every REST attempt shared one array-order tie. */
  startedAt?: string;
}

/** Uppercase a REST enum the way GraphQL reports it, preserving absent as absent. Invariant: this is
 *  load-bearing. Consumers resolve an outcome as `(state ?? conclusion ?? status ??
 *  "").toUpperCase()`, so the chain must fall through on a missing value; REST sends
 *  `conclusion: null` for an incomplete run, and mapping that to `""` would turn a queued required
 *  check into an empty outcome. */
function upper(v: string | null | undefined): string | undefined {
  return v == null || v === "" ? undefined : v.toUpperCase();
}

/** Compose one GraphQL-shaped `statusCheckRollup` from REST's two halves. REST splits GraphQL's
 *  union across two endpoints, so both are read and concatenated: reading only `/check-runs` would
 *  drop `remudero-review` and make every reviewed PR look unreviewed.
 *
 *  Invariant: the combined-status endpoint's top-level `state` is ignored — it reports "pending" for
 *  a commit with zero statuses, and an invented entry flips `checksStateFromRollup` from "none" to
 *  "pending", so only real `statuses[]` rows become entries. The two shapes map
 *  {@link RestRollupEntry.startedAt} from two different source keys (W1-T2300). */
export function rollupFromRest(checkRuns: RestCheckRun[], statuses: RestStatus[]): RestRollupEntry[] {
  const fromRuns = checkRuns.map((c) => {
    const e: RestRollupEntry = { name: c.name ?? "" };
    const status = upper(c.status);
    const conclusion = upper(c.conclusion);
    if (status !== undefined) e.status = status;
    if (conclusion !== undefined) e.conclusion = conclusion;
    if (c.details_url) e.detailsUrl = c.details_url;
    if (c.started_at) e.startedAt = c.started_at;
    return e;
  });
  const fromStatuses = statuses.map((s) => {
    const e: RestRollupEntry = { context: s.context ?? "" };
    const state = upper(s.state);
    if (state !== undefined) e.state = state;
    // `targetUrl`, not `detailsUrl`: `fetchCiFailures` mines `detailsUrl` for an Actions job id,
    // and a status context's target URL is not an Actions URL.
    if (s.target_url) e.targetUrl = s.target_url;
    // A status context has no `started_at`; `created_at` is what the real `gh` gateway maps this from.
    if (s.created_at) e.startedAt = s.created_at;
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
  /** SINGLE-PR ENDPOINT ONLY. The `/pulls` LIST endpoint omits this key entirely — see
   *  {@link prStateFromRest}, which is why it is not the merge discriminator. */
  merged?: boolean;
  /** The merge timestamp, or `null` when unmerged. Returned by BOTH endpoints, so this — not
   *  {@link RestPullRow.merged} — is what {@link prStateFromRest} decides MERGED on. */
  merged_at?: string | null;
  /** W1-T2304: when the PR opened — the only input to the board-review rung's age arm. Omitted rather
   *  than defaulted, so a row without it never reads as an infinitely old PR. */
  created_at?: string;
  /** `null` on an empty body, where GraphQL reports "". */
  body?: string | null;
  updated_at: string;
  head?: { ref?: string; sha?: string };
  /** `null` unless auto-merge is armed. Consumed ONLY as a nullity test. */
  auto_merge?: unknown;
  /** The PR title (W1-T184's RECENT decoration). Absent only on a malformed row. */
  title?: string;
  /** W1-T528: true when the PR is a draft — the operator's hold, which the sweep's update-branch rung
   *  refuses to touch (`selectUpdateBranchTarget`, lib/sweep.ts). Returned by both endpoints, unlike
   *  {@link RestPullRow.merged} above, because `draft` is in the `pull-request-simple` schema the list
   *  endpoint serves. Optional: a malformed row degrades to `undefined`, never `false`. */
  draft?: boolean;
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
  /** W1-T521: true when this PR's rollup fetch threw — exhaustion, a 404 on a head deleted mid-pass, a
   *  network blip — so `statusCheckRollup` is absent rather than an observed empty rollup. Sparse,
   *  mirroring `status.ts`'s `indeterminate` convention. `checksStateFromRollup` (lib/sweep.ts) reads an
   *  absent rollup as "none", never "green", so such a PR cannot be disposed mergeable off a failed
   *  read; this flag carries what "none" alone cannot. */
  rollupUnreadable?: true;
  /** W1-T528: GitHub's `draft`, under the `gh --json` name this interface mirrors. Consumed by
   *  `buildOpenPrViews` (run-task.ts) as `OpenPrView.isDraft`. Preserved as `undefined` when the row
   *  omits it — never `false`, which would launder "GitHub did not say" into "not a draft". */
  isDraft?: boolean;
  /** REST's `created_at`, carried for the board-review rung's age arm. Absent on a malformed row
   *  — a consumer must treat absence as "age unknown", never as age zero or age infinity. */
  createdAt?: string;
}

/** Translate one REST pull row to the `gh --json` shape, without its rollup. Four translations are
 *  load-bearing: `url` comes from `html_url`, never REST's `url`, because the ledger matches on the web
 *  URL; `body` normalises `null` to `""` for the `Remudero-Task:` trailer regex; `headRefName` survives
 *  as `""` because the Dependabot predicate calls `.startsWith`; and `autoMergeRequest` passes
 *  `auto_merge` verbatim, since `autoMergeArmed: pr.autoMergeRequest != null` is the whole contract. */
export function mapRestPr(row: RestPullRow): OpenPrRest {
  return {
    number: row.number,
    url: row.html_url,
    headRefName: row.head?.ref ?? "",
    headRefOid: row.head?.sha ?? "",
    updatedAt: row.updated_at,
    body: row.body ?? "",
    autoMergeRequest: row.auto_merge ?? null,
    // W1-T528: undefaulted — `?? false` would make a malformed row assert "not a draft" rather than
    // "unknown", and the operator's hold is the one fact this rung must not guess at. Sparse like
    // `rollupUnreadable`, so a row omitting `draft` maps to exactly the pre-W1-T528 object.
    ...(row.draft === undefined ? {} : { isDraft: row.draft }),
    // Same omitted-rather-than-defaulted discipline as `isDraft` directly above.
    ...(row.created_at === undefined ? {} : { createdAt: row.created_at }),
  };
}

/** REST's open/closed/merged triple, collapsed to the uppercase token `terminalStateReason` compares
 *  against.
 *
 *  Invariant: `merged_at` is the discriminator and `merged` only corroborates. The list endpoint
 *  omits `merged` — a single-PR-only field — so it reads `undefined` there and every merged pull
 *  collapsed to "CLOSED"; `merged_at` is returned by both endpoints. Trap: do not simplify to
 *  `state.toUpperCase()`, since a lower-cased "open" reads terminal and `rmd fix` would refuse every
 *  live PR. Falsifier: test/open-prs-rest.test.ts, on fixtures captured from a live list response.
 *  Why: the 2026-07-31 dispatch runaway — docs/forensics/open-prs-rest.md (#1017). */
export function prStateFromRest(row: { state?: string; merged?: boolean; merged_at?: string | null }): string {
  if (row.merged === true || row.merged_at != null) return "MERGED";
  return (row.state ?? "").toUpperCase() || "UNKNOWN";
}

/** Fetch and attach one PR head's composed rollup. Split out so both orchestrators share it, and
 *  exported for W1-T2268: run-task.ts's `pollToGate`/`waitForCiGreen` were the last GraphQL reads on
 *  the point-priced budget (`gh pr view --json statusCheckRollup`, every 6s for a whole CI wait) and
 *  migrate onto this read. Falsifier: test/poll-rollup-over-rest.test.ts. */
export function rollupFor(owner: string, repo: string, sha: string, fetch: GhApiFetcher): RestRollupEntry[] {
  const runs = fetch(checkRunsRestArgs(owner, repo, sha)) as { check_runs?: RestCheckRun[] };
  const combined = fetch(combinedStatusRestArgs(owner, repo, sha)) as { statuses?: RestStatus[] };
  return rollupFromRest(runs?.check_runs ?? [], combined?.statuses ?? []);
}

/** The sweep's open-PR enumeration, REST only — a drop-in for the `gh pr list --json …` call.
 *
 *  Invariant: the list call throws, exactly as the `ghJson` call it replaced threw, because
 *  swallowing would turn an outage into a silent "zero open PRs" the sweep reads as a healthy empty
 *  queue. Once the list returns the queue size is known, so the per-PR rollup read is guarded
 *  instead: a throw yields that PR with `rollupUnreadable: true` rather than costing every other PR
 *  its disposition, and no retry, because the next pass re-derives (W1-T521). W1-T1008: the list call
 *  alone asks `fetch` for its rate-limit reading and returns it via {@link withGhBudgetReading}, for
 *  {@link paceGhEntry} to arm the floor from. */
export function fetchOpenPrsRest(owner: string, repo: string, fetch: GhApiFetcher): OpenPrRest[] {
  let budget: GhBudgetReading | undefined;
  const rows = fetch(openPrsRestArgs(owner, repo), (reading) => {
    budget = budgetFromRateLimitLikeReading(reading);
  }) as RestPullRow[];
  const result = rows.map((row) => {
    const pr = mapRestPr(row);
    try {
      return { ...pr, statusCheckRollup: rollupFor(owner, repo, pr.headRefOid, fetch) };
    } catch {
      return { ...pr, rollupUnreadable: true as const };
    }
  });
  return withGhBudgetReading(result, budget);
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

/** W1-T511: `ghLiveState`'s (run-task.ts) REST substitute — one fetch, no rollup. Not
 *  {@link fetchSinglePrRest}, which also fetches the head's two rollup endpoints: the post-review
 *  disposition this replaces reads exactly one field, so an unasked-for rollup would triple the cost of
 *  a call whose point is staying cheap. The row goes to {@link prStateFromRest}, so no consumer of the
 *  token can tell which transport served it. */
export function liveStateFromRest(owner: string, repo: string, prNumber: number, fetch: GhApiFetcher): string {
  const row = fetch(singlePrRestArgs(owner, repo, prNumber)) as RestPullRow;
  return prStateFromRest(row);
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * The board gateway's enumeration (W1-T265) — the second consumer of this module.
 *
 * The gateway (`buildBatchedGithub`, lib/status.ts) needs every PR in every state, with `body` and
 * `title` and no checks at all. Its GraphQL call re-downloaded an almost entirely immutable set on a
 * 15s TTL, spending ~58% of the account's GraphQL budget on one open console tab; when it ran out,
 * merged-ness became underivable and long-merged tasks stayed pinned at the head of UP NEXT. Not
 * {@link fetchOpenPrsRest}: open-only, no `title`, and 1+2N requests for rollups the board never reads.
 * It reuses {@link mapRestPr}, {@link prStateFromRest} and {@link RestPullRow}, which is why this lives
 * here. A naive full REST paginate is better on points and 4.7x worse on bytes, so the cold pass runs
 * once and every refresh reads only what changed (docs/forensics/open-prs-rest.md).
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/** The board's list argv for one page of one state. Invariant: `sort=updated&direction=desc` is the
 *  entire basis of the delta's early stop. `page`/`per_page` rather than `--paginate`, for the reason
 *  {@link openPrsRestArgs} gives. */
export function boardPrsRestArgs(owner: string, repo: string, state: "open" | "closed", page: number, perPage: number): string[] {
  return ["api", `repos/${owner}/${repo}/pulls?state=${state}&sort=updated&direction=desc&per_page=${perPage}&page=${page}`];
}

/** One board row — structurally what `gh pr list --json number,url,state,headRefName,body,
 *  autoMergeRequest,title` produced, plus the `updatedAt` the delta stops on. */
export interface BoardPrRest {
  number: number;
  url: string;
  /** UPPERCASE "OPEN" | "CLOSED" | "MERGED", via {@link prStateFromRest}. */
  state: string;
  headRefName: string;
  /** REST's current `head.sha`; empty only when GitHub omitted it from a malformed/legacy row. */
  headRefOid: string;
  body: string;
  autoMergeRequest: unknown;
  title: string;
  /** REST's `updated_at`. Not rendered — the delta's stop key. */
  updatedAt: string;
}

/** Translate one REST pull row to the board's row shape. Everything except `state` and `title` comes
 *  from {@link mapRestPr}, so its four load-bearing translations hold by construction. Two more: `state`
 *  runs through {@link prStateFromRest}, never `state.toUpperCase()`, because the index does
 *  `all.filter((p) => p.state === "MERGED")` to build `mergedNewestFirst` and a plain uppercase would
 *  match nothing; and `title` normalises absent to `""`. */
export function mapBoardPr(row: RestPullRow): BoardPrRest {
  const base = mapRestPr(row);
  return {
    number: base.number,
    url: base.url,
    state: prStateFromRest(row),
    headRefName: base.headRefName,
    headRefOid: base.headRefOid,
    body: base.body,
    autoMergeRequest: base.autoMergeRequest,
    title: row.title ?? "",
    updatedAt: base.updatedAt,
  };
}

/** Cold pass page size — 687 PRs is 7 requests. */
const BOARD_FULL_PAGE_SIZE = 100;
/** Delta page size. Smaller because a steady-state refresh only has to reach the first unchanged row
 *  it already holds — row 1 or 2 in practice, where a 100-row page moves ~2.2 MB to learn nothing
 *  happened. Page size must be constant within a run, so a second delta page pays 30 again. */
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
  /** Which halves this call actually walked — see {@link BoardFetchHalf}. */
  half: BoardFetchHalf;
}

/** Which half of the board a fetch walks (W1-T2323). `"both"` is the default and is byte for byte the
 *  walk this function always performed. The halves are separable because they cost wildly different
 *  amounts and have different consumers: the open pass is 1 page against the cold closed pass's 25,
 *  and `listOpenHeadBranches` (lib/status.ts) paid all 26 for the one it used.
 *
 *  Invariant: splitting the call does not split the index. The closed half is still built, still
 *  walked with the same stop test, still shared by the merged-credit readers (W1-T377). What moves is
 *  when each half is fetched, never whether. */
export type BoardFetchHalf = "both" | "open" | "closed";

/** Every PR in the repo, over REST, re-reading only what can have changed.
 *
 *  Two halves, by mutability. Hot: every open PR, re-read unconditionally, because they are the only
 *  rows whose rendered fields can still move — and unconditionally so it never depends on GitHub
 *  bumping `updated_at`, which matters most for `auto_merge`. Cold: closed and merged PRs, walked
 *  newest-updated-first, stopped at the first row already held with an identical `updated_at`.
 *
 *  Invariant: sorted `updated_at` descending, so every changed row sorts strictly above every
 *  unchanged one and rows never reached keep their cached values. Throws on a failed page without
 *  mutating the cache — swallowing would report "the repo has zero PRs" (W1-T181). */
export function fetchBoardPrsRest(
  owner: string,
  repo: string,
  fetch: GhApiFetcher,
  known?: ReadonlyMap<number, BoardPrRest>,
  half: BoardFetchHalf = "both",
): BoardFetchResult {
  const mode: "full" | "delta" = known && known.size > 0 ? "delta" : "full";
  const perPage = mode === "delta" ? BOARD_DELTA_PAGE_SIZE : BOARD_FULL_PAGE_SIZE;
  // W1-T2323: seeded from `known` as before. For `"open"` the caller passes no `known`, because
  // seeding a complete read of a small set would resurrect a since-merged PR as permanently open.
  const out = new Map<number, BoardPrRest>(known ?? []);
  let calls = 0;
  let truncated = false;
  const wantOpen = half !== "closed";
  const wantClosed = half !== "open";

  // Hot half. Paginated rather than assuming one page: a repo holding >100 open PRs must not
  // silently drop the tail.
  for (let page = 1; wantOpen && page <= BOARD_MAX_PAGES; page += 1) {
    const rows = fetch(boardPrsRestArgs(owner, repo, "open", page, perPage)) as RestPullRow[];
    calls += 1;
    for (const row of rows) {
      const pr = mapBoardPr(row);
      out.set(pr.number, pr);
    }
    if (rows.length < perPage) break;
    if (page === BOARD_MAX_PAGES) truncated = true;
  }

  // Cold half. The short-circuit is unchanged by W1-T2323: on a cold index `known` is empty, so the
  // walk runs to a short page — which is why a cold closed pass is 25 pages and not 2.
  // Why: what the split changed is who pays that, never whether — docs/forensics/open-prs-rest.md.
  for (let page = 1; wantClosed && page <= BOARD_MAX_PAGES; page += 1) {
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

  return { rows: [...out.values()], calls, mode, truncated, half };
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * The labelled-issue delta (W1-T2222) — the board gateway's other re-read, reusing the stop test
 * {@link fetchBoardPrsRest}'s cold half already proves rather than a second mechanism.
 *
 * `fetchAllIssues` (lib/status.ts) re-read the whole `needs-human` label set on every TTL refresh,
 * because its call carried no `known` and no `updated_at` comparison. `--paginate` cannot be interrupted
 * mid-walk, so this walks explicit `page`/`per_page` requests, as {@link boardPrsRestArgs} does. One
 * walk, not two halves: an issue has no field that can move without bumping `updated_at`, so there is
 * no `auto_merge`-shaped reason to carve out an open half (docs/forensics/open-prs-rest.md).
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * One page of the board's labelled-issue walk argv — the issue counterpart of
 * {@link boardPrsRestArgs}: same `page`/`per_page` reasoning, same load-bearing
 * `sort=updated&direction=desc`, the entire basis of the delta's early stop below.
 */
export function boardIssuesRestArgs(owner: string, repo: string, label: string, page: number, perPage: number): string[] {
  return [
    "api",
    `repos/${owner}/${repo}/issues?labels=${encodeURIComponent(label)}&state=all&sort=updated&direction=desc&per_page=${perPage}&page=${page}`,
  ];
}

/** The wire shape GitHub's REST `/issues` endpoint returns. Carries `pull_request`, because that
 *  endpoint answers PRs too and they are dropped below, and `updated_at`, the delta's stop key. */
interface RestIssueRow {
  number: number;
  html_url: string;
  state: string;
  title?: string;
  updated_at: string;
  pull_request?: unknown;
}

/** One board-issue row — {@link BatchedIssue}'s shape plus the `updatedAt` the delta stops on. */
export interface BoardIssueRest {
  number: number;
  url: string;
  state: string;
  title?: string;
  /** REST's `updated_at`. Not rendered — the delta's stop key. */
  updatedAt: string;
}

function mapBoardIssue(row: RestIssueRow): BoardIssueRest {
  return { number: row.number, url: row.html_url, state: row.state, title: row.title, updatedAt: row.updated_at };
}

/** Cold pass page size for issues — the label-scoped set measures ~523-524 rows (MEASURED
 *  2026-08-24), so 100/page is ~6 requests on a cold cache. */
const BOARD_ISSUE_FULL_PAGE_SIZE = 100;
/** Delta page size, same reasoning as {@link BOARD_DELTA_PAGE_SIZE}: a steady-state refresh only
 *  has to reach the first row it already holds unchanged, which in practice is row 1. */
const BOARD_ISSUE_DELTA_PAGE_SIZE = 30;

/** What a labelled-issue fetch cost, for the ledger — {@link BoardFetchResult}'s shape, restated
 *  because the two walks are independent reads over independent row types. */
export interface BoardIssueFetchResult {
  rows: BoardIssueRest[];
  /** REST requests issued. Steady state is 1. */
  calls: number;
  mode: "full" | "delta";
  /** True if {@link BOARD_MAX_PAGES} stopped the walk — a truncated view, never silent. */
  truncated: boolean;
}

/** Every issue carrying `label`, over REST, re-reading only what can have changed since the last
 *  successful call — the issue counterpart of {@link fetchBoardPrsRest}, reusing its stop test
 *  (W1-T2222). Invariant: sorted `updated_at` descending, so the first row matching `known` means
 *  every row below it, open or closed, is unchanged. Throws on a failed page without mutating the
 *  caller's cache, the same W1-T181 discipline. */
export function fetchLabelledIssuesRest(
  owner: string,
  repo: string,
  label: string,
  fetch: GhApiFetcher,
  known?: ReadonlyMap<number, BoardIssueRest>,
): BoardIssueFetchResult {
  const mode: "full" | "delta" = known && known.size > 0 ? "delta" : "full";
  const perPage = mode === "delta" ? BOARD_ISSUE_DELTA_PAGE_SIZE : BOARD_ISSUE_FULL_PAGE_SIZE;
  const out = new Map<number, BoardIssueRest>(known ?? []);
  let calls = 0;
  let truncated = false;

  for (let page = 1; page <= BOARD_MAX_PAGES; page += 1) {
    const rawRows = fetch(boardIssuesRestArgs(owner, repo, label, page, perPage)) as RestIssueRow[];
    calls += 1;
    let reachedKnown = false;
    for (const row of rawRows) {
      if (row.pull_request !== undefined) continue; // the /issues endpoint answers PRs too.
      // `!== undefined` on both sides, not a bare `===`: an entry genuinely absent from `known` and
      // a row missing `updated_at` must never compare equal just because both read `undefined`,
      // which would mark a never-seen row "already known" on the first walk.
      const cachedUpdatedAt = known?.get(row.number)?.updatedAt;
      if (cachedUpdatedAt !== undefined && cachedUpdatedAt === row.updated_at) {
        reachedKnown = true;
        break;
      }
      out.set(row.number, mapBoardIssue(row));
    }
    // `rawRows.length`, not the post-filter issue count: `per_page` counts issues and pull requests
    // alike, so a page mixing PRs in can hold fewer issues and still be full.
    if (reachedKnown || rawRows.length < perPage) break;
    if (page === BOARD_MAX_PAGES) truncated = true;
  }

  return { rows: [...out.values()], calls, mode, truncated };
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * Merge-state hydration — the third instance of the single-PR-only field class.
 *
 * `mergeable` and `mergeable_state` are single-PR-only, and the list endpoint omits them exactly as it
 * omits `merged`. So `OpenPrView.mergeState` was always `undefined` after the REST migration, the
 * sweep's two `mergeState === "dirty"` rows were unreachable, and a conflicted PR fell through to the
 * mergeable catch-all — the same defect shape as #1017, same endpoint, same omission list. The per-PR
 * fetch is affordable by measurement, not assumption: a per-sweep median of 1 PR and a p95 of 6, with
 * {@link MERGE_STATE_HYDRATION_CAP} bounding the pathological case. Why: PR #1074's five wrong
 * dispositions and the 5,735-sweep census — docs/forensics/open-prs-rest.md.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/** Hard ceiling on per-PR merge-state fetches in one sweep pass. Above it the remaining PRs keep
 *  `mergeState: undefined` and disposition exactly as before — the honest degradation, since unknown
 *  was the status quo for every PR until now. 25 sits just above the observed maximum, 23. */
export const MERGE_STATE_HYDRATION_CAP = 25;

/** GitHub's raw `mergeable_state`, narrowed to the sweep's {@link MergeState} vocabulary.
 *
 *  Trap: three states, not two. GitHub computes mergeability asynchronously, and a PR here has sat
 *  `unknown` across five consecutive polls.
 *    "dirty"                    -> "dirty"    a definite, observed conflict; act on it.
 *    "clean" | "unstable" | …   -> "clean"    definitely not conflicted.
 *    "unknown" | absent | error -> undefined  not yet known; left in the catch-all.
 *
 *  Invariant: unknown maps to `undefined`, never a {@link MergeState} — "dirty" would escalate healthy
 *  PRs whenever GitHub was slow, "clean" would assert something unobserved. The failure mode stays
 *  "no improvement", never "wrong answer". */
export function mergeStateFromRest(row: { mergeable_state?: string | null; mergeable?: boolean | null }): MergeState | undefined {
  const raw = typeof row.mergeable_state === "string" ? row.mergeable_state.toLowerCase() : undefined;
  if (raw === "dirty") return "dirty";
  if (raw === undefined || raw === "unknown") return undefined;
  // Every other documented value ("clean", "blocked", "behind", "unstable", "draft", "has_hooks")
  // means GitHub COULD compute mergeability and did not find a conflict. `behind` is deliberately
  // NOT surfaced as its own state here — see MergeState's doc: it is out of scope for the sweep.
  return "clean";
}

/** Fetch `mergeable_state` for up to {@link MERGE_STATE_HYDRATION_CAP} PRs, as a map from PR number to
 *  the narrowed state; absent means not known. Invariant: best-effort per PR — a throw (rate limit, a
 *  404 on a PR closed mid-pass, a network blip) skips that PR, because a degraded disposition beats a
 *  sweep that dispositions nothing. Exhausted, the map comes back empty and nothing changes. */
export function hydrateMergeStates(
  owner: string,
  repo: string,
  prNumbers: readonly number[],
  fetch: GhApiFetcher,
  cap: number = MERGE_STATE_HYDRATION_CAP,
): Map<number, MergeState> {
  const out = new Map<number, MergeState>();
  for (const n of prNumbers.slice(0, cap)) {
    try {
      const row = fetch(singlePrRestArgs(owner, repo, n)) as { mergeable_state?: string | null; mergeable?: boolean | null };
      const state = mergeStateFromRest(row);
      if (state !== undefined) out.set(n, state);
    } catch {
      /* best-effort: this PR keeps the pre-existing undefined, the pass continues */
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * Workflow run observations (W1-T2340) — the producer for `OpenPrView.workflowRuns`.
 *
 * `stalledRunReason` (lib/sweep.ts) joins a run's own conclusion against its jobs' statuses: a job left
 * non-terminal inside an already-concluded run will never move, because a terminal run schedules
 * nothing further. The rollup cannot answer that — it is check-runs, and such a run contributes entries
 * that merely look pending. A `KNOWN_UNWIRED` entry was refused because `stalledRunReason(undefined)`
 * returns `undefined`, so it would ship a detector that never fires. The cost bound is read off the
 * predicate, never picked: across PRs, only heads whose `checksState` reads `pending`; within a PR,
 * jobs only for runs already concluded. Cadence, not volume, is what bites, so this adds no loop and
 * no wait of its own (docs/forensics/open-prs-rest.md).
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/** Hard ceiling on the PRs this hydrates in one sweep pass. Above it the rest keep
 *  `workflowRuns: undefined` and disposition exactly as before. Reuses
 *  {@link MERGE_STATE_HYDRATION_CAP}'s value rather than a second ceiling.
 *
 *  KIND: BACKSTOP (test/bound-kind-declared.test.ts) — sized to sit ABOVE the population it bounds
 *  rather than to shape it: 25 against an all-time observed maximum of 23 open PRs, over the same
 *  population in the same pass, so reaching it would mean that count had left every observed range. */
export const WORKFLOW_RUN_HYDRATION_CAP = MERGE_STATE_HYDRATION_CAP;

/** `gh api` argv listing the workflow runs for ONE head sha. */
export function runsForHeadRestArgs(owner: string, repo: string, headSha: string): string[] {
  return ["api", `repos/${owner}/${repo}/actions/runs?head_sha=${headSha}&per_page=100`];
}

/** `gh api` argv listing the jobs of ONE workflow run. The runs listing does NOT carry jobs, so
 *  this second call is required for any run the predicate could fire on. */
export function jobsForRunRestArgs(owner: string, repo: string, runId: number): string[] {
  return ["api", `repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`];
}

/** True when a run's conclusion is populated — GitHub sets it only once the run itself concluded.
 *  The SAME first clause {@link "./sweep.js".stalledRunReason} tests, kept here so the fetch scope
 *  and the predicate cannot drift apart. */
function runHasConcluded(conclusion: unknown): boolean {
  return typeof conclusion === "string" && conclusion.trim() !== "";
}

/** Observations for one head: every workflow run on it, with jobs attached to the runs that have
 *  already concluded. A run still in progress is reported without jobs, since the predicate cannot
 *  fire on it. Throws only if the run listing itself fails; a per-run jobs failure leaves that run's
 *  `jobs` `undefined`, which reads as "could not check", never "GitHub scheduled nothing". */
export function fetchWorkflowRunObservations(
  owner: string,
  repo: string,
  headSha: string,
  fetch: GhApiFetcher,
): WorkflowRunObservation[] {
  const listing = fetch(runsForHeadRestArgs(owner, repo, headSha)) as {
    workflow_runs?: ReadonlyArray<{ id?: number; conclusion?: string | null }>;
  };
  const runs = listing?.workflow_runs ?? [];
  const out: WorkflowRunObservation[] = [];
  for (const run of runs) {
    const conclusion = typeof run.conclusion === "string" ? run.conclusion : undefined;
    if (!runHasConcluded(conclusion) || typeof run.id !== "number") {
      out.push({ conclusion });
      continue;
    }
    let jobs: ReadonlyArray<{ status?: string }> | undefined;
    try {
      const j = fetch(jobsForRunRestArgs(owner, repo, run.id)) as {
        jobs?: ReadonlyArray<{ status?: string | null }>;
      };
      jobs = (j?.jobs ?? []).map((x) => ({ status: typeof x.status === "string" ? x.status : undefined }));
    } catch {
      /* leave `jobs` undefined: "could not check", never "nothing was scheduled" */
    }
    out.push({ conclusion, jobs });
  }
  return out;
}

/** Run observations for up to {@link WORKFLOW_RUN_HYDRATION_CAP} heads, as a map from PR number to
 *  its observations; absent means the caller leaves `workflowRuns` `undefined`. Best-effort per PR,
 *  the discipline {@link hydrateMergeStates} uses. Callers pass only pending-check PRs. */
export function hydrateWorkflowRuns(
  owner: string,
  repo: string,
  pendingPrs: readonly { number: number; headRefOid: string }[],
  fetch: GhApiFetcher,
  cap: number = WORKFLOW_RUN_HYDRATION_CAP,
): Map<number, readonly WorkflowRunObservation[]> {
  const out = new Map<number, readonly WorkflowRunObservation[]>();
  for (const p of pendingPrs.slice(0, cap)) {
    try {
      out.set(p.number, fetchWorkflowRunObservations(owner, repo, p.headRefOid, fetch));
    } catch {
      /* best-effort: this PR keeps the pre-existing undefined workflowRuns, the pass continues */
    }
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * Conflict evidence (W1-T984) — the `mergeConflict` producer `OpenPrView` (lib/sweep.ts) has lacked
 * since W1-T106 declared the field. `isPureConcurrentAddition` opens with `files.length > 0`, so an
 * absent list already fails closed to escalation rather than a wrong auto-resolution — but every
 * escalation then read "files: none captured", because nothing populated it with real paths. The shape
 * mirrors {@link hydrateMergeStates}: fetch only for a PR already known `mergeState === "dirty"`, reuse
 * {@link MERGE_STATE_HYDRATION_CAP}, best-effort per PR. Nothing in the sweep path shells to git, so
 * the evidence is GitHub's compare API — the merge base plus this PR's side, then that base to the
 * target branch.
 *
 * Invariant: only a path present in BOTH responses becomes a {@link ConflictFileDiff}, and REST's
 * "touched since merge base" is broader than "git would conflict here". The set is a superset of
 * git's, which makes {@link isPureConcurrentAddition} stricter and never looser: it cannot manufacture
 * a false true from a genuine deletion. A later reader must not narrow it to an exact git-conflict set
 * without re-deriving that argument.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/** The compare argv — GitHub's own merge-base-relative diff, never a raw two-tip diff. */
export function compareRestArgs(owner: string, repo: string, base: string, head: string): string[] {
  return ["api", `repos/${owner}/${repo}/compare/${base}...${head}`];
}

/** One file entry in a compare response — the wire shape, never {@link ConflictFileDiff}. */
interface RestCompareFile {
  filename?: string;
  deletions?: number;
}

/** One commit entry in a compare response — enough to build a `git log`-shaped one-liner. */
interface RestCompareCommit {
  sha?: string;
  commit?: { message?: string };
}

/** The compare endpoint's response, narrowed to what this producer reads. */
interface RestCompareResponse {
  merge_base_commit?: { sha?: string };
  files?: RestCompareFile[];
  commits?: RestCompareCommit[];
}

/** One repository content response. Directories/arrays are refused by shape. */
interface RestContentResponse {
  content?: string;
  encoding?: string;
}

/** The contents endpoint argv for one path at one ref, preserving path separators. */
export function contentRestArgs(owner: string, repo: string, path: string, ref: string): string[] {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return ["api", `repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`];
}

/**
 * `git log <since>..<until>`'s one-line-per-commit shape ({@link MergeConflictEvidence.oursLog}'s
 * own doc), built from a compare response's `commits[]` rather than shelling to git — REST already
 * carries the SHA and message, so no second fetch is needed.
 */
function logFromCompareCommits(commits: RestCompareCommit[] | undefined): string {
  return (commits ?? []).map((c) => `${(c.sha ?? "").slice(0, 7)} ${(c.commit?.message ?? "").split("\n")[0]}`).join("\n");
}

function contentBytes(owner: string, repo: string, path: string, ref: string, fetch: GhApiFetcher): Buffer {
  const raw = fetch(contentRestArgs(owner, repo, path, ref)) as RestContentResponse;
  if (raw.encoding !== "base64" || typeof raw.content !== "string") {
    throw new Error(`content response for ${path}@${ref} was not a base64 file`);
  }
  return Buffer.from(raw.content.replace(/\s/g, ""), "base64");
}

const REDUNDANT_REFIX_COMPARE_PATH_CAP = 25;

function redundantRefixEvidence(
  owner: string,
  repo: string,
  targetBranch: string,
  headRefOid: string,
  files: readonly ConflictFileDiff[],
  fetch: GhApiFetcher,
): RedundantRefixEvidence | undefined {
  if (files.length === 0 || files.length > REDUNDANT_REFIX_COMPARE_PATH_CAP) return undefined;
  try {
    const comparedPaths: string[] = [];
    const differingPaths: string[] = [];
    for (const file of files) {
      const target = contentBytes(owner, repo, file.path, targetBranch, fetch);
      const head = contentBytes(owner, repo, file.path, headRefOid, fetch);
      comparedPaths.push(file.path);
      if (!target.equals(head)) differingPaths.push(file.path);
    }
    return differingPaths.length === 0
      ? { compared: "bytes", verdict: "main-byte-identical", comparedPaths }
      : { compared: "bytes", verdict: "different-from-main", comparedPaths, differingPaths };
  } catch {
    /* best-effort: content bytes were unreadable, so redundant evidence stays absent. */
    return undefined;
  }
}

/**
 * One PR's conflict evidence, over REST — the {@link MergeConflictEvidence} producer W1-T984
 * wires. Throws on a failed/malformed read (no retry, same discipline as {@link rollupFor}); the
 * caller ({@link hydrateMergeConflictEvidence}) catches it per PR.
 */
export function fetchMergeConflictEvidence(
  owner: string,
  repo: string,
  targetBranch: string,
  headRefOid: string,
  fetch: GhApiFetcher,
): MergeConflictEvidence {
  const ours = fetch(compareRestArgs(owner, repo, targetBranch, headRefOid)) as RestCompareResponse;
  const mergeBaseSha = ours.merge_base_commit?.sha;
  if (!mergeBaseSha) throw new Error("conflict evidence compare carried no merge_base_commit.sha");
  const theirs = fetch(compareRestArgs(owner, repo, mergeBaseSha, targetBranch)) as RestCompareResponse;

  const oursDeletions = new Map((ours.files ?? []).filter((f) => f.filename).map((f) => [f.filename as string, f.deletions ?? 0]));
  const theirsDeletions = new Map((theirs.files ?? []).filter((f) => f.filename).map((f) => [f.filename as string, f.deletions ?? 0]));
  const files: ConflictFileDiff[] = [];
  for (const [path, oursDeleted] of oursDeletions) {
    const theirsDeleted = theirsDeletions.get(path);
    // INTERSECTION ONLY — see this section's own header doc for why a path touched on just one
    // side is never a candidate git could actually conflict on.
    if (theirsDeleted === undefined) continue;
    files.push({ path, oursDeleted, theirsDeleted });
  }

  return {
    files,
    oursLog: logFromCompareCommits(ours.commits),
    theirsLog: logFromCompareCommits(theirs.commits),
    redundantRefix: redundantRefixEvidence(owner, repo, targetBranch, headRefOid, files, fetch),
  };
}

/** `gh api` argv listing ONE pull request's changed files. */
export function prFilesRestArgs(owner: string, repo: string, prNumber: number): string[] {
  return ["api", `repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`];
}

/** One `/pulls/N/files` row, loosely typed — every field optional, because this reads another
 *  service's payload and a missing key must degrade rather than throw. */
interface RestPrFile {
  filename?: string;
  additions?: number;
  deletions?: number;
}

/** BACKSTOP: GitHub serves at most 100 files on the single page this bounded reader requests. */
export const PLAN_FILING_FILE_RESPONSE_CAP = 100;
/** BACKSTOP: retained complete observations stay far above the measured open-PR population. */
export const PLAN_FILING_FILE_CACHE_MAX_ENTRIES = 256;

export interface PlanFilingFileCandidate {
  number: number;
  headRefOid: string;
}

export type PlanFilingFileObservation =
  | { state: "complete"; paths: readonly string[]; cache: "hit" | "miss" }
  | {
      state: "unreadable";
      reason: "per-pass-cap" | "fetch-failed" | "malformed" | "empty" | "response-cap";
    };

/** Process-lifetime state is owned by the caller, so one daemon shares it while tests stay isolated. */
export interface PlanFilingFileCache {
  entries: Map<string, readonly string[]>;
  missCursors: Map<string, string>;
}

export function createPlanFilingFileCache(): PlanFilingFileCache {
  return { entries: new Map(), missCursors: new Map() };
}

function planFilingFileCacheKey(owner: string, repo: string, candidate: PlanFilingFileCandidate): string {
  return `${owner}/${repo}#${candidate.number}@${candidate.headRefOid}`;
}

function rememberPlanFilingFiles(
  cache: PlanFilingFileCache,
  key: string,
  paths: readonly string[],
  maxEntries: number,
): void {
  const prPrefix = key.slice(0, key.lastIndexOf("@") + 1);
  for (const prior of cache.entries.keys()) {
    if (prior.startsWith(prPrefix) && prior !== key) cache.entries.delete(prior);
  }
  cache.entries.delete(key);
  cache.entries.set(key, [...paths]);
  while (cache.entries.size > Math.max(0, maxEntries)) {
    const oldest = cache.entries.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.entries.delete(oldest);
  }
}

function rememberPlanFilingMissCursor(
  cache: PlanFilingFileCache,
  repositoryKey: string,
  candidateKey: string,
  maxEntries: number,
): void {
  cache.missCursors.delete(repositoryKey);
  cache.missCursors.set(repositoryKey, candidateKey);
  while (cache.missCursors.size > Math.max(0, maxEntries)) {
    const oldest = cache.missCursors.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.missCursors.delete(oldest);
  }
}

/**
 * Read a bounded set of actual PR file lists. Complete positive and negative observations are
 * cached by repository, PR and head SHA; failures and capped misses remain unknown and are never
 * promoted to a plan-filing fact. A cache hit costs none of this pass's miss budget.
 */
export function hydratePlanFilingFiles(
  owner: string,
  repo: string,
  candidates: readonly PlanFilingFileCandidate[],
  fetch: GhApiFetcher,
  cache: PlanFilingFileCache,
  opts: { missCap: number; maxEntries?: number },
): Map<number, PlanFilingFileObservation> {
  const out = new Map<number, PlanFilingFileObservation>();
  const missCap = Math.max(0, Math.floor(opts.missCap));
  const maxEntries = opts.maxEntries ?? PLAN_FILING_FILE_CACHE_MAX_ENTRIES;
  const uncached: Array<{ candidate: PlanFilingFileCandidate; key: string }> = [];
  let misses = 0;

  for (const candidate of candidates) {
    const key = planFilingFileCacheKey(owner, repo, candidate);
    const cached = cache.entries.get(key);
    if (cached !== undefined) {
      cache.entries.delete(key);
      cache.entries.set(key, cached);
      out.set(candidate.number, { state: "complete", paths: [...cached], cache: "hit" });
      continue;
    }
    uncached.push({ candidate, key });
  }

  const repositoryKey = `${owner}/${repo}`;
  const cursor = cache.missCursors.get(repositoryKey);
  const cursorIndex = cursor === undefined ? -1 : uncached.findIndex(({ key }) => key === cursor);
  const startIndex = cursorIndex < 0 ? 0 : (cursorIndex + 1) % Math.max(1, uncached.length);
  const rotated = uncached.map((_, offset) => uncached[(startIndex + offset) % uncached.length]);
  for (const { candidate, key } of rotated) {
    if (misses >= missCap) {
      out.set(candidate.number, { state: "unreadable", reason: "per-pass-cap" });
      continue;
    }
    misses++;
    rememberPlanFilingMissCursor(cache, repositoryKey, key, maxEntries);

    let raw: unknown;
    try {
      raw = fetch(prFilesRestArgs(owner, repo, candidate.number));
    } catch {
      out.set(candidate.number, { state: "unreadable", reason: "fetch-failed" });
      continue;
    }
    if (!Array.isArray(raw)) {
      out.set(candidate.number, { state: "unreadable", reason: "malformed" });
      continue;
    }
    if (raw.length === 0) {
      out.set(candidate.number, { state: "unreadable", reason: "empty" });
      continue;
    }
    if (raw.length >= PLAN_FILING_FILE_RESPONSE_CAP) {
      out.set(candidate.number, { state: "unreadable", reason: "response-cap" });
      continue;
    }
    const paths: string[] = [];
    let malformed = false;
    for (const value of raw) {
      const filename = value && typeof value === "object" ? (value as RestPrFile).filename : undefined;
      if (
        typeof filename !== "string" ||
        filename.length === 0 ||
        filename.length > 1_024 ||
        /[\0\r\n]/.test(filename)
      ) {
        malformed = true;
        break;
      }
      paths.push(filename);
    }
    if (malformed) {
      out.set(candidate.number, { state: "unreadable", reason: "malformed" });
      continue;
    }
    rememberPlanFilingFiles(cache, key, paths, maxEntries);
    out.set(candidate.number, { state: "complete", paths, cache: "miss" });
  }
  return out;
}

/** One open PR's supersession verdict, over REST — the producer {@link SupersessionVerdict} has never
 *  had (W1-T2384). W1-T920 declared the field and the gated row, then deferred the detector to "a
 *  separate shard" that was never filed.
 *
 *  Both PRs' changed-file lists, compared by path. `rawLineCount` is every added and deleted line
 *  observed before any matching, so a read that saw nothing is indeterminate, never "unique".
 *  Outcomes: one side wholly in plan scope while the other holds non-plan work is "complementary"
 *  (W1-T2779); every path also touched by the superseding PR is "superseded"; no shared path is
 *  "unique"; a partial overlap or an empty control is "indeterminate". */
export function fetchSupersessionVerdict(
  owner: string,
  repo: string,
  prNumber: number,
  supersedingPrNumber: number,
  taskId: string,
  fetch: GhApiFetcher,
  isPlanPath: PlanPathPredicate,
): SupersessionVerdict {
  const ours = fetch(prFilesRestArgs(owner, repo, prNumber)) as RestPrFile[];
  const theirs = fetch(prFilesRestArgs(owner, repo, supersedingPrNumber)) as RestPrFile[];
  if (!Array.isArray(ours) || !Array.isArray(theirs)) throw new Error("supersession read carried no file list");

  const ourPaths = ours.map((f) => f.filename).filter((f): f is string => typeof f === "string" && f.length > 0);
  const theirPaths = new Set(theirs.map((f) => f.filename).filter((f): f is string => typeof f === "string" && f.length > 0));
  const rawLineCount = ours.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0);
  const theirRawLineCount = theirs.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0);
  const matchedHunks = ourPaths.filter((f) => theirPaths.has(f)).length;
  const diff = { rawLineCount, matchedHunks };

  // THE CONTROL FIRST. An empty corpus cannot support either finding — see this function's own doc.
  if (ourPaths.length === 0 || rawLineCount === 0 || theirPaths.size === 0 || theirRawLineCount === 0) {
    const emptyPrNumber = ourPaths.length === 0 || rawLineCount === 0 ? prNumber : supersedingPrNumber;
    return { status: "indeterminate", detail: `the diff read for #${emptyPrNumber} observed no changed lines — no finding is supportable`, diff } as SupersessionVerdict;
  }

  // W1-T2779: a plan filing and an implementation are complementary, never duplicates. A positive
  // result over both fetched corpora, not an inference from title, branch or task id: exactly one
  // side must be wholly plan scope. Two filings, or two implementations, fall through unchanged.
  const oursPlanOnly = ourPaths.every(isPlanPath);
  const theirPathList = [...theirPaths];
  const theirsPlanOnly = theirPathList.every(isPlanPath);
  if (oursPlanOnly !== theirsPlanOnly) {
    const planIsOurs = oursPlanOnly;
    const planPaths = planIsOurs ? ourPaths : theirPathList;
    const implementationPaths = planIsOurs ? theirPathList : ourPaths;
    return {
      status: "complementary",
      complement: {
        planPrNumber: planIsOurs ? prNumber : supersedingPrNumber,
        implementationPrNumber: planIsOurs ? supersedingPrNumber : prNumber,
        taskId,
        planPathCount: planPaths.length,
        implementationPathCount: implementationPaths.length,
      },
      detail:
        `#${planIsOurs ? prNumber : supersedingPrNumber} is plan-only while ` +
        `#${planIsOurs ? supersedingPrNumber : prNumber} contains non-plan work — complementary stages of ${taskId}`,
      diff,
    };
  }
  if (matchedHunks === ourPaths.length) {
    return {
      status: "superseded",
      evidence: { supersedingPrNumber, taskId, diff },
      detail: `every one of #${prNumber}'s ${ourPaths.length} changed path(s) is also changed by #${supersedingPrNumber}`,
    };
  }
  if (matchedHunks === 0) {
    return { status: "unique", detail: `none of #${prNumber}'s ${ourPaths.length} changed path(s) is touched by #${supersedingPrNumber}` };
  }
  return {
    status: "indeterminate",
    detail: `#${prNumber} shares ${matchedHunks} of ${ourPaths.length} changed path(s) with #${supersedingPrNumber} — a partial overlap supports neither finding`,
  };
}

/** Every supersession verdict for a bounded set, mirroring {@link hydrateMergeConflictEvidence} in
 *  shape, cap and failure direction (W1-T2384). Scoped the way its sibling is: only PRs the arithmetic
 *  already flagged — `supersededBy != null`, a higher-numbered open PR crediting the same task, a set
 *  measured in single digits. Best-effort per PR: a throw leaves `supersessionVerdict` `undefined`. */
export function hydrateSupersessionVerdicts(
  owner: string,
  repo: string,
  supersededPrs: readonly { number: number; supersededBy: number; taskId: string }[],
  fetch: GhApiFetcher,
  isPlanPath: PlanPathPredicate,
  cap: number = MERGE_STATE_HYDRATION_CAP,
): Map<number, SupersessionVerdict> {
  const out = new Map<number, SupersessionVerdict>();
  for (const p of supersededPrs.slice(0, cap)) {
    try {
      out.set(p.number, fetchSupersessionVerdict(owner, repo, p.number, p.supersededBy, p.taskId, fetch, isPlanPath));
    } catch {
      /* best-effort: this PR keeps the pre-existing undefined supersessionVerdict, the pass continues */
    }
  }
  return out;
}

/** Conflict evidence for up to {@link MERGE_STATE_HYDRATION_CAP} already-`dirty` PRs, as a map from PR
 *  number to {@link MergeConflictEvidence}; absent means the caller leaves `mergeConflict` `undefined`.
 *  Best-effort per PR, the discipline {@link hydrateMergeStates} uses: a throw (a rate limit, a 404 on
 *  a PR closed mid-pass, an unresolvable merge-base compare) skips that PR. Callers pass only PRs
 *  already confirmed dirty — six over a measured 7-day window, so the cap is headroom. */
export function hydrateMergeConflictEvidence(
  owner: string,
  repo: string,
  targetBranch: string,
  dirtyPrs: readonly { number: number; headRefOid: string }[],
  fetch: GhApiFetcher,
  cap: number = MERGE_STATE_HYDRATION_CAP,
): Map<number, MergeConflictEvidence> {
  const out = new Map<number, MergeConflictEvidence>();
  for (const p of dirtyPrs.slice(0, cap)) {
    try {
      out.set(p.number, fetchMergeConflictEvidence(owner, repo, targetBranch, p.headRefOid, fetch));
    } catch {
      /* best-effort: this PR keeps the pre-existing undefined mergeConflict, the pass continues */
    }
  }
  return out;
}
