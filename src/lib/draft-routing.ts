import { readdirSync } from "node:fs";
import { fixedClock, systemClock } from "./clock.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";

export interface DraftDeploymentStats {
  attempts: number;
  clean: number;
  contractFailures: number;
  costUsd: number;
}

export type DraftStats = Record<string, DraftDeploymentStats>;
export type DraftOutcome = "clean" | "not-clean" | "contract-failed" | "refused" | "failed";
interface DraftMeasurements {
  costedAttempts: number;
}
type DraftRecentOutcomes = Record<string, Array<{ outcome: unknown; tsMs: number }>>;
const operationalHistory = new WeakMap<DraftStats, DraftRecentOutcomes>();
function recentOutcomes(stats: DraftStats): DraftRecentOutcomes {
  let recent = operationalHistory.get(stats);
  if (!recent) operationalHistory.set(stats, recent = {});
  return recent;
}
// Per-call evidence belongs to the snapshot's lifetime; aggregate-only callers remain supported.
const measurements = new WeakMap<DraftDeploymentStats, DraftMeasurements>();
function evidence(stats: DraftDeploymentStats): DraftMeasurements {
  let value = measurements.get(stats);
  if (!value) {
    value = { costedAttempts: stats.costUsd > 0 ? stats.attempts : 0 };
    measurements.set(stats, value);
  }
  return value;
}
export interface DraftArm { deployment: string; estimatedCostUsd: number }
export interface DraftPosterior extends DraftArm {
  alpha: number;
  beta: number;
  sampledCleanRate: number;
  costPerAttemptUsd: number;
  cleanPerDollar: number;
}
export interface DraftChoice {
  deployment: string;
  reason: "thompson-clean-per-dollar";
  posterior: DraftPosterior;
  arms: DraftPosterior[];
  skipped?: Array<{ deployment: string; count: number; until: string }>;
}

export type DraftRoutingLog = (step: string, extra?: Record<string, unknown>) => void;

export function recordDraftRouting(log: DraftRoutingLog, step: string, extra: Record<string, unknown>): void {
  try { log(step, extra); }
  catch (error) { console.error(JSON.stringify({ event: "draft.routing.error", reason: "ledger-write-failed", step, error: String(error) })); }
}

/** A batch reads the archive union once and feeds each new outcome into its shared snapshot. */
export function createDraftStatsSession(stateDir: string, lane: string, log: DraftRoutingLog, read: typeof readDraftStats = readDraftStats): {
  readStats: () => DraftStats;
  log: DraftRoutingLog;
} {
  let stats: DraftStats | undefined;
  let failure: { reason: string } | undefined;
  let loaded = false;
  return {
    readStats: () => {
      if (!loaded) {
        loaded = true;
        try { stats = read(stateDir, lane); }
        catch (error) { failure = { reason: String(error) }; }
      }
      if (failure) throw new Error(failure.reason);
      return stats!;
    },
    log: (step, extra = {}) => {
      recordDraftRouting(log, step, extra);
      if (stats && step === "draft.routing.outcome") {
        const deltaStats = draftStatsFromRows([{ step, ...extra }], lane);
        const recent = recentOutcomes(stats);
        for (const [deployment, incoming] of Object.entries(recentOutcomes(deltaStats))) {
          recent[deployment] = [...(recent[deployment] ?? []), ...incoming].slice(-10);
        }
        for (const [deployment, delta] of Object.entries(deltaStats)) {
          const measured = stats[deployment] ??= { attempts: 0, clean: 0, contractFailures: 0, costUsd: 0 };
          const current = evidence(measured);
          const incoming = evidence(delta);
          current.costedAttempts += incoming.costedAttempts;
          measured.attempts += delta.attempts;
          measured.clean += delta.clean;
          measured.contractFailures += delta.contractFailures;
          measured.costUsd += delta.costUsd;
        }
      }
    },
  };
}

