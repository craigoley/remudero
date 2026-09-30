import assert from "node:assert/strict";
import fs from "node:fs";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import type { Clock } from "../src/lib/clock.js";
import { daemonInstanceRegistryPath } from "../src/lib/deployer.js";
import { createLedgerProjector, openProjectorReadModel, readModelDigest } from "../src/lib/ledger-projector.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import { ORACLE_AGREE_INTERVAL_MS, ORACLE_DRIFT_INTERVAL_MS, READ_MODEL_CONSISTENCY_STEP, READ_MODEL_SELF_HEALED_STEP } from "../src/lib/read-model-consistency.js";
import { acquireLease, releaseLease } from "../src/lib/read-model-db.js";
import {
  READ_MODEL_CHECK_SHARE,
  READ_MODEL_LEASE_RENEW_MS,
  READ_MODEL_SWITCH_RECHECK_MS,
  createReadModelTicker,
  createReadModelWorker,
  ledgerSource,
  loadCommittedViewBodies,
  readModelBodyKey,
  readModelSwitchesPath,
  readReadModelSwitches,
  runReadModelWorker,
  type ReadModelView,
  type ReadModelWorkerMessage,
} from "../src/lib/read-model-worker.js";
import { buildServeServer, readModelInstances, resolveConsoleSha, stopServeReadModel, type ServeDeps } from "../src/lib/serve.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { assertWallClockBound } from "./helpers/wall-clock-bound.js";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
const LIVE = "ledger.ndjson";

type TestCtx = { after: (fn: () => void) => void };

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function steppedClock(start = T0): { clock: Clock; advance: (ms: number) => void } {
  let ms = start;
  return {
    clock: { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() },
    advance: (by) => void (ms += by),
  };
}

/** `n` rows from `startMs`, one millisecond apart; every other row is a fact step. */
function rows(n: number, startMs: number, tag = "r"): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const step = i % 2 === 0 ? "run.start" : "worker.activity";
    out.push(JSON.stringify({ ts: new Date(startMs + i).toISOString(), step, task_id: `T${i % 500}`, run_id: `${tag}-${i}`, note: "x".repeat(120) }));
  }
  return out;
}

function text(lines: string[]): string {
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function archiveName(ms: number): string {
  return `ledger.${new Date(ms).toISOString().replace(/[:.]/g, "-")}.ndjson.gz`;
}

/** A ledger dir of `archives` gzip rotations of `perArchive` rows each, plus a live file. */
function corpus(dir: string, archives: number, perArchive: number, live: number): { total: number; newestTs: string } {
  mkdirSync(dir, { recursive: true });
  let at = T0 - 86_400_000;
  for (let a = 0; a < archives; a++) {
    writeFileSync(join(dir, archiveName(at + perArchive)), gzipSync(text(rows(perArchive, at, `a${a}`))));
    at += perArchive;
  }
  const liveRows = rows(live, at, "live");
  writeFileSync(join(dir, LIVE), text(liveRows));
  return { total: archives * perArchive + live, newestTs: new Date(at + live - 1).toISOString() };
}

function collect(): { messages: ReadModelWorkerMessage[]; post: (m: ReadModelWorkerMessage) => void; logs: (step: string) => Array<Record<string, unknown>> } {
  const messages: ReadModelWorkerMessage[] = [];
  return {
    messages,
    post: (m) => void messages.push(m),
    logs: (step) => messages.flatMap((m) => (m.type === "log" && m.step === step ? [m.extra] : [])),
  };
}

function lastState(messages: ReadModelWorkerMessage[]) {
  const states = messages.filter((m) => m.type === "state");
  const last = states[states.length - 1];
  assert.ok(last && last.type === "state", "the ticker posted a state");
  return last;
}

function tableCount(stateDir: string, instance: string, table: string): number {
  const db = openProjectorReadModel(stateDir, instance);
  try {
    return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
  } finally {
    db.close();
  }
}

const PROBE_MS = 5;

/** Samples the main loop every {@link PROBE_MS}: each sample is how late its timer fired. Unlike
 *  monitorEventLoopDelay, a stall that begins in the same turn as the probe is still counted. */
function loopProbe(): { stop: () => { samples: number; p99Ms: number; maxMs: number } } {
  const lags: number[] = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - last - PROBE_MS));
    last = now;
  }, PROBE_MS);
  return {
    stop: () => {
      clearInterval(timer);
      lags.push(Math.max(0, performance.now() - last - PROBE_MS));
      const sorted = [...lags].sort((a, b) => a - b);
      return { samples: lags.length, p99Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0, maxMs: sorted[sorted.length - 1] ?? 0 };
    },
  };
}

