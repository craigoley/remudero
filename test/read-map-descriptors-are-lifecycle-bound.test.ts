import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { buildReadMap, readMapProblem, readReadMap, readReadRecords, selectAffectedSuites } from "../src/lib/affected-suites.js";
import { installReadMap, recordFileName } from "./setup/read-map.js";

const bytes = Buffer.from("descriptor control\n");
const suite = "test/descriptor-fixture.test.ts";
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-read-descriptor-"));
  writeFileSync(join(root, "input.json"), bytes);
  return root;
};

test("descriptor read mapping observes real sync callback promise and FileHandle reads without changing bytes", async () => {
  const root = fixture();
  const map = await installReadMap({ root, suite, dir: join(root, "records") });
  try {
    let fd = fs.openSync(join(root, "input.json"), "r");
    assert.deepEqual(fs.readFileSync(fd), bytes); fs.closeSync(fd);
    fd = await promisify(fs.open)(join(root, "input.json"), "r");
    const buffer = Buffer.alloc(bytes.length);
    const result = await promisify(fs.read)(fd, buffer, 0, bytes.length, 0);
    assert.equal(result.bytesRead, bytes.length); assert.deepEqual(result.buffer, bytes); fs.closeSync(fd);
    const handle = await fs.promises.open(join(root, "input.json"), "r");
    assert.deepEqual(await handle.readFile(), bytes); await handle.close();
    const vector = await fs.promises.open(join(root, "input.json"), "r");
    const part = Buffer.alloc(bytes.length);
    assert.equal((await vector.readv([part], 0)).bytesRead, bytes.length); assert.deepEqual(part, bytes); await vector.close();
    assert.deepEqual(map.recorder.snapshot().reads, ["input.json"]);
    assert.equal(map.recorder.snapshot().unknownDescriptors, false);
    map.flush();
    assert.equal(readReadRecords(join(root, "records")).records[0]!.unknownDescriptors, false);
  } finally { map.restore(); rmSync(root, { recursive: true, force: true }); }
});

test("pre-existing numeric and FileHandle descriptors cannot become trusted empty read maps", async () => {
  const root = fixture(), path = join(root, "input.json");
  const fd = fs.openSync(path, "r"), handle = await fs.promises.open(path, "r");
  const map = await installReadMap({ root, suite, dir: join(root, "records") });
  try {
    assert.deepEqual(fs.readFileSync(fd), bytes);
    assert.deepEqual(await handle.readFile(), bytes);
    assert.equal(map.recorder.snapshot().unknownDescriptors, true);
    const merged = buildReadMap([map.recorder.snapshot()], { sha: "a".repeat(40) });
    const input = { map: merged, drift: { distance: 0, changedSinceMap: [] } };
    assert.match(readMapProblem(input)!, /descriptor coverage is incomplete/);
    const selection = selectAffectedSuites(["input.json"], { files: new Map([[suite, "export {};\n"]]), pathReaders: [], readMap: input });
    assert.equal(selection.fullRun, true);
  } finally { fs.closeSync(fd); await handle.close(); map.restore(); rmSync(root, { recursive: true, force: true }); }
});

test("cached unobserved fd replacement is detected by inode identity instead of being credited to its old pathname", async () => {
  const root = fixture(), rawOpen = fs.openSync, rawClose = fs.closeSync;
  writeFileSync(join(root, "other.json"), "replacement\n");
  const map = await installReadMap({ root, suite, dir: join(root, "records") });
  let fd: number | undefined;
  try {
    fd = fs.openSync(join(root, "input.json"), "r"); rawClose(fd);
    const reused = rawOpen(join(root, "other.json"), "r");
    assert.equal(reused, fd, "the real kernel reused the closed descriptor for this replacement control"); fd = reused;
    assert.equal(fs.readFileSync(fd, "utf8"), "replacement\n");
    assert.equal(map.recorder.snapshot().unknownDescriptors, true);
  } finally { if (fd !== undefined) rawClose(fd); map.restore(); rmSync(root, { recursive: true, force: true }); }
});

test("stream fd overrides cannot credit the ignored pathname and automatic close cannot leave a reusable alias", async () => {
  const root = fixture(), rawOpen = fs.openSync;
  const map = await installReadMap({ root, suite, dir: join(root, "records") });
  let fd: number | undefined;
  try {
    fd = fs.openSync(join(root, "input.json"), "r");
    const stream = fs.createReadStream(join(root, "ignored.json"), { fd });
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), bytes); fd = undefined;
    assert.deepEqual(map.recorder.snapshot().reads, ["input.json"]);
    fd = rawOpen(join(root, "input.json"), "r");
    assert.deepEqual(fs.readFileSync(fd), bytes);
    // The stream's native auto-close can bypass public close; an unknown later descriptor must fail closed.
    assert.equal(map.recorder.snapshot().unknownDescriptors, true);
  } finally { if (fd !== undefined) fs.closeSync(fd); map.restore(); rmSync(root, { recursive: true, force: true }); }
});

test("unknown descriptor evidence stays sticky across retries and legacy records never acquire v2 completeness", async () => {
  const root = fixture(), dir = join(root, "records");
  const first = await installReadMap({ root, suite, dir });
  first.recorder.unknown(); first.flush(); first.restore();
  const second = await installReadMap({ root, suite, dir });
  try { second.flush(); assert.equal(readReadRecords(dir).records[0]!.unknownDescriptors, true); }
  finally { second.restore(); }
  writeFileSync(join(dir, recordFileName(suite)), JSON.stringify({ format: "rmd-read-record-v1", suite, reads: [], listed: [] }));
  const third = await installReadMap({ root, suite, dir });
  try { third.flush(); assert.equal(readReadRecords(dir).records[0]!.unknownDescriptors, true); }
  finally { third.restore(); rmSync(root, { recursive: true, force: true }); }
});

test("legacy or malformed descriptor coverage is not a qualified map", () => {
  const old = { format: "rmd-read-map-v1", sha: "a".repeat(40), suites: [suite], reads: {}, listed: {} };
  assert.match(readReadMap("fixture", () => JSON.stringify(old)).problem!, /is not a rmd-read-map-v2/);
  const merged = buildReadMap([{ suite, reads: [], listed: [] }], { sha: "a".repeat(40) });
  assert.match(readMapProblem({ map: merged, drift: { distance: 0, changedSinceMap: [] } })!, /descriptor coverage is incomplete/);
});

test("unknown descriptors propagate through map union to a named full-run fallback", () => {
  const merged = buildReadMap([
    { suite, reads: [], listed: [], unknownDescriptors: false },
    { suite, reads: [], listed: [], unknownDescriptors: true },
  ], { sha: "a".repeat(40) });
  const selection = selectAffectedSuites(["deploy/descriptor.json"], {
    files: new Map([[suite, "export {};\n"]]), pathReaders: [],
    readMap: { map: merged, drift: { distance: 0, changedSinceMap: [] } },
  });
  assert.equal(selection.fullRun, true);
  assert.match(selection.readMapFallback!, /descriptor coverage is incomplete/);
});

test("a refused native open preserves its error and read bytes after restoration use original APIs", async () => {
  const root = fixture(), original = fs.openSync;
  const map = await installReadMap({ root, suite, dir: join(root, "records") });
  try { assert.throws(() => fs.openSync(join(root, "missing.json"), "r"), { code: "ENOENT" }); }
  finally { map.restore(); }
  assert.equal(fs.openSync, original); assert.deepEqual(readFileSync(join(root, "input.json")), bytes);
  rmSync(root, { recursive: true, force: true });
});
