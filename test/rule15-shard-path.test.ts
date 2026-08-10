import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import type { Task } from "../src/lib/plan.js";
import { checkSatisfiedByGuard, judgeReview } from "../src/lib/review.js";
import { rule15FilingViolation } from "../src/lib/task-linter.js";

/**
 * W1-T399 — BOTH rule-15 guards keyed on the LITERAL `plan/tasks.yaml` path, so neither could
 * see a criteria edit (or a filing) in a `plan/tasks.d/` shard, and every task filed since the
 * monolith froze (PR #1060) is a shard. Each test below RE-DERIVES its own control before
 * trusting the shard result — exactly the discipline the task's design note (i) demands, because
 * a source reading of this area misled a session two days earlier (W1-T389's first fixture edited
 * a shard, where the check was silent BY CONSTRUCTION, and both arms read false).
 */

const CRITERIA: AcceptanceCriterion[] = [
  { claim: "the widget renders", proof: "unit test: test/widget.test.ts" },
];
const RESPONSIVE_REPORT = "REPORT\n- Implemented the widget.\nPR_URL: https://github.com/o/r/pull/7";

/** A minimal, otherwise-clean Task fixture — every test overrides only what it needs. */
function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    acceptance: [{ claim: "does the thing", proof: "unit test: test/foo.test.ts" }],
    ...over,
  };
}

// ── ACCEPTANCE 1: the review-time guard sees a shard exactly like the monolith ──

test("ACCEPTANCE 1 control: an EDITED criterion field in the MONOLITH is detected (checkSatisfiedByGuard, meta {} — no exemption)", () => {
  const monolithEdit = `
diff --git a/plan/tasks.yaml b/plan/tasks.yaml
+++ b/plan/tasks.yaml
@@
-      claim: "the widget renders red"
-      proof: "the old proof"
+      claim: "the widget renders blue"
+      proof: "the new proof, rewritten to match the diff"
`.trim();
  assert.equal(checkSatisfiedByGuard(monolithEdit, {}).pass, false, "the control must trip, or a shard result proves nothing");
});

test("ACCEPTANCE 1: the BYTE-IDENTICAL diff, only the path changed to a plan/tasks.d/ shard, is detected too", () => {
  const shardEdit = `
diff --git a/plan/tasks.d/W1-T999-some-shard.yaml b/plan/tasks.d/W1-T999-some-shard.yaml
+++ b/plan/tasks.d/W1-T999-some-shard.yaml
@@
-      claim: "the widget renders red"
-      proof: "the old proof"
+      claim: "the widget renders blue"
+      proof: "the new proof, rewritten to match the diff"
`.trim();
  assert.equal(
    checkSatisfiedByGuard(shardEdit, {}).pass,
    false,
    "a shard edit must be flagged exactly like the same edit in the monolith",
  );
});

test("ACCEPTANCE 1 (second disjunct): an ADDED satisfied_by: line is caught in a shard too, not only a removed field", () => {
  const shardSatisfiedBy = `
diff --git a/plan/tasks.d/W1-T999-some-shard.yaml b/plan/tasks.d/W1-T999-some-shard.yaml
+++ b/plan/tasks.d/W1-T999-some-shard.yaml
@@
+      satisfied_by: "#123"
`.trim();
  assert.equal(checkSatisfiedByGuard(shardSatisfiedBy, {}).pass, false);
});

test("ACCEPTANCE 1, the BINDING side (judgeReview.criteriaTampered): a non-plan-only diff editing a shard's own criteria forces failure, exactly as the monolith shape does (W1-T58)", () => {
  const mixedShardEdit = `
diff --git a/plan/tasks.d/W1-T999-some-shard.yaml b/plan/tasks.d/W1-T999-some-shard.yaml
+++ b/plan/tasks.d/W1-T999-some-shard.yaml
@@
-      proof: "the old proof"
+      proof: "the new proof, rewritten to match the diff"
diff --git a/src/lib/widget.ts b/src/lib/widget.ts
+++ b/src/lib/widget.ts
@@
+export function frobnicate() {}
`.trim();
  const v = judgeReview(CRITERIA, { diff: mixedShardEdit, report: RESPONSIVE_REPORT });
  assert.equal(v.planOnly, false);
  assert.equal(v.criteriaTampered, true, "a worker-authored shard-criteria edit must trip the binding guard");
  assert.equal(v.state, "failure");
  assert.match(v.summary, /Standing rule 15/i);
});

test("a clean diff touching no task record at all (monolith or shard) never trips criteriaTampered", () => {
  const clean = `
diff --git a/src/lib/widget.ts b/src/lib/widget.ts
+++ b/src/lib/widget.ts
@@
+export function frobnicate() {}
`.trim();
  const v = judgeReview(CRITERIA, { diff: clean, report: RESPONSIVE_REPORT });
  assert.equal(v.criteriaTampered, false);
});