test("serve's main loop lag stays under 50 ms while the worker rebuilds", async (t) => {
  const ledgerDir = scratch(t, "rmw-lag-ledger");
  const { total, newestTs } = corpus(ledgerDir, 6, 20_000, 5_000);

  // Positive control: the same rebuild run on the main thread holds the loop, so the probe can see a stall.
  const inlineState = scratch(t, "rmw-lag-inline");
  const inline = createReadModelTicker({ stateDir: inlineState, instances: [{ name: "core", ledgerDir }], post: () => {} });
  const control = loopProbe();
  inline.tick();
  const inlineLag = control.stop();
  inline.release();
  assert.ok(inlineLag.maxMs >= 50, `the control must stall the loop it measures; the inline rebuild held it only ${inlineLag.maxMs.toFixed(1)} ms`);
  assert.equal(tableCount(inlineState, "core", "seen"), total, "the control rebuilt every row");

  const stateDir = scratch(t, "rmw-lag-state");
  const handle = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir }], tickMs: 50 });
  t.after(() => handle.stop());
  const probe = loopProbe();
  const started = performance.now();
  handle.start();
  const deadline = started + 120_000;
  while (handle.state().instances.get("core")?.newestTs !== newestTs && performance.now() < deadline) await sleep(20);
  const elapsedMs = performance.now() - started;
  const lag = probe.stop();
  assert.equal(handle.state().instances.get("core")?.newestTs, newestTs, "the worker finished the rebuild");
  const facts = `over a ${elapsedMs.toFixed(0)} ms worker rebuild of ${total} rows (${lag.samples} samples); inline the same rebuild held the loop ${inlineLag.maxMs.toFixed(0)} ms`;
  t.diagnostic(`main-loop lag p99 ${lag.p99Ms.toFixed(1)} ms, max ${lag.maxMs.toFixed(1)} ms ${facts}`);
  assertWallClockBound(lag.maxMs, 250, `main-loop lag max ${lag.maxMs.toFixed(1)} ms ${facts}: one stall as long as the inline rebuild hides inside a p99`);
  assertWallClockBound(lag.p99Ms, 50, `main-loop lag p99 ${lag.p99Ms.toFixed(1)} ms ${facts}`);
  assert.ok(lag.samples >= elapsedMs / (PROBE_MS * 4), `the probe must have sampled the loop throughout the rebuild; it took ${lag.samples} samples in ${elapsedMs.toFixed(0)} ms`);
  assert.equal(handle.stop(), true, "the worker confirmed its stop");
  assert.equal(tableCount(stateDir, "core", "seen"), total, "the worker rebuilt every row");
});

test("the worker writes nothing while the projector switch reads off", (t) => {
  const ledgerDir = scratch(t, "rmw-off-ledger");
  const stateDir = scratch(t, "rmw-off-state");
  corpus(ledgerDir, 1, 10, 4);
  const { clock, advance } = steppedClock();
  const sink = collect();
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], clock, post: sink.post });
  t.after(() => ticker.release());
  ticker.tick();
  const before = { seen: tableCount(stateDir, "core", "seen"), bodies: tableCount(stateDir, "core", "view_body"), generation: lastState(sink.messages).instances[0]?.generation };
  assert.equal(before.seen, 14);

  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ projector: "off" }));
  appendFileSync(join(ledgerDir, LIVE), text(rows(5, T0, "after")));
  advance(READ_MODEL_SWITCH_RECHECK_MS);
  ticker.tick();
  const off = lastState(sink.messages);
  assert.equal(off.switches.projector, "off");
  assert.equal(off.instances[0]?.reason, "projector switched off");
  assert.equal(off.instances[0]?.generation, before.generation, "no transaction ran");
  assert.equal(tableCount(stateDir, "core", "seen"), before.seen, "no row was applied while off");
  assert.equal(tableCount(stateDir, "core", "view_body"), before.bodies, "no body was persisted while off");
  const lastBody = sink.messages.filter((m) => m.type === "body").pop();
  assert.ok(lastBody?.type === "body" && lastBody.entry.body.stale, "the views keep serving, marked stale");

  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ projector: "on" }));
  advance(READ_MODEL_SWITCH_RECHECK_MS);
  ticker.tick();
  assert.equal(tableCount(stateDir, "core", "seen"), before.seen + 5, "switching back on applies the held rows");
});

test("a restarted worker serves its last committed bodies before its first tick", (t) => {
  const ledgerDir = scratch(t, "rmw-warm-ledger");
  const stateDir = scratch(t, "rmw-warm-state");
  corpus(ledgerDir, 1, 6, 2);
  const sink = collect();
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], post: sink.post });
  ticker.tick();
  assert.equal(ticker.release(), 1);
  const posted = sink.messages.filter((m) => m.type === "body").pop();
  assert.ok(posted?.type === "body");

  const logs: string[] = [];
  const restarted = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir }], log: (step) => void logs.push(step) });
  const warm = restarted.bodies.get(readModelBodyKey("read-model"));
  assert.deepEqual(warm, posted.entry, "the committed body is served as the worker posted it");
  assert.equal(restarted.state().at, undefined, "no tick has run");
  assert.deepEqual(logs, ["read_model.warm_boot", "read_model.switch_absent"], "no switch file: every view dark, and the reason ledgered");
  assert.equal(restarted.stop(), false, "a never-started worker has nothing to confirm");

  const cold = loadCommittedViewBodies(scratch(t, "rmw-cold"), "core");
  assert.deepEqual(cold.bodies, []);
  assert.match(cold.reason ?? "", /no committed view bodies/);
});

test("the worker releases its leases when serve stops", async (t) => {
  const ledgerDir = scratch(t, "rmw-release-ledger");
  const stateDir = scratch(t, "rmw-release-state");
  corpus(ledgerDir, 1, 4, 1);
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  const handle = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir }], tickMs: 20, log: (step, extra) => void logs.push([step, extra]) });
  handle.start();
  handle.start();
  const deadline = Date.now() + 30_000;
  while (handle.state().instances.get("core")?.lease !== "held" && Date.now() < deadline) await sleep(20);
  assert.equal(handle.state().instances.get("core")?.lease, "held");
  const db = openProjectorReadModel(stateDir, "core");
  t.after(() => db.close());
  assert.equal(acquireLease(db, { holder: "successor" }).ok, false, "while the worker runs, a successor is refused");
  assert.equal(handle.stop(), true);
  assert.equal(acquireLease(db, { holder: "successor" }).ok, true, "after the stop, a successor takes the lease at once");
  assert.ok(logs.some(([step, extra]) => step === "read_model.stop" && extra?.confirmed === true));
  await sleep(50);
  assert.ok(logs.some(([step, extra]) => step === "read_model.stopped" && extra?.released === 1), JSON.stringify(logs));
  handle.start();
  assert.equal(handle.stop(), false, "a stopped handle does not respawn");
});

