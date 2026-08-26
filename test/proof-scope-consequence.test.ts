import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lintTask, proofScopeViolations } from "../src/lib/task-linter.js";
import { judgeCriterion } from "../src/lib/review.js";
import type { Task } from "../src/lib/plan.js";

/** A minimal, otherwise-clean Task fixture — mirrors lint-proof-scope.test.ts's own helper so
 *  this suite reads consistently with the rest of the linter's tests. */
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

const MIS_DECLARED = task({
  id: "W1-T2287-FIXTURE",
  files: ["src/lib/status-board.ts"],
  acceptance: [
    {
      claim: "a live-status ledger candidate is re-checked against its own current state",
      proof: "unit test: test/status-blockers-live.test.ts",
    },
  ],
});

// ── CLAIM 1: the warning names the grading consequence, not a refusal that
//    does not happen ────────────────────────────────────────────────────────

test("CLAIM 1: the message names the real grading consequence — executed_fail instead of not_yet_built via judgeCriterion", () => {
  const violations = proofScopeViolations(MIS_DECLARED, { moduleExists: () => false });
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /judgeCriterion/);
  assert.match(violations[0]!.message, /not_yet_built/);
  assert.match(violations[0]!.message, /executed_fail/);
  assert.match(violations[0]!.message, /wrong verdict|overrides keyword coverage/);
});

// ── CLAIM 2: the message no longer claims a refusal — that path pushes and
//    flags instead ─────────────────────────────────────────────────────────

test("CLAIM 2: the message does not claim the scope guard refuses a push — it names push-and-flag instead", () => {
  const violations = proofScopeViolations(MIS_DECLARED);
  assert.equal(violations.length, 1);
  const { message } = violations[0]!;
  assert.doesNotMatch(message, /will refuse/i);
  assert.doesNotMatch(message, /refuse a branch touching it/i);
  assert.match(message, /does NOT refuse/);
  assert.match(message, /pushes the branch/);
  assert.match(message, /scope_guard\.overrun/);
});

// ── CLAIM 3: severity escalates to "block" ONLY when the path is absent at
//    head AND the task is dispatchable (verify: auto) ──────────────────────

test("CLAIM 3: severity escalates to block when the proof path is absent at head on a verify:auto task", () => {
  const violations = proofScopeViolations(MIS_DECLARED, { moduleExists: () => false });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.severity, "block");
  const res = lintTask(MIS_DECLARED, { moduleExists: () => false });
  assert.equal(res.ok, false);
});

test("CLAIM 3 (control): absent opts.moduleExists makes no attempt to escalate — stays the plain warn default", () => {
  // No predicate ⇒ no opinion, the same purity contract callSiteViolations' opts.moduleExists
  // already keeps (module comment, W1-T2287). This is the byte-identical pre-existing default.
  const violations = proofScopeViolations(MIS_DECLARED);
  assert.equal(violations[0]!.severity, "warn");
});

// ── CLAIM 4: a mis-declared proof whose test file already EXISTS stays
//    advisory — no currently-dispatchable task is failed by this change ────

test("CLAIM 4: a mis-declared proof whose path already exists at head stays advisory (warn), even on verify:auto", () => {
  const violations = proofScopeViolations(MIS_DECLARED, { moduleExists: () => true });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.severity, "warn");
  const res = lintTask(MIS_DECLARED, { moduleExists: () => true });
  assert.equal(res.ok, true, "an existing-path mis-declaration must never flip lintTask to not-ok");
});

// ── CLAIM 5: a verify:human task is never escalated — it can never reach a
//    review that would grade it wrong in the first place ───────────────────

test("CLAIM 5: a verify:human task is never escalated, even when its proof path is absent at head", () => {
  const humanTask = task({
    ...MIS_DECLARED,
    id: "W1-T2287-HUMAN",
    verify: "human",
  });
  const violations = proofScopeViolations(humanTask, { moduleExists: () => false });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.severity, "warn");
});

// ── CLAIM 6: the declaration (files:) stays in the carve-out predicate — a
//    proof naming a genuinely MISTAKEN path (never declared by anything in
//    this diff) still grades executed_fail, never a false not_yet_built ────

test("CLAIM 6: a mistaken path outside every declared files: still grades executed_fail at review time (the carve-out predicate is untouched)", () => {
  const verdict = judgeCriterion(
    { claim: "some future work is proven", proof: "unit test: test/totally-unrelated-fabricated.test.ts" },
    new Set(),
    undefined,
    // forwardReferenceFiles IS populated (this could be a filing-PR review) but names a
    // DIFFERENT path — the proof under judgment was never declared by anything in this diff,
    // exactly the "mistaken, not merely forward-referenced" case design point 4 distinguishes.
    { cwd: "/nonexistent", exec: () => "fail", forwardReferenceFiles: new Set(["test/filing-forward-reference.test.ts"]) },
  );
  assert.equal(verdict.proof_exec, "executed_fail");
  assert.equal(verdict.met, false);
});

// ── CLAIM 7: a proof naming an EXISTING path that fails still grades as an
//    executed failure — the carve-out never rescues a real failure ─────────

test("CLAIM 7: a proof naming a path that EXISTS at head and fails still grades executed_fail, never not_yet_built", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w2287-existing-fail-"));
  writeFileSync(join(dir, "existing.test.ts"), "// present on disk\n");
  const verdict = judgeCriterion(
    { claim: "the fixture behaves", proof: "unit test: existing.test.ts" },
    new Set(),
    undefined,
    { cwd: dir, exec: () => "fail", forwardReferenceFiles: new Set(["existing.test.ts"]) },
  );
  assert.equal(verdict.proof_exec, "executed_fail");
  assert.notEqual(verdict.proof_exec, "not_yet_built");
});

// ── CLAIM 8: THE FALSIFIER — restoring the old refusal wording turns this
//    file red, proving the check is actually discriminating on the words ───

test("CLAIM 8 (falsifier): the exact old refusal sentence is absent — reintroducing it would fail this assertion", () => {
  const violations = proofScopeViolations(MIS_DECLARED);
  const OLD_WORDING =
    "the scope guard (run-task.ts's scopeGuardOutOfScopeFiles) will refuse a branch touching it, AFTER the work is done";
  assert.doesNotMatch(
    violations[0]!.message,
    new RegExp(OLD_WORDING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});
