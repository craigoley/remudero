/**
 * W1-T3232 — the forward-reference carve-out asks the same question of the head in both dialects.
 *
 * `judgeCriterion` decided "forward reference, or missing work?" twice — once per dialect — and
 * only one arm asked what kind of PR this is. W1-T456 built it for `unit test:` with four
 * conditions. W1-T2737 built the same carve-out for `grep:` and gave it a FIFTH,
 * `planOnlyDiff === true`, whose own comment calls it "the filing-scope half". The `unit test:`
 * arm never got it.
 *
 * MEASURED on #4770 (2026-09-09): W1-T2925 declared `test/measurement-cadence-delta.test.ts` and
 * proved a criterion with it; the implementation put the behaviour in a differently-named file and
 * never created the declared one. The mechanical gate PASSED — "a forward reference to work not
 * yet built ... keyword floor applied" — and only the LLM reviewer's semantic downgrade caught it.
 *
 * OPERATOR RULING 2026-09-09. W1-T2737 never argued this arm should fire on a build head: its
 * criterion 5 pinned byte-identical grading as a COMPATIBILITY guarantee while extending the
 * carve-out to `grep:`, and its design (iv) states this task's intent — "A BUILT TASK IS
 * UNAFFECTED ... this only reaches the case where the target path is declared-but-unwritten in the
 * same diff." Its contradicting assertion is FLIPPED in place, not deleted, in
 * test/two-gates-demand-opposite-proof-dialects-for-a-new-module.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { judgeCriterion } from "../src/lib/review.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const DECLARED = "test/a-suite-this-diff-declares-but-never-wrote.test.ts";

/** Grade one `unit test:` proof naming DECLARED, against a head that does not contain it. */
function gradeDeclaredAbsent(planOnlyDiff: boolean) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fwd-ref-`));
  try {
    return judgeCriterion(
      { claim: "the declared suite proves it", proof: `unit test: ${DECLARED}` },
      new Set(),
      undefined,
      { cwd: dir, forwardReferenceFiles: new Set([DECLARED]), planOnlyDiff },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("W1-T3232: an implementation head does not get the forward-reference carve-out", () => {
  const v = gradeDeclaredAbsent(false);

  // On a head that changes source, a declared-but-absent test file is work the PR claimed and did
  // not build. Excusing it is what let #4770 through the mechanical gate.
  assert.equal(v.proof_exec, "executed_fail");
  assert.notEqual(v.proof_exec, "not_yet_built", "the carve-out must not fire on a build head");
  assert.equal(v.proof_skip, undefined, "nothing was skipped — the proof ran and did not pass");
  assert.equal(v.met, false, "executed_fail overrides any keyword coverage");
});

test("W1-T3232: a plan-only head still gets the forward-reference carve-out", () => {
  const v = gradeDeclaredAbsent(true);

  // This is the half W1-T456 exists for and it must be untouched: on a FILING PR the declared test
  // genuinely does not exist yet, and grading it executed_fail made the filing unrepairable.
  assert.equal(v.proof_exec, "not_yet_built");
  assert.equal(v.proof_skip, "forward-reference");
  assert.match(v.reason, /forward reference to work not yet built/);
});

test("W1-T3232: the two cases differ ONLY in the head shape, so the head is provably what decides", () => {
  // Same proof, same declared set, same absent file, same everything but planOnlyDiff. If the two
  // verdicts agreed, this file would prove nothing about which input is load-bearing.
  const filing = gradeDeclaredAbsent(true);
  const build = gradeDeclaredAbsent(false);
  assert.notEqual(filing.proof_exec, build.proof_exec);
  assert.equal(filing.proof_exec, "not_yet_built");
  assert.equal(build.proof_exec, "executed_fail");
});

test("W1-T3232: an UNDECLARED absent path still fails on BOTH heads — the carve-out was never a hole", () => {
  // W1-T456's own line: "NEVER assigned when the named path is simply absent and UNDECLARED".
  // A typo'd path is an authoring error on a filing PR too, and this ruling does not widen that.
  for (const planOnly of [true, false]) {
    const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fwd-ref-undecl-`));
    try {
      const v = judgeCriterion(
        { claim: "a suite no shard declares", proof: "unit test: test/nothing-declares-this.test.ts" },
        new Set(),
        undefined,
        { cwd: dir, forwardReferenceFiles: new Set([DECLARED]), planOnlyDiff: planOnly },
      );
      assert.equal(v.proof_exec, "executed_fail", `undeclared path on planOnlyDiff=${planOnly}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
