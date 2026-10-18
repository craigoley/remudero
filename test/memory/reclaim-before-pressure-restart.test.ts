import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  createDaemonMemoryGovernor, createDaemonSlackReclaimer, installDaemonSlackReclaimer,
  installedDaemonSlackReclaimer, reclaimBeforeMemoryRestart,
  type DaemonMemoryReading, type DaemonSlackReclaimer,
} from "#src/lib/daemon-memory-policy.js";
import { runDaemon } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import { withTempDir } from "#src/lib/tmp.js";

const BUDGET = 2048 * 1048576;
const reading = (share: number): DaemonMemoryReading => ({
  rss_bytes: BUDGET * share, swap_bytes: 0, budget_bytes: BUDGET, budget_source: "memory.high",
});
function fixture() {
  let current = reading(0.25), reads = 0, collections = 0;
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  const governor = createDaemonMemoryGovernor({ read: () => { reads++; return current; }, setFlags: () => {} });
  governor.step();
  current = reading(0.52);
  governor.step();
  const due = governor.step();
  assert.equal(due.tier, "restart");
  const reclaimer = (collect: () => void) => createDaemonSlackReclaimer({
    collect: () => { collections++; collect(); }, setFlags: () => {},
    inForcePercent: () => governor.inForcePercent!(),
    snapshot: () => ({ rss_bytes: current.rss_bytes, swap_bytes: current.swap_bytes,
      heap_used_bytes: 0.2 * BUDGET, heap_physical_bytes: 0.25 * BUDGET,
      external_bytes: 0, heap_size_limit_bytes: 4 * BUDGET }),
  });
  return { governor, due, rows, reclaimer, set: (value: DaemonMemoryReading) => { current = value; },
    reads: () => reads, collections: () => collections,
    log: (step: string, fields: Record<string, unknown>) => rows.push({ step, fields }) };
}
function installed(t: TestContext, reclaimer: DaemonSlackReclaimer | undefined) {
  const prior = installedDaemonSlackReclaimer();
  installDaemonSlackReclaimer(reclaimer);
  t.after(() => installDaemonSlackReclaimer(prior));
}

test("a pressure restart first reclaims once and continues only on measured relief", () => {
  const f = fixture();
  const result = reclaimBeforeMemoryRestart(f.due, f.governor, f.log, f.reclaimer(() => f.set(reading(0.28))));
  assert.equal(result.tier, "clear");
  assert.equal(result.share, 0.28);
  assert.equal(f.collections(), 1);
  assert.equal(f.reads(), 4);
  assert.equal(f.rows[0].step, "daemon.memory_restart_reclaim");
  assert.deepEqual(f.rows[0].fields, { outcome: "reclaimed", recheck: "measured", reason: undefined,
    prior_share: 0.52, share: 0.28, budget_bytes: BUDGET, budget_source: "memory.high", relieved: true });
});

test("pressure remaining after a reclaim still restarts without retrying the collection", () => {
  const f = fixture();
  const result = reclaimBeforeMemoryRestart(f.due, f.governor, f.log, f.reclaimer(() => {}));
  assert.equal(result.tier, "restart");
  assert.equal(result.share, 0.52);
  assert.equal(f.collections(), 1);
  assert.equal(f.rows[0].fields.relieved, false);
});

test("a paced reclaim does not manufacture a lower reading or retry the collector", () => {
  const f = fixture(), r = f.reclaimer(() => {});
  r.reclaim();
  assert.equal(reclaimBeforeMemoryRestart(f.due, f.governor, f.log, r), f.due);
  assert.equal(f.collections(), 1);
  assert.equal(f.reads(), 3);
  assert.equal(f.rows[0].fields.outcome, "paced");
  assert.match(String(f.rows[0].fields.reason), /freed nothing above the noise/);
});

test("a failed real reclaimer retains the original restart and its refusal reason", () => {
  const f = fixture();
  const result = reclaimBeforeMemoryRestart(f.due, f.governor, f.log, f.reclaimer(() => { throw Error("collector refused"); }));
  assert.equal(result, f.due);
  assert.equal(f.rows[0].fields.outcome, "unavailable");
  assert.equal(f.rows[0].fields.reason, "collector refused");
  assert.equal(f.rows[0].fields.relieved, false);
});

test("a throwing reclaim or post-reclaim reader keeps the pressure restart", () => {
  for (const where of ["reclaim", "read"] as const) {
    const f = fixture();
    const r = where === "reclaim" ? createDaemonSlackReclaimer({ snapshot: () => { throw Error("snapshot refused"); } }) : f.reclaimer(() => {});
    const g = where === "read" ? { step: () => { throw Error("read refused"); } } : f.governor;
    assert.equal(reclaimBeforeMemoryRestart(f.due, g, f.log, r), f.due);
    assert.equal(f.rows[0].fields.outcome, "unavailable");
    assert.equal(f.rows[0].fields.relieved, false);
    assert.equal(f.rows[0].fields.recheck, where === "read" ? "unavailable" : "not-run");
  }
});

