import assert from "node:assert/strict";
import { test } from "node:test";
import type { Mount } from "../src/lib/mounts.js";
import type { spawnWorker, WorkerResult } from "../src/lib/worker.js";
import {
  argmaxTypedJudgmentOption,
  buildTypedJudgmentPrompt,
  buildTypedJudgmentSpawnArgs,
  parseTypedJudgmentResponse,
  runTypedJudgment,
  TYPED_JUDGMENT_MAX_TURNS,
  TYPED_JUDGMENT_TOOLS,
} from "../src/lib/typed-judgment.js";
import {
  planRiskJudgeAction,
  RISK_JUDGE_TYPED_OPTIONS,
  runRiskJudge,
  typedRiskJudgment,
  type RiskJudgeInput,
  type RiskJudgeOrchestratorDeps,
  type RiskJudgeVerdict,
} from "../src/lib/risk-judge.js";

// ── shared fixtures (mirrors test/risk-judge.test.ts's own shapes) ────────────────────

function baseInput(overrides: Partial<RiskJudgeInput> = {}): RiskJudgeInput {
  return {
    change: { description: "add a fuzzy-search helper to serve.ts", files: ["src/lib/serve.ts"] },
    gatesState: { lint: "pass", typecheck: "pass", tests: "pass" },
    planContext: { taskId: "W1-T900", planRefs: ["P34"] },
    ...overrides,
  };
}

