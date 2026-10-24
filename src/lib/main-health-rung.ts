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
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { baseProbeSetupFailure, baseReproductionFiles, type BaseProbeResult } from "./base-reproduction.js";
import { selectAffectedSuites, type AffectedSuitesInput } from "./affected-suites.js";
import { judgeFixProgress, type FixProgressInput, type FixProgressJudge, type FixProgressVerdict } from "./fix-progress-judge.js";
import {
  CHECK_REQUEUE_STEP,
  CI_MATRIX_AGGREGATORS,
  RATIFIED_BASELINE_RATCHET_REPAIRS,
  type RatifiedBaselineRatchetScript,
  classifyCiInfrastructureFailure,
  dedupeRollupByLatestAttempt,
  enrichMainHealthObservation,
  failedMainGuardRuns,
  MAIN_HEALTH_FALLBACK_WINDOW_COMMITS,
  mainGuardFailureCandidates,
  mainRunConcludedRed,
  mainRunIsVerdict,
  mainHealthUnattributedSpan,
  mainHealthEscalationDecision,
  mainHealthFallbackCandidates,
  mainHealthWalkRuns,
  mainRunIsInProgress,
  mainHealthFromRollup,
  mainHealthHeadInconclusive,
  earlyRedEvidenceRollup,
  REQUIRED_CHECK_FAIL,
  requeuedCheckKeysFromLedger,
  type CiFailure,
  describeMainRed,
  MAIN_INHERITED_RED_STEP,
  mainRedCovers,
  mainRedFields,
  mainRedOfRow,
  mainRedSignature,
  mainRedSignaturesMatch,
  type MainRedSignature,
  type MainHealthFirstRedCommit,
  type MainHealthObservation,
  type MainHealthRunHistoryEntry,
  type RollupCheckEntry,
} from "./sweep.js";

// W1-T8042: the red signature moved to sweep.ts, which classifies a red shared across open PRs by it and
// cannot import this module back; re-exported so every existing importer keeps its path.
export { describeMainRed, mainRedSignature, mainRedSignaturesMatch, type MainRedSignature };

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
  /** Keyed `<runId>#<attempt>`: a re-run of a completed run is a new attempt with its own jobs. */
  jobsByRunId: Map<string, RollupCheckEntry[]>;
  /** W1-T6023: main's newest first-parent commits from this head, read once a fallback is needed. */
  recentShas?: MainFirstParentWindow;
}

/** W1-T6023 — main's newest first-parent commits from its head, as {@link readMainFirstParentWindow}
 *  reads them. */
export interface MainFirstParentWindow {
  /** Newest first: the head at index 0, each next entry its first parent. */
  readonly order: readonly string[];
  readonly shas: ReadonlySet<string>;
  /** Each commit's committer time. Main squash-merges, so this is when the merge landed. */
  readonly committedAtMs: ReadonlyMap<string, number>;
}

/** How old the evidence that decided main's state is. `head`: main's own head decided. `fresh`: an
 *  older commit decided, and the oldest merge since it has waited no longer than main's own observed
 *  evidence latency. `stale`: it has waited longer. `unmeasured`: a commit time or a latency sample
 *  was missing, so no age can be claimed either way. */
export type MainEvidenceFreshness = "head" | "fresh" | "stale" | "unmeasured";

export interface MainEvidenceAge {
  readonly freshness: MainEvidenceFreshness;
  /** First-parent commits between main's head and the deciding commit; 0 when the head decided. */
  readonly depth: number;
  /** The oldest merge after the deciding commit: the longest-waiting merge with no evidence. */
  readonly oldestUnverifiedSha?: string;
  /** How long that merge has waited for evidence. */
  readonly lagMs?: number;
  /** The longest wait main's own evidence-bearing runs show: see {@link mainEvidenceAge}. */
  readonly latencyBoundMs?: number;
  /** The median gap between consecutive first-parent merges in the window. Reported, so a reader can
   *  turn the lag into merges; the verdict is made in time, which the merge cadence cannot move. */
  readonly mergeCadenceMs?: number;
}

function timeMs(value: string | undefined): number | undefined {
  const ms = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function medianGapMs(window: MainFirstParentWindow): number | undefined {
  const times = window.order.map((sha) => window.committedAtMs.get(sha)).filter((t): t is number => t !== undefined);
  const gaps = times.slice(1).map((t, i) => times[i]! - t).filter((gap) => gap >= 0).sort((a, b) => a - b);
  return gaps.length === 0 ? undefined : gaps[Math.floor(gaps.length / 2)];
}

/**
 * PRIMARY CONTROL — how old main's deciding evidence may be before a green reads `stale`, derived
 * from main's own runs, never a fixed number. Main's push runs share one concurrency group: a merge
 * landing just after a run started waits for that run and then for its own (or a later merge's),
 * so a healthy merge waits up to two run lengths for evidence. The bound is the larger of twice the
 * longest observed run (start to completion) and the longest observed merge-to-verdict wait, over
 * every completed, non-cancelled run of an evidence-bearing workflow whose head sits in the window.
 * The oldest merge after the deciding commit waiting longer than that is outside anything main's
 * pipeline has been seen to do: its evidence stopped arriving, so the old green is not reported.
 */
export function mainEvidenceAge(
  decidedBySha: string,
  window: MainFirstParentWindow,
  history: readonly MainHealthRunHistoryEntry[],
  evidenceWorkflows: ReadonlySet<string>,
  nowMs: number,
): MainEvidenceAge {
  // A sha outside the window never decides (W1-T6023), so -1 is only a caller's mistake: unmeasured.
  const depth = window.order.indexOf(decidedBySha);
  if (depth <= 0) return { freshness: depth === 0 ? "head" : "unmeasured", depth: Math.max(depth, 0) };
  const mergeCadenceMs = medianGapMs(window);
  const oldestUnverifiedSha = window.order[depth - 1]!;
  const mergedAtMs = window.committedAtMs.get(oldestUnverifiedSha);
  let longestRunMs = 0;
  let longestWaitMs = 0;
  for (const run of mainHealthFallbackCandidates(history)) {
    if (!evidenceWorkflows.has(run.workflowName ?? "")) continue;
    const completedMs = timeMs(run.completedAt);
    if (completedMs === undefined) continue;
    const startedMs = timeMs(run.startedAt);
    if (startedMs !== undefined && completedMs >= startedMs) longestRunMs = Math.max(longestRunMs, completedMs - startedMs);
    const committedMs = window.committedAtMs.get(run.headSha);
    if (committedMs !== undefined && completedMs >= committedMs) longestWaitMs = Math.max(longestWaitMs, completedMs - committedMs);
  }
  const latencyBoundMs = Math.max(2 * longestRunMs, longestWaitMs);
  const base = { depth, oldestUnverifiedSha, ...(mergeCadenceMs !== undefined ? { mergeCadenceMs } : {}) };
  if (mergedAtMs === undefined || latencyBoundMs <= 0) {
    return { ...base, freshness: "unmeasured", ...(latencyBoundMs > 0 ? { latencyBoundMs } : {}) };
  }
  const lagMs = Math.max(0, nowMs - mergedAtMs);
  return { ...base, freshness: lagMs > latencyBoundMs ? "stale" : "fresh", lagMs, latencyBoundMs };
}

const minutes = (ms: number): string => `${Math.round(ms / 60_000)} min`;

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
  /** Rules whether another fix attempt at a red is warranted once one ended without a fix. Absent,
   *  an ended attempt goes straight to the proven-culprit revert check, as before. */
  judgeRepairProgress?: FixProgressJudge;
  readRequiredChecks?: () => readonly string[];
  /** W1-T5806: the git reads that name the merges a red met in; defaults to GitHub's over `fetch`. */
  mergeReader?: MainHealthMergeReader;
  /** W1-T5806: one PR's changed paths; defaults to its `pulls/N/files` list over `fetch`. */
  readPrFiles?: (prNumber: number) => readonly string[] | undefined | Promise<readonly string[] | undefined>;
  /** W1-T9665: the affected-suites input for a merge's changed files. Absent, a merge's reach is unknown. */
  readAffectedInput?: (changed: readonly string[]) => Awaitable<AffectedSuitesInput>;
  /** W1-T6403: the PR openers of the red-main repair lane. Absent, a red main only escalates. */
  repair?: MainRepairLane;
  /** One failing check's job log, reduced by {@link mainCeilingLogReducer}; undefined when unread. */
  readCeilingVerdict?: (check: RollupCheckEntry) => MainCeilingLogVerdict | undefined | Promise<MainCeilingLogVerdict | undefined>;
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
  /** W1-T9665: every first-parent merge since the last green main, so a two-PR collision is visible. */
  readonly mergesSinceGreen?: MainRepairMergesSinceGreen;
}

/** W1-T9665 — one merge since the last green main. `reachesFailingTests` is undefined when unknown. */
export interface MainRepairMerge {
  readonly sha: string;
  readonly pr?: number;
  readonly subject: string;
  readonly files: readonly string[];
  readonly diffStat: string;
  readonly reachesFailingTests?: boolean;
  readonly reached?: readonly string[];
  readonly reachUnknown?: string;
  /** A reaching merge's unified diff. */
  readonly diff?: string;
}

export interface MainRepairMergesSinceGreen {
  readonly afterGreenSha?: string;
  /** Oldest first. */
  readonly merges: readonly MainRepairMerge[];
  readonly unreadable?: string;
}

const short = (sha: string): string => sha.slice(0, 12);

const mainRepairMergeName = (merge: MainRepairMerge): string => `\`${short(merge.sha)}\`${merge.pr !== undefined ? ` (#${merge.pr})` : ""}`;

/** W1-T9665 — the fix brief's merges-since-green lines and its "Fix EXACTLY ONE thing" line: the merges
 *  reaching the failing tests are the ones to repair, and two of them are a collision. */
export function mainRepairMergesBrief(request: Pick<MainRepairFixRequest, "offendingSha" | "mergesSinceGreen">): { lines: string[]; fixLine: string } {
  const reaching = (request.mergesSinceGreen?.merges ?? []).filter((merge) => merge.reachesFailingTests === true);
  const names = reaching.map(mainRepairMergeName).join(", ");
  const locatedMisses = request.mergesSinceGreen?.merges.find((merge) => merge.sha === request.offendingSha)?.reachesFailingTests === false;
  return {
    lines: [
      renderMainRepairMergesSinceGreen(request.mergesSinceGreen),
      ...(reaching.length >= 2 ? [`The red may be a COLLISION of ${names}: each was green on its own base, and they fail only together. Repair their INTERACTION.`] : []),
    ],
    fixLine:
      locatedMisses && reaching.length > 0
        ? `Fix EXACTLY ONE thing: make main green again by REPAIRING the defect that ${names} introduced: they reach the failing tests, and the located merge reaches none of them.`
        : "Fix EXACTLY ONE thing: make main green again by REPAIRING the defect the merge above introduced.",
  };
}

/** Lines of `text` from its head that fit `chars`, then how many were cut. */
function headWithOmission(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const lines = text.split("\n");
  const shown: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > chars) break;
    shown.push(line);
    used += line.length + 1;
  }
  return [...shown, `(${lines.length - shown.length} more diff lines omitted)`].join("\n");
}

/** W1-T9665 — the brief's "Merges since the last green main" section: reaching merges first with their
 *  diffs, the rest with their diff stat. Past `budget`, whole non-reaching merges are cut first (newest
 *  last-ranked first), then each reaching diff keeps its head; every cut is counted. */
export function renderMainRepairMergesSinceGreen(since: MainRepairMergesSinceGreen | undefined, budget = MAIN_REPAIR_LOG_EXCERPT_CHARS): string {
  if (!since) return "Merges since the last green main: not read for this brief.";
  const title = `Merges since the last green main${since.afterGreenSha ? ` \`${short(since.afterGreenSha)}\`` : ""}:`;
  if (since.unreadable !== undefined) return `${title} unread (${since.unreadable}). Nothing here says the merge above is the only candidate.`;
  const rank = (merge: MainRepairMerge) => (merge.reachesFailingTests === true ? 0 : merge.reachesFailingTests === undefined ? 1 : 2);
  const ordered = [...since.merges].sort((a, b) => rank(a) - rank(b));
  const head = (merge: MainRepairMerge): string => {
    const reach =
      merge.reachesFailingTests === true
        ? `REACHES the failing test(s) ${(merge.reached ?? []).join(", ")}`
        : merge.reachesFailingTests === false
          ? "reaches none of the failing tests"
          : `reach UNKNOWN: ${merge.reachUnknown ?? "not read"}`;
    return `- ${mainRepairMergeName(merge)} ${merge.subject} — ${reach}\n  files: ${merge.files.join(", ") || "(none listed)"}`;
  };
  const sum = (texts: readonly string[]) => texts.reduce((total, text) => total + text.length + 1, 0);
  const reaching = ordered.filter((merge) => merge.reachesFailingTests === true);
  const rest = ordered.filter((merge) => merge.reachesFailingTests !== true).map((merge) => ({ sha: merge.sha, text: `${head(merge)}\n${merge.diffStat}` }));
  const fixed = title.length + 1 + sum(reaching.map(head));
  const diffs = sum(reaching.map((merge) => merge.diff ?? merge.diffStat));
  const omitted: string[] = [];
  while (rest.length > 0 && fixed + diffs + sum(rest.map((entry) => entry.text)) > budget) omitted.push(short(rest.pop()!.sha));
  const perDiff = Math.floor(Math.max(0, budget - fixed - sum(rest.map((entry) => entry.text))) / Math.max(1, reaching.length));
  return [
    title,
    ...reaching.map((merge) => `${head(merge)}\n${headWithOmission(merge.diff ?? merge.diffStat, perDiff)}`),
    ...rest.map((entry) => entry.text),
    ...(omitted.length > 0 ? [`(${omitted.length} more merge(s) omitted to fit the brief, none reaching a failing test: ${omitted.join(", ")})`] : []),
  ].join("\n");
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
  /** W1-T10269 — why the revert opens. Absent (or `red-main`) is W1-T6403's red main. A reviewer
   *  regression is not red on main: its body names the outcome-mix evidence, not failing checks. */
  readonly reason?: MainRepairRevertReason;
}

export type MainRepairRevertReason =
  | { readonly kind: "red-main" }
  | { readonly kind: "reviewer-regression"; readonly incidentId: string; readonly evidence: string };

/** W1-T10269 — the revert PR's title and opening lines for a reviewer regression; undefined for a red main. */
export function reviewerRegressionRevertText(
  request: MainRepairRevertRequest,
): { title: string; lead: string[] } | undefined {
  const reason = request.reason;
  if (reason?.kind !== "reviewer-regression") return undefined;
  const pr = request.offendingPr !== undefined ? `#${request.offendingPr}` : request.offendingSha.slice(0, 12);
  return {
    title: `revert(review): revert ${pr}, the merge that regressed the reviewer`,
    lead: [
      `Reverts \`${request.offendingSha}\` (${request.offendingPr !== undefined ? `#${request.offendingPr}` : "an unnamed PR"}), ` +
        `the first review-material merge before reviewer incident \`${reason.incidentId}\`.`,
      "",
      "The reviewer's own outcome mix departed from its history (W1-T10269):",
      "",
      ...reason.evidence.split("\n").map((line) => `> ${line}`),
      "",
      "Until this merges or a fix returns the reviewer to its baseline, reviews run from origin/main with this",
      "merge reverted on top. It is closed automatically if a fix makes it unnecessary.",
    ],
  };
}

