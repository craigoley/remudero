/**
 * W1-T13366 — a judge replay answer records its corpus digest in both lanes.
 *
 * Each `judge_replay.answered` row names the digest and the name of the corpus its replay sent, so the
 * field-trials judge family reads the digest from the answer itself. Both lanes run against fake
 * endpoints: no network and no paid call runs.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CASH_RESPONSES_DEPLOYMENTS } from "#src/lib/cash-responses.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import { DEFAULT_CASH_KEY_ENV } from "#src/lib/config-schema.js";
import { periodOf, projectFlowRow } from "#src/lib/field-trials-flow.js";
import { JUDGE_CORPUS_DIGEST_UNRECORDED, judgeTrialCells, judgeTrialRows, type JudgeTrialCell } from "#src/lib/field-trials-judges.js";
import { ANTHROPIC_API_KEY_ENV, JUDGE_REPLAY_ANSWERED_STEP, JUDGE_REPLAY_BATCH_STEP, JUDGE_REPLAY_FINISHED_STEP, JUDGE_REPLAY_MAX_TOKENS, batchPriceFor,
  batchResultUsd, judgeReplayBatchBody, judgeReplayCorpusDigest, loadJudgeReplayCorpus, replayJudgeCorpus, type JudgeReplayCase } from "#src/lib/judge-replay-batch.js";
import { readLedgerLines } from "#src/lib/status.js";
import { OPENWEIGHT_CONTEXT_WINDOWS, OPENWEIGHT_PRICES, clearOpenWeightAbsence, isFoundryClaudeDeployment, openWeightReservationUsd,
  resetLearnedCashCapacity } from "#src/lib/worker-provider.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Row = Record<string, unknown>;

const MODEL = "claude-haiku-5-5";
const BATCH_ID = "msgbatch_fixture01";
const USAGE = { input_tokens: 180, output_tokens: 40, cache_read_input_tokens: 0 };
// The cheapest chat deployment with one flat rate: the direct lane's candidate.
const CASH = Object.keys(OPENWEIGHT_PRICES).filter((name) => !isFoundryClaudeDeployment(name) && !CASH_RESPONSES_DEPLOYMENTS[name] &&
  OPENWEIGHT_PRICES[name]!.longContext === undefined && (OPENWEIGHT_CONTEXT_WINDOWS[name]?.totalTokens ?? 0) >= 64_000)
  .sort((a, b) => OPENWEIGHT_PRICES[a]!.inputUsdPerMillion - OPENWEIGHT_PRICES[b]!.inputUsdPerMillion)[0]!;

const casesOf = (corpus: string): JudgeReplayCase[] => loadJudgeReplayCorpus(REPO_ROOT, corpus)!.cases;
const ALL = casesOf("all");
const PROBES = casesOf("machine-judge-probes");
const DIGEST_ALL = judgeReplayCorpusDigest(ALL);
const DIGEST_PROBES = judgeReplayCorpusDigest(PROBES);

function world(t: TestContext): { dir: string; config: Config; rows: () => Row[] } {
  clearOpenWeightAbsence();
  resetLearnedCashCapacity();
  t.after(() => { clearOpenWeightAbsence(); resetLearnedCashCapacity(); });
  const { dir } = ownedFixtureDir(t, "judge-replay-digest");
  return { dir, config: { claudeBin: "/unused", root: dir, dailyCapUsd: 25, workerProviders: { cashEndpoint: "https://cash.example.test/" } } as Config,
    rows: () => readLedgerLines(join(dir, "state", "ledger.ndjson")) };
}

/** A fake Anthropic API: it creates the batch, ends it, and serves one result per request; `errored` names requests that error. */
function fakeAnthropic(bodies: string[], errored: ReadonlySet<string> = new Set()): typeof fetch {
  let requests: Array<{ custom_id: string }> = [];
  const expected = new Map(ALL.map((item) => [item.customId, item.expected]));
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  return async (target, init) => {
    const url = new URL(String(target));
    if (url.pathname === "/v1/messages/batches" && init?.method === "POST") {
      const body = Buffer.from(init.body as Uint8Array).toString("utf8");
      bodies.push(body);
      requests = (JSON.parse(body) as { requests: Array<{ custom_id: string }> }).requests;
      return json({ id: BATCH_ID, type: "message_batch", processing_status: "in_progress" });
    }
    if (url.pathname === `/v1/messages/batches/${BATCH_ID}`)
      return json({ id: BATCH_ID, processing_status: "ended", results_url: `https://api.anthropic.com/v1/messages/batches/${BATCH_ID}/results` });
    const lines = requests.map((r) => JSON.stringify({ custom_id: r.custom_id, result: errored.has(r.custom_id) ? { type: "errored" }
      : { type: "succeeded", message: { type: "message", role: "assistant", stop_reason: "end_turn",
        content: [{ type: "text", text: expected.get(r.custom_id) }], usage: USAGE } } }));
    return new Response(`${lines.join("\n")}\n`, { status: 200, headers: { "content-type": "application/binary" } });
  };
}

