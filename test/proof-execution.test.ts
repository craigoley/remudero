import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadPlan, type AcceptanceCriterion } from "../src/lib/plan.js";
import {
  execWhitelistedProof,
  isDialectPrefixed,
  judgeReview,
  parseWhitelistedProof,
  type ProofExecutor,
} from "../src/lib/review.js";

// ── W1-T128: THE DEAD PROOF FLOOR ────────────────────────────────────────────
//
// MEASURED 2026-07-19: 126 acceptance proofs in plan/tasks.yaml carried a runnable
// house-dialect prefix ('unit test:' / 'grep:') and only 25 (20%) could ever
// execute. Cause: UNSAFE_FENCE_CHARS_RE refused any dialect BODY containing
// `; & \` $ < >` -- and a dialect body is ordinary architect PROSE, which
// routinely contains a semicolon (W1-T38's own second acceptance proof reads
// 'unit test: marking an entry superseded reduces the counted size; the same
// bytes as an active entry would exceed the cap' -- refused for that one `;`).
//
// FIX (decided: narrow the blocklist, not a new proof format): execFile never
// invokes a shell, so those characters were never actually unsafe for the
// argv they become -- the blocklist was refusing safety execFile already
// guaranteed by construction. The only REAL hazards that survive execFile are
// path traversal ('..') and literal glob expansion ('*') in a grep TARGET,
// both still refused (test/review.test.ts covers those directly). This file
// proves the FOUR acceptance criteria named on the task.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ── Acceptance #1: the dead floor is measurably alive on the REAL plan corpus ─

test("ACCEPTANCE #1: dialect-prefixed proofs in the real plan/tasks.yaml corpus are now overwhelmingly executable -- against the recorded 2026-07-19 baseline of 25/126 (20%)", () => {
  const plan = loadPlan(join(REPO_ROOT, "plan", "tasks.yaml"));
  let dialectCount = 0;
  let executableCount = 0;
  for (const t of plan.tasks) {
    for (const c of t.acceptance ?? []) {
      if (!isDialectPrefixed(c.proof)) continue;
      dialectCount++;
      if (parseWhitelistedProof(c.proof)) executableCount++;
    }
  }
  // Sanity: the corpus is not empty (a vacuous 0/0 would trivially "pass" below).
  assert.ok(dialectCount > 50, `expected a substantial dialect-prefixed corpus, got ${dialectCount}`);
  // The defect measured 25/126 (~20%) executable. The fix must clear that floor
  // by a wide margin -- comfortably above the old baseline in BOTH the absolute
  // count and the fraction, resilient to ordinary plan growth/shrinkage.
  assert.ok(
    executableCount >= 150,
    `expected far more than the 25-proof 2026-07-19 baseline to execute, got ${executableCount}/${dialectCount}`,
  );
  const fraction = executableCount / dialectCount;
  assert.ok(
    fraction >= 0.9,
    `expected the vast majority of dialect proofs executable (was 20%), got ${(fraction * 100).toFixed(1)}%`,
  );
});

// ── Acceptance #2: the FALSIFIER -- a genuinely failing proof still FAILS ────
// The load-bearing constraint: the fix must not "start passing" by relaxing
// judgment. A dialect proof containing the exact semicolon that used to get it
// refused must, once executed, still FAIL the review when the repo state does
// not observably contain what it claims -- proof_exec overrides keyword
// coverage in BOTH directions, unchanged from W1-T65.

test("ACCEPTANCE #2 (falsifier): a semicolon-bearing dialect proof that genuinely FAILS on the PR head still fails the review -- not merely relaxed into passing", () => {
  const alwaysFail: ProofExecutor = () => "fail";
  const criteria: AcceptanceCriterion[] = [
    {
      claim: "the resolver rejects a malformed mount; the caller sees a named error",
      proof: "unit test: a malformed mount is rejected; the resolver names the field that failed",
    },
  ];
  // Report keyword-claims the proof in prose (would PASS the old keyword-only
  // floor) -- but the observed execution must still override it to FAILURE.
  const report =
    "the resolver rejects a malformed mount; the resolver names the field that failed, exactly as claimed";
  const v = judgeReview(criteria, {
    diff: "",
    report,
    headCheckoutDir: "/fake/head/checkout",
    execProof: alwaysFail,
  });
  assert.equal(v.criteria[0].proof_exec, "executed_fail");
  assert.equal(v.criteria[0].met, false);
  assert.equal(v.state, "failure");
});

// ── Acceptance #4: the #234-class semicolon regression -- the single character
// that disabled 80% of the floor now executes rather than being refused ─────

test("ACCEPTANCE #4: a proof whose body contains a semicolon EXECUTES rather than being refused -- the W1-T38 semicolon regression, byte-for-byte", () => {
  // The EXACT proof text recorded in plan/tasks.yaml (W1-T38's own second
  // acceptance criterion) that the rationale names as the single-semicolon
  // refusal: 'unit test: marking an entry superseded reduces the counted
  // size; the same bytes as an active entry would exceed the cap'.
  const w1t38Proof =
    "unit test: marking an entry superseded reduces the counted size; the same bytes as an active entry would exceed the cap";
  const whitelisted = parseWhitelistedProof(w1t38Proof);
  assert.ok(whitelisted, "the semicolon-bearing dialect body must no longer be refused");
  assert.equal(whitelisted!.kind, "test");
  assert.ok(whitelisted!.nameFiltered);

  // End-to-end through judgeReview too, with an injected executor standing in
  // for the real one (same discipline as the W1-T65/W1-T72 fixtures) --
  // proof_exec must be OBSERVED (executed_pass/executed_fail), never
  // not_executable, and a genuine pass is honestly reported as such.
  const alwaysPass: ProofExecutor = () => "pass";
  const v = judgeReview([{ claim: "superseded entries do not count against the cap", proof: w1t38Proof }], {
    diff: "",
    report: "unrelated report text",
    headCheckoutDir: "/fake/head/checkout",
    execProof: alwaysPass,
  });
  assert.equal(v.criteria[0].proof_exec, "executed_pass");
  assert.equal(v.criteria[0].met, true);
});

// ── Acceptance #3: the W1-T38 over-cap fixture executes END-TO-END through the
// REAL default executor (no injected fake) against the real repo checkout --
// proving the floor really runs a proof in the sandbox, not merely parses one.
// test/learnings-budget-ratchet.test.ts IS the over-cap fixture: it drives the
// real scripts/learnings-budget-ratchet.mjs CLI and covers a bulk active
// corpus going RED naming the overage, and the identical bytes marked
// superseded going GREEN. Naming it as a literal test-file path is a shape the
// floor already executed pre-W1-T128 (unaffected by the blocklist fix) --
// reported honestly here as the REAL end-to-end proof of the underlying story,
// not a demonstration of the narrowed-blocklist mechanism itself (that is
// acceptance #1/#2/#4, above).
test("ACCEPTANCE #3: the W1-T38 over-cap/supersede fixture executes end-to-end via the REAL proof executor, against the real checkout", () => {
  const whitelisted = parseWhitelistedProof("unit test: test/learnings-budget-ratchet.test.ts");
  assert.ok(whitelisted);
  assert.equal(whitelisted!.kind, "test");
  const outcome = execWhitelistedProof(whitelisted!, REPO_ROOT, 60_000);
  assert.equal(outcome, "pass");
});
