import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import {
  applyVerdictStability,
  auditMergedTaskClaims,
  decideArmFromLedgerVerdict,
  decideAutoMergeArm,
  judgeCriterion,
  judgeReview,
  narrowNameFilteredArgs,
  parseWhitelistedProof,
  priorReviewVerdictFromLedger,
  reviewLedgerLegibilityFields,
  type PriorReviewVerdict,
  type ProofExecutor,
  type ReviewVerdict,
} from "../src/lib/review.js";

// ── W1-T305 ──────────────────────────────────────────────────────────────────
//
// MEASURED 2026-08-03 over `review.posted` in state/ledger.ndjson unioned with all 664
// rotations, deduped by head_sha: of 821 distinct CODE review heads, 418 (50.9%) executed
// ZERO proofs, and 322 of those posted `state: success` anyway — the vast majority certified
// by the keyword-coverage floor alone, which this codebase's own comments already call "a
// claim, never evidence". Every one of the 1,157 proof markers inside those 418 zero-executed
// heads landed as the SAME `not_executable` marker, indistinguishable from the outside whether
// the proof was ordinary prose (expected), a malformed dialect body (an authoring error), or a
// paraphrase that legitimately named no test. A separate 52 heads executed SOME but not ALL of
// their proofs and posted identically to a fully-certified pass.
//
// These three acceptance criteria make that silence loud, without tightening the floor itself
// (design (3) — that is an explicit, separate, ratified decision, out of scope here):
//   1. a proof that fails to PARSE as a dialect (an authoring error) is reported distinctly from
//      one that parses but resolves to no candidate.
//   2. the verdict AND the ledger row both carry the unexecutable count and the offending proof
//      text.
//   3. a partially-executed proof set reads differently, on the posted verdict, than a fully-
//      executed one.

const FAKE_HEAD = "/fake/head/checkout";

// ── Acceptance 1: a proof that fails to parse as a dialect is an AUTHORING ERROR, ──
// distinct from a proof that parses but resolves to no candidate, and distinct from
// ordinary prose that never claimed to be mechanical at all.

test("judgeCriterion: a grep: proof with NO `in <path>` clause is a DIALECT-PARSE-ERROR (authoring error), not the same bucket as free prose", () => {
  const criterion = { claim: "TODOs are gone", proof: "grep: TODO" }; // dialect label, but no target
  const v = judgeCriterion(criterion, new Set(["todos", "gone"]), undefined, { cwd: FAKE_HEAD });
  assert.equal(v.proof_exec, "not_executable");
  assert.equal(v.proof_skip, "dialect-parse-error");
  assert.match(v.reason, /authoring error/i);
  assert.match(v.reason, /dialect prefix/i);
});

test("judgeCriterion: a unit test:/grep: proof refused for PATH TRAVERSAL is ALSO a dialect-parse-error (an authoring error), never no-dialect", () => {
  const criterion = { claim: "traversal is refused", proof: "grep: secret in ../../etc/passwd" };
  const v = judgeCriterion(criterion, new Set(["traversal", "refused"]), undefined, { cwd: FAKE_HEAD });
  assert.equal(v.proof_exec, "not_executable");
  assert.equal(v.proof_skip, "dialect-parse-error");
  assert.notEqual(v.proof_skip, "no-dialect");
});

test("judgeCriterion: ordinary PROSE (no dialect label at all) stays no-dialect and is NEVER called an authoring error", () => {
  const criterion = { claim: "the widget is frobnicated", proof: "the widget frobnicates on load" };
  const v = judgeCriterion(criterion, new Set(["widget", "frobnicates", "load"]), undefined, { cwd: FAKE_HEAD });
  assert.equal(v.proof_exec, "not_executable");
  assert.equal(v.proof_skip, "no-dialect");
  assert.doesNotMatch(v.reason, /authoring error/i);
});

