import { BAKED_RUNTIME_SOURCE_PATHS } from "./baked-runtime-inputs.js";
import { isInPlanScope } from "./plan-scope.js";

export type DeployImpactScore = 0 | 1 | 3 | 9 | 18;

/** Files that reach the fleet only through a rebuilt image (W1-T3240); acr-build.yml builds on
 *  exactly these, and a test holds the two lists equal. */
export const IMAGE_BAKED_PATHS: readonly string[] = [
  "deploy/Dockerfile",
  "deploy/entrypoint.sh",
  ".dockerignore",
  // The image's own CLI install (claude, codex) and the Codex requirements it copies in: a change
  // to either reaches workers only through a rebuilt image.
  "deploy/package.json",
  "deploy/package-lock.json",
  "deploy/codex-requirements.toml",
  ...BAKED_RUNTIME_SOURCE_PATHS,
];

/** W1-T9094 — the image inputs a `build` (daemon) container executes from its image. Its daemon and
 *  workers run from mounted checkouts, so the serve supervisor's source (BAKED_RUNTIME_SOURCE_PATHS)
 *  never makes it stale: 13 of the 14 image rebuilds of 2026-10-12/13 touched only that source. */
export const BUILD_ROLE_IMAGE_BAKED_PATHS: readonly string[] = IMAGE_BAKED_PATHS.filter(
  (path) => !BAKED_RUNTIME_SOURCE_PATHS.includes(path),
);

/** W1-T9094 — the baked paths whose change makes a container of `role` stale. Only `build` is
 *  narrowed; `serve` and an unknown role keep the full list, today's behaviour. */
export function imageBakedPathsForRole(role: string | undefined): readonly string[] {
  return role === "build" ? BUILD_ROLE_IMAGE_BAKED_PATHS : IMAGE_BAKED_PATHS;
}

function touchesImage(change: DeployWorthChange): boolean {
  return change.files.some((file) => IMAGE_BAKED_PATHS.includes(file));
}
export type DeployWorthSource = "deterministic" | "judge" | "fail-closed";

export interface RecordedDeployRestartThreshold {
  value: number;
  reason: string;
}

/** PRIMARY CONTROL: the tunable score total that normally decides when stale code is worth taking. */
export const DEPLOY_RESTART_SCORE_THRESHOLD: RecordedDeployRestartThreshold = {
  value: 18,
  reason:
    "Starting value from the 2026-09-08 14-day replay: threshold 18 preserves the flat " +
    "scorer's cadence once rare judge uplifts are ledgered and measurable.",
};

/** BACKSTOP: even urgent scores cannot restart the fleet more often than this. */
export const DEPLOY_RESTART_RATE_CEILING_MS = 60 * 60_000;

export const DEPLOY_RESTART_SCORE_STEP = "deploy.restart_score";
export const DEPLOY_RESTART_PRESSURE_STEP = "deploy.restart_pressure";
/** BACKSTOP ledger signal for the rate ceiling refusing a score-triggered restart. */
export const DEPLOY_RESTART_RATE_LIMITED_STEP = "deploy.restart_rate_limited";

export interface DeployWorthChange {
  sha: string;
  subject?: string;
  files: readonly string[];
  /** W1-T14360: the task ids this commit's own `Remudero-Task:` lines name, read from its body, never its subject.
   *  Absent when it names none or could not be read. */
  tasks?: readonly string[];
  /** W1-T12230: what the commit asks of a restart, from the freshness reading (self-sync.ts `classifyAdvanceCommit`).
   *  Absent when the reading did not class it, which counts as `loop`. */
  changeClass?: FreshnessChangeClass;
}

/** W1-T12230 — `reviewer`: a path a review's verdict depends on; `loop`: code the daemon loop loads; `worker_only`:
 *  src/ or scripts/ that only a worker loads, from its own fresh worktree. */
export type FreshnessChangeClass = "reviewer" | "loop" | "worker_only";
export const FRESHNESS_CHANGE_CLASSES: readonly FreshnessChangeClass[] = ["reviewer", "loop", "worker_only"];

