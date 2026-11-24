// W1-T14673: daemon.restart_cycle's new_sha names the commit the successor booted (its own daemon.boot head_sha), not
// the decision's view of origin. A handoff's standby checks out main when it is spawned, which can be newer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { restartCycleRow } from "#src/lib/restart-cycle.js";

const epoch = Date.parse("2026-11-24T15:00:00.000Z");
const at = (ms: number) => new Date(epoch + ms).toISOString();
type Row = Record<string, unknown>;
const row = (ms: number, step: string, fields: Row = {}): Row => ({ ts: at(ms), step, ...fields });

function cycle(successorBoot: Row): Row[] {
  return [
    row(0, "daemon.boot", { run_id: "old", head_sha: "41e1e740" }),
    row(200, "daemon.freshness_decision", { action: "restart", reason: "restart_request", old_sha: "41e1e740", new_sha: "41e1e740" }),
    row(300, "daemon.freshness_exit", { phases_ms: { total: 100 } }),
    row(301, "daemon_selfrestart_for_freshness", { old_sha: "41e1e740", new_sha: "41e1e740" }),
    row(305, "daemon.handoff_yielded", { standby_run_id: "new" }),
    row(400, "daemon.boot", successorBoot),
    row(430, "daemon.standby_promoted", { prepare_ms: 1, promote_wait_ms: 1, lock_wait_ms: 1, takeover_ms: 1 }),
    row(450, "daemon.boot_phases", {}),
    row(500, "review.posted", { pr_url: "https://github.com/o/r/pull/1" }),
  ];
}

test("W1-T14673 a restart cycle names the commit its successor booted", () => {
  const r = restartCycleRow(cycle({ run_id: "new", head_sha: "15da52517" }), epoch + 400);
  assert.ok(r);
  assert.equal(r.old_sha, "41e1e740", "the old daemon's code, from its decision");
  assert.equal(r.new_sha, "15da52517", "the successor's own boot head, not the decision's view of origin");
});

test("W1-T14673 a successor boot without a head sha keeps the decision's new sha", () => {
  const r = restartCycleRow(cycle({ run_id: "new" }), epoch + 400);
  assert.ok(r);
  assert.equal(r.new_sha, "41e1e740");
  const blank = restartCycleRow(cycle({ run_id: "new", head_sha: "" }), epoch + 400);
  assert.equal(blank?.new_sha, "41e1e740");
});
