import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse as parseYaml } from "yaml";
import type { Config } from "#src/lib/config.js";
import { DEFAULT_CASH_KEY_ENV, validateConfigShape } from "#src/lib/config-schema.js";
import {
  CANNOT_TELL_OPTION,
  DECISION_ANSWERED_STEP,
  DECISION_OUTPUT_MARGIN_TOKENS,
  askDecisionModel,
  checkDecisionQuestions,
  decisionsCommand,
  readDecisionAnswers,
  resolveDecisionTarget,
  type DecisionAnswer,
  type DecisionAnsweredRow,
  type DecisionQuestion,
} from "#src/lib/decision-model.js";
import { DECISION_MODEL_SHAPES, loadMounts, mountsPath, validateMounts, type DecisionCandidate } from "#src/lib/mounts.js";
import {
  OPENWEIGHT_ALLOWANCE_FILENAME,
  OPENWEIGHT_MAX_COMPLETION_TOKENS,
  clearOpenWeightAbsence,
  openWeightDeploymentKnownAbsent,
  type OpenWeightAllowanceState,
} from "#src/lib/worker-provider.js";
import { readLedgerLines } from "#src/lib/status.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const DEFAULT_KEY = "fixture-default-key-never-printed";
const NAMED_KEY = "fixture-named-key-never-printed";
const WORKER_KEY = "fixture-worker-key-never-printed";
const env = { [DEFAULT_CASH_KEY_ENV]: DEFAULT_KEY, RMD_CASH_NAMED_API_KEY: NAMED_KEY, RMD_CASH_WORKER_API_KEY: WORKER_KEY };
const INPUT = "PR 1: changes docs/readme.md only, two lines.";
const DEPLOYMENT = "fixture-decisions";

const PRICE = { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.05, readAt: "2026-11-12", source: "fixture page" };
const openAiCandidate: DecisionCandidate = { name: "fixture-openai", deployment: DEPLOYMENT, shape: "openai-decisions",
  endpoint: { source: "cash-entry", entry: "named-entry" }, price: PRICE };
const microsoftCandidate: DecisionCandidate = { name: "fixture-microsoft", deployment: DEPLOYMENT, shape: "microsoft-systemone",
  endpoint: { source: "cash-default" }, price: PRICE };

const QUESTIONS = [
  { type: "yes-no", name: "docs_only", instructions: "Does the change touch only docs?" },
  { type: "choice", name: "risk", instructions: "How risky is it?", options: [{ value: "low", description: "safe" }, { value: "high" }] },
  { type: "score", name: "size", instructions: "How big is it?", levels: [{ label: "tiny" }, { label: "small" }, { label: "medium" }, { label: "large" }] },
];

function fixture(t: TestContext, cap: Config["dailyCapUsd"] = 25): { dir: string; config: Config } {
  clearOpenWeightAbsence();
  t.after(() => clearOpenWeightAbsence());
  const { dir } = ownedFixtureDir(t, "decision-model");
  return { dir, config: { claudeBin: "/unused", root: dir, dailyCapUsd: cap, workerProviders: {
    cashEndpoint: "https://default.example.test/",
    cashDeploymentEndpoints: {
      [DEPLOYMENT]: { endpoint: "https://worker.cognitiveservices.azure.com/", keyEnv: "RMD_CASH_WORKER_API_KEY" },
      "named-entry": { endpoint: "https://named.cognitiveservices.azure.com/", keyEnv: "RMD_CASH_NAMED_API_KEY" },
    } } } as Config };
}

type Sent = { url: string; key: string | null; body: Record<string, unknown> };

