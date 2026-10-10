// W1-T5769 — A BUNDLED CHECK'S REMEDY FOLLOWS THE GATE THAT REFUSED, NOT THE CHECK NAME.
//
// ci.yml posts comment-load-ratchet, expiring-fixture-census and console-parity under ONE check
// run named `comment-load-ratchet`; W1-T3720 titles that run by the gate that refused. The
// recordable-ratchet classifier used to read only the NAME, so #9186 (title
// "expiring-fixture-census") was told its whole fix was `npm run comment-load-ratchet`.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLedgerLines } from "../src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY,
  ratifiedBaselineRatchetRepairFor,
  recordableRatchetRepairFor,
  runSweep,
  type CiFailure,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";

const NOW = Date.parse("2026-10-05T00:00:00.000Z");

function bundledPr(failure: CiFailure): OpenPrView {
  return {
    prNumber: 9186,
    prUrl: "https://github.com/o/r/pull/9186",
    taskId: "W1-T9186",
    reviewState: "failure",
    checksState: "red",
    redRequiredChecks: [failure.name],
    ciFailures: [failure],
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-10-05T00:00:00.000Z", // expiring-fixture: exempt -- pinned to this suite's own `now: () => NOW`, so the age it exercises is always 0 and never the wall clock
    headSha: "2519141a",
    autoMergeArmed: false,
  };
}

const CENSUS_REFUSAL: CiFailure = {
  name: "comment-load-ratchet",
  title: "expiring-fixture-census",
  logTail: "comment-load-ratchet: OK\nexpiring-fixture-census: BLOCKED -- 1 fixture(s) CROSS their threshold within 14 day(s):",
};

const COMMENT_LOAD_REFUSAL: CiFailure = {
  name: "comment-load-ratchet",
  title: "comment-load-ratchet",
  logTail: "comment-load-ratchet: BLOCKED -- 1 file(s) carry more comment lines than their recorded ceiling:",
};

async function disposedReason(pr: OpenPrView, repairEnabled: boolean): Promise<{ reason: string; repaired: number }> {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-bundled-remedy-")), "ledger.ndjson");
  let repaired = 0;
  const deps: SweepDeps = {
    ledgerPath,
    runId: "bundled-remedy-test",
    now: () => NOW,
    arm: () => {},
    close: () => {},
    escalate: () => {},
    dispatchFix: () => {},
    repairRecordableRatchet: () => {
      repaired += 1;
      return true;
    },
    log: () => {},
  };
  await runSweep([pr], deps, { ...DEFAULT_SWEEP_POLICY, recordableRatchetRepairEnabled: repairEnabled });
  const disposed = readLedgerLines(ledgerPath).filter((line) => line.step === "sweep.disposed");
  return { reason: String(disposed[0]?.reason), repaired };
}

test("a comment-load-ratchet failure whose title is expiring-fixture-census is not recordable and its reason names expiring-fixture-census, while one whose title is comment-load-ratchet still yields npm run comment-load-ratchet", async () => {
  const census = bundledPr(CENSUS_REFUSAL);
  assert.equal(recordableRatchetRepairFor(census), undefined, "the refusing gate owns no recorded number");
  assert.equal(ratifiedBaselineRatchetRepairFor(census), undefined, "and grants no unattended baseline write");
  const censusReason = await disposedReason(census, false);
  assert.doesNotMatch(censusReason.reason, /RECORDABLE ratchet/);
  assert.doesNotMatch(censusReason.reason, /npm run comment-load-ratchet/);
  assert.match(censusReason.reason, /refused by expiring-fixture-census/);

  const commentLoad = bundledPr(COMMENT_LOAD_REFUSAL);
  assert.deepEqual(recordableRatchetRepairFor(commentLoad), ["comment-load-ratchet"]);
  assert.deepEqual(ratifiedBaselineRatchetRepairFor(commentLoad), ["comment-load-ratchet"]);
  const commentLoadReason = await disposedReason(commentLoad, false);
  assert.match(commentLoadReason.reason, /RECORDABLE ratchet/);
  assert.match(commentLoadReason.reason, /npm run comment-load-ratchet/);
});

test("W1-T5769: with the repair switched on, a bundled census refusal never records a comment-load baseline", async () => {
  const census = await disposedReason(bundledPr(CENSUS_REFUSAL), true);
  assert.equal(census.repaired, 0);
  const commentLoad = await disposedReason(bundledPr(COMMENT_LOAD_REFUSAL), true);
  assert.equal(commentLoad.repaired, 1, "the gate the recorded number does clear is still repaired");
});

test("W1-T5769: with no title, the log tail's own `<gate>: BLOCKED` headline names the refusing gate", () => {
  const { title: _title, ...untitled } = CENSUS_REFUSAL;
  assert.equal(recordableRatchetRepairFor(bundledPr(untitled)), undefined);
  assert.equal(ratifiedBaselineRatchetRepairFor(bundledPr(untitled)), undefined);
  // GitHub's `##[error]` rendering of the same headline is the same refusal.
  const rendered = { name: "comment-load-ratchet", logTail: "##[error]console-parity: BLOCKED -- drift" };
  assert.equal(recordableRatchetRepairFor(bundledPr(rendered)), undefined);
});

test("W1-T5769: a bundle where BOTH a recordable gate and a census refused is not partially recordable", () => {
  const both = { ...CENSUS_REFUSAL, title: "comment-load-ratchet, expiring-fixture-census" };
  assert.equal(recordableRatchetRepairFor(bundledPr(both)), undefined);
  assert.equal(ratifiedBaselineRatchetRepairFor(bundledPr(both)), undefined);
});

test("W1-T5769: a check that names no gate keeps today's name-keyed behaviour", () => {
  const plain = { name: "comment-load-ratchet", logTail: "record it in scripts/comment-load-baseline.json" };
  assert.deepEqual(recordableRatchetRepairFor(bundledPr(plain)), ["comment-load-ratchet"]);
  assert.deepEqual(ratifiedBaselineRatchetRepairFor(bundledPr(plain)), ["comment-load-ratchet"]);
  // A free-text title that is not a gate list is not read as one.
  const prose = { ...plain, title: "Comment load grew past its ceiling" };
  assert.deepEqual(recordableRatchetRepairFor(bundledPr(prose)), ["comment-load-ratchet"]);
});
