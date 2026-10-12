/** Private measurements: unavailable is never zero; task runs own retry cost. */
import { createHash } from "node:crypto";
import { fixedClock } from "./clock.js";

export type CanaryBilling = "api" | "subscription";
/** One scheduled case across arms. Retention turns and retries stay inside one run. */
export interface CanaryTrialBlock {
  version: "canary-trial-block-v1";
  day: string;
  scheduleDigest: string;
  blockId: string;
  slotId: string;
  plannedSlotIds: string[];
  position: number;
  aaLabel: "A" | "B" | null;
}

export function canaryTrialBlockId(day: string, suiteHash: string, caseId: string,
  scheduleDigest: string, plannedSlotIds: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([
    "canary-trial-block-v1", day, suiteHash, caseId, scheduleDigest, plannedSlotIds,
  ])).digest("hex");
}
export interface CanaryAttempt {
  id: string;
  durationMs: number | null;
  firstTextMs: number | null;
  generationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  usageRatedUsd: number | null;
  billing: CanaryBilling;
  servedModel: string | null;
  terminal: "complete" | "error" | "timeout";
}
export interface CanaryRun {
  id: string;
  caseId: string;
  suiteHash: string;
  model: string;
  route: string;
  effort: string;
  family: string;
  verified: boolean | null;
  totalDurationMs: number | null;
  attempts: CanaryAttempt[];
  outcomeReason?: string;
  retention?: { turnsObserved: number; violations: number; firstViolationTurn: number | null };
  trial?: CanaryTrialBlock;
}
export const nonnegativeMeasurement = (n: number | null): n is number =>
  n !== null && Number.isFinite(n) && n >= 0;

/** Observed text deltas are timed separately from thinking/empty/keepalive events. */
export function canaryStreamClock(startMs: number) {
  let first: number | null = null;
  let last: number | null = null;
  let invalid = !Number.isFinite(startMs);
  return {
    text(atMs: number, delta: string) {
      if (!delta) return;
      if (!Number.isFinite(atMs) || atMs < startMs || (last !== null && atMs < last)) { invalid = true; return; }
      first ??= atMs; last = atMs;
    },
    finish(endMs: number) {
      if (!Number.isFinite(endMs) || endMs < startMs || (last !== null && endMs < last)) invalid = true;
      return { durationMs: invalid ? null : endMs - startMs,
        firstTextMs: invalid || first === null ? null : first - startMs,
        generationMs: invalid || first === null || last === null ? null : last - first };
    },
  };
}

export function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(q * sorted.length) - 1] ?? sorted[0]!;
}

