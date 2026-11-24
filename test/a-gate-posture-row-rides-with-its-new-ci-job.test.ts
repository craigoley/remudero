/**
 * W1-T14655. A new ci.yml job forces THREE registry rows in one diff: its ci-gate.yml name, its
 * CI_PARITY_TABLE row (W1-T2738) and its GATE_POSTURE_DECLARATIONS row, because the posture census
 * (test/the-blocked-resting-state-has-many-producers.test.ts) refuses both a missing and a stale
 * declaration. W1-T3171's carve-out knew the first two registries; without the third, the W1-T14633
 * prototype (a `flake-screen` job) read entangled under Rule 25 on its posture row alone. Craig approved
 * widening the carve-out to GATE_POSTURE_DECLARATIONS on 2026-11-24. The confinement and add-only
 * guards of changeIsConfinedToRegistry are unchanged, and the second test is what proves they still bite.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { detectInstrumentEntanglement } from "#src/lib/review.js";

const CI = ".github/workflows/ci.yml";
const GATE = ".github/workflows/ci-gate.yml";
const PARITY = "src/lib/ci-parity.ts";
const POSTURE = "src/lib/gate-posture.ts";

// The hunk headers git really printed for the W1-T14633 prototype's two registry rows.
const PARITY_CTX = "export const CI_PARITY_TABLE: CiParityEntry[] = [";
const POSTURE_CTX = "export const GATE_POSTURE_DECLARATIONS: Readonly<Record<string, GatePostureDecla";

/** One file's section of a unified diff. `hunks` is a list of [context, lines]. */
function fileDiff(path: string, hunks: Array<[string, string[]]>): string {
  const head = [`diff --git a/${path} b/${path}`, `index 1111111..2222222 100644`, `--- a/${path}`, `+++ b/${path}`];
  const body = hunks.flatMap(([ctx, lines]) => [`@@ -10,3 +10,${lines.length + 2} @@ ${ctx}`, '   "ci:depcruise": repair(true, "x"),', ...lines, '   "ci:jscpd-gate": repair(true, "y"),']);
  return [...head, ...body, ""].join("\n");
}

const POSTURE_ROW = '+  "ci:flake-screen": repair(true, "a flake-screen failure names the added test file that failed a rerun"),';

/** The W1-T14633 shape: a new job, its ci-gate name, its parity row, and the given posture hunks. */
function newJobDiff(posture: Array<[string, string[]]>): string {
  return [
    fileDiff(CI, [["jobs:", ["+  flake-screen:", "+    name: flake-screen", "+    needs: [coverage-ledger]"]]]),
    fileDiff(GATE, [["REQUIRED: >-", ['+        "flake-screen"']]]),
    fileDiff(PARITY, [[PARITY_CTX, ["+  {", '+    job: "flake-screen",', "+    mirrored: false,", '+    reason: "GitHub-only",', "+  },"]]]),
    fileDiff(POSTURE, posture),
  ].join("\n");
}

const FILES = [CI, GATE, PARITY, POSTURE];
const verdict = (diff: string, files: string[] = FILES) => detectInstrumentEntanglement(files, diff);

test("W1-T14655: a new ci job with its gate-posture row is not entangled", () => {
  const v = verdict(newJobDiff([[POSTURE_CTX, [POSTURE_ROW]]]));
  assert.equal(v.entangled, false, "the posture row is a mandatory registration, like the parity row");
  // The raw evidence is never edited: the carve-out subtracts from the verdict only.
  assert.deepEqual([...v.instrumentPaths].sort(), [GATE, CI].sort());
  assert.deepEqual([...v.srcPaths].sort(), [PARITY, POSTURE].sort());
  // The control: without the posture row the same job is not entangled either, so the row is the only variable.
  const parityOnly = newJobDiff([]).split(`diff --git a/${POSTURE}`)[0]!;
  assert.equal(verdict(parityOnly, [CI, GATE, PARITY]).entangled, false);
});

test("W1-T14655: a gate-posture edit outside its declaration or deleting a row stays entangled", () => {
  // Logic beside the registry, in the same file, is not a registration.
  const unconfined = verdict(newJobDiff([[POSTURE_CTX, [POSTURE_ROW]], ["export function censusGatePostures(", ["+  return { ...census, missingDeclarations: [] };"]]]));
  assert.equal(unconfined.entangled, true, "a hunk outside GATE_POSTURE_DECLARATIONS is still a mixture");
  // Deleting a row unprotects a surface; add-only still holds.
  const deleting = verdict(newJobDiff([[POSTURE_CTX, ['-  "ci:leak-grep": close(true, "secret leakage is a genuine harm bar"),', POSTURE_ROW]]]));
  assert.equal(deleting.entangled, true, "a registry change that deletes a row is not a registration");
  // Re-postured, not registered: changing an existing row's posture is a deletion plus an addition.
  const reposture = verdict(newJobDiff([[POSTURE_CTX, ['-  "ci:leak-grep": close(true, "secret leakage is a genuine harm bar"),', '+  "ci:leak-grep": repair(true, "secret leakage"),', POSTURE_ROW]]]));
  assert.equal(reposture.entangled, true);
  // A hunk git gave no function context for is not proven confined.
  assert.equal(verdict(newJobDiff([["", [POSTURE_ROW]]])).entangled, true, "no context fails closed");
  // A posture row beside a workflow edit that registers no job is not this shape.
  const noJob = [
    fileDiff(CI, [["jobs:", ["+    timeout-minutes: 35"]]]),
    fileDiff(POSTURE, [[POSTURE_CTX, [POSTURE_ROW]]]),
  ].join("\n");
  assert.equal(verdict(noJob, [CI, POSTURE]).entangled, true, "the carve-out is for a registration, not any workflow edit");
});
