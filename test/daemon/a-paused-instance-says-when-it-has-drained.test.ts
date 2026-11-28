/**
 * W1-T12939 — A PAUSED INSTANCE SAYS WHEN IT HAS DRAINED.
 *
 * OBSERVED 2026-11-15: an operator paused the fleet to reboot the host and had to write a process watch by hand,
 * whose first version reported the fleet drained while two runs were live. The daemon already knows every unit it
 * owns, so a held pass now carries the census (`in_flight`), the first empty census of a hold writes
 * `daemon.drained`, and the off-host beat prints `drain_verdict` from those rows.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runDaemon, type DaemonDeps, type PauseInFlightUnit } from "#src/lib/daemon.js";
import { createGardenFlightRegistry, gardenAndJudgeUnits, startGardenOffLoop } from "#src/lib/garden-registry.js";
import { loadPlan, type Plan } from "#src/lib/plan.js";
import { registerChildWork, resetChildWork, trackInFlightReview } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { runBeat } from "#test/helpers/fleet-heartbeat-harness.js";

type Row = { step: string; extra: Record<string, unknown> };

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t12939-plan-`));
  const file = join(dir, "tasks.yaml");
  writeFileSync(file, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  return loadPlan(file);
}

/** A held daemon that runs `passes` paused ticks, calling `afterPass(n)` once the n-th pause row is written. */
async function heldDaemon(passes: number, extra: Partial<DaemonDeps>, afterPass: (pass: number) => void = () => {}): Promise<Row[]> {
  const rows: Row[] = [];
  let pass = 0;
  await runDaemon(fixturePlan(), {
    refreshMerged: () => () => false,
    runOne: async (id) => {
      throw new Error(`runOne must never be called for ${id} — a held instance starts nothing`);
    },
    checkPause: () => "PAUSE requested: reboot the host",
    checkStop: () => (pass >= passes ? "test done" : undefined),
    sleepUntilSweepWake: async () => {
      await settle();
      return "wake";
    },
    sweepLight: async () => {},
    sleep: async () => {
      await settle();
    },
    log: (step, fields = {}) => {
      rows.push({ step, extra: fields });
      if (step === "daemon.pause") afterPass(++pass);
    },
    ...extra,
  } as DaemonDeps);
  return rows;
}

const units = (row: Row): PauseInFlightUnit[] => row.extra.in_flight as PauseInFlightUnit[];

// ── criterion 1 ──────────────────────────────────────────────────────────────────────────────────

test("W1-T12939 criterion 1: each daemon.pause row names the in-flight units by kind and name", async (t) => {
  let finishReview!: () => void;
  const review = trackInFlightReview(new Promise<void>((resolve) => { finishReview = resolve; }), { taskId: "W1-T1", prNumber: 77 });
  registerChildWork({ runId: "child-1", kind: "review", taskId: "W1-T2", prNumber: 78, headSha: "abc" });
  t.after(() => { finishReview(); resetChildWork(); });
  void review;
  const rows = await heldDaemon(2, {
    pauseInFlight: () => [{ kind: "garden-child", name: "knowledge" }, { kind: "judge-call", name: "queue-judge" }],
    adoptRunChildren: () => [{ started: true, runId: "run-1", dir: "/nowhere", pid: 1, taskId: "W1-T9", settled: new Promise(() => {}) }] as never,
  }, (pass) => { if (pass === 2) { finishReview(); resetChildWork(); } });
  const pauses = rows.filter((r) => r.step === "daemon.pause");
  assert.ok(pauses.length >= 2);
  for (const row of pauses) {
    const kinds = units(row).map((u) => `${u.kind}:${u.name}`);
    assert.ok(kinds.includes("run-child:W1-T9"), `a live run child is named: ${kinds}`);
    assert.ok(kinds.includes("review:W1-T1"), `an in-process review is named: ${kinds}`);
    assert.ok(kinds.includes("child-work:review"), `a review child is counted by kind: ${kinds}`);
    assert.ok(kinds.includes("garden-child:knowledge"), `a garden child is named: ${kinds}`);
    assert.ok(kinds.includes("judge-call:queue-judge"), `a judge call is named: ${kinds}`);
    assert.equal(row.extra.in_flight_count, 5);
    assert.equal(typeof row.extra.in_flight_oldest_age_ms, "number");
  }
  assert.equal(rows.filter((r) => r.step === "daemon.drained").length, 0, "a census with units is never drained");
});

test("W1-T12939 criterion 1: a census that cannot be read is a unit, never an empty census", async () => {
  const rows = await heldDaemon(2, { pauseInFlight: () => { throw new Error("garden registry unreadable"); } });
  const pause = rows.find((r) => r.step === "daemon.pause")!;
  assert.deepEqual(units(pause).map((u) => u.kind), ["census-unreadable"]);
  assert.equal(rows.filter((r) => r.step === "daemon.drained").length, 0);
});

