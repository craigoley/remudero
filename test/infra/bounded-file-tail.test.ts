import { REPO_ROOT } from "#test/helpers/repo-root.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function fixture(body: (root: string) => void | Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(join(tmpdir(), "rmd-bounded-tail-"));
  try { await body(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("the bounded history tail preserves small files and drops only a partial leading row", () => fixture(async root => {
  assert.ok(fs.existsSync(join(REPO_ROOT, "src/lib/bounded-file-tail.ts")),
    "this source tree must contain the bounded-history implementation");
  const { readBoundedFileTail } = await import("#src/lib/bounded-file-tail.js");
  const path = join(root, "history"); fs.writeFileSync(path, "alpha\nbeta\ngamma\n");
  assert.equal(readBoundedFileTail(path, 128), "alpha\nbeta\ngamma\n");
  assert.equal(readBoundedFileTail(path, 10), "gamma\n");
  fs.writeFileSync(path, "one-unbroken-row");
  assert.equal(readBoundedFileTail(path, 4), "", "a partial row has no proven line boundary");
  fs.writeFileSync(path, ""); assert.equal(readBoundedFileTail(path, 128), "");
}));

test("a large sparse history is read through bounded positional I/O without a whole-file allocation", t => fixture(async root => {
  assert.ok(fs.existsSync(join(REPO_ROOT, "src/lib/bounded-file-tail.ts")),
    "this source tree must contain the bounded-history implementation");
  const { readBoundedFileTail } = await import("#src/lib/bounded-file-tail.js");
  const path = join(root, "history"), fd = fs.openSync(path, "wx");
  try {
    fs.ftruncateSync(fd, 64 * 1024 ** 2);
    fs.writeSync(fd, Buffer.from("\nlast\n"), 0, 6, 64 * 1024 ** 2 - 6);
  } finally { fs.closeSync(fd); }
  const whole = fs.readFileSync, positional = fs.readSync, requests: Array<{ requested: number; read: number }> = [];
  const fullRead = t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]) === path) throw new Error("whole-file history read refused by positive control");
    return Reflect.apply(whole, fs, args);
  }) as typeof fs.readFileSync);
  const read = t.mock.method(fs, "readSync", ((fd: number, buffer: NodeJS.ArrayBufferView,
    offset: number, length: number, position: number | null) => {
    const count = positional(fd, buffer, offset, length, position);
    requests.push({ requested: length, read: count }); return count;
  }) as typeof fs.readSync);
  syncBuiltinESMExports();
  try {
    assert.equal(readBoundedFileTail(path, 32), "last\n");
    assert.ok(requests.length > 0, "actual positional reads were observed");
    assert.ok(requests.every(row => row.requested > 0 && row.requested <= 32));
    assert.ok(requests.reduce((total, row) => total + row.read, 0) <= 32);
  } finally { read.mock.restore(); fullRead.mock.restore(); syncBuiltinESMExports(); }
}));

test("bounded history reads reject links invalid bounds and non-files", () => fixture(async root => {
  assert.ok(fs.existsSync(join(REPO_ROOT, "src/lib/bounded-file-tail.ts")),
    "this source tree must contain the bounded-history implementation");
  const { readBoundedFileTail } = await import("#src/lib/bounded-file-tail.js");
  const path = join(root, "history"); fs.writeFileSync(path, "kept");
  const link = join(root, "linked"); fs.symlinkSync(path, link);
  assert.throws(() => readBoundedFileTail(link, 32));
  assert.throws(() => readBoundedFileTail(root, 32), /regular file/);
  for (const bound of [0, -1, Infinity, NaN, 1.5]) assert.throws(() => readBoundedFileTail(path, bound), /positive integer/);
  assert.equal(fs.readFileSync(path, "utf8"), "kept");
}));


test("short native positional reads finish the bounded tail and close its descriptor", t => fixture(async root => {
  assert.ok(fs.existsSync(join(REPO_ROOT, "src/lib/bounded-file-tail.ts")),
    "this source tree must contain the bounded-history implementation");
  const { readBoundedFileTail } = await import("#src/lib/bounded-file-tail.js");
  const path = join(root, "history"); fs.writeFileSync(path, "alpha\nbeta\n");
  const positional = fs.readSync;
  let descriptor: number | undefined;
  let reads = 0;
  const read = t.mock.method(fs, "readSync", ((fd: number, buffer: NodeJS.ArrayBufferView,
    offset: number, length: number, position: number) => {
    descriptor = fd; reads++;
    return positional(fd, buffer, offset, Math.min(length, 2), position);
  }) as typeof fs.readSync);
  syncBuiltinESMExports();
  try {
    assert.equal(readBoundedFileTail(path, 128), "alpha\nbeta\n");
    assert.ok(reads > 1, "the real file required multiple short native reads");
    assert.notEqual(descriptor, undefined);
    assert.throws(() => fs.fstatSync(descriptor!), { code: "EBADF" });
  } finally { read.mock.restore(); syncBuiltinESMExports(); }
}));

test("a history truncated by a real writer refuses partial output and closes its descriptor", t => fixture(async root => {
  assert.ok(fs.existsSync(join(REPO_ROOT, "src/lib/bounded-file-tail.ts")),
    "this source tree must contain the bounded-history implementation");
  const { readBoundedFileTail } = await import("#src/lib/bounded-file-tail.js");
  const path = join(root, "history"); fs.writeFileSync(path, "alpha\nbeta\n");
  const positional = fs.readSync;
  let descriptor: number | undefined;
  let writerRan = false;
  const read = t.mock.method(fs, "readSync", ((...args: Parameters<typeof fs.readSync>) => {
    descriptor = args[0];
    if (!writerRan) { fs.truncateSync(path, 0); writerRan = true; }
    return Reflect.apply(positional, fs, args);
  }) as typeof fs.readSync);
  syncBuiltinESMExports();
  try {
    assert.throws(() => readBoundedFileTail(path, 128), { code: "EIO" });
    assert.equal(writerRan, true, "the writer actually changed the opened file");
    assert.notEqual(descriptor, undefined);
    assert.throws(() => fs.fstatSync(descriptor!), { code: "EBADF" });
  } finally { read.mock.restore(); syncBuiltinESMExports(); }
}));
