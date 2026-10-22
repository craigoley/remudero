import { REPO_ROOT as __testRepoRoot } from "#test/helpers/repo-root.js";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";
type CashAccountingModule = typeof import("#src/lib/cash-accounting.js");
let cashAccountingEvidence: CashAccountingModule["cashAccountingEvidence"];
let recordCashAccounting: CashAccountingModule["recordCashAccounting"];
const cashAccounting = existsSync(join(__testRepoRoot, "src/lib/cash-accounting.ts"))
  ? await import("#src/lib/cash-accounting.js") : undefined;
if (cashAccounting) ({ cashAccountingEvidence, recordCashAccounting } = cashAccounting);
import { evaluateRoutingExperiment, ROUTING_EXPERIMENTS } from "#src/lib/routing-experiments.js";
type ExecutionEvidenceModule = typeof import("#src/lib/worker-execution-evidence.js");
let codexRequestedEffort: ExecutionEvidenceModule["codexRequestedEffort"];
let mergeWorkerIdentity: ExecutionEvidenceModule["mergeWorkerIdentity"];
let readWorkerRequestedEffort: ExecutionEvidenceModule["readWorkerRequestedEffort"];
let sdkRequestedEffort: ExecutionEvidenceModule["sdkRequestedEffort"];
const executionEvidence = existsSync(join(__testRepoRoot, "src/lib/worker-execution-evidence.ts"))
  ? await import("#src/lib/worker-execution-evidence.js") : undefined;
if (executionEvidence) ({ codexRequestedEffort, mergeWorkerIdentity, readWorkerRequestedEffort, sdkRequestedEffort } = executionEvidence);
import { cashTrialStopReason, DEFAULT_CASH_TRIAL_POLICY, summarizeCashTrial } from "#src/lib/cash-trial.js";
import { buildFieldTrialsFlowSnapshot, projectFlowRow } from "#src/lib/field-trials-flow.js";
import { repairCostsByPull } from "#src/lib/repair-cost-evidence.js";
import { benchmarkRunAttemptReceipt, benchmarkWorkerAttemptResources } from "#src/lib/benchmark-run.js";
import { spendAmountUsd } from "#src/lib/spend-rows.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { accumulateUsageLine, usageTelemetryState } from "#src/lib/usage-telemetry.js";

const epoch = ROUTING_EXPERIMENTS.find(item => item.id === "sol61-vs-sonnet55")!;
const today = "2026-10-10";
const ts = `${today}T10:00:00Z`;
function assignment(id: string) {
  return { ts, step: "worker.assignment", task_id: `W1-T${id}`, worker_assignment: { id: `a-${id}`, selected: { provider: "claude" },
    routing: { decision: { ab: epoch.id, considered: [{ provider: "claude", model: "claude-sonnet-5-5" }] }, experiment: { assignedArm: "sol61" } } } };
}
const wire = [{ provenance: "adapter-fetch-call", transport: "responses", parameter: "reasoning.effort", state: "parameter-present", value: "high", providerEffectiveEffort: null, requests: 1 }];
function receipt(id: string, fields: object, step = "worker.attempt") {
  return { ts, step, selection_assignment_id: `a-${id}`, success: true, ...fields };
}
function arm(rows: Record<string, unknown>[]) {
  return evaluateRoutingExperiment(rows, epoch, today).arms.find(item => item.arm === "sol61")!;
}

test("the same selected provider produces distinct actual API and subscription effort scopes", () => {
  assert.ok(cashAccounting, "this source tree must contain the cashAccounting implementation");
  assert.ok(executionEvidence, "this source tree must contain the executionEvidence implementation");
  const rows = [assignment("1"), assignment("2"), assignment("3"), assignment("4"), assignment("5"), assignment("6"),
    receipt("1", { billing_mode: "api", execution_transport: "responses", request_efforts: wire }),
    receipt("2", { billing_mode: "subscription", execution_transport: "claude-sdk", requested_effort: sdkRequestedEffort({ effort: "high" }) }),
    receipt("3", { total_cost_usd: 0 }),
    receipt("4", { billing_mode: "api", execution_transport: "claude-sdk", requested_effort: sdkRequestedEffort({}) }),
    receipt("5", { billing_mode: "subscription", execution_transport: "responses", request_efforts: wire }),
    receipt("6", { billing_mode: "api", execution_transport: "responses", request_efforts: [] })];
  const scope = arm(rows).executionEffortScope;
  assert.equal(scope.assignments, 6); assert.equal(scope.apiWireAssignments, 2);
  assert.equal(scope.subscriptionNativeAssignments, 1); assert.equal(scope.apiNativeAssignments, 1);
  assert.equal(scope.missingIdentityAssignments, 1); assert.equal(scope.conflictingIdentityAssignments, 1);
  assert.equal(scope.apiWireEvidence.attemptedRequests, 1); assert.equal(scope.apiWireEvidence.noRequestAssignments, 1);
  assert.equal(scope.subscriptionRequestedEvidence.parameterPresentAssignments, 1);
  assert.equal(scope.apiNativeRequestedEvidence.parameterOmittedAssignments, 1);
  assert.equal(scope.providerEffectiveEffort, null);
  // The older broad summary remains available independently of transport attribution.
  assert.equal(arm(rows).requestEffortEvidence.assignments, 6);
});

