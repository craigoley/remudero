import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { checkSatisfiedByGuard, criterionFieldTampered, judgeReview } from "../src/lib/review.js";

// W1-T5031 — Rule 15 protected claim/proof/satisfied_by, but `kind: guard` exempts a criterion from the
// proof-discrimination gate (and two lints), which resolves criteria AT THE PR HEAD. A builder diff that only ADDED
// `kind: guard` to its own record read `criterionFieldTampered` false. `kind` joins the protected set; `holdout`
// deliberately does not, because it changes no verdict and exempts nothing.

const SHARD = "plan/tasks.d/W1-T999-some-shard.yaml";
const CRITERIA: AcceptanceCriterion[] = [{ claim: "the widget renders", proof: "unit test: test/widget.test.ts" }];
const REPORT = "REPORT\n- Implemented the widget.\nPR_URL: https://github.com/o/r/pull/4200";

function shardDiff(body: string[]): string {
  return [`diff --git a/${SHARD} b/${SHARD}`, `+++ b/${SHARD}`, "@@", ...body].join("\n");
}

const SRC_PART = ["diff --git a/src/lib/widget.ts b/src/lib/widget.ts", "+++ b/src/lib/widget.ts", "@@", "+export function frobnicate() {}"];

const ADD_KIND = shardDiff([
  "   acceptance:",
  '     - claim: "the widget renders"',
  '       proof: "unit test: test/widget.test.ts"',
  "+      kind: guard",
]);

test("W1-T5031: a diff that only adds kind: guard under an existing criterion trips criterionFieldTampered", () => {
  assert.equal(criterionFieldTampered(ADD_KIND), true);
  assert.equal(criterionFieldTampered(shardDiff(["   acceptance:", '     - claim: "c"', "+      kind: guard"])), true);
});

test("W1-T5031: a removed kind line and a context-free added kind line trip it too", () => {
  assert.equal(criterionFieldTampered(shardDiff(["   acceptance:", '     - claim: "c"', "-      kind: guard"])), true, "removed");
  assert.equal(criterionFieldTampered(shardDiff(["-      kind: guard", "+      kind: other"])), true, "changed");
  assert.equal(criterionFieldTampered(shardDiff(["+      kind: guard"])), true, "added with no acceptance context");
});

test("W1-T5031: a builder PR that adds kind: guard to its own record is refused by the guard and the review", () => {
  const diff = [ADD_KIND, ...SRC_PART].join("\n");
  const guard = checkSatisfiedByGuard(diff, {});
  assert.equal(guard.pass, false);
  assert.match(guard.reason, /kind/);
  const verdict = judgeReview(CRITERIA, { diff, report: REPORT });
  assert.equal(verdict.planOnly, false);
  assert.equal(verdict.criteriaTampered, true);
  assert.equal(verdict.state, "failure");
  assert.match(verdict.summary, /Standing rule 15/i);
});

test("W1-T5031: a plan-only human filing that declares its own kind: guard still passes", () => {
  const filing = shardDiff([
    "+- id: W1-T9999",
    "+  acceptance:",
    '+    - claim: "a guard criterion"',
    '+      proof: "grep: foo in src/foo.ts"',
    "+      kind: guard",
  ]);
  assert.equal(criterionFieldTampered(filing), true, "diff-derived only: a filing always reads tampered");
  assert.equal(checkSatisfiedByGuard(filing, { planOnly: true, humanAuthored: true }).pass, true);
  assert.equal(judgeReview(CRITERIA, { diff: filing, report: REPORT }).criteriaTampered, false, "plan-only is exempt in the review");
});

test("W1-T5031: attempts and status bumps and an added holdout line do not trip it", () => {
  assert.equal(criterionFieldTampered(shardDiff(["   status: queued", "-  attempts: 0", "+  attempts: 1"])), false);
  assert.equal(criterionFieldTampered(shardDiff(["-  status: queued", "+  status: done"])), false);
  assert.equal(
    criterionFieldTampered(shardDiff(["   acceptance:", '     - claim: "the widget renders"', '       proof: "unit test: test/widget.test.ts"', "+      holdout: true"])),
    false,
    "holdout exempts nothing from any judge, so adding it is not Rule 15's concern",
  );
});

test("W1-T5031: every criterion field that exempts a criterion from a gate is protected and holdout is not", () => {
  const table: Array<{ field: string; value: string; protectedField: boolean }> = [
    { field: "claim", value: '"x"', protectedField: true },
    { field: "proof", value: '"unit test: test/x.test.ts"', protectedField: true },
    { field: "satisfied_by", value: '"#123"', protectedField: true },
    { field: "kind", value: "guard", protectedField: true },
    { field: "holdout", value: "true", protectedField: false },
    { field: "status", value: "done", protectedField: false },
  ];
  for (const row of table) {
    const added = shardDiff(["   acceptance:", '     - claim: "the widget renders"', `+      ${row.field}: ${row.value}`]);
    const removed = shardDiff(["   acceptance:", '     - claim: "the widget renders"', `-      ${row.field}: ${row.value}`]);
    // `claim` as the context line is itself unchanged here, so only the +/- line decides.
    assert.equal(criterionFieldTampered(added), row.protectedField, `${row.field} added`);
    assert.equal(criterionFieldTampered(removed), row.protectedField, `${row.field} removed`);
  }
});
