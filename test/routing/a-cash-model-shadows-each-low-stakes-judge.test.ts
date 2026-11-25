/**
 * W1-T12187 — a cash model shadows the risk judge and the decision summary, a summary gives each role's
 * record (with the ci judge's and the fix-progress judge's rows of W1-T11075), and the config gardener
 * proposes `provider: cash` on a role's own mounts row when that record clears the bar.
 * Every spawn here is a fake: no network and no paid call runs.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import { fixedClock } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import {
  applyConfigEdits, CONFIG_GARDEN_LEDGER_STEPS, configCandidates, configGardenSpec, JUDGE_CASH_BAR, serveConfigMeasurement,
  type ConfigInventory,
} from "#src/lib/config-gardener.js";
import { realDecisionSummarizer, resolveDecisionSummaryMount } from "#src/lib/feedback.js";
import type { GardenerDeps } from "#src/lib/gardener.js";
import { JUDGE_SHADOW_STEPS, judgeShadowSummary, runJudgeShadow, type JudgeShadowRoleSummary } from "#src/lib/judge-shadow.js";
import { loadMounts, mountsPath, validateMounts, type JudgeMount, type Mounts } from "#src/lib/mounts.js";
import { realRiskJudge, resolveRiskJudgeMount, resolveRiskJudgeRoleMount, type RiskJudgeInput } from "#src/lib/risk-judge.js";
import { JUDGE_SHADOW_TRIAL_ID, type SpawnWorkerArgs, type WorkerResult } from "#src/lib/worker.js";
import {
  OpenWeightAllowanceExhaustedError, OpenWeightRequestTooLargeError, openWeightCandidatesForCapability, reserveOpenWeightBudget,
  selectOpenWeightModel,
} from "#src/lib/worker-provider.js";
import { ownedFixtureDir, type FixtureScope } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const ISO = fixedClock(NOW).iso();
const TABLE = readFileSync(mountsPath(REPO_ROOT), "utf8");
const SETTINGS = join(REPO_ROOT, "settings", "worker.json");
const LOW = "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.9\nRISK_REASON: a rename with tests";
const HIGH = "RISK_VERDICT: high\nRISK_CONFIDENCE: 0.8\nRISK_REASON: it touches the merge gate";
const SUMMARY = '{"headline":"Rule on the cap","what_happened":"A cap was reached.","decision":"Choose one.","options":[]}';
const INPUT: RiskJudgeInput = {
  change: { description: "rename a helper", files: ["src/a.ts"] }, gatesState: {}, planContext: { taskId: "W1-T1" },
  prNumber: 7, headSha: "abc1234",
};

type Spawn = (args: SpawnWorkerArgs) => Promise<WorkerResult>;
const isShadowCall = (args: SpawnWorkerArgs) => args.routingTrial?.id === JUDGE_SHADOW_TRIAL_ID;
const isShadowRow = (row: Record<string, unknown>) => String(row.step).startsWith("judge_shadow.");

function worker(text: string, extra: Partial<WorkerResult> = {}): WorkerResult {
  return { sessionId: "s", costUsd: 0.0002, numTurns: 1, text, ...extra } as unknown as WorkerResult;
}

/** The repo's mounts table with the two rows of this task removed, then `rows` added. */
function table(rows: Record<string, unknown> = {}): Mounts {
  const raw = parseYaml(TABLE) as Record<string, unknown>;
  delete raw.risk_judge;
  delete raw.feedback_summary;
  return validateMounts({ ...raw, ...rows });
}

/** W1-T14841: the repo's table with the risk judge's row naming no shadow, so its judgement takes the cash row's shadow
 *  as it did before decision-1 became the row's shadow on 2026-11-25. */
function cashShadowed(): Mounts {
  const row = { model: "haiku", effort: "low", max_turns: 400, context_budget: 60000 };
  return table({ risk_judge: row, feedback_summary: row });
}

