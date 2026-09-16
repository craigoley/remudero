import assert from "node:assert/strict";
import { test } from "node:test";
import { INSTRUMENT_SURFACE, INSTRUMENT_SURFACE_EXCLUSIONS } from "../src/lib/review.js";

// ── W1-T3600 (prereq split, #5700) ──────────────────────────────────────────────────────────────
//
// `scripts/run-branch-eligibility-check.mjs` does not exist on this branch and is referenced by no
// workflow or `package.json` script, so `test/instrument-surface-completeness.test.ts`'s own
// tree-derived candidate walk never picks the path up as a candidate — running that whole file
// passes identically whether or not this PR's `INSTRUMENT_SURFACE_EXCLUSIONS` entry exists, which
// is exactly the shape `proof-discrimination-gate.mjs` flags `executed_stale` (CI run 35028778352:
// "1 proof(s) pass at both PR head and merge base ... they cannot establish this PR's work").
//
// This file is NEW, not a modification of the shared completeness suite: `buildBaseProofDir`
// (src/run-task.ts) copies only diff-ADDED `test/**` paths into `rmd check-proof --base`'s
// merge-base worktree, precisely so a proof like this one gets RE-RUN there against the merge
// base's OWN `src/lib/review.ts` — which does not carry this exclusion entry. So the assertion
// below genuinely fails at the merge base and genuinely passes at head: real discrimination, not a
// second copy of the general completeness walk.
test("W1-T3600: scripts/run-branch-eligibility-check.mjs carries a reasoned instrument-surface exclusion", () => {
  const reason = INSTRUMENT_SURFACE_EXCLUSIONS["scripts/run-branch-eligibility-check.mjs"];
  assert.equal(typeof reason, "string", "the pre-push eligibility check must be classified explicitly, not left an unexplained gap");
  assert.ok(reason.trim().length >= 10, `reason "${reason}" is too short to be a real explanation`);
  assert.match(reason, /VERIFIED NON-INSTRUMENT/, "must state the verified-non-instrument classification, not a bare exclusion");
  assert.match(reason, /currentPlanIneligibilityReason/, "must name the reviewer predicate it imports rather than re-derives");
  assert.equal(
    new RegExp(INSTRUMENT_SURFACE.join("|")).test("scripts/run-branch-eligibility-check.mjs"),
    false,
    "an EXCLUSION and DECLARED gate-rule membership are mutually exclusive by design (W1-T402)",
  );
});
