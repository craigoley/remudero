// W1-T14161: a reviewer FAIL (a) or (c) built on a counterexample names the production producer that can emit its
// input. A counterexample only a test seam, an injected fixture or hand-forged bytes can produce is (b). The rule is
// prompt text only: the tags, the follow-up grammar and the fold stay exactly as on origin/main.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { AcceptanceCriterion } from "#src/lib/plan.js";
import * as review from "#src/lib/review.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const CRITERION: AcceptanceCriterion = {
  claim: "ps-style start times parse every kernel stat record",
  proof: "grep: W1-T14161 fixture criterion in test/fixture.test.ts",
};
const PROMPT_INPUT = {
  task: { id: "W1-T14161", acceptance: [CRITERION], design: "keep the fold" },
  prUrl: "https://github.com/acme/remudero/pull/1", owner: "acme", repo: "remudero", headSha: "a".repeat(40),
};

function rule(): string {
  const value = (review as Record<string, unknown>).COUNTEREXAMPLE_PRODUCER_RULE;
  assert.equal(typeof value, "string", "COUNTEREXAMPLE_PRODUCER_RULE is an exported string");
  return value as string;
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

test("W1-T14161 criterion 1: the prompt's step 4 and the verdict contract each render the producer rule once", () => {
  const text = rule();
  assert.match(text, /A FAIL \(a\) or \(c\) that rests on a counterexample must name the production producer/);
  assert.match(text, /caller, the file:line, or the external source/);
  assert.match(text, /only a test seam, an injected fixture or hand-forged bytes can produce/);
  assert.match(text, /is \(b\): emit PASS and a REVIEW_FOLLOW_UP line/);
  assert.match(text, /"exactly as on origin\/main" is judged on the inputs production can produce/);
  assert.doesNotMatch(text, /\n/, "one line, so each surface carries it verbatim");

  for (const input of [PROMPT_INPUT, { ...PROMPT_INPUT, evidencePath: "/x/input.json", proofEvidencePath: "/x/proofs.json" }]) {
    const prompt = review.buildReviewPrompt(input as never);
    assert.equal(occurrences(prompt, text), 1, "the prompt carries the rule once");
    const at = prompt.indexOf(text);
    assert.ok(prompt.lastIndexOf("\n4. ", at) > prompt.lastIndexOf("\n3. ", at), "the rule sits in step 4");
    assert.ok(prompt.indexOf("\n5. ", at) > at, "before step 5");
  }
  for (const n of [1, 3]) {
    const contract = review.reviewerVerdictContract(n);
    assert.equal(occurrences(contract, text), 1, "the contract carries the rule once");
    const at = contract.indexOf(text);
    assert.ok(contract.indexOf("(a): on an input the claim itself names") < at, "inside the class block");
    assert.ok(contract.indexOf("ON A FAIL, THE TEXT AFTER THE TOKEN") > at, "before the clause guidance");
  }
});

// The class block, verdict forms and follow-up grammar as origin/main 907d10c06b renders them, byte for byte.
const BASE_VERDICT_FORMS = [
  "  REVIEW_VERDICT <n>: PASS",
  "  REVIEW_VERDICT <n>: FAIL (a) <the claim's own input and what the change does with it>",
  "  REVIEW_VERDICT <n>: FAIL (c) <the behaviour outside the claim that the change breaks, and where>",
  "  REVIEW_VERDICT <n>: UNABLE <what you could not inspect, and why>",
].join("\n");
const BASE_CLASS_BLOCK = [
  "(a): on an input the claim itself names, the change does not do what the claim says,",
  "or the proof never exercises that input. Name the input and what happens to it.",
  "(c): the change breaks behaviour outside the claim: a previously passing test, a",
  "preservation constraint, a production path. Name that behaviour and where it breaks.",
  "(b): a counterexample on an input outside the claim that exposes no regression",
  "or preservation violation. Use at most one follow-up line per criterion:",
  "  REVIEW_FOLLOW_UP <n>: <the input and the result>",
  "Emit PASS if (b) is the only finding. Emit the appropriate FAIL for a separate",
  "(a) or (c) finding on the same criterion, alongside the follow-up line.",
].join("\n");
const BASE_STEP4_CLASSES = [
  "   A violated preservation constraint is (c). A design-item deviation that makes the claim",
  "   false on its own inputs is (a). A deviation that changes neither claimed nor existing",
  "   behaviour and satisfies preservation constraints (such as where a test helper comes from)",
  "   is a (b) REVIEW_FOLLOW_UP line. Apply the same classes to an extra experiment: (a) if it",
  "   falsifies the claim on its own input, (c) if it exposes a regression or preservation",
  "   violation, and (b) for an out-of-claim result that does neither.",
].join("\n");

function judged(t: TestContext, transcript: string) {
  const dir = ownedFixtureDir(t, "counterexample-producer").dir;
  return review.judgeReview([CRITERION], {
    diff: "diff --git a/src/changed.ts b/src/changed.ts\n--- a/src/changed.ts\n+++ b/src/changed.ts\n@@ -0,0 +1 @@\n+export const changed = true;\n",
    report: `${CRITERION.claim}\n${CRITERION.proof}`, headCheckoutDir: dir, execProof: () => "pass",
    semantic: review.parseReviewerVerdicts(transcript, 1),
    semanticClauses: review.parseReviewerVerdictClauses(transcript, 1),
    reviewerUnable: review.parseReviewerUnable(transcript, 1),
  } as never).criteria[0]!;
}

test("W1-T14161 criterion 2: the tags, the follow-up grammar and the fold are exactly as on origin/main", (t) => {
  const contract = review.reviewerVerdictContract(3);
  assert.ok(contract.includes(BASE_VERDICT_FORMS), "the verdict forms are byte-equal");
  assert.ok(contract.includes(BASE_CLASS_BLOCK), "the (a)/(b)/(c) lines and REVIEW_FOLLOW_UP grammar are byte-equal");
  assert.equal(review.reviewerVerdictContract.length, 1);
  const prompt = review.buildReviewPrompt({ ...PROMPT_INPUT, evidencePath: "/x/input.json", proofEvidencePath: "/x/proofs.json" } as never);
  assert.ok(prompt.includes(BASE_STEP4_CLASSES), "step 4's class sentences are byte-equal");
  assert.equal(review.DOWNGRADE_TAG_RE.source, String.raw`^\s*\(\s*([abc])\s*\)[\s:]*`);
  assert.equal(review.REVIEWER_RECORD_LINE_RE.source,
    String.raw`(REVIEW_VERDICT\s+(\d+)\s*:\s*(PASS|FAIL|UNABLE)\b([^\r\n]*))|REVIEW_FOLLOW_UP[ \t]+(?<criterion>\d+)[ \t]*:(?<clause>[^\r\n]*)`);

  const producer = "a /proc/<pid>/stat record the kernel emits at src/lib/proc.ts:40 loses its start time";
  const named = judged(t, `REVIEW_VERDICT 1: FAIL (c) ${producer}`);
  assert.deepEqual([named.proof_exec, named.met, named.downgrade_class], ["executed_pass", false, "c"], "a FAIL naming a producer still binds");
  assert.ok(named.reason.includes(producer));
  const own = judged(t, `REVIEW_VERDICT 1: FAIL (a) ${producer}`);
  assert.deepEqual([own.met, own.downgrade_class], [false, "a"]);
  const seam = "an injected stat record with field 22 removed reads as undefined";
  const follow = judged(t, `REVIEW_VERDICT 1: FAIL (b) ${seam}`);
  assert.deepEqual([follow.met, follow.downgrade_class, follow.followUp], [true, "b", seam], "(b) folds to a follow-up");
  assert.deepEqual(review.parseReviewerFollowUps(`REVIEW_VERDICT 1: PASS\nREVIEW_FOLLOW_UP 1: ${seam}`, 1), [seam]);
  const bare = judged(t, "REVIEW_VERDICT 1: FAIL");
  assert.equal(bare.met, true, "W1-T2811: a bare FAIL cannot outweigh an executed_pass");
  assert.match(bare.reason, /REFUSED: the FAIL line named no reason/);
  assert.deepEqual(review.classifyDowngrade("no tag"), { class: "unclassified", text: "no tag" });
});