/** A revert PR opened, or the revert refused (a conflicting `git revert`, or a failed push or open). */
export type MainRepairRevertOutcome =
  | { readonly prUrl: string }
  | { readonly refused: string; readonly conflictPaths?: readonly string[] };

/** A red main that crossed only ratified ceilings: which writers record it, and what main read. */
export interface MainRatchetRecordRequest {
  readonly branch: string;
  readonly headSha: string;
  readonly scripts: readonly RatifiedBaselineRatchetScript[];
  readonly gates: readonly string[];
}

/** The PR this lane opened, an open PR that already records it (so the lane stands down), or why
 *  neither -- a declined record hands the red back to the fix-then-revert path. */
export type MainRatchetRecordOutcome =
  | { readonly opened: string }
  | { readonly standing: string }
  | { readonly declined: string };

export interface MainRepairPr {
  readonly state: "open" | "closed" | "merged";
  readonly headSha?: string;
}

/** W1-T6403 — the lane's effects. Both openers cut a fresh branch off origin/main and open a PR;
 *  neither pushes to main. `readPr`/`closePr` default to GitHub's REST calls over `fetch`. */
export interface MainRepairLane {
  openFixPr(request: MainRepairFixRequest): Awaitable<string | undefined>;
  openRevertPr(request: MainRepairRevertRequest): Awaitable<MainRepairRevertOutcome>;
  /** The recorded-baseline PR for a red that is only a ratified ceiling. Absent, such a red takes
   *  the fix-then-revert path like any other. */
  recordRatchet?(request: MainRatchetRecordRequest): Awaitable<MainRatchetRecordOutcome>;
  readPr?(prUrl: string): Awaitable<MainRepairPr>;
  closePr?(prUrl: string, comment: string): Awaitable<void>;
  /** W1-T7760: runs CI on commits whose own push run was cancelled. Defaults to GitHub's REST over `fetch`. */
  probes?: MainRepairProbes;
  reproduceAt?(sha: string, testFiles: readonly string[]): Awaitable<BaseProbeResult>;
}

/** W1-T7760 — the workflow a probe runs. It carries ci-gate's required checks, has a
 *  `workflow_dispatch` trigger, and its `push` trigger is `branches: [main]`, so creating a probe's
 *  ref fires no workflow's push trigger (read from .github/workflows/*.yml: every `push:` there is
 *  filtered to main). */
export const MAIN_PROBE_WORKFLOW = "ci.yml";

/** W1-T7760 — a probe's ref lives under this prefix: its concurrency group (`ci-refs/heads/<ref>`)
 *  is its own, never main's `ci-refs/heads/main`. */
export const MAIN_PROBE_REF_PREFIX = "rmd-attribution/";

/** One probe: CI run on one commit under its own ref. */
export interface MainProbeHandle {
  readonly sha: string;
  /** The branch name, without `refs/heads/`. */
  readonly ref: string;
  readonly runId?: number;
  readonly runUrl?: string;
}

/** What one probe's CI run reads as right now. `missing`: no run registered for the ref (yet). */
export interface MainProbeReading {
  readonly status: "running" | "completed" | "missing";
  readonly runId?: number;
  readonly runUrl?: string;
  /** The run's jobs, shaped as rollup entries; judged by {@link mainHealthFromRollup}. */
  readonly jobs?: readonly RollupCheckEntry[];
}

/** The repo's CI load: jobs waiting for a runner, and runners that are online and idle. */
export interface MainRunnerLoad {
  readonly queuedJobs: number;
  readonly idleRunners: number;
}

/** W1-T7760 — the lane's probe effects. A probe never re-runs a push run in place and never
 *  dispatches at `main`: either would join main's own concurrency group and cancel its pending run. */
export interface MainRepairProbes {
  /** Create `rmd-attribution/<sha>` at `sha`, then dispatch {@link MAIN_PROBE_WORKFLOW} on it. */
  dispatch(sha: string): Awaitable<MainProbeHandle>;
  read(probe: MainProbeHandle): Awaitable<MainProbeReading>;
  /** Delete the probe's ref once its run concluded. */
  release(probe: MainProbeHandle): Awaitable<void>;
  readRunnerLoad(): Awaitable<MainRunnerLoad>;
}

export type MainProbeVerdict = "green" | "red" | "inconclusive";

interface MainProbeEvidence {
  verdict: MainProbeVerdict;
  runUrl?: string;
  runId?: number;
  failingChecks: string[];
  method?: "local-test";
  files?: readonly string[];
  outcomes?: BaseProbeResult;
}

function localProbeVerdict(files: readonly string[], outcomes: BaseProbeResult): MainProbeVerdict {
  const byFile = new Map(outcomes.map((outcome) => [outcome.file, outcome.outcome]));
  if (files.some((file) => byFile.get(file) === "fails")) return "red";
  return files.length > 0 && outcomes.reason === undefined && outcomes.setup_error === undefined &&
    files.every((file) => byFile.get(file) === "passes" || byFile.get(file) === "absent") ? "green" : "inconclusive";
}

/** Probes in flight: one at a time while any CI job in the repo waits for a runner; otherwise as many
 *  as there are idle runners (at least one). No constant: both inputs are readings. */
export function chooseProbeConcurrency(load: MainRunnerLoad): number {
  return load.queuedJobs > 0 ? 1 : Math.max(1, Math.floor(load.idleRunners));
}

/** The median wall-clock duration (ms) of the completed runs in `history` that carry a start and a
 *  completion time; undefined when none do. Prices one probe. */
export function medianCiRunMs(history: readonly MainHealthRunHistoryEntry[], workflows?: ReadonlySet<string>): number | undefined {
  const durations = history
    .filter((run) => (run.status === undefined || run.status.toLowerCase() === "completed") && mainRunIsVerdict(run) && (!workflows || workflows.size === 0 || run.workflowName === undefined || workflows.has(run.workflowName)))
    .map((run) => {
      const start = timeMs(run.startedAt ?? run.createdAt);
      const end = timeMs(run.completedAt);
      return start !== undefined && end !== undefined && end > start ? end - start : undefined;
    })
    .filter((ms): ms is number => ms !== undefined)
    .sort((a, b) => a - b);
  if (durations.length === 0) return undefined;
  const mid = Math.floor(durations.length / 2);
  return durations.length % 2 === 1 ? durations[mid]! : Math.round((durations[mid - 1]! + durations[mid]!) / 2);
}

/** What the planner decided this pass. */
export type MainBisectionPlan =
  | { readonly state: "proven"; readonly offendingSha: string; readonly parentSha: string }
  | {
      readonly state: "probe";
      /** Commits to start probes on now, in the order they are dispatched. */
      readonly shas: readonly string[];
      readonly strategy: "linear-newest-first" | "split-points" | "wait";
      /** Commits between the newest proven green and the oldest proven red: the interval still open. */
      readonly open: readonly string[];
      /** Worst-case probes the chosen strategy spends on `open`, and the other strategy's. */
      readonly estimatedProbes: number;
      readonly alternativeProbes: number;
    };

/**
 * W1-T7760 — where main turned red, from verdicts only. The sequence is `green`, the `span` oldest
 * first, `red`. Verdicts are the completed runs and concluded probes; the newest proven green and the
 * oldest proven red above it bound the open interval. The first red is PROVEN when those two are
 * adjacent: a completed red whose first parent is a completed green.
 *
 * With `concurrency` probes allowed in flight, the open commits are probed newest first (a linear
 * walk from the known red) while that costs no more than a bisection would, and at split points once
 * it costs more. Cost is worst-case probes, each priced alike, so the comparison needs no constant.
 */
export function planMainBisection(input: {
  readonly green: string;
  readonly red: string;
  /** The unattributed commits, newest first. */
  readonly span: readonly string[];
  readonly verdicts: ReadonlyMap<string, MainProbeVerdict>;
  readonly inFlight: ReadonlySet<string>;
  readonly concurrency: number;
}): MainBisectionPlan {
  const sequence = [input.green, ...[...input.span].reverse(), input.red];
  const verdictAt = (index: number): MainProbeVerdict | undefined =>
    index === 0 ? "green" : index === sequence.length - 1 ? "red" : input.verdicts.get(sequence[index]!);
  let lo = 0;
  for (let index = sequence.length - 2; index > 0; index -= 1) {
    if (verdictAt(index) === "green") {
      lo = index;
      break;
    }
  }
  let hi = sequence.length - 1;
  for (let index = lo + 1; index < sequence.length - 1; index += 1) {
    if (verdictAt(index) === "red") {
      hi = index;
      break;
    }
  }
  if (hi === lo + 1) return { state: "proven", offendingSha: sequence[hi]!, parentSha: sequence[lo]! };
  const open = sequence.slice(lo + 1, hi);
  const n = open.length;
  const k = Math.max(1, Math.floor(input.concurrency));
  const linear = n;
  const rounds = Math.ceil(Math.log(n + 1) / Math.log(k + 1) - 1e-9);
  const split = k * Math.max(1, rounds);
  const free = k - [...input.inFlight].filter((sha) => open.includes(sha)).length;
  if (free <= 0) {
    return { state: "probe", shas: [], strategy: "wait", open, estimatedProbes: Math.min(linear, split), alternativeProbes: Math.max(linear, split) };
  }
  const startable = (sha: string): boolean => !input.inFlight.has(sha);
  if (linear <= split) {
    const shas = [...open].reverse().filter(startable).slice(0, free);
    return { state: "probe", shas, strategy: "linear-newest-first", open, estimatedProbes: linear, alternativeProbes: split };
  }
  const points = new Set<number>();
  for (let i = 1; i <= k; i += 1) points.add(Math.min(n - 1, Math.max(0, Math.round((i * (n + 1)) / (k + 1)) - 1)));
  const shas = [...points].sort((a, b) => b - a).map((index) => open[index]!).filter(startable).slice(0, free);
  return { state: "probe", shas, strategy: "split-points", open, estimatedProbes: split, alternativeProbes: linear };
}

/** One red's bisection, folded from `main.repair.bisecting` and `main.repair.probe_concluded` rows. */
export interface MainBisectionState {
  /** Probes dispatched and not yet concluded, by commit. */
  readonly inFlight: Map<string, MainProbeHandle>;
  /** Concluded probes that said green or red, by commit. */
  readonly verdicts: Map<string, MainProbeVerdict>;
  /** Their evidence, by commit. */
  readonly evidence: Map<string, MainProbeEvidence>;
  readonly localAttempts: Set<string>;
  /** True once the bisection was dispatched at all. */
  readonly started: boolean;
  /** The located row that closed it, if one was written. */
  readonly located: boolean;
}

/** The ledger, not memory, is the dedupe: a restarted daemon (or a rotated ledger) must not
 *  dispatch a probe that is already running, nor re-run one that concluded. Keyed by the first red
 *  `firstRedSha` the walk named. */
