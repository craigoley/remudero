import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { boardSnapshotPath, createBoardSnapshotCache } from "#src/lib/board-snapshot-cache.js";
import { fixedClock } from "#src/lib/clock.js";
import type { BoardIssueRest, BoardPrRest } from "#src/lib/open-prs-rest.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// W1-T11266: serve rewrote its 43 MB board snapshot about 23 times an hour on 2026-11-03 and stringified every
// closed and issue row twice per rewrite, the channel that did not change included.

const clock = fixedClock(Date.UTC(2026, 10, 3, 18, 0, 0));
const stamp = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString();

function closed(number: number): BoardPrRest {
  return { number, url: `https://github.com/o/r/pull/${number}`, state: "MERGED", headRefName: `run-W1-T${number}-1`,
    headRefOid: `sha-${number}`, body: `body ${number}`, autoMergeRequest: null, title: `pr ${number}`, updatedAt: stamp(number),
    mergedAt: stamp(number), authorLogin: "remudero-fleet[bot]" };
}

function issue(number: number, title = `issue ${number}`): BoardIssueRest {
  return { number, url: `https://github.com/o/r/issues/${number}`, state: "open", title, updatedAt: stamp(number) };
}

function root(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}board-snapshot-lines-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Counts JSON.stringify calls on snapshot records: header, footer, and closed or issue row lines. */
function countRecordStringifies(t: TestContext): { readonly count: number } {
  const original = JSON.stringify;
  const seen = { count: 0 };
  JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
    const type = value && typeof value === "object" ? (value as { type?: unknown }).type : undefined;
    if (type === "board-snapshot" || type === "complete" || type === "closed" || type === "issues") seen.count++;
    return (original as (v: unknown, ...r: unknown[]) => string)(value, ...rest);
  }) as typeof JSON.stringify;
  t.after(() => { JSON.stringify = original; });
  return seen;
}

const closedRows = Array.from({ length: 30 }, (_, i) => closed(100 + i));
const issueRows = Array.from({ length: 20 }, (_, i) => issue(500 + i));
// A retitle moves updatedAt, as GitHub does; sameVersions skips a commit whose versions are all unchanged.
const changedIssues = issueRows.map((row) => row.number === 507 ? { ...issue(507, "retitled"), updatedAt: stamp(9_999) } : row);

test("board snapshot commit: the bytes equal a fresh cache's for the same state, after reused lines", (t) => {
  const warm = root(t);
  const cache = createBoardSnapshotCache(warm, "o", "r", { clock });
  assert.equal(cache.commitClosed(closedRows), true);
  assert.equal(cache.commitIssues(issueRows), true);
  assert.equal(cache.commitIssues(changedIssues), true);
  const cold = root(t);
  const fresh = createBoardSnapshotCache(cold, "o", "r", { clock });
  assert.equal(fresh.commitClosed(closedRows), true);
  assert.equal(fresh.commitIssues(changedIssues), true);
  const written = readFileSync(boardSnapshotPath(warm, "o", "r"));
  assert.ok(written.includes('"title":"retitled"'), "positive control: the changed row was written");
  assert.deepEqual(written, readFileSync(boardSnapshotPath(cold, "o", "r")));
  assert.deepEqual(createBoardSnapshotCache(warm, "o", "r", { clock }).issueSeed()?.get(507)?.title, "retitled");
});

test("board snapshot commit: each record is stringified once, and one changed issue row costs only its own line", (t) => {
  const cache = createBoardSnapshotCache(root(t), "o", "r", { clock });
  const seen = countRecordStringifies(t);
  assert.equal(cache.commitClosed(closedRows), true);
  assert.equal(seen.count, closedRows.length + 2, "every closed row once, plus the header and footer");
  let before = seen.count;
  assert.equal(cache.commitIssues(issueRows), true);
  assert.equal(seen.count - before, issueRows.length + 2, "the unchanged closed channel reuses its lines");
  before = seen.count;
  assert.equal(cache.commitIssues(changedIssues), true);
  assert.equal(seen.count - before, 3, "the retitled row, the header and the footer");
});

test("board snapshot commit: an oversized or too-long line is still refused before any byte is written", (t) => {
  const small = root(t);
  const events: string[] = [];
  const log = (event: string, extra?: Record<string, unknown>) => events.push(`${event}:${String(extra?.reason ?? "")}`);
  assert.equal(createBoardSnapshotCache(small, "o", "r", { clock, log, bounds: { maxBytes: 2_000 } }).commitClosed(closedRows), false);
  assert.equal(existsSync(boardSnapshotPath(small, "o", "r")), false);
  const narrow = root(t);
  assert.equal(createBoardSnapshotCache(narrow, "o", "r", { clock, log, bounds: { maxLineBytes: 120 } }).commitIssues([issue(1, "x".repeat(200))]), false);
  assert.equal(existsSync(boardSnapshotPath(narrow, "o", "r")), false);
  assert.ok(events.some((e) => e.startsWith("board_snapshot.commit_refused")), `refusals are logged (saw ${events.join(", ")})`);
});
