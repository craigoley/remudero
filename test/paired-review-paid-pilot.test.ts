import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { BENCHMARK_AA_RECEIPT_VERSION, BENCHMARK_AA_VERSION } from "../src/lib/benchmark-aa.js";
import { activateBenchmarkPaidPilot, appendPaidPilotControl, buildPaidPilotReport, paidArmPauseReasons,
  parsePaidPilotRequest, readPaidPilotEvidence,
  type PaidPilotProtocol } from "../src/lib/benchmark-paid-pilot.js";
import type { GoldenCorpusItem } from "../src/lib/golden-corpus.js";
import type { BlindedReviewInput, PairedReviewCase } from "../src/lib/paired-review-eval.js";
import { replayPairedReviews } from "../src/lib/replay-harness.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = (char: string) => char.repeat(40);
const repos = ["fixture/alpha", "fixture/beta", "fixture/gamma"];
const stack = { harness: sha("a"), prompt: sha("b"), tool: sha("c"), scorer: sha("d"), environment: sha("e") };
const seed = "reviewer-seed-1";
const idle = { liveness: { state: "up" as const, quiet: true as const },
  headroom: { billingMode: "subscription" as const, session: { percentUsed: 20 }, weekly: [{ label: "all", percentUsed: 20 }] } };

function caseFor(id: string, index: number): PairedReviewCase {
  const hex = (index + 10).toString(16);
  return { id, corpusTaskId: `T-PAIR-${index}`, repo: repos[index % repos.length]!, createdAt: new Date().toISOString(),
    baseSha: sha("1"), taskContextDigest: sha("2"), changedFileShapeDigest: sha("3"), issueCategory: "wiring",
    bug: { headSha: sha(hex), label: "faulty",
      evidence: { kind: "executable-falsifier", digest: sha("5"), observed: true } },
    benign: { headSha: sha(index % 2 ? "6" : "7"), label: "benign",
      evidence: { kind: "executable-falsifier", digest: sha("8"), observed: true } },
    sealedMechanismDigest: sha("9") };
}

function corpusFor(pair: PairedReviewCase): GoldenCorpusItem {
  return { taskId: pair.corpusTaskId, baseSha: pair.baseSha, headSha: pair.bug.headSha,
    mergedAt: pair.createdAt, creditSource: "ledger", proofs: [{ claim: "private held-out", proof: "unit test: private", holdout: true }],
    spec: { type: "implement", verify: "auto", files: ["src/fixture.ts"] }, freshness: { ageDays: 0 }, heldOut: true };
}

