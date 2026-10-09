import assert from "node:assert/strict";
import { test } from "node:test";

import * as goals from "../src/lib/goals.js";
import * as carry from "../src/lib/ledger-carry.js";

const PR = "https://github.com/craigoley/remudero/pull/42";
const at = (minute: number) => new Date(Date.UTC(2026, 9, 9, 12, minute)).toISOString();

test("a pr.terminal merged row alone measures pr-flow-minutes for the goal", () => {
  const rows = [
    { ts: at(0), step: "pr.opened", pr_url: PR },
    { ts: at(30), step: "pr.terminal", state: "merged", pr_url: PR, pr_number: 42 },
  ];
  assert.equal(goals.measureGoal("pr-flow-minutes", rows as never), 30);
});

test("a closed pr.terminal row is not a merge in pr-flow-minutes", () => {
  const rows = [
    { ts: at(0), step: "pr.opened", pr_url: PR },
    { ts: at(30), step: "pr.terminal", state: "closed", pr_url: PR, pr_number: 42 },
  ];
  assert.equal(goals.measureGoal("pr-flow-minutes", rows as never), null);
});

test("a PR with both verdict.merged and pr.terminal merged rows counts once at the earliest merge", () => {
  const other = "https://github.com/craigoley/remudero/pull/43";
  const rows = [
    { ts: at(0), step: "pr.opened", pr_url: PR },
    { ts: at(20), step: "verdict.merged", pr_url: PR },
    { ts: at(50), step: "pr.terminal", state: "merged", pr_url: PR, pr_number: 42 },
    { ts: at(0), step: "pr.opened", pr_url: other },
    { ts: at(40), step: "pr.terminal", state: "merged", pr_url: other, pr_number: 43 },
  ];
  // Two PRs: 20 and 40 minutes — the median of two is their mean.
  assert.equal(goals.measureGoal("pr-flow-minutes", rows as never), 30);
});

test("the shared merge-row reader recognises every recorded merge shape and nothing else", () => {
  const isMerged = (carry as Record<string, unknown>).isMergedLedgerRow as ((row: Record<string, unknown>) => boolean) | undefined;
  assert.equal(typeof isMerged, "function", "ledger-carry exports isMergedLedgerRow");
  assert.equal(isMerged!({ step: "verdict.merged" }), true);
  assert.equal(isMerged!({ step: "verdict", verdict: "merged" }), true);
  assert.equal(isMerged!({ step: "pr.terminal", state: "merged" }), true);
  assert.equal(isMerged!({ step: "pr.terminal", state: "closed" }), false);
  assert.equal(isMerged!({ step: "verdict", verdict: "failed" }), false);
});
