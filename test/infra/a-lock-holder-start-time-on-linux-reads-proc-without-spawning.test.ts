// W1-T11457: on Linux a lock holder's start time comes from /proc, not from a `ps` forked off the daemon.
// The Mac has no /proc, so every Linux case drives defaultGetProcessStartTime through its
// ProcessStartTimeSyscalls seam with pinned fixture text; CI on Linux is the first run against a real kernel
// (the last test below, skipped elsewhere).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { defaultGetProcessStartTime, isHolderStale, type ProcessStartTimeSyscalls } from "#src/lib/fs-race-safe.js";

const PID = 4242;
const BTIME_SEC = 1_795_000_000;
const PS_ETIME = "   05:30\n"; // what the ps spy answers: 5 min 30 s elapsed
const PS_ARGS = ["-o", "etime=", "-p", String(PID)];
const GETCONF_CALL = ["getconf", ["CLK_TCK"], { encoding: "utf8" }];

/** The 50 fields after comm in a Linux 3.5+ `/proc/<pid>/stat`: state (field 3) .. exit_code (field 52). */
function pidStatFields(startTicks: number | string, pid = PID): string[] {
  const fields3to21 = ["S", "1", String(pid), String(pid), "0", "-1", "4194560", "100", "0", "0", "0", "5", "3", "0", "0", "20", "0", "1", "0"];
  const fields23to52 = ["123456789", "4321", "18446744073709551615", "94827364", "94837364", "140734", "0", "0", "0", "0", "4096", "134234626",
    "0", "0", "0", "17", "3", "0", "0", "0", "0", "0", "94839000", "94839500", "94840000", "140735", "140736", "140737", "140738", "0"];
  return [...fields3to21, String(startTicks), ...fields23to52];
}

function pidStatLine(fields: string[], comm = "node", pid = PID): string {
  return `${pid} (${comm}) ${fields.join(" ")}\n`;
}

/** `/proc/<pid>/stat`: pid, (comm), fields 3..21, starttime (field 22), then fields 23..52. */
function pidStat(startTicks: number | string, comm = "node", pid = PID): string {
  return pidStatLine(pidStatFields(startTicks, pid), comm, pid);
}

function procStat(btimeSec: number = BTIME_SEC): string {
  return `cpu  10 0 20 300 0 0 0 0 0 0\ncpu0 10 0 20 300 0 0 0 0 0 0\nintr 12345 0 1\nctxt 999\nbtime ${btimeSec}\nprocesses 77\n`;
}