/** A ledger that stamps each row, and can wait for the shadow rows a caller did not wait for. */
function ledger(ts = ISO) {
  const rows: Array<Record<string, unknown>> = [];
  const waiting: Array<() => void> = [];
  return {
    rows,
    log: (step: string, fields: Record<string, unknown> = {}) => {
      rows.push({ ts, step, ...fields });
      for (const wake of waiting.splice(0)) wake();
    },
    shadowRows: async (count = 1) => {
      while (rows.filter(isShadowRow).length < count) await new Promise<void>((wake) => waiting.push(wake));
      return rows.filter(isShadowRow);
    },
  };
}

/** Enough turns of the event loop for a shadow that was going to start to have started. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function riskJudge(mounts: Mounts, shadow: Spawn, book = ledger(), primary = LOW) {
  const spawned: SpawnWorkerArgs[] = [];
  const judge = realRiskJudge({
    mount: resolveRiskJudgeRoleMount(mounts), cwd: REPO_ROOT, settingsFile: SETTINGS, shadowLog: book.log,
    spawn: async (args) => {
      spawned.push(args);
      return isShadowCall(args) ? shadow(args) : worker(primary, { costUsd: 0.003, servedModel: "claude-haiku-5-5" });
    },
  });
  return { judge, book, spawned };
}

function summarizer(mounts: Mounts, shadow: Spawn, book = ledger(), primary = SUMMARY) {
  const spawned: SpawnWorkerArgs[] = [];
  const summarize = realDecisionSummarizer({
    mount: resolveDecisionSummaryMount(mounts), cwd: REPO_ROOT, settingsFile: SETTINGS, shadowLog: book.log,
    spawn: async (args) => {
      spawned.push(args);
      return isShadowCall(args) ? shadow(args) : worker(primary, { costUsd: 0.002 });
    },
  });
  return { summarize, book, spawned };
}

test("W1-T12187 criterion 1: after the risk judge answers, the same prompt goes to the first ready cash economy model and one row records the role, both models, both answers, agreement and each cost", async () => {
  const mounts = cashShadowed();
  const { judge, book, spawned } = riskJudge(mounts, async () => worker(HIGH, { costUsd: 0.0004, routedModel: "gpt-oss-120b" }));
  const verdict = await judge(INPUT);
  assert.equal(verdict.verdict, "low");
  const rows = await book.shadowRows();
  const [primaryArgs, shadowArgs] = spawned;
  assert.equal(spawned.length, 2, "the prompt is sent to the shadow once");
  assert.equal(shadowArgs!.prompt, primaryArgs!.prompt);
  assert.deepEqual(shadowArgs!.tools, []);
  assert.equal(shadowArgs!.mountProvider, "cash");
  assert.equal(shadowArgs!.effort, "low");
  assert.equal(shadowArgs!.routingTrial?.models, undefined, "no deployment is pinned");
  // What the worker's cash path selects from those args: the first READY model of the cash economy row.
  const economy = openWeightCandidatesForCapability(mounts.capabilities, "economy", "low");
  assert.equal(selectOpenWeightModel(mounts.capabilities, shadowArgs!.model, shadowArgs!.effort, undefined, { ready: () => true }).model, economy[0]);
  assert.equal(selectOpenWeightModel(mounts.capabilities, shadowArgs!.model, shadowArgs!.effort, undefined, { ready: (d) => d !== economy[0] }).model, economy[1]);
  assert.deepEqual(rows, [{
    ts: ISO, step: "judge_shadow.compared", role: "risk-judge", decision_key: "PR7@abc1234",
    primary_model: "claude-haiku-5-5", primary_provider: null, primary_cost_usd: 0.003, shadow_effort: "low",
    shadow_model: "gpt-oss-120b", shadow_cost_usd: 0.0004, primary_answer: "low", shadow_answer: "high", agreement: false,
  }]);

  // An agreeing shadow, and a judgement with no pull request: the key is the task.
  const agreeing = riskJudge(mounts, async () => worker(LOW));
  await agreeing.judge({ ...INPUT, prNumber: undefined });
  const [row] = await agreeing.book.shadowRows();
  assert.equal(row!.agreement, true);
  assert.equal(row!.decision_key, "W1-T1");

  // A deployment named on the role's own row is pinned, as on the rows of W1-T11075.
  const pinned = riskJudge(table({ risk_judge: { model: "haiku", effort: "low", max_turns: 400, context_budget: 60000, shadow: { deployment: "DeepSeek-V4-Flash" } } }),
    async () => worker(LOW));
  await pinned.judge(INPUT);
  await pinned.book.shadowRows();
  assert.deepEqual(pinned.spawned[1]!.routingTrial?.models, ["DeepSeek-V4-Flash"]);
});

test("W1-T12187 criterion 2: the decision summary gets the same shadow call, and its row records the cost and whether the reply parses and no agreement", async () => {
  const mounts = loadMounts(mountsPath(REPO_ROOT));
  const parsed = summarizer(mounts, async () => worker('{"headline":"Another wording"}', { costUsd: 0.0001, routedModel: "gpt-oss-120b" }));
  assert.deepEqual(await parsed.summarize({ context: "a cap was reached" }), JSON.parse(SUMMARY));
  const rows = await parsed.book.shadowRows();
  assert.equal(parsed.spawned[1]!.prompt, parsed.spawned[0]!.prompt);
  assert.equal(parsed.spawned[1]!.mountProvider, "cash");
  assert.equal(rows.length, 1);
  const { decision_key: key, ...row } = rows[0]!;
  assert.match(String(key), /^[0-9a-f]{16}$/);
  assert.deepEqual(row, {
    ts: ISO, step: "judge_shadow.compared", role: "decision-summary", primary_model: "haiku", primary_provider: null,
    primary_cost_usd: 0.002, shadow_effort: "low", shadow_model: "gpt-oss-120b", shadow_cost_usd: 0.0001, parses: true,
  });
  assert.equal("agreement" in row, false);

  // A reply that does not parse is still one row with its cost: `parses` is false.
  for (const reply of ["no json here", "{not json}"]) {
    const garbled = summarizer(mounts, async () => worker(reply, { costUsd: 0.0001 }));
    await garbled.summarize({ context: "a cap was reached" });
    const [bad] = await garbled.book.shadowRows();
    assert.deepEqual([bad!.step, bad!.parses, bad!.shadow_cost_usd, "agreement" in bad!], ["judge_shadow.compared", false, 0.0001, false]);
  }
});

test("W1-T12187 criterion 3: the caller holds the current model's answer before the shadow starts, and a shadow that fails, times out or gives no usable answer changes nothing and writes one row with the reason", async () => {
  const mounts = cashShadowed();
  const first = riskJudge(mounts, async () => worker(HIGH));
  const verdict = await first.judge(INPUT);
  assert.equal(first.spawned.length, 1, "no shadow request was made before the caller had its answer");
  assert.deepEqual(first.book.rows, []);
  assert.deepEqual([verdict.verdict, verdict.confidence], ["low", 0.9], "the answer is the current model's, not the shadow's");
  await first.book.shadowRows();

  const failures: Array<[string, Spawn]> = [
    ["endpoint reset", async () => { throw new Error("endpoint reset"); }],
    ["timed out after 120000 ms", async () => { throw new Error("timed out after 120000 ms"); }],
    ["plain failure", async () => { throw "plain failure"; }],
    ["shadow call failed (error_during_execution)", async () => worker("", { isError: true, subtype: "error_during_execution" } as never)],
    ["shadow call failed (error)", async () => worker("", { isError: true })],
    ["unparseable shadow verdict", async () => worker("no verdict here")],
  ];
  for (const [reason, shadow] of failures) {
    const failed = riskJudge(mounts, shadow);
    assert.deepEqual(await failed.judge(INPUT), verdict, `${reason}: the verdict is unchanged`);
    const rows = await failed.book.shadowRows();
    await settle();
    assert.deepEqual(failed.book.rows.map((row) => [row.step, row.reason, row.role]), [["judge_shadow.skipped", reason, "risk-judge"]]);
    assert.equal(rows[0]!.refusal, undefined);
    assert.equal(failed.spawned.length, 2, "the shadow is asked once and never retried");
  }

  // The decision summary: the same contract.
  const summary = summarizer(mounts, async () => { throw new Error("endpoint reset"); });
  assert.deepEqual(await summary.summarize({ context: "x" }), JSON.parse(SUMMARY));
  assert.deepEqual((await summary.book.shadowRows()).map((row) => [row.step, row.reason]), [["judge_shadow.skipped", "endpoint reset"]]);
  // A primary summary that does not parse is still returned as it was (null), and shadowed.
  const unparsed = summarizer(mounts, async () => worker(SUMMARY), ledger(), "no json");
  assert.equal(await unparsed.summarize({ context: "x" }), null);
  assert.equal((await unparsed.book.shadowRows())[0]!.parses, true);

  // A ledger that cannot be written changes nothing either.
  const stderr: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { stderr.push(chunk); return true; }) as typeof process.stderr.write;
  try {
    for (const failure of [new Error("disk full"), "disk gone"]) {
      const judge = realRiskJudge({ mount: resolveRiskJudgeRoleMount(mounts), cwd: REPO_ROOT, settingsFile: SETTINGS,
        shadowLog: () => { throw failure; }, spawn: async () => worker(LOW) });
      assert.equal((await judge(INPUT)).verdict, "low");
      await settle();
    }
  } finally {
    process.stderr.write = write;
  }
  assert.deepEqual(stderr, ["judge shadow ledger unavailable: disk full\n", "judge shadow ledger unavailable: disk gone\n"]);

  // A primary that never parses returns the malformed-response verdict and asks no shadow.
  const malformed = riskJudge(mounts, async () => assert.fail("no answer, so no shadow"), ledger(), "nothing");
  assert.equal((await malformed.judge(INPUT)).availability, "unavailable");
  await settle();
  assert.deepEqual(malformed.book.rows, []);
});

test("W1-T12187 criterion 4: each shadow call reserves against the normal figure of the daily cash cap; when the cap refuses, no request is sent and one row says so", async (t) => {
  const mounts = cashShadowed();
  const root = ownedFixtureDir(t, "judge-shadow-cap").dir;
  // The normal figure has no room; the squeezed figure has plenty.
  const config = {
    root, claudeBin: "/unused", dailyCapUsd: { normal: 0.000001, squeezed: 25 },
    workerProviders: { enabled: ["claude", "cash"], reservePercent: 5, capacityCacheMs: 60_000, cashEndpoint: "https://openai.example.test/" },
  } as unknown as Config;
  const sent: SpawnWorkerArgs[] = [];
  let requests = 0;
  // What the worker's cash path does: reserve against the figure the args select, and only then send.
  const cash: Spawn = async (args) => {
    reserveOpenWeightBudget(config, { requestId: `shadow-${++requests}`, deployment: "gpt-oss-120b",
      requestBodyBytes: Buffer.byteLength(args.prompt, "utf8"), atIso: ISO, squeezed: args.cashSqueezed === true });
    sent.push(args);
    return worker(LOW);
  };
  const refused = riskJudge(mounts, cash);
  assert.equal((await refused.judge(INPUT)).verdict, "low");
  const rows = await refused.book.shadowRows();
  await settle();
  assert.equal(sent.length, 0, "no request is sent after the cap refuses");
  assert.equal(refused.spawned.length, 2, "the shadow is not asked again on another figure");
  assert.equal(refused.spawned[1]!.cashSqueezed, false, "the shadow never selects the squeezed figure");
  assert.deepEqual(refused.book.rows.map((row) => [row.step, row.refusal]), [["judge_shadow.skipped", "budget"]]);
  assert.match(String(rows[0]!.reason), /would exceed the \$0\.00 dailyCapUsd \(fleet limit, normal posture\)/);
  // Positive control: the same request on the squeezed figure is admitted, so the refusal above is the normal figure's.
  await cash({ ...refused.spawned[1]!, cashSqueezed: true });
  assert.equal(sent.length, 1);

  // The worker's own refusals, returned or thrown, are each one row and no answer.
  const refusals: Array<[string, Spawn]> = [
    ["budget", async () => worker("", { isError: true, budgetRefused: true, cashAllowanceLimit: "fleet" })],
    ["budget", async () => worker("", { isError: true, budgetRefused: true })],
    ["budget", async () => { throw new OpenWeightAllowanceExhaustedError({ committedUsd: 10, capUsd: 10, wantUsd: 0.001, utcDay: "2026-11-17" }); }],
    ["capacity", async () => worker("", { isError: true, openWeightCapacityShortfall: {
      reason: "capacity_shortfall", deployment: "gpt-oss-120b", estimatedTokens: 30_000, limitTokens: 20_000 } })],
    ["capacity", async () => { throw new OpenWeightRequestTooLargeError({ estimatedTokens: 30_000, capability: "economy", considered: ["gpt-oss-120b"] }); }],
  ];
  for (const [refusal, shadow] of refusals) {
    const summary = summarizer(mounts, shadow);
    assert.deepEqual(await summary.summarize({ context: "x" }), JSON.parse(SUMMARY));
    assert.deepEqual((await summary.book.shadowRows()).map((row) => [row.step, row.refusal]), [["judge_shadow.skipped", refusal]]);
  }
});

/** A W1-T11075 row, written by its own writer. */
async function t11075Row(book: ReturnType<typeof ledger>, surface: "ci-judge" | "fix-progress", primary: string, shadow: Spawn): Promise<void> {
  const mount: JudgeMount = { model: "haiku", effort: "low", maxTurns: 400, contextBudget: 60000, shadow: { provider: "cash", deployment: "DeepSeek-V4-Flash" } };
  await runJudgeShadow({
    surface, key: "PR9@def5678", mount, primaryArgs: { cwd: REPO_ROOT, prompt: "judge this" } as SpawnWorkerArgs, primaryVerdict: primary,
    parse: (text) => (text === "" ? undefined : text), agreementKey: (verdict) => verdict, spawn: shadow, log: book.log,
  });
}

