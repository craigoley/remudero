import assert from "node:assert/strict";
import { test } from "node:test";
import { defectEventsOf, fixLaneInventoryOf } from "#src/lib/fix-lane-gardener.js";
import type { LedgerRecord } from "#src/lib/retro.js";

const NOW = Date.UTC(2026, 9, 25, 12);
const at = (hour: number) => new Date(NOW + hour * 3_600_000).toISOString();
const fixed: LedgerRecord = {
  step: "fix.done", ts: at(-6), pr_number: 7, round_id: "repair-7",
  fix_outcome: "FIXED", pushed_head_sha: "fixed-head", worker_tail: "repair-7.tail",
};
const sweep = (hour: number, blocker: string, pr = 7, head = "fixed-head"): LedgerRecord => ({
  step: "sweep.disposed", ts: at(hour), pr_number: pr, head_sha: head, blocker,
  blocker_owner: blocker === "own-red" ? "fix-lane" : "arm", reason: blocker,
});
const defects = (rows: LedgerRecord[]) => defectEventsOf(rows, NOW).filter(e => e.key === "fixed-still-red");

test("W1-T10520: fix-lane-fixed-still-red clears without a person", () => {
  for (const cleared of ["awaiting-arm", "armed-idle", "operator-hold"]) {
    const rows = [fixed, sweep(-5, "awaiting-ci"), sweep(-4, cleared), sweep(-3, "own-red")];
    assert.deepEqual(defects(rows), [], `${cleared} retires the successful repair before a later rerun`);
    const inventory = fixLaneInventoryOf(rows, [], new Map(), { ok: true, interventions: [] }, NOW);
    assert.equal(inventory.priced.some(p => p.key === "fixed-still-red"), false);
    assert.equal(inventory.next?.origin, undefined, "the cleared repair does not file another remedy");
    assert.equal(inventory.interventions.total, 0);
  }
});

test("pending and inconclusive sweeps retain evidence of a repair that really stays red", () => {
  for (const blocker of ["awaiting-ci", "awaiting-review", "other", "base-red"]) {
    const rows = [fixed, sweep(-5, blocker), sweep(-4, "own-red"), sweep(-3, "own-red")];
    assert.deepEqual(defects(rows), [{
      pr: 7, at: Date.parse(at(-4)), key: "fixed-still-red", elapsedMs: undefined,
      evidence: "a FIXED push fixed-hea is still red on the next sweep — worker saw: repair-7.tail",
    }]);
  }
});

test("a different PR or head cannot retire a repair's evidence", () => {
  for (const clearance of [sweep(-5, "awaiting-arm", 8), sweep(-5, "awaiting-arm", 7, "another-head")]) {
    const events = defects([fixed, clearance, sweep(-4, "own-red")]);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.pr, 7);
    assert.equal(events[0]!.at, Date.parse(at(-4)));
  }
  assert.equal(defects([fixed, sweep(-5, "own-red", 8), sweep(-4, "own-red")])[0]!.pr, 7);
});

test("a new repair at the same head is evaluated after a previously cleared round", () => {
  const again = { ...fixed, ts: at(-3), round_id: "repair-again", worker_tail: "repair-again.tail" };
  const events = defects([fixed, sweep(-4, "awaiting-arm"), again, sweep(-2, "own-red")].reverse());
  assert.equal(events.length, 1);
  assert.equal(events[0]!.at, Date.parse(at(-2)));
  assert.match(events[0]!.evidence, /repair-again\.tail/);
});

test("W1-T10781: fix-lane-fixed-still-red clears without a person", () => {
  const original: LedgerRecord = {
    step: "fix.dispatch", ts: at(-7), pr_number: 7, round_id: "repair-7", head_sha: "old-head",
    ci_failures: [{ check: "unit", signature: "a" }],
  };
  const current: LedgerRecord = {
    step: "fix.dispatch", ts: at(-3), pr_number: 7, round_id: "repair-8", head_sha: "fixed-head",
    ci_failures: [{ check: "lint", signature: "b" }],
  };
  const redSweep = sweep(-4, "own-red");
  const all = (rows: LedgerRecord[]) => defectEventsOf(rows, NOW).filter(e => e.key.startsWith("fixed-"));
  assert.equal(redSweep.ci_failures, undefined, "production sweep rows do not carry failing checks");
  assert.deepEqual(all([original, fixed, redSweep, current]).map(e => e.key), ["fixed-new-red"]);
  assert.deepEqual(all([original, fixed, redSweep, { ...current,
    ci_failures: [{ check: "unit", signature: "a" }, { check: "lint", signature: "b" }],
  }]).map(e => e.key), ["fixed-still-red"]);
  assert.deepEqual(all([original, fixed, redSweep]).map(e => e.key), ["fixed-still-red"],
    "an undispatched red remains visible without invented check evidence");
  assert.deepEqual(all([original, fixed, redSweep, { ...current, pr_number: 8 }]).map(e => e.key),
    ["fixed-still-red"], "another PR's dispatch cannot reclassify this one");
  assert.deepEqual(all([original, fixed, redSweep, { ...current, head_sha: "another-head" }]).map(e => e.key),
    ["fixed-still-red"], "another head's dispatch cannot reclassify this one");
});
