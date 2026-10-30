import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BoundedOutput, readBoundedFileTail } from "#src/lib/bounded-file-tail.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

test("W1-T10962: the real default report reader respects a byte bound and preserves valid multibyte evidence", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-bounded-tail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "report");
  execFileSync(process.execPath, ["-e", "const f=require('fs'); const d=f.openSync(process.argv[1],'w'); f.ftruncateSync(d,2**30); f.writeSync(d,Buffer.from('🙂é終\\n'),0,10,2**30-10); f.closeSync(d)", path],
    { cwd: REPO_ROOT, env: { ...process.env, NODE_V8_COVERAGE: "" } });
  const read = fs.readSync;
  let requested = 0;
  t.mock.method(fs, "readSync", (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
    requested += length;
    return read(fd, buffer, offset, length, position);
  });
  const result = readBoundedFileTail(path, 8);
  assert.equal(result.state, "truncated");
  assert.equal(result.fileBytes, 2 ** 30);
  assert.equal(result.text, "é終\n");
  assert.ok(result.bytesRead <= 8 && requested <= 8);
  assert.ok(Buffer.byteLength(result.text) <= 8);
  writeFileSync(path, "🙂é終\n");
  assert.equal(readBoundedFileTail(path, 10).state, "complete");
  assert.equal(readBoundedFileTail(path, 10).text, "🙂é終\n");
});

test("bounded report states distinguish absent, unreadable, malformed and empty", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-bounded-states-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "report");
  const absent = readBoundedFileTail(path, 12);
  assert.equal(absent.state, "absent");
  assert.match(absent.reason!, /ENOENT/);
  const unreadable = readBoundedFileTail(dir, 12);
  assert.equal(unreadable.state, "unreadable");
  assert.ok(unreadable.reason);
  writeFileSync(path, Buffer.from([0xc3, 0x28]));
  const malformed = readBoundedFileTail(path, 12);
  assert.equal(malformed.state, "malformed");
  assert.ok(malformed.reason);
  assert.equal(malformed.bytesRead, 2);
  assert.equal(malformed.text, "");
  writeFileSync(path, "");
  assert.equal(readBoundedFileTail(path, 12).state, "complete");
  assert.throws(() => readBoundedFileTail(path, -1), /byte bound/);
  assert.throws(() => readBoundedFileTail(path, NaN), /byte bound/);
  assert.equal(readBoundedFileTail(path, 0).text, "");
});

test("bounded report short reads and close failures never claim completeness", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-bounded-race-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "report");
  writeFileSync(path, "complete report");
  const read = fs.readSync;
  let calls = 0;
  const partial = t.mock.method(fs, "readSync", (fd: number, buffer: Buffer, offset: number, _length: number, position: number) => {
    if (calls++ > 0) return 0;
    return read(fd, buffer, offset, 2, position);
  });
  const result = readBoundedFileTail(path, 100);
  assert.equal(result.state, "unreadable");
  assert.match(result.reason!, /short read/);
  partial.mock.restore();
  const close = fs.closeSync;
  t.mock.method(fs, "closeSync", (fd: number) => { close(fd); throw new Error("close failed"); });
  const closed = readBoundedFileTail(path, 100);
  assert.equal(closed.state, "unreadable");
  assert.match(closed.reason!, /close failed/);
  assert.equal(closed.bytesRead, Buffer.byteLength("complete report"));
});

test("bounded output spills, preserves small chunks and reports write and cleanup failures", (t) => {
  assert.throws(() => new BoundedOutput(-1), /byte bound/);
  const small = new BoundedOutput(12);
  small.push("");
  small.push("hello");
  small.push("é");
  assert.deepEqual(small.finish().chunks, ["hello", "é"]);
  assert.equal(small.finish().evidence.state, "complete");
  assert.doesNotThrow(() => small.push("late"));
  assert.deepEqual(small.finish().chunks, ["hello", "é"]);
  const spilled = new BoundedOutput(8);
  spilled.push("first");
  spilled.push("\n🙂é終\n");
  spilled.push("end");
  assert.deepEqual(spilled.finish().chunks, ["終\nend"]);
  assert.equal(spilled.finish().evidence.state, "truncated");
  const write = t.mock.method(fs, "appendFileSync", () => { throw new Error("disk full"); });
  const failed = new BoundedOutput(1);
  failed.push("large");
  failed.push("ignored");
  const failedOutput = failed.finish();
  assert.equal(failedOutput.evidence.state, "unreadable");
  assert.match(failedOutput.evidence.reason!, /disk full/);
  assert.deepEqual(failedOutput.chunks, []);
  write.mock.restore();
  const create = t.mock.method(fs, "mkdtempSync", () => { throw new Error("scratch refused"); });
  const noScratch = new BoundedOutput(0);
  noScratch.push("x");
  assert.equal(noScratch.finish().evidence.state, "unreadable");
  assert.match(noScratch.finish().evidence.reason!, /scratch refused/);
  create.mock.restore();
  const dirs: string[] = [];
  const mkdtemp = fs.mkdtempSync;
  t.mock.method(fs, "mkdtempSync", (prefix: string) => {
    const dir = mkdtemp(prefix);
    dirs.push(dir);
    return dir;
  });
  const cleanup = t.mock.method(fs, "rmSync", () => { throw new Error("cleanup refused"); });
  t.after(() => { cleanup.mock.restore(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
  const leftover = new BoundedOutput(1);
  leftover.push("large");
  assert.equal(leftover.finish().evidence.state, "unreadable");
  assert.match(leftover.finish().evidence.reason!, /cleanup refused/);
});

test("bounded output preserves block boundaries and unicode across write chunks", () => {
  const blocks = new BoundedOutput(12, "\n");
  blocks.push("first");
  blocks.push("second");
  blocks.push("last");
  assert.deepEqual(blocks.finish().chunks, ["\nsecond\nlast"]);
  const unicode = new BoundedOutput(12);
  unicode.push(`${"x".repeat(8191)}🙂tail`);
  assert.equal(unicode.finish().chunks.join(""), "xxxx🙂tail");
  assert.equal(unicode.finish().evidence.state, "truncated");
});

test("bounded reader refuses a changing file and handles successful short reads", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-bounded-growth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "report");
  writeFileSync(path, "report");
  const read = fs.readSync;
  const partial = t.mock.method(fs, "readSync", (fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
    read(fd, buffer, offset, Math.min(2, length), position));
  assert.equal(readBoundedFileTail(path, 6).text, "report");
  partial.mock.restore();
  t.mock.method(fs, "readSync", (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
    const count = read(fd, buffer, offset, length, position);
    fs.appendFileSync(path, "changed");
    return count;
  });
  const changed = readBoundedFileTail(path, 6);
  assert.equal(changed.state, "unreadable");
  assert.match(changed.reason!, /changed while reading/);
});
