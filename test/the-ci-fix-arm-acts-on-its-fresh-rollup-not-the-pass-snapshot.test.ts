import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  DEFAULT_SWEEP_POLICY,
  runSweep,
  type FixDispatchEvidence,
  type OpenPrView,
  type RollupCheckEntry,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { readLedgerLines } from "../src/lib/status.js";

const NOW = Date.parse("2026-10-04T16:57:27.376Z");
const OLD_START = "2026-10-04T16:54:04Z";
const NEW_START = "2026-10-04T17:13:26Z";

function snapshot(overrides: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 9124,
    prUrl: "https://github.com/craigoley/remudero/pull/9124",
    taskId: "W1-T5654",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW).toISOString(),
    headSha: "0704ab90",
    headRefName: "run-W1-T5654-1791171209847",
    autoMergeArmed: false,
    redRequiredChecks: ["coverage-ratchet", "ci-gate"],
    ciFailures: [{ name: "coverage-ratchet", logTail: "diff-coverage: BLOCKED" }],
    cancelledRequiredChecks: [{ name: "ci-gate", jobId: "111483790238" }],
    ...overrides,
  };
}

function fresh(conclusion: string): RollupCheckEntry[] {
  return [
    { name: "coverage-ratchet", conclusion: "FAILURE", startedAt: OLD_START },
    { name: "ci-gate", conclusion: "CANCELLED", startedAt: OLD_START },
    { name: "coverage-ratchet", conclusion, startedAt: NEW_START },
    { name: "ci-gate", conclusion, startedAt: NEW_START },
  ];
}

async function sweep(rollup: RollupCheckEntry[] | undefined, pr = snapshot(), omitReader = false) {
  const fixed: FixDispatchEvidence[] = [];
  const requeued: string[] = [];
  const escalated: string[] = [];
  let reads = 0;
  const deps: SweepDeps = {
    arm: () => assert.fail("red snapshot must not arm"),
    close: () => assert.fail("red snapshot must not close"),
    escalate: (_pr, reason) => { escalated.push(reason); },
    escalateCancelledCheck: (_pr, check) => { escalated.push(check.name); },
    dispatchFix: (_pr, evidence) => { fixed.push(evidence); },
    requeueCheck: async (_pr, check) => { requeued.push(check.name); },
    liveCiRunForHead: () => false,
    ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-fresh-ci-arm-")), "ledger.ndjson"),
    runId: "SWEEP-W1-T5654",
    now: () => NOW,
    ...(!omitReader ? { readCiGateRollup: () => { reads++; return rollup; } } : {}),
  };
  await runSweep([pr], deps, DEFAULT_SWEEP_POLICY);
  const rows = readLedgerLines(deps.ledgerPath);
  const disposed = rows.find((row) => row.step === "sweep.disposed");
  assert.ok(disposed, "the disposition is observable in the ledger");
  return { fixed, requeued, escalated, reads, rows, disposed };
}

