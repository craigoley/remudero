import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { createIndexedLifetimeAccounting, tallyAuditedLifetimeDispatches } from "#src/lib/lifetime-identity-index.js";
import { buildLedgerIndex } from "#src/lib/status.js";

type Row = Record<string, unknown>;
const now = Date.parse("2026-11-17T22:00:00Z");
const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const yesterday = at(-24 * 60 * 60_000);

function accountingFor(t: TestContext, rows: readonly Row[] = []) {
  const accounting = createIndexedLifetimeAccounting(1_000);
  t.after(() => accounting.close());
  for (const row of rows) {
    const identity = row.step === "run.start" ? `${row.task_id}\u0000${row.run_id}` : undefined;
    accounting.record(row, identity, false);
  }
  assert.equal(accounting.unavailableReason(), undefined);
  return accounting;
}

test("W1-T13527 criterion 1: 500 candidates share the clock and task buckets of a 10,000-row pass", (t) => {
  const tasks = Array.from({ length: 500 }, (_, i) => `W1-T${i + 1}`);
  const ts = at(0);
  const tsReads = new Uint32Array(10_000);
  let rowReads = 0;
  const rows = new Proxy(Array.from(tsReads, (_, i) => ({
    task_id: tasks[i % tasks.length],
    step: "worker.progress",
    get ts() { tsReads[i] += 1; return ts; },
  })), {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) rowReads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const index = buildLedgerIndex(rows);
  assert.equal(rowReads, rows.length, "the pass actually indexed every row once");
  assert.ok(tsReads.every((reads) => reads > 0), "the clock was read from every row");
  const accounting = accountingFor(t);
  for (const task of tasks) {
    assert.deepEqual(tallyAuditedLifetimeDispatches(accounting, task, rows, index), { starts: 0, capacityBlocked: 0 });
  }
  assert.ok(tsReads.every((reads) => reads <= 2), "no row's timestamp is read more than twice");
  assert.equal(rowReads, rows.length, "neither the clock nor the visible run IDs rescan the live rows");
});

test("W1-T13527 criterion 2: an appended row array or a missing index gets the full-scan tally", (t) => {
  const task = "W1-T1";
  const start = { task_id: task, run_id: "old", step: "run.start", ts: yesterday };
  const snapshotRows = [{ task_id: "OTHER", step: "worker.progress", ts: start.ts }];
  const index = buildLedgerIndex(snapshotRows);
  const rows = [...snapshotRows, start, { task_id: "OTHER", step: "worker.progress", ts: at(0) }];
  const stale = accountingFor(t, [start]);
  const unindexed = accountingFor(t, [start]);
  assert.deepEqual(tallyAuditedLifetimeDispatches(stale, task, snapshotRows, index), { starts: 1, capacityBlocked: 0 });
  const expected = tallyAuditedLifetimeDispatches(unindexed, task, rows);
  assert.deepEqual(expected, { starts: 0, capacityBlocked: 0 }, "the appended rows prove the old start is an orphan");
  assert.deepEqual(tallyAuditedLifetimeDispatches(stale, task, rows, index), expected);
  const foreignIndex = buildLedgerIndex(rows.map((row) => ({ ...row, task_id: "OTHER" })));
  assert.deepEqual(tallyAuditedLifetimeDispatches(accountingFor(t, [start]), task, rows, foreignIndex), expected,
    "matching row counts do not make a foreign index usable");

  stale.record({ task_id: task, step: "run.start" }, undefined, false);
  assert.equal(stale.unavailableReason(), "start_identity_missing");
  assert.equal(tallyAuditedLifetimeDispatches(stale, task, rows, buildLedgerIndex(rows)), undefined);
});

test("W1-T13527 criterion 3: indexed and full-scan tallies agree for each candidate", (t) => {
  const orphan = { task_id: "W1-T1", run_id: "orphan", step: "run.start", ts: yesterday };
  const blocked = { task_id: "W1-T2", run_id: "blocked", step: "run.start", ts: at(-2_000) };
  const receipt = { task: "W1-T2", step: "daemon.spawn_infra_blocked", ts: at(-1_000) };
  const young = { task_id: "W1-T3", run_id: "young", step: "run.start", ts: at(0) };
  const rows = [orphan, blocked, receipt, young];
  const indexed = accountingFor(t, rows);
  const unindexed = accountingFor(t, rows);
  const expected = [
    ["W1-T1", { starts: 0, capacityBlocked: 0 }],
    ["W1-T2", { starts: 1, capacityBlocked: 1 }],
    ["W1-T3", { starts: 1, capacityBlocked: 0 }],
    ["W1-T4", { starts: 0, capacityBlocked: 0 }],
  ] as const;

  // After rotation the orphan appears only in `task`, so it stays uncharged.
  const rotatedRows = [blocked, receipt, young, { task: "W1-T1", run_id: "orphan", step: "worker.progress", ts: at(1) }];
  for (const live of [rows, rotatedRows]) {
    const index = buildLedgerIndex(live);
    for (const [task, tally] of expected) {
      assert.deepEqual(tallyAuditedLifetimeDispatches(unindexed, task, live), tally, task);
      assert.deepEqual(tallyAuditedLifetimeDispatches(indexed, task, live, index), tally, task);
    }
  }
});