export interface DeployWorthVerdict {
  score: DeployImpactScore;
  reason: string;
  source: DeployWorthSource;
  judgeFailed?: true;
}

export interface DeployRestartPressureState {
  total: number;
  scoredShas: readonly string[];
  lastRestartAtMs?: number;
}

export interface DeployRestartScoreRow {
  step: typeof DEPLOY_RESTART_SCORE_STEP;
  sha: string;
  subject?: string;
  files: readonly string[];
  score: DeployImpactScore;
  total: number;
  threshold: number;
  threshold_reason: string;
  decision: "score";
  reason: string;
  source: DeployWorthSource;
  judge_failed?: true;
}

export interface DeployRestartPressureResult {
  wantRestart: boolean;
  reason: string;
  state: DeployRestartPressureState;
  scoreRows: DeployRestartScoreRow[];
  total: number;
  threshold: number;
  thresholdReason: string;
  decision: "restart" | "defer";
  rateLimited: boolean;
}

export interface DeployWorthJudgeObject {
  score: number;
  reason: string;
}

export type DeployWorthJudge = (
  change: DeployWorthChange,
  base: DeployWorthVerdict,
) => string | DeployWorthJudgeObject;

function cleanTotal(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : 0;
}

function isDeployImpactScore(value: number): value is DeployImpactScore {
  return value === 0 || value === 1 || value === 3 || value === 9 || value === 18;
}

function planOnlyChange(change: DeployWorthChange): boolean {
  return change.files.length > 0 && change.files.every(isInPlanScope);
}

function reachesRuntime(change: DeployWorthChange): boolean {
  return change.files.some((file) => file.startsWith("src/") || file.startsWith("scripts/"));
}

export function deterministicDeployWorth(change: DeployWorthChange): DeployWorthVerdict {
  if (!planOnlyChange(change) && touchesImage(change)) {
    return {
      score: 18,
      reason: "image input changed: only a recycle onto the rebuilt image delivers it",
      source: "deterministic",
    };
  }
  return sourceDeployWorth(change);
}

/** The plan/src/scripts rules alone: what a process restart onto the mounted checkout delivers. */
function sourceDeployWorth(change: DeployWorthChange): DeployWorthVerdict {
  if (planOnlyChange(change)) {
    return {
      score: 0,
      reason: "plan-only change: deterministic zero; the judge is not consulted",
      source: "deterministic",
    };
  }
  if (reachesRuntime(change)) {
    return {
      score: 1,
      reason: "runtime-reaching path touched src/ or scripts/: deterministic floor 1",
      source: "deterministic",
    };
  }
  return {
    score: 0,
    reason: "change touches no plan, src or scripts path that changes running daemon behavior",
    source: "deterministic",
  };
}

export type DeployWorthParseOutcome =
  | { kind: "parsed"; verdict: DeployWorthVerdict }
  | { kind: "unparseable"; raw: string; reason: string };

export function parseDeployWorthResponse(text: string): DeployWorthParseOutcome {
  const scoreMatch = text.match(/DEPLOY_IMPACT_SCORE:\s*(\d+)/i);
  const reasonMatch = text.match(/DEPLOY_IMPACT_REASON:\s*(.+)/i);
  const score = scoreMatch ? Number(scoreMatch[1]) : NaN;
  if (!Number.isFinite(score) || !isDeployImpactScore(score)) {
    return {
      kind: "unparseable",
      raw: text,
      reason: "judge output carried no parseable DEPLOY_IMPACT_SCORE — failing closed to no uplift",
    };
  }
  return {
    kind: "parsed",
    verdict: {
      score,
      reason: reasonMatch?.[1]?.trim() || "judge stated no reason",
      source: "judge",
    },
  };
}

