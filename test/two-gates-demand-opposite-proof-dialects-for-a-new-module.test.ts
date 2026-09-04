// test/two-gates-demand-opposite-proof-dialects-for-a-new-module.test.ts — W1-T2737.
//
// TWO GATES ASK FOR OPPOSITE THINGS ON A FILING THAT CREATES A MODULE, and the one that
// PRESCRIBES the remedy is the one whose remedy fails the PR.
//
//   `callSiteViolations` (src/lib/task-linter.ts) — for a task whose `files:` create a `src/`
//   module, demands a criterion of the form `grep: <symbol>( in <the file that calls it>`, in
//   those words. It is the only dialect that can express "a DIFFERENT file calls this symbol".
//
//   `judgeCriterion` (src/lib/review.ts) — EXECUTES that grep at review time. On a filing the
//   symbol does not exist yet, so it grades `executed_fail`, which by its own text "overrides
//   any keyword coverage" and fails the PR.
//
// W1-T456 built `not_yet_built` for exactly this situation one dialect over, and scoped it to
// `whitelisted.kind === "test"`. This suite extends the SAME carve-out to the mandated dialect,
// and pins the three things that must NOT change with it.
//
// MEASURED COST, not hypothesised: W1-T2716 (MERGED) carries a 25-line comment in its own
// `acceptance:` block recording that `grep: hashInstallInputs( in src/lib/worker.ts` read
// `executed_fail` while its six sibling proofs read `not_yet_built`, that the one proof failed
// the PR alone, and that the author dropped the call-site criterion to merge — losing the only
// criterion proving the module is wired, which is the unwired-instrument class W1-T2732 counted
// four of.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { judgeCriterion } from "../src/lib/review.js";

const CONSUMER = "src/lib/worker.ts";
const NEW_MODULE = "src/lib/install-inputs.ts";
const CALL_SITE_PROOF = `grep: hashInstallInputs( in ${CONSUMER}`;

/** A head checkout whose consumer file contains `body`. */
function headWith(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t2737-head-"));
  mkdirSync(join(dir, "src", "lib"), { recursive: true });
  writeFileSync(join(dir, CONSUMER), body);
  return dir;
}

/** Grade one criterion against a head checkout. `declared` is the shard's own `files:`. */
function grade(
  proof: string,
  cwd: string,
  declared: readonly string[],
  planOnlyDiff: boolean,
): { proof_exec: string; met: boolean; reason: string } {
  const v = judgeCriterion(
    { claim: "the production worker path calls the shared install-input identity helper", proof },
    new Set<string>(["the", "production", "worker", "path", "calls", "shared", "install", "input"]),
    undefined,
    { cwd, forwardReferenceFiles: new Set(declared), planOnlyDiff },
  ) as unknown as { proof_exec: string; met: boolean; reason: string };
  return v;
}

// The wiring the filing promises but has not written: the consumer exists and does not call it.
const UNWIRED = "export async function runWorker(): Promise<void> {\n  return;\n}\n";
const WIRED = "import { hashInstallInputs } from './install-inputs.js';\nexport async function runWorker() {\n  return hashInstallInputs('x');\n}\n";

test("W1-T2737 a declared path whose symbol is absent grades not_yet_built, not executed_fail", () => {
  const v = grade(CALL_SITE_PROOF, headWith(UNWIRED), [NEW_MODULE, CONSUMER], true);
  assert.equal(v.proof_exec, "not_yet_built", "the mandated call-site proof must not fail a filing");
  assert.match(v.reason, /forward reference/i);
  assert.match(v.reason, /keyword floor applied/);
});

test("W1-T2737 an UNDECLARED path still grades executed_fail, so the carve-out is not a hole", () => {
  // W1-T456's own line, kept verbatim for the new dialect: "NEVER assigned when the named path is
  // simply absent and UNDECLARED". A grep at a file no shard in the diff claims is an authoring
  // error and must keep blocking.
  const v = grade(CALL_SITE_PROOF, headWith(UNWIRED), [NEW_MODULE], true);
  assert.equal(v.proof_exec, "executed_fail", "an undeclared target keeps blocking");
  assert.equal(v.met, false);
  assert.match(v.reason, /overrides any keyword coverage/);
});