test("a projector error is logged and the instance backs off while the others keep ticking", (t) => {
  const good = scratch(t, "rmw-err-good");
  const stateDir = scratch(t, "rmw-err-state");
  const missing = join(scratch(t, "rmw-err-base"), "not-yet");
  corpus(good, 0, 0, 3);
  const { clock, advance } = steppedClock();
  const sink = collect();
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir: good }, { name: "site", ledgerDir: missing }], clock, tickMs: 100, post: sink.post, oracle: "off" });
  t.after(() => ticker.release());
  ticker.tick();
  let state = lastState(sink.messages);
  assert.equal(state.instances[0]?.reason, undefined);
  assert.equal(state.instances[0]?.generation, 1, "core ticked");
  assert.equal(state.instances[1]?.failures, 1);
  assert.match(state.instances[1]?.reason ?? "", /tick failed/);
  assert.deepEqual(sink.logs("read_model.tick_failed").map((l) => [l.instance, l.failures, l.backoffMs]), [["site", 1, 200]]);

  ticker.tick();
  assert.equal(sink.logs("read_model.tick_failed").length, 1, "inside its back-off the failing instance is not retried");
  advance(200);
  ticker.tick();
  assert.deepEqual(sink.logs("read_model.tick_failed").map((l) => l.backoffMs), [200, 400], "the back-off doubles");

  corpus(missing, 0, 0, 2);
  advance(400);
  ticker.tick();
  state = lastState(sink.messages);
  assert.equal(state.instances[1]?.failures, 0, "a good tick resets the back-off");
  assert.equal(state.instances[1]?.reason, undefined);
  assert.equal(state.instances[1]?.newestTs, new Date(T0 - 86_400_000 + 1).toISOString());
});

test("a lease held by another serve keeps this worker from writing and a stolen lease is retaken", (t) => {
  const ledgerDir = scratch(t, "rmw-lease-ledger");
  const stateDir = scratch(t, "rmw-lease-state");
  corpus(ledgerDir, 0, 0, 2);
  const { clock, advance } = steppedClock();
  const other = openProjectorReadModel(stateDir, "core", clock);
  t.after(() => other.close());
  assert.ok(acquireLease(other, { holder: "other-serve", clock }).ok);
  const sink = collect();
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], clock, holder: "me", post: sink.post });
  t.after(() => ticker.release());
  ticker.tick();
  let state = lastState(sink.messages).instances[0];
  assert.equal(state?.lease, "elsewhere");
  assert.match(state?.reason ?? "", /lease held by pid/);
  assert.equal(state?.generation, 0, "nothing was projected");

  advance(21_000);
  ticker.tick();
  state = lastState(sink.messages).instances[0];
  assert.equal(state?.lease, "held", "an expired lease passes to this worker");
  assert.equal(state?.heldBy, undefined);

  other.prepare("UPDATE lease SET holder = 'thief'").run();
  appendFileSync(join(ledgerDir, LIVE), text(rows(2, T0, "late")));
  advance(READ_MODEL_LEASE_RENEW_MS - 1);
  ticker.tick();
  state = lastState(sink.messages).instances[0];
  assert.equal(state?.lease, "none", "the fence refused the write and the lease is dropped");
  assert.match(String(sink.logs("read_model.tick_failed")[0]?.error), /lease_lost/);

  advance(READ_MODEL_LEASE_RENEW_MS);
  other.prepare("UPDATE lease SET expires_ms = 0").run();
  ticker.tick();
  assert.equal(lastState(sink.messages).instances[0]?.lease, "held");
  other.exec("DROP TABLE lease");
  assert.equal(ticker.release(), 0, "a release that fails is counted out");
  assert.match(String(sink.logs("read_model.release_failed")[0]?.error), /no such table/);
});

/** What `rmd read-model rebuild` does (#8081): build a side file, take the live lease, checkpoint, rename over. */
function rebuildAndSwap(stateDir: string, ledgerDir: string, clock: Clock, step: "fence" | "swap" | "both" = "both"): void {
  const livePath = join(stateDir, "read-model", "core.v1.sqlite");
  if (step !== "swap") {
    const live = openProjectorReadModel(stateDir, "core", clock);
    live.prepare("UPDATE lease SET holder = 'rebuild-cli', expires_ms = ?").run(clock.now() + 20_000);
    live.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    live.close();
  }
  if (step === "fence") return;
  const sideRoot = join(stateDir, "read-model", `rebuild-core-${clock.now()}`);
  const side = openProjectorReadModel(sideRoot, "core", clock);
  const got = acquireLease(side, { holder: "rebuild-cli", clock });
  assert.ok(got.ok);
  createLedgerProjector({ ledgerDir, db: side, lease: got.lease, clock }).tick();
  releaseLease(side, got.lease);
  side.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const sidePath = side.path;
  side.close();
  renameSync(sidePath, livePath);
}

function digestOf(stateDir: string): string {
  const db = openProjectorReadModel(stateDir, "core");
  try {
    return readModelDigest(db);
  } finally {
    db.close();
  }
}

