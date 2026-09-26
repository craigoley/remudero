// W1-T4569: W1-T4563 retires the daemon's in-process console and deletes the suites that measured
// it, including test/console-shell-coverage-is-vacuous.test.ts (3 recorded fixture stamps). The
// census refuses any drop below a recorded population, and its table is an instrument (Standing
// rule 25), so the record is released HERE, in an instrument-only change landed first, and the
// suite is deleted in W1-T4563's product change. A drop is only ever a refusal for a file whose
// record still exists.
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-ignore the executable .mjs module has no declaration file.
import { RECORDED_POPULATION_BY_FILE, refusePopulationDrop } from "../scripts/expiring-fixture-census.mjs";

const RETIRING_SUITE = "test/console-shell-coverage-is-vacuous.test.ts";

test("W1-T4569: the retiring console suite has no recorded census population", () => {
  assert.equal(Object.hasOwn(RECORDED_POPULATION_BY_FILE, RETIRING_SUITE), false);
});

test("W1-T4569: deleting the retiring suite is not a population drop, while a still-recorded file still is", () => {
  const current: Record<string, number> = { ...RECORDED_POPULATION_BY_FILE };
  delete current[RETIRING_SUITE];
  assert.equal(refusePopulationDrop(current).length, 0, "the retiring suite's absence refuses nothing");
  const [someRecorded] = Object.entries(RECORDED_POPULATION_BY_FILE).filter(([, n]) => (n as number) > 0);
  assert.ok(someRecorded, "control: the table still records at least one populated file");
  const dropped = { ...current, [someRecorded![0]]: 0 };
  assert.equal(refusePopulationDrop(dropped).length, 1, "control: a real drop is still refused");
});
