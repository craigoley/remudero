import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import * as adapter from "#src/lib/read-model-db.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { createReadModelTicker, READ_MODEL_STALL_MS, type ReadModelWorkerMessage } from "#src/lib/read-model-worker.js";
import type { Clock } from "#src/lib/clock.js";

function fixture(t: TestContext, label = "fixture writer") {
  const dir = makeTempDir("transaction-observation");
  const db = adapter.openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1, ddl: "CREATE TABLE value(n INTEGER);", transactionObservation: { label } });
  const closers: Array<() => void | Promise<void>> = [];
  t.after(async () => { for (const close of closers.reverse()) await close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, closers };
}

test("W1-T9501: a locked write names the connection holding the lock", { timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  const childFile = join(f.dir, "holder.mjs");
  const module = pathToFileURL(join(process.cwd(), "src/lib/read-model-db.ts")).href;
  writeFileSync(childFile, `import { openReadModel } from ${JSON.stringify(module)};
const db=openReadModel({stateDir:process.argv[2],instance:'core',schemaVersion:1,transactionObservation:{label:'child-held-write'}});
db.exec('BEGIN IMMEDIATE'); process.send({ready:true});
process.on('message',()=>{db.exec('ROLLBACK');db.close();process.disconnect()});
`);
  const child = fork(childFile, [f.dir], { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  f.closers.push(async () => {
    if (child.exitCode !== null) return;
    const exit = new Promise<void>(resolve => child.once("exit", () => resolve()));
    if (child.connected) child.send("release");
    await exit;
  });
  await new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); child.once("exit", code => code && reject(Error(`child exited ${code}`))); });
  f.db.exec("PRAGMA busy_timeout=1");
  let failure: Error | undefined;
  try { f.db.exec("BEGIN IMMEDIATE"); } catch (e) { failure = e as Error; }
  assert.ok(failure);
  const observations = (failure as Error & { readModelTransactions: adapter.ReadModelTransactionInventory }).readModelTransactions;
  assert.ok(observations.complete);
  const acquired = observations.records.find(r => r.recordedState === "recorded-acquired");
  assert.equal(acquired?.label, "child-held-write");
  assert.equal(acquired?.pid, child.pid);
  assert.equal(acquired?.lockOwnership, "unverified");
  if (process.platform === "linux") assert.equal(acquired?.state, "recorded-acquired", "the real child's default Linux identity is verified");
  const waiting = observations.records.find(r => r.recordedState === "attempting" && r.pid === process.pid);
  assert.ok(waiting);
  assert.equal(waiting.acquiredAt, undefined, "a failed BEGIN is never promoted to acquired");
  assert.notEqual(waiting.connection, acquired?.connection);
  assert.match(failure.message, /operation=exec.begin-immediate/);
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.send("release"); await exited;
  assert.ok(!adapter.readReadModelTransactions(f.db.path).records.some(r => r.pid === child.pid), "successful release retires only the child's record");
  f.db.exec("BEGIN IMMEDIATE"); f.db.exec("COMMIT");
  assert.equal(adapter.readReadModelTransactions(f.db.path).state, "none-recorded");
});

test("W1-T9501: a stall escalation names the oldest lock holder", { timeout: 50_000 }, (t) => {
  const f = fixture(t, "oldest recorded transaction");
  writeFileSync(join(f.dir, "ledger.ndjson"), "");
  let now = Date.now();
  const clock: Clock = { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() };
  const logs: Array<Extract<ReadModelWorkerMessage, { type: "log" }>> = [];
  const details: string[] = [];
  const ticker = createReadModelTicker({ stateDir: f.dir, instances: [{ name: "core", ledgerDir: f.dir }],
    views: [], oracle: "off", clock,
    post: message => { if (message.type === "log") logs.push(message); },
    escalation: { runId: "test", ledgerPath: join(f.dir, "escalations.ndjson"), issues: {
      create: (_title, body) => { details.push(body); return "https://github.com/craigoley/remudero/issues/1"; },
    } },
  });
  f.closers.push(() => { ticker.release(); });
  f.db.exec("BEGIN IMMEDIATE");
  ticker.start(); ticker.tick();
  for (let n = 0; n < 3; n++) { now += READ_MODEL_STALL_MS + 1; ticker.tick(); }
  for (const step of ["read_model.stalled", "read_model.stall_escalated"]) {
    const row = logs.find(log => log.step === step);
    assert.ok(row, step);
    const observations = row.extra.transactions as adapter.ReadModelTransactionInventory;
    assert.equal(observations.records[0]?.label, "oldest recorded transaction");
    assert.equal(observations.records[0]?.recordedState, "recorded-acquired");
    assert.equal(observations.records[0]?.lockOwnership, "unverified");
    assert.ok("recordAgeMs" in observations.records[0]!);
    assert.equal("heldMs" in observations.records[0]!, false);
    if (step === "read_model.stall_escalated") assert.ok(details[0]?.includes(JSON.stringify(observations)), "the issue and ledger carry the same observation");
  }
  assert.equal(details.length, 1);
  assert.match(details[0]!, /oldest recorded transaction/);
  assert.match(details[0]!, /lock ownership unverified/);
  f.db.exec("ROLLBACK");
});