test("after a CLI rebuild swaps the file the worker resumes against the new file with no lost or duplicate rows", (t) => {
  const ledgerDir = scratch(t, "rmw-swap-ledger");
  const stateDir = scratch(t, "rmw-swap-state");
  corpus(ledgerDir, 1, 10, 4);
  const { clock, advance } = steppedClock();
  const sink = collect();
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], clock, holder: "worker", tickMs: 100, post: sink.post, oracle: "off" });
  t.after(() => ticker.release());
  ticker.tick();
  assert.equal(tableCount(stateDir, "core", "seen"), 14);

  // The worker is fenced off before the rename: its write rolls back, it closes, and it reopens the new file.
  rebuildAndSwap(stateDir, ledgerDir, clock, "fence");
  appendFileSync(join(ledgerDir, LIVE), text(rows(3, T0, "fenced")));
  ticker.tick();
  assert.match(String(sink.logs("read_model.tick_failed")[0]?.error), /lease_lost/);
  rebuildAndSwap(stateDir, ledgerDir, clock, "swap");
  appendFileSync(join(ledgerDir, LIVE), text(rows(2, T0 + 10, "after-swap")));
  advance(200);
  ticker.tick();
  assert.equal(lastState(sink.messages).instances[0]?.lease, "held", "the worker took the new file's lease");
  assert.equal(tableCount(stateDir, "core", "seen"), 19);

  // An idle worker never writes, so the fence cannot tell it: the replaced inode does.
  rebuildAndSwap(stateDir, ledgerDir, clock);
  appendFileSync(join(ledgerDir, LIVE), text(rows(4, T0 + 20, "idle-swap")));
  ticker.tick();
  assert.equal(sink.logs("read_model.reopened").length, 1, "the rename was noticed by its inode");
  assert.equal(lastState(sink.messages).instances[0]?.reason, undefined);
  assert.equal(tableCount(stateDir, "core", "seen"), 23, "no row lost and none doubled");

  // The design's full rollback deletes state/read-model/: the worker rebuilds from the ledger.
  rmSync(join(stateDir, "read-model"), { recursive: true, force: true });
  ticker.tick();
  assert.equal(sink.logs("read_model.reopened").length, 2, "a deleted file reads as replaced");
  assert.equal(tableCount(stateDir, "core", "seen"), 23, "and is rebuilt whole");

  const clean = scratch(t, "rmw-swap-clean");
  const fresh = createReadModelTicker({ stateDir: clean, instances: [{ name: "core", ledgerDir }], clock, post: () => {} });
  fresh.tick();
  fresh.release();
  ticker.release();
  assert.equal(digestOf(stateDir), digestOf(clean), "the resumed store digests equal to a clean rebuild");
});

test("a stop requested mid-rebuild rolls back the open transaction without a failure", (t) => {
  const ledgerDir = scratch(t, "rmw-stop-ledger");
  const stateDir = scratch(t, "rmw-stop-state");
  corpus(ledgerDir, 2, 5, 0);
  let calls = 0;
  const sink = collect();
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }, { name: "site", ledgerDir }], post: sink.post, stopRequested: () => ++calls > 2 });
  ticker.tick();
  assert.equal(sink.logs("read_model.tick_failed").length, 0);
  assert.equal(sink.messages.some((m) => m.type === "state"), false, "a stopping tick posts nothing further");
  assert.equal(ticker.release(), 1);
  assert.equal(tableCount(stateDir, "core", "seen"), 5, "the first archive committed and the second rolled back");
});

test("the switch file keeps its last good reading and a view switched off is not materialized", (t) => {
  const stateDir = scratch(t, "rmw-switch-state");
  const ledgerDir = scratch(t, "rmw-switch-ledger");
  corpus(ledgerDir, 0, 0, 1);
  const path = readModelSwitchesPath(stateDir);
  assert.deepEqual(readReadModelSwitches(path), { ok: true, switches: { projector: "on", views: {} }, mtimeMs: 0, absent: `no switch file at ${path}` });
  mkdirSync(path, { recursive: true });
  assert.match(String((readReadModelSwitches(path) as { reason: string }).reason), /unreadable/);
  rmSync(path, { recursive: true });
  writeFileSync(path, "{ not json");
  assert.match(String((readReadModelSwitches(path) as { reason: string }).reason), /not JSON/);
  writeFileSync(path, JSON.stringify({ views: { "read-model": "sideways" } }));
  assert.match(String((readReadModelSwitches(path) as { reason: string }).reason), /mode "sideways"/);
  writeFileSync(path, JSON.stringify({ projector: "maybe" }));
  assert.match(String((readReadModelSwitches(path) as { reason: string }).reason), /projector has mode/);
  writeFileSync(path, "null");
  assert.equal(readReadModelSwitches(path).ok, true);

  const { clock, advance } = steppedClock();
  const sink = collect();
  const throws: ReadModelView = { name: "broken", version: 1, materialize: () => { throw new Error("boom"); } };
  const counted: ReadModelView = { name: "counted", version: 1, materialize: () => [{ key: "", data: { n: 1 }, sources: [] }] };
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], clock, views: [throws, counted], post: sink.post });
  t.after(() => ticker.release());
  writeFileSync(path, JSON.stringify({ views: { counted: "off" } }));
  ticker.tick();
  assert.deepEqual(sink.messages.filter((m) => m.type === "body"), [], "a view switched off is not materialized");
  assert.deepEqual(sink.logs("read_model.materialize_failed"), [{ view: "broken", error: "boom" }]);

  writeFileSync(path, "{ half written");
  advance(READ_MODEL_SWITCH_RECHECK_MS);
  ticker.tick();
  assert.equal(sink.logs("read_model.switch_unreadable").length, 1);
  assert.deepEqual(lastState(sink.messages).switches.views, { counted: "off" }, "an unreadable file keeps the last good switches");
  assert.equal(sink.messages.filter((m) => m.type === "body").length, 0);

  writeFileSync(path, JSON.stringify({ views: { counted: "serve" } }));
  advance(READ_MODEL_SWITCH_RECHECK_MS);
  ticker.tick();
  ticker.tick();
  assert.equal(sink.messages.filter((m) => m.type === "body").length, 1, "one body, and an unchanged body is not re-posted");
});

