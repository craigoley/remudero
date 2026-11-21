import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import * as adaptiveWip from "#src/lib/adaptive-wip.js";
import * as focus from "#src/lib/focus-gardener.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { ledgerRotationLockPath, rotateLedger } from "#src/lib/ledger.js";
import { loadPlan } from "#src/lib/plan.js";
import {
  DEFAULT_SWEEP_POLICY, checkQueueGovernor, createSweepFixAdmissionController, detachSweepAction, fixRoundsInFlight,
  logQueueGovernorDeferral, registerChildWork, resetChildWork, settleChildWork, type OpenPrView, type QueueGovernorResult,
} from "#src/lib/sweep.js";
import { withTempDir } from "#src/lib/tmp.js";
import { hostIndependentDaemonDeps } from "#test/helpers/daemon-host-pins.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const BASE = 10;
const MIN = 60_000;
const NOW = Date.parse("2026-11-20T07:00:00.000Z");
const T0 = Date.parse("2026-11-20T01:12:13.000Z");

type Reading = { stuck: number; movable?: number; open?: number; deferred?: boolean };
type Rounds = { admitted: number; refused: number } | undefined;

function governorReading(r: Reading): QueueGovernorResult {
  return {
    deferred: r.deferred ?? false, observedOpenCount: r.open ?? 29, wipLimit: 30, baseWipLimit: BASE,
    stuckOwnedCount: r.stuck, ...(r.movable === undefined ? {} : { movableStuckOwnedCount: r.movable }),
    tier: r.deferred ? "growing" : "under_limit",
  };
}

function disposed(pr: number, blocker: string, ageMs: number, ts = new Date(NOW).toISOString()) {
  return { ts, step: "sweep.disposed", pr_number: pr, blocker, blocker_age_ms: ageMs };
}

/** The 2026-11-20 shape: 12 parked (escalated or operator-hold), 4 ageing past the SLO, 2 ageing under it, 3 moving. */
function incidentLines(): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  for (let pr = 1; pr <= 10; pr++) lines.push(disposed(pr, "escalated", 0));
  lines.push(disposed(11, "operator-hold", 0), disposed(12, "operator-hold", 5 * MIN));
  for (let pr = 13; pr <= 16; pr++) lines.push(disposed(pr, pr % 2 ? "own-red" : "review-failed", 50 * MIN));
  lines.push(disposed(17, "own-red", 10 * MIN), disposed(18, "conflict", 20 * MIN));
  lines.push(disposed(19, "awaiting-ci", 3 * 60 * MIN), disposed(20, "awaiting-review", 0), disposed(21, "armed-idle", 0));
  return lines;
}
const OWNED = Array.from({ length: 21 }, (_, i) => i + 1);

/** A queue gate whose next consultation admits or defers the reading it is given. */
function harness(dir: string, opts: { readFixRounds?: (sinceMs: number) => Rounds; startMs?: number } = {}) {
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  let nowMs = opts.startMs ?? T0;
  let next: QueueGovernorResult | undefined;
  let admission: QueueGovernorResult | undefined;
  const inner = Object.assign((): QueueGovernorResult | undefined => {
    admission = next && !next.deferred ? next : undefined;
    return next?.deferred ? next : undefined;
  }, { readAdmission: () => admission });
  const sinceAsked: number[] = [];
  const gateOpts = {
    stateDir: dir, log: (step: string, fields: Record<string, unknown>) => rows.push({ step, fields }),
    clock: clockFromMillisFn(() => nowMs),
    ...(opts.readFixRounds ? { readFixRounds: (sinceMs: number) => { sinceAsked.push(sinceMs); return opts.readFixRounds!(sinceMs); } } : {}),
  };
  const gate = focus.focusGateFor(inner, gateOpts as Parameters<typeof focus.focusGateFor>[1]);
  return {
    rows, gate, sinceAsked, now: () => nowMs,
    consult: (r: Reading | undefined, advanceMs = 0) => { nowMs += advanceMs; next = r && governorReading(r); return gate(); },
  };
}

/** A fake fix-lane ledger: the rounds admitted and refused at given times. */
function fixLane() {
  const admitted: number[] = [];
  const refused: number[] = [];
  return {
    admit: (atMs: number) => admitted.push(atMs),
    refuse: (atMs: number) => refused.push(atMs),
    read: (sinceMs: number): Rounds => ({
      admitted: admitted.filter((t) => t >= sinceMs).length, refused: refused.filter((t) => t >= sinceMs).length,
    }),
  };
}

/** Enter focus on a movable stack: one reading starts the dwell, the next completes it. */
function enter(h: ReturnType<typeof harness>, stuck = 12, movable = 12) {
  assert.equal(h.consult({ stuck, movable }), undefined);
  assert.equal(h.consult({ stuck, movable }, focus.FOCUS_DWELL_MS)?.tier, "focus");
  return h.now();
}

// ── criterion 1 ────────────────────────────────────────────────────────────────────────────────────────────────────

test("W1-T13990 criterion 1: decideFocus does not enter on 12 parked and 4 ageing stuck PRs against a base of 10", () => {
  const reading = { stuckOwnedCount: 16, movableStuckOwnedCount: 4, observedOpenCount: 29, baseWipLimit: BASE };
  const first = focus.decideFocus({ on: false }, reading, T0);
  assert.deepEqual([first.on, first.changed, first.pendingSinceMs], [false, false, undefined],
    "a stack of parked PRs never even starts the dwell");
  const later = focus.decideFocus(first, reading, T0 + 3 * focus.FOCUS_DWELL_MS);
  assert.deepEqual([later.on, later.changed], [false, false], "focus does not enter on PRs that wait on a person");
  assert.match(later.reason, /\b4 movable stuck\b.*\b12 parked\b/);
});

test("W1-T13990 criterion 1: the focus gate holds no build, writes no FOCUS file and no row for a parked stack", async () => {
  await withTempDir("focus-movable", (dir) => {
    const h = harness(dir);
    for (let i = 0; i < 8; i++) {
      assert.equal(h.consult({ stuck: 16, movable: 4 }, i === 0 ? 0 : 10 * MIN), undefined, `consultation ${i} admits`);
    }
    assert.equal(h.gate.readAdmission()?.stuckOwnedCount, 16, "the admission still sizes the lanes on the full reading");
    assert.equal(existsSync(join(dir, focus.FOCUS_FILE)), false);
    assert.deepEqual(h.rows, []);
  });
});

test("W1-T13990 criterion 1: a hold leaves once the PRs a fix lane can move halve, though the parked ones remain", async () => {
  await withTempDir("focus-movable", (dir) => {
    const h = harness(dir);
    enter(h);
    assert.equal(h.consult({ stuck: 16, movable: 5 }, 5 * MIN)?.tier, "focus", "the halved movable stack must hold for the dwell");
    assert.equal(h.consult({ stuck: 16, movable: 5 }, focus.FOCUS_DWELL_MS), undefined, "it leaves with 11 parked PRs still open");
    assert.deepEqual(h.rows.map((r) => r.step), [focus.FOCUS_ENTERED_STEP, focus.FOCUS_EXITED_STEP]);
    assert.equal(existsSync(join(dir, focus.FOCUS_FILE)), false);
  });
});

