import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  READ_MODEL_BUSY_TIMEOUT_MS,
  acquireLease,
  attachReadModel,
  openReadModel,
  openScratchReadModel,
  withWriteTransaction,
} from "../src/lib/read-model-db.js";
import { makeTempDir } from "../src/lib/tmp.js";

test("W1-T5177: a reader connection never reports a lock while the projector writes", (t) => {
  const stateDir = makeTempDir("read-model-readers");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const projector = openReadModel({ stateDir, instance: "core", schemaVersion: 1,
    ddl: "CREATE TABLE item(id INTEGER PRIMARY KEY, value INTEGER); INSERT INTO item VALUES(1, 10), (2, 20);" });
  const materializer = attachReadModel(projector.path, 1);
  const oracle = attachReadModel(projector.path, 1);
  materializer.exec("CREATE TEMP TABLE local_item(value INTEGER)");
  t.after(() => { oracle.close(); materializer.close(); projector.close(); });
  const acquired = acquireLease(projector);
  assert.equal(acquired.ok, true);
  if (!acquired.ok) throw new Error("the fixture must own the projector lease");

  const cursor = materializer.prepare("SELECT value FROM item ORDER BY id").iterate()[Symbol.iterator]();
  t.after(() => cursor.return?.());
  assert.equal(cursor.next().value?.value, 10);
  oracle.exec("BEGIN");
  assert.equal(oracle.prepare("SELECT value FROM item WHERE id = 1").get()?.value, 10);
  withWriteTransaction(projector, acquired.lease, () => {
    projector.prepare("UPDATE item SET value = 11 WHERE id = 1").run();
    assert.equal(materializer.prepare("SELECT value FROM item WHERE id = 1").get()?.value, 10);
    assert.equal(oracle.prepare("SELECT value FROM item WHERE id = 1").get()?.value, 10);
  });

  // Persisting a body must not upgrade the materializer's stale read snapshot into a writer.
  withWriteTransaction(materializer, acquired.lease, () => {
    materializer.prepare("UPDATE item SET value = 21 WHERE id = 2").run();
    assert.equal(materializer.prepare("SELECT value FROM item WHERE id = 2").get()?.value, 21);
  });
  assert.equal(cursor.next().value?.value, 20);
  assert.equal(cursor.next().done, true);
  assert.equal(oracle.prepare("SELECT value FROM item WHERE id = 1").get()?.value, 10);
  oracle.exec("COMMIT");
  assert.deepEqual(oracle.prepare("SELECT value FROM item ORDER BY id").all().map((row) => row.value), [11, 21]);
  assert.equal(oracle.prepare("PRAGMA busy_timeout").get()?.timeout, READ_MODEL_BUSY_TIMEOUT_MS);
  assert.equal(materializer.prepare("PRAGMA busy_timeout").get()?.timeout, READ_MODEL_BUSY_TIMEOUT_MS);
});

