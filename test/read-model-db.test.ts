import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock, type Clock } from "../src/lib/clock.js";
import {
  READ_MODEL_BUSY_TIMEOUT_MS,
  READ_MODEL_DIRNAME,
  READ_MODEL_JOURNAL_SIZE_LIMIT_BYTES,
  ReadModelError,
  acquireLease,
  currentReadModelPath,
  openReadModel,
  peekLease,
  publishReadModelGeneration,
  readModelGenerationPath,
  readModelPath,
  readModelPointerPath,
  releaseLease,
  withWriteTransaction,
} from "../src/lib/read-model-db.js";
import { makeTempDir } from "../src/lib/tmp.js";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
const DDL = "CREATE TABLE IF NOT EXISTS item(id INTEGER PRIMARY KEY, label TEXT);";

function stateDir(t: { after: (fn: () => void) => void }): string {
  const dir = makeTempDir("read-model-db");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function steppingClock(start: number): Clock & { advance: (ms: number) => void } {
  let now = start;
  return { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString(), advance: (ms) => void (now += ms) };
}

function labels(dir: string): string[] {
  const reader = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1, readOnly: true });
  try {
    return reader.prepare("SELECT label FROM item ORDER BY id").all().map((row) => String(row.label));
  } finally {
    reader.close();
  }
}

test("the read model opens in WAL with synchronous NORMAL a five second busy timeout and a bounded journal", (t) => {
  const dir = stateDir(t);
  const db = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1, ddl: DDL });
  t.after(() => db.close());
  assert.equal(db.path, join(dir, READ_MODEL_DIRNAME, "core.v1.sqlite"));
  assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  assert.equal(db.prepare("PRAGMA synchronous").get()?.synchronous, 1, "1 is NORMAL");
  assert.equal(db.prepare("PRAGMA busy_timeout").get()?.timeout, READ_MODEL_BUSY_TIMEOUT_MS);
  assert.equal(db.prepare("PRAGMA journal_size_limit").get()?.journal_size_limit, READ_MODEL_JOURNAL_SIZE_LIMIT_BYTES);
  assert.equal(db.meta("schema_version"), "1");
  assert.equal(db.meta("absent"), undefined);
});

test("each instance gets its own read-model file and an unsafe instance name is refused", (t) => {
  const dir = stateDir(t);
  const core = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 3 });
  const site = openReadModel({ stateDir: dir, instance: "site", schemaVersion: 3 });
  core.close();
  site.close();
  assert.deepEqual(readdirSync(join(dir, READ_MODEL_DIRNAME)).filter((n) => n.endsWith(".sqlite")).sort(), ["core.v3.sqlite", "site.v3.sqlite"]);
  assert.throws(() => readModelPath(dir, "../core", 3), (e: unknown) => e instanceof ReadModelError && e.reason === "bad_instance");
});

test("a schema version mismatch opens a new file and leaves the old one readable", (t) => {
  const dir = stateDir(t);
  const v1 = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1, ddl: DDL });
  v1.prepare("INSERT INTO item(label) VALUES(?)").run("from v1");
  v1.close();

  const v2 = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 2, ddl: DDL });
  assert.equal(v2.prepare("SELECT count(*) AS n FROM item").get()?.n, 0, "v2 starts empty beside v1");
  v2.close();
  assert.deepEqual(labels(dir), ["from v1"], "the v1 file still answers reads");

  const mislabelled = readModelPath(dir, "core", 5);
  copyFileSync(readModelPath(dir, "core", 1), mislabelled);
  assert.throws(
    () => openReadModel({ stateDir: dir, instance: "core", schemaVersion: 5 }),
    (e: unknown) => e instanceof ReadModelError && e.reason === "schema_mismatch",
    "a file whose meta disagrees with its name is refused, never silently reused",
  );
});