function fakeWorkerResult(text: string): WorkerResult {
  return {
    sessionId: "s-typed-judgment",
    costUsd: 0.0001,
    numTurns: 1,
    text,
    blocks: [text],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "haiku",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

const MOUNT: Mount = { model: "haiku", effort: "medium", maxTurns: 20, contextBudget: 60000 };

// ── W1-T4672 acceptance criterion 1 ────────────────────────────────────────────────────

test("W1-T4672: the typed judgment returns a distribution over the fixed options and rejects anything else", async () => {
  // A clean response over a two-option set returns a full distribution.
  const clean = parseTypedJudgmentResponse('TYPED_JUDGMENT: {"low": 0.9, "high": 0.1}', ["low", "high"] as const);
  assert.deepEqual(clean, { kind: "distribution", distribution: { low: 0.9, high: 0.1 } });
  assert.equal(argmaxTypedJudgmentOption((clean as { distribution: Record<string, number> }).distribution), "low");

  // Out-of-set key: rejected, never coerced into one of the declared options.
  const outOfSet = parseTypedJudgmentResponse('TYPED_JUDGMENT: {"low": 0.5, "medium": 0.5}', ["low", "high"] as const);
  assert.equal(outOfSet.kind, "rejected");
  assert.match((outOfSet as { reason: string }).reason, /out-of-set/);

  // Missing option: rejected, not defaulted to 0.
  const missing = parseTypedJudgmentResponse('TYPED_JUDGMENT: {"low": 1}', ["low", "high"] as const);
  assert.equal(missing.kind, "rejected");
  assert.match((missing as { reason: string }).reason, /missing/);

  // Non-numeric value: rejected.
  const nonNumeric = parseTypedJudgmentResponse('TYPED_JUDGMENT: {"low": "high", "high": 0}', ["low", "high"] as const);
  assert.equal(nonNumeric.kind, "rejected");

  // Out-of-range value: rejected.
  const outOfRange = parseTypedJudgmentResponse('TYPED_JUDGMENT: {"low": 1.5, "high": -0.5}', ["low", "high"] as const);
  assert.equal(outOfRange.kind, "rejected");

  // Does not sum to 1: rejected.
  const badSum = parseTypedJudgmentResponse('TYPED_JUDGMENT: {"low": 0.2, "high": 0.2}', ["low", "high"] as const);
  assert.equal(badSum.kind, "rejected");
  assert.match((badSum as { reason: string }).reason, /summed to/);

  // Unparseable/malformed JSON and a response with no TYPED_JUDGMENT line at all: rejected.
  assert.equal(parseTypedJudgmentResponse('TYPED_JUDGMENT: {not json}', ["low", "high"] as const).kind, "rejected");
  assert.equal(parseTypedJudgmentResponse('no machine-readable line here', ["low", "high"] as const).kind, "rejected");

  // Tool-less, single-turn, BY CONSTRUCTION — Jev's model, never a multi-turn session.
  assert.deepEqual(TYPED_JUDGMENT_TOOLS, []);
  assert.equal(TYPED_JUDGMENT_MAX_TURNS, 1);
  const spawnArgs = buildTypedJudgmentSpawnArgs({
    question: "Classify this change's RISK.",
    options: ["low", "high"] as const,
    mount: MOUNT,
    cwd: "/tmp/x",
    settingsFile: "/tmp/settings.json",
  });
  assert.deepEqual(spawnArgs.tools, []);
  assert.equal(spawnArgs.maxTurns, 1);
  assert.match(spawnArgs.prompt, /TYPED_JUDGMENT:/);
  assert.match(buildTypedJudgmentPrompt({ question: "q", options: ["low", "high"] as const }), /\blow\b[\s\S]*\bhigh\b/);

  // The end-to-end call: a real (injected) spawn returning a clean distribution.
  const spawn = (async () => fakeWorkerResult('TYPED_JUDGMENT: {"low": 0.7, "high": 0.3}')) as typeof spawnWorker;
  const outcome = await runTypedJudgment({
    question: "Classify this change's RISK.",
    options: ["low", "high"] as const,
    mount: MOUNT,
    cwd: "/tmp/x",
    settingsFile: "/tmp/settings.json",
    spawn,
  });
  assert.deepEqual(outcome, { kind: "distribution", distribution: { low: 0.7, high: 0.3 } });

  // The risk judge's own typed-choice entry point reuses the SAME two-label option set
  // the session judge already classifies over — no second vocabulary to drift.
  assert.deepEqual(RISK_JUDGE_TYPED_OPTIONS, ["low", "high"]);
  const riskSpawn = (async () => fakeWorkerResult('TYPED_JUDGMENT: {"low": 0.2, "high": 0.8}')) as typeof spawnWorker;
  const riskOutcome = await typedRiskJudgment({
    input: baseInput(),
    mount: MOUNT,
    cwd: "/tmp/x",
    settingsFile: "/tmp/settings.json",
    spawn: riskSpawn,
  });
  assert.deepEqual(riskOutcome, { kind: "distribution", distribution: { low: 0.2, high: 0.8 } });
  const rejectingRiskSpawn = (async () => fakeWorkerResult('TYPED_JUDGMENT: {"low": 0.5, "unknown": 0.5}')) as typeof spawnWorker;
  const rejectedRiskOutcome = await typedRiskJudgment({
    input: baseInput(),
    mount: MOUNT,
    cwd: "/tmp/x",
    settingsFile: "/tmp/settings.json",
    spawn: rejectingRiskSpawn,
  });
  assert.equal(rejectedRiskOutcome.kind, "rejected");
});

// ── W1-T4672 acceptance criterion 2 ────────────────────────────────────────────────────

test("W1-T4672: the typed judgment runs in shadow beside the session judge", async () => {
  const input = baseInput();
  const sessionVerdict: RiskJudgeVerdict = { verdict: "low", confidence: 0.95, reasons: ["routine, well-trodden change"] };

  async function runWithTypedJudge(
    typedJudge: RiskJudgeOrchestratorDeps["typedJudge"],
  ): Promise<{ rows: { step: string; extra?: Record<string, unknown> }[]; result: Awaited<ReturnType<typeof runRiskJudge>> }> {
    const rows: { step: string; extra?: Record<string, unknown> }[] = [];
    const escalateCalls: unknown[] = [];
    const result = await runRiskJudge(
      input,
      {
        judge: async () => sessionVerdict,
        escalate: async () => {
          escalateCalls.push(true);
          return "https://example.invalid/issue/1";
        },
        log: (step, extra) => rows.push({ step, extra }),
        typedJudge,
      },
    );
    assert.equal(escalateCalls.length, 0, "a low/confident session verdict never escalates");
    return { rows, result };
  }

  // Agreeing typed shadow: ledgered beside the session verdict, and the action is
  // EXACTLY planRiskJudgeAction's own output — the typed call never touches it.
  const agreeing = await runWithTypedJudge(async () => ({ kind: "distribution", distribution: { low: 0.9, high: 0.1 } }));
  assert.deepEqual(agreeing.result.action, planRiskJudgeAction(sessionVerdict));
  const agreeingShadowRow = agreeing.rows.find((r) => r.step === "risk_judge.typed_shadow");
  assert.ok(agreeingShadowRow, "the typed shadow call must be ledgered");
  assert.equal(agreeingShadowRow?.extra?.kind, "distribution");
  assert.equal(agreeingShadowRow?.extra?.argmax, "low");
  assert.equal(agreeingShadowRow?.extra?.agreement, true);
  assert.equal(agreeingShadowRow?.extra?.session_verdict, "low");

  // Disagreeing typed shadow: still ledgered, still advisory — the action is UNCHANGED.
  const disagreeing = await runWithTypedJudge(async () => ({ kind: "distribution", distribution: { low: 0.1, high: 0.9 } }));
  assert.deepEqual(disagreeing.result.action, planRiskJudgeAction(sessionVerdict));
  const disagreeingShadowRow = disagreeing.rows.find((r) => r.step === "risk_judge.typed_shadow");
  assert.equal(disagreeingShadowRow?.extra?.argmax, "high");
  assert.equal(disagreeingShadowRow?.extra?.agreement, false);

  // A rejected typed response: ledgered as rejected, the session action stays UNCHANGED.
  const rejected = await runWithTypedJudge(async () => ({ kind: "rejected", reason: "out-of-set option(s): medium", raw: "x" }));
  assert.deepEqual(rejected.result.action, planRiskJudgeAction(sessionVerdict));
  const rejectedShadowRow = rejected.rows.find((r) => r.step === "risk_judge.typed_shadow");
  assert.equal(rejectedShadowRow?.extra?.kind, "rejected");

  // A THROWING typed judge: never escapes runRiskJudge, and the session action stays UNCHANGED.
  const threw = await runWithTypedJudge(async () => {
    throw new Error("typed judge spawn failed");
  });
  assert.deepEqual(threw.result.action, planRiskJudgeAction(sessionVerdict));
  const thrownShadowRow = threw.rows.find((r) => r.step === "risk_judge.typed_shadow");
  assert.equal(thrownShadowRow?.extra?.kind, "unavailable");
  assert.match(String(thrownShadowRow?.extra?.reason), /typed judge spawn failed/);

  // Omitting `typedJudge` entirely (today's default) never logs a shadow row at all.
  const omitted = await runWithTypedJudge(undefined);
  assert.equal(omitted.rows.find((r) => r.step === "risk_judge.typed_shadow"), undefined);
});
