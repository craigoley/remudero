import assert from "node:assert/strict";
import { test } from "node:test";

import { RULE_15_SPLIT_REMEDY, rule15SplitStep, rule15SplitViolation } from "../src/lib/ci-parity.js";
import { rule15SplitViolation as viaLinter } from "../src/lib/task-linter.js";
import { checkSatisfiedByGuard } from "../src/lib/review.js";

// W1-T3099 — Standing rule 15 at AUTHOR time. The judge already refuses this; the cost being
// removed is that it refuses after a full CI cycle (#4509 re-split only once the judge told it).
// Every fixture below is a real unified diff, because the predicate consumes the judge's own
// `criterionFieldTampered`/`planOnlyDiff`, and a hand-built object would not exercise either.

/** A diff that ADDS an acceptance criterion to a shard. */
const criterionAdd = (file = "plan/tasks.d/W1-T9999-a-thing.yaml") =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -10,6 +10,8 @@\n   acceptance:\n     - claim: "an existing one"\n       proof: "unit test: test/x.test.ts"\n+    - claim: "a newly added criterion"\n+      proof: "unit test: test/y.test.ts"\n`;

/** A src hunk, to entangle a filing with. */
const srcHunk = (file = "src/lib/sweep.ts") =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,3 +1,4 @@\n const a = 1;\n+const b = 2;\n`;

test("W1-T3099: a criterion added beside a src file is REFUSED before push, and the reason names the rule", () => {
  const v = rule15SplitViolation(criterionAdd() + srcHunk());
  assert.equal(v.refused, true);
  assert.match(v.reason ?? "", /Standing rule 15/);
  assert.match(v.reason ?? "", /acceptance criteria were added\/edited/);
});

test("W1-T3099: a criterion added beside a TEST file is refused too — test/ is not a plan path", () => {
  const v = rule15SplitViolation(criterionAdd() + srcHunk("test/a-thing.test.ts"));
  assert.equal(v.refused, true, "the rule names src/ OR test/; a test file entangles a filing just as a src file does");
});

test("W1-T3099: a plan-only diff PASSES, so a filing PR is never refused by this check", () => {
  const v = rule15SplitViolation(criterionAdd());
  assert.equal(v.refused, false, "this is the shape the rule PRESCRIBES — refusing it would invert the rule");
  assert.equal(v.reason, undefined);
});

test("W1-T3099: a diff that moves NO criterion passes, even when it touches src and plan together", () => {
  // A shard whose `status:` flips beside a src change moves no criterion field. THE POSITIVE
  // CONTROL for the two refusals above: they are the criterion arm, not a plan+src path rule.
  const statusFlip =
    `diff --git a/plan/tasks.d/W1-T9999-a-thing.yaml b/plan/tasks.d/W1-T9999-a-thing.yaml\n` +
    `--- a/plan/tasks.d/W1-T9999-a-thing.yaml\n+++ b/plan/tasks.d/W1-T9999-a-thing.yaml\n` +
    `@@ -5,1 +5,1 @@\n-  status: queued\n+  status: merged\n`;
  assert.equal(rule15SplitViolation(statusFlip + srcHunk()).refused, false);
});

test("W1-T3099: lint-plan and preflight reach the identical verdict, because both call ONE function", () => {
  // Not "both return false" — the SAME reference. Two copies are two things to drift, and this is
  // the assertion that fails the moment someone re-implements the predicate on one side.
  assert.equal(viaLinter, rule15SplitViolation, "task-linter re-exports the function, never a copy");
  const mixed = criterionAdd() + srcHunk();
  assert.deepEqual(viaLinter(mixed), rule15SplitViolation(mixed));
});

test("W1-T3099: the refusal carries the judge's own two-half remedy, verbatim", () => {
  const v = rule15SplitViolation(criterionAdd() + srcHunk());
  assert.ok(String(v.reason).includes(RULE_15_SPLIT_REMEDY), "the constant itself must reach the author");
  // BOTH halves, because review.ts records that one is not enough.
  assert.match(RULE_15_SPLIT_REMEDY, /file the shard in its own plan-only PR/, "half one: split it");
  assert.match(RULE_15_SPLIT_REMEDY, /NAMING the proof that will carry it/, "half two: substantiate it");
  // AND IT IS THE JUDGE'S TEXT, not a paraphrase: the same sentence appears in the judge's refusal.
  const judged = checkSatisfiedByGuard(criterionAdd() + srcHunk(), {});
  assert.equal(judged.pass, false, "the judge refuses the same diff — the positive control for parity");
  assert.ok(String(judged.reason).includes("file the shard in its own plan-only PR"), "same sentence, both surfaces");
});

test("W1-T3099: the preflight step REFUSES rather than warns, and names itself", () => {
  const bad = rule15SplitStep(criterionAdd() + srcHunk());
  assert.equal(bad.ok, false, "a warning at author time is a line in a scroll-back");
  assert.equal(bad.name, "rule-15-split");
  const good = rule15SplitStep(criterionAdd());
  assert.equal(good.ok, true);
  assert.match(good.detail, /no acceptance criterion added or edited/);
});

test("W1-T3099: this check is WEAKER than the judge in the safe direction, and that is deliberate", () => {
  // Authorship is not knowable from a diff, so a plan-only WORKER-authored diff passes here. The
  // judge may still refuse it. An under-refusal never blocks work the judge would have allowed;
  // an over-refusal would, which is the direction an early warning may not err in.
  const planOnly = criterionAdd();
  assert.equal(rule15SplitViolation(planOnly).refused, false, "passes locally regardless of author");
  const judgedWorker = checkSatisfiedByGuard(planOnly, { planOnly: true, humanAuthored: false });
  assert.equal(judgedWorker.pass, false, "and the judge can still refuse it — the gap is real and named");
});
