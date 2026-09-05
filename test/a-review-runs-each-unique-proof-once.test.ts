import assert from "node:assert/strict";
import { test } from "node:test";
import {
  judgeReview,
  memoizeProofExecutor,
  reviewLedgerLegibilityFields,
  type ProofExecutor,
  type ReviewEvidence,
  type WhitelistedProof,
} from "../src/lib/review.js";
import type { AcceptanceCriterion } from "../src/lib/plan.js";

/**
 * test/a-review-runs-each-unique-proof-once.test.ts — W1-T2743.
 *
 * OBSERVED ON PR #3744 AT HEAD 5af85ec9. All six acceptance criteria named the byte-identical
 * proof `unit test: test/a-gate-shaped-instrument-that-nothing-invokes.test.ts`, and the posted
 * `review.posted` row carried six proof outcomes in order: one `executed_fail`, then five
 * `executed_pass`. That cannot describe six different facts — it is six samples of ONE fact taken
 * inside one supposedly atomic judgment, and the first sample alone failed the commit status.
 *
 * `judgeReview` mapped every criterion through `judgeCriterion` with one shared
 * `ProofExecContext` carrying the RAW executor, so each criterion spawned its proof again — and a
 * passing proof is re-run against the merge base for staleness, so N identical criteria could cost
 * as many as 2N child processes.
 *
 * THE FIX IS AN IDENTITY, NOT A CACHE POLICY. The memo lives and dies inside one `judgeReview`
 * call and keys on checkout path + executable + exact argv, so no sha can inherit another sha's
 * result and there is nothing to invalidate. `cwd` is IN the key, which is what keeps a head
 * observation and a base observation of the same command from aliasing — the one aliasing that
 * would actually corrupt a verdict, since staleness is decided by comparing exactly those two.
 */

const PROOF = "unit test: test/a-gate-shaped-instrument-that-nothing-invokes.test.ts";

/** The #3744 shape: six criteria, one proof string, byte-identical. */
function sixIdenticalCriteria(): AcceptanceCriterion[] {
  return Array.from({ length: 6 }, (_, i) => ({ claim: `claim number ${i + 1}`, proof: PROOF }));
}

interface Recorder {
  exec: ProofExecutor;
  calls: Array<{ cwd: string; label: string }>;
}

