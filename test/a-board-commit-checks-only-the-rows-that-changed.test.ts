/**
 * W1-T13616: after the write-behind (W1-T13332), serve's board pass still spent 0.14 to 0.16 cores on its request loop
 * in commitClosed and recordClosedAttempt (3.5 to 5.1 s stalls every 2 to 5 minutes on 2026-11-18): it re-validated
 * every closed row's strings and re-serialized every row for the digest, though few rows change between commits.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boardClosedRowsDigest, createBoardSnapshotCache } from "#src/lib/board-snapshot-cache.js";
import { fixedClock } from "#src/lib/clock.js";
import type { BoardPrRest } from "#src/lib/open-prs-rest.js";

const clock = fixedClock(Date.parse("2026-11-18T05:00:00.000Z"));
const pr = (n: number, title = `pr ${n}`, body = `body of ${n} `.repeat(20)): BoardPrRest => ({
  number: n, url: `https://github.com/o/r/pull/${n}`, state: "MERGED", headRefName: `run-W1-T${n}-1`, headRefOid: "a".repeat(40),
  body, title, autoMergeRequest: null, updatedAt: `2026-11-1${n % 8}T00:00:00Z`, mergedAt: `2026-11-1${n % 8}T00:00:00Z`,
}) as BoardPrRest;
const prs = (count: number) => Array.from({ length: count }, (_, i) => pr(i + 1));

function cache(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-board-incremental-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return createBoardSnapshotCache(root, "o", "r", { clock });
}

test("W1-T13616 criterion 1: a commit after one changed row measures only that row's strings", (t) => {
  const c = cache(t);
  const counter = t.mock.method(Buffer, "byteLength");
  assert.equal(c.commitClosed(prs(500)), true);
  const cold = counter.mock.callCount();
  assert.ok(cold >= 500 * 8, `positive control: the first commit validates every row (${cold} byte counts)`);
  counter.mock.resetCalls();
  const rows = prs(500);
  rows[250] = pr(251, "a renamed pull request");
  assert.equal(c.commitClosed(rows), true);
  assert.ok(counter.mock.callCount() <= 20, `only the changed row's strings were measured (${counter.mock.callCount()})`);
});

test("W1-T13616 criterion 2: the memoized digest equals a fresh digest and stringifies only the changed rows", (t) => {
  const memo = new Map();
  const rows = prs(300);
  assert.equal(boardClosedRowsDigest(rows, memo), boardClosedRowsDigest(rows), "the same digest as without a memo");
  rows[10] = pr(11, "changed");
  const stringify = t.mock.method(JSON, "stringify");
  const memoized = boardClosedRowsDigest(rows, memo);
  const calls = stringify.mock.callCount();
  stringify.mock.restore();
  assert.equal(memoized, boardClosedRowsDigest(rows), "a changed row moves the digest exactly as a fresh one");
  assert.equal(calls, 1, "only the changed row was stringified");
});

test("W1-T13616 criterion 3: a changed row that breaks a bound is still refused while the others are reused", (t) => {
  const c = cache(t);
  assert.equal(c.commitClosed(prs(50)), true);
  const rows = prs(50);
  rows[5] = { ...pr(6), body: 42 as never };
  assert.equal(c.commitClosed(rows), false, "the invalid changed row refuses the commit");
  assert.equal(c.commitClosed(prs(50)), true, "positive control: the unchanged rows still commit");
});
