import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import fs, { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import threads from "node:worker_threads";
import { buildSync } from "esbuild";
import * as adapter from "#src/lib/read-model-db.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { createReadModelTicker, READ_MODEL_STALL_MS, type ReadModelWorkerMessage } from "#src/lib/read-model-worker.js";
import type { Clock } from "#src/lib/clock.js";

async function fixture(t: TestContext, label = "fixture writer") {
  const dir = makeTempDir("transaction-observation");
  const db = adapter.openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1, ddl: "CREATE TABLE value(n INTEGER);", transactionObservation: { label } });
  const closers: Array<() => void | Promise<void>> = [];
  t.after(async () => { for (const close of closers.reverse()) await close(); db.close(); await adapter.flushReadModelTransactions().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
  await adapter.flushReadModelTransactions();
  return { dir, db, closers };
}

test("W1-T9501: a locked write names the connection holding the lock", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const childFile = join(f.dir, "holder.mjs");
  const module = pathToFileURL(join(process.cwd(), "src/lib/read-model-db.ts")).href;
  writeFileSync(childFile, `import { openReadModel,flushReadModelTransactions } from ${JSON.stringify(module)};
const db=openReadModel({stateDir:process.argv[2],instance:'core',schemaVersion:1,transactionObservation:{label:'child-held-write'}});
db.exec('BEGIN IMMEDIATE'); await flushReadModelTransactions(); process.send({ready:true});
process.on('message',async()=>{db.exec('ROLLBACK');db.close();await flushReadModelTransactions();process.disconnect()});
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
  assert.equal(typeof observations.complete, "boolean");
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
  await adapter.flushReadModelTransactions();
  assert.equal(adapter.readReadModelTransactions(f.db.path).state, "none-recorded");
});

test("W1-T9501: a stall escalation names the oldest lock holder", { timeout: 50_000 }, async (t) => {
  const f = await fixture(t, "oldest recorded transaction");
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

test("failed COMMIT retains the acquired record and successful ROLLBACK retires it", async (t) => {
  const f = await fixture(t);
  // A failed COMMIT with a deferred foreign-key violation keeps a genuine transaction open.
  f.db.exec("PRAGMA foreign_keys=ON");
  f.db.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)");
  f.db.exec("BEGIN IMMEDIATE"); f.db.prepare("INSERT INTO child VALUES(?)").run(7);
  assert.throws(() => f.db.exec("COMMIT"));
  await adapter.flushReadModelTransactions();
  assert.ok(f.db.inTransaction());
  assert.equal(adapter.readReadModelTransactions(f.db.path).records[0]?.recordedState, "recorded-acquired");
  f.db.exec("ROLLBACK");
  await adapter.flushReadModelTransactions();
  assert.equal(adapter.readReadModelTransactions(f.db.path).state, "none-recorded");
});

test("W1-T9501: a dead or unrecorded holder is named as such", async (t) => {
  const f = await fixture(t);
  rmSync(adapter.readModelTransactionDir(f.db.path), { recursive: true });
  assert.equal(adapter.readReadModelTransactions(f.db.path).state, "unknown", "missing inventory is not absence evidence");
  const own = { pid: process.pid, bootId: "boot", pidNamespace: "ns", startTicks: "123" };
  const inspect = (pid: number) => pid === own.pid ? { status: "identified" as const, identity: own } : { status: "missing" as const };
  const read = () => adapter.readReadModelTransactions(f.db.path, { processIdentity: inspect });
  const recorder = adapter.createReadModelTransactionRecorder(f.db.path, "identity-cases", { identity: () => own });
  f.closers.push(() => recorder.close());
  const first = recorder.attempt(); recorder.acquired(first);
  const newer = recorder.attempt(); recorder.acquired(newer); recorder.release(first);
  await adapter.flushReadModelTransactions();
  assert.equal(read().records[0]?.transaction, newer, "late cleanup cannot retire the newer nonce");
  const replacement = adapter.createReadModelTransactionRecorder(f.db.path, "identity-cases", { identity: () => own });
  f.closers.push(() => replacement.close());
  const replacementNonce = replacement.attempt(); replacement.acquired(replacementNonce); await adapter.flushReadModelTransactions(); recorder.release(newer);
  await adapter.flushReadModelTransactions();
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
  writeFileSync(file, JSON.stringify(original)); replacement.release(replacementNonce); replacement.close(); recorder.close();
  await adapter.flushReadModelTransactions();
  assert.equal(adapter.readReadModelTransactions(f.db.path).state, "none-recorded");
  const reports: string[] = [];
  const broken = adapter.createReadModelTransactionRecorder(f.db.path, "failed-record", { publish: () => { throw Error("unwritable"); }, report: step => reports.push(step) });
  broken.acquired(broken.attempt()); broken.acquired(broken.attempt());
  assert.deepEqual(reports, ["read_model.holder_record_failed"]);
});

test("bounded incomplete inventories and failed cleanup never establish release or no holder", async (t) => {
  const f = await fixture(t);
  const dir = adapter.readModelTransactionDir(f.db.path);
  const reports: string[] = [];
  const identity = { pid: process.pid, bootId: "boot", pidNamespace: "ns", startTicks: "123" };
  const recorder = adapter.createReadModelTransactionRecorder(f.db.path, "cleanup", {
    identity: () => identity,
    remove: () => { throw Error("unlink denied"); }, report: step => reports.push(step),
  });
  f.closers.push(() => recorder.close());
  const nonce = recorder.attempt(); recorder.acquired(nonce);
  await adapter.flushReadModelTransactions(); recorder.release(nonce);
  await adapter.flushReadModelTransactions();
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

test("attached writers and close use the real default recorder without changing SQLite behavior", async (t) => {
  const f = await fixture(t);
  const attached = adapter.attachReadModel(f.db.path, 1, { label: "attached writer" });
  attached.exec("BEGIN IMMEDIATE");
  await adapter.flushReadModelTransactions();
  assert.equal(adapter.readReadModelTransactions(f.db.path).records[0]?.label, "attached writer");
  attached.close();
  await adapter.flushReadModelTransactions();
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
  await adapter.flushReadModelTransactions();
  assert.deepEqual(reports, ["read_model.holder_record_failed"], "real filesystem failure is advisory and bounded");
});

test("default process inspection and failed inventory close remain unknown", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const read = t.mock.method(fs, "readFileSync", () => { calls++; throw Object.assign(Error("procfs denied"), { code: "EACCES" }); });
  syncBuiltinESMExports();
  try {
    assert.equal(adapter.readModelProcessIdentity(), undefined);
    assert.equal(calls, 1, "the real default process reader ran and handled its failure");
  } finally { read.mock.restore(); syncBuiltinESMExports(); }
  const originalClose = fs.Dir.prototype.closeSync;
  const close = t.mock.method(fs.Dir.prototype, "closeSync", function(this: fs.Dir) {
    originalClose.call(this);
    throw Error("directory close failed");
  });
  try {
    const observed = adapter.readReadModelTransactions(f.db.path);
    assert.equal(observed.complete, false);
    assert.equal(observed.state, "unknown");
  } finally { close.mock.restore(); }
});

test("a real default diagnostic sink reports once and never prevents child database writes", async (t) => {
  const f = await fixture(t);
  rmSync(adapter.readModelTransactionDir(f.db.path), { recursive: true });
  writeFileSync(adapter.readModelTransactionDir(f.db.path), "not a directory");
  const file = join(f.dir, "default-failure.mjs");
  const module = pathToFileURL(join(process.cwd(), "src/lib/read-model-db.ts")).href;
  writeFileSync(file, `import { openReadModel,flushReadModelTransactions } from ${JSON.stringify(module)};
const db=openReadModel({stateDir:process.argv[2],instance:'core',schemaVersion:1});
db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO value VALUES(?)').run(17);db.exec('COMMIT');
db.exec('BEGIN IMMEDIATE');db.exec('ROLLBACK');db.close();await flushReadModelTransactions();
`);
  const child = spawnSync(process.execPath, ["--import", "tsx", file, f.dir], { encoding: "utf8", timeout: 20_000, maxBuffer: 65_536 });
  assert.equal(child.status, 0, child.stderr);
  const reports = child.stderr.split("\n").filter(line => line.includes('"step":"read_model.holder_record_failed"'));
  assert.equal(reports.length, 1);
  assert.equal(JSON.parse(reports[0]!).release, "unverified");
  assert.equal(f.db.prepare("SELECT n FROM value").get()?.n, 17);
});


test("default transaction publication never writes sidecars on SQLite's calling thread", async (t) => {
  const f = await fixture(t);
  const original = fs.writeFileSync;
  let sidecarWrites = 0;
  const mocked = t.mock.method(fs, "writeFileSync", ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(file).includes(".transactions")) { sidecarWrites++; throw Error("SQLite thread must not touch diagnostic disk"); }
    return (original as (...args: unknown[]) => void)(file, ...args);
  }) as typeof fs.writeFileSync);
  syncBuiltinESMExports();
  try {
    f.db.exec("BEGIN IMMEDIATE"); f.db.prepare("INSERT INTO value VALUES(?)").run(23); f.db.exec("COMMIT");
    assert.equal(f.db.prepare("SELECT n FROM value").get()?.n, 23);
    assert.equal(sidecarWrites, 0, "diagnostic disk publication must happen outside SQLite's calling thread");
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});


test("the default publisher records acquisition while SQLite's calling thread is blocked", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const file = join(f.dir, "blocked-caller.mjs");
  const module = pathToFileURL(join(process.cwd(), "src/lib/read-model-db.ts")).href;
  writeFileSync(file, `import {openReadModel,flushReadModelTransactions} from ${JSON.stringify(module)};
const db=openReadModel({stateDir:process.argv[2],instance:'core',schemaVersion:1,transactionObservation:{label:'blocked-js-caller'}});
await flushReadModelTransactions();db.exec('BEGIN IMMEDIATE');process.send({blocked:true});
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,3000);
db.exec('ROLLBACK');db.close();await flushReadModelTransactions();process.disconnect();
`);
  const child = fork(file, [f.dir], { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const exit = new Promise<number | null>(resolve => child.once("exit", resolve));
  f.closers.push(async () => { await exit; });
  await new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); });
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => finish(Error("No independently published acquired record")), 2000);
    const watcher = fs.watch(adapter.readModelTransactionDir(f.db.path), check);
    function finish(error?: Error) { clearTimeout(deadline); watcher.close(); if (error) reject(error); else resolve(); }
    function check() {
      const observed = adapter.readReadModelTransactions(f.db.path);
      if (observed.records.some(r => r.pid === child.pid && r.label === "blocked-js-caller" && r.recordedState === "recorded-acquired")) finish();
    }
    check();
  });
  assert.equal(child.exitCode, null, "publication completed during the real caller's synchronous block");
  assert.equal(await exit, 0);
});

test("coalesced short transactions retire an older snapshot and close waits for retirement", async (t) => {
  const f = await fixture(t);
  f.db.exec("BEGIN IMMEDIATE");
  await adapter.flushReadModelTransactions();
  f.db.exec("ROLLBACK");
  for (let n = 0; n < 100; n++) { f.db.exec("BEGIN IMMEDIATE"); f.db.exec("COMMIT"); }
  await adapter.flushReadModelTransactions();
  assert.equal(adapter.readReadModelTransactions(f.db.path).state, "none-recorded");
});


test("publisher startup or worker failure stays advisory and reports once", async (t) => {
  for (const kind of ["constructor", "worker"] as const) {
    const dir = makeTempDir("publisher-failure");
    const Original = threads.Worker;
    let calls = 0;
    const reports: string[] = [];
    const mocked = t.mock.method(threads, "Worker", (function(this: unknown, _source: unknown, options: threads.WorkerOptions) {
      calls++;
      if (kind === "constructor") throw Error("injected worker startup failure");
      return new Original("throw Error('injected publisher failure')", options);
    }) as unknown as typeof threads.Worker);
    syncBuiltinESMExports();
    let db: adapter.ReadModelDb | undefined;
    try {
      db = adapter.openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1, ddl: "CREATE TABLE value(n);", transactionObservation: { report: step => reports.push(step) } });
      db.exec("BEGIN IMMEDIATE"); db.prepare("INSERT INTO value VALUES(?)").run(31); db.exec("COMMIT");
      if (kind === "worker") await assert.rejects(adapter.flushReadModelTransactions(), /publisher stopped/);
      db.exec("BEGIN IMMEDIATE"); db.exec("ROLLBACK");
      assert.equal(db.prepare("SELECT n FROM value").get()?.n, 31);
      assert.equal(calls, 1, "the default publisher constructor was exercised");
      assert.deepEqual(reports, ["read_model.holder_record_failed"]);
    } finally {
      mocked.mock.restore(); syncBuiltinESMExports(); db?.close();
      await adapter.flushReadModelTransactions().catch(() => {}); rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("publisher capacity is bounded and refuses extra diagnostics without refusing SQL", async (t) => {
  const f = await fixture(t);
  const records: ReturnType<typeof adapter.createReadModelTransactionRecorder>[] = [];
  const reports: string[] = [];
  for (let n = 0; n < 128; n++) records.push(adapter.createReadModelTransactionRecorder(f.db.path, `capacity-${n}`, { report: step => reports.push(step) }));
  f.closers.push(() => { for (const record of records) record.close(); });
  const overflow = records.at(-1)!;
  overflow.acquired(overflow.attempt()); overflow.acquired(overflow.attempt());
  f.db.exec("BEGIN IMMEDIATE"); f.db.prepare("INSERT INTO value VALUES(?)").run(37); f.db.exec("COMMIT");
  assert.equal(f.db.prepare("SELECT n FROM value").get()?.n, 37);
  assert.deepEqual(reports, ["read_model.holder_record_failed"]);
});

test("compiled transaction diagnostics name business callers for direct and fenced writes", async (t) => {
  const f = await fixture(t);
  const entry = join(f.dir, "bundled-writer.mjs");
  const module = join(process.cwd(), "src/lib/read-model-db.ts");
  // Keep the fenced label assertion independent of an asynchronous inventory snapshot race.
  // The direct case and the blocked-caller child above exercise the default asynchronous publisher.
  const contents = `import {openReadModel,attachReadModel,flushReadModelTransactions,readReadModelTransactions,acquireLease,withWriteTransaction} from ${JSON.stringify(module)};
import {mkdirSync,writeFileSync} from 'node:fs';import {dirname} from 'node:path';
const db=openReadModel({stateDir:process.argv[2],instance:'core',schemaVersion:1});
await flushReadModelTransactions();
function businessDirectWrite(){db.exec('BEGIN IMMEDIATE')}
businessDirectWrite();await flushReadModelTransactions();
const direct=readReadModelTransactions(db.path).records[0]?.label;
db.exec('ROLLBACK');await flushReadModelTransactions();
let recorded;
const fencedDb=attachReadModel(db.path,1,{publish:(file,record)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(record));recorded=record}});
const acquired=acquireLease(fencedDb);if(!acquired.ok)throw Error('private lease not acquired');
function businessFencedWrite(){return withWriteTransaction(fencedDb,acquired.lease,()=>recorded.label)}
const fenced=businessFencedWrite();fencedDb.close();db.close();await flushReadModelTransactions();
console.log(JSON.stringify({direct,fenced}));
`;
  const built = buildSync({ stdin: { contents, resolveDir: process.cwd(), sourcefile: "caller-client.ts" },
    bundle: true, write: false, platform: "node", format: "esm", target: "node24" });
  writeFileSync(entry, built.outputFiles[0]!.contents);
  const child = spawnSync(process.execPath, [entry, f.dir], { encoding: "utf8", timeout: 20_000, maxBuffer: 65_536 });
  assert.equal(child.status, 0, child.stderr);
  const labels = JSON.parse(child.stdout);
  assert.match(labels.direct, /businessDirectWrite/, "a bundle filename cannot identify the transaction caller");
  assert.match(labels.fenced, /businessFencedWrite/, "the lease helper must not hide its business caller");
});