async function batchReplay(w: ReturnType<typeof world>, corpus: string, opts: { bodies?: string[]; errored?: ReadonlySet<string> } = {}) {
  return await replayJudgeCorpus(w.config, { model: MODEL, corpus, repoRoot: REPO_ROOT, env: { [ANTHROPIC_API_KEY_ENV]: "fixture-key-never-printed" },
    sleep: async () => {}, upstreamFetch: fakeAnthropic(opts.bodies ?? [], opts.errored) });
}

/** A fake Chat Completions endpoint: each case answers its expected option; `failing` names a case that gets a 500. */
function fakeChat(failing?: JudgeReplayCase): typeof fetch {
  return async (_target, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const item = ALL.find((candidate) => body.messages.some((message) => message.content === candidate.prompt))!;
    if (item === failing) return new Response(JSON.stringify({ error: { message: "upstream failed" } }), { status: 500, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ model: CASH, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `${item.expected}\n` } }],
      usage: { prompt_tokens: 120, completion_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

async function directReplay(w: ReturnType<typeof world>, corpus: string, failing?: JudgeReplayCase) {
  let now = 1_794_830_400_000;
  return await replayJudgeCorpus(w.config, { model: CASH, corpus, repoRoot: REPO_ROOT, env: { [DEFAULT_CASH_KEY_ENV]: "fixture-cash-key-never-printed" },
    upstreamFetch: fakeChat(failing), clock: clockFromMillisFn(() => (now += 10)), sleep: async (ms) => { now += ms; }, lane: "direct" });
}

const answered = (rows: Row[]): Row[] => rows.filter((row) => row.step === JUDGE_REPLAY_ANSWERED_STEP);
const cellsOf = (rows: Row[]): JudgeTrialCell[] =>
  judgeTrialCells(judgeTrialRows("core", rows.map((row, index) => projectFlowRow(row, `fp-${index}`))).rows, periodOf);
const digestsOf = (cells: JudgeTrialCell[]): string[] => [...new Set(cells.map((cell) => String(cell.corpusDigest)))].sort();
/** A row as a replay wrote it before this task: no digest and no replay corpus on an answered row. */
const beforeThisTask = (row: Row): Row => {
  if (row.step !== JUDGE_REPLAY_ANSWERED_STEP) return row;
  const { corpus_digest: _digest, replay_corpus: _corpus, ...rest } = row;
  return rest;
};

test("W1-T13366 criterion 1: invariant:an-answer-names-its-corpus — every answered row of both lanes carries its replay's corpus digest and corpus name", async (t) => {
  assert.notEqual(DIGEST_ALL, DIGEST_PROBES);
  // The batch lane, with one errored request: its row has no typed answer and still names the corpus.
  const batch = world(t);
  const erroredId = ALL[1]!.customId;
  assert.equal((await batchReplay(batch, "all", { errored: new Set([erroredId]) })).outcome, "ended");
  const batchRows = answered(batch.rows());
  assert.equal(batchRows.length, ALL.length);
  assert.deepEqual(batchRows.find((row) => row.custom_id === erroredId)?.typed_answers, []);
  // The direct lane, with one failed case.
  const direct = world(t);
  const finished = await directReplay(direct, "all", ALL[2]);
  assert.equal(finished.outcome, "finished", JSON.stringify(finished));
  const directRows = answered(direct.rows());
  assert.equal(directRows.length, ALL.length);
  assert.deepEqual(directRows.filter((row) => row.result === "failed").map((row) => row.case_id), [ALL[2]!.caseId]);
  for (const rows of [batchRows, directRows]) {
    assert.deepEqual([...new Set(rows.map((row) => row.corpus_digest))], [DIGEST_ALL], "one digest for the whole replay");
    assert.deepEqual([...new Set(rows.map((row) => row.replay_corpus))], ["all"]);
    // The row's own `corpus` is still the case's corpus.
    assert.deepEqual(rows.map((row) => row.corpus), ALL.map((item) => item.corpus));
  }
  // A replay of one corpus names that corpus and its own digest.
  const probes = world(t);
  await batchReplay(probes, "machine-judge-probes");
  assert.deepEqual([...new Set(answered(probes.rows()).map((row) => [row.corpus_digest, row.replay_corpus].join("|")))], [`${DIGEST_PROBES}|machine-judge-probes`]);
  const directProbes = world(t);
  await directReplay(directProbes, "machine-judge-probes");
  assert.deepEqual([...new Set(answered(directProbes.rows()).map((row) => [row.corpus_digest, row.replay_corpus].join("|")))], [`${DIGEST_PROBES}|machine-judge-probes`]);
});

test("W1-T13366 criterion 2: a batch replay's cell and an unfinished direct replay's cell name the digest, and two corpus contents are in two cells", async (t) => {
  const w = world(t);
  await batchReplay(w, "all");
  await batchReplay(w, "machine-judge-probes");
  const batchCells = cellsOf(w.rows());
  assert.ok(batchCells.length > 0);
  assert.deepEqual(digestsOf(batchCells), [DIGEST_ALL, DIGEST_PROBES].sort());
  // The probes' role, model and surface are in two cells, one per corpus content.
  const probeRole = PROBES[0]!.role;
  assert.deepEqual(batchCells.filter((cell) => cell.role === probeRole).map((cell) => [cell.model, cell.basis, cell.corpusDigest]).sort(),
    [[MODEL, "replay", DIGEST_ALL], [MODEL, "replay", DIGEST_PROBES]].sort());
  // Before this task the same rows all read `unrecorded`.
  assert.deepEqual(digestsOf(cellsOf(w.rows().map(beforeThisTask))), [JUDGE_CORPUS_DIGEST_UNRECORDED]);

  // A direct replay that stopped before its closing row, as a killed process leaves the ledger.
  const direct = world(t);
  await directReplay(direct, "all");
  const unfinished = direct.rows().filter((row) => row.step !== JUDGE_REPLAY_FINISHED_STEP);
  assert.equal(answered(unfinished).length, ALL.length);
  assert.deepEqual(digestsOf(cellsOf(unfinished)), [DIGEST_ALL]);
  assert.deepEqual(digestsOf(cellsOf(unfinished.map(beforeThisTask))), [JUDGE_CORPUS_DIGEST_UNRECORDED]);
});

test("W1-T13366 criterion 3: invariant:the-answered-row-wins — the cell takes the answered row's digest, then the finished row's, then unrecorded", async (t) => {
  const direct = world(t);
  await directReplay(direct, "all");
  const OTHER = "ffff000011112222";
  const rows = direct.rows().map((row) => (row.step === JUDGE_REPLAY_FINISHED_STEP ? { ...row, corpus_digest: OTHER } : row));
  assert.equal(rows.filter((row) => row.corpus_digest === OTHER).length, 1);
  assert.deepEqual(digestsOf(cellsOf(rows)), [DIGEST_ALL], "the answered row's digest wins over the finished row's");
  assert.deepEqual(digestsOf(cellsOf(rows.map(beforeThisTask))), [OTHER], "an older answered row takes its run's finished-row digest");
  assert.deepEqual(digestsOf(cellsOf(rows.map(beforeThisTask).filter((row) => row.step !== JUDGE_REPLAY_FINISHED_STEP))), [JUDGE_CORPUS_DIGEST_UNRECORDED]);
});

test("W1-T13366 criterion 4: the judge_replay.batch row carries the digest, and the request body, reservation, settled dollars and result counts are unchanged", async (t) => {
  const w = world(t);
  const bodies: string[] = [];
  const row = await batchReplay(w, "all", { bodies });
  assert.equal(row.outcome, "ended", JSON.stringify(row));
  assert.equal(row.corpus_digest, DIGEST_ALL);
  assert.deepEqual(w.rows().filter((line) => line.step === JUDGE_REPLAY_BATCH_STEP).map((line) => [line.corpus, line.corpus_digest]), [["all", DIGEST_ALL]]);
  // The request, the reservation and the settlement are what the unchanged formulas give for this corpus.
  const price = batchPriceFor(MODEL)!;
  assert.deepEqual(bodies, [judgeReplayBatchBody(MODEL, ALL)]);
  assert.equal(bodies[0]!.includes(DIGEST_ALL), false, "the digest is not sent");
  assert.equal(row.reserved_usd, openWeightReservationUsd(MODEL, Buffer.byteLength(bodies[0]!, "utf8"), 0, JUDGE_REPLAY_MAX_TOKENS * ALL.length, price));
  assert.ok(Math.abs(row.settled_usd - ALL.length * batchResultUsd(USAGE, price)) < 1e-12, String(row.settled_usd));
  assert.equal(row.held_usd, 0);
  assert.deepEqual(row.result_counts, { succeeded: ALL.length });
  assert.deepEqual(row.usage, { input_tokens: USAGE.input_tokens * ALL.length, output_tokens: USAGE.output_tokens * ALL.length });

  // An unknown corpus has no digest.
  const unknown = world(t);
  const refused = await batchReplay(unknown, "no-such-corpus");
  assert.deepEqual([refused.outcome, refused.reason, refused.corpus_digest], ["refused", "unknown-corpus", null]);
  assert.deepEqual(unknown.rows().filter((line) => line.step === JUDGE_REPLAY_BATCH_STEP).map((line) => line.corpus_digest), [null]);
});
