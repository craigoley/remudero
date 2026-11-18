/**
 * W1-T13608 — THE DISPATCH LIFETIME TALLY READS THE LEDGER CLOCK ONCE PER SNAPSHOT.
 *
 * Each dispatch decision asks the lifetime tally for each candidate task. lifetimeAccounting().tallyFor called
 * orphanedRunIds with no index, so latestLedgerTsMs read every ledger row for the clock, and then filtered every
 * row again for the task's run ids: two full passes per candidate task, on the daemon loop. It now reads the clock
 * and the task's rows from the snapshot's LedgerIndex when that index was built over the same rows.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_LIVENESS_BOUND_MS } from "#src/lib/non-worker-verdict.js";
import { buildLedgerIndex, hasRepeatedTaskAttributableLifetimeDispatches, ledgerIndexBuildCount, readLedgerSnapshot, type LedgerSnapshot } from "#src/lib/status.js";
import { auditedLifetimeTalliesFromArchives, breakerGateFor, type LifetimeHistory } from "#test/helpers/run-task-test.js"; // the shared run-task seam

type Row = Record<string, unknown>;
const NOW = Date.parse("2026-11-18T04:00:00.000Z");
const at = (ms: number) => new Date(ms).toISOString();
const encode = (rows: readonly Row[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-lifetime-clock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(join(stateDir, "ledger.2026-11-17T00-00-00-000Z.ndjson"), encode([{ task_id: "OTHER", run_id: "control", step: "run.start" }]));
  writeFileSync(ledgerPath, "");
  // a rename gives the live ledger a new inode, as a rotation does.
  const live = (rows: readonly Row[]) => {
    writeFileSync(`${ledgerPath}.next`, encode(rows));
    renameSync(`${ledgerPath}.next`, ledgerPath);
  };
  const history = async (): Promise<LifetimeHistory> => {
    const audit = await auditedLifetimeTalliesFromArchives(stateDir, ledgerPath);
    assert.equal(audit.unavailableReason, undefined);
    assert.ok(audit.history);
    return audit.history;
  };
  return { ledgerPath, live, history };
}

/** The snapshot as today's unindexed path took it: its rows, never its index. */
const unindexed = (snap: LedgerSnapshot) => ({ identity: snap.identity, content: snap.content, lines: snap.lines });