test("a corrupt read-model file is renamed aside and reopened empty", (t) => {
  const dir = stateDir(t);
  const clock = fixedClock(T0);
  const path = readModelPath(dir, "core", 1);
  const first = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1, ddl: DDL });
  first.prepare("INSERT INTO item(label) VALUES('kept aside')").run();
  first.close();
  writeFileSync(path, Buffer.from("this is not a sqlite database ".repeat(200)));

  const db = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1, ddl: DDL, clock });
  t.after(() => db.close());
  assert.equal(db.recoveredFrom?.corruptPath, `${path}.corrupt-${T0}`);
  assert.match(db.recoveredFrom?.reason ?? "", /not a database/);
  assert.ok(existsSync(`${path}.corrupt-${T0}`), "the damaged file is kept for forensics, never deleted");
  assert.equal(db.prepare("SELECT count(*) AS n FROM item").get()?.n, 0);
  assert.equal(db.meta("schema_version"), "1");
});

test("an open failure that is not corruption is thrown instead of discarding the file", (t) => {
  const dir = stateDir(t);
  writeFileSync(join(dir, READ_MODEL_DIRNAME), "a file where the directory should be");
  assert.throws(() => openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1 }), /EEXIST|ENOTDIR/);
  rmSync(join(dir, READ_MODEL_DIRNAME));
  assert.throws(() => openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1, readOnly: true }), /unable to open/);
});

test("a second writer cannot commit while another holds the projector lease", (t) => {
  const dir = stateDir(t);
  const clock = steppingClock(T0);
  const a = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1, ddl: DDL });
  const b = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1, ddl: DDL });
  t.after(() => { a.close(); b.close(); });

  const heldByA = acquireLease(a, { holder: "writer-a", clock });
  assert.equal(heldByA.ok, true);
  const refused = acquireLease(b, { holder: "writer-b", clock });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.heldBy, "writer-a");
  assert.equal(refused.ok === false && refused.pid, process.pid);

  const forged = { name: "projector", holder: "writer-b", ttlMs: 20_000, clock };
  assert.throws(
    () => withWriteTransaction(b, forged, () => b.prepare("INSERT INTO item(label) VALUES('from b')").run()),
    (e: unknown) => e instanceof ReadModelError && e.reason === "lease_lost",
  );
  if (!heldByA.ok) throw new Error("unreachable: writer-a holds the lease");
  withWriteTransaction(a, heldByA.lease, () => a.prepare("INSERT INTO item(label) VALUES('from a')").run());
  assert.deepEqual(labels(dir), ["from a"], "only the lease holder's write committed");
});

test("an expired lease passes to the next holder and the old holder's next transaction rolls back", (t) => {
  const dir = stateDir(t);
  const clock = steppingClock(T0);
  const a = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1, ddl: DDL });
  const b = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1, ddl: DDL });
  t.after(() => { a.close(); b.close(); });
  const leaseA = acquireLease(a, { holder: "writer-a", ttlMs: 1_000, clock });
  if (!leaseA.ok) throw new Error("writer-a should take a free lease");

  clock.advance(999);
  assert.equal(acquireLease(b, { holder: "writer-b", clock }).ok, false, "a live lease is not taken");
  clock.advance(2);
  const leaseB = acquireLease(b, { holder: "writer-b", clock });
  assert.equal(leaseB.ok, true, "an expired lease is taken over");

  assert.throws(
    () => withWriteTransaction(a, leaseA.lease, () => a.prepare("INSERT INTO item(label) VALUES('stale a')").run()),
    (e: unknown) => e instanceof ReadModelError && e.reason === "lease_lost",
  );
  assert.equal(a.inTransaction(), false, "the fenced transaction rolled back");
  assert.deepEqual(labels(dir), []);
});

