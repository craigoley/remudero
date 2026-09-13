import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  GREP_PROOF_RE,
  diagnoseUnrunnableProofs,
  refusesToAuthorAClaim,
  renderBodyDefects,
  repairedProofsAreSafeToPush,
  type BodyCriterion,
} from "../src/lib/body-repair.js";

/**
 * W1-T3389 — MEASURED on PR 5108: the first review graded three criteria `not_yet_built`. The fix
 * rung then rewrote the body and the SECOND review graded FOUR criteria `exec_error` — every proof
 * the rung authored failed to execute, one of them `grep: unit test: test/...`, a proof whose
 * pattern is a different dialect's text wearing the `grep:` prefix. The rung already knows how to
 * RUN a proof (`diagnoseBodyDefects`'s own `execProof`, used to settle wrapped-vs-bare grep
 * ambiguity when diagnosing somebody else's body) and never applied that capability to its own
 * output. This file pins the fix: `diagnoseUnrunnableProofs`/`repairedProofsAreSafeToPush` run
 * every proof a repair is about to push and refuse it when one cannot be substantiated.
 */

const CRIT = (proof: string, claim = "c"): BodyCriterion => ({ claim, proof });

test("W1-T3389: GREP_PROOF_RE accepts a well-formed grep: proof and refuses the doubled-dialect shape", () => {
  // The healthy arm — a `grep:` proof that really does carry an `in <path>` clause.
  assert.equal(GREP_PROOF_RE.test("grep: REAL in f.md"), true);
  assert.equal(GREP_PROOF_RE.exec("grep: REAL in f.md")?.[2], "f.md");
  // The unhealthy arm — the exact PR-5108 shape, a second dialect's text with no `in <path>` at all.
  assert.equal(GREP_PROOF_RE.test("grep: unit test: test/the-body-repair-rung-ships-proofs-it-never-ran.test.ts"), false);
  assert.equal(GREP_PROOF_RE.exec("grep: unit test: test/x.test.ts"), null);
});

test("W1-T3389 criterion 1: a doubled-dialect grep: proof (no `in <path>` clause) is never pushed", () => {
  // The EXACT shape measured on PR 5108: a second dialect's text wearing the grep: prefix, so it
  // never had an `in <path>` clause at all — no executor is even needed to catch this.
  const criteria = [CRIT("grep: unit test: test/the-body-repair-rung-ships-proofs-it-never-ran.test.ts")];
  assert.equal(repairedProofsAreSafeToPush(criteria), false);
  const d = diagnoseUnrunnableProofs(criteria);
  assert.equal(d.length, 1);
  assert.equal(d[0].kind, "exec-error");
  assert.equal(d[0].criterion, 1);
  assert.match(d[0].why, /no `in <path>` clause/);
  assert.match(d[0].why, /rmd check-proof refuses it in one call/);
});

test("W1-T3389 criterion 1: a grep: proof that raises exec_error when actually run is never pushed", () => {
  const criteria = [CRIT("grep: SOMETHING in src/does/not/exist.ts")];
  const execProof = () => undefined; // simulates a spawn failure / grep exit 2 — the reviewer's own exec_error
  assert.equal(repairedProofsAreSafeToPush(criteria, { execProof }), false);
  const d = diagnoseUnrunnableProofs(criteria, { execProof });
  assert.equal(d.length, 1);
  assert.equal(d[0].kind, "exec-error");
  assert.equal(d[0].criterion, 1);
  assert.match(d[0].why, /exec_error/);
});

test("W1-T3389: a grep: proof that parses and executes cleanly is safe to push", () => {
  const criteria = [CRIT("grep: REAL in f.md")];
  const execProof = () => ({ hits: 2 });
  assert.equal(repairedProofsAreSafeToPush(criteria, { execProof }), true);
  assert.deepEqual(diagnoseUnrunnableProofs(criteria, { execProof }), []);
});

test("W1-T3389: a grep: proof that executes with zero hits is NOT exec_error — this gate polices execution, not truth", () => {
  const criteria = [CRIT("grep: NOWHERE in f.md")];
  const execProof = () => ({ hits: 0 });
  assert.equal(repairedProofsAreSafeToPush(criteria, { execProof }), true);
  assert.deepEqual(diagnoseUnrunnableProofs(criteria, { execProof }), []);
});

test("W1-T3389: with no execProof, the pure parse-shape defect is still caught — silence otherwise, never a guess", () => {
  const noPathClause = [CRIT("grep: unit test: test/x.test.ts")];
  assert.equal(
    repairedProofsAreSafeToPush(noPathClause),
    false,
    "a structurally unparseable proof needs no executor to refuse",
  );
  const wellFormed = [CRIT("grep: REAL in f.md")];
  assert.equal(
    repairedProofsAreSafeToPush(wellFormed),
    true,
    "whether this genuinely executes cannot be settled without a runner, so it is not flagged",
  );
});

test("W1-T3389: a unit test: proof has no runner in this module and is left undiagnosed, not flagged unsafe", () => {
  const criteria = [CRIT("unit test: test/whatever.test.ts")];
  assert.equal(repairedProofsAreSafeToPush(criteria), true);
  assert.deepEqual(diagnoseUnrunnableProofs(criteria), []);
});

test("W1-T3389 criterion 2: an unrunnable proof is reported as an undiagnosable defect, never a silent replacement", () => {
  const criteria = [CRIT("grep: unit test: test/x.test.ts")];
  const d = diagnoseUnrunnableProofs(criteria);
  assert.equal(
    d[0].repair,
    undefined,
    "this module cannot know what the author meant — it must not invent a replacement proof",
  );
  assert.equal(
    refusesToAuthorAClaim(d, criteria),
    true,
    "no repair here ever equals a claim's text, so the rule-15 boundary holds trivially",
  );
  assert.match(renderBodyDefects(d), /exec-error/, "the escalation an operator reads names the defect kind");
});

test("W1-T3389: every proof in a repaired body is checked, not just the first", () => {
  const criteria = [
    CRIT("grep: REAL in f.md"),
    CRIT("grep: unit test: test/x.test.ts"),
    CRIT("unit test: test/y.test.ts"),
  ];
  const execProof = () => ({ hits: 1 });
  const d = diagnoseUnrunnableProofs(criteria, { execProof });
  assert.equal(d.length, 1);
  assert.equal(d[0].criterion, 2, "the second criterion is the one carrying the doubled dialect");
  assert.equal(repairedProofsAreSafeToPush(criteria, { execProof }), false);
});
