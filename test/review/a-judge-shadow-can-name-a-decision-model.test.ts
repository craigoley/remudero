/**
 * W1-T12417 — a fixed-option judge's shadow can name a decision model. The role's options go to it as one choice
 * question, after the judge answered; every fixed-option judge calls the same shadow under its own role name; an
 * unusable candidate writes one row and changes nothing; a threshold is read only for its own model id and surface;
 * the config gardener proposes a switch only above the per-model bar; and a decision request carries the judged head.
 * Every spawn and every decision request here is a fake: no network and no paid call runs.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse as parseYaml } from "yaml";

import { fixedClock } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import { configCandidates, judgeShadowModelClears, judgeShadowSwitchCandidate, judgeShadowThresholds, judgeShadowTypedAnswers, JUDGE_SWITCH_BAR, type ConfigInventory } from "#src/lib/config-gardener.js";
import { askDecisionModel, DECISION_ANSWERED_STEP, type DecisionAnsweredRow } from "#src/lib/decision-model.js";
import { buildFixProgressInput } from "#src/lib/fix-progress-judge.js";
import {
  FIXED_OPTION_JUDGE_ROLES, JUDGE_SHADOW_QUESTIONS, judgeShadowOnlyArm, runJudgeShadow, shadowJudgeCall,
  thresholdFor, type ShadowJudgeCall,
} from "#src/lib/judge-shadow.js";
import { loadMounts, mountsPath, MountsError, validateMounts, type DecisionCandidate, type JudgeMount, type Mounts } from "#src/lib/mounts.js";
import { productionQuietWorkerJudge } from "#src/lib/quiet-worker-watchdog.js";
import { productionRefreshJudge } from "#src/lib/refresh-value.js";
import { realRiskJudge, type RiskJudgeInput } from "#src/lib/risk-judge.js";
import { readLedgerLines } from "#src/lib/status.js";
import { productionFixProgressJudge } from "#src/lib/sweep.js";
import { scoreTypedAnswers } from "#src/lib/typed-answer-scores.js";
import { runTypedJudgment } from "#src/lib/typed-judgment.js";
import { realVerifyHumanJudge } from "#src/lib/verify-human-judge.js";
import { JUDGE_SHADOW_TRIAL_ID, type SpawnWorkerArgs, type WorkerResult } from "#src/lib/worker.js";
import { clearOpenWeightAbsence, openWeightCandidatesForCapability } from "#src/lib/worker-provider.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const ISO = fixedClock(NOW).iso();
const TABLE = readFileSync(mountsPath(REPO_ROOT), "utf8");
const SETTINGS = join(REPO_ROOT, "settings", "worker.json");
const MOUNTS = loadMounts(mountsPath(REPO_ROOT));
const CANDIDATE: DecisionCandidate = MOUNTS.decision_models!["decisions-eastus"]!;
const ROW = { model: "haiku", effort: "low", max_turns: 400, context_budget: 60000 };
const LOW = "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.9\nRISK_REASON: a rename with tests";
const INPUT: RiskJudgeInput = {
  change: { description: "rename a helper", files: ["src/a.ts"] }, gatesState: {}, planContext: { taskId: "W1-T1" },
  prNumber: 7, headSha: "abc1234",
};

type DecisionShadowDeps = NonNullable<ShadowJudgeCall<unknown>["decisions"]>;
type Spawn = (args: SpawnWorkerArgs) => Promise<WorkerResult>;
const isShadowRow = (row: Record<string, unknown>) => String(row.step).startsWith("judge_shadow.");

function worker(text: string, extra: Partial<WorkerResult> = {}): WorkerResult {
  return { sessionId: "s", costUsd: 0.003, numTurns: 1, text, subtype: "success", ...extra } as unknown as WorkerResult;
}

/** The repo's mounts table with `rows` laid over it. */
function table(rows: Record<string, unknown> = {}): Mounts {
  return validateMounts({ ...(parseYaml(TABLE) as Record<string, unknown>), ...rows });
}

const decisionsArm = { provider: "decisions" as const, deployment: CANDIDATE.deployment, candidate: CANDIDATE };
const riskMount = (extra: Partial<JudgeMount> = {}): JudgeMount => ({ model: "haiku", effort: "low", maxTurns: 400, contextBudget: 60000, shadow: decisionsArm, ...extra });

/** A ledger that can wait for the shadow rows a caller did not wait for. */
function ledger() {
  const rows: Array<Record<string, unknown>> = [];
  const waiting: Array<() => void> = [];
  return {
    rows,
    log: (step: string, fields: Record<string, unknown> = {}) => {
      rows.push({ step, ...fields });
      for (const wake of waiting.splice(0)) wake();
    },
    shadowRows: async (count = 1) => {
      while (rows.filter(isShadowRow).length < count) await new Promise<void>((wake) => waiting.push(wake));
      return rows.filter(isShadowRow);
    },
  };
}

/** A decision row as askDecisionModel writes it, with one answer. */
function answered(answer: DecisionAnsweredRow["answers"][number] | undefined, patch: Partial<DecisionAnsweredRow> = {}): DecisionAnsweredRow {
  return { role: "risk-judge", input_digest: "d", candidate: CANDIDATE.name, deployment: CANDIDATE.deployment, shape: CANDIDATE.shape,
    model_surface: "decisions", outcome: "answered", served_model: "gpt-6-luna", latency_ms: 332, reserved_usd: 0.002, settled_usd: 0.0004,
    held_usd: 0, usage: { input_tokens: 4000, output_tokens: 0 }, question_count: 1, answers: answer === undefined ? [] : [answer], ...patch };
}
const distribution = (low: number) => ({ name: "risk_judge", outcome: "distribution" as const, confidence: null,
  distribution: [{ option: "low", probability: low }, { option: "high", probability: 1 - low }] });

