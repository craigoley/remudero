/**
 * W1-T12414: recorded typed answers are scored with Brier, log-loss and agreement, per role and per
 * model. A decision model's distribution, a generative judge's single answer, an abstention and a
 * rejection are four kinds; only a distribution with a known outcome gets a Brier or log-loss figure.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildAnalyticsRoute,
  deriveAnalyticsSnapshot,
  deriveAnalyticsSnapshotFromCheckpointedLedger,
  type AnalyticsCheckpoint,
} from "#src/lib/analytics-route.js";
import { fixedClock } from "#src/lib/clock.js";
import { DECISION_ANSWERED_STEP, readDecisionAnswers, type DecisionQuestion } from "#src/lib/decision-model.js";
import { deriveJudgeCalibration, JUDGE_CALIBRATION_VERSION, type JudgeCalibration } from "#src/lib/judge-calibration.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  checkTypedAnswer,
  decisionAnsweredTypedAnswers,
  LOG_LOSS_FLOOR,
  scoreTypedAnswers,
  TYPED_ANSWER_SCORES_VERSION,
  type TypedAnswer,
  type TypedAnswerRow,
  type TypedAnswerScoreGroup,
} from "#src/lib/typed-answer-scores.js";
import { TYPED_JUDGMENT_SUM_TOLERANCE } from "#src/lib/typed-judgment.js";

const NOW = "2026-11-12T12:00:00.000Z";
const RISK = ["low", "high"];
type Row = Record<string, unknown>;

const dist = (pairs: Array<[string, number]>): TypedAnswer => ({ kind: "distribution", distribution: pairs.map(([option, probability]) => ({ option, probability })) });

function row(patch: Partial<TypedAnswerRow> & Pick<TypedAnswerRow, "answer">): TypedAnswerRow {
  return { role: "risk", question: null, model: "model-a", source: "decisions", questionType: "choice", options: RISK,
    inputDigest: null, incumbent: null, outcome: null, ...patch };
}

function only(groups: readonly TypedAnswerScoreGroup[], model: string, role = "risk", source = "decisions"): TypedAnswerScoreGroup {
  const found = groups.filter((g) => g.model === model && g.role === role && g.source === source);
  assert.equal(found.length, 1, `one group for ${role} x ${model} x ${source}`);
  return found[0]!;
}

const near = (actual: number | null, expected: number, what: string): void => {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12, `${what}: ${actual} is not ${expected}`);
};

test("W1-T12414 criterion 1: a recorded answer is a distribution, a single answer, an abstention or a rejection, never coerced", () => {
  const clean = checkTypedAnswer(row({ answer: dist([["low", 0.7], ["high", 0.3]]) }));
  assert.deepEqual(clean, dist([["low", 0.7], ["high", 0.3]]));
  const slack = 1 - TYPED_JUDGMENT_SUM_TOLERANCE / 2;
  assert.deepEqual(checkTypedAnswer(row({ answer: dist([["low", slack], ["high", 0]]) })), dist([["low", slack], ["high", 0]]),
    "a sum inside the tolerance is kept as it was, not normalised");
  assert.deepEqual(checkTypedAnswer(row({ answer: { kind: "single", option: "high" } })), { kind: "single", option: "high" });
  assert.deepEqual(checkTypedAnswer(row({ answer: { kind: "abstained", reason: "refusal" } })), { kind: "abstained", reason: "refusal" });

  const outOfSet = checkTypedAnswer(row({ answer: dist([["low", 0.5], ["high", 0.3], ["medium", 0.2]]) }));
  assert.equal(outOfSet.kind, "rejected");
  assert.match((outOfSet as { reason: string }).reason, /medium was not declared/);
  const badSum = checkTypedAnswer(row({ answer: dist([["low", 0.6], ["high", 0.3]]) }));
  assert.equal(badSum.kind, "rejected");
  assert.match((badSum as { reason: string }).reason, /sums to 0\.900/);
  assert.equal(checkTypedAnswer(row({ answer: dist([["low", 1]]) })).kind, "rejected", "a declared option with no mass");
  assert.equal(checkTypedAnswer(row({ answer: { kind: "single", option: "medium" } })).kind, "rejected");

  const scores = scoreTypedAnswers([row({ answer: dist([["low", 0.5], ["high", 0.3], ["medium", 0.2]]), incumbent: "low", outcome: "low" })]);
  const group = only(scores.groups, "model-a");
  assert.equal(group.rejected, 1);
  assert.equal(group.distributions, 0, "the rejected distribution is not scored as a distribution");
  assert.equal(group.brier, null);
  assert.equal(scores.version, TYPED_ANSWER_SCORES_VERSION);

  // From the producer to the scorer: a choice may declare `true` and "true" as two options
  // (lib/decision-model.ts DecisionOptionValue). The reader keeps them two, so a valid
  // distribution over them is a distribution, not a rejection for a repeated option.
  const mixed: DecisionQuestion[] = [
    { type: "choice", name: "flag", instructions: "Which flag?", options: [{ value: true }, { value: "true" }, { value: "no" }] },
  ];
  const openAi = readDecisionAnswers("openai-decisions", mixed, { answers: [
    { type: "choice", choice: "true", probabilities: [{ value: true, probability: 0.2 }, { value: "true", probability: 0.7 }, { value: "no", probability: 0.1 }] },
  ] });
  assert.equal(openAi[0]!.outcome, "distribution", "the producer accepts the mixed options");
  const [flag] = decisionAnsweredTypedAnswers({ step: DECISION_ANSWERED_STEP, outcome: "answered", role: "risk", candidate: "model-m", answers: openAi });
  assert.deepEqual(flag!.options, ["boolean:true", "string:true", "string:no"], "two options with the same text keep their type");
  const checkedFlag = checkTypedAnswer(flag!);
  assert.equal(checkedFlag.kind, "distribution", "a valid mixed-type distribution is never rejected as a repeat");
  assert.deepEqual(checkedFlag, dist([["boolean:true", 0.2], ["string:true", 0.7], ["string:no", 0.1]]), "and is never coerced");
  const flagGroup = only(scoreTypedAnswers([{ ...flag!, outcome: "string:true" }]).groups, "model-m");
  assert.equal(flagGroup.rejected, 0);
  near(flagGroup.brier, 0.2 ** 2 + 0.3 ** 2 + 0.1 ** 2, "Brier keeps the two options apart");

  // A string option named like the cannot-tell option stays apart from the cannot-tell mass.
  const named: DecisionQuestion[] = [
    { type: "choice", name: "named", instructions: "Which?", options: [{ value: "cannot_tell" }, { value: "other" }] },
  ];
  const microsoft = readDecisionAnswers("microsoft-systemone", named, { answers: {
    named: { type: "choice", choice: "string:other", probabilities: { "string:cannot_tell": 0.4, "string:other": 0.6, cannot_tell: 0.1 } },
  } });
  assert.equal(microsoft[0]!.outcome, "distribution");
  const [namedRow] = decisionAnsweredTypedAnswers({ step: DECISION_ANSWERED_STEP, outcome: "answered", role: "risk", candidate: "model-m", answers: microsoft });
  assert.deepEqual(namedRow!.options, ["string:cannot_tell", "string:other", "cannot_tell"]);
  assert.equal(checkTypedAnswer(namedRow!).kind, "distribution");

  // Plain options keep their plain text, and a real repeat is still a rejection.
  const [plain] = decisionAnsweredTypedAnswers({ step: DECISION_ANSWERED_STEP, outcome: "answered", role: "risk", candidate: "model-m",
    answers: [{ name: "risk", outcome: "distribution", distribution: [{ option: "low", probability: 0.4 }, { option: "high", probability: 0.6 }], confidence: null }] });
  assert.deepEqual(plain!.options, ["low", "high"]);
  const [repeat] = decisionAnsweredTypedAnswers({ step: DECISION_ANSWERED_STEP, outcome: "answered", role: "risk", candidate: "model-m",
    answers: [{ name: "risk", outcome: "distribution", distribution: [{ option: "low", probability: 0.4 }, { option: "low", probability: 0.6 }], confidence: null }] });
  assert.equal(checkTypedAnswer(repeat!).kind, "rejected", "a repeated option is still rejected");
});

test("W1-T12414 criterion 2: per role and model the scorer counts answers, agreement, abstentions and rejections, and a single answer gets no Brier", () => {
  const rows = [
    row({ source: "generative", options: null, questionType: null, answer: { kind: "single", option: "low" }, incumbent: "low", outcome: "low" }),
    row({ source: "generative", options: null, questionType: null, answer: { kind: "single", option: "high" }, incumbent: "low", outcome: "low" }),
    row({ source: "generative", options: null, questionType: null, answer: { kind: "single", option: "low" }, incumbent: "low" }),
    row({ source: "generative", options: null, questionType: null, answer: { kind: "abstained", reason: "refusal" }, incumbent: "low" }),
    row({ source: "generative", options: null, questionType: null, answer: { kind: "rejected", reason: "no answer line" }, incumbent: "high" }),
  ];
  const group = only(scoreTypedAnswers(rows).groups, "model-a", "risk", "generative");
  assert.equal(group.answers, 5);
  assert.equal(group.singles, 3);
  assert.deepEqual(group.agreement, { compared: 3, agreed: 2, rate: 2 / 3 });
  assert.equal(group.abstained, 1);
  assert.equal(group.abstentionRate, 1 / 5);
  assert.equal(group.rejected, 1);
  assert.equal(group.rejectionRate, 1 / 5);
  assert.equal(group.brier, null, "a single answer counts toward agreement only");
  assert.equal(group.logLoss, null);
  assert.equal(group.outcomes.scored, 0);
  assert.equal(group.buckets.length, 0);
});

test("W1-T12414 criterion 3: a distribution with a known outcome gets a multi-class Brier and a clamped log-loss, and one without is only counted", () => {
  const options = ["a", "b", "c"];
  const scored = scoreTypedAnswers([row({ options, answer: dist([["a", 0.7], ["b", 0.2], ["c", 0.1]]), outcome: "b" })]);
  const one = only(scored.groups, "model-a");
  near(one.brier, 0.7 ** 2 + 0.8 ** 2 + 0.1 ** 2, "Brier sums over every option");
  near(one.logLoss, -Math.log(0.2), "log-loss");

  const zero = only(scoreTypedAnswers([row({ options, answer: dist([["a", 1], ["b", 0], ["c", 0]]), outcome: "c" })]).groups, "model-a");
  near(zero.logLoss, -Math.log(LOG_LOSS_FLOOR), "a zero probability is clamped away from zero");
  near(zero.brier, 2, "a confident miss");

  const unknown = only(scoreTypedAnswers([
    row({ options, answer: dist([["a", 0.9], ["b", 0.05], ["c", 0.05]]), incumbent: "b" }),
  ]).groups, "model-a");
  assert.equal(unknown.distributions, 1);
  assert.deepEqual(unknown.outcomes, { scored: 0, unknown: 1, notDeclared: 0 });
  assert.equal(unknown.brier, null, "the current judge's answer is not an outcome");
  assert.equal(unknown.logLoss, null);
  assert.deepEqual(unknown.agreement, { compared: 1, agreed: 0, rate: 0 }, "it still counts toward agreement");
});

test("W1-T12414 criterion 4: a score question is scored on its 2 to 10 levels, and an abstention is its own outcome, never a wrong answer", () => {
  const sizes: DecisionQuestion[] = [
    { type: "score", name: "size", instructions: "How big is the change?", levels: ["tiny", "small", "medium", "large"].map((label) => ({ label })) },
    { type: "choice", name: "risk", instructions: "How risky is the change?", options: [{ value: "low" }, { value: "high" }] },
    { type: "choice", name: "scope", instructions: "Is it in scope?", options: [{ value: "in" }, { value: "out" }] },
  ];
  const envelope = { answers: {
    size: { type: "score", score: 0.2, confidence: 0.9, legend: { 0: "tiny", 1: "small", 2: "medium", 3: "large" },
      probabilities: { 0: 0.1, 1: 0.6, 2: 0.2, 3: 0.1 } },
    risk: { type: "choice", choice: "cannot_tell", probabilities: { "string:low": 0.1, "string:high": 0.1, cannot_tell: 0.8 } },
    scope: { type: "choice", choice: "string:in", confidence: 0.5, probabilities: { "string:in": 0.6, "string:out": 0.4, cannot_tell: 0.5 } },
  } };
  const answers = readDecisionAnswers("microsoft-systemone", sizes, envelope);
  const recorded = decisionAnsweredTypedAnswers({ step: DECISION_ANSWERED_STEP, outcome: "answered", role: "review", candidate: "model-d", answers });
  assert.equal(recorded.length, 3);
  const size = recorded.find((r) => r.question === "size")!;
  assert.equal(size.questionType, "score");
  assert.deepEqual(size.options, ["tiny", "small", "medium", "large"]);
  const scored = only(scoreTypedAnswers([{ ...size, outcome: "medium" }]).groups, "model-d", "review");
  near(scored.brier, 0.1 ** 2 + 0.6 ** 2 + 0.8 ** 2 + 0.1 ** 2, "Brier over the levels");
  near(scored.logLoss, -Math.log(0.2), "log-loss on the outcome level");

  const tooFew = checkTypedAnswer({ ...size, options: ["only"], answer: dist([["only", 1]]) });
  assert.equal(tooFew.kind, "rejected");
  const eleven = Array.from({ length: 11 }, (_, i) => `level-${i}`);
  assert.equal(checkTypedAnswer({ ...size, options: eleven, answer: dist(eleven.map((l, i) => [l, i === 0 ? 1 : 0])) }).kind, "rejected");
  const ten = eleven.slice(0, 10);
  assert.equal(checkTypedAnswer({ ...size, options: ten, answer: dist(ten.map((l, i) => [l, i === 0 ? 1 : 0])) }).kind, "distribution");

  const risk = recorded.find((r) => r.question === "risk")!;
  assert.deepEqual(risk.answer, { kind: "abstained", reason: "cannot-tell" }, "a declared cannot-tell answer is an abstention");
  const scope = recorded.find((r) => r.question === "scope")!;
  assert.equal(scope.abstainOption, "cannot_tell");
  const abstentions = scoreTypedAnswers([
    { ...risk, incumbent: "low", outcome: "low" },
    { ...scope, incumbent: "in", outcome: "in" },
    row({ role: "review", question: "risk", model: "model-d", answer: { kind: "abstained", reason: "refusal" }, incumbent: "low", outcome: "low" }),
    row({ role: "review", question: "risk", model: "model-d", answer: { kind: "single", option: "cannot_tell" }, options: ["low", "high", "cannot_tell"],
      abstainOption: "cannot_tell", incumbent: "low", outcome: "low" }),
  ]);
  const riskGroup = only(abstentions.groups.filter((g) => g.question === "risk"), "model-d", "review");
  assert.equal(riskGroup.abstained, 3, "a native refusal, a cannot-tell choice and a cannot-tell single answer");
  assert.equal(riskGroup.agreement.compared, 0, "an abstention is never compared as a wrong answer");
  assert.equal(riskGroup.outcomes.scored, 0, "and never scored");
  assert.equal(riskGroup.brier, null);
  const scopeGroup = only(abstentions.groups.filter((g) => g.question === "scope"), "model-d", "review");
  assert.equal(scopeGroup.abstained, 1, "a distribution whose top option is cannot-tell is an abstention");
  assert.equal(scopeGroup.distributions, 0);
});

test("W1-T12414 criterion 5: the calibration buckets group distributions by their top option's probability", () => {
  const rows = [
    row({ answer: dist([["low", 0.95], ["high", 0.05]]), outcome: "low" }),
    row({ answer: dist([["low", 0.08], ["high", 0.92]]), outcome: "low" }),
    row({ answer: dist([["low", 0.55], ["high", 0.45]]), outcome: "low" }),
    row({ answer: dist([["low", 0.6], ["high", 0.4]]) }),
  ];
  const group = only(scoreTypedAnswers(rows).groups, "model-a");
  assert.equal(group.buckets.length, 10);
  const top = group.buckets[9]!;
  assert.equal(top.lo, 0.9);
  assert.equal(top.count, 2);
  near(top.meanForecast, (0.95 + 0.92) / 2, "mean probability of the top option");
  near(top.observedRate, 0.5, "observed rate: the share whose top option was the outcome");
  const middle = group.buckets[5]!;
  assert.equal(middle.count, 1, "a distribution with no outcome is not in a bucket");
  near(middle.meanForecast, 0.55, "mean");
  near(middle.observedRate, 1, "rate");
  assert.equal(group.buckets.reduce((sum, b) => sum + b.count, 0), 3);
  assert.equal(scoreTypedAnswers(rows, { bins: 4 }).groups[0]!.buckets.length, 4);
  assert.throws(() => scoreTypedAnswers(rows, { bins: 0 }), RangeError);
});

test("W1-T12414 criterion 6: every figure is keyed by role and model id, two models are never pooled, and a model with no rows has no figure", () => {
  const rows = [
    row({ model: "model-a", answer: dist([["low", 0.9], ["high", 0.1]]), incumbent: "low", outcome: "low" }),
    row({ model: "model-b", answer: dist([["low", 0.2], ["high", 0.8]]), incumbent: "low", outcome: "low" }),
    row({ model: "model-a", role: "verify-human", options: ["automate", "keep"], answer: dist([["automate", 1], ["keep", 0]]), incumbent: "keep" }),
    row({ model: "model-a", source: "generative", options: null, questionType: null, answer: { kind: "single", option: "high" }, incumbent: "low" }),
  ];
  const { groups } = scoreTypedAnswers(rows);
  assert.equal(groups.length, 4);
  const a = only(groups, "model-a");
  const b = only(groups, "model-b");
  near(a.brier, 0.01 * 2, "model-a alone");
  near(b.brier, 0.64 * 2, "model-b alone");
  assert.deepEqual(a.agreement, { compared: 1, agreed: 1, rate: 1 });
  assert.deepEqual(b.agreement, { compared: 1, agreed: 0, rate: 0 });
  assert.deepEqual(only(groups, "model-a", "verify-human").agreement, { compared: 1, agreed: 0, rate: 0 });
  assert.deepEqual(only(groups, "model-a", "risk", "generative").agreement, { compared: 1, agreed: 0, rate: 0 },
    "the same model id generating text is its own group");
  assert.equal(groups.some((g) => g.model === "model-c"), false);
  assert.equal(scoreTypedAnswers([]).groups.length, 0);
});

function shadowRow(i: number, surface: string, shadowModel: string, primary: unknown, shadow: unknown): Row {
  return { ts: `2026-11-12T10:${String(i).padStart(2, "0")}:00.000Z`, step: "shadow_judge.paired", run_id: `run-${i}`, surface,
    decision_key: `key-${i}`, primary_model: "judge-p", shadow_model: shadowModel, primary_decision: primary, shadow_decision: shadow,
    agreement: JSON.stringify(primary) === JSON.stringify(shadow) };
}

function fakeResponse() {
  let body = "";
  const res = { statusCode: 0, setHeader() {}, writeHead() { return this; }, end(chunk?: string) { body = chunk ?? ""; } } as unknown as ServerResponse;
  return { res, body: () => body };
}

test("W1-T12414 criterion 7: the judge calibration body folds the live shadow_judge.paired rows through the scorer", async () => {
  const verdicts = [
    { pass: true, review: "PASS" }, { pass: false, review: "FAIL" },
  ];
  const rows: Row[] = [
    shadowRow(1, "risk", "shadow-x", "low", "low"),
    shadowRow(2, "risk", "shadow-x", "low", "high"),
    shadowRow(3, "risk", "shadow-y", "high", "high"),
    shadowRow(4, "review", "shadow-x", verdicts, verdicts),
    { ts: "2026-11-12T10:05:00.000Z", step: "shadow_judge.unavailable", surface: "risk", shadow_model: "shadow-x", reason: "timeout" },
    { ts: "2026-11-12T10:06:00.000Z", step: DECISION_ANSWERED_STEP, run_id: "decision-1", outcome: "answered", role: "risk", candidate: "model-d",
      answers: [{ name: "risk", outcome: "distribution", distribution: [{ option: "low", probability: 0.8 }, { option: "high", probability: 0.2 }], confidence: 0.8 }] },
  ];
  const calibration = deriveJudgeCalibration(rows, { asOf: NOW, labels: { labels: [] } });
  const groups = calibration.typedAnswerScores.groups;
  assert.deepEqual(only(groups, "shadow-x", "risk", "generative").agreement, { compared: 2, agreed: 1, rate: 0.5 });
  assert.deepEqual(only(groups, "shadow-y", "risk", "generative").agreement, { compared: 1, agreed: 1, rate: 1 });
  assert.deepEqual(only(groups, "shadow-x", "review", "generative").agreement, { compared: 1, agreed: 1, rate: 1 });
  assert.equal(only(groups, "model-d", "risk", "decisions").distributions, 1);
  assert.equal(only(groups, "shadow-x", "risk", "generative").answers, 2, "an unavailable shadow is not an answer");

  const snapshot = deriveAnalyticsSnapshot(rows, NOW, { judgeLabels: { labels: [] } });
  const route = buildAnalyticsRoute({ currentSnapshot: () => snapshot });
  const served = fakeResponse();
  await route.handler({ url: `/v1/analytics?projectionVersion=${JUDGE_CALIBRATION_VERSION}` } as never, served.res, { params: {} });
  const body = JSON.parse(served.body()) as JudgeCalibration;
  assert.equal(body.state, "unavailable", "no review or risk verdict rows in this ledger");
  assert.deepEqual(body.typedAnswerScores, JSON.parse(JSON.stringify(calibration.typedAnswerScores)), "the served body carries the scores");

  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}typed-answer-scores-`));
  try {
    writeFileSync(join(dir, "ledger.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const clock = fixedClock(Date.parse(NOW));
    const options = { judgeLabels: { labels: [] } };
    const first = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock, undefined, undefined, options);
    assert.deepEqual(first.snapshot.judgeCalibration?.typedAnswerScores, calibration.typedAnswerScores);
    const prior = JSON.parse(JSON.stringify(first.checkpoint)) as AnalyticsCheckpoint;
    const resumed = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock, undefined, prior, options);
    assert.equal(resumed.scan?.mode, "resume");
    assert.deepEqual(resumed.snapshot.judgeCalibration?.typedAnswerScores, calibration.typedAnswerScores, "the checkpoint round-trips the answers");
    const older = JSON.parse(JSON.stringify(first.checkpoint)) as AnalyticsCheckpoint;
    delete (older.state.judgeCalibrationFold as Row).typedAnswers;
    const rescanned = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock, undefined, older, options);
    assert.notEqual(rescanned.scan?.mode, "resume", "a checkpoint from before the answers forces a full scan");
    assert.deepEqual(rescanned.snapshot.judgeCalibration?.typedAnswerScores, calibration.typedAnswerScores, "never an empty score");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
