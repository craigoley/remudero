/**
 * W1-T12420: a model's surface is part of its key. One deployment name (gpt-6-luna) serves worker
 * text on one resource and Decisions on another, so the 404 absence mark and every typed-answer
 * figure are keyed by model id AND surface. A caller that names no surface is on the text surface.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import { DEFAULT_CASH_KEY_ENV } from "#src/lib/config-schema.js";
import { DECISION_ANSWERED_STEP, askDecisionModel } from "#src/lib/decision-model.js";
import { emptyRepoStore } from "#src/lib/field-trials-github.js";
import { buildFieldTrialsFlowSnapshot, readFieldTrialsLedger } from "#src/lib/field-trials-flow.js";
import { deriveJudgeCalibration, judgeCalibrationRow } from "#src/lib/judge-calibration.js";
import type { DecisionCandidate } from "#src/lib/mounts.js";
import { readLedgerLines } from "#src/lib/status.js";
import { decisionAnsweredTypedAnswers, scoreTypedAnswers, typedAnswerKey, type TypedAnswerRow } from "#src/lib/typed-answer-scores.js";
import {
  OPENWEIGHT_ABSENT_TTL_MS,
  clearOpenWeightAbsence,
  markOpenWeightDeploymentAbsent,
  openWeightAbsenceKey,
  openWeightDeploymentKnownAbsent,
  openWeightDeploymentReady,
  sendCashRequest,
} from "#src/lib/worker-provider.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const LUNA = "gpt-6-luna";
const T0 = Date.parse("2026-11-12T15:40:00.000Z");
const env = { [DEFAULT_CASH_KEY_ENV]: "fixture-default-key-never-printed", RMD_CASH_EASTUS_API_KEY: "fixture-eastus-key-never-printed",
  RMD_CASH_WORKER_API_KEY: "fixture-worker-key-never-printed" };
const PRICE = { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.05, readAt: "2026-11-12", source: "fixture page" };
/** The operator's probe 2: the East US Decisions deployment has the worker deployment's name. */
const decisions: DecisionCandidate = { name: LUNA, deployment: LUNA, shape: "openai-decisions",
  endpoint: { source: "cash-entry", entry: "eastus" }, price: PRICE };
const QUESTIONS = [{ type: "yes-no", name: "docs_only", instructions: "Does the change touch only docs?" }];
const INPUT = "PR 1: changes docs/readme.md only.";

function fixture(t: TestContext): { dir: string; config: Config } {
  clearOpenWeightAbsence();
  t.after(() => clearOpenWeightAbsence());
  const { dir } = ownedFixtureDir(t, "model-surface");
  return { dir, config: { claudeBin: "/unused", root: dir, dailyCapUsd: 25, workerProviders: {
    cashEndpoint: "https://eastus2.example.test/",
    cashDeploymentEndpoints: {
      [LUNA]: { endpoint: "https://eastus2.cognitiveservices.azure.com/", keyEnv: "RMD_CASH_WORKER_API_KEY" },
      eastus: { endpoint: "https://eastus.cognitiveservices.azure.com/", keyEnv: "RMD_CASH_EASTUS_API_KEY" },
    } } } as Config };
}

function counting(status: number): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  return { calls: () => calls, fetchImpl: async () => { calls++; return new Response("{}", { status }); } };
}

/** A worker-shaped cash request: it names no surface and no target, as every worker path does. */
const workerRequest = (config: Config, fetchImpl: typeof fetch, nowMs = T0) => sendCashRequest(config, {
  deployment: LUNA, path: "openai/v1/responses", body: JSON.stringify({ model: LUNA, input: "hi" }), source: "fixture-worker",
  outputTokenCeiling: 64, env, fetchImpl, clock: fixedClock(nowMs) });

const ask = (config: Config, fetchImpl: typeof fetch, nowMs = T0) => askDecisionModel(config, {
  role: "risk", candidate: decisions, input: INPUT, questions: QUESTIONS, env, fetchImpl, clock: fixedClock(nowMs) });