// ── criterion 2 ──────────────────────────────────────────────────────────────────────────────────

test("W1-T12939 criterion 2: one hold writes drained once, reopened when a unit appears", async () => {
  // pass index -> census: busy, empty, empty, busy, empty
  const census: PauseInFlightUnit[][] = [[{ kind: "judge-call", name: "j" }], [], [], [{ kind: "garden-child", name: "g" }], []];
  let pass = 0;
  let held = true;
  let checks = 0;
  const rows: Row[] = [];
  await runDaemon(fixturePlan(), {
    refreshMerged: () => (id: string) => id === "A",
    runOne: async (id) => {
      throw new Error(`runOne must never be called for ${id}`);
    },
    checkPause: () => (held ? "PAUSE requested: reboot the host" : undefined),
    checkStop: () => (++checks > census.length + 6 ? "test done" : undefined),
    sleepUntilSweepWake: async () => {
      await settle();
      return "wake";
    },
    sweepLight: async () => {},
    sleep: async () => {
      await settle();
    },
    pauseInFlight: () => census[Math.min(pass, census.length - 1)]!,
    log: (step, fields = {}) => {
      rows.push({ step, extra: fields });
      if (step === "daemon.pause") {
        pass++;
        // the hold ends after the fifth paused pass, and a second hold begins one pass later
        if (pass === census.length) held = false;
      }
    },
  } as DaemonDeps);
  const order = rows.filter((r) => r.step === "daemon.pause" || r.step === "daemon.drained" || r.step === "daemon.drain_reopened")
    .map((r) => r.step.replace("daemon.", ""));
  assert.deepEqual(order, ["pause", "pause", "drained", "pause", "pause", "drain_reopened", "pause", "drained"],
    `drained is written once per empty stretch, never on every paused pass: ${order}`);
  const episodes = new Set(rows.filter((r) => r.step === "daemon.drained" || r.step === "daemon.drain_reopened").map((r) => r.extra.drain_episode));
  assert.equal(episodes.size, 1, "all transitions of one hold carry the hold's one episode id");
  assert.equal(rows.find((r) => r.step === "daemon.drained")!.extra.drain_episode, rows.find((r) => r.step === "daemon.pause")!.extra.drain_episode);
});

test("W1-T12939 criterion 2: releasing the hold ends the episode, and the next hold writes its own drained row", async () => {
  let tick = 0;
  const rows: Row[] = [];
  await runDaemon(fixturePlan(), {
    refreshMerged: () => (id: string) => id === "A",
    runOne: async (id) => {
      throw new Error(`runOne must never be called for ${id}`);
    },
    // held on ticks 1-2 and 5-6, released on ticks 3-4
    checkPause: () => (tick <= 2 || (tick >= 5 && tick <= 6) ? "PAUSE requested: reboot the host" : undefined),
    checkStop: () => (tick >= 7 ? "test done" : undefined),
    sleepUntilSweepWake: async () => {
      await settle();
      return "wake";
    },
    sweepLight: async () => {},
    sleep: async () => {
      await settle();
    },
    pauseInFlight: () => [],
    log: (step, fields = {}) => {
      rows.push({ step, extra: fields });
      if (step === "daemon.tick") tick++;
    },
  } as DaemonDeps);
  const drained = rows.filter((r) => r.step === "daemon.drained");
  assert.equal(drained.length, 2, "two holds, one drained row each, however many paused passes either held");
  assert.notEqual(drained[0]!.extra.drain_episode, drained[1]!.extra.drain_episode, "a released hold ends its episode");
  assert.equal(rows.filter((r) => r.step === "daemon.pause").length, 4);
});

// ── the production census: garden children and judge calls ───────────────────────────────────────

