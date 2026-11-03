/**
 * Enumerate the sweep's open PRs over REST; never use GraphQL, including `gh --json`.
 * GraphQL exhaustion blinded the sweep despite a healthy core budget (PR #794, PR #796;
 * CLAUDE.md, "CI and merging"; docs/forensics/open-prs-rest.md).
 * Preserve values without retries, alarms, degraded modes or escalation; rollups cost 1 + 2N reads.
 */

import { createHash } from "node:crypto";
import { contributionOriginFromRest, type ContributionOrigin, type RestContributionOrigin } from "./contributor-admission.js";
import type { ConflictFileDiff, MergeConflictEvidence, MergeState, RedundantRefixEvidence } from "./merge-state.js";
import type { WorkflowRunJobObservation, WorkflowRunObservation } from "./workflow-run.js";
// W1-T2384: import from the leaf; even a type import from sweep.js closes a cycle. See supersession.ts.
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
  paceGhEntryAsync,
  type GhBudgetReading,
  type GhCallPacer,
  type GhRefusalBackoffOpts,
} from "./github-transport.js";

/** W1-T2779: run-task.ts injects isInPlanScope to avoid plan-architect dependency cycles. */
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

/** Injected `ghJson`: parse one `gh api` response without importing worker.ts (W1-T1008).
 *  Its optional rate-limit callback also permits offline fixtures. Keep the type between functions:
 *  V8 can mark leading/trailing type declarations `DA:<line>,0` in coverage. */
export type GhApiFetcher = (
  args: string[],
  onRateLimit?: (reading: { remaining?: number; limit?: number; resource?: string }) => void,
) => unknown;

/** Arm the floor only with a complete, finite reading; partial/zero-filled data can falsely stop calls. */
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

/** W1-T6591: git-push.ts's `Steps` (one set of reads, a sync and an async driver), restated to avoid an import cycle. */
export type GhReadSteps<R> = Generator<() => unknown, R, unknown>;

function* ghRead(read: GhApiFetcher, args: string[], onRateLimit?: Parameters<GhApiFetcher>[1]): GhReadSteps<unknown> {
  return yield () => (onRateLimit ? read(args, onRateLimit) : read(args));
}

export function runGhReadSteps<R>(steps: GhReadSteps<R>): R {
  let next = steps.next();
  while (!next.done) {
    let value: unknown;
    try {
      value = next.value();
    } catch (error) {
      next = steps.throw(error);
      continue;
    }
    next = steps.next(value);
  }
  return next.value;
}

/** Check-runs for a head SHA. GitHub can return multiple same-name runs on this endpoint,
 *  including runs whose start timestamps are identical. Consumers must select the latest id. */
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
  id?: number;
  external_id?: string | null;
  name?: string;
  output?: { title?: string | null } | null;
  /** "queued" | "in_progress" | "completed" — lowercase, where GraphQL reports "QUEUED" etc. */
  status?: string;
  /** "success" | "failure" | "neutral" | … — `null` while the run is still incomplete. */
  conclusion?: string | null;
  details_url?: string | null;
  /** W1-T2300 — ISO8601 start of this attempt, on every entry a live response carries. Mirrored to
   *  {@link RestRollupEntry.startedAt} by {@link rollupFromRest}. */
  started_at?: string | null;
  /** A terminal check run's completion time. Kept distinct from `started_at`: a run that began
   * before a main repair and completed after it is not stale evidence (W1-T3422). */
  completed_at?: string | null;
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
  /** GitHub supplies this only on status contexts. A terminal status's update, not its creation,
   * is the comparable completion time when it is present (W1-T3422). */
  updated_at?: string | null;
  /** The status's own one-line verdict; `security-merge-policy` publishes `<state>: <reason>` here. */
  description?: string | null;
}

/** GraphQL-shaped rollup, kept independent of sweep.ts to avoid a leading type import's coverage trap.
 *  test/open-prs-rest.test.ts passes rollupFromRest into checksStateFromRollup; tsc catches shape drift. */
export interface RestRollupEntry {
  name?: string;
  /** The posted refusing gate, distinct from a hosting bundle's check name. */
  title?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  checkRunId?: number;
  externalId?: string;
  workflowRunId?: number;
  workflowId?: number;
  jobId?: string;
  targetUrl?: string;
  /** W1-T2300: started_at/created_at from rollupFromRest; absent on malformed rows.
   *  dedupeRollupByLatestAttempt and staleCiGateTransition need it to distinguish attempts. */
  startedAt?: string;
  /** Terminal completion time, when GitHub supplied one. Absence stays absent: consumers that
   * need to prove a verdict predates a main repair must decline rather than substitute a start. */
  completedAt?: string;
  /** A status context's description, verbatim; check runs carry none. */
  description?: string;
}

/** Uppercase enums while preserving absence for the state ?? conclusion ?? status fallback.
 *  Mapping an incomplete run's null conclusion to "" would hide its queued status. */
function upper(v: string | null | undefined): string | undefined {
  return v == null || v === "" ? undefined : v.toUpperCase();
}

interface RestWorkflowRunIdentity { id?: number; workflow_id?: number }

function actionsIdentity(c: RestCheckRun): { runId?: number; jobId?: string } {
  const url = c.details_url?.match(/\/actions\/runs\/(\d+)\/job\/(\d+)/);
  const posted = c.external_id?.match(/^run:(\d+):\d+:job:(\d+)$/);
  const runId = Number(url?.[1] ?? posted?.[1]);
  return {
    ...(Number.isSafeInteger(runId) && runId > 0 ? { runId } : {}),
    jobId: url?.[2] ?? posted?.[2] ?? c.external_id?.match(/^job:(\d+)$/)?.[1],
  };
}

export function needsWorkflowIdentity(checkRuns: RestCheckRun[]): boolean {
  const seen = new Map<string, number>();
  for (const c of checkRuns) {
    const { runId } = actionsIdentity(c);
    if (runId === undefined) continue;
    const name = c.name ?? "";
    if (seen.has(name) && seen.get(name) !== runId) return true;
    seen.set(name, runId);
  }
  return false;
}

/** Compose statusCheckRollup from check runs AND commit statuses; /check-runs alone loses remudero-review.
 *  Ignore combined-status's top-level state: zero statuses reports "pending", but must stay "none".
 *  Only real statuses[] become entries; startedAt uses each shape's own key (W1-T2300). */
export function rollupFromRest(checkRuns: RestCheckRun[], statuses: RestStatus[], workflowRuns?: readonly RestWorkflowRunIdentity[]): RestRollupEntry[] {
  const workflows = new Map(workflowRuns?.map((r) => [r.id, r.workflow_id]));
  const fromRuns = checkRuns.map((c) => {
    const e: RestRollupEntry = { name: c.name ?? "" };
    if (typeof c.output?.title === "string" && c.output.title.trim() !== "") e.title = c.output.title;
    const status = upper(c.status);
    const conclusion = upper(c.conclusion);
    if (status !== undefined) e.status = status;
    if (conclusion !== undefined) e.conclusion = conclusion;
    if (c.details_url) e.detailsUrl = c.details_url;
    if (typeof c.id === "number" && Number.isSafeInteger(c.id) && c.id > 0) e.checkRunId = c.id;
    if (c.external_id) e.externalId = c.external_id;
    if (workflowRuns !== undefined || c.external_id?.startsWith("run:")) {
      const { runId, jobId } = actionsIdentity(c);
      if (runId !== undefined) e.workflowRunId = runId;
      if (jobId !== undefined) e.jobId = jobId;
      const workflowId = workflows.get(runId);
      if (typeof workflowId === "number") e.workflowId = workflowId;
    }
    if (c.started_at) e.startedAt = c.started_at;
    if (c.completed_at) e.completedAt = c.completed_at;
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
    if (s.updated_at) e.completedAt = s.updated_at;
    if (s.description) e.description = s.description;
    return e;
  });
  return [...fromRuns, ...fromStatuses];
}

/** One pull request as REST's `/pulls` endpoint returns it — the wire shape, never a consumer's. */
export interface RestPullRow extends RestContributionOrigin {
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
  head?: RestContributionOrigin["head"] & { ref?: string; sha?: string };
  /** `null` unless auto-merge is armed. Consumed ONLY as a nullity test. */
  auto_merge?: unknown;
  /** The PR title (W1-T184's RECENT decoration). Absent only on a malformed row. */
  title?: string;
  /** W1-T528: operator's draft hold, honored by selectUpdateBranchTarget (lib/sweep.ts).
   *  Both endpoints return it; malformed absence stays undefined, never false. */
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
  contributionOrigin?: ContributionOrigin;
  statusCheckRollup?: RestRollupEntry[];
  /** W1-T521: failed rollup fetch (budget, deleted head, network), distinct from observed empty.
   *  Sparse like status.ts's indeterminate; checksStateFromRollup treats absence as "none", never green. */
  rollupUnreadable?: true;
  /** W1-T528: draft hold passed to buildOpenPrViews as OpenPrView.isDraft; unknown stays undefined. */
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
  const contributionOrigin = contributionOriginFromRest(row);
  return {
    number: row.number,
    url: row.html_url,
    headRefName: row.head?.ref ?? "",
    headRefOid: row.head?.sha ?? "",
    updatedAt: row.updated_at,
    body: row.body ?? "",
    autoMergeRequest: row.auto_merge ?? null,
    ...(contributionOrigin === undefined ? {} : { contributionOrigin }),
    // W1-T528: omit unknown draft holds; defaulting to false would assert operator permission.
    ...(row.draft === undefined ? {} : { isDraft: row.draft }),
    // Same omitted-rather-than-defaulted discipline as `isDraft` directly above.
    ...(row.created_at === undefined ? {} : { createdAt: row.created_at }),
  };
}