export function buildDeployWorthPrompt(change: DeployWorthChange, base: DeployWorthVerdict): string {
  return [
    "You are the DEPLOY WORTH judge scoring one merged change's daemon impact.",
    "You may raise the deterministic score, never lower it.",
    "",
    `SHA: ${change.sha}`,
    `SUBJECT: ${change.subject ?? "(none supplied)"}`,
    `FILES: ${change.files.length > 0 ? change.files.join(", ") : "(none supplied)"}`,
    `DETERMINISTIC_BASE_SCORE: ${base.score}`,
    `DETERMINISTIC_BASE_REASON: ${base.reason}`,
    "",
    "Score exactly one rung:",
    "  1  runtime path reached",
    "  3  notable behavior an operator would notice",
    "  9  significant decision path, gate, or disposition change",
    "  18 urgent live-defect repair or newly-wired unreached mechanism",
    "",
    "MACHINE-READABLE OUTPUT:",
    "  DEPLOY_IMPACT_SCORE: <1|3|9|18>",
    "  DEPLOY_IMPACT_REASON: <why this change affects the daemon at that rung>",
  ].join("\n");
}

function parseJudgeValue(value: string | DeployWorthJudgeObject): DeployWorthParseOutcome {
  if (typeof value === "string") return parseDeployWorthResponse(value);
  if (isDeployImpactScore(value.score)) {
    return { kind: "parsed", verdict: { score: value.score, reason: value.reason, source: "judge" } };
  }
  return {
    kind: "unparseable",
    raw: JSON.stringify(value),
    reason: "judge returned a score outside the recorded deploy-impact scale — failing closed to no uplift",
  };
}

export function judgeDeployWorth(
  change: DeployWorthChange,
  deps: { judge?: DeployWorthJudge } = {},
): DeployWorthVerdict {
  const base = deterministicDeployWorth(change);
  if (base.score === 0 || !deps.judge) return base;

  let outcome: DeployWorthParseOutcome;
  try {
    outcome = parseJudgeValue(deps.judge(change, base));
  } catch (err) {
    return {
      ...base,
      source: "fail-closed",
      judgeFailed: true,
      reason:
        `judge unavailable (${err instanceof Error ? err.message : String(err)}) — ` +
        "failing closed to no uplift; deterministic base remains in force",
    };
  }
  if (outcome.kind === "unparseable") {
    return {
      ...base,
      source: "fail-closed",
      judgeFailed: true,
      reason: `${outcome.reason}; deterministic base remains in force`,
    };
  }

  const score = outcome.verdict.score < base.score ? base.score : outcome.verdict.score;
  return {
    score,
    reason:
      score === base.score && outcome.verdict.score < base.score
        ? `${outcome.verdict.reason}; deterministic base ${base.score} remained in force`
        : outcome.verdict.reason,
    source: "judge",
  };
}

export function resetDeployRestartPressure(
  _state: DeployRestartPressureState,
  nowMs: number,
): DeployRestartPressureState {
  return { total: 0, scoredShas: [], lastRestartAtMs: nowMs };
}

export function accumulateDeployRestartPressure(
  changes: readonly DeployWorthChange[],
  state: DeployRestartPressureState,
  opts: {
    threshold?: RecordedDeployRestartThreshold;
    nowMs: number;
    rateCeilingMs: number;
    scoreChange: (change: DeployWorthChange) => DeployWorthVerdict;
  },
): DeployRestartPressureResult {
  const threshold = opts.threshold ?? DEPLOY_RESTART_SCORE_THRESHOLD;
  let total = cleanTotal(state.total);
  const scored = new Set(state.scoredShas);
  const scoreRows: DeployRestartScoreRow[] = [];

  for (const change of changes) {
    if (scored.has(change.sha)) continue;
    const verdict = opts.scoreChange(change);
    total += verdict.score;
    scored.add(change.sha);
    scoreRows.push({
      step: DEPLOY_RESTART_SCORE_STEP,
      sha: change.sha,
      subject: change.subject,
      files: [...change.files],
      score: verdict.score,
      total,
      threshold: threshold.value,
      threshold_reason: threshold.reason,
      decision: "score",
      reason: verdict.reason,
      source: verdict.source,
      ...(verdict.judgeFailed ? { judge_failed: true } : {}),
    });
  }

  const crossed = total >= threshold.value;
  const last = state.lastRestartAtMs;
  const rateLimited = crossed && last !== undefined && opts.nowMs - last < opts.rateCeilingMs;
  const wantRestart = crossed && !rateLimited;
  const stateOut = {
    total,
    scoredShas: [...scored],
    ...(last === undefined ? {} : { lastRestartAtMs: last }),
  };

  const reason = !crossed
    ? `restart pressure below threshold: total ${total} < ${threshold.value}`
    : rateLimited
      ? `restart-rate ceiling holds: last restart ${Math.max(0, opts.nowMs - last!)}ms ago < ${opts.rateCeilingMs}ms`
      : `restart pressure crossed threshold: total ${total} >= ${threshold.value}`;

  return {
    wantRestart,
    reason,
    state: stateOut,
    scoreRows,
    total,
    threshold: threshold.value,
    thresholdReason: threshold.reason,
    decision: wantRestart ? "restart" : "defer",
    rateLimited,
  };
}

