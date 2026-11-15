/**
 * W1-T12528 — THE BOOT SWEEP READS THE HOST THROUGH AN INJECTED PROBE.
 *
 * MEASURED 2026-11-11 on a Mac (W1-T12162's builder): the sweep read the boot time from /proc/stat, which macOS does
 * not have, and kept a dead claim. The suites that drive the sweep depended on the host they ran on. The sweep now
 * takes its hostname, namespace boot time and pid presence from one probe, and only the daemon passes the real one.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import {
  bootSweepDispatchClaims, bootSweepDispatchClaimsAsync, dispatchClaimRef, pidIsPresent, readNamespaceBootMs,
  realBootSweepHostProbe, type BootSweepInputs,
} from "#src/lib/dispatch-claim.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import {
  DEAD_PID, LOCAL, MINT_ISO, NAMESPACE_BOOT_ISO, RUN_ID, TASK, anchorMessage, fakeReserver, instance, orphanRunRows,
  orphanVerdicts, sweepRows,
} from "#test/helpers/restart-orphan.js";
import { daemonCommand } from "#test/helpers/run-task-daemon.js";

type Row = Record<string, unknown>;
type HostProbe = NonNullable<BootSweepInputs["hostProbe"]>;
type Deps = NonNullable<Parameters<typeof daemonCommand>[1]>;

const PROBE_HOST = "fixed-probe-host";
const PROBE_BOOT_ISO = "2001-06-01T00:00:00.000Z";
const LIVE_PID = 4242;
const REAL_HOST = os.hostname();
const LOCK_ISO = "2026-11-11T00:00:00.000Z";
const stopped = { attempted: [], merged: [], stopReason: "stopped" as const, costUsd: 0, ticks: 0 };

function fixedProbe(over: Partial<HostProbe> = {}): HostProbe {
  return {
    hostname: () => PROBE_HOST,
    namespaceBootMs: () => Date.parse(PROBE_BOOT_ISO),
    pidPresent: (pid) => pid !== DEAD_PID,
    ...over,
  };
}

/** The probe host's dead orphan, a claim minted after its boot, a live pid, and a dead claim on the REAL hostname. */
function claims(): Record<string, string> {
  return {
    [TASK]: anchorMessage(DEAD_PID, PROBE_HOST, MINT_ISO),
    "W1-T1": anchorMessage(DEAD_PID, PROBE_HOST, "2002-01-01T00:00:00.000Z"),
    "W1-T2": anchorMessage(LIVE_PID, PROBE_HOST, MINT_ISO),
    "W1-T3": anchorMessage(DEAD_PID, REAL_HOST, MINT_ISO),
  };
}

