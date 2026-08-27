/**
 * test/doctor.test.ts — W1-T1047: `rmd doctor`.
 *
 * EVERY REFUSAL ARM IS DRIVEN THROUGH ITS OWN PURE FUNCTION WITH A PAIRED POSITIVE CONTROL. That
 * shape is deliberate: an arm reachable only through a real `/proc` read or a live daemon is a
 * line no test can cover, and `diff-coverage` blocks a diff whose added lines have no covering
 * test — which stopped four PRs on the day this was written.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readCheckoutDepth } from "../src/run-task.js";

import {
  DOCTOR_USAGE_EXIT,
  classifyReadFailure,
  readMemInfo,
  buildDoctorReport,
  exitCodeFor,
  judgeDiskHeadroom,
  judgeDispatchStall,
  judgeDispatchStarvation,
  judgeLaneLessWorkers,
  judgeLedgerFreshness,
  judgeLockDivergence,
  judgeCheckoutDepth,
  judgeMemory,
  judgePauseHonoured,
  judgeRepairStall,
  judgeStaleGitLocks,
  judgeSweepLiveness,
  parseMemInfo,
  readAlivePhases,
  readCurrentRunAlivePhases,
  readGitLocks,
  readLedgerAgeMs,
  readPauseAgeMs,
  readSweepPassSummaryTimestamps,
  refuseUnsupportedArgs,
  renderDoctor,
  SWEEP_LIVENESS_STEPS,
  worstVerdict,
  type Check,
} from "../src/lib/doctor.js";

const MIN = 60_000;

function aliveRow(phase: string, ts: string): Record<string, unknown> {
  return { step: "daemon.alive", phase, ts, poll_interval_ms: 300_000 };
}

// A HEALTHY sweep.pass/sweep.summary pair, so every PRE-EXISTING test below (none of which is
// about sweep-liveness) keeps testing what it always tested, rather than incidentally tripping
// the new arm's zero-rows WARN (design note (3): zero sweep.pass rows is WARN, never OK).
function healthySweepRows(): Record<string, unknown>[] {
  return [
    { step: "sweep.pass", ts: "2026-08-20T11:50:00Z", enumerated: 3 },
    { step: "sweep.summary", ts: "2026-08-20T11:50:05Z" },
    { step: "sweep.pass", ts: "2026-08-20T11:55:00Z", enumerated: 2 },
    { step: "sweep.summary", ts: "2026-08-20T11:55:05Z" },
  ];
}

function baseInputs(over: Partial<Parameters<typeof buildDoctorReport>[0]> = {}): Parameters<typeof buildDoctorReport>[0] {
  const now = Date.parse("2026-08-20T12:00:00Z");
  return {
    nowMs: now,
    ledgerLines: [aliveRow("dispatch", "2026-08-20T11:59:00Z"), ...healthySweepRows()],
    candidateCount: 0,
    mem: { availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, swapTotalBytes: 2 * 1024 ** 3 },
    diskFreeBytes: 40 * 1024 ** 3,
    totalLocks: 0,
    deadLocks: [],
    gitLocks: [],
    workerCount: 0,
    // W1-T2332: a healthy, full checkout by default — same discipline as `gitLocks: []` above —
    // so every PRE-EXISTING test below (none of which is about checkout depth) keeps testing
    // what it always tested rather than incidentally tripping the new arm's unreadable-by-default
    // WARN (judgeCheckoutDepth never reads an absent measurement as healthy).
    checkoutDepth: { shallow: false, commitCount: 980 },
    ...over,
  };
}

// ── criterion 1 — the stall check, with no network read ───────────────────────────────────────

test("doctor: a non-empty eligible pool past the dispatch bound is a FAIL", () => {
  const stalled = judgeDispatchStall(3, 90 * MIN, 30 * MIN, "3x the widest observed gap");
  assert.equal(stalled.verdict, "FAIL");
  assert.match(stalled.measured, /3 eligible/);
  assert.match(stalled.measured, /nothing dispatched in/);
  assert.match(stalled.threshold, /3x the widest observed gap/, "the bound explains its own derivation, never a round figure");

  // POSITIVE CONTROL: the same pool INSIDE the bound is OK, so FAIL comes from the age and not
  // merely from having candidates.
  assert.equal(judgeDispatchStall(3, 10 * MIN, 30 * MIN).verdict, "OK");
  // …and an empty pool is OK however old the last dispatch is — a quiet queue is not a stall.
  assert.equal(judgeDispatchStall(0, 900 * MIN, 30 * MIN).verdict, "OK");
  // …and an unknown bound degrades to WARN rather than inventing one.
  assert.equal(judgeDispatchStall(3, 90 * MIN, undefined).verdict, "WARN");
});

// ── W1-T1209 — the repair-rung stall, a sibling of dispatch-stall ──────────────────────────────
//
// `fix.dispatch` read ZERO for twenty-one hours on 2026-08-22 while the sweep kept disposing open
// pull requests `blocked-fixable` every pass, and nothing anywhere said the repair rung was down.
// Each test below is one of the shard's five named acceptance claims.

test("W1-T1209: candidates with no dispatch in the derived window read FAIL", () => {
  const stalled = judgeRepairStall(4, 90 * MIN, 30 * MIN, "3x the widest observed fix.dispatch gap");
  assert.equal(stalled.verdict, "FAIL");
  assert.match(stalled.measured, /4 disposed blocked-fixable/);
  assert.match(stalled.measured, /nothing dispatched in/);
  assert.match(stalled.threshold, /3x the widest observed fix\.dispatch gap/, "the bound explains its own derivation, never a round figure");

  // POSITIVE CONTROL: the same disposals INSIDE the bound are OK, so FAIL comes from the age and
  // not merely from a nonzero disposed count.
  assert.equal(judgeRepairStall(4, 10 * MIN, 30 * MIN).verdict, "OK");
  // an unknown bound degrades to WARN rather than inventing one.
  assert.equal(judgeRepairStall(4, 90 * MIN, undefined).verdict, "WARN");
  // an unknown dispatch age degrades to WARN too, even with a known bound.
  assert.equal(judgeRepairStall(4, undefined, 30 * MIN).verdict, "WARN");
});

test("W1-T1209: an empty repair queue with no dispatch reads OK", () => {
  // THE CONJUNCTION'S OWN FALSIFIER (design note iii): without this case the arm is a bare gap
  // detector, and the first quiet weekend retires it as a false alarm.
  const quiet = judgeRepairStall(0, 900 * MIN, 30 * MIN);
  assert.equal(quiet.verdict, "OK");
  assert.match(quiet.measured, /^0 blocked-fixable disposal\(s\)/);

  // even with no dispatch EVER and no bound at all, an empty queue stays OK — nothing was chosen
  // for repair, so a gap in `fix.dispatch` measures nothing.
  assert.equal(judgeRepairStall(0, undefined, undefined).verdict, "OK");
});

test("W1-T1209: the repair-stall bound is derived and its derivation is printed", () => {
  const derived = judgeRepairStall(2, 40 * MIN, 20 * MIN, "3x the widest observed fix.dispatch gap (host-observed cadence)");
  assert.match(derived.threshold, /3x the widest observed fix\.dispatch gap \(host-observed cadence\)/, "the printed threshold carries its own derivation, never a bare number");
  assert.match(derived.threshold, /20m/, "the bound itself is printed beside its derivation");

  // no derivation string supplied still prints the bound on its own — the caller MAY omit prose,
  // but the number itself is never hidden.
  assert.match(judgeRepairStall(2, 40 * MIN, 20 * MIN).threshold, /20m/);
  // no bound at all says so rather than guessing one — this arm carries no hardcoded ceiling.
  assert.equal(judgeRepairStall(2, 40 * MIN, undefined).threshold, "no observed cadence yet");
});

test("W1-T1209: the repair-stall arm performs no action of its own", () => {
  const fail = judgeRepairStall(3, 90 * MIN, 30 * MIN, "derivation");
  assert.equal(fail.verdict, "FAIL");
  // REPORT ONLY (design note iv): the FAIL detail cites the owners of the contention and the dedup
  // gate rather than clearing either, and never a fix-dispatch/escalate verb of its own.
  assert.match(fail.detail!, /W1-T1129/);
  assert.match(fail.detail!, /W1-T1127/);
  assert.match(fail.detail!, /doctor only reports/);

  // PURITY AS THE PROOF OF "NO ACTION": a function with a side effect (a dispatch, a gate clear, an
  // escalation) is not idempotent on identical inputs in a test process free of that state: it would
  // either throw on the second call (a gate already cleared) or leave visible residue. Calling it
  // twice with the same inputs yields a byte-identical Check both times.
  assert.deepEqual(judgeRepairStall(3, 90 * MIN, 30 * MIN, "derivation"), fail);
  assert.deepEqual(judgeRepairStall(3, 90 * MIN, 30 * MIN, "derivation"), fail);
});

test("W1-T1209: the existing doctor arms are unchanged", () => {
  const report = buildDoctorReport(baseInputs());
  assert.ok(report.checks.some((c) => c.name === "repair-stall"), "the new arm is wired into the composed report");

  // every pre-existing arm's verdict is exactly what it was before this addition. A caller that
  // does not yet supply a real `blocked-fixable`-disposal count (run-task.ts's real reader is a
  // separate, out-of-scope task per the shard's design note v) defaults to 0, so the new arm reads
  // OK and disturbs nothing else in the report.
  const preExisting = [
    "ledger-freshness",
    "dispatch-stall",
    "dispatch-liveness",
    "pause-honoured",
    "lock-vs-process",
    "lane-less-workers",
    "git-locks",
    "disk-headroom",
    "memory",
  ];
  for (const name of preExisting) {
    const check = report.checks.find((c) => c.name === name);
    assert.ok(check, `${name} is still present in the composed report`);
    assert.equal(check!.verdict, "OK", `${name}'s verdict is unaffected by the new repair-stall arm`);
  }
  assert.equal(report.worst, "OK");
  assert.equal(report.exitCode, 0);
  // +3, not +2: W1-T1236 lands a SECOND new arm (sweep-liveness) after this test's own baseline,
  // and W1-T2332 a THIRD (checkout-depth) later still — this file's own baseInputs() carries a
  // healthy sweep.pass/sweep.summary pair and a full checkoutDepth, so both read OK.
  assert.equal(report.checks.length, preExisting.length + 3, "repair-stall, sweep-liveness and checkout-depth all joined the report");
});

// ── W1-T1236 — sweep liveness: a reader for `sweep.pass`, the per-pass heartbeat nothing read ──
//
// `sweep.pass` is written BEFORE `runSweep`'s per-PR loop runs, exactly so a pass that throws
// mid-loop still leaves a row — and until this arm, nothing consumed it. Each test below is one of
// the shard's eight named acceptance claims.

test("W1-T1236: a stale sweep.pass reads non-OK with its measured age", () => {
  const t0 = Date.parse("2026-08-20T11:00:00Z");
  const t1 = Date.parse("2026-08-20T11:10:00Z"); // a 10-minute observed gap ⇒ a 30-minute bound
  const nowMs = t1 + 40 * MIN; // 40 minutes past the newest pass — past the derived bound

  const stale = judgeSweepLiveness([t0, t1], [t1 + 1000], nowMs);
  assert.equal(stale.verdict, "WARN");
  assert.match(stale.measured, /40m/, "the measured age is named, never a bare non-OK verdict");
  assert.match(stale.threshold, /longest observed gap between sweep\.pass rows/, "the bound explains its own derivation, never a round figure");

  // POSITIVE CONTROL: the identical cadence, well inside the bound, is OK — non-OK comes from the
  // age and not merely from sweep.pass rows existing at all.
  const fresh = judgeSweepLiveness([t0, t1], [t1 + 1000], t1 + 5 * MIN);
  assert.equal(fresh.verdict, "OK");
});

test("W1-T1236: a pass with no summary after it reads non-OK", () => {
  const passTs = Date.parse("2026-08-20T11:55:00Z");
  const summaryBeforeTs = Date.parse("2026-08-20T11:50:00Z"); // BEFORE the pass — does not cover it
  const nowMs = passTs + MIN;

  const unfinished = judgeSweepLiveness([passTs], [summaryBeforeTs], nowMs);
  assert.equal(unfinished.verdict, "WARN");
  assert.match(unfinished.measured, /no sweep\.summary at or after it/);
  assert.match(unfinished.detail!, /written BEFORE the loop/);

  // POSITIVE CONTROL: a summary at the SAME instant as the pass already counts as covering it —
  // pairing is BY TIME ORDER, never a correlation id (design note (2b)).
  const finished = judgeSweepLiveness([passTs], [passTs], nowMs);
  assert.equal(finished.verdict, "OK");
});

test("W1-T1236: a pass followed by its own summary reads OK", () => {
  const t0 = Date.parse("2026-08-20T11:50:00Z");
  const t1 = Date.parse("2026-08-20T11:55:00Z");
  const summary0 = t0 + 5_000;
  const summary1 = t1 + 5_000;
  const nowMs = t1 + MIN;

  const healthy = judgeSweepLiveness([t0, t1], [summary0, summary1], nowMs);
  assert.equal(healthy.verdict, "OK");
  assert.match(healthy.measured, /finished by its own sweep\.summary/);

  // wired end to end through the reader, on real ledger-line shapes
  const lines = [
    { step: "sweep.pass", ts: new Date(t0).toISOString(), enumerated: 5 },
    { step: "sweep.summary", ts: new Date(summary0).toISOString() },
    { step: "sweep.pass", ts: new Date(t1).toISOString(), enumerated: 4 },
    { step: "sweep.summary", ts: new Date(summary1).toISOString() },
  ];
  const rows = readSweepPassSummaryTimestamps(lines);
  assert.equal(rows.passesMs.length, 2);
  assert.equal(rows.summariesMs.length, 2);
  assert.equal(judgeSweepLiveness(rows.passesMs, rows.summariesMs, nowMs).verdict, "OK");
});

test("W1-T1236: zero sweep.pass rows read WARN and never OK", () => {
  const unknown = judgeSweepLiveness([], [], Date.parse("2026-08-20T12:00:00Z"));
  assert.equal(unknown.verdict, "WARN");
  assert.match(unknown.measured, /UNKNOWN/);
  assert.notEqual(unknown.verdict, "OK");

  // a sweep.summary with no sweep.pass at all is the identical shape — sweep.summary alone proves
  // nothing about sweep.pass's own liveness (design note (3)).
  const onlySummary = judgeSweepLiveness([], [Date.parse("2026-08-20T11:59:00Z")], Date.parse("2026-08-20T12:00:00Z"));
  assert.equal(onlySummary.verdict, "WARN");

  // and wired through the reader on an empty ledger
  assert.deepEqual(readSweepPassSummaryTimestamps([]), { passesMs: [], summariesMs: [] });
});

test("W1-T1236: the sweep-liveness arm performs no action of its own", () => {
  const t0 = Date.parse("2026-08-20T11:50:00Z");
  const t1 = Date.parse("2026-08-20T11:55:00Z");
  const nowMs = t1 + 90 * MIN; // comfortably past the derived 15-minute bound

  const stale = judgeSweepLiveness([t0, t1], [], nowMs);
  assert.equal(stale.verdict, "WARN");
  assert.match(stale.detail!, /doctor only reports/);

  // PURITY AS THE PROOF OF "NO ACTION" (mirrors W1-T1209's own test): a function with a side
  // effect is not idempotent on identical inputs in a test process free of that state — it would
  // either throw on a second call or leave visible residue. Calling it twice with the same inputs
  // yields a byte-identical Check both times.
  assert.deepEqual(judgeSweepLiveness([t0, t1], [], nowMs), stale);
  assert.deepEqual(judgeSweepLiveness([t0, t1], [], nowMs), stale);
});

test("W1-T1236: buildDoctorReport wires the sweep-liveness arm into the composed report", () => {
  const report = buildDoctorReport(baseInputs());
  const check = report.checks.find((c) => c.name === "sweep-liveness");
  assert.ok(check, "sweep-liveness must actually appear in the composed report, not merely be defined and unreached");
  assert.equal(check!.verdict, "OK", "the healthy fixture pair in baseInputs() reads OK");

  // CONTROL: strip the sweep rows back out and the SAME composed report reads the arm as WARN,
  // proving buildDoctorReport really threads ledgerLines through to the new arm rather than a stub.
  const blind = buildDoctorReport(baseInputs({ ledgerLines: [aliveRow("dispatch", "2026-08-20T11:59:00Z")] }));
  assert.equal(blind.checks.find((c) => c.name === "sweep-liveness")!.verdict, "WARN");
});

test("W1-T1236: the arm reads the ledger through its exported boundary marker", () => {
  assert.deepEqual([...SWEEP_LIVENESS_STEPS].sort(), ["sweep.pass", "sweep.summary"]);

  // a step NOT named in the marker must never contribute, even one that superficially resembles a
  // sweep step — the marker is the ONLY place either string literal is compared against.
  const rows = readSweepPassSummaryTimestamps([
    { step: "sweep.disposed", ts: "2026-08-20T11:55:00Z" },
    { step: "sweep.pass", ts: "2026-08-20T11:56:00Z" },
  ]);
  assert.equal(rows.passesMs.length, 1);
  assert.equal(rows.summariesMs.length, 0);
});

test("W1-T1236: the existing doctor arms are unchanged", () => {
  const report = buildDoctorReport(baseInputs());
  assert.ok(report.checks.some((c) => c.name === "sweep-liveness"), "the new arm is wired into the composed report");

  const preExisting = [
    "ledger-freshness",
    "dispatch-stall",
    "repair-stall",
    "dispatch-liveness",
    "pause-honoured",
    "lock-vs-process",
    "lane-less-workers",
    "git-locks",
    "disk-headroom",
    "memory",
  ];
  for (const name of preExisting) {
    const check = report.checks.find((c) => c.name === name);
    assert.ok(check, `${name} is still present in the composed report`);
    assert.equal(check!.verdict, "OK", `${name}'s verdict is unaffected by the new sweep-liveness arm`);
  }
  assert.equal(report.worst, "OK");
  assert.equal(report.exitCode, 0);
  // +2, not +1: W1-T2332 lands a further new arm (checkout-depth) after this test's own baseline —
  // this file's own baseInputs() carries a healthy, full checkoutDepth, so it reads OK.
  assert.equal(report.checks.length, preExisting.length + 2, "sweep-liveness and checkout-depth both joined the report");
});

// ── criterion 2 — dispatch starvation, a reader for a field nothing read ───────────────────────

test("doctor: consecutive alive rows in sweep phase report dispatch starvation", () => {
  const starved = judgeDispatchStarvation(["sweep", "sweep", "sweep"]);
  assert.equal(starved.verdict, "WARN");
  assert.match(starved.measured, /sweep, sweep, sweep/);

  // POSITIVE CONTROL: one dispatch among them clears it, so the arm keys on the phases and not on
  // the row count.
  assert.equal(judgeDispatchStarvation(["sweep", "dispatch", "sweep"]).verdict, "OK");
  // Too few rows to judge is OK, not a WARN — a just-booted daemon is not starving.
  assert.equal(judgeDispatchStarvation(["sweep"]).verdict, "OK");

  // and the reader picks the phases out of real ledger rows, ignoring everything else
  const phases = readAlivePhases([aliveRow("sweep", "t1"), { step: "verdict", phase: "nope" }, aliveRow("dispatch", "t2")]);
  assert.deepEqual(phases, ["sweep", "dispatch"], "only daemon.alive rows contribute a phase");
});

// ── W1-T1099 — the predicate must match its own printed threshold ──────────────────────────────

test("W1-T1099: a window with no dispatch phase is starved whatever the phases are", () => {
  // MEASURED (rationale (1)): `retro, retro, retro` passed the OLD predicate, which checked
  // literally for `sweep` and nothing else — a threshold string promising "some dispatch phase"
  // enforced by a rule that only ever looked for one hardcoded non-dispatch phase.
  assert.equal(judgeDispatchStarvation(["retro", "retro", "retro"]).verdict, "WARN");
  assert.equal(judgeDispatchStarvation(["sweep", "sweep", "sweep"]).verdict, "WARN");
  assert.equal(judgeDispatchStarvation(["sweep", "retro", "sweep"]).verdict, "WARN", "a mix of non-dispatch phases must still warn");
});

test("W1-T1099: a window containing a dispatch phase is still healthy", () => {
  assert.equal(judgeDispatchStarvation(["sweep", "dispatch", "retro"]).verdict, "OK");
  assert.equal(judgeDispatchStarvation(["dispatch", "dispatch", "dispatch"]).verdict, "OK");
});

test("W1-T1099: a replaced run's phases are not judged as the current run's", () => {
  // MEASURED (rationale (2)): a run that stopped cleanly 90 minutes ago left daemon.alive rows
  // behind; the CURRENT run has written a daemon.-prefixed row of its own but no daemon.alive row
  // yet. Reading unfiltered would judge the dead run's `sweep, sweep, sweep` as if it were live.
  const replaced = (ts: string) => ({ step: "daemon.alive", phase: "sweep", ts, run_id: "DAEMON-OLD" });
  const currentTick = { step: "daemon.iteration", ts: "2026-08-21T13:49:45Z", run_id: "DAEMON-NEW" };
  const lines = [replaced("2026-08-21T11:07:00Z"), replaced("2026-08-21T11:07:05Z"), replaced("2026-08-21T11:07:10Z"), currentTick];

  const phases = readCurrentRunAlivePhases(lines);
  assert.deepEqual(phases, [], "the replaced run's rows belong to DAEMON-OLD, not the current DAEMON-NEW run");

  // and wired through the judge, the replaced run's `sweep, sweep, sweep` must NOT read as OK —
  // it must not be seen at all, which is a stronger guarantee than merely re-judging it starved.
  assert.equal(judgeDispatchStarvation(readAlivePhases(lines).slice(-3)).verdict, "WARN", "control: unfiltered, the old run's own rows are starved too");
  assert.equal(judgeDispatchStarvation(phases).verdict, "WARN", "current run: unknown, not the old run's healthy-looking OK");
});

test("W1-T1099: a current run with no alive rows reports unknown", () => {
  assert.equal(judgeDispatchStarvation([]).verdict, "WARN");
  assert.match(judgeDispatchStarvation([]).measured, /UNKNOWN/);
  // POSITIVE CONTROL: this must not be OK — the old form's "too few rows" branch degraded silently
  // to healthy, which is the false-green rationale (iii) names.
  assert.notEqual(judgeDispatchStarvation([]).verdict, "OK");

  // wired end to end: a live daemon that has written its own daemon.-prefixed row this run, but has
  // declined every candidate and so never entered a rung, writes zero daemon.alive rows (rationale
  // (3): startInFlightTicker wraps a rung's body, not the tick).
  const lines = [{ step: "daemon.iteration", ts: "2026-08-21T13:49:45Z", run_id: "DAEMON-NEW" }];
  const phases = readCurrentRunAlivePhases(lines);
  assert.deepEqual(phases, []);
  assert.equal(judgeDispatchStarvation(phases).verdict, "WARN");
});

// ── criterion 3 — ledger freshness, needing no daemon ─────────────────────────────────────────

test("doctor: ledger freshness is measured from the newest row and needs no daemon", () => {
  const stale = judgeLedgerFreshness(30 * MIN, 10 * MIN);
  assert.equal(stale.verdict, "FAIL");
  assert.match(stale.measured, /30m/);
  assert.match(stale.threshold, /10m/);

  // POSITIVE CONTROL: inside the bound is OK, so FAIL is the age and not the check always firing.
  assert.equal(judgeLedgerFreshness(5 * MIN, 10 * MIN).verdict, "OK");

  // A DOWN DAEMON IS THE DIAGNOSIS, NOT AN ERROR: no row at all is a printable FAIL, and the
  // command does not throw.
  const none = judgeLedgerFreshness(undefined, 10 * MIN);
  assert.equal(none.verdict, "FAIL");
  assert.match(none.measured, /no daemon row/);
});

// ── W1-T1274 — the liveness corpus rests on a false assumption, corrected ─────────────────────
//
// MEASURED (rationale (3)/(5)): the `daemon.`-prefix went silent for 102.5 minutes on 2026-08-23
// while the daemon stayed alive, because its only RECURRING emitter (`daemon.alive`) is a ticker
// confined to three windows (retro, full sweep, dispatch settling) — every stretch of the loop
// outside those three (plain inter-iteration sleep, or an early return at this very freshness
// check) wrote nothing with the prefix at all. The fix is an unconditional `daemon.tick` row
// (`daemon.ts`'s `runDaemon` loop, first statement of every iteration, every path) that joins the
// SAME `daemon.`-prefixed corpus `readLedgerAgeMs`/`deriveLastPoll` already read — never narrowed
// to `daemon.tick` alone, never widened to a `run_id` (rationale (7)/(8)).

const REAL_POLL_INTERVAL_MS = 60_000; // the live daemon's own observed poll_interval_ms (rationale (2))
const REAL_BOUND_MS = REAL_POLL_INTERVAL_MS * 2; // the derived two-minute bound

function tickRow(ts: string): Record<string, unknown> {
  return { step: "daemon.tick", ts, poll_interval_ms: REAL_POLL_INTERVAL_MS };
}

test("W1-T1274: a daemon alive but outside every ticker window is not reported as failed", () => {
  // Ten minutes of iterations, one minute apart, none of them inside a ticker window — no
  // `daemon.alive`, no boot row, nothing but the new unconditional per-iteration row. This is
  // exactly the shape rationale (5) names: "the inter-iteration await deps.sleep(...)... and
  // every iteration that returns at the freshness check before the sweep ticker is ever started".
  const now = Date.parse("2026-08-23T16:30:00.000Z");
  const lines: Record<string, unknown>[] = [];
  for (let i = 10; i >= 0; i--) {
    lines.push(tickRow(new Date(now - i * MIN).toISOString()));
  }
  const { ageMs, boundMs } = readLedgerAgeMs(lines, now);
  assert.equal(boundMs, REAL_BOUND_MS);
  assert.ok(ageMs !== undefined && ageMs <= REAL_BOUND_MS, `age ${ageMs}ms must be inside the ${REAL_BOUND_MS}ms bound`);
  assert.equal(judgeLedgerFreshness(ageMs, boundMs).verdict, "OK", "alive-but-ticker-silent must not FAIL");

  // CONTROL, PRE-FIX SHAPE: strip the unconditional row and leave only a boot-time one-shot row
  // from ten minutes ago (the OLD corpus, as measured — rationale (3)) — the same silence now
  // correctly FAILs, proving the OK above comes from the new row and not from a widened bound.
  const preFixLines = [{ step: "daemon.boot", ts: new Date(now - 10 * MIN).toISOString(), poll_interval_ms: REAL_POLL_INTERVAL_MS }];
  const preFix = readLedgerAgeMs(preFixLines, now);
  assert.equal(judgeLedgerFreshness(preFix.ageMs, preFix.boundMs).verdict, "FAIL", "control: without the new row, the same gap still reads as it measurably did before this fix");
});

test("W1-T1274: a daemon that is genuinely gone is still reported as failed at the same bound", () => {
  // The tick rows simply stop — no process is alive to write the next one.
  const now = Date.parse("2026-08-23T16:30:00.000Z");
  const lines = [tickRow(new Date(now - 10 * MIN).toISOString()), tickRow(new Date(now - 5 * MIN).toISOString())];
  const { ageMs, boundMs } = readLedgerAgeMs(lines, now);
  assert.equal(boundMs, REAL_BOUND_MS, "the bound is unchanged by this fix — still 2x the observed poll interval");
  assert.equal(judgeLedgerFreshness(ageMs, boundMs).verdict, "FAIL", "5 minutes of silence past a 2-minute bound is still a genuine FAIL");
});

test("W1-T1274: rows written by a worker after the daemon is gone do not keep the check green", () => {
  // MEASURED (rationale (4)/(8)): worker rows inherit the daemon's OWN run_id but never its
  // `daemon.`-prefixed step names — `pr.polling`, `fix.dispatch`, `review.posted`, etc. A lane
  // still writing after the daemon died must read as what it is, not as a live daemon.
  const now = Date.parse("2026-08-23T16:30:00.000Z");
  const lastRealTick = new Date(now - 10 * MIN).toISOString();
  const lines: Record<string, unknown>[] = [tickRow(lastRealTick)];
  for (let i = 9; i >= 1; i--) {
    lines.push({ step: "pr.polling", ts: new Date(now - i * MIN).toISOString(), run_id: "DAEMON-1787493725647" });
  }
  const { ageMs, boundMs } = readLedgerAgeMs(lines, now);
  assert.equal(ageMs, now - Date.parse(lastRealTick), "age is measured from the last daemon.-prefixed row, ignoring every worker row after it");
  assert.equal(judgeLedgerFreshness(ageMs, boundMs).verdict, "FAIL", "9 minutes of worker-only rows must not read as a live daemon");
});

test("W1-T1274: the absent-corpus detail names the rows the check actually looks for", () => {
  const none = judgeLedgerFreshness(undefined, REAL_BOUND_MS);
  assert.match(none.detail!, /daemon\.tick/, "the detail names the per-iteration row an operator should expect");
  assert.match(none.detail!, /daemon\./, "and still names the wider daemon.-prefixed corpus it falls back to");
});

// ── criterion 4 — every check prints its value beside its threshold ────────────────────────────

test("doctor: every check prints its measured value beside its threshold", () => {
  const report = buildDoctorReport(baseInputs());
  assert.ok(report.checks.length > 0, "control: the report actually produced checks");
  for (const c of report.checks) {
    assert.ok(c.measured.length > 0, `${c.name} must print what it measured`);
    assert.ok(c.threshold.length > 0, `${c.name} must print what it was judged against`);
    assert.match(report.text, new RegExp(`${c.name}\\s+measured: `), `${c.name}'s line carries its value, never a bare verdict`);
    assert.match(report.text, new RegExp(`threshold: `), `${c.name}'s line carries its threshold`);
  }
});

// ── criterion 5 — the summary line and the exit code agree ─────────────────────────────────────

test("doctor: the summary line and the exit code agree on the worst verdict", () => {
  const ok = buildDoctorReport(baseInputs());
  assert.equal(ok.worst, "OK");
  assert.equal(ok.exitCode, 0);
  assert.match(ok.text.split("\n")[0]!, /^rmd doctor: OK/);

  // one WARN → 1
  const warn = buildDoctorReport(baseInputs({ gitLocks: [{ path: "/r/.git/index.lock", ageMs: 5 * MIN }] }));
  assert.equal(warn.worst, "WARN");
  assert.equal(warn.exitCode, 1);
  assert.match(warn.text.split("\n")[0]!, /^rmd doctor: WARN/);

  // one FAIL outranks the WARN → 2
  const fail = buildDoctorReport(baseInputs({
    gitLocks: [{ path: "/r/.git/index.lock", ageMs: 5 * MIN }],
    mem: { availableBytes: 512 * 1024 ** 2, totalBytes: 16 * 1024 ** 3, swapTotalBytes: 0 },
  }));
  assert.equal(fail.worst, "FAIL");
  assert.equal(fail.exitCode, 2);
  assert.match(fail.text.split("\n")[0]!, /^rmd doctor: FAIL/);

  // the summary is ONE line and names what went wrong — short enough for a cron subject
  assert.ok(fail.text.split("\n")[0]!.length < 200);
  assert.match(fail.text.split("\n")[0]!, /memory/);

  assert.equal(worstVerdict([]), "OK", "nothing measured is not a failure");
  assert.equal(exitCodeFor("WARN"), 1);
});

// ── criterion 6 — the verb registration dispatches into the doctor module ──────────────────────

test("doctor: the verb registration dispatches into the doctor module", async () => {
  const { doctorCommand } = await import("../src/run-task.js");
  const lines: string[] = [];
  const code = await doctorCommand([], {
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    loadConfig: () => ({ root: "/nonexistent-doctor-root" }) as never,
    nowMs: Date.parse("2026-08-20T12:00:00Z"),
    readLedgerLines: () => [aliveRow("dispatch", "2026-08-20T11:59:00Z"), ...healthySweepRows()],
    liveInflightRuns: () => [],
    readLockFiles: () => ({ locks: [] }),
    readMemInfo: () => ({ availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, swapTotalBytes: 2 * 1024 ** 3 }),
    readDiskFreeBytes: () => 40 * 1024 ** 3,
    readPauseAgeMs: () => undefined,
    readGitLocks: () => [],
    // W1-T2332: injected so this test's exit code never depends on whether the checkout THIS
    // suite happens to run in is shallow (e.g. a CI runner's shallow clone) — the same reason
    // every other reader above is injected rather than left to hit the real filesystem/git.
    readCheckoutDepth: () => ({ shallow: false, commitCount: 980 }),
  });
  assert.equal(code, 0, "a healthy local read exits 0");
  assert.match(lines.join("\n"), /^rmd doctor: OK/m, "the command printed the module's own report");

  // NO NETWORK: the command took no gateway, no token and no gh seam — there is nowhere for a
  // GitHub read to enter, which is the constraint this whole task exists for.
  assert.equal(lines.join("\n").includes("gh "), false);
});

// ── W1-T1109 — lock-vs-process must key on the TASK id, never the RUN id ──────────────────────
//
// MEASURED: `doctorCommand` built `liveIds` from `live.map((r) => r.runId)` (a RUN id, shaped
// `<taskId>-<epochMs>`) and then filtered lock FILE names (bare task ids) against it. A task id
// can never equal a run id, so every lock read as dead unconditionally — a live run's lock
// included. The fix keys `liveIds` on `r.taskId` instead, the one field `LiveInflightRun` already
// carries beside `runId`.

function doctorDoctorDeps(over: Record<string, unknown> = {}) {
  return {
    out: () => {},
    err: () => {},
    loadConfig: () => ({ root: "/nonexistent-doctor-root" }) as never,
    nowMs: Date.parse("2026-08-20T12:00:00Z"),
    readLedgerLines: () => [aliveRow("dispatch", "2026-08-20T11:59:00Z"), ...healthySweepRows()],
    readMemInfo: () => ({ availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, swapTotalBytes: 2 * 1024 ** 3 }),
    readDiskFreeBytes: () => 40 * 1024 ** 3,
    readPauseAgeMs: () => undefined,
    readGitLocks: () => [],
    // W1-T2332: same reasoning as the standalone verb-registration test above — a real, unstubbed
    // git read would make these tests' exit codes depend on the ambient checkout's actual depth.
    readCheckoutDepth: () => ({ shallow: false, commitCount: 980 }),
    ...over,
  };
}

test("W1-T1109: a live run's lock is not reported as stale", async () => {
  const { doctorCommand } = await import("../src/run-task.js");
  const lines: string[] = [];
  const code = await doctorCommand(
    [],
    doctorDoctorDeps({
      out: (l: string) => lines.push(l),
      err: (l: string) => lines.push(l),
      // the lock file is named for the TASK, and the live run reports that SAME task id — a
      // live worker, correctly recognised.
      liveInflightRuns: () => [{ taskId: "W1-T1100", runId: "W1-T1100-1755000000000", pid: 631772 }],
      readLockFiles: () => ({ locks: ["W1-T1100"] }),
    }),
  );
  assert.equal(code, 0, "a live run's lock must not fail the health check");
  const text = lines.join("\n");
  assert.match(text, /1 lock\(s\), 0 with no live pid/);
  assert.equal(text.includes("W1-T1100"), false, "a live lock must not be NAMED as stale");
});

test("W1-T1109: a lock with no live run is still reported as stale", async () => {
  const { doctorCommand } = await import("../src/run-task.js");
  const lines: string[] = [];
  const code = await doctorCommand(
    [],
    doctorDoctorDeps({
      out: (l: string) => lines.push(l),
      err: (l: string) => lines.push(l),
      liveInflightRuns: () => [],
      readLockFiles: () => ({ locks: ["W1-T1200"] }),
    }),
  );
  assert.equal(code, 1, "a stale lock is a WARN, exit 1");
  const text = lines.join("\n");
  assert.match(text, /1 lock\(s\), 1 with no live pid/);
  assert.match(text, /W1-T1200/, "the stale lock is named");
});

test("W1-T1109: the comparison keys on the task id", async () => {
  // DISCRIMINATES ON THE KEY, NOT THE COUNT (design (ii)): one live run, one lock, SAME task id,
  // DIFFERENT run id from anything the lock filename could equal. The pre-fix comparison
  // (`liveIds` built from `runId`) would filter this lock as dead even though its run is live,
  // because a bare task id can never equal a `<taskId>-<epochMs>` run id. Zero dead is the only
  // outcome consistent with the run actually being live.
  const { doctorCommand } = await import("../src/run-task.js");
  const lines: string[] = [];
  await doctorCommand(
    [],
    doctorDoctorDeps({
      out: (l: string) => lines.push(l),
      err: (l: string) => lines.push(l),
      liveInflightRuns: () => [{ taskId: "W1-T1109", runId: "W1-T1109-1787342211470", pid: 999 }],
      readLockFiles: () => ({ locks: ["W1-T1109"] }),
    }),
  );
  assert.match(lines.join("\n"), /1 lock\(s\), 0 with no live pid/, "a task id must never be compared against a run id");
});

test("W1-T1109: the arm reports and reclaims nothing", async () => {
  // design (iv): doctor stays WARN-and-name. Confirm the fixed comparison still only NAMES the
  // stale lock in its output — no lock file is touched, no reclamation deps are consulted.
  const { doctorCommand } = await import("../src/run-task.js");
  const lines: string[] = [];
  let readLockFilesCalls = 0;
  const code = await doctorCommand(
    [],
    doctorDoctorDeps({
      out: (l: string) => lines.push(l),
      err: (l: string) => lines.push(l),
      liveInflightRuns: () => [],
      readLockFiles: () => {
        readLockFilesCalls += 1;
        return { locks: ["W1-T1300"] };
      },
    }),
  );
  assert.equal(code, 1, "reporting a stale lock never escalates past WARN's exit code");
  assert.equal(readLockFilesCalls, 1, "the lock directory is read exactly once — no repair pass, no re-read to clear it");
  assert.match(lines.join("\n"), /W1-T978 owns reclamation, doctor only reports/);
});

// ── the read-only refusal ─────────────────────────────────────────────────────────────────────

test("doctor: --fix is refused by name and says who owns each repair", async () => {
  const refusal = refuseUnsupportedArgs(["--fix"]);
  assert.ok(refusal, "--fix must be refused, not silently ignored");
  assert.match(refusal!, /READ-ONLY/);
  assert.match(refusal!, /#2251/);
  assert.match(refusal!, /W1-T1036/);
  assert.match(refusal!, /W1-T978/);

  // POSITIVE CONTROL: an accepted flag is not refused, so the refusal is not a blanket reject.
  assert.equal(refuseUnsupportedArgs(["--json"]), undefined);
  assert.equal(refuseUnsupportedArgs([]), undefined);
  // an unknown flag is a usage error with its own distinct exit code
  assert.match(refuseUnsupportedArgs(["--wat"])!, /unknown argument --wat/);

  const { doctorCommand } = await import("../src/run-task.js");
  const errs: string[] = [];
  const code = await doctorCommand(["--fix"], { err: (l) => errs.push(l), out: () => {} });
  assert.equal(code, DOCTOR_USAGE_EXIT, "a usage error must NOT collide with FAIL's exit 2");
  assert.notEqual(code, 2, "exit 2 must always mean a check failed, never a typo");
});

// ── the pause check earned on 2026-08-20 ──────────────────────────────────────────────────────

test("doctor: a pause held while dispatch continued is reported, not repaired", () => {
  // dispatch NEWER than the pause (smaller age) ⇒ the pause was not honoured
  const ignored = judgePauseHonoured(14 * MIN, 3 * MIN);
  assert.equal(ignored.verdict, "FAIL");
  assert.match(ignored.measured, /PAUSED 14m/);
  assert.match(ignored.measured, /last dispatch 3m ago/);
  assert.match(ignored.detail!, /W1-T1065/, "the tick defect is CITED, not fixed here");
  assert.match(ignored.detail!, /only reports/);

  // POSITIVE CONTROL: a pause with no dispatch after it is OK, so FAIL keys on the ordering.
  assert.equal(judgePauseHonoured(14 * MIN, 30 * MIN).verdict, "OK");
  // and no pause at all is OK
  assert.equal(judgePauseHonoured(undefined, 3 * MIN).verdict, "OK");
});

// ── memory: /proc/meminfo, never the cgroup limit ─────────────────────────────────────────────

test("doctor: memory is judged from MemAvailable and SwapTotal, never a cgroup limit", () => {
  const info = parseMemInfo(["MemTotal:       16000000 kB", "MemAvailable:     640000 kB", "SwapTotal:             0 kB"].join("\n"));
  assert.equal(info.totalBytes, 16_000_000 * 1024);
  assert.equal(info.availableBytes, 640_000 * 1024);
  assert.equal(info.swapTotalBytes, 0);

  // 4% available with zero swap — the measured freeze shape
  const frozen = judgeMemory(info.availableBytes, info.totalBytes, info.swapTotalBytes);
  assert.equal(frozen.verdict, "FAIL");
  assert.match(frozen.measured, /4\.0%/);
  assert.match(frozen.detail!, /NO swap/);
  assert.match(frozen.detail!, /never arms the OOM killer/);

  // POSITIVE CONTROL: healthy headroom is OK, so FAIL comes from the fraction.
  assert.equal(judgeMemory(8 * 1024 ** 3, 16 * 1024 ** 3, 2 * 1024 ** 3).verdict, "OK");
  assert.equal(judgeMemory(2.4 * 1024 ** 3, 16 * 1024 ** 3, 0).verdict, "WARN");
  // unreadable degrades to WARN and never throws
  assert.equal(judgeMemory(undefined, undefined, undefined).verdict, "WARN");
  assert.deepEqual(parseMemInfo("nothing useful here"), { availableBytes: undefined, totalBytes: undefined, swapTotalBytes: undefined });
});

// ── the remaining arms, each with its control ─────────────────────────────────────────────────

test("doctor: disk, locks, workers and git locks each judge against a printed threshold", () => {
  assert.equal(judgeDiskHeadroom(100 * 1024 ** 2).verdict, "FAIL");
  assert.equal(judgeDiskHeadroom(1024 ** 3).verdict, "WARN");
  assert.equal(judgeDiskHeadroom(40 * 1024 ** 3).verdict, "OK");
  assert.equal(judgeDiskHeadroom(undefined).verdict, "WARN", "unreadable is a WARN, never a crash");

  assert.equal(judgeLockDivergence(2, ["RUN-1"]).verdict, "WARN");
  assert.match(judgeLockDivergence(2, ["RUN-1"]).detail!, /W1-T978 owns reclamation/);
  assert.equal(judgeLockDivergence(2, []).verdict, "OK");

  assert.equal(judgeLaneLessWorkers(8000, 1).verdict, "WARN");
  assert.match(judgeLaneLessWorkers(8000, 1).threshold, /#2251/, "the threshold cites where it came from");
  assert.equal(judgeLaneLessWorkers(60, 1).verdict, "OK");
  assert.equal(judgeLaneLessWorkers(undefined, 0).verdict, "OK");

  assert.equal(judgeStaleGitLocks([{ path: "/r/.git/index.lock", ageMs: MIN }]).verdict, "WARN");
  assert.match(judgeStaleGitLocks([{ path: "/r/.git/index.lock", ageMs: MIN }]).detail!, /W1-T1036 owns reclamation/);
  assert.equal(judgeStaleGitLocks([]).verdict, "OK");
});

// ── W1-T2332 — checkout-depth: the history horizon nothing proactive asked about ────────────
//
// A shallow canonical checkout breaks every history read SILENTLY: `git log -S`, `--follow` and
// merge-base checks all stay plausible over a truncated corpus (docs/operator-guide.md's own
// measurement — a 120-commit clone answered ZERO deletions for a file deleted before its horizon,
// with the "does this query return rows" control passing loudly). The prior fleet detector was
// `defaultMergeEvidenceLog`/`defaultVerdictCalibrationGitLog` REFUSING BY NAME, which only speaks
// when a linter that needs history happens to run — this arm asks proactively. Each test below is
// one of the shard's checkout-depth acceptance claims.

test("W1-T2332: a shallow checkout is a FAIL naming the reachable commit count and the remedy command", () => {
  const shallow = judgeCheckoutDepth({ shallow: true, commitCount: 208 });
  assert.equal(shallow.verdict, "FAIL", "FAIL rather than WARN is deliberate — invisible by construction, remedy is one command");
  assert.match(shallow.measured, /shallow/);
  assert.match(shallow.measured, /208/, "the reachable commit count is named, never a bare non-OK verdict");
  assert.match(shallow.detail!, /git fetch --unshallow/, "the remedy command is named in the operator-guide's own words");

  // POSITIVE CONTROL: the identical shape but full reads OK — FAIL comes from shallow-ness, not
  // merely from a checkout-depth measurement existing at all.
  assert.equal(judgeCheckoutDepth({ shallow: false, commitCount: 208 }).verdict, "OK");
});

test("W1-T2332: a measurement that could not be taken reports UNREADABLE rather than healthy — never OK", () => {
  const unreadable = judgeCheckoutDepth(undefined);
  assert.equal(unreadable.verdict, "WARN");
  assert.match(unreadable.measured, /unreadable/);
  assert.notEqual(unreadable.verdict, "OK", "a read that FAILED must never report as a read that SAID NO (W1-T472 design (v))");
});

test("W1-T2332: a full checkout still prints its reachable commit count so the horizon is legible when it is fine", () => {
  const full = judgeCheckoutDepth({ shallow: false, commitCount: 2461 });
  assert.equal(full.verdict, "OK");
  assert.match(full.measured, /2461/, "the horizon is printed even though nothing is wrong — the operator-guide's own prescription");
});

test("W1-T2332: the arm is report-only — it repairs nothing, fetches nothing, and changes no exit path other than its own verdict", () => {
  const shallow = judgeCheckoutDepth({ shallow: true, commitCount: 100 });
  // PURITY AS THE PROOF OF "NO ACTION" (mirrors judgeRepairStall's/judgeSweepLiveness's own
  // tests): a function with a side effect (an unshallow fetch) is not idempotent on identical
  // inputs in a test process free of that state. Calling it twice yields a byte-identical Check.
  assert.deepEqual(judgeCheckoutDepth({ shallow: true, commitCount: 100 }), shallow);
  assert.deepEqual(judgeCheckoutDepth({ shallow: true, commitCount: 100 }), shallow);
  assert.match(shallow.detail!, /doctor reports and stops/);
  assert.match(shallow.detail!, /nothing here unshallows anything/);
});

test("W1-T2332: the verdict is a pure function over measured inputs, callable with no git and no live process", () => {
  // No filesystem, no execFileSync, no daemon — every arm reachable by calling one function with
  // one set of plain numbers, exactly this file's own header discipline for every judge* above.
  assert.equal(judgeCheckoutDepth({ shallow: true, commitCount: 0 }).verdict, "FAIL");
  assert.equal(judgeCheckoutDepth({ shallow: false, commitCount: 1 }).verdict, "OK");
  assert.equal(judgeCheckoutDepth(undefined).verdict, "WARN");
});

test("W1-T2332: buildDoctorReport wires checkout-depth into the composed report, and a shallow checkout is the report's own FAIL", () => {
  const healthy = buildDoctorReport(baseInputs());
  const healthyCheck = healthy.checks.find((c) => c.name === "checkout-depth");
  assert.ok(healthyCheck, "checkout-depth must actually appear in the composed report, not merely be defined and unreached");
  assert.equal(healthyCheck!.verdict, "OK", "baseInputs()'s full, deep checkoutDepth reads OK");
  assert.equal(healthy.worst, "OK");

  // CONTROL: swap in a shallow measurement and the SAME composed report reads FAIL end to end —
  // proving buildDoctorReport really threads checkoutDepth through, never a stub.
  const shallow = buildDoctorReport(baseInputs({ checkoutDepth: { shallow: true, commitCount: 208 } }));
  assert.equal(shallow.checks.find((c) => c.name === "checkout-depth")!.verdict, "FAIL");
  assert.equal(shallow.worst, "FAIL");
  assert.equal(shallow.exitCode, 2);

  // CONTROL: an absent measurement reads WARN through the same composed path, never OK.
  const unreadable = buildDoctorReport(baseInputs({ checkoutDepth: undefined }));
  assert.equal(unreadable.checks.find((c) => c.name === "checkout-depth")!.verdict, "WARN");
});

test("doctor: the state readers degrade to a stated unknown rather than throwing", () => {
  // an absent PAUSE is 'not paused', not an error
  assert.equal(readPauseAgeMs("/nonexistent-doctor-root", Date.now()), undefined);
  // an unreadable git dir yields no locks rather than a fabricated WARN
  assert.deepEqual(readGitLocks("/nonexistent-doctor-root", Date.now()), []);

  // POSITIVE CONTROL: with injected fs the same readers DO produce values, so the zeros above are
  // real absence and not a reader that never works.
  const now = 10 * MIN;
  assert.equal(readPauseAgeMs("/r", now, () => ({ mtimeMs: 4 * MIN })), 6 * MIN);
  const locks = readGitLocks("/r", now, { readdir: () => ["index.lock", "HEAD"], stat: () => ({ mtimeMs: 7 * MIN }) });
  assert.equal(locks.length, 1);
  assert.equal(locks[0]!.ageMs, 3 * MIN);
});

test("doctor: renderDoctor names every failing check in its one-line summary", () => {
  const checks: Check[] = [
    { name: "alpha", verdict: "OK", measured: "1", threshold: "2" },
    { name: "beta", verdict: "FAIL", measured: "9", threshold: "2" },
  ];
  const first = renderDoctor(checks).split("\n")[0]!;
  assert.match(first, /^rmd doctor: FAIL/);
  assert.match(first, /beta/);
  assert.equal(first.includes("alpha"), false, "the summary names what is wrong, not what is fine");
});

// ── the three readers diff-coverage named, one test per arm, each with a positive control ──────

test("doctor: an unreadable /proc/meminfo degrades to empty rather than throwing", () => {
  // readFileSync THROWS on ENOENT/EACCES — it returns no sentinel — so the catch is the only thing
  // between a missing /proc and a crashed health command.
  const failed = readMemInfo(() => {
    throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  });
  assert.deepEqual(failed, {}, "an unreadable meminfo yields nothing, and never throws out of doctor");
  assert.equal(judgeMemory(failed.availableBytes, failed.totalBytes, failed.swapTotalBytes).verdict, "WARN");

  // POSITIVE CONTROL: the SAME reader with a readable file parses real values, so the empty object
  // above is the failure arm and not a reader that never works.
  const ok = readMemInfo(() => "MemTotal: 16000000 kB\nMemAvailable: 8000000 kB\nSwapTotal: 0 kB");
  assert.equal(ok.totalBytes, 16_000_000 * 1024);
  assert.equal(ok.availableBytes, 8_000_000 * 1024);
});

test("doctor: an unreadable inflight dir reports UNKNOWN lock state, never zero locks", async () => {
  // THE FAIL-OPEN THIS FIXES: a permissions fault HIDES locks. Answering "0 locks" to that would
  // let the health check report all-clear on a fault that blinded it.
  const { readLockFilesFrom } = await import("../src/run-task.js");
  const denied = readLockFilesFrom("/whatever", () => {
    throw Object.assign(new Error("EACCES"), { code: "EACCES" });
  });
  assert.deepEqual(denied.locks, []);
  assert.match(denied.unreadableReason!, /inflight dir unreadable \(EACCES\)/);
  const unknown = judgeLockDivergence(0, [], denied.unreadableReason);
  assert.equal(unknown.verdict, "WARN", "unknown lock state is NOT healthy");
  assert.match(unknown.measured, /UNKNOWN/);
  assert.match(unknown.detail!, /hides locks rather than proving there are none/);

  // POSITIVE CONTROL 1 — an ABSENT dir genuinely is zero locks and stays silently OK.
  const absent = readLockFilesFrom("/whatever", () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
  assert.deepEqual(absent, { locks: [] }, "ENOENT carries no unreadable reason");
  assert.equal(judgeLockDivergence(0, [], undefined).verdict, "OK");

  // POSITIVE CONTROL 2 — a readable dir really does list its locks, so the empties are absence.
  const listed = readLockFilesFrom("/whatever", () => ["W1-T1.lock", "notes.txt", "W1-T2.lock"]);
  assert.deepEqual(listed.locks, ["W1-T1", "W1-T2"], "only *.lock entries count, with the suffix stripped");

  // and the classifier itself discriminates in both directions
  assert.deepEqual(classifyReadFailure(Object.assign(new Error("x"), { code: "ENOENT" })), { absent: true, reason: "ENOENT" });
  assert.equal(classifyReadFailure(Object.assign(new Error("x"), { code: "EPERM" })).absent, false);
  assert.equal(classifyReadFailure(new Error("no code at all")).absent, false, "an unclassifiable error is NOT treated as absent");
});

test("doctor: a merged verdict row builds the local projection, and a truthy non-boolean does not", async () => {
  // THE SUBSTITUTION THAT KEEPS THE STALL CHECK ALIVE WITH NO NETWORK READ. Asserted by EFFECT, not
  // by coverage: falsification showed the earlier version of this test still passed with the
  // assignment deleted, so it is rewritten to compare presence against absence.
  const { localMergedProjections } = await import("../src/run-task.js");

  const withRow = localMergedProjections([
    { step: "verdict", task_id: "W1-T900", merged: true },
    { step: "verdict", task_id: "W1-T901", merged: false },
  ]);
  assert.equal(withRow.get("W1-T900")?.merged, true, "a merged verdict row marks that task merged");
  assert.equal(withRow.has("W1-T901"), false, "merged:false is not merged");
  assert.equal(withRow.size, 1);

  // POSITIVE CONTROL: the SAME rows without the merged flag produce an EMPTY map, so the entry
  // above comes from the flag and not from every verdict row landing in the set.
  const withoutRow = localMergedProjections([{ step: "verdict", task_id: "W1-T900" }]);
  assert.equal(withoutRow.size, 0);
  assert.equal(withRow.size, withoutRow.size + 1, "presence versus absence differs by exactly the merged row");

  // FAIL-CLOSED: a truthy non-boolean must NOT count. A false positive removes a task from the
  // eligible pool, which would HIDE a stall rather than report one.
  assert.equal(localMergedProjections([{ step: "verdict", task_id: "W1-T9", merged: "yes" }]).size, 0);
  // a row with no task_id is skipped rather than throwing
  assert.equal(localMergedProjections([{ step: "verdict", merged: true }]).size, 0);
  // and a non-verdict step never contributes
  assert.equal(localMergedProjections([{ step: "run.start", task_id: "W1-T9", merged: true }]).size, 0);
});

test("W1-T2332: readCheckoutDepth's shared try/catch returns undefined on an unreadable directory — the arm the ratchet's route-4 comment describes", () => {
  // THE CATCH ARM, DRIVEN. `readCheckoutDepth` runs BOTH git reads inside ONE try/catch, so a
  // directory git cannot read is the honest way to reach it without a seam: `git rev-parse
  // --is-shallow-repository` fails and the whole measurement is treated as absent rather than
  // partially guessed. `undefined` is "not measured" — `judgeCheckoutDepth` refuses on it by name.
  const missing = join(tmpdir(), `rmd-t2332-absent-${process.pid}`);
  assert.equal(existsSync(missing), false, "CONTROL: the directory really is absent, so git really will fail");
  assert.equal(readCheckoutDepth(missing), undefined, "a failed read is undefined, never a guessed depth");
});
