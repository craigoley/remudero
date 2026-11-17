import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Config } from "#src/lib/config.js";
import { buildWorkerEnv } from "#src/lib/env.js";
import { deriveJudgeCalibration, judgeCalibrationRow } from "#src/lib/judge-calibration.js";
import {
  ANTHROPIC_API_KEY_ENV,
  JUDGE_REPLAY_ANSWERED_STEP,
  JUDGE_REPLAY_BATCH_STEP,
  JUDGE_REPLAY_MAX_TOKENS,
  JUDGE_REPLAY_RETENTION,
  batchPriceFor,
  batchResultUsd,
  judgeReplayCommand,
  loadJudgeReplayCorpus,
  replayJudgeCorpus,
  type JudgeReplayCase,
  type JudgeReplayRequest,
} from "#src/lib/judge-replay-batch.js";
import { LEDGER_REQUEST_STEP, mintSentinel, secretBoundaryEnv } from "#src/lib/secret-boundary.js";
import { readLedgerLines } from "#src/lib/status.js";
import { scoreTypedAnswers, type TypedAnswerRow } from "#src/lib/typed-answer-scores.js";
import { OPENWEIGHT_ALLOWANCE_FILENAME, openWeightReservationUsd, type OpenWeightAllowanceState } from "#src/lib/worker-provider.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const KEY = "fixture-anthropic-key-never-printed";
const MODEL = "claude-haiku-5-5";
const BATCH_ID = "msgbatch_fixture01";

function fixture(t: TestContext): { dir: string; config: Config } {
  const { dir } = ownedFixtureDir(t, "judge-replay");
  return { dir, config: { claudeBin: "/unused", root: dir, dailyCapUsd: 25 } as Config };
}