test("W1-T13990 criterion 1: deriveMovableStuckOwnedCount counts the ageing class past its SLO only", () => {
  const lines = incidentLines();
  assert.equal(adaptiveWip.deriveMovableStuckOwnedCount(lines, OWNED, NOW), 4);
  assert.equal(adaptiveWip.deriveMovableStuckOwnedCount(lines, OWNED, NOW + 30 * MIN), 5);
  assert.equal(adaptiveWip.deriveMovableStuckOwnedCount(lines, OWNED, NOW + 40 * MIN), 6,
    "an ageing PR crosses its SLO as the clock runs, exactly as the full count reads it");
  assert.equal(adaptiveWip.deriveMovableStuckOwnedCount(lines, [1, 2, 13], NOW), 1, "only owned PRs count");
  assert.equal(adaptiveWip.deriveMovableStuckOwnedCount([...lines, disposed(13, "awaiting-ci", 0)], OWNED, NOW), 3,
    "each PR's latest disposition decides");
  assert.equal(adaptiveWip.deriveMovableStuckOwnedCount([{ step: "sweep.disposed", pr_number: 13, blocker: "own-red" }], OWNED, NOW), 0,
    "a row with no age reads as progressing");
  for (const blocker of Object.keys(adaptiveWip.WIP_BLOCKER_CLASS)) {
    const cls = adaptiveWip.WIP_BLOCKER_CLASS[blocker as keyof typeof adaptiveWip.WIP_BLOCKER_CLASS];
    assert.equal(adaptiveWip.deriveMovableStuckOwnedCount([disposed(1, blocker, 60 * MIN)], [1], NOW), cls === "ageing" ? 1 : 0, blocker);
  }
});

test("W1-T13990 criterion 1: the adaptive flow and the governor carry the movable count beside the full one", () => {
  const flow = adaptiveWip.assembleAdaptiveQueueFlow({
    lines: incidentLines(), ownedPrNumbers: OWNED, nowMs: NOW, baseLimit: BASE, trailingMergedCount: 0, readHeadroom: () => 0.5,
  });
  assert.deepEqual([flow.stuckOwnedCount, flow.movableStuckOwnedCount], [16, 4]);
  const unowned = adaptiveWip.assembleAdaptiveQueueFlow({
    lines: incidentLines(), nowMs: NOW, baseLimit: BASE, trailingMergedCount: 0, readHeadroom: () => 0.5,
  });
  assert.deepEqual([unowned.stuckOwnedCount, unowned.movableStuckOwnedCount], [0, 0], "no ownership split reads as nothing stuck");
  const result = checkQueueGovernor(29, DEFAULT_SWEEP_POLICY, { stuckOwnedCount: flow.stuckOwnedCount,
    movableStuckOwnedCount: flow.movableStuckOwnedCount, adaptiveBound: flow.adaptiveBound });
  assert.deepEqual([result.stuckOwnedCount, result.movableStuckOwnedCount], [16, 4]);
  const clamped = checkQueueGovernor(3, DEFAULT_SWEEP_POLICY, { stuckOwnedCount: 16, movableStuckOwnedCount: 9 });
  assert.deepEqual([clamped.stuckOwnedCount, clamped.movableStuckOwnedCount], [3, 3], "the movable count never exceeds the stuck count");
  assert.equal("movableStuckOwnedCount" in checkQueueGovernor(29, DEFAULT_SWEEP_POLICY, { stuckOwnedCount: 16 }), false,
    "a caller that passes no movable count gets no movable field");
});

// ── criterion 2 ────────────────────────────────────────────────────────────────────────────────────────────────────

test("W1-T13990 criterion 2: a dwell of focus in which every fix dispatch was refused releases it with one row", async () => {
  await withTempDir("focus-movable", (dir) => {
    const lane = fixLane();
    const h = harness(dir, { readFixRounds: lane.read });
    const on = enter(h);
    lane.refuse(on + 5 * MIN);
    assert.equal(h.consult({ stuck: 12, movable: 12 }, 10 * MIN)?.tier, "focus", "one refusal never releases a hold");
    lane.refuse(on + 12 * MIN);
    lane.refuse(on + 25 * MIN);
    assert.equal(h.consult({ stuck: 12, movable: 12 }, 19 * MIN)?.tier, "focus", "the window is not yet a full dwell");
    assert.equal(h.consult({ stuck: 12, movable: 12 }, 1 * MIN), undefined, "a dwell with no admitted round releases the hold");
    assert.equal(h.sinceAsked.at(-1), on, "the window read is the dwell that just ended");
    assert.equal(existsSync(join(dir, focus.FOCUS_FILE)), false);
    const released = h.rows.filter((r) => r.step === focus.FOCUS_RELEASED_STEP);
    assert.equal(released.length, 1);
    assert.equal(released[0].fields.cause, "fix_lane_refused");
    assert.equal(released[0].fields.refused_count, 3);
    assert.match(String(released[0].fields.reason), /no fix round was admitted in 30 minutes of focus \(3 refused\)/);
    assert.equal(h.consult({ stuck: 12, movable: 12 }, 1 * MIN), undefined, "re-entry waits a full dwell again");
    assert.equal(h.rows.filter((r) => r.step === focus.FOCUS_RELEASED_STEP).length, 1, "the release is written once");
    assert.equal(h.consult({ stuck: 12, movable: 12 }, focus.FOCUS_DWELL_MS)?.tier, "focus");
    assert.deepEqual(h.rows.map((r) => r.step), [focus.FOCUS_ENTERED_STEP, focus.FOCUS_RELEASED_STEP, focus.FOCUS_ENTERED_STEP]);
  });
});

test("W1-T13990 criterion 2: an admitted round keeps the hold, and a dwell with no dispatch at all releases it as idle", async () => {
  await withTempDir("focus-movable", (dir) => {
    const lane = fixLane();
    const h = harness(dir, { readFixRounds: lane.read });
    const on = enter(h);
    lane.refuse(on + 2 * MIN);
    lane.admit(on + 20 * MIN);
    assert.equal(h.consult({ stuck: 12, movable: 12 }, focus.FOCUS_DWELL_MS)?.tier, "focus", "a round was admitted in the dwell");
    assert.equal(h.consult({ stuck: 12, movable: 12 }, 19 * MIN)?.tier, "focus", "the admitted round is still inside the window");
    assert.equal(h.consult({ stuck: 12, movable: 12 }, 2 * MIN), undefined, "a full dwell after the last admitted round releases");
    const released = h.rows.find((r) => r.step === focus.FOCUS_RELEASED_STEP)!;
    assert.deepEqual([released.fields.cause, released.fields.refused_count], ["fix_lane_idle", 0]);
  });
});

