/**
 * test/fix-rung-classify.test.ts — W1-T2891 (decomposition step 8).
 *
 * `classifyUpdateBranchFailure`, `detectReviewFalseBlock`, `detectCiLogVerdictUnchanged` and
 * `classifyNoPrShape` moved out of src/run-task.ts into src/lib/fix-rung-classify.ts unchanged —
 * this suite imports the LIB MODULE DIRECTLY (never the run-task.ts compatibility re-export) and
 * feeds each classifier the same fixture shapes their pre-move tests in test/sweep.test.ts,
 * test/run-task.test.ts, test/fix-rung-verdict-unchanged.test.ts and
 * test/worker-no-wait-contract.test.ts already use, asserting the identical verdicts. It exists
 * to prove the move is behavior-preserving, not to re-litigate each classifier's own design —
 * that documentation and those falsifiers stay where they already live.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyUpdateBranchFailure,
  detectReviewFalseBlock,
  detectCiLogVerdictUnchanged,
  classifyNoPrShape,
} from "../src/lib/fix-rung-classify.js";
import type { CiFailure } from "../src/lib/sweep.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";

// ── shared fixtures, mirroring the pre-move suites' own conventions ─────────────────────────────

function criterion(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
  return { proof: "proof", reason: "", proof_exec: "not_executable", ...over };
}

function fakeReview(
  state: "success" | "failure",
  criteria: CriterionVerdict[],
  headSha = "deadbeef",
): ReviewVerdict & { headSha: string } {
  return {
    state,
    criteria,
    testTheater: false,
    summary: state === "success" ? "all criteria met" : "unmet criteria",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
  };
}

function annotated(name: string, messages: string[]): CiFailure {
  return {
    name,
    logTail: messages.join("\n"),
    tailSource: "annotations",
    annotationFallback: { outcome: "recovered" },
  };
}

// ── classifyUpdateBranchFailure (test/sweep.test.ts's own fixture texts) ────────────────────────

test("classifyUpdateBranchFailure: conflict/divergence-shaped stderr classifies as conflict", () => {
  for (const s of [
    "HTTP 422: expected_head_sha does not match the pull request head",
    "the merge conflicts with target branch",
    "branch has diverged from base",
    "Merge conflict in src/run-task.ts",
  ]) {
    assert.equal(classifyUpdateBranchFailure(s), "conflict", `"${s}" names a conflict`);
  }
});

test("classifyUpdateBranchFailure: an ordinary error text classifies as error, never conflict", () => {
  for (const s of ["HTTP 500: internal server error", "network timeout", "rate limited"]) {
    assert.equal(classifyUpdateBranchFailure(s), "error", `"${s}" is an ordinary error`);
  }
});

// ── detectReviewFalseBlock (test/run-task.test.ts's own fixture shapes) ─────────────────────────

test("detectReviewFalseBlock: an UNCHANGED head sha whose review re-fails the SAME criterion is a false-block", () => {
  const priorHeadSha = "sha-0";
  const priorUnmetClaims = new Set(["criterion A merges cleanly"]);
  const current = fakeReview(
    "failure",
    [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken" })],
    "sha-0",
  );
  const reason = detectReviewFalseBlock({ priorHeadSha, priorUnmetClaims, current });
  assert.ok(reason, "an unchanged head sha re-blocking the identical criterion is detected as a false-block");
});

test("detectReviewFalseBlock: the deterministic floor passing while the spawned reviewer blocks is a false-block regardless of head sha", () => {
  const priorHeadSha = "sha-0";
  const priorUnmetClaims = new Set(["criterion A merges cleanly"]);
  const current = {
    ...fakeReview(
      "failure",
      [criterion({ claim: "criterion A merges cleanly", met: false, reason: "semantic downgrade", proof_exec: "executed_pass" })],
      "sha-1",
    ),
    floorState: "success" as const,
  };
  const reason = detectReviewFalseBlock({ priorHeadSha, priorUnmetClaims, current });
  assert.ok(reason, "floor-passes-but-reviewer-blocks is detected as a false-block even on a changed head sha");
});

test("detectReviewFalseBlock: a genuine deficiency (changed head sha, floor also failing) trips neither signal", () => {
  const priorHeadSha = "sha-0";
  const priorUnmetClaims = new Set(["criterion A merges cleanly"]);
  const current = {
    ...fakeReview(
      "failure",
      [criterion({ claim: "criterion A merges cleanly", met: false, reason: "still broken", proof_exec: "executed_fail" })],
      "sha-1",
    ),
    floorState: "failure" as const,
  };
  assert.equal(
    detectReviewFalseBlock({ priorHeadSha, priorUnmetClaims, current }),
    undefined,
    "a genuine deficiency is never mis-escaped as a false-block",
  );
});

test("detectReviewFalseBlock: a passing review is never a false-block", () => {
  const current = fakeReview("success", [criterion({ claim: "criterion A merges cleanly", met: true })], "sha-0");
  assert.equal(
    detectReviewFalseBlock({ priorHeadSha: "sha-0", priorUnmetClaims: new Set(["criterion A merges cleanly"]), current }),
    undefined,
  );
});

// ── detectCiLogVerdictUnchanged (test/fix-rung-verdict-unchanged.test.ts's own fixture shapes) ──

test("detectCiLogVerdictUnchanged: IDENTICAL annotation sets, reordered, are detected as unchanged (order-insensitive)", () => {
  const got = detectCiLogVerdictUnchanged({
    priorFailures: [annotated("ci", ["finding A", "finding B"])],
    currentFailures: [annotated("ci", ["finding B", "finding A"])],
  });
  assert.match(got ?? "", /ci-log false-block/);
});

test("detectCiLogVerdictUnchanged: a genuinely different finding set is real progress — never 'unchanged'", () => {
  const got = detectCiLogVerdictUnchanged({
    priorFailures: [annotated("ci", ["finding A"])],
    currentFailures: [annotated("ci", ["finding A", "finding B (new)"])],
  });
  assert.equal(got, undefined);
});

test("detectCiLogVerdictUnchanged: a non-annotation tail source is never comparable — abstains", () => {
  const got = detectCiLogVerdictUnchanged({
    priorFailures: [annotated("ci", ["finding A"])],
    currentFailures: [{ name: "ci", logTail: "finding A", tailSource: "log" }],
  });
  assert.equal(got, undefined);
});

test("detectCiLogVerdictUnchanged: empty prior or current evidence abstains rather than matching vacuously", () => {
  assert.equal(detectCiLogVerdictUnchanged({ priorFailures: [], currentFailures: [annotated("ci", ["x"])] }), undefined);
  assert.equal(detectCiLogVerdictUnchanged({ priorFailures: [annotated("ci", ["x"])], currentFailures: [] }), undefined);
});

// ── classifyNoPrShape (test/worker-no-wait-contract.test.ts's own real corpus) ───────────────────

test("classifyNoPrShape: every real wait-shaped excerpt classifies as awaiting-notification", () => {
  for (const excerpt of [
    "I'll pause here and wait for the background test suite (task b8zoysdek) to finish; I'll be notified automatically when it completes.",
    "I'll stop issuing further tool calls now and wait for the background watcher's completion notification before proceeding to preflight and push.",
    "Waiting for the background preflight run to finish; will resume once notified.",
  ]) {
    assert.equal(classifyNoPrShape(excerpt), "awaiting-notification", `should classify as a stalled wait: ${excerpt.slice(0, 70)}…`);
  }
});

test("classifyNoPrShape: an honest no-op excerpt is never labelled awaiting-notification", () => {
  for (const excerpt of [
    "All 2/2 acceptance tests pass, mechanically verified live",
    "Working tree is clean... No code changes needed or made",
    "this task's acceptance is already satisfied on origin/main",
  ]) {
    assert.notEqual(classifyNoPrShape(excerpt), "awaiting-notification", `a correct no-op must not be labelled a stalled wait: ${excerpt}`);
  }
  assert.notEqual(classifyNoPrShape(undefined), "awaiting-notification");
  assert.notEqual(classifyNoPrShape(""), "awaiting-notification");
});
