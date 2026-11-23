import { createHash } from "node:crypto";
import type { Config } from "./config-schema.js";
import { fixedClock, systemClock } from "./clock.js";
import { readLedgerUnionRawLinesSync } from "./ledger-union.js";

/**
 * The Luna build canary (W1-T14549, 2026-11-23). No code build could reach Luna: a risk:low src task requests sonnet,
 * and the balanced Codex rows are Sol-only by the 2026-09-24 ruling, which said a Luna route on balanced work needs its
 * own measured decision. This is that measurement: a randomized share of risk:low src builds starts its FIRST attempt
 * on the Codex economy tier (Luna), every retry and the step-up run on the mount as before, and the arm holds itself
 * when its first-attempt PR rate falls below a fraction of the control's. Review and every gate are untouched.
 */
export interface LunaBuildCanaryPolicy {
  enabled: boolean;
  /** Share of eligible tasks that start on Luna. A quarter keeps three in four on the measured route. */
  sharePercent: number;
  /** Runs per arm before a relative verdict, the bar the cash-simple trial uses (W1-T3570). */
  minSample: number;
  /** Hold the arm when its first-attempt PR rate falls below this fraction of the control's. */
  minRelativeSuccess: number;
  /** Evidence window. A hold expires as its failures age out. */
  windowDays: number;
}

export const DEFAULT_LUNA_BUILD_CANARY_POLICY: LunaBuildCanaryPolicy = {
  enabled: true,
  sharePercent: 25,
  minSample: 20,
  minRelativeSuccess: 0.8,
  windowDays: 7,
};

export const LUNA_BUILD_CANARY_ID = "luna-build-canary";

export type LunaBuildCanaryArm = "luna" | "control" | "held";

export interface LunaBuildCanaryDecision {
  id: typeof LUNA_BUILD_CANARY_ID;
  arm: LunaBuildCanaryArm;
  reason: string;
  evidence?: LunaBuildCanaryEvidence;
}

export interface LunaBuildCanaryArmEvidence { runs: number; prs: number }
export interface LunaBuildCanaryEvidence { luna: LunaBuildCanaryArmEvidence; control: LunaBuildCanaryArmEvidence }

export function lunaBuildCanaryPolicy(config: Pick<Config, "workerProviders">): LunaBuildCanaryPolicy {
  return { ...DEFAULT_LUNA_BUILD_CANARY_POLICY, ...(config.workerProviders?.lunaBuildCanary ?? {}) };
}

/** Routine code work: an implement task at risk low whose routing class is `src` and whose mount names no provider. */
export function lunaBuildCanaryEligible(
  task: { type: string; risk: string },
  routeClass: string,
  mountProvider: string | undefined,
): boolean {
  return task.type === "implement" && task.risk === "low" && routeClass === "src" && mountProvider === undefined;
}

/** Stable per task and salted, so a retried task keeps its arm and the draw is independent of the cash trial's. */
export function lunaBuildCanaryArmFor(taskId: string, sharePercent: number): "luna" | "control" {
  const bucket = createHash("sha256").update(`${LUNA_BUILD_CANARY_ID}:${taskId}`).digest().readUInt32BE(0) % 100;
  return bucket < sharePercent ? "luna" : "control";
}

type Row = Record<string, unknown>;

/**
 * Per arm, the runs with a terminal verdict and those whose FIRST implement attempt opened the pull request: the
 * verdict carries a pr_url and is not failed, and the run's retry.success reads attempts 1. A Luna run rescued by its
 * mount retry is a PR for the run but a failure for Luna, so it counts against the arm, as does any run whose
 * implement.luna_canary_escalated row says its Luna attempt failed.
 */
export function summarizeLunaBuildCanary(rows: Iterable<Row>): LunaBuildCanaryEvidence {
  const armByRun = new Map<string, "luna" | "control">();
  const firstAttempt = new Set<string>();
  const escalated = new Set<string>();
  const opened = new Map<string, boolean>();
  for (const row of rows) {
    const runId = typeof row.run_id === "string" ? row.run_id : undefined;
    if (!runId) continue;
    if (row.step === "implement.luna_canary" && (row.arm === "luna" || row.arm === "control")) armByRun.set(runId, row.arm);
    else if (row.step === "retry.success" && row.attempts === 1) firstAttempt.add(runId);
    else if (row.step === "implement.luna_canary_escalated") escalated.add(runId);
    else if (row.step === "verdict") opened.set(runId, typeof row.pr_url === "string" && row.pr_url.length > 0 && row.verdict !== "failed");
  }
  const evidence: LunaBuildCanaryEvidence = { luna: { runs: 0, prs: 0 }, control: { runs: 0, prs: 0 } };
  for (const [runId, arm] of armByRun) {
    const pr = opened.get(runId);
    if (pr === undefined) continue;
    evidence[arm].runs += 1;
    if (pr && firstAttempt.has(runId) && !escalated.has(runId)) evidence[arm].prs += 1;
  }
  return evidence;
}