test("judgeCriterion: a proof that PARSES (unit test:) and resolves to zero candidates is prose-no-match — a THIRD, distinct bucket from both dialect-parse-error and no-dialect", () => {
  const criterion = {
    claim: "the widget renders densely",
    proof: "unit test: the widget renders densely, that is, above the fold",
  };
  const exec: ProofExecutor = () => "no-match";
  const v = judgeCriterion(criterion, new Set(["widget", "renders", "densely", "above", "fold"]), undefined, {
    cwd: FAKE_HEAD,
    exec,
  });
  assert.equal(v.proof_skip, "prose-no-match");
  assert.notEqual(v.proof_skip, "dialect-parse-error");
  assert.notEqual(v.proof_skip, "no-dialect");
});

test("a demonstration: proof is deliberately unexecutable BY DESIGN (W1-T277) and must never be reported as a dialect-parse-error authoring mistake", () => {
  const criterion = { claim: "an operator ran the demo", proof: "demonstration: click the button and observe the toast" };
  const v = judgeCriterion(criterion, new Set(["operator", "ran", "demo"]), undefined, { cwd: FAKE_HEAD });
  assert.equal(v.proof_exec, "not_executable");
  assert.equal(v.proof_skip, "no-dialect");
  assert.doesNotMatch(v.reason, /authoring error/i);
});

test("ACCEPTANCE 1 (end to end): auditMergedTaskClaims now reports a MALFORMED dialect proof from a merged task as a FINDING (an authoring error), never silently folded into the 'uncheckable' bucket alongside real prose", () => {
  const tasks = [
    {
      id: "T-malformed",
      acceptance: [{ claim: "TODOs are gone", proof: "grep: TODO" }], // dialect label, no `in <path>` — refused
    },
    {
      id: "T-prose",
      acceptance: [{ claim: "the widget is frobnicated", proof: "the widget frobnicates on load" }], // true prose
    },
  ];
  const exec: ProofExecutor = () => {
    throw new Error("neither a malformed dialect proof nor a prose proof should ever reach the executor");
  };
  const report = auditMergedTaskClaims(tasks, "/tmp/does-not-matter", exec);

  // The malformed dialect proof is now a FINDING (broken, distinct from prose) —
  // pre-W1-T305 this was misreported identically to the prose criterion below.
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].taskId, "T-malformed");
  assert.match(report.findings[0].reason, /authoring error/i);

  // The true prose criterion is still, correctly, uncheckable — never a finding.
  assert.equal(report.uncheckable.length, 1);
  assert.equal(report.uncheckable[0].taskId, "T-prose");
});

// ── Acceptance 2: the verdict AND the ledger row both carry the unexecutable count ──
// and the offending proof text.

test("ACCEPTANCE 2: judgeReview's verdict carries the unexecutable COUNT and the exact OFFENDING PROOF TEXT", () => {
  const criteria: AcceptanceCriterion[] = [
    { claim: "a", proof: "grep: TODO" }, // dialect-parse-error
    { claim: "b", proof: "the widget frobnicates on load" }, // no-dialect
    { claim: "c", proof: "grep: alpha in src/lib/a.ts" }, // executes cleanly
  ];
  const alwaysPass: ProofExecutor = () => "pass";
  const v = judgeReview(criteria, {
    diff: "",
    report: "REPORT — a: TODO. b: the widget frobnicates on load. c: alpha. Done.",
    headCheckoutDir: FAKE_HEAD,
    execProof: alwaysPass,
  });
  assert.equal(v.unexecutableCount, 2, "exactly the two not_executable criteria are counted");
  assert.deepEqual(
    v.unexecutableProofs,
    ["grep: TODO", "the widget frobnicates on load"],
    "the offending proof TEXT is carried verbatim, in criteria order",
  );
});