test("the switch reader does not follow a symlink to a different file", (t) => {
  const root = scratch(t, "rmw-switch-symlink");
  const path = join(root, "switches.json");
  const target = join(root, "outside.json");
  writeFileSync(target, JSON.stringify({ projector: "off" }));
  symlinkSync(target, path);
  const result = readReadModelSwitches(path);
  assert.equal(result.ok, false);
  assert.match(String((result as { reason: string }).reason), /unreadable/);
});

test("the switch reader rejects a file changed during its descriptor read", (t) => {
  const root = scratch(t, "rmw-switch-changed");
  const path = join(root, "switches.json");
  writeFileSync(path, JSON.stringify({ projector: "off" }));
  const realReadFileSync = fs.readFileSync.bind(fs);
  const readSpy = t.mock.method(fs, "readFileSync", (target: unknown, ...rest: unknown[]) => {
    const body = realReadFileSync(target as string, ...(rest as []));
    if (typeof target === "number") appendFileSync(path, "\n");
    return body;
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(readReadModelSwitches(path), { ok: false, reason: "switch file changed while being read" });
  } finally {
    readSpy.mock.restore();
    syncBuiltinESMExports();
  }
});

test("the ledger source reads stale when its projector is behind or has not ticked", () => {
  const base = { instance: "core", generation: 3, lease: "held" as const, failures: 0, newestTs: "2026-09-30T11:59:00.000Z" };
  assert.deepEqual(ledgerSource({ ...base, tickedAt: T0 }, T0 + 1_000), { name: "ledger:core", asOf: base.newestTs, state: "fresh" });
  assert.equal(ledgerSource({ ...base, tickedAt: T0 }, T0 + 12_000).reason, "projector 12 s behind");
  assert.equal(ledgerSource({ ...base, tickedAt: T0, reason: "tick failed: x" }, T0 + 12_000).reason, "projector 12 s behind: tick failed: x");
  assert.equal(ledgerSource({ ...base, tickedAt: T0, reason: "unread archives: a" }, T0).state, "stale");
  assert.equal(ledgerSource(base, T0).reason, "projector has not ticked yet");
  assert.equal(ledgerSource({ ...base, reason: "lease held by pid 1 on h" }, T0).reason, "lease held by pid 1 on h");
});

test("the worker branch ticks until a stop message and then signals its release", async (t) => {
  const ledgerDir = scratch(t, "rmw-branch-ledger");
  const stateDir = scratch(t, "rmw-branch-state");
  corpus(ledgerDir, 0, 0, 2);
  const signal = new SharedArrayBuffer(8);
  const posted: ReadModelWorkerMessage[] = [];
  let onMessage: ((msg: { type?: string }) => void) | undefined;
  let closed = 0;
  let failOnce = true;
  const port = {
    on: (_event: "message", run: (msg: { type?: string }) => void) => void (onMessage = run),
    postMessage: (m: unknown) => {
      const message = m as ReadModelWorkerMessage;
      if (message.type === "state" && failOnce) {
        failOnce = false;
        throw new Error("port closed");
      }
      posted.push(message);
    },
    close: () => void closed++,
  };
  runReadModelWorker(port, { kind: "remudero-read-model", stateDir, instances: [{ name: "core", ledgerDir }], tickMs: 5, signal, escalationRepository: "craigoley/remudero" });
  const deadline = Date.now() + 10_000;
  while (!posted.some((m) => m.type === "state") && Date.now() < deadline) await sleep(5);
  assert.ok(posted.some((m) => m.type === "log" && m.step === "read_model.tick_failed" && m.extra.error === "port closed"), "a failing tick is logged and the loop goes on");
  onMessage?.({ type: "noise" });
  onMessage?.({ type: "stop" });
  onMessage?.({ type: "stop" });
  const flags = new Int32Array(signal);
  assert.deepEqual([flags[0], flags[1], closed], [1, 1, 1]);
  assert.ok(posted.some((m) => m.type === "log" && m.step === "read_model.stopped" && m.extra.released === 1));

  const second = new SharedArrayBuffer(8);
  const quiet = { on: () => undefined, postMessage: () => undefined, close: () => void closed++ };
  runReadModelWorker(quiet, { kind: "remudero-read-model", stateDir, instances: [{ name: "core", ledgerDir }], tickMs: 5, signal: second });
  Atomics.store(new Int32Array(second), 0, 1);
  const until = Date.now() + 10_000;
  while (Atomics.load(new Int32Array(second), 1) !== 1 && Date.now() < until) await sleep(5);
  assert.equal(Atomics.load(new Int32Array(second), 1), 1, "a stop flag alone ends the loop");
});

test("a worker that dies is respawned with a doubling back-off and a silent one times out its stop", async (t) => {
  const stateDir = scratch(t, "rmw-respawn-state");
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  const dying = createReadModelWorker({
    stateDir, instances: [{ name: "core", ledgerDir: stateDir }], tickMs: 10,
    workerUrl: new URL("data:text/javascript,throw new Error('worker boom')"),
    log: (step, extra) => void logs.push([step, extra]),
  });
  dying.start();
  const deadline = Date.now() + 20_000;
  while (logs.filter(([step]) => step === "read_model.worker_exited").length < 2 && Date.now() < deadline) await sleep(10);
  dying.stop();
  const exits = logs.filter(([step]) => step === "read_model.worker_exited").map(([, extra]) => [extra?.deaths, extra?.respawnInMs]);
  assert.deepEqual(exits.slice(0, 2), [[1, 20], [2, 40]]);
  assert.ok(logs.some(([step, extra]) => step === "read_model.worker_failed" && /worker boom/.test(String(extra?.error))));

  const silent = createReadModelWorker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], stopWaitMs: 50, workerUrl: new URL("data:text/javascript,setInterval(() => {}, 1000)") });
  silent.start();
  await sleep(100);
  assert.equal(silent.stop(), false, "an unconfirmed stop is reported, bounded");
});

