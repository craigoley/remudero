import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeCriterion, judgeReview, type ProofExecutor } from "../src/lib/review.js";
import type { AcceptanceCriterion } from "../src/lib/plan.js";

/**
 * W1-T1071 — "a self-path `grep:` proof discriminates on the FILING PR and CANNOT on the
 * IMPLEMENTING one". The house convention this shard fixes, measured live across the plan
 * (`plan/tasks.d/*.yaml`): a criterion whose `grep:` proof greps a distinctive line of its OWN
 * shard's rationale/design prose back out of its own `plan/tasks.d/<id>-<slug>.yaml` — e.g.
 * `grep: the outlier population has more than one member in
 * plan/tasks.d/W1-T1039-a-burned-id-becomes-the-ceiling.yaml`. Honest on the FILING PR (the
 * shard's text is absent at the merge-base, present on the head — it discriminates the one
 * thing it can: "was this shard filed"). Once the shard merges, the SAME pattern sits in the
 * merge-base of every later PR too, including the one that BUILDS the task — the existing
 * `classifyBaseProofOutcome` correctly reports `"stale"` there, and before this task that
 * degraded, silently, to the keyword floor exactly like an ordinary non-discriminating grep.
 *
 * design (iv): the shape is a REFUSAL, named — `met` forced false, never merely withdrawn, with
 * a reason telling the author the proof was filing-time and must be rewritten to name the
 * behaviour now that it exists.
 *
 * design (v): the three shards whose ENTIRE deliverable is their own plan text (`files:` holds
 * nothing but their own `plan/tasks.d/*.yaml` path) must be exempt BY CONSTRUCTION — their
 * self-path proof keeps discriminating exactly as before, forever, because they have no
 * implementing diff to go stale on.
 */

const HEAD_DIR = "/fake/head/checkout";
const BASE_DIR = "/fake/base/checkout";

// The proof text every one of the 29-shard population's live examples is shaped like.
const SELF_PATH_PROOF =
  "grep: the outlier population has more than one member in " +
  "plan/tasks.d/W1-T1039-a-burned-id-becomes-the-ceiling.yaml";
const SELF_PATH_TARGET = "plan/tasks.d/W1-T1039-a-burned-id-becomes-the-ceiling.yaml";
// This task's own real `files:` (src/lib/review.ts, test/self-path-proof-discrimination.test.ts)
// declares no plan path at all — the code path is what makes it a shard with an implementing
// diff, exactly as design (v) requires.
const CODE_DELIVERABLE = new Set(["src/lib/task-id.ts", "test/task-id-allocation-bound.test.ts"]);

const alwaysPass: ProofExecutor = () => "pass";

// ── acceptance 1: refused by name, not degraded to the keyword floor ───────────────────────

test("acceptance 1 — a filing-time self-path proof gone stale is REFUSED (met forced false), even when the report pastes the proof verbatim", () => {
  const v = judgeCriterion(
    { claim: "the outlier population has more than one member", proof: SELF_PATH_PROOF },
    // A keyword-floor-satisfying report — under the OLD `executed_stale` degrade this alone
    // would have been enough to pass. The refusal must not care.
    new Set(SELF_PATH_PROOF.toLowerCase().split(/\W+/).filter(Boolean)),
    undefined,
    { cwd: HEAD_DIR, exec: alwaysPass, baseCwd: BASE_DIR, forwardReferenceFiles: CODE_DELIVERABLE },
  );
  assert.equal(v.proof_exec, "stale_self_path");
  assert.equal(v.met, false, "a self-path proof must be refused outright, never rescued by keyword coverage");
});

test("acceptance 1 — end-to-end through judgeReview: an implementing PR (task id resolved, no shard in this diff) still fails on a stale self-path proof", () => {
  const criteria: AcceptanceCriterion[] = [
    { claim: "the outlier population has more than one member", proof: SELF_PATH_PROOF },
  ];
  const v = judgeReview(criteria, {
    diff: "", // the implementing PR does not touch plan/tasks.d/ at all — the shard already merged
    report: `Built the fix. ${SELF_PATH_PROOF}`,
    headCheckoutDir: HEAD_DIR,
    baseCheckoutDir: BASE_DIR,
    execProof: alwaysPass,
    taskDeclaredFiles: [...CODE_DELIVERABLE],
  });
  assert.equal(v.criteria[0].proof_exec, "stale_self_path");
  assert.equal(v.criteria[0].met, false);
  assert.equal(v.state, "failure", v.summary);
});

// ── acceptance 2: a shard with no implementing diff keeps discriminating, never refused ────