test("ACCEPTANCE 2: the review.posted ledger row (reviewLedgerLegibilityFields) carries the SAME count and proof text the verdict does — never a hand-copied, driftable projection", () => {
  const criteria: AcceptanceCriterion[] = [{ claim: "a", proof: "grep: TODO" }];
  const v = judgeReview(criteria, { diff: "", report: "unrelated", headCheckoutDir: FAKE_HEAD });
  const ledgerFields = reviewLedgerLegibilityFields(v);
  assert.equal(ledgerFields.unexecutable_count, v.unexecutableCount);
  assert.deepEqual(ledgerFields.unexecutable_proofs, v.unexecutableProofs);
  assert.deepEqual(ledgerFields.unexecutable_proofs, ["grep: TODO"]);
});

test("ACCEPTANCE 2: a HEALTHY, fully-executed review carries unexecutable_count 0 and an empty proofs array — never absent (0/[] is the byte-identical baseline for every green review)", () => {
  const criteria: AcceptanceCriterion[] = [{ claim: "a", proof: "grep: alpha in src/lib/a.ts" }];
  const v = judgeReview(criteria, {
    diff: "",
    report: "unrelated",
    headCheckoutDir: FAKE_HEAD,
    execProof: () => "pass",
  });
  assert.equal(v.unexecutableCount, 0);
  assert.deepEqual(v.unexecutableProofs, []);
  const ledgerFields = reviewLedgerLegibilityFields(v);
  assert.equal(ledgerFields.unexecutable_count, 0);
  assert.deepEqual(ledgerFields.unexecutable_proofs, []);
});

test("ACCEPTANCE 2: a HOLDOUT criterion's unexecutable proof counts toward unexecutableCount (an aggregate number, never secret) but its TEXT never appears in unexecutableProofs — holdout content stays worker-invisible (W1-T166), exactly like unmet_criteria/reasons already do", () => {
  const criteria: AcceptanceCriterion[] = [
    { claim: "visible one", proof: "the visible claim is prose and never executes" },
    { claim: "secret one", proof: "the holdout claim is ALSO prose and never executes", holdout: true },
  ];
  const v = judgeReview(criteria, { diff: "", report: "unrelated", headCheckoutDir: FAKE_HEAD });
  assert.equal(v.unexecutableCount, 2, "both criteria (visible + holdout) are counted");
  assert.deepEqual(
    v.unexecutableProofs,
    ["the visible claim is prose and never executes"],
    "only the VISIBLE criterion's proof text is exposed",
  );
});

// ── Acceptance 3: a partially-executed proof set is distinguishable from a ──
// fully-executed one in the posted verdict.

const ALPHA_PROOF = "grep: alpha in src/lib/a.ts";
const BETA_PROSE_PROOF = "the widget frobnicates on load";
// Substantiates BOTH criteria's keyword floors (echoes alpha's own "grep"/"alpha" tokens and
// beta's proof verbatim) so `state` is "success" whether or not alpha's proof actually executes —
// the fixture below is reused across the executed and zero-executed contrast, and only the
// EXECUTION context should differ between them, never the keyword-floor outcome.
const PARTIAL_REPORT = `REPORT — grep alpha check confirmed. ${BETA_PROSE_PROOF} confirmed. Done.`;

function partialCriteria(): AcceptanceCriterion[] {
  return [
    { claim: "alpha", proof: ALPHA_PROOF },
    { claim: "beta", proof: BETA_PROSE_PROOF },
  ];
}

test("ACCEPTANCE 3: a review that executed SOME but not ALL of its proofs is flagged partiallyExecuted and its posted summary names the fraction — never rendered identically to a fully-observed PASS", () => {
  const v = judgeReview(partialCriteria(), {
    diff: "",
    report: PARTIAL_REPORT,
    headCheckoutDir: FAKE_HEAD,
    execProof: () => "pass", // only alpha's dialect proof can ever execute; beta is plain prose
  });
  assert.equal(v.state, "success");
  assert.equal(v.capped, false, "SOMETHING executed — this is not the zero-executed capped shape");
  assert.equal(v.partiallyExecuted, true);
  assert.equal(v.executedProofCount, 1);
  assert.equal(v.executableProofCount, 2);
  assert.match(v.summary, /PARTIAL: 1\/2/, "the posted verdict names the executed/executable fraction");
  assert.doesNotMatch(v.summary, /CAPPED/);
});

