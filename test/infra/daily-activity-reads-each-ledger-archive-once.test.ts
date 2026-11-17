import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { createDailyActivityMemo, readDailyActivity, type DailyProgressInstance } from "#src/lib/daily-progress-collector.js";
import { withTempDir } from "#src/lib/tmp.js";

const REPO = "craigoley/remudero";
const NOW = Date.parse("2026-11-17T17:00:00.000Z");
const SINCE = "2026-11-10T00:00:00.000Z";
const row = (ts: string, step: string, task: string): string => `${JSON.stringify({ ts, step, task_id: task, repository: REPO })}\n`;

/** A state dir with two rotated archives in the window, one before it, and a live ledger. */
function corpus(root: string): { state: string; source: DailyProgressInstance; archiveA: string; archiveB: string; old: string } {
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  const old = join(state, "ledger.2026-11-01T00-00-00-000Z.ndjson.gz");
  const archiveA = join(state, "ledger.2026-11-12T00-00-00-000Z.ndjson.gz");
  const archiveB = join(state, "ledger.2026-11-14T00-00-00-000Z.ndjson.gz");
  writeFileSync(old, gzipSync(row("2026-10-31T10:00:00.000Z", "worker.spawn", "W1-T1")));
  writeFileSync(archiveA, gzipSync(row("2026-11-11T10:00:00.000Z", "worker.spawn", "W1-T2") + row("2026-11-11T11:00:00.000Z", "serve.thread_load", "SERVE")
    + row("2026-11-09T23:00:00.000Z", "pr.opened", "W1-T9")));
  writeFileSync(archiveB, gzipSync(row("2026-11-13T10:00:00.000Z", "pr.opened", "W1-T3")));
  writeFileSync(join(state, "ledger.ndjson"), row("2026-11-16T10:00:00.000Z", "worker.finished", "W1-T4"));
  // Whole-second mtimes: a Date restored by utimes rounds a sub-millisecond mtime, which would read as a rewrite.
  for (const path of [old, archiveA, archiveB]) utimesSync(path, NOW / 1000, NOW / 1000);
  return { state, source: { name: "core", repository: REPO, root, stateDir: state }, archiveA, archiveB, old };
}

/** Overwrite `path` with same-length bytes that are not gzip, keeping its mtime: only a reader that skips it still sees its rows. */
function corruptInPlace(path: string): void {
  const before = statSync(path);
  writeFileSync(path, Buffer.alloc(before.size, 0x41));
  utimesSync(path, before.atime, before.mtime);
}
const titles = (events: Array<{ title: string }>): string[] => events.map((e) => e.title).sort();

test("W1-T13442 criterion 1: a second run reads each rotated archive from the memo and only the live ledger from disk", async () => {
  await withTempDir("daily-activity-memo", async (root) => {
    const { state, source, archiveA, archiveB } = corpus(root);
    const memo = createDailyActivityMemo();
    const first = await readDailyActivity(source, state, SINCE, NOW, undefined, memo);
    assert.deepEqual(titles(first.events), ["Pull request opened · W1-T3", "Worker finished · W1-T4", "Worker started · W1-T2"],
      "positive control: rows inside the window from both archives and the live ledger; the pre-window archive and the row before SINCE are not events");
    assert.equal(first.gaps, 0);
    corruptInPlace(archiveA); corruptInPlace(archiveB);
    appendFileSync(join(state, "ledger.ndjson"), row("2026-11-16T11:00:00.000Z", "fix.dispatch", "W1-T5"));
    const second = await readDailyActivity(source, state, SINCE, NOW, undefined, memo);
    assert.deepEqual(titles(second.events), [...titles(first.events), "Repair attempt recorded · W1-T5"].sort(), "archives came from the memo, the live ledger was read again");
    assert.equal(second.gaps, 0);
    const fresh = await readDailyActivity(source, state, SINCE, NOW, undefined, createDailyActivityMemo());
    assert.ok(fresh.gaps >= 2, `falsifier: without the memo the corrupted archives are read from disk and are gaps (${fresh.gaps})`);
  });
});

test("W1-T13442 criterion 2: an attempt that could not finish keeps the archives it read, and the next attempt reads only the rest", async () => {
  await withTempDir("daily-activity-resume", async (root) => {
    const { state, source, archiveA, archiveB } = corpus(root);
    const good = statSync(archiveB);
    const pristineB = gzipSync(row("2026-11-13T10:00:00.000Z", "pr.opened", "W1-T3"));
    writeFileSync(archiveB, Buffer.from("not gzip at all"));
    const memo = createDailyActivityMemo();
    const failed = await readDailyActivity(source, state, SINCE, NOW, undefined, memo);
    assert.ok(failed.gaps >= 1, "the unreadable archive is a gap this run");
    assert.equal(memo.size, 1, "only the archive read whole is kept");
    writeFileSync(archiveB, pristineB); utimesSync(archiveB, good.atime, new Date(good.mtimeMs + 1000));
    corruptInPlace(archiveA);
    const resumed = await readDailyActivity(source, state, SINCE, NOW, undefined, memo);
    assert.equal(resumed.gaps, 0, "the finished archive was not read again: its corruption is never seen");
    assert.deepEqual(titles(resumed.events), ["Pull request opened · W1-T3", "Worker finished · W1-T4", "Worker started · W1-T2"]);
    assert.equal(memo.size, 2);
  });
});

test("W1-T13442 criterion 3: an archive that leaves the window or is rewritten is dropped or re-read, never served stale", async () => {
  await withTempDir("daily-activity-window", async (root) => {
    const { state, source, archiveB } = corpus(root);
    const memo = createDailyActivityMemo();
    await readDailyActivity(source, state, SINCE, NOW, undefined, memo);
    assert.equal(memo.size, 2, "the two in-window archives are kept; the pre-window one is never read");
    // Rewritten (a compaction): new size, so it is read again.
    writeFileSync(archiveB, gzipSync(row("2026-11-13T10:00:00.000Z", "pr.opened", "W1-T3") + row("2026-11-13T12:00:00.000Z", "verdict", "W1-T6")));
    const rewritten = await readDailyActivity(source, state, SINCE, NOW, undefined, memo);
    assert.ok(titles(rewritten.events).includes("Work status reported · W1-T6"), "the rewritten archive's new row is seen");
    // The window moves past archive A: its entry goes.
    await readDailyActivity(source, state, "2026-11-13T00:00:00.000Z", NOW, undefined, memo);
    assert.equal(memo.size, 1, "an archive no longer in the window is not held");
  });
});

test("W1-T13442 criterion 3: an archive held from a later window is read again for an earlier one, never served short", async () => {
  await withTempDir("daily-activity-memo-since", async (root) => {
    const { state, source } = corpus(root);
    const memo = createDailyActivityMemo();
    const late = await readDailyActivity(source, state, "2026-11-12T00:00:00.000Z", NOW, undefined, memo);
    assert.ok(!titles(late.events).includes("Worker started · W1-T2"), "positive control: the later window leaves out the 2026-11-11 row");
    const early = await readDailyActivity(source, state, SINCE, NOW, undefined, memo);
    assert.ok(titles(early.events).includes("Worker started · W1-T2"), "the earlier window re-reads the archive rather than trusting the shorter memo entry");
  });
});
