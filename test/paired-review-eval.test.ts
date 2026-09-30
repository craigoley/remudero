import assert from "node:assert/strict";
import { test } from "node:test";
import { runPairedReviewEvaluation, type PairedReviewCase } from "../src/lib/paired-review-eval.js";
import { replayPairedReviews } from "../src/lib/replay-harness.js";
import type { GoldenCorpusItem } from "../src/lib/golden-corpus.js";

const sha = (char: string) => char.repeat(40);
const at = "2026-09-29T00:00:00Z";
const corpusItem: GoldenCorpusItem = { taskId: "T-PAIR", baseSha: sha("a"), headSha: sha("b"), mergedAt: at,
  creditSource: "ledger", proofs: [{ claim: "the fault is absent", proof: "unit test: held-out", holdout: true }],
  spec: { type: "implement", verify: "auto", files: ["src/thing.ts"] }, freshness: { ageDays: 1 }, heldOut: true };
const pair: PairedReviewCase = { id: "pair-1", corpusTaskId: "T-PAIR", repo: "acme/core", createdAt: at,
  baseSha: sha("a"), taskContextDigest: sha("c"), changedFileShapeDigest: sha("d"), issueCategory: "wiring",
  bug: { headSha: sha("b"), label: "faulty", evidence: { kind: "executable-falsifier", digest: sha("e"), observed: true } },
  benign: { headSha: sha("f"), label: "benign", evidence: { kind: "human-reviewed", digest: sha("1"), observed: true } },
  sealedMechanismDigest: sha("2") };
const stack = { harness: sha("3"), prompt: sha("4"), tool: sha("5"), scorer: sha("6"), environment: sha("7") };
const output = (verdict: "fail" | "pass") => ({ verdict, findings: [{ id: "f1", anchorSupported: true, mechanism: "specific fault", remedy: "fix it" }],
  assignmentId: "assignment-1", requestedModel: "model-a", servedModel: "model-a",
  observedStack: stack, elapsedMs: 100, inputTokens: 10, outputTokens: 5, costUsd: 0.2, billingMode: "api" as const });
const validateLabel = () => true;
const validatePair = () => true;
const admitReview = async () => ({ allowed: true, reason: "test-authorization" });

test("W1-T4905: bug and benign twins share context but opposite labels", async () => {
  const prompts: unknown[] = [];
  const good = await runPairedReviewEvaluation({ pairs: [pair], corpus: [corpusItem], stack, seed: "seed",
    validateLabel, validatePair, admitReview,
    review: async (input) => { prompts.push(input); return output("pass"); },
    score: () => ({ mechanismMatched: false, lineMatched: false, remedyActionable: false }) });
  assert.equal(good.pairs[0]?.state, "graded");
  assert.equal(good.pairs[0]?.baseSha, pair.baseSha);
  assert.equal(good.pairs[0]?.bugHeadSha, pair.bug.headSha);
  assert.equal(good.stack.prompt, stack.prompt);
  assert.ok(good.seedDigest.length === 64);
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((input) => !JSON.stringify(input).includes("faulty") && !JSON.stringify(input).includes("benign") &&
    !JSON.stringify(input).includes("held-out") && !JSON.stringify(input).includes(pair.sealedMechanismDigest)));
  const bad = await runPairedReviewEvaluation({ pairs: [{ ...pair, benign: { ...pair.benign, evidence: { ...pair.benign.evidence, observed: false } } }],
    corpus: [corpusItem], stack, seed: "seed", validateLabel, validatePair, admitReview,
    review: async () => { throw Error("must not dispatch"); } });
  assert.equal(bad.pairs[0]?.state, "ungradable");
  assert.equal(bad.pairs[0]?.reason, "benign-label-unverified");
});

test("W1-T4905: verdict without mechanism earns no diagnosis credit", async () => {
  const report = await runPairedReviewEvaluation({ pairs: [pair], corpus: [corpusItem], stack, seed: "seed",
    validateLabel, validatePair, admitReview,
    review: async () => output("fail"),
    score: () => ({ mechanismMatched: false, lineMatched: false, remedyActionable: false }) });
  assert.equal(report.pairs[0]?.bugDetected, true);
  assert.equal(report.pairs[0]?.benignSpecific, false);
  assert.equal(report.pairs[0]?.diagnosisCredit, false);
  assert.equal(report.pairs[0]?.benignFalseComments, 1);
  assert.equal(report.byModel[0]?.model, "model-a");
  assert.equal(report.byModel[0]?.issueCategory, "wiring");
  assert.equal(report.winnerClaim, "unsupported");
});

test("W1-T4905: paired replay is read-only and reports missingness", async () => {
  let calls = 0;
  const denied = await replayPairedReviews({ argv: [], idle: { liveness: { state: "up", quiet: true },
    headroom: { billingMode: "subscription", session: { percentUsed: 20 }, weekly: [{ label: "all", percentUsed: 40 }] } },
    spendAllowed: false, pairs: [pair], corpus: [corpusItem], stack, seed: "seed", validateLabel, validatePair, admitReview,
    review: async () => { calls++; return output("fail"); } });
  assert.equal(denied.state, "refused");
  assert.equal(calls, 0);
  const report = await runPairedReviewEvaluation({ pairs: [pair], corpus: [corpusItem], stack, seed: "seed",
    validateLabel, validatePair, admitReview,
    review: async () => { calls++; throw new Error("provider unavailable"); } });
  assert.equal(calls, 2);
  assert.equal(report.pairs[0]?.state, "incomplete");
  assert.deepEqual(report.pairs[0]?.missing.sort(), ["benign:replay-error:Error", "bug:replay-error:Error"]);
  assert.equal(report.cashCostUsd, null);
  assert.equal(report.notionalCostUsd, null);
  assert.equal(report.costMissingArms, 2);
  assert.equal(report.winnerClaim, "unsupported");
});

