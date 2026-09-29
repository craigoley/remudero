import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FILING_FORWARD_ADVISORY, judgeReview, type WhitelistedProof } from "../src/lib/review.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

/**
 * 2026-09-29 operator ruling: the reviewer refuses what is risky or broken, and passes the rest with a recorded
 * advisory. A plan-only FILING cannot build the test or source its proofs name, so a no-match or failure against a
 * target the diff does not change is an advisory there. MEASURED 2026-09-15..29: seven reviewer-unmet fix rounds on
 * filing PRs #6055 #6303 #6477 #6478 #6503 #7149 were this class, each round unable to make the proof pass.
 * The build head keeps the hard refusal, and so does a filing proof about the diff's own shard.
 */

const CLEAN_PLAN_LINT = { ran: true as const, label: "fixture", checked: 1, violations: [] };
const SHARD = "plan/tasks.d/W1-T9990-example.yaml";

function filingDiff(): string {
  return [
    `diff --git a/${SHARD} b/${SHARD}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${SHARD}`,
    "@@ -0,0 +1,2 @@",
    "+- id: W1-T9990",
    "+  status: queued",
  ].join("\n");
}

function buildDiff(): string {
  return [
    "diff --git a/src/lib/widget.ts b/src/lib/widget.ts",
    "index 111..222 100644",
    "--- a/src/lib/widget.ts",
    "+++ b/src/lib/widget.ts",
    "@@ -1 +1 @@",
    "-export const a = 1;",
    "+export const a = 2;",
  ].join("\n");
}

const TITLE_PROOF = "unit test: widgetResolvesItsOwner";
const SOURCE_GREP = "grep: resolveWidgetOwner( in src/lib/owner.ts";
const OWN_SHARD_GREP = `grep: status: done in ${SHARD}`;

function judge(diff: string, proof: string, outcome: "fail" | "no-match") {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}filing-advisory-`));
  try {
    const report = `Filed W1-T9990. ${proof}`;
    return judgeReview([{ claim: "the future widget is proven", proof }], {
      planLint: CLEAN_PLAN_LINT,
      diff,
      report,
      headCheckoutDir: dir,
      execProof: (_w: WhitelistedProof) => outcome,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a filing head names a test title it cannot build as an advisory not a failure", () => {
  const verdict = judge(filingDiff(), TITLE_PROOF, "no-match");
  const c = verdict.criteria[0];
  assert.equal(c.proof_exec, "not_yet_built");
  assert.equal(c.proof_skip, "forward-reference");
  assert.ok(c.reason.includes(FILING_FORWARD_ADVISORY), c.reason);
  assert.equal(verdict.state, "success", "the report substantiates it, so the filing passes on the keyword floor");
});

test("a filing head grep on source the diff does not change is an advisory not a failure", () => {
  const c = judge(filingDiff(), SOURCE_GREP, "fail").criteria[0];
  assert.equal(c.proof_exec, "not_yet_built");
  assert.ok(c.reason.includes("src/lib/owner.ts"), c.reason);
  assert.ok(c.reason.includes(FILING_FORWARD_ADVISORY), c.reason);
});

test("a build head still refuses the same unresolvable test title", () => {
  const verdict = judge(buildDiff(), TITLE_PROOF, "no-match");
  assert.equal(verdict.criteria[0].proof_exec, "executed_fail", "a build CAN write the test, so theater stays a refusal");
  assert.equal(verdict.state, "failure");
});

test("a filing grep against its own shard still fails when the shard does not say it", () => {
  const verdict = judge(filingDiff(), OWN_SHARD_GREP, "fail");
  assert.equal(verdict.criteria[0].proof_exec, "executed_fail", "the diff changes this file, so the failure is real");
  assert.equal(verdict.state, "failure");
});

test("a filing head names a missing test file as an advisory not a failure", () => {
  const c = judge(filingDiff(), "unit test: test/a-widget-not-yet-written.test.ts", "fail").criteria[0];
  assert.equal(c.proof_exec, "not_yet_built");
  assert.ok(c.reason.includes("test/a-widget-not-yet-written.test.ts"), c.reason);
});

test("a filing head test that ran and failed is still refused because it may read the plan", () => {
  const titled = judge(filingDiff(), TITLE_PROOF, "fail").criteria[0];
  assert.equal(titled.proof_exec, "executed_fail", "a matching test ran and FAILED — not absence");
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}filing-present-`));
  try {
    mkdirSync(join(dir, "test"));
    writeFileSync(join(dir, "test", "reads-the-plan.test.ts"), "// present on the head\n");
    const present = judgeReview([{ claim: "the plan census holds", proof: "unit test: test/reads-the-plan.test.ts" }], {
      planLint: CLEAN_PLAN_LINT,
      diff: filingDiff(),
      report: "unit test: test/reads-the-plan.test.ts",
      headCheckoutDir: dir,
      execProof: () => "fail",
    }).criteria[0];
    assert.equal(present.proof_exec, "executed_fail", "a PRESENT test file that fails is a real failure on a filing too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
