import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../src/lib/tmp.js";
import { readLedgerLines } from "../src/lib/status.js";
import { closedPrLookup, runPrTerminalReconcile } from "../src/lib/sweep.js";

const url = (n: number) => `https://github.com/o/r/pull/${n}`;
const row = (n: number, step = "pr.opened", extra: Record<string, unknown> = {}) =>
  JSON.stringify({ pr_url: url(n), step, ...extra }) + "\n";

test("test/the-pr-terminal-rung-reads-only-what-it-has-not-read.test.ts: appended live bytes and terminal dedup", (t) => {
  const dir = makeTempDir("pr-terminal-cursor");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  const initial = row(1);
  fs.writeFileSync(ledgerPath, initial);
  const reads: Array<{ position: number | null; bytes: number }> = [];
  const readSync = fs.readSync;
  t.mock.method(fs, "readSync", (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
    const bytes = readSync(fd, buffer, offset, length, position);
    reads.push({ position, bytes });
    return bytes;
  });
  const pass = () => runPrTerminalReconcile(() => undefined, { ledgerPath, runId: "cursor" });
  assert.equal(pass().named, 1);
  assert.deepEqual(reads, [{ position: 0, bytes: Buffer.byteLength(initial) }], "positive control: the reader sees the live file");
  const appended = row(2, "sweep.disposed", { note: "café" });
  fs.appendFileSync(ledgerPath, appended);
  reads.length = 0;
  assert.equal(pass().named, 2);
  assert.deepEqual(reads, [{ position: Buffer.byteLength(initial), bytes: Buffer.byteLength(appended) }]);
  reads.length = 0;
  assert.equal(pass().named, 2);
  assert.deepEqual(reads, [], "an unchanged pass reads no ledger bytes");
  t.mock.restoreAll();
  const lookup = closedPrLookup([
    { prUrl: url(1), prNumber: 1, state: "merged", at: "2026-10-04T01:02:03Z" },
    { prUrl: url(2), prNumber: 2, state: "closed", at: "2026-10-04T02:00:00Z" },
  ]);
  assert.equal(runPrTerminalReconcile(lookup, { ledgerPath, runId: "cursor" }).appended, 2);
  assert.equal(runPrTerminalReconcile(lookup, { ledgerPath, runId: "cursor" }).appended, 0);
  const terminal = readLedgerLines(ledgerPath).filter((r) => r.step === "pr.terminal");
  assert.equal(terminal.length, 2);
  assert.deepEqual(terminal.map(({ ts, host, actor, actor_pid, ...r }) => r), [
    { run_id: "cursor", task_id: "SWEEP", step: "pr.terminal", pr_url: url(1), pr_number: 1,
      state: "merged", merged_at: "2026-10-04T01:02:03Z", source: "sweep.pr_terminal" },
    { run_id: "cursor", task_id: "SWEEP", step: "pr.terminal", pr_url: url(2), pr_number: 2,
      state: "closed", closed_at: "2026-10-04T02:00:00Z", source: "sweep.pr_terminal" },
  ]);
});

test("the live cursor resets on inode replacement even when the replacement is larger", (t) => {
  const dir = makeTempDir("pr-terminal-rotate");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  fs.writeFileSync(ledgerPath, row(1));
  const pass = () => runPrTerminalReconcile(() => undefined, { ledgerPath, runId: "rotate" });
  assert.equal(pass().named, 1);
  fs.renameSync(ledgerPath, join(dir, "ledger.2026-10-04T00-00-00-000Z.ndjson"));
  fs.writeFileSync(ledgerPath, row(2) + row(3));
  assert.equal(pass().named, 2, "only the replacement file names PRs now");
  const lookup = closedPrLookup([{ prUrl: url(1), prNumber: 1, state: "closed" }]);
  assert.equal(runPrTerminalReconcile(lookup, { ledgerPath, runId: "rotate" }).appended, 0);
});

test("the live cursor resets on same-inode shrink and disappearance", (t) => {
  const dir = makeTempDir("pr-terminal-shrink");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  fs.writeFileSync(ledgerPath, row(1) + row(2));
  const pass = () => runPrTerminalReconcile(() => undefined, { ledgerPath, runId: "shrink" });
  assert.equal(pass().named, 2);
  const inode = fs.statSync(ledgerPath).ino;
  fs.writeFileSync(ledgerPath, row(3));
  assert.equal(fs.statSync(ledgerPath).ino, inode);
  assert.equal(pass().named, 1);
  fs.unlinkSync(ledgerPath);
  assert.equal(pass().named, 0);
  fs.writeFileSync(ledgerPath, row(4));
  assert.equal(pass().named, 1);
});