/** Wilson interval is descriptive per arm; repeated-case causal analyses need clustered pairing. */
export function canaryPassInterval(successes: number, observed: number): [number, number] | null {
  if (observed === 0) return null;
  const z = 1.959963984540054, p = successes / observed, denom = 1 + z * z / observed;
  const center = (p + z * z / (2 * observed)) / denom;
  const radius = z * Math.sqrt(p * (1 - p) / observed + z * z / (4 * observed * observed)) / denom;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

/** Exact duplicates are idempotent. Contradictory IDs refuse the whole projection. */
export function projectCanaryRuns(input: readonly CanaryRun[]) {
  if (input.length > 8192) throw new Error("canary-projection-bound");
  const runs = new Map<string, CanaryRun>();
  const attemptIds = new Set<string>();
  const trialSlots = new Set<string>();
  for (const run of input) {
    if (!run.id || !run.caseId || !/^[a-f0-9]{64}$/.test(run.suiteHash) || !run.model || !run.route || !run.effort || !run.family)
      throw new Error("canary-run-identity-invalid");
    if ((run.verified !== null && typeof run.verified !== "boolean")
      || (run.totalDurationMs !== null && !nonnegativeMeasurement(run.totalDurationMs))) throw new Error("canary-run-outcome-invalid");
    if (run.trial !== undefined) {
      const t = run.trial, hash = /^[a-f0-9]{64}$/;
      if (!t || t.version !== "canary-trial-block-v1" || !/^\d{4}-\d{2}-\d{2}$/.test(t.day)
        || !Number.isFinite(Date.parse(t.day + "T00:00:00Z"))
        || fixedClock(Date.parse(t.day + "T00:00:00Z")).iso().slice(0, 10) !== t.day
        || !hash.test(t.scheduleDigest) || !hash.test(t.slotId)
        || !Array.isArray(t.plannedSlotIds) || !t.plannedSlotIds.length || t.plannedSlotIds.length > 128
        || t.plannedSlotIds.some(id => typeof id !== "string" || !hash.test(id))
        || new Set(t.plannedSlotIds).size !== t.plannedSlotIds.length
        || !Number.isInteger(t.position) || t.position < 0 || t.plannedSlotIds[t.position] !== t.slotId
        || ![null, "A", "B"].includes(t.aaLabel)
        || t.blockId !== canaryTrialBlockId(t.day, run.suiteHash, run.caseId, t.scheduleDigest, t.plannedSlotIds))
        throw new Error("canary-trial-block-invalid");
    }
    const prior = runs.get(run.id);
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(run)) throw new Error("canary-run-conflicting-duplicate");
      continue;
    }
    if (run.trial) {
      if (trialSlots.has(run.trial.slotId)) throw new Error("canary-trial-slot-reused");
      trialSlots.add(run.trial.slotId);
    }
    if (run.attempts.length > (run.family === "retention" ? 50 : 8)
      || (!run.attempts.length && run.verified !== null)) throw new Error("canary-attempt-bound");
    for (const attempt of run.attempts) {
      if (!attempt.id || attemptIds.has(attempt.id)) throw new Error("canary-attempt-identity-reused");
      attemptIds.add(attempt.id);
      for (const value of [attempt.durationMs, attempt.firstTextMs, attempt.generationMs, attempt.inputTokens,
        attempt.outputTokens, attempt.cacheReadTokens, attempt.cacheWriteTokens, attempt.reasoningTokens, attempt.usageRatedUsd])
        if (value !== null && !nonnegativeMeasurement(value)) throw new Error("canary-measurement-invalid");
      if (!["api", "subscription"].includes(attempt.billing)) throw new Error("canary-billing-invalid");
      if (!["complete", "error", "timeout"].includes(attempt.terminal)) throw new Error("canary-terminal-invalid");
      if (attempt.servedModel !== null && (typeof attempt.servedModel !== "string" || !attempt.servedModel.trim()))
        throw new Error("canary-served-model-invalid");
      for (const value of [attempt.inputTokens, attempt.outputTokens, attempt.cacheReadTokens,
        attempt.cacheWriteTokens, attempt.reasoningTokens])
        if (value !== null && !Number.isSafeInteger(value)) throw new Error("canary-token-count-invalid");
    }
    runs.set(run.id, run);
  }
  const groups = new Map<string, CanaryRun[]>();
  for (const run of runs.values()) {
    const key = JSON.stringify([run.suiteHash, run.model, run.route, run.effort, run.family]);
    const rows = groups.get(key) ?? []; rows.push(run); groups.set(key, rows);
  }
  return { version: "model-canary-metrics-v1" as const, private: true as const, uniqueRuns: runs.size,
    groups: [...groups.values()].map(rows => {
      const attempts = rows.flatMap(r => r.attempts);
      const observed = rows.filter(r => r.verified !== null).length;
      const correct = rows.filter(r => r.verified === true).length;
      const durations = rows.filter(r => r.verified === true && r.totalDurationMs !== null).map(r => r.totalDurationMs!);
      const first = attempts.flatMap(a => a.firstTextMs === null ? [] : [a.firstTextMs]);
      const cost = (mode: CanaryBilling) => {
        const calls = attempts.filter(a => a.billing === mode), known = calls.filter(a => a.usageRatedUsd !== null);
        const measured = known.reduce((sum, a) => sum + a.usageRatedUsd!, 0);
        return { attempts: calls.length, known: known.length, observedLowerBoundUsd: calls.length ? measured : null,
          totalUsd: calls.length && known.length === calls.length ? measured : null,
          perCorrectTaskUsd: calls.length && known.length === calls.length && observed === rows.length && correct > 0 ? measured / correct : null };
      };
      const row = rows[0]!;
      return { suiteHash: row.suiteHash, model: row.model, route: row.route, effort: row.effort, family: row.family,
        tasks: rows.length, distinctCases: new Set(rows.map(r => r.caseId)).size, attempts: attempts.length,
        trialBlocks: new Set(rows.flatMap(r => r.trial ? [r.trial.blockId] : [])).size,
        unpairedRuns: rows.filter(r => !r.trial).length,
        unresolved: rows.length - observed, correct, observed, passRate: observed ? correct / observed : null,
        passInterval: canaryPassInterval(correct, observed), intervalBasis: "descriptive-run-not-independent-case" as const,
        durationObserved: durations.length, completionP50Ms: quantile(durations, .5),
        completionP95Ms: durations.length >= 20 ? quantile(durations, .95) : null,
        firstTextObserved: first.length, firstTextP50Ms: quantile(first, .5),
        servedIdentityKnown: attempts.filter(a => a.servedModel !== null).length,
        servedMismatch: attempts.filter(a => a.servedModel !== null && a.servedModel !== row.model).length,
        identityComparable: attempts.length > 0 && attempts.every(a => a.servedModel === row.model),
        failedAttempts: attempts.filter(a => a.terminal !== "complete").length,
        apiEstimate: cost("api"), subscriptionNotional: cost("subscription"), invoiceUsd: null };
    }) };
}
