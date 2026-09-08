import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { checkSatisfiedByGuard, criterionFieldTampered, judgeReview } from "../src/lib/review.js";

/**
 * W1-T2909 / docs/audits/recon-2026-09-05.md R-16 — falsifier named by the task record:
 * `planTasksCriterionFieldLines` (src/lib/review.ts) used to match only a criterion field's OWN
 * header line (`^\s*(claim|proof|satisfied_by)\s*:`). A field written as a YAML block scalar —
 * `proof: >-` (or `claim: >-`) followed by indented continuation lines carrying the actual text,
 * with NO `:` anywhere on those lines — let an edit confined to the continuation rewrite what the
 * proof/claim literally says while tripping neither `criterionFieldTampered` disjunct, so the
 * guard passed on a diff that rewrote a criterion's proof unseen.
 *
 * This proof constructs exactly that diff shape and asserts the guard now trips: the fix walks
 * the diff's own line order as a YAML-indent state machine, tracking an `openScalar` opener so a
 * block scalar's indented continuation lines are swept into the criterion-field comparison the
 * same as an inline `proof: "..."` value would be (doc-commented at review.ts as "block-scalar
 * CONTINUATION").
 */

const CRITERIA: AcceptanceCriterion[] = [{ claim: "the widget renders", proof: "unit test: test/widget.test.ts" }];
const REPORT = "REPORT\n- Implemented the widget.\nPR_URL: https://github.com/o/r/pull/4200";

test("ACCEPTANCE 1: editing only the continuation lines of a `proof: >-` block scalar trips criterionFieldTampered", () => {
  const blockScalarEdit = [
    "diff --git a/plan/tasks.d/W1-T999-some-shard.yaml b/plan/tasks.d/W1-T999-some-shard.yaml",
    "+++ b/plan/tasks.d/W1-T999-some-shard.yaml",
    "@@",
    "   acceptance:",
    '     - claim: "the widget renders"',
    "       proof: >-",
    "-        unit test: test/widget.test.ts",
    "+        unit test: test/widget-renamed.test.ts",
    "diff --git a/src/lib/widget.ts b/src/lib/widget.ts",
    "+++ b/src/lib/widget.ts",
    "@@",
    "+export function frobnicate() {}",
  ].join("\n");

  assert.equal(
    criterionFieldTampered(blockScalarEdit),
    true,
    "the continuation-only edit is part of the proof field's own value and must trip the predicate",
  );

  const guard = checkSatisfiedByGuard(blockScalarEdit, {});
  assert.equal(guard.pass, false, "the tamper guard must fail a continuation-only edit exactly like an inline one");

  const verdict = judgeReview(CRITERIA, { diff: blockScalarEdit, report: REPORT });
  assert.equal(verdict.planOnly, false, "the diff also touches src/, so the Architect plan-only carve-out never applies");
  assert.equal(verdict.criteriaTampered, true, "a block-scalar proof's continuation is the proof — editing it is tampering");
  assert.equal(verdict.state, "failure");
  assert.match(verdict.summary, /Standing rule 15/i);
});

test("ACCEPTANCE 1 (claim variant): editing only the continuation lines of a `claim: >-` block scalar trips it too", () => {
  const blockScalarClaimEdit = [
    "diff --git a/plan/tasks.d/W1-T999-some-shard.yaml b/plan/tasks.d/W1-T999-some-shard.yaml",
    "+++ b/plan/tasks.d/W1-T999-some-shard.yaml",
    "@@",
    "   acceptance:",
    "     - claim: >-",
    "-        the widget renders left to right",
    "+        the widget renders left to right and always has",
    '       proof: "unit test: test/widget.test.ts"',
  ].join("\n");

  assert.equal(
    criterionFieldTampered(blockScalarClaimEdit),
    true,
    "the rationale explicitly requires the same handling for `claim:` as for `proof:`",
  );
});

test("control: without the block-scalar walk, editing only continuation lines would carry no `:`-prefixed field header", () => {
  // Falsifying sanity check on the fixture itself: every ADDED/DELETED line in the block-scalar
  // edit above is a bare continuation line with no `key:` prefix, so a matcher that only tested
  // "does the line's text start with claim:/proof:/satisfied_by:" would see zero qualifying lines
  // here — the exact blindness the audit reproduced and this fix closes.
  const bareLines = ["        unit test: test/widget.test.ts", "        unit test: test/widget-renamed.test.ts"];
  const startsWithFieldName = /^\s*(claim|proof|satisfied_by)\s*:/;
  for (const line of bareLines) {
    assert.equal(startsWithFieldName.test(line), false, "a continuation line never itself starts with the field name");
  }
});