test("W1-T12187 criterion 5: a summary gives, for each role, the paired calls, the share that agree, the share with no usable shadow answer and the median cost of each model, and covers the ci and fix-progress rows of W1-T11075", async (t) => {
  const mounts = cashShadowed();
  const book = ledger();
  // The risk judge: three agree, one disagrees, one fails, one is refused by the cap.
  const risk: Spawn[] = [
    async () => worker(LOW, { costUsd: 0.0001 }), async () => worker(LOW, { costUsd: 0.0002 }), async () => worker(LOW, { costUsd: 0.0003 }),
    async () => worker(HIGH, { costUsd: 0.0004 }), async () => { throw new Error("endpoint reset"); },
    async () => worker("", { isError: true, budgetRefused: true }),
  ];
  for (const shadow of risk) await riskJudge(mounts, shadow, book).judge(INPUT);
  // The decision summary: two replies parse, one does not.
  for (const reply of [SUMMARY, SUMMARY, "no json"]) await summarizer(mounts, async () => worker(reply), book).summarize({ context: "x" });
  await book.shadowRows(9);
  // W1-T11075's rows: the ci judge pairs once, fails once and is refused once; the fix-progress judge disagrees once.
  await t11075Row(book, "ci-judge", "add", async () => worker("add", { costUsd: 0.0005 }));
  await t11075Row(book, "ci-judge", "add", async () => worker(""));
  await t11075Row(book, "ci-judge", "add", async () => worker("", { isError: true, budgetRefused: true }));
  await t11075Row(book, "fix-progress", "continue", async () => worker("escalate"));
  // A row from before the window, and rows that are not shadow rows, are not counted.
  const old = ledger(fixedClock(NOW - JUDGE_CASH_BAR.windowMs - 1).iso());
  await riskJudge(mounts, async () => worker(HIGH), old).judge(INPUT);
  await old.shadowRows();
  const rows = [...old.rows, ...book.rows, { ts: ISO, step: "risk_judge.decision", role: "risk-judge", agreement: true }, { ts: ISO, step: "judge_shadow.compared" }];

  const expected: JudgeShadowRoleSummary[] = [
    { role: "ci-judge", paired: 1, agreeShare: 1, noAnswerShare: 0.5, refused: 1, primaryMedianCostUsd: null, shadowMedianCostUsd: 0.0002 },
    { role: "decision-summary", paired: 2, agreeShare: null, noAnswerShare: 1 / 3, refused: 0, primaryMedianCostUsd: 0.002, shadowMedianCostUsd: 0.0002 },
    { role: "fix-progress", paired: 1, agreeShare: 0, noAnswerShare: 0, refused: 0, primaryMedianCostUsd: null, shadowMedianCostUsd: 0.0002 },
    { role: "risk-judge", paired: 4, agreeShare: 0.75, noAnswerShare: 0.2, refused: 1, primaryMedianCostUsd: 0.003, shadowMedianCostUsd: 0.0002 },
  ];
  const summary = judgeShadowSummary(rows, NOW - JUDGE_CASH_BAR.windowMs);
  assert.deepEqual(summary, expected);
  // Without a window the old disagreement is counted too.
  assert.deepEqual(judgeShadowSummary(rows).find((s) => s.role === "risk-judge")!.agreeShare, 0.6);
  assert.deepEqual(judgeShadowSummary([]), []);

  // The config gardener reads those steps, and its inventory holds the same summary over the bar's window.
  for (const step of JUDGE_SHADOW_STEPS) assert.ok(CONFIG_GARDEN_LEDGER_STEPS.includes(step), step);
  const root = gardenRoot(t);
  let reply: unknown;
  await serveConfigMeasurement({ kind: "inventory", repoRoot: root, stateDir: join(root, "state"), nowMs: NOW, rows, weights: {}, recommendations: [] },
    { postMessage: (message) => { reply = message; } });
  assert.deepEqual((reply as { ok: true; value: ConfigInventory }).value.judgeShadows, expected);
});

