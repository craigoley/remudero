import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CASH_RESPONSES_DEPLOYMENTS } from "#src/lib/cash-responses.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import { DEFAULT_CASH_KEY_ENV } from "#src/lib/config-schema.js";
import { DECISION_ANSWERED_STEP, DECISION_OUTPUT_MARGIN_TOKENS } from "#src/lib/decision-model.js";
import { judgeCalibrationRow } from "#src/lib/judge-calibration.js";
import {
  JUDGE_REPLAY_ANSWERED_STEP,
  JUDGE_REPLAY_CEILING_USD,
  JUDGE_REPLAY_DECISION_ROLE_PREFIX,
  JUDGE_REPLAY_FINISHED_STEP,
  JUDGE_REPLAY_MAX_TOKENS,
  JUDGE_REPLAY_RATE_WINDOW_MS,
  judgeReplayCashRequest,
  judgeReplayCommand,
  judgeReplayCorpusDigest,
  loadJudgeReplayCorpus,
  parseJudgeReplayLane,
  replayJudgeCorpus,
  type JudgeReplayCase,
  type JudgeReplayFinishedRow,
  type JudgeReplayRequest,
} from "#src/lib/judge-replay-batch.js";
import { loadMounts, mountsPath, type DecisionCandidate } from "#src/lib/mounts.js";
import { readLedgerLines } from "#src/lib/status.js";
import { scoreTypedAnswers, type TypedAnswerRow } from "#src/lib/typed-answer-scores.js";
import {
  OPENWEIGHT_ALLOWANCE_FILENAME,
  OPENWEIGHT_CONTEXT_WINDOWS,
  OPENWEIGHT_PRICES,
  clearOpenWeightAbsence,
  isFoundryClaudeDeployment,
  openWeightEstimatedTokens,
  openWeightReservationUsd,
  recordCashCapacity,
  reserveOpenWeightBudget,
  resetLearnedCashCapacity,
  type OpenWeightAllowanceState,
} from "#src/lib/worker-provider.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const DEFAULT_KEY = "fixture-default-cash-key-never-printed";
const ENTRY_KEY = "fixture-entry-cash-key-never-printed";
const ENTRY_KEY_ENV = "RMD_CASH_REPLAY_ENTRY_API_KEY";
const ENV = { [DEFAULT_CASH_KEY_ENV]: DEFAULT_KEY, [ENTRY_KEY_ENV]: ENTRY_KEY };
const START_MS = 1_794_830_400_000;

// The decision candidates the repo's own mounts table names, one per request shape.
const DECISIONS = Object.values(loadMounts(mountsPath(REPO_ROOT)).decision_models ?? {});
const OPENAI: DecisionCandidate = DECISIONS.find((c) => c.shape === "openai-decisions")!;
const MICROSOFT: DecisionCandidate = DECISIONS.find((c) => c.shape === "microsoft-systemone")!;

// Chat deployments with one flat rate and a context window: the cheapest for ordinary runs, the dearest for the ceiling.
const CHAT = Object.keys(OPENWEIGHT_PRICES).filter((name) => !isFoundryClaudeDeployment(name) && !CASH_RESPONSES_DEPLOYMENTS[name] &&
  OPENWEIGHT_PRICES[name]!.longContext === undefined && OPENWEIGHT_CONTEXT_WINDOWS[name] !== undefined && OPENWEIGHT_CONTEXT_WINDOWS[name]!.totalTokens >= 64_000)
  .sort((a, b) => OPENWEIGHT_PRICES[a]!.inputUsdPerMillion - OPENWEIGHT_PRICES[b]!.inputUsdPerMillion);
const CASH = CHAT[0]!;
const DEAR = CHAT[CHAT.length - 1]!;

const CASES = loadJudgeReplayCorpus(REPO_ROOT, "all")!.cases;

interface World { dir: string; config: Config; now: () => number; advance: (ms: number) => void; clock: ReturnType<typeof clockFromMillisFn>; sleeps: number[] }

