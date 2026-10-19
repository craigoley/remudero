import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { makeTempDir } from "#src/lib/tmp.js";
import { acquireLease, flushReadModelTransactions, openReadModel, READ_MODEL_BUSY_TIMEOUT_MS } from "#src/lib/read-model-db.js";
import { openProjectorReadModel } from "#src/lib/ledger-projector.js";
import { createReadModelTicker, readModelSwitchesPath, type ReadModelWorkerMessage } from "#src/lib/read-model-worker.js";

const fixtureClosers = new WeakMap<TestContext, Array<() => unknown>>();
function closeAfter(t: TestContext, close: () => unknown): void {
  const closers = fixtureClosers.get(t);
  assert.ok(closers, "the private state fixture must exist before registering its resources");
  closers.push(close);
}
function state(t: TestContext): string {
  const path = makeTempDir("read-model-contention");
  const closers: Array<() => unknown> = [];
  fixtureClosers.set(t, closers);
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await flushReadModelTransactions();
    rmSync(path, { recursive: true, force: true });
  });
  return path;
}

/** The worker, not this blocked JS thread, owns the competing SQLite transaction. */
async function hold(t: TestContext, path: string, exclusive = false): Promise<() => Promise<void>> {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL("./fixtures/read-model-contention-worker.mjs", import.meta.url), { workerData: { path, gate: gate.buffer, exclusive } });
  const done = new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", code => code === 0 ? resolve() : reject(new Error(`fixture writer exit ${code}`)));
  });
  // Attach a rejection observer immediately, including setup failure before the release call.
  void done.catch(() => {});
  const release = async () => { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); await done; };
  closeAfter(t, release);
  await new Promise<void>((resolve, reject) => {
    worker.once("message", message => message.held ? resolve() : reject(new Error("writer did not acquire lock")));
    worker.once("error", reject);
    worker.once("exit", () => reject(new Error("writer exited before acquiring lock")));
  });
  return release;
}

function failure(fn: () => unknown): Error & { errcode?: number; code?: string } {
  try { fn(); } catch (error) { assert.ok(error instanceof Error); return error; }
  return assert.fail("a real SQLite operation must fail");
}

test("W1-T9937 criterion 1: read-model contention identifies the failing operation without SQL or bind values", async t => {
  const db = openReadModel({ stateDir: state(t), instance: "core", schemaVersion: 1, ddl: "CREATE TABLE secret_table(value TEXT);" });
  closeAfter(t, () => db.close());
  assert.equal(db.prepare("PRAGMA busy_timeout").get()?.timeout, READ_MODEL_BUSY_TIMEOUT_MS);
  db.prepare("INSERT INTO secret_table VALUES (?)").run("positive control");
  assert.equal(db.prepare("SELECT count(*) AS n FROM secret_table").get()?.n, 1);
  // Only this private connection uses a shorter deadline. Production stays at five seconds.
  db.exec("PRAGMA busy_timeout=25");
  const insert = db.prepare("INSERT INTO secret_table VALUES (?)");
  const release = await hold(t, db.path);
  const errors = [failure(() => db.exec("BEGIN IMMEDIATE")), failure(() => insert.run("private-bind-value"))];
  for (const [index, error] of errors.entries()) {
    assert.equal(error.errcode! & 0xff, 5);
    assert.equal(error.code, "ERR_SQLITE_ERROR");
    assert.match(error.message, /\[connection=[^/]+\/writer pid=\d+ thread=\d+ path=.+\]/);
    assert.ok(error.message.endsWith(`[operation=${index === 0 ? "exec.begin-immediate" : "run"}]`));
    for (const secret of ["secret_table", "private-bind-value", "INSERT", "blocking-owner"]) assert.ok(!error.message.includes(secret));
  }
  assert.equal(errors[0]!.message.match(/connection=([^/]+)/)?.[1], errors[1]!.message.match(/connection=([^/]+)/)?.[1]);
  await release();
  insert.run("restored control");
  assert.equal(db.prepare("SELECT count(*) AS n FROM secret_table").get()?.n, 2);
});

test("W1-T9937 criterion 1: a blocked connect and a blocked iterate step name their operation", async t => {
  const stateDir = state(t);
  const db = openReadModel({ stateDir, instance: "core", schemaVersion: 1, ddl: "CREATE TABLE secret_table(value TEXT);" });
  let closed = false;
  closeAfter(t, () => { if (!closed) db.close(); });
  db.prepare("INSERT INTO secret_table VALUES (?)").run("positive control");
  const rows = () => [...db.prepare("SELECT value FROM secret_table").iterate()].map(row => row.value);
  assert.deepEqual(rows(), ["positive control"]);
  db.exec("PRAGMA busy_timeout=25");
  const bump = db.prepare("PRAGMA user_version = 7");
  let release = await hold(t, db.path);
  const step = failure(() => [...bump.iterate()]);
  assert.equal(step.errcode! & 0xff, 5);
  assert.match(step.message, /\[connection=[^/]+\/writer pid=\d+ thread=\d+ path=.+\]/);
  assert.ok(step.message.endsWith("[operation=iterate-next]"));
  assert.ok(!step.message.includes("user_version"));
  await release();
  assert.deepEqual([...bump.iterate()], []);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 7);
  db.close(); closed = true;
  // Production's five-second deadline applies here: the fixture shortens nothing on a connect.
  release = await hold(t, db.path, true);
  const open = failure(() => openReadModel({ stateDir, instance: "core", schemaVersion: 1 }));
  assert.equal(open.errcode! & 0xff, 5);
  assert.match(open.message, /\[connection=[^/]+\/writer pid=\d+ thread=\d+ path=.+\]/);
  assert.ok(open.message.endsWith("[operation=connect]"));
  await release();
  const reopened = openReadModel({ stateDir, instance: "core", schemaVersion: 1 });
  closeAfter(t, () => reopened.close());
  assert.deepEqual([...reopened.prepare("SELECT value FROM secret_table").iterate()].map(row => row.value), ["positive control"]);
});

