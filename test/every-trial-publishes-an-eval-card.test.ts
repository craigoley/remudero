import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { test } from "node:test";
import {
  buildEvalCard,
  canonicalProtocolText,
  chiSquareGoodnessOfFit,
  chiSquareSurvival,
  EVAL_CARD_VERSION,
  graderValidityFromReviewRows,
  mcnemarPairsRequired,
  normalQuantile,
  twoProportionPower,
  twoProportionSampleSize,
  type EvalCardEvidence,
  type EvalCardTrial,
} from "../src/lib/eval-card.js";
import { buildAnalyticsRoute, coldAnalyticsSnapshot } from "../src/lib/analytics-route.js";

/**
 * W1-T4630 — A FIELD-TRIAL RESULT CANNOT SHOW ITS OWN VALIDITY. Every trial (W1-T4575's A/A,
 * W1-T4603's paid pilot, W1-T4625's paired trial) gets a versioned eval card: pre-registration
 * hash and time, estimand and randomization unit, A/A and sample-ratio checks, power, per-cell
 * coverage with unknowns, grader validity and a deviations log. A trial whose pre-registration
 * was not committed before its first assignment has no publishable card.
 */

const PROTOCOL = "estimand: verified completion rate difference\nunit: task\nstopping: fixed n=200\n";

function trial(overrides: Partial<EvalCardTrial> = {}): EvalCardTrial {
  return {
    trialId: "aa-2026-10",
    kind: "aa",
    protocolText: PROTOCOL,
    preRegisteredAt: "2026-10-01T00:00:00.000Z",
    estimand: "difference in verified completion rate between arms (intention to treat)",
    randomizationUnit: "task",
    propensity: "each eligible task: P(arm-a) = P(arm-b) = 0.5, seeded by sha256(seed||task_id)",
    plannedAllocation: { "arm-a": 0.5, "arm-b": 0.5 },
    cells: ["arm-a|docs", "arm-a|src", "arm-b|docs", "arm-b|src"],
    power: { baselineRate: 0.5, minimumDetectableEffect: 0.25, alpha: 0.05, power: 0.9, discordantRate: 0.4 },
    ...overrides,
  };
}

function balancedEvidence(overrides: Partial<EvalCardEvidence> = {}): EvalCardEvidence {
  const assignments = [];
  const outcomes = [];
  for (let i = 0; i < 40; i += 1) {
    const arm = i % 2 === 0 ? "arm-a" : "arm-b";
    const stratum = i % 4 < 2 ? "docs" : "src";
    assignments.push({ unitId: `W1-T${i}`, arm, assignedAt: `2026-10-02T00:00:${String(i).padStart(2, "0")}.000Z` });
    outcomes.push({ unitId: `W1-T${i}`, arm, stratum, success: i % 3 !== 0 });
  }
  return { assignments, outcomes, reviewRows: [], deviations: [], ...overrides };
}

// ── pre-registration ───────────────────────────────────────────────────────────────────────────

test("eval card carries the sha256 of the canonical protocol text and is publishable when registered first", () => {
  const card = buildEvalCard(trial(), balancedEvidence());
  assert.equal(card.version, EVAL_CARD_VERSION);
  assert.equal(card.version, "eval-card-v1");
  assert.equal(card.visibility, "private");
  const expected = createHash("sha256").update(canonicalProtocolText(PROTOCOL)).digest("hex");
  assert.equal(card.preRegistration.protocolHash, expected);
  assert.equal(card.preRegistration.committedAt, "2026-10-01T00:00:00.000Z");
  assert.equal(card.preRegistration.firstAssignmentAt, "2026-10-02T00:00:00.000Z");
  assert.equal(card.preRegistration.precedesFirstAssignment, true);
  assert.equal(card.publishable, true);
  assert.deepEqual(card.blockers, []);
});

test("canonical protocol text ignores line endings and trailing whitespace, not content", () => {
  assert.equal(canonicalProtocolText("a  \r\nb\r\n\r\n"), canonicalProtocolText("a\nb"));
  assert.notEqual(canonicalProtocolText("a\nb"), canonicalProtocolText("a\nc"));
});

