// W1-T2961: every probe on the beat measured LIVENESS, and liveness was never the question. On
// 2026-09-05/06 the fleet dispatched ZERO tasks for two days — thousands per day before — while
// `daemon_verdict` read `live`, the beat branch stayed fresh, and fleet-heartbeat-watch concluded
// success. None of those were wrong: the daemon really was polling, sweeping, reviewing and merging
// (W1-T2960's livelock). The only row that showed it, `attempted : (none)` on 28 of 28 summaries,
// goes to a container log nothing reads.
//
// These tests drive the REAL `scripts/fleet-heartbeat.sh` in dry-run over a seeded ledger — the beat
// is plain bash by design (its own header: an emptied node_modules kills every rmd verb while the
// resident daemon keeps serving, so a beat written as a verb dies in the state it exists to report),
// so a bash-level test is the only honest way to pin it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const SCRIPT = "scripts/fleet-heartbeat.sh";

function isoAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

/** Seed a ledger and run the beat in dry-run, returning its published key=value payload. */
function beat(lines: string[]): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t2961-`));
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "ledger.ndjson"), lines.join("\n") + "\n");
    const r = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, RMD_HEARTBEAT_DRY_RUN: "1", RMD_ROOT: root },
    });
    const out: Record<string, string> = {};
    for (const line of (r.stdout || "").split("\n")) {
      const m = line.match(/^([a-z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A daemon that polls constantly — the shape that read `live` all through the outage. */
const POLLING = (n = 3) =>
  Array.from({ length: n }, (_, i) =>
    JSON.stringify({ ts: isoAgo(60 + i), step: "daemon.tick", task_id: "DAEMON" }),
  );

test("W1-T2961: the beat publishes a dispatch verdict", () => {
  const p = beat([
    ...POLLING(),
    JSON.stringify({ ts: isoAgo(120), step: "run.start", lane: "run-task", task_id: "W1-T1" }),
  ]);
  assert.ok("dispatch_verdict" in p, "the payload must carry a dispatch verdict at all");
  assert.equal(p.dispatch_verdict, "building", "a recent build dispatch reads as building");
  assert.ok("dispatch_last_ts" in p && p.dispatch_last_ts !== "none", "and names when it last built");
});

test("W1-T2961: a polling daemon that admits nothing reads as stalled", () => {
  // THE EXACT OUTAGE SHAPE. The daemon ticks constantly and the only run.start rows are RETRO —
  // which is why filtering to the run-task lane, rather than reading the bare step, is the whole
  // discrimination. A probe on the bare step would have read "building" for two days.
  const p = beat([
    ...POLLING(),
    // ORDER MATTERS AND IS THE POINT: the stale build row comes FIRST and the fresh RETRO row LAST,
    // so a probe reading the bare step with `tail -n 1` picks up the retro and reports "building".
    // Written the other way round the test passes with or without the lane filter — which it did on
    // the first draft, and a mutation run caught it.
    JSON.stringify({ ts: isoAgo(48 * 3600), step: "run.start", lane: "run-task", task_id: "W1-T1" }),
    JSON.stringify({ ts: isoAgo(60), step: "run.start", lane: "retro", task_id: "RETRO" }),
  ]);
  assert.equal(p.daemon_verdict, "live", "the daemon really is alive — that was never the question");
  assert.match(p.dispatch_verdict, /^STALLED/, "but two days without a build dispatch is STALLED");
});

test("W1-T2961: the stalled verdict names the blocking reason", () => {
  // "Not building" sends an operator to read container logs, which is where this hid for two days.
  // "Not building, last tick self-restarted for freshness" names the defect (W1-T2960).
  const p = beat([
    ...POLLING(),
    JSON.stringify({ ts: isoAgo(48 * 3600), step: "run.start", lane: "run-task", task_id: "W1-T1" }),
    JSON.stringify({ ts: isoAgo(30), step: "daemon_selfrestart_for_freshness", task_id: "DAEMON" }),
  ]);
  assert.match(p.dispatch_verdict, /^STALLED/);
  assert.match(
    p.dispatch_verdict,
    /daemon_selfrestart_for_freshness/,
    "the verdict must carry WHY, not only THAT — the alert is read without the logs",
  );
  assert.match(p.dispatch_block_reason, /daemon_selfrestart_for_freshness/);

  // A quiet fleet with no blocking signal is not slandered with one.
  const quiet = beat([...POLLING(), JSON.stringify({ ts: isoAgo(120), step: "run.start", lane: "run-task", task_id: "W1-T1" })]);
  assert.equal(quiet.dispatch_block_reason, "none");
  assert.equal(quiet.dispatch_verdict, "building", "and a building fleet never raises the arm");
});