test("an incomplete or changed-budget recheck never averts a pressure restart", () => {
  const missingSwap = { ...reading(0.28), swap_bytes: undefined };
  for (const incomplete of [
    { ...reading(0.28), budget_bytes: undefined }, missingSwap,
    { ...reading(0.28), budget_bytes: BUDGET * 2 },
    { ...reading(0.28), budget_source: "memory.max" as const },
    { ...reading(0.28), rss_bytes: NaN }, { ...reading(0.28), rss_bytes: 0 },
    { ...reading(0.28), swap_bytes: NaN }, { ...reading(0.28), swap_bytes: -1 },
  ]) {
    const f = fixture();
    assert.equal(reclaimBeforeMemoryRestart(f.due, f.governor, f.log, f.reclaimer(() => f.set(incomplete))), f.due);
    assert.equal(f.rows[0].fields.recheck, "unavailable");
    assert.equal(f.rows[0].fields.relieved, false);
  }
});

test("no installed reclaimer leaves the original pressure decision unchanged", t => {
  installed(t, undefined);
  const f = fixture();
  assert.equal(reclaimBeforeMemoryRestart(f.due, f.governor, f.log), f.due);
  assert.equal(f.rows[0].fields.reason, "no daemon slack reclaimer installed");
});

test("non-restart decisions never collect, including the existing futile-restart hold", () => {
  const f = fixture();
  const r = f.reclaimer(() => { throw Error("must not collect"); });
  for (const current of [reading(0.25), reading(0.4), reading(0.54)]) {
    const g = createDaemonMemoryGovernor({ read: () => current, setFlags: () => {}, heapUsed: () => 0.2 * BUDGET });
    const step = g.step();
    assert.notEqual(step.tier, "restart");
    assert.equal(reclaimBeforeMemoryRestart(step, g, f.log, r), step);
  }
  assert.equal(f.collections(), 0);
  assert.deepEqual(f.rows, []);
});

test("the installed production reclaimer runs its real collector without inventing relief", t => {
  const f = fixture();
  const records: string[] = [];
  installed(t, createDaemonSlackReclaimer({ inForcePercent: () => f.governor.inForcePercent!(),
    log: record => records.push(record.outcome) }));
  const result = reclaimBeforeMemoryRestart(f.due, f.governor, f.log);
  assert.deepEqual(records, ["reclaimed"], "the real default full collection and snapshot ran");
  assert.equal(result.tier, "restart", "a collector receipt is not evidence that this governor's reading fell");
  assert.equal(f.rows[0].fields.recheck, "measured");
  assert.equal(f.rows[0].fields.relieved, false);
});

test("the daemon uses measured reclaim relief before its tick-boundary restart", async t => {
  await withTempDir("memory-reclaim-boundary", async dir => {
    writeFileSync(join(dir, "tasks.yaml"), "[]\n");
    let calls = 0, relieved = false;
    const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
    const governor = createDaemonMemoryGovernor({ read: () => {
      calls++;
      return reading(calls === 1 ? 0.25 : relieved ? 0.28 : 0.52);
    }, setFlags: () => {} });
    installed(t, createDaemonSlackReclaimer({ collect: () => { relieved = true; }, setFlags: () => {},
      snapshot: () => ({ rss_bytes: (relieved ? 0.28 : 0.52) * BUDGET, swap_bytes: 0,
        heap_used_bytes: 0.2 * BUDGET, heap_physical_bytes: 0.25 * BUDGET, external_bytes: 0, heap_size_limit_bytes: 4 * BUDGET }) }));
    const summary = await runDaemon(loadPlan(join(dir, "tasks.yaml")), {
      refreshMerged: () => () => false, runOne: async () => { throw Error("empty plan"); },
      checkStop: () => calls >= 4 ? "fixture complete" : undefined, sleep: async () => {},
      memoryGovernor: governor, heapStatistics: () => ({ used_heap_size: 0.2 * BUDGET, heap_size_limit: 4 * BUDGET }),
      log: (step, fields = {}) => rows.push({ step, fields }),
    }, { pollIntervalMs: 1 });
    assert.equal(summary.stopReason, "stopped");
    assert.equal(rows.some(r => r.step === "daemon.heap_pressure_exit"), false);
    assert.equal(rows.find(r => r.step === "daemon.memory_restart_reclaim")?.fields.relieved, true);
  });
});
