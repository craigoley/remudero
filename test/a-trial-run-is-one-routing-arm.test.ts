import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { accumulateUsageLine, buildUsageProjection, usageTelemetryState, reasonPreview } from "../src/lib/usage-telemetry.js";
import { buildAnalyticsRoute, deriveAnalyticsSnapshot, deriveAnalyticsSnapshotFromCheckpointedLedger } from "../src/lib/analytics-route.js";
import { fixedClock } from "../src/lib/clock.js";
import { writeLedger } from "./helpers/ledger-fixture.js";
const now = "2026-10-02T12:00:00Z";
const reason = "trial spend evidence unavailable: ledger source unreadable or incomplete; preserve the complete explanation";
const assignment = (id: string, trialReason = reason) => ({ step: "worker.assignment", ts: "2026-10-02T10:00:00Z", run_id: id,
  worker_assignment: { id, selected: { provider: "cash", model: "gpt-6-luna" }, routing: { mode: "cash", decision: {
    trial: "inbox-bakeoff", trialArm: "cash", trialReason,
  } } } });

test("W1-T5176: a trial run appears as one arm row with its reason as metadata", () => {
  const state = usageTelemetryState();
  accumulateUsageLine(state, assignment("a"));
  accumulateUsageLine(state, { step: "verdict", run_id: "a", ts: "2026-10-02T11:00:00Z", success: true, total_cost_usd: 0.1 });
  const projection = buildUsageProjection(state, now);
  assert.equal(projection.version, "usage-v2");
  assert.equal(projection.routing.experiments.length, 1);
  const arm = projection.routing.experiments[0]!;
  assert.equal(arm.runs, 1);
  assert.equal(arm.terminals, 1);
  assert.equal(arm.trialId, "inbox-bakeoff");
  assert.equal(arm.trialArm, "cash");
  assert.equal(arm.reasonFull, reason);
  assert.equal(arm.reasonState, "observed");
  assert.equal(buildUsageProjection(state, now, undefined, "usage-v1").routing.experiments.length, 3, "legacy consumers retain their declared schema");
});

test("W1-T5176: a long reason is never cut mid-word", () => {
  const state = usageTelemetryState();
  accumulateUsageLine(state, assignment("a"));
  const arm = buildUsageProjection(state, now).routing.experiments[0]!;
  assert.ok(arm.reason!.endsWith("…"));
  assert.ok(reason.startsWith(arm.reason!.slice(0, -1)));
  assert.match(reason.slice(arm.reason!.length - 1), /^\s/);
  assert.equal(arm.reasonFull, reason);
  assert.equal(reasonPreview("short"), "short");
  assert.equal(reasonPreview("x".repeat(200)), "Reason available in full details…");
});

test("unrelated markers remain independent and an oversized reason stays explicitly unavailable", () => {
  const row = assignment("a", "x".repeat(4097));
  const state = usageTelemetryState();
  accumulateUsageLine(state, { ...row, worker_assignment: { ...row.worker_assignment, routing: { ...row.worker_assignment.routing,
    decision: { ...row.worker_assignment.routing.decision, ab: "different-study" } } } });
  const arms = buildUsageProjection(state, now).routing.experiments;
  assert.equal(arms.length, 2);
  assert.equal(arms.find(a => a.marker === "ab")!.value, "different-study");
  assert.equal(arms.find(a => a.marker === "trial")!.reasonState, "too-large");
  assert.equal(arms.find(a => a.marker === "trial")!.reasonFull, undefined);
});

test("usage routes keep v1 compatible and v2 grouped, and legacy checkpoints are rescanned", async () => {
  const rows = [assignment("a")];
  const snapshot = deriveAnalyticsSnapshot(rows, now);
  const route = buildAnalyticsRoute({ currentSnapshot: () => snapshot });
  for (const [version, count] of [["usage-v1", 3], ["usage-v2", 1]] as const) {
    let body = "";
    await route.handler({ url: `/v1/analytics?projectionVersion=${version}` } as never, { writeHead: () => {}, end: (s: string) => { body = s; } } as never, { params: {} });
    assert.equal(JSON.parse(body).version, version);
    assert.equal(JSON.parse(body).routing.experiments.length, count);
  }
  const fixture = writeLedger(rows), clock = fixedClock(Date.parse(now));
  try {
    const first = await deriveAnalyticsSnapshotFromCheckpointedLedger(fixture.dir, clock);
    const legacy = structuredClone(first.checkpoint);
    delete legacy.state.usage!.trialAccountingVersion;
    for (const run of legacy.state.usage!.markedRuns!) delete run.trial;
    const refreshed = await deriveAnalyticsSnapshotFromCheckpointedLedger(fixture.dir, clock, undefined, legacy);
    assert.equal(refreshed.snapshot.usage!.routing.experiments[0]!.reasonFull, reason);
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("latest trial reason follows assignment time across reordered archives", () => {
  const state = usageTelemetryState();
  accumulateUsageLine(state, { ...assignment("new", "Newest reason"), ts: "2026-10-02T11:00:00Z" });
  accumulateUsageLine(state, assignment("old", "Older reason"));
  const arm = buildUsageProjection(state, now).routing.experiments[0]!;
  assert.equal(arm.reasonFull, "Newest reason");
  assert.equal(arm.runs, 2);
});
