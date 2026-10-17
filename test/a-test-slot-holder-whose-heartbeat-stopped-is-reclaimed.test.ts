import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync, type Stats } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import {
  acquireTestSlot, beatTestSlot, probeReservedTree, releaseTestSlotForOwner, startTestSlotHeartbeat, TEST_SLOT_DIR_ENV, TEST_SLOT_HEARTBEAT_MS,
  TEST_SLOT_PARENT_ENV, TEST_SLOT_RUN_ENV, type ReservedTreeEvidence, type TestSlotHolder, type TestSlotOptions,
  testSlotReservationIdentity,
} from "#src/lib/test-slot.js";
import { acquireSlotMutation, createGuardHolderProbe, defaultGuardHolderProbe, reclaimOrphanedSlotMutation, type GuardHolderEvidence } from "#src/lib/test-slot-mutation.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { makeRuntimeFixture } from "#test/helpers/native-runtime-fixture.js";

const SLOT_MODULE = new URL("../src/lib/test-slot.ts", import.meta.url).href;
const IDLE = () => ({ cores: 8, load1: 0 });

function slotDir(t: TestContext, kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t9928-${kind}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fake clock whose sleep advances it, so a bounded wait runs in no real time. */
function fakeTime(start = Date.now()) {
  let now = start;
  const clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  return { clock, sleep: (ms: number) => { now += ms; }, advance: (ms: number) => { now += ms; }, get now() { return now; } };
}

/** Counts every signal other than the liveness probe 0; reclaim must send none. */
function signalSpy(t: TestContext): { delivered: () => number } {
  const real = process.kill;
  let delivered = 0;
  process.kill = ((pid: number, signal?: string | number) => {
    if (signal !== 0) delivered += 1;
    return real.call(process, pid, signal as never);
  }) as typeof process.kill;
  t.after(() => { process.kill = real; });
  return { delivered: () => delivered };
}

function deadPid(): number {
  const exited = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.equal(exited.status, 0);
  return exited.pid!;
}

function holder(fields: Partial<TestSlotHolder>): TestSlotHolder {
  const at = new Date().toISOString();
  return { pid: deadPid(), host: hostname(), bootId: "boot-1", pidNs: "ns-1", startedAt: at, heartbeatAt: at,
    label: "fixture owner", ownerNonce: "nonce-a", processStart: "proc:4242", ownerUid: process.getuid?.(), concurrency: 1, ...fields };
}

function terminal(held: TestSlotHolder): ReservedTreeEvidence {
  return { state: "ended", coverage: "fixture complete run monitor", reason: "all covered work ended",
    reservation: testSlotReservationIdentity(held), complete: true };
}

function writeHolder(path: string, held: TestSlotHolder | Record<string, unknown>, mode = 0o644): void {
  writeFileSync(path, JSON.stringify(held), { mode });
  chmodSync(path, mode);
}

function rows(lines: string[], step: string): Record<string, unknown>[] {
  return lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(row => row.step === step);
}

const waiterBase = (dir: string, lines: string[], extra: Partial<TestSlotOptions> = {}): TestSlotOptions => ({
  dir, slots: 1, load: IDLE, hostname, bootId: () => "boot-1", pidNamespace: () => "ns-1", isPidAlive: () => false,
  waitBoundMs: 0, log: line => lines.push(line), ...extra,
});

test("W1-T9928: a silent holder with a live validation child cannot be double admitted", async t => {
  const dir = slotDir(t, "live-child"), done = join(dir, "child-finished");
  // A REAL owner process: it takes the slot, states a cadence with one real beat, starts a marked validation
  // child, then stops beating and EXITS without releasing, while its child keeps working.
  const owner = `import {acquireTestSlot, beatTestSlot} from ${JSON.stringify(SLOT_MODULE)};
    import {spawn} from "node:child_process";
    const [dir, done] = process.argv.slice(1);
    const lease = acquireTestSlot("fixture validation owner", {dir, slots: 1, waitBoundMs: 0, log: () => {}, load: () => ({cores: 8, load1: 0})});
    if (lease.outcome !== "acquired" || !lease.heartbeat) throw new Error("fixture owner was not admitted: " + lease.note);
    const beat = beatTestSlot({...lease.heartbeat, intervalMs: 50});
    const child = spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'finished'), 4000)", done],
      {env: {...process.env, ...lease.heartbeat.coverageEnvironment}, stdio: "ignore", detached: true});
    child.unref();
    process.stdout.write(JSON.stringify({beat, child: child.pid, parent: process.pid, nonce: lease.heartbeat.ownerNonce}));
    process.exit(0);`;
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_TEST_CONTEXT: undefined };
  delete env[TEST_SLOT_PARENT_ENV]; delete env[TEST_SLOT_RUN_ENV]; delete env[TEST_SLOT_DIR_ENV];
  const ran = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", owner, dir, done],
    { encoding: "utf8", timeout: 30_000, env });
  assert.equal(ran.status, 0, ran.stderr);
  const fixture = JSON.parse(ran.stdout) as { beat: string; child: number; parent: number; nonce: string };
  assert.equal(fixture.beat, "beat", "positive control: the owner really stated a cadence");
  const recorded = JSON.parse(readFileSync(join(dir, "slot-1.json"), "utf8")) as TestSlotHolder;
  assert.equal(recorded.heartbeatIntervalMs, 50);
  assert.equal(recorded.pid, fixture.parent);
  assert.throws(() => process.kill(fixture.parent, 0), /ESRCH/, "the owner parent really exited");

  // A second waiter with every real default: real pid probe, real exact-tree probe. Its clock runs far past
  // three missed beats, which the SAFETY COUNTEREXAMPLE would have turned into a reclaim.
  const lines: string[] = [], time = fakeTime(), signals = signalSpy(t);
  const second = acquireTestSlot("second waiter", { dir, slots: 1, load: IDLE, clock: time.clock, sleep: time.sleep,
    waitBoundMs: 30_000, log: line => lines.push(line) });
  assert.equal(second.outcome, "wait_bound_exceeded", second.note);
  assert.equal(second.executionAllowed, false, "the bound cannot turn unproven live work into unslotted capacity");
  assert.equal(JSON.parse(readFileSync(join(dir, "slot-1.json"), "utf8")).ownerNonce, fixture.nonce, "the live child's reservation is intact");
  const silence = rows(lines, "test_slot.heartbeat_silent");
  assert.equal(silence.length, 1, "missed beats are observed once, as a diagnostic");
  assert.match(String(silence[0]!.decision), /^retained/);
  const withheld = rows(lines, "test_slot.reclaim_withheld");
  assert.equal(withheld.length, 1, lines.join("\n"));
  if (process.platform === "linux") {
    assert.equal(withheld[0]!.evidence, "live");
    assert.match(String(withheld[0]!.reason), new RegExp(`covered descendant pid ${fixture.child}\\b`));
  } else assert.equal(withheld[0]!.evidence, "unknown", "an unsupported probe keeps capacity reserved");
  assert.equal(rows(lines, "test_slot.reclaimed_quiescent").length, 0);
  assert.equal(signals.delivered(), 0, "no waiter signals any process");

  // The validation child is never disturbed: it finishes normally.
  const deadline = Date.now() + 20_000;
  while (!existsSync(done) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  assert.equal(readFileSync(done, "utf8"), "finished");
});