/** Decision seams that never touch the network: a fixed config and an `ask` that records each request. */
function decisions(reply: DecisionAnsweredRow | ((request: Parameters<typeof askDecisionModel>[1]) => DecisionAnsweredRow), learned?: number) {
  const asked: Array<Parameters<typeof askDecisionModel>[1]> = [];
  const deps: DecisionShadowDeps = {
    config: () => ({ claudeBin: "/unused", root: "/unused", workerProviders: { cashDeploymentEndpoints: {
      "gpt-6.1-terra": { endpoint: "https://fixture.cognitiveservices.azure.com/", keyEnv: "RMD_FIXTURE_DECISION_KEY" } } } }) as Config,
    env: { RMD_FIXTURE_DECISION_KEY: "fixture-key-never-printed" },
    ask: async (_config, request) => { asked.push(request); return typeof reply === "function" ? reply(request) : reply; },
    learnedLimit: () => learned,
  };
  return { asked, deps };
}

function riskCall(book: ReturnType<typeof ledger>, deps: DecisionShadowDeps, mount = riskMount(), extra: Partial<ShadowJudgeCall<{ verdict: string }>> = {}): ShadowJudgeCall<{ verdict: string }> {
  return { role: "risk-judge", key: "PR7@abc1234", mount, primaryArgs: { cwd: REPO_ROOT, prompt: "judge this change", tools: [] } as unknown as SpawnWorkerArgs,
    primary: { costUsd: 0.003, servedModel: "claude-haiku-5-5" }, primaryAnswer: { verdict: "low" }, parse: () => undefined,
    agreementKey: (v) => v.verdict, head: { sha: "abc1234" }, spawn: async () => { throw new Error("a decision shadow spawns no worker"); },
    log: book.log, decisions: deps, ...extra };
}

test("W1-T12417 criterion 1: a role's row names a decision model or a cash deployment, and a role naming none keeps W1-T12187's shadow", async () => {
  const named = table({ risk_judge: { ...ROW, shadow: "decisions-eastus" }, ci_judge: { ...ROW, shadow: "gpt-oss-120b" },
    judge_shadows: { "head-rehome": "decisions-eastus", "refresh-value": "Kimi-K2.6" } });
  assert.deepEqual(named.risk_judge!.shadow, decisionsArm);
  assert.deepEqual(named.ci_judge!.shadow, { provider: "cash", deployment: "gpt-oss-120b" });
  assert.deepEqual(named.judge_shadows!["head-rehome"], decisionsArm);
  assert.deepEqual(judgeShadowOnlyArm(named, "refresh-value"), { provider: "cash", deployment: "Kimi-K2.6" });
  assert.equal(judgeShadowOnlyArm(named, "quiet-worker-watchdog"), undefined);
  assert.throws(() => table({ judge_shadows: { "ruling-judge": "decisions-eastus" } }), MountsError, "the ruling judge is not a judge_shadows role");
  assert.throws(() => table({ risk_judge: { ...ROW, shadow: "not a name" } }), MountsError);
  // The repo's own table names a decision model for the judges with no row of their own and for the verify-human judge.
  assert.equal(MOUNTS.verify_human_judge!.shadow?.provider, "decisions");
  for (const role of ["refresh-value", "quiet-worker-watchdog", "head-rehome", "typed-judgment"] as const) {
    assert.equal(MOUNTS.judge_shadows![role]?.provider, "decisions", role);
  }

  // No candidate on the risk judge's row: the same prompt goes to the first ready model of the cash row, unpinned.
  const spawned: SpawnWorkerArgs[] = [];
  const book = ledger();
  const { asked, deps } = decisions(answered(distribution(0.9)));
  await shadowJudgeCall(riskCall(book, deps, riskMount({ shadow: undefined }), {
    spawn: async (args) => { spawned.push(args); return worker(LOW, { routedModel: "gpt-oss-120b", costUsd: 0.0004 }); },
    parse: () => ({ verdict: "low" }) }));
  assert.equal(asked.length, 0, "no decision model is asked");
  assert.equal(spawned[0]!.routingTrial?.id, JUDGE_SHADOW_TRIAL_ID);
  assert.equal(spawned[0]!.mountProvider, "cash");
  assert.equal(spawned[0]!.routingTrial?.models, undefined);
  assert.equal(book.rows[0]!.step, "judge_shadow.compared");
  assert.equal(book.rows[0]!.shadow_model, "gpt-oss-120b");
  // A named cash deployment is pinned, as on the rows of W1-T11075.
  await shadowJudgeCall(riskCall(book, deps, riskMount({ shadow: { provider: "cash", deployment: "DeepSeek-V4-Flash" } }), {
    spawn: async (args) => { spawned.push(args); return worker(LOW); }, parse: () => ({ verdict: "low" }) }));
  assert.deepEqual(spawned[1]!.routingTrial?.models, ["DeepSeek-V4-Flash"]);
  // A role outside W1-T12187's two, with no candidate named, is not shadowed and spends nothing.
  await shadowJudgeCall(riskCall(book, deps, riskMount({ shadow: undefined }), { role: "verify-human",
    spawn: async (args) => { spawned.push(args); return worker(LOW); } }));
  assert.equal(spawned.length, 2);
  assert.equal(book.rows.length, 2);
});

