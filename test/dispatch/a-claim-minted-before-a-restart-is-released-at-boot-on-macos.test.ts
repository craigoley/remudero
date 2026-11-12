/**
 * W1-T12356 — ON MACOS, A SAME-HOST CLAIM MINTED BEFORE AN IN-PLACE RESTART IS RELEASED AT BOOT.
 *
 * MEASURED 2026-11-11 on a Mac: the W1-T10896 boot sweep tests passed 2 of 11. macOS has no `/proc`, so
 * `readNamespaceBootMs` gave no boot time and the same-host arm declined every claim. `pidIsPresent` also
 * read `/proc/<pid>`, which is absent on macOS for a live pid too. Both now ask the darwin kernel.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { dispatchClaimRef, pidIsPresent, readNamespaceBootMs } from "#src/lib/dispatch-claim.js";
import {
  DEAD_PID, LOCAL, MINT_ISO, TASK, anchorMessage, fakeReserver, instance, orphanRunRows, sweepRows,
} from "#test/helpers/restart-orphan.js";

const NOW_MS = Date.parse("2026-11-12T12:00:00.000Z");
const PROC_STAT = "cpu  1 2 3\nbtime 1762900000\nprocesses 10\n";
// comm holds a space and a ")" so the reader must slice after the LAST ")".
const PROC_1_STAT = `1 (my (init) x) S ${Array.from({ length: 18 }, (_, k) => k).join(" ")} 4200 0 0`;

function kernelError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** Readers that fail the test if the darwin branch touches them. */
function noProcReads(): { readFile: (p: string) => string; exists: (p: string) => boolean } {
  return {
    readFile: (p) => assert.fail(`darwin read ${p}`),
    exists: (p) => assert.fail(`darwin checked ${p}`),
  };
}

/** This process as a Mac: `process.platform` is darwin and `/proc` does not exist, so a live pid has no
 *  `/proc/<pid>` either. Gives the `/proc` paths the code under test tried. */