test("a card whose pre-registration postdates the first assignment is not publishable", () => {
  const card = buildEvalCard(trial({ preRegisteredAt: "2026-10-03T00:00:00.000Z" }), balancedEvidence());
  assert.equal(card.preRegistration.precedesFirstAssignment, false);
  assert.equal(card.publishable, false);
  assert.ok(card.blockers.includes("pre-registration-postdates-first-assignment"));
  assert.ok(card.deviations.some((d) => d.kind === "pre-registration-postdates-first-assignment"));
});

test("a pre-registration committed at the same instant as the first assignment does not precede it", () => {
  const card = buildEvalCard(trial({ preRegisteredAt: "2026-10-02T00:00:00.000Z" }), balancedEvidence());
  assert.equal(card.publishable, false);
});

test("a trial with no committed pre-registration has no publishable card", () => {
  for (const t of [trial({ protocolText: null }), trial({ preRegisteredAt: null }), trial({ preRegisteredAt: "not a date" })]) {
    const card = buildEvalCard(t, balancedEvidence());
    assert.equal(card.publishable, false);
    assert.ok(card.blockers.includes("no-committed-pre-registration"), JSON.stringify(card.blockers));
  }
  const none = buildEvalCard(null, balancedEvidence());
  assert.equal(none.publishable, false);
  assert.equal(none.state, "unavailable");
  assert.ok(none.blockers.includes("no-committed-pre-registration"));
});

test("a protocol whose text no longer hashes to its registered hash is not publishable", () => {
  const card = buildEvalCard(trial({ registeredProtocolHash: "0".repeat(64) }), balancedEvidence());
  assert.equal(card.publishable, false);
  assert.ok(card.blockers.includes("protocol-text-changed-after-registration"));
});

// ── estimand, unit, propensity ─────────────────────────────────────────────────────────────────

test("eval card states the estimand, randomization unit and a propensity excerpt", () => {
  const card = buildEvalCard(trial(), balancedEvidence());
  assert.match(card.design.estimand, /verified completion/);
  assert.equal(card.design.randomizationUnit, "task");
  assert.match(card.design.propensityExcerpt, /P\(arm-a\)/);
  const long = buildEvalCard(trial({ propensity: "x".repeat(2000) }), balancedEvidence());
  assert.ok(long.design.propensityExcerpt.length <= 281);
  assert.equal(buildEvalCard(trial({ propensity: undefined }), balancedEvidence()).design.propensityExcerpt, "unavailable");
});

// ── sample ratio mismatch and A/A ──────────────────────────────────────────────────────────────

test("chi-square survival matches textbook critical values", () => {
  assert.ok(Math.abs(chiSquareSurvival(3.841458820694124, 1) - 0.05) < 1e-9);
  assert.ok(Math.abs(chiSquareSurvival(5.991464547107979, 2) - 0.05) < 1e-9);
  assert.ok(Math.abs(chiSquareSurvival(6.634896601021214, 1) - 0.01) < 1e-9);
  assert.ok(Math.abs(chiSquareSurvival(10.827566170662733, 1) - 0.001) < 1e-9);
  assert.ok(Math.abs(chiSquareSurvival(11.070497693516351, 5) - 0.05) < 1e-9);
  assert.equal(chiSquareSurvival(0, 3), 1);
});

test("chi-square goodness of fit on a 60/40 split of 1000 matches the hand computation", () => {
  const fit = chiSquareGoodnessOfFit([600, 400], [0.5, 0.5]);
  assert.equal(fit.statistic, 40); // (100²/500)·2
  assert.equal(fit.degreesOfFreedom, 1);
  assert.ok(fit.pValue < 1e-9 && fit.pValue > 0);
});

test("SRM detection flags a skewed split and passes a balanced one", () => {
  const skewedAssignments = [];
  for (let i = 0; i < 1000; i += 1) {
    skewedAssignments.push({ unitId: `T${i}`, arm: i < 600 ? "arm-a" : "arm-b", assignedAt: "2026-10-02T00:00:00.000Z" });
  }
  const skewed = buildEvalCard(trial(), balancedEvidence({ assignments: skewedAssignments, outcomes: [] }));
  assert.equal(skewed.sampleRatio.state, "observed");
  if (skewed.sampleRatio.state !== "observed") return;
  assert.deepEqual(skewed.sampleRatio.observed, { "arm-a": 600, "arm-b": 400 });
  assert.equal(skewed.sampleRatio.mismatch, true);
  assert.ok(skewed.sampleRatio.pValue < 0.001);
  assert.ok(skewed.deviations.some((d) => d.kind === "sample-ratio-mismatch"));

  const balanced = buildEvalCard(trial(), balancedEvidence());
  assert.equal(balanced.sampleRatio.state, "observed");
  if (balanced.sampleRatio.state !== "observed") return;
  assert.equal(balanced.sampleRatio.mismatch, false);
  assert.equal(balanced.sampleRatio.pValue, 1);
});

