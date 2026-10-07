import assert from "node:assert/strict";
import { test } from "node:test";
import { projectFlowRow } from "../src/lib/field-trials-flow.js";
import { projectRepairCostContext, repairCostCells, repairCostsByPull, repairReceiptFields } from "../src/lib/repair-cost-evidence.js";

function row(step: string, id: string, extra: Record<string, unknown> = {}) {
  return projectFlowRow({ step, ts: "2026-10-01T00:00:00Z", task_id: "W1-Tshared", run_id: "daemon",
    worker_run_id: "fix-run", worker_rung: "fix", repair_pr_url: "https://github.com/acme/core/pull/1", repair_round_id: "round-1",
    ...(step === "worker.assignment" ? { worker_assignment: { id } } : { selection_assignment_id: id }), ...extra }, JSON.stringify(extra));
}

test("PR repair costs deduplicate assignment attempts and keep subscription notional apart from cash", () => {
  const api = row("worker.attempt", "api", { total_cost_usd: 0.2, billing_mode: "api" });
  const sub = row("worker.attempt", "sub", { total_cost_usd: 99, notional_cost_usd: 0.5, billing_mode: "subscription" });
  const rows = [row("worker.assignment", "api"), api, { ...api, ts: "2026-10-02T00:00:00Z" },
    row("worker.assignment", "sub"), sub, { ...sub, step: "verdict" }, row("worker.assignment", "pending"),
    row("worker.attempt", "unjoined", { total_cost_usd: 3, billing_mode: "api" })];
  const report = repairCostsByPull(rows, "acme/core").get(1)!;
  assert.equal(report.identifiedAssignments, 3);
  assert.equal(report.knownApiAttempts, 1); assert.equal(report.apiCostEstimateUsd, 0.2);
  assert.equal(report.knownSubscriptionAttempts, 1); assert.equal(report.subscriptionNotionalUsd, 0.5);
  assert.equal(report.missingTerminal, 1); assert.equal(report.unjoinedAttemptRows, 1);
  assert.equal(report.history, "unavailable-retention-uncertified");
  assert.equal(report.source, "worker-result-estimate-not-invoice");
});

test("repair costs never use a shared task or daemon id to assign one PR's spending to another", () => {
  const second = { repair_pr_url: "https://github.com/acme/core/pull/2", repair_round_id: "round-2", worker_run_id: "another-fix-run" };
  const rows = [row("worker.assignment", "one"), row("worker.attempt", "one", { total_cost_usd: 1, billing_mode: "api" }),
    row("worker.assignment", "two", second), row("worker.attempt", "two", { ...second, total_cost_usd: 2, billing_mode: "api" }),
    row("worker.attempt", "build", { worker_rung: "implement", total_cost_usd: 50, billing_mode: "api" }),
    row("worker.attempt", "legacy", { repair_pr_url: undefined, total_cost_usd: 100, billing_mode: "api" }),
    row("worker.attempt", "foreign", { repair_pr_url: "https://github.com/acme/other/pull/1", total_cost_usd: 200, billing_mode: "api" })];
  const reports = repairCostsByPull(rows, "acme/core");
  assert.equal(reports.get(1)!.apiCostEstimateUsd, 1); assert.equal(reports.get(2)!.apiCostEstimateUsd, 2);
  const cells = repairCostCells([...reports.values()]);
  assert.equal(cells.apiCostEstimateUsd, 3); assert.equal(cells.knownApiAttempts, 2);
  assert.equal(cells.subscriptionNotionalUsd, null);
});

test("conflicting cost, PR, round or durable assignment evidence cannot become a repair charge", () => {
  const cases = [
    { total_cost_usd: 2 }, { billing_mode: "subscription" }, { repair_round_id: "different-round" },
    { repair_pr_url: "https://github.com/acme/core/pull/2" }, { assignment_observed: false }, { repair_round_id: undefined },
  ];
  for (const change of cases) {
    const rows = [row("worker.assignment", "a"), row("worker.attempt", "a", { total_cost_usd: 1, billing_mode: "api" }),
      row("worker.attempt", "a", { total_cost_usd: 1, billing_mode: "api", ...change })];
    const report = repairCostsByPull(rows, "acme/core").get(1)!;
    assert.equal(report.conflictingIdentities, 1, JSON.stringify(change));
    assert.equal(report.apiCostEstimateUsd, null); assert.equal(report.subscriptionNotionalUsd, null);
  }
});

