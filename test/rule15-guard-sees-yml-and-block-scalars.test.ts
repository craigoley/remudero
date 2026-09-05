import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import type { Task } from "../src/lib/plan.js";
import { checkSatisfiedByGuard, judgeReview } from "../src/lib/review.js";
import { rule15FilingViolation } from "../src/lib/task-linter.js";

/**
 * docs/audits/recon-2026-09-05.md, R-14 and R-16 — the Rule 15 tamper guard was blind to two
 * shard shapes the loader (`listShardFiles` in plan.ts, `materializeOriginShards` in run-task.ts)
 * already accepts:
 *
 * R-14: `isTaskRecordPath` (review.ts) and `TASKS_SHARD_PATH_RE` (task-linter.ts) matched only a
 * `.yaml` shard, so an identical criterion-editing diff tripped Rule 15 as `plan/tasks.d/x.yaml`
 * and passed silently as `plan/tasks.d/x.yml`.
 *
 * R-16: `planTasksCriterionFieldLines` (review.ts) matched only a criterion field's OWN header
 * line (`^\s*(claim|proof|satisfied_by)\s*:`). A field written as a YAML block scalar
 * (`proof: >-` followed by indented continuation lines) can have those continuation lines edited
 * — rewriting what the proof literally says — with no `:` anywhere on the changed lines, so the
 * guard never saw it.
 *
 * FALSIFIER, per the build brief: deleting fix (a) (the `.ya?ml` widening) must redden ACCEPTANCE
 * 1; deleting fix (b) (the block-scalar walk) must redden ACCEPTANCE 2. Both were run by hand —
 * see the PR body for the pasted `# fail N` / `# fail 0` pairs.
 */

const CRITERIA: AcceptanceCriterion[] = [{ claim: "the widget renders", proof: "unit test: test/widget.test.ts" }];
const REPORT = "REPORT\n- Implemented the widget.\nPR_URL: https://github.com/o/r/pull/4200";

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

// ── ACCEPTANCE 1 (R-14): the same criterion edit trips identically on .yaml and .yml ──────────

test("ACCEPTANCE 1 control: an EDITED criterion field in a .yaml shard is detected (checkSatisfiedByGuard, meta {} — no exemption)", () => {
  const yamlEdit = [
    "diff --git a/plan/tasks.d/W1-T999-some-shard.yaml b/plan/tasks.d/W1-T999-some-shard.yaml",
    "+++ b/plan/tasks.d/W1-T999-some-shard.yaml",
    "@@",
    '-      proof: "the old proof"',
    '+      proof: "the new proof, rewritten to match the diff"',
    "diff --git a/src/lib/widget.ts b/src/lib/widget.ts",
    "+++ b/src/lib/widget.ts",
    "@@",
    "+export function frobnicate() {}",
  ].join("\n");
  assert.equal(checkSatisfiedByGuard(yamlEdit, {}).pass, false, "the control must trip, or a .yml result proves nothing");
});

test("ACCEPTANCE 1: the BYTE-IDENTICAL diff, only the extension changed to .yml, is detected too (R-14)", () => {
  const yamlEdit = [
    "diff --git a/plan/tasks.d/W1-T999-some-shard.yaml b/plan/tasks.d/W1-T999-some-shard.yaml",
    "+++ b/plan/tasks.d/W1-T999-some-shard.yaml",
    "@@",
    '-      proof: "the old proof"',
    '+      proof: "the new proof, rewritten to match the diff"',
    "diff --git a/src/lib/widget.ts b/src/lib/widget.ts",
    "+++ b/src/lib/widget.ts",
    "@@",
    "+export function frobnicate() {}",
  ].join("\n");
  const ymlEdit = yamlEdit.replace(/some-shard\.yaml/g, "some-shard.yml");
  assert.notEqual(ymlEdit, yamlEdit, "the fixture must actually differ only in extension, or this proves nothing");

  const yamlResult = checkSatisfiedByGuard(yamlEdit, {});
  const ymlResult = checkSatisfiedByGuard(ymlEdit, {});
  assert.equal(yamlResult.pass, false, "the .yaml side must still trip");
  assert.equal(ymlResult.pass, false, "a .yml shard must be flagged exactly like the same edit in a .yaml shard");
  assert.equal(ymlResult.pass, yamlResult.pass, ".yaml and .yml must reach an identical verdict on a byte-identical edit");
});

test("ACCEPTANCE 1 (task-linter side, R-14): a filing declaring its own .yml shard alongside an out-of-scope path is refused exactly like the .yaml shape", () => {
  const yamlShard = task({
    id: "FIX-RULE15-YML-CONTROL",
    verify: "auto",
    files: ["plan/tasks.d/W1-T999-some-shard.yaml", "src/lib/widget.ts"],
  });
  const ymlShard = task({
    id: "FIX-RULE15-YML",
    verify: "auto",
    files: ["plan/tasks.d/W1-T999-some-shard.yml", "src/lib/widget.ts"],
  });
  const yamlViolation = rule15FilingViolation(yamlShard);
  const ymlViolation = rule15FilingViolation(ymlShard);
  assert.ok(yamlViolation, "the control (.yaml) must trip, or the .yml result proves nothing");
  assert.ok(ymlViolation, "a task declaring its own .yml shard alongside an out-of-scope path must be refused too");
  assert.equal(ymlViolation?.severity, yamlViolation?.severity);
});

// ── ACCEPTANCE 2 (R-16): a block-scalar proof's own CONTINUATION line is seen ──────────────────