test("a retry in the same arm counts once and a unit seen in two arms is a logged crossover", () => {
  const evidence = balancedEvidence();
  evidence.assignments.push({ unitId: "W1-T0", arm: "arm-a", assignedAt: "2026-10-05T00:00:00.000Z" });
  evidence.assignments.push({ unitId: "W1-T1", arm: "arm-a", assignedAt: "2026-10-05T00:00:00.000Z" });
  const card = buildEvalCard(trial(), evidence);
  assert.equal(card.sampleRatio.state, "observed");
  if (card.sampleRatio.state !== "observed") return;
  assert.deepEqual(card.sampleRatio.observed, { "arm-a": 20, "arm-b": 20 });
  assert.equal(card.sampleRatio.crossoverUnits, 1);
  assert.ok(card.deviations.some((d) => d.kind === "crossover"));
});

test("with no assignments the sample-ratio check reads unknown, not a pass", () => {
  const card = buildEvalCard(trial(), balancedEvidence({ assignments: [], outcomes: [] }));
  assert.equal(card.sampleRatio.state, "unknown");
  assert.equal(card.preRegistration.precedesFirstAssignment, "unknown");
});

test("an A/A trial reports its arm difference and never declares a winner", () => {
  const card = buildEvalCard(trial(), balancedEvidence());
  assert.equal(card.aa.state, "observed");
  if (card.aa.state !== "observed") return;
  assert.equal(card.aa.winnerDeclared, false);
  assert.equal(card.aa.arms["arm-a"]!.n, 20);
  assert.ok(card.aa.pValue >= 0 && card.aa.pValue <= 1);
  assert.ok(card.aa.difference.low <= card.aa.difference.estimate && card.aa.difference.estimate <= card.aa.difference.high);
});

test("a non-A/A trial cites its A/A receipt or reads missing", () => {
  const cited = buildEvalCard(trial({ kind: "paired", aaReceipt: "eval-card:aa-2026-10:abc" }), balancedEvidence());
  assert.deepEqual(cited.aa, { state: "cited", receipt: "eval-card:aa-2026-10:abc" });
  const missing = buildEvalCard(trial({ kind: "paid-pilot" }), balancedEvidence());
  assert.equal(missing.aa.state, "missing");
});

// ── power ──────────────────────────────────────────────────────────────────────────────────────

test("normal quantile matches reference values", () => {
  assert.ok(Math.abs(normalQuantile(0.975) - 1.959963984540054) < 1e-8);
  assert.ok(Math.abs(normalQuantile(0.8) - 0.8416212335729143) < 1e-8);
  assert.ok(Math.abs(normalQuantile(0.9) - 1.2815515655446004) < 1e-8);
  assert.ok(Math.abs(normalQuantile(0.025) + 1.959963984540054) < 1e-8);
});

test("two-proportion power numbers match R's power.prop.test reference", () => {
  // R documentation example: power.prop.test(n = 50, p1 = .50, p2 = .75) -> power = 0.7401659
  assert.ok(Math.abs(twoProportionPower(50, 0.5, 0.75, 0.05) - 0.7401659) < 1e-6);
  // The sample size inverts that same power equation (what power.prop.test's uniroot solves), by hand:
  // ((z.975·sqrt(1.25·0.75/2) + z.9·sqrt(.25 + .1875)) / .25)² = 76.7069
  const hand = ((1.959963984540054 * Math.sqrt(1.25 * 0.75 / 2) + 1.2815515655446004 * Math.sqrt(0.4375)) / 0.25) ** 2;
  const n = twoProportionSampleSize(0.5, 0.75, 0.05, 0.9);
  assert.ok(Math.abs(n - hand) < 1e-6 && Math.abs(n - 76.7069) < 1e-4);
  assert.ok(Math.abs(twoProportionPower(n, 0.5, 0.75, 0.05) - 0.9) < 1e-9);
});