/** Return terminalStateReason's uppercase state. Both endpoints carry merged_at; only single-PR
 *  carries merged. Ignoring merged_at mislabels merged list rows CLOSED; leaving open lowercase
 *  makes rmd fix refuse live PRs. Falsifier: test/open-prs-rest.test.ts's live-list fixtures.
 *  Record: dispatch runaway, docs/forensics/open-prs-rest.md (#1017, 2026-07-31). */
export function prStateFromRest(row: { state?: string; merged?: boolean; merged_at?: string | null }): string {
  if (row.merged === true || row.merged_at != null) return "MERGED";
  return (row.state ?? "").toUpperCase() || "UNKNOWN";
}

/** Shared REST rollup for orchestrators and pollToGate/waitForCiGreen (W1-T2268).
 *  Avoids repeated GraphQL reads while waiting; falsifier: test/poll-rollup-over-rest.test.ts. */
export function rollupFor(owner: string, repo: string, sha: string, fetch: GhApiFetcher): RestRollupEntry[] {
  return runGhReadSteps(rollupSteps(owner, repo, sha, fetch));
}

function* rollupSteps(owner: string, repo: string, sha: string, fetch: GhApiFetcher): GhReadSteps<RestRollupEntry[]> {
  const runs = (yield* ghRead(fetch, checkRunsRestArgs(owner, repo, sha))) as { check_runs?: RestCheckRun[] };
  const combined = (yield* ghRead(fetch, combinedStatusRestArgs(owner, repo, sha))) as { statuses?: RestStatus[] };
  const checks = runs?.check_runs ?? [];
  const listing = needsWorkflowIdentity(checks)
    ? (yield* ghRead(fetch, runsForHeadRestArgs(owner, repo, sha))) as { workflow_runs?: RestWorkflowRunIdentity[] }
    : undefined;
  return rollupFromRest(checks, combined?.statuses ?? [], listing === undefined ? undefined : listing?.workflow_runs ?? []);
}

export async function rollupForAsync(
  owner: string,
  repo: string,
  sha: string,
  fetch: (args: string[]) => unknown,
): Promise<RestRollupEntry[]> {
  const runs = (await fetch(checkRunsRestArgs(owner, repo, sha))) as { check_runs?: RestCheckRun[] };
  const combined = (await fetch(combinedStatusRestArgs(owner, repo, sha))) as { statuses?: RestStatus[] };
  const checks = runs?.check_runs ?? [];
  const listing = needsWorkflowIdentity(checks)
    ? await fetch(runsForHeadRestArgs(owner, repo, sha)) as { workflow_runs?: RestWorkflowRunIdentity[] }
    : undefined;
  return rollupFromRest(checks, combined?.statuses ?? [], listing === undefined ? undefined : listing?.workflow_runs ?? []);
}

/** Enumerate open PRs over REST. List failures throw: an outage must never look like an empty queue.
 *  Per-PR rollup failures set rollupUnreadable without losing other PRs; the next pass retries (W1-T521).
 *  Only the list requests a rate-limit reading, carried by withGhBudgetReading to paceGhEntry (W1-T1008). */
export function fetchOpenPrsRest(owner: string, repo: string, fetch: GhApiFetcher): OpenPrRest[] {
  return runGhReadSteps(fetchOpenPrsRestSteps(owner, repo, fetch));
}

export function* fetchOpenPrsRestSteps(owner: string, repo: string, fetch: GhApiFetcher): GhReadSteps<OpenPrRest[]> {
  let budget: GhBudgetReading | undefined;
  const rows = (yield* ghRead(fetch, openPrsRestArgs(owner, repo), (reading) => {
    budget = budgetFromRateLimitLikeReading(reading);
  })) as RestPullRow[];
  const result: OpenPrRest[] = [];
  for (const row of rows) result.push(yield* openPrWithRollupSteps(owner, repo, mapRestPr(row), fetch));
  return withGhBudgetReading(result, budget);
}

function* openPrWithRollupSteps(owner: string, repo: string, pr: OpenPrRest, fetch: GhApiFetcher): GhReadSteps<OpenPrRest> {
  try {
    return { ...pr, statusCheckRollup: yield* rollupSteps(owner, repo, pr.headRefOid, fetch) };
  } catch {
    return { ...pr, rollupUnreadable: true as const };
  }
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

export async function fetchSinglePrRestAsync(
  owner: string,
  repo: string,
  prNumber: number,
  fetch: GhApiFetcher,
): Promise<OpenPrRest & { state: string }> {
  const row = (await fetch(singlePrRestArgs(owner, repo, prNumber))) as RestPullRow;
  const pr = mapRestPr(row);
  return {
    ...pr,
    state: prStateFromRest(row),
    statusCheckRollup: await rollupForAsync(owner, repo, pr.headRefOid, fetch),
  };
}

/** W1-T511: ghLiveState's REST substitute, mapped by prStateFromRest.
 *  One read, no rollup: fetchSinglePrRest would triple the post-review disposition's cost. */
export function liveStateFromRest(owner: string, repo: string, prNumber: number, fetch: GhApiFetcher): string {
  const row = fetch(singlePrRestArgs(owner, repo, prNumber)) as RestPullRow;
  return prStateFromRest(row);
}

/** Board enumeration for buildBatchedGithub (lib/status.ts, W1-T265).
 *  Needs all PR states, bodies and titles, without checks. GraphQL exhaustion hid merged credit;
 *  full REST pagination inflated bytes, so refresh only changed rows after one cold pass.
 *  Record: docs/forensics/open-prs-rest.md. */

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
  mergedAt?: string;
  createdAt?: string;
  /** GitHub-supplied author evidence; absent on older cached rows, never inferred from a branch. */
  authorLogin?: string;
  authorType?: string;
}

/** Reuse mapRestPr's translations, normalise absent title to "", and derive state with prStateFromRest.
 *  Uppercasing REST state alone loses MERGED rows from mergedNewestFirst. */
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
    ...(base.createdAt === undefined ? {} : { createdAt: base.createdAt }),
    ...(typeof row.merged_at === "string" ? { mergedAt: row.merged_at } : {}),
    ...(typeof row.user?.login === "string" ? { authorLogin: row.user.login } : {}),
    ...(typeof row.user?.type === "string" ? { authorType: row.user.type } : {}),
  };
}

/** Cold pass page size — 687 PRs is 7 requests. */
const BOARD_FULL_PAGE_SIZE = 100;
/** Delta reads usually stop at row 1 or 2; smaller pages save bytes. Keep size constant within a walk. */
const BOARD_DELTA_PAGE_SIZE = 30;
/** BACKSTOP, not the primary control (a short page ends a healthy walk): a runaway guard. 200 pages is 20,000 PRs at the full size, past this repo's ~6,700 closed PRs (50 truncated every cold read). Reported, never silent. */
export const BOARD_MAX_PAGES = 200;

/** What a board fetch cost, for the ledger — the point of the exercise is that this stays small. */
export interface BoardFetchResult {
  rows: BoardPrRest[];
  /** REST requests issued. Steady state is 2. */
  calls: number;
  mode: "full" | "delta";
  /** True if {@link BOARD_MAX_PAGES} stopped the walk — a truncated view, never silent. */
  truncated: boolean;
  closedFloor?: string;
  /** Which halves this call actually walked — see {@link BoardFetchHalf}. */
  half: BoardFetchHalf;
}

/** W1-T2323: separable fetches, shared index. Default "both" preserves the original walk.
 *  listOpenHeadBranches need not pay for closed history; merged-credit readers still share that
 *  history and its stop test (W1-T377). The split changes when each half is fetched, never whether. */
export type BoardFetchHalf = "both" | "open" | "closed";

/** Refresh open PRs unconditionally: auto_merge can change without an updated_at bump.
 *  Walk closed/merged PRs by descending updated_at, stopping at the first unchanged cached row;
 *  later rows retain cached values. Failed pages throw without cache mutation, never report an
 *  empty repository (W1-T181). */
export function fetchBoardPrsRest(
  owner: string,
  repo: string,
  fetch: GhApiFetcher,
  known?: ReadonlyMap<number, BoardPrRest>,
  half: BoardFetchHalf = "both",
): BoardFetchResult {
  const walk = boardPrsWalk(owner, repo, known, half);
  for (let step = walk.next(); ; step = walk.next(fetch(step.value))) if (step.done) return step.value;
}

/** {@link fetchBoardPrsRest} with each page awaited: the same walk; a rejected page ends it as a throw does. */
export async function fetchBoardPrsRestAsync(
  owner: string,
  repo: string,
  fetch: (args: string[]) => Promise<unknown>,
  known?: ReadonlyMap<number, BoardPrRest>,
  half: BoardFetchHalf = "both",
): Promise<BoardFetchResult> {
  const walk = boardPrsWalk(owner, repo, known, half);
  for (let step = walk.next(); ; step = walk.next(await fetch(step.value))) if (step.done) return step.value;
}

function* boardPrsWalk(
  owner: string,
  repo: string,
  known: ReadonlyMap<number, BoardPrRest> | undefined,
  half: BoardFetchHalf,
): Generator<string[], BoardFetchResult, unknown> {
  const mode: "full" | "delta" = known && known.size > 0 ? "delta" : "full";
  const perPage = mode === "delta" ? BOARD_DELTA_PAGE_SIZE : BOARD_FULL_PAGE_SIZE;
  // W1-T2323: seeded from `known` as before. For `"open"` the caller passes no `known`, because
  // seeding a complete read of a small set would resurrect a since-merged PR as permanently open.
  const out = new Map<number, BoardPrRest>(known ?? []);
  let calls = 0;
  let truncated = false;
  let closedFloor: string | undefined;
  const wantOpen = half !== "closed";
  const wantClosed = half !== "open";

  // Hot half. Paginated rather than assuming one page: a repo holding >100 open PRs must not
  // silently drop the tail.
  for (let page = 1; wantOpen && page <= BOARD_MAX_PAGES; page += 1) {
    const rows = (yield boardPrsRestArgs(owner, repo, "open", page, perPage)) as RestPullRow[];
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
    const rows = (yield boardPrsRestArgs(owner, repo, "closed", page, perPage)) as RestPullRow[];
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
    if (page === BOARD_MAX_PAGES) {
      truncated = true;
      closedFloor = rows[rows.length - 1]!.updated_at;
    }
  }

  return { rows: [...out.values()], calls, mode, truncated, half, ...(closedFloor === undefined ? {} : { closedFloor }) };
}

