import assert from "node:assert/strict";
import { test } from "node:test";
import { fixLaneInventoryOf, type OperatorIntervention } from "#src/lib/fix-lane-gardener.js";
import type { LedgerRecord } from "#src/lib/retro.js";

const NOW = Date.UTC(2026, 9, 24, 17);
const at = (minute: number) => new Date(NOW + minute * 60_000).toISOString();
const push: OperatorIntervention = {
  pr: 10350, at: at(-2), kind: "push", actor: "cao825", detail: "hand repair", ref: "b96cfc011",
};
const defect: LedgerRecord = {
  step: "fix.stood_down", pr_number: push.pr, ts: at(-4),
  site: "rung.empty_ci_failures", outcome: "no_action", reason: "no failing test found",
};
const wait: LedgerRecord = {
  step: "sweep.disposed", pr_number: push.pr, ts: at(-3),
  blocker: "awaiting-ci", blocker_owner: "ci", reason: "checks pending review never posted running",
};
const WAIT_KEY = "awaiting-ci:ci:checks-pending-review-never-posted-runni";
const DEFECT_KEY = "red-no-actionable-test";

const assess = (records: readonly LedgerRecord[]) =>
  fixLaneInventoryOf(records, [], new Map(), { ok: true, interventions: [push] }, NOW).interventions;

test("W1-T12133 criterion 2: a hand push is routed and charged to the newest preceding fix-lane defect", () => {
  const olderDefect = { ...defect, ts: at(-5), site: "rung.older" };
  const laterDefect = { ...defect, ts: at(-1), site: "rung.later" };
  const { byClass, fresh } = assess([olderDefect, defect, wait, laterDefect]);
  assert.deepEqual([...byClass], [[DEFECT_KEY, 1]]);
  assert.deepEqual(fresh.map(row => row.cause_class), [...byClass.keys()]);
});

test("W1-T12133 criterion 3: without a preceding defect on the PR, use the sweep cause at the push", () => {
  const otherPrDefect = { ...defect, pr_number: push.pr + 1 };
  const laterDefect = { ...defect, ts: at(-1) };
  const earlierSweep = { ...wait, ts: at(-5), blocker: "own-red", blocker_owner: "fix-lane" };
  const laterSweep = { ...wait, ts: at(-1), blocker: "awaiting-arm", blocker_owner: "arm" };
  const defects = [otherPrDefect, laterDefect];
  const disposed = assess([...defects, earlierSweep, wait, laterSweep]);
  assert.deepEqual([...disposed.byClass], [[WAIT_KEY, 1]]);
  assert.deepEqual(disposed.fresh.map(row => row.cause_class), [WAIT_KEY]);

  const undisposed = assess([...defects, laterSweep]);
  assert.deepEqual([...undisposed.byClass], [["undisposed:none", 1]]);
  assert.deepEqual(undisposed.fresh.map(row => row.cause_class), ["undisposed:none"]);
});

test("W1-T12133 criterion 4: an existing sweep-classed row stays deduped", () => {
  const recorded = Object.freeze({
    step: "operator.intervention", ts: at(-1), at: push.at,
    surface: "pr", action: push.kind, target: "pr#10350@b96cfc011",
    intervention_actor: push.actor, cause_class: WAIT_KEY, source: "github",
  });
  const { byClass, fresh } = assess([defect, wait, recorded]);
  assert.deepEqual([...byClass], [[DEFECT_KEY, 1]]);
  assert.deepEqual(fresh, []);
  assert.equal(recorded.cause_class, WAIT_KEY);
});