test("ACCEPTANCE 3 (contrast): a FULLY-executed review (every executable criterion ran) is NOT flagged partial, and its summary carries no PARTIAL tag", () => {
  // BOTH proofs are dialect-prefixed here (unlike partialCriteria()'s prose `beta`), so nothing
  // is left unexecuted.
  const bothExecutable: AcceptanceCriterion[] = [
    { claim: "alpha", proof: ALPHA_PROOF },
    { claim: "beta", proof: "grep: beta in src/lib/b.ts" },
  ];
  const fully = judgeReview(bothExecutable, {
    diff: "",
    report: "unrelated",
    headCheckoutDir: FAKE_HEAD,
    execProof: () => "pass",
  });
  assert.equal(fully.partiallyExecuted, false);
  assert.equal(fully.executedProofCount, 2);
  assert.equal(fully.executableProofCount, 2);
  assert.doesNotMatch(fully.summary, /PARTIAL/);
});

test("ACCEPTANCE 3 (contrast): a ZERO-executed review takes the CAPPED shape, not partiallyExecuted — the two must never be conflated", () => {
  const v = judgeReview(partialCriteria(), { diff: "", report: PARTIAL_REPORT }); // no headCheckoutDir at all
  assert.equal(v.capped, true);
  assert.equal(v.partiallyExecuted, false, "capped (zero executed) is a DIFFERENT class from partial (some executed)");
  assert.match(v.summary, /CAPPED/);
  assert.doesNotMatch(v.summary, /PARTIAL/);
});

test("ACCEPTANCE 3: the PARTIAL tag survives verdict-stability suppression — a re-review of an unchanged, floor-passing head keeps naming the same fraction, never silently reverting to an unqualified PASS", () => {
  const computed: ReviewVerdict = {
    state: "failure", // a semantic-only downgrade on an unchanged, floor-passing head
    criteria: [
      { claim: "alpha", proof: ALPHA_PROOF, met: true, reason: "proof executed and PASSED", proof_exec: "executed_pass", floorMet: true },
      {
        claim: "beta",
        proof: BETA_PROSE_PROOF,
        met: false,
        reason: "reviewer judged the proof non-responsive (semantic downgrade)",
        proof_exec: "not_executable",
        proof_skip: "no-dialect",
        floorMet: true,
      },
    ],
    testTheater: false,
    summary: "remudero-review: FAIL — beta unmet",
    floorDegraded: false,
    floorState: "success",
    capped: false,
    keywordOnly: false,
    planOnly: false,
    partiallyExecuted: true,
    executedProofCount: 1,
    executableProofCount: 2,
  };
  const prior: PriorReviewVerdict = { headSha: "abc1234", state: "success", capped: false, planOnly: false };
  const result = applyVerdictStability(computed, "abc1234", prior);
  assert.equal(result.suppressed, true);
  assert.equal(result.verdict.state, "success");
  assert.match(result.verdict.summary, /PARTIAL: 1\/2/);
});

// ── W1-T1020 ─────────────────────────────────────────────────────────────────────────────────
//
// W1-T305 (above) made the reviewer WRITE DOWN that a PASS was only partially executed, at three
// levels of detail: per criterion (`ProofSkipReason`), rolled up (`partiallyExecuted` +
// `executedProofCount`/`executableProofCount`), and posted (`passSummary`'s "PARTIAL: X/Y" tag).
// Nothing downstream READ any of it: `decideAutoMergeArm`'s uncapped branch unconditionally
// returned `reason: "verdict is a full PASS"` — true of a review that observed every criterion,
// false of one that observed 1 of 13 — and `priorReviewVerdictFromLedger` reconstructed the
// ledger-fed path's verdict WITHOUT the recorded `partially_executed` boolean, so the sweep and
// triage arm paths never even had the fact in hand. These four tests prove that gap is closed
// WITHOUT turning legibility into a new refusal — the `arm` value is unchanged in every case.

