import assert from "node:assert/strict";
import { test } from "node:test";
import { BOARD_MAX_PAGES, fetchBoardPrsRest, type GhApiFetcher, type RestPullRow } from "../src/lib/open-prs-rest.js";

/** The closed-PR count this repo had when the cap was raised from 50 pages (5,000 PRs) to 200: 66 full
 *  pages and one of 79 rows. At 50 pages every cold read truncated. */
const CLOSED_PRS_WHEN_RAISED = 6679;
const FULL_PAGE = 100;

function closedRow(n: number): RestPullRow {
  return {
    number: n,
    html_url: `https://github.com/o/r/pull/${n}`,
    state: "closed",
    merged_at: "2026-08-01T00:00:00Z",
    updated_at: `2026-08-01T00:00:${String(n % 60).padStart(2, "0")}Z`,
    head: { ref: `run-W1-T${n}-1` },
    body: "",
    auto_merge: null,
    title: "",
  };
}

/** A closed history of `total` PRs served page by page at the cold-read page size; open is empty. */
function historyOf(total: number, calls: { closed: number }): GhApiFetcher {
  return (args) => {
    const q = String(args[1] ?? "");
    if (q.includes("state=open")) return [];
    calls.closed += 1;
    const page = Number(/[?&]page=(\d+)/.exec(q)?.[1] ?? "1");
    const from = (page - 1) * FULL_PAGE;
    return Array.from({ length: Math.max(0, Math.min(FULL_PAGE, total - from)) }, (_, i) => closedRow(from + i + 1));
  };
}

test("a cold closed read of 6679 closed PRs finishes untruncated", () => {
  const calls = { closed: 0 };
  const result = fetchBoardPrsRest("o", "r", historyOf(CLOSED_PRS_WHEN_RAISED, calls));
  assert.equal(result.truncated, false, "the whole closed history fits under the cap");
  assert.equal(result.rows.length, CLOSED_PRS_WHEN_RAISED, "every closed PR was read");
  assert.equal(calls.closed, 67, "66 full pages and the short page that ends the walk");
});

test("a walk that never reaches a short page stops at BOARD_MAX_PAGES and reports truncation", () => {
  const calls = { closed: 0 };
  const result = fetchBoardPrsRest("o", "r", historyOf(BOARD_MAX_PAGES * FULL_PAGE + 5000, calls));
  assert.equal(result.truncated, true, "the runaway guard still reports a truncated view");
  assert.equal(calls.closed, BOARD_MAX_PAGES, "the closed walk is still bounded, never open-ended");
  assert.equal(result.rows.length, BOARD_MAX_PAGES * FULL_PAGE, "every row inside the bound is still returned");
});

test("BOARD_MAX_PAGES leaves headroom beyond the present closed history", () => {
  assert.ok(
    BOARD_MAX_PAGES * FULL_PAGE >= 2 * CLOSED_PRS_WHEN_RAISED,
    "a cap that only just clears today's closed history truncates again within weeks",
  );
});
