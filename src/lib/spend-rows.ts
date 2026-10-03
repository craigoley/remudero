/**
 * W1-T4066: ONE definition of "this ledger row PRODUCED spend", read by every spend series.
 *
 * A dollar is counted once, at the row of the step that produced it. The old rule — "a row with a string `model`
 * adds its `total_cost_usd`" — counted the run's last worker twice (`terminalVerdictFields` restates it on the
 * `verdict` row) and missed every producer that records `cost_usd` and no `model` (`fix.done`, the probes).
 * Measured on a 4-day union (346,646 rows): 46 of 46 verdicts restated their last `implement.*` cost, a 26.9%
 * overstatement, while ~$514 of fix-rung and probe spend was invisible.
 *
 * The row's own identity is the key, never its `session_id`: four sessions carry both `retro.synthesized` and
 * `retro.preflight_repair`, each with its own real cost.
 */

/** `produced`: this row's cost is new money. `restated`: it repeats a cost an earlier row already carried. */
export type SpendRole = "produced" | "restated";

/**
 * Every literal `log(step, …)` in src that carries `cost_usd` / `total_cost_usd` (or spreads `workerLedgerFields`), plus
 * `cost.anomaly`, which is built by `costAnomalyLine`. The census test fails when a new cost-bearing step is not
 * listed here, so a step cannot silently join or leave the total.
 */
export const SPEND_STEP_ROLES: Readonly<Record<string, SpendRole>> = {
  verdict: "restated", // the run's last worker, via `terminalVerdictFields`, or the run's running total
  "cost.anomaly": "restated", // a finding about a run's cost, never a spend of its own
  "budget.warning": "restated", // the run's accumulated cost so far, ledgered once at a threshold
  "implement.done": "produced",
  "implement.resumed": "produced",
  "recon.done": "produced",
  "diagnose.worker_done": "produced",
  "fix.done": "produced",
  "fix.commit_line_answered": "produced",
  "fix.spawn_infra_blocked": "produced", // $0 by construction: nothing was billed
  "alert-fix.dispatched_worker": "produced",
  "census_push.strike": "produced",
  "inbox.draft_synthesized": "produced",
  "plan.synthesized": "produced",
  "triage.synthesized": "produced",
  "retro.synthesized": "produced",
  "retro.preflight_repair": "produced",
  "risk_judge.decision": "produced",
  "containment.probe": "produced",
  "isolation.probe": "produced",
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The row's cost: `total_cost_usd`, else `cost_usd`. Absent stays `undefined` — never drawn as 0. */
export function spendAmountUsd(row: Record<string, unknown>): number | undefined {
  return finiteNumber(row.total_cost_usd) ?? finiteNumber(row.cost_usd);
}

/** The row's role: its own `spend_role` label, else its step's entry, else the pre-label rule (a string `model`). */
export function spendRoleOf(row: Record<string, unknown>): SpendRole | undefined {
  if (row.spend_role === "produced" || row.spend_role === "restated") return row.spend_role;
  if (typeof row.step === "string" && Object.hasOwn(SPEND_STEP_ROLES, row.step)) return SPEND_STEP_ROLES[row.step];
  return typeof row.model === "string" && row.model !== "" ? "produced" : undefined;
}

/** True when this row carries a cost AND is the row that produced it. The one predicate every spend series reads. */
export function isProducedSpendRow(row: Record<string, unknown>): boolean {
  return spendAmountUsd(row) !== undefined && spendRoleOf(row) === "produced";
}

/** A cash-attributed producer receipt, including an unpriced one. Never infer billing from a
 * model name or credit a restated verdict. Missing provider attribution stays outside this sum. */
export function isCashSpendProducer(row: Record<string, unknown>): boolean {
  return row.provider === "cash" && spendRoleOf(row) === "produced";
}
