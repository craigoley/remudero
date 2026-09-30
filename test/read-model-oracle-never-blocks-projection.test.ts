import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { fixedClock } from "../src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { ORACLE_CLOSED_LAG_MS, ORACLE_SEED_ROWS_PER_MS, READ_MODEL_CONSISTENCY_STEP, readIngestMark } from "../src/lib/read-model-consistency.js";
import { acquireLease, openReadModel } from "../src/lib/read-model-db.js";
import {
  createReadModelTicker,
  inProcessOracle,
  runReadModelOracleWorker,
  threadOracle,
  type OracleSliceRequest,
  type OracleSliceResult,
  type ReadModelOracle,
  type ReadModelWorkerMessage,
} from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";

const LIVE = "ledger.ndjson";
const HOUR = 3_600_000;

type TestCtx = { after: (fn: () => void) => void };

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function line(ms: number, tag: string, i: number): string {
  return JSON.stringify({ ts: new Date(ms).toISOString(), step: i % 2 ? "run.start" : "worker.activity", task_id: `T${i % 97}`, run_id: `${tag}-${i}`, pad: "x".repeat(120) });
}

/** `archives` gzip rotations of `perArchive` rows spread over the last few days, then a small live file. */
function corpus(dir: string, archives: number, perArchive: number, endMs: number): void {
  mkdirSync(dir, { recursive: true });
  const spanMs = 5 * 24 * HOUR;
  const step = spanMs / (archives * perArchive);
  let at = endMs - spanMs;
  for (let a = 0; a < archives; a++) {
    let text = "";
    for (let i = 0; i < perArchive; i++) text += `${line(Math.round(at + i * step), `a${a}`, i)}\n`;
    at += perArchive * step;
    writeFileSync(join(dir, `ledger.${new Date(Math.round(at)).toISOString().replace(/[:.]/g, "-")}.ndjson.gz`), gzipSync(text));
  }
  writeFileSync(join(dir, LIVE), `${line(endMs - ORACLE_CLOSED_LAG_MS * 2, "live", 0)}\n`);
}

function metricRows(stateDir: string): Array<Record<string, unknown>> {
  const path = join(stateDir, LIVE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r.step === READ_MODEL_CONSISTENCY_STEP);
}

test("projection keeps advancing while an oracle slice runs on its own thread over a large corpus", async (t) => {
  const ledgerDir = scratch(t, "rmo-ledger");
  const stateDir = scratch(t, "rmo-state");
  corpus(ledgerDir, 40, 1_250, Date.now());
  const messages: ReadModelWorkerMessage[] = [];
  const oracle = threadOracle({ log: (step, extra) => messages.push({ type: "log", step, extra }) });
  // Marks settle at once and one slice covers the whole window, so the slice is as large as the corpus.
  const ticker = createReadModelTicker({
    stateDir, instances: [{ name: "core", ledgerDir }], holder: "never-blocks", ingestSettleMs: 0, oracleSliceBudgetMs: 1e9, oracleRunner: oracle,
    post: (m) => void messages.push(m),
  });
  t.after(() => ticker.release());
  ticker.start();
  const state = () => {
    const last = messages.findLast((m) => m.type === "state");
    return last?.type === "state" ? last.instances[0] : undefined;
  };
  const during: Array<{ ms: number; appended: string; applied: string | null }> = [];
  const deadline = Date.now() + 120_000;
  let n = 0;
  while (metricRows(stateDir).length === 0 && Date.now() < deadline) {
    const ts = new Date().toISOString();
    appendFileSync(join(ledgerDir, LIVE), `${JSON.stringify({ ts, step: "worker.activity", run_id: `tick-${n++}` })}\n`);
    const started = performance.now();
    ticker.tick();
    const ms = performance.now() - started;
    if (state()?.checking) during.push({ ms, appended: ts, applied: state()?.newestTs ?? null });
    await sleep(20);
  }
  const [metric] = metricRows(stateDir);
  assert.equal(metric?.outcome, "agree", "the slice finished and agreed");
  assert.ok(Number(metric?.compared) >= 25_000, `the slice compared ${metric?.compared} rows: a large one`);
  assert.ok(during.length >= 3, `${during.length} ticks ran while the slice was in flight`);
  assert.deepEqual(during.filter((tick) => tick.applied !== tick.appended), [], "every tick during the slice applied the row appended just before it: no lag");
  const longest = Math.max(...during.map((tick) => tick.ms));
  assert.ok(longest < Number(metric?.elapsed_ms), `the longest tick during the slice (${Math.round(longest)} ms) was shorter than the slice (${metric?.elapsed_ms} ms)`);
});

