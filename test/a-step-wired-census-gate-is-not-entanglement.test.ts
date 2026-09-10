// W1-T3272 — A CENSUS GATE WIRED AS A STEP WAS UNRESOLVABLE FROM INSIDE ITS OWN PR.
//
// Rule 25 refuses an instrument changed beside `src/`. W1-T3171 already carves out the case where a
// new ci.yml JOB forces registrations in `ci-gate.yml` and `CI_PARITY_TABLE` — the mixture is
// symmetric and neither half exists without the other.
//
// #4851 hit the same wall through a different door, and its own ci.yml comment shows the author
// trying to avoid it: they wired the gate as a STEP on an existing job precisely BECAUSE a new job
// looked like entanglement. It failed anyway, because adding a census-shaped TEST FILE forces an
// entry in `CENSUS_POPULATION` — the second registry in `src/lib/ci-parity.ts`, which the carve-out
// did not name. MEASURED 2026-09-10, in BOTH directions:
//   - remove that one member  -> two live-drift suites fail ("every census-shaped file this run's
//     own recognizer discovers in the CURRENT tree is a CENSUS_POPULATION member")
//   - add the member with NO test file -> the same check fails
// Neither half can land first. The PR sat five hours.
//
// THE PAIRING IS STILL THE DISCRIMINATION. The job form pairs two adds agreeing on a NAME; the step
// form pairs on the SCRIPT: ci.yml runs `scripts/<stem>`, that script is NEW in this diff, and
// ci-parity registers the same stem. The controls below are the point of this file — each one is a
// way the carve-out could have become an escape hatch, and each must still refuse.

import assert from "node:assert/strict";
import { test } from "node:test";

import { detectInstrumentEntanglement } from "../src/lib/review.js";

const CI = ".github/workflows/ci.yml";
const PARITY = "src/lib/ci-parity.ts";
const REVIEW = "src/lib/review.ts";

/** A unified diff block, in the shape `walkDiff`/`diffHunkContexts` actually parse. */
function block(file: string, hunkContext: string, added: string[], opts: { newFile?: boolean } = {}): string {
  const head = opts.newFile
    ? `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n`
    : `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n`;
  return head + `@@ -1,1 +1,${added.length + 1} @@ ${hunkContext}\n` + added.map((l) => "+" + l).join("\n") + "\n";
}

/** The shape #4851 actually carries: a step invoking a NEW census script, plus its mandatory
 *  CENSUS_POPULATION classification. */
function stepWiredGate(): { files: string[]; diff: string } {
  const diff =
    block(CI, "jobs:", ["      - name: Expiring-fixture census", "        run: node scripts/zz-census-probe.mjs"]) +
    block("scripts/zz-census-probe.mjs", "", ["#!/usr/bin/env node", "// the gate"], { newFile: true }) +
    block(PARITY, "export const CENSUS_POPULATION: readonly CensusPopulationMember[] = [", [
      '  refusedForPredicate("test/zz-census-probe.test.ts", "a", "not a src-population walk"),',
    ]);
  return { files: [CI, "scripts/zz-census-probe.mjs", PARITY], diff };
}

test("W1-T3272 criterion 1: a step-wired NEW census gate with its mandatory registration is not entanglement", () => {
  const { files, diff } = stepWiredGate();
  const r = detectInstrumentEntanglement(files, diff);
  assert.equal(r.entangled, false, "the shape that sat five hours must pass");
  // THE EVIDENCE IS NOT MUTED — same discipline as the carve-outs beside it. A reader still sees
  // exactly which instrument and which src path were in the diff; only the VERDICT is subtracted.
  assert.deepEqual(r.instrumentPaths, [CI], "the instrument stays visible in the evidence");
  assert.deepEqual(r.srcPaths, [PARITY], "and so does the src half");
});

// ── the controls: each is a way this could have become an escape hatch ────────────────────────

test("W1-T3272 CONTROL: an ORDINARY src file beside the same workflow is still entangled", () => {
  const diff =
    block(CI, "jobs:", ["        run: node scripts/zz-census-probe.mjs"]) +
    block("scripts/zz-census-probe.mjs", "", ["// the gate"], { newFile: true }) +
    block(PARITY, "export const CENSUS_POPULATION: readonly CensusPopulationMember[] = [", ['  refusedForPredicate("test/x.test.ts", "a", "r"),']) +
    block("src/lib/sweep.ts", "export function runSweep(", ["  const smuggled = 1;"]);
  const r = detectInstrumentEntanglement([CI, "scripts/zz-census-probe.mjs", PARITY, "src/lib/sweep.ts"], diff);
  assert.equal(r.entangled, true, "a product change riding along must still be refused — this is the whole rule");
});

