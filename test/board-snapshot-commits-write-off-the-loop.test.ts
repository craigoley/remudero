/**
 * W1-T13332: serve's board pass committed the closed-PR and issue snapshot about 52 times an hour on 2026-11-17, each a
 * synchronous write, fsync and rename on serve's request loop (writeBuffer was 712 ms of self time inside main-thread
 * stalls). With writeBehind the rows are committed in memory at once and the file is written behind the caller.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { boardSnapshotPath, createBoardSnapshotCache, writeSnapshotFileAsync } from "#src/lib/board-snapshot-cache.js";
import { fixedClock } from "#src/lib/clock.js";
import type { BoardIssueRest } from "#src/lib/open-prs-rest.js";

type Ctx = { after: (fn: () => void) => void };
const clock = fixedClock(Date.parse("2026-11-17T18:00:00.000Z"));
const TAGS = ["a", "first", "second", "third", "fourth", "seeded"];
/** A row whose version (its updatedAt) changes with `tag`, so each tag is a real change to commit. */
const issue = (n: number, tag = "a"): BoardIssueRest => ({ number: n, url: `https://github.com/o/r/issues/${n}`, state: "open", title: `needs human ${n} ${tag}`,
  updatedAt: `2026-11-17T0${n % 10}:${String(TAGS.indexOf(tag)).padStart(2, "0")}:00Z` });
const issues = (count: number, tag = "a") => Array.from({ length: count }, (_, i) => issue(i + 1, tag));

function root(t: Ctx): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-board-write-behind-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A write-behind seam that records when it runs and lets the test decide when the real write proceeds. */
function gatedWriter() {
  const calls: Array<{ stage: string; path: string; release: () => void; done: Promise<void> }> = [];
  const write = (stage: string, path: string, buffers: readonly Buffer[]) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const done = gate.then(() => writeSnapshotFileAsync(stage, path, buffers));
    calls.push({ stage, path, release, done });
    return done;
  };
  return { write, calls };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

test("W1-T13332 criterion 1: a 30,000-row commit returns before any write, and the file then equals a synchronous commit's", async (t) => {
  const rows = issues(30_000);
  const syncRoot = root(t), behindRoot = root(t);
  assert.equal(createBoardSnapshotCache(syncRoot, "o", "r", { clock }).commitIssues(rows), true);
  const writer = gatedWriter();
  const cache = createBoardSnapshotCache(behindRoot, "o", "r", { clock, writeBehind: { write: writer.write } });
  assert.equal(cache.commitIssues(rows), true);
  assert.equal(writer.calls.length, 0, "no write started on the committing turn");
  assert.equal(existsSync(boardSnapshotPath(behindRoot, "o", "r")), false, "nothing on disk yet");
  await settle();
  assert.equal(writer.calls.length, 1, "the write runs after the caller's turn");
  writer.calls[0]!.release();
  await writer.calls[0]!.done;
  assert.deepEqual(readFileSync(boardSnapshotPath(behindRoot, "o", "r")), readFileSync(boardSnapshotPath(syncRoot, "o", "r")), "byte for byte a synchronous commit's file");
});

test("W1-T13332 criterion 2: quick commits leave the latest on disk, one write at a time, and a failed write leaves the earlier file", async (t) => {
  const dir = root(t);
  const writer = gatedWriter();
  const cache = createBoardSnapshotCache(dir, "o", "r", { clock, writeBehind: { write: writer.write } });
  cache.commitIssues(issues(50, "first"));
  await settle();
  cache.commitIssues(issues(50, "second"));
  cache.commitIssues(issues(50, "third"));
  await settle();
  assert.equal(writer.calls.length, 1, "one write in flight; later commits wait behind it");
  writer.calls[0]!.release();
  await writer.calls[0]!.done;
  await settle();
  assert.equal(writer.calls.length, 2, "the queued commits collapse into one more write");
  writer.calls[1]!.release();
  await writer.calls[1]!.done;
  const file = readFileSync(boardSnapshotPath(dir, "o", "r"), "utf8");
  assert.match(file, /needs human 1 third/);
  assert.doesNotMatch(file, /second/, "the replaced commit was never written");
  // A write that fails after its stage file exists (a crash before the rename) leaves the published file untouched.
  const failing = createBoardSnapshotCache(dir, "o", "r", { clock, writeBehind: { write: async (stage, _path, buffers) => {
    writeFileSync(stage, Buffer.concat([...buffers]));
    throw new Error("disk full before the rename");
  } } });
  failing.commitIssues(issues(50, "fourth"));
  await settle();
  assert.match(readFileSync(boardSnapshotPath(dir, "o", "r"), "utf8"), /third/, "the earlier file is intact");
  assert.deepEqual(readdirSync(dirname(boardSnapshotPath(dir, "o", "r"))).filter((f) => f.includes(".tmp-")), [], "no stage file is left");
});

test("W1-T13332 criterion 3: seeds answer the committed rows at once, while the write is still in flight", async (t) => {
  const writer = gatedWriter();
  const cache = createBoardSnapshotCache(root(t), "o", "r", { clock, writeBehind: { write: writer.write } });
  cache.commitIssues(issues(3, "seeded"));
  await settle();
  assert.equal(writer.calls.length, 1);
  const seed = cache.issueSeed();
  assert.deepEqual([...(seed?.keys() ?? [])], [1, 2, 3], "the committed rows, before the file exists");
  assert.equal(seed?.get(2)?.title, "needs human 2 seeded");
  writer.calls[0]!.release();
  await writer.calls[0]!.done;
});
