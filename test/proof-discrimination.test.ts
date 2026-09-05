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
// `unit test:` proofs were explicitly OUT OF SCOPE for W1-T273 itself — a
// forward-referencing test path legitimately matches nothing before the work
// and everything after, so the same rule did not generalize to them by
// analogy. W1-T362 (below, and test/review.test.ts) closes that gap: a
// `unit test:` proof that is ABSENT or FAILS at the base still discriminates
// (unaffected here), but one that PASSES identically at head AND base is now
// downgraded exactly like a stale `grep:` proof.

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
    baseIsCheckout: true, // (R-11) a faked base run of a `unit test:` proof counts only for a real checkout
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
    baseIsCheckout: true, // (R-11) a faked base run of a `unit test:` proof counts only for a real checkout
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
    baseIsCheckout: true, // (R-11) a faked base run of a `unit test:` proof counts only for a real checkout
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

test("W1-T362: a `unit test:` proof that ALSO passes on the merge-base is now flagged stale, exactly like a grep proof", () => {
  // SUPERSEDES the pre-W1-T362 "explicitly out of scope" behaviour: a test
  // that passes identically at head AND base proves the diff changed nothing
  // the test observes — the unit-test analog of the grep defect W1-T273 closed.
  // Full matrix (absent-at-base, failing-at-base, base-run error) lives in
  // test/review.test.ts, this task's declared acceptance proof.
  const criteria: AcceptanceCriterion[] = [
    { claim: "the widget is frobnicated", proof: "unit test: test/widget.test.ts" },
  ];
  const alwaysPass: ProofExecutor = () => "pass";
  const v = judgeReview(criteria, {
    diff: "",
    report: "REPORT — unrelated cleanup, no mention of the criterion above.",
    headCheckoutDir: HEAD_DIR,
    baseCheckoutDir: BASE_DIR,
    baseIsCheckout: true, // (R-11) a faked base run of a `unit test:` proof counts only for a real checkout
    execProof: alwaysPass,
  });
  assert.equal(v.criteria[0].proof_exec, "executed_stale");
  assert.match(v.criteria[0].reason, /non-discriminating/);
});

test("W1-T362: a `unit test:` proof absent/failing at the base still discriminates and stays executed_pass", () => {
  const criteria: AcceptanceCriterion[] = [
    { claim: "the widget is frobnicated", proof: "unit test: test/widget.test.ts" },
  ];
  // Forward-referencing test: passes on head, does not exist / does not pass on base.
  const headOnly: ProofExecutor = (_wp, cwd) => (cwd === BASE_DIR ? "no-match" : "pass");
  const v = judgeReview(criteria, {
    diff: "",
    report: "REPORT — unrelated cleanup, no mention of the criterion above.",
    headCheckoutDir: HEAD_DIR,
    baseCheckoutDir: BASE_DIR,
    baseIsCheckout: true, // (R-11) a faked base run of a `unit test:` proof counts only for a real checkout
    execProof: headOnly,
  });
  assert.equal(v.criteria[0].proof_exec, "executed_pass");
  assert.equal(v.criteria[0].met, true);
  assert.match(v.criteria[0].reason, /discriminates/);
});

test("W1-T273: a base-checkout re-run that THROWS degrades to not-stale (executed_pass stands) instead of hard-failing", () => {
  // preexistingProofHits's own doc-comment: "whenever the base checkout itself
  // throws (an unreadable/absent merge-base checkout is an environment gap,
  // not a finding) [it] degrades to 'not stale' exactly like exec_error
  // degrades elsewhere in this module — never a silent hard-fail." Exercise
  // that catch branch directly: the executor passes cleanly on the head but
  // THROWS when invoked against baseCheckoutDir (e.g. the merge-base worktree
  // is missing/unreadable) — the criterion must still land executed_pass, not
  // executed_stale and not a thrown error propagating out of judgeReview.
  const criteria: AcceptanceCriterion[] = [
    { claim: "the probe reads the worker keychain path", proof: "grep: workerKeychainPaths in src/run-task.ts" },
  ];
  const throwsOnBase: ProofExecutor = (_wp, cwd) => {
    if (cwd === BASE_DIR) throw new Error("merge-base checkout unreadable");
    return "pass";
  };
  const v = judgeReview(criteria, {
    diff: "",
    report: "REPORT — unrelated cleanup, no mention of the criterion above.",
    headCheckoutDir: HEAD_DIR,
    baseCheckoutDir: BASE_DIR,
    baseIsCheckout: true, // (R-11) a faked base run of a `unit test:` proof counts only for a real checkout
    execProof: throwsOnBase,
  });
  assert.equal(v.criteria[0].proof_exec, "executed_pass");
  assert.equal(v.criteria[0].met, true);
});
