import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { detectInstrumentEntanglement, INSTRUMENT_SURFACE_EXCLUSIONS, judgeReview } from "../src/lib/review.js";
import type { AcceptanceCriterion } from "../src/lib/plan.js";

// W1-T2521 — A NEW CENSUS GATE CANNOT SHIP ITSELF.
//
// #3331 (scripts/source-size-ratchet.mjs, filename matches `-ratchet.mjs`) and #3335
// (scripts/worker-branch-shape.mjs, filename does not) hit OPPOSITE refusals for the SAME
// shape: a census gate's introducing commit necessarily both creates a `scripts/` script and
// first registers it in `src/lib/ci-parity.ts`. detectInstrumentEntanglement now carves out
// that one shape — BOTH halves brand-new in the SAME diff — from the `entangled` verdict,
// while leaving `instrumentPaths`/`srcPaths` as the raw, unedited evidence and leaving every
// OTHER shape (an existing instrument touched again, a half-missing diff) governed by the
// ordinary predicate. These fixtures pin the seven acceptance claims in
// plan/tasks.d/W1-T2521-a-new-census-gate-cannot-ship-itself.yaml, in order.

const reviewSrc = readFileSync(fileURLToPath(new URL("../src/lib/review.ts", import.meta.url)), "utf8");

const SIMPLE_CRITERIA: AcceptanceCriterion[] = [{ claim: "the change is safe", proof: "widget frobnicate implemented" }];
const SIMPLE_REPORT = `
REPORT
- widget frobnicate implemented and verified.
PR_URL: https://github.com/o/r/pull/1
`.trim();

/** A brand-new `scripts/<stem>.mjs` file, git's own `new file mode` + `--- /dev/null` shape. */
function newScriptDiff(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1,2 @@",
    "+#!/usr/bin/env node",
    "+console.log('ratchet');",
  ].join("\n");
}

/** A `src/lib/ci-parity.ts` hunk that ADDS a line naming `stem` — a first registration. */
function newRegistrationDiff(stem: string): string {
  return [
    "diff --git a/src/lib/ci-parity.ts b/src/lib/ci-parity.ts",
    "+++ b/src/lib/ci-parity.ts",
    "@@",
    ` npmScriptEntry("existing-entry", "existing-entry"),`,
    `+npmScriptEntry("${stem}", "${stem}"),`,
  ].join("\n");
}

/** `src/lib/ci-parity.ts` edited WITHOUT adding a line naming `stem` — an unrelated edit. */
function unrelatedCiParityDiff(): string {
  return [
    "diff --git a/src/lib/ci-parity.ts b/src/lib/ci-parity.ts",
    "+++ b/src/lib/ci-parity.ts",
    "@@",
    `-npmScriptEntry("old-entry", "old-entry"),`,
    `+npmScriptEntry("renamed-entry", "renamed-entry"),`,
  ].join("\n");
}

/** An ordinary EDIT (not a new file) of an already-shipped instrument, e.g. a ratchet script. */
function editedInstrumentDiff(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `+++ b/${path}`,
    "@@",
    "-const FLOOR = 89.64;",
    "+const FLOOR = 82.75;",
  ].join("\n");
}

/** A genuine, unrelated product-code edit under `src/`. */
function srcProductDiff(path: string): string {
  return [`diff --git a/${path} b/${path}`, `+++ b/${path}`, "@@", "+export function frobnicate() {}"].join("\n");
}

// ── Claim 1: a diff that both creates a gate script and first registers it is not entangled ──

test("W1-T2521 claim 1: a new scripts/<x>-ratchet.mjs plus its OWN first ci-parity.ts registration, in the same diff, is NOT entangled", () => {
  const diff = [newScriptDiff("scripts/example-ratchet.mjs"), newRegistrationDiff("example-ratchet")].join("\n");
  const diffFiles = ["scripts/example-ratchet.mjs", "src/lib/ci-parity.ts"];
  const r = detectInstrumentEntanglement(diffFiles, diff);
  assert.equal(r.entangled, false);
  // Raw evidence stays intact — the introducing pair is a real change, just not the shape
  // Rule 25 exists to catch (see claim 7's negative control below).
  assert.deepEqual(r.instrumentPaths, ["scripts/example-ratchet.mjs"]);
  assert.deepEqual(r.srcPaths, ["src/lib/ci-parity.ts"]);
});