test("McNemar paired pairs match Connor's formula computed by hand", () => {
  // Connor (1987): n = (z_{a/2}·sqrt(psi) + z_b·sqrt(psi - d²))² / d², psi = 0.4, d = 0.25, a = .05, 1-b = .9
  const hand = (1.959963984540054 * Math.sqrt(0.4) + 1.2815515655446004 * Math.sqrt(0.4 - 0.0625)) ** 2 / 0.0625;
  assert.ok(Math.abs(mcnemarPairsRequired(0.4, 0.25, 0.05, 0.9) - hand) < 1e-6);
  assert.ok(Math.abs(hand - 62.9867) < 1e-4);
  assert.ok(Number.isNaN(mcnemarPairsRequired(0.1, 0.25, 0.05, 0.9)));
});

test("the card's power section carries both designs, rounded up to whole units", () => {
  const card = buildEvalCard(trial(), balancedEvidence());
  assert.equal(card.power.state, "declared");
  if (card.power.state !== "declared") return;
  assert.equal(card.power.twoProportion.unitsPerArm, 77);
  assert.equal(card.power.paired.state, "computed");
  if (card.power.paired.state === "computed") assert.equal(card.power.paired.pairs, 63);
  assert.equal(card.power.twoProportion.observedMinArmUnits, 20);
  const achieved = card.power.twoProportion.achievedPower;
  assert.ok(typeof achieved === "number" && achieved > 0 && achieved < 0.9);
  const unstarted = buildEvalCard(trial(), balancedEvidence({ assignments: [], outcomes: [] }));
  if (unstarted.power.state === "declared") assert.equal(unstarted.power.twoProportion.achievedPower, "unknown");
  const noPsi = buildEvalCard(trial({ power: { baselineRate: 0.5, minimumDetectableEffect: 0.25 } }), balancedEvidence());
  assert.equal(noPsi.power.state, "declared");
  if (noPsi.power.state === "declared") assert.equal(noPsi.power.paired.state, "unknown");
  assert.equal(buildEvalCard(trial({ power: undefined }), balancedEvidence()).power.state, "undeclared");
});

// ── coverage ───────────────────────────────────────────────────────────────────────────────────

test("unknown cells stay unknown, never zero", () => {
  const evidence = balancedEvidence({
    outcomes: [
      { unitId: "A", arm: "arm-a", stratum: "docs", success: true },
      { unitId: "B", arm: "arm-a", stratum: "docs", success: false },
      { unitId: "C", arm: "arm-b", stratum: "src", success: null },
    ],
  });
  const card = buildEvalCard(trial(), evidence);
  const byCell = new Map(card.coverage.map((c) => [c.cell, c]));
  const docsA = byCell.get("arm-a|docs")!;
  assert.equal(docsA.state, "observed");
  if (docsA.state === "observed") assert.equal(docsA.successRate, 0.5);
  for (const cell of ["arm-a|src", "arm-b|docs", "arm-b|src"]) {
    const entry = byCell.get(cell)!;
    assert.equal(entry.state, "unknown", cell);
    assert.equal(entry.n, 0);
    assert.equal((entry as { successRate?: unknown }).successRate, undefined);
  }
  assert.equal(byCell.get("arm-b|src")!.unavailableOutcomes, 1);
  assert.doesNotMatch(JSON.stringify(card.coverage.filter((c) => c.state === "unknown")), /"successRate"/);
});

// ── grader validity ────────────────────────────────────────────────────────────────────────────