/** A checkout the config gardener can read: the repo's mounts table, an empty plan and a state directory. */
function gardenRoot(t: FixtureScope, mountsText = TABLE): string {
  const root = ownedFixtureDir(t, "judge-shadow-garden").dir;
  mkdirSync(join(root, ".remudero"));
  mkdirSync(join(root, "state"));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(mountsPath(root), mountsText);
  return root;
}

function inventory(...judgeShadows: JudgeShadowRoleSummary[]): ConfigInventory {
  return { nowIso: ISO, runs: [], queued: [], recommendations: [], active: [], cooling: [], judgeShadows };
}

function record(role: string, over: Partial<JudgeShadowRoleSummary> = {}): JudgeShadowRoleSummary {
  return { role, paired: 200, agreeShare: 0.98, noAnswerShare: 0.02, refused: 3, primaryMedianCostUsd: 0.003, shadowMedianCostUsd: 0.0002, ...over };
}

test("W1-T12187 criterion 6: the config gardener proposes one change that puts a role's own row on the cash provider when the role clears the bar, and nothing below the bar or with no agreement figure", (t) => {
  const root = gardenRoot(t);
  const rng = () => 0;
  assert.deepEqual([JUDGE_CASH_BAR.minPaired, JUDGE_CASH_BAR.minAgreeShare, JUDGE_CASH_BAR.maxNoAnswerShare, JUDGE_CASH_BAR.windowMs],
    [200, 0.98, 0.02, 14 * 24 * 3600 * 1000]);

  // Exactly at the bar: one change, one line, on the role's own row. The risk judge fails closed, so W1-T13501
  // skips it and the decision summary's row is the one proposed.
  const deps: GardenerDeps = { repoRoot: root, stateDir: join(root, "state"), clock: fixedClock(NOW), seed: 7, log: () => {},
    openWorkspace: () => { throw new Error("no workspace is opened to list candidates"); } };
  const spec = configGardenSpec(deps);
  const clearing = inventory(record("risk-judge"), record("decision-summary"));
  const actions = spec.candidates(clearing, rng);
  assert.equal(actions.length, 1);
  const action = actions[0]!;
  assert.deepEqual([action.class, action.target, action.scope, action.cohort.kind], ["move-judge-to-cash", "decision-summary", "judge:decision-summary", "all"]);
  assert.deepEqual(action.edits, [{
    path: ".remudero/mounts.yaml",
    from: "feedback_summary: { model: haiku, effort: low, max_turns: 400, context_budget: 60000 }",
    to: "feedback_summary: { model: haiku, effort: low, max_turns: 400, context_budget: 60000, provider: cash }",
  }]);
  assert.match(action.reason, /agreed on 98\.0% of 200 paired calls in 14 days, and 2\.0% of its calls gave no usable answer/);
  assert.notEqual(spec.fingerprint(clearing), spec.fingerprint(inventory(record("decision-summary", { agreeShare: 0.97 }))));

  // Below the bar on any one figure, or with no agreement figure, or with nothing measured: nothing.
  const below: JudgeShadowRoleSummary[] = [
    record("decision-summary", { agreeShare: 0.97 }),
    record("decision-summary", { paired: 199 }),
    record("decision-summary", { noAnswerShare: 0.03 }),
    record("decision-summary", { noAnswerShare: null }),
    record("decision-summary", { agreeShare: null }),
  ];
  for (const s of below) assert.deepEqual(configCandidates(inventory(s), root, rng), [], JSON.stringify(s));
  assert.deepEqual(configCandidates({ ...inventory(), judgeShadows: undefined }, root, rng), []);
  // A role that is no role at all: nothing.
  assert.deepEqual(configCandidates(inventory(record("unknown-role")), root, rng), []);
  assert.deepEqual(configCandidates(inventory(record("decision-summary")), join(root, "missing"), rng), [], "no mounts table");
  // A row that is not on the lowest tier would not be served from the cash economy row: nothing.
  const dear = gardenRoot(t, TABLE.replace("feedback_summary: { model: haiku,", "feedback_summary: { model: sonnet,"));
  assert.deepEqual(configCandidates(inventory(record("decision-summary")), dear, rng), []);

  // The change, applied: the role's row names the cash provider, the table still loads, and it is not proposed twice.
  assert.deepEqual(applyConfigEdits(root, action.edits), [".remudero/mounts.yaml"]);
  const moved = loadMounts(mountsPath(root));
  assert.deepEqual(resolveDecisionSummaryMount(moved), { ...resolveDecisionSummaryMount(loadMounts(mountsPath(REPO_ROOT))), provider: "cash" });
  assert.equal(resolveRiskJudgeRoleMount(moved).provider, undefined);
  assert.deepEqual(configCandidates(clearing, root, rng), []);
  // W1-T13501: a row that already names another provider is refused; moving it from that provider is not this class's job.
  const claude = gardenRoot(t, TABLE.replace(action.edits[0]!.from, action.edits[0]!.from.replace(/ \}$/, ", provider: claude }")));
  assert.equal(resolveDecisionSummaryMount(loadMounts(mountsPath(claude))).provider, "claude");
  assert.deepEqual(configCandidates(inventory(record("decision-summary")), claude, rng), []);
});

