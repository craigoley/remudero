import {
  NEEDS_HUMAN_LABEL,
  tryEscalateAsync,
  type AsyncIssueGateway,
  type Escalation,
  type OpenIssue,
} from "./escalate.js";
import { prFilesRestArgs, rollupForAsync, type GhApiFetcher } from "./open-prs-rest.js";
import { appendLedger } from "./ledger.js";
import { systemClock, type Clock } from "./clock.js";
import { readLedgerLines } from "./status.js";
import { baseReproductionFiles } from "./base-reproduction.js";
import {
  CHECK_REQUEUE_STEP,
  classifyCiInfrastructureFailure,
  dedupeRollupByLatestAttempt,
  enrichMainHealthObservation,
  failedMainGuardRuns,
  MAIN_HEALTH_FALLBACK_WINDOW_COMMITS,
  mainGuardFailureCandidates,
  mainHealthEscalationDecision,
  mainHealthFallbackCandidates,
  mainHealthFallbackRuns,
  mainHealthFromRollup,
  mainHealthHeadInconclusive,
  requeuedCheckKeysFromLedger,
  type CiFailure,
  type MainHealthObservation,
  type MainHealthRunHistoryEntry,
  type RollupCheckEntry,
} from "./sweep.js";

/** Stable referent for the one repo-wide default-branch health incident. */
export const MAIN_HEALTH_TASK_ID = "MAIN-HEALTH";

/** W1-T4472 — the stable, NON-REQUIRED check name `.github/workflows/main-tripwire.yml` posts once
 *  per merged commit on `main` (see that workflow's own header for why: ci.yml's push lane groups
 *  every push under one concurrency key, so a red can sit superseded-then-live for the better part
 *  of an hour). It is never added to `readRequiredChecks()` — ci-gate's REQUIRED list stays the
 *  sole BLOCKING authority for a merge — so it is read separately, below, from the gate-required
 *  judgment {@link mainHealthFromRollup} already performs. */
export const MAIN_TRIPWIRE_CHECK_NAME = "main-tripwire";

/** True when the deduped rollup carries a {@link MAIN_TRIPWIRE_CHECK_NAME} entry for this head that
 *  concluded with a failing conclusion. An absent or still-running tripwire reads `false` here —
 *  this predicate only ever fires on a genuinely concluded red. */
function tripwireIsRed(rollup: readonly RollupCheckEntry[]): boolean {
  const entry = dedupeRollupByLatestAttempt(rollup).find((c) => (c.name ?? c.context) === MAIN_TRIPWIRE_CHECK_NAME);
  if (!entry) return false;
  const state = (entry.state ?? entry.conclusion ?? entry.status ?? "").toUpperCase();
  return TRIPWIRE_RED.has(state);
}

/** Only a tripwire that RAN and failed reads red. A cancelled, timed-out or stale one is no evidence
 *  either way: 17 of 21 runs on 2026-09-26..28 hit the job timeout and paged a false "main is red". */
const TRIPWIRE_RED: ReadonlySet<string> = new Set(["FAILURE", "ERROR"]);

/** W1-T4472 design (ii) — a RED main-tripwire on main's newest head reads main red AT ONCE, layered
 *  onto whatever {@link mainHealthFromRollup} already found rather than replacing its reasoning: the
 *  full required run may still be minutes away from its own verdict. The asymmetry is deliberate and
 *  one-directional — a GREEN or absent tripwire never touches `observation`, because a fast check
 *  over a SUBSET of the suite is never evidence the whole tree is healthy; only the full required
 *  run may report green. Idempotent: a second call once `main-tripwire` is already named in
 *  `failingChecks` (main-tripwire is itself in the required set) changes nothing. */
export function withTripwireOverride(
  observation: MainHealthObservation,
  rollup: readonly RollupCheckEntry[],
): MainHealthObservation {
  if (!tripwireIsRed(rollup) || observation.failingChecks.includes(MAIN_TRIPWIRE_CHECK_NAME)) return observation;
  return {
    ...observation,
    state: "red",
    reason:
      observation.state === "red"
        ? `${observation.reason} (the per-commit main-tripwire is also red on this head)`
        : "the per-commit main-tripwire is red on main's head (a fast check over this merge's own " +
          `affected suites, run ahead of the full required check concluding): ${observation.reason}`,
    failingChecks: [...observation.failingChecks, MAIN_TRIPWIRE_CHECK_NAME],
  };
}

/** W1-T5630 — PRIMARY CONTROL: how long one head's completed run history (and the fallback jobs
 *  read under it) is reused. The key already refetches on a new head or a newly completed head
 *  check; this bounds staleness from runs finishing on OTHER commits while the head sits still.
 *  Read 2026-10-04: 72 observations over 7 heads in 88 minutes, so each head's page refetched ~10x. */
export const MAIN_HEALTH_RUN_HISTORY_TTL_MS = 5 * 60_000;

/** The run-history cache key: the head sha plus each COMPLETED head rollup entry's name:verdict,
 *  sorted. A check run carries a conclusion only once completed; a commit status counts once it
 *  leaves `PENDING`. A guard workflow finishing on the head therefore changes the key. */
function runHistoryCacheKey(sha: string, rollup: readonly RollupCheckEntry[]): string {
  const completed = rollup
    .map((c) => [c.name ?? c.context, c.conclusion || (c.state !== "PENDING" ? c.state : undefined)] as const)
    .filter(([, verdict]) => verdict)
    .map(([name, verdict]) => `${name}:${verdict}`)
    .sort();
  return `${sha}|${completed.join(",")}`;
}

interface RunHistoryCache {
  key: string;
  readAtMs: number;
  history: MainHealthRunHistoryEntry[];
  jobsByRunId: Map<number, RollupCheckEntry[]>;
  /** W1-T6023: main's newest first-parent shas from this head, read once a fallback is needed. */
  recentShas?: ReadonlySet<string>;
}

export interface MainHealthRungDeps {
  /** Every read is awaited: production passes the async `gh` transport, because a sync `ghJson`
   *  here held the core daemon's loop 144 s (E36, 2026-10-02). A sync fetcher still works. */
  fetch: GhApiFetcher;
  /** W1-T5283: every issue call is awaited, for the same reason as `fetch`; a sync gateway still works. */
  issues: AsyncIssueGateway;
  ledgerPath: string;
  runId: string;
  log: (step: string, extra?: Record<string, unknown>) => void;
  /** Brief successful-observation cache shared by the event and ordinary full-sweep paths. */
  freshMs?: number;
  /** Injectable wall clock for the freshness boundary. */
  now?: () => number;
  readCiFailures?: (
    rollup: readonly RollupCheckEntry[] | undefined,
  ) => CiFailure[] | undefined | Promise<CiFailure[] | undefined>;
  readMainRunHistory?: (branch: string) => MainHealthRunHistoryEntry[] | undefined | Promise<MainHealthRunHistoryEntry[] | undefined>;
  requeueCheck?: (failure: CiFailure) => boolean | void | Promise<boolean | void>;
  readRequiredChecks?: () => readonly string[];
  /** W1-T5806: the git reads that name the merges a red met in; defaults to GitHub's over `fetch`. */
  mergeReader?: MainHealthMergeReader;
  /** W1-T5806: one PR's changed paths; defaults to its `pulls/N/files` list over `fetch`. */
  readPrFiles?: (prNumber: number) => readonly string[] | undefined | Promise<readonly string[] | undefined>;
  /** W1-T6403: the PR openers of the red-main repair lane. Absent, a red main only escalates. */
  repair?: MainRepairLane;
}