export function replayDeployRestartFrequency(scores: readonly number[], threshold: number): {
  restarts: number;
  finalTotal: number;
} {
  let total = 0;
  let restarts = 0;
  for (const score of scores) {
    total += score;
    if (total >= threshold) {
      restarts++;
      total = 0;
    }
  }
  return { restarts, finalTotal: total };
}

export const FRESHNESS_DECISION_STEP = "daemon.freshness_decision";

/**
 * Freshness weight on deploy-judge's own scale. W1-T9089 (ADR 0007 A.10): once every build run is a child a booting
 * daemon adopts, a restart drains only its own reviews and detached actions, so the daemon's own code is weighed like
 * any other material advance; the self-path list, the self-scoped commit test and #11861's declaration weighing are gone.
 */
export function freshnessAdvanceWorth(change: DeployWorthChange): DeployWorthVerdict {
  // W1-T12230: a worker gets a fresh worktree and scripts/ is read per call, so a restart delivers it nothing.
  if (change.changeClass === "worker_only") {
    return { score: 0, reason: "worker-only change: no daemon process loads it, so a restart delivers nothing", source: "deterministic" };
  }
  // B1 (2026-10-17): an image input is NOT full weight here. A daemon process restart reruns the mounted checkout on
  // the image it already has, so it cannot deliver a rebuilt image; the recycle does (deployer.ts).
  return sourceDeployWorth(change);
}

export interface FreshnessDecision {
  action: "restart" | "defer";
  reason: string;
  restartTrigger?: "change" | "idle" | "age" | "withheld_reviews" | "unreadable" | "stall";
  /** Change pressure: the summed freshness weight of every advance scored this lifetime. */
  weight: number;
  /** Staleness pressure: grows linearly from the first stale reading, reaching the threshold at the horizon. */
  agePressure: number;
  /** The stall share times the score limit, rounded down. Absent when the measured share is zero. */
  stallPressure?: number;
  pressure: number;
  state: DeployRestartPressureState;
  /** W1-T12230: the count of the advance's commits in each class (an unclassed commit counts as `loop`). Present when
   *  the caller passed `loopOnlyHorizonMs`, as the daemon does. */
  changeClasses?: Record<FreshnessChangeClass, number>;
  /** W1-T12230: the horizon of the staleness part that set `agePressure`. Present with `changeClasses`. */
  horizonMs?: number;
}

/** W1-T12230: the count of commits in each class; a commit the reading did not class is `loop`. */
export function countFreshnessChangeClasses(changes: readonly DeployWorthChange[] | undefined): Record<FreshnessChangeClass, number> {
  const counts: Record<FreshnessChangeClass, number> = { reviewer: 0, loop: 0, worker_only: 0 };
  for (const change of changes ?? []) counts[change.changeClass ?? "loop"]++;
  return counts;
}

/** W1-T12230 — the staleness pressure and the horizon that set it. A `reviewer` commit's part runs from its first read
 *  against `stalenessHorizonMs`, a `loop` commit's against `loopOnlyHorizonMs`; the larger part wins. A reading with no
 *  commit list has one part, from the first stale reading, as before; one of only `worker_only` commits has none. */
