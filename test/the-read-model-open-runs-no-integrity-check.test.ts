import assert from "node:assert/strict";
import { existsSync, openSync, closeSync, fstatSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { fixedClock, type Clock } from "../src/lib/clock.js";
import { createLedgerProjector, openProjectorReadModel } from "../src/lib/ledger-projector.js";
import {
  acquireLease,
  attachReadModel,
  openReadModel,
  quickCheckReadModel,
  readModelDirtyMarkerPath,
  readModelPath,
  readModelPointerPath,
} from "../src/lib/read-model-db.js";
import {
  READ_MODEL_INTEGRITY_INTERVAL_MS,
  checkReadModelIntegrity,
  createReadModelTicker,
  threadIntegrityCheck,
  type IntegrityRequest,
  type IntegrityResult,
  type ReadModelWorkerMessage,
} from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
const NOW = T0 + 3_600_000;
const LIVE = "ledger.ndjson";
const DDL = "CREATE TABLE IF NOT EXISTS item(id INTEGER PRIMARY KEY, label TEXT NOT NULL);";

type TestCtx = { after: (fn: () => void) => void };

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function steppingClock(start: number): Clock & { advance: (ms: number) => void } {
  let now = start;
  return { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString(), advance: (ms) => void (now += ms) };
}

/** Overwrites the file's last page, a leaf no open reads, so only a full page walk can see the damage. */
function damageLastPage(path: string): void {
  const fd = openSync(path, "r+");
  try {
    const size = fstatSync(fd).size;
    writeSync(fd, Buffer.alloc(4_096, 0xab), 0, 4_096, size - 4_096);
  } finally {
    closeSync(fd);
  }
}

/** A core state dir whose ledger holds rows in a gzip archive and the live file (the rebuild's corpus). */
function coreState(t: TestCtx): string {
  const stateDir = scratch(t, "rm-integrity");
  const rows = Array.from({ length: 400 }, (_, i) => JSON.stringify({ ts: new Date(T0 + i * 1_000).toISOString(), host: "h1", step: i % 2 ? "run.start" : "worker.activity", task_id: `W1-T${i}`, pad: "x".repeat(200) }));
  writeFileSync(join(stateDir, `ledger.${new Date(T0 + 200_500).toISOString().replace(/[:.]/g, "-")}.ndjson.gz`), gzipSync(`${rows.slice(0, 200).join("\n")}\n`));
  writeFileSync(join(stateDir, LIVE), `${rows.slice(200).join("\n")}\n`);
  return stateDir;
}

test("a clean writable open runs no quick_check even over a damaged page", (t) => {
  const dir = scratch(t, "rm-open");
  const path = readModelPath(dir, "core", 1);
  const first = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1, ddl: DDL });
  const insert = first.prepare("INSERT INTO item(label) VALUES(?)");
  for (let i = 0; i < 2_000; i++) insert.run(`row ${i} ${"y".repeat(100)}`);
  first.close();
  damageLastPage(path);

  const db = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1, ddl: DDL, clock: fixedClock(NOW) });
  t.after(() => db.close());
  assert.equal(db.recoveredFrom, undefined, "the open never walked the pages, so it never moved the file aside");
  assert.equal(db.uncleanShutdown, undefined, "the previous writer closed cleanly");
  assert.equal(existsSync(`${path}.corrupt-${NOW}`), false);
  const check = quickCheckReadModel(path);
  assert.equal(check.ok, false, "the damage is real: the background check sees it");
  assert.equal(!check.ok && check.corrupt, true);
});

test("a writer that never closed leaves a dirty marker the next writable open reports", (t) => {
  const dir = scratch(t, "rm-dirty");
  const path = readModelPath(dir, "core", 1);
  const marker = readModelDirtyMarkerPath(path);
  const crashed = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1 });
  assert.ok(existsSync(marker), "a writable open marks the file dirty");
  const reader = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1, readOnly: true });
  const attached = attachReadModel(path, 1);
  reader.close();
  attached.close();
  assert.ok(existsSync(marker), "only the writer that wrote the marker removes it");

  const next = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1 });
  assert.equal(next.uncleanShutdown, true);
  next.close();
  crashed.close();
  assert.equal(existsSync(marker), false, "a clean close removes the marker");
  const clean = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1 });
  assert.equal(clean.uncleanShutdown, undefined);
  clean.close();
});

