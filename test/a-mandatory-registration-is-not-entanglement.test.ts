/**
 * W1-T3171. Two bidirectional censuses make a CI job registration UNAVOIDABLY a mixture: adding a
 * `ci.yml` job forces a `CI_PARITY_TABLE` row (preflight --ci-parity checks both directions), and
 * adding the gate script forces an `INSTRUMENT_SURFACE_EXCLUSIONS` entry (W1-T402 refuses a
 * gate-rule-like path that is neither declared nor excluded with a reason). Both registries live
 * under `src/`, so rule 25 read the unavoidable as smuggling.
 *
 * Rule 25 blocks an instrument beside `src/` because a weakened instrument could hide a product
 * regression shipped next to it. The carve-out rests on there being NO product change to hide —
 * which is why the second test matters more than the first: a carve-out that forgets to refuse
 * extra `src/` paths, or an unconfined hunk INSIDE a registry file, turns "add a job" into a
 * universal escape hatch. Those cases are asserted against the shipped predicate, and the
 * implementation was checked by watching them fail without the guard.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { detectInstrumentEntanglement, ENTANGLEMENT_EXEMPT_INSTRUMENTS } from "../src/lib/review.js";

const CI = ".github/workflows/ci.yml";
const GATE = ".github/workflows/ci-gate.yml";
const PARITY = "src/lib/ci-parity.ts";
const REVIEW = "src/lib/review.ts";

/** One file's section of a unified diff. `hunks` is a list of [context, lines]. */
function fileDiff(path: string, hunks: Array<[string, string[]]>): string {
  const head = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  const body = hunks.flatMap(([ctx, lines]) => [`@@ -1,2 +1,${lines.length} @@ ${ctx}`, ...lines]);
  return [...head, ...body].join("\n");
}

const PARITY_CTX = "export const CI_PARITY_TABLE: CiParityEntry[] = [";
const EXCL_CTX = "export const INSTRUMENT_SURFACE_EXCLUSIONS: Readonly<Record<string, st";

/** #4559's real shape: two jobs added to ci.yml, both registered in ci-gate.yml and the parity
 *  table, plus exclusion entries for the scripts those jobs run. */
function registrationDiff(over: { jobs?: string[]; gateJobs?: string[]; parityJobs?: string[] } = {}): string {
  const jobs = over.jobs ?? ["test-slow", "flake-retry-aggregate"];
  const gateJobs = over.gateJobs ?? jobs;
  const parityJobs = over.parityJobs ?? jobs;
  return [
    fileDiff(CI, [["jobs:", [...jobs.map((j) => `+  ${j}:`), "+    runs-on: ubuntu-latest", "+    steps:", "+      - run: npm test"]]]),
    fileDiff(GATE, [["required:", gateJobs.map((j) => `+        "${j}",`)]]),
    fileDiff(PARITY, [[PARITY_CTX, parityJobs.map((j) => `+    { job: "${j}", mirrored: true },`)]]),
    fileDiff(REVIEW, [[EXCL_CTX, ['+  "scripts/flake-retry-aggregate.mjs": "informational only, exits 0",']]]),
  ].join("\n");
}

const FULL_FILES = [CI, GATE, PARITY, REVIEW];

function verdict(diff: string, files: string[] = FULL_FILES) {
  return detectInstrumentEntanglement(files, diff);
}

test("a ci.yml job plus its ci-gate registration and BOTH registry entries is not entangled", () => {
  const v = verdict(registrationDiff());
  assert.equal(v.entangled, false);
});

test("the raw evidence is never edited, and the exempt list is not consulted", () => {
  const v = verdict(registrationDiff());
  assert.deepEqual(v.instrumentPaths.slice().sort(), [GATE, CI, REVIEW].sort(), "instrument evidence stays whole");
  assert.deepEqual(v.srcPaths.slice().sort(), [PARITY].sort(), "src evidence stays whole");
  for (const p of [CI, GATE, PARITY, REVIEW]) {
    assert.equal(ENTANGLEMENT_EXEMPT_INSTRUMENTS.has(p), false, `${p} must not be exempted by path`);
  }
});

test("GUARD: any OTHER product src/ file still refuses — the carve-out cannot ship unrelated code", () => {
  const withProduct = [
    registrationDiff(),
    fileDiff("src/lib/sweep.ts", [["export function sweep(", ["+  const smuggled = 1;", "+  return smuggled;"]]]),
  ].join("\n");
  const v = verdict(withProduct, [...FULL_FILES, "src/lib/sweep.ts"]);
  assert.equal(v.entangled, true, "a registration must not launder an unrelated src/ change through");
  assert.ok(v.srcPaths.includes("src/lib/sweep.ts"));
});