type Awaitable<T> = T | Promise<T>;

/** W1-T6403 — PRIMARY CONTROL: red observations a fix PR may sit through with no new head and no
 *  merge before the lane opens the revert PR (the operator ruling's "two daemon ticks"). */
export const MAIN_REPAIR_STALL_TICKS = 2;

/** W1-T6403 — PRIMARY CONTROL: the least time since a fix PR last moved before it counts as stalled.
 *  A daemon tick is 60 s (`pollIntervalMs`) and one CI run on a fix PR takes far longer, so two
 *  ticks alone would revert while the fix PR's own CI was still running. #10092's red lasted 40
 *  minutes before a hand fix merged. */
export const MAIN_REPAIR_STALL_MS = 30 * 60_000;

/** W1-T6403 — what the priority fix PR's worker is told: the failing checks, their failing test
 *  titles and log excerpt, and the merge that turned main red. */
export interface MainRepairFixRequest {
  readonly branch: string;
  readonly headSha: string;
  readonly offendingSha: string;
  readonly offendingPr?: number;
  /** The offending merge's per-file `+added -deleted` lines, or why they were not read. */
  readonly diffStat: string;
  readonly failingChecks: readonly string[];
  readonly failingTestTitles: readonly string[];
  readonly testFiles: readonly string[];
  readonly logExcerpt: string;
  readonly reason: string;
}

/** W1-T6403 — the one revert PR of the offending merge, opened once its fix PR was not enough. */
export interface MainRepairRevertRequest {
  readonly branch: string;
  readonly headSha: string;
  readonly offendingSha: string;
  readonly offendingPr?: number;
  readonly failingChecks: readonly string[];
  readonly fixPrUrl?: string;
  readonly whyFixInsufficient: string;
}

/** A revert PR opened, or the revert refused (a conflicting `git revert`, or a failed push or open). */
export type MainRepairRevertOutcome =
  | { readonly prUrl: string }
  | { readonly refused: string; readonly conflictPaths?: readonly string[] };

export interface MainRepairPr {
  readonly state: "open" | "closed" | "merged";
  readonly headSha?: string;
}

/** W1-T6403 — the lane's effects. Both openers cut a fresh branch off origin/main and open a PR;
 *  neither pushes to main. `readPr`/`closePr` default to GitHub's REST calls over `fetch`. */
export interface MainRepairLane {
  openFixPr(request: MainRepairFixRequest): Awaitable<string | undefined>;
  openRevertPr(request: MainRepairRevertRequest): Awaitable<MainRepairRevertOutcome>;
  readPr?(prUrl: string): Awaitable<MainRepairPr>;
  closePr?(prUrl: string, comment: string): Awaitable<void>;
}

/** One offending merge's repair, folded from its `main.repair.*` ledger rows. */
export interface MainRepairRecord {
  offendingSha: string;
  offendingPr?: number;
  failingChecks: string[];
  fixDispatched: boolean;
  fixPrUrl?: string;
  fixRefused?: string;
  revertPrUrl?: string;
  revertRefused?: string;
  resolved: boolean;
}

/** W1-T6403 — every offending merge this lane has acted on, keyed by its sha. The ledger, not
 *  memory, is the dedupe: a restarted daemon must not open a second fix PR for the same merge. */
export function mainRepairRecordsFromLedger(lines: readonly Record<string, unknown>[]): Map<string, MainRepairRecord> {
  const records = new Map<string, MainRepairRecord>();
  for (const line of lines) {
    const sha = line.offending_sha;
    if (typeof line.step !== "string" || !line.step.startsWith("main.repair.") || typeof sha !== "string") continue;
    const record = records.get(sha);
    if (line.step === "main.repair.located") {
      if (!record || record.resolved) {
        records.set(sha, {
          offendingSha: sha,
          ...(typeof line.offending_pr === "number" ? { offendingPr: line.offending_pr } : {}),
          failingChecks: Array.isArray(line.failing_checks) ? line.failing_checks.map(String) : [],
          fixDispatched: false,
          resolved: false,
        });
      }
      continue;
    }
    if (!record) continue;
    if (line.step === "main.repair.fix_dispatched") record.fixDispatched = true;
    else if (line.step === "main.repair.fix_opened") record.fixPrUrl = String(line.pr_url);
    else if (line.step === "main.repair.fix_refused") record.fixRefused = String(line.reason);
    else if (line.step === "main.repair.revert_opened") record.revertPrUrl = String(line.pr_url);
    else if (line.step === "main.repair.revert_refused") record.revertRefused = String(line.reason);
    else if (line.step === "main.repair.resolved") record.resolved = true;
  }
  return records;
}

function pullNumberOf(prUrl: string): string {
  const n = /\/pull\/(\d+)/.exec(prUrl)?.[1];
  if (!n) throw new Error(`not a pull request url: ${prUrl}`);
  return n;
}

/** PRIMARY CONTROL: characters of the failing checks' log tails a fix worker is handed. */
export const MAIN_REPAIR_LOG_EXCERPT_CHARS = 4000;

function logExcerptOf(failures: readonly CiFailure[], failingChecks: readonly string[]): string {
  const text = failures
    .filter((failure) => failingChecks.includes(failure.name))
    .map((failure) => `--- ${failure.name} ---\n${failure.logTail}`)
    .join("\n");
  return text.slice(-MAIN_REPAIR_LOG_EXCERPT_CHARS);
}

/** W1-T5806 — the git questions {@link findMetPrs} asks. Every answer is awaited. */
export interface MainHealthMergeReader {
  /** The PR whose merge produced `sha`, that PR's last head and the merge's first parent; undefined
   *  when `sha` is no PR merge. */
  prMerge(sha: string): Awaitable<{ number: number; headSha: string; parentSha: string } | undefined>;
  mergeBase(a: string, b: string): Awaitable<string>;
  /** The PRs merged on main after `base`, up to and including `tip`. */
  prsMergedBetween(base: string, tip: string): Awaitable<readonly number[]>;
}

/** W1-T5806 — a red PR merge (A) and the PRs merged after the base A's CI ran on that share a path. */
export interface MetPrs {
  mergeSha: string;
  ciBaseSha: string;
  redPr: number;
  metPrs: number[];
  sharedPaths: string[];
}

type MetPrLookup = { met?: MetPrs; unreadable?: string };

/** BACKSTOP: PR file lists one red head may read. The window between a PR's CI base and its merge
 *  is normally a handful of merges; past this the lookup gives up and today's escalation stands. */
export const MAIN_HEALTH_MET_PR_LIMIT = 20;