function fixture(t: TestContext,
  pairs: PairedReviewCase[], reserveUsd: number): { stateDir: string; protocol: PaidPilotProtocol } {
  const parent = mkdtempSync(join(tmpdir(), "rmd-reviewer-paid-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const stateDir = join(parent, "state");
  mkdirSync(stateDir);
  writeFileSync(join(stateDir, "ledger.ndjson"), "");
  const now = new Date().toISOString();
  const request = parsePaidPilotRequest({ version: "benchmark-paid-pilot-request-v1", pilotId: "reviewer-fixture-1",
    approval: { reference: "operator-$100-7d", approvedAt: now },
    repos: repos.map((repo) => ({ repo, consentReceipt: `consent:${repo}` })),
    pseudonymSalt: "fixture-salt", assignmentSeed: seed,
    arms: { paid: { provider: "cash", model: "paid-review-model", effort: "medium" },
      control: { provider: "subscription", model: "control-review-model", effort: "medium" } },
    revisions: { harnessRevision: stack.harness, promptRevision: stack.prompt, toolRevision: stack.tool,
      scorerRevision: stack.scorer, environmentRevision: stack.environment },
    strataRevision: "strata-v1", population: pairs.map((pair) => ({ taskId: pair.corpusTaskId, repo: pair.repo,
      taskClass: "reviewer-held-out", risk: "low" })), primaryOutcome: "verified-completion", maturityDays: 14,
    design: "paired", paired: { samplingRate: 1, maxPairs: pairs.length, shadow: true },
    protocolText: "Operator-approved paid implementation pilot plus explicit sealed reviewer A/A scope.",
    reviewerReplay: { version: "paid-reviewer-replay-v1", cashReserveUsdPerCall: reserveUsd,
      cases: pairs.map((pair) => ({ id: pair.id, corpusTaskId: pair.corpusTaskId, repo: pair.repo, baseSha: pair.baseSha,
        bugHeadSha: pair.bug.headSha, benignHeadSha: pair.benign.headSha, sealedManifestDigest: hash(pair) })) },
  });
  assert.ok(request.ok, request.ok ? "" : request.reason);
  const aaBody = { version: BENCHMARK_AA_VERSION };
  const aaReport = { ...aaBody, receipt: { version: BENCHMARK_AA_RECEIPT_VERSION, state: "observed", asOf: now,
    verdict: "no-integrity-concern-detected", winnerDeclared: false, reportHash: hash(aaBody), trialId: "aa-fixture",
    allocationReceiptHash: sha("a"), stackHash: sha("b") } };
  const activation = activateBenchmarkPaidPilot({ request: request.request, aaReport, nowIso: now, existing: [] });
  assert.ok(activation.ok, activation.ok ? "" : activation.reason);
  writeFileSync(join(stateDir, "benchmark-paid-pilot-v1.reviewer-fixture-1.protocol.json"),
    JSON.stringify({ protocol: activation.protocol, receipt: activation.receipt }));
  return { stateDir, protocol: activation.protocol };
}

function replayInput(stateDir: string, pairs: PairedReviewCase[], review: Parameters<typeof replayPairedReviews>[0]["review"],
  phase: "aa" | "comparison" = "aa"): Parameters<typeof replayPairedReviews>[0] {
  return { argv: ["--confirm-spend"], idle, stateDir, pilotId: "reviewer-fixture-1", phase, pairs,
    corpus: pairs.map(corpusFor), stack, seed, validatePair: () => true, validateLabel: () => true,
    score: () => ({ mechanismMatched: true, lineMatched: true, remedyActionable: true }), review };
}

function scored(pair: PairedReviewCase, input: BlindedReviewInput,
  costUsd: number) {
  return { verdict: input.headSha === pair.bug.headSha ? "fail" as const : "pass" as const,
    findings: [{ id: `finding-${input.opaqueArmId}`, anchorSupported: true, mechanism: "private mechanism", remedy: "repair" }],
    assignmentId: input.opaqueArmId, requestedModel: input.requestedModel, servedModel: input.requestedModel,
    servedEffort: input.requestedEffort, observedStack: stack, billingMode: "api" as const, costUsd,
    elapsedMs: 10, inputTokens: 10, outputTokens: 5 };
}

test("W1-T4929: paid admission is rechecked before each reviewer call", async (t) => {
  const pair = caseFor("pair-budget", 1);
  const { stateDir, protocol } = fixture(t, [pair], 60);
  let calls = 0;
  const result = await replayPairedReviews(replayInput(stateDir, [pair], async (input) => { calls++; return scored(pair, input, 50); }));
  assert.equal(result.state, "evaluated");
  assert.equal(calls, 1, "the first cash receipt plus the second reserve exhausts the shared $100 envelope");
  if (result.state !== "evaluated") return;
  assert.equal(result.report.pairs[0]?.state, "incomplete");
  assert.ok(result.report.pairs[0]?.missing.some((reason) => reason.includes("cash-budget-exhausted")));
  const evidence = await readPaidPilotEvidence(stateDir, protocol);
  assert.equal(paidArmPauseReasons(protocol, evidence, new Date().toISOString()).spend?.cashEstimateUsd, 50);
  const live = readFileSync(join(stateDir, "ledger.ndjson"), "utf8");
  assert.equal(live.match(/reviewer_replay\.receipt/g)?.length, 1);
  writeFileSync(join(stateDir, "ledger.2099-01-01T00-00-00-000Z.ndjson.gz"), gzipSync(live));
  writeFileSync(join(stateDir, "ledger.2099-01-01T00-00-01-000Z.ndjson"), live);
  const union = await readPaidPilotEvidence(stateDir, protocol);
  assert.deepEqual(union.forms, { gzip: 1, plain: 1, live: 1 });
  assert.ok(union.duplicateRows > 0);
  assert.equal(paidArmPauseReasons(protocol, union, new Date().toISOString()).spend?.cashEstimateUsd, 50,
    "overlapping archive and live rows are one cash receipt, never three");
});

test("W1-T4929: unavailable spend pauses the paid arm alone", async (t) => {
  const pair = caseFor("pair-unreadable", 1);
  const { stateDir } = fixture(t, [pair], 2);
  writeFileSync(join(stateDir, "ledger.2099-01-01T00-00-00-000Z.ndjson.gz"), "not-gzip");
  let calls = 0;
  const result = await replayPairedReviews(replayInput(stateDir, [pair], async (input) => { calls++; return scored(pair, input, 1); }));
  assert.equal(result.state, "evaluated");
  assert.equal(calls, 0);
  if (result.state !== "evaluated") return;
  assert.equal(result.report.pairs[0]?.state, "incomplete");
  assert.ok(result.report.pairs[0]?.missing.some((reason) => reason.includes("spend-source-unreadable")));
  assert.equal(result.report.winnerClaim, "unsupported");
});

test("W1-T4929: A/A failure withholds model comparison", async (t) => {
  const pair = caseFor("pair-one-group", 1);
  const { stateDir } = fixture(t, [pair], 2);
  let calls = 0;
  const review = async (input: BlindedReviewInput) => {
    calls++; return scored(pair, input, 1);
  };
  const aa = await replayPairedReviews(replayInput(stateDir, [pair], review));
  assert.equal(aa.state, "evaluated");
  if (aa.state !== "evaluated") return;
  assert.equal(aa.aaVerdict, "integrity-concerns", "one group is not an A/A comparison");
  assert.deepEqual(aa.report.byModel, []);
  const before = calls;
  const comparison = await replayPairedReviews(replayInput(stateDir, [pair], review, "comparison"));
  assert.deepEqual(comparison, { state: "refused", reason: "reviewer-aa-invalid-or-failed" });
  assert.equal(calls, before);
});

test("a complete same-model A/A receipt unlocks only private descriptive comparison", async (t) => {
  const ids: string[] = [];
  for (let i = 0; i < 100 && (!ids[0] || !ids[1]); i++) {
    const id = `aa-pair-${i}`;
    const group = parseInt(hash(`${seed}:${id}`).slice(0, 2), 16) % 2;
    ids[group] = id;
  }
  assert.ok(ids[0] && ids[1]);
  const pairs = [caseFor(ids[0]!, 1), caseFor(ids[1]!, 2)];
  const { stateDir } = fixture(t, pairs, 2);
  const review = async (input: BlindedReviewInput) => {
    const pair = pairs.find((item) => item.bug.headSha === input.headSha || item.benign.headSha === input.headSha)!;
    return scored(pair, input, 1);
  };
  const aa = await replayPairedReviews(replayInput(stateDir, pairs, review));
  assert.equal(aa.state, "evaluated");
  if (aa.state !== "evaluated") return;
  assert.equal(aa.aaVerdict, "no-integrity-concern-detected");
  assert.deepEqual(aa.report.byModel, [], "A/A itself is not a model-quality result");
  const compared = await replayPairedReviews(replayInput(stateDir, pairs, review, "comparison"));
  assert.equal(compared.state, "evaluated");
  if (compared.state !== "evaluated") return;
  assert.equal(compared.report.gradedPairs, 2);
  assert.equal(compared.report.byModel[0]?.model, "paid-review-model");
  assert.equal(compared.report.winnerClaim, "unsupported");
});

test("an unreceipted reviewer attempt holds later paid calls without a success-shaped zero", async (t) => {
  const pair = caseFor("pair-provider-failure", 1);
  const { stateDir, protocol } = fixture(t, [pair], 2);
  let calls = 0;
  const result = await replayPairedReviews(replayInput(stateDir, [pair], async () => {
    calls++;
    throw new Error("provider may have charged before failure");
  }));
  assert.equal(result.state, "evaluated");
  assert.equal(calls, 1);
  const evidence = await readPaidPilotEvidence(stateDir, protocol);
  const pause = paidArmPauseReasons(protocol, evidence, new Date().toISOString());
  assert.ok(pause.reasons.includes("cost-evidence-missing"));
  assert.equal(pause.spend?.missingReceipts, 1);
  assert.equal(pause.spend?.cashEstimateUsd, 2, "the in-flight reserve stays counted until reconciled");
  const privateReport = buildPaidPilotReport({ protocol, evidence, nowIso: new Date().toISOString() });
  assert.equal(privateReport.cash.spentEstimateUsd, null, "a missing actual receipt is unknown, not a measured $0 or $2");
  assert.equal(privateReport.cash.remainingUsd, null);
});

test("an operator pause or contested replay lock does not dispatch a paid reviewer", async (t) => {
  const pair = caseFor("pair-held", 1);
  const { stateDir } = fixture(t, [pair], 2);
  let calls = 0;
  const input = replayInput(stateDir, [pair], async (blinded) => { calls++; return scored(pair, blinded, 1); });
  appendPaidPilotControl(stateDir, "reviewer-fixture-1", "pause", new Date().toISOString(), "fixture hold");
  const paused = await replayPairedReviews(input);
  assert.equal(paused.state, "evaluated");
  assert.equal(calls, 0);
  if (paused.state !== "evaluated") return;
  assert.ok(paused.report.pairs[0]?.missing.some((reason) => reason.includes("operator-paused")));
  appendPaidPilotControl(stateDir, "reviewer-fixture-1", "resume", new Date().toISOString(), "fixture release");
  const lock = join(stateDir, "benchmark-paid-pilot-v1.reviewer-fixture-1.reviewer-lock");
  mkdirSync(lock);
  const contested = await replayPairedReviews(input);
  assert.deepEqual(contested, { state: "refused", reason: "reviewer-paid-arm-busy-or-state-unavailable" });
  assert.equal(calls, 0);
});

test("a changed sealed head is excluded before any admission or reviewer call", async (t) => {
  const pair = caseFor("pair-sealed", 1);
  const { stateDir } = fixture(t, [pair], 2);
  let calls = 0;
  const altered = { ...pair, bug: { ...pair.bug, headSha: sha("f") } };
  const result = await replayPairedReviews(replayInput(stateDir, [altered], async (blinded) => {
    calls++; return scored(altered, blinded, 1);
  }));
  assert.deepEqual(result, { state: "refused", reason: "no-sealed-held-out-reviewer-pair" });
  assert.equal(calls, 0);
});

test("a concurrent live pilot is refused before reviewer spend, without holding ordinary work", async (t) => {
  const pair = caseFor("pair-exclusive", 1);
  const { stateDir, protocol } = fixture(t, [pair], 2);
  const competing = { ...protocol, pilotId: "competing-pilot", reviewerReplay: undefined };
  writeFileSync(join(stateDir, "benchmark-paid-pilot-v1.competing-pilot.protocol.json"), JSON.stringify({ protocol: competing }));
  let calls = 0;
  const result = await replayPairedReviews(replayInput(stateDir, [pair], async (blinded) => {
    calls++; return scored(pair, blinded, 1);
  }));
  assert.deepEqual(result, { state: "refused", reason: "competing-pilot-active" });
  assert.equal(calls, 0);
});
