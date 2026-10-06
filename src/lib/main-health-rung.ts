import {
  NEEDS_HUMAN_LABEL,
  tryEscalateAsync,
  type AsyncIssueGateway,
  type Escalation,
  type OpenIssue,
} from "./escalate.js";
import { prFilesRestArgs, rollupForAsync, type GhApiFetcher } from "./open-prs-rest.js";
import { appendLedger } from "./ledger.js";
import { readLedgerLines } from "./status.js";
import {
  CHECK_REQUEUE_STEP,
  classifyCiInfrastructureFailure,
  dedupeRollupByLatestAttempt,
  enrichMainHealthObservation,
  failedMainGuardRuns,
  mainHealthEscalationDecision,
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
}

type Awaitable<T> = T | Promise<T>;

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
    conclusion?: unknown;
    html_url?: unknown;
    pull_requests?: ReadonlyArray<{ number?: unknown; html_url?: unknown; url?: unknown }>;
  }>;
}

export function mainPushRunHistoryRestArgs(owner: string, repo: string, branch: string): string[] {
  return [
    "api",
    `repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&event=push&status=completed&per_page=100`,
  ];
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
      "This observer never auto-reverts or pauses unrelated dispatch; an explicit operator ruling " +
      "is required to hold the queue. The automatic PR repair and update paths remain active.",
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
      if (runHistory && mainHealthHeadInconclusive(observation)) {
        for (const run of mainHealthFallbackRuns(runHistory)) {
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
          break;
        }
      }
      // W1-T5490 (a): a failed guard workflow reads main red even beside green required checks.
      const guardFailures = runHistory ? failedMainGuardRuns(runHistory) : [];
      if (guardFailures.length > 0) {
        const guardNames = guardFailures.map((run) => run.workflowName!);
        if (observation.state !== "red") decidedBySha = guardFailures[0]!.headSha;
        observation = {
          ...observation,
          state: "red",
          reason: `main guard workflow(s) failed on main: ${guardNames.join(", ")}${observation.state === "red" ? `; ${observation.reason}` : ""}`,
          failingChecks: [...observation.failingChecks, ...guardNames.filter((name) => !observation.failingChecks.includes(name))],
        };
      }
      const advisoryFailing =
        required.size === 0
          ? []
          : mainHealthFromRollup(decidedBySha, evidenceRollup, undefined, undefined, judging).failingChecks.filter(
              (name) => !observation.failingChecks.includes(name),
            );
      // Only CONCLUDED checks are a census `decideBaseRed` may read: a pending or skipped one is
      // not evidence that main ran it green.
      const notConcluded = new Set([...observation.pendingChecks, ...observation.nonEvidenceChecks]);
      const observedChecks = [
        ...new Set([
          ...judgedRollup(evidenceRollup, required)
            .map((c) => c.name ?? c.context ?? "unknown")
            .filter((name) => !notConcluded.has(name)),
          ...observation.failingChecks,
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
      if (observation.state !== "green") {
        resolvedSignature = undefined;
        lastSuccessfulObservationAtMs = startedAtMs;
        return;
      }
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