function world(t: TestContext, cap: Config["dailyCapUsd"] = 25): World {
  clearOpenWeightAbsence();
  resetLearnedCashCapacity();
  t.after(() => { clearOpenWeightAbsence(); resetLearnedCashCapacity(); });
  const { dir } = ownedFixtureDir(t, "judge-replay-direct");
  const entries: Record<string, { endpoint: string; keyEnv: string }> = {};
  for (const candidate of DECISIONS)
    if (candidate.endpoint.source === "cash-entry") entries[candidate.endpoint.entry] = { endpoint: `https://entry-${candidate.name}.example.test/`, keyEnv: ENTRY_KEY_ENV };
  let now = START_MS;
  const sleeps: number[] = [];
  return { dir, config: { claudeBin: "/unused", root: dir, dailyCapUsd: cap,
    workerProviders: { cashEndpoint: "https://cash.example.test/", cashDeploymentEndpoints: entries } } as Config,
  now: () => now, advance: (ms) => { now += ms; }, clock: clockFromMillisFn(() => now), sleeps };
}

type Kind = "openai" | "microsoft" | "chat";
interface Seen { url: string; kind: Kind; caseIds: string[]; body: Record<string, unknown>; at: number; inFlight: number }

/** What the fake answers for one case: an option (all mass on it), a raw answer object, or a whole response. */
/** `usage` replaces the decision reply's usage; a usage above the reservation keeps the request held at it. */
type Reply = { option: string; mass?: number; usage?: unknown } | { raw: unknown } | { response: () => Response };

const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * A fake cash endpoint that answers both decision shapes and Chat Completions. It records each
 * request with the cases whose input (or prompt) it carries, and advances the clock 10 ms more per
 * request, so the latencies are 10, 20, 30 ... ms.
 */
function fakeCash(w: World, seen: Seen[], answer: (item: JudgeReplayCase, kind: Kind) => Reply, cases: readonly JudgeReplayCase[] = CASES): typeof fetch {
  let inFlight = 0;
  return async (target, init) => {
    inFlight += 1;
    try {
      const url = String(target);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const kind: Kind = url.includes("/openai/v1/decisions") ? "openai" : url.includes("/providers/microsoft/v1/systemone") ? "microsoft" : "chat";
      const messages = Array.isArray(body.messages) ? (body.messages as Array<{ content: string }>) : [];
      const matched = cases.filter((item) => kind === "openai" ? body.input === item.input : kind === "microsoft" ? body.state === item.input
        : messages.some((message) => message.content === item.prompt));
      seen.push({ url, kind, caseIds: matched.map((item) => item.caseId), body, at: w.now(), inFlight });
      await new Promise((resolve) => setImmediate(resolve));
      w.advance(10 * seen.length);
      const item = matched[0]!;
      const reply = answer(item, kind);
      if ("response" in reply) return reply.response();
      const name = item.question;
      if (kind === "chat") {
        const message = "raw" in reply ? reply.raw : { role: "assistant", content: `${reply.option}\n` };
        return json({ model: CASH, choices: [{ index: 0, finish_reason: "stop", message }], usage: { prompt_tokens: 120, completion_tokens: 2 } });
      }
      const top = "raw" in reply ? undefined : reply.option;
      const mass = "raw" in reply ? 1 : reply.mass ?? 0.9;
      const share = (option: string): number => (option === top ? mass : (1 - mass) / (item.options.length - 1));
      if (kind === "openai") {
        const raw = "raw" in reply ? reply.raw : { type: "choice", name, choice: top,
          probabilities: item.options.map((value) => ({ value, probability: share(value) })), confidence: mass };
        return json({ model: "served-decisions", answers: [raw],
          usage: ("usage" in reply ? reply.usage : undefined) ?? { input_tokens: 150, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0 } });
      }
      const raw = "raw" in reply ? reply.raw : { type: "choice", choice: `string:${top}`, confidence: mass,
        probabilities: { ...Object.fromEntries(item.options.map((value) => [`string:${value}`, share(value)])), cannot_tell: 0.01 } };
      return json({ model: "served-systemone", answers: { [name]: raw }, usage: { input_tokens: 150, output_tokens: 3 } });
    } finally {
      inFlight -= 1;
    }
  };
}