test("W1-T12420 criterion 1: a decisions 404 on gpt-6-luna leaves the worker deployment gpt-6-luna ready", async (t) => {
  const { config } = fixture(t);
  assert.equal(openWeightDeploymentReady(LUNA, T0), true, "the worker deployment starts ready");
  const notFound = counting(404);
  const row = await ask(config, notFound.fetchImpl);
  assert.deepEqual([row.outcome, row.reason, row.status, notFound.calls()], ["failed", "deployment-absent", 404, 1]);
  assert.equal(openWeightDeploymentReady(LUNA, T0 + 1), true, "cash selection still takes the worker deployment");
  assert.equal(openWeightDeploymentKnownAbsent(LUNA, T0 + 1), false);

  // The surface alone separates them, even for a decisions caller with no endpoint of its own.
  const bare = await sendCashRequest(config, { deployment: LUNA, path: "openai/v1/decisions", body: "{}", source: "fixture-decisions",
    outputTokenCeiling: 64, env, fetchImpl: notFound.fetchImpl, clock: fixedClock(T0), surface: "decisions" });
  assert.equal(bare.ok ? "ok" : bare.reason, "deployment-absent");
  assert.equal(openWeightDeploymentKnownAbsent(LUNA, T0 + 1, { surface: "decisions" }), true);
  assert.equal(openWeightDeploymentReady(LUNA, T0 + 1), true, "a decisions 404 never marks the text surface");
  assert.notEqual(openWeightAbsenceKey(LUNA, "decisions"), openWeightAbsenceKey(LUNA, "text"));
});

test("W1-T12420 criterion 2: a worker 404 on gpt-6-luna still lets a decisions request go, and a second decisions 404 sends nothing", async (t) => {
  const { config } = fixture(t);
  const notFound = counting(404);
  const worker = await workerRequest(config, notFound.fetchImpl);
  assert.equal(worker.ok ? "ok" : worker.reason, "deployment-absent");
  assert.equal(openWeightDeploymentReady(LUNA, T0 + 1), false, "the worker 404 marks the worker deployment");
  markOpenWeightDeploymentAbsent(LUNA, T0); // and the worker ladder's own mark (lib/worker.ts) on the same entry

  const first = await ask(config, notFound.fetchImpl, T0 + 1);
  assert.equal(notFound.calls(), 2, "the decisions request is still sent");
  assert.deepEqual([first.reason, first.status], ["deployment-absent", 404]);
  const second = await ask(config, notFound.fetchImpl, T0 + OPENWEIGHT_ABSENT_TTL_MS - 1);
  assert.equal(notFound.calls(), 2, "a second decisions request inside the absent window sends nothing");
  assert.equal(second.reason, "deployment-absent");
  assert.equal(second.status, undefined, "refused before transport");
});

test("W1-T12420 criterion 3: a caller that names no surface marks, reads and clears the text surface exactly as before", async (t) => {
  const { config } = fixture(t);
  assert.equal(openWeightAbsenceKey(LUNA, "text"), LUNA, "the text key is the deployment name, the key of every worker path");
  markOpenWeightDeploymentAbsent(LUNA, T0);
  assert.equal(openWeightDeploymentKnownAbsent(LUNA, T0 + 1), true);
  assert.equal(openWeightDeploymentKnownAbsent(LUNA, T0 + 1, { surface: "text" }), true);
  assert.equal(openWeightDeploymentKnownAbsent(LUNA, T0 + 1, { surface: "decisions" }), false);
  assert.equal(openWeightDeploymentReady(LUNA, T0 + 1), false);
  assert.equal(openWeightDeploymentReady(LUNA, T0 + OPENWEIGHT_ABSENT_TTL_MS), true, "the mark lasts its window, as before");
  clearOpenWeightAbsence();
  assert.equal(openWeightDeploymentReady(LUNA, T0 + 1), true);

  const notFound = counting(404);
  await workerRequest(config, notFound.fetchImpl);
  assert.equal(openWeightDeploymentKnownAbsent(LUNA, T0 + 1), true, "a request with no surface marks the text surface");
  const again = await workerRequest(config, notFound.fetchImpl, T0 + 1);
  assert.deepEqual([again.ok ? "ok" : again.reason, notFound.calls()], ["deployment-absent", 1], "and reads it before transport");
  clearOpenWeightAbsence();
  assert.equal(openWeightDeploymentReady(LUNA, T0 + 1), true, "clearing clears the text surface");
});

