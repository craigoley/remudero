import { REPO_ROOT as __workspaceRoot } from "#test/helpers/repo-root.js";
import { pathToFileURL as __workspaceUrl, fileURLToPath as __workspacePath } from "node:url";
const __workspaceRootUrl = __workspaceUrl(__workspaceRoot + "/");
/** Canonical compact consumer controls; synthetic corpus only, no deployment claim. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { test, type TestContext } from "node:test";
import { evaluateRoutingExperiment, routingExperimentObserver, ROUTING_EXPERIMENTS } from "#src/lib/routing-experiments.js";

const { dailyRoutingReview } = await import(pathToFileURL(__workspacePath(new URL("scripts/private-routing-daily-review.mjs", __workspaceRootUrl))).href);
// Every timestamp and the collector clock belongs to this synthetic fixture.
const asOf = "2026-10-12T12:00:00.000Z";
const epoch = ROUTING_EXPERIMENTS.find(e => e.id === "sol61-vs-sonnet55")!;
const assignment = (id: number, arm = "sol61") => ({ ts: "2026-10-12T10:00:00.000Z", step: "worker.assignment", task_id: `W1-T${id}`,
  worker_assignment: { id: `contract-${id}-${arm}`, selected: { provider: arm === "sol61" ? "codex" : "claude" }, routing: {
    decision: { ab: epoch.id, considered: [{ provider: "claude", model: "claude-sonnet-5-5" }, { provider: "codex", model: "gpt-6.1-sol" }] },
    experiment: { assignedArm: arm, crossover: false },
  } } });
const receipt = (id: number, mode = "api") => ({ ts: "2026-10-12T10:01:00.000Z", step: "worker.attempt",
  selection_assignment_id: `contract-${id}-sol61`, billing_mode: mode, total_cost_usd: 2,
  notional_cost_usd: mode === "subscription" ? 3 : undefined, served_model: "gpt-6.1-sol-synthetic-fixture", success: true });
const ndjson = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join("\n") + "\n";
function fixture(t: TestContext, gzip: unknown[], plain: unknown[], live: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "rmd-collector-contract-")), stateDir = join(root, "state");
  mkdirSync(stateDir); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(stateDir, "ledger.2026-10-12T09-00-00-000Z.ndjson.gz"), gzipSync(ndjson(gzip)));
  writeFileSync(join(stateDir, "ledger.2026-10-12T09-30-00-000Z.ndjson"), ndjson(plain));
  writeFileSync(join(stateDir, "ledger.ndjson"), ndjson(live));
  return { root, stateDir, sources: [{ label: "core", stateDir }], outDir: join(root, "out"), asOf };
}
const reportOf = (snapshot: any) => snapshot.sources[0].reports.find((r: { id: string }) => r.id === epoch.id);
const armOf = (report: any, arm = "sol61") => report.arms.find((a: { arm: string }) => a.arm === arm);

test("collector preparation real three-form duplicates and receipts-before-assignment retain distinct record units", async t => {
  const a = assignment(7001), b = assignment(7002), r = receipt(7001);
  const f = fixture(t, [r, a], [a, b], [b]);
  const { snapshot } = await dailyRoutingReview(f), source = snapshot.sources[0], report = reportOf(snapshot);
  assert.deepEqual(source.forms, { gzip: 1, plain: 1, live: 1 }); assert.equal(source.rowsRead, 3);
  assert.equal(report.assignments, 2); assert.equal(armOf(report).receiptCoverage.terminalAssignments, 1);
  assert.equal(armOf(report).nonStarterAssignments, 1); assert.equal(source.state, "observed");
  assert.equal(snapshot.comparativeClaims, "none"); assert.equal(snapshot.routingChanged, false);
});

test("collector preparation canonical ties preserve first arrival and repeated fixes preserve multiplicity", () => {
  const a = assignment(7003), b = assignment(7003, "sonnet");
  const first = evaluateRoutingExperiment([a, b], epoch, asOf.slice(0, 10));
  const reverse = evaluateRoutingExperiment([b, a], epoch, asOf.slice(0, 10));
  assert.equal(armOf(first).tasks, 1); assert.equal(armOf(reverse, "sonnet").tasks, 1);
  const fix = { ts: "2026-10-12T11:00:00.000Z", step: "fix.dispatch", task_id: "W1-T7003" };
  const report = evaluateRoutingExperiment([fix, { ...fix, event_index: 2 }, a], epoch, asOf.slice(0, 10));
  assert.equal(armOf(report).meanFixDispatches, 2);
  assert.equal(report.sufficient, false, "fixture coverage cannot waive the real sample minimum");
});

test("collector preparation corrupt archives and malformed rows retain positive trial evidence and scoped damage", async t => {
  const f = fixture(t, [], [assignment(7004)], [assignment(7005)]);
  writeFileSync(join(f.stateDir, "ledger.2026-10-12T09-00-00-000Z.ndjson.gz"), "invalid gzip");
  writeFileSync(join(f.stateDir, "ledger.2026-10-12T09-30-00-000Z.ndjson"), ndjson([assignment(7004)]) + "not JSON\n");
  const { snapshot } = await dailyRoutingReview(f), source = snapshot.sources[0], report = reportOf(snapshot);
  assert.deepEqual(source.forms, { gzip: 1, plain: 1, live: 1 }); assert.equal(report.assignments, 2);
  assert.equal(source.state, "observed-partial"); assert.ok(source.reasons.includes("ledger-source-unreadable"));
  assert.ok(source.reasons.includes("ledger-source-malformed")); assert.equal(report.reviewState, "source-incomplete");
  assert.equal(report.nextAction, "repair-source-evidence");
});

test("collector preparation arrivals after cutoff and unresolved future timestamps remain different evidence gaps", async t => {
  const current = assignment(7006), arrived = { ...assignment(7007), ts: "2026-10-12T12:01:00.000Z" };
  const future = { ...assignment(7008), ts: "2026-10-12T12:10:00.000Z" };
  const f = fixture(t, [current], [arrived], [future]);
  const { snapshot } = await dailyRoutingReview(f), source = snapshot.sources[0], report = reportOf(snapshot);
  assert.equal(source.rowsRead, 1); assert.equal(report.assignments, 1); assert.equal(source.futureRows, 1);
  assert.ok(source.reasons.includes("ledger-source-future-dated")); assert.equal(report.sourceQuality.state, "observed-partial");
  assert.equal(source.selfImprovement.efficacyClaim, "none");
});

test("collector preparation missing cost and source retention never become a measured zero or certified history", async t => {
  const f = fixture(t, [assignment(7009)], [], [{ ts: "2026-10-12T10:01:00.000Z", step: "worker.attempt",
    selection_assignment_id: "contract-7009-sol61", success: false }]);
  const { snapshot } = await dailyRoutingReview(f), source = snapshot.sources[0], arm = armOf(reportOf(snapshot));
  assert.equal(arm.costMissingAssignments, 1); assert.equal(arm.meanCashCostUsd, null); assert.equal(arm.meanNotionalCostUsd, null);
  assert.equal(source.selfImprovement.sourceComplete, false); assert.equal(source.selfImprovement.ciLearning, null);
});

test("collector target compact retention keeps small trials and recent review learning after unrelated history", async t => {
  const noise = (start: number, count: number) => Array.from({ length: count }, (_, i) => ({
    ts: "2026-10-10T10:00:00.000Z", step: "worker.assignment", task_id: `W1-T${800000 + start + i}`,
    worker_assignment: { id: `unrelated-${start + i}`, routing: { decision: { ab: "unrelated-fixture" } } },
  }));
  const review = { ts: "2026-10-12T11:40:00.000Z", step: "review.posted", task_id: "W1-T7010" };
  const learning = { ts: "2026-10-12T11:50:00.000Z", step: "ci_learning_cadence.ran", filed: 1, refused: 0 };
  const f = fixture(t, noise(0, 50_000), noise(50_000, 50_001), [assignment(7010), assignment(7011), receipt(7010), review, learning]);
  const { snapshot } = await dailyRoutingReview(f), source = snapshot.sources[0];
  assert.deepEqual(source.forms, { gzip: 1, plain: 1, live: 1 }); assert.equal(source.rowsRead, 100_006);
  assert.equal(reportOf(snapshot).assignments, 2, "required compact consumer must retain the eligible small trial");
  assert.equal(source.selfImprovement.ciLearning.filed, 1, "recent learning cannot share unrelated historical raw-row exhaustion");
  assert.equal(source.retainedRowsOmitted, 0, "a compact scope must report its own exhaustion separately");
});

test("collector target conflicting known billing stays unavailable in both arrival orders", () => {
  const a = assignment(7012), api = receipt(7012, "api"), subscription = receipt(7012, "subscription");
  const arms = [[api, subscription], [subscription, api]].map(receipts => armOf(evaluateRoutingExperiment([a, ...receipts], epoch, asOf.slice(0, 10))));
  assert.deepEqual(arms.map(a => a.costMissingAssignments), [1, 1], "contradictory modes are unavailable, not last-row wins");
  assert.deepEqual(arms.map(a => a.meanCashCostUsd), [null, null]);
  assert.deepEqual(arms.map(a => a.meanNotionalCostUsd), [null, null]);
});

test("compact observer and batch wrapper agree over out of order crossover merge and fix permutations", () => {
  const a = assignment(7013), b = { ...assignment(7013, "sonnet"), ts: "2026-10-12T11:00:00Z" };
  b.worker_assignment.routing.experiment.crossover = true;
  const rows = [a, b, receipt(7013), { ts: "2026-10-12T10:30:00Z", step: "verdict.merged", task_id: a.task_id },
    { ts: "2026-10-12T09:00:00Z", step: "fix.dispatch", task_id: a.task_id },
    { ts: "2026-10-12T11:00:00Z", step: "fix.dispatch", task_id: a.task_id },
    { ts: "2026-10-12T11:00:00Z", step: "fix.dispatch", task_id: a.task_id }];
  for (const permutation of [rows, [...rows].reverse(), [...rows.slice(2), a, b]]) {
    const observer = routingExperimentObserver(epoch, "2026-10-12");
    permutation.forEach(observer.observe);
    assert.deepEqual(observer.report(), evaluateRoutingExperiment(permutation, epoch, "2026-10-12"));
    assert.equal(armOf(observer.report()).meanFixDispatches, 2); assert.equal(armOf(observer.report()).merged, 1);
    assert.equal(observer.report().mixedTasks, 1); assert.equal(observer.report().crossoverTasks, 1);
  }
});

test("compact billing retains known-mode observations but invalid identity prevents a price claim", () => {
  const a = assignment(7014), r = receipt(7014);
  const report = evaluateRoutingExperiment([a, r, r, { ...r, billing_mode: undefined }, { ...r, billing_mode: "invalid" }], epoch, "2026-10-12");
  assert.equal(armOf(evaluateRoutingExperiment([a, r, r], epoch, "2026-10-12")).meanCashCostUsd, 2);
  for (const rows of [[a, r, { ...r, billing_mode: "invalid" }], [a, { ...r, billing_mode: "invalid" }, r]]) {
    const unknown = armOf(evaluateRoutingExperiment(rows, epoch, "2026-10-12"));
    assert.equal(unknown.meanCashCostUsd, null); assert.equal(unknown.costMissingAssignments, 1);
    assert.equal(unknown.executionEffortScope.invalidIdentityAssignments, 1);
  }
  assert.equal(armOf(report).meanCashCostUsd, null); assert.equal(armOf(report).costMissingAssignments, 1);
  assert.equal(report.evidence!.billing.conflicts, 0); assert.equal(report.evidence!.billing.invalidObservations, 2);
  const missing = { ...r }; delete (missing as { billing_mode?: string }).billing_mode;
  assert.equal(evaluateRoutingExperiment([a, missing, r], epoch, "2026-10-12").evidence!.billing.missingObservations, 1);
});

test("compact billing quality joins only actual trial assignments while retaining pending corpus damage", () => {
  const observer = routingExperimentObserver(epoch, "2026-10-12");
  observer.observe(receipt(7020, "api")); observer.observe(receipt(7020, "subscription"));
  observer.observe(assignment(7021)); observer.observe(receipt(7021));
  let report = observer.report(); assert.equal(report.evidence!.billing.conflicts, 0);
  assert.equal(report.evidence!.receiptCorpusBilling.conflicts, 1); assert.equal(report.evidence!.state, "observed");
  observer.observe(assignment(7020)); report = observer.report();
  assert.equal(report.evidence!.billing.conflicts, 1); assert.equal(report.evidence!.state, "observed-partial");
  assert.equal(armOf(report).costMissingAssignments, 1);
});

test("compact observer independently reports bounded task assignment receipt merge and fix omissions", () => {
  const a = assignment(7015), b = assignment(7016), c = { ...a, worker_assignment: { ...a.worker_assignment, id: "extra-assignment" } };
  for (const [scope, rows] of [
    ["tasks", [a, b]], ["assignments", [a, c]], ["receipts", [receipt(7016), receipt(7015), a]],
    ["merges", [a, { ts: "2026-10-12", step: "verdict.merged", task_id: a.task_id }, { ts: "2026-10-12", step: "verdict.merged", task_id: b.task_id }]],
    ["fixTimes", [a, { ts: "2026-10-12T11:00:00Z", step: "fix.dispatch", task_id: a.task_id }, { ts: "2026-10-12T11:01:00Z", step: "fix.dispatch", task_id: a.task_id }]],
  ] as const) {
    const observer = routingExperimentObserver(epoch, "2026-10-12", 1); rows.forEach(observer.observe);
    const report = observer.report(); assert.equal(report.evidence!.state, "observed-partial");
    assert.equal(report.evidence!.omitted[scope], 1); assert.equal(report.sufficient, false);
    if (scope === "receipts") assert.equal(armOf(report).nonStarterAssignments, null, "unretained receipt is not a measured nonstarter");
    if (scope === "merges") assert.equal(armOf(report).mergeRate, null);
    if (scope === "fixTimes") assert.equal(armOf(report).meanFixDispatches, null);
  }
});

test("compact observer assignment identity conflicts stay unavailable without guessed receipt credit", () => {
  const a = assignment(7017), b = assignment(7018); b.worker_assignment.id = a.worker_assignment.id;
  for (const rows of [[a, b, a], [b, a, b]]) {
    const report = evaluateRoutingExperiment([...rows, receipt(7017)], epoch, "2026-10-12");
    assert.equal(report.assignments, 1); assert.equal(report.evidence!.assignmentConflicts, 1);
    assert.equal(report.evidence!.state, "observed-partial"); assert.equal(armOf(report).receiptCoverage.assignments, 0);
  }
});

test("compact observer rejects invalid bounds and reports oversized evidence without retaining payloads", () => {
  for (const bound of [0, -1, 100001, 1.1, NaN]) assert.throws(() => routingExperimentObserver(epoch, "2026-10-12", bound));
  const a = assignment(7019), observer = routingExperimentObserver(epoch, "2026-10-12");
  observer.observe({ ...a, ts: "x".repeat(81) }); observer.observe({ ...a, task_id: "x".repeat(513) });
  observer.observe({ ...receipt(7019), selection_assignment_id: "x".repeat(513) });
  observer.observe({ ...a, worker_assignment: { ...a.worker_assignment, id: "x".repeat(513) } });
  observer.observe({ ...a, worker_assignment: { ...a.worker_assignment, routing: { ...a.worker_assignment.routing,
    experiment: { assignedArm: "unknown", crossover: false } } } });
  assert.equal(observer.report().evidence!.omitted.oversized, 5); assert.equal(observer.report().assignments, 0);
});