test("W1-T2737 a symbol PRESENT on the head still executes and passes on its merits", () => {
  // (iv) A BUILT TASK IS UNAFFECTED. The carve-out is reached only after the executor reports a
  // failure, so a grep that can pass is never intercepted.
  const v = grade(CALL_SITE_PROOF, headWith(WIRED), [NEW_MODULE, CONSUMER], true);
  assert.equal(v.proof_exec, "executed_pass");
  assert.equal(v.met, true);
  assert.match(v.reason, /PASSED on the PR head/);
});

test("W1-T2737 a BUILD PR keeps failing on unwired code — the carve-out is filing-only", () => {
  // THE HOLE THE `files:` TEST ALONE WOULD LEAVE, and the reason this gate is not just the
  // declaration check. `forwardReferenceFiles` is the union of the diff's own shard `files:` AND a
  // resolved task's declared `files:`, so on the BUILD PR the consumer path is declared too. The
  // `unit test:` carve-out is filing-scoped by accident of `!existsSync` — the suite exists once
  // built. A call-site grep has no such tell: the consumer file exists in both worlds. Without the
  // plan-only gate this carve-out would excuse exactly the unwired-instrument class it is meant to
  // keep catchable.
  const v = grade(CALL_SITE_PROOF, headWith(UNWIRED), [NEW_MODULE, CONSUMER], false);
  assert.equal(v.proof_exec, "executed_fail", "a diff carrying source must still prove its wiring");
  assert.equal(v.met, false);
});

test("W1-T2737 the PR #3733 shape: the prescribed criterion no longer fails the filing", () => {
  // The measured conflict, both directions on one shard. With the call-site criterion the review
  // posted FAILURE and lint-plan reported the call-site warning ZERO times; carried as a
  // `unit test:` proof the review passed and the warning appeared ONCE. Both criteria are graded
  // here against the same filing-shaped head.
  const head = headWith(UNWIRED);
  const declared = [NEW_MODULE, CONSUMER, "test/the-deferred-drift-ruling-leaves-a-measured-defect-with-no-owner.test.ts"];
  const asGrep = grade(CALL_SITE_PROOF, head, declared, true);
  const asTest = grade(
    "unit test: test/the-deferred-drift-ruling-leaves-a-measured-defect-with-no-owner.test.ts",
    head,
    declared,
    true,
  );
  assert.equal(asTest.proof_exec, "not_yet_built", "the sibling dialect graded this way all along");
  assert.equal(asGrep.proof_exec, asTest.proof_exec, "the two gates can now be satisfied at once");
});

test("W1-T2737 unit test: grading is unchanged — W1-T456 is extended, never rewritten", () => {
  const head = headWith(UNWIRED);
  // Declared and absent ⇒ carved out, exactly as before.
  const declared = grade("unit test: test/some-declared-suite.test.ts", head, ["test/some-declared-suite.test.ts"], true);
  assert.equal(declared.proof_exec, "not_yet_built");
  // Absent and UNDECLARED ⇒ still a failure, exactly as before.
  const undeclared = grade("unit test: test/some-other-suite.test.ts", head, ["test/some-declared-suite.test.ts"], true);
  assert.equal(undeclared.proof_exec, "executed_fail");
  // And the plan-only gate is grep-only: a declared-but-absent suite on a BUILD PR keeps the
  // W1-T456 behaviour byte for byte, because `!existsSync` already scopes it.
  const onBuild = grade("unit test: test/some-declared-suite.test.ts", head, ["test/some-declared-suite.test.ts"], false);
  assert.equal(onBuild.proof_exec, "not_yet_built", "the unit test: arm must not acquire a plan-only condition");
});

test("W1-T2737 the carve-out reads the house dialect only, never author-selected argv", () => {
  // `parseDialectGrep` compiles to a fixed `["-arn", "--", pattern, path]` argv — BRE, no engine
  // choice. The LEGACY fenced form passes the author's own argv through, so its target is not
  // reliably the last element and `proofEngineDivergenceViolations` already flags it as
  // engine-ambiguous. Carving that shape out would be guessing at a path.
  const head = headWith(UNWIRED);
  const fenced = grade("`grep -rn hashInstallInputs( src/lib/worker.ts`", head, [NEW_MODULE, CONSUMER], true);
  assert.notEqual(fenced.proof_exec, "not_yet_built", "a fenced author-argv grep takes no carve-out");
});