test("W1-T12420 criterion 4: a decision.answered row carries model_surface decisions and a mapped shadow row carries text", async (t) => {
  const { dir, config } = fixture(t);
  const reply = async () => new Response(JSON.stringify({ model: LUNA, answers: [{ type: "predicate", name: "docs_only", probability: 0.9 }],
    usage: { input_tokens: 10, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
  const answered = await ask(config, reply);
  const refused = await askDecisionModel(config, { role: "risk", candidate: decisions, input: "", questions: QUESTIONS, env });
  assert.deepEqual([answered.outcome, answered.model_surface, refused.outcome, refused.model_surface],
    ["answered", "decisions", "refused", "decisions"]);
  const rows = readLedgerLines(join(dir, "state", "ledger.ndjson")).filter((row) => row.step === DECISION_ANSWERED_STEP);
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.model_surface, "decisions", "every written decision.answered row names its surface");
  assert.deepEqual(decisionAnsweredTypedAnswers(rows[0]!).map((r) => r.modelSurface), ["decisions"]);
  const legacy = { ...rows[0]! };
  delete legacy.model_surface;
  assert.deepEqual(decisionAnsweredTypedAnswers(legacy).map((r) => r.modelSurface), ["decisions"], "a row with no field reads as decisions by its step");

  const shadow = { ts: "2026-11-12T10:00:00.000Z", step: "shadow_judge.paired", run_id: "run-1", surface: "risk", decision_key: "k-1",
    primary_model: "judge-p", shadow_model: LUNA, primary_decision: "low", shadow_decision: "high", agreement: false };
  const mapped = judgeCalibrationRow(shadow)!.typed_answers as TypedAnswerRow[];
  assert.deepEqual(mapped.map((r) => [r.source, r.modelSurface]), [["generative", "text"]]);
});

test("W1-T12420 criterion 5: typed-answer figures are keyed by role, model id and surface, so two surfaces of one model never pool", () => {
  const base = { role: "risk", question: null, model: LUNA, questionType: "choice" as const, options: ["low", "high"],
    inputDigest: null, incumbent: "low", outcome: null };
  const rows: TypedAnswerRow[] = [
    { ...base, source: "decisions", modelSurface: "decisions", answer: { kind: "distribution", distribution: [{ option: "low", probability: 0.8 }, { option: "high", probability: 0.2 }] } },
    { ...base, source: "generative", modelSurface: "text", answer: { kind: "single", option: "high" } },
  ];
  const { groups } = scoreTypedAnswers(rows);
  assert.equal(groups.length, 2, "a Decisions distribution and a generated answer from one model id in one role are two figures");
  const bySurface = Object.fromEntries(groups.map((g) => [g.modelSurface, g]));
  assert.deepEqual([bySurface.decisions!.distributions, bySurface.decisions!.agreement.rate], [1, 1]);
  assert.deepEqual([bySurface.text!.singles, bySurface.text!.agreement.rate], [1, 0]);
  assert.notEqual(typedAnswerKey("risk", LUNA, "decisions", null), typedAnswerKey("risk", LUNA, "text", null));

  // The same through the live readers: a decision.answered row and a shadow row from one model id.
  const calibration = deriveJudgeCalibration([
    { ts: "2026-11-12T10:00:00.000Z", step: "shadow_judge.paired", run_id: "run-1", surface: "risk", decision_key: "k-1",
      primary_model: "judge-p", shadow_model: LUNA, primary_decision: "low", shadow_decision: "low", agreement: true },
    { ts: "2026-11-12T10:01:00.000Z", step: DECISION_ANSWERED_STEP, run_id: "decision-1", outcome: "answered", role: "risk", candidate: LUNA,
      model_surface: "decisions", answers: [{ name: "risk", outcome: "distribution", distribution: [{ option: "low", probability: 0.7 }, { option: "high", probability: 0.3 }] }] },
  ], { asOf: "2026-11-12T12:00:00.000Z", labels: { labels: [] } });
  const luna = calibration.typedAnswerScores.groups.filter((g) => g.model === LUNA && g.role === "risk");
  assert.deepEqual(luna.map((g) => g.modelSurface).sort(), ["decisions", "text"]);
});

test("W1-T12420 criterion 6: a decision.answered row served by gpt-6-luna leaves the field-trials figures for gpt-6-luna the same", async (t) => {
  const { dir } = ownedFixtureDir(t, "model-surface-trials");
  const at = (hour: number) => new Date(Date.UTC(2026, 10, 10, hour)).toISOString();
  const stack = Object.fromEntries(["harness", "prompt", "tool", "scorer", "environment"]
    .map((field, i) => [`${field}Revision`, { state: "observed", value: String(i + 1).repeat(40) }]));
  const worker = [
    { ts: at(1), step: "run.start", host: "h", actor: "daemon", task_id: "task-1", run_id: "run-1" },
    { ts: at(2), step: "worker.assignment", host: "h", actor: "daemon", task_id: "task-1", run_id: "run-1",
      worker_assignment: { id: "asg-1", requested: { model: LUNA }, selected: { provider: "cash", model: LUNA, effort: "medium" } },
      benchmark_run: { work: { taskClass: { state: "observed", value: "implement" }, risk: { state: "observed", value: "medium" },
        shape: { lane: { state: "observed", value: "build" } } }, stack } },
    { ts: at(3), step: "worker.attempt", host: "h", actor: "daemon", task_id: "task-1", run_id: "run-1",
      selection_assignment_id: "asg-1", served_model: LUNA, success: true, lane: "build" },
    { ts: at(4), step: "fix.done", host: "h", actor: "daemon", task_id: "task-1", run_id: "run-1", requested_model: LUNA },
  ];
  const decision = { ts: at(3), step: DECISION_ANSWERED_STEP, actor: "DECISIONS", run_id: "decision-1", role: "risk", candidate: LUNA,
    deployment: LUNA, model_surface: "decisions", outcome: "answered", served_model: LUNA, task_id: "task-1",
    answers: [{ name: "docs_only", outcome: "distribution", distribution: [{ option: true, probability: 0.9 }, { option: false, probability: 0.1 }] }] };
  const snapshotOf = async (rows: Array<Record<string, unknown>>, name: string) => {
    const stateDir = join(dir, name);
    writeLedger(rows, { dir: stateDir });
    const ledger = await readFieldTrialsLedger(stateDir, Date.parse(at(12)));
    return { ledger, snapshot: buildFieldTrialsFlowSnapshot({ asOf: at(12), sources: [{ label: "core", repo: "acme/core", ledger }],
      github: { version: "field-trials-github-v1", repos: { "acme/core": emptyRepoStore() } } }) };
  };
  const without = await snapshotOf(worker, "without");
  const withDecision = await snapshotOf([...worker, decision], "with");
  // W1-T12423: the snapshot reads the Decisions row as a judge row, and it enters the judge family only.
  assert.deepEqual(withDecision.ledger.rows.filter((row) => row.step === DECISION_ANSWERED_STEP).map((row) => row.judge !== undefined), [true]);
  assert.deepEqual(Object.values(withDecision.snapshot.families.judges).map((partition) => [partition.cells.model, partition.cells.modelSurface]),
    [[LUNA, "decisions"]]);
  assert.deepEqual(withDecision.snapshot.families.funnel, without.snapshot.families.funnel);
  assert.deepEqual(withDecision.snapshot.families.adoption, without.snapshot.families.adoption);
  assert.deepEqual(withDecision.snapshot.families.guardrails, without.snapshot.families.guardrails);
  assert.deepEqual(withDecision.snapshot.servedTrialCohorts, without.snapshot.servedTrialCohorts);
  assert.ok(JSON.stringify(without.snapshot.families.adoption).includes(LUNA), "the fixture has gpt-6-luna figures to compare");
});
