import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { writeMutantModule } from "./helpers/mutant-module.js";
import { TRIAGE_PROOF_NEEDLE, mutateTriageProofSource } from "./helpers/triage-proof-needle.js";
import { execWhitelistedProof, parseWhitelistedProof } from "../src/lib/review.js";
import { feedbackEntryRepoPath } from "../src/lib/feedback.js";

// ── W1-T2587: A HAND-ROLLED MUTATION TEST COLLIDES WITH THE REAL HARNESS ───────────────────────
//
// `test/triage-proof-dialect.test.ts`'s W1-T963 mutation check used to `readFileSync`
// `src/lib/triage.ts` and require its OWN `return` STATEMENT text to appear byte-for-byte, once,
// before hand-mutating that literal on disk. Inside Stryker's mutation sandbox that file is
// INSTRUMENTED — every mutable expression, this template literal included, is rewritten into a
// generated conditional (`return cond ? mutant : original;`) — so the exact-statement text is
// gone and the sanity assertion that guarded it aborted the mutation-testing dry run with
// `ConfigError: There were failed tests in the initial test run` (deterministic, not flaky: it
// fires whenever the nightly's rotation reaches `src/lib/triage.ts`).
//
// This file proves the fix in `test/helpers/triage-proof-needle.ts` on a SIMULATED instrumented
// copy — a `.instrumented-mimic` we build ourselves rather than depending on Stryker being
// installed and its exact wrapper shape — against the two things the task requires:
//
//   1. the assertion SURVIVES an instrumented copy (no more `ConfigError` on the dry run), and
//   2. the guard is NOT disabled inside the sandbox: it still MUTATES the instrumented copy and
//      the mutation still gets CAUGHT (base and head stop discriminating), so `triage.ts` keeps
//      its mutation coverage instead of trading a red nightly for a silent hole.
//
// The mimic wraps ONLY the discriminating expression in a self-contained ternary that always
// selects the "original" branch — `(() => false)() ? \`\` : <expression>` — which is precisely
// the SHAPE Stryker's instrumenter produces (`cond ? mutant : original`) without requiring the
// real `@stryker-mutator/core` runtime helpers to be present. Critically, this wrapping makes the
// OLD needle (the full `"  return \`...\`;\n"` statement) NOT MATCH, which is exactly the failure
// this task fixes — see the assertion below that pins that down, so this test cannot pass
// vacuously against a mimic that happens not to exercise the regression.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const triageTsPath = join(repoRoot, "src", "lib", "triage.ts");

/** The statement-shaped needle the OLD, now-removed check searched for. */
const OLD_STATEMENT_NEEDLE = `  return ${TRIAGE_PROOF_NEEDLE};\n`;

/** Build a source string that mimics an instrumented copy of `src/lib/triage.ts`. */
function buildInstrumentedMimic(source: string): string {
  const occurrences = source.split(TRIAGE_PROOF_NEEDLE).length - 1;
  assert.equal(occurrences, 1, "setup sanity: the real file must contain the needle exactly once");
  return source.replace(TRIAGE_PROOF_NEEDLE, `(() => false)() ? \`\` : ${TRIAGE_PROOF_NEEDLE}`);
}

function writeFeedbackEntry(root: string, relPath: string, status: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `id: x\nstatus: ${status}\nproposal_pr: null\n`);
}

test("W1-T2587: the mimic actually reproduces the regression — the OLD statement needle stops matching", () => {
  const original = readFileSync(triageTsPath, "utf8");
  assert.equal(
    original.split(OLD_STATEMENT_NEEDLE).length - 1,
    1,
    "setup sanity: the OLD needle must match the real, uninstrumented file once",
  );
  const instrumented = buildInstrumentedMimic(original);
  assert.equal(
    instrumented.split(OLD_STATEMENT_NEEDLE).length - 1,
    0,
    "the whole point of the mimic: wrapping the expression must break the OLD full-statement needle " +
      "— if this were not zero, the mimic would not exercise the ConfigError this task fixes",
  );
});

test("W1-T2587: the assertion survives an instrumented copy — the dry run no longer aborts", () => {
  const original = readFileSync(triageTsPath, "utf8");
  const instrumented = buildInstrumentedMimic(original);

  // This is the exact shape of `test/triage-proof-dialect.test.ts`'s sanity assertion, run against
  // the INSTRUMENTED mimic instead of the plain file. Under the OLD (statement-literal) needle this
  // would be 0, throwing `AssertionError [ERR_ASSERTION]: 0 !== 1` — the dry-run-aborting failure
  // this task fixes. Under the NEW (expression-only) needle it is 1.
  const { matchCount } = mutateTriageProofSource(instrumented);
  assert.equal(matchCount, 1, "the needle must survive being wrapped by instrumentation");
});

