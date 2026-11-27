/**
 * test/ci/suites/a-sibling-namespace-waiter-never-frees-a-live-owners-test-slot.test.ts — W1-T15112.
 *
 * OBSERVED 2026-11-27 (cloud repro with real namespaces): a waiter in a sibling pid namespace, with its own /proc,
 * freed a LIVE owner's aged slot as `reclaimed_quiescent{pid-namespace-ended}`. NSpid counts from the namespace of the
 * /proc mount, so that waiter read one entry and took itself for the initial namespace, then found none of the owner's
 * namespace members (it cannot see them) and called the namespace ended.
 *
 * INVARIANT sibling-waiter-keeps-live-slot: only a waiter whose /proc/self/ns/pid is the initial namespace
 * (INITIAL_PID_NAMESPACE) may judge another namespace ended, or prove an owner gone by a boot-wide start scan.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  acquireTestSlot, INITIAL_PID_NAMESPACE, probeRecordedPidNamespace, scanProcessStarts, TEST_SLOT_SILENT_BEATS,
  type ReservedTreeProbeHost, type TestSlotHolder,
} from "#src/lib/test-slot.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const OWNER_NS = "pid:[4026532544]";
const SIBLING_NS = "pid:[4026532999]";
const CADENCE = 60_000;
const NOW = Date.parse("2026-11-27T10:47:00.000Z");
const failure = (code: string) => Object.assign(new Error(code), { code });
const stat = (pid: string, start: string) => `${pid} (node) S ${Array(18).fill("0").join(" ")} ${start}\n`;

/** The host's observed record: a daemon-container owner, its beat stopped well past three cadences. */
const holder = (extra: Partial<TestSlotHolder> = {}): TestSlotHolder => ({
  pid: 42, host: "vm", bootId: "boot", pidNs: OWNER_NS, processStart: "proc:101320783", ownerUid: process.getuid?.(),
  startedAt: new Date(NOW - 90 * CADENCE).toISOString(), heartbeatAt: new Date(NOW - 80 * CADENCE).toISOString(),
  heartbeatIntervalMs: CADENCE, workIdentity: "reservation-marker-v1", label: "retro-preflight:plan-reading-suites",
  ownerNonce: "owner-nonce", concurrency: 1, ...extra,
});

/** A waiter's /proc: its own namespace link, a one-entry NSpid either way, and only the processes it can see. */
function procHost(waiterNs: string, table: Record<string, string | Error>): ReservedTreeProbeHost {
  const proc: Record<string, string | Error> = { "/proc/self/ns/pid": waiterNs, "/proc/self/status": "Name:\twaiter\nNSpid:\t77\n", ...table };
  return {
    platform: "linux", bootId: "boot",
    list: () => Object.keys(proc).map(path => path.split("/")[2]!).filter((pid, i, all) => all.indexOf(pid) === i),
    read: path => {
      const value = proc[path];
      if (value instanceof Error) throw value;
      if (value === undefined) throw failure("ENOENT");
      return value;
    },
  };
}

/** A sibling container sees only itself: no member of the owner's namespace, and not the owner's start. */
const SIBLING = { "/proc/1/stat": stat("1", "500"), "/proc/1/ns/pid": SIBLING_NS, "/proc/1/status": "NSpid:\t1\n" };
/** The initial namespace sees the owner's live namespace init and the owner itself. */
const INITIAL_LIVE = {
  "/proc/1/stat": stat("1", "5"), "/proc/1/ns/pid": INITIAL_PID_NAMESPACE, "/proc/1/status": "NSpid:\t1\n",
  "/proc/900/stat": stat("900", "100"), "/proc/900/ns/pid": OWNER_NS, "/proc/900/status": "NSpid:\t900\t1\n",
  "/proc/942/stat": stat("942", "101320783"), "/proc/942/ns/pid": OWNER_NS, "/proc/942/status": "NSpid:\t942\t42\n",
};

function slot(t: TestContext, held: TestSlotHolder) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t15112-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "slot-1.json"), text = JSON.stringify(held);
  const prior = process.umask(0o022);
  try { writeFileSync(path, text, { mode: 0o644 }); } finally { process.umask(prior); }
  return { dir, path, text };
}

