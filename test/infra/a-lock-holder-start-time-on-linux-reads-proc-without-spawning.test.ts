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

/** `/proc/<pid>/stat`: pid, (comm), fields 3..21, starttime (field 22), then a tail. */
function pidStat(startTicks: number | string, comm = "node", pid = PID): string {
  const fields3to21 = ["S", "1", String(pid), String(pid), "0", "-1", "4194560", "100", "0", "0", "0", "5", "3", "0", "0", "20", "0", "1", "0"];
  return `${pid} (${comm}) ${[...fields3to21, String(startTicks), "123456789", "4321"].join(" ")}\n`;
}

function procStat(btimeSec: number = BTIME_SEC): string {
  return `cpu  10 0 20 300 0 0 0 0 0 0\ncpu0 10 0 20 300 0 0 0 0 0 0\nintr 12345 0 1\nctxt 999\nbtime ${btimeSec}\nprocesses 77\n`;
}

/** `/proc/self/auxv` on a 64-bit little-endian kernel: (type, value) word pairs ending in AT_NULL. */
function auxv(pairs: Array<[number, number]>): Buffer {
  const buf = Buffer.alloc(pairs.length * 16);
  pairs.forEach(([type, value], i) => {
    buf.writeBigUInt64LE(BigInt(type), i * 16);
    buf.writeBigUInt64LE(BigInt(value), i * 16 + 8);
  });
  return buf;
}
const AT_PAGESZ = 6, AT_CLKTCK = 17, AT_HWCAP = 16;
const auxvWithHz = (hz: number): Buffer => auxv([[AT_HWCAP, 0xbfebfbff], [AT_PAGESZ, 4096], [AT_CLKTCK, hz], [0, 0]]);

