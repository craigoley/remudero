/**
 * W1-T13665: on a copy of serve's live board snapshot (14,504 closed rows, 51 MB), the first closed commit after a boot
 * took 494 ms on the loop, and each collection receipt after a commit took 92 to 136 ms: every row was serialized again
 * and all ~50 MB of row JSON was hashed again, though few rows change between commits.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boardClosedCollectionPath, boardClosedRowsDigest, boardSnapshotPath, createBoardSnapshotCache,
  readBoardClosedCollectionReceipt } from "#src/lib/board-snapshot-cache.js";
import { fixedClock } from "#src/lib/clock.js";
import type { BoardIssueRest, BoardPrRest } from "#src/lib/open-prs-rest.js";

const clock = fixedClock(Date.parse("2026-11-18T12:00:00.000Z"));
const pr = (n: number, title = `pr ${n}`): BoardPrRest => ({
  number: n, url: `https://github.com/o/r/pull/${n}`, state: "MERGED", headRefName: `run-W1-T${n}-1`, headRefOid: "a".repeat(40),
  body: `body of ${n} `.repeat(10), title, autoMergeRequest: null, updatedAt: `2026-11-1${n % 8}T00:00:00Z`,
  mergedAt: `2026-11-1${n % 8}T00:00:00Z`,
}) as BoardPrRest;
const prs = (count: number) => Array.from({ length: count }, (_, i) => pr(i + 1));
/** A row GitHub edited: a new title and a new updatedAt, so the commit sees a new version. */
const edited = (n: number, title: string): BoardPrRest => ({ ...pr(n, title), updatedAt: "2026-11-18T11:00:00Z" });

function root(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-board-carry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const open = (dir: string) => createBoardSnapshotCache(dir, "o", "r", { clock });
const file = (dir: string) => readFileSync(boardSnapshotPath(dir, "o", "r"));

/** Counts JSON.stringify calls made by `fn`. */
function stringifies(t: { mock: { method: typeof import("node:test").mock.method } }, fn: () => void): number {
  const spy = t.mock.method(JSON, "stringify");
  try { fn(); return spy.mock.callCount(); } finally { spy.mock.restore(); }
}

test("W1-T13665: the first commit after a load reuses the lines it read and serializes only the changed row", (t) => {
  const dir = root(t);
  assert.equal(open(dir).commitClosed(prs(400)), true);
  const booted = open(dir);
  const rows = prs(400);
  rows[123] = edited(124, "renamed after the boot");
  const calls = stringifies(t as never, () => assert.equal(booted.commitClosed(rows), true));
  assert.ok(calls <= 4, `only the changed row, the header and the footer were serialized (${calls})`);
});

test("W1-T13665: invariant:byte-identical — a file written from carried lines equals one a fresh cache writes", (t) => {
  const carried = root(t), fresh = root(t);
  const rows = prs(120);
  assert.equal(open(carried).commitClosed(rows), true);
  const booted = open(carried);
  rows[7] = edited(8, "changed once");
  assert.equal(booted.commitClosed(rows), true);
  assert.equal(open(fresh).commitClosed(rows), true);
  assert.deepEqual(file(carried), file(fresh));

  // A loaded row whose keys are not in the commit's own order is written fresh, so the bytes still match.
  const path = boardSnapshotPath(carried, "o", "r");
  const reordered = readFileSync(path, "utf8").split("\n").map((line) => {
    if (!line.includes('"type":"closed"')) return line;
    const record = JSON.parse(line) as { type: string; row: Record<string, unknown> };
    const { title, ...rest } = record.row;
    return JSON.stringify({ type: record.type, row: { title, ...rest } });
  }).join("\n");
  writeFileSync(path, reordered);
  rows[9] = edited(10, "changed twice");
  assert.equal(open(carried).commitClosed(rows), true);
  assert.equal(open(fresh).commitClosed(rows), true);
  assert.deepEqual(file(carried), file(fresh));
});

test("W1-T13665: an issues commit carries every closed line without serializing or comparing a closed row", (t) => {
  const dir = root(t);
  const c = open(dir);
  assert.equal(c.commitClosed(prs(300)), true);
  const issues = [{ number: 9001, url: "https://github.com/o/r/issues/9001", title: "an issue", state: "OPEN",
    updatedAt: "2026-11-18T00:00:00Z" }] as unknown as BoardIssueRest[];
  let accepted = false;
  // Each row comparison reads both rows' keys; a carried closed line is reused without one.
  const keys = t.mock.method(Object, "keys");
  const calls = stringifies(t as never, () => { accepted = c.commitIssues(issues); });
  const compared = keys.mock.callCount();
  keys.mock.restore();
  assert.equal(accepted, true);
  assert.ok(calls <= 4, `no closed row was serialized (${calls})`);
  assert.ok(compared < 50, `no closed row was compared again (${compared} key reads for 300 closed rows)`);
  const fresh = root(t);
  assert.equal(open(fresh).commitClosed(prs(300)), true);
  assert.equal(open(fresh).commitIssues(issues), true);
  assert.deepEqual(file(dir), file(fresh), "the carried closed lines are the bytes a fresh write makes");
});

test("W1-T13665: a version 2 receipt hashes only the changed row, and a version 1 receipt still certifies its rows", (t) => {
  const dir = root(t);
  const c = open(dir);
  const rows = prs(200);
  assert.equal(c.commitClosed(rows), true);
  c.recordClosedAttempt?.({ ok: true, truncated: false, persisted: true });
  rows[50] = edited(51, "changed");
  assert.equal(c.commitClosed(rows), true);
  const calls = stringifies(t as never, () => c.recordClosedAttempt?.({ ok: true, truncated: false, persisted: true }));
  assert.ok(calls <= 2, `only the changed row and the receipt were serialized (${calls})`);
  const read = readBoardClosedCollectionReceipt(dir, "o", "r", rows);
  assert.equal(read.ok, true);
  assert.equal(read.ok && read.receipt.version, 2);
  assert.equal(read.ok && read.receipt.rowsDigest, boardClosedRowsDigest(rows));
  assert.equal(readBoardClosedCollectionReceipt(dir, "o", "r", prs(200)).ok, false, "other rows are not certified");

  // A receipt written before W1-T13665: version 1, the hash of every row's whole JSON.
  const legacy = createHash("sha256");
  for (const row of [...rows].sort((a, b) => a.number - b.number)) {
    const { autoMergeRequest: _drop, ...disk } = row as BoardPrRest & { autoMergeRequest: unknown };
    legacy.update(JSON.stringify(disk) + "\n");
  }
  const path = boardClosedCollectionPath(dir, "o", "r");
  const v1 = { ...JSON.parse(readFileSync(path, "utf8")), version: 1, rowsDigest: legacy.digest("hex") };
  writeFileSync(path, JSON.stringify(v1));
  assert.equal(readBoardClosedCollectionReceipt(dir, "o", "r", rows).ok, true);
});