test("rmd serve starts the read-model worker for every registry instance and stops it on shutdown", async (t) => {
  const root = scratch(t, "rmw-serve");
  const stateDir = join(root, "state");
  const stateBase = join(root, "instances");
  mkdirSync(stateDir, { recursive: true });
  const coreCorpus = corpus(stateDir, 0, 0, 3);
  corpus(join(stateBase, "site", "state"), 0, 0, 2);
  mkdirSync(join(root, ".remudero"), { recursive: true });
  const row = (name: string, repo: string) => [`  ${name}:`, `    repo: ${repo}`, "    project: remudero", `    github_repo: craigoley/${repo}`, `    state_dir: /host/${name}-state`].join("\n");
  writeFileSync(daemonInstanceRegistryPath(root), ["instances:", row("core", "remudero"), row("site", "remudero-site"), ""].join("\n"));
  const ledgerPath = join(stateDir, LIVE);
  const planPath = join(root, "plan.yaml");
  writeFileSync(planPath, "[]\n");
  const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
  const deps: ServeDeps = {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
    panelGraph: { root, planPath, ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve: () => {}, reframe: () => {} } },
    ledgerPath,
    issues: { close: () => {} },
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: "read-token", write: "write-token" },
    consoleSha: "aaaaaaaa",
    resolveCurrentSha: () => "aaaaaaaa",
    gatewayCheckout: async () => ({ state: "clean" }) as never,
    githubAppRefresh: { start: () => ({ armed: false, stop() {} }) as never },
    instances: { stateBase },
    readModel: { tickMs: 20 },
  };
  assert.deepEqual(readModelInstances(deps), [
    { name: "core", ledgerDir: stateDir, feedbackRoot: root, planPath },
    { name: "site", ledgerDir: join(stateBase, "site", "state"), repo: "craigoley/remudero-site" },
  ]);
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  assert.ok((server.address() as AddressInfo).port > 0);
  const siteDb = join(stateDir, "read-model", "site.v1.sqlite");
  const deadline = Date.now() + 30_000;
  while (!existsSync(siteDb) && Date.now() < deadline) await sleep(20);
  await sleep(200);
  assert.equal(stopServeReadModel(server), true, "the SIGTERM path releases the worker's leases");
  assert.equal(tableCount(stateDir, "site", "seen"), 2, "the site instance was projected into its own DB under core's state");
  // Core's DB also projects the oracle's metric rows, which the worker appends to core's own ledger.
  const core = openProjectorReadModel(stateDir, "core");
  t.after(() => core.close());
  assert.equal(Number(core.prepare("SELECT count(*) AS n FROM seen WHERE ts_ms <= ?").get(Date.parse(coreCorpus.newestTs))?.n), 3);
  assert.equal(stopServeReadModel(buildServeServer({ ...deps, readModel: undefined })), false, "no worker runs unless serve asks for one");
});

test("a serve that exits for a due restart stops the read-model worker and releases its lease first", async (t) => {
  const root = scratch(t, "rmw-restart");
  const stateDir = join(root, "state");
  corpus(stateDir, 0, 0, 3);
  const ledgerPath = join(stateDir, LIVE);
  const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
  let recheck: () => void = () => {};
  const exits: number[] = [];
  const server = buildServeServer({
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
    panelGraph: { root, planPath: join(root, "plan.yaml"), ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve: () => {}, reframe: () => {} } },
    ledgerPath,
    issues: { close: () => {} },
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: "read-token", write: "write-token" },
    consoleSha: resolveConsoleSha(),
    githubAppRefresh: { start: () => ({ armed: false, stop() {} }) as never },
    gatewayCheckout: async () => ({ state: { head: "a".repeat(40), behindBy: 2, dirty: false, checkedAt: new Date(T0).toISOString() }, restartDue: true }),
    // The drain's backstop path: a hung client (an SSE stream) outlives the bound, so the drain ends
    // with the server still open and its "close" handler has not stopped the worker.
    staleExitSeams: {
      scheduleRecheck: (run) => ((recheck = run), () => {}),
      drain: () => Promise.resolve(),
      exit: (code) => void exits.push(code, leases()),
    },
    readModel: { tickMs: 20 },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    if (server.listening) server.close();
  });
  const db = openProjectorReadModel(stateDir, "core");
  t.after(() => db.close());
  const leases = (): number => Number(db.prepare("SELECT count(*) AS n FROM lease").get()?.n);
  const coreDb = join(stateDir, "read-model", "core.v1.sqlite");
  const deadline = Date.now() + 30_000;
  while (!(existsSync(coreDb) && tableCount(stateDir, "core", "seen") >= 3) && Date.now() < deadline) await sleep(20);
  assert.equal(leases(), 1, "the control: the running worker holds the lease");
  recheck();
  const until = Date.now() + 10_000;
  while (exits.length === 0 && Date.now() < until) await sleep(10);
  assert.deepEqual(exits, [0, 0], "the due restart exited, and no lease was held at that instant");
});

/** The oracle's metric rows, which the ticker appends to core's ledger in `stateDir`. */
function oracleRows(stateDir: string): Array<Record<string, unknown>> {
  const path = join(stateDir, LIVE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.step === READ_MODEL_CONSISTENCY_STEP || r.step === READ_MODEL_SELF_HEALED_STEP);
}