function asMacOs(t: TestContext): string[] {
  const tried: string[] = [];
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(real);
  const { readFileSync, existsSync } = fs;
  t.after(() => {
    Object.defineProperty(process, "platform", real);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  Object.defineProperty(process, "platform", { ...real, value: "darwin", configurable: true });
  t.mock.method(fs, "readFileSync", ((path: fs.PathOrFileDescriptor, options?: unknown) => {
    if (String(path).startsWith("/proc")) {
      tried.push(String(path));
      throw kernelError("ENOENT");
    }
    return readFileSync(path, options as BufferEncoding);
  }) as typeof fs.readFileSync);
  t.mock.method(fs, "existsSync", (path: fs.PathLike) => {
    if (String(path).startsWith("/proc")) return (tried.push(String(path)), false);
    return existsSync(path);
  });
  syncBuiltinESMExports();
  return tried;
}

test("W1-T12356: on darwin the namespace boot time is the kernel boot time", () => {
  const { readFile } = noProcReads();
  const boot = readNamespaceBootMs({ platform: "darwin", readFile, uptimeSec: () => 3600.25, nowMs: () => NOW_MS });
  assert.equal(boot, NOW_MS - 3_600_250);
  // A bad uptime declines arm 3 rather than guessing.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, NOW_MS / 1000 + 10]) {
    assert.equal(readNamespaceBootMs({ platform: "darwin", readFile, uptimeSec: () => bad, nowMs: () => NOW_MS }), undefined);
  }
  // The defaults: the real os.uptime and the module clock give a boot in the past.
  const real = readNamespaceBootMs({ platform: "darwin", readFile });
  assert.ok(real !== undefined && real > 0 && real <= Date.now(), `boot ${real}`);
});

test("W1-T12356: on darwin a pid is present unless the kernel answers ESRCH", () => {
  const { exists } = noProcReads();
  const signals: Array<[number, number]> = [];
  assert.equal(pidIsPresent(4242, { platform: "darwin", exists, kill: (pid, signal) => signals.push([pid, signal]) }), true);
  assert.deepEqual(signals, [[4242, 0]]);
  assert.equal(pidIsPresent(4242, { platform: "darwin", exists, kill: () => { throw kernelError("ESRCH"); } }), false);
  for (const code of ["EPERM", "EINVAL", "EIO"]) {
    assert.equal(pidIsPresent(4242, { platform: "darwin", exists, kill: () => { throw kernelError(code); } }), true, code);
  }
  assert.equal(pidIsPresent(4242, { platform: "darwin", exists, kill: () => { throw "not an error"; } }), true);
  // The default process.kill: this process is present, a pid no kernel hands out is absent.
  assert.equal(pidIsPresent(process.pid, { platform: "darwin", exists }), true);
  assert.equal(pidIsPresent(DEAD_PID, { platform: "darwin", exists }), false);
});

test("W1-T12356: on darwin the boot sweep releases a dead same-host claim and keeps the live ones", (t) => {
  // The production path: bootSweepDispatchClaims -> sameHostLivenessProbe with the real os.uptime and process.kill.
  const procTried = asMacOs(t);
  const live = new Date(Date.now() + 60_000).toISOString();
  const node = instance(t, orphanRunRows());
  const reserver = fakeReserver({
    [TASK]: anchorMessage(DEAD_PID, LOCAL, MINT_ISO),
    "W1-T1": anchorMessage(DEAD_PID, LOCAL, live),
    "W1-T2": anchorMessage(process.pid, LOCAL, MINT_ISO),
  });
  node.boot(reserver);
  assert.deepEqual(reserver.dropped, [TASK]);
  const swept = new Map(sweepRows(node.rows()).map((r) => [r.ref, r]));
  const released = swept.get(dispatchClaimRef(TASK));
  assert.equal(released?.arm, "dead-claimant");
  assert.equal(released?.release, true);
  assert.equal(released?.dropped, true);
  for (const kept of ["W1-T1", "W1-T2"]) {
    assert.equal(swept.get(dispatchClaimRef(kept))?.release, false, `${kept} has a claimant`);
    assert.equal(swept.get(dispatchClaimRef(kept))?.dropped, false);
  }
  assert.equal(procTried.length, 0, `darwin tried ${procTried.join(", ")}`);
});

test("W1-T12356: on linux the namespace boot time and the pid check still read /proc", () => {
  const read: string[] = [];
  const checked: string[] = [];
  const kernel = {
    uptimeSec: () => assert.fail("linux called os.uptime"),
    nowMs: () => assert.fail("linux read the clock"),
    kill: () => assert.fail("linux called process.kill"),
  };
  const readFile = (p: string) => (read.push(p), p === "/proc/stat" ? PROC_STAT : PROC_1_STAT);
  assert.equal(readNamespaceBootMs({ platform: "linux", readFile, ...kernel }), Math.round((1762900000 + 4200 / 100) * 1000));
  assert.equal(readNamespaceBootMs({ platform: "linux", readFile, clockTicks: () => 250, ...kernel }), Math.round((1762900000 + 4200 / 250) * 1000));
  assert.deepEqual(read, ["/proc/stat", "/proc/1/stat", "/proc/stat", "/proc/1/stat"]);
  assert.equal(readNamespaceBootMs({ platform: "linux", readFile: () => "no btime here", ...kernel }), undefined);
  const exists = (p: string) => (checked.push(p), p === "/proc/7");
  assert.equal(pidIsPresent(7, { platform: "linux", exists, ...kernel }), true);
  assert.equal(pidIsPresent(8, { platform: "linux", exists, ...kernel }), false);
  assert.equal(pidIsPresent(9, { platform: "linux", exists: () => { throw kernelError("EACCES"); }, ...kernel }), true);
  assert.deepEqual(checked, ["/proc/7", "/proc/8"]);
});

test("W1-T12356: on another platform the release still declines", () => {
  const kernel = {
    uptimeSec: () => assert.fail("win32 called os.uptime"),
    nowMs: () => assert.fail("win32 read the clock"),
    kill: () => assert.fail("win32 called process.kill"),
  };
  const unreadable = () => { throw kernelError("ENOENT"); };
  for (const platform of ["win32", "freebsd", "aix"] as const) {
    assert.equal(readNamespaceBootMs({ platform, readFile: unreadable, ...kernel }), undefined, `${platform} has no boot time`);
    assert.equal(pidIsPresent(DEAD_PID, { platform, exists: unreadable, ...kernel }), true, `${platform} keeps the pid present`);
  }
});