function gamma(shape: number, random: () => number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = Math.sqrt(-2 * Math.log(Math.max(Number.MIN_VALUE, random()))) * Math.cos(2 * Math.PI * random());
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = Math.max(Number.MIN_VALUE, random());
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < x * x / 2 + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Row order supplies a weak Beta prior; measured outcomes and dollars determine traffic. */
export function chooseDraftDeployment(stats: DraftStats, candidates: readonly DraftArm[], random: () => number = Math.random, now = systemClock.now()): DraftChoice {
  if (candidates.length === 0) throw new Error("draft routing has no eligible deployments");
  const blocked = candidates.flatMap((arm) => {
    const recent = recentOutcomes(stats)[arm.deployment];
    if (!recent || recent.length < 10 || !recent.every((r) => r.outcome === "refused" || r.outcome === "failed")) return [];
    const until = recent[recent.length - 1]!.tsMs + 60 * 60 * 1000;
    return Number.isFinite(until) && now < until ? [{ deployment: arm.deployment, count: recent.length, until: fixedClock(until).iso() }] : [];
  });
  const skipped = blocked.length < candidates.length ? blocked : [];
  const arms = candidates.flatMap((arm, index): DraftPosterior[] => {
    if (skipped.some((skip) => skip.deployment === arm.deployment)) return [];
    const measured = stats[arm.deployment];
    const attempts = measured?.attempts ?? 0;
    const clean = Math.min(attempts, measured?.clean ?? 0);
    const alpha = 1 + clean;
    const beta = 1 + index + attempts - clean;
    const a = gamma(alpha, random);
    const b = gamma(beta, random);
    const sampledCleanRate = a / (a + b);
    const costedAttempts = measured ? evidence(measured).costedAttempts : 0;
    const costPerAttemptUsd = measured && costedAttempts > 0
      ? measured.costUsd / costedAttempts : arm.estimatedCostUsd;
    if (!(costPerAttemptUsd > 0) || !Number.isFinite(costPerAttemptUsd)) throw new Error(`invalid draft cost for ${arm.deployment}`);
    return [{ ...arm, alpha, beta, sampledCleanRate, costPerAttemptUsd, cleanPerDollar: sampledCleanRate / costPerAttemptUsd }];
  });
  const posterior = arms.reduce((best, arm) => arm.cleanPerDollar > best.cleanPerDollar ? arm : best);
  return { deployment: posterior.deployment, reason: "thompson-clean-per-dollar", posterior, arms, ...(skipped.length ? { skipped } : {}) };
}

/** Correlate legacy outcomes by run and proposal, never crediting an earlier relint's deployment. */
export function draftStatsFromRows(rows: readonly Record<string, unknown>[], lane: string): DraftStats {
  const stats: DraftStats = {};
  const recent = recentOutcomes(stats);
  const identities = (row: Record<string, unknown>): string[] => [
    typeof row.selection_assignment_id === "string" && row.selection_assignment_id ? `assignment:${row.selection_assignment_id}` : undefined,
    typeof row.session_id === "string" && row.session_id ? `session:${row.session_id}` : undefined,
  ].filter((id): id is string => id !== undefined);
  const recordedAttempts = new Set(rows.filter((r) => r.step === "draft.routing.outcome" && r.lane === lane).flatMap(identities));
  const pending = new Map<string, DraftDeploymentStats>();
  const arm = (deployment: string) => stats[deployment] ??= { attempts: 0, clean: 0, contractFailures: 0, costUsd: 0 };
  const cost = (row: Record<string, unknown>) => typeof row.cost_usd === "number" && Number.isFinite(row.cost_usd) && row.cost_usd >= 0 ? row.cost_usd : 0;
  for (const row of rows) {
    if (row.step === "draft.routing.outcome" && row.lane === lane && typeof row.deployment === "string") {
      recent[row.deployment] = [...(recent[row.deployment] ?? []), {
        outcome: row.outcome, tsMs: typeof row.ts === "string" ? Date.parse(row.ts) : NaN,
      }].slice(-10);
      // Keep its identity in recordedAttempts so a legacy copy cannot resurrect this refusal.
      // Unmarked history and contradictory markers retain their original interpretation.
      if (row.quality_sample === "not-invoked-budget-refusal" && row.draft_cost_usd === 0 &&
          row.clean === false && row.contract_failed === false) continue;
      const measured = arm(row.deployment);
      const detail = evidence(measured);
      const dollars = cost({ cost_usd: row.draft_cost_usd });
      if (dollars > 0) detail.costedAttempts++;
      measured.attempts++;
      measured.costUsd += dollars;
      if (row.clean === true && row.outcome !== "refused" && row.outcome !== "failed") measured.clean++;
      if (row.contract_failed === true) measured.contractFailures++;
      continue;
    }
    if (lane !== "inbox-draft" || typeof row.run_id !== "string" || typeof row.proposal_id !== "string") continue;
    const key = JSON.stringify([row.run_id, row.proposal_id]);
    if (row.step === "inbox.draft_synthesized") {
      pending.delete(key);
      if (identities(row).some((id) => recordedAttempts.has(id))) continue;
      const deployment = row.routed_model ?? row.model;
      if (typeof deployment !== "string" || (row.provider !== undefined && row.provider !== "cash" && row.provider !== "openweight")) continue;
      const measured = arm(deployment);
      const detail = evidence(measured);
      if (cost(row) > 0) detail.costedAttempts++;
      measured.attempts++;
      measured.costUsd += cost(row);
      pending.set(key, measured);
    } else if (row.step === "inbox.drafted" || row.step === "inbox.draft_error") {
      const measured = pending.get(key);
      if (measured && row.step === "inbox.drafted" && row.lint_clean === true) measured.clean++;
      if (measured && row.step === "inbox.draft_error" && row.usage_refused !== true &&
          typeof row.fragments === "number" && typeof row.stamps === "number") measured.contractFailures++;
      pending.delete(key);
    }
  }
  return stats;
}

const DRAFT_STATS_STEPS = ["draft.routing.outcome", "inbox.draft_synthesized", "inbox.drafted", "inbox.draft_error"] as const;

/** Could this unparseable ledger line have been a row of one of `steps`? Only a line that names a
 *  step, and none of these, proves it was not: a line torn before its `step` field could be anything. */
export function tornLineCouldBeStep(line: string, steps: readonly string[]): boolean {
  if (steps.some((step) => line.includes(JSON.stringify(step)))) return true;
  return !line.includes('"step":"');
}

export function readDraftStats(stateDir: string, lane: string): DraftStats {
  // The union's best-effort directory read otherwise hides a permissions failure as an empty prior.
  readdirSync(stateDir);
  // The union counts EVERY unparseable line it scans, whatever its step. One spliced 2026-09-20 ENOSPC
  // row (sweep.fix_capacity + serve.error) failed all 927 reads from 10-04 to 10-14, so this lane never
  // routed by its posteriors. Refuse only over a torn line that could have been one of these rows.
  let tornDraftRows = 0;
  const read = readLedgerUnionRecordsSync(stateDir, { order: "oldest-first", refuseIncomplete: true, step: [...DRAFT_STATS_STEPS],
    onTorn: (line) => { if (tornLineCouldBeStep(line, DRAFT_STATS_STEPS)) tornDraftRows += 1; } });
  if (!read.ok || tornDraftRows > 0) {
    throw new Error(`draft stats corpus incomplete: ${read.unread.join(", ")}; torn=${tornDraftRows} of ${read.torn}`);
  }
  return draftStatsFromRows(read.rows, lane);
}
