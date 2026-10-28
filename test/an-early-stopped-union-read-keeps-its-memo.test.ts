/**
 * AN EARLY-STOPPED MEMOIZED UNION READ KEEPS THE ROTATIONS IT NEVER REACHED.
 *
 * OBSERVED 2026-10-14 on the core daemon (ledger rows, Azure host read-only): the full sweep's credit
 * rung (`readMergeCreditedTaskIdsAsync` over `readLedgerUnionRecordsMemoized`) stopped on the live file
 * at 11:37:33Z (`credit_scan_files_read` 1) because every candidate was already credited there. The
 * memo's `complete()` then kept only the rotations that pass touched, which was none, so the memo
 * was emptied. The next pass at 11:58:54Z had two fresh merges with no credit anywhere, walked every
 * rotation, and reloaded all 393 of them; its summary landed at 12:42:06Z (`credit_scan_files_read`
 * 394) after the core loop had sat frozen from 12:04 to 12:34Z with the container at memory.high.
 * An early stop says nothing about the rotations it did not reach: they are still on disk and still
 * valid, so the memo keeps them. A rotation that has left the directory is still pruned.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { createLedgerRotationMemo, readLedgerUnionRecordsMemoized } from "#src/lib/ledger-union.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const ROTATIONS = [
  "ledger.2026-10-12T00-00-00-000Z.ndjson.gz",
  "ledger.2026-10-13T00-00-00-000Z.ndjson.gz",
  "ledger.2026-10-14T00-00-00-000Z.ndjson.gz",
];

function credit(taskId: string, ts: string): string {
  return JSON.stringify({ ts, run_id: `RUN-${taskId}`, task_id: taskId, step: "verdict.merged", verdict: "merged" });
}

/** Three gzipped rotations, oldest first, each crediting one task, and a live file crediting LIVE. */
function corpus(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}early-stop-memo-`));
  ROTATIONS.forEach((name, i) => {
    writeFileSync(join(dir, name), gzipSync(Buffer.from(credit(`OLD-${i}`, `2026-10-1${2 + i}T01:00:00.000Z`) + "\n")));
  });
  writeFileSync(join(dir, "ledger.ndjson"), credit("LIVE", "2026-10-14T12:00:00.000Z") + "\n");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A memo whose loads are counted: every count is one rotation decompressed and parsed. */
function countingMemo(): { memo: ReturnType<typeof createLedgerRotationMemo>; loads: () => number } {
  let loads = 0;
  const memo = createLedgerRotationMemo((rows) => rows, {
    pattern: /verdict/,
    readFile: async (path) => {
      loads += 1;
      return readFileSync(path);
    },
  });
  return { memo, loads: () => loads };
}

const newestFirst = { liveFirst: true, order: "newest-first" as const, dedupe: false, pattern: /verdict/ };

test("an early-stopped memoized read keeps the rotations it never reached, so the next full walk loads nothing", async () => {
  const { dir, cleanup } = corpus();
  try {
    const { memo, loads } = countingMemo();
    const full = await readLedgerUnionRecordsMemoized(dir, memo, newestFirst);
    assert.equal(loads(), ROTATIONS.length, "the first walk loads every rotation once");
    assert.equal(full.rows.length, ROTATIONS.length + 1);
    // The 11:37:33Z shape: every candidate resolves on the live file, so the walk stops before any rotation.
    const early = await readLedgerUnionRecordsMemoized(dir, memo, {
      ...newestFirst,
      satisfied: (stepsSeen) => stepsSeen.has("verdict.merged"),
    });
    assert.equal(early.filesRead, 1, "the early stop read only the live file");
    assert.equal(memo.size(), ROTATIONS.length, "the rotations it never reached stay memoized");
    // The 11:58:54Z shape: a candidate nothing has credited forces a walk to the oldest rotation.
    const deep = await readLedgerUnionRecordsMemoized(dir, memo, { ...newestFirst, satisfied: () => false });
    assert.equal(deep.filesRead, ROTATIONS.length + 1);
    assert.equal(loads(), ROTATIONS.length, "the deep walk answers every rotation from the memo, reloading none");
    assert.deepEqual(deep.rows.map((r) => r.task_id), ["LIVE", "OLD-2", "OLD-1", "OLD-0"]);
  } finally {
    cleanup();
  }
});

test("a rotation that has left the directory is still pruned from the memo after an early stop", async () => {
  const { dir, cleanup } = corpus();
  try {
    const { memo } = countingMemo();
    await readLedgerUnionRecordsMemoized(dir, memo, newestFirst);
    assert.equal(memo.size(), ROTATIONS.length);
    // Compaction removes the oldest rotation; an early-stopped read must not keep it alive.
    rmSync(join(dir, ROTATIONS[0]!));
    await readLedgerUnionRecordsMemoized(dir, memo, { ...newestFirst, satisfied: (stepsSeen) => stepsSeen.has("verdict.merged") });
    assert.equal(memo.size(), ROTATIONS.length - 1, "only the rotations still listed are kept");
  } finally {
    cleanup();
  }
});

test("a full walk with no early stop still prunes to exactly the rotations it touched", async () => {
  const { dir, cleanup } = corpus();
  try {
    const { memo } = countingMemo();
    await readLedgerUnionRecordsMemoized(dir, memo, newestFirst);
    // A windowed read skips the two older rotations without stopping early: they are not retained.
    await readLedgerUnionRecordsMemoized(dir, memo, { ...newestFirst, since: "2026-10-14T00:00:00.000Z" });
    assert.equal(memo.size(), 1, "a window, unlike an early stop, still sheds what it no longer reads");
  } finally {
    cleanup();
  }
});
