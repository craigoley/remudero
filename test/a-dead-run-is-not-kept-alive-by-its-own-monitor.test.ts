import assert from "node:assert/strict";
import { test } from "node:test";
import { recordRunningLong, RUNNING_LONG_STEP } from "../src/lib/cost-anomaly.js";
import { dispatchesWithoutNewOwnedPr, orphanedRunIds, taskAttributableLifetimeDispatches } from "../src/lib/status.js";
import type { LedgerRecord } from "../src/lib/retro.js";

const TASK = "W1-T4819";
const START = "2026-09-01T00:00:00.000Z";
const LATER = "2026-09-01T02:00:00.000Z";

test("W1-T4819: a run whose only later rows are running_long is an orphan", () => {
  const start = { ts: START, step: "run.start", task_id: TASK, run_id: "dead" };
  const monitorRows = [
    { ts: "2026-09-01T00:45:00.000Z", step: RUNNING_LONG_STEP, task_id: TASK, run_id: "dead" },
    { ts: "2026-09-01T01:00:00.000Z", step: "cost.anomaly", task_id: TASK, run_id: "dead" },
    { ts: "2026-09-01T01:15:00.000Z", step: "worker.stalled", task_id: TASK, run_id: "dead" },
  ];
  const fleetClock = { ts: LATER, step: "run.start", task_id: "W1-OTHER", run_id: "other" };
  const rows = [start, ...monitorRows, fleetClock];

  assert.deepEqual([...orphanedRunIds(rows, TASK)], ["dead"]);
  assert.equal(dispatchesWithoutNewOwnedPr(rows, TASK), 0);
  assert.equal(taskAttributableLifetimeDispatches(rows, TASK), 0);
  assert.deepEqual([...orphanedRunIds(rows, TASK, undefined, { nowMs: Date.parse(START) + 60_000 })], []);

  const withWorkerVerdict = [...rows, { ts: LATER, step: "verdict", task_id: TASK, run_id: "dead", verdict: "no_pr" }];
  assert.deepEqual([...orphanedRunIds(withWorkerVerdict, TASK)], []);
  const withWorkerActivity = [...rows, { ts: LATER, step: "worker.activity", task_id: TASK, run_id: "dead" }];
  assert.deepEqual([...orphanedRunIds(withWorkerActivity, TASK)], [], "a worker event is evidence this run did work");
});

test("W1-T4819: a long run is reported once per threshold crossing", () => {
  const minute = 60_000;
  const base = Date.parse(START);
  const rows: LedgerRecord[] = [];
  for (let i = 0; i < 3; i++) {
    const started = base + i * 20 * minute;
    rows.push(
      { ts: new Date(started).toISOString(), step: "run.start", run_id: `settled-${i}`, task_id: `T-${i}`, task_class: "src" },
      { ts: new Date(started + 10 * minute).toISOString(), step: "verdict", run_id: `settled-${i}`, task_id: `T-${i}`, verdict: "merged" },
    );
  }
  rows.push({ ts: new Date(base + 60 * minute).toISOString(), step: "run.start", run_id: "long", task_id: TASK, task_class: "src" });

  const written: LedgerRecord[] = [];
  const deps = { ledgerPath: "unused", writeLedger: (_path: string, line: LedgerRecord) => { written.push(line); } };
  const policy = { multiplier: 3, minSamples: 3 };
  assert.equal(recordRunningLong(rows, policy, base + 89 * minute, deps).length, 0, "below threshold");
  assert.equal(recordRunningLong(rows, policy, base + 91 * minute, deps).length, 1, "first crossing");
  assert.equal(written.filter((row) => row.step === RUNNING_LONG_STEP).length, 1);

  rows.push({ ...written[0], ts: new Date(base + 91 * minute).toISOString() });
  assert.equal(recordRunningLong(rows, policy, base + 120 * minute, deps).length, 0, "later sweep");

  rows.pop(); // Rotation moved the marker to an archive; the archive union still knows this run.
  assert.equal(recordRunningLong(rows, policy, base + 150 * minute, { ...deps, alreadyReported: new Set(["long"]) }).length, 0);
  assert.equal(written.length, 1);
});