test("the live cursor carries a partial utf8 row until its newline arrives", (t) => {
  const dir = makeTempDir("pr-terminal-partial");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  const bytes = Buffer.from(row(1, "pr.opened", { note: "café" }));
  const cut = bytes.indexOf(Buffer.from("é")) + 1;
  fs.writeFileSync(ledgerPath, bytes.subarray(0, cut));
  const pass = () => runPrTerminalReconcile(() => undefined, { ledgerPath, runId: "partial" });
  const errors: string[] = [];
  t.mock.method(console, "error", (message: string) => errors.push(message));
  assert.equal(pass().named, 0);
  assert.equal(pass().named, 0);
  assert.deepEqual(errors, [], "an incomplete append is not a malformed row");
  fs.appendFileSync(ledgerPath, bytes.subarray(cut));
  assert.equal(pass().named, 1);
  assert.deepEqual(errors, []);
});

test("a malformed complete row is reported once and later rows still reconcile", (t) => {
  const dir = makeTempDir("pr-terminal-torn");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  fs.writeFileSync(ledgerPath, "not json\n\n" + row(1));
  const errors: string[] = [];
  t.mock.method(console, "error", (message: string) => errors.push(message));
  const pass = () => runPrTerminalReconcile(() => undefined, { ledgerPath, runId: "torn" });
  assert.equal(pass().named, 1);
  assert.equal(pass().named, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /dropping unparseable line.*not json/);
});

test("short reads resume at the bytes actually read and eof preserves a partial row", (t) => {
  const dir = makeTempDir("pr-terminal-short");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  fs.writeFileSync(ledgerPath, row(1) + row(2));
  const readSync = fs.readSync;
  let calls = 0;
  t.mock.method(fs, "readSync", (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
    calls++;
    if (calls === 2) return 0;
    return readSync(fd, buffer, offset, Math.min(length, 7), position);
  });
  const pass = () => runPrTerminalReconcile(() => undefined, { ledgerPath, runId: "short" });
  assert.equal(pass().named, 0);
  assert.equal(pass().named, 2);
});

test("a live-file access failure propagates instead of clearing known keys", (t) => {
  const dir = makeTempDir("pr-terminal-access");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  fs.writeFileSync(ledgerPath, row(1));
  const pass = () => runPrTerminalReconcile(() => undefined, { ledgerPath, runId: "access" });
  assert.equal(pass().named, 1);
  const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
  t.mock.method(fs, "openSync", () => { throw failure; });
  assert.throws(pass, (error) => error === failure);
  t.mock.restoreAll();
  assert.equal(pass().named, 1);
});

test("dry runs and failed appends leave a pending PR retryable", (t) => {
  const dir = makeTempDir("pr-terminal-retry");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  fs.writeFileSync(ledgerPath, row(1));
  const lookup = closedPrLookup([{ prUrl: url(1), prNumber: 1, state: "closed" }]);
  const deps = { ledgerPath, runId: "retry" };
  assert.equal(runPrTerminalReconcile(lookup, { ...deps, dryRun: true }).appended, 0);
  const failure = new Error("append failed");
  assert.throws(() => runPrTerminalReconcile(lookup, { ...deps, appendLine: () => { throw failure; } }),
    (error) => error === failure);
  assert.equal(runPrTerminalReconcile(lookup, deps).appended, 1);
  assert.equal(runPrTerminalReconcile(lookup, deps).appended, 0);
  assert.equal(readLedgerLines(ledgerPath).filter((r) => r.step === "pr.terminal").length, 1);
});

test("the existing injected ledger reader still supplies a fresh snapshot", (t) => {
  const dir = makeTempDir("pr-terminal-injected");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const written: Record<string, unknown>[] = [];
  const lookup = closedPrLookup([{ prUrl: url(1), prNumber: 1, state: "merged" }]);
  const summary = runPrTerminalReconcile(lookup, {
    ledgerPath: join(dir, "ledger.ndjson"), runId: "injected",
    readLedger: () => [{ step: "pr.opened", pr_url: url(1) }, { step: "noise" }],
    appendLine: (_path, line) => written.push(line),
  });
  assert.equal(summary.named, 1);
  assert.equal(summary.appended, 1);
  assert.equal(written[0].step, "pr.terminal");
});
