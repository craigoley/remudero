/**
 * W1-T15164 — a judge shadow row whose primary gave no answer is counted apart, never as a disagreement, so a decision
 * model's agreement reads only the pairs where both answered. Every decision request here is a fake: no network and no
 * paid call runs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import {
  judgeShadowPrimaryUnanswered, judgeShadowSwitchCandidate, judgeShadowThresholds, judgeShadowTypedAnswers, JUDGE_SWITCH_BAR, type ConfigInventory,
} from "#src/lib/config-gardener.js";
import type { askDecisionModel, DecisionAnsweredRow } from "#src/lib/decision-model.js";
import { shadowJudgeCall, type ShadowJudgeCall } from "#src/lib/judge-shadow.js";
import { loadMounts, mountsPath, type DecisionCandidate, type JudgeMount } from "#src/lib/mounts.js";
import { scoreTypedAnswers } from "#src/lib/typed-answer-scores.js";
import type { SpawnWorkerArgs } from "#src/lib/worker.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const NOW = Date.parse("2026-11-28T12:00:00.000Z");
const ISO = fixedClock(NOW).iso();
const WINDOW = NOW - 14 * 24 * 3600 * 1000;
const CANDIDATE: DecisionCandidate = loadMounts(mountsPath(REPO_ROOT)).decision_models!["decisions-eastus"]!;
const decisionsArm = { provider: "decisions" as const, deployment: CANDIDATE.deployment, candidate: CANDIDATE };
const mount: JudgeMount = { model: "haiku", effort: "low", maxTurns: 400, contextBudget: 60000, shadow: decisionsArm };
type DecisionShadowDeps = NonNullable<ShadowJudgeCall<unknown>["decisions"]>;

function answered(low: number): DecisionAnsweredRow {
  return { role: "risk-judge", input_digest: "d", candidate: CANDIDATE.name, deployment: CANDIDATE.deployment, shape: CANDIDATE.shape,
    model_surface: "decisions", outcome: "answered", served_model: "gpt-6-luna", latency_ms: 332, reserved_usd: 0.002, settled_usd: 0.0004,
    held_usd: 0, usage: { input_tokens: 4000, output_tokens: 0 }, question_count: 1,
    answers: [{ name: "risk_judge", outcome: "distribution", confidence: null,
      distribution: [{ option: "low", probability: low }, { option: "high", probability: 1 - low }] }] };
}

function deps(reply: DecisionAnsweredRow): DecisionShadowDeps {
  return {
    config: () => ({ claudeBin: "/unused", root: "/unused", workerProviders: { cashDeploymentEndpoints: {
      "gpt-6.1-terra": { endpoint: "https://fixture.cognitiveservices.azure.com/", keyEnv: "RMD_FIXTURE_DECISION_KEY" } } } }) as Config,
    env: { RMD_FIXTURE_DECISION_KEY: "fixture-key-never-printed" },
    ask: async (_config: Config, _request: Parameters<typeof askDecisionModel>[1]) => reply,
    learnedLimit: () => undefined,
  };
}

/** One risk-judge shadow call, its rows written to `rows`; `primaryAnswer` absent is a judge that gave no answer. */
async function shadowRow(primaryAnswer: { verdict: string } | undefined, low: number): Promise<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const call: ShadowJudgeCall<{ verdict: string }> = {
    role: "risk-judge", key: "PR7@abc1234", mount, primaryArgs: { cwd: REPO_ROOT, prompt: "judge this change", tools: [] } as unknown as SpawnWorkerArgs,
    primary: { costUsd: 0.003, servedModel: "claude-haiku-5-5" }, primaryAnswer, parse: () => undefined,
    agreementKey: (v) => v.verdict, head: { sha: "abc1234" }, spawn: async () => { throw new Error("a decision shadow spawns no worker"); },
    log: (step, fields = {}) => { rows.push({ step, ...fields }); }, decisions: deps(answered(low)),
  };
  await shadowJudgeCall(call);
  assert.equal(rows.length, 1);
  return rows[0]!;
}