function replying(seen: Sent[], ...replies: Array<() => Response>): typeof fetch {
  let index = 0;
  return async (url, init) => {
    seen.push({ url: String(url), key: new Headers(init?.headers).get("api-key"), body: JSON.parse(String(init?.body)) });
    return replies[Math.min(index++, replies.length - 1)]!();
  };
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

// The reply shapes OBSERVED 2026-11-12 from inside remudero-daemon.
const OPENAI_USAGE = { input_tokens: 387, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 0,
  output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 387 };
const openAiReply = (answers: unknown[]) => json({ model: "served-fixture", answers, usage: OPENAI_USAGE });
const OPENAI_ANSWERS = [
  { type: "predicate", name: "docs_only", probability: 0.97 },
  { type: "choice", name: "risk", choice: "low", probabilities: [{ value: "low", probability: 0.9 }, { value: "high", probability: 0.1 }], confidence: 0.9 },
  { type: "score", name: "size", score: 0, confidence: 0.8, probabilities: [{ value: 0, label: "tiny", probability: 0.8 },
    { value: 1, label: "small", probability: 0.15 }, { value: 2, label: "medium", probability: 0.04 }, { value: 3, label: "large", probability: 0.01 }] },
];
const microsoftReply = (answers: Record<string, unknown>) => json({ model: "served-fixture", answers, usage: { input_tokens: 101, output_tokens: 3 } });
const MICROSOFT_ANSWERS = {
  docs_only: { type: "noul", noul: 0.9964 },
  risk: { type: "choice", choice: "string:low", confidence: 0.848,
    probabilities: { "string:high": 0.0759, "string:low": 0.9191, [CANNOT_TELL_OPTION]: 0.005 } },
  size: { type: "score", score: 0.0707, confidence: 0.908, legend: { 0: "tiny", 1: "small", 2: "medium", 3: "large" },
    probabilities: { 0: 0.931, 1: 0.0674, 2: 0.0012, 3: 0.0003 } },
};

function allowance(dir: string): OpenWeightAllowanceState | undefined {
  try { return JSON.parse(readFileSync(join(dir, "state", OPENWEIGHT_ALLOWANCE_FILENAME), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** The decision_answered rows, read with the daemon's own ledger reader. */
function answeredRows(dir: string): Array<Record<string, unknown>> {
  return readLedgerLines(join(dir, "state", "ledger.ndjson")).filter((row) => row.step === DECISION_ANSWERED_STEP);
}

const answer = (row: DecisionAnsweredRow, name: string): DecisionAnswer => row.answers.find((a) => a.name === name)!;

test("W1-T12416 criterion 1: a question set outside the bounds, or with a duplicate name or option, is refused before any reservation", async (t) => {
  const choice = (n: number) => ({ type: "choice", name: "pick", instructions: "Pick.", options: Array.from({ length: n }, (_, i) => ({ value: `o${i}` })) });
  const score = (n: number) => ({ type: "score", name: "rank", instructions: "Rank.", levels: Array.from({ length: n }, (_, i) => ({ label: `l${i}` })) });
  for (const shape of DECISION_MODEL_SHAPES) {
    assert.equal(checkDecisionQuestions(QUESTIONS, shape).ok, true);
    assert.equal(checkDecisionQuestions([choice(2), score(2)], shape).ok, true);
    assert.equal(checkDecisionQuestions([choice(255), score(10)], shape).ok, true);
    for (const bad of [[], [choice(1)], [choice(256)], [score(1)], [score(11)],
      [QUESTIONS[0], { ...QUESTIONS[0] }], [{ type: "yes-no", instructions: "No name." }],
      [{ type: "choice", name: "pick", instructions: "Pick.", options: [{ value: "a" }, { value: "a" }] }],
      [{ type: "score", name: "rank", instructions: "Rank.", levels: [{ label: "a" }, { label: "a" }] }],
      [{ type: "estimate", name: "x", instructions: "Guess." }], Array.from({ length: 401 }, (_, i) => ({ type: "yes-no", name: `q${i}`, instructions: "Yes?" }))]) {
      assert.equal(checkDecisionQuestions(bad, shape).ok, false, JSON.stringify(bad).slice(0, 80));
    }
  }
  const typed = [{ type: "choice", name: "flag", instructions: "Which?", options: [{ value: true }, { value: "true" }] }];
  assert.equal(checkDecisionQuestions(typed, "openai-decisions").ok, true, "a boolean and its text are two options");
  assert.equal(checkDecisionQuestions(typed, "microsoft-systemone").ok, true, "typed options are provider-neutral");
  const { dir, config } = fixture(t);
  const seen: Sent[] = [];
  const row = await askDecisionModel(config, { role: "probe", candidate: openAiCandidate, input: INPUT, questions: [choice(1)],
    env, fetchImpl: replying(seen, openAiReply(OPENAI_ANSWERS)) });
  assert.equal(seen.length, 0);
  assert.equal(allowance(dir), undefined, "no reservation was made");
  assert.equal(row.outcome, "refused");
  assert.equal(row.reason, "invalid-questions");
  assert.equal(row.reserved_usd, 0);
});

test("W1-T12416 criterion 1: Microsoft wire identifiers preserve distinct typed options and the user's cannot_tell option", async (t) => {
  const { config } = fixture(t);
  const values = [true, "true", false, "false", CANNOT_TELL_OPTION, "boolean:true", "string:true", "__proto__"];
  const wires = ["boolean:true", "string:true", "boolean:false", "string:false", "string:cannot_tell",
    "string:boolean:true", "string:string:true", "string:__proto__"];
  const questions = [{ type: "choice", name: "flag", instructions: "Which typed value?", options: values.map((value) => ({ value })) }];
  for (const candidate of [openAiCandidate, microsoftCandidate]) {
    assert.equal(checkDecisionQuestions(questions, candidate.shape).ok, true);
    for (const [picked, value] of values.entries()) {
      const distribution = values.map((option, index) => ({ option, probability: index === picked ? 1 : 0 }));
      const probabilities = Object.fromEntries(wires.map((wire, index) => [wire, index === picked ? 1 : 0]));
      const seen: Sent[] = [];
      const row = await askDecisionModel(config, { role: "probe", candidate, input: INPUT, questions, env,
        fetchImpl: replying(seen, candidate.shape === "openai-decisions"
          ? openAiReply([{ type: "choice", name: "flag", choice: value, confidence: 1,
            probabilities: distribution.map(({ option, probability }) => ({ value: option, probability })) }])
          : microsoftReply({ flag: { type: "choice", choice: wires[picked], confidence: 1,
            probabilities: { ...probabilities, [CANNOT_TELL_OPTION]: 0 } } })) });
      assert.equal(seen.length, 1, "one input and all options travel in one request");
      assert.equal(row.outcome, "answered");
      assert.deepEqual(answer(row, "flag"), { name: "flag", outcome: "distribution", confidence: 1, distribution,
        ...(candidate.shape === "microsoft-systemone" ? { cannotTell: 0 } : {}) });
      if (candidate.shape === "microsoft-systemone") {
        const sent = seen[0]!.body.questions as Record<string, { criteria: Record<string, string> }>;
        assert.deepEqual(Object.keys(sent.flag!.criteria), [...wires, CANNOT_TELL_OPTION]);
        assert.equal(sent.flag!.criteria["boolean:true"], "true");
        assert.equal(sent.flag!.criteria["string:true"], '"true"');
        assert.equal(sent.flag!.criteria["string:cannot_tell"], '"cannot_tell"');
      }
    }
  }
  const abstained = await askDecisionModel(config, { role: "probe", candidate: microsoftCandidate, input: INPUT, questions, env,
    fetchImpl: replying([], microsoftReply({ flag: { type: "choice", choice: CANNOT_TELL_OPTION,
      probabilities: { [CANNOT_TELL_OPTION]: 1 } } })) });
  assert.deepEqual(answer(abstained, "flag"), { name: "flag", outcome: "abstained", reason: "cannot-tell" });
  for (const invalid of [
    { choice: "true", probabilities: { "boolean:true": 1, "string:true": 0, [CANNOT_TELL_OPTION]: 0 } },
    { choice: "boolean:true", probabilities: { true: 1, "string:true": 0, [CANNOT_TELL_OPTION]: 0 } },
  ]) {
    const row = await askDecisionModel(config, { role: "probe", candidate: microsoftCandidate, input: INPUT,
      questions: [{ ...questions[0], options: [{ value: true }, { value: "true" }] }], env,
      fetchImpl: replying([], microsoftReply({ flag: { type: "choice", ...invalid } })) });
    assert.equal(answer(row, "flag").outcome, "rejected", "unencoded values are not coerced into wire identifiers");
  }
});

test("W1-T12416 criterion 2: the OpenAI-shape backend sends an array and reads each answer in order, keeping typed option values", async (t) => {
  const { config } = fixture(t);
  const seen: Sent[] = [];
  const questions = [...QUESTIONS,
    { type: "choice", name: "flag", instructions: "Which?", options: [{ value: true }, { value: "true" }] },
    { type: "yes-no", name: "secret", instructions: "Is there a secret?" }];
  const row = await askDecisionModel(config, { role: "risk", candidate: openAiCandidate, input: INPUT, questions, env,
    fetchImpl: replying(seen, openAiReply([...OPENAI_ANSWERS,
      { type: "choice", name: "flag", choice: true, confidence: 0.7, probabilities: [{ value: "true", probability: 0.3 }, { value: true, probability: 0.7 }] },
      { type: "refusal", name: "secret" }])) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://named.cognitiveservices.azure.com/openai/v1/decisions");
  assert.deepEqual(seen[0]!.body, { model: DEPLOYMENT, input: INPUT, questions: [
    { type: "predicate", name: "docs_only", instructions: "Does the change touch only docs?" },
    { type: "choice", name: "risk", instructions: "How risky is it?", choices: [{ value: "low", description: "safe" }, { value: "high" }] },
    { type: "score", name: "size", instructions: "How big is it?", levels: [{ label: "tiny" }, { label: "small" }, { label: "medium" }, { label: "large" }] },
    { type: "choice", name: "flag", instructions: "Which?", choices: [{ value: true }, { value: "true" }] },
    { type: "predicate", name: "secret", instructions: "Is there a secret?" }] });
  assert.equal(row.outcome, "answered");
  assert.deepEqual(answer(row, "docs_only"), { name: "docs_only", outcome: "distribution", confidence: null,
    distribution: [{ option: true, probability: 0.97 }, { option: false, probability: 1 - 0.97 }] });
  assert.deepEqual(answer(row, "risk"), { name: "risk", outcome: "distribution", confidence: 0.9,
    distribution: [{ option: "low", probability: 0.9 }, { option: "high", probability: 0.1 }] });
  assert.deepEqual(answer(row, "size"), { name: "size", outcome: "distribution", confidence: 0.8, score: 0, distribution: [
    { option: "tiny", probability: 0.8 }, { option: "small", probability: 0.15 }, { option: "medium", probability: 0.04 }, { option: "large", probability: 0.01 }] });
  assert.deepEqual(answer(row, "flag"), { name: "flag", outcome: "distribution", confidence: 0.7,
    distribution: [{ option: true, probability: 0.7 }, { option: "true", probability: 0.3 }] });
  assert.deepEqual(answer(row, "secret"), { name: "secret", outcome: "abstained", reason: "refusal" });
});

test("W1-T12416 criterion 3: the Microsoft-shape backend sends questions keyed by name with a cannot-tell option, and a cannot-tell answer is an abstention", async (t) => {
  const { config } = fixture(t);
  const seen: Sent[] = [];
  const row = await askDecisionModel(config, { role: "risk", candidate: microsoftCandidate, input: INPUT, questions: QUESTIONS, env,
    fetchImpl: replying(seen, microsoftReply(MICROSOFT_ANSWERS),
      microsoftReply({ ...MICROSOFT_ANSWERS, risk: { type: "choice", choice: CANNOT_TELL_OPTION, confidence: 0.6,
        probabilities: { "string:high": 0.2, "string:low": 0.2, [CANNOT_TELL_OPTION]: 0.6 } } })) });
  assert.equal(seen[0]!.url, "https://default.example.test/providers/microsoft/v1/systemone");
  assert.equal(seen[0]!.key, DEFAULT_KEY);
  assert.deepEqual(seen[0]!.body, { model: DEPLOYMENT, state: INPUT, questions: {
    docs_only: { type: "noul", instructions: "Does the change touch only docs?" },
    risk: { type: "choice", instructions: "How risky is it?", criteria: { "string:low": "safe", "string:high": '"high"',
      [CANNOT_TELL_OPTION]: "The input does not say enough to choose any other option." } },
    size: { type: "score", instructions: "How big is it?", criteria: ["tiny", "small", "medium", "large"] } } });
  assert.equal(row.outcome, "answered");
  assert.deepEqual(answer(row, "docs_only"), { name: "docs_only", outcome: "distribution", confidence: null,
    distribution: [{ option: true, probability: 0.9964 }, { option: false, probability: 1 - 0.9964 }] });
  assert.deepEqual(answer(row, "risk"), { name: "risk", outcome: "distribution", confidence: 0.848, cannotTell: 0.005,
    distribution: [{ option: "low", probability: 0.9191 }, { option: "high", probability: 0.0759 }] });
  assert.deepEqual(answer(row, "size"), { name: "size", outcome: "distribution", confidence: 0.908, score: 0.0707, distribution: [
    { option: "tiny", probability: 0.931 }, { option: "small", probability: 0.0674 }, { option: "medium", probability: 0.0012 }, { option: "large", probability: 0.0003 }] });
  const second = await askDecisionModel(config, { role: "risk", candidate: microsoftCandidate, input: INPUT, questions: QUESTIONS, env,
    fetchImpl: replying(seen, microsoftReply({ ...MICROSOFT_ANSWERS, risk: { type: "choice", choice: CANNOT_TELL_OPTION, confidence: 0.6,
      probabilities: { "string:high": 0.2, "string:low": 0.2, [CANNOT_TELL_OPTION]: 0.6 } } })) });
  assert.deepEqual(answer(second, "risk"), { name: "risk", outcome: "abstained", reason: "cannot-tell" });
});

test("W1-T12416 criterion 4: an out-of-set or badly summed answer is rejected with a reason and never coerced", async (t) => {
  const { config } = fixture(t);
  const ask = (candidate: DecisionCandidate, reply: () => Response, questions: unknown = QUESTIONS) =>
    askDecisionModel(config, { role: "risk", candidate, input: INPUT, questions, env, fetchImpl: replying([], reply) });
  const [yesNo, choice, score] = OPENAI_ANSWERS;
  const cases: Array<[string, unknown[]]> = [
    ["risk", [yesNo, { ...choice, choice: "medium" }, score]],
    ["risk", [yesNo, { ...choice, probabilities: [{ value: "low", probability: 0.9 }, { value: "medium", probability: 0.1 }] }, score]],
    ["risk", [yesNo, { ...choice, probabilities: [{ value: "low", probability: 0.7 }, { value: "high", probability: 0.1 }] }, score]],
    ["risk", [yesNo, { ...choice, probabilities: [{ value: "low", probability: 1 }] }, score]],
    ["risk", [yesNo, { ...choice, confidence: 1.5 }, score]],
    ["docs_only", [{ ...yesNo, probability: 1.2 }, choice, score]],
    ["size", [yesNo, choice, { ...score, probabilities: [{ value: 0, label: "huge", probability: 1 }] }]],
  ];
  for (const [name, answers] of cases) {
    const row = await ask(openAiCandidate, openAiReply(answers));
    assert.equal(row.outcome, "answered");
    const got = answer(row, name);
    assert.equal(got.outcome, "rejected", JSON.stringify(answers));
    assert.ok(got.outcome === "rejected" && got.reason.length > 0);
    assert.equal(row.answers.filter((a) => a.outcome === "rejected").length, 1, "one bad answer leaves the others");
  }
  const typed = [{ type: "choice", name: "flag", instructions: "Which?", options: [{ value: true }, { value: false }] }];
  const textForBoolean = await ask(openAiCandidate, openAiReply([{ type: "choice", name: "flag", choice: "true", confidence: 1,
    probabilities: [{ value: "true", probability: 1 }, { value: false, probability: 0 }] }]), typed);
  assert.equal(answer(textForBoolean, "flag").outcome, "rejected", "the text true is not the boolean true");
  const short = await ask(openAiCandidate, openAiReply([yesNo, choice]));
  assert.ok(short.answers.every((a) => a.outcome === "rejected"));
  const badMicrosoft = await ask(microsoftCandidate, microsoftReply({ ...MICROSOFT_ANSWERS,
    risk: { type: "choice", choice: "string:low", confidence: 0.8,
      probabilities: { "string:low": 0.5, "string:high": 0.1, [CANNOT_TELL_OPTION]: 0.1 } },
    size: { ...MICROSOFT_ANSWERS.size, legend: { 0: "tiny", 1: "big", 2: "medium", 3: "large" } } }));
  assert.equal(answer(badMicrosoft, "risk").outcome, "rejected");
  assert.equal(answer(badMicrosoft, "size").outcome, "rejected");
  assert.equal(answer(badMicrosoft, "docs_only").outcome, "distribution");
  for (const [low, cannotTell, expectedSum] of [[0.6, 0.3, "0.700"], [0.88, 0.02, "0.980"]] as const) {
    const row = await ask(microsoftCandidate, microsoftReply({ ...MICROSOFT_ANSWERS,
      risk: { type: "choice", choice: "string:low", confidence: 0.8,
        probabilities: { "string:low": low, "string:high": 0.1, [CANNOT_TELL_OPTION]: cannotTell } } }));
    assert.deepEqual(answer(row, "risk"), { name: "risk", outcome: "rejected",
      reason: `risk summed to ${expectedSum}, not 1` }, "cannot-tell mass cannot complete the declared-option sum");
    assert.equal(answer(row, "docs_only").outcome, "distribution");
    assert.equal(answer(row, "size").outcome, "distribution");
  }
  for (const [low, cannotTell] of [[0.9, 0], [0.895, 0.005]] as const) {
    const row = await ask(microsoftCandidate, microsoftReply({ ...MICROSOFT_ANSWERS,
      risk: { type: "choice", choice: "string:low", confidence: 0.8,
        probabilities: { "string:low": low, "string:high": 0.1, [CANNOT_TELL_OPTION]: cannotTell } } }));
    assert.deepEqual(answer(row, "risk"), { name: "risk", outcome: "distribution", confidence: 0.8, cannotTell,
      distribution: [{ option: "low", probability: low }, { option: "high", probability: 0.1 }] },
    "declared-option mass inside tolerance is preserved without normalization");
  }
});

test("W1-T12416 criterion 4: score values must match declared ordered labels without duplicates and scores stay in range", () => {
  const questions: DecisionQuestion[] = [{ type: "score", name: "rank", instructions: "Rank.", levels: [{ label: "low" }, { label: "high" }] }];
  const rows = [{ value: 0, label: "low", probability: 0.75 }, { value: 1, label: "high", probability: 0.25 }];
  const base = { type: "score", name: "rank", score: 0.25, confidence: 0.75, probabilities: rows };
  const parse = (raw: unknown) => readDecisionAnswers("openai-decisions", questions, { answers: [raw] })[0]!;
  const expected = { name: "rank", outcome: "distribution", score: 0.25, confidence: 0.75,
    distribution: [{ option: "low", probability: 0.75 }, { option: "high", probability: 0.25 }] };
  assert.deepEqual(parse(base), expected);
  assert.deepEqual(parse({ ...base, probabilities: [...rows].reverse() }), expected, "values identify levels regardless of reply order");
  for (const [values, labels] of [
    [[99, 100], ["low", "high"]], [[0, 0], ["low", "high"]], [[1, 0], ["low", "high"]],
    [[-1, 1], ["low", "high"]], [[0.5, 1], ["low", "high"]], [["0", 1], ["low", "high"]],
    [[0, 1], ["high", "low"]], [[0, 1], ["low", "low"]],
  ] as const) {
    const got = parse({ ...base, probabilities: rows.map((row, index) => ({ ...row, value: values[index], label: labels[index] })) });
    assert.equal(got.outcome, "rejected", JSON.stringify({ values, labels }));
    assert.ok(got.outcome === "rejected" && got.reason.length > 0);
  }
  const microsoft = { type: "score", score: 0.25, confidence: 0.75, legend: { 0: "low", 1: "high" }, probabilities: { 0: 0.75, 1: 0.25 } };
  for (const shape of DECISION_MODEL_SHAPES) {
    const parseScore = (score: unknown) => readDecisionAnswers(shape, questions, { answers: shape === "openai-decisions"
      ? [{ ...base, score }] : { rank: { ...microsoft, score } } })[0]!;
    for (const score of [-1, 99, 1.01, "0", NaN, Infinity]) {
      const got = parseScore(score);
      assert.equal(got.outcome, "rejected", `${shape}: ${String(score)}`);
      assert.ok(got.outcome === "rejected" && got.reason.length > 0);
    }
    for (const score of [0, 0.25, 1]) assert.deepEqual(parseScore(score), { ...expected, score });
  }
});

test("W1-T12416 criterion 5: a candidate reads its endpoint source from the decision_models row and never the worker's entry for its deployment", async (t) => {
  const raw = parseYaml(readFileSync(mountsPath(REPO_ROOT), "utf8")) as Record<string, unknown>;
  const parsed = validateMounts({ ...raw, decision_models: {
    one: { deployment: DEPLOYMENT, shape: "openai-decisions", endpoint: { "cash-entry": "named-entry" }, input_usd_per_million: 0.1,
      output_usd_per_million: 0, read_at: "2026-11-12", source: "a page" },
    two: { deployment: DEPLOYMENT, shape: "microsoft-systemone", endpoint: "cash-default", input_usd_per_million: 0.042,
      output_usd_per_million: 0.042, read_at: "2026-11-12", source: "another page" } } }).decision_models!;
  assert.deepEqual(parsed.one, { ...openAiCandidate, name: "one", price: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0, readAt: "2026-11-12", source: "a page" } });
  assert.deepEqual(parsed.two.endpoint, { source: "cash-default" });
  assert.throws(() => validateMounts({ ...raw, decision_models: { bad: { ...(raw.decision_models as Record<string, object>)[Object.keys(raw.decision_models as object)[0]!], shape: "other" } } }), /shape/);
  assert.throws(() => validateMounts({ ...raw, decision_models: { bad: { deployment: "d", shape: "openai-decisions", endpoint: { "cash-entry": "x" },
    input_usd_per_million: 0.1, output_usd_per_million: 0, read_at: "2026-11-12" } } }), /source/);

  const { config } = fixture(t);
  const before = structuredClone(config);
  const seen: Sent[] = [];
  await askDecisionModel(config, { role: "risk", candidate: openAiCandidate, input: INPUT, questions: QUESTIONS, env,
    fetchImpl: replying(seen, openAiReply(OPENAI_ANSWERS)) });
  await askDecisionModel(config, { role: "risk", candidate: microsoftCandidate, input: INPUT, questions: QUESTIONS, env,
    fetchImpl: replying(seen, microsoftReply(MICROSOFT_ANSWERS)) });
  assert.deepEqual(seen.map((s) => [new URL(s.url).host, s.key]), [["named.cognitiveservices.azure.com", NAMED_KEY], ["default.example.test", DEFAULT_KEY]]);
  assert.ok(seen.every((s) => s.key !== WORKER_KEY && !s.url.includes("worker.")), "the worker's entry is never read");
  assert.deepEqual(config, before, "the config is never changed");
});

test("W1-T12416 criterion 9: both declared candidates resolve from today's config keys, and a missing entry or key is unavailable and sends nothing", async (t) => {
  const declared = Object.values(loadMounts(mountsPath(REPO_ROOT)).decision_models ?? {});
  assert.equal(declared.length, 2);
  assert.deepEqual(declared.map((c) => c.shape).sort(), [...DECISION_MODEL_SHAPES].sort());
  for (const candidate of declared) {
    assert.match(candidate.price.readAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(candidate.price.source.length > 20);
  }
  const microsoft = declared.find((c) => c.shape === "microsoft-systemone")!;
  assert.equal(microsoft.price.outputUsdPerMillion, microsoft.price.inputUsdPerMillion, "output is priced at the input rate");
  assert.match(microsoft.price.source, /W1-T10858/);
  assert.match(declared.find((c) => c.shape === "openai-decisions")!.price.source, /no Decisions price/);
  const entries = declared.flatMap((c) => (c.endpoint.source === "cash-entry" ? [c.endpoint.entry] : []));
  assert.ok(entries.length > 0);
  // Only keys today's config already has: validateConfigShape refuses an unknown field.
  const today = validateConfigShape({ claudeBin: "/unused", root: "/unused", dailyCapUsd: 25, workerProviders: {
    cashEndpoint: "https://default.cognitiveservices.azure.com/",
    cashDeploymentEndpoints: Object.fromEntries(entries.map((entry) => [entry, { endpoint: "https://second.cognitiveservices.azure.com/", keyEnv: "RMD_CASH_EASTUS_API_KEY" }])),
  } }, "today");
  const todayEnv = { [DEFAULT_CASH_KEY_ENV]: DEFAULT_KEY, RMD_CASH_EASTUS_API_KEY: NAMED_KEY };
  for (const candidate of declared) assert.equal(resolveDecisionTarget(today, candidate, todayEnv).ok, true, candidate.name);

  const { config, dir } = fixture(t);
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls++; throw new Error("nothing may be sent"); };
  const noEntry = await askDecisionModel(config, { role: "risk", candidate: { ...openAiCandidate, endpoint: { source: "cash-entry", entry: "absent" } },
    input: INPUT, questions: QUESTIONS, env, fetchImpl });
  const noKey = await askDecisionModel(config, { role: "risk", candidate: openAiCandidate, input: INPUT, questions: QUESTIONS,
    env: { [DEFAULT_CASH_KEY_ENV]: DEFAULT_KEY }, fetchImpl });
  const noEndpoint = await askDecisionModel({ ...config, workerProviders: {} }, { role: "risk", candidate: microsoftCandidate,
    input: INPUT, questions: QUESTIONS, env, fetchImpl });
  assert.equal(calls, 0);
  assert.equal(allowance(dir), undefined);
  assert.deepEqual([noEntry, noKey, noEndpoint].map((r) => [r.outcome, r.reason]),
    [["unavailable", "no-entry"], ["unavailable", "no-key"], ["unavailable", "no-endpoint"]]);
  assert.ok(!JSON.stringify([noEntry, noKey, noEndpoint]).includes(DEFAULT_KEY));
});

test("W1-T12416 criterion 6: a request reserves on input size plus the declared output margin against the normal cap and settles from usage at its own price row", async (t) => {
  const { dir, config } = fixture(t);
  const seen: Sent[] = [];
  const row = await askDecisionModel(config, { role: "risk", candidate: microsoftCandidate, input: INPUT, questions: QUESTIONS, env,
    fetchImpl: replying(seen, microsoftReply(MICROSOFT_ANSWERS)) });
  const bytes = Buffer.byteLength(JSON.stringify(seen[0]!.body), "utf8");
  const reserved = (bytes * PRICE.inputUsdPerMillion + DECISION_OUTPUT_MARGIN_TOKENS * PRICE.outputUsdPerMillion) / 1_000_000;
  const settled = (101 * PRICE.inputUsdPerMillion + 3 * PRICE.outputUsdPerMillion) / 1_000_000;
  assert.equal(DECISION_OUTPUT_MARGIN_TOKENS, 64);
  assert.equal(row.reserved_usd, reserved);
  assert.ok(row.reserved_usd < (bytes * PRICE.inputUsdPerMillion + OPENWEIGHT_MAX_COMPLETION_TOKENS * PRICE.outputUsdPerMillion) / 1_000_000);
  assert.equal(row.settled_usd, settled);
  assert.equal(row.held_usd, 0);
  const [reservation] = Object.values(allowance(dir)!.reservations);
  assert.equal(reservation!.reservedUsd, reserved);
  assert.equal(reservation!.settledUsd, settled);
  assert.equal(reservation!.deployment, DEPLOYMENT);

  const squeezedOnly = fixture(t, { normal: 1e-9, squeezed: 1000 });
  let calls = 0;
  const refused = await askDecisionModel(squeezedOnly.config, { role: "risk", candidate: microsoftCandidate, input: INPUT, questions: QUESTIONS, env,
    fetchImpl: async () => { calls++; return microsoftReply(MICROSOFT_ANSWERS)(); } });
  assert.equal(calls, 0, "the squeezed figure is never read");
  assert.deepEqual([refused.outcome, refused.reason, refused.reserved_usd], ["failed", "budget-refused", 0]);
});

test("W1-T12416 criterion 7: each request writes one decision.answered row with its fields, and a refused or failed request writes the same row with its reason", async (t) => {
  const { dir, config } = fixture(t);
  const answered = await askDecisionModel(config, { role: "risk", candidate: openAiCandidate, input: INPUT, questions: QUESTIONS, env,
    fetchImpl: replying([], openAiReply(OPENAI_ANSWERS)) });
  const refused = await askDecisionModel(config, { role: "risk", candidate: openAiCandidate, input: INPUT, questions: [], env,
    fetchImpl: replying([], openAiReply(OPENAI_ANSWERS)) });
  const failed = await askDecisionModel(config, { role: "risk", candidate: microsoftCandidate, input: INPUT, questions: QUESTIONS, env,
    fetchImpl: replying([], json({ error: { code: "RateLimitReached" } }, 429)) });
  const rows = answeredRows(dir);
  assert.equal(rows.length, 3, "one row per request");
  const [first] = rows;
  for (const field of ["role", "input_digest", "candidate", "deployment", "served_model", "latency_ms", "reserved_usd", "settled_usd",
    "held_usd", "usage", "question_count", "answers"]) assert.ok(Object.hasOwn(first!, field), field);
  assert.equal(first!.task_id, "DECISIONS");
  assert.equal(first!.role, "risk");
  assert.match(String(first!.input_digest), /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(rows).includes(INPUT), "the input itself is never written");
  assert.equal(first!.served_model, "served-fixture");
  assert.deepEqual(first!.usage, { input_tokens: 387, output_tokens: 0, cached_tokens: 0 });
  assert.equal(first!.question_count, 3);
  assert.deepEqual(first!.answers, JSON.parse(JSON.stringify(answered.answers)));
  assert.deepEqual([rows[1]!.outcome, rows[1]!.reason], ["refused", "invalid-questions"]);
  assert.deepEqual([rows[2]!.outcome, rows[2]!.reason, rows[2]!.status], ["failed", "http", 429]);
  assert.equal(refused.outcome, "refused");
  assert.equal(failed.status, 429);
});

test("W1-T12416: a 429 inside the deadline is sent once more, then ends as a named reason, never a throw or a long wait", async (t) => {
  const { config } = fixture(t);
  let calls = 0;
  const row = await askDecisionModel(config, { role: "risk", candidate: microsoftCandidate, input: INPUT, questions: QUESTIONS, env,
    requestTimeoutMs: 2_000, fetchImpl: async () => { calls++; return json({}, 429, { "retry-after-ms": "10" })(); } });
  assert.equal(calls, 2);
  assert.deepEqual([row.outcome, row.reason, row.status], ["failed", "http", 429]);
  let late = 0;
  const beyond = await askDecisionModel(config, { role: "risk", candidate: microsoftCandidate, input: INPUT, questions: QUESTIONS, env,
    requestTimeoutMs: 2_000, fetchImpl: async () => { late++; return json({}, 429, { "retry-after": "60" })(); } });
  assert.equal(late, 1, "a retry-after past the deadline is not waited for");
  assert.equal(beyond.outcome, "failed");
});

test("W1-T12416: a decision 404 marks only its own endpoint and path absent, never the worker's deployment", async (t) => {
  const { config } = fixture(t);
  let calls = 0;
  const notFound: typeof fetch = async () => { calls++; return new Response("{}", { status: 404 }); };
  const first = await askDecisionModel(config, { role: "risk", candidate: openAiCandidate, input: INPUT, questions: QUESTIONS, env, fetchImpl: notFound });
  const second = await askDecisionModel(config, { role: "risk", candidate: openAiCandidate, input: INPUT, questions: QUESTIONS, env, fetchImpl: notFound });
  assert.deepEqual([first.reason, first.status, second.reason], ["deployment-absent", 404, "deployment-absent"]);
  assert.equal(calls, 1, "the same route is not asked again inside the absent window");
  assert.equal(openWeightDeploymentKnownAbsent(DEPLOYMENT), false, "worker selection still sees the deployment");
  await askDecisionModel(config, { role: "risk", candidate: microsoftCandidate, input: INPUT, questions: QUESTIONS, env, fetchImpl: notFound });
  assert.equal(calls, 2, "another endpoint or path is still asked");
});

function probeFiles(dir: string, questions: string): { input: string; questions: string } {
  writeFileSync(join(dir, "input.txt"), INPUT);
  writeFileSync(join(dir, "questions.json"), questions);
  return { input: join(dir, "input.txt"), questions: join(dir, "questions.json") };
}

test("W1-T12416 criterion 8: rmd decisions probe sends one question set to a named candidate and prints the row it wrote", async (t) => {
  const { dir, config } = fixture(t);
  config.workerProviders = { cashEndpoint: "https://127.0.0.1:1/" };
  const declared = Object.values(loadMounts(mountsPath(REPO_ROOT)).decision_models ?? {}).find((c) => c.endpoint.source === "cash-default")!;
  const files = probeFiles(dir, JSON.stringify(QUESTIONS));
  const out: string[] = [];
  const err: string[] = [];
  const saved = process.env[DEFAULT_CASH_KEY_ENV];
  process.env[DEFAULT_CASH_KEY_ENV] = DEFAULT_KEY;
  t.after(() => { if (saved === undefined) delete process.env[DEFAULT_CASH_KEY_ENV]; else process.env[DEFAULT_CASH_KEY_ENV] = saved; });
  // Nothing injected in place of the request: the global fetch sends it and the connection is refused.
  const code = await decisionsCommand(["probe", "--candidate", declared.name, "--input-file", files.input, "--questions-file", files.questions,
    "--role", "risk"], (c, request) => askDecisionModel(c, request), { repoRoot: REPO_ROOT, config: () => config, out: (l) => out.push(l), err: (l) => err.push(l) });
  assert.equal(code, 1, err.join("\n"));
  assert.equal(out.length, 1);
  assert.ok(!out[0]!.includes(DEFAULT_KEY));
  const printed = JSON.parse(out[0]!);
  assert.deepEqual([printed.outcome, printed.reason, printed.candidate, printed.role], ["failed", "transport", declared.name, "risk"]);
  const [written] = answeredRows(dir);
  assert.deepEqual(Object.fromEntries(Object.keys(printed).map((key) => [key, written![key]])), printed, "it prints the row it wrote");
  assert.ok(printed.reserved_usd > 0);

  const answered: string[] = [];
  const ok = await decisionsCommand(["probe", "--candidate", declared.name, "--input-file", files.input, "--questions-file", files.questions],
    (c, request) => askDecisionModel(c, { ...request, env, fetchImpl: replying([], microsoftReply(MICROSOFT_ANSWERS)) }),
    { repoRoot: REPO_ROOT, config: () => ({ ...config, workerProviders: { cashEndpoint: "https://default.example.test/" } }), out: (l) => answered.push(l), err: (l) => err.push(l) });
  assert.equal(ok, 0);
  assert.equal(JSON.parse(answered[0]!).role, "probe");

  let asked = 0;
  const never = async (): Promise<DecisionAnsweredRow> => { asked++; throw new Error("not asked"); };
  const host = { repoRoot: REPO_ROOT, config: () => config, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  assert.equal(await decisionsCommand(["ask"], never, host), 2);
  assert.equal(await decisionsCommand(["probe", "--candidate", declared.name], never, host), 2);
  assert.equal(await decisionsCommand(["probe", "--candidate", "no-such-candidate", "--input-file", files.input, "--questions-file", files.questions], never, host), 2);
  assert.equal(asked, 0);
});

test("W1-T12416: an unreadable questions file is a usage error and asks nothing", async (t) => {
  const { dir, config } = fixture(t);
  const declared = Object.values(loadMounts(mountsPath(REPO_ROOT)).decision_models ?? {})[0]!;
  const files = probeFiles(dir, "{ not json");
  const err: string[] = [];
  let asked = 0;
  const code = await decisionsCommand(["probe", "--candidate", declared.name, "--input-file", files.input, "--questions-file", files.questions],
    async () => { asked++; throw new Error("not asked"); }, { repoRoot: REPO_ROOT, config: () => config, out: () => {}, err: (l) => err.push(l) });
  assert.equal(code, 2);
  assert.equal(asked, 0);
  assert.match(err.join("\n"), /could not read/);
});