const PARTIAL_VERDICT_FOR_ARM: Pick<ReviewVerdict, "state" | "capped" | "planOnly"> &
  Pick<ReviewVerdict, "partiallyExecuted" | "executedProofCount" | "executableProofCount"> = {
  state: "success",
  capped: false,
  planOnly: false,
  partiallyExecuted: true,
  executedProofCount: 1,
  executableProofCount: 2,
};

test("W1-T1020: a partial verdict arms with a reason that names the partial shape", () => {
  const decision = decideAutoMergeArm(PARTIAL_VERDICT_FOR_ARM, false);
  assert.match(decision.reason, /PARTIAL/, "the reason must name the partial shape");
  assert.match(decision.reason, /1\/2/, "the fraction is named when the caller's verdict carries the counts");
  assert.notEqual(
    decision.reason,
    "verdict is a full PASS",
    "a verdict the same review labelled PARTIAL must never record the FULL-PASS reason",
  );
});

test("W1-T1020: a partial verdict still arms", () => {
  const decision = decideAutoMergeArm(PARTIAL_VERDICT_FOR_ARM, false);
  assert.equal(decision.arm, true, "legibility must never become a new refusal (design (ii))");
});

test("W1-T1020: a fully executed pass keeps its reason unchanged", () => {
  // Every executable criterion executed — `partiallyExecuted` is false, exactly the shape
  // `judgeReview` computes for a healthy review. The negative control from design (v): without
  // it, a change that also rewrote the ordinary path's reason string would pass just as well.
  const fullyExecuted: Pick<ReviewVerdict, "state" | "capped" | "planOnly"> &
    Pick<ReviewVerdict, "partiallyExecuted" | "executedProofCount" | "executableProofCount"> = {
    state: "success",
    capped: false,
    planOnly: false,
    partiallyExecuted: false,
    executedProofCount: 2,
    executableProofCount: 2,
  };
  const decision = decideAutoMergeArm(fullyExecuted, false);
  assert.equal(decision.arm, true);
  assert.equal(decision.reason, "verdict is a full PASS", "byte identical to today's reason — the ordinary path is pinned");
});

test("W1-T1020: the ledger reconstruction carries the partial flag", () => {
  const lines = [
    {
      step: "review.posted",
      task_id: "W1-T1020-fixture",
      head_sha: "deadbeef",
      state: "success",
      capped: false,
      plan_only: false,
      partially_executed: true,
    },
  ];
  const prior = priorReviewVerdictFromLedger(lines, "W1-T1020-fixture");
  assert.ok(prior);
  assert.equal(prior!.partiallyExecuted, true, "the recorded partially_executed boolean must reach the reconstructed verdict");

  // End to end: the sweep/triage arm path (decideArmFromLedgerVerdict) reaches the SAME decision
  // as the fresh-verdict path above, from ONLY the boolean the ledger carries (no counts) — the
  // fraction is named only where it is actually in hand (design (iii)).
  const decision = decideArmFromLedgerVerdict(prior, "deadbeef");
  assert.equal(decision.arm, true);
  assert.match(decision.reason, /PARTIAL/);
  assert.notEqual(decision.reason, "verdict is a full PASS");
});

// ── W1-T1020 DESIGN (vii): THE FILE-SHA-BRACKETED MUTATION CHECK ────────────────────────────
//
// A positive test alone proves nothing here: an implementation that named the partial shape only
// in a code COMMENT, or that computed the right string but never returned it on this branch,
// would still make the three tests above pass by accident if they were weakly written. The check
// (verbatim, design note (vii)): read the sha256 of the edited file, revert the reason change,
// read the sha256 again and require it to DIFFER, run the suite and require the partial-reason
// test to FAIL, restore, and require the sha to return to the original.
//
// This mutates a PRIVATE TMPDIR COPY of `src/lib/review.ts` (never the real, shared checkout —
// see the ISOLATED WORKING COPY note below for why), then spawns a REAL child `node --test`
// process against that copy — the same model test/task-id-reservation.test.ts's own W1-T949
// mutation test follows for its own target file, narrowed via `--test-name-pattern` to ONLY the
// "arms with a reason that names the partial shape" test above, in this SAME source file. That
// narrowing is what makes same-file safe: the pattern matches that one test's name and no
// other's, so THIS test (a different name) is never invoked by the child and no recursive
// re-entry occurs.

