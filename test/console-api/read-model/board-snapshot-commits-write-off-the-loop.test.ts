/**
 * W1-T13332: serve's board pass committed the closed-PR and issue snapshot about 52 times an hour on 2026-11-17, each a
 * synchronous write, fsync and rename on serve's request loop (writeBuffer was 712 ms of self time inside main-thread
 * stalls). With writeBehind the rows are committed in memory at once and the file is written behind the caller.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { boardObservationPath, boardSnapshotPath, createBoardSnapshotCache, writeSnapshotFileAsync } from "#src/lib/board-snapshot-cache.js";
import { fixedClock } from "#src/lib/clock.js";
import type { BoardIssueRest, BoardPrRest } from "#src/lib/open-prs-rest.js";

type Ctx = { after: (fn: () => void) => void };
const clock = fixedClock(Date.parse("2026-11-17T18:00:00.000Z"));
const TAGS = ["a", "first", "second", "third", "fourth", "seeded"];
/** A row whose version (its updatedAt) changes with `tag`, so each tag is a real change to commit. */
const issue = (n: number, tag = "a"): BoardIssueRest => ({ number: n, url: `https://github.com/o/r/issues/${n}`, state: "open", title: `needs human ${n} ${tag}`,
  updatedAt: `2026-11-17T0${n % 10}:${String(TAGS.indexOf(tag)).padStart(2, "0")}:00Z` });
const issues = (count: number, tag = "a") => Array.from({ length: count }, (_, i) => issue(i + 1, tag));
const closed = (n: number, tag: string): BoardPrRest => ({ number: n, url: `https://github.com/o/r/pull/${n}`, state: "MERGED",
  headRefName: `run-W1-T${n}-1700000000000`, headRefOid: `sha-${n}`, body: `Remudero-Task: W1-T${n}`, autoMergeRequest: null, title: `merged ${n} ${tag}`,
  updatedAt: `2026-11-17T0${n % 10}:${String(TAGS.indexOf(tag)).padStart(2, "0")}:00Z` });

function root(t: Ctx): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-board-write-behind-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A write-behind seam that records when it runs and lets the test decide when the real write proceeds. */
function gatedWriter() {
  const calls: Array<{ stage: string; path: string; release: () => void; done: Promise<void> }> = [];
  const callWaiters: Array<() => void> = [];
  const waitForCall = async (count: number): Promise<void> => {
    while (calls.length < count) await new Promise<void>((resolve) => callWaiters.push(resolve));
  };
  const write = (stage: string, path: string, buffers: readonly Buffer[]) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const done = gate.then(() => writeSnapshotFileAsync(stage, path, buffers));
    calls.push({ stage, path, release, done });
    for (const resolve of callWaiters.splice(0)) resolve();
    return done;
  };
  return { write, calls, waitForCall };
}

test("W1-T13332 criterion 1: a 30,000-row commit returns before any write, and the file then equals a synchronous commit's", async (t) => {
  const rows = issues(30_000);
  const syncRoot = root(t), behindRoot = root(t);
  assert.equal(createBoardSnapshotCache(syncRoot, "o", "r", { clock }).commitIssues(rows), true);
  const writer = gatedWriter();
  const cache = createBoardSnapshotCache(behindRoot, "o", "r", { clock, writeBehind: { write: writer.write } });
  assert.equal(cache.commitIssues(rows), true);
  assert.equal(writer.calls.length, 0, "no write started on the committing turn");
  assert.equal(existsSync(boardSnapshotPath(behindRoot, "o", "r")), false, "nothing on disk yet");
  await writer.waitForCall(1);
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
  await writer.waitForCall(1);
  cache.commitIssues(issues(50, "second"));
  cache.commitIssues(issues(50, "third"));
  assert.equal(writer.calls.length, 1, "one write in flight; later commits wait behind it");
  writer.calls[0]!.release();
  await writer.calls[0]!.done;
  await writer.waitForCall(2);
  assert.equal(writer.calls.length, 2, "the queued commits collapse into one more write");
  writer.calls[1]!.release();
  await writer.calls[1]!.done;
  const file = readFileSync(boardSnapshotPath(dir, "o", "r"), "utf8");
  assert.match(file, /needs human 1 third/);
  assert.doesNotMatch(file, /second/, "the replaced commit was never written");
  // A write that fails after its stage file exists (a crash before the rename) leaves the published file untouched.
  let refuse!: () => void;
  const refused = new Promise<void>((resolve) => { refuse = resolve; });
  const failing = createBoardSnapshotCache(dir, "o", "r", { clock, log: (event) => {
    if (event === "board_snapshot.commit_refused") refuse();
  }, writeBehind: { write: async (stage, _path, buffers) => {
    writeFileSync(stage, Buffer.concat([...buffers]));
    throw new Error("disk full before the rename");
  } } });
  failing.commitIssues(issues(50, "fourth"));
  await refused;
  assert.match(readFileSync(boardSnapshotPath(dir, "o", "r"), "utf8"), /third/, "the earlier file is intact");
  assert.deepEqual(readdirSync(dirname(boardSnapshotPath(dir, "o", "r"))).filter((f) => f.includes(".tmp-")), [], "no stage file is left");
});

test("writeSnapshotFileAsync rethrows a write error after close, even when close also fails", async (t) => {
  const dir = root(t), stage = join(dir, "snapshot.tmp"), path = join(dir, "snapshot.json");
  const writeError = new Error("write failed"), closeError = new Error("close failed");
  const realOpen = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await realOpen(...args);
    const realClose = handle.close.bind(handle);
    t.mock.method(handle, "write", async () => { throw writeError; });
    t.mock.method(handle, "close", async () => { await realClose(); throw closeError; });
    return handle;
  });

  await assert.rejects(writeSnapshotFileAsync(stage, path, [Buffer.from("snapshot")]), (error) => error === writeError);
  assert.equal(existsSync(stage), false, "the stage is removed after the write fails");
});