test("W1-T2587: the guard is not disabled inside the sandbox — an unmutated instrumented copy still discriminates", async () => {
  // A CONTROL: instrumentation alone (no logic mutation) must not change behaviour. If this failed,
  // "the guard survives" would be meaningless — it would just mean nothing is being checked anymore.
  const original = readFileSync(triageTsPath, "utf8");
  const instrumented = buildInstrumentedMimic(original);
  const instrumentedPath = writeMutantModule("triage.ts", instrumented);
  const instrumentedModule = (await import(instrumentedPath)) as typeof import("../src/lib/triage.js");

  const feedbackId = "fb-1784766956423-6635d1";
  const relPath = feedbackEntryRepoPath(feedbackId);
  const baseDir = mkdtempSync(join(tmpdir(), "rmd-w1-t2587-instr-base-"));
  const headDir = mkdtempSync(join(tmpdir(), "rmd-w1-t2587-instr-head-"));
  try {
    writeFeedbackEntry(baseDir, relPath, "new");
    writeFeedbackEntry(headDir, relPath, "rejected");

    const proof = parseWhitelistedProof(instrumentedModule.triageAcceptanceProof(feedbackId, "rejected"));
    assert.ok(proof, "the instrumented-but-unmutated module must still emit a parseable proof");
    assert.equal(execWhitelistedProof(proof!, headDir), "pass", "instrumentation alone must not break the head match");
    assert.equal(execWhitelistedProof(proof!, baseDir), "fail", "instrumentation alone must not break the base refusal");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(headDir, { recursive: true, force: true });
  }
});

test("W1-T2587: the guard is not disabled inside the sandbox — the mutation is still caught on an instrumented copy", async () => {
  // THE ACTUAL COVERAGE CLAIM: apply the SAME destination-state-removing mutation that
  // `test/triage-proof-dialect.test.ts`'s W1-T963 test applies, but to the INSTRUMENTED mimic
  // rather than the plain file, and require the SAME failure signature — the mutant's proof
  // matches the base fixture too, which is precisely the defect the guard exists to catch. If this
  // guard were silently skipped/disabled under instrumentation instead of merely surviving it,
  // `src/lib/triage.ts` would lose its mutation coverage the moment the nightly's rotation reaches
  // it, even after this fix — a quiet hole standing in for the red nightly.
  const original = readFileSync(triageTsPath, "utf8");
  const instrumented = buildInstrumentedMimic(original);

  const { matchCount, mutated } = mutateTriageProofSource(instrumented);
  assert.equal(matchCount, 1, "sanity: the needle must be found exactly once in the instrumented mimic");
  assert.notEqual(mutated, instrumented, "the mutation must actually change the instrumented source");

  const mutantPath = writeMutantModule("triage.ts", mutated);
  const mutant = (await import(mutantPath)) as typeof import("../src/lib/triage.js");

  const feedbackId = "fb-1784766956423-6635d1";
  const relPath = feedbackEntryRepoPath(feedbackId);
  const baseDir = mkdtempSync(join(tmpdir(), "rmd-w1-t2587-mut-base-"));
  const headDir = mkdtempSync(join(tmpdir(), "rmd-w1-t2587-mut-head-"));
  try {
    writeFeedbackEntry(baseDir, relPath, "new");
    writeFeedbackEntry(headDir, relPath, "rejected");

    const mutantProof = parseWhitelistedProof(mutant.triageAcceptanceProof(feedbackId, "rejected"));
    assert.ok(mutantProof, "sanity: the mutant's proof must still parse");
    assert.equal(execWhitelistedProof(mutantProof!, headDir), "pass", "the mutant is not simply broken: still matches at head");
    assert.equal(
      execWhitelistedProof(mutantProof!, baseDir),
      "pass",
      "THE DEFECT the guard exists to catch: with no destination-state interpolation the pattern is " +
        "the always-present bare `status:`, matching the merge base too — the guard must still see this " +
        "on an instrumented copy, or `triage.ts` silently loses its mutation coverage under the sandbox",
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(headDir, { recursive: true, force: true });
  }
});
