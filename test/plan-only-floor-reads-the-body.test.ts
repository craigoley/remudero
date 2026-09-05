import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeReview } from "../src/lib/review.js";

// R-15 (docs/audits/recon-2026-09-05.md) — W1-T2713 shipped its plan-only arm as
// `floorTokens = tokenize(claim + proof)`, drawing the mechanical floor from THE VERY CRITERION IT
// WAS JUDGING. A criterion trivially contains its own proof, so `proofKeywords(proof)` was a subset
// of the floor tokens and coverage was 1.0 BY CONSTRUCTION: every resolved-shard criterion on a
// plan-only diff read `met` against ANY body, an EMPTY one included. Because `judgeReview` decides
// a plan-only diff's state on `floorUnmet` alone, nothing short of an `executed_fail` could fail
// such a PR — which defeats W1-T2713's own third acceptance claim ("a filing that genuinely fails
// to substantiate its criteria still fails") and its falsifier's explicit refusal of any change
// that makes the lane unfailable.
//
// The fix keeps W1-T2713's real finding — a test FILENAME's accidental vocabulary must not decide
// the only binding lane (#3665 cleared at 4/6 purely on a path named after four words its body
// happened to use) — and changes only WHICH text of the criterion supplies the keywords. The floor
// is always scored against the REPORT. These tests pin that the floor can read BELOW 1.0 again.

const CRITERION = {
  claim: "the recycle supervisor observes readiness before acting on a confirmation",
  // Deliberately opaque: nothing in this path appears in either body below, so if the verdict ever
  // moves with this string again the floor has gone back to scoring filename vocabulary.
  proof: "unit test: test/xylophone-zebra-quokka.test.ts",
};

function planShardDiff(): string {
  return [
    "diff --git a/plan/tasks.d/W1-T999-example.yaml b/plan/tasks.d/W1-T999-example.yaml",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/plan/tasks.d/W1-T999-example.yaml",
    "@@ -0,0 +1,4 @@",
    "+- id: W1-T999",
    "+  files: [src/lib/example.ts, test/xylophone-zebra-quokka.test.ts]",
    "+  status: queued",
    "+  title: example filing",
  ].join("\n");
}

const DECLARED = ["src/lib/example.ts", "test/xylophone-zebra-quokka.test.ts"];

test("(i) an EMPTY body cannot meet a resolved-shard criterion, and the reason names the floor", () => {
  const verdict = judgeReview([CRITERION], {
    diff: planShardDiff(),
    report: "",
    taskDeclaredFiles: DECLARED,
  });

  assert.equal(verdict.planOnly, true, "the fixture must exercise the plan-only arm");
  assert.equal(
    verdict.criteria[0].floorMet,
    false,
    "R-15: an empty body substantiates nothing — a floor that reads the criterion itself scored this 1.0",
  );
  assert.equal(verdict.state, "failure");
  assert.match(
    verdict.criteria[0].reason,
    /report does not substantiate it \(matched 0\/7 claim keywords\)/,
    "the reason must name the report as the source and report a coverage BELOW 1.0",
  );
});

test("(ii) a body that carries the claim's keywords meets the same criterion", () => {
  const verdict = judgeReview([CRITERION], {
    diff: planShardDiff(),
    report:
      "The recycle supervisor observes readiness on the host and acts only on a fresh signed " +
      "confirmation; nothing runs before that observation.",
    taskDeclaredFiles: DECLARED,
  });

  assert.equal(verdict.planOnly, true);
  assert.equal(verdict.criteria[0].floorMet, true);
  assert.equal(verdict.state, "success");
  assert.match(verdict.criteria[0].reason, /proof substantiated in report \(matched \d+\/7 claim keywords\)/);
});

test("(iii) an executed_fail still OVERRIDES a body that covers every claim keyword", () => {
  const executable = {
    claim: "the recycle supervisor observes readiness before acting on a confirmation",
    // NOT a file this diff's shard declares, so W1-T456's `not_yet_built` forward-reference
    // carve-out cannot swallow the failure and the executed outcome is what is under test.
    proof: "grep: supervisor in src/lib/untouched-by-this-shard.ts",
  };
  const verdict = judgeReview([executable], {
    diff: planShardDiff(),
    // Pastes the claim verbatim, so the keyword floor is a full 1.0 and only execution can fail it.
    report: "the recycle supervisor observes readiness before acting on a confirmation",
    taskDeclaredFiles: DECLARED,
    headCheckoutDir: "/nonexistent-head-checkout-for-this-fixture",
    execProof: () => "fail",
  });

  assert.equal(verdict.planOnly, true);
  assert.equal(verdict.criteria[0].proof_exec, "executed_fail");
  assert.equal(verdict.criteria[0].floorMet, false, "execution overrides the keyword floor in the UNMET direction");
  assert.equal(verdict.state, "failure");
});

test("(iv) GOLDEN — a non-plan-only diff's floor reason is byte-identical to the pre-fix text", () => {
  const verdict = judgeReview([CRITERION], {
    diff:
      planShardDiff() +
      "\n" +
      [
        "diff --git a/src/lib/example.ts b/src/lib/example.ts",
        "index 1111111..2222222 100644",
        "--- a/src/lib/example.ts",
        "+++ b/src/lib/example.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
    report: "An unrelated body.",
    taskDeclaredFiles: DECLARED,
  });

  assert.equal(verdict.planOnly, false);
  assert.equal(
    verdict.criteria[0].reason,
    "proof unmet: report does not substantiate it (matched 0/5 proof keywords)",
    "the implementing path keeps the proof-keyword floor and its exact wording",
  );
});