test("failed COMMIT retains the acquired record and successful ROLLBACK retires it", (t) => {
  const f = fixture(t);
  // A failed COMMIT with a deferred foreign-key violation keeps a genuine transaction open.
  f.db.exec("PRAGMA foreign_keys=ON");
  f.db.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)");
  f.db.exec("BEGIN IMMEDIATE"); f.db.prepare("INSERT INTO child VALUES(?)").run(7);
  assert.throws(() => f.db.exec("COMMIT"));
  assert.ok(f.db.inTransaction());
  assert.equal(adapter.readReadModelTransactions(f.db.path).records[0]?.recordedState, "recorded-acquired");
  f.db.exec("ROLLBACK");
  assert.equal(adapter.readReadModelTransactions(f.db.path).state, "none-recorded");
});

test("W1-T9501: a dead or unrecorded holder is named as such", (t) => {
  const f = fixture(t);
  rmSync(adapter.readModelTransactionDir(f.db.path), { recursive: true });
  assert.equal(adapter.readReadModelTransactions(f.db.path).state, "unknown", "missing inventory is not absence evidence");
  const own = { pid: process.pid, bootId: "boot", pidNamespace: "ns", startTicks: "123" };
  const inspect = (pid: number) => pid === own.pid ? { status: "identified" as const, identity: own } : { status: "missing" as const };
  const read = () => adapter.readReadModelTransactions(f.db.path, { processIdentity: inspect });
  const recorder = adapter.createReadModelTransactionRecorder(f.db.path, "identity-cases", { identity: () => own });
  const first = recorder.attempt(); recorder.acquired(first);
  const newer = recorder.attempt(); recorder.acquired(newer); recorder.release(first);
  assert.equal(read().records[0]?.transaction, newer, "late cleanup cannot retire the newer nonce");
  const replacement = adapter.createReadModelTransactionRecorder(f.db.path, "identity-cases", { identity: () => own });
  const replacementNonce = replacement.attempt(); replacement.acquired(replacementNonce); recorder.release(newer);
  assert.equal(read().records[0]?.transaction, replacementNonce, "late cleanup checks the file's nonce too");
  const file = join(adapter.readModelTransactionDir(f.db.path), "identity-cases.json");
  const original = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(read().records[0]?.state, "recorded-acquired");
    const dead = { ...original, identity: { ...own, pid: 2_000_000_000 }, pid: 2_000_000_000 };
    writeFileSync(file, JSON.stringify(dead));
    assert.equal(read().records[0]?.state, "stale");
    writeFileSync(file, JSON.stringify({ ...original, identity: { ...own, startTicks: "different" } }));
    assert.equal(read().records[0]?.state, "unknown");
    writeFileSync(file, JSON.stringify({ ...original, identity: { ...own, pidNamespace: "foreign" } }));
    assert.equal(read().records[0]?.state, "unknown");
  writeFileSync(file, JSON.stringify({ ...original, identity: { ...own, bootId: "foreign-boot" } }));
  assert.equal(read().records[0]?.state, "unknown");
  writeFileSync(file, JSON.stringify(original));
  assert.equal(adapter.readReadModelTransactions(f.db.path, { processIdentity: () => ({ status: "unknown" }) }).records[0]?.state, "unknown");
  assert.equal(adapter.readReadModelTransactions(f.db.path, { processIdentity: () => { throw Error("identity unreadable"); } }).complete, false);
  const realIdentity = adapter.readModelProcessIdentity();
  if (process.platform === "linux") assert.ok(realIdentity, "positive control: default Linux procfs identity is available");
  writeFileSync(file, JSON.stringify({ ...original, identity: realIdentity && { ...realIdentity, pid: 2_000_000_000 }, pid: 2_000_000_000 }));
  assert.equal(adapter.readReadModelTransactions(f.db.path).records[0]?.state, realIdentity ? "stale" : "unknown", "default identity verification never trusts a bare PID");
  writeFileSync(file, "{truncated");
  assert.equal(adapter.readReadModelTransactions(f.db.path).complete, false);
  writeFileSync(file, JSON.stringify(original)); replacement.release(replacementNonce);
  assert.equal(adapter.readReadModelTransactions(f.db.path).state, "none-recorded");
  const reports: string[] = [];
  const broken = adapter.createReadModelTransactionRecorder(f.db.path, "failed-record", { publish: () => { throw Error("unwritable"); }, report: step => reports.push(step) });
  broken.acquired(broken.attempt()); broken.acquired(broken.attempt());
  assert.deepEqual(reports, ["read_model.holder_record_failed"]);
});