const expected = (item: JudgeReplayCase): Reply => ({ option: item.expected });

function request(w: World, model: string, upstreamFetch: typeof fetch, extra: Partial<JudgeReplayRequest> = {}): JudgeReplayRequest & { lane: "direct" } {
  return { model, corpus: "all", repoRoot: REPO_ROOT, env: ENV, upstreamFetch, clock: w.clock,
    sleep: async (ms) => { w.sleeps.push(ms); w.advance(ms); }, ...extra, lane: "direct" };
}

const ledger = (w: World): Array<Record<string, unknown>> => readLedgerLines(join(w.dir, "state", "ledger.ndjson"));
const rowsOf = (w: World, step: string) => ledger(w).filter((line) => line.step === step);
const typedOf = (w: World): TypedAnswerRow[] => rowsOf(w, JUDGE_REPLAY_ANSWERED_STEP).flatMap((line) => line.typed_answers as TypedAnswerRow[]);

function allowance(dir: string): OpenWeightAllowanceState | undefined {
  try { return JSON.parse(readFileSync(join(dir, "state", OPENWEIGHT_ALLOWANCE_FILENAME), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** A repo root of its own whose machine-filing probes are the given titles; nothing else is read from it. */
function probeRoot(t: TestContext, titles: string[]): string {
  const { dir } = ownedFixtureDir(t, "judge-replay-probes");
  mkdirSync(join(dir, "test", "fixtures"), { recursive: true });
  writeFileSync(join(dir, "test", "fixtures", "machine-judge-probes.json"), JSON.stringify({ probes: titles.map((title, index) =>
    ({ id: `W1-TFIX${index + 1}`, title, files: ["docs/readme.md"], claims: ["The readme says one more thing."], expect: "proceed" })) }));
  return dir;
}

test("W1-T12421 criterion 1: the direct lane reads the batch lane's corpora and sends each case once, to a decision model through askDecisionModel or to a cash deployment through sendCashRequest with the case's own prompt", async (t) => {
  assert.ok(OPENAI && MICROSOFT, "the mounts table names one decision candidate of each shape");
  for (const candidate of [OPENAI, MICROSOFT]) {
    const w = world(t);
    const seen: Seen[] = [];
    const row = await replayJudgeCorpus(w.config, request(w, candidate.name, fakeCash(w, seen, expected)));
    assert.equal(row.outcome, "finished", JSON.stringify(row));
    assert.equal(row.lane, "direct");
    assert.deepEqual(seen.map((s) => s.caseIds[0]), CASES.map((c) => c.caseId), `${candidate.name}: every case of the batch lane's corpora, in order`);
    const decisionRows = rowsOf(w, DECISION_ANSWERED_STEP);
    assert.equal(decisionRows.length, CASES.length, "each case went through askDecisionModel, which writes one decision.answered row");
    assert.ok(decisionRows.every((line) => line.candidate === candidate.name && line.model_surface === "decisions"));
    assert.deepEqual(decisionRows.map((line) => line.role), CASES.map((c) => `${JUDGE_REPLAY_DECISION_ROLE_PREFIX}${c.role}`));
    for (const s of seen) {
      const item = CASES.find((c) => c.caseId === s.caseIds[0])!;
      assert.equal(s.kind, candidate.shape === "openai-decisions" ? "openai" : "microsoft");
      const questions = s.body.questions;
      if (s.kind === "openai") {
        assert.ok(s.url.startsWith(`https://entry-${candidate.name}.example.test/`), s.url);
        assert.deepEqual(questions, [{ type: "choice", name: item.question, instructions: item.task, choices: item.options.map((value) => ({ value })) }]);
      } else {
        assert.ok(s.url.startsWith("https://cash.example.test/"), s.url);
        assert.deepEqual(Object.keys(questions as object), [item.question]);
      }
    }
  }
  {
    const w = world(t);
    const seen: Seen[] = [];
    const row = await replayJudgeCorpus(w.config, request(w, CASH, fakeCash(w, seen, expected)));
    assert.equal(row.outcome, "finished", JSON.stringify(row));
    assert.equal(row.model_surface, "text");
    assert.equal(seen.length, CASES.length);
    for (const [index, s] of seen.entries()) {
      assert.equal(s.kind, "chat");
      assert.equal(s.url, `https://cash.example.test/openai/deployments/${encodeURIComponent(CASH)}/chat/completions?api-version=2024-10-21`);
      assert.deepEqual(s.body.messages, [{ role: "user", content: CASES[index]!.prompt }], "the role's own prompt, unchanged from the batch lane");
      assert.equal(s.body.max_completion_tokens, JUDGE_REPLAY_MAX_TOKENS);
    }
    assert.deepEqual(typedOf(w).map((r) => r.answer), CASES.map((c) => ({ kind: "single", option: c.expected })), "the one-word parser read each reply");
    assert.equal(rowsOf(w, DECISION_ANSWERED_STEP).length, 0, "a cash deployment never goes through askDecisionModel");
  }
  {
    const w = world(t);
    const row = await replayJudgeCorpus(w.config, request(w, "no-such-candidate", async () => { throw new Error("never sent"); }));
    assert.equal(row.outcome, "refused");
    assert.equal(row.reason, "unknown-candidate");
  }
});

test("W1-T12421 criterion 2: one case per request, one at a time, inside the learned per-minute limit; a lasting 429 or a budget refusal stops the replay and keeps the answers written", async (t) => {
  {
    // A learned limit that holds about two requests a minute.
    const w = world(t);
    const corpus = loadJudgeReplayCorpus(REPO_ROOT, "risk-judge-dispositions")!.cases;
    const need = (s: Seen): number => openWeightEstimatedTokens(Buffer.byteLength(JSON.stringify(s.body), "utf8")) + DECISION_OUTPUT_MARGIN_TOKENS;
    const limit = 2 * (openWeightEstimatedTokens(1400) + DECISION_OUTPUT_MARGIN_TOKENS);
    recordCashCapacity(w.config, MICROSOFT.deployment, new Headers({ "x-ratelimit-limit-tokens": String(limit) }),
      { clock: w.clock, endpoint: "https://cash.example.test/" });
    const seen: Seen[] = [];
    const row = await replayJudgeCorpus(w.config, request(w, MICROSOFT.name, fakeCash(w, seen, expected, corpus), { corpus: "risk-judge-dispositions" }));
    assert.equal(row.outcome, "finished", JSON.stringify(row));
    assert.equal(seen.length, corpus.length, "one request per case");
    assert.ok(seen.every((s) => s.caseIds.length === 1), "two cases never share a request");
    assert.equal(new Set(seen.map((s) => s.caseIds[0])).size, corpus.length);
    assert.ok(seen.every((s) => Object.keys(s.body.questions as object).length === 1), "one question about one input");
    assert.ok(seen.every((s) => s.inFlight === 1), "one request at a time");
    assert.ok(w.sleeps.length > 0, "the replay waited for the per-minute limit");
    for (const s of seen) {
      const inWindow = seen.filter((other) => other.at <= s.at && other.at > s.at - JUDGE_REPLAY_RATE_WINDOW_MS);
      assert.ok(inWindow.reduce((total, other) => total + need(other), 0) <= limit, `the minute before ${s.caseIds[0]} stays inside ${limit} tokens`);
    }
  }
  {
    // A 429 that stays after one retry stops the replay; the answers before it are kept.
    const w = world(t);
    const seen: Seen[] = [];
    const third = CASES[2]!;
    const row = await replayJudgeCorpus(w.config, request(w, CASH, fakeCash(w, seen, (item) => item === third
      ? { response: () => json({ error: { code: "429", message: "rate limited" } }, 429) } : expected(item))));
    assert.equal(row.outcome, "stopped");
    assert.equal(row.reason, "rate-limited");
    assert.deepEqual(seen.map((s) => s.caseIds[0]), [CASES[0]!.caseId, CASES[1]!.caseId, third.caseId, third.caseId], "one retry, then nothing more");
    assert.ok(w.sleeps.includes(JUDGE_REPLAY_RATE_WINDOW_MS), "the retry waited one window");
    const answered = rowsOf(w, JUDGE_REPLAY_ANSWERED_STEP);
    assert.deepEqual(answered.map((line) => [line.case_id, line.result]), [[CASES[0]!.caseId, "succeeded"], [CASES[1]!.caseId, "succeeded"], [third.caseId, "failed"]]);
    assert.equal(row.answered, 2);
  }
  {
    // A budget refusal stops the replay with its name; the first answer is kept. The first request
    // stays held at its reservation, and other spend then fills the normal cap to within $0.000001.
    const w = world(t, { normal: 1, squeezed: 25 });
    const seen: Seen[] = [];
    const inner = fakeCash(w, seen, (item) => (item === CASES[0] ? { option: item.expected, usage: { input_tokens: 100_000_000, output_tokens: 0 } } : expected(item)));
    const row = await replayJudgeCorpus(w.config, request(w, OPENAI.name, async (url, init) => {
      const response = await inner(url, init);
      if (seen.length === 1) {
        const committed = Object.values(allowance(w.dir)!.reservations).reduce((total, r) => total + r.reservedUsd, 0);
        reserveOpenWeightBudget(w.config, { requestId: "filler", deployment: "filler", requestBodyBytes: 0, atIso: w.clock.iso(),
          outputTokenCeiling: 1_000_000, price: { inputUsdPerMillion: 0, outputUsdPerMillion: 1 - committed - 1e-6, readAt: "2026-11-16" } });
      }
      return response;
    }));
    assert.equal(row.outcome, "stopped");
    assert.equal(row.reason, "budget-refused");
    assert.equal(seen.length, 1, "the refused request was never sent");
    assert.deepEqual(typedOf(w).map((r) => r.inputDigest !== null), [true], "the first answer is kept");
  }
});

test("W1-T12421 criterion 3: the corpus estimate is checked against the replay ceiling before the first request, and each request reserves against the normal cap", async (t) => {
  assert.equal(JUDGE_REPLAY_CEILING_USD, 1);
  const title = `Edit the docs. ${"The readme gains one more plain sentence about the docs. ".repeat(1_800)}`;
  const oneCase = (root: string): number => {
    const item = loadJudgeReplayCorpus(root, "machine-judge-probes")!.cases[0]!;
    return openWeightReservationUsd(DEAR, Buffer.byteLength(judgeReplayCashRequest(DEAR, item.prompt).body, "utf8"), 0, JUDGE_REPLAY_MAX_TOKENS);
  };
  const perCase = oneCase(probeRoot(t, [title]));
  const over = Math.floor(JUDGE_REPLAY_CEILING_USD / perCase) + 1;
  assert.ok(over >= 2 && (over - 1) * perCase <= JUDGE_REPLAY_CEILING_USD && over * perCase > JUDGE_REPLAY_CEILING_USD);
  {
    const w = world(t);
    const seen: Seen[] = [];
    const root = probeRoot(t, Array.from({ length: over }, () => title));
    const row = await replayJudgeCorpus(w.config, request(w, DEAR, fakeCash(w, seen, expected, loadJudgeReplayCorpus(root, "machine-judge-probes")!.cases),
      { repoRoot: root, corpus: "machine-judge-probes" }));
    assert.equal(row.outcome, "refused");
    assert.equal(row.reason, "over-ceiling");
    assert.ok(row.estimated_usd > JUDGE_REPLAY_CEILING_USD, String(row.estimated_usd));
    assert.equal(seen.length, 0, "nothing is sent before the estimate passes");
    assert.equal(allowance(w.dir), undefined, "nothing is reserved either");
  }
  {
    const w = world(t);
    const seen: Seen[] = [];
    const root = probeRoot(t, Array.from({ length: over - 1 }, () => title));
    const cases = loadJudgeReplayCorpus(root, "machine-judge-probes")!.cases;
    const reservedBefore: number[] = [];
    const inner = fakeCash(w, seen, expected, cases);
    const row = await replayJudgeCorpus(w.config, request(w, DEAR, async (url, init) => {
      reservedBefore.push(Object.keys(allowance(w.dir)?.reservations ?? {}).length);
      return await inner(url, init);
    }, { repoRoot: root, corpus: "machine-judge-probes" }));
    assert.equal(row.outcome, "finished", JSON.stringify(row));
    assert.ok(row.estimated_usd <= JUDGE_REPLAY_CEILING_USD);
    assert.deepEqual(reservedBefore, cases.map((_, index) => index + 1), "each request reserved before it was sent");
  }
  {
    // The squeezed figure would hold the second request; the normal figure refuses it.
    const w = world(t, { normal: 1, squeezed: 25 });
    const seen: Seen[] = [];
    const inner = fakeCash(w, seen, expected);
    reserveOpenWeightBudget(w.config, { requestId: "filler", deployment: "filler", requestBodyBytes: 0, atIso: w.clock.iso(),
      outputTokenCeiling: 1_000_000, price: { inputUsdPerMillion: 0, outputUsdPerMillion: 0.99999, readAt: "2026-11-16" } });
    const row = await replayJudgeCorpus(w.config, request(w, CASH, inner));
    assert.equal(row.outcome, "stopped");
    assert.equal(row.reason, "budget-refused");
    assert.equal(seen.length, 0);
  }
});

test("W1-T12421 criterion 4: each result is one recorded typed answer with the expected answer as its outcome, keyed by role, model id and surface; a distribution gets Brier and log-loss, a single answer agreement only", async (t) => {
  const wrong = new Set([CASES[0]!.caseId, CASES[12]!.caseId]);
  const answer = (item: JudgeReplayCase): Reply => (wrong.has(item.caseId) ? { option: item.options.find((o) => o !== item.expected)!, mass: 0.7 } : { option: item.expected });
  const wd = world(t);
  await replayJudgeCorpus(wd.config, request(wd, OPENAI.name, fakeCash(wd, [], answer)));
  const wc = world(t);
  await replayJudgeCorpus(wc.config, request(wc, CASH, fakeCash(wc, [], answer)));
  for (const [w, model, surface, kind] of [[wd, OPENAI.name, "decisions", "distribution"], [wc, CASH, "text", "single"]] as const) {
    const typed = typedOf(w);
    assert.equal(typed.length, CASES.length, "one recorded answer per case");
    assert.deepEqual(typed.map((r) => [r.role, r.model, r.modelSurface, r.question, r.outcome, r.incumbent, r.answer.kind]),
      CASES.map((c) => [c.role, model, surface, c.question, c.expected, c.expected, kind]));
  }
  const decided = scoreTypedAnswers(typedOf(wd)).groups;
  const probes = decided.find((g) => g.role === "machine-filing")!;
  assert.equal(probes.modelSurface, "decisions");
  assert.equal(probes.outcomes.scored, 10);
  assert.ok(probes.brier !== null && probes.brier > 0 && probes.logLoss !== null && probes.logLoss > 0, "a distribution with a known outcome is scored");
  const said = scoreTypedAnswers(typedOf(wc)).groups;
  for (const group of said) {
    assert.equal(group.brier, null, "a single answer gets no Brier score");
    assert.equal(group.logLoss, null, "a single answer gets no log-loss");
    assert.equal(group.agreement.compared, group.singles);
  }
  assert.equal(said.find((g) => g.role === "machine-filing")!.agreement.agreed, 9);
  // The decision request's own row is skipped by the calibration body, so no answer counts twice.
  for (const line of rowsOf(wd, DECISION_ANSWERED_STEP)) assert.equal(judgeCalibrationRow(line), undefined);
  for (const line of rowsOf(wd, JUDGE_REPLAY_ANSWERED_STEP)) assert.equal((judgeCalibrationRow(line)!.typed_answers as unknown[]).length, 1);
});

test("W1-T12421 criterion 5: a case above the input limit is too large and never sent; an abstention and a rejection are counted apart and never scored as wrong", async (t) => {
  {
    const window = OPENWEIGHT_CONTEXT_WINDOWS[CASH]!.totalTokens;
    const root = probeRoot(t, ["Edit one line of the readme.", `Edit the docs. ${"plain words about the docs ".repeat(Math.ceil((window * 4) / 26) + 100)}`]);
    const cases = loadJudgeReplayCorpus(root, "machine-judge-probes")!.cases;
    const w = world(t);
    const seen: Seen[] = [];
    const row = await replayJudgeCorpus(w.config, request(w, CASH, fakeCash(w, seen, expected, cases), { repoRoot: root, corpus: "machine-judge-probes" }));
    assert.equal(row.outcome, "finished", JSON.stringify(row));
    assert.equal(row.too_large, 1);
    assert.equal(row.too_large_cases[0]!.caseId, cases[1]!.caseId);
    assert.ok(row.too_large_cases[0]!.tokens > row.too_large_cases[0]!.limitTokens);
    assert.deepEqual(seen.map((s) => s.caseIds[0]), [cases[0]!.caseId], "the too-large case was not sent");
    assert.equal(row.sent, 1);
    assert.deepEqual(rowsOf(w, JUDGE_REPLAY_ANSWERED_STEP).map((line) => line.case_id), [cases[0]!.caseId]);
  }
  const [refusing, rambling] = [CASES[0]!, CASES[1]!];
  {
    const w = world(t);
    const row = await replayJudgeCorpus(w.config, request(w, CASH, fakeCash(w, [], (item) => item === refusing
      ? { raw: { role: "assistant", content: null, refusal: "I cannot judge this." } }
      : item === rambling ? { option: "maybe, it depends" } : expected(item))));
    assert.deepEqual([row.answered, row.abstained, row.rejected], [CASES.length - 2, 1, 1]);
    const group = scoreTypedAnswers(typedOf(w)).groups.find((g) => g.role === "machine-filing")!;
    assert.deepEqual([group.abstained, group.rejected, group.agreement.compared, group.agreement.agreed], [1, 1, 8, 8], "neither is compared as a wrong answer");
  }
  {
    const w = world(t);
    const row = await replayJudgeCorpus(w.config, request(w, MICROSOFT.name, fakeCash(w, [], (item) => item === refusing
      ? { raw: { type: "choice", choice: "cannot_tell", probabilities: { "string:escalate": 0.5, "string:proceed": 0.5, cannot_tell: 0.9 } } }
      : item === rambling ? { raw: { type: "choice", choice: "string:escalate", probabilities: { "string:escalate": 0.9, "string:proceed": 0.9, cannot_tell: 0 } } }
        : expected(item))));
    assert.deepEqual([row.answered, row.abstained, row.rejected], [CASES.length - 2, 1, 1]);
    const group = scoreTypedAnswers(typedOf(w)).groups.find((g) => g.role === "machine-filing")!;
    assert.deepEqual([group.abstained, group.rejected, group.outcomes.scored, group.agreement.compared], [1, 1, 8, 8], "only the answered distributions are scored");
  }
});

test("W1-T12421 criterion 6: each replay writes one judge_replay.finished row with the candidate, surface, role, corpus and digest, the counts, the settled dollars and the median latency, or the reason it stopped", async (t) => {
  {
    const w = world(t);
    const row: JudgeReplayFinishedRow = await replayJudgeCorpus(w.config, request(w, OPENAI.name, fakeCash(w, [], expected), { corpus: "machine-judge-probes" }));
    const finished = rowsOf(w, JUDGE_REPLAY_FINISHED_STEP);
    assert.equal(finished.length, 1);
    const probes = CASES.filter((c) => c.corpus === "machine-judge-probes");
    const written = finished[0]!;
    assert.deepEqual([written.candidate, written.deployment, written.model_surface, written.role, written.corpus, written.corpus_digest, written.outcome],
      [OPENAI.name, OPENAI.deployment, "decisions", "machine-filing", "machine-judge-probes", judgeReplayCorpusDigest(probes), "finished"]);
    assert.deepEqual([written.sent, written.answered, written.abstained, written.rejected, written.too_large], [10, 10, 0, 0, 0]);
    const settled = rowsOf(w, JUDGE_REPLAY_ANSWERED_STEP).reduce((total, line) => total + (line.settled_usd as number), 0);
    assert.ok((written.settled_usd as number) > 0 && Math.abs((written.settled_usd as number) - settled) < 1e-12);
    assert.equal(written.median_latency_ms, 55, "the latencies were 10 to 100 ms");
    assert.deepEqual(Object.fromEntries(Object.keys(row).map((key) => [key, written[key]])), { ...row }, "the written row is the returned row");
  }
  {
    const w = world(t);
    await replayJudgeCorpus(w.config, request(w, CASH, fakeCash(w, [], (item) => item === CASES[1]
      ? { response: () => json({ error: { code: "429", message: "rate limited" } }, 429) } : expected(item))));
    const finished = rowsOf(w, JUDGE_REPLAY_FINISHED_STEP);
    assert.equal(finished.length, 1);
    assert.deepEqual([finished[0]!.outcome, finished[0]!.reason, finished[0]!.model_surface, finished[0]!.role], ["stopped", "rate-limited", "text", "machine-filing,risk"]);
    assert.match(String(finished[0]!.detail), new RegExp(CASES[1]!.caseId));
  }
});

test("W1-T12421: rmd judge-replay reads --lane through the replay module; the direct lane takes --candidate", async (t) => {
  assert.deepEqual(parseJudgeReplayLane([]), { lane: "batch" });
  assert.deepEqual(parseJudgeReplayLane(["--lane", "direct"]), { lane: "direct" });
  assert.ok("error" in parseJudgeReplayLane(["--lane", "sideways"]));
  const never = async (): Promise<never> => { throw new Error("not called"); };
  const err: string[] = [];
  for (const argv of [["--lane", "sideways", "--model", "m", "--corpus", "all"], ["--lane", "direct", "--model", "m", "--corpus", "all"],
    ["--lane", "direct", "--corpus", "all"], ["--candidate", "c", "--model", "m", "--corpus", "all"]])
    assert.equal(await judgeReplayCommand(argv, never, { repoRoot: REPO_ROOT, err: (line) => err.push(line) }), 2, argv.join(" "));
  const w = world(t);
  const out: string[] = [];
  const code = await judgeReplayCommand(["--lane", "direct", "--candidate", CASH, "--corpus", "risk-judge-dispositions"],
    async (config, req) => await replayJudgeCorpus(config, { ...request(w, CASH, fakeCash(w, [], expected)), ...req, env: ENV }),
    { repoRoot: REPO_ROOT, config: () => w.config, out: (line) => out.push(line), err: (line) => err.push(line), lane: parseJudgeReplayLane(["--lane", "direct"]) });
  assert.equal(code, 0);
  assert.deepEqual([JSON.parse(out[0]!).lane, JSON.parse(out[0]!).sent], ["direct", 9]);
});