function errno(code: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

type FixtureFile = string | NodeJS.ErrnoException;

function linuxSeam(
  files: Record<string, FixtureFile>,
  ps: string | Error = PS_ETIME,
  platform: NodeJS.Platform | "unnamed" = "linux",
  clkTck: string | Error = "100\n",
) {
  const execCalls: unknown[][] = [];
  const reads: string[] = [];
  const sys: ProcessStartTimeSyscalls = {
    ...(platform === "unnamed" ? {} : { platform }),
    readFileSync: (path: string) => {
      reads.push(path);
      const file = files[path];
      if (file === undefined) throw errno("ENOENT", path);
      if (file instanceof Error) throw file;
      return Buffer.from(file);
    },
    execFileSync: ((...args: unknown[]) => {
      execCalls.push(args);
      const answer = args[0] === "getconf" ? clkTck : ps;
      if (answer instanceof Error) throw answer;
      return answer;
    }) as unknown as typeof execFileSync,
  };
  return { sys, execCalls, reads };
}

const healthy = (startTicks: number | string = 123_456, comm = "node"): Record<string, FixtureFile> => ({
  "/proc/stat": procStat(),
  [`/proc/${PID}/stat`]: pidStat(startTicks, comm),
});

/** Today's ps result for PS_ETIME, bracketed by the clock read around the call. */
function assertTodaysPsResult(start: number | null, before: number, after: number): void {
  assert.ok(start !== null, "the ps path answered");
  assert.ok(start >= before - 330_000 && start <= after - 330_000, `start ${start} is 5:30 before the call`);
}

test("W1-T11457 criterion 1: a holder's start time uses procfs and a cached CLK_TCK independent of Linux ABI", () => {
  for (const [hz, expectedOffsetMs] of [[100, 1_234_560], [250, 493_824], [1000, 123_456]] as const) {
    const files = healthy();
    const { sys, execCalls, reads } = linuxSeam(files, PS_ETIME, "linux", `${hz}\n`);
    assert.equal(defaultGetProcessStartTime(PID, sys), BTIME_SEC * 1000 + expectedOffsetMs, `uses the reported CLK_TCK ${hz}`);
    assert.deepEqual(execCalls, [GETCONF_CALL], "the cold lookup initializes the clock rate once");
    assert.deepEqual([...reads].sort(), ["/proc/4242/stat", "/proc/stat"]);
    execCalls.length = 0;
    reads.length = 0;
    files["/proc/stat"] = procStat(BTIME_SEC + 1);
    files[`/proc/${PID}/stat`] = pidStat(123_456 + hz);
    assert.equal(defaultGetProcessStartTime(PID, sys), BTIME_SEC * 1000 + expectedOffsetMs + 2000);
    assert.deepEqual(execCalls, [], "the next Linux lookup spawns no child process");
    assert.deepEqual([...reads].sort(), ["/proc/4242/stat", "/proc/stat"]);
  }
});

test("W1-T11457 criterion 1: a comm holding spaces, a newline and ') (' is parsed after the LAST ')'", () => {
  const { sys, execCalls } = linuxSeam(healthy(777, "node) (name\n9 9 9"));
  assert.equal(defaultGetProcessStartTime(PID, sys), BTIME_SEC * 1000 + 7_770);
  assert.deepEqual(execCalls, [GETCONF_CALL]);
});

test("W1-T11457 criterion 1: a pid with no /proc/<pid>/stat is null, the same no-evidence answer ps gives, and no ps is spawned", () => {
  const files = healthy();
  delete files[`/proc/${PID}/stat`];
  const { sys, execCalls } = linuxSeam(files);
  assert.equal(defaultGetProcessStartTime(PID, sys), null);
  assert.deepEqual(execCalls, [], "a gone pid is answered from /proc, not by asking ps");
});

/** `ps -o etime=`'s `[[DD-]HH:]MM:SS` for whole seconds. */
function formatEtime(totalSec: number): string {
  const days = Math.floor(totalSec / 86_400);
  const [h, m, s] = [Math.floor(totalSec / 3600) % 24, Math.floor(totalSec / 60) % 60, totalSec % 60].map((n) => String(n).padStart(2, "0"));
  return `${days > 0 ? `${days}-` : ""}${h}:${m}:${s}\n`;
}

test("W1-T11457 criterion 1: for one process, the /proc start is never later than ps's and within btime's second plus ps's second of it", () => {
  // The kernel's btime is whole seconds (the /proc answer can sit up to 1 s early) and ps's etime is whole seconds
  // (its answer can sit up to 1 s late); both use the same start ticks, so a tick of truncation is shared.
  for (const hz of [100, 250, 1000]) {
    for (const bootFracMs of [0, 1, 500, 999]) {
      for (const sinceBootMs of [3_723_456, 86_399_999, 400_000_123]) {
        const now = Date.now();
        const bootWallMs = now - 30 * 86_400_000 + bootFracMs - (now % 1000);
        const ticks = Math.floor((sinceBootMs * hz) / 1000);
        const kernelStartMs = bootWallMs + (ticks * 1000) / hz; // the instant the kernel's ticks name
        const trueStartMs = bootWallMs + sinceBootMs;
        const files: Record<string, FixtureFile> = {
          "/proc/stat": procStat(Math.floor(bootWallMs / 1000)),
          [`/proc/${PID}/stat`]: pidStat(ticks),
        };
        const fromProc = defaultGetProcessStartTime(PID, linuxSeam(files, PS_ETIME, "linux", `${hz}\n`).sys);
        const before = Date.now();
        const etime = formatEtime(Math.floor((before - kernelStartMs) / 1000));
        const fromPs = defaultGetProcessStartTime(PID, linuxSeam(files, etime, "darwin").sys);
        const drift = Date.now() - before;
        const label = `hz=${hz} bootFrac=${bootFracMs} sinceBoot=${sinceBootMs}`;
        assert.ok(fromProc !== null && fromPs !== null, label);
        assert.ok(fromProc <= fromPs, `${label}: /proc ${fromProc} is never later than ps ${fromPs}`);
        assert.ok(fromPs - fromProc < 2000 + drift, `${label}: ${fromPs - fromProc} ms apart`);
        assert.ok(fromProc <= trueStartMs && trueStartMs - fromProc < 1000 + 1000 / hz, `${label}: within one tick plus btime's second of the true start`);
      }
    }
  }
});

test("W1-T11457 criterion 2: a non-Linux platform, or a seam naming no platform, takes the ps path with today's result and reads no /proc", () => {
  for (const platform of ["darwin", "freebsd", "unnamed"] as const) {
    const { sys, execCalls, reads } = linuxSeam(healthy(), PS_ETIME, platform);
    const before = Date.now();
    const start = defaultGetProcessStartTime(PID, sys);
    assertTodaysPsResult(start, before, Date.now());
    assert.deepEqual(reads, [], `${platform}: no /proc read`);
    assert.deepEqual(execCalls, [["ps", PS_ARGS, { encoding: "utf8" }]], `${platform}: today's ps call`);
  }
  const gone = linuxSeam(healthy(), new Error("ps: no such process"), "darwin");
  assert.equal(defaultGetProcessStartTime(PID, gone.sys), null, "a ps failure is still null");
});

test("W1-T11457 criterion 2: a /proc read or parse failure on Linux falls back to the ps path with today's result", () => {
  const cases: Array<[string, Record<string, FixtureFile>]> = [
    ["/proc/stat absent (no procfs mounted)", { ...healthy(), "/proc/stat": errno("ENOENT", "/proc/stat") }],
    ["/proc/stat unreadable", { ...healthy(), "/proc/stat": errno("EACCES", "/proc/stat") }],
    ["/proc/stat with no btime line", { ...healthy(), "/proc/stat": "cpu  1 2 3\nctxt 9\n" }],
    ["/proc/<pid>/stat unreadable", { ...healthy(), [`/proc/${PID}/stat`]: errno("EACCES", `/proc/${PID}/stat`) }],
    ["/proc/<pid>/stat vanished mid-read", { ...healthy(), [`/proc/${PID}/stat`]: errno("ESRCH", `/proc/${PID}/stat`) }],
    ["/proc/<pid>/stat with no ')'", { ...healthy(), [`/proc/${PID}/stat`]: "4242 node S 1 2 3\n" }],
    ["/proc/<pid>/stat with no '('", { ...healthy(), [`/proc/${PID}/stat`]: pidStat(123_456).replace("(", "") }],
    ["/proc/<pid>/stat truncated before field 22", { ...healthy(), [`/proc/${PID}/stat`]: "4242 (node) S 1 4242 4242 0\n" }],
    ["/proc/<pid>/stat with a non-numeric start", healthy("x1")],
  ];
  for (const [label, files] of cases) {
    const { sys, execCalls } = linuxSeam(files);
    const before = Date.now();
    const start = defaultGetProcessStartTime(PID, sys);
    assertTodaysPsResult(start, before, Date.now());
    assert.deepEqual(execCalls, [["ps", PS_ARGS, { encoding: "utf8" }]], `${label}: today's ps call, once`);
    const psGone = linuxSeam(files, new Error("ps: no such process"));
    assert.equal(defaultGetProcessStartTime(PID, psGone.sys), null, `${label}: and ps's own failure is still null`);
  }
});

test("W1-T11457 criterion 2: malformed start ticks take the original ps path", (t) => {
  const now = BTIME_SEC * 1000 + 2_000_000;
  t.mock.method(Date, "now", () => now);
  const files = healthy();
  const { sys, execCalls } = linuxSeam(files);
  assert.equal(defaultGetProcessStartTime(PID, sys), BTIME_SEC * 1000 + 1_234_560);
  assert.deepEqual(execCalls, [GETCONF_CALL]);
  for (const ticks of ["-1", "0x10", "+10", "1.5", "1e3", "9".repeat(400)]) {
    files[`/proc/${PID}/stat`] = pidStat(ticks);
    execCalls.length = 0;
    assert.equal(defaultGetProcessStartTime(PID, sys), now - 330_000, `invalid field 22: ${ticks}`);
    assert.deepEqual(execCalls, [["ps", PS_ARGS, { encoding: "utf8" }]]);
  }
});

/** Thirty days of uptime: a field shifted into the start-time slot then lands in the past, so no bound catches it. */
const LONG_UPTIME_NOW = BTIME_SEC * 1000 + 30 * 86_400_000;

/** Runs one Linux probe over a pid stat file and asserts it took ps (one call) and returned ps's answer. */
function assertTakesPs(pidStatText: string, label: string): void {
  const { sys, execCalls } = linuxSeam({ "/proc/stat": procStat(), [`/proc/${PID}/stat`]: pidStatText });
  assert.equal(defaultGetProcessStartTime(PID, sys), Date.now() - 330_000, `${label}: ps's answer`);
  assert.deepEqual(execCalls.filter((call) => call[0] === "ps"), [["ps", PS_ARGS, { encoding: "utf8" }]], `${label}: one ps call`);
}

test("W1-T11457 criterion 2: a stat record with the state field removed takes the ps path, not the next field as its start", (t) => {
  t.mock.method(Date, "now", () => LONG_UPTIME_NOW);
  const noState = pidStatFields(123_456).slice(1); // field 23 (vsize) now sits in the start-time slot
  assertTakesPs(pidStatLine(noState), "state removed");
  // The same misread at the kernel's field count (one field appended): only the state-letter check names it.
  assertTakesPs(pidStatLine([...noState, "0"]), "state removed, field count kept");
});

test("W1-T11457 criterion 2: a stat record with an extra field inserted before starttime takes the ps path", (t) => {
  t.mock.method(Date, "now", () => LONG_UPTIME_NOW);
  for (const at of [1, 10, 19]) {
    const fields = pidStatFields(123_456);
    fields.splice(at, 0, "0");
    assertTakesPs(pidStatLine(fields), `extra field at index ${at}`);
  }
});

test("W1-T11457 criterion 2: a stat record with ppid removed and a non-numeric exit_code appended takes the ps path", (t) => {
  t.mock.method(Date, "now", () => LONG_UPTIME_NOW);
  // The field count and state letter still match, and vsize (14 days of ticks) sits in the start-time slot.
  const noPpid = pidStatFields(123_456).filter((_, i) => i !== 1);
  assertTakesPs(pidStatLine([...noPpid, "x"]), "ppid removed, non-numeric exit_code appended");
});

test("W1-T11457 criterion 2: a numeric second line cannot shift vsize into a live holder's start time", (t) => {
  t.mock.method(Date, "now", () => LONG_UPTIME_NOW);
  const elapsedSec = 20 * 86_400;
  const start = LONG_UPTIME_NOW - elapsedSec * 1000;
  const startTicks = (start / 1000 - BTIME_SEC) * 100; // linuxSeam reports CLK_TCK=100
  const noPpid = pidStatFields(startTicks).filter((_, i) => i !== 1);
  const files = {
    "/proc/stat": procStat(),
    "/proc/1/stat": pidStat(0, "init", 1),
    [`/proc/${PID}/stat`]: `${pidStatLine(noPpid)}0\n`,
  };
  const { sys, execCalls } = linuxSeam(files, formatEtime(elapsedSec));
  const held = { pid: PID, startedAt: new Date(start).toISOString() };
  const opts = { isPidAlive: () => true, getProcessStartTime: (pid: number) => defaultGetProcessStartTime(pid, sys) };
  assert.equal(isHolderStale(held, opts), false, "the fallback keeps the live holder");
  assert.deepEqual(execCalls, [GETCONF_CALL, ["ps", PS_ARGS, { encoding: "utf8" }]]);
  assert.equal(defaultGetProcessStartTime(PID, sys), start, "the malformed record returns today's ps result");
});

test("W1-T11457 criterion 2: a stat record with a non-numeric field in the middle takes the ps path", (t) => {
  t.mock.method(Date, "now", () => LONG_UPTIME_NOW);
  for (const at of [5, 13, 20, 35]) {
    for (const bad of ["x", "1.5", "+3", "0x10", "-"]) {
      const fields = pidStatFields(123_456);
      fields[at] = bad;
      assertTakesPs(pidStatLine(fields), `field index ${at} is ${JSON.stringify(bad)}`);
    }
  }
});

test("W1-T11457 criterion 2: a starttime that resolves to the future takes the ps path", (t) => {
  t.mock.method(Date, "now", () => BTIME_SEC * 1000 + 2_000_000);
  // 1_000_000 ticks at CLK_TCK 100 is 10 000 s after boot, 8 000 s after this pinned now.
  assertTakesPs(pidStat(1_000_000), "start after now");
});

test("W1-T11457 criterion 2: a failed CLK_TCK lookup falls back to ps and getconf runs only once", (t) => {
  const now = BTIME_SEC * 1000 + 2_000_000;
  t.mock.method(Date, "now", () => now);
  for (const clkTck of [new Error("getconf failed"), "0\n", "0x64\n", "100.5\n", "9007199254740992\n"]) {
    const { sys, execCalls } = linuxSeam(healthy(), PS_ETIME, "linux", clkTck);
    assert.equal(defaultGetProcessStartTime(PID, sys), now - 330_000);
    assert.equal(defaultGetProcessStartTime(PID, sys), now - 330_000);
    const psCall = ["ps", PS_ARGS, { encoding: "utf8" }];
    assert.deepEqual(execCalls, [GETCONF_CALL, psCall, psCall], String(clkTck));
  }
});

test("W1-T11457: the real default seam judges this live test process its own current holder", () => {
  const start = defaultGetProcessStartTime(process.pid);
  assert.ok(start !== null && start <= Date.now(), `start ${start}`);
  const startedAt = new Date(performance.timeOrigin).toISOString();
  assert.equal(isHolderStale({ pid: process.pid, startedAt }, { isPidAlive: () => true }), false);
});

test("W1-T11457: on a real Linux kernel the /proc start agrees with ps's for this process", (t) => {
  if (process.platform !== "linux") { t.skip("reads the real /proc; the Mac has none"); return; }
  const fromProc = defaultGetProcessStartTime(process.pid);
  // The strict layout must accept the kernel's own record: a real /proc read asks nothing of ps.
  const spawned: unknown[] = [];
  const spy = ((...args: Parameters<typeof execFileSync>) => (spawned.push(args[0]), execFileSync(...args))) as typeof execFileSync;
  assert.equal(typeof defaultGetProcessStartTime(process.pid, { execFileSync: spy, platform: "linux" }), "number");
  assert.deepEqual(spawned, ["getconf"], "the real record parses, so only the one CLK_TCK lookup runs");
  const before = Date.now();
  const fromPs = defaultGetProcessStartTime(process.pid, { execFileSync }); // no platform: today's ps path
  const drift = Date.now() - before;
  assert.ok(fromProc !== null && fromPs !== null, `proc ${fromProc} ps ${fromPs}`);
  assert.ok(fromPs - fromProc > -drift - 1000 && fromPs - fromProc < 2000 + drift, `${fromPs - fromProc} ms apart`);
});