function freshnessAgePressure(input: {
  changes: readonly DeployWorthChange[] | undefined;
  staleSinceMs: number;
  nowMs: number;
  limit: number;
  stalenessHorizonMs: number;
  loopOnlyHorizonMs: number;
  classSinceMs?: Partial<Record<"reviewer" | "loop", number>>;
}): { agePressure: number; horizonMs: number } {
  const part = (sinceMs: number, horizonMs: number) => Math.floor((input.limit * Math.max(0, input.nowMs - sinceMs)) / horizonMs);
  if (input.changes === undefined || input.changes.length === 0) {
    return { agePressure: part(input.staleSinceMs, input.stalenessHorizonMs), horizonMs: input.stalenessHorizonMs };
  }
  const classes = countFreshnessChangeClasses(input.changes);
  const since = (cls: "reviewer" | "loop") => input.classSinceMs?.[cls] ?? input.staleSinceMs;
  const reviewer = classes.reviewer > 0 ? part(since("reviewer"), input.stalenessHorizonMs) : undefined;
  const loop = classes.loop > 0 ? part(since("loop"), input.loopOnlyHorizonMs) : undefined;
  if (reviewer !== undefined && (loop === undefined || reviewer >= loop)) return { agePressure: reviewer, horizonMs: input.stalenessHorizonMs };
  return { agePressure: loop ?? 0, horizonMs: input.loopOnlyHorizonMs };
}

function boundedStallShare(share = 0): number {
  return Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0;
}

export function freshnessMinLifetimeForStall(minLifetimeMs: number, stallShare?: number): number {
  return minLifetimeMs * (1 - boundedStallShare(stallShare));
}

/**
 * Decide WHEN, not WHETHER, to take a material advance (W1-T4945). Idle: restart now, which costs only a boot.
 * Busy: restart through the existing drain when pressure from change, staleness, withheld reviews and measured
 * loop stalls reaches the threshold. Staleness alone reaches the threshold at the horizon. `changes` undefined means
 * the advance could not be read, which counts as full weight: an unknown advance never waits.
 */
export function decideFreshnessRestart(input: {
  changes?: readonly DeployWorthChange[];
  busy: boolean;
  staleSinceMs: number;
  nowMs: number;
  state: DeployRestartPressureState;
  threshold?: RecordedDeployRestartThreshold;
  ageHorizonMs?: number;
  /** W1-T5476 — terminal verdicts the reviewer withheld for stale reviewer code since the stale reading.
   *  Above 0 the review lane is stalled on exactly this lag, so it adds a full threshold of pressure. */
  withheldReviews?: number;
  stallShare?: number;
  /** W1-T12230: the horizon of an advance with `loop` commits and no `reviewer` one. Defaults to `ageHorizonMs`. */
  loopOnlyHorizonMs?: number;
  /** W1-T12230: when the daemon first read the earliest commit of each class. A class absent here runs from
   *  `staleSinceMs`. */
  classSinceMs?: Partial<Record<"reviewer" | "loop", number>>;
}): FreshnessDecision {
  const threshold = input.threshold ?? DEPLOY_RESTART_SCORE_THRESHOLD;
  const stalenessHorizonMs = input.ageHorizonMs ?? DEPLOY_RESTART_RATE_CEILING_MS;
  const scored = accumulateDeployRestartPressure(input.changes ?? [], input.state, {
    threshold,
    nowMs: input.nowMs,
    rateCeilingMs: 0,
    scoreChange: freshnessAdvanceWorth,
  });
  const weight = input.changes === undefined ? Math.max(scored.total, threshold.value) : scored.total;
  const { agePressure, horizonMs } = freshnessAgePressure({
    changes: input.changes, staleSinceMs: input.staleSinceMs, nowMs: input.nowMs, limit: threshold.value, stalenessHorizonMs,
    loopOnlyHorizonMs: input.loopOnlyHorizonMs ?? stalenessHorizonMs, ...(input.classSinceMs ? { classSinceMs: input.classSinceMs } : {}),
  });
  const withheld = input.withheldReviews ?? 0;
  const withheldPressure = withheld > 0 ? threshold.value : 0;
  const stallShare = boundedStallShare(input.stallShare);
  const stallPressure = Math.floor(threshold.value * stallShare);
  const pressure = weight + agePressure + withheldPressure + stallPressure;
  const state = { total: weight, scoredShas: scored.state.scoredShas };
  const classes = input.loopOnlyHorizonMs === undefined ? {} : { changeClasses: countFreshnessChangeClasses(input.changes), horizonMs };
  const scores = { weight, agePressure, pressure, state, ...classes, ...(stallShare > 0 ? { stallPressure } : {}) };
  const pressureTerms = `change ${weight} + staleness ${agePressure}`;
  const stallTerm = stallShare > 0 ? ` + stall ${stallPressure}` : "";
  const restartTrigger = input.changes === undefined ? "unreadable"
    : withheldPressure > 0 ? "withheld_reviews"
    : weight >= threshold.value ? "change"
    : !input.busy ? "idle"
    : pressure >= threshold.value && weight + agePressure < threshold.value ? "stall" : "age";
  if (!input.busy) {
    const stall = stallShare > 0 ? ` (stall pressure ${stallPressure})` : "";
    return { action: "restart", restartTrigger, reason: `idle: nothing in flight, so the restart costs only a boot${stall}`, ...scores };
  }
  if (withheldPressure > 0) {
    return {
      action: "restart",
      restartTrigger,
      reason:
        `busy, but ${withheld} review(s) withheld for stale reviewer code: pressure ${pressure} ` +
        `(${pressureTerms} + withheld ${withheldPressure}${stallTerm}) >= ${threshold.value}: drain and restart`,
      ...scores,
    };
  }
  if (pressure >= threshold.value) {
    return {
      action: "restart",
      restartTrigger,
      reason: `busy, but pressure ${pressure} (${pressureTerms}${stallTerm}) >= ${threshold.value}: drain and restart`,
      ...scores,
    };
  }
  return {
    action: "defer",
    reason: `busy, and pressure ${pressure} (${pressureTerms}${stallTerm}) < ${threshold.value}: wait for an idle moment`,
    ...scores,
  };
}