function checkWindows(stateDir: string): Array<[number, number]> {
  return oracleRows(stateDir).filter((r) => r.step === READ_MODEL_CONSISTENCY_STEP && Array.isArray(r.window))
    .map((r) => (r.window as string[]).map((iso) => Date.parse(iso)) as [number, number]);
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Eight days of rows every three hours up to an hour before T0: an archive, then the live file. */
function spreadRows(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const at = (k: number) => T0 - 8 * DAY + k * 3 * HOUR;
  const line = (k: number) => JSON.stringify({ ts: new Date(at(k)).toISOString(), step: k % 2 ? "run.start" : "worker.activity", task_id: `T${k}`, run_id: `s-${k}` });
  const all = Array.from({ length: 8 * 8 - 2 }, (_, k) => line(k));
  writeFileSync(join(dir, archiveName(at(31))), gzipSync(text(all.slice(0, 32))));
  writeFileSync(join(dir, LIVE), text(all.slice(32)));
}

function checkFixture(t: TestCtx, extra: { escalation?: { issues: IssueGateway; ledgerPath: string; runId: string }; clock?: Clock } = {}) {
  const ledgerDir = scratch(t, "rmw-check-ledger");
  const stateDir = scratch(t, "rmw-check-state");
  spreadRows(ledgerDir);
  const c = collect();
  const stepped = steppedClock();
  const clock = extra.clock ?? stepped.clock;
  const make = () => createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], post: c.post, clock, holder: "serve-a", ...(extra.escalation ? { escalation: extra.escalation } : {}) });
  let ticker = make();
  t.after(() => ticker.release());
  return {
    ledgerDir, stateDir, c, clock, advance: stepped.advance,
    get ticker() { return ticker; },
    restart: () => {
      ticker.release();
      ticker = make();
    },
  };
}

/** Ticks until `n` more checks have run (bounded), appending a fresh row before every tick. Each
 *  tick reports whether it projected (the row landed) and whether it checked (a metric row). */
function tickUntilChecks(f: ReturnType<typeof checkFixture>, n: number, maxTicks = 60): Array<{ projected: boolean; checked: boolean; at: number }> {
  const out: Array<{ projected: boolean; checked: boolean; at: number }> = [];
  const target = checkWindows(f.stateDir).length + n;
  for (let i = 0; i < maxTicks && checkWindows(f.stateDir).length < target; i++) {
    const at = f.clock.now();
    appendFileSync(join(f.ledgerDir, LIVE), `${JSON.stringify({ ts: new Date(at).toISOString(), step: "worker.activity", run_id: `tick-${at}-${i}` })}\n`);
    const seen = existsSync(join(f.stateDir, "read-model")) ? tableCount(f.stateDir, "core", "seen") : 0;
    const checks = checkWindows(f.stateDir).length;
    f.ticker.tick();
    out.push({ projected: tableCount(f.stateDir, "core", "seen") > seen, checked: checkWindows(f.stateDir).length > checks, at });
    f.advance(250);
  }
  assert.equal(checkWindows(f.stateDir).length, target, `${n} check(s) ran within ${maxTicks} ticks`);
  return out;
}

test("seven consecutive slice checks tile the seven-day window exactly and no tick both projects and checks", (t) => {
  const f = checkFixture(t);
  const ticks = tickUntilChecks(f, 7);
  assert.deepEqual(ticks.filter((x) => x.projected && x.checked), [], "a check tick never projects");
  assert.ok(ticks.filter((x) => x.projected).length >= 7, "projection ticks run between the checks");
  const windows = checkWindows(f.stateDir);
  const end = windows[0]![1];
  assert.deepEqual(windows, Array.from({ length: 7 }, (_, i) => [end - (i + 1) * DAY, end - i * DAY]), "slice i covers day i back from the cycle's end");
  assert.equal(end, ticks.find((x) => x.checked)!.at - 10 * 60_000, "the cycle ends at the closed-window edge of its first check");
  assert.ok(oracleRows(f.stateDir).every((r) => r.outcome === "agree"));
  for (let i = 0; i < 10; i++) f.ticker.tick();
  assert.equal(checkWindows(f.stateDir).length, 7, "a new cycle waits for the schedule hook after an agreeing cycle");
  f.advance(ORACLE_AGREE_INTERVAL_MS);
  tickUntilChecks(f, 1);
  assert.ok(checkWindows(f.stateDir)[7]![1] > end, "the next cycle ends later");
});

test("the slice cursor survives a worker restart and the next slice resumes the cycle", (t) => {
  const f = checkFixture(t);
  tickUntilChecks(f, 3);
  const end = checkWindows(f.stateDir)[0]![1];
  f.restart();
  tickUntilChecks(f, 1);
  assert.deepEqual(checkWindows(f.stateDir)[3], [end - 4 * DAY, end - 3 * DAY], "the restarted worker checks the fourth slice of the same cycle");
});