test("an unclean open schedules the integrity check in the background without blocking the first tick", (t) => {
  const stateDir = coreState(t);
  const seeded = openProjectorReadModel(stateDir, "core");
  const dbPath = seeded.path;
  seeded.close();
  // The crash: the marker a writable open leaves until its close is still there at the next boot.
  writeFileSync(readModelDirtyMarkerPath(dbPath), "1\n");

  const clock = steppingClock(NOW);
  const requests: Array<{ request: IntegrityRequest; done: (result: IntegrityResult) => void }> = [];
  const messages: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({
    stateDir, instances: [{ name: "core", ledgerDir: stateDir }], holder: "qcheck", clock, oracle: "off",
    integrityCheck: (request, done) => void requests.push({ request, done }),
    post: (m) => void messages.push(m),
  });
  t.after(() => ticker.release());
  ticker.start();
  ticker.tick();
  assert.equal(requests.length, 1, "the unclean open asked for one check");
  assert.equal(requests[0]!.request.dbPath, dbPath);
  const state = messages.findLast((m) => m.type === "state");
  assert.ok(state?.type === "state" && state.instances[0]!.newestTs !== null, "the first tick projected while the check was still running");
  const logs = messages.flatMap((m) => (m.type === "log" ? [m] : []));
  assert.deepEqual(logs.find((m) => m.step === "read_model.integrity_started")?.extra, { instance: "core", reason: "unclean shutdown" });

  ticker.tick();
  assert.equal(requests.length, 1, "a running check is never started twice");
  requests[0]!.done({ ok: false, corrupt: true, error: "quick_check: page 9 is never used", ms: 7, rebuild: { code: 0, output: ["rebuilt core"] } });
  const failed = messages.flatMap((m) => (m.type === "log" && m.step === "read_model.integrity_failed" ? [m.extra] : []));
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0]!.rebuild, { code: 0, output: ["rebuilt core"] });

  clock.advance(READ_MODEL_INTEGRITY_INTERVAL_MS - 1);
  ticker.tick();
  assert.equal(requests.length, 1, "the next check waits the full interval");
  clock.advance(1);
  ticker.tick();
  assert.equal(requests.length, 2, "and then runs periodically");
  requests[1]!.done({ ok: true, ms: 3 });
  assert.ok(messages.some((m) => m.type === "log" && m.step === "read_model.integrity_ok"));
});

test("a clean open waits the interval before its first integrity check", (t) => {
  const stateDir = coreState(t);
  const clock = steppingClock(NOW);
  const requests: IntegrityRequest[] = [];
  const messages: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({
    stateDir, instances: [{ name: "core", ledgerDir: stateDir }], holder: "qcheck", clock, oracle: "off",
    integrityCheck: (request) => void requests.push(request),
    post: (m) => void messages.push(m),
  });
  t.after(() => ticker.release());
  ticker.start();
  ticker.tick();
  assert.equal(requests.length, 0, "a clean open runs no check at boot");
  clock.advance(READ_MODEL_INTEGRITY_INTERVAL_MS);
  ticker.tick();
  assert.equal(requests.length, 1);
  assert.deepEqual(messages.flatMap((m) => (m.type === "log" && m.step === "read_model.integrity_started" ? [m.extra.reason] : [])), ["periodic"]);
});

test("corruption found in the background rebuilds a new generation and flips the pointer", (t) => {
  const stateDir = coreState(t);
  const clock = fixedClock(NOW);
  const db = openProjectorReadModel(stateDir, "core", clock);
  const got = acquireLease(db, { holder: "worker", clock });
  assert.ok(got.ok);
  createLedgerProjector({ ledgerDir: stateDir, db, lease: got.lease, clock }).tick();
  const dbPath = db.path;
  db.close();
  damageLastPage(dbPath);

  const request = { instance: "core", stateDir, ledgerDir: stateDir, dbPath };
  const result = checkReadModelIntegrity(request, clock);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.corrupt, "a damaged page is corruption");
  assert.equal(!result.ok && result.rebuild?.code, 0, JSON.stringify(result));
  assert.equal(readFileSync(readModelPointerPath(stateDir, "core", 1), "utf8").trim(), `core.v1.g${NOW}.sqlite`, "the pointer names the rebuilt generation");
  const fresh = openProjectorReadModel(stateDir, "core", clock);
  t.after(() => fresh.close());
  assert.notEqual(fresh.path, dbPath, "every reopen lands on the rebuilt file");
  assert.equal(quickCheckReadModel(fresh.path).ok, true);
});

test("a healthy or unreadable file is never rebuilt", (t) => {
  const stateDir = coreState(t);
  const db = openProjectorReadModel(stateDir, "core");
  const dbPath = db.path;
  db.close();
  let rebuilds = 0;
  const rebuild = (): { code: number; output: string[] } => ({ code: 0, output: [String(++rebuilds)] });
  assert.equal(checkReadModelIntegrity({ instance: "core", stateDir, ledgerDir: stateDir, dbPath }, fixedClock(NOW), rebuild).ok, true);
  const missing = checkReadModelIntegrity({ instance: "core", stateDir, ledgerDir: stateDir, dbPath: join(stateDir, "absent.sqlite") }, fixedClock(NOW), rebuild);
  assert.ok(!missing.ok && !missing.corrupt && missing.rebuild === undefined, JSON.stringify(missing));
  assert.equal(rebuilds, 0);
});

test("the integrity check runs on a thread of its own and a thread that dies is reported", async (t) => {
  const stateDir = coreState(t);
  const db = openProjectorReadModel(stateDir, "core");
  const dbPath = db.path;
  db.close();
  const request = { instance: "core", stateDir, ledgerDir: stateDir, dbPath };
  // The thread is unref'd, as serve's worker never waits on it; this test's timer keeps the loop up.
  const keepAlive = setInterval(() => undefined, 1_000);
  t.after(() => clearInterval(keepAlive));
  const healthy = await new Promise<IntegrityResult>((resolve) => threadIntegrityCheck()(request, resolve));
  assert.equal(healthy.ok, true, JSON.stringify(healthy));
  const died = await new Promise<IntegrityResult>((resolve) => threadIntegrityCheck(new URL("data:text/javascript,throw new Error('boom')"))(request, resolve));
  assert.ok(!died.ok && !died.corrupt, JSON.stringify(died));
  assert.match(died.ok ? "" : died.error, /exited with code 1: boom/);
});