test("an explicitly observed zero is distinct from a missing or malformed repair estimate", () => {
  const rows = [row("worker.assignment", "zero"), row("worker.attempt", "zero", { total_cost_usd: 0, billing_mode: "api" }),
    row("worker.assignment", "missing"), row("worker.attempt", "missing", { billing_mode: "api" }),
    row("worker.assignment", "unknown-mode"), row("worker.attempt", "unknown-mode", { total_cost_usd: 3 }),
    row("worker.assignment", "invalid-notional"), row("worker.attempt", "invalid-notional", {
      total_cost_usd: 3, notional_cost_usd: NaN, billing_mode: "subscription" }),
    row("worker.assignment", "sub-zero"), row("worker.attempt", "sub-zero", {
      notional_cost_usd: 0, billing_mode: "subscription" }),
    row("worker.assignment", "legacy-sub"), row("worker.attempt", "legacy-sub", {
      total_cost_usd: 0.4, billing_mode: "subscription" }),
    row("worker.attempt", "bad-join", { worker_run_id: undefined, total_cost_usd: 4, billing_mode: "api" })];
  const report = repairCostsByPull(rows, "acme/core").get(1)!;
  assert.equal(report.knownApiAttempts, 1); assert.equal(report.apiCostEstimateUsd, 0);
  assert.equal(report.knownSubscriptionAttempts, 2); assert.equal(report.subscriptionNotionalUsd, 0.4);
  assert.equal(report.missingCost, 3); assert.equal(report.unjoinedAttemptRows, 1);
  assert.equal(repairCostCells([]).apiCostEstimateUsd, null);
});

test("repair receipt context is explicit and a pre-push or malformed identity cannot invent a PR", () => {
  assert.deepEqual(repairReceiptFields(), {});
  assert.deepEqual(repairReceiptFields({ prUrl: "bad-url", roundId: "round" }), {});
  assert.deepEqual(repairReceiptFields({ prUrl: "https://github.com/acme/core/pull/1", roundId: "" }), {});
  assert.deepEqual(repairReceiptFields({ prUrl: "https://github.com/acme/core/pull/1", roundId: "round" }),
    { repair_pr_url: "https://github.com/acme/core/pull/1", repair_round_id: "round" });
  const malformed = projectRepairCostContext({ repair_pr_url: "https://github.com/acme/core/pull/999999999999999999" });
  assert.equal(malformed.number, null);
  assert.equal(repairCostsByPull([row("worker.assignment", "a", { repair_pr_url: undefined })], "acme/core").size, 0);
});

test("known Codex repair providers require an explicit notional price and cannot conflict across one identity", () => {
  const assigned = (id: string) => row("worker.assignment", id, { provider: "codex" });
  const attempt = (id: string, extra: Record<string, unknown>) => row("worker.attempt", id,
    { total_cost_usd: 0, billing_mode: "subscription", ...extra });
  const rows = [assigned("explicit"), attempt("explicit", { provider: "codex" }),
    assigned("legacy"), attempt("legacy", {}), assigned("zero"), attempt("zero", { notional_cost_usd: 0 }),
    assigned("positive"), attempt("positive", { notional_cost_usd: 0.5 }),
    assigned("conflict"), attempt("conflict", { provider: "claude", notional_cost_usd: 0.2 })];
  const report = repairCostsByPull(rows, "acme/core").get(1)!;
  assert.equal(report.identifiedAssignments, 5);
  assert.equal(report.knownSubscriptionAttempts, 2);
  assert.equal(report.subscriptionNotionalUsd, 0.5);
  assert.equal(report.missingCost, 2);
  assert.equal(report.conflictingIdentities, 1);
  assert.equal(report.apiCostEstimateUsd, null);
});
