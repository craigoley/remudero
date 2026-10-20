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
}

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
  // B1 (2026-10-17): an image input is NOT full weight here. A daemon process restart reruns the mounted checkout on
  // the image it already has, so it cannot deliver a rebuilt image; the recycle does (deployer.ts).
  return sourceDeployWorth(change);
}

export interface FreshnessDecision {
  action: "restart" | "defer";
  reason: string;
  restartTrigger?: "change" | "idle" | "age" | "withheld_reviews" | "unreadable";
  /** Change pressure: the summed freshness weight of every advance scored this lifetime. */
  weight: number;
  /** Staleness pressure: grows linearly from the first stale reading, reaching the threshold at the horizon. */
  agePressure: number;
  pressure: number;
  state: DeployRestartPressureState;
}

/**
 * Decide WHEN, not WHETHER, to take a material advance (W1-T4945). Idle: restart now, which costs only a boot.
 * Busy: restart through the existing drain only once change pressure plus staleness pressure reaches the
 * recorded threshold, so a change to the daemon's own code goes at once and a low-weight one waits for an idle
 * moment — never past the horizon, because staleness alone reaches the threshold there. `changes` undefined means
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
}): FreshnessDecision {
  const threshold = input.threshold ?? DEPLOY_RESTART_SCORE_THRESHOLD;
  const horizonMs = input.ageHorizonMs ?? DEPLOY_RESTART_RATE_CEILING_MS;
  const scored = accumulateDeployRestartPressure(input.changes ?? [], input.state, {
    threshold,
    nowMs: input.nowMs,
    rateCeilingMs: 0,
    scoreChange: freshnessAdvanceWorth,
  });
  const weight = input.changes === undefined ? Math.max(scored.total, threshold.value) : scored.total;
  const agePressure = Math.floor((threshold.value * Math.max(0, input.nowMs - input.staleSinceMs)) / horizonMs);
  const withheld = input.withheldReviews ?? 0;
  const withheldPressure = withheld > 0 ? threshold.value : 0;
  const pressure = weight + agePressure + withheldPressure;
  const state = { total: weight, scoredShas: scored.state.scoredShas };
  const restartTrigger = input.changes === undefined ? "unreadable"
    : withheldPressure > 0 ? "withheld_reviews"
    : weight >= threshold.value ? "change"
    : !input.busy ? "idle" : "age";
  if (!input.busy) {
    return { action: "restart", restartTrigger, reason: "idle: nothing in flight, so the restart costs only a boot", weight, agePressure, pressure, state };
  }
  if (withheldPressure > 0) {
    return {
      action: "restart",
      restartTrigger,
      reason:
        `busy, but ${withheld} review(s) withheld for stale reviewer code: pressure ${pressure} ` +
        `(change ${weight} + staleness ${agePressure} + withheld ${withheldPressure}) >= ${threshold.value}: drain and restart`,
      weight,
      agePressure,
      pressure,
      state,
    };
  }
  if (pressure >= threshold.value) {
    return {
      action: "restart",
      restartTrigger,
      reason: `busy, but pressure ${pressure} (change ${weight} + staleness ${agePressure}) >= ${threshold.value}: drain and restart`,
      weight,
      agePressure,
      pressure,
      state,
    };
  }
  return {
    action: "defer",
    reason: `busy, and pressure ${pressure} (change ${weight} + staleness ${agePressure}) < ${threshold.value}: wait for an idle moment`,
    weight,
    agePressure,
    pressure,
    state,
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
 * gave 10.9/day. Only the fast paths pass it: install inputs, withheld reviews and an unreadable advance.
 */
export const FRESHNESS_MIN_LIFETIME_MS = 90 * 60_000;
/** The coalesce reason, and the ledger's `held_by`, for a restart held by {@link FRESHNESS_MIN_LIFETIME_MS}. */
export const MIN_LIFETIME_HOLD = "min_lifetime";

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
}): { action: "restart" | "hold" | "defer"; reason: string; heldMs?: number; windowEndsAtMs?: number } {
  const { decision } = input;
  if (decision.action === "defer") return decision;
  const windowEndsAtMs = input.lastAdvanceAtMs + input.window.value;
  if (decision.restartTrigger === "unreadable" || decision.restartTrigger === "withheld_reviews") {
    const reason = decision.restartTrigger === "unreadable" ? "unreadable_advance" : "withheld_reviews";
    return { action: "restart", reason, heldMs: 0, windowEndsAtMs };
  }
  const heldMs = Math.max(0, input.nowMs - input.staleSinceMs);
  // Every other release (change, age, idle; window_quiet and upper_age below) waits out the minimum lifetime.
  if (input.nowMs - input.lifetimeStartedAtMs < (input.minLifetimeMs ?? FRESHNESS_MIN_LIFETIME_MS)) {
    return input.installInputsChanged
      ? { action: "restart", reason: INSTALL_INPUTS_RELEASE, heldMs, windowEndsAtMs }
      : { action: "hold", reason: MIN_LIFETIME_HOLD, heldMs, windowEndsAtMs };
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
