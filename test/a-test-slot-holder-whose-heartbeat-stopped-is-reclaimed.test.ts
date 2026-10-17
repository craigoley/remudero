import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync, type Stats } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import {
  acquireTestSlot, beatTestSlot, probeReservedTree, releaseTestSlotForOwner, TEST_SLOT_DIR_ENV, TEST_SLOT_HEARTBEAT_MS,
  TEST_SLOT_PARENT_ENV, TEST_SLOT_RUN_ENV, type ReservedTreeEvidence, type TestSlotHolder, type TestSlotOptions,
} from "../src/lib/test-slot.js";
import { acquireSlotMutation, defaultGuardHolderProbe, type GuardHolderEvidence } from "../src/lib/test-slot-mutation.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { makeRuntimeFixture } from "./helpers/native-runtime-fixture.js";

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
    label: "fixture owner", ownerNonce: "nonce-a", processStart: "proc:4242", concurrency: 1, ...fields };
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
    platform: "linux" as const, bootId: "boot-1", pidNs: "ns-1", list: () => Object.keys(table),
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
  const marked = probeReservedTree(owner, proc({ 10: { start: 900 }, 11: { start: 600, environ: `HOME=/h\0${TEST_SLOT_RUN_ENV}=nonce-a\0` } }));
  assert.deepEqual([marked.state, /pid 11/.test(marked.reason)], ["live", true], "a reparented descendant keeps it after its parent died");
  const partial = probeReservedTree(owner, proc({ 11: { start: 600, environ: eacces } }));
  assert.equal(partial.state, "unknown", "an unreadable later process is incomplete evidence");
  assert.match(partial.reason, /incomplete/);
  assert.equal(probeReservedTree(owner, proc({ 3: { start: 1, environ: eacces }, 10: { start: 900 }, 12: { start: 700 } })).state, "ended",
    "positive control: the pid now names a newer process and no later process carries the marker");
  assert.equal(probeReservedTree({ ...owner, pidNs: "ns-other" }, proc({})).state, "unknown", "a foreign namespace is unprobeable");
  assert.equal(probeReservedTree({ ...owner, ownerNonce: undefined }, proc({})).state, "unknown", "unknown ownership");
  assert.equal(probeReservedTree(owner, { ...proc({}), platform: "darwin" }).state, "unknown", "no darwin tree probe: reserved");

  const dir = slotDir(t, "quiescence"), path = join(dir, "slot-1.json");
  const attempt = (probe: (held: TestSlotHolder) => ReservedTreeEvidence, extra: Partial<TestSlotOptions> = {}) => {
    const lines: string[] = [];
    const lease = acquireTestSlot("waiter", waiterBase(dir, lines, { treeProbe: probe, ...extra }));
    return { lease, lines };
  };
  const silentOwner = holder({ heartbeatIntervalMs: 1000, heartbeatAt: new Date(Date.now() - 600_000).toISOString() });
  // Silence plus a dead pid is not quiescence: unknown/incomplete and live evidence both retain the slot.
  for (const evidence of [{ state: "unknown", coverage: "proc-environ (incomplete)", reason: "incomplete: 1 process unreadable" },
    { state: "live", coverage: "proc-environ", reason: "covered descendant pid 77 still carries the reservation marker" }] as const) {
    writeHolder(path, silentOwner);
    const { lease, lines } = attempt(() => evidence);
    assert.equal(lease.outcome, "wait_bound_exceeded", evidence.state);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).ownerNonce, "nonce-a");
    assert.equal(rows(lines, "test_slot.reclaim_withheld")[0]?.reason, evidence.reason);
  }
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
  const freed = attempt(() => ({ state: "ended", coverage: "proc-environ", reason: "owner gone; none of 3 process(es) carries the marker" }));
  assert.equal(freed.lease.outcome, "acquired", freed.lease.note);
  const reclaimed = rows(freed.lines, "test_slot.reclaimed_quiescent");
  assert.equal(reclaimed.length, 1);
  assert.deepEqual([reclaimed[0]!.ownerNonce, reclaimed[0]!.processStart, reclaimed[0]!.coverage], ["nonce-a", "proc:4242", "proc-environ"]);
  freed.lease.release();

  // Owner-assisted release: identity-checked, refused while covered work lives, held on a late refresh.
  const request = { ownerNonce: "nonce-a", pid: silentOwner.pid, processStart: "proc:4242" };
  const release = (probe: (held: TestSlotHolder) => ReservedTreeEvidence, req = request) =>
    releaseTestSlotForOwner(path, req, { treeProbe: probe, isPidAlive: () => false, log: () => {} });
  const ended = (): ReservedTreeEvidence => ({ state: "ended", coverage: "proc-environ", reason: "work ended" });
  writeHolder(path, silentOwner);
  assert.equal(release(() => ({ state: "live", coverage: "proc-environ", reason: "child alive" })).outcome, "refused");
  assert.equal(release(ended, { ...request, processStart: "proc:9" }).outcome, "refused", "PID reuse");
  assert.equal(release(ended, { ...request, ownerNonce: "nonce-z" }).outcome, "refused", "a replaced reservation");
  assert.equal(release(() => { writeHolder(path, { ...silentOwner, heartbeatAt: new Date().toISOString() }); return ended(); }).outcome,
    "held", "a late refresh holds the record for re-observation");
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
  assert.equal(seen.marker, lease.heartbeat.ownerNonce, "every covered descendant carries the reservation marker");
  const after = JSON.parse(readFileSync(path, "utf8")) as TestSlotHolder;
  assert.equal(after.heartbeatIntervalMs, undefined, "the cadence is withdrawn once the step's process group ended");
  assert.equal(after.ownerNonce, before.ownerNonce);
  // A delayed beat is diagnostic only: far past three intervals, a live owner keeps its slot.
  assert.equal(beatTestSlot({ ...lease.heartbeat, intervalMs: 100 }), "beat");
  const lines: string[] = [], time = fakeTime(Date.now() + 60_000);
  const late = acquireTestSlot("late waiter", { dir, slots: 1, load: IDLE, clock: time.clock, waitBoundMs: 0, log: line => lines.push(line) });
  assert.equal(late.outcome, "wait_bound_exceeded");
  assert.equal(rows(lines, "test_slot.heartbeat_silent").length, 1);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).ownerNonce, before.ownerNonce);

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
  const prior = process.env[TEST_SLOT_DIR_ENV];
  process.env[TEST_SLOT_DIR_ENV] = slots;
  try {
    assert.equal(main([], { root: f.dir, select: () => ({ fullRun: false, suites: ["test/a.test.ts"], reasons: ["beat witness"] }) }), 0);
  } finally { if (prior === undefined) delete process.env[TEST_SLOT_DIR_ENV]; else process.env[TEST_SLOT_DIR_ENV] = prior; }
  const observed = JSON.parse(readFileSync(witness, "utf8")) as { record: TestSlotHolder; marker: string | null };
  assert.equal(observed.record.label, "preflight-author:static-and-affected");
  assert.equal(observed.record.heartbeatIntervalMs, TEST_SLOT_HEARTBEAT_MS, "the author's test step ran under a beating record");
  assert.equal(observed.marker, observed.record.ownerNonce);
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
  if (closed.state === "unknown") assert.match(closed.reason, /incomplete|no open-file probe|lsof/);
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