function squashPrNumber(message: unknown): number | undefined {
  const subject = String(message ?? "").split("\n")[0] ?? "";
  const n = /\(#(\d+)\)\s*$/.exec(subject)?.[1];
  return n === undefined ? undefined : Number(n);
}

interface RestCommit {
  commit?: { message?: unknown };
  parents?: ReadonlyArray<{ sha?: unknown }>;
}

/** The production {@link MainHealthMergeReader}: GitHub's commit, PR and compare reads over the same
 *  awaited `fetch` the rung already uses. Main squash-merges, so a `(#N)` subject names the PR. */
function restMergeReader(owner: string, repo: string, fetch: GhApiFetcher): MainHealthMergeReader {
  const base = `repos/${owner}/${repo}`;
  return {
    prMerge: async (sha) => {
      const commit = (await fetch(["api", `${base}/commits/${sha}`])) as RestCommit;
      const number = squashPrNumber(commit?.commit?.message);
      if (number === undefined) return undefined;
      const pr = (await fetch(["api", `${base}/pulls/${number}`])) as { head?: { sha?: unknown } };
      return {
        number,
        headSha: requiredString(pr?.head?.sha, `PR #${number} head sha`),
        parentSha: requiredString(commit?.parents?.[0]?.sha, "merge parent sha"),
      };
    },
    mergeBase: async (a, b) => {
      const compare = (await fetch(["api", `${base}/compare/${b}...${a}?per_page=1`])) as { merge_base_commit?: { sha?: unknown } };
      return requiredString(compare?.merge_base_commit?.sha, "merge base sha");
    },
    prsMergedBetween: async (from, tip) => {
      const compare = (await fetch(["api", `${base}/compare/${from}...${tip}?per_page=100`])) as {
        total_commits?: unknown;
        commits?: ReadonlyArray<RestCommit>;
      };
      const commits = compare?.commits ?? [];
      if (typeof compare?.total_commits === "number" && compare.total_commits > commits.length) {
        throw new Error(`compare ${from}...${tip} read ${commits.length} of ${compare.total_commits} commits`);
      }
      return commits.map((c) => squashPrNumber(c.commit?.message)).filter((n): n is number => n !== undefined);
    },
  };
}

/** W1-T5806 — when `sha` is PR A's merge, the PRs merged on main between A's CI base (A's head's
 *  merge-base with main) and A's merge whose changed paths intersect A's. Throws on any failed read. */
async function findMetPrs(
  sha: string,
  reader: MainHealthMergeReader,
  readPrFiles: NonNullable<MainHealthRungDeps["readPrFiles"]>,
): Promise<MetPrs | undefined> {
  const merge = await reader.prMerge(sha);
  if (!merge) return undefined;
  const ciBaseSha = await reader.mergeBase(merge.headSha, merge.parentSha);
  const between = [...new Set(await reader.prsMergedBetween(ciBaseSha, merge.parentSha))].filter((n) => n !== merge.number);
  if (between.length === 0) return undefined;
  if (between.length > MAIN_HEALTH_MET_PR_LIMIT) {
    throw new Error(`${between.length} merges since PR #${merge.number}'s CI base, more than ${MAIN_HEALTH_MET_PR_LIMIT}`);
  }
  const filesOf = async (n: number): Promise<readonly string[]> => {
    const files = await readPrFiles(n);
    if (!files || files.length === 0) throw new Error(`PR #${n} has no readable file list`);
    return files;
  };
  const own = new Set(await filesOf(merge.number));
  const metPrs: number[] = [];
  const shared = new Set<string>();
  for (const n of between) {
    const overlap = (await filesOf(n)).filter((path) => own.has(path));
    if (overlap.length === 0) continue;
    metPrs.push(n);
    for (const path of overlap) shared.add(path);
  }
  if (metPrs.length === 0) return undefined;
  return { mergeSha: sha, ciBaseSha, redPr: merge.number, metPrs: metPrs.sort((a, b) => a - b), sharedPaths: [...shared].sort() };
}

function metPrFields(lookup: MetPrLookup | undefined): Record<string, unknown> {
  if (lookup?.met) {
    return { red_pr: lookup.met.redPr, met_prs: lookup.met.metPrs, shared_paths: lookup.met.sharedPaths };
  }
  return lookup?.unreadable ? { met_prs_unreadable: lookup.unreadable } : {};
}

function judgedRollup(rollup: readonly RollupCheckEntry[], required: ReadonlySet<string>): RollupCheckEntry[] {
  return required.size === 0
    ? [...rollup]
    : rollup.filter((c) => required.has(c.name ?? "") || required.has(c.context ?? ""));
}

interface RepoMetadata {
  default_branch?: unknown;
}

interface CommitMetadata {
  sha?: unknown;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`GitHub response omitted ${field}`);
  }
  return value;
}

interface WorkflowRunHistoryResponse {
  workflow_runs?: ReadonlyArray<{
    id?: unknown;
    name?: unknown;
    head_sha?: unknown;
    status?: unknown;
    conclusion?: unknown;
    html_url?: unknown;
    pull_requests?: ReadonlyArray<{ number?: unknown; html_url?: unknown; url?: unknown }>;
  }>;
}

/** W1-T6023: no `status=completed` filter. With it, GitHub sometimes answered with a days-old page
 *  (2026-10-06: runs from 09-28 at 13:46Z) where the unfiltered call returned that hour's runs;
 *  completed runs are kept client-side in {@link mainPushRunHistoryFromResponse} instead. */
export function mainPushRunHistoryRestArgs(owner: string, repo: string, branch: string): string[] {
  return ["api", `repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&event=push&per_page=100`];
}

export function fetchMainPushRunHistory(
  owner: string,
  repo: string,
  branch: string,
  fetch: GhApiFetcher,
): MainHealthRunHistoryEntry[] {
  return mainPushRunHistoryFromResponse(fetch(mainPushRunHistoryRestArgs(owner, repo, branch)) as WorkflowRunHistoryResponse);
}

function mainPushRunHistoryFromResponse(response: WorkflowRunHistoryResponse): MainHealthRunHistoryEntry[] {
  return (response.workflow_runs ?? [])
    .map((run): MainHealthRunHistoryEntry | undefined => {
      if (typeof run.head_sha !== "string" || run.head_sha.trim() === "") return undefined;
      // W1-T6023: a queued or running run concluded nothing. A run with no `status` field at all is
      // kept: it decides nothing anyway unless it carries a `conclusion`.
      if (typeof run.status === "string" && run.status !== "completed") return undefined;
      const pullRequests = (run.pull_requests ?? [])
        .map((pr) => ({
          ...(typeof pr.number === "number" ? { number: pr.number } : {}),
          ...(typeof pr.html_url === "string" ? { url: pr.html_url } : typeof pr.url === "string" ? { url: pr.url } : {}),
        }))
        .filter((pr) => pr.number !== undefined || pr.url !== undefined);
      return {
        headSha: run.head_sha,
        ...(typeof run.name === "string" ? { workflowName: run.name } : {}),
        ...(typeof run.id === "number" ? { runId: run.id } : {}),
        ...(typeof run.conclusion === "string" ? { conclusion: run.conclusion } : {}),
        ...(typeof run.html_url === "string" ? { url: run.html_url } : {}),
        ...(pullRequests.length > 0 ? { pullRequests } : {}),
      };
    })
    .filter((run): run is MainHealthRunHistoryEntry => run !== undefined);
}

interface FirstParentCommit {
  sha?: unknown;
  parents?: ReadonlyArray<{ sha?: unknown }>;
}

