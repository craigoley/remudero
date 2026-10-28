import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_SWEEP_POLICY, deriveDisposition, type OpenPrView } from "#test/helpers/sweep-test.js";
import { checkRunsRestArgs } from "#src/lib/open-prs-rest.js";

function redPr(activityMs: number): OpenPrView {
  return {
    prNumber: 2612,
    prUrl: "https://github.com/craigoley/remudero/pull/2612",
    taskId: "W1-TX",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(activityMs).toISOString(),
    headSha: "e97690b0e97690b0e97690b0e97690b0e97690b0",
    headRefName: "run-W1-TX-1785378652634",
    autoMergeArmed: false,
  };
}

test("W1-T10684: check:test:test/stale-ci-gate-wiring.test.ts:flaky is prevented, not retried", () => {
  // The flake: the end-to-end suite stamped the PR from the wall clock but ran the sweep at a
  // pinned past instant, so the PR's activity lay in the sweep's future. A fixture and a sweep
  // clock that share ONE instant must give the same disposition wherever that instant falls.
  assert.equal(checkRunsRestArgs("o", "r", "abc")[0], "api");
  const dispositions = new Set<string>();
  for (const now of [Date.now(), Date.parse("2026-08-26T18:16:00.000Z"), Date.now() + 90 * 86_400_000]) {
    const result = deriveDisposition(redPr(now - 60 * 60 * 1000), DEFAULT_SWEEP_POLICY, now);
    dispositions.add(result.disposition);
  }
  assert.equal(dispositions.size, 1, `disposition must not depend on the calendar: ${[...dispositions].join(",")}`);
  assert.equal([...dispositions][0], "blocked-fixable", "a fresh red PR routes to the fix rung");
});
