// W1-T14873: an exit waited on the SRE lane page, a whole-ledger-union read, before it released the drain lock. On the
// 2026-11-25 18:57Z hand-over that held the lock 29.9 min after the yield, so the ready standby gave up after 300 s.
import assert from "node:assert/strict";
import test from "node:test";
import { closeDaemonCleanup } from "#src/cli/commands/daemon.js";

type Row = { step: string } & Record<string, unknown>;

/** An exit whose SRE lane page is still being read; `settle` lets the read finish. */
function exitWithHeldPage() {
  const rows: Row[] = [];
  const events: string[] = [];
  let nowMs = 0;
  let settle: () => void = () => {};
  const page = new Promise<void>((resolve) => { settle = () => { nowMs += 900; events.push("page_settled"); resolve(); }; });
  let exited = false;
  const exit = closeDaemonCleanup(
    [{ resource: "drain_lock", close: () => { events.push("drain_lock"); } },
      { resource: "stop_marker", close: () => { events.push("stop_marker"); nowMs += 3; } }],
    (step, extra = {}) => { rows.push({ step, ...extra }); if (step === "daemon.exit_after_release") events.push(`row:${step}`); },
    { now: () => nowMs },
    [{ resource: "sre_lane_page", settled: page }],
  ).then(() => { exited = true; });
  return { rows, events, settle, exit, exited: () => exited };
}

const turns = async (n: number) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };

test("W1-T14873 an exit releases the drain lock before the SRE lane page settles", async () => {
  const run = exitWithHeldPage();
  await turns(5);
  assert.ok(run.events.includes("drain_lock"), "the lock is released while the page is still being read");
  assert.ok(!run.events.includes("page_settled"), "the page had not settled when the lock was released");
  run.settle();
  await run.exit;
  assert.deepEqual(run.events, ["stop_marker", "drain_lock", "page_settled", "row:daemon.exit_after_release"],
    "the page is waited on, and timed, only after the lock is released");
});

test("W1-T14873 an exit still waits for the SRE lane page to settle", async () => {
  const run = exitWithHeldPage();
  await turns(5);
  assert.equal(run.exited(), false, "the exit has not returned while the page is held");
  run.settle();
  await run.exit;
  assert.equal(run.exited(), true);
  const after = run.rows.filter((row) => row.step === "daemon.exit_after_release");
  assert.deepEqual(after, [{ step: "daemon.exit_after_release", sre_lane_page_ms: 900, total_ms: 900 }]);
  const cleanup = run.rows.find((row) => row.step === "daemon.exit_cleanup");
  assert.equal(cleanup?.released_last, "drain_lock");
  assert.equal(cleanup?.sre_lane_page_ms, undefined, "the page is no longer timed as a close before the lock");
});