test("W1-T13608 criterion 1: 50 tallies over one 20,000-row snapshot make no full pass and build no index", async (t) => {
  const f = fixture(t);
  const history = await f.history();
  const tasks = Array.from({ length: 50 }, (_, i) => `W1-T${9000 + i}`);
  const rows: Row[] = [];
  for (let i = 0; i < 20_000; i++) {
    const task = tasks[i % tasks.length]!;
    rows.push({ ts: at(NOW - (20_000 - i) * 1000), task_id: task, run_id: `${task}-r${i % 7}`, step: i % 3 === 0 ? "run.start" : "worker.progress" });
  }
  let reads = 0;
  const counted = new Proxy(rows, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const snap = { identity: undefined, content: "", lines: counted as unknown as LedgerSnapshot["lines"], index: buildLedgerIndex(counted) };
  reads = 0;
  const builds = ledgerIndexBuildCount();
  for (const task of tasks) assert.ok(history.tallyFor(task, snap), `${task} has a tally`);
  assert.ok(reads < rows.length, `50 tallies read ${reads} rows; one pass is ${rows.length}`);
  assert.equal(ledgerIndexBuildCount(), builds, "no new LedgerIndex is built");
});

/** Orphans, live runs, verdicts, other tasks, and a row that names the task only in `task`. */
function mixedRows(withTs: boolean): Row[] {
  const old = NOW - 2 * DEFAULT_LIVENESS_BOUND_MS;
  const ts = (ms: number) => (withTs ? { ts: at(ms) } : {});
  return [
    { ...ts(old), task_id: "W1-TA", run_id: "a-orphan", step: "run.start" },
    { ...ts(old + 1000), task_id: "W1-TA", run_id: "a-orphan-2", step: "run.start" },
    { ...ts(NOW - 60_000), task_id: "W1-TA", run_id: "a-live", step: "run.start" },
    { ...ts(old), task_id: "W1-TB", run_id: "b-done", step: "run.start" },
    { ...ts(old + 5000), task_id: "W1-TB", run_id: "b-done", step: "verdict", verdict: "failed", reason: "worker failure" },
    { ...ts(NOW - 30_000), task_id: "W1-TB", run_id: "b-live", step: "run.start" },
    { ...ts(old), task_id: "W1-TC", run_id: "c-only", step: "run.start" },
    { ...ts(old + 2000), task: "W1-TC", step: "daemon.spawn_infra_blocked" },
    { ...ts(NOW - 10_000), task_id: "W1-TD", run_id: "d-1", step: "run.start" },
    { ...ts(NOW), task_id: "OTHER", run_id: "o-1", step: "run.start" },
  ];
}

const TASKS = ["W1-TA", "W1-TB", "W1-TC", "W1-TD", "OTHER", "W1-T-NO-ROWS"];

test("W1-T13608 criterion 2: the indexed tally equals today's unindexed tally for every task, with and without a ledger clock", async (t) => {
  for (const withTs of [true, false]) {
    const f = fixture(t);
    const indexedHistory = await f.history();
    const plainHistory = await f.history();
    f.live(mixedRows(withTs));
    const first = readLedgerSnapshot(f.ledgerPath);
    for (const task of TASKS) {
      assert.deepEqual(indexedHistory.tallyFor(task, first), plainHistory.tallyFor(task, unindexed(first)), `${task}, ts ${withTs}`);
    }
    // a rotation leaves W1-TC's run named only by a row without task_id; its charge must not move.
    f.live([
      { ...(withTs ? { ts: at(NOW + 1000) } : {}), task: "W1-TC", run_id: "c-only", step: "worker.progress" },
      { ...(withTs ? { ts: at(NOW + 2000) } : {}), task_id: "W1-TD", run_id: "d-2", step: "run.start" },
    ]);
    const second = readLedgerSnapshot(f.ledgerPath);
    for (const task of TASKS) {
      assert.deepEqual(indexedHistory.tallyFor(task, second), plainHistory.tallyFor(task, unindexed(second)), `${task} after rotation, ts ${withTs}`);
    }
    // the orphaned start stays uncharged with a clock, and counted without one; the infra refusal is its own count.
    assert.deepEqual(indexedHistory.tallyFor("W1-TC", second), { starts: withTs ? 0 : 1, capacityBlocked: 1 });
  }
});

test("W1-T13608 criterion 3: an unavailable index still gives undefined and the live fallback; a missing or foreign index scans the rows", async (t) => {
  const f = fixture(t);
  const broken = await f.history();
  f.live([
    { ts: at(NOW - 2000), task_id: "W1-TE", run_id: "e-1", step: "run.start" },
    { ts: at(NOW - 1000), task_id: "W1-TE", run_id: "e-2", step: "run.start" },
    { ts: at(NOW), task_id: "W1-TE", step: "run.start" },
  ]);
  const snap = readLedgerSnapshot(f.ledgerPath);
  assert.equal(broken.tallyFor("W1-TE", snap), undefined, "a run.start without a run id makes the lifetime index unavailable");
  const gate = breakerGateFor(f.ledgerPath, [], broken);
  assert.equal(gate.isLifetimeCapExceeded("W1-TE"), hasRepeatedTaskAttributableLifetimeDispatches(snap.lines, "W1-TE"));
  assert.equal(gate.isLifetimeCapExceeded("W1-TE"), true, "the live-only fallback sees two starts");

  const g = fixture(t);
  const withIndex = await g.history();
  const withoutIndex = await g.history();
  g.live(mixedRows(true));
  const live = readLedgerSnapshot(g.ledgerPath);
  // a foreign index whose clock is far ahead would make every live run an orphan if it were trusted.
  const foreign = buildLedgerIndex([...live.lines, { ts: at(NOW + 10 * DEFAULT_LIVENESS_BOUND_MS), task_id: "OTHER", run_id: "far", step: "run.start" }]);
  for (const task of TASKS) {
    assert.deepEqual(withIndex.tallyFor(task, { ...live, index: foreign }), withoutIndex.tallyFor(task, unindexed(live)), `${task}: a foreign index is not trusted`);
    assert.deepEqual(withIndex.tallyFor(task, unindexed(live)), withoutIndex.tallyFor(task, unindexed(live)), `${task}: no index`);
  }
});