test("W1-T9928: only proven quiescence or an identity-checked owner release frees capacity", t => {
  const signals = signalSpy(t);
  // Exact-tree probe: identity, namespace and coverage must all be positive before `ended`.
  const owner = holder({ pid: 10, processStart: "proc:500" });
  const proc = (table: Record<string, { start: number; environ?: string | Error }>) => ({
    platform: "linux" as const, hostname, bootId: "boot-1", pidNs: "ns-1", list: () => Object.keys(table),
    read: (path: string) => {
      const [, , pid, file] = path.split("/");
      const entry = table[pid!];
      if (!entry) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      if (file === "stat") return `${pid} (node) S ${"0 ".repeat(18)}${entry.start} 0 0`;
      if (entry.environ instanceof Error) throw entry.environ;
      return entry.environ ?? "PATH=/bin\0";
    },
  });
  const eacces = Object.assign(new Error("denied"), { code: "EACCES" });
  assert.equal(probeReservedTree(owner, proc({ 10: { start: 500 } })).state, "live", "the owner itself is alive");
  const marked = probeReservedTree(owner, proc({ 10: { start: 900 }, 11: { start: 600,
    environ: `HOME=/h\0${TEST_SLOT_RUN_ENV}=${JSON.stringify({ nonce: owner.ownerNonce, pid: owner.pid, start: owner.processStart })}\0` } }));
  assert.deepEqual([marked.state, /pid 11/.test(marked.reason)], ["live", true], "a reparented descendant keeps it after its parent died");
  const partial = probeReservedTree(owner, proc({ 11: { start: 600, environ: eacces } }));
  assert.equal(partial.state, "unknown", "an unreadable later process is incomplete evidence");
  assert.match(partial.reason, /incomplete/);
  assert.equal(probeReservedTree(owner, proc({ 3: { start: 1, environ: eacces }, 10: { start: 900 }, 12: { start: 700 } })).state, "unknown",
    "marker absence cannot prove that a detached descendant did not replace its environment or fork during the scan");
  assert.equal(probeReservedTree({ ...owner, pidNs: "ns-other" }, proc({})).state, "unknown", "a foreign namespace is unprobeable");
  assert.equal(probeReservedTree({ ...owner, ownerNonce: undefined }, proc({})).state, "unknown", "unknown ownership");
  assert.equal(probeReservedTree({ ...owner, ownerUid: undefined }, proc({})).state, "unknown", "unknown uid");
  assert.equal(probeReservedTree({ ...owner, processStart: "proc:NaN" }, proc({})).state, "unknown", "invalid process start");
  assert.equal(probeReservedTree({ ...owner, host: "another-host" }, proc({})).state, "unknown", "another host");
  assert.equal(probeReservedTree(owner, { ...proc({}), platform: "darwin" }).state, "unknown", "no darwin tree probe: reserved");
  const unreadableTable = probeReservedTree(owner, { ...proc({}), list: () => { throw eacces; } });
  assert.equal(unreadableTable.state, "unknown");
  assert.match(unreadableTable.reason, /process table unreadable.*denied/);
  const unreadableStat = probeReservedTree(owner, { ...proc({}), list: () => ["11"], read: () => { throw eacces; } });
  assert.equal(unreadableStat.state, "unknown");
  assert.match(unreadableStat.reason, /11: process identity unreadable.*denied/);
  const malformedMarker = probeReservedTree(owner, proc({ 11: { start: 600, environ: `${TEST_SLOT_RUN_ENV}={bad json\0` } }));
  assert.equal(malformedMarker.state, "unknown");
  assert.match(malformedMarker.reason, /malformed reservation marker/);
  assert.match(malformedMarker.reason, /incomplete/);

  const dir = slotDir(t, "quiescence"), path = join(dir, "slot-1.json");
  const attempt = (probe: (held: TestSlotHolder) => ReservedTreeEvidence, extra: Partial<TestSlotOptions> = {}) => {
    const lines: string[] = [];
    const lease = acquireTestSlot("waiter", waiterBase(dir, lines, { treeProbe: probe, ...extra }));
    return { lease, lines };
  };
  const silentOwner = holder({ heartbeatIntervalMs: 1000, heartbeatAt: new Date(Date.now() - 600_000).toISOString() });
  // Silence plus a dead pid is not quiescence: unknown/incomplete and live evidence both retain the slot.
  for (const evidence of [{ state: "unknown", coverage: "proc-environ (incomplete)", reason: "incomplete: 1 process unreadable" },
    { state: "live", coverage: "proc-environ", reason: "covered descendant pid 77 still carries the reservation marker" },
    { state: "ended", coverage: "partial monitor", reason: "missing complete reservation evidence" }] as const) {
    writeHolder(path, silentOwner);
    const { lease, lines } = attempt(() => evidence);
    assert.equal(lease.outcome, "wait_bound_exceeded", evidence.state);
    assert.equal(lease.executionAllowed, false, "unproven protected capacity never permits an unslotted run");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).ownerNonce, "nonce-a");
    assert.match(String(rows(lines, "test_slot.reclaim_withheld")[0]?.reason), evidence.state === "ended" ? /incomplete|identity/ : new RegExp(evidence.reason));
  }
  writeHolder(path, { ...silentOwner, heartbeatIntervalMs: undefined, workIdentity: "reservation-marker-v1" });
  const withdrawn = attempt(() => ({ state: "unknown", coverage: "none", reason: "no complete monitor" }));
  assert.equal(withdrawn.lease.outcome, "wait_bound_exceeded", "withdrawing a cadence never authorizes parent-only recovery");
  assert.equal(withdrawn.lease.executionAllowed, false);
  writeHolder(path, silentOwner);
  const failed = attempt(() => { throw new Error("monitor failed"); });
  assert.equal(failed.lease.outcome, "wait_bound_exceeded");
  assert.equal(failed.lease.executionAllowed, false);
  assert.match(String(rows(failed.lines, "test_slot.reclaim_withheld")[0]?.reason), /monitor failed/);
  // Unknown owner identity, judged by the REAL default probe (identity is checked before any scan).
  writeHolder(path, { ...silentOwner, ownerNonce: undefined, processStart: undefined });
  const anonymous = attempt(undefined as never, { treeProbe: undefined, platform: "linux" });
  assert.equal(anonymous.lease.outcome, "wait_bound_exceeded");
  assert.match(String(rows(anonymous.lines, "test_slot.reclaim_withheld")[0]?.reason), /owner identity unknown/);
  // PID reuse: the recorded pid is alive as ANOTHER process; a live pid is never second-guessed by beat age.
  writeHolder(path, { ...silentOwner, pid: process.pid, processStart: "proc:1" });
  let probed = 0;
  assert.equal(attempt(() => { probed += 1; return { state: "ended", coverage: "x", reason: "x" }; }, { isPidAlive: () => true }).lease.outcome, "wait_bound_exceeded");
  assert.equal(probed, 0);
  // A replaced reservation during the probe is held for re-observation, never deleted.
  writeHolder(path, silentOwner);
  const replacement = holder({ ownerNonce: "nonce-b", heartbeatIntervalMs: 1000 });
  const replaced = attempt(held => {
    if (held.ownerNonce === "nonce-a") { writeHolder(path, replacement); return { state: "ended", coverage: "proc-environ", reason: "owner gone" }; }
    return { state: "live", coverage: "proc-environ", reason: "replacement owner alive" };
  });
  assert.equal(replaced.lease.outcome, "wait_bound_exceeded");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).ownerNonce, "nonce-b", "the replacement survives");
  // Positive control: exact-tree terminal evidence admits exactly one waiter, logged with its identity.
  writeHolder(path, silentOwner);
  const freed = attempt(terminal);
  assert.equal(freed.lease.outcome, "acquired", freed.lease.note);
  const reclaimed = rows(freed.lines, "test_slot.reclaimed_quiescent");
  assert.equal(reclaimed.length, 1);
  assert.deepEqual([reclaimed[0]!.ownerNonce, reclaimed[0]!.processStart, reclaimed[0]!.coverage], ["nonce-a", "proc:4242", "fixture complete run monitor"]);
  freed.lease.release();

  // Owner-assisted release: identity-checked, refused while covered work lives, held on a late refresh.
  const request = { ownerNonce: "nonce-a", pid: silentOwner.pid, processStart: "proc:4242" };
  const release = (probe: (held: TestSlotHolder) => ReservedTreeEvidence, req = request) =>
    releaseTestSlotForOwner(path, req, { treeProbe: probe, isPidAlive: () => false, hostname, bootId: () => "boot-1", pidNamespace: () => "ns-1", log: () => {} });
  const ended = (): ReservedTreeEvidence => terminal(silentOwner);
  writeHolder(path, silentOwner);
  assert.equal(release(() => ({ state: "live", coverage: "proc-environ", reason: "child alive" })).outcome, "refused");
  assert.equal(release(() => ({ state: "unknown", coverage: "none", reason: "permission denied" })).outcome, "refused", "unknown never means work ended");
  assert.equal(release(() => ({ ...ended(), complete: false })).outcome, "refused", "partial evidence");
  assert.equal(release(() => ({ ...ended(), reservation: testSlotReservationIdentity({ ...silentOwner, ownerNonce: "nonce-z" }) })).outcome,
    "refused", "evidence for a different generation");
  assert.equal(release(() => { throw new Error("probe failed"); }).outcome, "refused", "failed probe retains capacity");
  for (const drift of [{ host: "another-host" }, { bootId: "another-boot" }, { pidNs: "another-ns" }, { ownerUid: undefined },
    { ownerUid: (process.getuid?.() ?? 0) + 1 }]) {
    writeHolder(path, { ...silentOwner, ...drift });
    assert.equal(release(ended).outcome, "refused", `identity boundary ${JSON.stringify(drift)}`);
  }
  writeHolder(path, silentOwner);
  assert.equal(release(ended, { ...request, processStart: "proc:9" }).outcome, "refused", "PID reuse");
  assert.equal(release(ended, { ...request, ownerNonce: "nonce-z" }).outcome, "refused", "a replaced reservation");
  const allegedLive = { ...silentOwner, pid: deadPid() };
  writeHolder(path, allegedLive);
  const aliveResult = releaseTestSlotForOwner(path, { ...request, pid: allegedLive.pid }, { treeProbe: terminal,
    isPidAlive: () => true, hostname, bootId: () => "boot-1", pidNamespace: () => "ns-1", log: () => {} });
  if (aliveResult.outcome === "released") assert.fail("a reported live owner cannot be released");
  assert.match(aliveResult.reason, /owner pid .* is alive/);
  writeHolder(path, silentOwner);
  assert.equal(release(() => { writeHolder(path, { ...silentOwner, heartbeatAt: new Date().toISOString() }); return ended(); }).outcome,
    "held", "a late refresh holds the record for re-observation");
  writeHolder(path, silentOwner);
  const changedDuringUnlink = releaseTestSlotForOwner(path, request, { treeProbe: terminal, isPidAlive: () => false,
    hostname, bootId: () => "boot-1", pidNamespace: () => "ns-1",
    log: () => writeHolder(path, { ...silentOwner, heartbeatAt: new Date(Date.now() + 1000).toISOString() }) });
  assert.equal(changedDuringUnlink.outcome, "held", "a changed heartbeat after audit cannot be unlinked");
  assert.equal(existsSync(path), true);
  unlinkSync(path);
  const absent = release(ended);
  if (absent.outcome === "released") assert.fail("an absent reservation cannot be released");
  assert.match(absent.reason, /no reservation at this path/);
  writeHolder(path, silentOwner);
  writeHolder(path, { ...silentOwner, ownerNonce: undefined });
  assert.equal(release(ended).outcome, "refused", "unknown owner identity");
  writeHolder(path, silentOwner, 0o600);
  assert.equal(release(ended).outcome, "refused", "a private record stays owner-lane only");
  assert.equal(existsSync(path), true);
  writeHolder(path, silentOwner);
  const blocked = attempt(() => ({ state: "unknown", coverage: "none", reason: "unproven" }));
  assert.equal(blocked.lease.outcome, "wait_bound_exceeded", "before the owner release, the waiter is not admitted");
  assert.equal(release(ended).outcome, "released");
  const admitted = attempt(() => assert.fail("a free slot needs no evidence"));
  assert.equal(admitted.lease.outcome, "acquired");
  admitted.lease.release();
  assert.equal(signals.delivered(), 0, "neither reclaim nor owner release signals anything");
});