/** W1-T6023 — main's newest {@link MAIN_HEALTH_FALLBACK_WINDOW_COMMITS} first-parent shas, `headSha`
 *  first, walked through one `commits?sha=` page by each commit's first parent. The page is 100, not
 *  N, so a second-parent commit interleaved by date cannot cut the walk short. A page that is not a
 *  list, or does not hold the head, throws: a window that was not read admits no run. */
async function readMainFirstParentWindow(
  owner: string,
  repo: string,
  headSha: string,
  fetch: GhApiFetcher,
): Promise<ReadonlySet<string>> {
  const page = await fetch(["api", `repos/${owner}/${repo}/commits?sha=${headSha}&per_page=100`]);
  if (!Array.isArray(page)) throw new Error("GitHub's commit list for main's head was not a list");
  const parentOf = new Map<string, unknown>(
    (page as FirstParentCommit[]).map((commit) => [String(commit?.sha), commit?.parents?.[0]?.sha]),
  );
  if (!parentOf.has(headSha)) throw new Error(`GitHub's commit list did not hold main's head ${headSha}`);
  const window = new Set<string>();
  let at: unknown = headSha;
  while (typeof at === "string" && parentOf.has(at) && window.size < MAIN_HEALTH_FALLBACK_WINDOW_COMMITS) {
    window.add(at);
    at = parentOf.get(at);
  }
  return window;
}

interface WorkflowJobsResponse {
  jobs?: ReadonlyArray<{
    id?: unknown;
    name?: unknown;
    status?: unknown;
    conclusion?: unknown;
    html_url?: unknown;
    started_at?: unknown;
    completed_at?: unknown;
  }>;
}

/** W1-T5490 — one completed run's jobs, shaped as rollup entries so the same judgment and the same
 *  job-id evidence reader ({@link checkJobId} via `externalId`) apply to fallback evidence. */
function rollupFromJobs(response: WorkflowJobsResponse | undefined): RollupCheckEntry[] {
  return (response?.jobs ?? []).map((job) => ({
    name: typeof job.name === "string" ? job.name : "",
    ...(typeof job.status === "string" && job.status !== "" ? { status: job.status.toUpperCase() } : {}),
    ...(typeof job.conclusion === "string" && job.conclusion !== "" ? { conclusion: job.conclusion.toUpperCase() } : {}),
    ...(typeof job.html_url === "string" ? { detailsUrl: job.html_url } : {}),
    ...(typeof job.id === "number" ? { externalId: `job:${job.id}` } : {}),
    ...(typeof job.started_at === "string" ? { startedAt: job.started_at } : {}),
    ...(typeof job.completed_at === "string" ? { completedAt: job.completed_at } : {}),
  }));
}

/** W1-T5843: the diagnosis the decision composed after `observation.reason` — the failing test titles
 *  and the first red push run with the merged PR that produced it — as ` <line>. <line>.`, or "".
 *  The `(<url>)` the decision prints after `PR #N` is dropped: a `/pull/` URL in an issue body is read
 *  by the escalation reconciler as the issue's referent, and that PR is already merged. */
function operatorDetailOf(observation: MainHealthObservation, decisionReason: string): string {
  const marker = `: ${observation.reason}.`;
  const at = decisionReason.indexOf(marker);
  if (at < 0) return "";
  return decisionReason
    .slice(at + marker.length)
    .replace(/ \(\S*\/pull\/\d+[^\s)]*\)/g, "")
    .trimEnd();
}

/** W1-T5806: a met escalation names PRs as `PR #N`, never a `/pull/` URL — the escalation reconciler
 *  reads a URL as the issue's referent and would retire it as soon as it saw that PR merged. */
export function escalationFor(observation: MainHealthObservation, branch: string, met?: MetPrs): Escalation {
  const decision = mainHealthEscalationDecision(observation);
  if (!decision.escalate || !decision.class) {
    throw new Error(`refusing to build a main-health escalation for ${observation.state}`);
  }
  const diagnosis = operatorDetailOf(observation, decision.reason);
  const metNames = met?.metPrs.map((n) => `PR #${n}`).join(", ");
  return {
    class: decision.class,
    taskId: MAIN_HEALTH_TASK_ID,
    runId: undefined,
    headSha: met ? met.mergeSha : observation.sha,
    summary: met ? `main is red where PR #${met.redPr} met ${metNames}` : "main's own check suite is red",
    detail:
      (met
        ? `PR #${met.redPr} merged as \`${met.mergeSha}\`; its CI ran on \`${met.ciBaseSha}\`, before ${metNames} ` +
          `merged, and they share ${met.sharedPaths.map((path) => `\`${path}\``).join(", ")}. Each passed CI alone. `
        : "") +
      `The default branch \`${branch}\` at \`${observation.sha}\` is red. ${observation.reason}.${diagnosis} ` +
      "This observer never auto-reverts or pauses unrelated dispatch: when it locates the first red " +
      "merge it opens one priority fix PR and, if main stays red, one revert PR of that merge, each " +
      "judged by review and CI like any PR (W1-T6403); this issue means that lane could not locate, " +
      "fix or revert. An explicit operator ruling is required to hold the queue. The automatic PR " +
      "repair and update paths remain active.",
    options: [
      {
        label: "let automatic repair continue",
        detail: "Keep the queue moving while Remudero updates or repairs work that inherited the failing baseline.",
        kind: { type: "operator-only" },
      },
      {
        label: "place a queue hold",
        detail: "Record an operator hold if continuing dispatch would compound this specific trunk failure.",
        kind: { type: "operator-only" },
      },
    ],
    recommendation: "let automatic repair continue",
  };
}

function isMainHealthIssue(issue: OpenIssue): boolean {
  return /^\*\*Task:\*\*\s+MAIN-HEALTH\s*$/m.test(issue.body ?? "");
}

/**
 * Build the default-branch observer once per daemon process, then invoke it from settled check
 * events and every FULL sweep. The branch name is stable enough to cache for that process; the
 * head SHA and its rollup are re-read after the brief event-settlement freshness window. All
 * errors are named and swallowed here so neither GitHub nor issue transport can stop the PR
 * reconciler that follows this rung.
 */