// ── ACCEPTANCE 3: a plan-scoped repair editing a SHARD is still exempt ──────────
// (must be proven, not assumed — design note (iii): without this, W1-T399's fix
// would re-create the deadlock W1-T386 cost three PRs to escape.)

test("ACCEPTANCE 3 control: the SAME criterion-field edit, made in a genuinely plan-only MONOLITH diff, is a legitimate Architect correction — never tripped", () => {
  const planOnlyMonolith = `
diff --git a/plan/tasks.yaml b/plan/tasks.yaml
+++ b/plan/tasks.yaml
@@
-      proof: "the old proof"
+      proof: "the new proof, corrected by the Architect"
`.trim();
  const v = judgeReview(CRITERIA, { diff: planOnlyMonolith, report: RESPONSIVE_REPORT });
  assert.equal(v.planOnly, true);
  assert.equal(v.criteriaTampered, false);
});

test("ACCEPTANCE 3: the SAME plan-only repair, editing a SHARD's own criteria, is still exempt — the hand-authored repair route is not deadlocked", () => {
  const planOnlyShard = `
diff --git a/plan/tasks.d/W1-T999-some-shard.yaml b/plan/tasks.d/W1-T999-some-shard.yaml
+++ b/plan/tasks.d/W1-T999-some-shard.yaml
@@
-      proof: "the old proof"
+      proof: "the new proof, corrected by the Architect"
`.trim();
  const v = judgeReview(CRITERIA, { diff: planOnlyShard, report: RESPONSIVE_REPORT });
  assert.equal(v.planOnly, true, "plan/tasks.d/ is already in plan scope (isInPlanScope: path.startsWith('plan/'))");
  assert.equal(v.criteriaTampered, false, "a plan-only shard repair must not be treated as tampering");
});

// ── ACCEPTANCE 2: the filing-time refusal sees a shard exactly like the monolith ─

test("ACCEPTANCE 2 control: a task declaring the MONOLITH alongside an out-of-scope path at verify:auto is refused at filing (W1-T384's original shape)", () => {
  const t = task({
    id: "FIX-RULE15-SHARD-CONTROL",
    verify: "auto",
    files: ["plan/tasks.yaml", "src/run-task.ts"],
  });
  const v = rule15FilingViolation(t);
  assert.ok(v, "the control must trip, or a shard result proves nothing");
  assert.equal(v?.severity, "block");
});

test("ACCEPTANCE 2: a task declaring its OWN SHARD alongside an out-of-scope path at verify:auto is refused at filing too — closes the matching filing-time blind spot", () => {
  const t = task({
    id: "FIX-RULE15-SHARD",
    verify: "auto",
    files: ["plan/tasks.d/W1-T999-some-shard.yaml", "src/lib/widget.ts"],
  });
  const v = rule15FilingViolation(t);
  assert.ok(v, "a shard-declaring task in this shape must be refused exactly like the monolith shape");
  assert.equal(v?.severity, "block");
  assert.match(v!.message, /plan\/tasks\.d\/W1-T999-some-shard\.yaml/);
  assert.match(v!.message, /src\/lib\/widget\.ts/);
  assert.match(v!.message, /two tasks/i);
});

test("ACCEPTANCE 2 (contrast): the IDENTICAL shard-declaring record at verify:human PASSES — the operator makes the edit by hand", () => {
  const t = task({
    id: "FIX-RULE15-SHARD-HUMAN",
    verify: "human",
    files: ["plan/tasks.d/W1-T999-some-shard.yaml", "src/lib/widget.ts"],
  });
  assert.equal(rule15FilingViolation(t), undefined);
});

test("ACCEPTANCE 2 (contrast): a task declaring ONLY its own shard (no out-of-scope path) PASSES — a plan-only repair is never refused", () => {
  const t = task({
    id: "FIX-RULE15-SHARD-PLANONLY",
    verify: "auto",
    files: ["plan/tasks.d/W1-T999-some-shard.yaml", "MASTER-PLAN.md"],
  });
  assert.equal(rule15FilingViolation(t), undefined);
});

test("ACCEPTANCE 2 (negative control): a nested or non-shard plan/tasks.d/ path is NOT treated as a task record — the match is structural, not a loose glob", () => {
  const notAShard = task({
    id: "FIX-RULE15-SHARD-NOT-A-RECORD",
    verify: "auto",
    files: ["plan/tasks.d/README.md", "src/lib/widget.ts"],
  });
  assert.equal(rule15FilingViolation(notAShard), undefined, "README.md is not a .yaml shard");

  const nested = task({
    id: "FIX-RULE15-SHARD-NESTED",
    verify: "auto",
    files: ["plan/tasks.d/archive/W1-T001-old.yaml", "src/lib/widget.ts"],
  });
  assert.equal(
    rule15FilingViolation(nested),
    undefined,
    "a nested path is not a shard the loader reads (listShardFiles never recurses)",
  );
});