export function mainBisectionFromLedger(lines: readonly Record<string, unknown>[], firstRedSha: string): MainBisectionState {
  const inFlight = new Map<string, MainProbeHandle>();
  const verdicts = new Map<string, MainProbeVerdict>();
  const evidence = new Map<string, MainProbeEvidence>();
  const localAttempts = new Set<string>();
  let started = false;
  let located = false;
  for (const line of lines) {
    if (line.first_red_sha !== firstRedSha && line.bisection_of !== firstRedSha) continue;
    if (line.step === "main.repair.bisecting" && Array.isArray(line.probes)) {
      started = true;
      for (const probe of line.probes as Array<Record<string, unknown>>) {
        if (typeof probe?.sha !== "string" || typeof probe.ref !== "string") continue;
        inFlight.set(probe.sha, {
          sha: probe.sha,
          ref: probe.ref,
          ...(typeof probe.run_id === "number" ? { runId: probe.run_id } : {}),
          ...(typeof probe.run_url === "string" ? { runUrl: probe.run_url } : {}),
        });
      }
    } else if (line.step === "main.repair.probe_concluded" && typeof line.probe_sha === "string") {
      inFlight.delete(line.probe_sha);
      if (line.method === "local-test") localAttempts.add(line.probe_sha);
      const verdict = line.verdict === "green" || line.verdict === "red" ? line.verdict : undefined;
      if (verdict) {
        verdicts.set(line.probe_sha, verdict);
        evidence.set(line.probe_sha, {
          verdict,
          ...(typeof line.run_url === "string" ? { runUrl: line.run_url } : {}),
          ...(typeof line.run_id === "number" ? { runId: line.run_id } : {}),
          failingChecks: Array.isArray(line.failing_checks) ? line.failing_checks.map(String) : [],
          ...(line.method === "local-test" ? { method: "local-test" as const,
            files: Array.isArray(line.files) ? line.files.map(String) : [],
            outcomes: Array.isArray(line.outcomes) ? line.outcomes as BaseProbeResult : [] } : {}),
        });
      } else {
        verdicts.delete(line.probe_sha);
      }
    } else if (line.step === "main.repair.located" && line.bisection_of === firstRedSha) {
      located = true;
    }
  }
  return { inFlight, verdicts, evidence, localAttempts, started, located };
}

/**
 * W1-T7760 — why `sha` may NOT be written as a located offender, or undefined when it may. A sha is
 * nameable only when a COMPLETED run of it whose required checks concluded red exists in main's push
 * run history, or a concluded probe of it read red. A cancelled run concluded nothing.
 */
export function locatedWriterRefusal(
  sha: string,
  history: readonly MainHealthRunHistoryEntry[] | undefined,
  probeVerdicts: ReadonlyMap<string, MainProbeVerdict> = new Map(),
): string | undefined {
  if (probeVerdicts.get(sha) === "red") return undefined;
  const own = (history ?? []).filter((run) => run.headSha === sha);
  if (own.some(mainRunConcludedRed)) return undefined;
  const cancelled = own.filter((run) => !mainRunIsVerdict(run)).length;
  return (
    `\`${sha}\` has no completed run whose required checks concluded red, and no concluded red probe` +
    (own.length > 0 ? ` (${own.length} run(s) in main's push run history, ${cancelled} of them cancelled, skipped or stale)` : " (no run in main's push run history)")
  );
}

/** Folds `{ref}` branch listing rows into the newest run's reading. */
interface BranchRunsResponse {
  workflow_runs?: ReadonlyArray<{ id?: unknown; html_url?: unknown; status?: unknown; head_sha?: unknown }>;
}

/** GitHub answers a workflow dispatch and a ref delete with 204 No Content: `gh` exits 0 and prints nothing, which
 *  the JSON fetcher reports as an unreadable body. For these writes that is the request's success. Every probe
 *  dispatch on 2026-10-16 was logged failed this way, so the red at bd42ca367 was never attributed. */
async function writeWithNoContent(write: () => unknown): Promise<void> {
  try {
    await write();
  } catch (error) {
    if ((error as { reasonClass?: unknown } | undefined)?.reasonClass !== "gh_json_unreadable_response") throw error;
  }
}

/** The production {@link MainRepairProbes}: GitHub's REST `git/refs`, workflow dispatch, runs and
 *  runners endpoints over the same `fetch` the rung reads with. */
export function restMainProbes(owner: string, repo: string, fetch: GhApiFetcher): MainRepairProbes {
  const repoPath = `repos/${owner}/${repo}`;
  return {
    async dispatch(sha) {
      const ref = `${MAIN_PROBE_REF_PREFIX}${sha}`;
      try {
        await fetch(["api", "--method", "POST", `${repoPath}/git/refs`, "-f", `ref=refs/heads/${ref}`, "-f", `sha=${sha}`]);
      } catch (error) {
        // A ref left by an earlier, unreleased probe of the same commit is reused, never an error.
        if (!/already exists/i.test(String((error as Error)?.message ?? error))) throw error;
      }
      await writeWithNoContent(() => fetch(["api", "--method", "POST", `${repoPath}/actions/workflows/${MAIN_PROBE_WORKFLOW}/dispatches`, "-f", `ref=${ref}`]));
      return { sha, ref };
    },
    async read(probe) {
      const runs = (await fetch([
        "api",
        `${repoPath}/actions/workflows/${MAIN_PROBE_WORKFLOW}/runs?branch=${encodeURIComponent(probe.ref)}&event=workflow_dispatch&per_page=5`,
      ])) as BranchRunsResponse | undefined;
      const run = (runs?.workflow_runs ?? []).find((candidate) => candidate.head_sha === probe.sha && typeof candidate.id === "number");
      if (!run) return { status: "missing" };
      const runId = run.id as number;
      const runUrl = typeof run.html_url === "string" ? run.html_url : undefined;
      const completed = String(run.status ?? "").toLowerCase() === "completed";
      const jobs = rollupFromJobs((await fetch(["api", `${repoPath}/actions/runs/${runId}/jobs?per_page=100`])) as WorkflowJobsResponse);
      return { status: completed ? "completed" : "running", runId, ...(runUrl ? { runUrl } : {}), jobs };
    },
    async release(probe) {
      await writeWithNoContent(() => fetch(["api", "--method", "DELETE", `${repoPath}/git/refs/heads/${probe.ref}`]));
    },
    async readRunnerLoad() {
      const queued = (await fetch(["api", `${repoPath}/actions/runs?status=queued&per_page=1`])) as { total_count?: unknown } | undefined;
      const runners = (await fetch(["api", `${repoPath}/actions/runners?per_page=100`])) as
        | { runners?: ReadonlyArray<{ status?: unknown; busy?: unknown }> }
        | undefined;
      const idle = (runners?.runners ?? []).filter((runner) => runner.status === "online" && runner.busy !== true).length;
      return { queuedJobs: typeof queued?.total_count === "number" ? queued.total_count : 0, idleRunners: idle };
    },
  };
}

/** One offending merge's repair, folded from its `main.repair.*` ledger rows. */
export interface MainRepairRecord {
  offendingSha: string;
  offendingPr?: number;
  failingChecks: string[];
  /** The red this repair is for; absent on a row written before the lane recorded one. */
  red?: MainRedSignature;
  fixDispatched: boolean;
  /** Every fix run dispatched for this red, oldest first, and how each ended. */
  attempts: MainRepairAttempt[];
  fixPrUrl?: string;
  fixRefused?: string;
  /** The fix-progress judge's ruling on the newest ended attempt, if it was asked. */
  judgement?: { attempt: number; verdict: FixProgressVerdict };
  revertPrUrl?: string;
  revertRefused?: string;
  /** Why the revert was withheld: the located merge was not proven to be the culprit. */
  revertWithheld?: string;
  /** W1-T7760: set when the merge was located by probing CI on the cancelled commits before it; the
   *  probe runs, not main's push run history, are then its proof. */
  bisected?: { parentSha: string; evidence: string; failingChecks: string[]; testFiles: string[]; localRuns?: Array<Record<string, unknown>> };
  /** W1-T8042: set when the sweep handed this red over from open PRs sharing it; `offendingSha` is then
   *  the merge base every affected PR contains and no green one does. */
  inherited?: { prs: number[]; testFiles: string[]; logExcerpt: string };
  resolved: boolean;
}

export interface MainRepairAttempt {
  headSha?: string;
  outcome?: "opened" | "no_pr";
  reason?: string;
}

/** W1-T6403 — every offending merge this lane has acted on, keyed by its sha. The ledger, not
 *  memory, is the dedupe: a restarted daemon must not open a second fix PR for the same merge. */
export function mainRepairRecordsFromLedger(lines: readonly Record<string, unknown>[]): Map<string, MainRepairRecord> {
  const records = new Map<string, MainRepairRecord>();
  for (const line of lines) {
    const sha = line.offending_sha;
    if (typeof line.step !== "string" || !line.step.startsWith("main.repair.") || typeof sha !== "string") continue;
    const record = records.get(sha);
    if (line.step === MAIN_INHERITED_RED_STEP) {
      // W1-T8042: an `advanced` row only adds PRs to the record its `opened` row started.
      if (line.outcome === "opened" && (!record || record.resolved)) records.set(sha, inheritedRecordOf(sha, line));
      continue;
    }
    if (line.step === "main.repair.located") {
      if (!record || record.resolved) {
        const red = mainRedOfRow(line);
        records.set(sha, {
          offendingSha: sha,
          ...(typeof line.offending_pr === "number" ? { offendingPr: line.offending_pr } : {}),
          failingChecks: Array.isArray(line.failing_checks) ? line.failing_checks.map(String) : [],
          ...(red ? { red } : {}),
          ...(line.method === "bisected-first-red" && typeof line.parent_sha === "string"
            ? {
                bisected: {
                  parentSha: line.parent_sha,
                  testFiles: Array.isArray(line.test_files) ? line.test_files.map(String) : [],
                  evidence: Array.isArray(line.probe_runs)
                    ? (line.probe_runs as Array<Record<string, unknown>>).map((probe) => `${String(probe.sha)} ${String(probe.verdict)} ${String(probe.run_url ?? "")}`.trim()).join("; ")
                    : "",
                  failingChecks: Array.isArray(line.probe_failing_checks) ? line.probe_failing_checks.map(String) : [],
                  ...(Array.isArray(line.probe_runs) && line.probe_runs.some((probe) => probe?.method === "local-test")
                    ? { localRuns: line.probe_runs as Array<Record<string, unknown>> } : {}),
                },
              }
            : {}),
          fixDispatched: false,
          attempts: [],
          resolved: false,
        });
      }
      continue;
    }
    if (!record) continue;
    const attempt = record.attempts.at(-1);
    if (line.step === "main.repair.fix_dispatched") {
      // A further attempt at the same red starts clean: the last one's PR or refusal is history.
      record.fixDispatched = true;
      record.attempts.push(typeof line.head_sha === "string" ? { headSha: line.head_sha } : {});
      delete record.fixPrUrl;
      delete record.fixRefused;
    } else if (line.step === "main.repair.fix_opened") {
      record.fixPrUrl = String(line.pr_url);
      if (attempt) attempt.outcome = "opened";
    } else if (line.step === "main.repair.fix_refused") {
      record.fixRefused = String(line.reason);
      if (attempt) Object.assign(attempt, { outcome: "no_pr", reason: String(line.reason) });
    } else if (line.step === "main.repair.progress_judged") {
      const verdict = progressVerdictOfRow(line);
      if (verdict) record.judgement = { attempt: Number(line.attempt), verdict };
    } else if (line.step === "main.repair.revert_opened") record.revertPrUrl = String(line.pr_url);
    else if (line.step === "main.repair.revert_refused") record.revertRefused = String(line.reason);
    else if (line.step === "main.repair.revert_withheld") record.revertWithheld = String(line.reason);
    else if (line.step === "main.repair.resolved") record.resolved = true;
  }
  return records;
}

function inheritedRecordOf(sha: string, line: Record<string, unknown>): MainRepairRecord {
  const red = mainRedOfRow(line);
  const rows = Array.isArray(line.inherited_prs) ? (line.inherited_prs as Array<Record<string, unknown>>) : [];
  return {
    offendingSha: sha,
    failingChecks: red ? [...red.checks] : [],
    ...(red ? { red } : {}),
    fixDispatched: false,
    attempts: [],
    inherited: {
      prs: rows.map((row) => row?.pr_number).filter((n): n is number => typeof n === "number"),
      testFiles: Array.isArray(line.test_files) ? line.test_files.map(String) : [],
      logExcerpt: typeof line.log_excerpt === "string" ? line.log_excerpt : "",
    },
    resolved: false,
  };
}

function progressVerdictOfRow(line: Record<string, unknown>): FixProgressVerdict | undefined {
  const reason = String(line.reason ?? "");
  if (line.verdict === "continue") return { verdict: "continue", reason };
  if (line.verdict === "change-approach") return { verdict: "change-approach", approach: String(line.approach ?? ""), reason };
  if (line.verdict === "escalate") return { verdict: "escalate", loop: String(line.loop ?? ""), reason };
  return undefined;
}

function pullNumberOf(prUrl: string): string {
  const n = /\/pull\/(\d+)/.exec(prUrl)?.[1];
  if (!n) throw new Error(`not a pull request url: ${prUrl}`);
  return n;
}

/** What one failing `ci-shard` job log says about main's own ceilings: the main-ceiling-drift gates
 *  it named BLOCKED, and the failed-test count of the last test summary printed before them
 *  (absent when the log printed no summary, which is never read as "no test failed"). */
export interface MainCeilingLogVerdict {
  readonly blockedGates: readonly string[];
  readonly testsFailed?: number;
}

