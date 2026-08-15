import assert from "node:assert/strict";
import { test } from "node:test";
import { isDemonstrationProof, isDialectPrefixed, parseWhitelistedProof } from "../src/lib/review.js";
import { lintTask, proofDialectViolations } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";

/**
 * W1-T277: a third house dialect, `demonstration: <what the operator must
 * do>`, for the six `verify:human` tasks whose proof is an operator action
 * with no executable form and never will have one (a chaos drill, a device
 * recording, a live deploy) — recon-VERIFIED at ebb6777 as W1-T12e, W1-T147,
 * W12-T1, W2-T2, W3-T4, W3-T7. The dialect is honest about what it is: not a
 * proof the harness checks, but one it DECLINES to check, on the record. That
 * honesty is legal ONLY on a `verify: human` task; on `verify: auto` the same
 * prefix would be an escape hatch from the executable-proof rule, so the
 * asymmetry is enforced by task-linter.ts.
 */

/** A minimal, otherwise-clean Task fixture — mirrors task-linter.test.ts's own
 * helper so every test overrides only the field(s) it's exercising. */
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

const DEMO_PROOF =
  "demonstration: operator runs the chaos drill against the staging cluster and confirms recovery within SLA";

// ── ACCEPTANCE 1: a demonstration proof on a verify:human task lints clean ──

test("ACCEPTANCE 1: a `demonstration:` proof on a verify:human task lints clean — no proof-dialect violation at all", () => {
  const t = task({
    id: "FIX-DEMO-HUMAN-CLEAN",
    verify: "human",
    files: ["src/lib/example.ts"],
    acceptance: [{ claim: "the chaos drill recovers within SLA", proof: DEMO_PROOF }],
  });
  assert.deepEqual(proofDialectViolations(t), []);
  const res = lintTask(t);
  assert.equal(res.ok, true, `expected a clean lint, got: ${JSON.stringify(res.violations)}`);
  assert.equal(
    res.violations.filter((v) => v.check === "proof-dialect").length,
    0,
    "a demonstration proof on a verify:human task must never even WARN — declining to execute it is the point",
  );
});

// ── ACCEPTANCE 2: the SAME proof on a verify:auto task is refused ──────────

test("ACCEPTANCE 2: the SAME `demonstration:` proof on a verify:auto task is refused by the linter (BLOCK, unconditionally)", () => {
  const t = task({
    id: "FIX-DEMO-AUTO-REFUSED",
    verify: "auto",
    acceptance: [{ claim: "the chaos drill recovers within SLA", proof: DEMO_PROOF }],
  });
  const violations = proofDialectViolations(t);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.check, "proof-dialect");
  assert.equal(violations[0]!.severity, "block");
  assert.match(violations[0]!.message, /demonstration/i);
  assert.match(violations[0]!.message, /verify:human/i);
  assert.equal(lintTask(t).ok, false);

  // The refusal is unconditional — it is illegal BY CONSTRUCTION on an
  // auto-verify task, not merely a legacy-backlog proof that failed to parse,
  // so the "warn" rollout knob (proofDialect: "warn") must NOT rescue it the
  // way it rescues an ordinary dead-proof-floor violation.
  const warnRes = lintTask(t, { proofDialect: "warn" });
  assert.equal(
    warnRes.ok,
    false,
    "a `demonstration:` proof on verify:auto stays BLOCKED even under the warn-only legacy-backlog rollout knob",
  );
});

test("ACCEPTANCE 2b: a verify:auto task with NO demonstration proof is unaffected by this rule", () => {
  const t = task({
    id: "FIX-DEMO-AUTO-UNRELATED",
    verify: "auto",
    acceptance: [{ claim: "does the thing", proof: "unit test: test/foo.test.ts" }],
  });
  assert.deepEqual(proofDialectViolations(t), []);
});

// ── ACCEPTANCE 3: never executed, never counts as an executed pass ─────────

test("ACCEPTANCE 3: a `demonstration:` proof never parses to an executable shape — parseWhitelistedProof is null by construction", () => {
  assert.equal(parseWhitelistedProof(DEMO_PROOF), null);
  assert.equal(parseWhitelistedProof("demonstration: plug in the physical device and record the boot chime"), null);
});

test("ACCEPTANCE 3b: isDemonstrationProof recognises exactly the `demonstration:` prefix, matched at the START of the proof only", () => {
  assert.equal(isDemonstrationProof(DEMO_PROOF), true);
  assert.equal(isDemonstrationProof("Demonstration: capitalised label still counts"), true);
  assert.equal(isDemonstrationProof("  demonstration: leading whitespace is trimmed"), true);
  assert.equal(
    isDemonstrationProof("the operator gave a live demonstration: of the feature"),
    false,
    "the label is how a proof STARTS, never something incidentally mentioned mid-sentence",
  );
  assert.equal(isDemonstrationProof("unit test: test/foo.test.ts"), false);
  assert.equal(isDemonstrationProof("grep: TODO in src/lib/foo.ts"), false);
});

// ── ACCEPTANCE 4 (review.ts): the dialect is recognised alongside grep/unit test ──

test("ACCEPTANCE 4: review.ts's isDialectPrefixed recognises `demonstration:` alongside `grep:`/`unit test:` — it is never mistaken for free prose", () => {
  assert.equal(isDialectPrefixed(DEMO_PROOF), true);
  assert.equal(isDialectPrefixed("grep: TODO in src/lib/foo.ts"), true);
  assert.equal(isDialectPrefixed("unit test: test/foo.test.ts"), true);
  assert.equal(isDialectPrefixed("the operator eyeballs the output and confirms it looks right"), false);
});

test("a satisfied_by criterion is exempt from the demonstration check too — Architect-only, never expected to be executable prose", () => {
  const t = task({
    id: "FIX-DEMO-SATISFIED-BY",
    verify: "auto",
    acceptance: [{ claim: "already shipped elsewhere", proof: DEMO_PROOF, satisfied_by: "#123" }],
  });
  assert.deepEqual(proofDialectViolations(t), []);
});
