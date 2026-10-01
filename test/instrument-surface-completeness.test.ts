import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { INSTRUMENT_SURFACE, INSTRUMENT_SURFACE_EXCLUSIONS, detectInstrumentEntanglement, judgeReview } from "../src/lib/review.js";
// @ts-ignore the executable .mjs module has no declaration file.
import { deriveInstrumentCandidates, findUnexplainedGaps, harvestTokens, liveTree } from "../scripts/lib/instrument-surface-census.mjs";

// ── W1-T402: "INSTRUMENT_SURFACE was hand-enumerated against one day's tree and missed the rule
// files of five REQUIRED jobs ... and the only thing asking anyone to re-check membership is a
// comment" (RECON guard-reach-2026-08-07). INSTRUMENT_SURFACE stays the DECLARED, sole BLOCKING
// authority (never touched here) — this file is the completeness ALARM the design's clause (ii)
// calls for: it derives candidate gate-rule paths from the LIVE TREE, the same way every run, and
// fails the moment a derived candidate is neither covered by INSTRUMENT_SURFACE nor excused by a
// REASONED entry in INSTRUMENT_SURFACE_EXCLUSIONS (review.ts). A bare exclusion (no reason, or a
// blank one) does not count — that would rebuild the exact silent gap this alarm exists to close.
// ──────────────────────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const DECLARED_RE = new RegExp(INSTRUMENT_SURFACE.join("|"));

// ── the tokeniser trap, regression-pinned ───────────────────────────────────────────────────

test("harvestTokens: an extension alternation ordered longest-first never truncates .jscpd.json to .jscpd.js", () => {
  const tokens = harvestTokens("run: jscpd src --config .jscpd.json");
  assert.deepEqual(tokens, [".jscpd.json"]);
});

// ── acceptance claim 1: an uncovered, unexcused derived candidate is REPORTED ──────────────────

test("findUnexplainedGaps: a derived candidate with no declared coverage and no exclusion is reported, not silently passed", () => {
  const gaps = findUnexplainedGaps(["some/newly-added-gate.json"], DECLARED_RE, {});
  assert.deepEqual(gaps, ["some/newly-added-gate.json"]);
});

test("findUnexplainedGaps: a candidate already covered by the declared INSTRUMENT_SURFACE is never reported", () => {
  const gaps = findUnexplainedGaps([".github/workflows/ci.yml", "scripts/coverage-baseline.json"], DECLARED_RE, {});
  assert.deepEqual(gaps, []);
});

// ── acceptance claim 2: an exclusion is honoured ONLY when it carries a recorded reason ────────

test("findUnexplainedGaps: a bare exclusion (empty or whitespace-only reason) does not silence the alarm", () => {
  assert.deepEqual(findUnexplainedGaps(["x/gate.json"], DECLARED_RE, { "x/gate.json": "" }), ["x/gate.json"]);
  assert.deepEqual(findUnexplainedGaps(["x/gate.json"], DECLARED_RE, { "x/gate.json": "   " }), ["x/gate.json"]);
});

test("findUnexplainedGaps: an exclusion with an actual recorded reason silences the alarm", () => {
  const gaps = findUnexplainedGaps(["x/gate.json"], DECLARED_RE, { "x/gate.json": "not gate logic, verified" });
  assert.deepEqual(gaps, []);
});

test("INSTRUMENT_SURFACE_EXCLUSIONS: every real exclusion in review.ts carries a substantive, non-blank reason", () => {
  const entries = Object.entries(INSTRUMENT_SURFACE_EXCLUSIONS);
  assert.ok(entries.length > 10, "sanity: the real exclusion map is not empty/trivial");
  for (const [path, reason] of entries) {
    assert.equal(typeof reason, "string", `${path}: reason must be a string`);
    assert.ok(reason.trim().length >= 10, `${path}: reason "${reason}" is too short to be a real explanation`);
  }
});

test("W1-T2843: the entrypoint path trigger has a reasoned instrument-surface exclusion", () => {
  const reason = INSTRUMENT_SURFACE_EXCLUSIONS["deploy/entrypoint.sh"];
  assert.equal(typeof reason, "string", "the baked entrypoint must be classified explicitly");
  assert.match(reason, /container image asset/i);
  assert.match(reason, /push\.paths/);
  assert.match(reason, /not (?:CI )?gate(?:-rule)? logic/i);
});

// ── acceptance claim 3: the declared list is the SOLE blocking authority — the derivation/
// exclusions can never themselves refuse a PR, however wrong or incomplete they are ────────────