test("W1-T2521 claim 1: end-to-end through judgeReview, the introducing commit PASSES the entanglement floor", () => {
  const diff = [newScriptDiff("scripts/example-ratchet.mjs"), newRegistrationDiff("example-ratchet")].join("\n");
  const v = judgeReview(SIMPLE_CRITERIA, { diff, report: SIMPLE_REPORT });
  assert.equal(v.instrumentEntangled, false, v.summary);
  assert.equal(v.state, "success", v.summary);
});

// ── Claim 2: a later diff moving an instrument and the code it measures is still refused ──

test("W1-T2521 claim 2: an ALREADY-SHIPPED instrument edited alongside genuine src/ product code — the ordinary #585/#586 shape — still entangles", () => {
  const diff = [editedInstrumentDiff("scripts/coverage-ratchet.mjs"), srcProductDiff("src/lib/widget.ts")].join("\n");
  const diffFiles = ["scripts/coverage-ratchet.mjs", "src/lib/widget.ts"];
  const r = detectInstrumentEntanglement(diffFiles, diff);
  assert.equal(r.entangled, true);
  assert.deepEqual(r.instrumentPaths, ["scripts/coverage-ratchet.mjs"]);
  assert.deepEqual(r.srcPaths, ["src/lib/widget.ts"]);
});

// ── Claim 3: a diff that changes an EXISTING instrument alongside src is still refused ──

test("W1-T2521 claim 3: an EXISTING script (edited, not new) re-registered in ci-parity.ts gets NO carve-out — still entangled", () => {
  // "an existing script re-registered" — the first of the design doc's three half-missing
  // shapes: the script half is not new in this diff, only edited, so isIntroducingCensusGate's
  // fileIsNewInDiff check fails and the ordinary predicate governs.
  const diff = [editedInstrumentDiff("scripts/coverage-ratchet.mjs"), newRegistrationDiff("coverage-ratchet")].join("\n");
  const diffFiles = ["scripts/coverage-ratchet.mjs", "src/lib/ci-parity.ts"];
  const r = detectInstrumentEntanglement(diffFiles, diff);
  assert.equal(r.entangled, true, "the script itself was not new in this diff, so no carve-out applies");
});

// ── Claim 4: the carve-out requires BOTH the script and its registration to be new ──

test("W1-T2521 claim 4a: a new script whose registration is NOT part of this diff gets NO carve-out — still entangled alongside src", () => {
  // "a new script whose registration is not part of this diff" — the second half-missing shape.
  const diff = [newScriptDiff("scripts/example-ratchet.mjs"), srcProductDiff("src/lib/widget.ts")].join("\n");
  const diffFiles = ["scripts/example-ratchet.mjs", "src/lib/widget.ts"];
  const r = detectInstrumentEntanglement(diffFiles, diff);
  assert.equal(r.entangled, true, "ci-parity.ts never appears in diffFiles, so isIntroducingCensusGate returns false");
});

test("W1-T2521 claim 4b: a new script alongside an UNRELATED ci-parity.ts edit (no line naming its stem) gets NO carve-out — still entangled", () => {
  // "a new script alongside an unrelated src/ edit" — the third half-missing shape: ci-parity.ts
  // IS in the diff, but no ADDED line names the new script's stem.
  const diff = [newScriptDiff("scripts/example-ratchet.mjs"), unrelatedCiParityDiff()].join("\n");
  const diffFiles = ["scripts/example-ratchet.mjs", "src/lib/ci-parity.ts"];
  const r = detectInstrumentEntanglement(diffFiles, diff);
  assert.equal(r.entangled, true, "src/lib/ci-parity.ts is real product evidence here, and no add names the stem");
});

// ── Claim 5: the outcome no longer depends on whether the filename matches the ratchet pattern ──

