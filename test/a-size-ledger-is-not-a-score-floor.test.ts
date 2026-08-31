// W1-T2526. `scripts/source-size-baseline.json` matches INSTRUMENT_SURFACE's
// `^scripts/[^/]*-baseline\.json$` entry, so before this task every PR that grew a `src/` file was
// refused by detectInstrumentEntanglement: the ratchet's own header names a hand raise as the only
// sanctioned way to move a ceiling, which puts an instrument path in the same diff as the growth it
// records. MEASURED on 2026-08-31 across five consecutive merges, the last of which left `main`
// itself red on the gate (#3352 was the repair, one PR late by construction).
//
// WHAT THIS FILE ASSERTS IS THE DISTINCTION, NOT THE CONVENIENCE. A SCORE FLOOR grades falsifiers
// -- lower it and a weakened suite passes -- and every one of those stays blocking. A per-file size
// LEDGER grades nothing; raising an entry can only permit one named file to be longer. The tests
// below pin both halves, in the SAME call shape, so the exemption cannot be read as "baselines are
// fine now".

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ENTANGLEMENT_EXEMPT_INSTRUMENTS,
  INSTRUMENT_SURFACE,
  detectInstrumentEntanglement,
} from "../src/lib/review.js";

const SIZE_LEDGER = "scripts/source-size-baseline.json";
const MUTATION_FLOOR = "scripts/mutation-baseline.json";
const GROWN_SRC = "src/lib/review.ts";

/** A patch whose `src/` half carries real executable content, so the `diff`-aware arm of
 *  detectInstrumentEntanglement cannot exempt it for being comment-only (W1-T2884's carve-out).
 *  Both arms of every comparison below use THIS SAME patch, so the only variable is the path. */
function patchGrowing(instrumentPath: string): string {
  return [
    `diff --git a/${instrumentPath} b/${instrumentPath}`,
    `--- a/${instrumentPath}`,
    `+++ b/${instrumentPath}`,
    "@@ -1,3 +1,3 @@",
    `-  "${GROWN_SRC}": 8178,`,
    `+  "${GROWN_SRC}": 8209,`,
    `diff --git a/${GROWN_SRC} b/${GROWN_SRC}`,
    `--- a/${GROWN_SRC}`,
    `+++ b/${GROWN_SRC}`,
    "@@ -1,2 +1,3 @@",
    "+export const somethingExecutable = 1;",
  ].join("\n");
}

// ── acceptance 1 ──────────────────────────────────────────────────────────────────────────────

test("a diff raising the source-size ledger beside the src file whose growth it records is no longer refused for instrument entanglement", () => {
  const verdict = detectInstrumentEntanglement([SIZE_LEDGER, GROWN_SRC], patchGrowing(SIZE_LEDGER));
  assert.equal(verdict.entangled, false, "the exact shape every growing PR must ship must not be refused");
  assert.deepEqual(verdict.instrumentPaths, [], "the ledger contributes no instrument evidence at all");
  assert.deepEqual(verdict.srcPaths, [GROWN_SRC], "and the src/ half is still SEEN — the subtraction is on the ledger, not on the diff");
});

// ── acceptance 2: the exemption is a PATH, never the `-baseline.json` pattern ──────────────────

test("a diff lowering a SCORE floor beside src code is still refused, so the exemption is a path and not the pattern", () => {
  const verdict = detectInstrumentEntanglement([MUTATION_FLOOR, GROWN_SRC], patchGrowing(MUTATION_FLOOR));
  assert.equal(verdict.entangled, true, "a score floor beside src/ is exactly the hazard rule 25 exists for");
  assert.deepEqual(verdict.instrumentPaths, [MUTATION_FLOOR], "and it is named as the evidence");
  // THE DISCRIMINATOR: identical call shape, identical patch shape, one path exempt and one not.
  // Without this pair the test above would pass just as well if the whole predicate were disabled.
  assert.notEqual(
    detectInstrumentEntanglement([SIZE_LEDGER, GROWN_SRC], patchGrowing(SIZE_LEDGER)).entangled,
    verdict.entangled,
    "the two sibling *-baseline.json paths must reach OPPOSITE verdicts under the same call",
  );
});

// ── acceptance 3: the ledger stays on the surface for every OTHER purpose ─────────────────────

test("the size ledger stays on INSTRUMENT_SURFACE for docs-awareness and the completeness alarm, and only the entanglement predicate subtracts it", () => {
  const onSurface = new RegExp(INSTRUMENT_SURFACE.join("|")).test(SIZE_LEDGER);
  assert.equal(onSurface, true, "it must still MATCH the surface — this task narrows one consumer, it does not delist the path");
  assert.equal(ENTANGLEMENT_EXEMPT_INSTRUMENTS.has(SIZE_LEDGER), true, "and the subtraction is expressed in the exemption set, the one place that narrows");
  // An instrument-ONLY diff over the ledger was already fine and must stay fine — proving the
  // exemption did not change the no-src case into something else.
  assert.equal(detectInstrumentEntanglement([SIZE_LEDGER], patchGrowing(SIZE_LEDGER)).entangled, false);
});

// ── acceptance 4: the entry carries its OWN reason ────────────────────────────────────────────

test("the exemption entry states the ledger-versus-floor reason rather than reusing the knowledge-budget entry's own reason", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/review.js", import.meta.url)).replace(/\.js$/, ".ts"), "utf8");
  const set = src.slice(src.indexOf("ENTANGLEMENT_EXEMPT_INSTRUMENTS"), src.indexOf("]);", src.indexOf("ENTANGLEMENT_EXEMPT_INSTRUMENTS")));
  assert.match(set, /THIS ENTRY DOES NOT FIT THE REASON ABOVE/, "the entry must say the pre-existing reason does not transfer, not quietly inherit it");
  assert.match(set, /IS read in CI/, "and must name WHY it does not transfer — this ledger really is read by a CI job");
  assert.match(set, /A SCORE FLOOR/, "the ledger/floor distinction is the reason that does apply and must be stated");
  // The knowledge-budget entry's own reason must still be there, unchanged and attached to ITS path
  // — a shared reason for both would be exactly the conflation this criterion refuses.
  assert.match(set, /No workflow job ratchets against it/, "the pre-existing entry keeps its own distinct reason");
});

// ── acceptance 5: the exemption set is what drives it ─────────────────────────────────────────

test("removing the exemption entry makes the ordinary-growth case refuse again", () => {
  // The set is a module constant, so the falsifier is run over the PREDICATE's own inputs rather
  // than by mutating it: a *-baseline.json path that is NOT in the set, in the identical call
  // shape, must refuse. If the exemption were inert, this would be indistinguishable from the
  // exempt case — and it is not.
  const notExempt = "scripts/some-other-baseline.json";
  assert.equal(ENTANGLEMENT_EXEMPT_INSTRUMENTS.has(notExempt), false, "control: this sibling is not exempt");
  assert.equal(
    detectInstrumentEntanglement([notExempt, GROWN_SRC], patchGrowing(notExempt)).entangled,
    true,
    "a non-exempt *-baseline.json in the same shape still refuses, so membership in the set is what decided the exempt case",
  );
  assert.equal(ENTANGLEMENT_EXEMPT_INSTRUMENTS.size, 2, "exactly two paths are exempt — a third would need its own reviewed reason");
});
