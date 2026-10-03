// W1-T5484: W1-T5407 flags a row stamped past its ledger file's mtime with `ledger.future_stamp` but keeps
// it, and the core ledger held a 2027-10-14 `cli.invoked` daemon row. `judgeInstanceLiveness` counted it as
// a boot in every trailing window, and would have taken a future-stamped heartbeat as the newest one.
// Every fixture instant is an offset from the injected clock, so no row ages out of "the future".
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock, systemClock } from "../src/lib/clock.js";
import { judgeInstanceLiveness, LIVENESS_WINDOW_MS, MAX_BOOTS_WITHOUT_HEARTBEAT, readLivenessRows } from "../src/lib/fleet-liveness.js";
import { LEDGER_FUTURE_STAMP_STEP, LEDGER_FUTURE_STAMP_TOLERANCE_MS } from "../src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const clock = fixedClock(systemClock.now());
const NOW = clock.now();
const MIN = 60_000;
const YEAR = 365 * 24 * 60 * MIN;
const CORE = { name: "core", repo: "craigoley/remudero", stateDir: "/unused" };
const at = (offsetMs: number) => fixedClock(NOW + offsetMs).iso();

const sweep = (offsetMs: number, runId = "DAEMON-1") => ({ ts: at(offsetMs), step: "sweep.summary", poll_interval_ms: 60_000, run_id: runId });
const boot = (offsetMs: number, runId: string) => ({ ts: at(offsetMs), step: "cli.invoked", verb: "daemon", host: "8f3e86a35d09", actor_pid: 88, run_id: runId });
/** The flag `appendLedger` writes beside a future-stamped row: stamped at the file's mtime, naming the row. */
const flag = (row: { ts: string; step: string; run_id: string }, offsetMs: number) => ({
  ts: at(offsetMs),
  step: LEDGER_FUTURE_STAMP_STEP,
  run_id: row.run_id,
  claimed_ts: row.ts,
  skew_ms: Date.parse(row.ts) - (NOW + offsetMs),
  flagged_step: row.step,
});

test("a flagged future-stamped daemon boot row is not counted as a boot", () => {
  const future = boot(YEAR, "CLI-1823549018323");
  const judged = judgeInstanceLiveness(CORE, [sweep(-MIN), future, flag(future, -2 * MIN)], NOW);
  assert.equal(judged.bootsSinceHeartbeat, 0);
  assert.equal(judged.bootsLastHour, 0);
  assert.equal(judged.state, "up");
});

test("a flagged future-stamped heartbeat is not used as the newest row", () => {
  // The only real sweep is 45 min old, past the 30 min bound of a 60 s poll: the instance is down.
  const future = sweep(YEAR, "DAEMON-FUTURE");
  const judged = judgeInstanceLiveness(CORE, [sweep(-45 * MIN), future, flag(future, -40 * MIN)], NOW);
  assert.equal(judged.lastSweepAgeMs, 45 * MIN);
  assert.equal(judged.state, "down");
  assert.match(judged.reasons.join("; "), /no sweep for 45 min/);
});

test("an unflagged row stamped beyond now plus the tolerance is skipped, one inside it is kept", () => {
  const beyond = judgeInstanceLiveness(CORE, [sweep(-MIN), boot(LEDGER_FUTURE_STAMP_TOLERANCE_MS + MIN, "CLI-UNFLAGGED")], NOW);
  assert.equal(beyond.bootsLastHour, 0);
  assert.equal(beyond.bootsSinceHeartbeat, 0);
  const unflaggedSweep = judgeInstanceLiveness(CORE, [sweep(-45 * MIN), sweep(LEDGER_FUTURE_STAMP_TOLERANCE_MS + MIN, "DAEMON-2")], NOW);
  assert.equal(unflaggedSweep.lastSweepAgeMs, 45 * MIN);
  const inside = judgeInstanceLiveness(CORE, [sweep(-MIN), boot(LEDGER_FUTURE_STAMP_TOLERANCE_MS - MIN, "CLI-SKEWED")], NOW);
  assert.equal(inside.bootsLastHour, 1);
  assert.equal(inside.bootsSinceHeartbeat, 1);
});

test("real boots and heartbeats are counted as before beside a flagged row", () => {
  const future = boot(YEAR, "CLI-1823549018323");
  const loop = Array.from({ length: MAX_BOOTS_WITHOUT_HEARTBEAT + 1 }, (_, i) => boot(-30 * MIN + i * 3 * MIN, `CLI-${i}`));
  const judged = judgeInstanceLiveness(CORE, [sweep(-50 * MIN), ...loop, future, flag(future, -2 * MIN)], NOW);
  assert.equal(judged.bootsLastHour, MAX_BOOTS_WITHOUT_HEARTBEAT + 1);
  assert.equal(judged.bootsSinceHeartbeat, MAX_BOOTS_WITHOUT_HEARTBEAT + 1);
  assert.equal(judged.state, "down");
  // The flag names one row, not its whole run: a real sweep sharing the flagged run_id is still the heartbeat.
  const sharing = judgeInstanceLiveness(CORE, [sweep(-MIN, "CLI-1823549018323"), future, flag(future, -2 * MIN)], NOW);
  assert.equal(sharing.lastSweepAgeMs, MIN);
  assert.equal(sharing.state, "up");
});

test("readLivenessRows reads the ledger.future_stamp row, so a flagged boot inside the tolerance is skipped", () => {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5484-`));
  try {
    // Ahead of its file's mtime by more than the tolerance, but within it of the reader's own clock.
    const skewed = boot(5 * MIN, "CLI-SKEWED");
    const rows = [sweep(-MIN), skewed, flag(skewed, -LEDGER_FUTURE_STAMP_TOLERANCE_MS)];
    writeFileSync(join(stateDir, "ledger.ndjson"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const read = readLivenessRows({ ...CORE, stateDir }, NOW - LIVENESS_WINDOW_MS);
    assert.ok(read.some((row) => row.step === LEDGER_FUTURE_STAMP_STEP));
    const judged = judgeInstanceLiveness(CORE, read, NOW);
    assert.equal(judged.bootsLastHour, 0);
    assert.equal(judged.bootsSinceHeartbeat, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