function sweepState(t: TestContext, seed: Row[]): { stateDir: string; rows: () => Row[]; log: (step: string, fields: Row) => void } {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-probe-state-`));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  writeFileSync(join(stateDir, "ledger.ndjson"), seed.map((row) => `${JSON.stringify(row)}\n`).join(""));
  const written: Row[] = [];
  return { stateDir, rows: () => written, log: (step, fields) => { written.push({ step, ...fields }); } };
}

function kernelError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** Every host read the sweep could make — /proc, os.hostname, os.uptime, process.kill — recorded and refused.
 *  `platform` pretends this process runs there; `undefined` keeps the real platform. `hostnameAnswer` makes
 *  os.hostname answer another host without recording, for a log that stamps each row with it. */
function watchHost(t: TestContext, platform?: NodeJS.Platform, hostnameAnswer?: string): string[] {
  const reads: string[] = [];
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(realPlatform);
  const { readFileSync: realRead, existsSync: realExists } = fs;
  const realHostname = os.hostname;
  t.after(() => {
    Object.defineProperty(process, "platform", realPlatform);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  if (platform !== undefined) Object.defineProperty(process, "platform", { ...realPlatform, value: platform, configurable: true });
  t.mock.method(fs, "readFileSync", ((path: fs.PathOrFileDescriptor, options?: unknown) => {
    if (String(path).startsWith("/proc")) {
      reads.push(String(path));
      throw kernelError("ENOENT");
    }
    return realRead(path, options as BufferEncoding);
  }) as typeof fs.readFileSync);
  t.mock.method(fs, "existsSync", (path: fs.PathLike) => {
    if (String(path).startsWith("/proc")) return (reads.push(String(path)), false);
    return realExists(path);
  });
  t.mock.method(os, "hostname", () => hostnameAnswer ?? (reads.push("os.hostname"), realHostname()));
  t.mock.method(os, "uptime", () => (reads.push("os.uptime"), 1));
  t.mock.method(process, "kill", ((pid: number) => { reads.push(`process.kill(${pid})`); throw kernelError("ESRCH"); }) as typeof process.kill);
  syncBuiltinESMExports();
  return reads;
}

const verdictOf = (rows: Row[]) => orphanVerdicts(rows).map((v) => [v.run_id, v.namespace_boot]);
const armsOf = (rows: Row[]) => sweepRows(rows).map((r) => [r.ref, r.arm, r.dropped]);

const EXPECTED_ARMS = [
  [dispatchClaimRef(TASK), "dead-claimant", true],
  [dispatchClaimRef("W1-T1"), "operator", false],
  [dispatchClaimRef("W1-T2"), "operator", false],
  [dispatchClaimRef("W1-T3"), "operator", false],
];

for (const platform of [undefined, "darwin", "freebsd"] as const) {
  const where = platform === undefined ? "linux" : platform === "darwin" ? "darwin" : "a host with no /proc";
  test(`W1-T12528 criterion 1: with a fixed probe the boot sweep gives the same release rows on ${where}`, async (t) => {
    const reads = watchHost(t, platform);
    const lock = { hostProbe: fixedProbe(), lockHeldSinceMs: Date.parse(LOCK_ISO), lockHeldSinceIso: LOCK_ISO };
    const seed = orphanRunRows(TASK, RUN_ID, PROBE_HOST);
    const sync = sweepState(t, seed);
    bootSweepDispatchClaims(fakeReserver(claims()), { ...lock, stateDir: sync.stateDir, log: sync.log });
    const awaited = sweepState(t, seed);
    await bootSweepDispatchClaimsAsync(fakeReserver(claims()), { ...lock, stateDir: awaited.stateDir, log: awaited.log });

    assert.deepEqual(armsOf(sync.rows()), EXPECTED_ARMS, "the probe's host, boot and pids decide every claim");
    assert.deepEqual(verdictOf(sync.rows()), [[RUN_ID, PROBE_BOOT_ISO]], "the orphan's verdict names the probe's boot");
    assert.deepEqual(awaited.rows(), sync.rows(), "the awaited sweep writes the same rows");
    assert.deepEqual(reads, [], `the sweep read the host: ${reads.join(", ")}`);
  });
}

/** A daemon command over a fresh root, booted as the start-claim-sweep tests boot it. */
function commandFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}host-probe-`));
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
  const plan = join(root, "tasks.yaml");
  writeFileSync(plan, "[]\n");
  const signalListeners = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  t.after(async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const listener of process.listeners(signal)) if (!signalListeners[signal].includes(listener)) process.removeListener(signal, listener);
    }
    await flush();
    rmSync(root, { recursive: true, force: true });
  });
  const deps: Deps = {
    config: { root, claudeBin: "/bin/true" }, repoRoot: REPO_ROOT,
    startGithubAppRefresh: () => ({ armed: false }),
    applyMemoryPolicy: () => ({ heap_growing_percent: 10 }),
    daemonBoot: async () => ({ env_clean: true, billing_mode: "subscription", node_path: process.execPath, node_version: process.version }),
    checkPause: () => undefined, checkStop: () => undefined,
    readRunChildMode: () => "off",
    wireSweepWake: () => ({ sleep: async () => "timeout", acknowledge: () => {}, close: () => {} }),
    buildSweepHook: () => async () => {}, buildSweepLightHook: () => async () => {},
  };
  return {
    run: (overrides: Deps) => daemonCommand(["--allow-self-target", "--plan", plan, "--max", "0"], {
      ...deps,
      runDaemon: async (_plan, d) => { await d.claimSweepSettled; return stopped; },
      ...overrides,
    }),
    rows: (): Row[] => readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Row),
  };
}

