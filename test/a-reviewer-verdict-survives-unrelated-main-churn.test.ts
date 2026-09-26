import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MATERIAL_ADVANCE_PATHS,
  REVIEW_MATERIAL_ADVANCE_PATHS,
  advanceIsMaterial,
  reviewAdvanceIsMaterial,
  checkReviewerCodeFreshness,
} from "../src/lib/self-sync.js";

// W1-T3735. The reviewer computed PASS and threw it away: 200 `review.post_refused` rows on the
// live fleet, every one `attempted_state: "success"`, `evidence: "executed"`. Cause: the RESTART
// materiality list ("would a different module graph load?") was reused to answer "could this
// verdict have changed?". Any src/ merge invalidated every pending verdict, and main moves faster
// than the daemon can sync — so nothing could post, and nothing merged.

test("an unrelated source merge no longer invalidates a verdict", () => {
  const unrelated = ["src/lib/cash-actuals.ts"];
  assert.equal(advanceIsMaterial(unrelated), true, "it still forces a RESTART — that part is right");
  assert.equal(reviewAdvanceIsMaterial(unrelated), false, "but it cannot change a review verdict");
});

test("a change to the review path DOES still invalidate a verdict", () => {
  // THE LOAD-BEARING HALF. Narrowing is only safe if the paths that decide a verdict still count.
  for (const p of ["src/lib/review.ts", "src/run-task.ts", "src/lib/plan.ts", "src/lib/task-linter.ts", "package.json"]) {
    assert.equal(reviewAdvanceIsMaterial([p]), true, `${p} must remain material to a review`);
  }
});

test("review materiality is a STRICT SUBSET of restart materiality, never a superset", () => {
  // If this ever inverts, something is material to a verdict but not to a restart — which would
  // mean a reviewer trusting code the process would not even reload.
  for (const p of REVIEW_MATERIAL_ADVANCE_PATHS) {
    assert.equal(advanceIsMaterial([p]), true, `${p} must also force a restart`);
  }
  assert.ok(
    REVIEW_MATERIAL_ADVANCE_PATHS.length > 0 && MATERIAL_ADVANCE_PATHS.length > 0,
    "both lists must be non-empty, or the comparison proves nothing",
  );
});

test("it still FAILS TOWARD REFUSING — an unreadable advance is material", () => {
  // Narrowing WHICH paths count must never narrow what "I cannot tell" means.
  assert.equal(reviewAdvanceIsMaterial(undefined), true);
  assert.equal(reviewAdvanceIsMaterial([]), true);
  assert.equal(reviewAdvanceIsMaterial(["   "]), true);
});

test("the freshness check reports FRESH for an immaterial advance, so the verdict can post", () => {
  // End to end through the real function: a behind service whose diff touches nothing on the
  // review path must come back fresh, which is what lets postReviewStatusGuarded publish.
  const freshness = checkReviewerCodeFreshness("/unused", {}, {
    git: (args: string[]) => {
      if (args[0] === "merge-base") return "a".repeat(40);
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    },
    checkServiceFreshness: () => ({
      status: "loaded",
      behind: { oldSha: "a".repeat(40), newSha: "b".repeat(40), changedPaths: ["src/lib/cash-actuals.ts", "plan/tasks.yaml"] },
    }),
  } as never);
  assert.equal(freshness.status, "fresh");
  assert.equal((freshness as { advance: string }).advance, "immaterial");
});

test("and STALE when the advance really did touch the review path", () => {
  const freshness = checkReviewerCodeFreshness("/unused", {}, {
    git: (args: string[]) => {
      if (args[0] === "merge-base") return "a".repeat(40);
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    },
    checkServiceFreshness: () => ({
      status: "loaded",
      behind: { oldSha: "a".repeat(40), newSha: "b".repeat(40), changedPaths: ["src/lib/review.ts"] },
    }),
  } as never);
  assert.equal(freshness.status, "stale");
});