function errno(code: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

type FixtureFile = string | Buffer | NodeJS.ErrnoException;

/** A Linux seam over pinned files. Every exec is recorded; it answers like `ps -o etime=` or throws. */
function linuxSeam(files: Record<string, FixtureFile>, ps: string | Error = PS_ETIME, platform: NodeJS.Platform | "unnamed" = "linux") {
  const execCalls: unknown[][] = [];
  const reads: string[] = [];
  const sys: ProcessStartTimeSyscalls = {
    ...(platform === "unnamed" ? {} : { platform }),
    readFileSync: (path: string) => {
      reads.push(path);
      const file = files[path];
      if (file === undefined) throw errno("ENOENT", path);
      if (file instanceof Error) throw file;
      return Buffer.isBuffer(file) ? file : Buffer.from(file);
    },
    execFileSync: ((...args: unknown[]) => {
      execCalls.push(args);
      if (ps instanceof Error) throw ps;
      return ps;
    }) as unknown as typeof execFileSync,
  };
  return { sys, execCalls, reads };
}

const healthy = (hz = 100, startTicks: number | string = 123_456, comm = "node"): Record<string, FixtureFile> => ({
  "/proc/stat": procStat(),
  "/proc/self/auxv": auxvWithHz(hz),
  [`/proc/${PID}/stat`]: pidStat(startTicks, comm),
});

/** Today's ps result for PS_ETIME, bracketed by the clock read around the call. */
function assertTodaysPsResult(start: number | null, before: number, after: number): void {
  assert.ok(start !== null, "the ps path answered");
  assert.ok(start >= before - 330_000 && start <= after - 330_000, `start ${start} is 5:30 before the call`);
}

test("W1-T11457 criterion 1: a holder's start time is /proc/stat's btime plus its /proc/<pid>/stat start ticks over CLK_TCK, with no ps spawned", () => {
  for (const [hz, expectedOffsetMs] of [[100, 1_234_560], [250, 493_824], [1000, 123_456]] as const) {
    const { sys, execCalls, reads } = linuxSeam(healthy(hz));
    assert.equal(defaultGetProcessStartTime(PID, sys), BTIME_SEC * 1000 + expectedOffsetMs, `CLK_TCK ${hz} is the kernel's, read from the aux vector`);
    assert.deepEqual(execCalls, [], "no child process is spawned on the Linux path");
    assert.deepEqual([...reads].sort(), ["/proc/4242/stat", "/proc/self/auxv", "/proc/stat"]);
  }
});

test("W1-T11457 criterion 1: a comm holding spaces and ') (' is parsed after the LAST ')'", () => {
  const { sys, execCalls } = linuxSeam(healthy(100, 777, "evil) (name 9 9 9"));
  assert.equal(defaultGetProcessStartTime(PID, sys), BTIME_SEC * 1000 + 7_770);
  assert.deepEqual(execCalls, []);
});

test("W1-T11457 criterion 1: a pid with no /proc/<pid>/stat is null, the same no-evidence answer ps gives, and no ps is spawned", () => {
  const files = healthy();
  delete files[`/proc/${PID}/stat`];
  const { sys, execCalls } = linuxSeam(files);
  assert.equal(defaultGetProcessStartTime(PID, sys), null);
  assert.deepEqual(execCalls, [], "a gone pid is answered from /proc, not by asking ps");
});

test("W1-T11457 criterion 1: CLK_TCK is read once per seam and reused, while btime and the pid are read on every call", () => {
  const { sys, execCalls, reads } = linuxSeam(healthy());
  assert.equal(defaultGetProcessStartTime(PID, sys), BTIME_SEC * 1000 + 1_234_560);
  assert.equal(defaultGetProcessStartTime(PID, sys), BTIME_SEC * 1000 + 1_234_560);
  assert.equal(reads.filter((p) => p === "/proc/self/auxv").length, 1, "the aux vector is read once");
  assert.equal(reads.filter((p) => p === "/proc/stat").length, 2);
  assert.deepEqual(execCalls, []);
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
          "/proc/self/auxv": auxvWithHz(hz),
          [`/proc/${PID}/stat`]: pidStat(ticks),
        };
        const fromProc = defaultGetProcessStartTime(PID, linuxSeam(files).sys);
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
    ["aux vector unreadable", { ...healthy(), "/proc/self/auxv": errno("EACCES", "/proc/self/auxv") }],
    ["aux vector with no AT_CLKTCK", { ...healthy(), "/proc/self/auxv": auxv([[AT_PAGESZ, 4096], [0, 0]]) }],
    ["aux vector with a zero AT_CLKTCK", { ...healthy(), "/proc/self/auxv": auxv([[AT_CLKTCK, 0], [0, 0]]) }],
    ["aux vector in a 32-bit layout", { ...healthy(), "/proc/self/auxv": Buffer.from(new Uint32Array([AT_PAGESZ, 4096, AT_CLKTCK, 100, 0, 0]).buffer) }],
    ["/proc/<pid>/stat unreadable", { ...healthy(), [`/proc/${PID}/stat`]: errno("EACCES", `/proc/${PID}/stat`) }],
    ["/proc/<pid>/stat vanished mid-read", { ...healthy(), [`/proc/${PID}/stat`]: errno("ESRCH", `/proc/${PID}/stat`) }],
    ["/proc/<pid>/stat with no ')'", { ...healthy(), [`/proc/${PID}/stat`]: "4242 node S 1 2 3\n" }],
    ["/proc/<pid>/stat truncated before field 22", { ...healthy(), [`/proc/${PID}/stat`]: "4242 (node) S 1 4242 4242 0\n" }],
    ["/proc/<pid>/stat with a non-numeric start", { ...healthy(100, "x1") }],
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

test("W1-T11457 criterion 2: an unreadable CLK_TCK is not cached, so the next call reads /proc again once it heals", () => {
  const files = { ...healthy(), "/proc/self/auxv": errno("EACCES", "/proc/self/auxv") as FixtureFile };
  const { sys, execCalls } = linuxSeam(files);
  assertTodaysPsResult(defaultGetProcessStartTime(PID, sys), Date.now() - 5, Date.now() + 5);
  files["/proc/self/auxv"] = auxvWithHz(100);
  assert.equal(defaultGetProcessStartTime(PID, sys), BTIME_SEC * 1000 + 1_234_560);
  assert.equal(execCalls.length, 1, "only the failed call asked ps");
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
  const before = Date.now();
  const fromPs = defaultGetProcessStartTime(process.pid, { execFileSync }); // no platform: today's ps path
  const drift = Date.now() - before;
  assert.ok(fromProc !== null && fromPs !== null, `proc ${fromProc} ps ${fromPs}`);
  assert.ok(fromPs - fromProc > -drift - 1000 && fromPs - fromProc < 2000 + drift, `${fromPs - fromProc} ms apart`);
});
