// W1-T2221 — "the plan-only carve-out is gated on an execution outcome, not on the diff".
//
// `planOnly` (review.ts:planOnly, computed off `diffFiles`/`isInPlanScope`) was already correct.
// The bug was in the CONSUMER: the carve-out's summary was reachable only through
// `state === "success" && capped ? planOnly ? planOnlySummary(...) : ...`, and `state` itself
// never consulted `planOnly` at all — it rolled up on `unmet`, which includes SEMANTIC
// downgrades. So a plan-only filing (one `plan/tasks.d/*.yaml` file, no code) whose declared
// proof path happened to name a test that already exists on the PR head:
//   1. RESOLVED and RAN (proof_exec !== not_executable) ⇒ `capped` false ⇒ the `planOnly` branch
//      of the summary was never reached even on a clean pass (acceptance 1).
//   2. got semantically downgraded — the semantic lane judged a SPECIFICATION OF WORK NOT YET
//      DONE as "non-responsive", which is correct about the artifact and wrong about the verdict
//      — and that downgrade alone flipped `state` to "failure" before the carve-out was ever
//      consulted (acceptance 2).
//
// Measured live on PR #2707 (rationale (1)/(2)/(4) in this task's own plan shard): four PRs with
// the SAME single-plan-shard diff shape passed (their proof paths did not resolve, so
// `not_executable`/`not_yet_built` kept them capped); #2707's proof paths named an existing file
// (`test/settings.test.ts`) and failed instead.
//
// The fix: `state` now rolls a plan-only diff up on the DETERMINISTIC FLOOR (`floorMet`,
// pre-downgrade) rather than the semantically-downgraded `met`, and the summary consults
// `planOnly` BEFORE `capped` rather than behind it. A code diff (`planOnly` false) is
// byte-identical to before on every path this test exercises (acceptance 5).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { judgeReview } from "../src/lib/review.js";

/** A minimal, well-formed plan-shard diff — the exact shape every #2707-sibling PR carried:
 *  ONE file, entirely under `plan/tasks.d/`, adding a task shard. Never touches src/test/etc. */