test("W1-T13990 criterion 2: an unread fix lane, or no reader, never releases the hold", async () => {
  await withTempDir("focus-movable", (dir) => {
    const h = harness(dir, { readFixRounds: () => undefined });
    enter(h);
    for (let i = 0; i < 4; i++) assert.equal(h.consult({ stuck: 12, movable: 12 }, focus.FOCUS_DWELL_MS)?.tier, "focus");
    assert.deepEqual(h.rows.map((r) => r.step), [focus.FOCUS_ENTERED_STEP]);
  });
  await withTempDir("focus-movable", (dir) => {
    const h = harness(dir);
    enter(h);
    for (let i = 0; i < 4; i++) assert.equal(h.consult({ stuck: 12, movable: 12 }, focus.FOCUS_DWELL_MS)?.tier, "focus");
  });
});

test("W1-T13990 criterion 2: a hold restored at boot is released after one dwell of this process with no admitted round", async () => {
  await withTempDir("focus-movable", (dir) => {
    writeFileSync(join(dir, focus.FOCUS_FILE), JSON.stringify({ owner: focus.FOCUS_OWNER, since: "2026-11-19T22:00:00.000Z",
      reason: "r", stuck_owned_count: 12, observed_open_count: 20, base_wip_limit: 10 }));
    const lane = fixLane();
    const h = harness(dir, { readFixRounds: lane.read });
    assert.equal(h.consult({ stuck: 12, movable: 12 })?.tier, "focus", "the restored hold stands at boot");
    assert.equal(h.consult({ stuck: 12, movable: 12 }, focus.FOCUS_DWELL_MS - 1)?.tier, "focus");
    assert.equal(h.consult({ stuck: 12, movable: 12 }, 1), undefined);
    assert.deepEqual(h.rows.map((r) => r.step), [focus.FOCUS_RELEASED_STEP]);
  });
});

test("W1-T13990 criterion 2: fixRoundReaderFor reads admitted and refused fix rounds since a time from the gate's ledger lines", () => {
  const at = (m: number) => new Date(T0 + m * MIN).toISOString();
  const read = adaptiveWip.fixRoundReaderFor([
    { ts: at(-5), step: "fix.dispatch" }, { ts: at(1), step: "fix.dispatch" }, { ts: at(2), step: "sweep.fix.dispatch_failed" },
    { ts: at(3), step: "sweep.fix.dispatch_failed" }, { ts: at(4), step: "fix.done" }, { ts: at(5), step: "fix.retrigger" },
    { ts: "garbage", step: "fix.dispatch" }, { step: "sweep.fix.dispatch_failed" },
  ]);
  assert.deepEqual(read(T0), { admitted: 2, refused: 2 }, "a retrigger round ran; a fix.done without evidence of a worker does not count");
  assert.deepEqual(read(T0 - 10 * MIN), { admitted: 3, refused: 2 });
  assert.deepEqual(read(T0 + 10 * MIN), { admitted: 0, refused: 0 });
});

/** Sweep passes of the real capacity controller, its rows (`sweep.fix_capacity`) appended to a {@link writeLedger}
 *  fixture as the sweep's log stamps them, and read back from that file. */