test("GUARD: a hunk INSIDE a registry file but outside its map still refuses", () => {
  // The subtler half of the same hole: naming src/lib/review.ts as a registry, without checking
  // WHERE in it the diff lands, would make the reviewer itself freely editable beside a workflow.
  const unconfined = [
    fileDiff(CI, [["jobs:", ["+  test-slow:", "+    runs-on: ubuntu-latest"]]]),
    fileDiff(GATE, [["required:", ['+        "test-slow",']]]),
    fileDiff(PARITY, [[PARITY_CTX, ['+    { job: "test-slow", mirrored: true },']]]),
    fileDiff(REVIEW, [
      [EXCL_CTX, ['+  "scripts/x.mjs": "reason",']],
      ["export function judgeCriterion(", ["+  if (alwaysPass) return { met: true };"]],
    ]),
  ].join("\n");
  const v = verdict(unconfined);
  assert.equal(v.entangled, true, "a registry file carrying logic beside its map is still a mixture");
});

test("GUARD: a hunk git gave no function context for is not confined — fails closed", () => {
  const noContext = [
    fileDiff(CI, [["jobs:", ["+  test-slow:", "+    runs-on: ubuntu-latest"]]]),
    fileDiff(GATE, [["required:", ['+        "test-slow",']]]),
    fileDiff(PARITY, [["", ['+    { job: "test-slow", mirrored: true },']]]),
    fileDiff(REVIEW, [[EXCL_CTX, ['+  "scripts/x.mjs": "reason",']]]),
  ].join("\n");
  assert.equal(verdict(noContext).entangled, true, "no context means not proven confined");
});

test("a workflow edit that registers no job — a run:/trigger/timeout change — still refuses beside src/", () => {
  const notARegistration = [
    fileDiff(CI, [["jobs:", ["-      - run: npm test", "+      - run: npm test -- --bail", "+    timeout-minutes: 35"]]]),
    fileDiff(PARITY, [[PARITY_CTX, ['+    { job: "already-there", mirrored: true },']]]),
  ].join("\n");
  const v = verdict(notARegistration, [CI, PARITY]);
  assert.equal(v.entangled, true, "the carve-out is for a REGISTRATION, not for any workflow edit");
});

test("a job registered on only one side is not this shape and stays blocking", () => {
  // ci-gate has it, the parity table does not.
  assert.equal(verdict(registrationDiff({ parityJobs: ["something-else"] })).entangled, true);
  // the parity table has it, ci-gate does not.
  assert.equal(verdict(registrationDiff({ gateJobs: ["something-else"] })).entangled, true);
  // one of TWO added jobs unregistered is still a mismatch — every added job must match.
  assert.equal(verdict(registrationDiff({ gateJobs: ["test-slow"] })).entangled, true);
});

test("an unrelated instrument riding along on a registration still refuses", () => {
  const withOtherInstrument = [
    registrationDiff(),
    fileDiff("scripts/coverage-ratchet.mjs", [["export function ratchet(", ["+  const floor = 0;"]]]),
  ].join("\n");
  const v = verdict(withOtherInstrument, [...FULL_FILES, "scripts/coverage-ratchet.mjs"]);
  assert.equal(v.entangled, true, "only the two CI workflows may be subtracted by this carve-out");
});

test("the live instance: PR #4559's real file list and diff shape classify as not entangled", () => {
  // The four paths #4559 actually carries on the instrument/src surfaces, in its real shape:
  // two workflows, the parity row, and three INSTRUMENT_SURFACE_EXCLUSIONS entries (13 added
  // lines across 3 hunks, 0 removed, every hunk inside the map).
  const real = [
    fileDiff(CI, [["jobs:", ["+  test-slow:", "+  flake-retry-aggregate:", "+    runs-on: ubuntu-latest"]]]),
    fileDiff(GATE, [["required:", ['+        "test-slow"', '+        "flake-retry-aggregate",']]]),
    fileDiff(PARITY, [[PARITY_CTX, ['+    job: "test-slow",', '+    job: "flake-retry-aggregate",']]]),
    fileDiff(REVIEW, [
      [EXCL_CTX, ['+  "scripts/test-tier-manifest.json": "data, not rule logic",']],
      [EXCL_CTX, ['+  "scripts/flake-retry-aggregate.mjs": "informational only",']],
      [EXCL_CTX, ['+  "scripts/test-tier-manifest.mjs": "known gap, widening deferred",']],
    ]),
  ].join("\n");
  assert.equal(verdict(real).entangled, false);
});
