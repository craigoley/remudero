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
  judgeStaleGitLocks,
  parseMemInfo,
  readAlivePhases,
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
    readLockFiles: () => [],
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