function planShardDiff(taskId = "W1-T999"): string {
  return [
    `diff --git a/plan/tasks.d/${taskId}-example.yaml b/plan/tasks.d/${taskId}-example.yaml`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/plan/tasks.d/${taskId}-example.yaml`,
    "@@ -0,0 +1,3 @@",
    `+- id: ${taskId}`,
    "+  status: queued",
    "+  title: example filing",
  ].join("\n");
}

/** The same shard, plus a second hunk touching a file OUTSIDE plan scope. */
function planShardPlusCodeDiff(taskId = "W1-T999"): string {
  return (
    planShardDiff(taskId) +
    "\n" +
    [
      "diff --git a/src/example.ts b/src/example.ts",
      "index 111..222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n")
  );
}

test("acceptance 1 — a plan-only diff reaches its plan-only verdict even when a proof resolved and ran", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w2221-resolved-"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "already-exists.test.ts"), "// pre-existing test on the PR head\n");
  const criteria = [{ claim: "W1-T999 filed as a well-formed plan task shard", proof: "unit test: test/already-exists.test.ts" }];
  const report = "Filed W1-T999. unit test: test/already-exists.test.ts";
  const verdict = judgeReview(criteria, {
    diff: planShardDiff(),
    report,
    headCheckoutDir: dir,
    // The proof path EXISTS, so it resolves and RUNS — the #2707 shape, not the forward-
    // reference shape (that carve-out, W1-T456, is a different mechanism and not under test here).
    execProof: () => "pass",
  });
  assert.equal(verdict.planOnly, true);
  assert.equal(verdict.capped, false, "the proof resolved and ran — this is the NON-capped shape #2707 hit");
  assert.equal(verdict.criteria[0].proof_exec, "executed_pass");
  assert.equal(verdict.state, "success");
  assert.match(
    verdict.summary,
    /^remudero-review: PASS — plan-only PR/,
    "the carve-out's own summary text (planOnlySummary), reached regardless of whether a proof executed",
  );
});

test("acceptance 2 — a semantic downgrade alone does not fail a diff that touches only plan paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w2221-semantic-"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "settings.test.ts"), "// pre-existing test on the PR head\n");
  const criteria = [
    { claim: "the pinned key set is compared to the live schema's members in both directions", proof: "unit test: test/settings.test.ts" },
  ];
  const report = "Filed W1-T999. unit test: test/settings.test.ts";
  const verdict = judgeReview(criteria, {
    diff: planShardDiff(),
    report,
    headCheckoutDir: dir,
    execProof: () => "pass",
    // The #2707 shape exactly: mechanically executed and passing, but the semantic lane judges
    // the proof "non-responsive" against a specification of work not yet done.
    semantic: [false],
  });
  assert.equal(verdict.planOnly, true);
  assert.equal(verdict.criteria[0].floorMet, true, "the deterministic floor passed");
  assert.equal(verdict.criteria[0].met, false, "the per-criterion downgrade is still RECORDED");
  assert.match(verdict.criteria[0].reason, /semantic downgrade/);
  assert.equal(verdict.state, "success", "the aggregate verdict is never decided by a semantic downgrade alone on a plan-only diff");
  assert.match(verdict.summary, /^remudero-review: PASS — plan-only PR/);
});

test("acceptance 3 — a diff touching one path outside plan scope keeps the full review and the full downgrade", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w2221-mixed-"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "settings.test.ts"), "// pre-existing test on the PR head\n");
  const criteria = [{ claim: "a real code change is proven", proof: "unit test: test/settings.test.ts" }];
  const report = "unit test: test/settings.test.ts";
  const verdict = judgeReview(criteria, {
    diff: planShardPlusCodeDiff(),
    report,
    headCheckoutDir: dir,
    execProof: () => "pass",
    semantic: [false],
  });
  assert.equal(verdict.planOnly, false, "one file outside plan/** disqualifies the whole diff — FAILS CLOSED");
  assert.equal(verdict.criteria[0].floorMet, true);
  assert.equal(verdict.criteria[0].met, false);
  assert.equal(verdict.state, "failure", "the semantic downgrade still decides a non-plan-only diff, exactly as before");
  assert.doesNotMatch(verdict.summary, /plan-only PR/);
});

test("acceptance 4 — the deterministic floor still decides the filing and a failing floor still fails it", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w2221-floorfail-"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "settings.test.ts"), "// pre-existing test on the PR head\n");
  const criteria = [{ claim: "a genuine defect in the filed shard", proof: "unit test: test/settings.test.ts" }];
  const report = "unit test: test/settings.test.ts";
  const verdict = judgeReview(criteria, {
    diff: planShardDiff(),
    report,
    headCheckoutDir: dir,
    // A genuine, mechanical execution FAILURE — never a semantic opinion.
    execProof: () => "fail",
  });
  assert.equal(verdict.planOnly, true);
  assert.equal(verdict.criteria[0].proof_exec, "executed_fail");
  assert.equal(verdict.criteria[0].floorMet, false, "the deterministic floor itself failed — no semantic lane involved");
  assert.equal(verdict.state, "failure", "a plan-only diff is never exempt from a genuine floor failure");
  assert.doesNotMatch(verdict.summary, /plan-only PR/, "a failing filing renders via failSummary, never the carve-out");
});

test("acceptance 5 — a code diff is judged exactly as it is today", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w2221-code-"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "settings.test.ts"), "// pre-existing test on the PR head\n");
  const codeDiff = [
    "diff --git a/src/example.ts b/src/example.ts",
    "index 111..222 100644",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");
  const criteria = [{ claim: "the code change is proven", proof: "unit test: test/settings.test.ts" }];
  const report = "unit test: test/settings.test.ts";
  // Semantically downgraded, exactly like acceptance 2/3 — the ONLY variable across all five
  // tests in this file is the diff's own shape (plan-only vs. not).
  const verdict = judgeReview(criteria, {
    diff: codeDiff,
    report,
    headCheckoutDir: dir,
    execProof: () => "pass",
    semantic: [false],
  });
  assert.equal(verdict.planOnly, false);
  assert.equal(verdict.criteria[0].floorMet, true);
  assert.equal(verdict.criteria[0].met, false);
  assert.equal(verdict.state, "failure", "an ordinary code PR's semantic downgrade still fails it, unaffected by this task");
  assert.equal(verdict.capped, false);
  assert.doesNotMatch(verdict.summary, /plan-only PR/);
});