test("writeSnapshotFileAsync preserves a write error when stage cleanup fails", async (t) => {
  const dir = root(t), stage = join(dir, "snapshot.tmp"), path = join(dir, "snapshot.json");
  const writeError = new Error("write failed"), unlinkError = new Error("unlink failed");
  const realOpen = fs.promises.open.bind(fs.promises), realUnlink = fs.promises.unlink.bind(fs.promises);
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await realOpen(...args);
    t.mock.method(handle, "write", async () => { throw writeError; });
    return handle;
  });
  t.mock.method(fs.promises, "unlink", async () => { throw unlinkError; });

  try {
    await assert.rejects(writeSnapshotFileAsync(stage, path, [Buffer.from("snapshot")]), (error) => error === writeError);
    assert.equal(existsSync(stage), true, "failed cleanup leaves the stage for the caller to diagnose");
  } finally {
    t.mock.restoreAll();
    await realUnlink(stage).catch(() => {});
  }
});

test("writeSnapshotFileAsync preserves a rename error when stage cleanup fails", async (t) => {
  const dir = root(t), stage = join(dir, "snapshot.tmp"), path = join(dir, "snapshot.json");
  const renameError = new Error("rename failed"), unlinkError = new Error("unlink failed");
  const realUnlink = fs.promises.unlink.bind(fs.promises);
  t.mock.method(fs.promises, "rename", async () => { throw renameError; });
  t.mock.method(fs.promises, "unlink", async () => { throw unlinkError; });

  try {
    await assert.rejects(writeSnapshotFileAsync(stage, path, [Buffer.from("snapshot")]), (error) => error === renameError);
    assert.equal(existsSync(stage), true, "failed cleanup leaves the stage for the caller to diagnose");
  } finally {
    t.mock.restoreAll();
    await realUnlink(stage).catch(() => {});
  }
});

test("a repeated closed commit while its replacement is writing does not certify the old file", async (t) => {
  const dir = root(t), writer = gatedWriter();
  const first = createBoardSnapshotCache(dir, "o", "r", { clock });
  assert.equal(first.commitClosed([closed(1, "first")]), true);
  const cache = createBoardSnapshotCache(dir, "o", "r", { clock, writeBehind: { write: writer.write } });
  const next = [closed(1, "second")];
  assert.equal(cache.commitClosed(next), true);
  await writer.waitForCall(1);
  assert.equal(cache.commitClosed(next), true, "the unchanged commit is accepted while the write is in flight");
  assert.equal(existsSync(boardObservationPath(dir, "o", "r")), false, "the old on-disk identity is not certified");
  writer.calls[0]!.release();
  await writer.calls[0]!.done;
});

test("an unchanged commit retries a failed queued write after cleanup refusal", async (t) => {
  const dir = root(t), target = boardSnapshotPath(dir, "o", "r");
  const unlinkError = new Error("cleanup failed"), realUnlink = fs.promises.unlink.bind(fs.promises);
  let stage = "", writes = 0, signalRefusal!: () => void, signalCommit!: () => void;
  const unlinkAttempts: string[] = [];
  const refused = new Promise<void>((resolve) => { signalRefusal = resolve; });
  const committed = new Promise<void>((resolve) => { signalCommit = resolve; });
  const rows = issues(2, "fourth");
  t.mock.method(fs.promises, "unlink", async (path: Parameters<typeof fs.promises.unlink>[0]) => {
    const target = String(path);
    unlinkAttempts.push(target);
    if (target.includes(".tmp-")) throw unlinkError;
    return realUnlink(path);
  });
  const cache = createBoardSnapshotCache(dir, "o", "r", {
    clock,
    log: (event) => {
      if (event === "board_snapshot.commit_refused") signalRefusal();
      if (event === "board_snapshot.committed") signalCommit();
    },
    writeBehind: { write: async (nextStage, path, buffers) => {
      writes++;
      if (writes === 1) {
        stage = nextStage;
        fs.mkdirSync(dirname(stage), { recursive: true });
        writeFileSync(stage, Buffer.concat([...buffers]));
        throw new Error("write failed");
      }
      await writeSnapshotFileAsync(nextStage, path, buffers);
    } },
  });

  try {
    assert.equal(cache.commitIssues(rows), true);
    await refused;
    assert.deepEqual(unlinkAttempts, [stage], "the queued write attempts to remove its stage");
    assert.equal(existsSync(stage), true, "the failed cleanup is observed and the stage remains for diagnosis");
    assert.equal(cache.commitIssues(rows), true, "an unchanged commit retries the previous failure");
    await committed;
    assert.equal(writes, 2);
    assert.match(readFileSync(target, "utf8"), /needs human 1 fourth/);
  } finally {
    t.mock.restoreAll();
    if (stage) await realUnlink(stage).catch(() => {});
  }
});

test("W1-T13332 criterion 3: seeds answer the committed rows at once, while the write is still in flight", async (t) => {
  const writer = gatedWriter();
  const cache = createBoardSnapshotCache(root(t), "o", "r", { clock, writeBehind: { write: writer.write } });
  cache.commitIssues(issues(3, "seeded"));
  await writer.waitForCall(1);
  assert.equal(writer.calls.length, 1);
  const seed = cache.issueSeed();
  assert.deepEqual([...(seed?.values() ?? [])].map((row) => row.number), [1, 2, 3], "the committed rows, before the file exists");
  assert.equal(seed?.get("https://github.com/o/r/issues/2")?.title, "needs human 2 seeded");
  writer.calls[0]!.release();
  await writer.calls[0]!.done;
});