test("W1-T9928: a beating or cadence-less live holder keeps its slot", t => {
  const dir = slotDir(t, "beating"), path = join(dir, "slot-1.json");
  const hourAgo = new Date(Date.now() - 10 * 3_600_000).toISOString();
  const cases: { name: string; held: Partial<TestSlotHolder>; silent: boolean }[] = [
    { name: "cadence-less, ten hours quiet", held: { heartbeatAt: hourAgo }, silent: false },
    { name: "beating inside its bound", held: { heartbeatIntervalMs: 1000 }, silent: false },
    { name: "cadence stated, beats missed", held: { heartbeatIntervalMs: 1000, heartbeatAt: new Date(Date.now() - 10_000).toISOString() }, silent: true },
  ];
  for (const { name, held, silent } of cases) {
    writeHolder(path, holder({ pid: process.pid, processStart: undefined, ...held }));
    let probed = 0;
    const lines: string[] = [];
    const lease = acquireTestSlot("waiter", waiterBase(dir, lines, { isPidAlive: () => true,
      treeProbe: () => { probed += 1; return { state: "ended", coverage: "x", reason: "x" }; } }));
    assert.equal(lease.outcome, "wait_bound_exceeded", name);
    assert.equal(existsSync(path), true, name);
    assert.equal(probed, 0, `${name}: a live pid never reaches the tree probe`);
    const observed = rows(lines, "test_slot.heartbeat_silent");
    assert.equal(observed.length, silent ? 1 : 0, name);
    if (silent) assert.match(String(observed[0]!.decision), /^retained/);
  }
});