test("W1-T12417 criterion 2: the risk judge's low/high verdict is asked of a decision model as one choice question after the judge answered, and the row adds the distribution, the latency and the cost", async () => {
  const book = ledger();
  const { asked, deps } = decisions(answered(distribution(0.2)));
  const pending = shadowJudgeCall(riskCall(book, deps));
  assert.equal(asked.length, 0, "the caller holds its own answer before any shadow request is made");
  await pending;
  assert.equal(asked.length, 1, "one request");
  assert.equal(asked[0]!.role, "risk-judge");
  assert.equal(asked[0]!.candidate, CANDIDATE);
  assert.equal(asked[0]!.input, "judge this change", "the judge's own prompt is the one input");
  assert.deepEqual(asked[0]!.questions, [{ type: "choice", name: "risk_judge", instructions: JUDGE_SHADOW_QUESTIONS["risk-judge"].instructions,
    options: [{ value: "low" }, { value: "high" }] }]);
  assert.deepEqual(book.rows, [{
    step: "judge_shadow.compared", role: "risk-judge", decision_key: "PR7@abc1234", primary_model: "claude-haiku-5-5", primary_provider: null,
    primary_cost_usd: 0.003, shadow_model: "decisions-eastus", shadow_deployment: CANDIDATE.deployment, model_surface: "decisions",
    head_sha: "abc1234", shadow_cost_usd: 0.0004, latency_ms: 332,
    distribution: [{ option: "low", probability: 0.2 }, { option: "high", probability: 0.8 }],
    primary_answer: "low", shadow_answer: "high", agreement: false,
  }]);

  // Through the risk judge itself: the verdict returned is the judge's own, before any shadow row is written.
  const judged = ledger();
  const judge = realRiskJudge({ mount: riskMount(), cwd: REPO_ROOT, settingsFile: SETTINGS, shadowLog: judged.log,
    spawn: async () => worker(LOW, { servedModel: "claude-haiku-5-5" }) });
  const verdict = await judge(INPUT);
  assert.equal(verdict.verdict, "low");
  assert.equal(judged.rows.filter(isShadowRow).length, 0, "no shadow row exists when the verdict returns");
  const [row] = await judged.shadowRows();
  assert.equal(row!.role, "risk-judge");
  assert.equal(row!.shadow_model, "decisions-eastus");
});