/** PRIMARY CONTROL: W1-T6093's quiet window opens on an advance and re-arms on each new SHA. */
export const FRESHNESS_COALESCE_WINDOW_MS: RecordedDeployRestartThreshold = {
  value: 10 * 60_000,
  reason: "All eight measured follow-on daemon boots on 2026-10-06 came 1–10 minutes after the previous boot.",
};

/**
 * 2026-10-10: a package.json or package-lock.json advance leaves the install root every implement worktree links behind
 * main, so W1-T4193 refuses every implement dispatch until the restart reinstalls it: nine runs at 18:08-18:17Z while
 * the window held #10700's restart to 18:21Z. Such an advance is never held for a quiet window.
 */
export const INSTALL_INPUTS_RELEASE = "install_inputs_changed";
export function changesInstallInputs(changes: readonly DeployWorthChange[] | undefined): boolean {
  return (changes ?? []).some((change) => change.files.some((file) => file === "package.json" || file === "package-lock.json"));
}

/**
 * OPERATOR RULING 2026-10-17: a daemon lifetime runs at least 90 minutes before a freshness restart takes it. On
 * 2026-10-17 the daemon read stale ~20 min after each boot and upper_age released it 30 min later, so it restarted
 * about every 75 min (18.2 freshness restarts/day over 10-12..10-17); replaying those 1406 commits with this floor
 * gave 10.9/day. Install inputs, withheld reviews, an unreadable advance and a declared expedite can pass the hold.
 * A measured loop stall shortens it in proportion to the blocked share.
 */
export const FRESHNESS_MIN_LIFETIME_MS = 90 * 60_000;
/** The coalesce reason, and the ledger's `held_by`, for a restart held by {@link FRESHNESS_MIN_LIFETIME_MS}. */
export const MIN_LIFETIME_HOLD = "min_lifetime";
export const LOOP_STALL_RELEASE = "loop_stall";

