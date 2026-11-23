import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createBoardSnapshotCache } from "#src/lib/board-snapshot-cache.js";
import type { BoardIssueRest, BoardPrRest } from "#src/lib/open-prs-rest.js";

const updatedAt = "2026-11-17T00:00:00.000Z";
const closed: BoardPrRest = {
  number: 1, url: "https://github.com/o/r/pull/1", state: "MERGED", headRefName: "branch",
  headRefOid: "sha-1", body: "", title: "Closed PR", updatedAt, autoMergeRequest: null,
};
const issue: BoardIssueRest = { number: 2, url: "https://github.com/o/r/issues/2", state: "open", updatedAt };
const anotherClosed = { ...closed, number: 3, url: "https://github.com/o/r/pull/3" };
const anotherIssue = { ...issue, number: 4, url: "https://github.com/o/r/issues/4" };

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-board-load-refused-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events: Array<{ event: string; reason: unknown }> = [];
  const open = (maxRows: number) => createBoardSnapshotCache(root, "o", "r", {
    bounds: { maxRows },
    log: (event, extra) => events.push({ event, reason: extra?.reason }),
  });
  return { events, open };
}

test("W1-T13104: board_snapshot.load_refused no longer recurs", (t) => {
  const { events, open } = fixture(t);
  const writer = open(2);
  assert.equal(writer.commitClosed([closed]), true);
  assert.equal(writer.commitIssues([issue]), true);

  events.length = 0;
  const committed = [writer.commitIssues([issue, anotherIssue]), writer.commitClosed([closed, anotherClosed])];
  const reader = open(2);
  assert.deepEqual(events, [
    { event: "board_snapshot.commit_refused", reason: "row_limit" },
    { event: "board_snapshot.commit_refused", reason: "row_limit" },
    { event: "board_snapshot.loaded", reason: undefined },
  ]);
  assert.deepEqual(committed, [false, false]);
  for (const cache of [writer, reader]) {
    assert.deepEqual(cache.closedSeed(), new Map([[closed.number, closed]]));
    assert.deepEqual(cache.issueSeed(), new Map([[issue.number, issue]]));
  }
});

test("W1-T13104: the symptom is still recorded when its failure occurs", (t) => {
  const { events, open } = fixture(t);
  const writer = open(3);
  assert.equal(writer.commitClosed([closed]), true);
  assert.equal(writer.commitIssues([issue, anotherIssue]), true);

  events.length = 0;
  const reader = open(2);
  assert.equal(reader.closedSeed(), undefined);
  assert.equal(reader.issueSeed(), undefined);
  assert.deepEqual(events, [{ event: "board_snapshot.load_refused", reason: "row_limit" }]);
});