export function buildMainHealthRung(
  owner: string,
  repo: string,
  deps: MainHealthRungDeps,
): () => Promise<void> {
  let defaultBranch: string | undefined;
  let escalatedSignature: string | undefined;
  let resolvedSignature: string | undefined;
  let lastSuccessfulObservationAtMs: number | undefined;
  let inFlight: Promise<void> | undefined;
  let runHistoryCache: RunHistoryCache | undefined;
  let metPrCache: { sha: string; lookup: MetPrLookup } | undefined;
  const mergeReader = deps.mergeReader ?? restMergeReader(owner, repo, deps.fetch);
  const readPrFiles =
    deps.readPrFiles ??
    (async (n: number) => {
      const rows = (await deps.fetch(prFilesRestArgs(owner, repo, n))) as ReadonlyArray<{ filename?: unknown }> | undefined;
      return (Array.isArray(rows) ? rows : []).map((row) => row.filename).filter((f): f is string => typeof f === "string");
    });
  const freshMs = Math.max(0, deps.freshMs ?? 0);
  const now = deps.now ?? Date.now;

  // W1-T6403 — the red-main repair lane: locate the offending merge, open ONE fix PR for it, then ONE
  // revert PR if main stays red, then close out once main is green on its own head. The ledger rows
  // are the dedupe across daemon restarts; the stall counters below are this process's own.
  let repairedSignature: string | undefined;
  let repairsMayBeActive = true;
  const fixInFlight = new Set<string>();
  const fixProgress = new Map<string, { marker: string; ticks: number; sinceMs: number }>();
  const repairRow = (step: string, fields: Record<string, unknown>): void => {
    appendLedger(deps.ledgerPath, { run_id: deps.runId, task_id: MAIN_HEALTH_TASK_ID, step, surface: "main", ...fields });
    repairsMayBeActive = true;
  };
  const readRepairPr = async (prUrl: string): Promise<MainRepairPr | undefined> => {
    try {
      if (deps.repair?.readPr) return await deps.repair.readPr(prUrl);
      const pr = (await deps.fetch(["api", `repos/${owner}/${repo}/pulls/${pullNumberOf(prUrl)}`])) as {
        state?: unknown;
        merged?: unknown;
        head?: { sha?: unknown };
      };
      const state = pr?.merged === true ? "merged" : pr?.state === "closed" ? "closed" : pr?.state === "open" ? "open" : undefined;
      if (!state) throw new Error(`GitHub's read of ${prUrl} carried no state`);
      return { state, ...(typeof pr.head?.sha === "string" ? { headSha: pr.head.sha } : {}) };
    } catch (error) {
      // An unreadable repair PR decides nothing this observation: no revert or close-out on a guess.
      deps.log("main.repair.pr_unreadable", { pr_url: prUrl, error: String((error as Error)?.message ?? error) });
      return undefined;
    }
  };
  const closeRepairPr = async (prUrl: string, comment: string): Promise<void> => {
    if (deps.repair?.closePr) return deps.repair.closePr(prUrl, comment);
    const n = pullNumberOf(prUrl);
    await deps.fetch(["api", "--method", "POST", `repos/${owner}/${repo}/issues/${n}/comments`, "-f", `body=${comment}`]);
    await deps.fetch(["api", "--method", "PATCH", `repos/${owner}/${repo}/pulls/${n}`, "-f", "state=closed"]);
  };
  const diffStatOf = async (sha: string): Promise<string> => {
    try {
      const commit = (await deps.fetch(["api", `repos/${owner}/${repo}/commits/${sha}`])) as {
        files?: ReadonlyArray<{ filename?: unknown; additions?: unknown; deletions?: unknown }>;
      };
      const lines = (commit?.files ?? []).map((f) => ` ${String(f.filename)} | +${Number(f.additions ?? 0)} -${Number(f.deletions ?? 0)}`);
      return lines.length > 0 ? lines.join("\n") : "(GitHub's commit read listed no files)";
    } catch (error) {
      return `(diff stat unreadable: ${String((error as Error)?.message ?? error)})`;
    }
  };
  /** The fix worker runs for minutes, so it is never awaited here: its outcome lands as a ledger row. */
  const dispatchFix = (lane: MainRepairLane, request: MainRepairFixRequest): void => {
    const at = { offending_sha: request.offendingSha, offending_pr: request.offendingPr };
    repairRow("main.repair.fix_dispatched", { ...at, head_sha: request.headSha, failing_checks: request.failingChecks });
    fixInFlight.add(request.offendingSha);
    void Promise.resolve()
      .then(() => lane.openFixPr(request))
      .then(
        (prUrl) =>
          prUrl
            ? repairRow("main.repair.fix_opened", { ...at, pr_url: prUrl })
            : repairRow("main.repair.fix_refused", { ...at, reason: "the fix run opened no pull request" }),
        (error) => repairRow("main.repair.fix_refused", { ...at, reason: String((error as Error)?.message ?? error) }),
      )
      .catch((error) => deps.log("main.repair.error", { ...at, error: String((error as Error)?.message ?? error) }))
      .finally(() => fixInFlight.delete(request.offendingSha));
  };
  /** A stall reason once the same fix-PR marker has held for the tick and time windows, else undefined. */
  const stallOf = (sha: string, marker: string, atMs: number, what: string): string | undefined => {
    const prior = fixProgress.get(sha);
    if (!prior || prior.marker !== marker) {
      fixProgress.set(sha, { marker, ticks: 0, sinceMs: atMs });
      return undefined;
    }
    prior.ticks += 1;
    const quietMs = atMs - prior.sinceMs;
    if (prior.ticks < MAIN_REPAIR_STALL_TICKS || quietMs < MAIN_REPAIR_STALL_MS) return undefined;
    return `${what} made no progress (no new head, no merge) across ${prior.ticks} red observations and ${Math.round(quietMs / 60_000)} minutes`;
  };
  /** One step of an existing repair. True while the lane still owns this red; false when it was refused. */
  const advanceRepair = async (lane: MainRepairLane, record: MainRepairRecord, sha: string, branch: string, atMs: number): Promise<boolean> => {
    if (record.revertRefused) return false;
    if (record.revertPrUrl) return (await readRepairPr(record.revertPrUrl))?.state !== "closed";
    if (fixInFlight.has(record.offendingSha)) return true;
    let stalled: string | undefined;
    if (record.fixPrUrl) {
      const fix = await readRepairPr(record.fixPrUrl);
      if (!fix) return true;
      stalled =
        fix.state === "closed"
          ? `fix PR ${record.fixPrUrl} closed unmerged while main stayed red`
          : stallOf(record.offendingSha, `${fix.state}:${fix.headSha ?? ""}`, atMs, `fix PR ${record.fixPrUrl}`);
    } else if (record.fixRefused) {
      stalled = `the fix run opened no fix PR: ${record.fixRefused}`;
    } else {
      stalled = stallOf(record.offendingSha, "no-pr", atMs, "the fix run, dispatched before this daemon process started,");
    }
    if (!stalled) return true;
    const at = { offending_sha: record.offendingSha, offending_pr: record.offendingPr, head_sha: sha };
    let outcome: MainRepairRevertOutcome;
    try {
      outcome = await lane.openRevertPr({
        branch,
        headSha: sha,
        offendingSha: record.offendingSha,
        ...(record.offendingPr !== undefined ? { offendingPr: record.offendingPr } : {}),
        failingChecks: record.failingChecks,
        ...(record.fixPrUrl ? { fixPrUrl: record.fixPrUrl } : {}),
        whyFixInsufficient: stalled,
      });
    } catch (error) {
      outcome = { refused: String((error as Error)?.message ?? error) };
    }
    if ("prUrl" in outcome) {
      repairRow("main.repair.revert_opened", { ...at, pr_url: outcome.prUrl, fix_pr_url: record.fixPrUrl, reason: stalled });
      return true;
    }
    repairRow("main.repair.revert_refused", { ...at, reason: outcome.refused, conflict_paths: outcome.conflictPaths ?? [] });
    return false;
  };
  /** Locate the offending merge and open its fix PR, or advance the repair already under way. */
  const repairRedMain = async (
    lane: MainRepairLane,
    observation: MainHealthObservation,
    sha: string,
    branch: string,
    failures: readonly CiFailure[],
    atMs: number,
  ): Promise<boolean> => {
    const records = mainRepairRecordsFromLedger(readLedgerLines(deps.ledgerPath));
    const first = observation.firstRedCommit;
    const active = [...records.values()].filter((record) => !record.resolved);
    const record = first ? active.find((r) => r.offendingSha === first.headSha) : active[active.length - 1];
    if (record) return advanceRepair(lane, record, sha, branch, atMs);
    if (!first) {
      repairRow("main.repair.unlocated", {
        head_sha: sha,
        failing_checks: observation.failingChecks,
        reason: observation.runHistoryWindowExhausted
          ? "main's push run history window holds no green run to bound the red streak"
          : "main's push run history names no first red merge after a green run",
      });
      return false;
    }
    const offendingPr = first.pullRequest?.number;
    const testFiles = baseReproductionFiles(failures);
    repairRow("main.repair.located", {
      head_sha: sha,
      offending_sha: first.headSha,
      offending_pr: offendingPr,
      failing_checks: observation.failingChecks,
      test_files: testFiles,
      method: "first-red-run",
    });
    dispatchFix(lane, {
      branch,
      headSha: sha,
      offendingSha: first.headSha,
      ...(offendingPr !== undefined ? { offendingPr } : {}),
      diffStat: await diffStatOf(first.headSha),
      failingChecks: [...observation.failingChecks],
      failingTestTitles: [...(observation.failingTestTitles ?? [])],
      testFiles,
      logExcerpt: logExcerptOf(failures, observation.failingChecks),
      reason: observation.reason,
    });
    return true;
  };
  /** Main is green on its own head: every open repair is resolved, and its still-open PRs closed. */
  const resolveRepairs = async (sha: string): Promise<void> => {
    if (!repairsMayBeActive) return;
    let pending = false;
    for (const record of mainRepairRecordsFromLedger(readLedgerLines(deps.ledgerPath)).values()) {
      if (record.resolved) continue;
      if (fixInFlight.has(record.offendingSha)) {
        pending = true;
        continue;
      }
      const fix = record.fixPrUrl ? await readRepairPr(record.fixPrUrl) : undefined;
      const revert = record.revertPrUrl ? await readRepairPr(record.revertPrUrl) : undefined;
      const by = revert?.state === "merged" ? "revert" : fix?.state === "merged" ? "fix" : "other";
      const closed: string[] = [];
      for (const [url, pr] of [[record.fixPrUrl, fix], [record.revertPrUrl, revert]] as const) {
        if (!url || pr?.state !== "open") continue;
        await closeRepairPr(
          url,
          `Closed by the red-main repair lane (W1-T6403): \`${owner}/${repo}\` is green on its own head \`${sha}\` ` +
            `again (resolved by ${by}), so this repair of \`${record.offendingSha}\` is redundant.`,
        );
        closed.push(url);
      }
      repairRow("main.repair.resolved", { offending_sha: record.offendingSha, head_sha: sha, by, closed_prs: closed });
      fixProgress.delete(record.offendingSha);
    }
    repairsMayBeActive = pending;
  };

  const observe = async (startedAtMs: number): Promise<void> => {
    try {
      if (!defaultBranch) {
        const metadata = (await deps.fetch(["api", `repos/${owner}/${repo}`])) as RepoMetadata;
        defaultBranch = requiredString(metadata?.default_branch, "default_branch");
      }
      const branch = defaultBranch;
      const commit = (await deps.fetch([
        "api",
        `repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
      ])) as CommitMetadata;
      const sha = requiredString(commit?.sha, "default branch head sha");
      const rollup = await rollupForAsync(owner, repo, sha, deps.fetch);
      const required = new Set(deps.readRequiredChecks?.() ?? []);
      const judgedAgainst = required.size > 0 ? required : undefined;
      const judging = { cancelledIsPending: true } as const;
      let observation = mainHealthFromRollup(sha, rollup, judgedAgainst, undefined, judging);
      // W1-T4472 (ii): applied BEFORE `advisoryFailing` is derived below, so a red main-tripwire
      // (never itself in `required`) is counted once, as a genuine failing check, rather than also
      // spilling into the advisory list `mainHealthFromRollup(sha, rollup, undefined)` would
      // otherwise place it on.
      observation = withTripwireOverride(observation, rollup);
      // W1-T5490: the completed push-run history is shared with the red-path enrichment below: it
      // supplies fallback evidence and the guard workflows' verdicts. W1-T5630: it is read once per
      // head (see {@link runHistoryCacheKey}) and reused until MAIN_HEALTH_RUN_HISTORY_TTL_MS, aged
      // on the injected clock; a negative age (a clock stepping back) or an unreadable read refetches.
      let runHistory: MainHealthRunHistoryEntry[] | undefined;
      let runHistoryUnavailable: string | undefined;
      const cacheKey = runHistoryCacheKey(sha, rollup);
      const cacheAgeMs = startedAtMs - (runHistoryCache?.readAtMs ?? Number.NaN);
      const cacheHit =
        runHistoryCache?.key === cacheKey && cacheAgeMs >= 0 && cacheAgeMs < MAIN_HEALTH_RUN_HISTORY_TTL_MS;
      if (cacheHit) {
        runHistory = runHistoryCache!.history;
      } else {
        runHistoryCache = undefined;
        try {
          const readMainRunHistory =
            deps.readMainRunHistory ??
            (async (branchName: string) =>
              mainPushRunHistoryFromResponse(
                (await deps.fetch(mainPushRunHistoryRestArgs(owner, repo, branchName))) as WorkflowRunHistoryResponse,
              ));
          runHistory = await readMainRunHistory(branch);
          if (runHistory === undefined) runHistoryUnavailable = "the main push run-history reader returned no evidence";
          else runHistoryCache = { key: cacheKey, readAtMs: startedAtMs, history: runHistory, jobsByRunId: new Map() };
        } catch (error) {
          runHistoryUnavailable = String((error as Error)?.message ?? error);
          deps.log("main.health.run_history_unreadable", {
            branch,
            sha,
            error: String((error as Error)?.message ?? error),
          });
        }
      }
      // W1-T5490 (a): a head whose required runs were all cancelled by the next push, or are still
      // pending, concluded nothing — the latest COMPLETED main run that carries required checks
      // decides instead. `decidedBySha` names which commit's evidence the verdict rests on.
      let decidedBySha = sha;
      let evidenceRollup: readonly RollupCheckEntry[] = rollup;
      // W1-T6023: and only a run whose head is one of main's newest first-parent commits may decide.
      // A window that was not read, or a history holding only older runs, leaves main undetermined.
      let recentShas = runHistoryCache?.recentShas;
      const guardNeedsWindow = runHistory && mainGuardFailureCandidates(runHistory).length > 0;
      if (runHistory && !recentShas && (guardNeedsWindow ||
        (mainHealthHeadInconclusive(observation) && mainHealthFallbackCandidates(runHistory).length > 0))) {
        try {
          recentShas = await readMainFirstParentWindow(owner, repo, sha, deps.fetch);
          if (runHistoryCache) runHistoryCache.recentShas = recentShas;
        } catch (error) {
          const message = String((error as Error)?.message ?? error);
          deps.log("main.health.recent_commits_unreadable", { branch, sha, error: message });
          observation = {
            ...observation,
            reason:
              `${observation.reason}; main's last ${MAIN_HEALTH_FALLBACK_WINDOW_COMMITS} first-parent commits were not ` +
              `read (${message}), so no completed main run may decide`,
          };
        }
      }
      if (runHistory && recentShas && mainHealthHeadInconclusive(observation)) {
        const { runs, skipped } = mainHealthFallbackRuns(runHistory, recentShas);
        let decided = false;
        for (const run of runs) {
          let jobs: RollupCheckEntry[];
          try {
            jobs =
              runHistoryCache?.jobsByRunId.get(run.runId!) ??
              rollupFromJobs(
                (await deps.fetch(["api", `repos/${owner}/${repo}/actions/runs/${run.runId}/jobs?per_page=100`])) as WorkflowJobsResponse,
              );
            runHistoryCache?.jobsByRunId.set(run.runId!, jobs);
          } catch (error) {
            deps.log("main.health.completed_run_unreadable", {
              branch,
              sha,
              run_sha: run.headSha,
              run_id: run.runId,
              error: String((error as Error)?.message ?? error),
            });
            break;
          }
          if (judgedRollup(jobs, required).length === 0) continue;
          const fallback = mainHealthFromRollup(sha, jobs, judgedAgainst, undefined, judging);
          observation = {
            ...fallback,
            reason: `main's head has no completed required run; the latest completed main run (${run.headSha}) decides: ${fallback.reason}`,
          };
          decidedBySha = run.headSha;
          evidenceRollup = jobs;
          decided = true;
          break;
        }
        if (!decided && skipped.length > 0) {
          observation = {
            ...observation,
            reason:
              `${observation.reason}; no completed main run among main's last ${MAIN_HEALTH_FALLBACK_WINDOW_COMMITS} ` +
              `first-parent commits decides, and the newest older run skipped is for ${skipped[0]!.headSha}`,
          };
        }
      }
      // W1-T5490 (a): a failed guard workflow reads main red even beside green required checks.
      const { runs: guardFailures, skipped: skippedGuards } = runHistory && recentShas
        ? failedMainGuardRuns(runHistory, recentShas)
        : { runs: [], skipped: [] };
      if (skippedGuards.length > 0) {
        observation = {
          ...observation,
          reason: `${observation.reason}; main guard verdict for ${skippedGuards[0]!.headSha} skipped outside ` +
            `main's last ${MAIN_HEALTH_FALLBACK_WINDOW_COMMITS} first-parent commits`,
        };
      }
      if (guardFailures.length > 0) {
        const guardNames = guardFailures.map((run) => run.workflowName!);
        if (observation.state !== "red") decidedBySha = guardFailures[0]!.headSha;
        observation = {
          ...observation,
          state: "red",
          reason: `main guard workflow(s) failed on main: ${guardNames.join(", ")}${observation.state === "red" || skippedGuards.length > 0 ? `; ${observation.reason}` : ""}`,
          failingChecks: [...observation.failingChecks, ...guardNames.filter((name) => !observation.failingChecks.includes(name))],
        };
      }
      // EVERY check on the deciding run, judged alike: the advisory list and `decideBaseRed`'s census.
      const everyCheck = mainHealthFromRollup(decidedBySha, evidenceRollup, undefined, undefined, judging);
      const advisoryFailing =
        required.size === 0 ? [] : everyCheck.failingChecks.filter((name) => !observation.failingChecks.includes(name));
      // Only CONCLUDED checks are a census `decideBaseRed` may read: a pending or skipped one is
      // not evidence that main ran it green. The census spans EVERY check, not only ci-gate's
      // required aggregates: a PR's red names a shard ("coverage-shard (2/8)") that the required
      // set ("ci", "test-slow") never names, so a required-only census read every shard red "absent"
      // and held it as main's whenever main was red for any reason (2026-10-10, eight PRs held on
      // dbca9031a, whose only failing shard was test-slow-shard (2/2)).
      const notConcluded = new Set([
        ...observation.pendingChecks, ...observation.nonEvidenceChecks,
        ...everyCheck.pendingChecks, ...everyCheck.nonEvidenceChecks,
      ]);
      const observedChecks = [
        ...new Set([
          ...[...judgedRollup(evidenceRollup, required), ...evidenceRollup]
            .map((c) => c.name ?? c.context ?? "unknown")
            .filter((name) => !notConcluded.has(name)),
          ...observation.failingChecks,
          ...advisoryFailing,
        ]),
      ];
      // W1-T5806: read once per red head; a failed read is named here and changes no escalation.
      if (observation.state === "red" && metPrCache?.sha !== decidedBySha) {
        let lookup: MetPrLookup;
        try {
          const met = await findMetPrs(decidedBySha, mergeReader, readPrFiles);
          lookup = met ? { met } : {};
        } catch (error) {
          lookup = { unreadable: String((error as Error)?.message ?? error) };
        }
        metPrCache = { sha: decidedBySha, lookup };
      }
      const metLookup = observation.state === "red" ? metPrCache?.lookup : undefined;
      deps.log("main.health.observed", {
        branch,
        sha,
        state: observation.state,
        reason: observation.reason,
        failing_checks: observation.failingChecks,
        observed_checks: observedChecks,
        decided_by_sha: decidedBySha,
        pending_checks: observation.pendingChecks,
        non_evidence_checks: observation.nonEvidenceChecks,
        judged_against: required.size > 0 ? "ci-gate-required" : "all-checks",
        run_history_source: cacheHit ? "cache" : "fetched",
        ...(advisoryFailing.length > 0 ? { advisory_failing_checks: [...advisoryFailing].sort() } : {}),
        ...metPrFields(metLookup),
      });

      if (observation.state === "red") {
        resolvedSignature = undefined;
        const signature = `${sha}:${[...observation.failingChecks].sort().join(",")}`;
        if (signature === escalatedSignature) {
          lastSuccessfulObservationAtMs = startedAtMs;
          return;
        }
        // W1-T6403: the same red the lane already owns re-reads no CI log; it only advances the repair.
        if (signature === repairedSignature && deps.repair) {
          if (await repairRedMain(deps.repair, observation, sha, branch, [], startedAtMs)) {
            lastSuccessfulObservationAtMs = startedAtMs;
            return;
          }
          repairedSignature = undefined;
        }
        let failures: CiFailure[] | undefined;
        let ciFailuresUnavailable: string | undefined;
        // W1-T4472: `main-tripwire` is never in `required` (it is not a ci-gate-required check),
        // so `judgedRollup(rollup, required)` alone would filter its entry out and the evidence
        // reader below would never fetch its job log — the "named failing suites" design (ii)
        // calls for. Widened ONLY when the tripwire is actually part of this red verdict, and
        // ONLY when `required` is non-empty (an empty `required` already reads every check).
        const evidenceRequired =
          required.size > 0 && observation.failingChecks.includes(MAIN_TRIPWIRE_CHECK_NAME)
            ? new Set([...required, MAIN_TRIPWIRE_CHECK_NAME])
            : required;
        try {
          failures = deps.readCiFailures ? await deps.readCiFailures(judgedRollup(evidenceRollup, evidenceRequired)) : undefined;
          if (!deps.readCiFailures) ciFailuresUnavailable = "no CI failure reader configured";
          if (deps.readCiFailures && failures === undefined) ciFailuresUnavailable = "the CI failure reader returned no evidence";
        } catch (error) {
          ciFailuresUnavailable = String((error as Error)?.message ?? error);
          deps.log("main.health.ci_evidence_unreadable", {
            branch,
            sha,
            error: String((error as Error)?.message ?? error),
          });
        }
        observation = enrichMainHealthObservation(observation, {
          ...(failures ? { ciFailures: failures } : {}),
          ...(ciFailuresUnavailable ? { ciFailuresUnavailable } : {}),
          ...(runHistory ? { runHistory } : {}),
          ...(runHistoryUnavailable ? { runHistoryUnavailable } : {}),
        });
        const failingNames = [...observation.failingChecks].sort();
        const evidenceNames = [...(failures ?? [])].map((failure) => failure.name).sort();
        const exactEvidenceSet =
          failingNames.length === evidenceNames.length &&
          failingNames.every((name, index) => name === evidenceNames[index]);
        const classified = (failures ?? []).map((failure) => ({
          failure,
          signature: classifyCiInfrastructureFailure({
            conclusion: failure.conclusion,
            logTail: failure.logTail,
          }),
        }));
        const allRetryable =
          deps.readCiFailures !== undefined &&
          deps.requeueCheck !== undefined &&
          exactEvidenceSet &&
          classified.length > 0 &&
          classified.every(({ failure, signature: failureSignature }) => failure.jobId && failureSignature);
        if (allRetryable) {
          const priorKeys = requeuedCheckKeysFromLedger(readLedgerLines(deps.ledgerPath));
          const repeated = classified.some(({ failure }) => priorKeys.has(`${decidedBySha}@${failure.name}`));
          if (!repeated) {
            let allDispatched = true;
            for (const { failure, signature: failureSignature } of classified) {
              const jobId = failure.jobId!;
              const namedSignature = failureSignature!;
              appendLedger(deps.ledgerPath, {
                run_id: deps.runId,
                task_id: MAIN_HEALTH_TASK_ID,
                step: CHECK_REQUEUE_STEP,
                surface: "main",
                head_sha: decidedBySha,
                check_name: failure.name,
                signature: namedSignature,
                job_id: jobId,
                outcome: "attempting",
                worker_strike_avoided: true,
              });
              let dispatched = false;
              try {
                dispatched = (await deps.requeueCheck!(failure)) !== false;
              } catch (error) {
                deps.log("main.health.ci_requeue.error", {
                  branch,
                  sha,
                  check_name: failure.name,
                  job_id: jobId,
                  error: String((error as Error)?.message ?? error),
                });
                dispatched = false;
              }
              appendLedger(deps.ledgerPath, {
                run_id: deps.runId,
                task_id: MAIN_HEALTH_TASK_ID,
                step: "main.health.ci_requeued",
                surface: "main",
                head_sha: decidedBySha,
                check_name: failure.name,
                signature: namedSignature,
                job_id: jobId,
                outcome: dispatched ? "dispatched" : "failed",
                worker_strike_avoided: true,
              });
              allDispatched = allDispatched && dispatched;
            }
            if (allDispatched) {
              lastSuccessfulObservationAtMs = startedAtMs;
              return;
            }
          }
        }
        // W1-T6403: a red the lane locates is repaired through PRs; MAIN-HEALTH is raised only once
        // locating, fixing and reverting were all refused.
        if (deps.repair && (await repairRedMain(deps.repair, observation, sha, branch, failures ?? [], startedAtMs))) {
          repairedSignature = signature;
          lastSuccessfulObservationAtMs = startedAtMs;
          return;
        }
        const issueUrl = await tryEscalateAsync(escalationFor(observation, branch, metLookup?.met), {
          issues: deps.issues,
          ledgerPath: deps.ledgerPath,
          runId: deps.runId,
        });
        if (issueUrl) {
          escalatedSignature = signature;
          deps.log("main.health.escalated", {
            branch,
            sha,
            failing_checks: observation.failingChecks,
            issue_url: issueUrl,
            ...(metLookup?.met ? metPrFields(metLookup) : {}),
          });
        }
        lastSuccessfulObservationAtMs = startedAtMs;
        return;
      }

      escalatedSignature = undefined;
      repairedSignature = undefined;
      if (observation.state !== "green") {
        resolvedSignature = undefined;
        lastSuccessfulObservationAtMs = startedAtMs;
        return;
      }
      if (deps.repair && decidedBySha === sha) await resolveRepairs(sha);
      const signature = `${observation.state}:${sha}`;
      if (signature === resolvedSignature) {
        lastSuccessfulObservationAtMs = startedAtMs;
        return;
      }
      if (!deps.issues.listOpen || !deps.issues.closeWithComment) {
        throw new Error("main-health resolution requires issue list and close support");
      }
      const open = (await deps.issues.listOpen(NEEDS_HUMAN_LABEL)).filter(isMainHealthIssue);
      for (const issue of open) {
        await deps.issues.closeWithComment(
          issue.url,
          `Resolved automatically: default branch \`${branch}\` at \`${sha}\` now has genuine passing check evidence. ${observation.reason}`,
        );
        deps.log("main.health.resolved", { branch, sha, issue_url: issue.url });
      }
      resolvedSignature = signature;
      lastSuccessfulObservationAtMs = startedAtMs;
    } catch (error) {
      deps.log("main.health.error", { error: String((error as Error)?.message ?? error) });
    }
  };

  return () => {
    const startedAtMs = now();
    if (
      lastSuccessfulObservationAtMs !== undefined &&
      startedAtMs >= lastSuccessfulObservationAtMs &&
      startedAtMs - lastSuccessfulObservationAtMs < freshMs
    ) {
      return Promise.resolve();
    }
    if (inFlight) return inFlight;
    const started = observe(startedAtMs);
    inFlight = started;
    void started.finally(() => {
      if (inFlight === started) inFlight = undefined;
    });
    return started;
  };
}