test("grader validity reads proof outcome shares and holdout coverage from review.posted criteria", () => {
  const rows = [
    { step: "review.posted", task_id: "W1-T0", pr_url: "p0", decision_verdict: { criteria: [
      { proof_exec: "executed_pass", holdout: false }, { proof_exec: "executed_stale", holdout: false },
      { proof_exec: "not_executable", holdout: true }, { proof_exec: "exec_error" },
    ] } },
    { step: "review.posted", task_id: "W1-T1", pr_url: "p1", decision_verdict: { criteria: [{ proof_exec: "executed_pass" }] } },
    { step: "review.posted", task_id: "W1-T1", pr_url: "p1", decision_verdict: { criteria: [{ proof_exec: "executed_pass" }, { proof_exec: "executed_stale" }] } },
    { step: "review.posted", task_id: "OTHER", pr_url: "px", decision_verdict: { criteria: [{ proof_exec: "exec_error" }] } },
    { step: "verdict", task_id: "W1-T0" },
  ];
  const validity = graderValidityFromReviewRows(rows, new Set(["W1-T0", "W1-T1"]));
  assert.equal(validity.state, "observed");
  if (validity.state !== "observed") return;
  assert.equal(validity.criteria, 6); // the later W1-T1 review supersedes the earlier one
  assert.equal(validity.reviews, 2);
  assert.equal(validity.shares.executed_stale, 2 / 6);
  assert.equal(validity.shares.not_executable, 1 / 6);
  assert.equal(validity.shares.exec_error, 1 / 6);
  assert.equal(validity.holdoutCoverage, 1 / 2);

  const card = buildEvalCard(trial(), balancedEvidence({ reviewRows: rows }));
  assert.equal(card.graderValidity.state, "observed");
  assert.equal(graderValidityFromReviewRows([], new Set(["W1-T0"])).state, "unknown");
});

// ── deviations ─────────────────────────────────────────────────────────────────────────────────

test("declared deviations are logged in time order beside the derived ones", () => {
  const card = buildEvalCard(trial(), balancedEvidence({ deviations: [
    { at: "2026-10-09T00:00:00.000Z", kind: "stopping-rule", description: "stopped early for budget" },
    { at: "2026-10-04T00:00:00.000Z", kind: "harness-revision", description: "scorer pinned revision bumped" },
  ] }));
  assert.deepEqual(card.deviations.map((d) => d.kind), ["harness-revision", "stopping-rule"]);
});

// ── the route ──────────────────────────────────────────────────────────────────────────────────

function captureResponse(): { res: ServerResponse; sent: () => { status: number; body: unknown } } {
  let status = 0;
  let body = "";
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    end(chunk?: string) { body = chunk ?? ""; return this; },
  } as unknown as ServerResponse;
  return { res, sent: () => ({ status, body: JSON.parse(body) }) };
}

test("GET /v1/analytics?projectionVersion=eval-card-v1 serves a private card built by buildEvalCard", async () => {
  const route = buildAnalyticsRoute({
    currentSnapshot: coldAnalyticsSnapshot,
    currentEvalCardInput: (trialId) => (trialId === "aa-2026-10" ? { trial: trial(), evidence: balancedEvidence() } : undefined),
  });
  const hit = captureResponse();
  await route.handler({ url: "/v1/analytics?projectionVersion=eval-card-v1&trial=aa-2026-10" } as never, hit.res, { params: {} });
  const served = hit.sent();
  assert.equal(served.status, 200);
  const card = served.body as { version: string; visibility: string; publishable: boolean; trialId: string };
  assert.equal(card.version, "eval-card-v1");
  assert.equal(card.visibility, "private");
  assert.equal(card.trialId, "aa-2026-10");
  assert.equal(card.publishable, true);

  const miss = captureResponse();
  await route.handler({ url: "/v1/analytics?projectionVersion=eval-card-v1&trial=nope" } as never, miss.res, { params: {} });
  const unknown = miss.sent().body as { state: string; publishable: boolean; blockers: string[] };
  assert.equal(unknown.state, "unavailable");
  assert.equal(unknown.publishable, false);
  assert.ok(unknown.blockers.includes("no-committed-pre-registration"));

  const unwired = buildAnalyticsRoute({ currentSnapshot: coldAnalyticsSnapshot });
  const bare = captureResponse();
  await unwired.handler({ url: "/v1/analytics?projectionVersion=eval-card-v1" } as never, bare.res, { params: {} });
  assert.equal((bare.sent().body as { publishable: boolean }).publishable, false);
});

test("normalQuantile's tail branch matches reference quantiles on both sides", () => {
  // Below 0.02425 and above 0.97575 the approximation takes its tail branch.
  assert.ok(Math.abs(normalQuantile(0.001) - -3.090232306) < 1e-6);
  assert.ok(Math.abs(normalQuantile(0.999) - 3.090232306) < 1e-6);
  assert.ok(Math.abs(normalQuantile(0.01) - -2.326347874) < 1e-6);
});