test("W1-T9937 criterion 2: actual projector and view writers retain fences through contention", async t => {
  const stateDir = state(t), ledger = join(stateDir, "ledger.ndjson");
  let now = Date.now();
  const clock = { now: () => now, iso: () => new Date(now).toISOString(), date: () => new Date(now) }, messages: ReadModelWorkerMessage[] = [];
  writeFileSync(ledger, ""); mkdirSync(join(stateDir, "read-model"));
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { inbox: "serve" } }));
  const common = { stateDir, instances: [{ name: "core", ledgerDir: stateDir }], holder: "fixture-owner", clock, views: [], oracle: "off" as const, tickMs: 1, post: (message: ReadModelWorkerMessage) => { messages.push(message); } };
  const projector = createReadModelTicker(common), views = createReadModelTicker({ ...common, viewsOnly: true });
  closeAfter(t, () => { views.release(); projector.release(); });
  projector.start(); projector.tick();
  const observed = messages.filter(m => m.type === "state").at(-1)!;
  assert.equal(observed.type, "state");
  if (observed.type !== "state") return;
  assert.equal(observed.instances[0]?.lease, "held");
  views.start(); views.observe(observed.instances); views.tick();
  const db = openProjectorReadModel(stateDir, "core", clock); closeAfter(t, () => db.close());
  const accept = (value: string) => views.accept({ view: "inbox", version: 1, bodies: [{ key: "fixture", data: { value }, sources: [] }] });
  accept("positive");
  const body = () => String(db.prepare("SELECT body FROM view_body WHERE view='inbox' AND key='fixture'").get()?.body);
  assert.match(body(), /positive/);
  const append = (id: string) => appendFileSync(ledger, JSON.stringify({ ts: new Date(now).toISOString(), run_id: id, task_id: "W1-T9937", step: "run.start" }) + "\n");
  append("positive"); now += 10; projector.tick();
  const facts = () => Number(db.prepare("SELECT count(*) AS n FROM fact").get()?.n);
  assert.equal(facts(), 1, "real projector positive commit");
  let release = await hold(t, db.path);
  append("blocked"); now += 10; projector.tick();
  const logs = (step: string) => messages.filter(m => m.type === "log" && m.step === step).map(m => m.type === "log" ? m.extra : {});
  assert.match(String(logs("read_model.tick_failed").at(-1)?.error), /\[operation=exec.begin-immediate\]/);
  assert.equal(facts(), 1, "failed projector admission commits no partial facts");
  await release(); now += 10; projector.tick();
  assert.equal(facts(), 2, "same real path recovers after the competing writer ends");
  const fresh = messages.filter(m => m.type === "state").at(-1)!;
  if (fresh.type === "state") views.observe(fresh.instances);
  views.tick();
  release = await hold(t, db.path);
  accept("blocked");
  assert.match(String(logs("read_model.materialize_failed").at(-1)?.error), /\[operation=exec.begin-immediate\]/);
  assert.match(body(), /positive/, "failed materializer admission preserves the committed body");
  const projectorConnection = String(logs("read_model.tick_failed").at(-1)?.error).match(/connection=([^/]+)/)?.[1];
  const viewsConnection = String(logs("read_model.materialize_failed").at(-1)?.error).match(/connection=([^/]+)/)?.[1];
  assert.ok(projectorConnection && viewsConnection && projectorConnection !== viewsConnection, "both failing connection identities are retained");
  await release(); accept("restored"); assert.match(body(), /restored/);
  now += 21_000;
  assert.equal(acquireLease(db, { holder: "foreign-owner", clock }).ok, true);
  // Refresh only the observation to reach the actual SQL fence, keeping the old holder.
  if (fresh.type === "state") views.observe(fresh.instances);
  views.tick(); accept("forbidden");
  assert.match(String(logs("read_model.materialize_failed").at(-1)?.error), /lease_lost/);
  assert.match(body(), /restored/);
  assert.equal(db.prepare("SELECT holder FROM lease WHERE name='projector'").get()?.holder, "foreign-owner");
});

test("W1-T9937 criterion 3: unclassified SQLite failures retain their original outcome", t => {
  const db = openReadModel({ stateDir: state(t), instance: "core", schemaVersion: 1 });
  const native = new DatabaseSync(":memory:");
  closeAfter(t, () => { db.close(); native.close(); });
  for (const sql of ["SELECT FROM", "SELECT * FROM absent_table"]) {
    const original = failure(() => native.prepare(sql)), actual = failure(() => db.prepare(sql));
    assert.deepEqual({ message: actual.message, code: actual.code, errcode: actual.errcode }, { message: original.message, code: original.code, errcode: original.errcode });
    assert.equal(actual.message.includes("[operation="), false);
  }
  db.exec("BEGIN"); assert.equal(db.inTransaction(), true); db.exec("ROLLBACK");
  db.exec("BEGIN IMMEDIATE"); db.exec("COMMIT");
  assert.equal(db.inTransaction(), false);
});