test("the next slice waits in proportion to what the last one cost", (t) => {
  // Every read of this clock moves it 20 ms, so a check that reads it costs measurable time.
  let ms = T0;
  const clock: Clock = { now: () => (ms += 20), date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
  const f = checkFixture(t, { clock });
  const ticks = tickUntilChecks(f, 2);
  const [first, second] = ticks.filter((x) => x.checked);
  const cost = Number(oracleRows(f.stateDir)[0]?.elapsed_ms);
  assert.ok(cost > 0, "the control: the first check cost clock time");
  assert.ok(second!.at - first!.at >= cost / READ_MODEL_CHECK_SHARE, `the second slice waited ${second!.at - first!.at} ms after one that cost ${cost} ms`);
});

test("the worker runs a due slice only as the lease holder", (t) => {
  const f = checkFixture(t);
  f.ticker.tick();
  f.ticker.tick();
  const other = openProjectorReadModel(f.stateDir, "core", f.clock);
  t.after(() => other.close());
  other.prepare("UPDATE lease SET holder = 'serve-b', expires_ms = ?").run(T0 + HOUR);
  f.advance(READ_MODEL_LEASE_RENEW_MS);
  f.ticker.tick();
  assert.equal(lastState(f.c.messages).instances[0]?.lease, "elsewhere");
  assert.equal(checkWindows(f.stateDir).length, 0, "a tick without the lease runs no check");
});

test("the consistency check never runs while a rebuild holds another generation", (t) => {
  const f = checkFixture(t);
  f.ticker.tick();
  f.ticker.tick();
  // A CLI rebuild in flight: a new generation beside the live file, holding that file's lease.
  const side = openProjectorReadModel(f.stateDir, "core", f.clock, String(T0));
  t.after(() => side.close());
  const got = acquireLease(side, { holder: "rebuild-4242-1", clock: f.clock });
  assert.ok(got.ok);
  f.ticker.tick();
  assert.equal(oracleRows(f.stateDir).length, 0, "due, but a rebuild is in flight");
  assert.match(String(f.c.logs("read_model.consistency_deferred")[0]?.reason), /rebuild-4242-1/);
  f.ticker.tick();
  f.ticker.tick();
  assert.equal(f.c.logs("read_model.consistency_deferred").length, 1, "a deferral waits out its back-off instead of asking every tick");
  releaseLease(side, got.lease);
  // A generation file that will not open counts as one being created only while it is fresh.
  const debris = join(f.stateDir, "read-model", "core.v1.g7.sqlite");
  writeFileSync(debris, "not a database");
  utimesSync(debris, (T0 + ORACLE_DRIFT_INTERVAL_MS) / 1000, (T0 + ORACLE_DRIFT_INTERVAL_MS) / 1000);
  f.advance(ORACLE_DRIFT_INTERVAL_MS);
  f.ticker.tick();
  f.ticker.tick();
  assert.match(String(f.c.logs("read_model.consistency_deferred")[1]?.reason), /core\.v1\.g7\.sqlite \(unreadable/);
  f.advance(ORACLE_DRIFT_INTERVAL_MS);
  tickUntilChecks(f, 1, 3);
  assert.equal(oracleRows(f.stateDir)[0]?.outcome, "agree", "the check runs once the rebuild lets go and the debris is stale");
});

test("a rebuild that fences the worker during its check makes it reopen the file", (t) => {
  const f = checkFixture(t);
  f.ticker.tick();
  f.ticker.tick();
  // The rebuild's fence lands after the projection tick that found a slice due, before the check writes.
  const rebuild = openProjectorReadModel(f.stateDir, "core", f.clock);
  t.after(() => rebuild.close());
  rebuild.prepare("UPDATE lease SET holder = 'rebuild-1', expires_ms = ?").run(T0 + 60_000);
  f.ticker.tick();
  assert.match(String(f.c.logs("read_model.tick_failed")[0]?.error), /lease/);
  assert.equal(f.c.logs("read_model.consistency_failed").length, 0, "a lost lease is the projector's reopen, not an oracle failure");
  assert.equal(lastState(f.c.messages).instances[0]?.lease, "none");
});

test("a drift the worker's windowed check detects is healed and a recurrence escalates through the issue path", (t) => {
  const titles: string[] = [];
  const issues: IssueGateway = { create: (title) => (titles.push(title), `https://github.com/craigoley/remudero/issues/${9000 + titles.length}`) };
  const f = checkFixture(t, { escalation: { issues, ledgerPath: join(scratch(t, "rmw-check-esc"), LIVE), runId: "read-model" } });
  f.ticker.tick();
  const tamper = openProjectorReadModel(f.stateDir, "core");
  t.after(() => tamper.close());
  const corruptDayBack = (days: number) => tamper.prepare("UPDATE fact SET body = body || ' ' WHERE seq = (SELECT max(seq) FROM fact WHERE ts_ms < ?)").run(T0 - days * DAY);
  corruptDayBack(0);
  f.ticker.tick();
  f.ticker.tick();
  assert.deepEqual(oracleRows(f.stateDir).map((r) => r.outcome ?? r.step), ["healed", READ_MODEL_SELF_HEALED_STEP], "the newest slice found the drift and healed it");
  assert.equal(tamper.prepare("SELECT count(*) AS n FROM fact WHERE body LIKE '% '").get()?.n, 0, "the corrupted fact was rebuilt from the ledger");
  assert.equal(titles.length, 0, "a first drift heals without asking anyone");
  corruptDayBack(1);
  f.ticker.tick();
  f.ticker.tick();
  assert.equal(oracleRows(f.stateDir).at(-2)?.outcome, "escalated", "a drift in the next slice within a day of the heal escalates");
  assert.equal(titles.length, 1, "through the one escalation path");
});

test("a blind slice is logged and waits out its back-off without failing the projector", (t) => {
  const ledgerDir = scratch(t, "rmw-blind-ledger");
  const stateDir = scratch(t, "rmw-blind-state");
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(join(ledgerDir, LIVE), text(rows(4, T0 - 30 * DAY)));
  const c = collect();
  const { clock, advance } = steppedClock();
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], post: c.post, clock });
  t.after(() => ticker.release());
  ticker.tick();
  ticker.tick();
  assert.match(String(c.logs("read_model.consistency_failed")[0]?.error), /oracle_blind/);
  assert.equal(lastState(c.messages).instances[0]?.failures, 0, "an idle instance's blind oracle never backs its projector off");
  ticker.tick();
  ticker.tick();
  assert.equal(c.logs("read_model.consistency_failed").length, 1, "not retried every tick");
  advance(ORACLE_DRIFT_INTERVAL_MS);
  ticker.tick();
  ticker.tick();
  const failed = c.logs("read_model.consistency_failed");
  assert.equal(failed.length, 2, "retried after the back-off");
  assert.notDeepEqual(failed[1]?.window, failed[0]?.window, "the cursor moved past the blind slice");
});
