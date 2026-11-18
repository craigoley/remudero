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
import { installFixtureDuGuard } from "./helpers/fixture-du.js";

const SCRIPT = "scripts/fleet-heartbeat.sh";

// The beat ages every row against its own `NOW_EPOCH="$(date -u +%s)"` — a child's real clock that
// scripts/clock-shift.mjs cannot move — so the rows are dated from that same `date`, read per row,
// never from this process's `Date.now()` (see test/fleet-heartbeat.test.ts `NOW`).
function isoAgo(seconds: number): string {
  const nowMs = Number(spawnSync("date", ["-u", "+%s"], { encoding: "utf8" }).stdout.trim()) * 1000;
  return new Date(nowMs - seconds * 1000).toISOString();
}

/** Seed a ledger and run the beat in dry-run, returning its published key=value payload. */
function beat(lines: string[]): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t2961-`));
  try {
    const bin = join(root, "bin"), home = join(root, "home");
    mkdirSync(bin); mkdirSync(home);
    installFixtureDuGuard(bin, [root]);
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "ledger.ndjson"), lines.join("\n") + "\n");
    const r = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home,
        RMD_HEARTBEAT_DRY_RUN: "1", RMD_ROOT: root },
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

test("idle_starved: a fresh shell pulse is live but not a stalled build; an old pulse is neither", () => {
  const oldBuild = JSON.stringify({ ts: isoAgo(48 * 3600), step: "run.start", lane: "run-task", task_id: "W1-T1" });
  const fresh = beat([oldBuild, JSON.stringify({ ts: isoAgo(60), step: "daemon.idle_starved.pulse", task_id: "DAEMON" })]);
  assert.equal(fresh.daemon_verdict, "live");
  assert.match(fresh.dispatch_verdict, /^idle_starved/);
  assert.equal(fresh.daemon_last_step, "daemon.idle_starved.pulse");

  const dead = beat([oldBuild, JSON.stringify({ ts: isoAgo(3600), step: "daemon.idle_starved.pulse", task_id: "DAEMON" })]);
  assert.match(dead.daemon_verdict, /^STALE/);
  assert.match(dead.dispatch_verdict, /^STALLED/, "an old pulse cannot mask a dead sleeper");
});

test("W1-T13249 criterion 2: the last dispatch is the newest run that passed its claim, not the newest run.start", () => {
  const rs = (ago: number, runId: string) =>
    JSON.stringify({ ts: isoAgo(ago), run_id: runId, step: "run.start", lane: "run-task", task_id: "W1-T12114" });
  const claim = (ago: number, runId: string, proceed: boolean) =>
    JSON.stringify({ ts: isoAgo(ago), run_id: runId, step: "dispatch.claim", outcome: proceed ? "created" : "taken", proceed });
  // A real build 48 h ago, then a refused run.start every tick since: the beat must still read STALLED.
  const ledger = [
    rs(48 * 3600, "real"), claim(48 * 3600 - 1, "real", true),
    rs(120, "refused-1"), claim(119, "refused-1", false),
    rs(60, "refused-2"), claim(59, "refused-2", false),
  ];
  const stalled = beat([...POLLING(), ...ledger]);
  assert.match(stalled.dispatch_verdict, /^STALLED/, "a claim-refused run.start is not a dispatch");
  assert.ok(Number(stalled.dispatch_last_age_s) > 47 * 3600, `last dispatch is the real build, got age ${stalled.dispatch_last_age_s}`);

  // A run that took no claim, and a run that passed its claim, both still count.
  const noClaim = beat([...POLLING(), ...ledger, rs(30, "no-claim")]);
  assert.equal(noClaim.dispatch_verdict, "building");
  const passed = beat([...POLLING(), ...ledger, rs(40, "ok"), claim(39, "ok", true)]);
  assert.equal(passed.dispatch_verdict, "building");
});

// W1-T13256: dispatches every 30 minutes (12 of them, so 11 gaps), the newest `lastAgo` seconds old.
const CADENCE = (lastAgo: number, count = 12, gapS = 1800) =>
  Array.from({ length: count }, (_, i) =>
    JSON.stringify({ ts: isoAgo(lastAgo + i * gapS), run_id: `cad-${i}`, step: "run.start", lane: "run-task", task_id: "W1-T1" }),
  );

test("W1-T13256 criterion 1: the stalled bound is derived from the recent gaps between dispatches and published with its source", () => {
  // Gaps of 30 min -> p90 1800 s -> bound 5400 s. 2 h without a dispatch is far under the old fixed
  // 6 h, so only a derived bound reads it as stalled.
  const stalled = beat([...POLLING(), ...CADENCE(2 * 3600)]);
  assert.equal(stalled.dispatch_stall_bound_s, "5400", "the bound is three times the p90 gap");
  assert.match(stalled.dispatch_stall_bound_source, /^derived:p90x3\(gaps=11,p90=1800s\)$/);
  assert.match(stalled.dispatch_verdict, /^STALLED/, "2 h against a 30-minute cadence is stalled");

  // Inside the derived bound the same fleet still reads building.
  const building = beat([...POLLING(), ...CADENCE(3000)]);
  assert.equal(building.dispatch_stall_bound_s, "5400");
  assert.equal(building.dispatch_verdict, "building");

  // A burst of back-to-back dispatches cannot derive a bound below the floor.
  const burst = beat([...POLLING(), ...CADENCE(600, 12, 20)]);
  assert.equal(burst.dispatch_stall_bound_s, "1800");
  assert.match(burst.dispatch_stall_bound_source, /^derived:floor1800\(/);
  assert.equal(burst.dispatch_verdict, "building");
});

test("W1-T13256 criterion 2: too little history keeps the fixed 6 h bound and says so, and an empty queue reads idle", () => {
  // Seven dispatches = six gaps, under the eight needed.
  const few = beat([...POLLING(), ...CADENCE(2 * 3600, 7)]);
  assert.equal(few.dispatch_stall_bound_s, "21600", "too few gaps: today's fixed bound");
  assert.match(few.dispatch_stall_bound_source, /^fixed-fallback:too-few-gaps\(6<8\)$/);
  assert.equal(few.dispatch_verdict, "building", "2 h is inside the fixed 6 h");

  const old = beat([...POLLING(), ...CADENCE(7 * 3600, 7)]);
  assert.match(old.dispatch_verdict, /^STALLED/, "past the fixed 6 h it still stalls");

  // No dispatch rows at all: still the fallback.
  const none = beat([...POLLING()]);
  assert.equal(none.dispatch_stall_bound_s, "21600");
  assert.match(none.dispatch_stall_bound_source, /^fixed-fallback:too-few-gaps\(0<8\)$/);

  // A fleet with no queued work reads idle even when ample history derives a bound it has crossed.
  const idle = beat([
    ...CADENCE(2 * 3600),
    JSON.stringify({ ts: isoAgo(60), step: "daemon.idle_starved.pulse", task_id: "DAEMON" }),
  ]);
  assert.equal(idle.dispatch_stall_bound_s, "5400");
  assert.match(idle.dispatch_verdict, /^idle_starved/);
});
