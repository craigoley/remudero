import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectInstrumentEntanglement,
  failSummary,
  INSTRUMENT_SURFACE,
} from "../src/lib/review.js";

const REVIEW = "src/lib/review.ts";
const PRODUCT = "src/lib/widget.ts";
const TEST_FIXTURE = "test/rule-25-guards-the-gates-that-exist.test.ts";
const CI = ".github/workflows/ci.yml";
const PARITY = "src/lib/ci-parity.ts";
const RATCHET = "scripts/coverage-ratchet.mjs";
const SIZE_LEDGER = "scripts/source-size-baseline.json";

function patchBesideReview(instrumentPath: string): string {
  return [
    `diff --git a/${instrumentPath} b/${instrumentPath}`,
    `--- a/${instrumentPath}`,
    `+++ b/${instrumentPath}`,
    "@@ -1,3 +1,3 @@",
    `-  "${REVIEW}": 8178,`,
    `+  "${REVIEW}": 8209,`,
    `diff --git a/${REVIEW} b/${REVIEW}`,
    `--- a/${REVIEW}`,
    `+++ b/${REVIEW}`,
    "@@ -1,2 +1,3 @@",
    "+export const somethingExecutable = 1;",
  ].join("\n");
}

test("W1-T3329: src/lib/review.ts is on the instrument surface", () => {
  const surface = new RegExp(INSTRUMENT_SURFACE.join("|"));
  assert.match(REVIEW, surface);

  const r = detectInstrumentEntanglement([REVIEW, PRODUCT]);
  assert.equal(r.entangled, true);
  assert.deepEqual(r.instrumentPaths, [REVIEW]);
  assert.deepEqual(r.srcPaths, [PRODUCT]);
});

test("W1-T3329: ci-parity registration is not the product half of a ci.yml job", () => {
  const r = detectInstrumentEntanglement([CI, PARITY]);
  assert.equal(r.entangled, false);
});

test("W1-T3329: a real instrument beside product code still entangles", () => {
  const r = detectInstrumentEntanglement([RATCHET, PRODUCT]);
  assert.equal(r.entangled, true);
  assert.deepEqual(r.instrumentPaths, [RATCHET]);
  assert.deepEqual(r.srcPaths, [PRODUCT]);
});

test("W1-T3329: an entangled summary names the required split", () => {
  const msg = failSummary([], false, false, false, 0, [], {
    instrumentPaths: [REVIEW],
    srcPaths: [PRODUCT],
  });

  assert.match(msg, /src\/lib\/review\.ts/);
  assert.match(msg, /src\/lib\/widget\.ts/);
  assert.match(msg, /split it: land the instrument change in its own PR/i);
  assert.match(msg, /rebase this one/i);
});

test("W1-T3329: test fixtures are still not the product half", () => {
  const r = detectInstrumentEntanglement([REVIEW, TEST_FIXTURE]);
  assert.equal(r.entangled, false);
  assert.deepEqual(r.instrumentPaths, [REVIEW]);
  assert.deepEqual(r.srcPaths, []);
});

test("W1-T3329: review can still be the src half for an existing non-src instrument", () => {
  const r = detectInstrumentEntanglement([SIZE_LEDGER, REVIEW], patchBesideReview(SIZE_LEDGER));
  assert.equal(r.entangled, false);
  assert.deepEqual(r.instrumentPaths, []);
  assert.deepEqual(r.srcPaths, [REVIEW]);
});
