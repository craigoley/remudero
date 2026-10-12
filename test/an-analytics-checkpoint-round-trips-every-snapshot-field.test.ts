/**
 * The analytics snapshot keeps `abilityMap`, `judgeCalibration`, `workIntegrity`,
 * `benchmarkEvidence`, `cacheReuseTokens`, `usage` and more as NON-ENUMERABLE properties so they
 * stay off the wire. JSON.stringify drops them, so a serve booted from the checkpoint served a
 * snapshot missing every one until its first refresh completed, and on 2026-10-06 none did.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as analytics from "../src/lib/analytics-route.js";
import { fixedClock } from "../src/lib/clock.js";

function ownFields(owner: object): Record<string, unknown> {
  return Object.fromEntries(Object.getOwnPropertyNames(owner).map((name) => [name, (owner as Record<string, unknown>)[name]]));
}

function hiddenNames(owner: object): string[] {
  return Object.getOwnPropertyNames(owner).filter((name) => !Object.prototype.propertyIsEnumerable.call(owner, name)).sort();
}

test("unit test: an analytics checkpoint round-trips every snapshot field, enumerable or not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-analytics-round-trip-"));
  const rows = [
    { ts: "2026-10-06T20:00:00.000Z", task_id: "CLI", run_id: "CLI-1", step: "cli.invoked", verb: "status" },
    { ts: "2026-10-06T20:01:00.000Z", task_id: "W1-T1", run_id: "R1", step: "run.start" },
    { ts: "2026-10-06T20:01:45.000Z", task_id: "W1-T1", run_id: "R1", step: "worker.assignment",
      worker_assignment: { id: "assignment-1", selected: { provider: "claude", model: "claude-sonnet-4" }, routing: { mode: "multi-provider" } } },
    { ts: "2026-10-06T20:03:00.000Z", task_id: "W1-T1", run_id: "R1", step: "verdict", verdict: "merged", lane: "run-task", model: "sonnet",
      selection_assignment_id: "assignment-1", total_cost_usd: 1.5, worker_duration_ms: 2000,
      tokens: { input: 100, output: 20, cacheRead: 300, cacheCreation: 40 } },
  ];
  writeFileSync(join(dir, "ledger.ndjson"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const { snapshot, checkpoint } = await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(dir, fixedClock(Date.parse("2026-10-06T21:00:00.000Z")));
  const hidden = hiddenNames(snapshot);
  for (const name of ["abilityMap", "benchmarkEvidence", "cacheReuseTokens", "judgeCalibration", "workIntegrity"]) {
    assert.ok(hidden.includes(name), `positive control: ${name} is a non-enumerable snapshot field (${hidden.join(", ")})`);
  }

  analytics.writeAnalyticsCheckpoint(dir, checkpoint);
  const restored = analytics.readAnalyticsCheckpoint(dir);
  assert.ok(restored);
  assert.deepEqual(ownFields(restored.snapshot), ownFields(snapshot), "every own field survives, enumerable or not");
  assert.deepEqual(hiddenNames(restored.snapshot), hidden, "and stays off the wire: still non-enumerable");
  assert.deepEqual(ownFields(restored.snapshot.routingTelemetry), ownFields(snapshot.routingTelemetry));
  assert.deepEqual(hiddenNames(restored.snapshot.routingTelemetry), hiddenNames(snapshot.routingTelemetry));
  assert.deepEqual(JSON.parse(JSON.stringify(restored.snapshot)), JSON.parse(JSON.stringify(snapshot)), "the wire shape is unchanged");
  assert.equal("snapshotHidden" in restored, false, "the carrier is not part of the checkpoint a reader sees");

  // The boot path re-attaches the usage projection over the restored fields and then freezes.
  const cache = analytics.createAnalyticsSnapshotCache({ stateDir: dir, schedule: () => ({ unref: () => {}, cancel: () => {} }) });
  assert.deepEqual(cache.current().abilityMap, snapshot.abilityMap, "a serve booted from the checkpoint serves the same ability map");
  assert.deepEqual(cache.current().judgeCalibration, snapshot.judgeCalibration);
  assert.deepEqual(cache.current().workIntegrity, snapshot.workIntegrity);
  assert.deepEqual(cache.current().benchmarkEvidence, snapshot.benchmarkEvidence);
});