test("W1-T9928: preflight-author keeps beating its slot while a step runs", async t => {
  const capture = await import(pathToFileURL(join(process.cwd(), "scripts/lib/author-step-capture.mjs")).href) as {
    captureStepSync: (file: string, args: string[], options: Record<string, unknown>) => { status: number | null; stdout: string; stderr: string };
  };
  const dir = slotDir(t, "spooler"), logs = slotDir(t, "spooler-logs");
  const lease = acquireTestSlot("blocked author", { dir, slots: 1, load: IDLE, waitBoundMs: 0, log: () => {} });
  t.after(() => lease.release());
  assert.equal(lease.outcome, "acquired");
  assert.ok(lease.heartbeat, "a legacy lease owned by this process offers a beat handle");
  assert.equal(lease.heartbeat.intervalMs, TEST_SLOT_HEARTBEAT_MS);
  const path = lease.heartbeat.path, before = JSON.parse(readFileSync(path, "utf8")) as TestSlotHolder;
  assert.equal(before.heartbeatIntervalMs, undefined, "no cadence is claimed before anything beats");
  // spawnSync blocks THIS event loop for the whole step; only the spooler can beat. The step reads the record twice.
  const step = `const fs = require("node:fs"); const read = () => JSON.parse(fs.readFileSync(${JSON.stringify(path)}, "utf8"));
    setTimeout(() => { const first = read(); setTimeout(() => {
      console.log(JSON.stringify({ first, second: read(), marker: process.env[${JSON.stringify(TEST_SLOT_RUN_ENV)}] })); }, 900); }, 300);`;
  const result = capture.captureStepSync(process.execPath, ["-e", step], { cwd: process.cwd(), env: process.env,
    stdoutPath: join(logs, "out.log"), stderrPath: join(logs, "err.log"), resultPath: join(logs, "result.json"),
    heartbeat: { ...lease.heartbeat, intervalMs: 100 } });
  assert.equal(result.status, 0, result.stderr);
  const seen = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { first: TestSlotHolder; second: TestSlotHolder; marker: string };
  assert.equal(seen.first.heartbeatIntervalMs, 100, "the record states the cadence while the step runs");
  assert.ok(Date.parse(seen.second.heartbeatAt) > Date.parse(seen.first.heartbeatAt), "it kept beating while the author was blocked");
  assert.ok(Date.parse(seen.first.heartbeatAt) >= Date.parse(before.heartbeatAt));
  assert.equal(JSON.parse(seen.marker).nonce, lease.heartbeat.ownerNonce, "every covered descendant carries the reservation marker");
  const after = JSON.parse(readFileSync(path, "utf8")) as TestSlotHolder;
  assert.equal(after.heartbeatIntervalMs, undefined, "the cadence is withdrawn once the step's process group ended");
  assert.equal(after.workIdentity, "reservation-marker-v1", "withdrawal never restores parent-only recovery");
  lease.refresh();
  assert.equal(JSON.parse(readFileSync(path, "utf8")).workIdentity, "reservation-marker-v1", "an owner refresh preserves work identity");
  assert.equal(after.ownerNonce, before.ownerNonce);
  // A delayed beat is diagnostic only: far past three intervals, a live owner keeps its slot.
  assert.equal(beatTestSlot({ ...lease.heartbeat, intervalMs: 100 }), "beat");
  const lines: string[] = [], time = fakeTime(Date.now() + 60_000);
  const late = acquireTestSlot("late waiter", { dir, slots: 1, load: IDLE, clock: time.clock, waitBoundMs: 0, log: line => lines.push(line) });
  assert.equal(late.outcome, "wait_bound_exceeded");
  assert.equal(rows(lines, "test_slot.heartbeat_silent").length, 1);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).ownerNonce, before.ownerNonce);

  // A blocked initial beat must not start work against an unprotected reservation.
  const guard = join(dir, ".slot-1.json.mutation"), shouldNotRun = join(logs, "unexpected-child");
  const guardFd = openSync(guard, "wx", 0o600);
  try {
    const refused = capture.captureStepSync(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(shouldNotRun)}, "ran")`],
      { cwd: process.cwd(), env: process.env, stdoutPath: join(logs, "blocked-out"), stderrPath: join(logs, "blocked-err"),
        resultPath: join(logs, "blocked-result"), heartbeat: lease.heartbeat });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /initial heartbeat deferred/);
    assert.equal(existsSync(shouldNotRun), false);
  } finally { closeSync(guardFd); unlinkSync(guard); }

  // The shipped author wires the beat into its slotted test step.
  const f = makeRuntimeFixture(); t.after(() => f.cleanup());
  const slots = join(f.dir, "slots"), witness = join(slotDir(t, "witness"), "beat-witness.json");
  writeFileSync(join(f.dir, "test/a.test.ts"), `import {readFileSync, writeFileSync} from "node:fs"; import {test} from "node:test";
    test("records the beating slot", () => { writeFileSync(${JSON.stringify(witness)}, JSON.stringify({
      record: JSON.parse(readFileSync(${JSON.stringify(join(slots, "slot-1.json"))}, "utf8")), marker: process.env.${TEST_SLOT_RUN_ENV} ?? null })); });\n`);
  f.git("add", "test"); f.git("commit", "-m", "test: witness the beating author slot");
  const { main } = await import(pathToFileURL(join(process.cwd(), "scripts/preflight-author.mjs")).href) as {
    main: (argv: string[], deps: { root: string; select: () => { fullRun: boolean; suites: string[]; reasons: string[] } }) => number;
  };
  // This nested author owns the fixture's slot, not the real admitted parent running this test file.
  const privateSlotKeys = [TEST_SLOT_DIR_ENV, TEST_SLOT_PARENT_ENV, TEST_SLOT_RUN_ENV] as const;
  const prior = new Map(privateSlotKeys.map(key => [key, process.env[key]]));
  process.env[TEST_SLOT_DIR_ENV] = slots;
  delete process.env[TEST_SLOT_PARENT_ENV];
  delete process.env[TEST_SLOT_RUN_ENV];
  try {
    assert.equal(main([], { root: f.dir, select: () => ({ fullRun: false, suites: ["test/a.test.ts"], reasons: ["beat witness"] }) }), 0);
  } finally {
    for (const key of privateSlotKeys) {
      const value = prior.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const observed = JSON.parse(readFileSync(witness, "utf8")) as { record: TestSlotHolder; marker: string | null };
  assert.equal(observed.record.label, "preflight-author:static-and-affected");
  assert.equal(observed.record.heartbeatIntervalMs, TEST_SLOT_HEARTBEAT_MS, "the author's test step ran under a beating record");
  assert.equal(JSON.parse(observed.marker!).nonce, observed.record.ownerNonce);
});

test("W1-T9928: heartbeat faults retain diagnostics and never release a changed reservation", async t => {
  const dir = slotDir(t, "heartbeat-faults");
  const lease = acquireTestSlot("heartbeat faults", { dir, slots: 1, load: IDLE, waitBoundMs: 0, log: () => {} });
  assert.equal(lease.outcome, "acquired");
  assert.ok(lease.heartbeat);
  const handle = { ...lease.heartbeat, intervalMs: 15 };
  const path = handle.path, original = readFileSync(path, "utf8"), mode = lstatSync(path).mode & 0o777;
  const logs: Record<string, unknown>[] = [];
  const waitFor = async (step: string): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (!logs.some(row => row.step === step) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(logs.some(row => row.step === step), `expected ${step}: ${JSON.stringify(logs)}`);
  };
  const restore = (): void => {
    try { lstatSync(path); unlinkSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    writeFileSync(path, original, { mode });
  };
  try {
    assert.equal(beatTestSlot(handle), "beat");
    unlinkSync(path);
    assert.equal(beatTestSlot(handle), "lost", "an absent reservation is lost through the open error arm");
    restore();
    const lost = startTestSlotHeartbeat(handle, row => logs.push(row));
    const changed = { ...JSON.parse(readFileSync(path, "utf8")) as TestSlotHolder, ownerNonce: "replacement" };
    writeHolder(path, changed, mode);
    await waitFor("test_slot.heartbeat_lost");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).ownerNonce, "replacement");
    lost.stop(true);
    restore();

    const failed = startTestSlotHeartbeat(handle, row => logs.push(row));
    unlinkSync(path); symlinkSync(join(dir, "missing-target"), path);
    await waitFor("test_slot.heartbeat_failed");
    failed.stop(false);
    assert.ok(logs.some(row => row.step === "test_slot.heartbeat_stopped"));
    assert.equal(lstatSync(path).isSymbolicLink(), true, "a failed beat never removes the replacement");
    restore();

    const withdrawal = startTestSlotHeartbeat(handle, row => logs.push(row));
    unlinkSync(path); symlinkSync(join(dir, "missing-target"), path);
    withdrawal.stop(true);
    assert.ok(logs.some(row => row.step === "test_slot.heartbeat_withdraw_failed"));
    restore();
  } finally { restore(); lease.release(); }
});

test("W1-T9928: an orphaned mutation guard is reclaimed and an open one is kept", t => {
  const dir = slotDir(t, "guard"), path = join(dir, "slot-1.json"), guard = join(dir, ".slot-1.json.mutation");
  const orphan = (ageMs = 3_600_000): void => {
    writeFileSync(guard, "", { mode: 0o600 });
    const then = new Date(Date.now() - ageMs);
    utimesSync(guard, then, then);
  };
  const recovery = (state: GuardHolderEvidence["state"], boundMs: number | undefined, logged: Record<string, unknown>[], probes = { n: 0 }) => ({
    boundMs: () => boundMs, now: () => Date.now(), log: (row: Record<string, unknown>) => logged.push(row),
    probe: (): GuardHolderEvidence => { probes.n += 1; return { state, probe: "fixture", reason: `fixture ${state}` }; },
  });
  for (const [state, bound, age, outcome] of [["open", 10, 3_600_000, "busy"], ["unknown", 10, 3_600_000, "busy"],
    ["closed", undefined, 3_600_000, "busy"], ["closed", 7_200_000, 3_600_000, "busy"], ["closed", 10, 3_600_000, "acquired"]] as const) {
    orphan(age);
    const logged: Record<string, unknown>[] = [], probes = { n: 0 };
    const mutation = acquireSlotMutation(path, recovery(state, bound, logged, probes));
    assert.equal(mutation.state, outcome, `${state} ${bound} ${age}`);
    assert.equal(probes.n, bound === undefined || bound > age ? 0 : 1, "no measured bound, or a young guard, is never probed");
    if (mutation.state === "acquired") {
      assert.deepEqual(logged.map(row => row.step), ["test_slot.mutation_guard_reclaimed"]);
      const row = logged[0]!;
      assert.deepEqual([row.path, row.uid, row.boundMs, row.probe], [guard, process.getuid?.(), 10, "fixture"]);
      assert.ok(Number(row.ageMs) >= 3_600_000 && typeof row.mtime === "string");
      mutation.release();
      assert.equal(existsSync(guard), false);
    } else {
      assert.equal(existsSync(guard), true, "an open, unproven or unjudged guard is kept");
      assert.deepEqual(logged.map(row => row.step), state === "unknown" ? ["test_slot.mutation_guard_unproven"] : []);
      unlinkSync(guard);
    }
  }
  // The REAL default open-file probe: a descriptor this process holds is seen; foreign uids are never judged.
  const fd = openSync(guard, "wx", 0o600), st: Stats = fstatSync(fd);
  try {
    const held = defaultGuardHolderProbe(guard, st);
    if (process.platform === "linux") assert.deepEqual([held.state, held.reason], ["open", `held open by pid ${process.pid}`]);
    else assert.notEqual(held.state, "closed");
  } finally { closeSync(fd); }
  const closed = defaultGuardHolderProbe(guard, lstatSync(guard));
  assert.notEqual(closed.state, "open");
  if (process.platform === "darwin") {
    assert.deepEqual([closed.state, closed.probe], ["unknown", "lsof"],
      "the direct default never invents a completed Darwin open-file observation");
    assert.match(closed.reason, /polling.*observer/i, "unknown says which observation is missing without fixing the diagnostic's wording");
  } else if (closed.state === "unknown") assert.match(closed.reason, /incomplete|no open-file probe|lsof/);
  assert.equal(defaultGuardHolderProbe(guard, { ...st, uid: (process.getuid?.() ?? 0) + 1 } as Stats).state, "unknown");
  // Darwin's lsof path: pids are open, a silent exit 1 is closed, any diagnostic is unknown.
  const lsof = (outcome: string | { status: number; stdout: string; stderr: string }) => () => {
    if (typeof outcome === "string") return outcome;
    throw Object.assign(new Error("lsof exited"), outcome);
  };
  assert.equal(defaultGuardHolderProbe(guard, st, "darwin", lsof("812\n")).state, "open");
  assert.equal(defaultGuardHolderProbe(guard, st, "darwin", lsof({ status: 1, stdout: "", stderr: "" })).state, "closed");
  assert.equal(defaultGuardHolderProbe(guard, st, "darwin", lsof({ status: 1, stdout: "", stderr: "lsof: WARNING: can't stat()" })).state, "unknown");
  unlinkSync(guard);

  // A failed probe and a non-private guard cannot be mistaken for a proven orphan.
  orphan();
  const failedRows: Record<string, unknown>[] = [];
  assert.equal(acquireSlotMutation(path, { ...recovery("closed", 10, failedRows), probe: () => { throw new Error("probe denied"); } }).state, "busy");
  assert.match(String(failedRows[0]?.reason), /probe denied/);
  // A readable group/other bit makes the guard non-private without a uid-dependent denial.
  chmodSync(guard, 0o744);
  assert.equal(acquireSlotMutation(path, recovery("closed", 10, failedRows)).state, "busy");
  assert.equal(existsSync(guard), true);
  unlinkSync(guard);

  // The real Linux probe sees an open hard-link alias by inode, even when the named guard is closed.
  if (process.platform === "linux") {
    orphan();
    const alias = join(dir, "guard-alias"); linkSync(guard, alias);
    const aliasFd = openSync(alias, "r");
    try { assert.equal(defaultGuardHolderProbe(guard, lstatSync(guard)).state, "open"); }
    finally { closeSync(aliasFd); unlinkSync(alias); unlinkSync(guard); }
  }

  // A waiter measures its own holds on slot 2, meets slot 1's orphan on an earlier poll, then reclaims it.
  for (const state of ["closed", "open"] as const) {
    orphan();
    const lines: string[] = [], time = fakeTime();
    const lease = acquireTestSlot("guarded waiter", { dir, slots: 2, load: IDLE, clock: time.clock, sleep: time.sleep,
      waitBoundMs: 20_000, log: line => lines.push(line), guardProbe: () => ({ state, probe: "fixture", reason: state }) });
    if (state === "closed") {
      assert.equal(lease.outcome, "acquired", lease.note);
      assert.match(lease.note, /slot 1\/2/);
      assert.equal(rows(lines, "test_slot.mutation_guard_reclaimed").length, 1);
      lease.release();
    } else {
      assert.equal(lease.outcome, "wait_bound_exceeded", "a guard someone holds open is never stolen");
      assert.equal(existsSync(guard), true);
      unlinkSync(guard);
    }
  }
});

test("W1-T9928: a changed or vanished orphan guard is re-observed before reclaim", t => {
  const dir = slotDir(t, "guard-drift"), path = join(dir, "slot-1.json"), guard = join(dir, ".slot-1.json.mutation");
  const makeOldGuard = (): void => {
    writeFileSync(guard, "", { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(guard, old, old);
  };
  const rows: Record<string, unknown>[] = [];
  const recovery = (probe: () => GuardHolderEvidence) => ({ boundMs: () => 1, now: () => Date.now(),
    log: (row: Record<string, unknown>) => rows.push(row), probe });
  assert.equal(reclaimOrphanedSlotMutation(path, recovery(() => assert.fail("an absent guard has no holder to probe"))), "gone");
  makeOldGuard();
  assert.equal(reclaimOrphanedSlotMutation(path, recovery(() => {
    chmodSync(guard, 0o700);
    return { state: "closed", probe: "fixture", reason: "no holder" };
  })), "kept");
  assert.equal(existsSync(guard), true);
  assert.match(String(rows.at(-1)?.reason), /guard identity changed during the probe/);
  unlinkSync(guard);
  makeOldGuard();
  assert.equal(reclaimOrphanedSlotMutation(path, recovery(() => {
    unlinkSync(guard);
    return { state: "closed", probe: "fixture", reason: "no holder" };
  })), "gone");
  assert.equal(existsSync(guard), false);
});

test("W1-T9928: guard probe filesystem failures retain the guard", t => {
  const dir = slotDir(t, "guard-faults"), path = join(dir, "slot-1.json"), guard = join(dir, ".slot-1.json.mutation");
  const moduleUrl = new URL("../src/lib/test-slot-mutation.ts", import.meta.url).href;
  const run = (body: string): { state: string; reason: string; remains: boolean } => {
    writeFileSync(guard, "", { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(guard, old, old);
    const script = `import assert from 'node:assert/strict';
      import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const api = await import(${JSON.stringify(moduleUrl)});
      const guard = process.argv[1], path = process.argv[2];
      const logs = []; const base = {boundMs: () => 1, now: () => Date.now(), log: row => logs.push(row),
        probe: () => ({state: 'closed', probe: 'fixture', reason: 'no holder'})};
      ${body}
      console.log(JSON.stringify({state, reason, remains: fs.existsSync(guard)}));`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, guard, path],
      { encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1)!) as { state: string; reason: string; remains: boolean };
    if (existsSync(guard)) unlinkSync(guard);
    return result;
  };
  const table = run(`const original = fs.readdirSync;
    fs.readdirSync = (name, ...args) => { if (name === '/proc') throw Object.assign(Error('table denied'), {code: 'EACCES'});
      return original(name, ...args); }; syncBuiltinESMExports();
    const result = api.defaultGuardHolderProbe(guard, fs.lstatSync(guard), 'linux');
    const state = result.state, reason = result.reason;`);
  assert.deepEqual([table.state, table.remains], ["unknown", true]);
  assert.match(table.reason, /process table unreadable.*table denied/);

  const unreadable = run(`const original = fs.lstatSync;
    fs.lstatSync = (name, ...args) => { if (name === guard) throw Object.assign(Error('guard lookup denied'), {code: 'EACCES'});
      return original(name, ...args); }; syncBuiltinESMExports();
    const state = api.reclaimOrphanedSlotMutation(path, base);
    const reason = String(logs.at(-1)?.reason);`);
  assert.deepEqual([unreadable.state, unreadable.remains], ["kept", true]);
  assert.match(unreadable.reason, /guard unreadable.*guard lookup denied/);

  const foreign = run(`const original = fs.lstatSync;
    fs.lstatSync = (name, ...args) => { const st = original(name, ...args);
      if (name !== guard) return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {uid: process.getuid() + 1}); };
    syncBuiltinESMExports();
    const state = api.reclaimOrphanedSlotMutation(path, base);
    const reason = String(logs.at(-1)?.reason);`);
  assert.deepEqual([foreign.state, foreign.remains], ["kept", true]);
  assert.match(foreign.reason, /foreign-uid guard/);

  const unlinkFailure = run(`const original = fs.unlinkSync;
    fs.unlinkSync = (name, ...args) => { if (name === guard) throw Object.assign(Error('unlink denied'), {code: 'EACCES'});
      return original(name, ...args); }; syncBuiltinESMExports();
    const state = api.reclaimOrphanedSlotMutation(path, base);
    const reason = String(logs.at(-1)?.reason);`);
  assert.deepEqual([unlinkFailure.state, unlinkFailure.remains], ["kept", true]);
  assert.match(unlinkFailure.reason, /reclaim failed.*unlink denied/);

  const receiptFailure = run(`const original = fs.unlinkSync;
    fs.unlinkSync = (name, ...args) => { if (String(name).endsWith('/receipt')) {
        original(name, ...args); throw Object.assign(Error('receipt unlink denied'), {code: 'EACCES'}); }
      return original(name, ...args); }; syncBuiltinESMExports();
    const observer = api.createGuardHolderProbe();
    const result = observer.probe(guard, fs.lstatSync(guard), 'darwin'); observer.dispose();
    const state = result.state, reason = result.reason;`);
  assert.deepEqual([receiptFailure.state, receiptFailure.remains], ["unknown", true]);
  assert.match(receiptFailure.reason, /receipt unlink denied/);
});

test("W1-T9928: the darwin guard observer reads terminal receipts while its caller's loop is blocked", t => {
  const dir = slotDir(t, "lsof-receipt"), path = join(dir, "slot-1.json"), guard = join(dir, ".slot-1.json.mutation");
  writeFileSync(guard, "", { mode: 0o600 });
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath ?? ""}`;
  t.after(() => { if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath; });
  const observer = createGuardHolderProbe();
  t.after(() => observer.dispose());
  for (const [status, stdout, stderr, state] of [[0, "812\n", "", "open"], [1, "", "", "closed"],
    [1, "", "lsof: permission denied", "unknown"], [0, "", "", "unknown"], [2, "", "", "unknown"]] as const) {
    // A real executable owns the lsof exit status and streams, independent of the host's installed tools.
    writeFileSync(join(dir, "lsof"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(stdout)});\n` +
      `process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${status};\n`, { mode: 0o700 });
    const first = observer.probe(guard, lstatSync(guard), "darwin");
    assert.equal(first.state, "unknown", "launching a probe never claims closed capacity");
    assert.match(first.reason, /pending/);
    let result = first;
    const deadline = Date.now() + 10_000;
    while (/pending/.test(result.reason) && Date.now() < deadline) {
      // No callback can run in this process: synchronous legacy acquisition must still receive the result.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      result = observer.probe(guard, lstatSync(guard), "darwin");
    }
    assert.equal(result.state, state, result.reason);
    assert.doesNotMatch(result.reason, /pending/);
    assert.equal(existsSync(guard), true, "observing never unlinks a guard");
  }
  // A receipt belongs to one guard generation, even when its pathname is reused before the next poll.
  const witnessed = join(dir, "lsof-finished");
  writeFileSync(join(dir, "lsof"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(witnessed)}, 'done'); process.exitCode = 1;\n`, { mode: 0o700 });
  assert.equal(observer.probe(guard, lstatSync(guard), "darwin").state, "unknown");
  const witnessDeadline = Date.now() + 10_000;
  while (!existsSync(witnessed) && Date.now() < witnessDeadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  assert.equal(existsSync(witnessed), true);
  unlinkSync(guard);
  writeFileSync(guard, "", { mode: 0o600 });
  writeFileSync(join(dir, "lsof"), `#!${process.execPath}\nprocess.stdout.write('812');\n`, { mode: 0o700 });
  let replacement = observer.probe(guard, lstatSync(guard), "darwin");
  assert.equal(replacement.state, "unknown", "the old terminal receipt cannot judge a replacement");
  const replacementDeadline = Date.now() + 10_000;
  while (/pending/.test(replacement.reason) && Date.now() < replacementDeadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    replacement = observer.probe(guard, lstatSync(guard), "darwin");
  }
  assert.equal(replacement.state, "open", replacement.reason);
  // A positive silent-1 receipt reaches the real reclaim path only after it has completed.
  writeFileSync(join(dir, "lsof"), `#!${process.execPath}\nprocess.exitCode = 1;\n`, { mode: 0o700 });
  const logged: Record<string, unknown>[] = [];
  const recovery = { boundMs: () => 0, now: () => Date.now() + 10_000,
    probe: (name: string, st: Stats) => observer.probe(name, st, "darwin"), log: (row: Record<string, unknown>) => logged.push(row) };
  let mutation = acquireSlotMutation(path, recovery);
  assert.equal(mutation.state, "busy");
  const deadline = Date.now() + 10_000;
  while (mutation.state === "busy" && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    mutation = acquireSlotMutation(path, recovery);
  }
  assert.equal(mutation.state, "acquired", JSON.stringify(logged));
  if (mutation.state === "acquired") mutation.release();
  assert.equal(logged.filter(row => row.step === "test_slot.mutation_guard_reclaimed").length, 1);
  observer.dispose();
  observer.dispose();
});

