import assert from "node:assert/strict";
import { test } from "node:test";
import { defectEventsOf } from "#src/lib/fix-lane-gardener.js";
import type { LedgerRecord } from "#src/lib/retro.js";

const NOW = Date.UTC(2026, 10, 20);
const at = (hour: number) => new Date(NOW + hour * 3_600_000).toISOString();
const reds = [
  { check: "coverage-ratchet", signature: "uncovered added line" },
  { check: "remudero-review" },
];
const dispatch = (round: string, hour: number, ci_failures = reds): LedgerRecord => ({
  step: "fix.dispatch", pr_number: 14013, round_id: round, ts: at(hour), ci_failures,
});
const fixed = (round: string, hour: number): LedgerRecord => ({
  step: "fix.done", pr_number: 14013, round_id: round, ts: at(hour), fix_outcome: "FIXED",
});
const repeats = (rows: LedgerRecord[]) => defectEventsOf(rows, NOW).filter(e => e.key === "same-red-set");

test("test/gardeners/fix-lane-same-red-set.test.ts: duplicate dispatch receipts do not count as consecutive rounds", () => {
  const first = dispatch("first", -6);
  const second = dispatch("second", -3);
  const duplicate = { ...first, ts: at(-2) };
  assert.deepEqual(repeats([first, { ...first, ts: at(-5) }, second, duplicate]).map(e => e.at), [Date.parse(at(-3))]);
});

test("same-red-set is attributed to consecutive rounds with a matching CI failure set", () => {
  const first = dispatch("first", -6);
  const second = dispatch("second", -3, [...reds].reverse());
  assert.equal(repeats([second, first]).length, 1);
  assert.deepEqual(repeats([first, dispatch("intervening", -4, []), second]), []);
  assert.deepEqual(repeats([first, dispatch("second", -3, [{ ...reds[0]!, signature: "different line" }])]), []);
  assert.deepEqual(repeats([first, { ...second, pr_number: 14007 }]), []);
});

test("only the preceding round's FIXED completion suppresses same-red-set", () => {
  const first = dispatch("first", -6);
  const second = dispatch("second", -3);
  assert.equal(repeats([first, fixed("unrelated", -4), second]).length, 1);
  assert.equal(repeats([first, fixed("first", -2), second]).length, 1);
  assert.deepEqual(repeats([first, fixed("first", -5), fixed("second", -4), second]), []);
});