test("a released lease is taken at once and a renewal keeps the original acquisition time", (t) => {
  const dir = stateDir(t);
  const clock = steppingClock(T0);
  const a = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1 });
  const b = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1 });
  t.after(() => { a.close(); b.close(); });
  const leaseA = acquireLease(a, { holder: "writer-a", clock });
  if (!leaseA.ok) throw new Error("writer-a should take a free lease");
  clock.advance(5_000);
  assert.equal(acquireLease(a, { holder: "writer-a", clock }).ok, true, "the holder renews its own lease");
  const row = a.prepare("SELECT acquired_ms, expires_ms FROM lease").get();
  assert.deepEqual([row?.acquired_ms, row?.expires_ms], [T0, T0 + 5_000 + 20_000]);

  assert.equal(releaseLease(a, leaseA.lease), true);
  assert.equal(releaseLease(a, leaseA.lease), false, "a lease is released once");
  assert.equal(acquireLease(b, { holder: "writer-b", clock }).ok, true);
});

test("a write transaction that throws rolls back its rows", (t) => {
  const dir = stateDir(t);
  const db = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1, ddl: DDL });
  t.after(() => db.close());
  const lease = acquireLease(db, { clock: fixedClock(T0) });
  if (!lease.ok) throw new Error("a free lease");
  assert.throws(() =>
    withWriteTransaction(db, lease.lease, () => {
      db.prepare("INSERT INTO item(label) VALUES('half written')").run();
      throw new Error("the projector failed mid-transaction");
    }), /mid-transaction/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM item").get()?.n, 0);
  const big = db.prepare("SELECT 9007199254740993 AS h", { bigInts: true }).get();
  assert.equal(big?.h, 9007199254740993n, "64-bit identity hashes read back exactly");
  assert.equal([...db.prepare("SELECT 1 AS one").iterate()].length, 1);
});

test("a pointer names the generation every open resolves and a foreign pointer is refused", (t) => {
  const dir = makeTempDir("read-model-pointer");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1, ddl: DDL });
  base.close();
  assert.equal(currentReadModelPath(dir, "core", 1), readModelPath(dir, "core", 1), "no pointer: the un-generationed file");
  const gen = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1, ddl: DDL, generation: "42" });
  assert.equal(gen.path, readModelGenerationPath(dir, "core", 1, "42"));
  assert.equal(peekLease(gen.path), undefined);
  assert.ok(acquireLease(gen, { holder: "h" }).ok);
  assert.equal(peekLease(gen.path)?.holder, "h");
  gen.close();
  publishReadModelGeneration(dir, "core", 1, "42");
  assert.equal(readFileSync(readModelPointerPath(dir, "core", 1), "utf8"), "core.v1.g42.sqlite\n");
  const current = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1 });
  assert.equal(current.path, gen.path);
  current.close();
  const legacy = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1, generation: null });
  assert.equal(legacy.path, readModelPath(dir, "core", 1));
  legacy.close();
  assert.throws(() => readModelGenerationPath(dir, "core", 1, "../x"), (e: unknown) => e instanceof ReadModelError && e.reason === "bad_pointer");
  writeFileSync(readModelPointerPath(dir, "core", 1), "site.v1.g42.sqlite\n");
  assert.throws(() => openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1 }), (e: unknown) => e instanceof ReadModelError && e.reason === "bad_pointer");
});

test("a pointer generation is parsed against the exact instance and schema prefix", (t) => {
  const dir = makeTempDir("read-model-dotted-instance-pointer");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, READ_MODEL_DIRNAME), { recursive: true });
  writeFileSync(readModelPointerPath(dir, "core.prod", 1), "core.prod.v1.g42.sqlite\n");
  assert.equal(currentReadModelPath(dir, "core.prod", 1), readModelGenerationPath(dir, "core.prod", 1, "42"));
  writeFileSync(readModelPointerPath(dir, "core.prod", 1), "coreXprod.v1.g42.sqlite\n");
  assert.throws(
    () => currentReadModelPath(dir, "core.prod", 1),
    (error: unknown) => error instanceof ReadModelError && error.reason === "bad_pointer",
  );
});