/** One poll through the REAL reclaim path with the real probes reading `host`. */
function poll(dir: string, waiterNs: string, host: ReservedTreeProbeHost) {
  const rows: Record<string, unknown>[] = [];
  const clock = { now: () => NOW, date: () => new Date(NOW), iso: () => new Date(NOW).toISOString() };
  const lease = acquireTestSlot("waiter", { dir, slots: 1, waitBoundMs: 0, queue: false, clock, sleep: () => {}, platform: "linux",
    hostname: () => "vm", bootId: () => "boot", pidNamespace: () => waiterNs, isPidAlive: () => true,
    load: () => ({ cores: 8, load1: 0 }), pidNamespaceProbe: record => probeRecordedPidNamespace(record, host),
    processStartScan: () => scanProcessStarts(host), log: line => rows.push(JSON.parse(line)), say: () => {} });
  lease.release?.();
  return { lease, rows };
}

test("W1-T15112 criterion 1: a sibling-namespace waiter keeps a live owner's aged slot", t => {
  const held = holder();
  assert.ok(NOW - Date.parse(held.heartbeatAt) > TEST_SLOT_SILENT_BEATS * CADENCE, "the hold is aged");
  const fixture = slot(t, held);
  const sibling = procHost(SIBLING_NS, SIBLING);
  for (let i = 0; i < 3; i += 1) {
    const { lease, rows } = poll(fixture.dir, SIBLING_NS, sibling);
    assert.equal(lease.outcome, "wait_bound_exceeded", lease.note);
    assert.equal(rows.filter(row => row.step === "test_slot.reclaimed_quiescent").length, 0);
    assert.match(JSON.stringify(rows.find(row => row.step === "test_slot.owner_aged")), /not in the initial pid namespace/);
  }
  assert.equal(readFileSync(fixture.path, "utf8"), fixture.text, "the live owner's record is byte-identical");
  // Each probe answers unknown, never ended, from the sibling.
  const ns = probeRecordedPidNamespace(held, sibling);
  assert.equal(ns.state, "unknown");
  assert.match(ns.reason, /not in the initial pid namespace \(pid:\[4026532999\]\)/);
  const starts = scanProcessStarts(sibling);
  assert.equal(starts.complete, false);
  // Positive control: the initial namespace sees the owner's live namespace and its live start, and keeps it too.
  assert.equal(probeRecordedPidNamespace(held, procHost(INITIAL_PID_NAMESPACE, INITIAL_LIVE)).state, "live");
  assert.equal(poll(fixture.dir, INITIAL_PID_NAMESPACE, procHost(INITIAL_PID_NAMESPACE, INITIAL_LIVE)).lease.outcome, "wait_bound_exceeded");
});

test("W1-T15112: an initial-namespace waiter still frees a dead owner whose namespace ended, as before", t => {
  // The owner's namespace is gone: no process in the initial namespace's view carries its link.
  const ended = procHost(INITIAL_PID_NAMESPACE, { "/proc/1/stat": stat("1", "5"), "/proc/1/ns/pid": INITIAL_PID_NAMESPACE, "/proc/1/status": "NSpid:\t1\n" });
  const fixture = slot(t, holder());
  const { lease, rows } = poll(fixture.dir, INITIAL_PID_NAMESPACE, ended);
  assert.equal(lease.outcome, "acquired", lease.note);
  const reclaimed = rows.find(row => row.step === "test_slot.reclaimed_quiescent");
  assert.equal(reclaimed?.coverage, "pid-namespace-ended");
  assert.equal(existsSync(fixture.path), false);
  // And the boot-wide start scan from the initial namespace is complete.
  const scan = scanProcessStarts(ended);
  assert.equal(scan.complete, true);
});

test("W1-T15112: an unreadable waiter namespace link is unknown in both probes (each catch arm)", () => {
  const unreadable = procHost(INITIAL_PID_NAMESPACE, { ...INITIAL_LIVE, "/proc/self/ns/pid": failure("EACCES") });
  const ns = probeRecordedPidNamespace(holder(), unreadable);
  assert.equal(ns.state, "unknown");
  assert.match(ns.reason, /pid namespace observation unreadable: .*EACCES/);
  const scan = scanProcessStarts(unreadable);
  assert.equal(scan.complete, false);
  assert.match(scan.complete ? "" : scan.reason, /process start scan unreadable: .*EACCES/);
});