test("opted-in held-out replay invokes the paired evaluator only for admitted corpus items", async () => {
  const idle = { liveness: { state: "up" as const, quiet: true as const },
    headroom: { billingMode: "subscription" as const, session: { percentUsed: 20 }, weekly: [{ label: "all", percentUsed: 40 }] } };
  let calls = 0;
  const run = await replayPairedReviews({ argv: ["--confirm-spend"], idle, spendAllowed: true,
    pairs: [pair, { ...pair, id: "not-in-corpus", corpusTaskId: "T-ABSENT" }], corpus: [corpusItem], stack, seed: "seed",
    validateLabel, validatePair, admitReview, review: async () => { calls++; return output("pass"); },
    score: () => ({ mechanismMatched: false, lineMatched: false, remedyActionable: false }) });
  assert.equal(run.state, "evaluated");
  if (run.state !== "evaluated") return;
  assert.equal(calls, 2);
  assert.deepEqual(run.excludedPairIds, ["not-in-corpus"]);
  assert.equal(run.report.totalPairs, 1);
  assert.equal(run.report.gradedPairs, 1);
  assert.equal(run.report.winnerClaim, "unsupported");
});

test("a scorer failure or unverified shared context never becomes a diagnosis", async () => {
  let calls = 0;
  const rejected = await runPairedReviewEvaluation({ pairs: [pair], corpus: [corpusItem], stack, seed: "seed",
    validateLabel, validatePair: () => false, admitReview, review: async () => { calls++; return output("fail"); } });
  assert.equal(rejected.pairs[0]?.reason, "pair-provenance-unverified");
  assert.equal(calls, 0);
  const failed = await runPairedReviewEvaluation({ pairs: [pair], corpus: [corpusItem], stack, seed: "seed",
    validateLabel, validatePair, admitReview, review: async () => output("fail"), score: () => { throw new Error("scorer unavailable"); } });
  assert.equal(failed.pairs[0]?.state, "incomplete");
  assert.equal(failed.pairs[0]?.diagnosisCredit, null);
  assert.ok(failed.pairs[0]?.missing.includes("independent-scorer-error:Error"));
});

test("a fallback to another served model or unpinned stack stays out of model comparisons", async () => {
  let calls = 0;
  const report = await runPairedReviewEvaluation({ pairs: [pair], corpus: [corpusItem], stack, seed: "seed",
    validateLabel, validatePair, admitReview, review: async () => {
      calls++;
      return { ...output("fail"), servedModel: calls === 1 ? "model-a" : "model-b",
        observedStack: calls === 1 ? stack : { ...stack, prompt: sha("8") } };
    }, score: () => ({ mechanismMatched: true, lineMatched: true, remedyActionable: true }) });
  assert.equal(report.pairs[0]?.state, "incomplete");
  assert.equal(report.gradedPairs, 0);
  assert.deepEqual(report.byModel, []);
  assert.ok(report.pairs[0]?.missing.includes("served-model-mismatch"));
  assert.ok(report.pairs[0]?.missing.some((reason) => reason.endsWith("stack-unpinned")));
});

test("missing paid-pilot admission pauses only evaluation calls, never review or PR flow", async () => {
  let calls = 0;
  const report = await runPairedReviewEvaluation({ pairs: [pair], corpus: [corpusItem], stack, seed: "seed",
    validateLabel, validatePair, admitReview: async () => ({ allowed: false, reason: "cash-budget-exhausted" }),
    review: async () => { calls++; return output("fail"); } });
  assert.equal(calls, 0);
  assert.equal(report.pairs[0]?.state, "incomplete");
  assert.equal(report.pairs[0]?.missing.filter((reason) => reason.includes("cash-budget-exhausted")).length, 2);
  assert.equal(report.costMissingArms, 0, "a refused call is not a missing cost receipt for a call that happened");
});

test("an independent provenance read failure leaves the pair ungradable without dispatch", async () => {
  let calls = 0;
  const report = await runPairedReviewEvaluation({ pairs: [pair], corpus: [corpusItem], stack, seed: "seed",
    validateLabel, validatePair: () => { throw new Error("evidence store unavailable"); }, admitReview,
    review: async () => { calls++; return output("fail"); } });
  assert.equal(calls, 0);
  assert.equal(report.pairs[0]?.state, "ungradable");
  assert.equal(report.pairs[0]?.reason, "independent-validation-unavailable:Error");
  assert.equal(report.gradedPairs, 0);
});

test("a paid admission read failure pauses the arm without calling the reviewer", async () => {
  let calls = 0;
  const report = await runPairedReviewEvaluation({ pairs: [pair], corpus: [corpusItem], stack, seed: "seed",
    validateLabel, validatePair, admitReview: async () => { throw new Error("budget evidence unavailable"); },
    review: async () => { calls++; return output("fail"); } });
  assert.equal(calls, 0);
  assert.equal(report.pairs[0]?.state, "incomplete");
  assert.equal(report.pairs[0]?.missing.filter((reason) => reason.includes("admission-read-failed:Error")).length, 2);
  assert.equal(report.costMissingArms, 0);
});