/** Labelled-issue delta for fetchAllIssues (lib/status.ts, W1-T2222).
 *  Reuse the PR cold-half stop test with explicit pages: --paginate cannot stop mid-walk.
 *  Issues always bump updated_at, so need no separate hot half. docs/forensics/open-prs-rest.md. */

/** Issue pages, like boardPrsRestArgs: sort=updated&direction=desc makes early stopping safe. */
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

/** Raw merge facts retained alongside normalized conflict state; `blocked` otherwise maps to `clean`. */
export interface MergeStateObservation {
  state?: MergeState;
  mergeable?: boolean;
  mergeableState?: string;
  mergeCommitSha?: string;
  headSha?: string;
}

/** Bounded best-effort hydration; unknown or failed reads are omitted, never guessed. */
export function hydrateMergeStateObservations(
  owner: string,
  repo: string,
  prNumbers: readonly number[],
  fetch: GhApiFetcher,
  cap: number = MERGE_STATE_HYDRATION_CAP,
): Map<number, MergeStateObservation> {
  return runGhReadSteps(hydrateMergeStateObservationsSteps(owner, repo, prNumbers, fetch, cap));
}

export function* hydrateMergeStateObservationsSteps(
  owner: string,
  repo: string,
  prNumbers: readonly number[],
  fetch: GhApiFetcher,
  cap: number = MERGE_STATE_HYDRATION_CAP,
): GhReadSteps<Map<number, MergeStateObservation>> {
  const out = new Map<number, MergeStateObservation>();
  for (const n of prNumbers.slice(0, cap)) {
    try {
      const row = (yield* ghRead(fetch, singlePrRestArgs(owner, repo, n))) as {
        mergeable_state?: string | null;
        mergeable?: boolean | null;
        merge_commit_sha?: string | null;
        head?: { sha?: string | null } | null;
      };
      const state = mergeStateFromRest(row);
      const mergeableState = typeof row.mergeable_state === "string" ? row.mergeable_state.toLowerCase() : undefined;
      const mergeable = typeof row.mergeable === "boolean" ? row.mergeable : undefined;
      const mergeCommitSha = typeof row.merge_commit_sha === "string" && row.merge_commit_sha !== "" ? row.merge_commit_sha : undefined;
      const headSha = row.head && typeof row.head.sha === "string" && row.head.sha !== "" ? row.head.sha : undefined;
      if (state !== undefined || mergeableState !== undefined || mergeable !== undefined) {
        out.set(n, {
          ...(state === undefined ? {} : { state }),
          ...(mergeableState === undefined ? {} : { mergeableState }),
          ...(mergeable === undefined ? {} : { mergeable }),
          ...(mergeCommitSha === undefined ? {} : { mergeCommitSha }),
          ...(headSha === undefined ? {} : { headSha }),
        });
      }
    } catch {
      /* best-effort: this PR keeps the pre-existing undefined, the pass continues */
    }
  }
  return out;
}

/** Fetch bounded merge states; failed reads remain absent so a degraded pass changes nothing. */
export function hydrateMergeStates(
  owner: string,
  repo: string,
  prNumbers: readonly number[],
  fetch: GhApiFetcher,
  cap: number = MERGE_STATE_HYDRATION_CAP,
): Map<number, MergeState> {
  const out = new Map<number, MergeState>();
  for (const [n, observation] of hydrateMergeStateObservations(owner, repo, prNumbers, fetch, cap)) {
    if (observation.state !== undefined) out.set(n, observation.state);
  }
  return out;
}

/** W1-T3980 — REST-only scanner-blocker read for an armed, green, `blocked` PR; its safety case is documented on
 *  `repairableCodeqlBlocker` (sweep.ts). Every failed or truncated read is a named `unreadable`, never absence.
 *  An unarmed plan PR in the same green `blocked` state shares the cap for its review-hold read alone. */
export const SCANNER_BLOCKER_HYDRATION_CAP = 3; // BACKSTOP: above the one-at-a-time population (#1579, #7495); up to 4 REST reads each
export const SCANNER_DIAGNOSTIC_MAX_CHARS = 400; // PRIMARY CONTROL: sizes the untrusted scanner text a repair prompt carries
const SCANNER_PAGE_SIZE = 100; // one full REST page; a response this long may be truncated, so reads as unreadable
const CODE_SCANNING_BOT_LOGIN = "github-advanced-security[bot]"; // the author of every code-scanning review thread

export interface ScannerBlockerCandidateInput {
  autoMergeArmed: boolean;
  isDraft?: boolean;
  checksState: string;
  reviewState: string;
  mergeable?: boolean;
  mergeableState?: string;
}

function greenReviewedButBlocked(pr: ScannerBlockerCandidateInput): boolean {
  return (
    pr.isDraft !== true &&
    pr.checksState === "green" &&
    pr.reviewState === "success" &&
    pr.mergeable === true &&
    pr.mergeableState === "blocked"
  );
}

/** The scanner-REPAIR population: armed, green, reviewed, mergeable and raw `blocked`. */
export function isScannerBlockerCandidate(pr: ScannerBlockerCandidateInput): boolean {
  return pr.autoMergeArmed === true && greenReviewedButBlocked(pr);
}

/** W1-T6595 — the sweep's plan-PR test: a plan filing, or a PR whose observed files reach `plan/`, is
 *  never armed (W1-T5615); the fleet merges it directly. An emitter-ledger filing carries no observed
 *  files (its file read is skipped), so `isPlanFiling` is read too. Unobserved files read false. */
export function mergesDirectlyAsPlanPr(pr: { isPlanFiling?: boolean; changedFiles?: readonly string[] }): boolean {
  return pr.isPlanFiling === true || (pr.changedFiles ?? []).some((f) => f.startsWith("plan/"));
}

export interface HumanHoldCandidateInput extends ScannerBlockerCandidateInput {
  isPlanFiling?: boolean;
  changedFiles?: readonly string[];
}

/** The population whose only blocker can be a person's CHANGES_REQUESTED hold: the scanner population,
 *  plus an unarmed plan PR the fleet merges directly, which is never armed and so never in it. Its
 *  review hold is read; scanner repair still requires {@link isScannerBlockerCandidate}. */
export function isHumanHoldCandidate(pr: HumanHoldCandidateInput): boolean {
  return (pr.autoMergeArmed === true || mergesDirectlyAsPlanPr(pr)) && greenReviewedButBlocked(pr);
}

export interface ScannerAlertIdentity {
  alertNumber: number;
  ruleId: string;
  path: string;
  line: number;
  message: string; // bounded to SCANNER_DIAGNOSTIC_MAX_CHARS; untrusted scanner text
}

export type ScannerBlockerAmbiguity = "unreadable" | "stale" | "multiple" | "non-codeql" | "human-thread" | "unthreaded";

/** One human reviewer whose latest decisive review on this PR is CHANGES_REQUESTED. */
export interface ChangesRequestedHold {
  login: string;
  reviewId: number;
  commitId: string; // the head the hold was placed on; it can predate the current head
  submittedAt: string;
}

export type ScannerBlockerObservation =
  | { kind: "codeql-singleton"; headSha: string; mergeCommitSha: string; alert: ScannerAlertIdentity }
  | { kind: "changes-requested"; headSha: string; holds: ChangesRequestedHold[] }
  | { kind: "ambiguous"; cause: ScannerBlockerAmbiguity; detail: string }
  | { kind: "base-behind"; behindBy: number }
  | { kind: "no-scanner-alert" };

export function scannerAlertsRestArgs(owner: string, repo: string, prNumber: number): string[] {
  return ["api", `repos/${owner}/${repo}/code-scanning/alerts?ref=refs/pull/${prNumber}/merge&state=open&per_page=${SCANNER_PAGE_SIZE}`];
}

export function reviewCommentsRestArgs(owner: string, repo: string, prNumber: number): string[] {
  return ["api", `repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=${SCANNER_PAGE_SIZE}`];
}

export function pullReviewsRestArgs(owner: string, repo: string, prNumber: number): string[] {
  return ["api", `repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=${SCANNER_PAGE_SIZE}`];
}

interface RestPullReview {
  id?: unknown;
  state?: unknown;
  commit_id?: unknown;
  submitted_at?: unknown;
  user?: { login?: unknown; type?: unknown } | null;
}

/** States that set a reviewer's standing verdict; a COMMENTED review leaves the previous one in force. */
const DECISIVE_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

/**
 * The human CHANGES_REQUESTED holds standing on a PR, by each reviewer's latest decisive review (the
 * order GitHub lists them in). `undefined` when no hold stands; a listing that is not a complete page
 * is `unreadable`, never "no hold".
 */
export function classifyChangesRequested(
  candidate: Pick<ScannerBlockerCandidate, "headSha">,
  reviews: unknown,
): ScannerBlockerObservation | undefined {
  if (!Array.isArray(reviews) || reviews.length >= SCANNER_PAGE_SIZE) {
    return ambiguousScanner("unreadable", "pull request review listing was not a complete page");
  }
  const latest = new Map<string, RestPullReview>();
  for (const review of reviews as RestPullReview[]) {
    const login = review.user ? review.user.login : undefined;
    if (typeof login !== "string" || (review.user ? review.user.type : undefined) === "Bot") continue;
    if (typeof review.state === "string" && DECISIVE_REVIEW_STATES.has(review.state)) latest.set(login, review);
  }
  const holds: ChangesRequestedHold[] = [];
  for (const [login, review] of latest) {
    if (review.state !== "CHANGES_REQUESTED") continue;
    holds.push({
      login,
      reviewId: typeof review.id === "number" ? review.id : 0,
      commitId: typeof review.commit_id === "string" ? review.commit_id : "",
      submittedAt: typeof review.submitted_at === "string" ? review.submitted_at : "",
    });
  }
  return holds.length === 0 ? undefined : { kind: "changes-requested", headSha: candidate.headSha, holds };
}