/** A module the oracle thread can load in place of the real one: it throws on its first message. */
function brokenOracleModule(t: TestCtx): URL {
  const dir = scratch(t, "rmo-broken");
  const path = join(dir, "oracle.mjs");
  writeFileSync(path, `import { parentPort } from "node:worker_threads";\nparentPort.on("message", () => { throw new Error("oracle boom"); });\n`);
  return pathToFileURL(path);
}

function request(dbPath: string, extra: Partial<OracleSliceRequest> = {}): OracleSliceRequest {
  return {
    instance: "core", stateDir: "/nonexistent", ledgerDir: "/nonexistent", dbPath, lease: { name: "projector", holder: "h", ttlMs: 20_000 },
    window: { t0: 0, t1: 1 }, mark: { atMs: 0, files: [] }, ...extra,
  };
}

test("an oracle slice in flight when its thread dies fails and the next slice respawns the thread", async (t) => {
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const oracle = threadOracle({ workerUrl: brokenOracleModule(t), log: (step, extra) => logs.push({ step, extra }) });
  t.after(() => oracle.close());
  const results: OracleSliceResult[] = [];
  const once = async (): Promise<void> => {
    const before = results.length;
    oracle.run(request("/nonexistent.sqlite"), (result) => results.push(result));
    const until = Date.now() + 20_000;
    while (results.length === before && Date.now() < until) await sleep(10);
  };
  await once();
  await once();
  assert.equal(results.length, 2, "each slice got exactly one result");
  for (const result of results) {
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : "", /the oracle thread exited with code 1/);
  }
  assert.ok(logs.filter((l) => l.step === "read_model.oracle_failed").length >= 2, "the thread's failure is logged, once per spawn");
  assert.match(String(logs[0]?.extra.error), /oracle boom/);
});

test("a closed oracle drops its slice in flight without calling back", async (t) => {
  const dir = scratch(t, "rmo-silent");
  const path = join(dir, "oracle.mjs");
  writeFileSync(path, `import { parentPort } from "node:worker_threads";\nparentPort.on("message", () => {});\n`);
  const oracle = threadOracle({ workerUrl: pathToFileURL(path), log: () => {} });
  let called = 0;
  oracle.run(request("/nonexistent.sqlite"), () => called++);
  await sleep(200);
  oracle.close();
  await sleep(200);
  assert.equal(called, 0, "a terminated thread's exit is not a result for a slice nobody waits on");
  oracle.close();
});

