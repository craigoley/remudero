import assert from "node:assert/strict";
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { readLedgerLines } from "#src/lib/status.js";
import { observeLightPassReviewEligibility, readLiveLedgerRows, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

// W1-T11260: 619 light passes in 6 h each parsed the whole 15 MB live ledger at least twice on the daemon's
// thread (host daemon.loop_stall_profile rows, 2026-11-03). The light pass now reads it through one tail.

const row = (n: number) => JSON.stringify({ ts: new Date(Date.UTC(2026, 10, 3, 12, 0, n)).toISOString(), step: "fixture.row", n });

const fixturePath = (t: TestContext, lines: number): string =>
  writeLedger(Array.from({ length: lines }, (_, n) => JSON.parse(row(n)) as Record<string, unknown>), { scope: t }).path;

/** Counts JSON.parse calls whose input is one of the fixture's ledger lines. */
function countFixtureRowParses(t: TestContext): { readonly count: number } {
  const original = JSON.parse;
  const seen = { count: 0 };
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (typeof text === "string" && text.includes('"step":"fixture.row"')) seen.count++;
    return original(text, reviver);
  }) as typeof JSON.parse;
  t.after(() => { JSON.parse = original; });
  return seen;
}

const pr: OpenPrView = {
  prNumber: 7, prUrl: "https://github.com/o/r/pull/7", taskId: "W1-T7", headSha: "head-7", headRefName: "run-W1-T7-1",
  lastActivityAt: new Date().toISOString(), reviewState: "none", checksState: "green", unmetCriteria: [], priorStrikes: 0,
  autoMergeArmed: false, mergeState: "clean", changedFiles: ["src/subject.ts"],
};

test("light pass ledger tail: the default reader returns readLedgerLines' rows, after appends and a rotation", (t) => {
  const path = fixturePath(t, 5);
  assert.deepEqual(readLiveLedgerRows(path), [...readLedgerLines(path)]);
  appendFileSync(path, `${row(5)}\n${row(6)}\n`);
  assert.deepEqual(readLiveLedgerRows(path), [...readLedgerLines(path)]);
  renameSync(path, `${path}.1`);
  writeFileSync(path, `${row(9)}\n`);
  assert.deepEqual(readLiveLedgerRows(path), [...readLedgerLines(path)], "a rotation's rename resets the tail");
  assert.equal(readLiveLedgerRows(path).length, 1);
});

test("light pass ledger tail: each call returns its own array, so a caller's receipt never enters the next read", (t) => {
  const path = fixturePath(t, 2);
  readLiveLedgerRows(path).push({ ts: new Date().toISOString(), step: "caller.receipt" });
  assert.deepEqual(readLiveLedgerRows(path), [...readLedgerLines(path)]);
});

test("light pass ledger tail: a second light pass over a file with no new bytes parses no line", (t) => {
  const path = fixturePath(t, 40);
  const deps = { ledgerPath: path, runId: "T11260", log: () => {} } as unknown as SweepDeps;
  const parses = countFixtureRowParses(t);
  const first = observeLightPassReviewEligibility([pr], deps);
  assert.equal(first.length, 40, "positive control: the first pass saw every row");
  assert.ok(parses.count >= 40, `positive control: the first pass parsed the file (saw ${parses.count})`);
  const before = parses.count;
  // The pass's own eligibility rows are appended between passes, so compare with a full read, not a count.
  const second = observeLightPassReviewEligibility([pr], deps);
  assert.deepEqual([...second].filter((r) => r.step === "fixture.row"), [...first].filter((r) => r.step === "fixture.row"));
  assert.equal(parses.count - before, 0, "no fixture line appended, none parsed again");
  appendFileSync(path, `${row(40)}\n`);
  const third = observeLightPassReviewEligibility([pr], deps);
  assert.equal([...third].filter((r) => r.step === "fixture.row").length, 41);
  assert.equal(parses.count - before, 1, "only the appended fixture line is parsed");
  assert.deepEqual(readLiveLedgerRows(path), [...readLedgerLines(path)], "the shared tail still matches a full read");
});
