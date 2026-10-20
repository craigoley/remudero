import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { forkWorkerEntry } from "../../../src/lib/child-entry-argv.js";
import { fixedClock } from "../../../src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "../../../src/lib/ledger-projector.js";
import { readIngestMark } from "../../../src/lib/read-model-consistency.js";
import { acquireLease } from "../../../src/lib/read-model-db.js";
import {
  childOracle,
  oracleChildExecArgv,
  READ_MODEL_ORACLE_CHILD_STEP,
  READ_MODEL_ORACLE_HEAP_MB,
  residentPeakBytes,
  runReadModelOracleChild,
  type OracleSliceRequest,
  type OracleSliceResult,
} from "../../../src/lib/read-model-worker.js";
import { makeTempDir } from "../../../src/lib/tmp.js";

type TestCtx = { after: (fn: () => void) => void };
type Row = { step: string; extra: Record<string, unknown> };

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function request(extra: Partial<OracleSliceRequest> = {}): OracleSliceRequest {
  return {
    instance: "core", stateDir: "/nonexistent", ledgerDir: "/nonexistent", dbPath: "/nonexistent.sqlite", lease: { name: "projector", holder: "h", ttlMs: 20_000 },
    window: { t0: 0, t1: 1 }, mark: { atMs: 0, files: [] }, ...extra,
  };
}

/** A module the child oracle starts in place of the real one (a process, so it speaks through `process.send`). */
function childModule(t: TestCtx, body: string): URL {
  const path = join(scratch(t, "rmo-child-module"), "oracle.mjs");
  writeFileSync(path, body);
  return pathToFileURL(path);
}