test("W1-T12417 criterion 3: the same shadow serves every fixed-option judge, each under its own role name", async (t) => {
  assert.deepEqual([...FIXED_OPTION_JUDGE_ROLES], ["risk-judge", "ci-judge", "fix-progress", "verify-human", "refresh-value",
    "quiet-worker-watchdog", "head-rehome", "typed-judgment"]);
  // Each role asks its own options and writes its rows under its own name.
  for (const role of FIXED_OPTION_JUDGE_ROLES) {
    const book = ledger();
    const { asked, deps } = decisions((request) => answered({ name: "x", outcome: "distribution", confidence: null,
      distribution: (request.questions as Array<{ options: Array<{ value: string }> }>)[0]!.options.map((o, i) => ({ option: o.value, probability: i === 0 ? 1 : 0 })) }));
    const own = role === "head-rehome" || role === "typed-judgment" ? { question: { instructions: "Which?", options: ["wait", "trailer"] } } : {};
    await shadowJudgeCall(riskCall(book, deps, riskMount(), { role, ...own, agreementKey: () => "none" }));
    const options = (asked[0]!.questions as Array<{ options: Array<{ value: string }> }>)[0]!.options.map((o) => o.value);
    assert.deepEqual(options, role === "head-rehome" || role === "typed-judgment" ? ["wait", "trailer"]
      : [...JUDGE_SHADOW_QUESTIONS[role as keyof typeof JUDGE_SHADOW_QUESTIONS].options], role);
    assert.equal(book.rows[0]!.role, role);
    assert.equal(asked[0]!.role, role);
  }

  // Each judge's own production entry calls the shadow. Its decision request goes through the default seams, which
  // read this test's own config: no candidate is reachable there, so every row is a skip, written under the role's name.
  const roleOf = async (start: (log: (step: string, fields: Record<string, unknown>) => void) => Promise<unknown>) => {
    const book = ledger();
    await start(book.log);
    // Bounded by event-loop turns, not time: a judge that never calls the shadow fails here instead of hanging.
    for (let turn = 0; turn < 500 && book.rows.filter(isShadowRow).length === 0; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
    return book.rows.find(isShadowRow)?.role;
  };
  const decisionsRow = (row: Record<string, unknown>) => ({ ...row, shadow: "decisions-eastus" });
  assert.equal(await roleOf((log) => realRiskJudge({ mount: riskMount(), cwd: REPO_ROOT, settingsFile: SETTINGS, shadowLog: log,
    spawn: async () => worker(LOW) })(INPUT)), "risk-judge");
  assert.equal(await roleOf((log) => runJudgeShadow({ surface: "ci-judge", key: "PR9@def5678", mount: riskMount(), primaryArgs: { prompt: "p" } as SpawnWorkerArgs,
    primaryVerdict: { add: [], escalateFull: true }, parse: () => undefined, agreementKey: () => "", spawn: async () => worker(""), log })), "ci-judge");
  assert.equal(await roleOf((log) => productionFixProgressJudge({ cwd: REPO_ROOT, settingsFile: SETTINGS, log,
    mount: table({ fix_progress_judge: decisionsRow(ROW) }).fix_progress_judge,
    spawn: async () => worker('FIX_PROGRESS: {"verdict":"continue","reason":"the red shrank"}') })(
    buildFixProgressInput({ taskId: "W1-T1", prNumber: 9, headSha: "def5678", currentRed: ["ci"], ledger: [] }))), "fix-progress");
  assert.equal(await roleOf((log) => realVerifyHumanJudge({ mounts: MOUNTS, cwd: REPO_ROOT, settingsFile: SETTINGS, shadowLog: log,
    spawn: async () => worker("VERIFY_HUMAN_DECISION: automate\nVERIFY_HUMAN_REASON: a test proves it") })(
    { id: "W1-T1", title: "t", rationale: "r", acceptance: ["a"], ageDays: 3, depsAllMerged: true, citedInSrc: false })), "verify-human");
  const { dir } = ownedFixtureDir(t, "judge-shadow-refresh");
  assert.equal(await roleOf((log) => productionRefreshJudge({ repoRoot: REPO_ROOT, stateDir: dir, log, diff: async () => "diff",
    spawn: async () => worker('{"verdict":"independent","reason":"no shared file"}') })(
    { prNumber: 9, headSha: "def5678", prFiles: ["a"], baseFiles: ["b"], baseTruncated: false, cause: "tests", ciInFlight: false })), "refresh-value");
  assert.equal(await roleOf((log) => productionQuietWorkerJudge({ cwd: REPO_ROOT, settingsFile: SETTINGS, log,
    spawn: async () => worker('QUIET_JUDGE: {"verdict":"wait","reason":"progress is plausible"}') })(
    { taskId: "W1-T1" } as Parameters<ReturnType<typeof productionQuietWorkerJudge>>[0])), "quiet-worker-watchdog");
  // A cash deployment named for a role reads the reply with the role's own parser.
  const cashRow = async (start: (log: (step: string, fields: Record<string, unknown>) => void, spawn: Spawn) => Promise<unknown>, reply: string) => {
    const book = ledger();
    await start(book.log, async (args) => worker(args.routingTrial?.id === JUDGE_SHADOW_TRIAL_ID ? reply : PRIMARY_OF(args)));
    const [row] = await book.shadowRows();
    return row!;
  };
  const PRIMARY_OF = (args: SpawnWorkerArgs) => args.prompt.includes("TYPED_JUDGMENT") ? 'TYPED_JUDGMENT: {"wait":0.3,"trailer":0.7}'
    : "VERIFY_HUMAN_DECISION: automate\nVERIFY_HUMAN_REASON: a test proves it";
  const typed = await cashRow((log, spawn) => runTypedJudgment({ question: "Is the author quiet?", options: ["wait", "trailer"] as const,
    mount: riskMount({ shadow: undefined }), cwd: REPO_ROOT, settingsFile: SETTINGS, spawn,
    shadow: { role: "typed-judgment", key: "PR9@def5678", arm: { provider: "cash", deployment: "gpt-oss-120b" }, log } }), 'TYPED_JUDGMENT: {"wait":0.9,"trailer":0.1}');
  assert.deepEqual([typed.role, typed.primary_answer, typed.shadow_answer, typed.agreement], ["typed-judgment", "trailer", "wait", false]);
  const human = await cashRow((log, spawn) => realVerifyHumanJudge({ mounts: table({ verify_human_judge: { ...ROW, shadow: "gpt-oss-120b" } }),
    cwd: REPO_ROOT, settingsFile: SETTINGS, shadowLog: log, spawn })(
    { id: "W1-T1", title: "t", rationale: "r", acceptance: ["a"], ageDays: 3, depsAllMerged: true, citedInSrc: false }), "no verdict here");
  assert.deepEqual([human.role, human.step], ["verify-human", "judge_shadow.skipped"], "a fail-open default is not an answer");
  for (const role of ["head-rehome", "typed-judgment"] as const) {
    assert.equal(await roleOf((log) => runTypedJudgment({ question: "Is the author quiet?", options: ["wait", "trailer"] as const, mount: riskMount({ shadow: undefined }),
      cwd: REPO_ROOT, settingsFile: SETTINGS, spawn: async () => worker('TYPED_JUDGMENT: {"wait":0.3,"trailer":0.7}'),
      shadow: { role, key: "PR9@def5678", arm: judgeShadowOnlyArm(MOUNTS, role), log } })), role);
  }
});

test("W1-T12417 criterion 4: an unusable candidate changes nothing and writes one row with its reason; a threshold is read only for its own model id and surface", async () => {
  const skipped = async (reply: DecisionAnsweredRow, learned?: number) => {
    const book = ledger();
    const { asked, deps } = decisions(reply, learned);
    const returned = await shadowJudgeCall(riskCall(book, deps));
    assert.equal(returned, undefined, "the shadow returns nothing the caller could act on");
    assert.equal(book.rows.length, 1, "one row");
    return { row: book.rows[0]!, asked };
  };
  const unavailable = await skipped(answered(undefined, { outcome: "unavailable", reason: "no-key", detail: "RMD_CASH_KEY is not set", latency_ms: null, settled_usd: 0 }));
  assert.equal(unavailable.row.step, "judge_shadow.skipped");
  assert.equal(unavailable.row.reason, "unavailable: no-key: RMD_CASH_KEY is not set");
  const refused = await skipped(answered(undefined, { outcome: "failed", reason: "budget-refused", detail: "cap reached", settled_usd: 0 }));
  assert.equal(refused.row.refusal, "budget");
  const limited = await skipped(answered(undefined, { outcome: "failed", reason: "http", status: 429, detail: "Too Many Requests" }));
  assert.match(String(limited.row.reason), /^unavailable: rate limited \(429\)/);
  assert.equal(limited.row.refusal, undefined, "a 429 is the candidate being unavailable");
  const failed = await skipped(answered(undefined, { outcome: "failed", reason: "transport", detail: "socket hang up" }));
  assert.equal(failed.row.reason, "failed: transport: socket hang up");
  const abstained = await skipped(answered({ name: "risk_judge", outcome: "abstained", reason: "cannot-tell" }));
  assert.equal(abstained.row.abstained, "cannot-tell");
  assert.equal(abstained.row.step, "judge_shadow.skipped");
  const rejected = await skipped(answered({ name: "risk_judge", outcome: "rejected", reason: "risk_judge summed to 0.7, not 1" }));
  assert.match(String(rejected.row.reason), /^rejected: /);
  const short = await skipped(answered(distribution(0.9)), 10);
  assert.equal(short.asked.length, 0, "a learned limit that cannot hold the request sends nothing");
  assert.equal(short.row.refusal, "capacity");
  // A config that cannot be read is a skip with its reason, never a throw.
  const unread = ledger();
  await shadowJudgeCall(riskCall(unread, { config: () => { throw new Error("config unreadable"); } }));
  assert.deepEqual([unread.rows[0]!.step, unread.rows[0]!.reason], ["judge_shadow.skipped", "config unreadable"]);
  // A role whose options are not declared asks nothing.
  const book = ledger();
  const none = decisions(answered(distribution(0.9)));
  await shadowJudgeCall(riskCall(book, none.deps, riskMount(), { role: "decision-summary" }));
  assert.equal(none.asked.length, 0);
  assert.equal(book.rows[0]!.reason, "the role declares no fixed options");

  // The threshold stored for this deployment on the decisions surface applies; one stored for the same model id on the
  // text surface, or for another model, does not.
  assert.equal(thresholdFor({ model: CANDIDATE.deployment, surface: "decisions", value: 0.9 }, CANDIDATE.deployment, "decisions"), 0.9);
  assert.equal(thresholdFor({ model: CANDIDATE.deployment, surface: "text", value: 0.9 }, CANDIDATE.deployment, "decisions"), undefined);
  assert.equal(thresholdFor({ model: "DeepSeek-V4-Flash", surface: "decisions", value: 0.9 }, CANDIDATE.deployment, "decisions"), undefined);
  const below = async (threshold: JudgeMount["threshold"]) => {
    const tuned = ledger();
    await shadowJudgeCall(riskCall(tuned, decisions(answered(distribution(0.8))).deps, riskMount({ threshold })));
    return tuned.rows[0]!;
  };
  const applied = await below({ model: CANDIDATE.deployment, surface: "decisions", value: 0.9 });
  assert.equal(applied.step, "judge_shadow.skipped");
  assert.equal(applied.abstained, "below-threshold");
  assert.equal(applied.threshold, 0.9);
  for (const other of [{ model: CANDIDATE.deployment, surface: "text" as const, value: 0.9 }, { model: "gpt-oss-120b", surface: "decisions" as const, value: 0.9 }]) {
    const row = await below(other);
    assert.equal(row.step, "judge_shadow.compared", JSON.stringify(other));
    assert.equal(row.threshold, undefined);
  }
  // The table refuses a threshold that names no surface.
  assert.throws(() => table({ ci_judge: { ...ROW, threshold: { model: CANDIDATE.deployment, value: 0.9 } } }), MountsError);
  assert.deepEqual(table({ ci_judge: { ...ROW, threshold: { model: CANDIDATE.deployment, surface: "decisions", value: 0.9 } } }).ci_judge!.threshold,
    { model: CANDIDATE.deployment, surface: "decisions", value: 0.9 });
});

test("W1-T12417 criterion 5: the config gardener proposes a role's shadow model as its primary only when that role and model clear the per-model bar", async (t) => {
  const served = openWeightCandidatesForCapability(MOUNTS.capabilities, "economy", "low")[0]!;
  const rows = (role: string, model: string, count: number, agreeing: number, surface = "text") => Array.from({ length: count }, (_, i) => ({
    ts: ISO, step: "judge_shadow.compared", role, shadow_model: model, model_surface: surface, primary_answer: "continue",
    shadow_answer: i < agreeing ? "continue" : "escalate", agreement: i < agreeing,
  }));
  const inventory = (ledgerRows: Array<Record<string, unknown>>): ConfigInventory => ({
    nowIso: ISO, runs: [], queued: [], recommendations: [], active: [], cooling: [],
    judgeShadowScores: scoreTypedAnswers(judgeShadowTypedAnswers(ledgerRows, NOW - 14 * 24 * 3600 * 1000)).groups,
    judgeShadowThresholds: judgeShadowThresholds(ledgerRows, NOW - 14 * 24 * 3600 * 1000),
  });
  // A decision model's rows: `disagreeing` of them differ from the judge's answer (top option 0.6), the rest agree at 0.9 or 0.7.
  const decided = (role: string, count: number, disagreeing: number, model = "decisions-eastus") => Array.from({ length: count }, (_, i) => {
    const top = i < disagreeing ? 0.6 : i % 2 === 0 ? 0.9 : 0.7;
    return { ts: ISO, step: "judge_shadow.compared", role, shadow_model: model, model_surface: "decisions", primary_answer: "overlap",
      shadow_answer: i < disagreeing ? "independent" : "overlap", agreement: i >= disagreeing,
      distribution: i < disagreeing ? [{ option: "overlap", probability: 1 - top }, { option: "independent", probability: top }]
        : [{ option: "overlap", probability: top }, { option: "independent", probability: 1 - top }] };
  });
  const n = JUDGE_SWITCH_BAR.minCompared;
  // A W1-T11075 paired row records agreement only, and is scored as agreement under its deployment.
  const paired = scoreTypedAnswers(judgeShadowTypedAnswers([{ ts: ISO, step: "judge_shadow.paired", surface: "ci-judge", shadow_deployment: "DeepSeek-V4-Flash", agreement: true },
    { ts: ISO, step: "judge_shadow.paired", surface: "ci-judge", shadow_deployment: "DeepSeek-V4-Flash", agreement: false }])).groups;
  assert.deepEqual(paired.map((g) => [g.role, g.model, g.modelSurface, g.agreement.compared, g.agreement.agreed]), [["ci-judge", "DeepSeek-V4-Flash", "text", 2, 1]]);
  const clear = inventory(rows("fix-progress", served, n, n));
  assert.equal(clear.judgeShadowScores!.length, 1);
  assert.equal(judgeShadowModelClears(clear.judgeShadowScores![0]!), true);
  const action = judgeShadowSwitchCandidate(clear, REPO_ROOT)!;
  assert.equal(action.scope, "judge:fix-progress");
  const line = TABLE.split("\n").find((l) => l.startsWith("fix_progress_judge: {"))!;
  assert.deepEqual(action.edits, [{ path: ".remudero/mounts.yaml", from: line, to: line.replace(/\s*\}\s*$/, ", provider: cash }") }]);
  assert.equal(parseYaml(action.edits[0]!.to).fix_progress_judge.provider, "cash");
  // It goes through the fleet's normal path: the gardener's candidates, one canary PR, review and merge.
  assert.ok(configCandidates(clear, REPO_ROOT, () => 0.5).some((a) => a.scope === "judge:fix-progress" && a.edits[0]!.to === action.edits[0]!.to));

  // A decision model that clears the bar on a judge whose answer is one option becomes its primary, with its threshold
  // stored beside its model id (the deployment) and its surface.
  const decisionClear = inventory(decided("refresh-value", n, 2));
  assert.equal(judgeShadowModelClears(decisionClear.judgeShadowScores![0]!), true);
  assert.deepEqual(decisionClear.judgeShadowThresholds, [{ role: "refresh-value", model: "decisions-eastus", surface: "decisions", value: 0.6 }]);
  const primary = judgeShadowSwitchCandidate(decisionClear, REPO_ROOT)!;
  assert.equal(primary.scope, "judge:refresh-value");
  assert.deepEqual(primary.edits, [{ path: ".remudero/mounts.yaml", from: "  refresh-value: decisions-eastus",
    to: `  refresh-value: { primary: decisions-eastus, threshold: { model: ${CANDIDATE.deployment}, surface: decisions, value: 0.6 } }` }]);
  const switched = validateMounts(parseYaml(TABLE.replace(primary.edits[0]!.from, primary.edits[0]!.to)));
  assert.deepEqual(switched.judge_primaries!["refresh-value"], { arm: decisionsArm, threshold: { model: CANDIDATE.deployment, surface: "decisions", value: 0.6 } });
  assert.equal(switched.judge_shadows!["refresh-value"], undefined, "the line that shadowed the role now makes the model its primary");
  assert.ok(configCandidates(decisionClear, REPO_ROOT, () => 0.5).some((a) => a.scope === "judge:refresh-value" && a.edits[0]!.to === primary.edits[0]!.to));
  // The rollback of the canary swaps the two lines, so the table reads as it did.
  assert.deepEqual(validateMounts(parseYaml(TABLE.replace(primary.edits[0]!.from, primary.edits[0]!.to).replace(primary.edits[0]!.to, primary.edits[0]!.from))).judge_shadows!["refresh-value"], decisionsArm);
  // A role that is already on its candidate gets no second proposal.
  const { dir } = ownedFixtureDir(t, "judge-primary-switched");
  mkdirSync(join(dir, ".remudero"));
  writeFileSync(mountsPath(dir), TABLE.replace(primary.edits[0]!.from, primary.edits[0]!.to));
  assert.equal(judgeShadowSwitchCandidate(decisionClear, dir), undefined, "already primary");
  for (const [why, ledgerRows] of [["too few", decided("refresh-value", n - 1, 0)], ["too little agreement", decided("refresh-value", n, 6)],
    ["a model that is no decision_models row", decided("refresh-value", n, 0, "unknown-model")],
    ["a judge whose answer is more than an option", decided("fix-progress", n, 0)],
    ["a judge with no primary read", decided("quiet-worker-watchdog", n, 0)]] as const) {
    assert.equal(judgeShadowSwitchCandidate(inventory([...ledgerRows]), REPO_ROOT), undefined, why);
  }
  // Without a threshold figure for the pair, nothing is proposed: a figure for the text surface does not stand in.
  assert.equal(judgeShadowSwitchCandidate({ ...decisionClear, judgeShadowThresholds: [{ role: "refresh-value", model: "decisions-eastus", surface: "text", value: 0.6 }] }, REPO_ROOT), undefined);
  assert.equal(judgeShadowThresholds(rows("refresh-value", "decisions-eastus", n, n)).length, 0, "a text answer has no probability");

  // Below the bar, nothing: too few calls, too little agreement, too many unusable answers, another model than the one
  // cash would serve the row with, a decision model on a judge that cannot take one, or a judge that fails closed.
  const unusable = [...rows("fix-progress", served, n, n), ...Array.from({ length: 10 }, () => ({ ts: ISO, step: "judge_shadow.skipped",
    role: "fix-progress", shadow_model: served, reason: "unparseable shadow verdict" }))];
  for (const [why, ledgerRows] of [["too few", rows("fix-progress", served, n - 1, n - 1)], ["too little agreement", rows("fix-progress", served, n, Math.floor(n * 0.97))],
    ["too many unusable", unusable], ["another model", rows("fix-progress", "Kimi-K2.6", n, n)],
    ["a decision model", rows("fix-progress", "decisions-eastus", n, n, "decisions")], ["fails closed", rows("risk-judge", served, n, n)],
    ["too old", rows("fix-progress", served, n, n).map((r) => ({ ...r, ts: fixedClock(NOW - 15 * 24 * 3600 * 1000).iso() }))]] as const) {
    assert.equal(judgeShadowSwitchCandidate(inventory([...ledgerRows]), REPO_ROOT), undefined, why);
  }

  // The edit does what it says: with the line merged, the decision model answers first, and the judge's own spawn answers
  // when the model cannot. The repo `dir` above holds the table with the edit applied.
  const refreshQuestion: Parameters<ReturnType<typeof productionRefreshJudge>>[0] =
    { prNumber: 9, headSha: "def5678", prFiles: ["a"], baseFiles: ["b"], baseTruncated: false, cause: "tests", ciInFlight: false };
  let counter = 0;
  const refresh = async (reply: DecisionAnsweredRow) => {
    const book = ledger();
    const seams = decisions(reply);
    let spawned = 0;
    const verdict = await productionRefreshJudge({ repoRoot: dir, stateDir: ownedFixtureDir(t, `judge-primary-state-${counter++}`).dir, log: book.log, diff: async () => "diff",
      shadowDecisions: seams.deps, spawn: async () => { spawned++; return worker('{"verdict":"independent","reason":"no shared file"}'); } })(refreshQuestion);
    return { verdict, spawned, asked: seams.asked, shadowRows: book.rows.filter(isShadowRow) };
  };
  const refreshDistribution = (overlap: number) => answered({ name: "refresh_value", outcome: "distribution", confidence: null,
    distribution: [{ option: "overlap", probability: overlap }, { option: "independent", probability: 1 - overlap }] });
  const primaryAnswered = await refresh(refreshDistribution(0.9));
  assert.equal(primaryAnswered.verdict, "overlap", "the decision model's top option is the answer");
  assert.equal(primaryAnswered.spawned, 0, "the judge's own spawn did not run");
  assert.equal(primaryAnswered.asked.length, 1);
  assert.equal(primaryAnswered.asked[0]!.role, "refresh-value");
  assert.deepEqual(primaryAnswered.asked[0]!.questions, [{ type: "choice", name: "refresh_value", instructions: JUDGE_SHADOW_QUESTIONS["refresh-value"].instructions,
    options: [{ value: "overlap" }, { value: "independent" }] }]);
  assert.equal(primaryAnswered.asked[0]!.headSha, "def5678");
  assert.equal(primaryAnswered.shadowRows.length, 0, "an answered primary writes no shadow row");
  const belowThreshold = await refresh(refreshDistribution(0.55));
  assert.equal(belowThreshold.verdict, "independent", "below the stored threshold the judge's own answer stands");
  assert.equal(belowThreshold.spawned, 1);
  assert.deepEqual(belowThreshold.shadowRows.map((row) => [row.step, row.served_as, row.abstained, row.threshold, row.shadow_model]),
    [["judge_shadow.skipped", "primary", "below-threshold", 0.6, "decisions-eastus"]]);
  const unreachable = await refresh(answered(undefined, { outcome: "unavailable", reason: "no-key", detail: "RMD_CASH_KEY is not set", latency_ms: null, settled_usd: 0 }));
  assert.equal(unreachable.verdict, "independent", "an unavailable candidate leaves today's judge as the only answer");
  assert.equal(unreachable.spawned, 1);
  assert.deepEqual(unreachable.shadowRows.map((row) => [row.step, row.served_as, row.reason]), [["judge_shadow.skipped", "primary", "unavailable: no-key: RMD_CASH_KEY is not set"]]);
  // A typed-judgment spawn takes the same primary through its shadow entry.
  const typedBook = ledger();
  const typed = await runTypedJudgment({ question: "Is the author quiet?", options: ["wait", "trailer"] as const, mount: riskMount({ shadow: undefined }), cwd: REPO_ROOT,
    settingsFile: SETTINGS, spawn: async () => { throw new Error("the primary answered, so no spawn runs"); },
    shadow: { role: "head-rehome", key: "PR9@def5678", arm: undefined, log: typedBook.log, primary: switched.judge_primaries!["refresh-value"],
      decisions: decisions(answered({ name: "head_rehome", outcome: "distribution", confidence: null,
        distribution: [{ option: "wait", probability: 0.2 }, { option: "trailer", probability: 0.8 }] })).deps } });
  assert.deepEqual(typed, { kind: "distribution", distribution: { wait: 0.2, trailer: 0.8 } });
});

