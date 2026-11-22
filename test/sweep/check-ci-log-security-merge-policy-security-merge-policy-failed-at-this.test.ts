import assert from "node:assert/strict";
import { test } from "node:test";
import { runSweep, type CiFailure, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";

const POLICY = "security-merge-policy";
const MISSING = "trusted-exact-head-codeql-result-missing";
const ROUND_AT = "2026-11-10T16:35:44.595Z";

// Replay the policy-only red from #17671, before sweep fills the empty status log tail with the recorded excerpt.
const recordedPr: OpenPrView = {
  prNumber: 17671,
  prUrl: "https://github.com/craigoley/remudero/pull/17671",
  taskId: "W1-T11769",
  headRefName: "run-W1-T11769-1794328000000",
  headSha: "a".repeat(40),
  checksState: "red",
  reviewState: "none",
  unmetCriteria: [],
  priorStrikes: 0,
  lastActivityAt: ROUND_AT,
  autoMergeArmed: false,
  ciFailures: [{ name: POLICY, logTail: "" }],
  securityMergePolicy: { state: "unknown", reason: MISSING },
};

async function sweep(pr: OpenPrView) {
  const fixes: CiFailure[][] = [];
  const rows: Record<string, unknown>[] = [];
  const otherEffects: string[] = [];
  const deps: SweepDeps = {
    arm: () => { otherEffects.push("arm"); },
    close: () => { otherEffects.push("close"); },
    escalate: () => { otherEffects.push("escalate"); },
    dispatchFix: (_pr, evidence) => { fixes.push(evidence?.ciFailures ?? []); },
    ledgerPath: "/nonexistent/rmd-w1-t12281/ledger.ndjson",
    runId: "SWEEP-12281",
    now: () => Date.parse(ROUND_AT),
    readLedger: () => rows,
    appendLine: (_path, row) => { rows.push(row); },
    log: (step, fields) => { rows.push({ step, ...fields }); },
  };
  const { actions } = await runSweep([pr], deps);
  return { fixes, actions, otherEffects };
}

test("W1-T12281: CI friction 6990ea84915912ff is prevented, not retried", async () => {
  const { fixes, actions, otherEffects } = await sweep(recordedPr);
  assert.deepEqual(fixes, []);
  assert.deepEqual(otherEffects, []);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.disposition, "wait");
  assert.equal(actions[0]?.acted, false);
  assert.match(actions[0]!.reason, /trusted-exact-head-codeql-result-missing/);
});

test("an independent required check failure still dispatches a fix beside missing CodeQL evidence", async () => {
  const failure = { name: "ci-gate", logTail: "a required check failed" };
  const { fixes } = await sweep({ ...recordedPr, redRequiredChecks: [failure.name],
    ciFailures: [...recordedPr.ciFailures!, failure] });
  assert.equal(fixes.length, 1);
  assert.ok(fixes[0]?.some((entry) => entry.name === failure.name && entry.logTail === failure.logTail));
});

test("a different security-policy refusal keeps its fix route", async () => {
  const { fixes } = await sweep({ ...recordedPr,
    securityMergePolicy: { state: "blocked", reason: "new-high-or-critical-security-alert" } });
  assert.equal(fixes.length, 1);
  assert.match(fixes[0]![0]!.logTail, /blocked: new-high-or-critical-security-alert/);
});