test("judgeReview: a diff touching a KNOWN, real instrument-surface gap (.jscpd.json, excused above pending a widening decision) plus a src/ file is NOT reported as entangled", () => {
  // .jscpd.json is a genuine gate-rule file (the jscpd-gate job's duplication threshold) that
  // INSTRUMENT_SURFACE_EXCLUSIONS records as a known gap with widening deliberately deferred
  // (W1-T402 design clause v). If the completeness alarm's derivation/exclusions fed the BLOCKING
  // verdict, this diff would wrongly refuse the PR the moment that exclusion looked wrong; instead
  // only INSTRUMENT_SURFACE decides, and .jscpd.json is not on it.
  assert.ok(
    ".jscpd.json" in INSTRUMENT_SURFACE_EXCLUSIONS,
    "fixture assumption: .jscpd.json is a recorded (excused) gap, not a made-up path",
  );
  const diff = `
diff --git a/.jscpd.json b/.jscpd.json
+++ b/.jscpd.json
@@
-  "threshold": 2
+  "threshold": 5
diff --git a/src/lib/widget.ts b/src/lib/widget.ts
+++ b/src/lib/widget.ts
@@
+export function frobnicate() {}
`.trim();
  const v = judgeReview([{ claim: "the change is safe", proof: "widget frobnicate implemented" }], {
    diff,
    report: "REPORT\n- widget frobnicate implemented and verified.\nPR_URL: https://github.com/o/r/pull/1",
  });
  assert.equal(
    v.instrumentEntangled,
    false,
    "a derived-but-not-DECLARED gate-rule path must never trip the binding entanglement verdict",
  );
});

// ── the completeness check itself, run for real against the live tree ──────────────────────────

test("instrument-surface completeness: every gate-rule-like path this tree's own workflows/package.json reference is either declared or has a recorded, reasoned exclusion", () => {
  const candidates: string[] = deriveInstrumentCandidates(liveTree(REPO_ROOT));
  assert.ok(candidates.length > 15, "sanity: the derivation is actually finding real candidates, not running vacuously");

  const gaps: string[] = findUnexplainedGaps(candidates, DECLARED_RE, INSTRUMENT_SURFACE_EXCLUSIONS);
  assert.deepEqual(
    gaps,
    [],
    `derived candidate(s) neither in INSTRUMENT_SURFACE nor excused in INSTRUMENT_SURFACE_EXCLUSIONS ` +
      `(src/lib/review.ts): ${gaps.join(", ")} — a diff can touch these to change what a CI gate ` +
      `measures with nothing flagging it`,
  );
});

// ── AN INSTRUMENT PATH UNDER `src/` MUST BE EXPRESSIBLE ──────────────────────────────────────
//
// `isProductPath` is unconditionally `src/` and not `test/`, so before the subtraction in
// `detectInstrumentEntanglement` a `src/` file named by INSTRUMENT_SURFACE landed in BOTH the
// instrument set and the product set, and `entangled` was true on that ONE file plus a workflow.
// Adding any `src/` path to the surface could therefore never change a verdict — the exemption was
// inexpressible. These pin the fix in BOTH directions: it must become expressible, and it must not
// quietly neuter the rule, which is the failure shape a green suite would otherwise hide.

const WORKFLOW = ".github/workflows/ci.yml";
const RATCHET = "scripts/claude-md-budget-ratchet.mjs";

test("a workflow shipped beside genuine product code still entangles", () => {
  // THE FALSIFIER. If this ever reads false, the subtraction has disabled the rule rather than
  // narrowed it, and every other assertion here would still pass.
  const r = detectInstrumentEntanglement([WORKFLOW, RATCHET, "src/lib/dispatch-overlap.ts"]);
  assert.equal(r.entangled, true, "a real product path beside an instrument must still fail the PR");
  assert.deepEqual(r.srcPaths, ["src/lib/dispatch-overlap.ts"], "and the product path is named");
});

test("the reviewer's own module is treated as an instrument, not product", () => {
  // `src/lib/review.ts` is the PR judge, so it belongs to the surface. It is still subject to
  // Rule 25 when real product code rides beside it.
  const instrumentOnly = detectInstrumentEntanglement([WORKFLOW, "src/lib/review.ts"]);
  assert.equal(instrumentOnly.entangled, false, "workflow plus reviewer is instrument-only");
  assert.ok(instrumentOnly.instrumentPaths.includes("src/lib/review.ts"));
  assert.equal(instrumentOnly.srcPaths.includes("src/lib/review.ts"), false);

  const withProduct = detectInstrumentEntanglement(["src/lib/review.ts", "src/lib/dispatch-overlap.ts"]);
  assert.equal(withProduct.entangled, true, "review.ts beside real product code still trips Rule 25");
  assert.deepEqual(withProduct.srcPaths, ["src/lib/dispatch-overlap.ts"]);
});

test("a surface path under src is subtracted from the product set", () => {
  // THE EXEMPTION, EXPRESSIBLE. Driven with a path the LIVE surface already matches so the test
  // needs no hypothetical: a `-ratchet.mjs` under `src/` matches `^scripts/...` only from `scripts/`,
  // so this uses the surface's own membership test rather than inventing a pattern.
  const surfaced = INSTRUMENT_SURFACE.some((p) => new RegExp(p).test(RATCHET));
  assert.equal(surfaced, true, "control: the ratchet really is on the surface");
  const r = detectInstrumentEntanglement([WORKFLOW, RATCHET]);
  assert.equal(r.entangled, false, "an instrument-only diff is the sanctioned shape");
  assert.deepEqual(r.srcPaths, [], "and nothing instrument-shaped leaks into the product set");
});

test("a diff carrying no instrument path never entangles whatever else it holds", () => {
  const r = detectInstrumentEntanglement(["src/lib/dispatch-overlap.ts", "src/run-task.ts", "test/x.test.ts"]);
  assert.equal(r.entangled, false, "product-only is a sanctioned shape too");
  assert.deepEqual(r.instrumentPaths, [], "control: the instrument set really is empty here");
});