test("the oracle thread body attaches once per store and turns every failure into a result", (t) => {
  const stateDir = scratch(t, "rmo-body-state");
  const ledgerDir = scratch(t, "rmo-body-ledger");
  const at = Date.parse("2026-09-30T12:00:00.000Z");
  writeFileSync(join(ledgerDir, LIVE), `${[0, 1, 2].map((i) => line(at + i * 1_000, "body", i)).join("\n")}\n`);
  const clock = fixedClock(at + HOUR);
  const db = openProjectorReadModel(stateDir, "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { holder: "body", clock });
  assert.ok(got.ok);
  createLedgerProjector({ ledgerDir, db, lease: got.lease, clock }).tick();
  const foreign = openReadModel({ stateDir: scratch(t, "rmo-body-foreign"), instance: "core", schemaVersion: 7 });
  const foreignPath = foreign.path;
  foreign.close();

  let onMessage: ((msg: { type?: string; id?: number; request?: OracleSliceRequest }) => void) | undefined;
  const posted: Array<{ id?: number; result: OracleSliceResult }> = [];
  runReadModelOracleWorker({ on: (_event, run) => (onMessage = run), postMessage: (m) => void posted.push(m as { id?: number; result: OracleSliceResult }) }, { kind: "remudero-read-model-oracle" }, clock);
  onMessage!({ type: "ping" });
  assert.equal(posted.length, 0, "only check messages are answered");
  const good = request(db.path, { stateDir, ledgerDir, lease: { name: got.lease.name, holder: "body", ttlMs: got.lease.ttlMs }, window: { t0: at - 1, t1: at + 10_000 }, mark: readIngestMark(db, at) });
  onMessage!({ type: "check", id: 1, request: good });
  onMessage!({ type: "check", id: 2, request: good });
  onMessage!({ type: "check", id: 3, request: request(foreignPath) });
  onMessage!({ type: "check", id: 4, request: good, });
  assert.deepEqual(posted.map((p) => [p.id, p.result.ok]), [[1, true], [2, true], [3, false], [4, true]]);
  assert.equal(posted[0]!.result.ok && posted[0]!.result.rows, 3);
  assert.match(!posted[2]!.result.ok ? posted[2]!.result.error : "", /could not attach to .*holds schema 7, expected 1/);
  // A holder that does not own the lease heals nothing and says why.
  db.exec("DELETE FROM fact WHERE seq = (SELECT min(seq) FROM fact)");
  onMessage!({ type: "check", id: 5, request: { ...good, lease: { ...good.lease, holder: "someone-else" } } });
  const stolen = posted.at(-1)!.result;
  assert.equal(stolen.ok, false);
  assert.equal(!stolen.ok && stolen.leaseLost, true);
});

test("a slice that finishes after its slot was released changes nothing", (t) => {
  const stateDir = scratch(t, "rmo-late-state");
  const ledgerDir = scratch(t, "rmo-late-ledger");
  const at = Date.parse("2026-09-30T12:00:00.000Z");
  writeFileSync(join(ledgerDir, LIVE), `${[0, 1, 2].map((i) => line(at + i * 1_000, "late", i)).join("\n")}\n`);
  let finish: ((result: OracleSliceResult) => void) | undefined;
  const deferred: ReadModelOracle = { run: (_request, done) => void (finish = done), close: () => {} };
  const logs: string[] = [];
  const ticker = createReadModelTicker({
    stateDir, instances: [{ name: "core", ledgerDir }], clock: fixedClock(at + HOUR), holder: "late", ingestSettleMs: 0, oracleRunner: deferred,
    post: (m) => void (m.type === "log" && logs.push(m.step)),
  });
  for (let i = 0; i < 4 && finish === undefined; i++) ticker.tick();
  assert.ok(finish, "a slice was started");
  ticker.release();
  finish({ ok: true, rows: 3, elapsedMs: 1 });
  assert.deepEqual(logs.filter((step) => step.includes("fail")), [], "nothing failed");
  const db = openProjectorReadModel(stateDir, "core");
  t.after(() => db.close());
  assert.equal(db.meta("oracle_slice"), undefined, "the released slot's cursor did not move");

  const none = inProcessOracle(() => undefined, fixedClock(at));
  let result: OracleSliceResult | undefined;
  none.run(request("/nowhere.sqlite"), (r) => (result = r));
  assert.match(result && !result.ok ? result.error : "", /no open store for core/);
  none.close();
});

test("a slice whose oracle thread died is retried at half the rate and never skipped", (t) => {
  const stateDir = scratch(t, "rmo-died-state");
  const ledgerDir = scratch(t, "rmo-died-ledger");
  const at = Date.parse("2026-09-30T12:00:00.000Z");
  writeFileSync(join(ledgerDir, LIVE), `${[0, 1, 2].map((i) => line(at + i * 1_000, "died", i)).join("\n")}\n`);
  const windows: Array<[number, number]> = [];
  let outcome: OracleSliceResult = { ok: false, error: "the oracle thread exited with code 1", leaseLost: false, died: true };
  const dying: ReadModelOracle = { run: (req, done) => (windows.push([req.window.t0, req.window.t1]), done(outcome)), close: () => {} };
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], clock: fixedClock(at + HOUR), holder: "died", ingestSettleMs: 0, oracleRunner: dying, post: () => {} });
  t.after(() => ticker.release());
  const db = openProjectorReadModel(stateDir, "core");
  t.after(() => db.close());
  const rate = () => (JSON.parse(db.meta("oracle_slice") ?? "{}") as { rowsPerMs?: number }).rowsPerMs;
  for (let i = 0; i < 4 && windows.length === 0; i++) ticker.tick();
  assert.equal(windows.length, 1);
  assert.equal(rate(), ORACLE_SEED_ROWS_PER_MS / 2, "the dead slice halved the rate its retry is sized from");
  // The failure backs the next slice off; once due again, the same slice is retried, smaller.
  outcome = { ok: true, rows: 3, elapsedMs: 1 };
  const later = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], clock: fixedClock(at + 2 * HOUR), holder: "died", ingestSettleMs: 0, oracleRunner: dying, post: () => {} });
  ticker.release();
  t.after(() => later.release());
  for (let i = 0; i < 4 && windows.length === 1; i++) later.tick();
  assert.equal(windows.length, 2);
  assert.equal(windows[1]![1], windows[0]![1], "the retry starts where the dead slice did: nothing was skipped");
  assert.equal(rate(), (ORACLE_SEED_ROWS_PER_MS / 2 + 3) / 2, "the retry finished and its measured rate moved the next one");
});