/** Decision rows for refresh-value: `agreeing` answered pairs that agree at top 0.9, `unanswered` with no primary answer. */
function decided(agreeing: number, unanswered: number, form: "new" | "old"): Array<Record<string, unknown>> {
  const distribution = [{ option: "overlap", probability: 0.1 }, { option: "independent", probability: 0.9 }];
  const both = Array.from({ length: agreeing }, () => ({ ts: ISO, step: "judge_shadow.compared", role: "refresh-value", shadow_model: "decisions-eastus",
    model_surface: "decisions", distribution, primary_answer: "independent", shadow_answer: "independent", agreement: true }));
  const none = Array.from({ length: unanswered }, () => ({ ts: ISO, step: "judge_shadow.compared", role: "refresh-value", shadow_model: "decisions-eastus",
    model_surface: "decisions", distribution, primary_answer: null, shadow_answer: "independent",
    ...(form === "new" ? { agreement: null, primary_unanswered: true } : { agreement: false }) }));
  return [...both, ...none];
}

function inventory(rows: Array<Record<string, unknown>>): ConfigInventory {
  return { nowIso: ISO, runs: [], queued: [], recommendations: [], active: [], cooling: [],
    judgeShadowScores: scoreTypedAnswers(judgeShadowTypedAnswers(rows, WINDOW)).groups,
    judgeShadowThresholds: judgeShadowThresholds(rows, WINDOW),
    judgeShadowPrimaryUnanswered: judgeShadowPrimaryUnanswered(rows, WINDOW) };
}

test("W1-T15164 criterion 1: a decision-arm compared row whose primary gave no answer writes agreement null and primary_unanswered true, never agreement false", async () => {
  const row = await shadowRow(undefined, 0.2);
  assert.equal(row.step, "judge_shadow.compared");
  assert.equal(row.primary_answer, null);
  assert.equal(row.shadow_answer, "high");
  assert.equal(row.agreement, null);
  assert.equal(row.primary_unanswered, true);
});

test("W1-T15164 criterion 2: judgeShadowThresholds and the switch-bar count leave primary-unanswered rows out of the agreement share and report their count separately", () => {
  const n = JUDGE_SWITCH_BAR.minCompared;
  for (const form of ["new", "old"] as const) {
    const rows = decided(n, 2 * n, form);
    // The switch bar reads only the answered pairs: all agree.
    const scores = inventory(rows).judgeShadowScores!;
    assert.equal(scores.length, 1, form);
    assert.equal(scores[0]!.agreement.compared, n, form);
    assert.equal(scores[0]!.agreement.agreed, n, form);
    assert.equal(scores[0]!.answers, n, form);
    // The threshold figure is drawn from the answered pairs and names the rows it left out.
    assert.deepEqual(judgeShadowThresholds(rows, WINDOW), [{ role: "refresh-value", model: "decisions-eastus", surface: "decisions", value: 0.9, primaryUnanswered: 2 * n }], form);
    assert.deepEqual(judgeShadowPrimaryUnanswered(rows, WINDOW), [{ role: "refresh-value", model: "decisions-eastus", surface: "decisions", count: 2 * n }], form);
    // The gardener's switch proposal states the count beside the agreement share.
    const action = judgeShadowSwitchCandidate(inventory(rows), REPO_ROOT);
    assert.ok(action !== undefined, form);
    assert.match(action.reason, /agreed on 100\.0% of \d+ compared calls/);
    assert.match(action.reason, new RegExp(`and ${2 * n} calls whose own judge gave no answer are counted apart`));
  }
  // Outside the window nothing is counted.
  assert.deepEqual(judgeShadowPrimaryUnanswered(decided(0, 3, "new"), NOW + 1), []);
});

test("W1-T15164 criterion 3: invariant:answered-pairs-unchanged — a row where both answered keeps agreement equal to primary === shadow, and its count is unchanged", async () => {
  const agree = await shadowRow({ verdict: "low" }, 0.8);
  assert.equal(agree.agreement, true);
  assert.equal(agree.primary_unanswered, undefined);
  const differ = await shadowRow({ verdict: "low" }, 0.2);
  assert.equal(differ.primary_answer, "low");
  assert.equal(differ.agreement, false);
  assert.equal(differ.primary_unanswered, undefined);
  // Answered rows alone: the same figures as before, and no count of rows left out.
  const n = JUDGE_SWITCH_BAR.minCompared;
  const rows = decided(n, 0, "new");
  assert.deepEqual(judgeShadowThresholds(rows, WINDOW), [{ role: "refresh-value", model: "decisions-eastus", surface: "decisions", value: 0.9 }]);
  assert.deepEqual(judgeShadowPrimaryUnanswered(rows, WINDOW), []);
  assert.equal(inventory(rows).judgeShadowScores![0]!.agreement.compared, n);
  assert.doesNotMatch(judgeShadowSwitchCandidate(inventory(rows), REPO_ROOT)!.reason, /counted apart/);
});