/**
 * W1-T14360 — the expedite fast path. 2026-11-22: #20230, a fix for a live cost leak, merged nine minutes into a
 * lifetime and waited out the floor although the pressure (21) was over the score limit (18). A task record may declare
 * `expedite: <reason>` when it is filed as the fix for a live leak or storm; a pending commit whose own Remudero-Task
 * line names such a task passes the minimum lifetime, and only while the pressure is already over the limit. Priority
 * is never read: 47 records sit at priority 0, and 14 of 44 measured holds held one (operator ruling 2026-11-23).
 */
export const EXPEDITE_RELEASE = "expedite";

export interface FreshnessExpedite {
  taskId: string;
  /** The record's own `expedite` text, verbatim. */
  reason: string;
}

/**
 * The first pending commit's task whose record declares a non-blank expedite, or undefined. `expediteOf` reads the
 * catalogs; one that throws is an unreadable catalog, which holds like a task with no expedite.
 */
export function pendingExpedite(
  changes: readonly DeployWorthChange[] | undefined,
  expediteOf: (taskId: string) => string | undefined,
): FreshnessExpedite | undefined {
  for (const change of changes ?? []) {
    for (const taskId of change.tasks ?? []) {
      let reason: unknown;
      try {
        reason = expediteOf(taskId);
      } catch (error) {
        // Fail closed: an unreadable catalog declares nothing, so the minimum lifetime holds as it would without it.
        void error;
        continue;
      }
      if (typeof reason === "string" && reason.trim() !== "") return { taskId, reason };
    }
  }
  return undefined;
}

export function coalesceFreshnessRestart(input: {
  decision: FreshnessDecision;
  newSha: string;
  lastAdvanceAtMs: number;
  staleSinceMs: number;
  nowMs: number;
  window: RecordedDeployRestartThreshold;
  threshold?: RecordedDeployRestartThreshold;
  ageHorizonMs?: number;
  installInputsChanged?: boolean;
  /** When this daemon lifetime began, on the clock `nowMs` reads. */
  lifetimeStartedAtMs: number;
  /** Defaults to {@link FRESHNESS_MIN_LIFETIME_MS}. */
  minLifetimeMs?: number;
  stallShare?: number;
  /** W1-T14360: the pending commit's declared expedite ({@link pendingExpedite}); absent, the floor holds as before. */
  expedite?: FreshnessExpedite;
}): { action: "restart" | "hold" | "defer"; reason: string; heldMs?: number; windowEndsAtMs?: number; expedite?: FreshnessExpedite } {
  const { decision } = input;
  if (decision.action === "defer") return decision;
  const windowEndsAtMs = input.lastAdvanceAtMs + input.window.value;
  if (decision.restartTrigger === "unreadable" || decision.restartTrigger === "withheld_reviews") {
    const reason = decision.restartTrigger === "unreadable" ? "unreadable_advance" : "withheld_reviews";
    return { action: "restart", reason, heldMs: 0, windowEndsAtMs };
  }
  const heldMs = Math.max(0, input.nowMs - input.staleSinceMs);
  const lifetimeMs = input.nowMs - input.lifetimeStartedAtMs;
  const minLifetimeMs = input.minLifetimeMs ?? FRESHNESS_MIN_LIFETIME_MS;
  if (lifetimeMs < minLifetimeMs) {
    if (input.installInputsChanged) return { action: "restart", reason: INSTALL_INPUTS_RELEASE, heldMs, windowEndsAtMs };
    // W1-T14360: a declared expedite passes only a pressure already over the limit; at or under it, the floor holds.
    if (input.expedite && decision.pressure > (input.threshold ?? DEPLOY_RESTART_SCORE_THRESHOLD).value) {
      return { action: "restart", reason: EXPEDITE_RELEASE, heldMs, windowEndsAtMs, expedite: input.expedite };
    }
    if (lifetimeMs >= freshnessMinLifetimeForStall(minLifetimeMs, input.stallShare)) {
      return { action: "restart", reason: LOOP_STALL_RELEASE, heldMs, windowEndsAtMs };
    }
    return { action: "hold", reason: MIN_LIFETIME_HOLD, heldMs, windowEndsAtMs };
  }
  if (decision.restartTrigger !== "change") return { action: "restart", reason: decision.reason, heldMs: 0, windowEndsAtMs };
  if (input.installInputsChanged) return { action: "restart", reason: INSTALL_INPUTS_RELEASE, heldMs, windowEndsAtMs };
  const threshold = input.threshold ?? DEPLOY_RESTART_SCORE_THRESHOLD;
  const horizonMs = input.ageHorizonMs ?? DEPLOY_RESTART_RATE_CEILING_MS;
  const agePressure = Math.floor((threshold.value * heldMs) / horizonMs);
  if (agePressure >= threshold.value / 2) {
    return { action: "restart", reason: "upper_age", heldMs, windowEndsAtMs };
  }
  if (input.nowMs >= windowEndsAtMs) {
    return { action: "restart", reason: "window_quiet", heldMs, windowEndsAtMs };
  }
  return { action: "hold", reason: `coalescing ${input.newSha}: waiting for a quiet advance window`, heldMs, windowEndsAtMs };
}