test("W1-T1020: reverting the reason change fails the partial reason test", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const realSrcPath = join(repoRoot, "src", "lib", "review.ts");
  const targetTestFile = "test/unexecutable-proof-visibility.test.ts";
  const positiveTestName = "W1-T1020: a partial verdict arms with a reason that names the partial shape";

  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

  const original = readFileSync(realSrcPath, "utf8");
  const originalSha = sha256(original);

  // THE REASON CHANGE: decideAutoMergeArm's `if (verdict.partiallyExecuted) { ... }` branch,
  // which is what makes the uncapped arm reason name the partial shape instead of unconditionally
  // asserting a full PASS. Reverted here to reproduce EXACTLY the defect this task closes.
  const needle =
    '  if (!verdict.capped) {\n' +
    '    const resolvedBands = bands ?? loadDefaultPolicy().values.armCalibrationBands;\n' +
    '    if (verdict.partiallyExecuted) {\n' +
    '      const hasCounts = typeof verdict.executedProofCount === "number" && typeof verdict.executableProofCount === "number";\n' +
    '      const base: ArmDecision = {\n' +
    '        arm: true,\n' +
    '        reason: hasCounts\n' +
    '          ? `verdict is a PARTIAL PASS (${verdict.executedProofCount}/${verdict.executableProofCount} executable ` +\n' +
    '            "criteria executed) — arms unchanged; legibility never becomes a refusal (W1-T1020)"\n' +
    '          : "verdict is a PARTIAL PASS (some, not all, executable criteria executed) — arms unchanged; " +\n' +
    '            "legibility never becomes a refusal (W1-T1020)",\n' +
    '      };\n' +
    '      return applyCalibrationBand(base, "keyword-floor", resolvedBands);\n' +
    '    }\n' +
    '    return applyCalibrationBand({ arm: true, reason: "verdict is a full PASS" }, "full-pass", resolvedBands);\n' +
    '  }';
  const occurrences = original.split(needle).length - 1;
  assert.equal(
    occurrences,
    1,
    "sanity: the uncapped-branch reason logic must appear EXACTLY once, or this mutation is not targeting the real rung",
  );
  const mutated = original.replace(
    needle,
    '  if (!verdict.capped) {\n' +
      '    // W1-T1020 MUTATION: the partial-shape branch removed, reverting to the pre-fix defect.\n' +
      '    return { arm: true, reason: "verdict is a full PASS" };\n' +
      '  }',
  );

  const whitelisted = parseWhitelistedProof(`unit test: ${positiveTestName}`);
  assert.ok(whitelisted, "sanity: the proof text must parse as a name-filtered `unit test:` dialect proof");
  assert.ok(whitelisted!.nameFiltered, "sanity: it must be the name-filtered shape (carries --test-name-pattern)");
  const args = narrowNameFilteredArgs(whitelisted!.args, [targetTestFile]);

  // ── ISOLATED WORKING COPY (never the real, shared checkout) ────────────────────────────────
  //
  // `review.ts` is imported by ~69 OTHER test files — by far the most widely imported source
  // module in this suite (contrast task-id-reservation.ts, the model this check otherwise
  // follows: 3 importers). `node --test` runs each matched FILE in its OWN subprocess
  // (test/setup/tmp-hygiene.ts's own header comment confirms this empirically, "no cross-file
  // collision risk under parallel execution" — true WITHIN one process's fixtures, but those
  // subprocesses themselves start throughout the WHOLE suite run, not all at t=0). Writing the
  // mutation directly onto the real, shared `src/lib/review.ts` therefore races ANY of those ~69
  // files' subprocesses that happen to start importing review.ts while it sits mutated on disk.
  //
  // MEASURED, not theorized: under `--experimental-test-coverage --enable-source-maps` (the
  // exact flags the `coverage-ratchet` CI job's "Test with coverage" step runs), this file
  // running alongside as few as one OTHER mutation check on a different file
  // (test/ledger-rotation.test.ts's own, independent mutation check on ledger.ts) corrupted
  // coverage-report generation for the WHOLE run — "Could not report code coverage. TypeError:
  // Cannot read properties of undefined (reading 'startOffset')" — leaving coverage/lcov.info
  // EMPTY (0 bytes). Reproduced twice in a row with that combination present, absent every time
  // (repeatedly) with either mutation target's file excluded from the run.
  //
  // A tmpdir COPY of src/ + test/ sidesteps the race entirely: the mutation lands on a path no
  // other subprocess (in this run or any other) ever resolves, so the shared checkout's
  // review.ts is never written to at all — the `untouchedSha` assertion in the `finally` below
  // makes that a checked property, not an assumption.
  const isolatedRoot = mkdtempSync(join(tmpdir(), "rmd-w1t1020-review-mutation-"));
  const skipVendoredOrVcs = (source: string) => /(^|[/\\])(node_modules|\.git)([/\\]|$)/.test(source);
  cpSync(join(repoRoot, "src"), join(isolatedRoot, "src"), { recursive: true, filter: (s) => !skipVendoredOrVcs(s) });
  cpSync(join(repoRoot, "test"), join(isolatedRoot, "test"), { recursive: true, filter: (s) => !skipVendoredOrVcs(s) });
  cpSync(join(repoRoot, "package.json"), join(isolatedRoot, "package.json"));
  cpSync(join(repoRoot, "tsconfig.json"), join(isolatedRoot, "tsconfig.json"));
  symlinkSync(join(repoRoot, "node_modules"), join(isolatedRoot, "node_modules"));
  const isolatedSrcPath = join(isolatedRoot, "src", "lib", "review.ts");

  let childResult: ReturnType<typeof spawnSync> | undefined;
  try {
    writeFileSync(isolatedSrcPath, mutated);
    const mutatedSha = sha256(readFileSync(isolatedSrcPath, "utf8"));
    assert.notEqual(mutatedSha, originalSha, "the mutation must actually change review.ts's bytes");

    // NODE_TEST_CONTEXT (set by node's OWN test runner on the process running THIS test) is
    // inherited by a plain spawnSync env by default — node's test runner treats its presence as
    // "this is a recursive run() call" and SKIPS running any files at all, exiting 0 having
    // executed nothing. Strip it so the child is a genuinely independent `node --test`
    // invocation, not a silently-skipped no-op that would make this check pass for the wrong
    // reason (test/task-id-reservation.test.ts's W1-T949 mutation test notes the same trap).
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    childResult = spawnSync(process.execPath, args, { cwd: isolatedRoot, encoding: "utf8", timeout: 90_000, env: childEnv });
  } finally {
    // The isolated copy is disposable regardless of what the child run did — a throw, a
    // timeout, or a pass all clean up the same way.
    rmSync(isolatedRoot, { recursive: true, force: true });
    // And the REAL, shared checkout was never written to in the first place — checked, not
    // assumed, so a future edit that reintroduces a real-file write trips this immediately.
    const untouchedSha = sha256(readFileSync(realSrcPath, "utf8"));
    assert.equal(untouchedSha, originalSha, "the real, shared review.ts must never be touched by this check");
  }

  assert.ok(childResult, "sanity: the child process must actually have been spawned");
  assert.notEqual(
    childResult!.status,
    0,
    `reverting the partial-shape reason must fail its own test — child exited ${childResult!.status}\n` +
      `stdout:\n${childResult!.stdout}\nstderr:\n${childResult!.stderr}`,
  );
});