test("billing and transport contradictions remain unknown in both arrival orders", () => {
  assert.ok(cashAccounting, "this source tree must contain the cashAccounting implementation");
  assert.ok(executionEvidence, "this source tree must contain the executionEvidence implementation");
  const first = receipt("1", { billing_mode: "api", execution_transport: "responses", total_cost_usd: 0.1, request_efforts: wire });
  const second = receipt("1", { billing_mode: "subscription", execution_transport: "claude-sdk", notional_cost_usd: 2 }, "verdict");
  for (const events of [[first, second], [second, first]]) {
    const result = arm([assignment("1"), ...events]);
    assert.equal(result.meanCashCostUsd, null); assert.equal(result.meanNotionalCostUsd, null);
    assert.equal(result.costMissingAssignments, 1); assert.equal(result.executionEffortScope.conflictingIdentityAssignments, 1);
  }
  for (const events of [[first, receipt("1", { billing_mode: null }, "verdict")], [receipt("1", { billing_mode: null }, "verdict"), first]])
    assert.equal(arm([assignment("1"), ...events]).executionEffortScope.invalidIdentityAssignments, 1);
  const missing = receipt("1", {}, "verdict");
  for (const events of [[first, missing], [missing, first], [first, first]]) {
    const result = arm([assignment("1"), ...events]);
    assert.equal(result.meanCashCostUsd, 0.1); assert.equal(result.executionEffortScope.apiWireAssignments, 1);
    assert.equal(result.executionEffortScope.apiWireEvidence.attemptedRequests, 1);
  }
});

test("held allowance does not appear as zero-priced or invoice cash in trial output", () => {
  assert.ok(cashAccounting, "this source tree must contain the cashAccounting implementation");
  assert.ok(executionEvidence, "this source tree must contain the executionEvidence implementation");
  const held = cashAccountingEvidence(); recordCashAccounting(held, "held", 0.02);
  const complete = cashAccountingEvidence(); recordCashAccounting(complete, "usage-priced", 0);
  const result = arm([assignment("1"), assignment("2"), receipt("1", { billing_mode: "api", total_cost_usd: 0, cash_accounting: held }),
    receipt("2", { billing_mode: "api", total_cost_usd: 0, cash_accounting: complete })]);
  assert.equal(result.costMissingAssignments, 1); assert.equal(result.receiptCoverage.costKnownAssignments, 1);
  assert.equal(result.cashAccountingEvidence.heldAssignments, 1); assert.equal(result.cashAccountingEvidence.heldUsd, 0.02);
  assert.equal(result.cashAccountingEvidence.invoiceCashUsd, null);
  const noComplete = arm([assignment("1"), receipt("1", { billing_mode: "api", total_cost_usd: 0, cash_accounting: held })]);
  assert.equal(noComplete.meanCashCostUsd, null);
});

