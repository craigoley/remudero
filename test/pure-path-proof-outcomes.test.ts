import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cappedReason,
  execWhitelistedProof,
  judgeCriterion,
  reviewLedgerLegibilityFields,
  type ProofExecContext,
  type ProofSpawner,
  type WhitelistedProof,
} from "../src/lib/review.js";

// ── W1-T1077 ─────────────────────────────────────────────────────────────────
//
// A pure-path (single-file, non-name-filtered) `unit test:` proof used to read its verdict from
// the process exit code ALONE — `execWhitelistedProof`'s pure-path branch did `return "fail"` on
// ANY clean nonzero exit. MEASURED (this task's rationale, and re-measured directly below): under
// the reviewer's own invocation (`node --test --import tsx --import <hygiene> <file>`), a genuinely
// FAILING test, an ABSENT file, and a BROKEN RUNTIME (an unresolvable `--import` loader, an
// uncaught module-load error) all exit 1 — but only the FAILING-test and ABSENT-file cases are
// evidence the criterion is unmet. A BROKEN RUNTIME never reached a verdict about the criterion at
// all, yet was refused exactly like a genuine failure.
//
// The TAP stdout already in hand separates them: a genuine failure's only `not ok` line names the
// TEST'S OWN TITLE; a broken runtime's only `not ok` line names the FILE ITSELF — the same
// `isFileWrapperResultName` predicate `nameFilteredOutcome` already used for the OTHER
// (name-filtered) branch, now reused (not reimplemented) for this one.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A {@link ProofSpawner} standing in for `execFileSync` throwing on a clean nonzero exit, with
 * `stdout` attached exactly as node's real `ErrnoException` carries it — the shape
 * `execWhitelistedProof`'s catch block already reads. */
function throwingSpawner(stdout: string): ProofSpawner {
  return () => {
    throw Object.assign(new Error("Command failed: node --test"), { status: 1, stdout });
  };
}

// Trimmed excerpts of REAL `node --test` TAP output, measured live against this exact fixture
// shape (a broken `--import` loader / uncaught module-load error vs. a genuine `ERR_ASSERTION`) —
// see this task's rationale for the full captures. Only the lines the parser reads (the TAP
// `(ok|not ok) N - name` result lines) are load-bearing; the rest is representative filler.
const BROKEN_RUNTIME_STDOUT = [
  "TAP version 13",
  "# Subtest: test/pure-path-fixture.test.ts",
  "not ok 1 - test/pure-path-fixture.test.ts",
  "  ---",
  "  duration_ms: 12.3",
  "  type: 'test'",
  "  failureType: 'testCodeFailure'",
  "  exitCode: 1",
  "  code: 'ERR_TEST_FAILURE'",
  "  ...",
  "1..1",
  "# tests 1",
  "# pass 0",
  "# fail 1",
  "# duration_ms 20",
].join("\n");

