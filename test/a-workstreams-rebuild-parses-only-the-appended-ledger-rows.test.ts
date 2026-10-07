import assert from "node:assert/strict";
import fs, { appendFileSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LEDGER_FILENAME } from "../src/lib/ledger-path.js";
import { buildBatchedGithub, readLedgerLines, type LedgerLines } from "../src/lib/status.js";
import { makeTempDir } from "../src/lib/tmp.js";
import * as workstreams from "../src/lib/workstreams-view.js";

function fixture(t: TestContext) {
  const root = makeTempDir("workstreams-ledger-tail");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, LEDGER_FILENAME);
  assert.ok("createLiveLedgerTail" in workstreams, "the appended-rows reader must exist");
  return { root, path, read: workstreams.createLiveLedgerTail(path) };
}

function oracle(path: string): LedgerLines {
  // ledger-read-intent: live — the whole-file oracle for the incremental live reader.
  return readLedgerLines(path);
}

function equalOracle(path: string, actual: LedgerLines): void {
  const expected = oracle(path);
  assert.deepEqual(actual, expected);
  assert.equal(actual.torn, expected.torn);
  assert.equal(actual.present, expected.present);
  assert.equal(Object.getOwnPropertyDescriptor(actual, "torn")!.enumerable, false);
  assert.equal(Object.getOwnPropertyDescriptor(actual, "present")!.enumerable, false);
}

function spyReads(t: TestContext) {
  const spy = t.mock.method(fs, "readSync");
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
  return spy;
}

test("appends read and parse only appended bytes and return fresh ledger arrays", (t) => {
  const f = fixture(t);
  const initial = '{"step":"run.start","task_id":"A"}\ninvalid\n \r\n';
  writeFileSync(f.path, initial);
  const reads = spyReads(t);
  const parses = t.mock.method(JSON, "parse");
  const first = f.read();
  assert.deepEqual(parses.mock.calls.map((c) => c.arguments[0]), [initial.split("\n")[0], "invalid"]);
  assert.equal(reads.mock.calls[0]!.arguments.at(4), 0);
  equalOracle(f.path, first);
  const readCount = reads.mock.callCount();
  const parseCount = parses.mock.callCount();
  const unchanged = f.read();
  assert.notEqual(unchanged, first);
  assert.equal(reads.mock.callCount(), readCount);
  assert.equal(parses.mock.callCount(), parseCount);
  const appended = '{"step":"run.end","task_id":"é🦊"}\n';
  appendFileSync(f.path, appended);
  const second = f.read();
  assert.deepEqual(parses.mock.calls.slice(parseCount).map((c) => c.arguments[0]), [appended.trim()]);
  assert.equal(reads.mock.calls.at(-1)!.arguments.at(4), Buffer.byteLength(initial));
  assert.equal(reads.mock.calls.at(-1)!.result, Buffer.byteLength(appended));
  assert.notEqual(second, first);
  assert.equal(first.length, 1, "a later build must not mutate an earlier ledger array");
  equalOracle(f.path, second);
  second.pop();
  equalOracle(f.path, f.read());
});

test("a partial final line is provisional until completed, with whole-file torn accounting", (t) => {
  const f = fixture(t);
  const prefix = '{"n":1}\nbroken\n';
  const next = Buffer.from('{"text":"é🦊"}\n');
  const split = next.indexOf(Buffer.from("🦊")) + 2;
  writeFileSync(f.path, prefix);
  appendFileSync(f.path, next.subarray(0, split));
  const first = f.read();
  equalOracle(f.path, first);
  assert.equal(first.torn, 2);
  equalOracle(f.path, f.read());
  const reads = spyReads(t);
  appendFileSync(f.path, next.subarray(split));
  const complete = f.read();
  assert.equal(reads.mock.calls[0]!.arguments.at(4), Buffer.byteLength(prefix));
  equalOracle(f.path, complete);
  assert.equal(complete.torn, 1);
  assert.deepEqual(complete, [{ n: 1 }, { text: "é🦊" }]);
  assert.equal(first.torn, 2, "completion must not mutate a previous result's metadata");
  appendFileSync(f.path, '{"n":3}');
  equalOracle(f.path, f.read());
  appendFileSync(f.path, 'garbage\n');
  equalOracle(f.path, f.read());
  assert.equal(f.read().length, 2, "a valid but unterminated row is never retained as complete");
});

test("rotation and truncation discard held rows and torn counts", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, '{"old":true}\nbroken\n');
  f.read();
  renameSync(f.path, `${f.path}.old`);
  writeFileSync(f.path, '{"replacement":"longer than the previous file"}\n');
  const reads = spyReads(t);
  equalOracle(f.path, f.read());
  assert.equal(reads.mock.calls[0]!.arguments.at(4), 0);
  writeFileSync(f.path, '{"n":1}\n');
  equalOracle(f.path, f.read());
  assert.equal(reads.mock.calls.at(-1)!.arguments.at(4), 0);
  writeFileSync(f.path, "");
  equalOracle(f.path, f.read());
  appendFileSync(f.path, '{"n":2}\n');
  equalOracle(f.path, f.read());
});