test("W1-T12417 criterion 6: a judge's decision request passes the judged head and the pull request, and its decision.answered row records both", async (t) => {
  clearOpenWeightAbsence();
  t.after(() => clearOpenWeightAbsence());
  const { dir } = ownedFixtureDir(t, "judge-shadow-head");
  const config = { claudeBin: "/unused", root: dir, dailyCapUsd: 25, workerProviders: {
    cashDeploymentEndpoints: { "gpt-6.1-terra": { endpoint: "https://fixture.cognitiveservices.azure.com/", keyEnv: "RMD_FIXTURE_DECISION_KEY" } } } } as Config;
  const reply = { model: "served-fixture", usage: { input_tokens: 40, output_tokens: 0 },
    answers: [{ type: "choice", name: "risk_judge", choice: "low", probabilities: [{ value: "low", probability: 0.9 }, { value: "high", probability: 0.1 }] }] };
  let sent = 0;
  const deps: DecisionShadowDeps = { config: () => config, env: { RMD_FIXTURE_DECISION_KEY: "fixture-key-never-printed" }, learnedLimit: () => undefined,
    ask: (c, request) => askDecisionModel(c, { ...request, fetchImpl: async () => { sent++; return new Response(JSON.stringify(reply), { status: 200 }); } }) };
  const book = ledger();
  await shadowJudgeCall(riskCall(book, deps, riskMount(), { head: { sha: "abc1234", prUrl: "https://github.com/craigoley/remudero/pull/7" } }));
  await shadowJudgeCall(riskCall(book, deps, riskMount(), { head: undefined, key: "W1-T1" }));
  assert.equal(sent, 2);
  const decided = readLedgerLines(join(dir, "state", "ledger.ndjson")).filter((row) => row.step === DECISION_ANSWERED_STEP);
  assert.equal(decided.length, 2);
  assert.equal(decided[0]!.head_sha, "abc1234");
  assert.equal(decided[0]!.pr_url, "https://github.com/craigoley/remudero/pull/7");
  assert.equal(decided[0]!.role, "risk-judge");
  assert.equal("head_sha" in decided[1]!, false, "a shadow with no judged head writes neither");
  assert.equal("pr_url" in decided[1]!, false);
  assert.equal(book.rows[0]!.head_sha, "abc1234");
  assert.equal(book.rows[0]!.step, "judge_shadow.compared");
  // A pull request with no head is not recorded either.
  const row = await askDecisionModel(config, { role: "risk-judge", candidate: CANDIDATE, input: "x", questions: [], prUrl: "https://github.com/o/r/pull/1" });
  assert.equal(row.pr_url, undefined);

  // The production callers hold a pull request number and a head, never a URL: each passes both, and the shadow turns the
  // number into the URL of the origin of the checkout the judge ran in. Nothing here injects a URL.
  const { dir: checkout } = ownedFixtureDir(t, "judge-shadow-origin");
  execFileSync("git", ["-C", checkout, "init", "-q"]);
  execFileSync("git", ["-C", checkout, "remote", "add", "origin", "git@github.com:craigoley/remudero.git"]);
  mkdirSync(join(checkout, ".remudero"));
  writeFileSync(mountsPath(checkout), TABLE);
  const requestOf = async (start: (seams: DecisionShadowDeps, log: (step: string, fields: Record<string, unknown>) => void) => Promise<unknown>) => {
    const book = ledger();
    const seams = decisions(answered(distribution(0.9)));
    await start(seams.deps, book.log);
    await book.shadowRows();
    assert.equal(seams.asked.length, 1);
    return { headSha: seams.asked[0]!.headSha, prUrl: seams.asked[0]!.prUrl };
  };
  assert.deepEqual(await requestOf((seams, log) => realRiskJudge({ mount: riskMount(), cwd: checkout, settingsFile: SETTINGS, shadowLog: log, shadowDecisions: seams,
    spawn: async () => worker(LOW) })(INPUT)), { headSha: "abc1234", prUrl: "https://github.com/craigoley/remudero/pull/7" }, "risk-judge");
  assert.deepEqual(await requestOf((seams, log) => runJudgeShadow({ surface: "ci-judge", key: "PR9@def5678", mount: riskMount(), primaryArgs: { prompt: "p", cwd: checkout } as SpawnWorkerArgs,
    primaryVerdict: { add: [], escalateFull: true }, parse: () => undefined, agreementKey: () => "", spawn: async () => worker(""), log, decisions: seams })),
  { headSha: "def5678", prUrl: "https://github.com/craigoley/remudero/pull/9" }, "ci-judge");
  assert.deepEqual(await requestOf((seams, log) => productionFixProgressJudge({ cwd: checkout, settingsFile: SETTINGS, log, shadowDecisions: seams,
    mount: table({ fix_progress_judge: { ...ROW, shadow: "decisions-eastus" } }).fix_progress_judge,
    spawn: async () => worker('FIX_PROGRESS: {"verdict":"continue","reason":"the red shrank"}') })(
    buildFixProgressInput({ taskId: "W1-T1", prNumber: 9, headSha: "def5678", currentRed: ["ci"], ledger: [] }))),
  { headSha: "def5678", prUrl: "https://github.com/craigoley/remudero/pull/9" }, "fix-progress");
  const { dir: state } = ownedFixtureDir(t, "judge-shadow-origin-state");
  assert.deepEqual(await requestOf((seams, log) => productionRefreshJudge({ repoRoot: checkout, stateDir: state, log, diff: async () => "diff", shadowDecisions: seams,
    spawn: async () => worker('{"verdict":"independent","reason":"no shared file"}') })(
    { prNumber: 11, headSha: "0123abc", prFiles: ["a"], baseFiles: ["b"], baseTruncated: false, cause: "tests", ciInFlight: false })),
  { headSha: "0123abc", prUrl: "https://github.com/craigoley/remudero/pull/11" }, "refresh-value");
  // A judgement with no pull request (a task id key) passes its head alone, and a checkout with no origin gives no URL.
  const viaCall = (extra: Partial<ShadowJudgeCall<{ verdict: string }>>) => (seams: DecisionShadowDeps, log: (step: string, fields: Record<string, unknown>) => void) =>
    shadowJudgeCall(riskCall({ log } as ReturnType<typeof ledger>, seams, riskMount(), extra));
  assert.deepEqual(await requestOf(viaCall({ key: "W1-T1", head: { sha: "abc1234" } })), { headSha: "abc1234", prUrl: undefined }, "no pull request");
  const { dir: bare } = ownedFixtureDir(t, "judge-shadow-no-origin");
  execFileSync("git", ["-C", bare, "init", "-q"]);
  assert.deepEqual(await requestOf(viaCall({ primaryArgs: { cwd: bare, prompt: "p" } as SpawnWorkerArgs, head: { sha: "abc1234", prNumber: 7 } })),
    { headSha: "abc1234", prUrl: undefined }, "no origin");
});