const ACTIONS_TIMESTAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const MAIN_CEILING_BLOCKED = /^main-ceiling-drift: (\S+) BLOCKED on main itself\s*$/;
const MAIN_CEILING_GROUP = /^##\[group\]main-ceiling-drift:/;
const TEST_SUMMARY_FAIL = /^(?:#|ℹ) fail (\d+)\s*$/;

/** Reads a job log line by line, so the core daemon never holds a whole shard log in memory. */
export function mainCeilingLogReducer(): { push(line: string): void; finish(): MainCeilingLogVerdict } {
  const blocked: string[] = [];
  let testsFailed: number | undefined;
  let inCeilings = false;
  return {
    push(raw) {
      const line = raw.replace(ACTIONS_TIMESTAMP, "");
      if (MAIN_CEILING_GROUP.test(line)) inCeilings = true;
      const gate = MAIN_CEILING_BLOCKED.exec(line)?.[1];
      if (gate !== undefined && !blocked.includes(gate)) blocked.push(gate);
      // A retry prints a second summary after the first; the last one before the ceilings decides.
      const fail = inCeilings ? undefined : TEST_SUMMARY_FAIL.exec(line)?.[1];
      if (fail !== undefined) testsFailed = Number(fail);
    },
    finish: () => ({ blockedGates: [...blocked], ...(testsFailed !== undefined ? { testsFailed } : {}) }),
  };
}

/** The ratified baseline writer whose no-record signal is the main-ceiling-drift gate `gate`. */
export function ratifiedRatchetForMainGate(gate: string): RatifiedBaselineRatchetScript | undefined {
  return (Object.keys(RATIFIED_BASELINE_RATCHET_REPAIRS) as RatifiedBaselineRatchetScript[]).find(
    (script) => RATIFIED_BASELINE_RATCHET_REPAIRS[script].signalScript === gate,
  );
}

/** A red main the fleet may record its way out of, or the reason it may not. */
export type MainRatchetRedVerdict =
  | { readonly kind: "ratchet-only"; readonly scripts: readonly RatifiedBaselineRatchetScript[]; readonly gates: readonly string[] }
  | { readonly kind: "not-ratchet"; readonly reason: string };

const CI_SHARD_MATRIX = CI_MATRIX_AGGREGATORS.find((entry) => entry.aggregator === "ci")!;

/**
 * Main is red ONLY because it crossed a ceiling the operator ratified for unattended recording
 * (W1-T4004's registry): every failing check is the `ci` shard matrix or its aggregator, and every
 * failing shard's own log names only ratified ceiling gates BLOCKED beside a test summary of zero
 * failures. Anything else -- a guard workflow, a failed test, an unratified gate such as a learnings
 * budget, an unread log -- is `not-ratchet`, and the ordinary repair lane keeps the red.
 */
export function classifyMainRatchetRed(
  failingChecks: readonly string[],
  verdicts: ReadonlyMap<string, MainCeilingLogVerdict | undefined>,
): MainRatchetRedVerdict {
  const shards = failingChecks.filter((name) => CI_SHARD_MATRIX.constituent.test(name));
  const others = failingChecks.filter((name) => name !== CI_SHARD_MATRIX.aggregator && !shards.includes(name));
  if (others.length > 0) return { kind: "not-ratchet", reason: `failing outside the ci shard matrix: ${others.join(", ")}` };
  if (shards.length === 0) return { kind: "not-ratchet", reason: "no failing ci shard names what failed" };
  const gates: string[] = [];
  for (const shard of shards) {
    const verdict = verdicts.get(shard);
    if (!verdict) return { kind: "not-ratchet", reason: `${shard}'s log was not read` };
    if (verdict.testsFailed === undefined) return { kind: "not-ratchet", reason: `${shard}'s log printed no test summary` };
    if (verdict.testsFailed > 0) return { kind: "not-ratchet", reason: `${shard} failed ${verdict.testsFailed} test(s)` };
    if (verdict.blockedGates.length === 0) return { kind: "not-ratchet", reason: `${shard} failed with no failed test and no ceiling named` };
    for (const gate of verdict.blockedGates) if (!gates.includes(gate)) gates.push(gate);
  }
  const unratified = gates.filter((gate) => ratifiedRatchetForMainGate(gate) === undefined);
  if (unratified.length > 0) return { kind: "not-ratchet", reason: `ceiling(s) not ratified for recording: ${unratified.join(", ")}` };
  const scripts = [...new Set(gates.map((gate) => ratifiedRatchetForMainGate(gate)!))].sort();
  return { kind: "ratchet-only", scripts, gates: [...gates].sort() };
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

type RestCommitFile = { filename?: unknown; additions?: unknown; deletions?: unknown; patch?: unknown };
type RestCommitRead = RestCommit & { files?: ReadonlyArray<RestCommitFile> };

function diffStatLines(files: ReadonlyArray<RestCommitFile>): string {
  const lines = files.map((f) => ` ${String(f.filename)} | +${Number(f.additions ?? 0)} -${Number(f.deletions ?? 0)}`);
  return lines.length > 0 ? lines.join("\n") : "(GitHub's commit read listed no files)";
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

interface WorkflowEvidence {
  readonly required: string;
  readonly carries: Set<string>;
  readonly carriesNone: Set<string>;
}

/** W1-T9690 — the one learner the walk back and a red head share: true when the run's jobs hold a
 *  required check; a completed run with jobs but none required marks its workflow as carrying none. */
function learnWorkflow(
  learned: WorkflowEvidence,
  run: MainHealthRunHistoryEntry,
  jobs: readonly RollupCheckEntry[],
  required: ReadonlySet<string>,
): boolean {
  const workflow = run.workflowName;
  if (judgedRollup(jobs, required).length > 0) {
    if (workflow !== undefined) learned.carries.add(workflow);
    return true;
  }
  if (!mainRunIsInProgress(run) && workflow !== undefined && jobs.length > 0) learned.carriesNone.add(workflow);
  return false;
}

/** W1-T7757: a job that reached a conclusion (or a terminal status), as opposed to one still queued or running. */
function jobConcluded(job: RollupCheckEntry): boolean {
  return (job.conclusion ?? "") !== "" || (job.state ?? "") !== "" || (job.status ?? "").toUpperCase() === "COMPLETED";
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
    run_attempt?: unknown;
    created_at?: unknown;
    run_started_at?: unknown;
    updated_at?: unknown;
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
      // W1-T7757: a queued or running run is KEPT, marked by its `status`, because its required jobs
      // may have concluded already. It carries no `conclusion`, so every reader of a run's verdict
      // (the guards, the first-red search, the latency samples) still sees completed runs only.
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
        ...(typeof run.run_attempt === "number" ? { runAttempt: run.run_attempt } : {}),
        ...(typeof run.conclusion === "string" ? { conclusion: run.conclusion } : {}),
        ...(typeof run.status === "string" ? { status: run.status } : {}),
        ...(typeof run.html_url === "string" ? { url: run.html_url } : {}),
        ...(pullRequests.length > 0 ? { pullRequests } : {}),
        ...(typeof run.created_at === "string" ? { createdAt: run.created_at } : {}),
        ...(typeof run.run_started_at === "string" ? { startedAt: run.run_started_at } : {}),
        ...(typeof run.updated_at === "string" ? { completedAt: run.updated_at } : {}),
      };
    })
    .filter((run): run is MainHealthRunHistoryEntry => run !== undefined);
}

