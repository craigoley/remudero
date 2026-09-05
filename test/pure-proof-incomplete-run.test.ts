import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cappedReason,
  execWhitelistedProof,
  judgeCriterion,
  type ProofExecContext,
  type ProofSpawner,
  type WhitelistedProof,
} from "../src/lib/review.js";
import { loadDefaultPolicy } from "../src/lib/policy.js";

// ── W1-T2740 ─────────────────────────────────────────────────────────────────
//
// A pure-path (single-file, non-name-filtered) `unit test:` proof whose run is CUT OFF was graded
// `executed_fail` — a binding refusal that overrides every other piece of evidence — on a stream
// that contains no failing test at all.
//
// MEASURED ON PR #3719, HEAD 51d4958b, then reproduced on the Azure review host: the proof
// `unit test: test/retro-marker-atomic.test.ts` was posted `executed_fail`, while the identical
// checkout completed all 33 of that file's tests in 127 seconds when allowed to finish. Running
// the same command under a 60-second `execFileSync` limit produced `status: 1`, `signal: null`,
// several real passing TAP results, NO `not ok` line, and NO trailing `# duration_ms` summary.
//
// Every guard `execWhitelistedProof` already had missed that shape. `err.code === "ETIMEDOUT"`
// (W1-T2742) did not fire; `typeof err.status !== "number"` did not fire (node traps SIGTERM and
// exits cleanly with 1); and W1-T1077's wrapper-name classifier found no `not ok` line to read. So
// the run fell through to `return "fail"`.
//
// The repository ALREADY owns the right discriminator and was applying it to the other branch
// only: node writes its trailing `# duration_ms` summary once, after the run genuinely completes.
// `hasFinalSummary` has documented exactly that since W1-T112, and `nameFilteredOutcome` throws on
// its absence. This task reuses that same signal for the pure-path branch rather than guessing
// from `status`, `signal`, elapsed wall time, or platform-specific timeout metadata.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A {@link ProofSpawner} standing in for `execFileSync` throwing on a clean nonzero exit, with
 * `stdout` attached exactly as node's real `ErrnoException` carries it — the shape
 * `execWhitelistedProof`'s catch block already reads. The SAME helper W1-T1077's suite
 * (test/pure-path-proof-outcomes.test.ts) uses, so both suites drive the identical seam. */
function throwingSpawner(stdout: string): ProofSpawner {
  return () => {
    throw Object.assign(new Error("Command failed: node --test"), { status: 1, stdout });
  };
}

/** The measured PR #3719 shape: real passing subtests, then nothing. No `not ok`, and — the
 * load-bearing part — no `# duration_ms` line, because the process was killed before node could
 * write its summary. Only the TAP `(ok|not ok) N - name` result lines and the summary's absence
 * are read by the parser; the rest is representative filler. */
const TIMEOUT_TRUNCATED_STDOUT = [
  "TAP version 13",
  "# Subtest: the marker write is atomic",
  "ok 1 - the marker write is atomic",
  "  ---",
  "  duration_ms: 41.2",
  "  type: 'test'",
  "  ...",
  "# Subtest: a partial write is never observed",
  "ok 2 - a partial write is never observed",
  "  ---",
  "  duration_ms: 38.7",
  "  type: 'test'",
  "  ...",
  "# Subtest: a concurrent reader sees one whole marker",
].join("\n");

/** The SAME truncation, but a real subtest genuinely failed before the kill. An observed failure
 * is evidence whether or not the run later finished — this must stay a hard `"fail"`. */
const TRUNCATED_WITH_REAL_FAILURE_STDOUT = [
  "TAP version 13",
  "# Subtest: the marker write is atomic",
  "ok 1 - the marker write is atomic",
  "# Subtest: a partial write is never observed",
  "not ok 2 - a partial write is never observed",
  "  ---",
  "  failureType: 'testCodeFailure'",
  "  code: 'ERR_ASSERTION'",
  "  ...",
  "# Subtest: a concurrent reader sees one whole marker",
].join("\n");

/** A COMPLETED run with a genuine failing subtest — carries the trailing summary. Unchanged by
 * this task: still `executed_fail`, still overriding the keyword floor. */
const COMPLETED_FAILURE_STDOUT = [
  "TAP version 13",
  "# Subtest: a partial write is never observed",
  "not ok 1 - a partial write is never observed",
  "  ---",
  "  code: 'ERR_ASSERTION'",
  "  ...",
  "1..1",
  "# tests 1",
  "# pass 0",
  "# fail 1",
  "# duration_ms 61",
].join("\n");

/** W1-T1077's broken-runtime shape, reproduced here as a REGRESSION CONTROL: it COMPLETED (it
 * carries `# duration_ms`) and its only `not ok` names the file itself. This task's classifier is
 * read FIRST in the same branch, so this suite must prove it did not swallow that sibling case. */