const GENUINE_FAILURE_STDOUT = [
  "TAP version 13",
  "# Subtest: adds wrong",
  "not ok 1 - adds wrong",
  "  ---",
  "  duration_ms: 1.1",
  "  type: 'test'",
  "  failureType: 'testCodeFailure'",
  "  code: 'ERR_ASSERTION'",
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

// ── acceptance 1: a broken runtime degrades to the keyword floor, never a refusal ──────────────

test("W1-T1077 (acceptance 1a): execWhitelistedProof — a pure-path proof whose only 'not ok' line names the FILE ITSELF throws (never a manufactured 'fail')", () => {
  assert.throws(
    () => execWhitelistedProof(PURE_PATH_WP, "/nonexistent", 60_000, throwingSpawner(BROKEN_RUNTIME_STDOUT)),
    /never reached a real subtest/,
  );
});

test("W1-T1077 (acceptance 1b): judgeCriterion — a broken-runtime pure-path proof DEGRADES to the keyword floor (exec_error), never hard-refuses a report that substantiates the claim", () => {
  const criterion = { claim: "the widget parses cleanly", proof: "unit test: test/pure-path-fixture.test.ts" };
  const execCtx: ProofExecContext = {
    cwd: "/nonexistent",
    exec: (w, cwd) => execWhitelistedProof(w, cwd, 60_000, throwingSpawner(BROKEN_RUNTIME_STDOUT)),
  };
  const reportTokens = new Set(["pure", "path", "fixture"]); // covers the proof's distinctive keywords
  const verdict = judgeCriterion(criterion, reportTokens, undefined, execCtx);

  assert.equal(verdict.proof_exec, "exec_error", "never executed_fail — the run never reached a verdict");
  assert.equal(verdict.proof_skip, "runtime-broken");
  assert.equal(verdict.met, true, "the keyword-floor pass stands, verbatim — exec_error only degrades, never overrides");
  assert.match(verdict.reason, /never reached a real subtest/);
  assert.match(verdict.reason, /test\/pure-path-fixture\.test\.ts/, "records the file-wrapper name already parsed");
});

test("W1-T1077 (acceptance 1c): judgeCriterion — a broken-runtime pure-path proof degrades a FAILING keyword floor too (stays unmet, never force-passed)", () => {
  const criterion = { claim: "the widget parses cleanly", proof: "unit test: test/pure-path-fixture.test.ts" };
  const execCtx: ProofExecContext = {
    cwd: "/nonexistent",
    exec: (w, cwd) => execWhitelistedProof(w, cwd, 60_000, throwingSpawner(BROKEN_RUNTIME_STDOUT)),
  };
  const verdict = judgeCriterion(criterion, new Set(), undefined, execCtx); // no report tokens ⇒ floor unmet
  assert.equal(verdict.proof_exec, "exec_error");
  assert.equal(verdict.proof_skip, "runtime-broken");
  assert.equal(verdict.met, false, "a degrade never OVERRIDES the floor in either direction");
});

// ── acceptance 2: a genuine named-test failure still refuses and still overrides ────────────────

test("W1-T1077 (acceptance 2a): execWhitelistedProof — a pure-path proof whose 'not ok' line names the TEST'S OWN TITLE is a genuine 'fail', unchanged", () => {
  assert.equal(
    execWhitelistedProof(PURE_PATH_WP, "/nonexistent", 60_000, throwingSpawner(GENUINE_FAILURE_STDOUT)),
    "fail",
  );
});

test("W1-T1077 (acceptance 2b): judgeCriterion — a genuinely FAILING pure-path proof still hard-refuses (executed_fail) even when the report keyword-claims success", () => {
  const criterion = { claim: "the widget parses cleanly", proof: "unit test: test/pure-path-fixture.test.ts" };
  const execCtx: ProofExecContext = {
    cwd: "/nonexistent",
    exec: (w, cwd) => execWhitelistedProof(w, cwd, 60_000, throwingSpawner(GENUINE_FAILURE_STDOUT)),
  };
  // The report keyword-claims the proof responsively (floor would say met=true unaided) — the
  // genuine execution failure must override it anyway (W1-T51's kill, unchanged by this task).
  const reportTokens = new Set(["pure", "path", "fixture"]);
  const verdict = judgeCriterion(criterion, reportTokens, undefined, execCtx);

  assert.equal(verdict.proof_exec, "executed_fail");
  assert.equal(verdict.proof_skip, undefined, "a genuine failure carries no proof_skip — it is not a skip at all");
  assert.equal(verdict.met, false, "overrides the keyword floor, exactly like before this task");
  assert.match(verdict.reason, /proof executed and FAILED/);
});

// ── acceptance 3: absence, outside the forward-reference carve-out, keeps refusing exactly as today ──

test("W1-T1077 (acceptance 3): execWhitelistedProof — a genuinely ABSENT pure-path target is still a hard 'fail', unchanged by this task (real spawn, real absence)", () => {
  const wp: WhitelistedProof = {
    kind: "test",
    command: "node",
    args: [
      "--test",
      "--import",
      "tsx",
      "--import",
      "./test/setup/tmp-hygiene.ts",
      "test/does-not-exist-w1t1077-fixture.test.ts",
    ],
    label: "test/does-not-exist-w1t1077-fixture.test.ts",
  };
  // REAL execWhitelistedProof, REAL spawn, REAL absence — node reports NO TAP output at all for a
  // missing path (empty stdout; the rationale's own measurement), so the new wrapper-name read
  // finds nothing to reclassify and this must still fall through to "fail", exactly as before.
  assert.equal(execWhitelistedProof(wp, REPO_ROOT, 60_000), "fail");
});

// ── acceptance 4: the posted review row can say WHICH of the two a failed pure-path proof was ────

test("W1-T1077 (acceptance 4): the ledger's capped_reason distinguishes a broken-runtime proof from an ordinary exec-error and from a genuine failure — three DIFFERENT tokens off ONE row", () => {
  const runtimeBrokenExecCtx: ProofExecContext = {
    cwd: "/nonexistent",
    exec: (w, cwd) => execWhitelistedProof(w, cwd, 60_000, throwingSpawner(BROKEN_RUNTIME_STDOUT)),
  };
  const ordinaryExecErrorExecCtx: ProofExecContext = {
    cwd: "/nonexistent",
    exec: () => {
      throw new Error("ETIMEDOUT"); // an unrelated cause — a timeout / spawn error, not this task's shape
    },
  };

  const runtimeBroken = judgeCriterion(
    { claim: "widget A parses cleanly", proof: "unit test: test/pure-path-fixture.test.ts" },
    new Set(["pure", "path", "fixture"]),
    undefined,
    runtimeBrokenExecCtx,
  );
  const ordinaryExecError = judgeCriterion(
    { claim: "widget B parses cleanly", proof: "unit test: test/some-other-fixture.test.ts" },
    new Set(["some", "other", "fixture"]),
    undefined,
    ordinaryExecErrorExecCtx,
  );
  const genuineFailure = judgeCriterion(
    { claim: "widget C parses cleanly", proof: "unit test: test/pure-path-fixture.test.ts" },
    new Set(["pure", "path", "fixture"]),
    undefined,
    { cwd: "/nonexistent", exec: (w, cwd) => execWhitelistedProof(w, cwd, 60_000, throwingSpawner(GENUINE_FAILURE_STDOUT)) },
  );

  // Both broken-runtime and ordinary-exec-error criteria degrade to exec_error — but they carry
  // DIFFERENT proof_skip discriminators, and the genuine failure carries neither.
  assert.equal(runtimeBroken.proof_exec, "exec_error");
  assert.equal(ordinaryExecError.proof_exec, "exec_error");
  assert.equal(genuineFailure.proof_exec, "executed_fail");
  assert.equal(runtimeBroken.proof_skip, "runtime-broken");
  assert.equal(ordinaryExecError.proof_skip, "exec-error");
  assert.notEqual(
    runtimeBroken.proof_skip,
    ordinaryExecError.proof_skip,
    "a review row must be able to tell a real environment fault from THIS task's specific broken-runtime shape",
  );

  // The classification rides the SAME existing projection (cappedReason / capped_reason) the
  // `review.posted` ledger line already carries — no new ledger step, per design (iv)/note.
  const reason = cappedReason([runtimeBroken, ordinaryExecError]);
  assert.match(reason!, /runtime-broken:1/);
  assert.match(reason!, /exec-error:1/);

  const legibility = reviewLedgerLegibilityFields({
    capped: true,
    keywordOnly: false,
    planOnly: false,
    criteria: [runtimeBroken, ordinaryExecError, genuineFailure],
  });
  assert.match(legibility.capped_reason!, /runtime-broken:1/, "the ledger-legibility projection carries the discriminator too");
});