test("W1-T3272 CONTROL: a step invoking a PRE-EXISTING script earns nothing", () => {
  // Without the new-file half there is no introducing commit, only an ordinary workflow edit — and
  // an ordinary workflow edit beside a registry is exactly what Rule 25 is for.
  const diff =
    block(CI, "jobs:", ["        run: node scripts/comment-load-ratchet.mjs"]) +
    block(PARITY, "export const CENSUS_POPULATION: readonly CensusPopulationMember[] = [", ['  refusedForPredicate("test/x.test.ts", "a", "r"),']);
  const r = detectInstrumentEntanglement([CI, PARITY], diff);
  assert.equal(r.entangled, true, "no NEW script means no introducing commit and no carve-out");
});

test("W1-T3272 CONTROL: wiring one script while registering ANOTHER carves out nothing", () => {
  // Co-presence is not the test — the pair must agree on the stem, the same discrimination the job
  // form makes on the job name.
  const diff =
    block(CI, "jobs:", ["        run: node scripts/zz-census-probe.mjs"]) +
    block("scripts/zz-census-probe.mjs", "", ["// the gate"], { newFile: true }) +
    block(PARITY, "export const CENSUS_POPULATION: readonly CensusPopulationMember[] = [", ['  refusedForPredicate("test/unrelated.test.ts", "a", "names a different stem entirely"),']);
  const r = detectInstrumentEntanglement([CI, "scripts/zz-census-probe.mjs", PARITY], diff);
  assert.equal(r.entangled, true, "the registration must name the script that was wired");
});

test("W1-T3272 CONTROL: a ci-parity hunk OUTSIDE both declarations is still entangled", () => {
  // The confinement guard is what stops the registry file becoming freely editable beside a
  // workflow. Two declarations are now accepted; a hunk in neither is not.
  const diff =
    block(CI, "jobs:", ["        run: node scripts/zz-census-probe.mjs"]) +
    block("scripts/zz-census-probe.mjs", "", ["// the gate"], { newFile: true }) +
    block(PARITY, "export function somethingElseEntirely(", ["  const loosened = true;"]);
  const r = detectInstrumentEntanglement([CI, "scripts/zz-census-probe.mjs", PARITY], diff);
  assert.equal(r.entangled, true, "confinement to a declared registry is what makes the subtraction safe");
});

test("W1-T3272: the job form still works exactly as it did — this extension adds a door, it does not move one", () => {
  const diff =
    block(CI, "jobs:", ["  brand-new-job:", "    runs-on: ubuntu-latest"]) +
    block(".github/workflows/ci-gate.yml", "REQUIRED:", ['        "brand-new-job",']) +
    block(PARITY, "export const CI_PARITY_TABLE: readonly CiParityRow[] = [", ['  { job: "brand-new-job", script: "x" },']);
  const r = detectInstrumentEntanglement([CI, ".github/workflows/ci-gate.yml", PARITY], diff);
  assert.equal(r.entangled, false, "W1-T3171's original shape must be untouched");
});

// ── the surface declaration is the THIRD mandatory half, and deletions are not carved out ─────

test("W1-T3272: the surface declaration rides along too — script, registration and declaration are one commit", () => {
  // I first measured this one as OPTIONAL and was wrong: I ran four suites, none of which polices
  // it. `test/instrument-surface-completeness.test.ts` does. MEASURED 2026-09-10 on #4851: with the
  // declaration 13/13, without it 12 pass and that suite fails. So a new gate cannot ship without
  // all three halves, which is exactly the circularity this carve-out exists for.
  const diff =
    block(CI, "jobs:", ["        run: node scripts/zz-census-probe.mjs"]) +
    block("scripts/zz-census-probe.mjs", "", ["// the gate"], { newFile: true }) +
    block(PARITY, "export const CENSUS_POPULATION: readonly CensusPopulationMember[] = [", ['  refusedForPredicate("test/zz-census-probe.test.ts", "a", "r"),']) +
    block(REVIEW, "export const INSTRUMENT_SURFACE: readonly string[] = [", ['  "^scripts/zz-census-probe\\\\.mjs$",']);
  const r = detectInstrumentEntanglement([CI, "scripts/zz-census-probe.mjs", PARITY, REVIEW], diff);
  assert.equal(r.entangled, false, "all three halves together are one indivisible introducing commit");
});