test("temp tables and views retain their connection-local rows without pinning ordinary reads", (t) => {
  const stateDir = makeTempDir("read-model-temp-reads");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const db = openReadModel({ stateDir, instance: "core", schemaVersion: 1,
    ddl: "CREATE TABLE item(value INTEGER); INSERT INTO item VALUES(9007199254740993);" });
  t.after(() => db.close());
  db.exec(`CREATE TEMP TABLE wrote(value INTEGER);
    CREATE TEMP TRIGGER record_update AFTER UPDATE ON item BEGIN INSERT INTO wrote VALUES(new.value); END;
    CREATE TEMP VIEW write_count AS SELECT count(*) AS n FROM wrote;`);
  db.prepare("UPDATE item SET value = value").run();
  assert.deepEqual(db.prepare("SELECT value FROM wrote", { bigInts: true }).all().map((r) => r.value),
    [9007199254740993n]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM temp.wrote").get()?.n, 1);
  assert.ok(db.prepare("EXPLAIN SELECT value FROM wrote").all().length > 0);
  assert.equal(db.prepare("SELECT n FROM write_count").get()?.n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM item JOIN wrote").get()?.n, 1);
  assert.deepEqual([...db.prepare("SELECT value FROM wrote", { bigInts: true }).iterate()].map((r) => r.value),
    [9007199254740993n]);
  db.exec("DELETE FROM wrote");
  assert.equal(db.prepare("SELECT count(*) AS n FROM wrote").get()?.n, 0);
  assert.throws(() => db.prepare("UPDATE item SET value = 0 RETURNING value").get(),
    (error: unknown) => (error as { errcode: number }).errcode === 8);
});

test("cached reads follow temp tables that shadow and then reveal persistent tables", (t) => {
  const stateDir = makeTempDir("read-model-temp-shadow");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const db = openReadModel({ stateDir, instance: "core", schemaVersion: 1,
    ddl: "CREATE TABLE item(value INTEGER); INSERT INTO item VALUES(10);" });
  t.after(() => db.close());
  const values = db.prepare("SELECT value FROM item");
  const mainValues = db.prepare("SELECT value FROM main.item");
  assert.equal(values.get()?.value, 10);
  db.exec("CREATE TEMP TABLE item(value INTEGER); INSERT INTO temp.item VALUES(20), (30)");
  assert.equal(values.get()?.value, 20);
  assert.deepEqual(values.all().map((r) => r.value), [20, 30]);
  assert.deepEqual([...values.iterate()].map((r) => r.value), [20, 30]);
  assert.equal(mainValues.get()?.value, 10);
  db.exec("DROP TABLE temp.item");
  assert.equal(values.get()?.value, 10);
});

test("read methods use a read-only connection and cached statements follow write transactions", (t) => {
  const stateDir = makeTempDir("read-model-read-only");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const db = openReadModel({ stateDir, instance: "core", schemaVersion: 1,
    ddl: "CREATE TABLE item(value INTEGER); INSERT INTO item VALUES(9007199254740993);" });
  t.after(() => db.close());
  const values = db.prepare("SELECT value FROM item", { bigInts: true });
  assert.deepEqual(values.all().map((row) => row.value), [9007199254740993n]);
  assert.throws(() => db.prepare("UPDATE item SET value = 0 RETURNING value").get(),
    (error: unknown) => (error as { errcode: number }).errcode === 8);
  assert.throws(() => db.prepare("SELECT * FROM absent"), /no such table/);
  const acquired = acquireLease(db);
  assert.equal(acquired.ok, true);
  if (!acquired.ok) throw new Error("the fixture must own the projector lease");
  assert.throws(() => withWriteTransaction(db, acquired.lease, () => {
    db.prepare("UPDATE item SET value = 7").run();
    assert.equal(values.get()?.value, 7n);
    assert.deepEqual([...values.iterate()].map((row) => row.value), [7n]);
    throw new Error("roll back");
  }), /roll back/);
  assert.equal(values.get()?.value, 9007199254740993n);
  assert.equal(db.inTransaction(), false);
  db.exec("BEGIN DEFERRED TRANSACTION;");
  assert.equal(db.inTransaction(), true);
  assert.equal(values.get()?.value, 9007199254740993n);
  db.exec("ROLLBACK TRANSACTION");
  assert.equal(db.inTransaction(), false);
});

test("remaining writer locks identify the connection without changing the sqlite error", (t) => {
  const stateDir = makeTempDir("read-model-lock-identity");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const projector = openReadModel({ stateDir, instance: "core", schemaVersion: 1 });
  const attached = attachReadModel(projector.path, 1);
  t.after(() => { attached.close(); projector.close(); });
  attached.exec("PRAGMA busy_timeout=0");
  projector.exec("BEGIN IMMEDIATE");
  try {
    const errors: Error[] = [];
    for (const write of [() => attached.exec("BEGIN IMMEDIATE"),
      () => attached.prepare("UPDATE meta SET v = v").run()]) {
      assert.throws(write, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { errcode: number }).errcode, 5);
        assert.match(error.message, /database is locked \[connection=[^ ]+\/writer pid=\d+ thread=\d+ path=/);
        assert.ok(error.message.endsWith(`${projector.path}]`));
        errors.push(error);
        return true;
      });
    }
    assert.equal(errors[0].message, errors[1].message, "both operations name the same writer connection");
  } finally {
    projector.exec("ROLLBACK");
  }
  attached.prepare("UPDATE meta SET v = v").run();
});

test("scratch read models retain one connection for their in-memory tables", () => {
  const scratch = openScratchReadModel();
  try {
    scratch.exec("CREATE TABLE item(value INTEGER); INSERT INTO item VALUES(42)");
    assert.equal(scratch.prepare("SELECT value FROM item").get()?.value, 42);
    scratch.exec("BEGIN");
    scratch.prepare("UPDATE item SET value = 43").run();
    scratch.exec("COMMIT");
    assert.equal(scratch.prepare("SELECT value FROM item").get()?.value, 43);
  } finally {
    scratch.close();
  }
});

test("a remaining lock on an unhealthy non-WAL store identifies reads and connection opens", (t) => {
  const stateDir = makeTempDir("read-model-non-wal-lock");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const seeded = openReadModel({ stateDir, instance: "core", schemaVersion: 1 });
  const path = seeded.path;
  seeded.close();
  const writer = new DatabaseSync(path);
  writer.exec("PRAGMA journal_mode=DELETE");
  const reader = openReadModel({ stateDir, instance: "core", schemaVersion: 1, readOnly: true });
  t.after(() => { reader.close(); writer.close(); });
  reader.exec("PRAGMA busy_timeout=0");
  writer.exec("BEGIN EXCLUSIVE");
  try {
    assert.throws(() => reader.prepare("SELECT v FROM meta").all(), /database is locked \[connection=[^ ]+\/reader /);
    assert.throws(() => openReadModel({ stateDir, instance: "core", schemaVersion: 1 }),
      /database is locked \[connection=[^ ]+\/writer /);
  } finally {
    writer.exec("ROLLBACK");
  }
  assert.equal(reader.meta("schema_version"), "1");
});