/** How often a light pass also observes main. A run in flight starves the full sweep (one tick read
 *  main at 14:01Z and the next at 14:49Z on 2026-10-09 while main sat red), so the light pass does it. */
export const MAIN_HEALTH_LIGHT_PASS_INTERVAL_MS = 2 * 60_000;

/** Wraps a light-pass hook so it also runs the main-health rung, at most once per interval. A rung
 *  failure is logged and never stops the light pass. */
export function withMainHealthOnLightPass<A extends unknown[]>(
  lightPass: (...args: A) => Promise<void>,
  rung: (() => Promise<void>) | undefined,
  options: {
    readonly intervalMs?: number;
    readonly clock?: Clock;
    readonly log?: (step: string, extra?: Record<string, unknown>) => void;
  } = {},
): (...args: A) => Promise<void> {
  if (!rung) return lightPass;
  const intervalMs = Math.max(0, options.intervalMs ?? MAIN_HEALTH_LIGHT_PASS_INTERVAL_MS);
  const clock = options.clock ?? systemClock;
  let lastAtMs: number | undefined;
  return async (...args: A) => {
    try {
      await lightPass(...args);
    } finally {
      const atMs = clock.now();
      if (lastAtMs === undefined || atMs < lastAtMs || atMs - lastAtMs >= intervalMs) {
        lastAtMs = atMs;
        try {
          await rung();
        } catch (error) {
          options.log?.("main.health.error", { source: "light_pass", error: String((error as Error)?.message ?? error) });
        }
      }
    }
  };
}
