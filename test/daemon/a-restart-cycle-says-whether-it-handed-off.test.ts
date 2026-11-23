// W1-T14547: daemon.restart_cycle says whether a freshness restart handed off to a ready standby, and on one that did,
// how long the standby's read-only boot took and how long the yield was dark before the successor's first tick.
import assert from "node:assert/strict";
import { test } from "node:test";
import { restartCycleRow } from "#src/lib/restart-cycle.js";

const epoch = Date.parse("2026-11-23T22:00:00.000Z");
const at = (ms: number) => new Date(epoch + ms).toISOString();
type Row = Record<string, unknown>;
const row = (ms: number, step: string, fields: Row = {}): Row => ({ ts: at(ms), step, ...fields });

function cold(): Row[] {
  return [
    row(0, "daemon.boot", { run_id: "old" }),
    row(50, "review.posted", { pr_url: "https://github.com/o/r/pull/9" }),
    row(200, "daemon.freshness_decision", { action: "restart", reason: "upper_age", old_sha: "old", new_sha: "new", stale_since_ms: epoch + 100 }),
    row(300, "daemon.freshness_exit", { phases_ms: { drain: 90, total: 100 } }),
    row(301, "daemon_selfrestart_for_freshness", { old_sha: "old", new_sha: "new", stale_since_ms: epoch + 100 }),
    row(400, "daemon.boot", { run_id: "new" }),
    row(450, "daemon.tick", {}),
    row(500, "review.posted", { pr_url: "https://github.com/o/r/pull/1" }),
  ];
}

function handedOff(): Row[] {
  const rows = cold();
  rows.push(row(305, "daemon.handoff_yielded", { standby_run_id: "new", children_left_running: [] }),
    row(330, "daemon.standby_promoted", { prepare_ms: 15_000, promote_wait_ms: 9, lock_wait_ms: 20, takeover_ms: 50 }));
  return rows;
}

test("W1-T14547 a restart cycle says whether it handed off", () => {
  const handed = restartCycleRow(handedOff(), epoch + 400);
  assert.ok(handed);
  assert.equal(handed.handed_off, true);
  assert.equal(handed.standby_ready_ms, 15_000, "the standby's own prepare time");
  assert.equal(handed.yield_to_first_tick_ms, 145, "yield at 305, first tick at 450");

  const coldCycle = restartCycleRow(cold(), epoch + 400);
  assert.ok(coldCycle);
  assert.equal(coldCycle.handed_off, false);
  assert.equal("standby_ready_ms" in coldCycle, false, "a cold cycle adds no other new field");
  assert.equal("yield_to_first_tick_ms" in coldCycle, false);

  // A yield the standby never took (it died before promotion) is not a handoff.
  const unpromoted = cold();
  unpromoted.push(row(305, "daemon.handoff_yielded", { standby_run_id: "new" }));
  assert.equal(restartCycleRow(unpromoted, epoch + 400)?.handed_off, false);

  // A promoted successor that never ticked yet, and a promoted row with no prepare time, keep the fields with null.
  const quiet = handedOff().filter((r) => r.step !== "daemon.tick").map((r) => r.step === "daemon.standby_promoted" ? { ...r, prepare_ms: "?" } : r);
  const q = restartCycleRow(quiet, epoch + 400);
  assert.equal(q?.handed_off, true);
  assert.equal(q?.standby_ready_ms, null);
  assert.equal(q?.yield_to_first_tick_ms, null);
});