test("the existing daily producer persists execution scopes and held accounting from all ledger forms", async () => {
  assert.ok(cashAccounting, "this source tree must contain the cashAccounting implementation");
  assert.ok(executionEvidence, "this source tree must contain the executionEvidence implementation");
  const root = mkdtempSync(join(tmpdir(), "rmd-trial-execution-"));
  try {
    const stateDir = join(root, "state"), outDir = join(root, "out"); mkdirSync(stateDir);
    const accounting = cashAccountingEvidence(); recordCashAccounting(accounting, "held", 0.02);
    const worker = receipt("1", { billing_mode: "api", execution_transport: "responses", request_efforts: wire, cash_accounting: accounting, total_cost_usd: 0 });
    const lines = (rows: object[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
    writeFileSync(join(stateDir, "ledger.2026-10-10T08-00-00-000Z.ndjson"), lines([assignment("1")]));
    writeFileSync(join(stateDir, "ledger.2026-10-10T09-00-00-000Z.ndjson.gz"), gzipSync(lines([worker])));
    writeFileSync(join(stateDir, "ledger.ndjson"), lines([{ ...worker, step: "verdict" }]));
    const { dailyRoutingReview } = await import(pathToFileURL(join(__testRepoRoot, "scripts/private-routing-daily-review.mjs")).href);
    const result = await dailyRoutingReview({ sources: [{ label: "core", stateDir }], outDir, asOf: `${today}T12:00:00Z` });
    const persisted = JSON.parse(readFileSync(join(outDir, "latest.json"), "utf8"));
    const report = persisted.sources[0].reports.find((item: { id: string }) => item.id === epoch.id).arms.find((item: { arm: string }) => item.arm === "sol61");
    assert.equal(report.executionEffortScope.apiWireAssignments, 1); assert.equal(report.executionEffortScope.apiWireEvidence.attemptedRequests, 1);
    assert.equal(report.cashAccountingEvidence.heldUsd, 0.02); assert.equal(report.meanCashCostUsd, null);
    assert.equal(report.cashAccountingEvidence.invoiceCashUsd, null); assert.equal(result.snapshot.comparativeClaims, "none");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native effort receipts name actual options and argv without claiming effective provider effort", () => {
  assert.ok(cashAccounting, "this source tree must contain the cashAccounting implementation");
  assert.ok(executionEvidence, "this source tree must contain the executionEvidence implementation");
  assert.equal(sdkRequestedEffort({}).state, "parameter-omitted");
  assert.equal(sdkRequestedEffort({ effort: "high" }).value, "high");
  assert.equal(sdkRequestedEffort({ effort: "invented" }).state, "parameter-unreadable");
  assert.equal(codexRequestedEffort(["exec", "-c", 'model_reasoning_effort="high"', "unrelated prompt"]).value, "high");
  assert.equal(codexRequestedEffort(["exec", "unrelated prompt"]).state, "parameter-omitted");
  assert.equal(codexRequestedEffort(["-c", "model_reasoning_effort=broken"]).state, "parameter-unreadable");
  assert.equal(codexRequestedEffort(["-c", 'model_reasoning_effort="high"', "-c", 'model_reasoning_effort="low"']).state, "parameter-unreadable");
  for (const value of [null, [], { provenance: { toString: null } }, { ...sdkRequestedEffort({ effort: "high" }), providerEffectiveEffort: "high" }])
    assert.equal(readWorkerRequestedEffort(value), undefined);
  const known = mergeWorkerIdentity(undefined, "api", ["api", "subscription"]);
  assert.deepEqual(mergeWorkerIdentity(known, undefined, ["api", "subscription"]), known);
});

test("unknown cash accounting holds the paid trial while retaining its known price separately", () => {
  assert.ok(cashAccounting, "this source tree must contain the cashAccounting implementation");
  assert.ok(executionEvidence, "this source tree must contain the executionEvidence implementation");
  const accounting = cashAccountingEvidence(); recordCashAccounting(accounting, "held", 0.1);
  const trial = summarizeCashTrial([{ ts, run_id: "run", step: "worker.assignment", worker_assignment: { id: "call", routing: { decision: { trial: "cash-simple", trialArm: "cash" } } } },
    { ts, step: "implement.done", selection_assignment_id: "call", provider: "cash", billing_mode: "api", total_cost_usd: 0, cash_accounting: accounting }], today);
  assert.equal(trial.spentTodayUsd, 0); assert.equal(trial.heldTodayUsd, 0.1);
  assert.match(trial.spendUnavailableReason!, /unknown.*held/);
});

test("served model contradictions stay unavailable in both trial receipt orders", () => {
  assert.ok(cashAccounting, "this source tree must contain the cashAccounting implementation");
  assert.ok(executionEvidence, "this source tree must contain the executionEvidence implementation");
  const first = receipt("1", { served_model: "actual-one" });
  const second = receipt("1", { served_model: "actual-two" }, "verdict");
  for (const events of [[first, second], [second, first]])
    assert.equal(arm([assignment("1"), ...events]).receiptCoverage.servedModelKnownAssignments, 0);
  assert.equal(arm([assignment("1"), first, receipt("1", {}, "verdict")]).receiptCoverage.servedModelKnownAssignments, 1);
});

test("actual native effort provenance must agree with its recorded execution transport", () => {
  assert.ok(cashAccounting, "this source tree must contain the cashAccounting implementation");
  assert.ok(executionEvidence, "this source tree must contain the executionEvidence implementation");
  const result = arm([assignment("1"), assignment("2"),
    receipt("1", { billing_mode: "subscription", execution_transport: "codex-cli", requested_effort: sdkRequestedEffort({ effort: "high" }) }),
    receipt("2", { billing_mode: "api", execution_transport: "chat-completions", request_efforts: wire })]);
  assert.equal(result.executionEffortScope.conflictingIdentityAssignments, 2);
  assert.equal(result.executionEffortScope.subscriptionNativeAssignments, 0);
  assert.equal(result.executionEffortScope.apiWireAssignments, 0);
});

test("the field-flow assignment projection preserves held charges and duplicate identity contradictions", () => {
  assert.ok(cashAccounting, "this source tree must contain the cashAccounting implementation");
  assert.ok(executionEvidence, "this source tree must contain the executionEvidence implementation");
  const accounting = cashAccountingEvidence(); recordCashAccounting(accounting, "held", 0.1);
  const assigned = { ...assignment("1"), worker_assignment: { id: "a-1", selected: { provider: "cash", model: "gpt-6-luna" } } };
  const first = receipt("1", { billing_mode: "api", cash_accounting: accounting, total_cost_usd: 0, served_model: "actual-one" });
  const second = receipt("1", { served_model: "actual-two" });
  for (const events of [[first, second], [second, first]]) {
    const rows = [assigned, ...events].map((row, index) => projectFlowRow(row, `fp-${index}`));
    const snapshot = buildFieldTrialsFlowSnapshot({ asOf: `${today}T12:00:00Z`,
      sources: [{ label: "core", repo: "fixture/core", ledger: { state: "observed", reason: null,
        forms: { gzip: 0, plain: 0, live: 1 }, malformedRows: 0, duplicateRows: 0, futureRows: 0, unreadSources: 0, newestTs: ts, rows } }],
      github: { version: "field-trials-github-v1", repos: {} } });
    const evidence = snapshot.assignmentTelemetry[0]!;
    assert.equal(evidence.apiCostEstimateUsd, 0); assert.equal(evidence.costMissingAssignments, 1);
    assert.equal(evidence.cashAccountingEvidence?.heldUsd, 0.1); assert.equal(evidence.cashAccountingEvidence?.invoiceCashUsd, null);
    assert.equal(evidence.servedModelKnownAssignments, 0); assert.equal(evidence.servedModelUnavailableReasons["served-model-conflicting"], 1);
  }
});

test("a held fix attempt is unavailable cost through the actual field-flow repair projection", () => {
  assert.ok(cashAccounting, "this source tree must contain the cashAccounting implementation");
  assert.ok(executionEvidence, "this source tree must contain the executionEvidence implementation");
  const held = cashAccountingEvidence(); recordCashAccounting(held, "held", 0.02);
  const shared = { repair_pr_url: "https://github.com/fixture/core/pull/1", repair_round_id: "round", worker_run_id: "run", worker_rung: "fix" };
  const cashAssignment = assignment("1");
  cashAssignment.worker_assignment.selected.provider = "cash";
  const assigned = projectFlowRow({ ...cashAssignment, ...shared }, "assignment");
  assert.equal(assigned.provider, "cash", "the repair assignment and actual cash result identify the same provider");
  const result = projectFlowRow({ ...receipt("1", { provider: "cash", billing_mode: "api", cash_accounting: held, total_cost_usd: 0 }), ...shared }, "attempt");
  assert.equal(result.costUsd, null);
  const report = repairCostsByPull([assigned, result], "fixture/core").get(1)!;
  assert.equal(report.missingCost, 1); assert.equal(report.knownApiAttempts, 0); assert.equal(report.apiCostEstimateUsd, null);
});

test("the real task-attempt resource projection retains held billing and transport without a zero cost", () => {
  assert.ok(cashAccounting, "this source tree must contain the cashAccounting implementation");
  assert.ok(executionEvidence, "this source tree must contain the executionEvidence implementation");
  const cash = cashAccountingEvidence(); recordCashAccounting(cash, "held", 0.02);
  const result = { sessionId: "fixture", costUsd: 0, numTurns: 1, text: "", blocks: [], stderr: "synthetic failure",
    subtype: "error_during_execution", isError: true, apiError: true, permissionDenials: [], childEnvKeys: [],
    model: "gpt-6-luna", effort: "low", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
    provider: "cash", executionTransport: "chat-completions", requestEfforts: [], cashAccounting: cash,
    compactionEvents: 0, qualitySuspect: false,
    tokenUsageState: "partial", budgetReservedUsd: 0.02, budgetHeldUsd: 0.02, budgetSettledUsd: 0 } as WorkerResult;
  const fields = benchmarkWorkerAttemptResources(result);
  assert.equal(fields.billing_mode, "api"); assert.equal(fields.execution_transport, "chat-completions");
  assert.equal(fields.provider, "cash");
  assert.deepEqual(fields.cash_accounting, cash); assert.equal(fields.budget_held_usd, 0.02);
  assert.equal(Object.hasOwn(fields, "total_cost_usd"), false); assert.equal(Object.hasOwn(fields, "tokens"), false);
  const receipt = benchmarkRunAttemptReceipt({ step: "worker.attempt", success: false, ...fields })!;
  assert.equal(receipt.accounting.apiCostUsd.state, "unavailable");
  assert.equal(receipt.accounting.cashAllowance?.state, "observed");
  assert.equal(spendAmountUsd({ ...fields, total_cost_usd: 0 }), undefined);
  const complete = cashAccountingEvidence(); recordCashAccounting(complete, "usage-priced", 0);
  assert.equal(spendAmountUsd({ billing_mode: "api", total_cost_usd: 99, cash_accounting: complete }), 0);
  const state = usageTelemetryState();
  accumulateUsageLine(state, { ...assignment("1"), run_id: "usage-run", worker_assignment: { id: "a-1", selected: { provider: "cash", model: "gpt-6-luna" },
    routing: { decision: { ab: "trial-fixture" } } } });
  const raw = { ts, run_id: "usage-run", provider: "cash", model: "gpt-6-luna", billing_mode: "api", total_cost_usd: 0, cash_accounting: cash };
  accumulateUsageLine(state, { ...raw, step: "implement.done" });
  accumulateUsageLine(state, { ...raw, step: "verdict", success: true });
  assert.equal(state.cash[0]?.unpricedRows, 1); assert.equal(state.cashEvents?.[0]?.[1], null);
  assert.equal(state.markedRuns?.[0]?.outcome?.costUsd, null);
});

test("invalid accounting holds the paid trial before its nominal cost can become spend", () => {
  assert.ok(cashAccounting, "this source tree must contain the cashAccounting implementation");
  const known = cashAccountingEvidence(); recordCashAccounting(known, "usage-priced", 0.4);
  const rows = (accounting: unknown) => [
    { ts, run_id: "invalid-accounting", step: "worker.assignment", worker_assignment: {
      id: "invalid-accounting-call", routing: { decision: { trial: "cash-simple", trialArm: "cash" } } } },
    { ts, step: "implement.done", selection_assignment_id: "invalid-accounting-call", provider: "cash",
      billing_mode: "api", total_cost_usd: 2, cash_accounting: accounting },
  ];
  const positive = summarizeCashTrial(rows(known), today);
  assert.equal(positive.spentTodayUsd, 0.4, "positive control observes the same cash assignment and receipt");
  assert.equal(positive.spendUnavailableReason, undefined);
  for (const invalid of [null, { ...known, invoiceCashUsd: 0.4 }, { ...known, heldRequests: 1 }]) {
    const trial = summarizeCashTrial(rows(invalid), today);
    assert.equal(trial.spentTodayUsd, 0, "invalid accounting cannot fall through to the nominal two-dollar cost");
    assert.equal(trial.heldTodayUsd, undefined, "missing reservation amount cannot be invented");
    assert.equal(trial.spendUnavailableReason, "cash accounting evidence is invalid or conflicting");
    assert.match(cashTrialStopReason(trial, DEFAULT_CASH_TRIAL_POLICY, 25)!, /spend evidence unavailable/);
  }
});
