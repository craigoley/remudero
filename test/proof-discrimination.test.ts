import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeReview, type ProofExecutor } from "../src/lib/review.js";
import type { AcceptanceCriterion } from "../src/lib/plan.js";

// ── W1-T273 ──────────────────────────────────────────────────────────────────
//
// THE LIVE DEFECT: W1-T267's fifth criterion carried
// `grep: workerKeychainPaths in src/run-task.ts`. Run against the commit
// BEFORE #1026 implemented the task, that pattern already returned two hits
// (an import line and an unrelated daemon rung) and exited 0. The work was
// real — #1026 genuinely fixed the probe's credential store — but the PROOF
// proved nothing: it would have exited 0 on completely unbuilt work, and the
// review executed it and recorded it as substantiated regardless, because
// `executed_pass` POSITIVELY OVERRIDES the keyword floor.
//
// THE CHECK (design, plan/tasks.d/W1-T273-*.yaml): when a `grep:` proof
// passes on the PR head, ALSO run it against the PR's merge-base. A match on
// BOTH cannot discriminate between the work having been done and not having
// been done — the same class of evidence gap #1026 exposed. This is a
// DOWNGRADE, never a `failure`: it withdraws the proof's positive override
// and falls back to the keyword floor, recorded under its own outcome name
// (`executed_stale`) rather than reusing `failure` or `exec_error`.
//
// `unit test:` proofs are explicitly OUT OF SCOPE: a forward-referencing test
// path legitimately matches nothing before the work and everything after, so
// the same rule does not generalize to them by analogy.

const HEAD_DIR = "/fake/head/checkout";
const BASE_DIR = "/fake/base/checkout";

test("W1-T273 #1: a grep proof matching on the merge-base as well as the head is flagged non-discriminating", () => {
  // Mirrors the W1-T267 fixture exactly: the pattern matches BOTH the head
  // and the pre-work merge-base — the shape that proved nothing live.
  const criteria: AcceptanceCriterion[] = [
    { claim: "the probe reads the worker keychain path", proof: "grep: workerKeychainPaths in src/run-task.ts" },
  ];
  const matchesBoth: ProofExecutor = () => "pass";
  const v = judgeReview(criteria, {
    diff: "",
    report: "REPORT — unrelated cleanup, no mention of the criterion above.",
    headCheckoutDir: HEAD_DIR,
    baseCheckoutDir: BASE_DIR,
    execProof: matchesBoth,
  });
  assert.equal(v.criteria[0].proof_exec, "executed_stale");
  assert.match(v.criteria[0].reason, /non-discriminating/);
  assert.match(v.criteria[0].reason, /merge-base/);
});

test("W1-T273 #2: the non-discriminating outcome removes the proof's positive override (met falls back to the keyword floor, not forced true)", () => {
  const criteria: AcceptanceCriterion[] = [
    { claim: "the probe reads the worker keychain path", proof: "grep: workerKeychainPaths in src/run-task.ts" },
  ];
  // Report never pastes the proof's distinctive keywords — the mechanical
  // floor alone would be UNMET. Without W1-T273, `executed_pass` would force
  // met=true regardless; with it, a merge-base match must withdraw that
  // override and leave the floor's own (unmet) verdict standing.
  const matchesBoth: ProofExecutor = () => "pass";
  const v = judgeReview(criteria, {
    diff: "",
    report: "REPORT — did unrelated work, said nothing about the keychain probe at all.",
    headCheckoutDir: HEAD_DIR,
    baseCheckoutDir: BASE_DIR,
    execProof: matchesBoth,
  });
  assert.equal(v.criteria[0].proof_exec, "executed_stale");
  assert.equal(v.criteria[0].met, false, "a non-discriminating match must not force met=true");
  assert.equal(v.state, "failure", v.summary);
});

test("W1-T273 #3: a grep proof matching only on the head still counts as executed and passing", () => {
  // THE DISCRIMINATING PATTERN from the same live fixture: `home: workerHome`
  // returned ZERO hits at the pre-work commit and one on the post-work head —
  // a real proof, and it must stay executed_pass, unaffected by this check.
  const criteria: AcceptanceCriterion[] = [
    { claim: "the probe reads the worker home", proof: "grep: home: workerHome in src/run-task.ts" },
  ];
  const headOnly: ProofExecutor = (_wp, cwd) => (cwd === BASE_DIR ? "fail" : "pass");
  const v = judgeReview(criteria, {
    diff: "",
    report: "REPORT — unrelated cleanup, no mention of the criterion above.",
    headCheckoutDir: HEAD_DIR,
    baseCheckoutDir: BASE_DIR,
    execProof: headOnly,
  });
  assert.equal(v.criteria[0].proof_exec, "executed_pass");
  assert.equal(v.criteria[0].met, true);
  assert.equal(v.state, "success", v.summary);
});

test("W1-T273: absent baseCheckoutDir never runs the check — a grep proof that passes on the head stays executed_pass exactly as before this task", () => {
  const criteria: AcceptanceCriterion[] = [
    { claim: "the probe reads the worker keychain path", proof: "grep: workerKeychainPaths in src/run-task.ts" },
  ];
  const alwaysPass: ProofExecutor = () => "pass";
  const v = judgeReview(criteria, {
    diff: "",
    report: "REPORT — unrelated cleanup, no mention of the criterion above.",
    headCheckoutDir: HEAD_DIR,
    // no baseCheckoutDir at all
    execProof: alwaysPass,
  });
  assert.equal(v.criteria[0].proof_exec, "executed_pass");
  assert.equal(v.criteria[0].met, true);
});

test("W1-T273: a `unit test:` proof is never flagged stale, even when it 'passes' on both the head and the base checkout", () => {
  // EXPLICITLY OUT OF SCOPE (design): a forward-referencing test path
  // legitimately matches nothing before the work and everything after — the
  // same rule must not be extended to it by analogy.
  const criteria: AcceptanceCriterion[] = [
    { claim: "the widget is frobnicated", proof: "unit test: test/widget.test.ts" },
  ];
  const alwaysPass: ProofExecutor = () => "pass";
  const v = judgeReview(criteria, {
    diff: "",
    report: "REPORT — unrelated cleanup, no mention of the criterion above.",
    headCheckoutDir: HEAD_DIR,
    baseCheckoutDir: BASE_DIR,
    execProof: alwaysPass,
  });
  assert.equal(v.criteria[0].proof_exec, "executed_pass");
  assert.equal(v.criteria[0].met, true);
});