describe("test/the-ci-fix-arm-acts-on-its-fresh-rollup-not-the-pass-snapshot.test.ts", () => {
  test("the recovered #9124 snapshot re-queues nothing and spends no fix strike", async () => {
    const result = await sweep(fresh("SUCCESS"));
    assert.deepEqual({ requeued: result.requeued, fixed: result.fixed }, { requeued: [], fixed: [] });
    assert.deepEqual(result.escalated, []);
    assert.equal(result.reads, 1);
    assert.equal(result.disposed.acted, false);
    assert.match(String(result.disposed.stand_down_reason), /fresh.*green or in flight/);
    assert.match(String(result.disposed.stand_down_reason), /coverage-ratchet/);
    assert.match(String(result.disposed.stand_down_reason), /ci-gate/);
    assert.equal(result.rows.some((row) => row.step === "sweep.check_requeued"), false);
  });

  test("fresh in-flight attempts stand down even when the live-run probe reads false", async () => {
    const result = await sweep(fresh("").map((entry) => ({ ...entry, status: "IN_PROGRESS" })));
    assert.deepEqual(result.requeued, []);
    assert.deepEqual(result.fixed, []);
    assert.equal(result.disposed.acted, false);
    assert.match(String(result.disposed.stand_down_reason), /fresh.*green or in flight/);
  });

  test("only a still-red failure reaches the fix worker, with recovered cancellations removed", async () => {
    const rollup = fresh("SUCCESS");
    rollup[2].conclusion = "FAILURE";
    const result = await sweep(rollup);
    assert.deepEqual(result.requeued, []);
    assert.equal(result.fixed.length, 1);
    assert.deepEqual(result.fixed[0].ciFailures, snapshot().ciFailures);
    assert.equal(result.disposed.acted, true);
  });

  test("a still-cancelled check requeues without dispatching the recovered failure", async () => {
    const rollup = fresh("SUCCESS");
    rollup[3].conclusion = "CANCELLED";
    const result = await sweep(rollup);
    assert.deepEqual(result.requeued, ["ci-gate"]);
    assert.deepEqual(result.fixed, []);
    assert.equal(result.disposed.acted, false);
    assert.match(String(result.disposed.stand_down_reason), /cancelled required check/);
  });

  test("mixed failures dispatch only the fresh red subset", async () => {
    const pr = snapshot({ ciFailures: [...snapshot().ciFailures!, { name: "ci", logTail: "assertion failed" }] });
    const result = await sweep([...fresh("SUCCESS"), { name: "ci", conclusion: "FAILURE", startedAt: NEW_START }], pr);
    assert.deepEqual(result.requeued, []);
    assert.equal(result.fixed.length, 1);
    assert.deepEqual(result.fixed[0].ciFailures, [{ name: "ci", logTail: "assertion failed" }]);
  });

  test("the fresh red set includes names present only in redRequiredChecks", async () => {
    const pr = snapshot({ redRequiredChecks: ["coverage-ratchet", "ci-gate", "ci"] });
    const result = await sweep([...fresh("SUCCESS"), { name: "ci", conclusion: "FAILURE", startedAt: NEW_START }], pr);
    assert.deepEqual(result.requeued, []);
    assert.equal(result.fixed.length, 1);
    assert.deepEqual(result.fixed[0].ciFailures, []);
    assert.equal(result.disposed.acted, true);
  });

  test("failure and cancellation names are filtered even without redRequiredChecks", async () => {
    const result = await sweep(fresh("SUCCESS"), snapshot({ redRequiredChecks: undefined }));
    assert.deepEqual(result.requeued, []);
    assert.deepEqual(result.fixed, []);
    assert.equal(result.disposed.acted, false);
    assert.match(String(result.disposed.stand_down_reason), /coverage-ratchet, ci-gate/);
  });

  test("recovered infrastructure evidence is removed before its retry while a real red is fixed", async () => {
    const pr = snapshot({ ciFailures: [...snapshot().ciFailures!, {
      name: "ci-artifact",
      conclusion: "FAILURE",
      jobId: "123",
      logTail: "Artifact upload completed successfully\nFinalizing artifact upload\nFailed to FinalizeArtifact: 403 Forbidden: Error from intermediary",
    }] });
    const rollup = fresh("SUCCESS");
    rollup[2].conclusion = "FAILURE";
    const result = await sweep([...rollup, { name: "ci-artifact", conclusion: "SUCCESS", startedAt: NEW_START }], pr);
    assert.deepEqual(result.requeued, []);
    assert.equal(result.fixed.length, 1);
    assert.deepEqual(result.fixed[0].ciFailures, snapshot().ciFailures);
    assert.equal(result.rows.some((row) => row.step === "sweep.ci_infrastructure_requeue"), false);
  });

  test("still-red infrastructure retains its bounded retry without a fix worker", async () => {
    const pr = snapshot({
      redRequiredChecks: undefined,
      cancelledRequiredChecks: undefined,
      ciFailures: [{
        name: "ci-artifact",
        conclusion: "FAILURE",
        jobId: "123",
        logTail: "Artifact upload completed successfully\nFinalizing artifact upload\nFailed to FinalizeArtifact: 403 Forbidden: Error from intermediary",
      }],
    });
    const result = await sweep([{ name: "ci-artifact", conclusion: "FAILURE", startedAt: NEW_START }], pr);
    assert.deepEqual(result.requeued, ["ci-artifact"]);
    assert.deepEqual(result.fixed, []);
    assert.equal(result.disposed.acted, false);
  });

  test("a recovered named red stands down when snapshot evidence lists are absent", async () => {
    const result = await sweep(fresh("SUCCESS"), snapshot({ ciFailures: undefined, cancelledRequiredChecks: undefined }));
    assert.deepEqual(result.requeued, []);
    assert.deepEqual(result.fixed, []);
    assert.equal(result.disposed.acted, false);
    assert.match(String(result.disposed.stand_down_reason), /fresh.*green or in flight/);
  });

  test("an unnamed snapshot red retains dispatch when the fresh rollup is still red", async () => {
    const result = await sweep(fresh("FAILURE"), snapshot({
      redRequiredChecks: undefined,
      ciFailures: undefined,
      cancelledRequiredChecks: undefined,
    }));
    assert.deepEqual(result.requeued, []);
    assert.equal(result.fixed.length, 1);
    assert.equal(result.disposed.acted, true);
  });

  for (const [label, rollup, omitReader] of [
    ["empty rollup", [], false],
    ["undefined rollup", undefined, false],
    ["omitted reader", undefined, true],
    ["absent check names", [{ name: "other", conclusion: "SUCCESS", startedAt: NEW_START }], false],
    ["missing attempt timestamps", fresh("SUCCESS").map(({ startedAt: _start, ...entry }) => entry), false],
  ] as const) {
    test(`${label} retains the snapshot's requeue and fix behavior`, async () => {
      const result = await sweep(rollup ? [...rollup] : undefined, snapshot(), omitReader);
      assert.deepEqual(result.requeued, ["ci-gate"]);
      assert.equal(result.fixed.length, 1);
      assert.deepEqual(result.fixed[0].ciFailures, snapshot().ciFailures);
      assert.equal(result.disposed.acted, true);
    });
  }
});
