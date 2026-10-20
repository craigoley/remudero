import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { acquireLease, withWriteTransaction } from "#src/lib/read-model-db.js";
import { openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { createReadModelWorker, readModelBodyKey, type ReadModelWorkerHandle } from "#src/lib/read-model-worker.js";
import { readModelWarmProbe } from "#src/lib/serve-generation.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { trackWorkerThreads } from "#src/lib/worker-heaps.js";

function fixture(t: TestContext) {
  const dir = makeTempDir("retired-standby-body");
  const db = openProjectorReadModel(dir, "core");
  db.exec("CREATE TABLE view_body(view TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL, generation INTEGER NOT NULL, etag TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(view,key)) WITHOUT ROWID");
  const got = acquireLease(db);
  assert.ok(got.ok);
  const handles: ReadModelWorkerHandle[] = [];
  const threads = trackWorkerThreads();
  t.after(async () => {
    for (const handle of handles) handle.stop();
    await threads.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const entry = (key: string, etag = key) => ({ view: "fixture", key, version: 1, generation: 1, etag,
    body: { view: "fixture", version: 1, generatedAt: new Date().toISOString(), asOf: null, stale: false, sources: [], data: etag } });
  const write = (key: string, etag = key) => {
    const body = entry(key, etag);
    withWriteTransaction(db, got.lease, () => db.prepare("INSERT OR REPLACE INTO view_body VALUES(?,?,?,?,?,?)")
      .run(body.view, key, 1, 1, etag, JSON.stringify(body.body)));
  };
  const open = (workerUrl?: URL) => {
    const handle = createReadModelWorker({ stateDir: dir, instances: [{ name: "core", ledgerDir: dir }], ...(workerUrl ? { workerUrl } : {}) });
    handles.push(handle);
    return handle;
  };
  return { dir, db, entry, write, open };
}

test("promotion reload removes retired committed keys so a fresh standby is not falsely thinner", (t) => {
  const f = fixture(t);
  f.write("kept"); f.write("retired");
  const active = f.open();
  f.db.prepare("DELETE FROM view_body WHERE key = ?").run("retired");
  f.write("kept", "changed"); f.write("added");
  assert.equal(active.reload(), 2);
  assert.deepEqual([...active.bodies.keys()].sort(), ["added", "kept"].map(k => readModelBodyKey("fixture", k)));
  assert.equal(active.body("fixture", "kept")?.etag, "changed");
  const standby = f.open();
  assert.equal(readModelWarmProbe(standby)(new URLSearchParams(`bodies=${active.bodies.size}`)).ok, true,
    "the unchanged readiness gate compares the same committed population after reload");
});

test("reload distinguishes an unreadable snapshot from a successfully committed empty snapshot", (t) => {
  const f = fixture(t);
  f.write("kept");
  const active = f.open();
  const original = active.body("fixture", "kept");
  f.db.exec("UPDATE view_body SET body = '{broken'");
  assert.equal(active.reload(), 0);
  assert.equal(active.body("fixture", "kept"), original, "failed reads preserve the last complete snapshot");
  f.db.exec("DELETE FROM view_body");
  assert.equal(active.reload(), 0);
  assert.equal(active.bodies.size, 0, "a successful empty snapshot retires the old committed population");
});

test("retired-key cleanup preserves a newer body actually posted by the running worker", { timeout: 10_000 }, async (t) => {
  const f = fixture(t);
  f.write("retired");
  const worker = join(f.dir, "producer.mjs");
  writeFileSync(worker, `import { parentPort, workerData } from 'node:worker_threads';
parentPort.on('message', m => { if (m.type === 'stop') { const s = new Int32Array(workerData.signal); Atomics.store(s,1,1); Atomics.notify(s,1); parentPort.close(); } });
parentPort.postMessage(${JSON.stringify({ type: "body", entry: f.entry("live-only") })});
`);
  const active = f.open(pathToFileURL(worker));
  const posted = new Promise<void>(resolve => active.onBody(() => resolve()));
  active.start(); await posted;
  const live = active.body("fixture", "live-only");
  assert.ok(live);
  f.db.exec("DELETE FROM view_body");
  active.reload();
  assert.equal(active.body("fixture", "live-only"), live, "worker output stays ahead of the older DB snapshot");
  assert.equal(active.body("fixture", "retired"), undefined);
});