export interface ScannerBlockerCandidate {
  number: number;
  headSha: string;
  merge?: MergeStateObservation;
  /** An unarmed plan PR ({@link isHumanHoldCandidate} only): its review hold is the one read taken. */
  holdOnly?: true;
}

function ambiguousScanner(cause: ScannerBlockerAmbiguity, detail: string): ScannerBlockerObservation {
  return { kind: "ambiguous", cause, detail: detail.slice(0, SCANNER_DIAGNOSTIC_MAX_CHARS) };
}

interface RestScannerAlert {
  number?: unknown;
  rule?: { id?: unknown } | null;
  tool?: { name?: unknown } | null;
  most_recent_instance?: {
    ref?: unknown;
    commit_sha?: unknown;
    message?: { text?: unknown } | null;
    location?: { path?: unknown; start_line?: unknown } | null;
  } | null;
}

interface RestReviewComment {
  body?: unknown;
  user?: { login?: unknown; type?: unknown } | null;
}

function threadCitesAlert(comment: RestReviewComment, alertNumber: number): boolean {
  const body = typeof comment.body === "string" ? comment.body : "";
  const needle = `/security/code-scanning/${alertNumber}`;
  for (let at = body.indexOf(needle); at !== -1; at = body.indexOf(needle, at + 1)) {
    const next = body.charAt(at + needle.length);
    if (next < "0" || next > "9") return true;
  }
  return false;
}

export function classifyScannerBlocker(
  candidate: ScannerBlockerCandidate,
  alerts: unknown,
  comments: unknown,
): ScannerBlockerObservation {
  if (!Array.isArray(alerts) || alerts.length >= SCANNER_PAGE_SIZE) {
    return ambiguousScanner("unreadable", "code-scanning alert listing was not a complete page");
  }
  if (!Array.isArray(comments) || comments.length >= SCANNER_PAGE_SIZE) {
    return ambiguousScanner("unreadable", "review comment listing was not a complete page");
  }
  const threads = comments as RestReviewComment[];
  const foreign = threads.filter((c) => (c.user ? c.user.login : undefined) !== CODE_SCANNING_BOT_LOGIN);
  const humans = foreign.filter((c) => (c.user ? c.user.type : undefined) !== "Bot");
  if (humans.length > 0) {
    return ambiguousScanner("human-thread", `${humans.length} review comment(s) not authored by a bot`);
  }
  if (foreign.length > 0) {
    return ambiguousScanner("non-codeql", `${foreign.length} review comment(s) authored by a bot other than code scanning`);
  }
  const rows = alerts as RestScannerAlert[];
  const nonCodeql = rows.filter((a) => (a.tool ? a.tool.name : undefined) !== "CodeQL");
  if (nonCodeql.length > 0) {
    return ambiguousScanner("non-codeql", `${nonCodeql.length} open alert(s) from a tool other than CodeQL`);
  }
  if (rows.length === 0) return { kind: "no-scanner-alert" };
  if (rows.length > 1) {
    return ambiguousScanner("multiple", `${rows.length} open CodeQL alerts on this merge ref`);
  }
  const alert = rows[0];
  const instance = alert.most_recent_instance ?? undefined;
  const location = instance ? instance.location ?? undefined : undefined;
  const ruleId = alert.rule ? alert.rule.id : undefined;
  const text = instance && instance.message ? instance.message.text : undefined;
  if (
    typeof alert.number !== "number" ||
    typeof ruleId !== "string" ||
    instance === undefined ||
    location === undefined ||
    typeof location.path !== "string" ||
    typeof location.start_line !== "number"
  ) {
    return ambiguousScanner("unreadable", "the CodeQL alert lacked a number, rule id or location");
  }
  const mergeRef = `refs/pull/${candidate.number}/merge`;
  if (instance.ref !== mergeRef) {
    return ambiguousScanner("stale", `alert #${alert.number} was observed on ${String(instance.ref)}, not ${mergeRef}`);
  }
  const merge = candidate.merge ?? {};
  const mergeCommitSha = merge.mergeCommitSha;
  if (mergeCommitSha === undefined || instance.commit_sha !== mergeCommitSha) {
    return ambiguousScanner("stale", `alert #${alert.number} was analysed at a merge commit other than the current one`);
  }
  if (merge.headSha !== candidate.headSha) {
    return ambiguousScanner("stale", `the PR head moved between the listing and the merge-fact read`);
  }
  const alertNumber = alert.number;
  if (!threads.some((c) => threadCitesAlert(c, alertNumber))) {
    return ambiguousScanner("unthreaded", `no code-scanning review thread cites alert #${alertNumber}`);
  }
  return {
    kind: "codeql-singleton",
    headSha: candidate.headSha,
    mergeCommitSha,
    alert: {
      alertNumber,
      ruleId,
      path: location.path,
      line: location.start_line,
      message: (typeof text === "string" ? text : "").slice(0, SCANNER_DIAGNOSTIC_MAX_CHARS),
    },
  };
}

export function observeScannerBlocker(
  owner: string,
  repo: string,
  candidate: ScannerBlockerCandidate,
  fetch: GhApiFetcher,
): ScannerBlockerObservation {
  return runGhReadSteps(observeScannerBlockerSteps(owner, repo, candidate, fetch));
}

/** One review read: the standing human hold, a named `unreadable`, or `undefined` when none stands. */
function* observeChangesRequestedSteps(
  owner: string,
  repo: string,
  candidate: ScannerBlockerCandidate,
  fetch: GhApiFetcher,
): GhReadSteps<ScannerBlockerObservation | undefined> {
  let reviews: unknown;
  try {
    reviews = yield* ghRead(fetch, pullReviewsRestArgs(owner, repo, candidate.number));
  } catch {
    const reason = "the pull request review read failed";
    return ambiguousScanner("unreadable", reason);
  }
  return classifyChangesRequested(candidate, reviews);
}

function* observeScannerBlockerSteps(
  owner: string,
  repo: string,
  candidate: ScannerBlockerCandidate,
  fetch: GhApiFetcher,
): GhReadSteps<ScannerBlockerObservation> {
  // A human hold blocks the merge whatever main, the scanner or a branch refresh does, so it is read
  // first: neither a refresh nor a scanner repair can clear it.
  const hold = yield* observeChangesRequestedSteps(owner, repo, candidate, fetch);
  if (hold !== undefined) return hold;
  let behindBy: unknown;
  try {
    const compare = (yield* ghRead(fetch, ["api", `repos/${owner}/${repo}/compare/${candidate.headSha}...main`])) as { ahead_by?: unknown } | null;
    behindBy = compare ? compare.ahead_by : undefined;
  } catch {
    const reason = "the head-to-main compare read failed";
    return ambiguousScanner("unreadable", reason);
  }
  if (typeof behindBy !== "number" || !Number.isFinite(behindBy)) {
    return ambiguousScanner("unreadable", "the head-to-main compare carried no distance");
  }
  if (behindBy > 0) return { kind: "base-behind", behindBy };
  let alerts: unknown;
  let comments: unknown;
  try {
    alerts = yield* ghRead(fetch, scannerAlertsRestArgs(owner, repo, candidate.number));
  } catch {
    const reason = "the code-scanning alert read failed";
    return ambiguousScanner("unreadable", reason);
  }
  try {
    comments = yield* ghRead(fetch, reviewCommentsRestArgs(owner, repo, candidate.number));
  } catch {
    const reason = "the review comment read failed";
    return ambiguousScanner("unreadable", reason);
  }
  return classifyScannerBlocker(candidate, alerts, comments);
}

export function hydrateScannerBlockerObservations(
  owner: string,
  repo: string,
  candidates: readonly ScannerBlockerCandidate[],
  fetch: GhApiFetcher,
  cap: number = SCANNER_BLOCKER_HYDRATION_CAP,
): Map<number, ScannerBlockerObservation> {
  return runGhReadSteps(hydrateScannerBlockerObservationsSteps(owner, repo, candidates, fetch, cap));
}

export function* hydrateScannerBlockerObservationsSteps(
  owner: string,
  repo: string,
  candidates: readonly ScannerBlockerCandidate[],
  fetch: GhApiFetcher,
  cap: number = SCANNER_BLOCKER_HYDRATION_CAP,
): GhReadSteps<Map<number, ScannerBlockerObservation>> {
  const out = new Map<number, ScannerBlockerObservation>();
  // Armed candidates take the cap first, so a hold-only plan PR never displaces a scanner read; a
  // hold-only read is one REST call, and one with no standing hold leaves the PR absent.
  const ordered = [...candidates.filter((c) => c.holdOnly !== true), ...candidates.filter((c) => c.holdOnly === true)];
  for (const candidate of ordered.slice(0, cap)) {
    const observation = candidate.holdOnly === true
      ? yield* observeChangesRequestedSteps(owner, repo, candidate, fetch)
      : yield* observeScannerBlockerSteps(owner, repo, candidate, fetch);
    if (observation !== undefined) out.set(candidate.number, observation);
  }
  return out;
}

export const CODEQL_CHECK_NAME = "CodeQL";
export const CODEQL_HEAD_ALERT_HYDRATION_CAP = 3; // BACKSTOP: one merge-ref read per failing-CodeQL or refused head per pass
export const CODEQL_HIGH_SEVERITIES: readonly string[] = ["critical", "high", "error", "warning", "medium"];

export interface CodeqlHeadAlert {
  alertNumber: number;
  ruleId: string;
  severity: string;
  path: string;
  line: number;
  message: string; // bounded to SCANNER_DIAGNOSTIC_MAX_CHARS; untrusted scanner text
}