test("acceptance 2 — a shard whose files: is nothing but its own plan path is exempt BY CONSTRUCTION: the self-path proof still degrades to executed_stale, never refused", () => {
  const v = judgeCriterion(
    { claim: "the outlier population has more than one member", proof: SELF_PATH_PROOF },
    new Set(), // report says nothing — proves the OLD degrade-to-floor path is what still runs
    undefined,
    {
      cwd: HEAD_DIR,
      exec: alwaysPass,
      baseCwd: BASE_DIR,
      // The only declared path IS the proof's own target — no code path beside it.
      forwardReferenceFiles: new Set([SELF_PATH_TARGET]),
    },
  );
  assert.equal(v.proof_exec, "executed_stale", "no other declared path ⇒ never the new refusal");
  assert.notEqual(v.proof_exec, "stale_self_path");
});

test("acceptance 2 — no declaredFiles at all (e.g. no task id resolved) also never refuses — only degrades", () => {
  const v = judgeCriterion(
    { claim: "the outlier population has more than one member", proof: SELF_PATH_PROOF },
    new Set(),
    undefined,
    { cwd: HEAD_DIR, exec: alwaysPass, baseCwd: BASE_DIR },
  );
  assert.equal(v.proof_exec, "executed_stale");
});

// ── acceptance 3: the refusal names the proof and says it must be rewritten ────────────────

test("acceptance 3 — the refusal reason names the proof's own text and instructs a rewrite naming the behaviour", () => {
  const v = judgeCriterion(
    { claim: "the outlier population has more than one member", proof: SELF_PATH_PROOF },
    new Set(),
    undefined,
    { cwd: HEAD_DIR, exec: alwaysPass, baseCwd: BASE_DIR, forwardReferenceFiles: CODE_DELIVERABLE },
  );
  assert.equal(v.proof_exec, "stale_self_path");
  // Names the proof: the grep's own pattern/path (the WhitelistedProof label) appears verbatim.
  assert.match(v.reason, /the outlier population has more than one member/);
  assert.match(v.reason, /W1-T1039-a-burned-id-becomes-the-ceiling\.yaml/);
  // Says it must be rewritten to name the behaviour.
  assert.match(v.reason, /rewrite/i);
  assert.match(v.reason, /behaviour/i);
});

// ── acceptance 4: a proof that already names behaviour (not a declared plan path) is untouched ──

test("acceptance 4 — an ordinary stale code grep (not a plan-shard path) is UNTOUCHED: stays executed_stale, never refused", () => {
  // Same shape of staleness (matches head AND base), but the proof already names the BEHAVIOUR
  // — a real source file — not a declared plan path. This is the pre-existing W1-T273 case and
  // must not be swept up by this task.
  const v = judgeCriterion(
    { claim: "the probe reads the worker keychain path", proof: "grep: workerKeychainPaths in src/run-task.ts" },
    new Set(),
    undefined,
    {
      cwd: HEAD_DIR,
      exec: alwaysPass,
      baseCwd: BASE_DIR,
      // Even with OTHER declared files present, a non-plan-shard target must never refuse.
      forwardReferenceFiles: new Set(["src/run-task.ts", "test/some-other-file.test.ts"]),
    },
  );
  assert.equal(v.proof_exec, "executed_stale");
  assert.notEqual(v.proof_exec, "stale_self_path");
});

test("acceptance 4 — a unit test: proof gone stale is also untouched (this task's refusal is grep-only, matching the population it was measured against)", () => {
  const v = judgeCriterion(
    { claim: "the widget is frobnicated", proof: "unit test: test/widget.test.ts" },
    new Set(),
    undefined,
    // (R-11) a faked base run of a `unit test:` proof counts only for a declared real checkout
    { cwd: HEAD_DIR, exec: alwaysPass, baseCwd: BASE_DIR, baseIsCheckout: true, forwardReferenceFiles: CODE_DELIVERABLE },
  );
  assert.equal(v.proof_exec, "executed_stale");
});

// ── control: a genuinely discriminating self-path-shaped proof is unaffected ───────────────

test("control — a self-path-shaped grep proof that still discriminates (absent at the base) is unaffected: stays executed_pass, met true", () => {
  const headOnly: ProofExecutor = (_wp, cwd) => (cwd === BASE_DIR ? "fail" : "pass");
  const v = judgeCriterion(
    { claim: "the outlier population has more than one member", proof: SELF_PATH_PROOF },
    new Set(),
    undefined,
    { cwd: HEAD_DIR, exec: headOnly, baseCwd: BASE_DIR, forwardReferenceFiles: CODE_DELIVERABLE },
  );
  assert.equal(v.proof_exec, "executed_pass", "the filing PR's own honest discrimination is never touched");
  assert.equal(v.met, true);
});