test("W1-T9928: a waiter that met a busy guard acquires once it is gone", t => {
  const dir = slotDir(t, "gate"), guard = join(dir, ".slot-1.json.mutation");
  writeFileSync(guard, "", { mode: 0o600 });
  const lines: string[] = [], time = fakeTime();
  let sleeps = 0;
  const lease = acquireTestSlot("legacy waiter", { dir, slots: 2, load: IDLE, clock: time.clock, waitBoundMs: 60_000,
    guardProbe: () => ({ state: "open", probe: "fixture", reason: "a live writer" }), log: line => lines.push(line),
    sleep: ms => { time.sleep(ms); sleeps += 1; if (sleeps === 1) unlinkSync(guard); } });
  const waiting = rows(lines, "test_slot.waiting")[0];
  assert.ok((waiting?.holders as string[]).includes("slot 1: mutation pending; coordination UNKNOWN"), lines.join("\n"));
  assert.equal(lease.outcome, "acquired", lease.note);
  assert.equal(sleeps, 1, "the first poll after the guard is gone admits it");
  lease.release();
  // A 0600 private record still gates a legacy waiter, exactly as before.
  mkdirSync(join(dir, "private"));
  writeHolder(join(dir, "private", "slot-2.json"), holder({ pid: process.pid }), 0o600);
  const gated = acquireTestSlot("legacy waiter", { dir: join(dir, "private"), slots: 2, load: IDLE, waitBoundMs: 0, log: () => {} });
  assert.equal(gated.outcome, "wait_bound_exceeded");
  assert.match(gated.note, /private coordination encountered; private writer remains gated/);
});
