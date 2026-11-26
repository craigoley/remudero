/**
 * W1-T15005: the Console's PR queue says when the sweep is holding a fix round for a review of the exact head, naming the
 * review run, while that head's review is pending.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeBoardSnapshot, type BoardDeps } from "#src/lib/board.js";
import type { GitHub, PrRef } from "#src/lib/status.js";

const URL = "https://github.com/craigoley/remudero/pull/15005";
const HEAD = "a".repeat(40);
const open: PrRef = { number: 15005, url: URL, state: "OPEN", title: "PR 15005", headRefName: "run-W1-T15005-1", headRefOid: HEAD, body: "" };

function snapshot(lines: Array<Record<string, unknown>>, review = "pending") {
  const github = {
    prByRef: () => open, findMergedByTrailer: () => null, headRefName: () => open.headRefName, prBody: () => "",
    listOpenHeadBranches: () => [open], reviewState: () => review, readFailed: () => false,
    readFailureReason: () => undefined, readTruncated: () => false,
  } as unknown as GitHub;
  const deps: BoardDeps = { plan: { tasks: [], byId: new Map() }, ledgerPath: "/not-read/ledger.ndjson", github, readLedger: () => lines };
  return computeBoardSnapshot(deps).prQueue.rows.find((row) => row.prNumber === 15005)!;
}

const disposed = { step: "sweep.disposed", pr_number: 15005, pr_url: URL, head_sha: HEAD, disposition: "blocked-fixable", reason: "CI red", ts: "2026-11-26T16:00:00.000Z" };
const deferred = (head = HEAD) => ({ step: "sweep.fix_deferred_review_in_flight", pr_number: 15005, head, review_run: "review-PR15005-1", ts: "2026-11-26T16:01:00.000Z" });

test("W1-T15005: the Console PR queue names the review a deferred fix round waits on", () => {
  assert.equal(snapshot([disposed]).reason, "CI red", "positive control: no deferral, the sweep's reason alone");
  assert.equal(snapshot([disposed, deferred()]).reason, "CI red; fix waiting on review review-PR15005-1", "THE CLAIM: the wait is shown");
  assert.equal(snapshot([disposed, deferred("b".repeat(40))]).reason, "CI red", "a deferral at another head says nothing about this one");
  assert.equal(snapshot([disposed, deferred()], "failure").reason, "CI red", "the wait ends once the head's review has a verdict");
});
