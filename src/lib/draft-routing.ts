import { readdirSync } from "node:fs";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";

export interface DraftDeploymentStats {
  attempts: number;
  clean: number;
  contractFailures: number;
  costUsd: number;
}

export type DraftStats = Record<string, DraftDeploymentStats>;
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
        for (const [deployment, delta] of Object.entries(draftStatsFromRows([{ step, ...extra }], lane))) {
          const measured = stats[deployment] ??= { attempts: 0, clean: 0, contractFailures: 0, costUsd: 0 };
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
export function chooseDraftDeployment(stats: DraftStats, candidates: readonly DraftArm[], random: () => number = Math.random): DraftChoice {
  if (candidates.length === 0) throw new Error("draft routing has no eligible deployments");
  const arms = candidates.map((arm, index): DraftPosterior => {
    const measured = stats[arm.deployment];
    const attempts = measured?.attempts ?? 0;
    const clean = Math.min(attempts, measured?.clean ?? 0);
    const alpha = 1 + clean;
    const beta = 1 + index + attempts - clean;
    const a = gamma(alpha, random);
    const b = gamma(beta, random);
    const sampledCleanRate = a / (a + b);
    const costPerAttemptUsd = measured && measured.costUsd > 0 && attempts > 0
      ? measured.costUsd / attempts : arm.estimatedCostUsd;
    if (!(costPerAttemptUsd > 0) || !Number.isFinite(costPerAttemptUsd)) throw new Error(`invalid draft cost for ${arm.deployment}`);
    return { ...arm, alpha, beta, sampledCleanRate, costPerAttemptUsd, cleanPerDollar: sampledCleanRate / costPerAttemptUsd };
  });
  const posterior = arms.reduce((best, arm) => arm.cleanPerDollar > best.cleanPerDollar ? arm : best);
  return { deployment: posterior.deployment, reason: "thompson-clean-per-dollar", posterior, arms };
}

/** Correlate legacy outcomes by run and proposal, never crediting an earlier relint's deployment. */
export function draftStatsFromRows(rows: readonly Record<string, unknown>[], lane: string): DraftStats {
  const stats: DraftStats = {};
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
      const measured = arm(row.deployment);
      measured.attempts++;
      measured.costUsd += cost({ cost_usd: row.draft_cost_usd });
      if (row.clean === true) measured.clean++;
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

export function readDraftStats(stateDir: string, lane: string): DraftStats {
  // The union's best-effort directory read otherwise hides a permissions failure as an empty prior.
  readdirSync(stateDir);
  const read = readLedgerUnionRecordsSync(stateDir, { order: "oldest-first", refuseIncomplete: true,
    step: ["draft.routing.outcome", "inbox.draft_synthesized", "inbox.drafted", "inbox.draft_error"] });
  if (!read.ok || read.torn > 0) throw new Error(`draft stats corpus incomplete: ${read.unread.join(", ")}; torn=${read.torn}`);
  return draftStatsFromRows(read.rows, lane);
}
