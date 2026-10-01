import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import type { Clock } from "../src/lib/clock.js";
import { MIN_TRANSACTION_LINES, createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import { acquireLease } from "../src/lib/read-model-db.js";
import { READ_MODEL_STALL_MS, createReadModelTicker, createReadModelWorker, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
const LIVE = "ledger.ndjson";

type TestCtx = { after: (fn: () => void) => void };

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function handClock(start: number): { clock: Clock; advance: (ms: number) => void } {
  let ms = start;
  return {
    clock: { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() },
    advance: (by) => void (ms += by),
  };
}

function rows(n: number, startMs: number, tag: string): string {
  let out = "";
  for (let i = 0; i < n; i++) out += `${JSON.stringify({ ts: new Date(startMs + i).toISOString(), step: "run.start", run_id: `${tag}-${String(i).padStart(4, "0")}` })}\n`;
  return out;
}

function archiveName(ms: number, gz: boolean): string {
  return `ledger.${new Date(ms).toISOString().replace(/[:.]/g, "-")}.ndjson${gz ? ".gz" : ""}`;
}

/** A worker that only posts what `body` makes it post: the serve watchdog's view of a real one. */
function scriptedWorker(body: string): URL {
  return new URL(`data:text/javascript,${encodeURIComponent(`import { parentPort } from "node:worker_threads";\n${body}`)}`);
}

test("upgrading from old-identity checkpoints re-reads nothing already checkpointed", (t) => {
  const ledgerDir = scratch(t, "reingest-ledger");
  const stateDir = scratch(t, "reingest-state");
  const gz = archiveName(T0, true);
  const plain = archiveName(T0 + 1_000, false);
  const half = archiveName(T0 + 2_000, false);
  writeFileSync(join(ledgerDir, gz), gzipSync(rows(300, T0, "gz")));
  writeFileSync(join(ledgerDir, plain), rows(200, T0 + 100_000, "plain"));
  const halfText = rows(100, T0 + 200_000, "half");
  writeFileSync(join(ledgerDir, half), halfText);
  writeFileSync(join(ledgerDir, LIVE), rows(50, T0 + 300_000, "live"));
  const clock = handClock(T0 + 3_600_000).clock;
  const db = openProjectorReadModel(stateDir, "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock, holder: "reingest" });
  if (!got.ok) throw new Error(`lease held by ${got.heldBy}`);
  createLedgerProjector({ ledgerDir, db, lease: got.lease, clock }).tick();

  // The checkpoints a store wrote before archives carried a head: null when read whole, and
  // `partial:<decompressed length>` for one stopped mid-file (here after its first 40 rows).
  const halfOff = Buffer.byteLength(halfText.split("\n").slice(0, 40).join("\n")) + 1;
  db.exec(`UPDATE source_file SET fp = NULL WHERE name IN ('${gz}', '${plain}')`);
  db.prepare("UPDATE source_file SET off = ?, fp = ? WHERE name = ?").run(halfOff, `partial:${Buffer.byteLength(halfText)}`, half);
  db.exec("DELETE FROM seen WHERE ts_ms >= " + String(T0 + 200_040) + " AND ts_ms < " + String(T0 + 300_000));

  const upgraded = createLedgerProjector({ ledgerDir, db, lease: got.lease, clock }).tick();
  assert.equal(upgraded.lines, 60, "only the rows past the old partial checkpoint are read; every read archive is skipped");
  assert.equal(upgraded.fresh, 60);
  assert.equal(upgraded.upgraded, 2, "both whole archives are given their head without a re-read");
  const fps = db.prepare("SELECT name, fp FROM source_file WHERE name <> ? ORDER BY name").all(LIVE).map((r) => `${String(r.name)}=${String(r.fp).split(":")[0]}`);
  assert.deepEqual(fps, [`${gz}=head`, `${plain}=head`, `${half}=head`], "every archive now carries its head");

  const again = createLedgerProjector({ ledgerDir, db, lease: got.lease, clock }).tick();
  assert.deepEqual([again.lines, again.upgraded], [0, 0], "an upgraded checkpoint is matched by its head from then on");
});

test("an unmeasured rate is calibrated on a small first transaction instead of a whole archive", (t) => {
  const ledgerDir = scratch(t, "reingest-calibrate");
  const stateDir = scratch(t, "reingest-calibrate-state");
  writeFileSync(join(ledgerDir, archiveName(T0, true)), gzipSync(rows(2_000, T0, "big")));
  const clock = handClock(T0 + 3_600_000).clock;
  const db = openProjectorReadModel(stateDir, "core", clock);
  t.after(() => db.close());
  const got = acquireLease(db, { clock, holder: "reingest" });
  if (!got.ok) throw new Error(`lease held by ${got.heldBy}`);
  const commits: number[] = [];
  const p = createLedgerProjector({ ledgerDir, db, lease: got.lease, clock, onCommit: (_source, lines) => void commits.push(lines) });
  p.tick({ budgetMs: 833 });
  assert.equal(commits[0], MIN_TRANSACTION_LINES, "a whole archive in one transaction outlasted the silent-worker watchdog on the host");
});

test("the read-model ticker heartbeats around a store open and on every commit", (t) => {
  const stateDir = scratch(t, "reingest-beat");
  const ledgerDir = scratch(t, "reingest-beat-ledger");
  writeFileSync(join(ledgerDir, LIVE), rows(10, T0, "beat"));
  const progress: string[] = [];
  const ticker = createReadModelTicker({
    stateDir, instances: [{ name: "core", ledgerDir }], clock: handClock(T0 + 60_000).clock, holder: "reingest", oracle: "off", views: [],
    post: (m: ReadModelWorkerMessage) => void (m.type === "progress" && progress.push(`${m.instance}:${m.phase}`)),
  });
  t.after(() => ticker.release());
  ticker.start();
  ticker.tick();
  assert.deepEqual(progress, ["core:open", "core:opened", "core:commit"]);
});

test("a long catch-up with progress is never recycled by the silent-worker watchdog", async (t) => {
  const stateDir = scratch(t, "reingest-busy");
  const hand = handClock(T0);
  const logged: string[] = [];
  let watch: (() => void) | undefined;
  const handle = createReadModelWorker({
    stateDir, instances: [{ name: "core", ledgerDir: stateDir }], stopWaitMs: 20, clock: hand.clock,
    workerUrl: scriptedWorker(`setInterval(() => parentPort.postMessage({ type: "progress", instance: "core", phase: "commit", rows: 64 }), 2);`),
    log: (step) => void logged.push(step), every: (run) => ((watch = run), () => undefined),
  });
  t.after(() => handle.stop());
  handle.start();
  await sleep(300); // the worker boots
  // Twenty minutes of catch-up, each minute carrying commits: no bound is ever reached.
  for (let minute = 0; minute < 20; minute++) {
    hand.advance(READ_MODEL_STALL_MS * 1.5);
    await sleep(30); // the worker's commits arrive at the advanced clock
    watch?.();
  }
  assert.deepEqual(logged.filter((s) => /worker_(silent|recycled|exited)/.test(s)), [], "a worker posting commits is never silent and never recycled");
});

test("a truly stuck worker is recycled and the row names the phase it went silent in", async (t) => {
  const stateDir = scratch(t, "reingest-stuck");
  const hand = handClock(T0);
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let watch: (() => void) | undefined;
  const handle = createReadModelWorker({
    stateDir, instances: [{ name: "core", ledgerDir: stateDir }], stopWaitMs: 20, clock: hand.clock,
    workerUrl: scriptedWorker(`parentPort.postMessage({ type: "progress", instance: "core", phase: "commit", rows: 64 }); setInterval(() => {}, 1000);`),
    log: (step, extra) => void logged.push({ step, ...(extra ? { extra } : {}) }), every: (run) => ((watch = run), () => undefined),
  });
  t.after(() => handle.stop());
  handle.start();
  await sleep(100);
  hand.advance(2 * READ_MODEL_STALL_MS);
  watch?.();
  const recycled = logged.find((l) => l.step === "read_model.worker_recycled");
  assert.ok(recycled, "silence past the bound with no progress recycles the worker");
  assert.deepEqual([recycled.extra?.phase, recycled.extra?.instance], ["commit", "core"]);
});

test("a store open is given twice the slowest open the worker reported before it is recycled", async (t) => {
  const stateDir = scratch(t, "reingest-open");
  const hand = handClock(T0);
  const logged: string[] = [];
  let watch: (() => void) | undefined;
  const slowOpenMs = 5 * READ_MODEL_STALL_MS;
  const handle = createReadModelWorker({
    stateDir, instances: [{ name: "core", ledgerDir: stateDir }], stopWaitMs: 20, clock: hand.clock,
    workerUrl: scriptedWorker(`parentPort.postMessage({ type: "progress", instance: "core", phase: "opened", ms: ${slowOpenMs} });
      parentPort.postMessage({ type: "progress", instance: "core", phase: "open" }); setInterval(() => {}, 1000);`),
    log: (step) => void logged.push(step), every: (run) => ((watch = run), () => undefined),
  });
  t.after(() => handle.stop());
  handle.start();
  await sleep(100);
  hand.advance(2 * READ_MODEL_STALL_MS);
  watch?.();
  assert.ok(!logged.includes("read_model.worker_recycled"), "an open slower than the base bound is not killed: a respawn repeats it");
  hand.advance(2 * slowOpenMs);
  watch?.();
  assert.ok(logged.includes("read_model.worker_recycled"), "an open past twice the slowest one reported is stuck");
});
