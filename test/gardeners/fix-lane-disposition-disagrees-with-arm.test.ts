import assert from "node:assert/strict";
import { test } from "node:test";
import { defectEventsOf, fixLaneInventoryOf } from "#src/lib/fix-lane-gardener.js";
import type { LedgerRecord } from "#src/lib/retro.js";

const NOW = Date.UTC(2026, 9, 30, 12);
const at = (minute: number) => new Date(NOW + minute * 60_000).toISOString();
const sweep = (minute: number, extra: Record<string, unknown> = {}): LedgerRecord => ({
  ts: at(minute), step: "sweep.disposed", pr_number: 14407, head_sha: "head", run_id: "prior",
  disposition: "mergeable", acted: true, blocker: "awaiting-arm", blocker_owner: "arm", ...extra,
});
const skipped = (extra: Record<string, unknown> = {}): LedgerRecord => ({
  ts: at(-2), step: "automerge.arm_skipped", pr_number: 14407, head_sha: "head", run_id: "current",
  lane: "sweep", outcome: "plan-pr-held", ...extra,
});
const defects = (rows: LedgerRecord[]) => defectEventsOf(rows, NOW)
  .filter(event => event.key === "disposition-disagrees-with-arm");

test("W1-T10883: fix-lane-disposition-disagrees-with-arm clears without a person", () => {
  for (const outcome of ["plan-pr-held", "direct-merge-preflight-refused"]) {
    const rows = [sweep(-3), skipped({ outcome }), sweep(-1, {
      run_id: "current", acted: false, arm_outcome: outcome, arm_armed: false,
    })];
    assert.deepEqual(defects(rows), [], "a refused attempt does not contradict the prior pass's arm");
    const inventory = fixLaneInventoryOf(rows, [], new Map(), { ok: true, interventions: [] }, NOW);
    assert.equal(inventory.priced.some(price => price.key === "disposition-disagrees-with-arm"), false);
    assert.equal(inventory.next, undefined);
    assert.equal(inventory.interventions.total, 0);
  }
});

test("the latest disposition supersedes an older arming claim in legacy rows", () => {
  assert.deepEqual(defects([
    sweep(-4, { run_id: undefined }), sweep(-3, { run_id: undefined, acted: false }),
    skipped({ run_id: undefined }),
  ]), []);
});

test("acted records handled attempts while concrete arm fields record whether they armed", () => {
  for (const extra of [
    { arm_armed: false }, { arm_outcome: "plan-pr-held" }, { disposition: "wait" },
  ]) {
    assert.deepEqual(defects([skipped(), sweep(-1, { run_id: "current", ...extra })]), []);
  }
  for (const outcome of ["armed", "direct-merged"]) {
    assert.equal(defects([skipped(), sweep(-1, { run_id: "current", arm_outcome: outcome })]).length, 1);
  }
});

test("an actual same-attempt arming contradiction remains actionable", () => {
  const rows = [skipped(), sweep(-1, { run_id: "current" })];
  const events = defects(rows);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.pr, 14407);
  assert.match(events[0]!.evidence, /plan-pr-held/);
  const inventory = fixLaneInventoryOf(rows, [], new Map(), { ok: true, interventions: [] }, NOW);
  assert.equal(inventory.priced[0]!.key, "disposition-disagrees-with-arm");
});

test("another head, run or lane cannot contradict a sweep arm", () => {
  for (const extra of [{ head_sha: "different" }, { run_id: "different" }, { lane: "review" }, { pr_number: 9 }]) {
    assert.deepEqual(defects([sweep(-3, { run_id: "current" }), skipped(extra)]), []);
  }
});

test("legacy contradictions retain the ten minute correlation window", () => {
  assert.equal(defects([sweep(-3, { run_id: undefined }), skipped({ run_id: undefined })]).length, 1);
  assert.deepEqual(defects([sweep(-13, { run_id: undefined }), skipped({ run_id: undefined })]), []);
});
