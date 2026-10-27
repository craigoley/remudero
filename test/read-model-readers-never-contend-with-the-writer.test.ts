import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import {
  READ_MODEL_BUSY_TIMEOUT_MS,
  acquireLease,
  attachReadModel,
  flushReadModelTransactions,
  openReadModel,
  openScratchReadModel,
  withWriteTransaction,
} from "#src/lib/read-model-db.js";
import { makeTempDir } from "#src/lib/tmp.js";

function fixture(t: TestContext, prefix: string) {
  const stateDir = makeTempDir(prefix);
  const closers: Array<() => unknown> = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await flushReadModelTransactions();
    rmSync(stateDir, { recursive: true, force: true });
  });
  return { stateDir, closeAfter: (close: () => unknown) => { closers.push(close); } };
}

test("W1-T5177: a reader connection never reports a lock while the projector writes", (t) => {
  const { stateDir, closeAfter } = fixture(t, "read-model-readers");
  const projector = openReadModel({ stateDir, instance: "core", schemaVersion: 1,
    ddl: "CREATE TABLE item(id INTEGER PRIMARY KEY, value INTEGER); INSERT INTO item VALUES(1, 10), (2, 20);" });
  const materializer = attachReadModel(projector.path, 1);
  const oracle = attachReadModel(projector.path, 1);
  materializer.exec("CREATE TEMP TABLE local_item(value INTEGER)");
  closeAfter(() => { oracle.close(); materializer.close(); projector.close(); });
  const acquired = acquireLease(projector);
  assert.equal(acquired.ok, true);
  if (!acquired.ok) throw new Error("the fixture must own the projector lease");

  const cursor = materializer.prepare("SELECT value FROM item ORDER BY id").iterate()[Symbol.iterator]();
  closeAfter(() => cursor.return?.());
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
  const { stateDir, closeAfter } = fixture(t, "read-model-temp-reads");
  const db = openReadModel({ stateDir, instance: "core", schemaVersion: 1,
    ddl: "CREATE TABLE item(value INTEGER); INSERT INTO item VALUES(9007199254740993);" });
  closeAfter(() => db.close());
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
  const { stateDir, closeAfter } = fixture(t, "read-model-temp-shadow");
  const db = openReadModel({ stateDir, instance: "core", schemaVersion: 1,
    ddl: "CREATE TABLE item(value INTEGER); INSERT INTO item VALUES(10);" });
  closeAfter(() => db.close());
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
  const { stateDir, closeAfter } = fixture(t, "read-model-read-only");
  const db = openReadModel({ stateDir, instance: "core", schemaVersion: 1,
    ddl: "CREATE TABLE item(value INTEGER); INSERT INTO item VALUES(9007199254740993);" });
  closeAfter(() => db.close());
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
  const { stateDir, closeAfter } = fixture(t, "read-model-lock-identity");
  const projector = openReadModel({ stateDir, instance: "core", schemaVersion: 1 });
  const attached = attachReadModel(projector.path, 1);
  closeAfter(() => { attached.close(); projector.close(); });
  attached.exec("PRAGMA busy_timeout=0");
  projector.exec("BEGIN IMMEDIATE");
  try {
    const errors: Error[] = [];
    for (const [operation, write] of [["exec.begin-immediate", () => attached.exec("BEGIN IMMEDIATE")],
      ["run", () => attached.prepare("UPDATE meta SET v = v").run()]] as const) {
      assert.throws(write, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { errcode: number }).errcode, 5);
        assert.match(error.message, /database is locked \[connection=[^ ]+\/writer pid=\d+ thread=\d+ path=/);
        assert.ok(error.message.endsWith(`${projector.path}] [operation=${operation}]`));
        errors.push(error);
        return true;
      });
    }
    const identity = (error: Error) => error.message.replace(/ \[operation=[^\]]+\]$/, "");
    assert.equal(identity(errors[0]), identity(errors[1]), "both operations name the same writer connection");
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
  const { stateDir, closeAfter } = fixture(t, "read-model-non-wal-lock");
  const seeded = openReadModel({ stateDir, instance: "core", schemaVersion: 1 });
  const path = seeded.path;
  seeded.close();
  const writer = new DatabaseSync(path);
  writer.exec("PRAGMA journal_mode=DELETE");
  const reader = openReadModel({ stateDir, instance: "core", schemaVersion: 1, readOnly: true });
  closeAfter(() => { reader.close(); writer.close(); });
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

test("read-model fixture teardown closes resources before removing its directory", async (t) => {
  const closed: string[] = [];
  let directory = "";
  await t.test("real SQLite resources close in reverse order", (inner) => {
    const { stateDir, closeAfter } = fixture(inner, "read-model-fixture-lifecycle");
    directory = stateDir;
    const db = openReadModel({ stateDir, instance: "core", schemaVersion: 1,
      ddl: "CREATE TABLE item(value INTEGER); INSERT INTO item VALUES(1), (2);" });
    closeAfter(() => {
      assert.equal(existsSync(stateDir), true, "state exists while its connection closes");
      db.close();
      closed.push("connection");
    });
    db.exec("BEGIN IMMEDIATE"); db.exec("COMMIT");
    const cursor = db.prepare("SELECT value FROM item").iterate()[Symbol.iterator]();
    assert.equal(cursor.next().value?.value, 1, "real database and active cursor positive control");
    closeAfter(async () => {
      await Promise.resolve();
      assert.equal(existsSync(stateDir), true, "state exists while its cursor closes");
      cursor.return?.();
      closed.push("cursor");
    });
  });
  assert.deepEqual(closed, ["cursor", "connection"]);
  assert.equal(existsSync(directory), false, "private fixture removal completed");
});
