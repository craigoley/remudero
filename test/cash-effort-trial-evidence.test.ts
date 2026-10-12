import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { evaluateRoutingExperiment, ROUTING_EXPERIMENTS } from "../src/lib/routing-experiments.js";

const epoch = ROUTING_EXPERIMENTS.find(item => item.id === "sol61-vs-sonnet55")!;
function assignment(id: string) {
  return { ts: "2026-10-08T10:00:00Z", step: "worker.assignment", task_id: `W1-T${id}`,
    worker_assignment: { id: `a-${id}`, selected: { provider: "codex" }, routing: {
      decision: { ab: epoch.id, considered: [{ provider: "claude", model: "claude-sonnet-5-5" }, { provider: "codex", model: "gpt-6.1-sol" }] },
      experiment: { assignedArm: "sol61", crossover: false },
    } } };
}
function effort(value: string | null = "high", requests = 1, transport = "responses", state = "parameter-present") {
  return { provenance: "adapter-fetch-call", transport,
    parameter: transport === "responses" ? "reasoning.effort" : transport === "chat-completions" ? "reasoning_effort" : "output_config.effort",
    state, value, providerEffectiveEffort: null, requests };
}
function receipt(id: string, value: unknown, step = "worker.attempt") {
  return { ts: "2026-10-08T10:01:00Z", step, selection_assignment_id: `a-${id}`, success: true,
    served_model: "gpt-6.1-sol", effort: "high", request_efforts: value };
}

test("daily trial effort evidence counts matching attempt and verdict snapshots once and keeps missing evidence unknown", () => {
  const rows = [assignment("1"), assignment("2"), assignment("3"), assignment("4"),
    receipt("1", [effort("high", 2)]), receipt("1", [effort("high", 2)], "verdict"),
    receipt("2", [effort(null, 3, "chat-completions", "parameter-omitted")]), receipt("3", []),
    { ts: "2026-10-08T10:01:00Z", step: "worker.attempt", selection_assignment_id: "a-4", effort: "high" }];
  const report = evaluateRoutingExperiment(rows, epoch, "2026-10-08");
  const observed = report.arms.find(arm => arm.arm === "sol61")!.requestEffortEvidence;
  assert.equal(observed.state, "partial");
  assert.equal(observed.assignments, 4);
  assert.equal(observed.reportedAssignments, 3);
  assert.equal(observed.missingAssignments, 1);
  assert.equal(observed.noRequestAssignments, 1);
  assert.equal(observed.attemptedRequests, 5);
  assert.equal(observed.parameterPresentRequests, 2);
  assert.equal(observed.parameterOmittedRequests, 3);
  assert.equal(observed.parameterUnreadableRequests, 0);
  assert.equal(observed.providerEffectiveEffort, null);
  assert.equal(report.sufficient, false);
  const noEvidence = evaluateRoutingExperiment([assignment("1")], epoch, "2026-10-08").arms.find(arm => arm.arm === "sol61")!.requestEffortEvidence;
  assert.equal(noEvidence.state, "unavailable");
  assert.equal(noEvidence.attemptedRequests, null);
});

test("trial effort evidence refuses invalid and conflicting receipts instead of selecting the latest label", () => {
  const rows = [assignment("1"), assignment("2"), assignment("3"), assignment("4"),
    receipt("1", [effort("high")]), receipt("1", [effort("low")], "verdict"),
    receipt("1", [effort("high")], "worker.done"), receipt("2", [{ ...effort(), requests: -1 }]),
    receipt("3", [effort(null, 1, "foundry-messages", "parameter-unreadable")]), receipt("4", [])];
  const result = evaluateRoutingExperiment(rows, epoch, "2026-10-08").arms.find(arm => arm.arm === "sol61")!.requestEffortEvidence;
  assert.equal(result.conflictingAssignments, 1);
  assert.equal(result.invalidAssignments, 1);
  assert.equal(result.reportedAssignments, 2);
  assert.equal(result.attemptedRequests, 1);
  assert.equal(result.parameterUnreadableRequests, 1);
  assert.equal(result.noRequestAssignments, 1);
});

test("persisted effort tuples reject malformed shape, invented defaults, duplicates and numeric overflow", async () => {
  const { readCashRequestEfforts, summarizeCashRequestEfforts } = await import("../src/lib/cash-request-effort.js");
  assert.deepEqual(readCashRequestEfforts(undefined), { state: "unavailable", reason: "missing" });
  for (const value of [null, {}, [null], Array(28).fill(effort()), [{ ...effort(), provenance: "selected-label" }],
    [{ ...effort(), providerEffectiveEffort: "high" }], [{ ...effort(), transport: { toString: null } }],
    [{ ...effort(), requests: 0 }], [{ ...effort(), requests: 0.5 }], [{ ...effort(), requests: Infinity }],
    [{ ...effort(), parameter: "wrong" }], [effort("made-up")], [effort(null)], [effort("high", 1, "responses", "parameter-omitted")],
    [effort(null, 1, "responses", "wrong")], [effort(), effort()], [effort("high", Number.MAX_SAFE_INTEGER), effort("low", 1)]]) {
    assert.deepEqual(readCashRequestEfforts(value), { state: "unavailable", reason: "invalid" });
  }
  const valid = readCashRequestEfforts([effort("high", 1, "chat-completions"), effort(null, 2, "foundry-messages", "parameter-omitted")]);
  assert.equal(valid.state, "observed");
  const overflow = summarizeCashRequestEfforts([readCashRequestEfforts([effort("high", Number.MAX_SAFE_INTEGER)]), readCashRequestEfforts([effort("high", 1)])]);
  assert.equal(overflow.state, "unavailable");
  assert.equal(overflow.countsOverflow, true);
  assert.equal(overflow.attemptedRequests, null);
  assert.equal(overflow.parameters, null);
});

test("the existing daily producer persists transmitted effort evidence without promoting a comparison", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-daily-cash-effort-"));
  try {
    const stateDir = join(dir, "state"), outDir = join(dir, "out");
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, "ledger.ndjson"), [assignment("1"), receipt("1", [effort(null, 2, "chat-completions", "parameter-omitted")])]
      .map(row => JSON.stringify(row)).join("\n") + "\n");
    const script = join(import.meta.dirname, "..", "scripts", "private-routing-daily-review.mjs");
    const { dailyRoutingReview } = await import(pathToFileURL(script).href);
    const result = await dailyRoutingReview({ sources: [{ label: "core", stateDir }], outDir, asOf: "2026-10-08T12:00:00Z" });
    const persisted = JSON.parse(readFileSync(join(outDir, "latest.json"), "utf8"));
    const arm = persisted.sources[0].reports.find((report: { id: string }) => report.id === epoch.id).arms.find((item: { arm: string }) => item.arm === "sol61");
    assert.equal(arm.requestEffortEvidence.state, "observed");
    assert.equal(arm.requestEffortEvidence.attemptedRequests, 2);
    assert.equal(arm.requestEffortEvidence.parameterOmittedRequests, 2);
    assert.equal(arm.requestEffortEvidence.providerEffectiveEffort, null);
    assert.equal(result.snapshot.comparativeClaims, "none");
    assert.equal(result.snapshot.routingChanged, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
