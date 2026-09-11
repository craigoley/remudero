/**
 * test/coverage-remediation-escalates-in-rounds.test.ts — W1-T3384b.
 *
 * #5117 retired every coverage floor by operator ruling, so the sub-85 band lands instead of
 * blocking. It also filed NOTHING there: `injectCoverageImprovementTask` returned `blocking` and
 * left the band to a tier-three loop that was never built. A band that neither blocks nor files is
 * the worst of both — the debt is invisible AND unacted-on.
 *
 * THE ESCALATION IS IN TIME, NOT WIDTH. The operator's ruling is that if coverage "keeps dropping
 * to a really low threshold then we continue to kick off more tasks until its in a state we're
 * happy with". W1-T470 rejected one entry per file outright (the queue cannot absorb that fan-out),
 * so each further drop of one full band opens a new remediation ROUND, and the round rides in the
 * dedupe key so the producer files again. The band width is DERIVED from `pass - block` — the span
 * that already separates healthy from owing-work — so no new constant is invented.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  coverageRemediationRound,
  buildCoverageRemediationFeedback,
  DEFAULT_TIER_BLOCK_PCT,
  DEFAULT_TIER_PASS_PCT,
  type FileDebt,
} from "../src/lib/coverage-improvement.js";

const BLOCK = DEFAULT_TIER_BLOCK_PCT;
const PASS = DEFAULT_TIER_PASS_PCT;
const DEBT: FileDebt[] = [{ file: "src/a.ts", uncoveredBranches: 40 }];

test("W1-T3384b: a further drop of one full band opens the NEXT remediation round", () => {
  assert.equal(coverageRemediationRound(BLOCK - 1, PASS, BLOCK), 0, "just under the cut is round one");
  assert.equal(coverageRemediationRound(BLOCK - (PASS - BLOCK), PASS, BLOCK), 1, "one full band lower is round two");
  assert.equal(coverageRemediationRound(BLOCK - 2 * (PASS - BLOCK), PASS, BLOCK), 2);
});

test("W1-T3384b: a WOBBLE inside one band does not open a new round, so the queue is not spammed", () => {
  const first = coverageRemediationRound(BLOCK - 1, PASS, BLOCK);
  for (const pct of [BLOCK - 1.5, BLOCK - 2, BLOCK - 3, BLOCK - 4.9]) {
    assert.equal(coverageRemediationRound(pct, PASS, BLOCK), first, `${pct}% is still the same round`);
  }
});

test("W1-T3384b: the band width is DERIVED from pass-block, never a constant of its own", () => {
  // A caller with a wider healthy/owing span gets proportionally wider remediation rounds.
  assert.equal(coverageRemediationRound(60, 100, 80), 1, "a 20pt span puts 60% one band under 80%");
  assert.equal(coverageRemediationRound(60, 90, 80), 2, "a 10pt span puts the same 60% two bands under");
});

test("W1-T3384b: coverage ABOVE the cut is never a remediation round", () => {
  assert.equal(coverageRemediationRound(BLOCK, PASS, BLOCK), 0);
  assert.equal(coverageRemediationRound(PASS + 5, PASS, BLOCK), 0, "a healthy run cannot go negative");
});

test("W1-T3384b: the remediation ask NAMES refactoring-for-testability, which tier two's text does not", () => {
  const text = buildCoverageRemediationFeedback(DEBT, { branchesPct: 80, round: 0, block: BLOCK });
  assert.match(text, /make it testable/, "a branch no test can reach needs a seam, not another test");
  assert.match(text, /THE BUILD IS NOT BLOCKED/, "the worker must not go looking for a failure that is not there");
  assert.match(text, /src\/a\.ts — 40 uncovered branch\(es\)/, "it still names the ranked files and counts");
});

test("W1-T3384b: a later round SAYS the earlier one did not recover it", () => {
  const first = buildCoverageRemediationFeedback(DEBT, { branchesPct: 84, round: 0, block: BLOCK });
  const third = buildCoverageRemediationFeedback(DEBT, { branchesPct: 74, round: 2, block: BLOCK });
  assert.match(first, /FIRST remediation round/);
  assert.match(third, /remediation round 3/);
  assert.match(third, /did not recover it/, "escalation has to be legible or it reads as a duplicate");
});
