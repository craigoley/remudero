import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deriveAnalyticsSnapshot, deriveAnalyticsSnapshotFromCheckpointedLedger } from "../src/lib/analytics-route.js";
import { fixedClock } from "../src/lib/clock.js";

const NOW = "2026-10-11T20:20:00.000Z";
const CLOCK = fixedClock(Date.parse(NOW));

function assignment(id: string) {
  return { ts: "2026-10-11T20:00:00.000Z", step: "worker.assignment",
    worker_assignment: { id, selected: { provider: "codex", model: "gpt-5.6-sol" }, routing: { mode: "multi-provider" } } };
}

function terminal(id: string, cost?: unknown) {
  return { ts: "2026-10-11T20:01:00.000Z", step: "verdict", selection_assignment_id: id,
    success: true, model: "gpt-5.6-sol", total_cost_usd: cost };
}

test("routing pricing coverage reports measured zero for positively observed priced receipts", () => {
  const routing = deriveAnalyticsSnapshot([assignment("paid"), terminal("paid", 0.25),
    assignment("free"), terminal("free", 0), assignment("pending")], NOW).routingTelemetry;
  assert.equal(routing.terminalResultsObserved, 2, "positive control: two terminal receipts are actually joined");
  assert.equal(routing.assignmentsWithoutTerminalResult, 1, "an unfinished assignment is not an unpriced terminal");
  assert.equal(routing.buckets[0]?.totalCostUsd, 0.25);
  assert.equal(routing.buckets[0]?.unpricedCostRows, 0);
  assert.equal(routing.daily[0]?.unpricedCostRows, 0);
  assert.equal(routing.daily[0]?.terminalResults, 2);
});

test("routing pricing coverage counts invalid prices once without losing known modeled dollars", () => {
  const rows = [assignment("paid"), terminal("paid", 0.25)];
  for (const [index, price] of [undefined, null, -1, "0.1", Infinity].entries()) {
    rows.push(assignment(`unknown-${index}`), terminal(`unknown-${index}`, price));
  }
  rows.push(terminal("unknown-0"));
  const routing = deriveAnalyticsSnapshot(rows, NOW).routingTelemetry;
  assert.equal(routing.terminalResultsObserved, 6, "duplicate terminal receipts do not double-count");
  assert.equal(routing.buckets[0]?.totalCostUsd, 0.25);
  assert.equal(routing.buckets[0]?.unpricedCostRows, 5);
  assert.equal(routing.daily[0]?.unpricedCostRows, 5);
  assert.deepEqual(deriveAnalyticsSnapshot([], NOW).routingTelemetry.buckets, [], "no corpus is not a zero-priced bucket");
});

test("a checkpoint without routing pricing coverage rebuilds evidence before certifying zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-routing-price-legacy-"));
  const rows = [assignment("paid"), terminal("paid", 0.25), assignment("unknown"), terminal("unknown")];
  writeFileSync(join(dir, "ledger.ndjson"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const first = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, CLOCK);
  const legacy = JSON.parse(JSON.stringify(first.checkpoint)) as typeof first.checkpoint;
  delete legacy.state.routingTelemetry.pricingVersion;
  for (const bucket of legacy.state.routingTelemetry.buckets) delete bucket.unpricedCostRows;
  for (const day of legacy.state.routingTelemetry.days) delete day.unpricedCostRows;
  const rebuilt = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, CLOCK, undefined, legacy);
  assert.ok(rebuilt.scan);
  assert.equal(rebuilt.scan.mode, "full", "unknown checkpoint pricing forces a retained-union rebuild");
  assert.equal(rebuilt.scan.reason, "checkpoint-version");
  assert.equal(rebuilt.snapshot.routingTelemetry.buckets[0]?.unpricedCostRows, 1);
  assert.equal(rebuilt.snapshot.routingTelemetry.daily[0]?.unpricedCostRows, 1);
  assert.equal(rebuilt.checkpoint.state.routingTelemetry.pricingVersion, 1);
});

test("a current checkpoint preserves measured routing pricing coverage across a resumed refresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-routing-price-resume-"));
  const ledger = join(dir, "ledger.ndjson");
  const rows = [assignment("paid"), terminal("paid", 0.25)];
  writeFileSync(ledger, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const first = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, CLOCK);
  assert.equal(first.checkpoint.state.routingTelemetry.pricingVersion, 1);
  assert.equal(first.snapshot.routingTelemetry.buckets[0]?.unpricedCostRows, 0);
  rows.push(assignment("unknown"), terminal("unknown"));
  writeFileSync(ledger, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const resumed = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, CLOCK, undefined, first.checkpoint);
  assert.ok(resumed.scan);
  assert.equal(resumed.scan.mode, "resume");
  assert.equal(resumed.snapshot.routingTelemetry.buckets[0]?.unpricedCostRows, 1);
  assert.equal(resumed.snapshot.routingTelemetry.daily[0]?.unpricedCostRows, 1);
  assert.deepEqual(resumed.snapshot.routingTelemetry,
    (await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, CLOCK)).snapshot.routingTelemetry);
});
