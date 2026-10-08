import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { acquireLease, attachReadModel, openReadModel, READ_MODEL_BUSY_TIMEOUT_MS, readModelPath, withWriteTransaction } from "../src/lib/read-model-db.js";
import { makeTempDir } from "../src/lib/tmp.js";

test("W1-T5177: a reader connection never reports a lock while the projector writes", (t) => {
  const stateDir = makeTempDir("read-model-readers");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const writer = openReadModel({ stateDir, instance: "core", schemaVersion: 1,
    ddl: "CREATE TABLE item(id INTEGER PRIMARY KEY); INSERT INTO item VALUES(1), (2);" });
  t.after(() => writer.close());
  const reader = attachReadModel(writer.path, 1);
  t.after(() => reader.close());
  assert.equal(reader.prepare("PRAGMA busy_timeout").get()?.timeout, READ_MODEL_BUSY_TIMEOUT_MS);

  const rows = reader.prepare("SELECT id FROM item ORDER BY id").iterate()[Symbol.iterator]();
  assert.equal(rows.next().value?.id, 1);
  try {
    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("INSERT INTO item VALUES(3)").run();
    assert.equal(reader.prepare("SELECT count(*) AS n FROM item").get()?.n, 2);
    writer.exec("COMMIT");
    // An active iterator must live on the read connection, away from this connection's checkpoint.
    assert.doesNotThrow(() => reader.prepare("PRAGMA wal_checkpoint(PASSIVE)").all());
    assert.equal(rows.next().value?.id, 2);
  } finally {
    rows.return?.();
    if (writer.inTransaction()) writer.exec("ROLLBACK");
  }
  assert.equal(reader.prepare("SELECT count(*) AS n FROM item").get()?.n, 3);
});

test("a consistency read snapshot stays pinned beside fenced writes", (t) => {
  const stateDir = makeTempDir("read-model-snapshot");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const db = openReadModel({ stateDir, instance: "core", schemaVersion: 1 });
  t.after(() => db.close());
  const got = acquireLease(db);
  assert.ok(got.ok);
  db.exec("INSERT INTO meta VALUES('value', 'old')");
  const select = db.prepare("SELECT v FROM meta WHERE k = ?");
  db.exec("BEGIN");
  assert.equal(db.inTransaction(), true);
  assert.equal(db.prepare("PRAGMA busy_timeout").get()?.timeout, READ_MODEL_BUSY_TIMEOUT_MS);
  assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  assert.equal(select.get("value")?.v, "old");
  assert.throws(() => db.prepare("UPDATE meta SET v = 'unfenced' WHERE k = 'value'").run(), /readonly/);
  assert.throws(() => db.exec("UPDATE meta SET v = 'unfenced' WHERE k = 'value'"), /readonly/);
  withWriteTransaction(db, got.lease, () => {
    db.prepare("UPDATE meta SET v = 'new' WHERE k = 'value'").run();
    assert.equal(select.get("value")?.v, "new", "writes read their own uncommitted state");
    assert.equal(db.meta("value"), "new");
  });
  assert.equal(select.get("value")?.v, "old", "the reader's transaction was not committed with the write");
  db.exec("COMMIT");
  assert.equal(db.inTransaction(), false);
  assert.equal(select.get("value")?.v, "new");
  db.exec("BEGIN DEFERRED");
  assert.equal(db.meta("value"), "new");
  db.exec("ROLLBACK");
  assert.equal(db.inTransaction(), false);
});

test("cached read statements preserve bigint values and report iteration errors", (t) => {
  const stateDir = makeTempDir("read-model-reader-statements");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const db = openReadModel({ stateDir, instance: "core", schemaVersion: 1,
    ddl: "CREATE TABLE item(n INTEGER); INSERT INTO item VALUES(9007199254740993);" });
  t.after(() => db.close());
  const select = db.prepare("SELECT n FROM item", { bigInts: true });
  assert.equal(select.get()?.n, 9007199254740993n);
  assert.equal(select.all()[0]?.n, 9007199254740993n);
  assert.deepEqual([...select.iterate()].map((row) => row.n), [9007199254740993n]);
  db.exec("BEGIN IMMEDIATE");
  assert.equal(select.get()?.n, 9007199254740993n);
  assert.deepEqual([...select.iterate()].map((row) => row.n), [9007199254740993n]);
  db.exec("ROLLBACK");
  assert.equal(select.get()?.n, 9007199254740993n);
  assert.throws(() => db.prepare("SELECT n FROM item").iterate(1)[Symbol.iterator]().next(), /column index out of range/);
  assert.throws(() => db.prepare("not sql"), /syntax error/);
});

test("remaining write locks identify the connection without changing SQLite's result code", (t) => {
  const stateDir = makeTempDir("read-model-lock-identity");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const writer = openReadModel({ stateDir, instance: "core", schemaVersion: 1 });
  t.after(() => writer.close());
  const contender = attachReadModel(writer.path, 1);
  t.after(() => contender.close());
  contender.exec("PRAGMA busy_timeout=0");
  writer.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() => contender.exec("BEGIN IMMEDIATE"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { errcode: number }).errcode, 5);
      assert.match(error.message, /database is locked \[read-model connection=\d+:\d+:[a-f0-9-]+\/writer path=/);
      assert.ok(error.message.includes(writer.path));
      return true;
    });
    assert.equal(contender.meta("schema_version"), "1");
  } finally {
    writer.exec("ROLLBACK");
  }
});

test("a remaining reader lock carries reader identity into the existing error message", (t) => {
  const stateDir = makeTempDir("read-model-reader-lock");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const initialized = openReadModel({ stateDir, instance: "core", schemaVersion: 1 });
  initialized.close();
  const path = readModelPath(stateDir, "core", 1);
  const blocker = new DatabaseSync(path);
  t.after(() => blocker.close());
  blocker.exec("PRAGMA journal_mode=DELETE");
  const reader = openReadModel({ stateDir, instance: "core", schemaVersion: 1, readOnly: true });
  t.after(() => reader.close());
  reader.exec("PRAGMA busy_timeout=0");
  const select = reader.prepare("SELECT v FROM meta WHERE k = 'schema_version'");
  blocker.exec("BEGIN EXCLUSIVE");
  try {
    assert.throws(() => select.get(), /database is locked \[read-model connection=\d+:\d+:[a-f0-9-]+\/reader path=/);
    assert.throws(() => select.iterate()[Symbol.iterator]().next(), /database is locked.*\/reader path=/);
  } finally {
    blocker.exec("ROLLBACK");
  }
  assert.equal(select.get()?.v, "1");
});