test("W1-T12187 criterion 7: with no row of its own each role resolves the same mount as today, and with a row the risk judge and the decision summary run on the model and provider the row names", async () => {
  // No row: the cell `resolveRiskJudgeMount` gives, and a spawn that names no provider.
  const bare = table();
  const { provider: _provider, ...cell } = resolveRiskJudgeMount(bare);
  assert.deepEqual(resolveRiskJudgeRoleMount(bare), cell);
  assert.deepEqual(resolveDecisionSummaryMount(bare), cell);
  const unrowed = riskJudge(bare, async () => worker(LOW));
  await unrowed.judge(INPUT);
  await unrowed.book.shadowRows();
  assert.deepEqual([unrowed.spawned[0]!.model, unrowed.spawned[0]!.effort, unrowed.spawned[0]!.mountProvider], [cell.model, cell.effort, undefined]);
  const unrowedSummary = summarizer(bare, async () => worker(SUMMARY));
  await unrowedSummary.summarize({ context: "x" });
  await unrowedSummary.book.shadowRows();
  assert.deepEqual([unrowedSummary.spawned[0]!.model, unrowedSummary.spawned[0]!.effort, unrowedSummary.spawned[0]!.mountProvider], [cell.model, cell.effort, undefined]);

  // The rows this task adds to the repo's table change no model: each equals the cell.
  const repo = loadMounts(mountsPath(REPO_ROOT));
  // W1-T14841: the risk judge's row also names decision-1 as its shadow; its model, effort and provider are the cell's.
  const { shadow: riskShadow, ...repoRiskRow } = repo.risk_judge!;
  assert.deepEqual(repoRiskRow, cell);
  assert.equal(riskShadow?.provider, "decisions");
  assert.deepEqual(repo.feedback_summary, cell);

  // A row: its model, effort and provider.
  const rowed = table({
    risk_judge: { model: "sonnet", effort: "medium", max_turns: 400, context_budget: 60000, provider: "claude" },
    feedback_summary: { model: "sonnet", effort: "low", max_turns: 400, context_budget: 60000, provider: "codex" },
  });
  const risk = riskJudge(rowed, async () => worker(LOW));
  await risk.judge(INPUT);
  const [riskRow] = await risk.book.shadowRows();
  assert.deepEqual([risk.spawned[0]!.model, risk.spawned[0]!.effort, risk.spawned[0]!.mountProvider], ["sonnet", "medium", "claude"]);
  assert.equal(riskRow!.primary_provider, "claude");
  const summary = summarizer(rowed, async () => worker(SUMMARY));
  await summary.summarize({ context: "x" });
  await summary.book.shadowRows();
  assert.deepEqual([summary.spawned[0]!.model, summary.spawned[0]!.effort, summary.spawned[0]!.mountProvider], ["sonnet", "low", "codex"]);

  // A caller that is not the risk judge role (no shadow ledger) keeps today's spawn: no provider, no shadow.
  const spawned: SpawnWorkerArgs[] = [];
  const other = realRiskJudge({ mount: resolveRiskJudgeRoleMount(rowed), cwd: REPO_ROOT, settingsFile: SETTINGS,
    spawn: async (args) => { spawned.push(args); return worker(LOW); } });
  await other(INPUT);
  await settle();
  assert.deepEqual(spawned.map((args) => args.mountProvider), [undefined]);

  // A role whose row is already on cash runs there and is not shadowed: a model is never compared with itself.
  const onCash = riskJudge(table({ risk_judge: { model: "haiku", effort: "low", max_turns: 400, context_budget: 60000, provider: "cash" } }),
    async () => assert.fail("a role on cash has no shadow"));
  assert.equal((await onCash.judge(INPUT)).verdict, "low");
  await settle();
  assert.deepEqual([onCash.spawned.length, onCash.spawned[0]!.mountProvider, onCash.book.rows.length], [1, "cash", 0]);
});