test("W1-T2521 claim 5: a new INSTRUMENT_SURFACE script that does NOT match the `-ratchet.mjs` shape gets the SAME carve-out as one that does", () => {
  // scripts/[^/]*-baseline.json is a DIFFERENT INSTRUMENT_SURFACE entry that shares no text with
  // `^scripts/[^/]*-ratchet\.mjs$` — the introducing-commit predicate never inspects which entry
  // matched, only whether the file is new and freshly registered.
  const ratchetDiff = [newScriptDiff("scripts/example-ratchet.mjs"), newRegistrationDiff("example-ratchet")].join("\n");
  const ratchetFiles = ["scripts/example-ratchet.mjs", "src/lib/ci-parity.ts"];
  const nonRatchetDiff = [newScriptDiff("scripts/example-baseline.json"), newRegistrationDiff("example-baseline")].join("\n");
  const nonRatchetFiles = ["scripts/example-baseline.json", "src/lib/ci-parity.ts"];

  assert.doesNotMatch("scripts/example-baseline.json", /^scripts\/[^/]*-ratchet\.mjs$/, "sanity: this fixture is not -ratchet-shaped");
  assert.equal(detectInstrumentEntanglement(ratchetFiles, ratchetDiff).entangled, false);
  assert.equal(detectInstrumentEntanglement(nonRatchetFiles, nonRatchetDiff).entangled, false);
});

// ── Claim 6: INSTRUMENT_SURFACE_EXCLUSIONS stays advisory and still never blocks ──

test("W1-T2521 claim 6: a #3335-shaped exclusion-listed script (scripts/worker-branch-shape.mjs) introduced fresh, registered, alongside src — never blocked, and the carve-out never had to fire", () => {
  assert.ok(
    Object.prototype.hasOwnProperty.call(INSTRUMENT_SURFACE_EXCLUSIONS, "scripts/worker-branch-shape.mjs"),
    "fixture assumption: this is a real INSTRUMENT_SURFACE_EXCLUSIONS entry, not INSTRUMENT_SURFACE itself",
  );
  const diff = [
    newScriptDiff("scripts/worker-branch-shape.mjs"),
    newRegistrationDiff("worker-branch-shape"),
    srcProductDiff("src/lib/widget.ts"),
  ].join("\n");
  const diffFiles = ["scripts/worker-branch-shape.mjs", "src/lib/ci-parity.ts", "src/lib/widget.ts"];
  const r = detectInstrumentEntanglement(diffFiles, diff);
  assert.equal(r.entangled, false);
  // It never reached INSTRUMENT_SURFACE at all, so it never entered instrumentPaths — the
  // BLOCKING verdict was decided by INSTRUMENT_SURFACE alone, never by the exclusions map, and
  // it never needed the introducing-commit carve-out to pass.
  assert.deepEqual(r.instrumentPaths, []);
  assert.deepEqual(r.srcPaths, ["src/lib/ci-parity.ts", "src/lib/widget.ts"]);
  // And the carve-out's own implementation never reads the exclusions map — it stays advisory,
  // informing instrument-surface-completeness only (the same discipline documented for
  // ENTANGLEMENT_EXEMPT_INSTRUMENTS).
  const carveOutSrc = reviewSrc.slice(reviewSrc.indexOf("function isIntroducingCensusGate"), reviewSrc.indexOf("export function detectInstrumentEntanglement"));
  assert.doesNotMatch(carveOutSrc, /INSTRUMENT_SURFACE_EXCLUSIONS/);
});

// ── Claim 7: removing the carve-out makes the introducing-commit assertion fail again ──

test("W1-T2521 claim 7: a path-only caller (no diff supplied) gets NO carve-out — the SAME introducing-commit diffFiles entangle again, proving the carve-out is doing real work", () => {
  const diffFiles = ["scripts/example-ratchet.mjs", "src/lib/ci-parity.ts"];
  const diff = [newScriptDiff("scripts/example-ratchet.mjs"), newRegistrationDiff("example-ratchet")].join("\n");
  // WITH the patch, claim 1 holds:
  assert.equal(detectInstrumentEntanglement(diffFiles, diff).entangled, false);
  // WITHOUT it (introducedGates can only ever be [] when diff === undefined, per the carve-out's
  // own `diff === undefined ? [] : …` guard), the exact same file list entangles — a negative
  // control that this is a real subtraction, not a vacuously-passing fixture.
  assert.equal(detectInstrumentEntanglement(diffFiles).entangled, true);
});