function capacityPasses(dir: string, runId: string, clockMs: () => number) {
  const fixture = writeLedger([], { dir });
  const log = (step: string, extra?: Record<string, unknown>) =>
    fixture.append([{ ts: new Date(clockMs()).toISOString(), run_id: runId, task_id: "SWEEP", step, ...extra }]);
  /** One sweep pass's controller: every host worker is busy, so each claim is refused before any dispatch. */
  const pass = (claims: number[]) => {
    const controller = createSweepFixAdmissionController({
      surface: "light", queueDepth: claims.length, hostWorkerBudget: 2, activeWorkers: 2, reviewReservations: 0, log,
    });
    for (const prNumber of claims) assert.equal(controller.claim({ prNumber } as OpenPrView).admitted, false);
  };
  /** One controller held open across consultations, its claims judged when made: `free` gives it an idle host. */
  const controller = (opts: { run?: string; surface?: "light" | "full"; free?: boolean } = {}) => {
    const run = opts.run ?? runId;
    const held = createSweepFixAdmissionController({
      surface: opts.surface ?? "light", queueDepth: 1, hostWorkerBudget: 2, activeWorkers: opts.free ? 0 : 2, reviewReservations: 0,
      log: (step, extra) => fixture.append([{ ts: new Date(clockMs()).toISOString(), run_id: run, task_id: "SWEEP", step, ...extra }]),
    });
    return (prNumber: number): boolean => held.claim({ prNumber } as OpenPrView).admitted;
  };
  const lines = (): Array<Record<string, unknown>> => readFileSync(fixture.path, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { lines, pass, controller, append: fixture.append };
}

test("W1-T13990 criterion 2: a refusal the capacity controller writes as sweep.fix_capacity counts as a refused round", async () => {
  await withTempDir("focus-movable", (dir) => {
    let nowMs = T0;
    const passes = capacityPasses(dir, "DAEMON-1", () => nowMs);
    passes.pass([13, 14]);
    nowMs += 10 * MIN;
    passes.pass([15]);
    nowMs += 10 * MIN;
    passes.pass([]);
    const lines = passes.lines();
    const capacity = lines.filter((line) => line.step === "sweep.fix_capacity");
    assert.equal(capacity.length, 6, "each pass writes its opening reading and one row per refused claim");
    assert.deepEqual(capacity.map((line) => line.fixes_refused), [0, 1, 2, 0, 1, 0], "the real row carries its running count");
    assert.equal(lines.some((line) => line.step === "sweep.fix.dispatch_failed"), false,
      "a claim refused before dispatch writes no dispatch failure: the capacity row is the only record of it");
    const read = adaptiveWip.fixRoundReaderFor(lines);
    assert.deepEqual(read(T0), { admitted: 0, refused: 3 });
    assert.deepEqual(read(T0 + 5 * MIN), { admitted: 0, refused: 1 });
  });
});

test("W1-T13990 criterion 2: a lost child counts once, and a controller whose opening row was not read counts from its baseline", () => {
  const at = (m: number) => new Date(T0 + m * MIN).toISOString();
  const read = adaptiveWip.fixRoundReaderFor([
    { ts: at(-1), run_id: "DAEMON-1", step: "sweep.fix_capacity", surface: "light", fixes_refused: 0 },
    { ts: at(1), run_id: "work-fix-dispatch-A", step: "sweep.fix_capacity", surface: "full", fixes_refused: 0 },
    { ts: at(1), run_id: "work-fix-dispatch-A", step: "sweep.fix_capacity", surface: "full", fixes_refused: 1 },
    { ts: at(2), run_id: "DAEMON-1", step: "sweep.fix.dispatch_failed", child_run_id: "work-fix-dispatch-A" },
    { ts: at(3), run_id: "DAEMON-1", step: "sweep.fix.dispatch_failed", child_run_id: "work-fix-dispatch-B" },
    { ts: at(4), run_id: "DAEMON-1", step: "sweep.fix_capacity", surface: "light", fixes_refused: 2 },
    { ts: at(5), run_id: "DAEMON-1", step: "sweep.fix_capacity", surface: "light", fixes_refused: 1 },
    { ts: at(6), run_id: "DAEMON-1", step: "sweep.fix_capacity", surface: "light", fixes_refused: 1 },
    { ts: at(7), run_id: "DAEMON-1", step: "sweep.fix_capacity", surface: "light" },
  ]);
  assert.deepEqual(read(T0), { admitted: 0, refused: 5 },
    "A's refusal once (its lost child is the same refusal), B's lost child, 2 then a new controller's 1, a repeat adds none");
});

test("W1-T13990 criterion 2: a refusal count with no row before the window is unknown, never idle and never inflated", () => {
  const at = (m: number) => new Date(T0 + m * MIN).toISOString();
  const rows = [
    { ts: at(4), run_id: "DAEMON-1", step: "sweep.fix_capacity", surface: "light", fixes_refused: 2 },
    { ts: at(6), run_id: "DAEMON-1", step: "sweep.fix_capacity", surface: "light", fixes_refused: 3 },
  ];
  assert.equal(adaptiveWip.fixRoundReaderFor(rows)(T0), undefined,
    "a controller first read at 2 opened before the window: how many of its 3 fell in the window is unknown");
  assert.deepEqual(adaptiveWip.fixRoundReaderFor(rows)(Date.parse(at(5))), { admitted: 0, refused: 1 },
    "its row before a later window is that window's baseline");
  assert.deepEqual(adaptiveWip.fixRoundReaderFor([
    { ts: at(-20), run_id: "DAEMON-1", step: "sweep.fix_capacity", surface: "light", fixes_refused: 1 }, ...rows,
  ])(T0), { admitted: 0, refused: 2 }, "a row before the window, read, baselines the rise in it");
  assert.deepEqual(adaptiveWip.fixRoundReaderFor([
    { ts: at(2), run_id: "DAEMON-1", step: "sweep.fix_capacity", surface: "light", fixes_refused: 0 }, ...rows,
  ])(T0), { admitted: 0, refused: 3 }, "a controller opened in the window starts at 0");
});

test("W1-T13990 criterion 2: a hold whose every fix claim the capacity controller refused releases as refused, with the count", async () => {
  await withTempDir("focus-movable", (dir) => {
    let passes: ReturnType<typeof capacityPasses> | undefined;
    const h = harness(dir, { readFixRounds: (sinceMs) => adaptiveWip.fixRoundReaderFor(passes!.lines())(sinceMs) });
    passes = capacityPasses(dir, "DAEMON-1", h.now);
    enter(h);
    h.consult({ stuck: 12, movable: 12 }, 5 * MIN);
    passes.pass([13, 14]);
    h.consult({ stuck: 12, movable: 12 }, 10 * MIN);
    passes.pass([15]);
    assert.equal(h.consult({ stuck: 12, movable: 12 }, 15 * MIN), undefined, "a dwell with every claim refused releases the hold");
    const released = h.rows.filter((r) => r.step === focus.FOCUS_RELEASED_STEP);
    assert.equal(released.length, 1);
    assert.deepEqual([released[0].fields.cause, released[0].fields.refused_count], ["fix_lane_refused", 3]);
  });
});

test("W1-T13990 criterion 2: when the idle dwell and a half-bound exit mature on one consultation, one release names the cause", async () => {
  await withTempDir("focus-movable", (dir) => {
    const lane = fixLane();
    const h = harness(dir, { readFixRounds: lane.read });
    const on = enter(h);
    assert.equal(h.consult({ stuck: 16, movable: 5 }, 5 * MIN)?.tier, "focus", "the halved stack starts the exit dwell");
    lane.refuse(on + 6 * MIN);
    lane.refuse(on + 20 * MIN);
    assert.equal(h.consult({ stuck: 16, movable: 5 }, focus.FOCUS_DWELL_MS), undefined, "both dwells have matured");
    assert.deepEqual(h.rows.map((r) => r.step), [focus.FOCUS_ENTERED_STEP, focus.FOCUS_RELEASED_STEP],
      "one release, not an exit that hides the unused hold");
    const released = h.rows[1].fields;
    assert.deepEqual([released.cause, released.refused_count], ["fix_lane_refused", 2]);
    assert.match(String(released.reason), /no fix round was admitted in 30 minutes of focus \(2 refused\)/);
    assert.match(String(released.reason), /5 movable stuck/, "the release also names the stack that reached the leave bound");
    assert.equal(existsSync(join(dir, focus.FOCUS_FILE)), false);
    assert.equal(h.consult({ stuck: 16, movable: 5 }, 1 * MIN), undefined, "the hold stays released");
    assert.equal(h.rows.length, 2);
  });
  await withTempDir("focus-movable", (dir) => {
    const lane = fixLane();
    const h = harness(dir, { readFixRounds: lane.read });
    const on = enter(h);
    h.consult({ stuck: 16, movable: 5 }, 5 * MIN);
    lane.admit(on + 10 * MIN);
    assert.equal(h.consult({ stuck: 16, movable: 5 }, focus.FOCUS_DWELL_MS), undefined, "an admitted round leaves by the bound");
    assert.deepEqual(h.rows.map((r) => r.step), [focus.FOCUS_ENTERED_STEP, focus.FOCUS_EXITED_STEP]);
    assert.equal(h.rows[1].fields.cause, undefined);
  });
});

/** A real rotation of the live file at `atMs`: `rotateLedger` carries the retained fix-round rows back (fix.dispatch,
 *  fix.retrigger, sweep.fix.dispatch_failed) and archives the rest, `sweep.fix_capacity` among them. */
function rotateLive(dir: string, atMs: number): void {
  const path = join(dir, "ledger.ndjson");
  appendFileSync(path, Array.from({ length: 20 }, () => JSON.stringify({ ts: new Date(atMs).toISOString(), step: "ci.polling",
    detail: "x".repeat(100) })).join("\n") + "\n");
  assert.equal(rotateLedger(path, { ceilingBytes: 1_000, smoothingWindowMs: 0, now: () => new Date(atMs) }).rotated, true);
}

/** A focus harness whose fix-round reader is the production one: the union of the rotations and the live file, read
 *  off the loop, joined with the live lines of each consultation. */
function unionHarness(dir: string, read?: adaptiveWip.FixRoundUnionRead, readRunning?: () => number) {
  let h: ReturnType<typeof harness> | undefined;
  const now = () => h!.now();
  const passes = capacityPasses(dir, "DAEMON-1", now);
  const union = adaptiveWip.createFixRoundUnionReader(dir, { clock: clockFromMillisFn(now), ...(read ? { read } : {}),
    ...(readRunning ? { readRunning } : {}) });
  h = harness(dir, { readFixRounds: (sinceMs) => union.readerFor(passes.lines())(sinceMs) });
  return { ...h, passes, union };
}

test("W1-T13990 criterion 2: a refusal whose sweep.fix_capacity rows rotated out of the live file is read through the union", async () => {
  await withTempDir("focus-movable", async (dir) => {
    const h = unionHarness(dir);
    const ageing = { stuck: 12, movable: 12 };
    const on = enter(h);
    h.consult(ageing, 5 * MIN);
    h.passes.pass([13]);
    rotateLive(dir, h.now() + MIN);
    const live = h.passes.lines();
    assert.equal(live.some((line) => line.step === "sweep.fix_capacity"), false, "the refusal's rows are in the archive alone");
    assert.deepEqual(adaptiveWip.fixRoundReaderFor(live)(on), { admitted: 0, refused: 0 }, "the live file alone reads no refusal");
    assert.equal(h.consult(ageing, focus.FOCUS_DWELL_MS - 5 * MIN)?.tier, "focus", "the dwell matured before the union was read");
    await h.union.settled();
    assert.equal(h.consult(ageing, MIN), undefined, "a dwell with no round run releases the hold");
    const released = h.rows.filter((r) => r.step === focus.FOCUS_RELEASED_STEP);
    assert.equal(released.length, 1);
    assert.deepEqual([released[0].fields.cause, released[0].fields.refused_count], ["fix_lane_refused", 1],
      "the rotated refusal is counted, so the row names the refused fix lane, not an idle one");
  });
});

test("W1-T13990 criterion 2: a refusal rotated after the cached union read cannot release focus as idle", async () => {
  await withTempDir("focus-movable", async (dir) => {
    const h = unionHarness(dir);
    const ageing = { stuck: 12, movable: 12 };
    const on = enter(h);
    assert.equal(h.consult(ageing, focus.FOCUS_DWELL_MS)?.tier, "focus");
    await h.union.settled();
    h.passes.pass([13]);
    rotateLive(dir, h.now() + MIN);
    assert.deepEqual(adaptiveWip.fixRoundReaderFor(h.passes.lines())(on), { admitted: 0, refused: 0 },
      "the only refusal is absent from both the cached snapshot and the new live file");
    assert.equal(h.consult(ageing, MIN)?.tier, "focus", "the old snapshot cannot prove this dwell was idle");
    assert.deepEqual(h.rows.map((r) => r.step), [focus.FOCUS_ENTERED_STEP]);
    await h.union.settled();
    assert.equal(h.consult(ageing, MIN), undefined, "the refreshed snapshot covers the rotation");
    await h.union.settled();
    const released = h.rows.filter((r) => r.step === focus.FOCUS_RELEASED_STEP);
    assert.equal(released.length, 1);
    assert.deepEqual([released[0].fields.cause, released[0].fields.refused_count], ["fix_lane_refused", 1]);
  });
});

test("W1-T13990 criterion 2: a missing live ledger or a rotation in progress cannot establish coverage", async () => {
  await withTempDir("focus-movable", async (dir) => {
    const nowMs = T0 + focus.FOCUS_DWELL_MS;
    const union = adaptiveWip.createFixRoundUnionReader(dir, { clock: clockFromMillisFn(() => nowMs) });
    const read = () => union.readerFor([])(T0);
    assert.equal(read(), undefined);
    await union.settled();
    assert.equal(read(), undefined, "a missing live file leaves the union unread");
    await union.settled();

    const fixture = writeLedger([], { dir });
    const lock = ledgerRotationLockPath(fixture.path);
    assert.equal(read(), undefined);
    await union.settled();
    writeFileSync(lock, "rotation still draining");
    assert.equal(read(), undefined, "the live file can still gain rows drained from a replaced inode");
    await union.settled();
    rmSync(lock);
    assert.equal(read(), undefined, "the read attempted during the rotation was not usable");
    await union.settled();
    assert.deepEqual(read(), { admitted: 0, refused: 0 });
    await union.settled();
  });
});

test("W1-T13990 criterion 2: one refusal before the dwell and one in it count one, read against the controller's row before the dwell", async () => {
  await withTempDir("focus-movable", async (dir) => {
    const h = unionHarness(dir);
    const ageing = { stuck: 12, movable: 12 };
    const on = enter(h);
    // One controller spans the dwell's start, and every host worker is busy: each claim it judges is refused.
    const claim = h.passes.controller();
    h.consult(ageing, 2 * MIN);
    assert.equal(claim(13), false, "refused before the dwell the release judges");
    h.consult(ageing, 8 * MIN);
    assert.equal(claim(14), false, "refused in the dwell");
    rotateLive(dir, h.now() + MIN);
    const archived = h.passes.lines().filter((line) => line.step === "sweep.fix_capacity");
    assert.equal(archived.length, 0, "the controller's rows are in the archive alone");
    assert.equal(h.consult(ageing, focus.FOCUS_DWELL_MS - 5 * MIN)?.tier, "focus", "the dwell matured before the union was read");
    assert.ok(h.sinceAsked.at(-1)! > on + 2 * MIN, "the first refusal is before the window the release judges");
    await h.union.settled();
    assert.equal(h.consult(ageing, MIN), undefined, "a dwell with every claim refused releases the hold");
    const released = h.rows.filter((r) => r.step === focus.FOCUS_RELEASED_STEP);
    assert.equal(released.length, 1);
    assert.deepEqual([released[0].fields.cause, released[0].fields.refused_count], ["fix_lane_refused", 1],
      "the archived counter reads 2, but one of the two refusals came before the dwell");
  });
});

test("W1-T13990 criterion 2: an unreadable union is unknown, never idle, and holds the hold", async () => {
  await withTempDir("focus-movable", async (dir) => {
    const h = unionHarness(dir);
    const ageing = { stuck: 12, movable: 12 };
    enter(h);
    writeFileSync(join(dir, `ledger.${new Date(h.now() + 6 * MIN).toISOString().replace(/[:.]/g, "-")}.ndjson.gz`), "not gzip");
    assert.equal(h.consult(ageing, focus.FOCUS_DWELL_MS)?.tier, "focus");
    for (let i = 0; i < 3; i++) {
      await h.union.settled();
      assert.equal(h.consult(ageing, MIN)?.tier, "focus", `a rotation in the window cannot be read (consultation ${i})`);
    }
    assert.deepEqual(h.rows.map((r) => r.step), [focus.FOCUS_ENTERED_STEP]);
  });
  await withTempDir("focus-movable", async (dir) => {
    let reads = 0;
    const h = unionHarness(dir, async () => { reads++; throw new Error("EIO: the union read failed"); });
    enter(h);
    assert.equal(h.consult({ stuck: 12, movable: 12 }, focus.FOCUS_DWELL_MS)?.tier, "focus");
    for (let i = 0; i < 3; i++) {
      await h.union.settled();
      assert.equal(h.consult({ stuck: 12, movable: 12 }, MIN)?.tier, "focus", `a failed read is no reading (consultation ${i})`);
    }
    await h.union.settled();
    assert.equal(reads, 4, "each consultation after a settled read starts the next one");
    assert.deepEqual(h.rows.map((r) => r.step), [focus.FOCUS_ENTERED_STEP]);
  });
});

test("W1-T13990 criterion 2: the union reader answers from a read begun inside the window, joined once with newer live rows", async () => {
  await withTempDir("focus-movable", async (dir) => {
    let nowMs = T0 + focus.FOCUS_DWELL_MS;
    const at = (ms: number) => new Date(ms).toISOString();
    const fixture = writeLedger([
      { ts: at(T0 - 5 * MIN), run_id: "DAEMON-1", step: "sweep.fix_capacity", surface: "light", fixes_refused: 2 },
      { ts: at(T0 + 2 * MIN), run_id: "DAEMON-1", step: "sweep.fix_capacity", surface: "light", fixes_refused: 3 },
      { ts: at(T0 + 3 * MIN), run_id: "DAEMON-1", step: "sweep.fix.dispatch_failed", child_run_id: "work-fix-dispatch-B" },
    ], { dir });
    const lines = () => readFileSync(fixture.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const union = adaptiveWip.createFixRoundUnionReader(dir, { clock: clockFromMillisFn(() => nowMs) });
    assert.equal(union.readerFor(lines())(T0), undefined, "nothing is read yet");
    assert.equal(union.readerFor(lines())(T0), undefined, "a read in flight is not a reading");
    await union.settled();
    assert.deepEqual(union.readerFor(lines())(T0), { admitted: 0, refused: 2 },
      "the pass's rise inside the window and the lost child, each once, though the live file holds them too");
    fixture.append([{ ts: at(nowMs + MIN), run_id: "DAEMON-1", step: "fix.retrigger", round_id: "r1" }]);
    nowMs += 2 * MIN;
    assert.deepEqual(union.readerFor(lines())(T0 + 2 * MIN), { admitted: 1, refused: 2 },
      "a round the live file shows after the read began counts");
    await union.settled();
    nowMs += 2 * focus.FOCUS_DWELL_MS;
    assert.equal(union.readerFor(lines())(nowMs - focus.FOCUS_DWELL_MS), undefined, "a read begun before the window is stale");
  });
});

/** A fix round this process admitted, started as run child R1 for #13, as `adoptChildWork` registers it. */
function startFixChild(): void {
  registerChildWork({ runId: "work-fix-dispatch-R1", kind: "fix-dispatch", taskId: "W1-T1", prNumber: 13, headSha: "a1", fixKey: "W1-T1@a1" });
}

test("W1-T13990 criterion 2: fixRoundsInFlight counts the fix rounds this process admitted until each settles", async () => {
  resetChildWork();
  let finish: () => void = () => {};
  try {
    assert.equal(fixRoundsInFlight(), 0);
    startFixChild();
    registerChildWork({ runId: "work-review-R2", kind: "review", taskId: "W1-T2", prNumber: 14, headSha: "b1", reviewKey: "k" });
    detachSweepAction(new Promise<void>((resolve) => { finish = resolve; }), { actionKind: "fix-dispatch", taskId: "W1-T3", fixKey: "W1-T3@c1" });
    assert.equal(fixRoundsInFlight(), 2, "a run child and an in-process round count; a review does not");
    settleChildWork("work-fix-dispatch-R1");
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixRoundsInFlight(), 0, "a settled round no longer counts");
  } finally {
    // Settled on every path, so a red here never leaves a round in flight for the tests after it.
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    resetChildWork();
  }
});

/** The 2026-11-20 shape on the production reader: the capacity controller admits a claim in the dwell, its round starts
 *  as a run child, and the child is refused at its own admission and ends lost. */
test("W1-T13990 criterion 2: a round admitted in the dwell and then refused is a refusal, and the hold is released", async () => {
  resetChildWork();
  try {
    await withTempDir("focus-movable", async (dir) => {
      const h = unionHarness(dir, undefined, fixRoundsInFlight);
      const ageing = { stuck: 12, movable: 12 };
      enter(h);
      h.consult(ageing, 5 * MIN);
      assert.equal(h.passes.controller({ free: true })(13), true, "the capacity controller admits the claim");
      startFixChild();
      h.consult(ageing, 5 * MIN);
      assert.equal(h.passes.controller({ run: "work-fix-dispatch-R1", surface: "full" })(13), false, "the child is refused");
      settleChildWork("work-fix-dispatch-R1");
      h.passes.append([{ ts: new Date(h.now()).toISOString(), run_id: "DAEMON-1", step: "sweep.fix.dispatch_failed", pr_number: 13,
        child_run_id: "work-fix-dispatch-R1", error: "fix dispatch refused: worker admission refused" }]);
      assert.equal(h.consult(ageing, focus.FOCUS_DWELL_MS - 10 * MIN)?.tier, "focus");
      await h.union.settled();
      assert.equal(h.consult(ageing, MIN), undefined, "an admission whose dispatch was refused is no round run");
      const released = h.rows.filter((r) => r.step === focus.FOCUS_RELEASED_STEP);
      assert.equal(released.length, 1);
      assert.deepEqual([released[0].fields.cause, released[0].fields.refused_count], ["fix_lane_refused", 1],
        "the child's refusal, once: its loss is the same refusal");
    });
  } finally {
    resetChildWork();
  }
});

test("W1-T13990 criterion 2: an abandoned memory admission releases focus with one refusal per round", async () => {
  for (const otherReceipt of [undefined, "child_run_id", "admission_run_id", "round_id"]) {
    await withTempDir("focus-movable", async (dir) => {
      const h = unionHarness(dir);
      const ageing = { stuck: 12, movable: 12 };
      const on = enter(h);
      const ts = new Date(on + 5 * MIN).toISOString();
      const runId = otherReceipt === "child_run_id" || otherReceipt === "admission_run_id" ? "work-fix-dispatch-R1" : "DAEMON-1";
      const roundId = `${runId}:1:${on}`;
      const rows = [{ ts, run_id: runId, task_id: "W1-T1", step: "fix.done", round_id: roundId,
        head_sha: "a1", subtype: "admission_abandoned", worker_exit: "not_spawned", admission_since_ms: on }];
      if (otherReceipt !== undefined) h.passes.append([{ ts, run_id: "DAEMON-1", step: "sweep.fix.dispatch_failed",
        [otherReceipt]: otherReceipt === "round_id" ? roundId : runId }]);
      h.passes.append(rows);
      assert.equal(h.consult(ageing, focus.FOCUS_DWELL_MS)?.tier, "focus");
      await h.union.settled();
      assert.equal(h.consult(ageing, MIN), undefined);
      await h.union.settled();
      const released = h.rows.filter((r) => r.step === focus.FOCUS_RELEASED_STEP);
      assert.equal(released.length, 1);
      assert.deepEqual([released[0].fields.cause, released[0].fields.refused_count], ["fix_lane_refused", 1], otherReceipt);
    });
  }
});

// ── criterion 3 ────────────────────────────────────────────────────────────────────────────────────────────────────

test("W1-T13990 criterion 3: the focus rows and the FOCUS flag carry the stuck count and the movable count", async () => {
  await withTempDir("focus-movable", (dir) => {
    const lane = fixLane();
    const h = harness(dir, { readFixRounds: lane.read });
    enter(h, 15, 11);
    const flag = focus.readFocusFlag(dir) as unknown as Record<string, unknown>;
    assert.deepEqual([flag.stuck_owned_count, flag.movable_stuck_owned_count], [15, 11]);
    h.consult({ stuck: 15, movable: 11 }, focus.FOCUS_DWELL_MS);
    h.consult({ stuck: 14, movable: 10 }, 1 * MIN);
    assert.equal(h.consult({ stuck: 14, movable: 3 }, focus.FOCUS_DWELL_MS), undefined);
    assert.deepEqual(h.rows.map((r) => r.step), [focus.FOCUS_ENTERED_STEP, focus.FOCUS_RELEASED_STEP]);
    for (const row of h.rows) {
      assert.equal(typeof row.fields.stuck_owned_count, "number", row.step);
      assert.equal(typeof row.fields.movable_stuck_owned_count, "number", row.step);
    }
    assert.deepEqual([h.rows[0].fields.stuck_owned_count, h.rows[0].fields.movable_stuck_owned_count], [15, 11]);
    assert.deepEqual([h.rows[1].fields.stuck_owned_count, h.rows[1].fields.movable_stuck_owned_count], [15, 11]);
  });
});

test("W1-T13990 criterion 3: the governor's deferral row writes both counts", () => {
  const rows: Array<Record<string, unknown>> = [];
  const result = checkQueueGovernor(29, DEFAULT_SWEEP_POLICY, { stuckOwnedCount: 16, movableStuckOwnedCount: 4, adaptiveBound: 5 });
  assert.equal(result.deferred, true);
  logQueueGovernorDeferral(result, (_path, line) => { rows.push(line); }, "ledger.ndjson", "RUN");
  assert.deepEqual([rows[0].step, rows[0].stuck_owned_count, rows[0].movable_stuck_owned_count], ["dispatch_deferred_wip", 16, 4]);
});

function fixturePlan(dir: string) {
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, ["A", "B"].map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`,
  ).join(""));
  return loadPlan(path);
}

test("W1-T13990 criterion 3: a held daemon tick's queue governor row names how many of its stuck PRs wait on a person", async () => {
  const held: QueueGovernorResult = { ...governorReading({ stuck: 16, movable: 4 }), deferred: true, tier: "focus" };
  const rows: Array<{ step: string; fields: Record<string, unknown> }> = [];
  let reads = 0;
  let sleeps = 0;
  let nowMs = NOW;
  await withTempDir("focus-movable-plan", (dir) => runDaemon(fixturePlan(dir), {
    ...hostIndependentDaemonDeps(),
    refreshMerged: () => () => false,
    checkQueueGovernor: () => ++reads % 2 === 0 ? held : undefined,
    runOne: async (id) => { assert.fail(`held task ${id} must not start`); },
    now: () => new Date(nowMs),
    sleep: async () => { sleeps++; nowMs += MIN; },
    checkStop: () => sleeps >= 2 ? "fixture complete" : undefined,
    log: (step, fields) => rows.push({ step, fields: fields ?? {} }),
  } as DaemonDeps, { laneCount: 2 }));
  const row = rows.find(({ step }) => step === "daemon.queue_governor")?.fields;
  assert.ok(row, "the held tick writes its governor row");
  assert.deepEqual([row.tier, row.stuck_owned_count, row.movable_stuck_owned_count], ["focus", 16, 4]);
});

// ── criterion 4 ────────────────────────────────────────────────────────────────────────────────────────────────────

test("W1-T13990 criterion 4: invariant:ageing-prs-still-focus — ageing PRs past their SLO enter and leave exactly as on origin/main", async () => {
  assert.equal(focus.FOCUS_DWELL_MS, 30 * MIN);
  assert.deepEqual(focus.focusBounds(BASE), { enterAt: 10, exitAt: 5 });
  const r = (n: number) => ({ stuckOwnedCount: n, movableStuckOwnedCount: n, observedOpenCount: 20, baseWipLimit: BASE });
  assert.equal(focus.decideFocus({ on: false }, r(9), T0).pendingSinceMs, undefined, "9 never starts the dwell");
  const pending = focus.decideFocus({ on: false }, r(10), T0);
  assert.equal(pending.pendingSinceMs, T0);
  assert.equal(focus.decideFocus(pending, r(10), T0 + focus.FOCUS_DWELL_MS - 1).on, false);
  assert.deepEqual([focus.decideFocus(pending, r(10), T0 + focus.FOCUS_DWELL_MS).on, focus.decideFocus(pending, r(10), T0 + focus.FOCUS_DWELL_MS).changed], [true, true]);
  for (const n of [6, 7, 8, 9]) assert.equal(focus.decideFocus({ on: true }, r(n), T0).pendingSinceMs, undefined, `${n} holds the state`);
  const leaving = focus.decideFocus({ on: true }, r(5), T0);
  assert.deepEqual([focus.decideFocus(leaving, r(5), T0 + focus.FOCUS_DWELL_MS).on, leaving.pendingSinceMs], [false, T0]);
  const unwired = { stuckOwnedCount: 12, observedOpenCount: 20, baseWipLimit: BASE };
  assert.equal(focus.decideFocus(focus.decideFocus({ on: false }, unwired, T0), unwired, T0 + focus.FOCUS_DWELL_MS).on, true,
    "a reading with no movable count decides on the full count, as before");
  await withTempDir("focus-movable", (dir) => {
    const h = harness(dir, { readFixRounds: fixLane().read });
    const ageing = { stuck: 10, movable: 10 };
    assert.equal(h.consult(ageing), undefined);
    assert.equal(h.consult(ageing, focus.FOCUS_DWELL_MS)?.tier, "focus", "ten ageing PRs past their SLO enter focus after the dwell");
  });
});

test("W1-T13990 criterion 4: invariant:ageing-prs-still-focus — the WIP bound still subtracts parked and ageing PRs", () => {
  const lines = incidentLines();
  assert.equal(adaptiveWip.deriveStuckOwnedCount(lines, OWNED, NOW), 16, "parked and ageing past the SLO both count as stuck");
  const flow = adaptiveWip.assembleAdaptiveQueueFlow({
    lines, ownedPrNumbers: OWNED, nowMs: NOW, baseLimit: BASE, trailingMergedCount: 0, readHeadroom: () => 0.5,
  });
  const result = checkQueueGovernor(21, DEFAULT_SWEEP_POLICY, {
    stuckOwnedCount: flow.stuckOwnedCount, movableStuckOwnedCount: flow.movableStuckOwnedCount, adaptiveBound: flow.adaptiveBound,
  });
  assert.deepEqual([flow.adaptiveBound, result.deferred, result.tier], [BASE, false, "under_limit"],
    "21 owned less 16 stuck is under the bound of 10: the full count is subtracted, not the movable one");
});

test("W1-T13990 criterion 4: invariant:ageing-prs-still-focus — 12 ageing PRs hold focus through a dwell whose only round was a retrigger", async () => {
  await withTempDir("focus-movable", (dir) => {
    let nowMs = T0;
    const fixture = writeLedger([], { dir });
    const lines = () => readFileSync(fixture.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const h = harness(dir, { readFixRounds: (sinceMs) => adaptiveWip.fixRoundReaderFor(lines())(sinceMs) });
    const ageing = { stuck: 12, movable: 12 };
    const on = enter(h);
    nowMs = on;
    // A worker admitted in the dwell, whose round's commits were retrigger-shaped: fix.ts writes fix.retrigger and no
    // fix.dispatch for it (W1-T2403), so the retrigger row is the round's only record.
    fixture.append([
      { ts: new Date(nowMs + 2 * MIN).toISOString(), run_id: "DAEMON-1", step: "sweep.fix_capacity", surface: "light", fixes_admitted: 1, fixes_refused: 0 },
      { ts: new Date(nowMs + 20 * MIN).toISOString(), run_id: "work-fix-1", task_id: "W1-T1", step: "fix.retrigger", round_id: "r1", retrigger: 1, strike: 0 },
    ]);
    assert.equal(lines().some((line) => line.step === "fix.dispatch"), false, "the dwell holds no fix.dispatch row");
    for (const advance of [focus.FOCUS_DWELL_MS, MIN, 5 * MIN]) {
      assert.equal(h.consult(ageing, advance)?.tier, "focus", "12 ageing PRs above the leave bound of 5 hold focus, as on origin/main");
    }
    assert.deepEqual(h.rows.map((r) => r.step), [focus.FOCUS_ENTERED_STEP], "no release: a round ran in the dwell");
    assert.equal(existsSync(join(dir, focus.FOCUS_FILE)), true);
  });
});

test("W1-T13990 criterion 4: invariant:ageing-prs-still-focus — 12 ageing PRs hold focus while a round admitted in the dwell runs", async () => {
  resetChildWork();
  try {
    await withTempDir("focus-movable", async (dir) => {
      const h = unionHarness(dir, undefined, fixRoundsInFlight);
      const ageing = { stuck: 12, movable: 12 };
      enter(h);
      h.consult(ageing, 5 * MIN);
      // The capacity controller grants the claim and the round starts as a run child; its worker has not returned, so the
      // round has written no fix.dispatch.
      assert.equal(h.passes.controller({ free: true })(13), true, "the capacity controller admits the claim");
      startFixChild();
      assert.equal(h.passes.lines().some((line) => line.step === "fix.dispatch" || line.step === "fix.retrigger"), false);
      assert.equal(h.consult(ageing, focus.FOCUS_DWELL_MS)?.tier, "focus");
      for (let i = 0; i < 3; i++) {
        await h.union.settled();
        assert.equal(h.consult(ageing, MIN)?.tier, "focus", `12 ageing PRs above the leave bound hold while the round runs (${i})`);
      }
      assert.deepEqual(h.rows.map((r) => r.step), [focus.FOCUS_ENTERED_STEP], "no release: an admitted round is running");
      assert.equal(existsSync(join(dir, focus.FOCUS_FILE)), true);
      // The worker returns: its fix.dispatch row is the round run, and the hold stays exactly as on origin/main.
      h.passes.append([{ ts: new Date(h.now()).toISOString(), run_id: "work-fix-dispatch-R1", task_id: "W1-T1", step: "fix.dispatch", round_id: "r1" }]);
      settleChildWork("work-fix-dispatch-R1");
      await h.union.settled();
      assert.equal(h.consult(ageing, MIN)?.tier, "focus");
      assert.deepEqual(h.rows.map((r) => r.step), [focus.FOCUS_ENTERED_STEP]);
    });
  } finally {
    resetChildWork();
  }
});

test("W1-T13990 criterion 4: invariant:ageing-prs-still-focus — a settled worker terminated by signal used the dwell", async () => {
  await withTempDir("focus-movable", async (dir) => {
    const h = unionHarness(dir, undefined, () => 0);
    const ageing = { stuck: 12, movable: 12 };
    const on = enter(h);
    const ts = new Date(on + 20 * MIN).toISOString();
    const terminal = { ts, run_id: "work-fix-dispatch-R1", task_id: "W1-T1", step: "fix.done", round_id: "r1",
      head_sha: "a1", subtype: "signal_terminated", worker_exit: "signal", worker_exit_signal: "SIGTERM" };
    h.passes.append([terminal]);
    assert.equal(h.consult(ageing, focus.FOCUS_DWELL_MS)?.tier, "focus");
    await h.union.settled();
    assert.equal(h.consult(ageing, MIN)?.tier, "focus", "the only receipt records a worker that ran and already settled");
    await h.union.settled();
    assert.deepEqual(h.rows.map((r) => r.step), [focus.FOCUS_ENTERED_STEP]);
    assert.equal(existsSync(join(dir, focus.FOCUS_FILE)), true);

    const dispatch = { ...terminal, step: "fix.dispatch" };
    assert.deepEqual(adaptiveWip.fixRoundReaderFor([terminal, dispatch])(on), { admitted: 1, refused: 0 },
      "a signal receipt and the dispatch for the same round count once");
  });
});

test("W1-T13990 criterion 4: invariant:ageing-prs-still-focus — the FOCUS file's restore at boot and its release by hand are unchanged", async () => {
  await withTempDir("focus-movable", (dir) => {
    writeFileSync(join(dir, focus.FOCUS_FILE), JSON.stringify({ owner: focus.FOCUS_OWNER, since: "2026-11-20T01:12:13.000Z",
      reason: "r", stuck_owned_count: 12, observed_open_count: 20, base_wip_limit: 10 }));
    const h = harness(dir, { readFixRounds: fixLane().read });
    assert.equal(h.consult({ stuck: 9, movable: 9 })?.tier, "focus", "a restarted daemon reads its standing hold from the file");
    rmSync(join(dir, focus.FOCUS_FILE));
    assert.equal(h.consult({ stuck: 12, movable: 12 }), undefined, "removing the file by hand releases the hold");
    assert.deepEqual(h.rows.map((r) => r.step), [focus.FOCUS_RELEASED_STEP]);
    assert.match(String(h.rows[0].fields.reason), /FOCUS was removed while focus held/);
    assert.equal(h.rows[0].fields.cause, undefined, "the hand release names no fix-lane cause");
    assert.equal(h.consult({ stuck: 12, movable: 12 }, focus.FOCUS_DWELL_MS)?.tier, "focus", "re-entry waits a full dwell");
  });
});