/** Why the Luna arm is held, or undefined while it may run. Mirrors cashTrialStopReason without a spend budget. */
export function lunaBuildCanaryStopReason(evidence: LunaBuildCanaryEvidence, policy: LunaBuildCanaryPolicy): string | undefined {
  const { luna, control } = evidence;
  if (luna.runs < policy.minSample) {
    const failures = luna.runs - luna.prs;
    const tolerated = policy.minSample - Math.ceil(policy.minSample * policy.minRelativeSuccess);
    return failures > tolerated
      ? `${failures} Luna first attempts without a PR in ${policy.windowDays}d exceed the ${tolerated} the bar tolerates at n=${policy.minSample}`
      : undefined;
  }
  const lunaRate = luna.prs / luna.runs;
  // An unmeasured control is taken as perfect, the cautious direction.
  const measured = control.runs >= policy.minSample;
  const controlRate = measured ? control.prs / control.runs : 1;
  if (lunaRate >= policy.minRelativeSuccess * controlRate) return undefined;
  return `Luna first-attempt PR rate ${(lunaRate * 100).toFixed(0)}% is below ${policy.minRelativeSuccess} x ` +
    `${measured ? `control ${(controlRate * 100).toFixed(0)}%` : "an unmeasured control taken as 100%"}`;
}

/** The window's canary rows, or the reason they could not all be read; an incomplete read holds the arm. */
export function readLunaBuildCanaryRows(stateDir: string, windowMs: number, nowMs = systemClock.now()):
  { rows: Row[]; unavailableReason?: string } {
  const startMs = nowMs - windowMs;
  const read = readLedgerUnionRawLinesSync(stateDir, {
    sinceTs: fixedClock(startMs).iso(),
    pattern: /"step":"(?:implement\.luna_canary(?:_escalated)?|retry\.success|verdict)"/,
    refuseIncomplete: true,
  });
  if (read.unread.length > 0 || !read.liveFileRead || read.unclassified.length > 0) {
    return { rows: [], unavailableReason: "ledger source unreadable or incomplete" };
  }
  const rows: Row[] = [];
  for (const line of read.rawLines) {
    let row: Row;
    try {
      row = JSON.parse(line) as Row;
    } catch {
      // A corrupt row is not an absent one: the caller holds the Luna arm on this reason.
      return { rows: [], unavailableReason: "a ledger row is not valid JSON" };
    }
    const tsMs = typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN;
    if (Number.isFinite(tsMs) && tsMs >= startMs) rows.push(row);
  }
  return { rows };
}

/** Decide one implement run's canary arm, or undefined when the task is not canary work at all. */
export function decideLunaBuildCanary(input: {
  task: { id: string; type: string; risk: string };
  routeClass: string;
  mountProvider: string | undefined;
  config: Pick<Config, "workerProviders">;
  stateDir: string;
  readRows?: (stateDir: string, windowMs: number) => { rows: Row[]; unavailableReason?: string };
}): LunaBuildCanaryDecision | undefined {
  if (!lunaBuildCanaryEligible(input.task, input.routeClass, input.mountProvider)) return undefined;
  const policy = lunaBuildCanaryPolicy(input.config);
  const held = (reason: string, evidence?: LunaBuildCanaryEvidence): LunaBuildCanaryDecision =>
    ({ id: LUNA_BUILD_CANARY_ID, arm: "held", reason, ...(evidence ? { evidence } : {}) });
  if (!policy.enabled) return held("workerProviders.lunaBuildCanary.enabled is false");
  if (!Number.isInteger(policy.sharePercent) || policy.sharePercent < 0 || policy.sharePercent > 100 ||
    !Number.isInteger(policy.windowDays) || policy.windowDays <= 0 || !Number.isInteger(policy.minSample) || policy.minSample <= 0 ||
    !Number.isFinite(policy.minRelativeSuccess) || policy.minRelativeSuccess <= 0 || policy.minRelativeSuccess > 1) {
    return held("luna build canary policy has an invalid share, window, sample, or bar");
  }
  const arm = lunaBuildCanaryArmFor(input.task.id, policy.sharePercent);
  if (arm === "control") return { id: LUNA_BUILD_CANARY_ID, arm, reason: `control arm by stable task hash at ${policy.sharePercent}% share` };
  const read = (input.readRows ?? readLunaBuildCanaryRows)(input.stateDir, policy.windowDays * 86_400_000);
  if (read.unavailableReason) return held(`canary evidence unavailable: ${read.unavailableReason}`);
  const evidence = summarizeLunaBuildCanary(read.rows);
  const stop = lunaBuildCanaryStopReason(evidence, policy);
  if (stop) return held(stop, evidence);
  return { id: LUNA_BUILD_CANARY_ID, arm, reason: `luna arm by stable task hash at ${policy.sharePercent}% share`, evidence };
}
