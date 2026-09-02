import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { judgeCriterion, judgeReview } from "../src/lib/review.js";

// W1-T2713 — the floor for a plan-only filing used to compare a proof loaded from the task
// shard with independently-written PR-body prose. That made a filename's accidental vocabulary
// overlap decide the only binding lane. These tests pin the source boundary: a criterion resolved
// from a shard is self-authenticating as PRESENT, while body-derived and implementation criteria
// keep the existing responsiveness check.

const CRITERION = {
  claim: "the account-visible choices are constrained by the active routing policy",
  proof: "unit test: test/xylophone-zebra.test.ts",
};

function planShardDiff(): string {
  return [
    "diff --git a/plan/tasks.d/W1-T999-example.yaml b/plan/tasks.d/W1-T999-example.yaml",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/plan/tasks.d/W1-T999-example.yaml",
    "@@ -0,0 +1,4 @@",
    "+- id: W1-T999",
    "+  files: [src/lib/example.ts, test/xylophone-zebra.test.ts]",
    "+  status: queued",
    "+  title: example filing",
  ].join("\n");
}

test("criteria resolved from a shard do not depend on an opaque test filename echoing PR prose", () => {
  const verdict = judgeReview([CRITERION], {
    diff: planShardDiff(),
    report: "File the account-model policy task separately from implementation.",
    taskDeclaredFiles: ["src/lib/example.ts", "test/xylophone-zebra.test.ts"],
  });

  assert.equal(verdict.planOnly, true);
  assert.equal(verdict.state, "success", "zero body/proof overlap cannot fail an authoritative shard filing");
  assert.equal(verdict.criteria[0].floorMet, true);
  assert.match(verdict.criteria[0].reason, /authoritative criterion source/);
  assert.doesNotMatch(verdict.criteria[0].reason, /report|PR body/i, "the reason must not blame correct body prose");
});

test("the same text remains unsubstantiated when criteria came from the body or the diff implements code", () => {
  const fromBody = judgeReview([CRITERION], {
    diff: planShardDiff(),
    report: "File the account-model policy task separately from implementation.",
  });
  assert.equal(fromBody.planOnly, true);
  assert.equal(fromBody.state, "failure", "no resolved shard means the body remains the floor source");
  assert.match(fromBody.criteria[0].reason, /report does not substantiate/);

  const implementation = judgeReview([CRITERION], {
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
    report: "File the account-model policy task separately from implementation.",
    taskDeclaredFiles: ["src/lib/example.ts", "test/xylophone-zebra.test.ts"],
  });
  assert.equal(implementation.planOnly, false);
  assert.equal(implementation.state, "failure", "resolved implementation work still must substantiate the proof");
  assert.match(implementation.criteria[0].reason, /report does not substantiate/);
});

test("W1-T219 stays fail-closed when an authoritative proof has no distinctive anchor", () => {
  const verdict = judgeReview(
    [{ claim: "a genuinely unsubstantiated filing", proof: "to be or not to be" }],
    {
      diff: planShardDiff(),
      report: "Everything requested was filed.",
      taskDeclaredFiles: ["src/lib/example.ts"],
    },
  );

  assert.equal(verdict.state, "failure");
  assert.equal(verdict.criteria[0].floorMet, false);
  assert.match(verdict.criteria[0].reason, /no mechanical anchors/);
});

test("the measured four-of-six margin and MIN_COVERAGE=0.6 remain pinned", () => {
  const measured = {
    claim: "the measured naming-coincidence control",
    proof: "unit test provider routing console controls",
  };
  const fourOfSix = judgeCriterion(measured, new Set(["provider", "routing", "console", "controls"]));
  const threeOfSix = judgeCriterion(measured, new Set(["provider", "routing", "console"]));

  assert.equal(fourOfSix.met, true, "the observed 4/6 = 0.667 control still clears the unchanged floor");
  assert.match(fourOfSix.reason, /matched 4\/6/);
  assert.equal(threeOfSix.met, false, "3/6 remains below the floor");
  assert.match(threeOfSix.reason, /matched 3\/6/);

  const source = readFileSync(new URL("../src/lib/review.ts", import.meta.url), "utf8");
  assert.match(source, /const MIN_COVERAGE = 0\.6;/, "the fix changes the source text, never the threshold");
});
