// W1-T4601: remudero-site drained its queue and entered the entrypoint's quiet mode at 01:03Z on
// 2026-09-27 (`daemon.idle_starved.enter`, then a `daemon.idle_starved.pulse` every 1800s instead of a
// sweep). At 01:33Z the gateway's liveness watch paged it as down (remudero-site#171): it counted only
// sweep.summary and daemon.pause as heartbeats and its prefilter never read the quiet rows.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { judgeInstanceLiveness, QUIET_PULSE_BOUND_MS, readLivenessRows } from "../src/lib/fleet-liveness.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const SITE = { name: "site", repo: "craigoley/remudero-site", stateDir: "/unused" };
const T0 = Date.parse("2026-09-27T01:03:14.000Z");
const MIN = 60_000;
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

const sweep = (offsetMs: number) => ({ ts: at(offsetMs), step: "sweep.summary", poll_interval_ms: 60_000 });
const enter = (offsetMs: number) => ({ ts: at(offsetMs), step: "daemon.idle_starved.enter", open_prs: 0, plan_tasks: 35 });
// The entrypoint's own shell-printed pulse row carries no host, pid or poll interval.
const pulse = (offsetMs: number) => ({ ts: at(offsetMs), run_id: "IDLE-a4da2853ac6a", task_id: "DAEMON", step: "daemon.idle_starved.pulse" });

test("W1-T4601: an instance whose queue drained and whose quiet-mode pulse is fresh is judged up and quiet, while a quiet mode whose pulse stopped is still judged down", () => {
  // The live shape: last sweep, then quiet mode, judged 45 min in (past the 30 min stale bound).
  const drained = [sweep(-10_000), enter(0), pulse(0), pulse(30 * MIN)];
  const idle = judgeInstanceLiveness(SITE, drained, T0 + 45 * MIN);
  assert.equal(idle.state, "up", "a drained queue is idle, not down");
  assert.equal(idle.quiet, true);
  assert.deepEqual(idle.reasons, []);

  // Without the quiet rows the same instance IS down — the watch still catches a real silence.
  assert.equal(judgeInstanceLiveness(SITE, [sweep(-10_000)], T0 + 45 * MIN).state, "down");

  // A quiet mode whose probe went silent past two probe intervals is down again, and says why.
  const silent = judgeInstanceLiveness(SITE, drained, T0 + 30 * MIN + QUIET_PULSE_BOUND_MS + MIN);
  assert.equal(silent.state, "down");
  assert.match(silent.reasons.join("; "), /quiet-mode probe has been silent/);

  // A sweep after the quiet rows means the daemon resumed: ordinary rules apply, not quiet.
  const resumed = judgeInstanceLiveness(SITE, [enter(0), pulse(0), sweep(40 * MIN)], T0 + 45 * MIN);
  assert.equal(resumed.state, "up");
  assert.equal(resumed.quiet, undefined);

  // An operator STOP still reads as held first.
  const stopped = judgeInstanceLiveness(SITE, [...drained, { ts: at(40 * MIN), step: "daemon.stop", detail: "operator" }], T0 + 45 * MIN);
  assert.equal(stopped.state, "held");
});

test("W1-T4601: the liveness prefilter reads the entrypoint's quiet-mode rows from the ledger", () => {
  const base = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4601-`));
  try {
    const stateDir = join(base, "state");
    mkdirSync(stateDir, { recursive: true });
    // Byte-for-byte the entrypoint's printf shape (deploy/entrypoint.sh `idle_starved_wait`).
    const lines = [
      JSON.stringify(sweep(-10_000)),
      JSON.stringify(enter(0)),
      `{"ts":"${at(30 * MIN)}","run_id":"IDLE-a4da2853ac6a","task_id":"DAEMON","step":"daemon.idle_starved.pulse","lane":"daemon","repo":"craigoley/remudero-site"}`,
      JSON.stringify({ ts: at(31 * MIN), step: "board_gateway.fetch_ok" }),
    ];
    writeFileSync(join(stateDir, "ledger.ndjson"), `${lines.join("\n")}\n`);
    const rows = readLivenessRows({ ...SITE, stateDir }, T0 - 60 * MIN);
    assert.deepEqual(
      rows.map((row) => row.step),
      ["sweep.summary", "daemon.idle_starved.enter", "daemon.idle_starved.pulse"],
    );
    assert.equal(judgeInstanceLiveness(SITE, rows, T0 + 45 * MIN).state, "up");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
