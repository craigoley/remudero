import { isInPlanScope } from "./plan-scope.js";

export type DeployImpactScore = 0 | 1 | 3 | 9 | 18;
export type DeployWorthSource = "deterministic" | "judge" | "fail-closed";

export interface RecordedDeployRestartThreshold {
  value: number;
  reason: string;
}

export const DEPLOY_RESTART_SCORE_THRESHOLD: RecordedDeployRestartThreshold = {
  value: 18,
  reason:
    "Starting value from the 2026-09-08 14-day replay: threshold 18 preserves the flat " +
    "scorer's cadence once rare judge uplifts are ledgered and measurable.",
};

export const DEPLOY_RESTART_RATE_CEILING_MS = 60 * 60_000;

export const DEPLOY_RESTART_SCORE_STEP = "deploy.restart_score";
export const DEPLOY_RESTART_PRESSURE_STEP = "deploy.restart_pressure";
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

export type DeployWorthJudge = (
  change: DeployWorthChange,
  base: DeployWorthVerdict,
) => string | DeployWorthVerdict;

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

function parseJudgeValue(value: string | DeployWorthVerdict): DeployWorthParseOutcome {
  if (typeof value === "string") return parseDeployWorthResponse(value);
  if (isDeployImpactScore(value.score)) {
    return { kind: "parsed", verdict: { ...value, source: "judge" } };
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