test("bounded incomplete inventories and failed cleanup never establish release or no holder", (t) => {
  const f = fixture(t);
  const dir = adapter.readModelTransactionDir(f.db.path);
  const reports: string[] = [];
  const identity = { pid: process.pid, bootId: "boot", pidNamespace: "ns", startTicks: "123" };
  const recorder = adapter.createReadModelTransactionRecorder(f.db.path, "cleanup", {
    identity: () => identity,
    remove: () => { throw Error("unlink denied"); }, report: step => reports.push(step),
  });
  const nonce = recorder.attempt(); recorder.acquired(nonce); recorder.release(nonce);
  const record = adapter.readReadModelTransactions(f.db.path, { processIdentity: () => ({ status: "identified", identity }) }).records[0]!;
  assert.equal(record.recordedState, "released");
  assert.equal(record.state, "unknown");
  assert.equal(record.lockOwnership, "unverified");
  assert.deepEqual(reports, ["read_model.holder_record_failed"]);
  const original = JSON.parse(readFileSync(join(dir, "cleanup.json"), "utf8"));
  for (let n = 0; n < 4; n++) writeFileSync(join(dir, `ordered-${n}.json`), JSON.stringify({ ...original, connection: `ordered-${n}`, recordedState: "recorded-acquired", acquiredAt: n + 1 }));
  const ordered = adapter.readReadModelTransactions(f.db.path);
  assert.equal(ordered.records.length, 3);
  assert.deepEqual(ordered.records.map(r => r.connection), ["ordered-0", "ordered-1", "ordered-2"]);
  writeFileSync(join(dir, "oversize.json"), "x".repeat(5000));
  mkdirSync(join(dir, "not-readable.json"));
  const incomplete = adapter.readReadModelTransactions(f.db.path);
  assert.equal(incomplete.complete, false); assert.equal(incomplete.unknownRecords, 2);
  for (let n = 0; n < 130; n++) writeFileSync(join(dir, `truncated-${n}.json`), "{}");
  const truncated = adapter.readReadModelTransactions(f.db.path);
  assert.equal(truncated.truncated, true); assert.equal(truncated.complete, false);
  assert.ok(truncated.inspected <= 129); assert.ok(truncated.records.length <= 3);
});

test("attached writers and close use the real default recorder without changing SQLite behavior", (t) => {
  const f = fixture(t);
  const attached = adapter.attachReadModel(f.db.path, 1, { label: "attached writer" });
  attached.exec("BEGIN IMMEDIATE");
  assert.equal(adapter.readReadModelTransactions(f.db.path).records[0]?.label, "attached writer");
  attached.close();
  assert.equal(adapter.readReadModelTransactions(f.db.path).state, "none-recorded");
  assert.equal(adapter.readReadModelTransactions(undefined).state, "unknown");
  assert.equal(adapter.readReadModelTransactions(":memory:").state, "unknown");
  const broken = adapter.attachReadModel(f.db.path, 1, { publish: () => { throw Error("read-only sidecar"); }, report: () => { throw Error("log unavailable"); } });
  broken.exec("BEGIN IMMEDIATE"); broken.prepare("INSERT INTO value VALUES(?)").run(9); broken.exec("COMMIT"); broken.close();
  assert.equal(f.db.prepare("SELECT n FROM value").get()?.n, 9);
  rmSync(adapter.readModelTransactionDir(f.db.path), { recursive: true });
  writeFileSync(adapter.readModelTransactionDir(f.db.path), "not a directory");
  const reports: string[] = [];
  const blocked = adapter.attachReadModel(f.db.path, 1, { report: step => reports.push(step) });
  blocked.exec("BEGIN IMMEDIATE"); blocked.exec("COMMIT"); blocked.close();
  assert.deepEqual(reports, ["read_model.holder_record_failed"], "real filesystem failure is advisory and bounded");
});
