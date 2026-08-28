import assert from "node:assert/strict";
import test from "node:test";

import { INSTRUMENT_SURFACE, detectInstrumentEntanglement } from "../src/lib/review.js";

// ── W1-T2428: the fast lane's classifier, declared on the instrument surface ───────────────────
//
// This file is the FALSIFIER for a one-line data registration. Without it, a typo'd pattern
// (`diff-class.mjs` unescaped, a missing anchor, `scripts/diff_class`) declares nothing and NOTHING
// SAYS SO: INSTRUMENT_SURFACE is checked candidate-to-pattern, never the reverse, so an entry
// matching no path is silently inert. The failure would surface one PR later, as the completeness
// alarm firing on the very classifier this entry was added to cover.
//
// It lives in `test/`, which `isProductPath` excludes, so it adds no product half to this
// changeset and Standing rule 25 stays unspanned.

const SURFACE_RE = new RegExp(INSTRUMENT_SURFACE.join("|"));

test("W1-T2428 registration: INSTRUMENT_SURFACE actually MATCHES scripts/diff-class.mjs, with controls proving the pattern is anchored rather than loose", () => {
  assert.equal(SURFACE_RE.test("scripts/diff-class.mjs"), true, "the declared path must match — an inert entry is the whole risk");

  // CONTROLS. A pattern loose enough to match these would cover paths it was never granted.
  assert.equal(SURFACE_RE.test("scripts/diff-class.mjs.bak"), false, "the trailing anchor must hold");
  assert.equal(SURFACE_RE.test("src/lib/diff-class.mjs"), false, "the leading anchor must hold");
  assert.equal(SURFACE_RE.test("scripts/diff-classXmjs"), false, "the dot must be escaped, not a wildcard");
  assert.equal(SURFACE_RE.test("scripts/nested/diff-class.mjs"), false, "no nested path is granted by this entry");
});

test("W1-T2428 registration: with the classifier declared, the fast-lane changeset carries NO product half — the follow-up PR is not instrument-entangled", () => {
  // The exact file list of the PR this registration unblocks. Every path is either a workflow or
  // the newly declared classifier (both instrument) or a test file (never a product path), so the
  // src/ half is empty and Standing rule 25 is not spanned.
  const fastLaneFiles = [
    ".github/workflows/ci.yml",
    "scripts/diff-class.mjs",
    "test/fast-lane-classifier.test.ts",
  ];
  const r = detectInstrumentEntanglement(fastLaneFiles);
  assert.equal(r.entangled, false, "the fast-lane changeset must not be entangled once its classifier is declared");
  assert.deepEqual(r.srcPaths, [], "no product path may appear in that changeset");
  assert.deepEqual(
    r.instrumentPaths,
    [".github/workflows/ci.yml", "scripts/diff-class.mjs"],
    "both instrument paths must be RECOGNISED as instruments — this is what the registration buys",
  );

  // FALSIFIER: add one product path and the same call must block, so the assertion above is a
  // real reading of the rule rather than a predicate that returns false for everything.
  const withProduct = detectInstrumentEntanglement([...fastLaneFiles, "src/lib/drain.ts"]);
  assert.equal(withProduct.entangled, true, "one product path beside an instrument must still block");
});