const BROKEN_RUNTIME_STDOUT = [
  "TAP version 13",
  "# Subtest: test/pure-path-fixture.test.ts",
  "not ok 1 - test/pure-path-fixture.test.ts",
  "  ---",
  "  code: 'ERR_TEST_FAILURE'",
  "  ...",
  "1..1",
  "# tests 1",
  "# pass 0",
  "# fail 1",
  "# duration_ms 20",
].join("\n");

const PURE_PATH_WP: WhitelistedProof = {
  kind: "test",
  command: "node",
  args: ["--test", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", "test/pure-path-fixture.test.ts"],
  label: "test/pure-path-fixture.test.ts",
};

const CRITERION = { claim: "the marker write is atomic", proof: "unit test: test/pure-path-fixture.test.ts" };
/** Covers the proof's distinctive keywords, so the keyword floor would say `met: true` unaided —
 * which is what makes "degrades, never overrides" observable in both directions below. */
const COVERING_TOKENS = new Set(["pure", "path", "fixture"]);

const ctxFor = (stdout: string): ProofExecContext => ({
  cwd: "/nonexistent",
  exec: (w, cwd) => execWhitelistedProof(w, cwd, 60_000, throwingSpawner(stdout)),
});

// ── acceptance 1: a truncated run is inconclusive, never executed_fail ─────────────────────────

test("W1-T2740 (acceptance 1a): execWhitelistedProof — a pure-path run with passing TAP results and NO trailing summary throws, never returning a manufactured 'fail'", () => {
  assert.throws(
    () => execWhitelistedProof(PURE_PATH_WP, "/nonexistent", 60_000, throwingSpawner(TIMEOUT_TRUNCATED_STDOUT)),
    /stopped before node's trailing `# duration_ms` summary/,
  );
});

test("W1-T2740 (acceptance 1b): judgeCriterion — a truncated pure-path proof DEGRADES to the keyword floor (exec_error), never hard-refusing a report that substantiates the claim", () => {
  const verdict = judgeCriterion(CRITERION, COVERING_TOKENS, undefined, ctxFor(TIMEOUT_TRUNCATED_STDOUT));
  assert.notEqual(verdict.proof_exec, "executed_fail", "the run never reached a verdict — it cannot mint one");
  assert.equal(verdict.proof_exec, "exec_error");
  assert.equal(verdict.proof_skip, "incomplete-run");
  assert.equal(verdict.met, true, "the keyword-floor pass stands verbatim — exec_error only degrades, never overrides");
});

test("W1-T2740 (acceptance 1c): judgeCriterion — a truncated pure-path proof degrades a FAILING keyword floor too, so the degrade never rescues either", () => {
  const verdict = judgeCriterion(CRITERION, new Set(), undefined, ctxFor(TIMEOUT_TRUNCATED_STDOUT));
  assert.equal(verdict.proof_exec, "exec_error");
  assert.equal(verdict.proof_skip, "incomplete-run");
  assert.equal(verdict.met, false, "a degrade never OVERRIDES the floor in either direction");
});

// ── acceptance 2: the outcome is recorded by NAME, with a bounded discriminator, not the stream ──

test("W1-T2740 (acceptance 2a): the recorded reason names the discriminator and the result count, and carries NO captured TAP output", () => {
  const verdict = judgeCriterion(CRITERION, COVERING_TOKENS, undefined, ctxFor(TIMEOUT_TRUNCATED_STDOUT));
  assert.match(verdict.reason, /2 passing subtest\(s\)/, "the bounded discriminator: how many real results the stream did carry");
  assert.match(verdict.reason, /stopped before node's trailing summary/, "and WHY it is inconclusive");
  // The stream itself must never reach the row. Assert on lines only the raw capture would carry.
  assert.doesNotMatch(verdict.reason, /TAP version 13/, "the raw TAP capture is unbounded and must never be persisted");
  assert.doesNotMatch(verdict.reason, /duration_ms: 41\.2/, "no per-subtest timing from the stream either");
  assert.doesNotMatch(verdict.reason, /# Subtest:/, "no subtest titles lifted out of the capture");
});

test("W1-T2740 (acceptance 2b): the ledger's capped_reason names incomplete-run as its OWN token, distinct from runtime-broken and from a generic exec-error", () => {
  const tokens = cappedReason([
    { proof_exec: "exec_error", proof_skip: "incomplete-run" },
    { proof_exec: "exec_error", proof_skip: "runtime-broken" },
    { proof_exec: "exec_error", proof_skip: "exec-error" },
  ]);
  assert.ok(tokens, "three capped proofs must produce a capped_reason at all");
  assert.match(tokens, /incomplete-run:1/, "a truncated run is legible on the row as its own cause");
  assert.match(tokens, /runtime-broken:1/);
  assert.match(tokens, /exec-error:1/);
});

// ── acceptance 3: a genuine failing subtest still grades executed_fail ─────────────────────────

test("W1-T2740 (acceptance 3a): a COMPLETED run with a real failing subtest still hard-refuses (executed_fail), overriding a keyword floor that claims success", () => {
  assert.equal(
    execWhitelistedProof(PURE_PATH_WP, "/nonexistent", 60_000, throwingSpawner(COMPLETED_FAILURE_STDOUT)),
    "fail",
  );
  const verdict = judgeCriterion(CRITERION, COVERING_TOKENS, undefined, ctxFor(COMPLETED_FAILURE_STDOUT));
  assert.equal(verdict.proof_exec, "executed_fail");
  assert.equal(verdict.proof_skip, undefined, "a genuine failure is not a skip at all");
  assert.equal(verdict.met, false);
});

test("W1-T2740 (acceptance 3b): a TRUNCATED run that nonetheless observed a real failing subtest is still executed_fail — an observed failure is evidence whether or not the run finished", () => {
  assert.equal(
    execWhitelistedProof(PURE_PATH_WP, "/nonexistent", 60_000, throwingSpawner(TRUNCATED_WITH_REAL_FAILURE_STDOUT)),
    "fail",
    "the summary's absence must not launder an observed failure into an inconclusive result",
  );
  const verdict = judgeCriterion(CRITERION, COVERING_TOKENS, undefined, ctxFor(TRUNCATED_WITH_REAL_FAILURE_STDOUT));
  assert.equal(verdict.proof_exec, "executed_fail");
  assert.notEqual(verdict.proof_skip, "incomplete-run");
});

// ── acceptance 4: absence emits no TAP result and stays a hard failure ─────────────────────────

test("W1-T2740 (acceptance 4a): a genuinely ABSENT pure-path target is still a hard 'fail' — real execWhitelistedProof, real spawn, real absence", () => {
  const wp: WhitelistedProof = {
    kind: "test",
    command: "node",
    args: [
      "--test",
      "--import",
      "tsx",
      "--import",
      "./test/setup/tmp-hygiene.ts",
      "test/does-not-exist-w1t2740-fixture.test.ts",
    ],
    label: "test/does-not-exist-w1t2740-fixture.test.ts",
  };
  // An absent path reports NO TAP output at all (W1-T1077's own measurement) — and empty stdout
  // ALSO has no trailing summary, which is exactly why this classifier requires at least one real
  // result before calling a run incomplete. Without that clause, absence would be silently
  // reclassified as a timeout: the one regression this task must not introduce.
  assert.equal(execWhitelistedProof(wp, REPO_ROOT, 60_000), "fail");
});

test("W1-T2740 (acceptance 4b): an empty stream is not 'incomplete' — the synthetic mirror of 4a, driving the same branch without a real spawn", () => {
  assert.equal(execWhitelistedProof(PURE_PATH_WP, "/nonexistent", 60_000, throwingSpawner("")), "fail");
});

// ── acceptance 5: the timeout policy, the complete-pass path and the sibling classifier stand ──

test("W1-T2740 (acceptance 5a): a COMPLETE passing run is still 'pass' — the classifier is only ever consulted on a nonzero exit", () => {
  const passingSpawner: ProofSpawner = () => ["TAP version 13", "ok 1 - fine", "# duration_ms 12"].join("\n");
  assert.equal(execWhitelistedProof(PURE_PATH_WP, "/nonexistent", 60_000, passingSpawner), "pass");
});

test("W1-T2740 (acceptance 5b): W1-T1077's broken-runtime case is untouched — a COMPLETED run whose only 'not ok' names the file wrapper still reads runtime-broken", () => {
  // The regression control for reading this task's classifier FIRST in the shared branch.
  assert.throws(
    () => execWhitelistedProof(PURE_PATH_WP, "/nonexistent", 60_000, throwingSpawner(BROKEN_RUNTIME_STDOUT)),
    /never reached a real subtest/,
  );
  const verdict = judgeCriterion(CRITERION, COVERING_TOKENS, undefined, ctxFor(BROKEN_RUNTIME_STDOUT));
  assert.equal(verdict.proof_skip, "runtime-broken", "not incomplete-run — that run COMPLETED and said so");
});

test("W1-T2740 (acceptance 5c): the proof timeout POLICY is untouched — the fix is the classification of an expiry, never a wider bound", () => {
  // The task's own falsifier names raising `proofTimeoutMs` as the wrong fix. Assert the bound the
  // executor defaults to is still exactly the one plan/policy.yaml declares — read from the file
  // rather than a literal, so this stays true when the operator moves the policy value and fails
  // the moment a change like this one tries to smuggle a wider tolerance in as the fix.
  const declared = /^proofTimeoutMs:\n\s+value:\s*(\d+)\s*$/m.exec(
    readFileSync(join(REPO_ROOT, "plan/policy.yaml"), "utf8"),
  );
  assert.ok(declared, "plan/policy.yaml still declares proofTimeoutMs.value");
  assert.equal(
    loadDefaultPolicy().values.proofTimeoutMs,
    Number(declared[1]),
    "the executor's default bound is the declared policy value, unchanged by this task",
  );
});
