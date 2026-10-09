// test/a-stale-proof-verdict-survives-the-ci-log-region.test.ts
//
// LIVE 2026-10-09: #10234's proof-discrimination check was red with one stale `unit test:` proof. The
// gate names the proof, then prints check-proof's whole output (~19 lines), then the allowance and
// remedy lines, then exits 1. The CI log region the sweep reads keeps only CI_STEP_ERROR_CONTEXT_LINES
// before `##[error]`, so it held the tail of that output and neither the FAIL header nor the proof.
// proofDiscriminationEvidenceFromCheckLog therefore found nothing, the proof-repair route never
// opened, and the sweep escalated and then parked the PR "awaiting a fresh edited-event verdict".
import assert from "node:assert/strict";
import { test } from "node:test";
import { proofDiscriminationEvidenceFromCheckLog } from "../src/lib/sweep.js";
import { ciFailureRegionReducer, extractCiFailureRegion, gateVerdictRetention } from "../src/run-task.js";

const PROOF = "unit test: test/an-unfiled-prs-review-contract-has-a-sweep-side-producer.test.ts";

function gateJobLog(): string[] {
  const stamp = "2026-10-09T08:57:00.0000000Z ";
  const output = Array.from({ length: 19 }, (_, i) => `    ok ${i + 1} - check-proof output line ${i + 1}`);
  return [
    "##[group]Run node --import tsx scripts/proof-discrimination-gate.mjs",
    "##[endgroup]",
    "proof-discrimination: FAIL — 1 proof(s) pass at both PR head and merge base (16651b3fc); they cannot establish this PR's work:",
    `  proof: ${PROOF}`,
    "  head hits: 22; base hits: 22",
    ...output,
    "Allowance for W1-T5714: 0 (scripts/proof-discrimination-baseline.json); this PR carries 1, 1 over.",
    "Remedy: replace each stale proof with one that names behavior this PR changes, then rerun this check.",
    "##[error]Process completed with exit code 1.",
  ].map((line) => stamp + line);
}

function evidence(logTail: string) {
  return proofDiscriminationEvidenceFromCheckLog([{ name: "proof-discrimination", logTail }]);
}

test("the streamed log region keeps the gate's stale proof, so the proof-repair route can open", () => {
  const reducer = ciFailureRegionReducer(60);
  for (const line of gateJobLog()) reducer.push(line);
  assert.deepEqual(evidence(reducer.finish())?.proofs.map((p) => p.proof), [PROOF]);
});

test("the whole-log region keeps the gate's stale proof too", () => {
  const log = gateJobLog().join("\n");
  const verdict = gateVerdictRetention();
  for (const line of log.split("\n")) verdict.push(line.replace(/^\S+Z /, ""));
  assert.deepEqual(evidence(verdict.wrap(extractCiFailureRegion(log, 60)))?.proofs.map((p) => p.proof), [PROOF]);
});

test("a log with no proof-discrimination verdict is returned unchanged", () => {
  const reducer = ciFailureRegionReducer(60);
  const plain = ["##[group]Run npm test", "  proof: not a gate line", "##[error]Process completed with exit code 1."];
  for (const line of plain) reducer.push(line);
  assert.equal(reducer.finish().includes("retained from earlier"), false);
});