test("W1-T12528 criterion 2: the daemon's boot sweeps with the real host probe unless a test injects one", async (t) => {
  assert.equal(realBootSweepHostProbe.hostname(), os.hostname(), "the real probe's hostname is os.hostname");
  assert.equal(realBootSweepHostProbe.namespaceBootMs(), readNamespaceBootMs(), "its boot is readNamespaceBootMs");
  assert.equal(realBootSweepHostProbe.pidPresent(process.pid), true, "this process is present");
  assert.equal(realBootSweepHostProbe.pidPresent(DEAD_PID), pidIsPresent(DEAD_PID), "its pid check is pidIsPresent");

  const realHost = anchorMessage(DEAD_PID, REAL_HOST, MINT_ISO);
  const probeHost = anchorMessage(DEAD_PID, PROBE_HOST, MINT_ISO);
  const real = commandFixture(t);
  assert.equal(await real.run({ bootClaimReserver: fakeReserver({ "W1-T1": realHost, "W1-T2": probeHost }) }), 0);
  const realArm = readNamespaceBootMs() !== undefined && !pidIsPresent(DEAD_PID) ? "dead-claimant" : "operator";
  assert.deepEqual(armsOf(real.rows()), [
    [dispatchClaimRef("W1-T1"), realArm, realArm === "dead-claimant"],
    [dispatchClaimRef("W1-T2"), "operator", false],
  ], "with no probe injected the sweep judges this host's own claims");

  const injected = commandFixture(t);
  const code = await injected.run({ bootClaimReserver: fakeReserver({ "W1-T1": realHost, "W1-T2": probeHost }), hostProbe: fixedProbe() });
  assert.equal(code, 0);
  assert.deepEqual(armsOf(injected.rows()), [
    [dispatchClaimRef("W1-T1"), "operator", false],
    [dispatchClaimRef("W1-T2"), "dead-claimant", true],
  ], "an injected probe replaces the real host");
});

test("W1-T12528 criterion 3: a probe with no boot time declines the same-host arm, and a pid it cannot check is present", (t) => {
  const lock = { lockHeldSinceMs: Date.parse(LOCK_ISO), lockHeldSinceIso: LOCK_ISO };
  const dead = { [TASK]: anchorMessage(DEAD_PID, PROBE_HOST, MINT_ISO) };
  const known = sweepState(t, []);
  bootSweepDispatchClaims(fakeReserver({ ...dead }), { ...lock, hostProbe: fixedProbe(), stateDir: known.stateDir, log: known.log });
  assert.deepEqual(armsOf(known.rows()), [[dispatchClaimRef(TASK), "dead-claimant", true]], "control: a known boot releases it");

  const unknown = sweepState(t, []);
  const reserver = fakeReserver({ ...dead });
  const probe = fixedProbe({ namespaceBootMs: () => undefined });
  bootSweepDispatchClaims(reserver, { ...lock, hostProbe: probe, stateDir: unknown.stateDir, log: unknown.log });
  assert.deepEqual(armsOf(unknown.rows()), [[dispatchClaimRef(TASK), "operator", false]], "an unknown boot declines");
  assert.deepEqual(reserver.dropped, [], "the claim is kept");

  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(realPlatform);
  const { existsSync: realExists } = fs;
  t.after(() => {
    Object.defineProperty(process, "platform", realPlatform);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(fs, "existsSync", (path: fs.PathLike) => {
    if (String(path).startsWith("/proc/")) throw kernelError("EACCES");
    return realExists(path);
  });
  syncBuiltinESMExports();
  Object.defineProperty(process, "platform", { ...realPlatform, value: "linux", configurable: true });
  assert.equal(realBootSweepHostProbe.pidPresent(DEAD_PID), true, "an unreadable /proc/<pid> is present");
  Object.defineProperty(process, "platform", { ...realPlatform, value: "darwin", configurable: true });
  const kills: number[] = [];
  t.mock.method(process, "kill", ((pid: number) => { kills.push(pid); throw kernelError("EPERM"); }) as typeof process.kill);
  assert.equal(realBootSweepHostProbe.pidPresent(DEAD_PID), true, "a kernel that will not say is present");
  assert.deepEqual(kills, [DEAD_PID], "darwin asked the kernel");
});

test("W1-T12528 criterion 4: the restart-orphan helper boots the sweep with a fixed probe and reads nothing from the host", (t) => {
  const node = instance(t, orphanRunRows());
  // The helper's ledger stamps each row with os.hostname, so it answers another host: a sweep reading it keeps the claim.
  const reads = watchHost(t, undefined, `not-${LOCAL}`);
  const reserver = fakeReserver({ [TASK]: anchorMessage(DEAD_PID, LOCAL, MINT_ISO) });
  node.boot(reserver);
  assert.deepEqual(reserver.dropped, [TASK], "the sweep judged the claim on the probe's hostname");
  assert.deepEqual(orphanVerdicts(node.rows()).map((v) => [v.run_id, v.namespace_boot]), [[RUN_ID, NAMESPACE_BOOT_ISO]]);
  assert.deepEqual(reads, [], `the helper's sweep read the host: ${reads.join(", ")}`);
});
