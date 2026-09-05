// scripts/comment-load-baseline.json matches INSTRUMENT_SURFACE's `^scripts/[^/]*-baseline\.json$`
// entry, so before this task every PR that shrank a src/ file's comment count was refused by
// detectInstrumentEntanglement: scripts/comment-load-ratchet.mjs (run unconditionally in ci.yml,
// see its own header) REWRITES a shrunk file's entry DOWN in the same diff as the src/ change that
// shrank it — evaluateCommentLoadRatchet's `shrunk` branch and the write in `main()`, both in
// scripts/comment-load-ratchet.mjs — which is exactly the "instrument beside the src/ growth it
// records" shape W1-T2526 already carved out for scripts/source-size-baseline.json.
//
// SAME REASON, NOT THE SAME FILE. This is a per-file COMMENT-LINE ledger, not a score FLOOR: it
// grades no falsifier, and raising (or in this case lowering) an entry cannot make a failing
// falsifier pass or hide a bug — it can only permit one named file's recorded count to change, in
// the same diff a reviewer already reads. test/a-size-ledger-is-not-a-score-floor.test.ts pins the
// sibling; this file pins the same distinction for the comment-load ledger.

import assert from "node:assert/strict";
import test from "node:test";

import { ENTANGLEMENT_EXEMPT_INSTRUMENTS, detectInstrumentEntanglement } from "../src/lib/review.js";

const COMMENT_LOAD_BASELINE = "scripts/comment-load-baseline.json";
const NOT_EXEMPT_INSTRUMENT = "scripts/mutation-relevant-paths.json";
const SHRUNK_SRC = "src/lib/review.ts";

/** A patch whose `src/` half carries real executable content, so the `diff`-aware arm of
 *  detectInstrumentEntanglement cannot exempt it for being comment-only (W1-T2884's carve-out).
 *  Both arms of the comparison below use THIS SAME patch, so the only variable is the instrument
 *  path beside it. */
function patchBesideInstrument(instrumentPath: string): string {
  return [
    `diff --git a/${instrumentPath} b/${instrumentPath}`,
    `--- a/${instrumentPath}`,
    `+++ b/${instrumentPath}`,
    "@@ -1,3 +1,3 @@",
    `-  "${SHRUNK_SRC}": 412,`,
    `+  "${SHRUNK_SRC}": 398,`,
    `diff --git a/${SHRUNK_SRC} b/${SHRUNK_SRC}`,
    `--- a/${SHRUNK_SRC}`,
    `+++ b/${SHRUNK_SRC}`,
    "@@ -1,2 +1,1 @@",
    "-export const somethingExecutable = 1;",
  ].join("\n");
}

test("a diff carrying the comment-load ledger's ratcheted-down entry beside the src/ change that shrank it is no longer refused for instrument entanglement", () => {
  const verdict = detectInstrumentEntanglement([COMMENT_LOAD_BASELINE, SHRUNK_SRC], patchBesideInstrument(COMMENT_LOAD_BASELINE));
  assert.equal(verdict.entangled, false, "the exact shape every shrinking PR must ship must not be refused");
  assert.deepEqual(verdict.instrumentPaths, [], "the ledger contributes no instrument evidence at all");
  assert.deepEqual(verdict.srcPaths, [SHRUNK_SRC], "and the src/ half is still SEEN — the subtraction is on the ledger, not on the diff");
});

// THE DISCRIMINATOR: identical call shape, identical patch shape, one path exempt and one not —
// proving the exemption is narrow rather than the whole predicate having gone inert.
test("the exemption is narrow — a different, real instrument path (not exempt) still entangles alongside the same src/ hunk", () => {
  const verdict = detectInstrumentEntanglement([NOT_EXEMPT_INSTRUMENT, SHRUNK_SRC], patchBesideInstrument(NOT_EXEMPT_INSTRUMENT));
  assert.equal(verdict.entangled, true, "mutation-relevant-paths.json is a real mutation-ratchet diff-scoping config — nothing exempts it");
  assert.deepEqual(verdict.instrumentPaths, [NOT_EXEMPT_INSTRUMENT], "and it is named as the evidence");
  assert.notEqual(
    detectInstrumentEntanglement([COMMENT_LOAD_BASELINE, SHRUNK_SRC], patchBesideInstrument(COMMENT_LOAD_BASELINE)).entangled,
    verdict.entangled,
    "the exempt comment-load ledger and a non-exempt instrument must reach OPPOSITE verdicts under the same call shape",
  );
});

test("the comment-load ledger is registered in the exemption set", () => {
  assert.equal(ENTANGLEMENT_EXEMPT_INSTRUMENTS.has(COMMENT_LOAD_BASELINE), true);
  assert.equal(ENTANGLEMENT_EXEMPT_INSTRUMENTS.has(NOT_EXEMPT_INSTRUMENT), false, "control: the sibling instrument config is not exempt");
});
