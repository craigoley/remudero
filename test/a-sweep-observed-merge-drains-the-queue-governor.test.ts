import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_SWEEP_POLICY, checkQueueGovernor, deriveQueueGovernorTrailingFlow, type SweepPolicy } from "../src/lib/sweep.js";

// 2026-10-09: no dispatch for ~95 minutes while 8+ PRs merged. The governor logged
// trailing_merged_count 0 because those merges were ledgered only as sweep `pr.terminal` rows
// (state merged); 14:00-15:59Z held 5 such rows and 0 `verdict.merged` rows.

const POLICY: SweepPolicy = { ...DEFAULT_SWEEP_POLICY, queueGovernorFlowWindowMinutes: 60 };
const NOW_MS = Date.parse("2026-10-09T15:35:00Z");
const INSIDE = "2026-10-09T15:10:00Z";

test("a pr.terminal merged row alone counts as a trailing merge", () => {
  const lines = [
    { step: "pr.terminal", state: "merged", pr_number: 10372, ts: INSIDE },
    { step: "pr.terminal", state: "merged", pr_number: 10373, ts: INSIDE },
    { step: "pr.terminal", state: "closed", pr_number: 10380, ts: INSIDE },
    { step: "pr.opened", pr_number: 10384, ts: INSIDE },
  ];
  const flow = deriveQueueGovernorTrailingFlow(lines, NOW_MS, POLICY);
  assert.equal(flow.trailingMergedCount, 2, "two merged PRs; the closed one is not a merge");
  assert.equal(flow.trailingOpenedCount, 1);
});

test("a PR with both a pr.terminal and a verdict.merged row counts once", () => {
  const lines = [
    { step: "pr.terminal", state: "merged", pr_number: 10296, pr_url: "https://github.com/craigoley/remudero/pull/10296", ts: INSIDE },
    { step: "verdict.merged", verdict: "merged", pr_number: 10296, pr_url: "https://github.com/craigoley/remudero/pull/10296", ts: INSIDE },
    { step: "verdict", verdict: "merged", pr_url: "https://github.com/craigoley/remudero/pull/10300", ts: INSIDE },
    { step: "pr.terminal", state: "merged", pr_url: "https://github.com/craigoley/remudero/pull/10300", ts: INSIDE },
    { step: "pr.terminal", state: "merged", pr_number: 10301, ts: INSIDE },
  ];
  assert.equal(deriveQueueGovernorTrailingFlow(lines, NOW_MS, POLICY).trailingMergedCount, 3, "#10296, #10300 and #10301, each once");
});

test("sweep-observed merges outpacing opens admit dispatch at the WIP limit", () => {
  const lines = [
    ...[10367, 10372, 10373, 10375].map((pr_number) => ({ step: "pr.terminal", state: "merged", pr_number, ts: INSIDE })),
    { step: "pr.opened", pr_number: 10384, ts: INSIDE },
  ];
  const flow = deriveQueueGovernorTrailingFlow(lines, NOW_MS, POLICY);
  const verdict = checkQueueGovernor(10, POLICY, { ...flow, foreignOpenCount: 0 });
  assert.equal(verdict.tier, "draining");
  assert.equal(verdict.deferred, false);
});
