/**
 * test/doctor.test.ts — W1-T1047: `rmd doctor`.
 *
 * EVERY REFUSAL ARM IS DRIVEN THROUGH ITS OWN PURE FUNCTION WITH A PAIRED POSITIVE CONTROL. That
 * shape is deliberate: an arm reachable only through a real `/proc` read or a live daemon is a
 * line no test can cover, and `diff-coverage` blocks a diff whose added lines have no covering
 * test — which stopped four PRs on the day this was written.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

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
  judgeMemory,
  judgePauseHonoured,
  judgeRepairStall,
  judgeStaleGitLocks,
  parseMemInfo,
  readAlivePhases,
  readCurrentRunAlivePhases,
  readGitLocks,
  readPauseAgeMs,
  refuseUnsupportedArgs,
  renderDoctor,
  worstVerdict,
  type Check,
} from "../src/lib/doctor.js";

const MIN = 60_000;

function aliveRow(phase: string, ts: string): Record<string, unknown> {
  return { step: "daemon.alive", phase, ts, poll_interval_ms: 300_000 };
}

function baseInputs(over: Partial<Parameters<typeof buildDoctorReport>[0]> = {}): Parameters<typeof buildDoctorReport>[0] {
  const now = Date.parse("2026-08-20T12:00:00Z");
  return {
    nowMs: now,
    ledgerLines: [aliveRow("dispatch", "2026-08-20T11:59:00Z")],
    candidateCount: 0,
    mem: { availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, swapTotalBytes: 2 * 1024 ** 3 },
    diskFreeBytes: 40 * 1024 ** 3,
    totalLocks: 0,
    deadLocks: [],
    gitLocks: [],
    workerCount: 0,
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
  assert.equal(report.checks.length, preExisting.length + 1, "exactly one new check joined the report");
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
    readLedgerLines: () => [aliveRow("dispatch", "2026-08-20T11:59:00Z")],
    liveInflightRuns: () => [],
    readLockFiles: () => ({ locks: [] }),
    readMemInfo: () => ({ availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, swapTotalBytes: 2 * 1024 ** 3 }),
    readDiskFreeBytes: () => 40 * 1024 ** 3,
    readPauseAgeMs: () => undefined,
    readGitLocks: () => [],
  });
  assert.equal(code, 0, "a healthy local read exits 0");
  assert.match(lines.join("\n"), /^rmd doctor: OK/m, "the command printed the module's own report");

  // NO NETWORK: the command took no gateway, no token and no gh seam — there is nowhere for a
  // GitHub read to enter, which is the constraint this whole task exists for.
  assert.equal(lines.join("\n").includes("gh "), false);
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