test("W1-T3272 CONTROL: a DELETION from a registry is never subtracted, however confined it is", () => {
  // ADD-ONLY, and this tightens the two entries that predate this change. These declarations DEFINE
  // the protected set: removing a path from INSTRUMENT_SURFACE unprotects it. Subtracting that from
  // the verdict would let an unprotection ride beside the very workflow edit rule 25 exists to catch.
  const del =
    `diff --git a/${REVIEW} b/${REVIEW}\n--- a/${REVIEW}\n+++ b/${REVIEW}\n` +
    "@@ -1,2 +1,1 @@ export const INSTRUMENT_SURFACE: readonly string[] = [\n" +
    '-  "^scripts/some-existing-ratchet\\\\.mjs$",\n';
  const diff =
    block(CI, "jobs:", ["        run: node scripts/zz-census-probe.mjs"]) +
    block("scripts/zz-census-probe.mjs", "", ["// the gate"], { newFile: true }) +
    block(PARITY, "export const CENSUS_POPULATION: readonly CensusPopulationMember[] = [", ['  refusedForPredicate("test/zz-census-probe.test.ts", "a", "r"),']) +
    del;
  const r = detectInstrumentEntanglement([CI, "scripts/zz-census-probe.mjs", PARITY, REVIEW], diff);
  assert.equal(r.entangled, true, "an unprotection beside a workflow edit is the thing rule 25 is FOR");
});

// ── the gate DECLARED ON THE SURFACE: the reading that actually decides ───────────────────────
//
// `INSTRUMENT_SURFACE` is read from the tree the detector RUNS IN, and the reviewer runs it on the
// PR's own tree. A census gate's PR necessarily declares its own script there (the declaration is
// mandatory — test/instrument-surface-completeness.test.ts), so the script is an INSTRUMENT by the
// time the verdict is taken.
//
// MEASURED 2026-09-10 on #4851, on byte-identical file lists: entangled=FALSE judged from a lane
// that did not declare the script, TRUE judged from the PR's own branch that did. The second is the
// one the reviewer uses, and it failed the review after the carve-out had supposedly cleared it.
// Condition (a) was refusing because an instrument was not a workflow — the very gate being
// registered, which `introducedGates` had ALREADY subtracted on W1-T2521's reasoning.

test("W1-T3272: the introduced gate does not veto its own registration when it is DECLARED ON THE SURFACE", () => {
  const diff =
    block(CI, "jobs:", ["        run: node scripts/zz-census-probe.mjs"]) +
    block("scripts/zz-census-probe.mjs", "", ["// the gate"], { newFile: true }) +
    block(PARITY, "export const CENSUS_POPULATION: readonly CensusPopulationMember[] = [", ['  refusedForPredicate("test/zz-census-probe.test.ts", "a", "r"),']) +
    block(REVIEW, "export const INSTRUMENT_SURFACE: readonly string[] = [", ['  "^scripts/zz-census-probe\\\\.mjs$",']);
  // The script is passed as an instrument here, which is what the PR's own tree produces.
  const r = detectInstrumentEntanglement([CI, "scripts/zz-census-probe.mjs", PARITY, REVIEW], diff);
  assert.equal(r.entangled, false, "an introduced gate that is already carved out must not also veto condition (a)");
});

test("W1-T3272 CONTROL: an instrument that is NOT an introduced gate still vetoes", () => {
  // Condition (a) exists so an unrelated instrument cannot ride along on a registration. Relaxing
  // it for the introduced gate must not relax it for anything else — a pre-existing ratchet script
  // changed in the same diff is exactly the passenger it was written to stop.
  const diff =
    block(CI, "jobs:", ["        run: node scripts/zz-census-probe.mjs"]) +
    block("scripts/zz-census-probe.mjs", "", ["// the gate"], { newFile: true }) +
    block(PARITY, "export const CENSUS_POPULATION: readonly CensusPopulationMember[] = [", ['  refusedForPredicate("test/zz-census-probe.test.ts", "a", "r"),']) +
    block("scripts/comment-load-ratchet.mjs", "export function ceilingForComments(", ["  return 999999;"]);
  const r = detectInstrumentEntanglement([CI, "scripts/zz-census-probe.mjs", PARITY, "scripts/comment-load-ratchet.mjs"], diff);
  assert.equal(r.entangled, true, "a PRE-EXISTING instrument weakened in the same diff must still refuse");
});