test("W1-T15112: the default seam reads this process's real namespace link", { skip: process.platform !== "linux" }, () => {
  const mine = readlinkSync("/proc/self/ns/pid");
  const scan = scanProcessStarts();
  const ns = probeRecordedPidNamespace(holder({ bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() }));
  if (mine === INITIAL_PID_NAMESPACE) {
    assert.ok(scan.complete || !/initial pid namespace/.test(scan.reason), "an initial-namespace process is not refused for its namespace");
    assert.doesNotMatch(ns.reason, /not in the initial pid namespace/);
  } else {
    assert.equal(scan.complete, false);
    assert.match(scan.complete ? "" : scan.reason, /not in the initial pid namespace/);
    assert.equal(ns.state, "unknown");
    assert.match(ns.reason, new RegExp(`not in the initial pid namespace \\(${mine.replace(/[[\]]/g, "\\$&")}\\)`));
  }
});

/** Can this runner make real pid namespaces? (root, and unshare present) */
const canUnshare = process.platform === "linux" &&
  spawnSync("unshare", ["--pid", "--fork", "--mount-proc", "true"], { stdio: "ignore", timeout: 10_000 }).status === 0;

test("W1-T15112 criterion 1: in real namespaces, a sibling waiter keeps a live owner's stopped-beat slot", { skip: !canUnshare && "needs unshare and root" }, async t => {
  const work = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t15112-ns-`));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const lib = join(REPO_ROOT, "src", "lib", "test-slot.ts");
  const owner = join(work, "owner.mts"), waiter = join(work, "waiter.mts"), dir = join(work, "slots");
  writeFileSync(owner, `import { mkdirSync } from "node:fs";
import { acquireTestSlot, startTestSlotHeartbeat } from ${JSON.stringify(lib)};
mkdirSync(${JSON.stringify(dir)}, { recursive: true, mode: 0o777 });
const lease = acquireTestSlot("ns-owner", { dir: ${JSON.stringify(dir)}, slots: 1, queue: false, waitBoundMs: 0, log: () => {} });
if (!lease.heartbeat) process.exit(2);
const beat = startTestSlotHeartbeat({ ...lease.heartbeat, intervalMs: 100 }, () => {});
setTimeout(() => { beat.stop(false); console.log("owner-ready", process.pid); }, 150);
setInterval(() => {}, 60_000);
`);
  writeFileSync(waiter, `import { acquireTestSlot } from ${JSON.stringify(lib)};
const rows = [];
const lease = acquireTestSlot("sibling", { dir: ${JSON.stringify(dir)}, slots: 1, queue: false, waitBoundMs: 0, log: l => rows.push(JSON.parse(l)), say: () => {} });
console.log(JSON.stringify({ outcome: lease.outcome, steps: rows.map(r => r.step + ":" + (r.coverage ?? "")) }));
lease.release?.();
`);
  const ownerNs = spawn("unshare", ["--pid", "--fork", "--mount-proc", process.execPath, "--import", "tsx", owner],
    { cwd: REPO_ROOT, detached: true, stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { try { process.kill(-ownerNs.pid!, "SIGKILL"); } catch { /* already gone */ } });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("owner never became ready")), 60_000);
    ownerNs.stdout!.on("data", chunk => { if (String(chunk).includes("owner-ready")) { clearTimeout(timer); resolve(); } });
  });
  // Let the stopped beat age past three cadences (300 ms) before the sibling looks.
  await new Promise(resolve => setTimeout(resolve, 1_000));
  const before = readFileSync(join(dir, "slot-1.json"), "utf8");
  const sibling = spawnSync("unshare", ["--pid", "--fork", "--mount-proc", process.execPath, "--import", "tsx", waiter],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000 });
  assert.equal(sibling.status, 0, sibling.stderr);
  const result = JSON.parse(sibling.stdout.trim().split("\n").at(-1)!);
  assert.equal(result.outcome, "wait_bound_exceeded", JSON.stringify(result));
  assert.ok(!result.steps.some((step: string) => step.startsWith("test_slot.reclaimed_quiescent")), JSON.stringify(result));
  assert.equal(readFileSync(join(dir, "slot-1.json"), "utf8"), before, "the live owner's record is untouched");
});