export interface CodeqlHeadObservation {
  headSha: string;
  alerts: CodeqlHeadAlert[];
}

export function codeqlCheckFailed(rollup: readonly RestRollupEntry[] | undefined): boolean {
  let latest: RestRollupEntry | undefined;
  for (const entry of rollup ?? []) {
    if ((entry.name ?? entry.context) !== CODEQL_CHECK_NAME) continue;
    if (latest === undefined || (entry.startedAt ?? "") >= (latest.startedAt ?? "")) latest = entry;
  }
  return latest !== undefined && (latest.conclusion ?? "").toUpperCase() === "FAILURE";
}

/** The status context the trusted security merge producer publishes (`SECURITY_MERGE_CONTEXT`). */
export const SECURITY_MERGE_POLICY_CONTEXT = "security-merge-policy";

/** #14202 — the newest `security-merge-policy` status's refusal at this head, parsed from the `<state>: <reason>`
 *  description the producer publishes. Read whether or not the PR was ever armed: the arm refusal row W1-T9731
 *  reads exists only for a PR green and reviewed enough to arm. A success, a pending status or an unparsed
 *  description is no refusal. */
export function securityMergePolicyRefusal(rollup: readonly RestRollupEntry[] | undefined):
  { state: "blocked" | "unknown"; reason: string } | undefined {
  let latest: RestRollupEntry | undefined;
  for (const entry of rollup ?? []) {
    if (entry.context !== SECURITY_MERGE_POLICY_CONTEXT) continue;
    if (latest === undefined || (entry.startedAt ?? "") >= (latest.startedAt ?? "")) latest = entry;
  }
  const match = /^(blocked|unknown): (\S+)/.exec(latest?.description ?? "");
  const failed = match?.[1] === "blocked" ? "FAILURE" : "ERROR";
  return match && (latest?.state ?? "").toUpperCase() === failed
    ? { state: match[1] as "blocked" | "unknown", reason: match[2]! } : undefined;
}

export function codeqlHeadAlertsRestArgs(owner: string, repo: string, prNumber: number): string[] {
  return ["api", `repos/${owner}/${repo}/code-scanning/alerts?ref=refs/pull/${prNumber}/merge&state=open&per_page=${SCANNER_PAGE_SIZE}`];
}

interface RestHeadAlert extends RestScannerAlert {
  rule?: { id?: unknown; severity?: unknown; security_severity_level?: unknown } | null;
}

export function classifyCodeqlHeadAlerts(headSha: string, alerts: unknown, mergeRef?: string): CodeqlHeadObservation | undefined {
  if (!Array.isArray(alerts) || alerts.length >= SCANNER_PAGE_SIZE) return undefined;
  const found: CodeqlHeadAlert[] = [];
  for (const raw of alerts as RestHeadAlert[]) {
    const instance = raw.most_recent_instance ?? undefined;
    const location = instance?.location ?? undefined;
    const severity = [raw.rule?.security_severity_level, raw.rule?.severity].find((v) =>
      typeof v === "string" && CODEQL_HIGH_SEVERITIES.includes(v));
    if (
      (raw.tool ? raw.tool.name : undefined) !== "CodeQL" ||
      typeof severity !== "string" ||
      typeof raw.number !== "number" ||
      typeof raw.rule?.id !== "string" ||
      instance === undefined ||
      (instance.commit_sha !== headSha && (mergeRef === undefined || instance.ref !== mergeRef)) ||
      typeof location?.path !== "string" ||
      typeof location.start_line !== "number"
    ) continue;
    const text = instance.message ? instance.message.text : undefined;
    found.push({
      alertNumber: raw.number,
      ruleId: raw.rule.id,
      severity,
      path: location.path,
      line: location.start_line,
      message: (typeof text === "string" ? text : "").slice(0, SCANNER_DIAGNOSTIC_MAX_CHARS),
    });
  }
  return found.length === 0 ? undefined : { headSha, alerts: found };
}

export function hydrateCodeqlHeadAlerts(
  owner: string,
  repo: string,
  candidates: readonly { number: number; headSha: string }[],
  fetch: GhApiFetcher,
  cap: number = CODEQL_HEAD_ALERT_HYDRATION_CAP,
  onUnreadable: (prNumber: number, reason: string) => void = () => {},
): Map<number, CodeqlHeadObservation> {
  return runGhReadSteps(hydrateCodeqlHeadAlertsSteps(owner, repo, candidates, fetch, cap, onUnreadable));
}