function allowance(dir: string): OpenWeightAllowanceState | undefined {
  try { return JSON.parse(readFileSync(join(dir, "state", OPENWEIGHT_ALLOWANCE_FILENAME), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

const recorded = (dir: string): Array<Record<string, unknown>> => readLedgerLines(join(dir, "state", "ledger.ndjson"));
const recordedText = (dir: string): string => readFileSync(join(dir, "state", "ledger.ndjson"), "utf8");

type Seen = { url: string; method: string; headers: Headers; body: string };
const USAGE = { input_tokens: 180, output_tokens: 40, cache_read_input_tokens: 0 };

/**
 * A fake Anthropic API behind the boundary: it creates the batch, reports it in progress once, then
 * ended, and serves one JSONL result per request. `answer` picks each case's reply text.
 */
function fakeAnthropic(seen: Seen[], opts: { answer?: (customId: string) => string; usage?: (customId: string) => unknown; onFirst?: () => void } = {}): typeof fetch {
  let requests: Array<{ custom_id: string }> = [];
  let polls = 0;
  return async (target, init) => {
    if (seen.length === 0) opts.onFirst?.();
    const url = new URL(String(target));
    const body = init?.body === undefined ? "" : Buffer.from(init.body as Uint8Array).toString("utf8");
    seen.push({ url: url.toString(), method: init?.method ?? "GET", headers: new Headers(init?.headers), body });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/messages/batches" && init?.method === "POST") {
      requests = (JSON.parse(body) as { requests: Array<{ custom_id: string }> }).requests;
      return json({ id: BATCH_ID, type: "message_batch", processing_status: "in_progress" });
    }
    if (url.pathname === `/v1/messages/batches/${BATCH_ID}`)
      return json({ id: BATCH_ID, processing_status: ++polls > 1 ? "ended" : "in_progress",
        results_url: `https://api.anthropic.com/v1/messages/batches/${BATCH_ID}/results` });
    if (url.pathname === `/v1/messages/batches/${BATCH_ID}/results`) {
      const lines = requests.map((r) => JSON.stringify({ custom_id: r.custom_id, result: { type: "succeeded", message: {
        type: "message", role: "assistant", stop_reason: "end_turn",
        content: [{ type: "thinking", thinking: "" }, { type: "text", text: opts.answer?.(r.custom_id) ?? "escalate" }],
        usage: opts.usage ? opts.usage(r.custom_id) : USAGE } } }));
      return new Response(`${lines.join("\n")}\n`, { status: 200, headers: { "content-type": "application/binary" } });
    }
    return new Response("not found", { status: 404 });
  };
}

/** Each case answers its expected answer, except the ones `wrong` names. */
function answering(cases: JudgeReplayCase[], wrong: Set<string> = new Set()): (customId: string) => string {
  const byId = new Map(cases.map((c) => [c.customId, c]));
  return (customId) => {
    const item = byId.get(customId)!;
    return wrong.has(customId) ? item.options.find((o) => o !== item.expected)! : `${item.expected}.`;
  };
}

function request(seen: Seen[], extra: Partial<JudgeReplayRequest> = {}): JudgeReplayRequest {
  return { model: MODEL, corpus: "all", repoRoot: REPO_ROOT, env: { [ANTHROPIC_API_KEY_ENV]: KEY }, sleep: async () => {},
    upstreamFetch: fakeAnthropic(seen), ...extra };
}

test("W1-T12418 criterion 1: the probes and the risk-judge dispositions are sent as one request each of one batch to the named model, with the expected answer beside each", async (t) => {
  const probes = JSON.parse(readFileSync(join(REPO_ROOT, "test", "fixtures", "machine-judge-probes.json"), "utf8")).probes as Array<{ id: string; expect: string }>;
  const loaded = loadJudgeReplayCorpus(REPO_ROOT, "all")!;
  assert.deepEqual(loaded.refused, []);
  const probeCases = loaded.cases.filter((c) => c.corpus === "machine-judge-probes");
  const riskCases = loaded.cases.filter((c) => c.corpus === "risk-judge-dispositions");
  assert.deepEqual(probeCases.map((c) => [c.caseId, c.expected]), probes.map((p) => [p.id, p.expect]));
  assert.equal(riskCases.length, 9);
  assert.deepEqual(riskCases.find((c) => c.caseId === "unrecoverable-stop")?.expected, "STOP");
  assert.deepEqual(riskCases.find((c) => c.caseId === "candidate-risk-escalate")?.expected, "escalate");
  for (const item of loaded.cases) {
    assert.ok(item.options.includes(item.expected), `${item.caseId} expects a declared option`);
    assert.doesNotMatch(item.prompt, /TRISK|TSAFE|expected|"judge"/, `${item.caseId} never shows its id or its answer`);
  }
  assert.equal(loadJudgeReplayCorpus(REPO_ROOT, "machine-judge-probes")!.cases.length, probes.length);
  assert.equal(loadJudgeReplayCorpus(REPO_ROOT, "no-such-corpus"), undefined);

  const { dir, config } = fixture(t);
  const seen: Seen[] = [];
  const row = await replayJudgeCorpus(config, request(seen, { upstreamFetch: fakeAnthropic(seen, { answer: answering(loaded.cases) }) }));
  assert.equal(row.outcome, "ended", JSON.stringify(row));
  const posts = seen.filter((s) => s.method === "POST");
  assert.equal(posts.length, 1, "one batch");
  assert.equal(new URL(posts[0]!.url).pathname, "/v1/messages/batches");
  const sent = JSON.parse(posts[0]!.body) as { requests: Array<{ custom_id: string; params: { model: string; max_tokens: number; messages: Array<{ content: string }> } }> };
  assert.deepEqual(sent.requests.map((r) => r.custom_id), loaded.cases.map((c) => c.customId));
  assert.ok(sent.requests.every((r) => r.params.model === MODEL && r.params.max_tokens === JUDGE_REPLAY_MAX_TOKENS));
  assert.deepEqual(sent.requests.map((r) => r.params.messages[0]!.content), loaded.cases.map((c) => c.prompt));
  const answered = recorded(dir).filter((l) => l.step === JUDGE_REPLAY_ANSWERED_STEP);
  assert.deepEqual(answered.map((l) => [l.case_id, l.expected]), loaded.cases.map((c) => [c.caseId, c.expected]));
  assert.equal(row.retention, JUDGE_REPLAY_RETENTION);
  assert.match(row.retention, /not zero-retention/);
  assert.match(row.retention, /29 days/);
});

test("W1-T12418 criterion 2: the daemon sends the batch through the secret boundary, a worker env never sends the key, and no key sends nothing", async (t) => {
  {
    const { dir, config } = fixture(t);
    const seen: Seen[] = [];
    const client: Seen[] = [];
    const clientFetch: typeof fetch = async (url, init) => {
      client.push({ url: String(url), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      return await fetch(url, init);
    };
    const row = await replayJudgeCorpus(config, request(seen, { clientFetch }));
    assert.equal(row.outcome, "ended", JSON.stringify(row));
    assert.equal(client.length, seen.length);
    for (const call of client) {
      assert.match(new URL(call.url).hostname, /^127\.0\.0\.1$/, "the replay talks only to the loopback boundary");
      assert.match(call.headers.get("authorization") ?? "", /^Bearer rmd-sentinel-/);
      assert.equal(call.headers.get("x-api-key"), null);
      assert.ok(![...call.headers.values()].some((v) => v.includes(KEY)) && !call.body.includes(KEY), "the replay never holds the key");
    }
    for (const call of seen) {
      assert.equal(new URL(call.url).origin, "https://api.anthropic.com");
      assert.equal(call.headers.get("x-api-key"), KEY, "the boundary puts the daemon's key in x-api-key");
      assert.equal(call.headers.get("authorization"), null, "the sentinel never leaves the host");
    }
    const boundary = recorded(dir).filter((l) => l.step === LEDGER_REQUEST_STEP);
    assert.equal(boundary.length, seen.length);
    assert.ok(boundary.every((l) => l.decision === "allow" && l.host === "api.anthropic.com"));
    assert.ok(!recordedText(dir).includes(KEY), "no ledger row holds the key");
  }
  {
    const { dir, config } = fixture(t);
    const seen: Seen[] = [];
    const row = await replayJudgeCorpus(config, request(seen, { env: {} }));
    assert.equal(row.outcome, "refused");
    assert.equal(row.reason, "no-key");
    assert.equal(seen.length, 0);
    assert.equal(allowance(dir), undefined, "nothing is reserved");
  }
  {
    // A worker's boundary env holds a sentinel. Even when a key rides along in it, the replay refuses.
    const { dir, config } = fixture(t);
    const seen: Seen[] = [];
    const workerEnv = { ...secretBoundaryEnv(buildWorkerEnv({}, { PATH: "/usr/bin", HOME: "/home/w" }),
      { modelSentinel: mintSentinel("model"), modelBaseUrl: "http://127.0.0.1:9" }), [ANTHROPIC_API_KEY_ENV]: KEY };
    const row = await replayJudgeCorpus(config, request(seen, { env: workerEnv }));
    assert.equal(row.outcome, "refused");
    assert.equal(row.reason, "worker-env");
    assert.equal(seen.length, 0);
    assert.equal(allowance(dir), undefined);
  }
});

test("W1-T12418 criterion 3: the whole batch is reserved at the batch price before it is sent, and settles from each result's usage", async (t) => {
  const price = batchPriceFor(MODEL)!;
  assert.equal(price.inputUsdPerMillion, 0.05);
  assert.equal(price.outputUsdPerMillion, 0.25);
  assert.equal(batchPriceFor("claude-no-such-model"), undefined);
  const cases = loadJudgeReplayCorpus(REPO_ROOT, "all")!.cases;
  {
    const { dir, config } = fixture(t);
    const seen: Seen[] = [];
    let atFirstSend: OpenWeightAllowanceState | undefined;
    const usage = (customId: string) => ({ input_tokens: 100 + cases.findIndex((c) => c.customId === customId), output_tokens: 7 });
    const row = await replayJudgeCorpus(config, request(seen, { upstreamFetch: fakeAnthropic(seen, { usage, onFirst: () => { atFirstSend = allowance(dir); } }) }));
    assert.equal(row.outcome, "ended", JSON.stringify(row));
    const reservations = Object.values(atFirstSend?.reservations ?? {});
    assert.equal(reservations.length, 1, "one reservation is on disk before the first byte is sent");
    const bytes = Buffer.byteLength(seen[0]!.body, "utf8");
    const want = openWeightReservationUsd(MODEL, bytes, 0, JUDGE_REPLAY_MAX_TOKENS * cases.length, price);
    assert.equal(reservations[0]!.reservedUsd, want);
    assert.equal(reservations[0]!.settledUsd, null);
    assert.equal(row.reserved_usd, want);
    const settled = cases.reduce((sum, c) => sum + batchResultUsd(usage(c.customId), price), 0);
    assert.ok(Math.abs(row.settled_usd - settled) < 1e-12, `${row.settled_usd} vs ${settled}`);
    assert.equal(row.held_usd, 0);
    const after = Object.values(allowance(dir)!.reservations);
    assert.equal(after.length, 1);
    assert.ok(Math.abs(after[0]!.settledUsd! - settled) < 1e-12);
    assert.deepEqual(row.usage, { input_tokens: cases.reduce((s, _c, i) => s + 100 + i, 0), output_tokens: 7 * cases.length });
    assert.equal(batchResultUsd({ input_tokens: 100_000, output_tokens: 1_000_000 }, price), 0.255, "half of the $0.10 and $0.50 rows");
    assert.equal(batchResultUsd({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, price), 1.5, "half of the long-context $0.50 and $2.50 rows above 100K");
  }
  {
    // A result with no usage keeps the whole reservation held.
    const { config } = fixture(t);
    const seen: Seen[] = [];
    const row = await replayJudgeCorpus(config, request(seen, { upstreamFetch: fakeAnthropic(seen, { usage: (id) => (id === cases[0]!.customId ? undefined : USAGE) }) }));
    assert.equal(row.outcome, "ended");
    assert.equal(row.held_usd, row.reserved_usd);
  }
  {
    // A cap too small for the batch refuses before anything is sent.
    const { dir } = fixture(t);
    const seen: Seen[] = [];
    const row = await replayJudgeCorpus({ claudeBin: "/unused", root: dir, dailyCapUsd: 0.0001 } as Config, request(seen));
    assert.equal(row.outcome, "refused");
    assert.equal(row.reason, "budget-refused");
    assert.equal(seen.length, 0);
  }
  {
    // A model with no price row sends nothing.
    const { config } = fixture(t);
    const seen: Seen[] = [];
    const row = await replayJudgeCorpus(config, request(seen, { model: "claude-no-such-model" }));
    assert.equal(row.reason, "no-price");
    assert.equal(seen.length, 0);
  }
});

test("W1-T12418 criterion 4: the results are recorded typed answers, keyed by the model id, that the judge calibration body scores", async (t) => {
  const cases = loadJudgeReplayCorpus(REPO_ROOT, "all")!.cases;
  const { dir, config } = fixture(t);
  const wrong = new Set([cases[0]!.customId]);
  const seenA: Seen[] = [];
  await replayJudgeCorpus(config, request(seenA, { upstreamFetch: fakeAnthropic(seenA, { answer: answering(cases, wrong) }) }));
  const seenB: Seen[] = [];
  const other = "claude-sonnet-5-5";
  await replayJudgeCorpus(config, request(seenB, { model: other, upstreamFetch: fakeAnthropic(seenB, {
    answer: (id) => (id === cases[1]!.customId ? "I cannot say." : answering(cases)(id)) }) }));

  const lines = recorded(dir);
  const answered = lines.filter((l) => l.step === JUDGE_REPLAY_ANSWERED_STEP);
  assert.equal(answered.length, cases.length * 2);
  const typed = answered.flatMap((l) => judgeCalibrationRow(l)?.typed_answers as TypedAnswerRow[]);
  assert.equal(typed.length, cases.length * 2, "the calibration projection reads every replay answer");
  assert.ok(typed.every((r) => r.source === "generative" && (r.model === MODEL || r.model === other)));
  const probe = typed.find((r) => r.model === MODEL && r.role === "machine-filing")!;
  assert.deepEqual(probe.options, ["escalate", "proceed"]);

  const body = deriveJudgeCalibration(lines, { asOf: "2026-11-16T00:00:00.000Z", labels: { labels: [] } });
  const groups = body.typedAnswerScores.groups;
  assert.deepEqual(groups, scoreTypedAnswers(typed).groups);
  const group = (model: string, role: string, question: string) => groups.find((g) => g.model === model && g.role === role && g.question === question)!;
  const probesA = group(MODEL, "machine-filing", "escalate_or_proceed");
  assert.equal(probesA.answers, 10);
  assert.deepEqual(probesA.agreement, { compared: 10, agreed: 9, rate: 0.9 });
  assert.equal(probesA.brier, null, "a single answer gets no Brier figure");
  const probesB = group(other, "machine-filing", "escalate_or_proceed");
  assert.equal(probesB.rejected, 1, "an answer outside the declared options is a rejection");
  assert.deepEqual(probesB.agreement, { compared: 9, agreed: 9, rate: 1 });
  assert.equal(groups.filter((g) => g.role === "machine-filing").length, 2, "two models are never pooled");
  assert.equal(group(MODEL, "risk", "gate_consequence").agreement.rate, 1);
});

test("W1-T12418: rmd judge-replay needs a model and a corpus, and prints the batch row with the retention notice", async (t) => {
  const err: string[] = [];
  assert.equal(await judgeReplayCommand(["--model", MODEL], async () => { throw new Error("not called"); }, { repoRoot: REPO_ROOT, err: (l) => err.push(l) }), 2);
  assert.equal(await judgeReplayCommand(["--model", MODEL, "--corpus", "all", "--bogus"], async () => { throw new Error("not called"); }, { repoRoot: REPO_ROOT, err: (l) => err.push(l) }), 2);
  const { dir, config } = fixture(t);
  const out: string[] = [];
  const seen: Seen[] = [];
  const code = await judgeReplayCommand(["--model", MODEL, "--corpus", "machine-judge-probes"],
    async (cfg, req) => await replayJudgeCorpus(cfg, { ...request(seen), ...req, env: { [ANTHROPIC_API_KEY_ENV]: KEY } }),
    { repoRoot: REPO_ROOT, config: () => config, out: (l) => out.push(l), err: (l) => err.push(l) });
  assert.equal(code, 0);
  assert.equal(JSON.parse(out[0]!).case_count, 10);
  assert.ok(err.some((l) => l.includes("29 days")));
  assert.equal(recorded(dir).filter((l) => l.step === JUDGE_REPLAY_BATCH_STEP).length, 1);
});