test("ACCEPTANCE 2 control: the same field, written on ONE line (no block scalar), is detected — proves the fixture shape reaches the branch at all", () => {
  const oneLineEdit = [
    "diff --git a/plan/tasks.d/W1-T999-some-shard.yaml b/plan/tasks.d/W1-T999-some-shard.yaml",
    "+++ b/plan/tasks.d/W1-T999-some-shard.yaml",
    "@@",
    "   acceptance:",
    '     - claim: "the widget renders"',
    '-      proof: "unit test: test/widget.test.ts"',
    '+      proof: "unit test: test/widget-renamed.test.ts"',
    "diff --git a/src/lib/widget.ts b/src/lib/widget.ts",
    "+++ b/src/lib/widget.ts",
    "@@",
    "+export function frobnicate() {}",
  ].join("\n");
  const v = judgeReview(CRITERIA, { diff: oneLineEdit, report: REPORT });
  assert.equal(v.criteriaTampered, true, "the control must trip, or a block-scalar result proves nothing");
});

test("ACCEPTANCE 2: editing only the indented CONTINUATION of a `proof: >-` block scalar is reported tampered (R-16)", () => {
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
  const g = checkSatisfiedByGuard(blockScalarEdit, {});
  assert.equal(g.pass, false, "editing a block scalar's own text must trip the guard exactly like an inline edit");

  const v = judgeReview(CRITERIA, { diff: blockScalarEdit, report: REPORT });
  assert.equal(v.planOnly, false, "the diff also touches src/, so it is not plan-only");
  assert.equal(v.criteriaTampered, true, "a block-scalar proof's continuation is part of the proof field — editing it is tampering");
  assert.equal(v.state, "failure");
  assert.match(v.summary, /Standing rule 15/i);
});

test("ACCEPTANCE 2 (contrast): the SAME block-scalar edit, in a genuinely plan-only diff, stays exempt via the Architect carve-out", () => {
  const blockScalarPlanOnly = [
    "diff --git a/plan/tasks.d/W1-T999-some-shard.yaml b/plan/tasks.d/W1-T999-some-shard.yaml",
    "+++ b/plan/tasks.d/W1-T999-some-shard.yaml",
    "@@",
    "   acceptance:",
    '     - claim: "the widget renders"',
    "       proof: >-",
    "-        unit test: test/widget.test.ts",
    "+        unit test: test/widget-renamed.test.ts",
  ].join("\n");
  const tampered = checkSatisfiedByGuard(blockScalarPlanOnly, {});
  assert.equal(tampered.pass, false, "meta {} carries no exemption — the underlying predicate must still see the edit");
  const exempt = checkSatisfiedByGuard(blockScalarPlanOnly, { planOnly: true, humanAuthored: true });
  assert.equal(exempt.pass, true, "planOnly && humanAuthored is the Architect exemption — a genuine repair is never blocked");
});

// ── ACCEPTANCE 3 (R-16 negative control): a non-criterion block scalar is untouched ────────────

test("ACCEPTANCE 3: editing the CONTINUATION of a non-criterion `rationale: >-` block scalar is NOT reported tampered", () => {
  const rationaleEdit = [
    "diff --git a/plan/tasks.d/W1-T999-some-shard.yaml b/plan/tasks.d/W1-T999-some-shard.yaml",
    "+++ b/plan/tasks.d/W1-T999-some-shard.yaml",
    "@@",
    "   rationale: >-",
    "-    the widget renders text left to right",
    "+    the widget renders text left to right and wraps at 80 columns",
    "diff --git a/src/lib/widget.ts b/src/lib/widget.ts",
    "+++ b/src/lib/widget.ts",
    "@@",
    "+export function frobnicate() {}",
  ].join("\n");
  const v = judgeReview(CRITERIA, { diff: rationaleEdit, report: REPORT });
  assert.equal(v.criteriaTampered, false, "rationale is not a criterion field (plan.ts's Task.rationale sits outside acceptance:) — never flagged");
});

test("ACCEPTANCE 3 (negative control): a clean diff touching neither a monolith nor a shard never trips criteriaTampered", () => {
  const clean = [
    "diff --git a/src/lib/widget.ts b/src/lib/widget.ts",
    "+++ b/src/lib/widget.ts",
    "@@",
    "+export function frobnicate() {}",
  ].join("\n");
  const v = judgeReview(CRITERIA, { diff: clean, report: REPORT });
  assert.equal(v.criteriaTampered, false);
});

// ── ACCEPTANCE 4 (R-16 fail-closed fallback): the owning field's header is OUTSIDE the hunk ────

test("ACCEPTANCE 4: a block-scalar continuation edit is still flagged when the diff's own hunk context never shows the owning `proof:`/`claim:` header — fails closed under a known `acceptance:` line", () => {
  // A tight hunk (minimal diff context) that shows `acceptance:` but jumps straight to a
  // continuation line with NO `- claim:`/`proof: >-` header visible in between — the exact
  // shape the header-outside-hunk fallback exists for (planTasksCriterionFieldLines' own doc).
  const noVisibleHeader = [
    "diff --git a/plan/tasks.d/W1-T999-some-shard.yaml b/plan/tasks.d/W1-T999-some-shard.yaml",
    "+++ b/plan/tasks.d/W1-T999-some-shard.yaml",
    "@@",
    "   acceptance:",
    "-        unit test: test/widget.test.ts",
    "+        unit test: test/widget-renamed.test.ts",
    "diff --git a/src/lib/widget.ts b/src/lib/widget.ts",
    "+++ b/src/lib/widget.ts",
    "@@",
    "+export function frobnicate() {}",
  ].join("\n");
  const v = judgeReview(CRITERIA, { diff: noVisibleHeader, report: REPORT });
  assert.equal(
    v.criteriaTampered,
    true,
    "with no visible owner, an edit indented under a known acceptance: line must fail closed, not silently pass",
  );
});