test("W1-T12939 criterion 1: the census the daemon CLI supplies names a live garden pass and a live judge call, and drained waits for both", async (t) => {
  // The same registry the CLI hands every garden's off-loop, read by the same builder the CLI hands runDaemon.
  const flight = createGardenFlightRegistry();
  let finishPass!: (exit: number) => void;
  const loop = startGardenOffLoop("plan", 3_600_000, {
    flight, log: () => {},
    spawnPass: () => new Promise<number>((resolve) => { finishPass = resolve; }),
  });
  t.after(() => { loop.stop(); finishPass(0); });
  let judgeStartedMs: number | undefined = 1_000;
  const rows = await heldDaemon(3, { pauseInFlight: () => gardenAndJudgeUnits(flight, judgeStartedMs, 5_000) }, (pass) => {
    if (pass === 1) judgeStartedMs = undefined; // the judge call settles after the first paused pass
    if (pass === 2) finishPass(0); // the garden pass settles after the second
  });
  const pauses = rows.filter((r) => r.step === "daemon.pause");
  assert.ok(pauses.length >= 3, `three paused passes ran: ${pauses.length}`);
  const named = (r: Row) => units(r).map((u) => `${u.kind}:${u.name}`);
  assert.deepEqual(named(pauses[0]!), ["garden-child:plan", "judge-call:ci-escalation"]);
  assert.equal(pauses[0]!.extra.in_flight_count, 2);
  assert.equal(units(pauses[0]!)[1]!.age_ms, 4_000, "the judge call's age is read from its start");
  assert.deepEqual(named(pauses[1]!), ["garden-child:plan"], "the judge call has settled, the garden child has not");
  assert.deepEqual(named(pauses[2]!), [], "the garden pass has settled");
  assert.equal(pauses[0]!.extra.in_flight_unobserved, undefined, "a supplied census covers every unit kind");
  const steps = rows.map((r) => r.step).filter((s) => s === "daemon.pause" || s === "daemon.drained");
  assert.deepEqual(steps.slice(0, 4), ["daemon.pause", "daemon.pause", "daemon.pause", "daemon.drained"],
    `drained is written only on the pass whose census is empty: ${steps}`);
});

test("W1-T12939 criterion 1: a garden pass that cannot spawn leaves the registry", () => {
  const flight = createGardenFlightRegistry();
  const loop = startGardenOffLoop("plan", 3_600_000, { flight, log: () => {}, spawnPass: () => { throw new Error("spawn refused"); } });
  loop.stop();
  assert.deepEqual(flight.live(), []);
});

test("W1-T12939 criterion 2: a daemon with no garden and judge census never writes drained, and says what it could not see", async () => {
  const rows = await heldDaemon(3, {});
  const pauses = rows.filter((r) => r.step === "daemon.pause");
  assert.ok(pauses.length >= 3);
  for (const pause of pauses) {
    assert.equal(pause.extra.in_flight_count, 0);
    assert.deepEqual(pause.extra.in_flight_unobserved, ["garden-child", "judge-call"]);
  }
  assert.equal(rows.filter((r) => r.step === "daemon.drained").length, 0, "an empty census that did not cover every unit kind is not drained");
});

// ── criterion 3 ──────────────────────────────────────────────────────────────────────────────────

/** One clock for the fixture and the beat (W1-T14786): the rows are aged from this process's clock, which the shift
 *  preload moves, and the beat's own `date -u` reads answer from the same clock through a stub, so a shifted run
 *  shifts both sides together. Every other `date` call reaches the real one. */
