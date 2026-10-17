/**
 * W1-T9929 — DEP-REVIEW HOLDS ONLY ON REQUIRED CHECKS.
 *
 * 2026-10-16: the advisory Semgrep `Scan` is red on main and every PR while mcp stays 1.30.0, and
 * `redChecks` counted it, so every Dependabot PR held (#11968 included) although GitHub would merge it.
 * A red outside the required set is named in `advisoryRed` and stays red on the PR; it never holds.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDepReviewEscalation,
  decideDepReview,
  depReviewRequiredSet,
  type DepReviewCheck,
  type DepReviewRequired,
} from "../src/lib/dep-review.js";

const REQUIRED: DepReviewRequired = { kind: "required", names: ["ci", "ci-gate", "commitlint", "remudero-review"] };

function minorBump(checks: DepReviewCheck[], required?: DepReviewRequired) {
  return decideDepReview({
    author: { login: "app/dependabot" },
    title: "chore(deps): bump example from 1.0.0 to 1.1.0",
    body: "",
    diff: "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n",
    checks,
    required,
  });
}

const GREEN_REQUIRED: DepReviewCheck[] = [
  { name: "ci-gate", conclusion: "SUCCESS" },
  { name: "commitlint", conclusion: "SUCCESS" },
];

test("W1-T9929: an advisory-only red arms and is named in advisoryRed", () => {
  const result = minorBump([...GREEN_REQUIRED, { name: "Scan", conclusion: "FAILURE" }], REQUIRED);
  assert.equal(result.decision, "arm");
  assert.deepEqual(result.redChecks, [], "an advisory red is not a holding red");
  assert.deepEqual(result.advisoryRed, ["Scan"]);
  assert.equal(result.judgedAgainst, "required");
  assert.equal(result.requiredFallback, undefined);
  assert.match(result.reason, /advisory red, not holding: Scan$/);

  // Positive control: the same checks with no required set hold, exactly as before this task.
  const before = minorBump([...GREEN_REQUIRED, { name: "Scan", conclusion: "FAILURE" }]);
  assert.equal(before.decision, "hold");
  assert.deepEqual(before.redChecks, ["Scan"]);
  assert.equal(before.judgedAgainst, "all-checks");

  // No advisory red: the arm reason is unchanged.
  const clean = minorBump(GREEN_REQUIRED, REQUIRED);
  assert.equal(clean.decision, "arm");
  assert.deepEqual(clean.advisoryRed, []);
  assert.doesNotMatch(clean.reason, /advisory/);
});

test("W1-T9929: a required red still holds and the reason names only required checks", () => {
  const result = minorBump([
    { name: "ci-gate", conclusion: "SUCCESS" },
    { name: "commitlint", conclusion: "FAILURE" },
    { name: "Scan", conclusion: "FAILURE" },
    { context: "remudero-review", state: "FAILURE" },
  ], REQUIRED);
  assert.equal(result.decision, "hold");
  assert.deepEqual(result.redChecks, ["commitlint"], "remudero-review stays excluded (W1-T3244); Scan is advisory");
  assert.equal(result.reason, "required check(s) not green: commitlint");
  assert.deepEqual(result.advisoryRed, ["Scan"]);

  // The aged-hold escalation keeps its Blocker line to required reds and names the advisory one apart.
  const escalation = buildDepReviewEscalation({
    prUrl: "https://github.com/craigoley/remudero/pull/11968", prNumber: 11968, title: "t", body: "", semverLevel: "minor",
    hold: { headSha: "a".repeat(40), redChecks: result.redChecks, advisoryRed: result.advisoryRed },
  });
  const lines = escalation.detail.split("\n");
  assert.ok(lines.includes("Blocker: required check(s) not green: commitlint."));
  assert.ok(lines.includes("Advisory red, not holding (still visible on the PR): Scan."));
  const noAdvisory = buildDepReviewEscalation({
    prUrl: "u", prNumber: 1, title: "t", body: "", semverLevel: "minor", hold: { headSha: "b".repeat(40), redChecks: ["ci"] },
  });
  assert.doesNotMatch(noAdvisory.detail, /Advisory red/);
});

test("W1-T9929: an unreadable required set holds on every red and names the fallback", () => {
  const unreadable = depReviewRequiredSet({ kind: "unreadable", reason: "HTTP 403" }, ["ci", "commitlint"]);
  assert.deepEqual(unreadable, { kind: "all-checks", fallback: "protection-unreadable:HTTP 403" });
  const result = minorBump([...GREEN_REQUIRED, { name: "Scan", conclusion: "FAILURE" }], unreadable);
  assert.equal(result.decision, "hold", "fail closed: an unknown required set holds on Scan as today");
  assert.deepEqual(result.redChecks, ["Scan"]);
  assert.deepEqual(result.advisoryRed, []);
  assert.equal(result.judgedAgainst, "all-checks");
  assert.equal(result.requiredFallback, "protection-unreadable:HTTP 403");

  assert.deepEqual(depReviewRequiredSet({ kind: "none" }, ["ci"]), { kind: "all-checks", fallback: "protection-none" });
  assert.deepEqual(depReviewRequiredSet({ kind: "contexts", contexts: ["ci-gate", "remudero-review"] }, []),
    { kind: "all-checks", fallback: "ci-gate-required-empty" }, "protection names ci-gate but its REQUIRED list is unreadable");
  assert.deepEqual(depReviewRequiredSet({ kind: "contexts", contexts: ["remudero-review", "ci-gate"] }, ["commitlint", "ci", "ci-gate"]),
    { kind: "required", names: ["ci", "ci-gate", "commitlint", "remudero-review"] }, "the union, deduped and sorted");
  assert.deepEqual(depReviewRequiredSet({ kind: "contexts", contexts: ["build"] }, []), { kind: "required", names: ["build"] },
    "a protection list without ci-gate needs no ci-gate REQUIRED");
});