test("missing and unreadable files match the whole-file outcome and clear held rows", (t) => {
  const f = fixture(t);
  equalOracle(f.path, f.read());
  writeFileSync(f.path, '{"old":true}\n');
  f.read();
  rmSync(f.path);
  equalOracle(f.path, f.read());
  mkdirSync(f.path);
  assert.throws(() => oracle(f.path), { code: "EISDIR" });
  assert.throws(() => f.read(), { code: "EISDIR" });
  rmSync(f.path, { recursive: true });
  writeFileSync(f.path, '{"new":true}\n');
  equalOracle(f.path, f.read());
});

test("a shrink inside the uncommitted tail and a changed device both force a full read", (t) => {
  const f = fixture(t);
  const prefix = '{"n":1}\n';
  writeFileSync(f.path, prefix + '{"unfinished":"long tail');
  f.read();
  const reads = spyReads(t);
  writeFileSync(f.path, prefix + " ");
  equalOracle(f.path, f.read());
  assert.equal(reads.mock.calls[0]!.arguments.at(4), 0, "shrink is compared to observed size, not just committed offset");
  const original = fs.fstatSync;
  const stats = t.mock.method(fs, "fstatSync", (fd: number) => {
    const st = original(fd);
    st.dev++;
    return st;
  });
  syncBuiltinESMExports();
  t.after(() => { stats.mock.restore(); syncBuiltinESMExports(); });
  equalOracle(f.path, f.read());
  assert.equal(reads.mock.calls.at(-1)!.arguments.at(4), 0, "device identity is checked even with the same inode");
});

test("a failed tail read falls back to a whole read and the next build starts at zero", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, '{"n":1}\n');
  f.read();
  appendFileSync(f.path, '{"n":2}\n');
  const spy = t.mock.method(fs, "readSync", () => { throw new Error("injected tail read failure"); });
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
  equalOracle(f.path, f.read());
  spy.mock.restore();
  syncBuiltinESMExports();
  const reads = spyReads(t);
  equalOracle(f.path, f.read());
  assert.equal(reads.mock.calls[0]!.arguments.at(4), 0);
});

test("a short read is completed and unexpected eof falls back without retaining stale rows", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, '{"n":1}\n');
  const original = fs.readSync;
  const short = t.mock.method(fs, "readSync", (fd: number, buffer: Buffer, offset: number, length: number, position: number) => original(fd, buffer, offset, Math.min(length, 2), position));
  syncBuiltinESMExports();
  t.after(() => { short.mock.restore(); syncBuiltinESMExports(); });
  equalOracle(f.path, f.read());
  assert.ok(short.mock.callCount() > 1);
  short.mock.restore();
  const eof = t.mock.method(fs, "readSync", () => 0);
  syncBuiltinESMExports();
  t.after(() => { eof.mock.restore(); syncBuiltinESMExports(); });
  appendFileSync(f.path, '{"n":2}\n');
  equalOracle(f.path, f.read());
  eof.mock.restore();
  syncBuiltinESMExports();
  equalOracle(f.path, f.read());
});

test("the view rebuilds through a separate live ledger tail for each instance", (t) => {
  const root = makeTempDir("workstreams-ledger-tail-view");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const instances = ["one", "two"].map((name) => {
    const ledgerDir = join(root, name);
    mkdirSync(ledgerDir);
    writeFileSync(join(ledgerDir, LEDGER_FILENAME), `{"instance":"${name}"}\n`);
    return { name, ledgerDir };
  });
  let planReads = 0;
  const view = workstreams.createWorkstreamsView({
    instances, debounceMs: 0,
    ledgerSource: () => ({ name: "ledger", state: "fresh", asOf: new Date(1).toISOString() }),
    readPlan: () => { planReads++; return { tasks: [], byId: new Map() }; },
    github: () => ({ github: buildBatchedGithub("owner", "repo", { fetchAll: () => [], fetchAllIssues: () => [], commitTrailerIndex: () => new Map() }), source: { state: "fresh", asOf: new Date(1).toISOString() } }),
    planBehind: () => ({ commits: 0 }),
  });
  const states = instances.map((i) => ({ state: { instance: i.name, newestTs: null } }));
  const reads = spyReads(t);
  const first = view.materialize({ now: 1, instances: states });
  assert.equal(first[0]!.data.instances.length, 2);
  assert.equal(reads.mock.callCount(), 2);
  const appended = '{"appended":true}\n';
  appendFileSync(join(instances[0]!.ledgerDir, LEDGER_FILENAME), appended);
  view.materialize({ now: 2, instances: states.slice(0, 1) });
  view.materialize({ now: 3, instances: states });
  assert.equal(planReads, 5, "control: all three builds reached their stages");
  assert.equal(reads.mock.callCount(), 3, "the unchanged instance reads no bytes");
  assert.equal(reads.mock.calls.at(-1)!.result, Buffer.byteLength(appended));
  assert.equal(reads.mock.calls.at(-1)!.arguments.at(4), Buffer.byteLength('{"instance":"one"}\n'));
});

test("the live tail opens the ledger once and never tails a symlinked one, falling back to the whole read", (t) => {
  // CodeQL js/file-system-race: an exists-then-open pair let the entry change between the two calls. The tail's
  // single O_NOFOLLOW open refuses the symlink (ELOOP), and the tail's own fallback answers with the whole read.
  const f = fixture(t);
  writeFileSync(`${f.path}.real`, '{"elsewhere":true}\n');
  symlinkSync(`${f.path}.real`, f.path);
  equalOracle(f.path, f.read());
});