/** W1-T12230: the horizon at which the staleness of an advance with `loop` commits and no `reviewer` one reaches the
 *  score limit. The record asked for 3 h against a 1 h `stalenessHorizonMs`; W1-T12552 has since shipped that row at
 *  4 h, and the loop-only row may never sit below it, so the row starts here. Mirrors `plan/policy.yaml`
 *  `freshnessRestart.loopOnlyHorizonMs`; with no row the daemon uses its staleness horizon for both classes. */
export const FRESHNESS_LOOP_ONLY_HORIZON_MS = 4 * 60 * 60_000;

/** W1-T12231: the share of the score limit at which a busy daemon starts to treat its freshness restart as likely.
 *  Mirrors `plan/policy.yaml` `freshnessRestart.likelyFraction`. */
export const FRESHNESS_LIKELY_FRACTION = 0.5;
/** BACKSTOP: W1-T12231 — the latest a freshness drain's time limit may be after the restart decision, however long
 *  the work in flight is predicted to run. Mirrors `plan/policy.yaml` `freshnessRestart.maxDrainWaitMs`. */
export const FRESHNESS_MAX_DRAIN_WAIT_MS = 30 * 60_000;

/**
 * W1-T12231 — when a busy daemon's freshness restart is likely. At the current stall share and with no further advance,
 * staleness grows until pressure reaches the score limit. The prediction also waits for the effective minimum lifetime.
 */
export function timeToLikelyFreshnessRestart(input: {
  /** The change pressure: the summed weight of the advances scored this lifetime. */
  weight: number;
  staleSinceMs: number;
  nowMs: number;
  threshold?: RecordedDeployRestartThreshold;
  ageHorizonMs?: number;
  lifetimeStartedAtMs: number;
  minLifetimeMs?: number;
  stallShare?: number;
}): { pressure: number; timeToRestartMs: number } {
  const limit = (input.threshold ?? DEPLOY_RESTART_SCORE_THRESHOLD).value;
  const horizonMs = input.ageHorizonMs ?? DEPLOY_RESTART_RATE_CEILING_MS;
  const weight = Number.isFinite(input.weight) ? Math.max(0, input.weight) : 0;
  const stallPressure = Math.floor(limit * boundedStallShare(input.stallShare));
  const agePressure = Math.floor((limit * Math.max(0, input.nowMs - input.staleSinceMs)) / horizonMs);
  const needed = Math.max(0, limit - weight - stallPressure);
  // The smallest stale age whose staleness pressure, floored as the decision floors it, reaches `needed`.
  const reachedAtMs = needed === 0 ? input.nowMs : input.staleSinceMs + Math.ceil((needed * horizonMs) / limit);
  const lifetimeEndsAtMs = input.lifetimeStartedAtMs +
    freshnessMinLifetimeForStall(input.minLifetimeMs ?? FRESHNESS_MIN_LIFETIME_MS, input.stallShare);
  return {
    pressure: weight + agePressure + stallPressure,
    timeToRestartMs: Math.max(0, reachedAtMs - input.nowMs, lifetimeEndsAtMs - input.nowMs),
  };
}