export function* hydrateCodeqlHeadAlertsSteps(
  owner: string,
  repo: string,
  candidates: readonly { number: number; headSha: string }[],
  fetch: GhApiFetcher,
  cap: number = CODEQL_HEAD_ALERT_HYDRATION_CAP,
  onUnreadable: (prNumber: number, reason: string) => void = () => {},
): GhReadSteps<Map<number, CodeqlHeadObservation>> {
  const out = new Map<number, CodeqlHeadObservation>();
  for (const candidate of candidates.slice(0, cap)) {
    let listing: unknown;
    try {
      listing = yield* ghRead(fetch, codeqlHeadAlertsRestArgs(owner, repo, candidate.number));
    } catch (error) {
      const reason = String((error as Error)?.message ?? error);
      onUnreadable(candidate.number, reason);
      continue;
    }
    const observed = classifyCodeqlHeadAlerts(candidate.headSha, listing, `refs/pull/${candidate.number}/merge`);
    if (observed !== undefined) out.set(candidate.number, observed);
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * Workflow run observations (W1-T2340) — the producer for `OpenPrView.workflowRuns`. `stalledRunReason`
 * (lib/sweep.ts) joins a run's own conclusion against its jobs' statuses: a job left non-terminal inside an
 * already-concluded run will never move, because a terminal run schedules nothing further. The rollup cannot
 * answer that — it is check-runs, and such a run contributes entries that merely look pending. A
 * `KNOWN_UNWIRED` entry was refused because `stalledRunReason(undefined)` returns `undefined`, so it would ship
 * a detector that never fires. The cost bound is read off the predicate, never picked: across PRs, only heads
 * whose `checksState` reads `pending`; within a PR, jobs only for runs already concluded. Cadence, not volume,
 * is what bites, so this adds no loop and no wait of its own (docs/forensics/open-prs-rest.md). GitHub's jobs
 * listing can trail its runs listing, so a running job is a stall only when a LATER read of that attempt still
 * shows it: #9482 and #11239 each escalated a head whose every job read `completed` minutes later.
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

/** True when a run's conclusion is populated — GitHub sets it only once the run itself concluded. The SAME first
 *  clause {@link "./sweep.js".stalledRunReason} tests, kept here so the fetch scope and the predicate cannot drift apart. */
function runHasConcluded(conclusion: unknown): boolean {
  return typeof conclusion === "string" && conclusion.trim() !== "";
}

export const CONCLUDED_RUN_JOBS_CACHE_MAX_ENTRIES = 2_048; // BACKSTOP: a concluded attempt's settled jobs are immutable

export type ConcludedRunJobsCache = Map<string, ReadonlyArray<WorkflowRunJobObservation>>;

const concludedRunJobs: ConcludedRunJobsCache = new Map();

export type StuckRunSuspects = Set<string>;

const stuckRunSuspects: StuckRunSuspects = new Set();

function jobSettled(job: WorkflowRunJobObservation): boolean {
  return (job.status ?? "").toLowerCase() === "completed";
}

/** One fresh jobs read of a concluded attempt: all settled is cached; a running job is reported only on a re-read. */
function concludedRunJobsAsRead(
  jobs: ReadonlyArray<WorkflowRunJobObservation>,
  runKey: string,
  cacheKey: string | undefined,
  jobsCache: ConcludedRunJobsCache,
  suspects: StuckRunSuspects,
): ReadonlyArray<WorkflowRunJobObservation> | undefined {
  if (jobs.every(jobSettled)) {
    suspects.delete(runKey);
    if (cacheKey !== undefined) {
      jobsCache.set(cacheKey, jobs);
      if (jobsCache.size > CONCLUDED_RUN_JOBS_CACHE_MAX_ENTRIES) jobsCache.delete(jobsCache.keys().next().value as string);
    }
    return jobs;
  }
  if (suspects.has(runKey)) return jobs;
  suspects.add(runKey);
  if (suspects.size > CONCLUDED_RUN_JOBS_CACHE_MAX_ENTRIES) suspects.delete(suspects.values().next().value as string);
  return undefined;
}

/** W1-T2947: keeps the job `name`/`id` the requeue targets; an unusable one is ABSENT, never "" or 0. */
function restJobObservation(x: { status?: string | null; name?: string | null; id?: number | null }): WorkflowRunJobObservation {
  return {
    status: typeof x.status === "string" ? x.status : undefined,
    ...(typeof x.name === "string" && x.name.trim() !== "" ? { name: x.name } : {}),
    ...(typeof x.id === "number" && Number.isSafeInteger(x.id) && x.id > 0 ? { id: String(x.id) } : {}),
  };
}

export function activeCiRerunEvidence(raw: unknown, headSha: string): WorkflowRunObservation["activeCiRerun"] {
  if (raw === null || typeof raw !== "object") return undefined;
  const run = raw as Record<string, unknown>;
  if (!/^[a-f0-9]{40}$/.test(headSha) || run.head_sha !== headSha ||
      run.path !== ".github/workflows/ci.yml" || run.status !== "in_progress" ||
      (run.conclusion !== null && run.conclusion !== undefined && run.conclusion !== "") ||
      typeof run.id !== "number" || !Number.isSafeInteger(run.id) || run.id <= 0 ||
      typeof run.run_attempt !== "number" || !Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 1 ||
      typeof run.run_started_at !== "string" || !Number.isFinite(Date.parse(run.run_started_at))) return undefined;
  return { headSha, runId: run.id, attempt: run.run_attempt, startedAt: run.run_started_at };
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
  jobsCache: ConcludedRunJobsCache = concludedRunJobs,
  suspects: StuckRunSuspects = stuckRunSuspects,
): WorkflowRunObservation[] {
  return runGhReadSteps(workflowRunObservationSteps(owner, repo, headSha, fetch, jobsCache, suspects));
}

function* workflowRunObservationSteps(
  owner: string,
  repo: string,
  headSha: string,
  fetch: GhApiFetcher,
  jobsCache: ConcludedRunJobsCache,
  suspects: StuckRunSuspects,
): GhReadSteps<WorkflowRunObservation[]> {
  const listing = (yield* ghRead(fetch, runsForHeadRestArgs(owner, repo, headSha))) as {
    workflow_runs?: ReadonlyArray<Record<string, unknown> & { id?: number; run_attempt?: number; conclusion?: string | null }>;
  };
  const runs = listing?.workflow_runs ?? [];
  const out: WorkflowRunObservation[] = [];
  for (const run of runs) {
    const conclusion = typeof run.conclusion === "string" ? run.conclusion : undefined;
    if (!runHasConcluded(conclusion) || typeof run.id !== "number") {
      const activeCiRerun = activeCiRerunEvidence(run, headSha);
      out.push({ conclusion, ...(activeCiRerun ? { activeCiRerun } : {}) });
      continue;
    }
    const key = typeof run.run_attempt === "number" ? `${owner}/${repo}#${run.id}@${run.run_attempt}` : undefined;
    let jobs: ReadonlyArray<WorkflowRunJobObservation> | undefined = key === undefined ? undefined : jobsCache.get(key);
    if (jobs) {
      out.push({ conclusion, jobs });
      continue;
    }
    try {
      const j = (yield* ghRead(fetch, jobsForRunRestArgs(owner, repo, run.id))) as {
        jobs?: ReadonlyArray<{ status?: string | null; name?: string | null; id?: number | null }>;
      };
      const read = (j?.jobs ?? []).map(restJobObservation);
      jobs = concludedRunJobsAsRead(read, key ?? `${owner}/${repo}#${run.id}`, key, jobsCache, suspects);
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
  return runGhReadSteps(hydrateWorkflowRunsSteps(owner, repo, pendingPrs, fetch, cap));
}

export function* hydrateWorkflowRunsSteps(
  owner: string,
  repo: string,
  pendingPrs: readonly { number: number; headRefOid: string }[],
  fetch: GhApiFetcher,
  cap: number = WORKFLOW_RUN_HYDRATION_CAP,
): GhReadSteps<Map<number, readonly WorkflowRunObservation[]>> {
  const out = new Map<number, readonly WorkflowRunObservation[]>();
  for (const p of pendingPrs.slice(0, cap)) {
    try {
      out.set(p.number, yield* workflowRunObservationSteps(owner, repo, p.headRefOid, fetch, concludedRunJobs, stuckRunSuspects));
    } catch {
      /* best-effort: this PR keeps the pre-existing undefined workflowRuns, the pass continues */
    }
  }
  return out;
}

/** W1-T4773: replays a pass's per-PR reads off the loop; the next pass takes each answer once. */
export interface GhReadWarmer {
  warm(): Promise<number>;
  fetcher(inner: GhApiFetcher): GhApiFetcher;
}

export const GH_READ_WARM_CONCURRENCY = 4;

export function createGhReadWarmer(
  readAsync: (args: string[]) => Promise<unknown>,
  concurrency: number = GH_READ_WARM_CONCURRENCY,
): GhReadWarmer {
  let recorded = new Map<string, string[]>();
  let warmed = new Map<string, unknown>();
  return {
    async warm() {
      const reads = [...recorded.values()];
      recorded = new Map();
      warmed = new Map();
      const answers = new Map<string, unknown>();
      let next = 0;
      const lane = async (): Promise<void> => {
        while (next < reads.length) {
          const args = reads[next++]!;
          try {
            answers.set(JSON.stringify(args), await readAsync(args));
          } catch {
            // Not an erasure: the pass re-issues an unwarmed read synchronously and handles its failure.
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
      warmed = answers;
      return answers.size;
    },
    fetcher(inner) {
      return (args, onRateLimit) => {
        if (onRateLimit) return inner(args, onRateLimit);
        const key = JSON.stringify(args);
        recorded.set(key, args);
        if (warmed.has(key)) {
          const answer = warmed.get(key);
          warmed.delete(key);
          return answer;
        }
        return inner(args);
      };
    },
  };
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
 * git's (W1-T11174: only while each list is under GitHub's 300-file cap), so {@link isPureConcurrentAddition} is never looser:
 * a false true from a genuine deletion. A later reader must not narrow it to an exact git-conflict set
 * without re-deriving that argument.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/** The compare argv — GitHub's own merge-base-relative diff, never a raw two-tip diff. */
export function compareRestArgs(owner: string, repo: string, base: string, head: string): string[] {
  return ["api", `repos/${owner}/${repo}/compare/${base}...${head}`];
}

/** One file entry in a compare response — the wire shape, never {@link ConflictFileDiff}.
 *
 *  `status`/`sha`/`previous_filename` are read ONLY by {@link ownDiffDigestFromCompareFiles}; the
 *  conflict-evidence producer above ignores them. `sha` is the BLOB sha of the file at the head of
 *  the compare, which is what makes the digest a statement about CONTENT rather than about commit
 *  history: a rebase, a force-push of identical bytes, or a merge of the base branch all leave
 *  every blob sha unchanged. W1-T9047: `patch` is read in preference to `sha`. */
interface RestCompareFile {
  filename?: string;
  deletions?: number;
  status?: string;
  sha?: string;
  previous_filename?: string;
  patch?: string;
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

function* contentBytes(owner: string, repo: string, path: string, ref: string, fetch: GhApiFetcher): GhReadSteps<Buffer> {
  const raw = (yield* ghRead(fetch, contentRestArgs(owner, repo, path, ref))) as RestContentResponse;
  if (raw.encoding !== "base64" || typeof raw.content !== "string") {
    throw new Error(`content response for ${path}@${ref} was not a base64 file`);
  }
  return Buffer.from(raw.content.replace(/\s/g, ""), "base64");
}

const REDUNDANT_REFIX_COMPARE_PATH_CAP = 25;
export const GITHUB_COMPARE_FILE_LIST_CAP = 300; // BACKSTOP: GitHub's own compare file-list cap; a list this long is incomplete

function* redundantRefixEvidence(
  owner: string,
  repo: string,
  targetBranch: string,
  headRefOid: string,
  files: readonly ConflictFileDiff[],
  fetch: GhApiFetcher,
): GhReadSteps<RedundantRefixEvidence | undefined> {
  if (files.length === 0 || files.length > REDUNDANT_REFIX_COMPARE_PATH_CAP) return undefined;
  try {
    const comparedPaths: string[] = [];
    const differingPaths: string[] = [];
    for (const file of files) {
      const target = yield* contentBytes(owner, repo, file.path, targetBranch, fetch);
      const head = yield* contentBytes(owner, repo, file.path, headRefOid, fetch);
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
  return runGhReadSteps(mergeConflictEvidenceSteps(owner, repo, targetBranch, headRefOid, fetch));
}

function* mergeConflictEvidenceSteps(
  owner: string,
  repo: string,
  targetBranch: string,
  headRefOid: string,
  fetch: GhApiFetcher,
): GhReadSteps<MergeConflictEvidence> {
  const ours = (yield* ghRead(fetch, compareRestArgs(owner, repo, targetBranch, headRefOid))) as RestCompareResponse;
  const mergeBaseSha = ours.merge_base_commit?.sha;
  if (!mergeBaseSha) throw new Error("conflict evidence compare carried no merge_base_commit.sha");
  const theirs = (yield* ghRead(fetch, compareRestArgs(owner, repo, mergeBaseSha, targetBranch))) as RestCompareResponse;
  const listed = Math.max(ours.files?.length ?? 0, theirs.files?.length ?? 0);
  if (listed >= GITHUB_COMPARE_FILE_LIST_CAP) {
    throw new Error(`a compare listed ${listed} files, GitHub's ${GITHUB_COMPARE_FILE_LIST_CAP}-file cap, so its intersection can miss a conflicting path`);
  }

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
    redundantRefix: yield* redundantRefixEvidence(owner, repo, targetBranch, headRefOid, files, fetch),
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
  patch?: string;
}

/** BACKSTOP: GitHub serves at most 100 files on the single page this bounded reader requests. */
export const PLAN_FILING_FILE_RESPONSE_CAP = 100;
/** BACKSTOP: retained complete observations stay far above the measured open-PR population. */
export const PLAN_FILING_FILE_CACHE_MAX_ENTRIES = 256;

export interface PlanFilingFileCandidate {
  number: number;
  headRefOid: string;
  nominated?: boolean;
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
  nominatedReads?: Set<string>;
}

export function createPlanFilingFileCache(): PlanFilingFileCache {
  return { entries: new Map(), missCursors: new Map(), nominatedReads: new Set() };
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
  return runGhReadSteps(hydratePlanFilingFilesSteps(owner, repo, candidates, fetch, cache, opts));
}

export function* hydratePlanFilingFilesSteps(
  owner: string,
  repo: string,
  candidates: readonly PlanFilingFileCandidate[],
  fetch: GhApiFetcher,
  cache: PlanFilingFileCache,
  opts: { missCap: number; maxEntries?: number },
): GhReadSteps<Map<number, PlanFilingFileObservation>> {
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
  const spent = (cache.nominatedReads ??= new Set());
  const first = uncached.filter(({ candidate, key }) => candidate.nominated === true && !spent.has(key));
  const rest = uncached.filter((entry) => !first.includes(entry));
  const cursor = cache.missCursors.get(repositoryKey);
  const cursorIndex = cursor === undefined ? -1 : rest.findIndex(({ key }) => key === cursor);
  const startIndex = cursorIndex < 0 ? 0 : (cursorIndex + 1) % Math.max(1, rest.length);
  const rotated = rest.map((_, offset) => rest[(startIndex + offset) % rest.length]);
  for (const entry of [...first, ...rotated]) {
    const { candidate, key } = entry;
    if (misses >= missCap) {
      out.set(candidate.number, { state: "unreadable", reason: "per-pass-cap" });
      continue;
    }
    misses++;
    if (first.includes(entry)) {
      spent.add(key);
      while (spent.size > Math.max(0, maxEntries)) spent.delete(spent.values().next().value as string);
    } else rememberPlanFilingMissCursor(cache, repositoryKey, key, maxEntries);

    let raw: unknown;
    try {
      raw = yield* ghRead(fetch, prFilesRestArgs(owner, repo, candidate.number));
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
 *  Both PRs' changed-file lists, then their unified-diff hunk payloads, are compared. A shared
 *  filename is not replacement evidence: every old hunk payload must appear in the newer PR.
 *  `rawLineCount` is every added and deleted line observed before any matching, so a read that saw
 *  nothing is indeterminate, never "unique".
 *  Outcomes: one side wholly in plan scope while the other holds non-plan work is "complementary"
 *  (W1-T2779); every old patch hunk contained in the newer PR is "superseded"; no shared path is
 *  "unique"; a partial overlap, absent patch, or non-contained hunk is "indeterminate". */

/** Coordinate-free, byte-significant unified-diff hunk payloads. */
interface PatchHunkObservation {
  hunks: readonly string[];
  additions: number;
  deletions: number;
}

function unifiedHunkPayloads(patch: unknown): PatchHunkObservation | undefined {
  if (typeof patch !== "string" || patch.length === 0) return undefined;
  const hunks: string[] = [];
  let current: string[] | undefined;
  let additions = 0;
  let deletions = 0;
  const lines = patch.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("@@ ")) {
      if (current !== undefined && current.length > 0) hunks.push(current.join("\n"));
      current = [];
      continue;
    }
    if (current === undefined) return undefined;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "\\ No newline at end of file") {
      current.push(line);
      continue;
    }
    return undefined;
  }
  if (current !== undefined && current.length > 0) hunks.push(current.join("\n"));
  return hunks.length > 0 ? { hunks, additions, deletions } : undefined;
}

function containedHunkCount(required: readonly string[], candidate: readonly string[]): number {
  const available = new Map<string, number>();
  for (const hunk of candidate) available.set(hunk, (available.get(hunk) ?? 0) + 1);
  let matched = 0;
  for (const hunk of required) {
    const count = available.get(hunk) ?? 0;
    if (count === 0) continue;
    available.set(hunk, count - 1);
    matched += 1;
  }
  return matched;
}

export function fetchSupersessionVerdict(
  owner: string,
  repo: string,
  prNumber: number,
  supersedingPrNumber: number,
  taskId: string,
  fetch: GhApiFetcher,
  isPlanPath: PlanPathPredicate,
): SupersessionVerdict {
  return runGhReadSteps(supersessionVerdictSteps(owner, repo, prNumber, supersedingPrNumber, taskId, fetch, isPlanPath));
}

function* supersessionVerdictSteps(
  owner: string,
  repo: string,
  prNumber: number,
  supersedingPrNumber: number,
  taskId: string,
  fetch: GhApiFetcher,
  isPlanPath: PlanPathPredicate,
): GhReadSteps<SupersessionVerdict> {
  const ours = (yield* ghRead(fetch, prFilesRestArgs(owner, repo, prNumber))) as RestPrFile[];
  const theirs = (yield* ghRead(fetch, prFilesRestArgs(owner, repo, supersedingPrNumber))) as RestPrFile[];
  if (!Array.isArray(ours) || !Array.isArray(theirs)) throw new Error("supersession read carried no file list");

  const ourFiles = new Map(ours.map((f) => [f.filename, f] as const).filter((entry): entry is [string, RestPrFile] => typeof entry[0] === "string" && entry[0].length > 0));
  const theirFiles = new Map(theirs.map((f) => [f.filename, f] as const).filter((entry): entry is [string, RestPrFile] => typeof entry[0] === "string" && entry[0].length > 0));
  const ourPaths = [...ourFiles.keys()];
  const theirPaths = new Set(theirFiles.keys());
  const rawLineCount = ours.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0);
  const theirRawLineCount = theirs.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0);
  const sharedPathCount = ourPaths.filter((f) => theirPaths.has(f)).length;
  const baseDiff = { rawLineCount, matchedHunks: 0 };

  // THE CONTROL FIRST. An empty corpus cannot support either finding — see this function's own doc.
  if (ourPaths.length === 0 || rawLineCount === 0 || theirPaths.size === 0 || theirRawLineCount === 0) {
    const emptyPrNumber = ourPaths.length === 0 || rawLineCount === 0 ? prNumber : supersedingPrNumber;
    return { status: "indeterminate", detail: `the diff read for #${emptyPrNumber} observed no changed lines — no finding is supportable`, diff: baseDiff } as SupersessionVerdict;
  }
  if (ourFiles.size !== ours.length || theirFiles.size !== theirs.length) {
    return { status: "indeterminate", detail: "the diff read carried an empty or duplicate filename — no auto-close is supportable", diff: baseDiff };
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
      diff: baseDiff,
    };
  }
  if (sharedPathCount === 0) {
    return { status: "unique", detail: `none of #${prNumber}'s ${ourPaths.length} changed path(s) is touched by #${supersedingPrNumber}` };
  }
  if (sharedPathCount !== ourPaths.length) {
    return {
      status: "indeterminate",
      detail: `#${prNumber} shares ${sharedPathCount} of ${ourPaths.length} changed path(s) with #${supersedingPrNumber} — a partial overlap supports neither finding`,
      diff: baseDiff,
    };
  }

  let requiredHunkCount = 0;
  let matchedHunks = 0;
  for (const path of ourPaths) {
    const ourFile = ourFiles.get(path)!;
    const theirFile = theirFiles.get(path)!;
    const oursHunks = unifiedHunkPayloads(ourFile.patch);
    const theirsHunks = unifiedHunkPayloads(theirFile.patch);
    const oursComplete = oursHunks !== undefined && oursHunks.additions === ourFile.additions && oursHunks.deletions === ourFile.deletions;
    const theirsComplete = theirsHunks !== undefined && theirsHunks.additions === theirFile.additions && theirsHunks.deletions === theirFile.deletions;
    if (!oursComplete || !theirsComplete) {
      return {
        status: "indeterminate",
        detail: `#${prNumber} and #${supersedingPrNumber} share every changed path, but ${path} has no complete text patch — no auto-close is supportable`,
        diff: { rawLineCount, matchedHunks },
      };
    }
    requiredHunkCount += oursHunks.hunks.length;
    matchedHunks += containedHunkCount(oursHunks.hunks, theirsHunks.hunks);
  }
  const diff = { rawLineCount, matchedHunks };
  if (matchedHunks === requiredHunkCount) {
    return {
      status: "superseded",
      evidence: { supersedingPrNumber, taskId, diff },
      detail: `every one of #${prNumber}'s ${requiredHunkCount} patch hunk(s) is contained in #${supersedingPrNumber}`,
    };
  }
  return {
    status: "indeterminate",
    detail: `#${prNumber} has ${matchedHunks} of ${requiredHunkCount} patch hunk(s) contained in #${supersedingPrNumber} — changed filenames alone cannot support an auto-close`,
    diff,
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
  return runGhReadSteps(hydrateSupersessionVerdictsSteps(owner, repo, supersededPrs, fetch, isPlanPath, cap));
}

export function* hydrateSupersessionVerdictsSteps(
  owner: string,
  repo: string,
  supersededPrs: readonly { number: number; supersededBy: number; taskId: string }[],
  fetch: GhApiFetcher,
  isPlanPath: PlanPathPredicate,
  cap: number = MERGE_STATE_HYDRATION_CAP,
): GhReadSteps<Map<number, SupersessionVerdict>> {
  const out = new Map<number, SupersessionVerdict>();
  for (const p of supersededPrs.slice(0, cap)) {
    try {
      out.set(p.number, yield* supersessionVerdictSteps(owner, repo, p.number, p.supersededBy, p.taskId, fetch, isPlanPath));
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
  gaps?: Map<number, string>,
): Map<number, MergeConflictEvidence> {
  return runGhReadSteps(hydrateMergeConflictEvidenceSteps(owner, repo, targetBranch, dirtyPrs, fetch, cap, gaps));
}

export function* hydrateMergeConflictEvidenceSteps(
  owner: string,
  repo: string,
  targetBranch: string,
  dirtyPrs: readonly { number: number; headRefOid: string }[],
  fetch: GhApiFetcher,
  cap: number = MERGE_STATE_HYDRATION_CAP,
  gaps?: Map<number, string>,
): GhReadSteps<Map<number, MergeConflictEvidence>> {
  const out = new Map<number, MergeConflictEvidence>();
  for (const p of dirtyPrs.slice(cap)) gaps?.set(p.number, `over the ${cap}-PR conflict-evidence cap this pass`);
  for (const p of dirtyPrs.slice(0, cap)) {
    try {
      out.set(p.number, yield* mergeConflictEvidenceSteps(owner, repo, targetBranch, p.headRefOid, fetch));
    } catch (error) {
      // W1-T9723: best-effort, but the failure is the evidence gap the escalation names.
      gaps?.set(p.number, `the compare read failed: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
    }
  }
  return out;
}


// review-reuse-producer: feed W1-T3704's reviewReuseVerdict and ledger readers; missing inputs
// previously forced every orphaned review to full-review (#5941).
// Both review and sweep MUST use this REST representation. Mixing local git and REST digests
// makes unchanged diffs compare unequal forever; reviewedOwnDiffDigest === currentOwnDiffDigest
// must compare PR content, independent of which caller asked.

/** reviewReuseVerdict's required pair. Partial reads become undefined (unreadable, re-review),
 *  never an authoritative half-answer. */
export interface ReviewReuseFacts {
  ownDiffDigest: string;
  mergeBaseSha: string;
}

/** W1-T9047 — a patch with each hunk header cut to `@@`, dropping the line numbers and function
 *  text that move when main edits elsewhere in the file (the idea behind `git patch-id`). */
export function hunksWithoutLineNumbers(patch: string): string {
  return patch
    .split("\n")
    .map((line) => (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line) ? "@@" : line))
    .join("\n");
}

/** The own-diff digest, and the paths whose part of it came from a blob sha instead of a patch. */
export interface OwnDiffDigestDetail {
  digest: string;
  /** Files GitHub sent no `patch` for (binary, or too large), sorted; their blob sha is used. */
  blobFallbackPaths: string[];
}

/** Hash the PR's own paths, statuses, normalised hunks and rename origins, sorted before hashing.
 *  Exclude commit metadata and ordering so equivalent rebases/refreshes keep the digest.
 *  W1-T9047: prefer hunks; main's edits move shared-file blobs. Missing patches use blob SHAs
 *  and record blobFallbackPaths. Missing filenames contribute a marker, never disappear:
 *  false "changed" wastes review; false "unchanged" could ship an unjudged diff. */
export function ownDiffDigestDetail(files: readonly RestCompareFile[] | undefined): OwnDiffDigestDetail {
  const blobFallbackPaths: string[] = [];
  const rows = (files ?? []).map((f) => {
    const name = f.filename ?? "\u0000unnamed";
    let content: string;
    if (typeof f.patch === "string") {
      content = `patch:${createHash("sha256").update(hunksWithoutLineNumbers(f.patch)).digest("hex")}`;
    } else {
      blobFallbackPaths.push(name);
      content = `blob:${f.sha ?? "\u0000noblob"}`;
    }
    return [name, f.status ?? "\u0000unknown", content, f.previous_filename ?? ""].join("\u0000");
  });
  rows.sort();
  // Include row count so differently partitioned lists cannot share the same concatenation digest.
  const digest = createHash("sha256").update(`${rows.length}\n${rows.join("\n")}`).digest("hex");
  return { digest, blobFallbackPaths: blobFallbackPaths.sort() };
}

/** {@link ownDiffDigestDetail}'s digest alone. Both sides of the reuse comparison record this. */
export function ownDiffDigestFromCompareFiles(files: readonly RestCompareFile[] | undefined): string {
  return ownDiffDigestDetail(files).digest;
}

/** W1-T9047 — what the sweep reads before upgrading a `discriminate-only` review to reuse. */
export interface ReviewReuseReachFacts {
  /** Paths main changed between the reviewed merge base and the current one. */
  mainChangedFiles: string[];
  /** The PR's own paths over the current merge base, a rename's source path included. */
  prFiles: string[];
  /** The PR's files whose own-diff digest part fell back to a blob sha (no patch from GitHub). */
  blobFallbackPaths: string[];
}

/** {@link ReviewReuseReachFacts} over REST: two compares, `reviewed...current` merge base for main's
 *  delta and `current merge base...head` for the PR's own files. Throws on a failed read. */
export function fetchReviewReuseReachFacts(
  owner: string,
  repo: string,
  reviewedMergeBaseSha: string,
  currentMergeBaseSha: string,
  headSha: string,
  fetch: GhApiFetcher,
): ReviewReuseReachFacts {
  return runGhReadSteps(reviewReuseReachFactsSteps(owner, repo, reviewedMergeBaseSha, currentMergeBaseSha, headSha, fetch));
}

function* reviewReuseReachFactsSteps(
  owner: string,
  repo: string,
  reviewedMergeBaseSha: string,
  currentMergeBaseSha: string,
  headSha: string,
  fetch: GhApiFetcher,
): GhReadSteps<ReviewReuseReachFacts> {
  const main = (yield* ghRead(fetch, compareRestArgs(owner, repo, reviewedMergeBaseSha, currentMergeBaseSha))) as RestCompareResponse;
  const own = (yield* ghRead(fetch, compareRestArgs(owner, repo, currentMergeBaseSha, headSha))) as RestCompareResponse;
  if (!Array.isArray(main.files) || !Array.isArray(own.files)) {
    throw new Error("review-reuse reach compare carried no files list");
  }
  const names = (files: readonly RestCompareFile[]): string[] =>
    [...new Set(files.flatMap((f) => [f.filename, f.previous_filename]).filter((p): p is string => typeof p === "string"))].sort();
  return {
    mainChangedFiles: names(main.files),
    prFiles: names(own.files),
    blobFallbackPaths: ownDiffDigestDetail(own.files).blobFallbackPaths,
  };
}

/** Fetch ReviewReuseFacts with one compare/<targetBranch>...<headSha> read, without retries.
 *  Failures, including missing merge_base_commit.sha, throw; a digest alone cannot authorize reuse. */
export function fetchReviewReuseFacts(
  owner: string,
  repo: string,
  targetBranch: string,
  headSha: string,
  fetch: GhApiFetcher,
): ReviewReuseFacts {
  return runGhReadSteps(reviewReuseFactsSteps(owner, repo, targetBranch, headSha, fetch));
}

function* reviewReuseFactsSteps(
  owner: string,
  repo: string,
  targetBranch: string,
  headSha: string,
  fetch: GhApiFetcher,
): GhReadSteps<ReviewReuseFacts> {
  const compare = (yield* ghRead(fetch, compareRestArgs(owner, repo, targetBranch, headSha))) as RestCompareResponse;
  const mergeBaseSha = compare.merge_base_commit?.sha;
  if (!mergeBaseSha) throw new Error("review-reuse compare carried no merge_base_commit.sha");
  return { ownDiffDigest: ownDiffDigestFromCompareFiles(compare.files), mergeBaseSha };
}

/** Best-effort fetchReviewReuseFacts: undefined means unreadable, requiring full review.
 *  A failed compare must not abort review or sweep; see reviewReuseVerdict's absence guard. */
export function tryFetchReviewReuseFacts(
  owner: string,
  repo: string,
  targetBranch: string,
  headSha: string,
  fetch: GhApiFetcher,
  /** Report failed reads distinctly from absent verdicts; callers with a logger pass it here. */
  onUnreadable?: (reason: string) => void,
): ReviewReuseFacts | undefined {
  try {
    return fetchReviewReuseFacts(owner, repo, targetBranch, headSha, fetch);
  } catch (err) {
    // NOT AN ERASURE: the reason is handed to `onUnreadable` before the value collapses, and the
    // `undefined` is a MEANINGFUL answer here rather than a lost one — "unreadable" is exactly what
    // `reviewReuseVerdict` needs to hear to fall back to a full review.
    onUnreadable?.(err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

/** One orphaned PR the reuse hydrator asks about. `headRefName` orders fleet heads first under a cap. */
export interface ReviewReuseHydrationTarget {
  number: number;
  headRefOid: string;
  headRefName?: string;
}

/** Fleet heads (`run-*`), the ones a refresh re-points at main, first; otherwise input order. */
export function reviewReuseHydrationOrder<T extends ReviewReuseHydrationTarget>(prs: readonly T[]): T[] {
  const fleet = (pr: T): number => (pr.headRefName?.startsWith("run-") === true ? 0 : 1);
  return prs.map((pr, index) => ({ pr, index }))
    .sort((a, b) => fleet(a.pr) - fleet(b.pr) || a.index - b.index)
    .map(({ pr }) => pr);
}

/** Hydrate current-head facts only for already-orphaned reviews, best-effort like hydrateSupersessionVerdicts.
 *  Full-board fan-out risks secondary cadence limits even with a full rate_limit budget.
 *  W1-T9047: default uncapped within this population; the former 25 cap forced needless full reviews. */
export function hydrateReviewReuseFacts(
  owner: string,
  repo: string,
  targetBranch: string,
  orphanedPrs: readonly ReviewReuseHydrationTarget[],
  fetch: GhApiFetcher,
  cap: number = Number.POSITIVE_INFINITY,
  /** Per-PR failure reason, forwarded from {@link tryFetchReviewReuseFacts}. */
  onUnreadable?: (prNumber: number, reason: string) => void,
  /** W1-T9047 — each PR a cap left unasked. Its review cannot be reused this pass. */
  onPastCap?: (prNumber: number, cap: number) => void,
): Map<number, ReviewReuseFacts> {
  return runGhReadSteps(hydrateReviewReuseFactsSteps(owner, repo, targetBranch, orphanedPrs, fetch, cap, onUnreadable, onPastCap));
}

export function* hydrateReviewReuseFactsSteps(
  owner: string,
  repo: string,
  targetBranch: string,
  orphanedPrs: readonly ReviewReuseHydrationTarget[],
  fetch: GhApiFetcher,
  cap: number = Number.POSITIVE_INFINITY,
  onUnreadable?: (prNumber: number, reason: string) => void,
  onPastCap?: (prNumber: number, cap: number) => void,
): GhReadSteps<Map<number, ReviewReuseFacts>> {
  const out = new Map<number, ReviewReuseFacts>();
  const ordered = reviewReuseHydrationOrder(orphanedPrs);
  for (const p of ordered.slice(cap)) onPastCap?.(p.number, cap);
  for (const p of ordered.slice(0, cap)) {
    // Best-effort per PR: an unreadable compare leaves `currentOwnDiffDigest` undefined, so the reuse
    // decision falls back to a full review; the reason goes to `onUnreadable` (see tryFetchReviewReuseFacts).
    try {
      out.set(p.number, yield* reviewReuseFactsSteps(owner, repo, targetBranch, p.headRefOid, fetch));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      onUnreadable?.(p.number, reason);
    }
  }
  return out;
}