interface FirstParentCommit {
  sha?: unknown;
  parents?: ReadonlyArray<{ sha?: unknown }>;
  commit?: { committer?: { date?: unknown } };
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
): Promise<MainFirstParentWindow> {
  const page = await fetch(["api", `repos/${owner}/${repo}/commits?sha=${headSha}&per_page=100`]);
  if (!Array.isArray(page)) throw new Error("GitHub's commit list for main's head was not a list");
  const commits = page as FirstParentCommit[];
  const parentOf = new Map<string, unknown>(commits.map((commit) => [String(commit?.sha), commit?.parents?.[0]?.sha]));
  if (!parentOf.has(headSha)) throw new Error(`GitHub's commit list did not hold main's head ${headSha}`);
  const committedAtByCommit = new Map<string, number>();
  for (const commit of commits) {
    const at = typeof commit?.commit?.committer?.date === "string" ? timeMs(commit.commit.committer.date) : undefined;
    if (at !== undefined) committedAtByCommit.set(String(commit.sha), at);
  }
  const order: string[] = [];
  const shas = new Set<string>();
  const committedAtMs = new Map<string, number>();
  let at: unknown = headSha;
  while (typeof at === "string" && parentOf.has(at) && !shas.has(at) && order.length < MAIN_HEALTH_FALLBACK_WINDOW_COMMITS) {
    order.push(at);
    shas.add(at);
    const when = committedAtByCommit.get(at);
    if (when !== undefined) committedAtMs.set(at, when);
    at = parentOf.get(at);
  }
  return { order, shas, committedAtMs };
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

/** What a revert's culprit is proven against: main's push run history and ci-gate's required checks. */
interface RepairEvidence {
  readonly runHistory?: readonly MainHealthRunHistoryEntry[];
  readonly required: ReadonlySet<string>;
  /** W1-T9678: the workflows learned to carry the required checks, as the first-red boundary reads them. */
  readonly requiredWorkflows?: ReadonlySet<string>;
}

/** One red observation, as the repair lane acts on it. */
interface RepairContext {
  readonly observation: MainHealthObservation;
  readonly sha: string;
  readonly branch: string;
  readonly failures: readonly CiFailure[];
  readonly atMs: number;
  readonly red: MainRedSignature;
  readonly evidence?: RepairEvidence;
}

/** The flake-incident gardener's FLAKE_INCIDENT_MAIN_INHERITED_STEP, spelled here so this module (imported by
 *  sweep.ts) never loads the gardener's filing graph; a test pins the two equal. */
export const MAIN_INHERITED_HINT_SOURCE_STEP = "flake_incident.main_inherited";
const FLAKE_INCIDENT_MAIN_INHERITED_STEP = MAIN_INHERITED_HINT_SOURCE_STEP;

/** W1-T9551: a `flake_incident.main_inherited` row — a red no retry recovered — that this rung has not answered. */
export interface MainInheritedHint {
  origin: string;
  file: string;
  title: string;
  prs: number[];
  prsCount: number;
}

/** The rows that answer a hint, each once per PR count: covered by a repair, main green on it, or main still red on it. */
export const MAIN_INHERITED_HINT_STEPS = Object.freeze({
  covered: "main.health.inherited_hint_covered",
  resolved: "main.health.inherited_hint_resolved",
  confirmed: "main.health.inherited_hint_confirmed",
});

/** Reads only the bytes appended since its last call and parses only hint and answer lines, so a pass
 *  every two minutes never re-parses the ledger. A file that shrank (compaction) is re-read from 0. */
export function mainInheritedHintReader(ledgerPath: string): () => { pending: MainInheritedHint[]; torn: number } {
  let offset = 0;
  let decoder = new StringDecoder("utf8");
  let carry = "";
  let torn = 0;
  const latest = new Map<string, MainInheritedHint>();
  const answered = new Map<string, number>();
  const take = (line: string): void => {
    if (!line.includes(FLAKE_INCIDENT_MAIN_INHERITED_STEP) && !line.includes("main.health.inherited_hint_")) return;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      torn++; // counted and returned: a torn line is not an absent one
      void error;
      return;
    }
    const prsCount = typeof row.prs_count === "number" ? row.prs_count : 0;
    if (typeof row.origin !== "string") return;
    if (row.step === FLAKE_INCIDENT_MAIN_INHERITED_STEP && typeof row.file === "string") {
      if ((latest.get(row.origin)?.prsCount ?? -1) > prsCount) return;
      const prs = Array.isArray(row.prs) ? row.prs.filter((n): n is number => typeof n === "number") : [];
      latest.set(row.origin, { origin: row.origin, file: row.file, title: typeof row.title === "string" ? row.title : "", prs, prsCount });
    } else if (typeof row.step === "string" && row.step.startsWith("main.health.inherited_hint_")) {
      answered.set(row.origin, Math.max(answered.get(row.origin) ?? -1, prsCount));
    }
  };
  return () => {
    // Size the descriptor it reads, never the path (CodeQL js/file-system-race): the ledger rotates under the daemon.
    let fd: number | undefined;
    try { fd = openSync(ledgerPath, "r"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try {
      const size = fd === undefined ? 0 : fstatSync(fd).size;
      if (size < offset) {
        offset = 0;
        decoder = new StringDecoder("utf8");
        carry = "";
        latest.clear();
        answered.clear();
      }
      const chunk = Buffer.alloc(fd !== undefined && size > offset ? 1 << 20 : 0);
      while (fd !== undefined && offset < size) {
        const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
        if (n <= 0) break;
        offset += n;
        const lines = (carry + decoder.write(chunk.subarray(0, n))).split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) take(line);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    return { pending: [...latest.values()].filter((h) => (answered.get(h.origin) ?? -1) < h.prsCount), torn };
  };
}

/** Whether a repair's red names the hint's test: its `not ok <title>` line, or for a file-level hint, the file. */
function repairCoversHint(record: MainRepairRecord, hint: MainInheritedHint): boolean {
  if (hint.title !== "") return record.red?.detail?.includes(`not ok ${hint.title}`) === true;
  return record.inherited?.testFiles.includes(hint.file) === true;
}

/** Whether main's own red, read this pass, still fails the hint's test. */
function redNamesHint(red: MainRedSignature, failures: readonly CiFailure[], hint: MainInheritedHint): boolean {
  if (hint.title !== "") return red.detail?.includes(`not ok ${hint.title}`) === true;
  return failures.some((failure) => failure.logTail.includes(hint.file));
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
  const localProbes = new Set<string>();
  let runHistoryCache: RunHistoryCache | undefined;
  let metPrCache: { sha: string; lookup: MetPrLookup } | undefined;
  // Which push workflows carry ci-gate's required checks, learned from the jobs pages read below and
  // kept across heads: CodeQL, Semgrep, Scorecard and main-tripwire finish minutes before CI, so
  // they crowd the newest completed history, and each one read costs a jobs read. A workflow is
  // passed over only once a run of it with jobs held no required check, and never once one did.
  // Keyed by the required set, so a changed ci-gate list relearns from scratch.
  let workflowEvidence: WorkflowEvidence | undefined;
  const learnedFor = (required: ReadonlySet<string>): WorkflowEvidence => {
    const key = [...required].sort().join(",");
    if (workflowEvidence?.required !== key) workflowEvidence = { required: key, carries: new Set(), carriesNone: new Set() };
    return workflowEvidence;
  };
  /** One run's jobs through the per-head cache; a running run is cached only once its required jobs concluded (W1-T7757). */
  const jobsOf = async (run: MainHealthRunHistoryEntry, required: ReadonlySet<string>): Promise<RollupCheckEntry[]> => {
    const jobsKey = `${run.runId}#${run.runAttempt ?? 1}`;
    const cached = runHistoryCache?.jobsByRunId.get(jobsKey);
    if (cached) return cached;
    const jobs = rollupFromJobs(
      (await deps.fetch(["api", `repos/${owner}/${repo}/actions/runs/${run.runId}/jobs?per_page=100`])) as WorkflowJobsResponse,
    );
    if (!mainRunIsInProgress(run) || judgedRollup(jobs, required).every(jobConcluded)) runHistoryCache?.jobsByRunId.set(jobsKey, jobs);
    return jobs;
  };
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
  // The red this observation repairs, and the run history a culprit is proven against: set on each
  // red observation before the lane runs, so a repair the lane already owns is advanced on them too.
  let currentRed: MainRedSignature | undefined;
  let repairEvidence: RepairEvidence | undefined;
  // Why the lane handed this red back without a revert, for the escalation it then raises.
  let withheldNote: string | undefined;
  let repairsMayBeActive = true;
  const fixInFlight = new Set<string>();
  const fixProgress = new Map<string, { marker: string; ticks: number; sinceMs: number }>();
  // The recorded-baseline repair of a ratchet-only red: the one open PR that owns it (this lane's
  // own, or one already open that records it), the red the opener declined, and the PRs it opened.
  let ratchetInFlight = false;
  let ratchetPrUrl: string | undefined;
  let ratchetDeclinedSignature: string | undefined;
  const ratchetOpened = new Set<string>();
  const readHints = mainInheritedHintReader(deps.ledgerPath);
  const hintFields = (hint: MainInheritedHint): Record<string, unknown> =>
    ({ origin: hint.origin, file: hint.file, title: hint.title, prs: hint.prs, prs_count: hint.prsCount });
  /** W1-T9551: answer each pending main-inherited hint once. A repair whose red names it covers it; on a
   *  green main it is resolved; on a red main that still fails it, the red path below repairs it. */
  const answerHints = (sha: string, state: string, red?: { signature: MainRedSignature; failures: readonly CiFailure[] }): void => {
    const { pending, torn } = readHints();
    if (torn > 0 && pending.length > 0) deps.log("main.health.inherited_hint_torn", { torn });
    if (pending.length === 0) return;
    const records = [...mainRepairRecordsFromLedger(readLedgerLines(deps.ledgerPath)).values()];
    for (const hint of pending) {
      const covering = records.find((record) => repairCoversHint(record, hint));
      if (covering) {
        deps.log(MAIN_INHERITED_HINT_STEPS.covered, {
          ...hintFields(hint), offending_sha: covering.offendingSha, fix_pr_url: covering.fixPrUrl ?? null, repair_resolved: covering.resolved,
        });
      } else if (state === "green") {
        deps.log(MAIN_INHERITED_HINT_STEPS.resolved, { ...hintFields(hint), head_sha: sha });
      } else if (red && redNamesHint(red.signature, red.failures, hint)) {
        deps.log(MAIN_INHERITED_HINT_STEPS.confirmed, { ...hintFields(hint), head_sha: sha, red_signature: describeMainRed(red.signature) });
      }
    }
  };
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
      return diffStatLines(((await deps.fetch(["api", `repos/${owner}/${repo}/commits/${sha}`])) as RestCommitRead)?.files ?? []);
    } catch (error) {
      return `(diff stat unreadable: ${String((error as Error)?.message ?? error)})`;
    }
  };
  /** W1-T9665 — whether `files` select a failing test file through the affected-suites import graph. */
  const reachOf = async (files: readonly string[], testFiles: readonly string[]): Promise<Pick<MainRepairMerge, "reachesFailingTests" | "reached" | "reachUnknown">> => {
    if (testFiles.length === 0) return { reachUnknown: "no failing test file was parsed from the log" };
    const direct = testFiles.filter((path) => files.includes(path));
    const unless = (why: string) => (direct.length > 0 ? { reachesFailingTests: true, reached: direct } : { reachUnknown: why });
    if (!deps.readAffectedInput) return unless("no affected-suites input is wired");
    let input: AffectedSuitesInput;
    try {
      input = await deps.readAffectedInput(files);
    } catch (error) {
      return unless(`the affected-suites input is unreadable: ${String((error as Error)?.message ?? error)}`);
    }
    const selection = selectAffectedSuites(files, input);
    if (selection.fullRun) return unless(selection.reasons[0] ?? "the selector does not model this merge");
    const reached = testFiles.filter((path) => direct.includes(path) || selection.suites.includes(path));
    if (reached.length > 0) return { reachesFailingTests: true, reached };
    const absent = testFiles.filter((path) => !input.files.has(path));
    if (absent.length > 0) return { reachUnknown: `the import graph was read from a tree without ${absent.join(", ")}` };
    return { reachesFailingTests: false };
  };
  /** W1-T9665 — every first-parent merge after the last green main up to `headSha`, oldest first. */
  const mergesSinceGreenOf = async (first: MainHealthFirstRedCommit | undefined, headSha: string, testFiles: readonly string[]): Promise<MainRepairMergesSinceGreen> => {
    if (!first) return { merges: [], unreadable: "this observation read no last green main" };
    const read: Array<{ sha: string; commit: RestCommitRead }> = [];
    try {
      for (let at = headSha; at !== first.afterGreenSha; ) {
        if (read.some((entry) => entry.sha === at)) throw new Error(`the first-parent chain from ${headSha} loops at ${at}`);
        const commit = (await deps.fetch(["api", `repos/${owner}/${repo}/commits/${at}`])) as RestCommitRead;
        read.unshift({ sha: at, commit });
        const parent = commit?.parents?.[0]?.sha;
        if (typeof parent !== "string") throw new Error(`the first-parent chain from ${headSha} ends at ${at}, short of ${first.afterGreenSha}`);
        at = parent;
      }
    } catch (error) {
      return { afterGreenSha: first.afterGreenSha, merges: [], unreadable: String((error as Error)?.message ?? error) };
    }
    const merges: MainRepairMerge[] = [];
    for (const { sha, commit } of read) {
      const files = (commit.files ?? []).filter((file) => typeof file.filename === "string");
      const paths = files.map((file) => String(file.filename));
      const reach = await reachOf(paths, testFiles);
      const pr = squashPrNumber(commit.commit?.message);
      const diff = files.map((file) => `diff --git a/${file.filename} b/${file.filename}\n${typeof file.patch === "string" ? file.patch : "(no patch: binary or too large)"}`);
      merges.push({
        sha,
        ...(pr !== undefined ? { pr } : {}),
        subject: String(commit.commit?.message ?? "").split("\n")[0] ?? "",
        files: paths,
        diffStat: diffStatLines(files),
        ...reach,
        ...(reach.reachesFailingTests ? { diff: headWithOmission(diff.join("\n"), MAIN_REPAIR_LOG_EXCERPT_CHARS) } : {}),
      });
    }
    return { afterGreenSha: first.afterGreenSha, merges };
  };
  /** The fix worker runs for minutes, so it is never awaited here: its outcome lands as a ledger row. */
  const dispatchFix = (lane: MainRepairLane, request: MainRepairFixRequest, red?: MainRedSignature): void => {
    const at = { offending_sha: request.offendingSha, offending_pr: request.offendingPr };
    repairRow("main.repair.fix_dispatched", {
      ...at,
      head_sha: request.headSha,
      failing_checks: request.failingChecks,
      ...(red ? mainRedFields(red) : {}),
    });
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
  /** The fix request for `offendingSha`, built from what this observation read. */
  const fixRequestFor = async (
    observation: MainHealthObservation,
    sha: string,
    branch: string,
    offendingSha: string,
    offendingPr: number | undefined,
    failures: readonly CiFailure[],
    reason: string,
  ): Promise<MainRepairFixRequest> => {
    const testFiles = baseReproductionFiles(failures);
    return {
      branch,
      headSha: sha,
      offendingSha,
      ...(offendingPr !== undefined ? { offendingPr } : {}),
      diffStat: await diffStatOf(offendingSha),
      failingChecks: [...observation.failingChecks],
      failingTestTitles: [...(observation.failingTestTitles ?? [])],
      testFiles,
      logExcerpt: logExcerptOf(failures, [...observation.failingChecks, ...failures.map((failure) => failure.name)]),
      reason,
      mergesSinceGreen: await mergesSinceGreenOf(observation.firstRedCommit, sha, testFiles),
    };
  };
  /** W1-T8042 — the fix request for a red the sweep handed over, built from the PR evidence it carried. */
  const inheritedFixRequest = async (
    record: MainRepairRecord,
    inherited: NonNullable<MainRepairRecord["inherited"]>,
    sha: string,
    branch: string,
    why: string,
    first: MainHealthFirstRedCommit | undefined,
  ): Promise<MainRepairFixRequest> => ({
    branch,
    headSha: sha,
    offendingSha: record.offendingSha,
    diffStat: await diffStatOf(record.offendingSha),
    failingChecks: [...record.failingChecks],
    failingTestTitles: (record.red?.detail ?? []).filter((line) => line.startsWith("not ok ")).map((line) => line.slice("not ok ".length)),
    testFiles: [...inherited.testFiles],
    logExcerpt: inherited.logExcerpt.slice(-MAIN_REPAIR_LOG_EXCERPT_CHARS),
    reason:
      `${why}; the same red is on open PRs ${inherited.prs.map((n) => `#${n}`).join(", ")}, whose own diffs touch none of ` +
      `the files it names, and ${record.offendingSha.slice(0, 12)} is in every one's merge base and no green PR's (W1-T8042)`,
    mergesSinceGreen: await mergesSinceGreenOf(first, sha, inherited.testFiles),
  });
  /** W1-T8042 — main's own runs concluded nothing, so a red the sweep handed over is this lane's only
   *  evidence: dispatch its first fix. Once dispatched, the record advances like any other. */
  const repairInheritedReds = async (lane: MainRepairLane, observation: MainHealthObservation, sha: string, branch: string): Promise<void> => {
    for (const record of mainRepairRecordsFromLedger(readLedgerLines(deps.ledgerPath)).values()) {
      if (record.resolved || !record.inherited || record.fixDispatched || fixInFlight.has(record.offendingSha)) continue;
      dispatchFix(lane, await inheritedFixRequest(record, record.inherited, sha, branch, observation.reason, observation.firstRedCommit), record.red);
    }
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
  /** One completed run of `commitSha` that carries ci-gate's required checks and concluded, read from
   *  its jobs; undefined when main's push run history holds none (a cancelled run concluded nothing). */
  const concludedRunOf = async (
    commitSha: string,
    history: readonly MainHealthRunHistoryEntry[],
    required: ReadonlySet<string>,
  ): Promise<{ run: MainHealthRunHistoryEntry; jobs: RollupCheckEntry[]; verdict: MainHealthObservation } | undefined> => {
    for (const run of mainHealthFallbackCandidates(history).filter((candidate) => candidate.headSha === commitSha)) {
      const jobsKey = `${run.runId}#${run.runAttempt ?? 1}`;
      const jobs =
        runHistoryCache?.jobsByRunId.get(jobsKey) ??
        rollupFromJobs(
          (await deps.fetch(["api", `repos/${owner}/${repo}/actions/runs/${run.runId}/jobs?per_page=100`])) as WorkflowJobsResponse,
        );
      runHistoryCache?.jobsByRunId.set(jobsKey, jobs);
      if (judgedRollup(jobs, required).length === 0) continue;
      const verdict = mainHealthFromRollup(commitSha, jobs, required.size > 0 ? required : undefined, undefined, { cancelledIsPending: true });
      if (verdict.state === "red" || verdict.state === "green") return { run, jobs, verdict };
    }
    return undefined;
  };
  /**
   * A located merge is the culprit only when that is PROVEN: its own completed run is red on this
   * repair's red, and its first parent's completed run is green. The locator's answer alone is not
   * proof — on 2026-10-10 it named a different merge on each of seven passes. `unreadable` means a
   * read failed, which decides nothing: the next observation asks again.
   */
  const proveCulprit = async (
    record: MainRepairRecord,
    red: MainRedSignature,
    evidence: RepairEvidence | undefined,
    testFiles: readonly string[],
  ): Promise<{ proven: true; detail: string } | { proven: false; reason: string } | { unreadable: string }> => {
    const sha = record.offendingSha;
    if (record.bisected) {
      if (record.bisected.localRuns) {
        const files = testFiles.length > 0 ? testFiles : record.bisected.testFiles;
        const matches = (commit: string, verdict: MainProbeVerdict): boolean => {
          const run = record.bisected!.localRuns!.find((probe) => probe.sha === commit);
          const named = Array.isArray(run?.files) ? run.files : [];
          return files.length > 0 && run?.method === "local-test" && run.verdict === verdict &&
            named.length === files.length && files.every((file) => named.includes(file)) &&
            Array.isArray(run.outcomes) && localProbeVerdict(files, run.outcomes as BaseProbeResult) === verdict;
        };
        if (!matches(sha, "red") || !matches(record.bisected.parentSha, "green")) {
          return { proven: false, reason: "local culprit proof needs a failing culprit and a passing first parent on the same failing test files" };
        }
      }
      // Located by probing CI on the commits whose own push run was cancelled: the probe runs, recorded
      // on the located row, are the proof, because main's push run history holds none for them.
      const probed = record.bisected.failingChecks;
      if (probed.length > 0 && !mainRedSignaturesMatch(mainRedSignature(probed, undefined), red)) {
        return { proven: false, reason: `\`${sha}\`'s probe run is red on ${probed.join(", ")}, not on this repair's ${describeMainRed(red)}` };
      }
      return {
        proven: true,
        detail: `\`${sha}\` was bisected: its probe run is red and its first parent \`${record.bisected.parentSha}\` is green (${record.bisected.evidence})`,
      };
    }
    const history = evidence === undefined ? undefined : evidence.runHistory;
    if (history === undefined) return { proven: false, reason: "main's push run history was not read" };
    try {
      const own = await concludedRunOf(sha, history, evidence!.required);
      if (!own) {
        return { proven: false, reason: `\`${sha}\` has no completed run carrying the required checks in main's push run history (a cancelled run concluded nothing)` };
      }
      if (own.verdict.state !== "red") return { proven: false, reason: `\`${sha}\`'s own completed run ${own.run.runId} is ${own.verdict.state}, not red` };
      const failingShards = earlyRedEvidenceRollup(own.jobs, own.verdict.failingChecks).filter(
        (entry) =>
          !own.verdict.failingChecks.includes(entry.name ?? "") &&
          REQUIRED_CHECK_FAIL.has(String(entry.conclusion ?? entry.state ?? "").toUpperCase()) &&
          String(entry.conclusion ?? "").toUpperCase() !== "CANCELLED",
      );
      const read = [...judgedRollup(own.jobs, new Set(own.verdict.failingChecks)), ...failingShards];
      const failures = deps.readCiFailures ? await deps.readCiFailures(read) : undefined;
      const ownRed = mainRedSignature([...own.verdict.failingChecks, ...failingShards.map((entry) => entry.name ?? "")], failures);
      if (!mainRedSignaturesMatch(ownRed, red)) {
        return { proven: false, reason: `\`${sha}\`'s own completed run ${own.run.runId} is red on ${describeMainRed(ownRed)}, not on this repair's ${describeMainRed(red)}` };
      }
      const commit = (await deps.fetch(["api", `repos/${owner}/${repo}/commits/${sha}`])) as { parents?: ReadonlyArray<{ sha?: unknown }> };
      const parent = commit?.parents?.[0]?.sha;
      if (typeof parent !== "string") return { unreadable: `GitHub's read of \`${sha}\` named no first parent` };
      const before = await concludedRunOf(parent, history, evidence!.required);
      if (!before) {
        return { proven: false, reason: `its first parent \`${parent}\` has no completed run carrying the required checks (cancelled, or outside the run-history window)` };
      }
      if (before.verdict.state !== "green") return { proven: false, reason: `its first parent \`${parent}\`'s completed run ${before.run.runId} is ${before.verdict.state}, not green` };
      return { proven: true, detail: `\`${sha}\`'s run ${own.run.runId} is red on ${describeMainRed(red)} and its first parent \`${parent}\`'s run ${before.run.runId} is green` };
    } catch (error) {
      return { unreadable: String((error as Error)?.message ?? error) };
    }
  };
  /** The fix-progress judge's ruling on whether another attempt at this red is warranted, recorded
   *  once per ended attempt; undefined when it could not rule this pass (asked again next pass). */
  const judgeAnotherAttempt = async (record: MainRepairRecord, red: MainRedSignature, sha: string, why: string): Promise<FixProgressVerdict | undefined> => {
    const attempt = record.attempts.length;
    if (record.judgement?.attempt === attempt) return record.judgement.verdict;
    const redList = (r: MainRedSignature) => [...r.checks, ...(r.detail ?? [])];
    const current = redList(red);
    const noPr = record.attempts.filter((a) => a.outcome === "no_pr").length;
    const input: FixProgressInput = {
      taskId: MAIN_HEALTH_TASK_ID,
      headSha: sha,
      strikesSpent: attempt,
      currentRed: current,
      rounds: record.attempts.map((a, index) => ({
        id: `${record.offendingSha}#${index + 1}`,
        ...(a.headSha ? { dispatchedHead: a.headSha } : {}),
        ...(a.outcome ? { fixOutcome: a.outcome === "no_pr" ? "NO_PR" : "PR_OPENED" } : {}),
        ...(a.reason ? { refusal: a.reason } : {}),
        redBefore: current,
        redAfter: current,
        completed: a.outcome !== undefined,
      })),
      parkedReason: `red main ${describeMainRed(red)}, located at merge ${record.offendingSha}: ${why}`,
      signals: {
        noOpRounds: noPr,
        identicalRedSets: record.attempts.length,
        identicalDiffs: 0,
        oscillating: false,
        refusedRounds: noPr,
        incompleteRounds: record.attempts.filter((a) => a.outcome === undefined).length,
        reviewerOnlyFailurePersists: 0,
      },
    };
    const result = await judgeFixProgress(input, deps.judgeRepairProgress);
    if (result.verdict === "unavailable") {
      deps.log("main.repair.progress_unjudged", { offending_sha: record.offendingSha, attempt, reason: result.reason });
      return undefined;
    }
    repairRow("main.repair.progress_judged", {
      offending_sha: record.offendingSha,
      head_sha: sha,
      attempt,
      verdict: result.verdict,
      reason: result.reason,
      ...(result.verdict === "change-approach" ? { approach: result.approach } : {}),
      ...(result.verdict === "escalate" ? { loop: result.loop } : {}),
    });
    return result;
  };
  /** One step of an existing repair. True while the lane still owns this red; false when it was refused. */
  const advanceRepair = async (lane: MainRepairLane, record: MainRepairRecord, ctx: RepairContext): Promise<boolean> => {
    const { sha, branch, atMs } = ctx;
    if (record.revertWithheld) {
      withheldNote = `the repair lane withheld its revert of \`${record.offendingSha}\`: ${record.revertWithheld}`;
      return false;
    }
    if (record.revertRefused) return false;
    if (record.revertPrUrl) return (await readRepairPr(record.revertPrUrl))?.state !== "closed";
    if (fixInFlight.has(record.offendingSha)) return true;
    if (record.inherited && !record.fixDispatched) {
      dispatchFix(lane, await inheritedFixRequest(record, record.inherited, sha, branch, ctx.observation.reason, ctx.observation.firstRedCommit), record.red ?? ctx.red);
      return true;
    }
    let stalled: string | undefined;
    let attemptEnded = false;
    if (record.fixPrUrl) {
      const fix = await readRepairPr(record.fixPrUrl);
      if (!fix) return true;
      attemptEnded = fix.state === "closed";
      stalled =
        fix.state === "closed"
          ? `fix PR ${record.fixPrUrl} closed unmerged while main stayed red`
          : stallOf(record.offendingSha, `${fix.state}:${fix.headSha ?? ""}`, atMs, `fix PR ${record.fixPrUrl}`);
    } else if (record.fixRefused) {
      attemptEnded = true;
      stalled = `the fix run opened no fix PR: ${record.fixRefused}`;
    } else {
      stalled = stallOf(record.offendingSha, "no-pr", atMs, "the fix run, dispatched before this daemon process started,");
    }
    if (!stalled) return true;
    const red = record.red ?? ctx.red;
    // An attempt that ended without a fix is not re-dispatched by rote, and not reverted over by rote:
    // the fix-progress judge rules whether another attempt at this same red is warranted.
    if (attemptEnded && deps.judgeRepairProgress) {
      const ruling = await judgeAnotherAttempt(record, red, sha, stalled);
      if (!ruling) return true;
      if (ruling.verdict !== "escalate") {
        fixProgress.delete(record.offendingSha);
        const approach = ruling.verdict === "change-approach" ? ` Take this approach: ${ruling.approach}` : "";
        const reason =
          `${ctx.observation.reason}. Attempt ${record.attempts.length + 1} at this red: the last one ended without a fix ` +
          `(${stalled}); the fix-progress judge ruled another attempt warranted: ${ruling.reason}.${approach}`;
        dispatchFix(lane, await fixRequestFor(ctx.observation, sha, branch, record.offendingSha, record.offendingPr, ctx.failures, reason), red);
        return true;
      }
      stalled = `${stalled}; the fix-progress judge ruled no further attempt: ${ruling.reason}`;
    }
    const at = { offending_sha: record.offendingSha, offending_pr: record.offendingPr, head_sha: sha };
    const proof = await proveCulprit(record, red, ctx.evidence, baseReproductionFiles(ctx.failures));
    if ("unreadable" in proof) {
      deps.log("main.repair.proof_unreadable", { ...at, error: proof.unreadable });
      return true;
    }
    if (!proof.proven) {
      repairRow("main.repair.revert_withheld", { ...at, reason: proof.reason, why_fix_insufficient: stalled, ...mainRedFields(red) });
      withheldNote = `the repair lane withheld its revert of \`${record.offendingSha}\`: ${proof.reason}`;
      return false;
    }
    let outcome: MainRepairRevertOutcome;
    try {
      outcome = await lane.openRevertPr({
        branch,
        headSha: sha,
        offendingSha: record.offendingSha,
        ...(record.offendingPr !== undefined ? { offendingPr: record.offendingPr } : {}),
        failingChecks: record.failingChecks,
        ...(record.fixPrUrl ? { fixPrUrl: record.fixPrUrl } : {}),
        whyFixInsufficient: `${stalled}; culprit proven: ${proof.detail}`,
      });
    } catch (error) {
      outcome = { refused: String((error as Error)?.message ?? error) };
    }
    if ("prUrl" in outcome) {
      repairRow("main.repair.revert_opened", { ...at, pr_url: outcome.prUrl, fix_pr_url: record.fixPrUrl, reason: stalled, proof: proof.detail });
      return true;
    }
    repairRow("main.repair.revert_refused", { ...at, reason: outcome.refused, conflict_paths: outcome.conflictPaths ?? [] });
    return false;
  };
  let restProbes: MainRepairProbes | undefined;
  const spanCache = new Map<string, readonly string[] | null>();
  /** The unattributed commits between the first red's last green and it, newest first; undefined when
   *  main's first-parent chain could not be read between them (named in the log, never guessed). */
  const spanOf = async (first: MainHealthFirstRedCommit, history: readonly MainHealthRunHistoryEntry[], verdictKey: string): Promise<readonly string[] | undefined> => {
    if (first.span) return first.span;
    const key = `${first.headSha}..${first.afterGreenSha}:${history.length}:${verdictKey}`;
    const cached = spanCache.get(key);
    if (cached !== undefined) return cached ?? undefined;
    try {
      const order = [first.headSha];
      while (order[order.length - 1] !== first.afterGreenSha) {
        const at = order[order.length - 1]!;
        const commit = (await deps.fetch(["api", `repos/${owner}/${repo}/commits/${at}`])) as { parents?: ReadonlyArray<{ sha?: unknown }> };
        const parent = commit?.parents?.[0]?.sha;
        if (typeof parent !== "string") throw new Error(`the first-parent chain from ${first.headSha} ends at ${at}, short of ${first.afterGreenSha}`);
        if (order.includes(parent)) throw new Error(`the first-parent chain from ${first.headSha} loops at ${parent}`);
        order.push(parent);
      }
      const span = mainHealthUnattributedSpan(order, first, history) ?? null;
      spanCache.set(key, span);
      return span ?? undefined;
    } catch (error) {
      deps.log("main.repair.span_unread", { first_red_sha: first.headSha, after_green_sha: first.afterGreenSha, error: String((error as Error)?.message ?? error) });
      return undefined;
    }
  };
  /**
   * W1-T7760 — which commit the lane names, and never by naming a commit whose CI was cancelled. An
   * empty span names the first completed red at once. A non-empty one is PROBED: CI runs on each
   * commit under its own ref until the first red is bounded by a completed green; until then no fix is
   * dispatched. A span that cannot be read falls back to the completed red, as before, and is logged.
   */
  const locateOffender = async (
    lane: MainRepairLane,
    first: MainHealthFirstRedCommit,
    ctx: RepairContext,
    lines: readonly Record<string, unknown>[],
  ): Promise<
    | { kind: "named"; sha: string; pr?: number; method: string; fields: Record<string, unknown>; probeVerdicts: ReadonlyMap<string, MainProbeVerdict> }
    | { kind: "probing" }
    | { kind: "unlocated"; reason: string }
  > => {
    const history = ctx.evidence?.runHistory ?? [];
    const asFirstRed = {
      kind: "named" as const,
      sha: first.headSha,
      ...(first.pullRequest?.number !== undefined ? { pr: first.pullRequest.number } : {}),
      method: "first-red-run",
      fields: {},
      probeVerdicts: new Map<string, MainProbeVerdict>(),
    };
    // W1-T9678: only a run of a workflow carrying the required checks is a verdict; with that set unknown, none is.
    const workflows = ctx.evidence?.requiredWorkflows;
    const verdictRuns = workflows ? history.filter((run) => run.workflowName === undefined || workflows.has(run.workflowName)) : [];
    const span = await spanOf(first, verdictRuns, workflows ? [...workflows].sort().join(",") : "unknown");
    if (span === undefined || span.length === 0) return asFirstRed;
    const probes = lane.probes ?? (restProbes ??= restMainProbes(owner, repo, deps.fetch));
    const state = mainBisectionFromLedger(lines, first.headSha);
    const required = ctx.evidence?.required ?? new Set<string>();
    const at = { first_red_sha: first.headSha, after_green_sha: first.afterGreenSha };
    const testFiles = baseReproductionFiles(ctx.failures);
    const localKey = (sha: string) => `${first.headSha}:${sha}`;
    const startLocal = (sha: string): void => {
      localProbes.add(localKey(sha));
      repairRow("main.repair.bisecting", { ...at, method: "local-test", head_sha: ctx.sha, span: [...span],
        files: testFiles, probes: [{ sha, ref: `local-test/${sha}` }] });
      void Promise.resolve().then(() => lane.reproduceAt!(sha, testFiles))
        .catch((error: unknown) => {
          const reason = String(error);
          return baseProbeSetupFailure(testFiles, reason);
        })
        .then((outcomes) => {
          repairRow("main.repair.probe_concluded", { ...at, method: "local-test", probe_sha: sha, ref: `local-test/${sha}`,
            verdict: localProbeVerdict(testFiles, outcomes), files: testFiles, outcomes: [...outcomes],
            ...(outcomes.setup_error ? { setup_error: outcomes.setup_error } : {}),
            ...(outcomes.reason ? { reason: outcomes.reason } : {}) });
        }).finally(() => localProbes.delete(localKey(sha)))
        .catch((error: unknown) => deps.log("main.repair.probe_unreadable", { ...at, probe_sha: sha, error: String(error) }));
    };
    for (const probe of [...state.inFlight.values()]) {
      if (probe.ref.startsWith("local-test/")) {
        if (!localProbes.has(localKey(probe.sha))) state.inFlight.delete(probe.sha);
        continue;
      }
      let reading: MainProbeReading;
      try {
        reading = await probes.read(probe);
      } catch (error) {
        deps.log("main.repair.probe_unreadable", { ...at, probe_sha: probe.sha, error: String((error as Error)?.message ?? error) });
        continue;
      }
      if (reading.status !== "completed") continue;
      const judged = mainHealthFromRollup(probe.sha, [...(reading.jobs ?? [])], required.size > 0 ? required : undefined, undefined, { cancelledIsPending: true });
      const verdict: MainProbeVerdict = judged.state === "green" ? "green" : judged.state === "red" ? "red" : "inconclusive";
      const runUrl = reading.runUrl ?? probe.runUrl;
      repairRow("main.repair.probe_concluded", {
        ...at,
        probe_sha: probe.sha,
        ref: probe.ref,
        verdict,
        failing_checks: [...judged.failingChecks],
        reason: judged.reason,
        ...((reading.runId ?? probe.runId) !== undefined ? { run_id: reading.runId ?? probe.runId } : {}),
        ...(runUrl ? { run_url: runUrl } : {}),
      });
      state.inFlight.delete(probe.sha);
      if (verdict === "inconclusive") state.verdicts.delete(probe.sha);
      else {
        state.verdicts.set(probe.sha, verdict);
        state.evidence.set(probe.sha, { verdict, ...(runUrl ? { runUrl } : {}), failingChecks: [...judged.failingChecks] });
      }
      try {
        await probes.release(probe);
      } catch (error) {
        deps.log("main.repair.probe_ref_not_released", { ...at, probe_sha: probe.sha, ref: probe.ref, error: String((error as Error)?.message ?? error) });
      }
    }
    const planFor = (concurrency: number) =>
      planMainBisection({
        green: first.afterGreenSha,
        red: first.headSha,
        span,
        verdicts: state.verdicts,
        inFlight: new Set(state.inFlight.keys()),
        concurrency,
      });
    let plan = planFor(1);
    if ([...state.inFlight.values()].some((probe) => probe.ref.startsWith("local-test/"))) return { kind: "probing" };
    if (lane.reproduceAt && testFiles.length > 0) {
      if (plan.state === "probe") {
        const local = plan.shas.filter((sha) => !state.localAttempts.has(sha));
        if (local.length > 0) { local.forEach(startLocal); return { kind: "probing" }; }
      } else if ([...state.evidence.values()].some((proof) => proof.method === "local-test")) {
        const needed = [plan.offendingSha, plan.parentSha].filter((sha) => !state.localAttempts.has(sha));
        if (needed.length > 0) {
          for (const sha of needed) if (!state.inFlight.has(sha)) startLocal(sha);
          return { kind: "probing" };
        }
      }
    }
    if (plan.state === "proven") {
      const evidenceOf = (probed: string, fallbackUrl?: string) => ({
        sha: probed,
        verdict: probed === first.headSha || probed === first.afterGreenSha ? (probed === first.headSha ? "red" : "green") : (state.evidence.get(probed)?.verdict ?? "unknown"),
        run_url: state.evidence.get(probed)?.runUrl ?? fallbackUrl ?? null,
        ...(state.evidence.get(probed)?.method === "local-test" ? { method: "local-test",
          files: state.evidence.get(probed)?.files, outcomes: state.evidence.get(probed)?.outcomes } : {}),
      });
      const proven = plan;
      return {
        kind: "named",
        sha: proven.offendingSha,
        ...(proven.offendingSha === first.headSha && first.pullRequest?.number !== undefined ? { pr: first.pullRequest.number } : {}),
        method: "bisected-first-red",
        fields: {
          ...at,
          bisection_of: first.headSha,
          parent_sha: proven.parentSha,
          span: [...span],
          probe_runs: [
            evidenceOf(proven.offendingSha, proven.offendingSha === first.headSha ? first.runUrl : undefined),
            evidenceOf(proven.parentSha),
            ...[...state.evidence.keys()].filter((probed) => probed !== proven.offendingSha && probed !== proven.parentSha).map((probed) => evidenceOf(probed)),
          ],
          probe_failing_checks: state.evidence.get(proven.offendingSha)?.failingChecks ?? [],
        },
        probeVerdicts: new Map([...state.verdicts, [first.headSha, "red" as const]]),
      };
    }
    let load: MainRunnerLoad | undefined;
    let loadUnread: string | undefined;
    try {
      load = await probes.readRunnerLoad();
    } catch (error) {
      loadUnread = String((error as Error)?.message ?? error);
      deps.log("main.repair.runner_load_unread", { ...at, error: loadUnread });
    }
    const concurrency = load ? chooseProbeConcurrency(load) : 1;
    plan = planFor(concurrency);
    if (plan.state === "probe" && plan.shas.length > 0) {
      const local = lane.reproduceAt && testFiles.length > 0 ? plan.shas.filter((sha) => !state.localAttempts.has(sha)) : [];
      if (local.length > 0) { local.forEach(startLocal); return { kind: "probing" }; }
      const medianMs = medianCiRunMs(history);
      const started: MainProbeHandle[] = [];
      const refused: string[] = [];
      for (const probeSha of plan.shas) {
        try {
          let handle = await probes.dispatch(probeSha);
          try {
            const reading = await probes.read(handle);
            if (reading.runId !== undefined) handle = { ...handle, runId: reading.runId, ...(reading.runUrl ? { runUrl: reading.runUrl } : {}) };
          } catch {
            // The run registers a moment after its dispatch; the concluded row carries its id and url.
          }
          started.push(handle);
        } catch (error) {
          refused.push(`${probeSha}: ${String((error as Error)?.message ?? error)}`);
          deps.log("main.repair.probe_dispatch_failed", { ...at, probe_sha: probeSha, error: String((error as Error)?.message ?? error) });
        }
      }
      if (started.length > 0) {
        repairRow("main.repair.bisecting", {
          ...at,
          head_sha: ctx.sha,
          span: [...span],
          open: [...plan.open],
          strategy: plan.strategy,
          probe_shas: started.map((probe) => probe.sha),
          probes: started.map((probe) => ({
            sha: probe.sha,
            ref: probe.ref,
            ...(probe.runId !== undefined ? { run_id: probe.runId } : {}),
            ...(probe.runUrl ? { run_url: probe.runUrl } : {}),
          })),
          concurrency,
          concurrency_reading: load ? { queued_jobs: load.queuedJobs, idle_runners: load.idleRunners } : { unread: loadUnread },
          median_run_ms: medianMs ?? null,
          estimated_probes: plan.estimatedProbes,
          alternative_probes: plan.alternativeProbes,
          estimated_runner_minutes: medianMs !== undefined ? Math.round((plan.estimatedProbes * medianMs) / 600) / 100 : null,
        });
      } else if (state.inFlight.size === 0) {
        // No probe runs, so the span stays unattributed, yet the red is still repaired: a fix needs the failing
        // tests, not a culprit. The completed red is named; its revert needs a culprit proof it does not have.
        return {
          ...asFirstRed,
          method: "first-red-unattributed",
          fields: { ...at, unattributed_span: [...span], attribution_refused: refused },
        };
      }
    }
    return { kind: "probing" };
  };
  /** Locate the offending merge and open its fix PR, or advance the repair already under way. A red
   *  the lane already owns is the SAME repair whichever merge the locator names this pass: the
   *  dedupe is the red's signature, never the located sha. */
  const repairRedMain = async (
    lane: MainRepairLane,
    observation: MainHealthObservation,
    sha: string,
    branch: string,
    failures: readonly CiFailure[],
    atMs: number,
  ): Promise<boolean> => {
    const red = currentRed ?? mainRedSignature(observation.failingChecks, failures);
    const ctx: RepairContext = { observation, sha, branch, failures, atMs, red, evidence: repairEvidence };
    const records = mainRepairRecordsFromLedger(readLedgerLines(deps.ledgerPath));
    const first = observation.firstRedCommit;
    const active = [...records.values()].filter((record) => !record.resolved);
    const owning = active.findLast((r) => r.red !== undefined && (r.inherited ? mainRedCovers(r.red, red) : mainRedSignaturesMatch(r.red, red)));
    const record = first ? (active.find((r) => r.offendingSha === first.headSha) ?? owning) : (owning ?? active[active.length - 1]);
    if (record) {
      if (first && record.offendingSha !== first.headSha) {
        deps.log("main.repair.same_red", { head_sha: sha, offending_sha: record.offendingSha, located_sha: first.headSha, ...mainRedFields(red) });
      }
      return advanceRepair(lane, record, ctx);
    }
    const lines = readLedgerLines(deps.ledgerPath);
    if (!first) {
      // A bisection that has not located its offender is the lane still owning this red; an observation
      // that carries no first red (the cached path reads none) must not file it as unlocated.
      if (lines.some((line) => line.step === "main.repair.bisecting" && !lines.some((l) => l.step === "main.repair.located" && l.bisection_of === line.first_red_sha))) {
        deps.log("main.repair.bisection_pending", { head_sha: sha });
        return false;
      }
      repairRow("main.repair.unlocated", {
        head_sha: sha,
        failing_checks: observation.failingChecks,
        reason: observation.runHistoryWindowExhausted
          ? "main's push run history window holds no green run to bound the red streak"
          : "main's push run history names no first red merge after a green run",
      });
      return false;
    }
    const located = await locateOffender(lane, first, ctx, lines);
    if (located.kind === "probing") return true;
    if (located.kind === "unlocated") {
      repairRow("main.repair.unlocated", { head_sha: sha, failing_checks: observation.failingChecks, first_red_sha: first.headSha, reason: located.reason });
      return false;
    }
    const alreadyOwned = active.find((r) => r.offendingSha === located.sha);
    if (alreadyOwned) return advanceRepair(lane, alreadyOwned, ctx);
    // The backstop for any path that hands the writer a commit whose CI never concluded red.
    const refusal = locatedWriterRefusal(located.sha, ctx.evidence?.runHistory, located.probeVerdicts);
    if (refusal) {
      repairRow("main.repair.unlocated", { head_sha: sha, failing_checks: observation.failingChecks, first_red_sha: first.headSha, refused_sha: located.sha, reason: refusal });
      return false;
    }
    const reason = located.method === "first-red-unattributed"
      ? `${observation.reason}. The commits after the last green \`${first.afterGreenSha}\` could not be attributed (no CI probe could ` +
        `run), so \`${located.sha}\` is named only as the first completed red: repair the failing tests, whichever merge broke them`
      : observation.reason;
    const request = await fixRequestFor(observation, sha, branch, located.sha, located.pr, failures, reason);
    repairRow("main.repair.located", {
      head_sha: sha,
      offending_sha: located.sha,
      offending_pr: located.pr,
      failing_checks: observation.failingChecks,
      test_files: request.testFiles,
      method: located.method,
      ...located.fields,
      ...mainRedFields(red),
    });
    dispatchFix(lane, request, red);
    return true;
  };
  /**
   * A red that is only a ratified ceiling is recorded, not fixed by a worker or reverted: the gate's
   * own remedy is a baseline PR, and the fenced writer produces it. True while that PR (or an open one
   * that already records the ceiling) owns this red; false hands the red to the fix-then-revert path.
   */
  const recordRatchetRed = async (
    lane: MainRepairLane,
    signature: string,
    sha: string,
    branch: string,
    failingNames: readonly string[],
    evidenceRollup: readonly RollupCheckEntry[],
  ): Promise<boolean> => {
    if (!lane.recordRatchet || !deps.readCeilingVerdict || signature === ratchetDeclinedSignature) return false;
    if (ratchetInFlight) return true;
    if (ratchetPrUrl) {
      const pr = await readRepairPr(ratchetPrUrl);
      if (!pr || pr.state === "open") return true;
      ratchetPrUrl = undefined;
    }
    const verdicts = new Map<string, MainCeilingLogVerdict | undefined>();
    const matrixOnly = failingNames.every((name) => name === CI_SHARD_MATRIX.aggregator || CI_SHARD_MATRIX.constituent.test(name));
    const latest = matrixOnly ? dedupeRollupByLatestAttempt([...evidenceRollup]) : [];
    for (const name of failingNames.filter((n) => matrixOnly && CI_SHARD_MATRIX.constituent.test(n))) {
      const entry = latest.find((check) => (check.name ?? check.context) === name);
      try {
        verdicts.set(name, entry ? await deps.readCeilingVerdict(entry) : undefined);
      } catch (error) {
        deps.log("main.repair.ratchet_log_unreadable", { head_sha: sha, check_name: name, error: String((error as Error)?.message ?? error) });
      }
    }
    const verdict = classifyMainRatchetRed(failingNames, verdicts);
    if (verdict.kind === "not-ratchet") {
      deps.log("main.repair.ratchet_not_applicable", { head_sha: sha, reason: verdict.reason });
      return false;
    }
    ratchetInFlight = true;
    repairRow("main.repair.ratchet_dispatched", { head_sha: sha, scripts: verdict.scripts, gates: verdict.gates });
    const decline = (reason: string): void => {
      ratchetDeclinedSignature = signature;
      repairRow("main.repair.ratchet_declined", { head_sha: sha, reason });
    };
    void Promise.resolve()
      .then(() => lane.recordRatchet!({ branch, headSha: sha, scripts: verdict.scripts, gates: verdict.gates }))
      .then(
        (outcome) => {
          if ("opened" in outcome) {
            ratchetPrUrl = outcome.opened;
            ratchetOpened.add(outcome.opened);
            repairRow("main.repair.ratchet_opened", { head_sha: sha, pr_url: outcome.opened });
          } else if ("standing" in outcome) {
            ratchetPrUrl = outcome.standing;
            repairRow("main.repair.ratchet_standing", { head_sha: sha, pr_url: outcome.standing });
          } else {
            decline(outcome.declined);
          }
        },
        (error) => decline(String((error as Error)?.message ?? error)),
      )
      .catch((error) => deps.log("main.repair.error", { head_sha: sha, error: String((error as Error)?.message ?? error) }))
      .finally(() => {
        ratchetInFlight = false;
      });
    return true;
  };
  /** Main is green on its own head: a recorded-baseline PR this lane opened and that is still open is
   *  now redundant -- it would lower a ceiling main no longer crosses -- so it is closed. */
  const resolveRatchetRecords = async (sha: string): Promise<void> => {
    ratchetDeclinedSignature = undefined;
    ratchetPrUrl = undefined;
    for (const url of [...ratchetOpened]) {
      const pr = await readRepairPr(url);
      if (!pr) continue;
      if (pr.state === "open") {
        await closeRepairPr(
          url,
          `Closed by the red-main repair lane: \`${owner}/${repo}\` is green on its own head \`${sha}\` without this ` +
            "recorded baseline, so recording it now would only move a ceiling main no longer crosses.",
        );
      }
      repairRow("main.repair.ratchet_resolved", { head_sha: sha, pr_url: url, by: pr.state === "merged" ? "record" : "other" });
      ratchetOpened.delete(url);
    }
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
        (mainHealthHeadInconclusive(observation) &&
          (mainHealthFallbackCandidates(runHistory).length > 0 || runHistory.some(mainRunIsInProgress))))) {
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
      // The walk back: main's head concluded nothing genuine (no required check yet, still pending,
      // cancelled by the next push, or every one skipped or known-vacuous on a plan-only merge), so
      // the NEWEST main commit whose completed run genuinely executed a required check decides. Runs
      // whose required jobs were themselves skipped, vacuous or cancelled are walked past, never
      // allowed to decide. The window (W1-T6023) bounds how far back; nothing else does.
      let evidenceAge: MainEvidenceAge | undefined;
      let walkedPast = 0;
      const headReason = observation.reason;
      if (runHistory && recentShas && mainHealthHeadInconclusive(observation)) {
        const learned = learnedFor(required);
        const { runs, skipped } = mainHealthWalkRuns(runHistory, recentShas);
        let decidedBy: MainHealthRunHistoryEntry | undefined;
        // W1-T7757: the newest commit passed over because a required check of it is still running.
        let pendingCommit: { sha: string; checks: readonly string[] } | undefined;
        for (const run of runs) {
          const workflow = run.workflowName;
          if (workflow !== undefined && learned.carriesNone.has(workflow) && !learned.carries.has(workflow)) continue;
          const running = mainRunIsInProgress(run);
          let jobs: RollupCheckEntry[];
          try {
            jobs = await jobsOf(run, required);
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
          if (!learnWorkflow(learned, run, jobs, required)) {
            // A running run's required jobs may simply not have registered yet: that proves nothing
            // about the workflow, unless it is already known to carry required checks (then it is pending).
            if (running && workflow !== undefined && learned.carries.has(workflow) && run.headSha !== sha) {
              pendingCommit ??= { sha: run.headSha, checks: [] };
            }
            continue;
          }
          const fallback = mainHealthFromRollup(sha, jobs, judgedAgainst, undefined, judging);
          if (fallback.state === "undetermined") {
            // A running commit with a required check still going decides nothing YET: remembered, and the
            // walk continues to older evidence. Never green; a red below it is still its own concluded red.
            // The head's own pending run is the reason the walk started (W1-T5490): it is not "newer than" the head.
            if (running && fallback.pendingChecks.length > 0) {
              if (run.headSha !== sha) pendingCommit ??= { sha: run.headSha, checks: fallback.pendingChecks };
            } else walkedPast += 1;
            continue;
          }
          const pending = pendingCommit !== undefined && pendingCommit.sha !== run.headSha ? pendingCommit : undefined;
          const evidenceWorkflows = new Set([...learned.carries, run.workflowName ?? ""]);
          evidenceAge = mainEvidenceAge(run.headSha, recentShas, runHistory, evidenceWorkflows, startedAtMs);
          const where = evidenceAge.depth > 0 ? `, ${evidenceAge.depth} first-parent commit(s) behind the head` : "";
          observation = {
            ...fallback,
            reason:
              `main's head carries no genuine evidence (${headReason}); the latest completed main run (${run.headSha}) ` +
              `decides, the newest main commit with genuine evidence${where}: ${fallback.reason}`,
          };
          if (pending && fallback.state === "green") {
            // W1-T7757: a newer commit is still running its required checks, so an older green is not main's state.
            observation = {
              ...observation,
              state: "undetermined",
              pendingChecks: [...pending.checks],
              reason:
                `pending: ${pending.sha} still has required check(s) running${pending.checks.length > 0 ? ` (${pending.checks.join(", ")})` : ""} — ` +
                `undetermined, not green; the older evidence is green at ${run.headSha}: ${fallback.reason}`,
            };
          } else if (pending && fallback.state === "red") {
            observation = { ...observation, reason: `${observation.reason} (newer commit ${pending.sha} is still running its required checks)` };
          } else if (fallback.state === "green" && evidenceAge.freshness === "stale") {
            const cadence = evidenceAge.mergeCadenceMs !== undefined ? ` at a median ${minutes(evidenceAge.mergeCadenceMs)} between merges` : "";
            observation = {
              ...observation,
              state: "stale",
              reason:
                `${observation.reason} — but stale, not green: merge ${evidenceAge.oldestUnverifiedSha} has waited ` +
                `${minutes(evidenceAge.lagMs!)} for evidence, longer than main's own runs have ever taken to deliver it ` +
                `(${minutes(evidenceAge.latencyBoundMs!)}), with ${evidenceAge.depth} merge(s) unverified${cadence}`,
            };
          }
          decidedBySha = run.headSha;
          evidenceRollup = jobs;
          decidedBy = run;
          break;
        }
        if (!decidedBy && walkedPast > 0) {
          observation = {
            ...observation,
            reason: `${observation.reason}; walked past ${walkedPast} completed main run(s) whose required checks were all skipped, vacuous or cancelled`,
          };
        }
        if (!decidedBy && skipped.length > 0) {
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
        ? failedMainGuardRuns(runHistory, recentShas.shas)
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
      // W1-T9690: a red head never walked back, so its own completed runs teach the set the boundary reads.
      const learned = observation.state === "red" && runHistory ? learnedFor(required) : undefined;
      if (learned && learned.carries.size === 0) {
        for (const run of runHistory!) {
          const workflow = run.workflowName;
          if (run.headSha !== decidedBySha || workflow === undefined || mainRunIsInProgress(run) || learned.carriesNone.has(workflow)) continue;
          try {
            learnWorkflow(learned, run, await jobsOf(run, required), required);
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
        }
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
      repairEvidence = {
        ...(runHistory ? { runHistory } : {}),
        required,
        ...(workflowEvidence && workflowEvidence.carries.size > 0 ? { requiredWorkflows: workflowEvidence.carries } : {}),
      };
      deps.log("main.health.observed", {
        branch,
        sha,
        state: observation.state,
        reason: observation.reason,
        failing_checks: observation.failingChecks,
        observed_checks: observedChecks,
        decided_by_sha: decidedBySha,
        ...(evidenceAge
          ? {
              evidence_depth: evidenceAge.depth,
              evidence_freshness: evidenceAge.freshness,
              ...(evidenceAge.lagMs !== undefined ? { evidence_lag_ms: evidenceAge.lagMs } : {}),
              ...(evidenceAge.latencyBoundMs !== undefined ? { evidence_latency_bound_ms: evidenceAge.latencyBoundMs } : {}),
              ...(evidenceAge.mergeCadenceMs !== undefined ? { merge_cadence_ms: evidenceAge.mergeCadenceMs } : {}),
            }
          : decidedBySha === sha && observation.state !== "undetermined" ? { evidence_depth: 0, evidence_freshness: "head" } : {}),
        ...(walkedPast > 0 ? { walked_past_runs: walkedPast } : {}),
        pending_checks: observation.pendingChecks,
        non_evidence_checks: observation.nonEvidenceChecks,
        judged_against: required.size > 0 ? "ci-gate-required" : "all-checks",
        run_history_source: cacheHit ? "cache" : "fetched",
        ...(advisoryFailing.length > 0 ? { advisory_failing_checks: [...advisoryFailing].sort() } : {}),
        ...metPrFields(metLookup),
      });
      if (observation.state !== "red") answerHints(sha, observation.state);

      if (observation.state === "red") {
        resolvedSignature = undefined;
        withheldNote = undefined;
        const signature = `${sha}:${[...observation.failingChecks].sort().join(",")}`;
        if (signature === escalatedSignature) {
          lastSuccessfulObservationAtMs = startedAtMs;
          return;
        }
        // A red that is only a ratified ceiling is recorded by a baseline PR before any worker is spent.
        if (
          deps.repair &&
          (await recordRatchetRed(deps.repair, signature, sha, branch, [...observation.failingChecks, ...advisoryFailing], evidenceRollup))
        ) {
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
          // W1-T9690: always passed, so an empty (unknown) set names no green rather than reading every workflow.
          requiredWorkflows: workflowEvidence?.carries ?? new Set<string>(),
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
        let repairFailures: readonly CiFailure[] = failures ?? [];
        if (deps.repair) {
          // The aggregator's log only points at its failing shard, so the shard's own log is read too:
          // it names the failing tests and BLOCKED gates the red's signature is made of.
          const shards = earlyRedEvidenceRollup(dedupeRollupByLatestAttempt([...evidenceRollup]), observation.failingChecks).filter(
            (entry) =>
              !observation.failingChecks.includes(entry.name ?? "") &&
              REQUIRED_CHECK_FAIL.has(String(entry.conclusion ?? entry.state ?? "").toUpperCase()) &&
              String(entry.conclusion ?? "").toUpperCase() !== "CANCELLED",
          );
          let shardFailures: readonly CiFailure[] = [];
          if (shards.length > 0 && deps.readCiFailures) {
            try {
              shardFailures = (await deps.readCiFailures(shards)) ?? [];
            } catch (error) {
              deps.log("main.repair.shard_log_unreadable", { head_sha: sha, error: String((error as Error)?.message ?? error) });
            }
          }
          const shardNames = shards.map((entry) => entry.name ?? entry.context ?? "unknown");
          repairFailures = [...repairFailures, ...shardFailures];
          currentRed = mainRedSignature(
            [...observation.failingChecks, ...shardNames],
            shards.length > 0 && shardFailures.length > 0 ? shardFailures : failures,
          );
        }
        answerHints(sha, "red", { signature: mainRedSignature([...observation.failingChecks], repairFailures), failures: repairFailures });
        if (deps.repair && (await repairRedMain(deps.repair, observation, sha, branch, repairFailures, startedAtMs))) {
          repairedSignature = signature;
          lastSuccessfulObservationAtMs = startedAtMs;
          return;
        }
        if (withheldNote) observation = { ...observation, reason: `${observation.reason}; ${withheldNote}` };
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
        if (deps.repair) await repairInheritedReds(deps.repair, observation, sha, branch);
        resolvedSignature = undefined;
        lastSuccessfulObservationAtMs = startedAtMs;
        return;
      }
      if (deps.repair && decidedBySha === sha) {
        await resolveRepairs(sha);
        await resolveRatchetRecords(sha);
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
