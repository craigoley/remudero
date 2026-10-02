import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { accumulateUsageLine, buildUsageProjection, usageTelemetryState } from "../src/lib/usage-telemetry.js";
import { createAnalyticsSnapshotCache, writeAnalyticsCheckpoint, deriveAnalyticsSnapshot, deriveAnalyticsSnapshotFromCheckpointedLedger } from "../src/lib/analytics-route.js";
import { deriveDayUnpricedRows, checkCostGovernor, DEFAULT_SWEEP_POLICY } from "../src/lib/sweep.js";
import { fixedClock } from "../src/lib/clock.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const now = "2026-10-02T12:00:00Z";
const rows = [undefined, 0, 2, -1, NaN].map((cost, i) => ({
  step: "implement.done", ts: "2026-10-02T11:00:00Z", run_id: `R${i}`, provider: "cash", model: "model-a", lane: "implement",
  ...(cost === undefined ? {} : { total_cost_usd: cost }),
}));

test("W1-T4687: a row with no recorded cost is counted as unpriced, never as zero", () => {
  const state = usageTelemetryState();
  for (const row of rows) accumulateUsageLine(state, row);
  const usage = buildUsageProjection(state, now);
  const window = usage.cash.windows.find((w) => w.name === "today-utc")!;
  assert.equal(window.usd, 2);
  assert.equal(window.rows, 5);
  assert.equal(window.unpricedRows, 3);
  assert.deepEqual(usage.cash.byModel24h, [{ model: "model-a", usd: 2, unpricedRows: 3 }]);
  assert.equal(usage.cash.series[0]!.unpricedRows, 3);
  const analytics = deriveAnalyticsSnapshot(rows, now);
  assert.deepEqual(analytics.costAccounting, { pricedUsd: 2, unpricedRows: 3, state: "uncertain" });
  assert.equal(analytics.workersByLaneModel[0]!.unpricedCostRows, 3);
  assert.equal(analytics.spend.cash.windows[0]!.unpricedRows, 3);
  const history = analytics.timeSeries.find(s => s.id === "cost.modeled.usd")!.points.at(-1)!;
  assert.equal(history.value, 2);
  assert.equal(history.unpricedRows, 3);
  assert.match(history.note!, /uncertain/);
  assert.equal(deriveDayUnpricedRows([...rows, { ...rows[0], step: "verdict" }], Date.parse(now)), 3);
  const governor = checkCostGovernor(2, DEFAULT_SWEEP_POLICY, 3);
  assert.equal(governor.costState, "uncertain");
  assert.equal(governor.unpricedRows, 3);
});

test("a missing trial terminal cost leaves its cost comparison unmeasured and routing uncertainty visible", () => {
  const assignment = { step: "worker.assignment", ts: "2026-10-02T10:00:00Z", run_id: "R1", worker_assignment: {
    id: "a1", selected: { provider: "cash", model: "model-a" }, routing: { mode: "cash", decision: { ab: "trial" } },
  } };
  const verdict = { step: "verdict", ts: "2026-10-02T11:00:00Z", run_id: "R1", selection_assignment_id: "a1", success: true };
  const snapshot = deriveAnalyticsSnapshot([assignment, verdict], now);
  const arm = snapshot.usage!.routing.experiments[0]!;
  assert.equal(arm.unpricedTerminals, 1);
  assert.equal(arm.meanCostPerTerminalUsd, null);
  assert.equal(snapshot.routingTelemetry.buckets[0]!.unpricedCostRows, 1);
  assert.equal(snapshot.routingTelemetry.daily[0]!.unpricedCostRows, 1);
  const free = deriveAnalyticsSnapshot([assignment, { ...verdict, total_cost_usd: 0 }], now).usage!.routing.experiments[0]!;
  assert.equal(free.unpricedTerminals, 0);
  assert.equal(free.meanCostPerTerminalUsd, 0);
});

test("pre-accounting checkpoints are rescanned and new unpriced counts survive resume", async () => {
  const fixture = writeLedger(rows);
  const clock = fixedClock(Date.parse(now));
  try {
    const first = await deriveAnalyticsSnapshotFromCheckpointedLedger(fixture.dir, clock);
    const legacy = structuredClone(first.checkpoint);
    delete legacy.state.usage!.costAccountingVersion;
    legacy.state.unpricedSpendRows = 0;
    writeAnalyticsCheckpoint(fixture.dir, legacy);
    const cold = createAnalyticsSnapshotCache({ stateDir: fixture.dir, clock });
    assert.equal(cold.current().asOf, null, "old totals are withheld until the uncertainty-aware rescan");
    cold.stop();
    const repaired = await deriveAnalyticsSnapshotFromCheckpointedLedger(fixture.dir, clock, undefined, legacy);
    assert.equal(repaired.snapshot.costAccounting!.unpricedRows, 3);
    fixture.append([{ ...rows[0]!, run_id: "R-new" }]);
    const resumed = await deriveAnalyticsSnapshotFromCheckpointedLedger(fixture.dir, clock, undefined, repaired.checkpoint);
    assert.equal(resumed.snapshot.costAccounting!.unpricedRows, 4);
    assert.equal(resumed.snapshot.spend.cash.windows[0]!.unpricedRows, 4);
    assert.equal(resumed.snapshot.usage!.cash.windows[0]!.unpricedRows, 4);
    assert.equal(resumed.snapshot.timeSeries.find(s => s.id === "cost.modeled.usd")!.points.at(-1)!.unpricedRows, 4);
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});
