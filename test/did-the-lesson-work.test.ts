// test/did-the-lesson-work.test.ts — W1-T3055.
//
// The one question that settles whether the CI-learning loop is worth running, and nothing asked it.
//
// Every signal upstream measures something SHORT of the outcome. `cited_count` measured INJECTION —
// was the fact put in a prompt — and retro.ts's own comment calls it "a proxy standing in for a
// signal nothing produced", which ranked the least-INJECTED entry as least useful and fed the next
// injection. W1-T2760 added `LEARNINGS_USED`, which is better and is still a worker's own CLAIM
// that it used a lesson. A claim is not an outcome.
//
// The outcome is: after a lesson about gate G landed, did G go on refusing pull requests?

import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeCiLessonEfficacy, parseFiledCiLesson } from "../src/lib/measurement-cadence.js";

const pair = (pr: number, gate: string) => ({ pr, gate, state: "repaired" as const, redSha: "a", repairFiles: [] });
const lesson = (gate: string, watermarkPr: number) => ({ findingId: `ci-learning:1:${gate}`, gate, watermarkPr });

test("W1-T3055: a gate that kept refusing after the lesson landed reads RECURRED, naming the PRs", () => {
  const corpus = { pairs: [pair(1, "g"), pair(2, "g"), pair(9, "g"), pair(11, "g")] };
  const [r] = judgeCiLessonEfficacy(corpus, [lesson("g", 2)]);
  assert.equal(r.verdict, "recurred");
  assert.deepEqual(r.recurredPrs, [9, 11], "the lesson did not take, and these are the receipts");
});

test("W1-T3055: a gate silent afterwards reads HELD — but only because later PRs existed to be silent about", () => {
  const corpus = { pairs: [pair(1, "g"), pair(2, "g"), pair(9, "other"), pair(11, "other")] };
  const [r] = judgeCiLessonEfficacy(corpus, [lesson("g", 2)]);
  assert.equal(r.verdict, "held");
  assert.deepEqual(r.recurredPrs, []);
  assert.equal(r.laterPrsSeen, 2, "the denominator is carried, so `held` can be checked rather than believed");
});

test("W1-T3055: NO later PRs is UNMEASURABLE, never held — a claim over an empty set is not a pass", () => {
  // The verdict that matters most. A lesson filed from the newest pull requests in a window has no
  // "after" yet; calling that success would be the vacuous pass this repo's coverage and ledger
  // sections already refuse, and it would accumulate silently as the loop's headline number.
  const corpus = { pairs: [pair(1, "g"), pair(2, "g")] };
  const [r] = judgeCiLessonEfficacy(corpus, [lesson("g", 2)]);
  assert.equal(r.verdict, "unmeasurable");
  assert.equal(r.laterPrsSeen, 0);
  assert.deepEqual(r.recurredPrs, []);
});

test("W1-T3055: a gate is judged only against ITS OWN later failures, never another gate's", () => {
  const corpus = { pairs: [pair(1, "g"), pair(9, "unrelated"), pair(10, "unrelated")] };
  const [r] = judgeCiLessonEfficacy(corpus, [lesson("g", 1)]);
  assert.equal(r.verdict, "held", "another gate's noise must not convict this lesson");
});

test("W1-T3055: one PR refusing twice on the same gate counts once", () => {
  const corpus = { pairs: [pair(1, "g"), pair(9, "g"), pair(9, "g")] };
  const [r] = judgeCiLessonEfficacy(corpus, [lesson("g", 1)]);
  assert.deepEqual(r.recurredPrs, [9], "a PR is one recurrence however many times it tripped");
});

test("W1-T3055: the watermark is read from the shard's own field, and its ABSENCE is unjudgeable", () => {
  const filed = [
    "- id: W1-T1",
    '  origin: "ci-learning:368:ci-gate"',
    "  ci_learning_prs: [368, 402, 511]",
  ].join("\n");
  assert.deepEqual(parseFiledCiLesson(filed), {
    findingId: "ci-learning:368:ci-gate",
    gate: "ci-gate",
    watermarkPr: 511,
    // The HIGHEST, not the origin's first: judging a lesson against pull requests it was derived
    // FROM would score it on its own evidence.
  });

  // Every lesson filed before this task carries no watermark. Undefined — unjudgeable — rather than
  // falling back to the origin's PR, which would do exactly that self-scoring.
  const older = ['- id: W1-T1', '  origin: "ci-learning:368:ci-gate"'].join("\n");
  assert.equal(parseFiledCiLesson(older), undefined);
});