const clockMs = () => Date.now();
const isoAt = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const iso = (agoS: number) => isoAt(clockMs() - agoS * 1000);
const row = (agoS: number, step: string, rest: Record<string, unknown> = {}) => JSON.stringify({ ts: iso(agoS), step, ...rest });
const dateStubAt = (ms: number) => `#!/bin/sh
case "$*" in
  '-u +%s') echo ${Math.floor(ms / 1000)} ;;
  '-u +%Y-%m-%dT%H:%M:%SZ') echo ${isoAt(ms)} ;;
  *) exec /bin/date "$@" ;;
esac
`;
// The beat's temp-leftover walk reads $TMPDIR and the host's /tmp unless the fixture points both at an empty
// directory; on a busy review host that walk cost each beat about 14 to 25 s (W1-T14786).
const QUIET_TMP = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14786-quiet-`));
const drainVerdict = (ledger: string[] | undefined): string => {
  const b = runBeat({
    ...(ledger ? { ledger } : {}),
    dateStub: dateStubAt(clockMs()),
    env: { TMPDIR: QUIET_TMP, RMD_HEARTBEAT_SYSTEM_TMP: QUIET_TMP },
  });
  const line = b.published.split("\n").find((l) => l.startsWith("drain_verdict="));
  assert.ok(line, `the beat must publish drain_verdict: ${b.published}`);
  return line.slice("drain_verdict=".length);
};
const live = row(30, "daemon.poll");

test("W1-T12939 criterion 3: the beat prints not-paused for an instance with no hold", () => {
  assert.equal(drainVerdict([row(900, "daemon.boot", { head_sha: "abc1234" }), live]), "not-paused");
  assert.equal(drainVerdict([live, row(2000, "daemon.pause", { in_flight_count: 0, drain_episode: "1-1" }), row(1990, "daemon.drained", { drain_episode: "1-1" })]),
    "not-paused", "a hold whose pause rows ended long ago is not a hold");
});

test("W1-T12939 criterion 3: the beat prints draining with the count and the oldest unit's age", () => {
  const v = drainVerdict([row(120, "daemon.pause", { in_flight_count: 2, in_flight_oldest_age_ms: 7_380_000, drain_episode: "1-1" }), live]);
  assert.match(v, /^draining — 2 in flight, oldest 2h/, v);
  const reopened = drainVerdict([
    row(300, "daemon.pause", { in_flight_count: 0, drain_episode: "1-1" }), row(299, "daemon.drained", { drain_episode: "1-1" }),
    row(100, "daemon.drain_reopened", { drain_episode: "1-1", in_flight_count: 1 }),
    row(60, "daemon.pause", { in_flight_count: 1, in_flight_oldest_age_ms: 5000, drain_episode: "1-1" }), live,
  ]);
  assert.match(reopened, /^draining — 1 in flight/, reopened);
});

test("W1-T12939 criterion 3: the beat prints drained with the row's time", () => {
  const drainedTs = iso(200);
  const v = drainVerdict([
    row(260, "daemon.pause", { in_flight_count: 1, in_flight_oldest_age_ms: 1000, drain_episode: "1-1" }),
    row(200, "daemon.pause", { in_flight_count: 0, drain_episode: "1-1" }), JSON.stringify({ ts: drainedTs, step: "daemon.drained", drain_episode: "1-1" }),
    row(140, "daemon.pause", { in_flight_count: 0, drain_episode: "1-1" }), live,
  ]);
  assert.equal(v, `drained — at ${drainedTs}`);
});

test("W1-T12939 criterion 3: the beat never prints drained for an unreadable, stale or census-less ledger", () => {
  assert.match(drainVerdict(undefined), /^unknown/, "no ledger at all");
  const stale = drainVerdict([row(5000, "daemon.pause", { in_flight_count: 0, drain_episode: "1-1" }), row(4990, "daemon.drained", { drain_episode: "1-1" }), row(4000, "daemon.poll")]);
  assert.match(stale, /^unknown/, `a daemon whose newest line is stale is unknown: ${stale}`);
  assert.match(drainVerdict([row(60, "daemon.pause", { tick: 3, detail: "PAUSE" }), live]), /^unknown/, "a pause row from a daemon that writes no census");
  const partial = drainVerdict([row(60, "daemon.pause", { in_flight_count: 0, in_flight_unobserved: ["garden-child", "judge-call"], drain_episode: "1-1" }),
    row(59, "daemon.drained", { drain_episode: "1-1" }), live]);
  assert.match(partial, /^unknown — the census does not cover/, `an empty census that could not see every unit kind is never drained: ${partial}`);
  // an earlier hold's drained row does not answer for a hold whose census is empty but not yet marked
  const previous = drainVerdict([row(900, "daemon.drained", { drain_episode: "0-1" }), row(60, "daemon.pause", { in_flight_count: 0, drain_episode: "1-1" }), live]);
  assert.match(previous, /^draining — 0 in flight/, previous);
});

// ── criterion 4 ──────────────────────────────────────────────────────────────────────────────────

test("W1-T12939 criterion 4: invariant:pause-behaviour-unchanged — a held instance starts nothing and keeps every pause field", async () => {
  const rows = await heldDaemon(3, { pauseInFlight: () => [] });
  const pauses = rows.filter((r) => r.step === "daemon.pause");
  assert.ok(pauses.length >= 3);
  pauses.forEach((r, i) => {
    assert.equal(r.extra.tick, i + 1);
    assert.equal(r.extra.detail, "PAUSE requested: reboot the host");
    assert.equal(typeof r.extra.poll_interval_ms, "number");
  });
  assert.ok(!rows.some((r) => r.step === "run.start" || r.step === "daemon.dispatch"), "nothing was started");
});

test("W1-T12939 criterion 4: an instance that is not held writes no drained row", async () => {
  const rows: Row[] = [];
  let ticks = 0;
  await runDaemon(fixturePlan(), {
    refreshMerged: () => (id: string) => id === "A",
    runOne: async (id) => {
      throw new Error(`runOne must never be called for ${id}`);
    },
    checkStop: () => (++ticks > 3 ? "test done" : undefined),
    sleepUntilSweepWake: async () => {
      await settle();
      return "wake";
    },
    sweepLight: async () => {},
    sleep: async () => {
      await settle();
    },
    pauseInFlight: () => [],
    log: (step, fields = {}) => rows.push({ step, extra: fields }),
  } as DaemonDeps);
  assert.equal(rows.filter((r) => r.step === "daemon.drained" || r.step === "daemon.drain_reopened" || r.step === "daemon.pause").length, 0);
});