/** A counting executor: records every (cwd, label) it is asked for and answers `outcome`. */
function recordingExecutor(outcome: (cwd: string) => "pass" | "fail" | "no-match" | Error): Recorder {
  const calls: Array<{ cwd: string; label: string }> = [];
  return {
    calls,
    exec: (whitelisted, cwd) => {
      calls.push({ cwd, label: whitelisted.label });
      const answer = outcome(cwd);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

function evidenceWith(rec: Recorder, over: Partial<ReviewEvidence> = {}): ReviewEvidence {
  return {
    diff: "",
    report: "claim number 1 claim number 2 gate shaped instrument nothing invokes",
    headCheckoutDir: "/head",
    baseCheckoutDir: "/base",
    execProof: rec.exec,
    ...over,
  } as ReviewEvidence;
}

// ── acceptance 1: six identical criteria run once on head and once on base ─────────────────────

test("W1-T2743 (acceptance 1): six criteria with the same pure-path proof execute ONCE on the head and ONCE on the merge base, then reuse", () => {
  // A DISCRIMINATING proof: passes at head, fails at base. Answering `pass` on BOTH sides would
  // grade `executed_stale` — correctly, per W1-T273/W1-T362 — which is a fact about staleness
  // rather than about duplicate execution, and would make this test measure the wrong thing.
  const rec = recordingExecutor((cwd) => (cwd === "/head" ? "pass" : "fail"));
  const verdict = judgeReview(sixIdenticalCriteria(), evidenceWith(rec));

  assert.equal(rec.calls.length, 2, `expected exactly two spawns, saw ${JSON.stringify(rec.calls)}`);
  assert.deepEqual(rec.calls.map((c) => c.cwd).sort(), ["/base", "/head"], "one of each, never two of one");
  assert.equal(verdict.proofUniqueRuns, 2);
  assert.equal(verdict.proofReuses, 10, "the other ten calls the #3744 shape would have made");
  // The verdict itself is unchanged in shape: six criteria, index-aligned, each with its outcome.
  assert.equal(verdict.criteria.length, 6);
  for (const c of verdict.criteria) assert.equal(c.proof_exec, "executed_pass");
});

// ── acceptance 2: head and base never alias ───────────────────────────────────────────────────

test("W1-T2743 (acceptance 2): head and merge-base executions never alias, even with identical command and argv", () => {
  // The base answers DIFFERENTLY from the head. If the two aliased, the base observation would be
  // the head's `pass` and every criterion would grade `executed_stale` — a wrong verdict, not
  // merely a wasted spawn. This is the aliasing that would actually corrupt a review.
  const rec = recordingExecutor((cwd) => (cwd === "/head" ? "pass" : "fail"));
  const verdict = judgeReview(sixIdenticalCriteria(), evidenceWith(rec));

  assert.equal(rec.calls.length, 2);
  assert.equal(verdict.proofUniqueRuns, 2, "two DISTINCT observations, because cwd is in the key");
  for (const c of verdict.criteria) {
    assert.notEqual(c.proof_exec, "executed_stale", "the base disagreed, so the proof discriminates");
    assert.equal(c.proof_exec, "executed_pass");
  }

  // And directly at the seam, so the property is pinned independently of judgeReview's plumbing.
  const direct = recordingExecutor((cwd) => (cwd === "/head" ? "pass" : "fail"));
  const memo = memoizeProofExecutor(direct.exec);
  const wp = { kind: "test", command: "node", args: ["--test", "x"], label: "x" } as WhitelistedProof;
  assert.equal(memo.exec(wp, "/head"), "pass");
  assert.equal(memo.exec(wp, "/base"), "fail", "same command, same argv, different checkout — a different observation");
  assert.equal(memo.uniqueRuns(), 2);
  assert.equal(memo.reuses(), 0);
});

// ── acceptance 3: a cached failure or throw is reused, never silently retried ──────────────────

test("W1-T2743 (acceptance 3a): a cached FAILURE is reused for every duplicate — one review cannot contradict itself", () => {
  // THE #3744 SIGNATURE, INVERTED: an executor that fails once and then passes. Before the memo
  // this produced one executed_fail followed by five executed_pass in one binding verdict.
  let n = 0;
  const rec = recordingExecutor(() => (n++ === 0 ? "fail" : "pass"));
  const verdict = judgeReview(sixIdenticalCriteria(), evidenceWith(rec));

  assert.equal(rec.calls.length, 1, "a failing head proof is never re-run for staleness, so exactly one spawn");
  const outcomes = verdict.criteria.map((c) => c.proof_exec);
  assert.deepEqual(
    new Set(outcomes),
    new Set(["executed_fail"]),
    `all six must report the ONE observation, not one fail and five passes: ${JSON.stringify(outcomes)}`,
  );
  assert.equal(verdict.proofUniqueRuns, 1);
  assert.equal(verdict.proofReuses, 5);
});

test("W1-T2743 (acceptance 3b): a cached execution ERROR replays the SAME throw rather than re-running", () => {
  let n = 0;
  const rec = recordingExecutor(() => (n++ === 0 ? new Error("timed out") : "pass"));
  const verdict = judgeReview(sixIdenticalCriteria(), evidenceWith(rec));

  assert.equal(rec.calls.length, 1, "a throw is a terminal observation for that command in that checkout");
  for (const c of verdict.criteria) {
    assert.equal(c.proof_exec, "exec_error", "every duplicate sees the same inconclusive result");
  }
  assert.equal(verdict.proofUniqueRuns, 1);
  assert.equal(verdict.proofReuses, 5);

  // At the seam: the SAME error object comes back, not a re-thrown lookalike.
  const boom = new Error("boom");
  const direct = recordingExecutor(() => boom);
  const memo = memoizeProofExecutor(direct.exec);
  const wp = { kind: "test", command: "node", args: ["a"], label: "x" } as WhitelistedProof;
  assert.throws(() => memo.exec(wp, "/head"), /boom/);
  assert.throws(
    () => memo.exec(wp, "/head"),
    (e: unknown) => e === boom,
    "the replayed rejection is the same observation, not a fresh attempt that might disagree",
  );
  assert.equal(direct.calls.length, 1, "and the underlying executor ran once");
  assert.equal(memo.reuses(), 1);
});

// ── acceptance 4: nothing survives a review boundary ───────────────────────────────────────────

test("W1-T2743 (acceptance 4): a LATER judgeReview call executes again — no result survives a review or head boundary", () => {
  const rec = recordingExecutor(() => "pass");
  judgeReview(sixIdenticalCriteria(), evidenceWith(rec));
  assert.equal(rec.calls.length, 2, "first review: two spawns");

  judgeReview(sixIdenticalCriteria(), evidenceWith(rec));
  assert.equal(rec.calls.length, 4, "second review re-observes — this is not a cross-review cache");

  // And a different head is a different observation even inside the same process.
  judgeReview(sixIdenticalCriteria(), evidenceWith(rec, { headCheckoutDir: "/head-2" }));
  assert.equal(rec.calls.length, 6);
  assert.ok(rec.calls.some((c) => c.cwd === "/head-2"), "the new checkout really was executed against");
});

// ── acceptance 5: the ledger records bounded counts and keeps the outcomes index-aligned ──────

test("W1-T2743 (acceptance 5a): review.posted's fields carry the two counts and nothing unbounded", () => {
  const rec = recordingExecutor(() => "pass");
  const verdict = judgeReview(sixIdenticalCriteria(), evidenceWith(rec));
  const fields = reviewLedgerLegibilityFields(verdict);

  assert.equal(fields.proof_unique_runs, 2);
  assert.equal(fields.proof_reuses, 10);
  // BOUNDED: the row gains two integers, never a command, argv, key list or stdout. Asserted by
  // scanning every value on the row for the proof's own text rather than by naming fields to avoid.
  const serialised = JSON.stringify(fields);
  assert.ok(!serialised.includes(PROOF), `no proof text on the row: ${serialised}`);
  assert.ok(!serialised.includes("--test"), "no argv on the row");
  assert.ok(!serialised.includes("/head"), "no checkout path on the row");
});

test("W1-T2743 (acceptance 5b): a review with NO head checkout reports the counts as ABSENT, never as zero", () => {
  const verdict = judgeReview(sixIdenticalCriteria(), { diff: "", report: "nothing" } as ReviewEvidence);
  assert.equal(verdict.proofUniqueRuns, undefined, "'never measured' is a different fact from 'measured none'");
  assert.equal(verdict.proofReuses, undefined);
  const fields = reviewLedgerLegibilityFields(verdict);
  assert.ok(!("proof_unique_runs" in fields), "and the ledger row omits them rather than writing 0");
  assert.ok(!("proof_reuses" in fields));
});

test("W1-T2743 (acceptance 5c): existing per-criterion outcomes stay index-aligned and unchanged in meaning", () => {
  // Two DIFFERENT proofs plus a duplicate of the first: the memo must not reorder, merge or drop a
  // criterion — only stop re-spawning. Criterion i's outcome must still describe criterion i.
  const rec = recordingExecutor((cwd) => (cwd === "/head" ? "pass" : "fail"));
  const criteria: AcceptanceCriterion[] = [
    { claim: "alpha", proof: "unit test: test/alpha.test.ts" },
    { claim: "beta", proof: "unit test: test/beta.test.ts" },
    { claim: "alpha again", proof: "unit test: test/alpha.test.ts" },
  ];
  const verdict = judgeReview(criteria, evidenceWith(rec));
  assert.equal(verdict.criteria.length, 3);
  assert.deepEqual(
    verdict.criteria.map((c) => c.claim),
    ["alpha", "beta", "alpha again"],
    "same order, same claims — the memo touches execution, never the criterion list",
  );
  assert.equal(verdict.proofUniqueRuns, 4, "two proofs x (head + base)");
  assert.equal(verdict.proofReuses, 2, "the duplicate's head and base calls");
  assert.deepEqual(rec.calls.filter((c) => c.label === "test/alpha.test.ts").length, 2, "alpha ran twice, not four times");
});