async function until(done: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await sleep(20);
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

test("C5: an oracle slice runs in a child process that answers, exits, and names what it cost", async (t) => {
  const stateDir = scratch(t, "rmo-child-state");
  const ledgerDir = scratch(t, "rmo-child-ledger");
  const at = Date.parse("2026-09-30T12:00:00.000Z");
  const line = (i: number): string => JSON.stringify({ ts: new Date(at + i * 1_000).toISOString(), step: "worker.activity", task_id: `T${i}`, run_id: `c5-${i}` });
  writeFileSync(join(ledgerDir, "ledger.ndjson"), `${[0, 1, 2].map(line).join("\n")}\n`);
  const clock = fixedClock(at + 3_600_000);
  const db = openProjectorReadModel(stateDir, "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { holder: "c5", clock });
  assert.ok(got.ok);
  createLedgerProjector({ ledgerDir, db, lease: got.lease, clock }).tick();
  // A parent larger than the child: a peak carried over the fork (getrusage's maxRSS on Linux) would read above it.
  const ballast = Buffer.alloc(512 * 1024 * 1024, 1);
  const rows: Row[] = [];
  const pids: number[] = [];
  // The real fork, watched: the child the oracle starts must be gone once its slice is answered.
  const oracle = childOracle({ log: (step, extra) => rows.push({ step, extra }),
    fork: (...args) => { const launched = forkWorkerEntry(...args); pids.push(launched.child.pid!); return launched; } });
  t.after(() => oracle.close());
  const results: OracleSliceResult[] = [];
  oracle.run(request({ stateDir, ledgerDir, dbPath: db.path, lease: { name: got.lease.name, holder: "c5", ttlMs: got.lease.ttlMs },
    window: { t0: at - 1, t1: at + 10_000 }, mark: readIngestMark(db, at) }), (result) => results.push(result));
  await until(() => rows.some((r) => r.step === READ_MODEL_ORACLE_CHILD_STEP));
  assert.deepEqual(results, [{ ok: true, rows: 3, elapsedMs: results[0]?.ok ? results[0].elapsedMs : -1 }], "the slice compared the fixture's three rows");
  const row = rows.find((r) => r.step === READ_MODEL_ORACLE_CHILD_STEP)?.extra;
  assert.equal(row?.outcome, "ok");
  assert.equal(row?.code, 0, "the child exited by itself once it answered");
  assert.equal(row?.instance, "core");
  assert.equal(row?.entry, "tsx", "a parent preloading TypeScript keeps its children on source, as its threads");
  const peak = Number(row?.child_max_rss_bytes);
  assert.ok(peak > 10 * 1024 * 1024, `the child's peak resident size is named: ${peak}`);
  assert.ok(peak < ballast.length, `the peak (${peak}) is the child's own since its exec, not its parent's ballast carried over by the fork`);
  assert.ok(Number(row?.spawn_sync_ms) >= 0 && Number(row?.ready_ms) >= 0 && Number(row?.wall_ms) >= Number(row?.ready_ms), JSON.stringify(row));
  assert.equal(pids.length, 1);
  assert.equal(isAlive(pids[0]!), false, "no process outlives its slice");
  assert.equal(ballast[0], 1);
});

test("C5: an oracle child that dies mid-slice fails it as died, and the next slice starts a fresh child", async (t) => {
  const rows: Row[] = [];
  const oracle = childOracle({ workerUrl: childModule(t, `process.send({ type: "ready" });\nprocess.on("message", () => process.exit(3));\n`),
    log: (step, extra) => rows.push({ step, extra }) });
  t.after(() => oracle.close());
  const results: OracleSliceResult[] = [];
  for (let n = 1; n <= 2; n++) {
    oracle.run(request(), (result) => results.push(result));
    await until(() => rows.filter((r) => r.step === READ_MODEL_ORACLE_CHILD_STEP).length === n);
  }
  assert.equal(results.length, 2, "each slice got exactly one result");
  for (const result of results) {
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.died, true, "a dead child's slice is retried smaller, never skipped");
    assert.match(!result.ok ? result.error : "", /the oracle child exited with code 3/);
  }
  const exits = rows.filter((r) => r.step === READ_MODEL_ORACLE_CHILD_STEP).map((r) => r.extra);
  assert.deepEqual(exits.map((e) => [e.outcome, e.code, e.entry, e.child_max_rss_bytes]), [["died", 3, "override", null], ["died", 3, "override", null]]);
});

test("C5: a closed child oracle kills its child and drops the slice without calling back", async (t) => {
  const pids: number[] = [];
  const oracle = childOracle({ workerUrl: childModule(t, `process.on("message", () => {});\n`), log: () => {},
    fork: (...args) => { const launched = forkWorkerEntry(...args); pids.push(launched.child.pid!); return launched; } });
  let called = 0;
  oracle.run(request(), () => called++);
  await sleep(300);
  oracle.close();
  await until(() => !isAlive(pids[0]!), 10_000);
  assert.equal(isAlive(pids[0]!), false, "close kills the child in flight");
  assert.equal(called, 0, "a killed child's exit is not a result for a slice nobody waits on");
  oracle.close();
});

test("C5: a child that cannot start fails its slice, whether the fork throws or the spawn errors", async () => {
  const rows: Row[] = [];
  const results: OracleSliceResult[] = [];
  childOracle({ log: (step, extra) => rows.push({ step, extra }), fork: () => { throw new Error("EAGAIN fork"); } })
    .run(request(), (result) => results.push(result));
  assert.deepEqual(results, [{ ok: false, error: "the oracle child could not start: EAGAIN fork", leaseLost: false }]);
  const child = Object.assign(new EventEmitter(), { pid: undefined, send: () => true, kill: () => true }) as unknown as ChildProcess;
  childOracle({ log: (step, extra) => rows.push({ step, extra }), fork: () => ({ child, kind: "tsx", spawnSyncMs: 1.234 }) })
    .run(request(), (result) => results.push(result));
  child.emit("error", new Error("spawn ENOMEM"));
  assert.equal(results.length, 2);
  assert.match(!results[1]!.ok ? results[1]!.error : "", /the oracle child exited with code null: spawn ENOMEM/);
  assert.deepEqual(rows.map((r) => r.step), ["read_model.oracle_failed", "read_model.oracle_failed", READ_MODEL_ORACLE_CHILD_STEP]);
  assert.equal(rows[2]!.extra.spawn_sync_ms, 1.2);
});

test("C5: the oracle child carries its own heap ceiling, not its parent's", () => {
  assert.deepEqual(oracleChildExecArgv(["--expose-gc", "--max-old-space-size=8192", "--import", "tsx", "--max_old_space_size=4096"]),
    ["--expose-gc", "--import", "tsx", `--max-old-space-size=${READ_MODEL_ORACLE_HEAP_MB}`]);
});

test("C5: the oracle child body says it is ready, answers one slice with its peak resident size, then exits", () => {
  const sent: Array<Record<string, unknown>> = [];
  let onMessage: ((msg: { type?: string; id?: number; request?: OracleSliceRequest }) => void) | undefined;
  let onDisconnect: (() => void) | undefined;
  let exits = 0;
  runReadModelOracleChild({ on: (_event, run) => (onMessage = run), once: (_event, run) => (onDisconnect = run),
    send: (message, done) => { sent.push(message as Record<string, unknown>); done(); } }, "", () => exits++);
  assert.deepEqual([...sent], [{ type: "ready" }]);
  assert.equal(exits, 0, "ready is not an answer");
  onMessage!({ type: "check", id: 7, request: request() });
  assert.equal(sent[1]?.type, "done");
  assert.equal(sent[1]?.id, 7);
  assert.match(String((sent[1]?.result as { error?: string }).error), /the oracle could not attach to \/nonexistent\.sqlite/);
  assert.ok(Number(sent[1]?.maxRssBytes) > 0);
  assert.equal(exits, 1);
  onDisconnect!();
  assert.equal(exits, 2, "a parent that goes away ends the child too");
});

test("C5: forkWorkerEntry starts the bundle a module's threads start, and a bundle child dying before it speaks demotes the module", async (t) => {
  const root = scratch(t, "rmo-fork-entry");
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  mkdirSync(join(root, "dist"));
  const source = join(root, "src", "lib", "lane.ts");
  writeFileSync(source, "process.exit(0);\n");
  const bundle = join(root, "dist", "lane.mjs");
  writeFileSync(bundle, "process.exit(1);\n");
  const opts = { storeRoot: false as const, hash: () => "h", check: () => ({ current: true, reason: "source-hash-match", bundle }) };
  const exited = (child: ChildProcess): Promise<number | null> => new Promise((resolve) => child.once("exit", resolve));
  const first = forkWorkerEntry(pathToFileURL(source), [], { execArgv: ["--import", "tsx"] }, opts);
  assert.equal(first.kind, "bundle");
  assert.equal(await exited(first.child), 1);
  const second = forkWorkerEntry(pathToFileURL(source), [], { execArgv: [] }, opts);
  assert.equal(second.kind, "tsx", "a bundle that died before speaking is not started again");
  assert.equal(await exited(second.child), 0);
  // A parent preloading TypeScript keeps a bundled module's child on its source, as startWorker keeps its threads.
  const preloaded = join(root, "src", "lib", "preloaded.ts");
  writeFileSync(preloaded, "process.exit(0);\n");
  const setup = join(root, "setup.ts");
  writeFileSync(setup, "export {};\n");
  const kept = forkWorkerEntry(pathToFileURL(preloaded), [], { execArgv: ["--import", setup] }, opts);
  assert.equal(kept.kind, "tsx");
  assert.equal(await exited(kept.child), 0);
  (globalThis as { __rmd_bundled?: unknown }).__rmd_bundled = true;
  try {
    assert.throws(() => forkWorkerEntry(pathToFileURL(source), [], { execArgv: [] }), /a bundled process cannot start src\/lib\/lane\.ts as a worker/);
  } finally {
    delete (globalThis as { __rmd_bundled?: unknown }).__rmd_bundled;
  }
});

test("C5: the child's peak is read from its own status, and an unreadable status is an unknown, not a failure", (t) => {
  const dir = scratch(t, "rmo-peak");
  writeFileSync(join(dir, "status"), "Name:\tnode\nVmHWM:\t  123456 kB\nVmRSS:\t 1000 kB\n");
  writeFileSync(join(dir, "bare"), "Name:\tnode\n");
  assert.equal(residentPeakBytes(join(dir, "status")), 123_456 * 1024);
  assert.equal(residentPeakBytes(join(dir, "bare")), undefined, "a status without VmHWM names no peak");
  assert.equal(residentPeakBytes(join(dir, "absent")), undefined, "no /proc names no peak");
  assert.ok(Number(residentPeakBytes()) > 0, "this host's own status names one");
});
