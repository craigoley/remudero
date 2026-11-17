/**
 * W1-T12423 — the field-trials snapshot has a judge family.
 *
 * The daily field-trials pass keeps rmd's private model evidence. The judge family adds agreement,
 * Brier, log-loss, abstention, rejection, latency and settled dollars per decision, for each role,
 * model and model surface, from `decision.answered`, `shadow_judge.paired` and `judge_replay` rows.
 * The rows enter no other family, the scorer is W1-T12414's, and no release reads the family.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { buildModelFieldNoteCandidate, PINNED_SITE_CONSENT_REGISTRY } from "#src/lib/field-trials-field-note.js";
import { buildFieldTrialsFlowSnapshot, buildFieldTrialsRelease, periodOf, projectFlowRow, readFieldTrialsLedger, type FieldTrialsConsent,
  type FieldTrialsFlowSnapshot, type FieldTrialsLedgerRead } from "#src/lib/field-trials-flow.js";
import { JUDGE_CORPUS_DIGEST_UNRECORDED, judgeTrialCells, judgeTrialRows, type JudgeTrialCell } from "#src/lib/field-trials-judges.js";
import { JUDGE_REPLAY_DECISION_ROLE_PREFIX } from "#src/lib/judge-replay-batch.js";
import { scoreTypedAnswers, type TypedAnswerRow } from "#src/lib/typed-answer-scores.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

type Row = Record<string, unknown>;
const T = (day: number, hour = 0) => new Date(Date.UTC(2026, 9, day, hour)).toISOString();
// 2026-10-05 and 2026-10-12 are Mondays: the two ISO weeks the rows fall in.
const WEEK_A = "2026-10-05";
const WEEK_B = "2026-10-12";
const AS_OF = T(20, 6);
const REPO = "craigoley/remudero";
const WORKER_MODEL = "gpt-6.1-sol";
const CORPUS_DIGEST = "c0ffee0123456789";
const SHADOW_HEAD = "0123abcdef0123abcdef";
const SHADOW_KEY = `W1-T900:${SHADOW_HEAD}`;

const dist = (low: number) => [{ option: "low", probability: low }, { option: "high", probability: 1 - low }];
const answered = (low: number) => ({ name: "verdict", outcome: "distribution", distribution: dist(low), confidence: null });

/** A `decision.answered` row as lib/decision-model.ts writes it. */
function decision(o: { day: number; hour?: number; run: string; candidate: string; digest: string; latency: number; usd: number;
  role?: string; answers?: unknown[]; extra?: Row }): Row {
  return { ts: T(o.day, o.hour ?? 1), step: "decision.answered", run_id: o.run, role: o.role ?? "risk", input_digest: o.digest, candidate: o.candidate,
    deployment: `${o.candidate}-deployment`, shape: "openai-decisions", model_surface: "decisions", outcome: "answered", served_model: o.candidate,
    latency_ms: o.latency, reserved_usd: o.usd, settled_usd: o.usd, held_usd: 0, usage: { input_tokens: 100, output_tokens: 1 },
    question_count: 1, answers: o.answers ?? [answered(0.75)], ...o.extra };
}

/** A `shadow_judge.paired` row as lib/shadow-judge.ts writes it: one generated answer beside the current judge's. */
function shadow(o: { day: number; key: string; model: string; primary: string; answer: string }): Row {
  return { ts: T(o.day, 2), step: "shadow_judge.paired", run_id: `shadow-run-${o.key}`, surface: "risk", decision_key: o.key, primary_model: "claude-opus-5-5",
    primary_decision: o.primary, shadow_model: o.model, shadow_decision: o.answer, agreement: o.primary === o.answer, sample_denominator: 20 };
}

const typed = (o: { model: string; surface: "decisions" | "text"; digest: string; expected: string; answer: TypedAnswerRow["answer"];
  outcome?: string | null }): TypedAnswerRow => ({ role: "risk", question: "verdict", model: o.model, source: o.surface === "decisions" ? "decisions" : "generative",
  modelSurface: o.surface, questionType: "choice", options: ["low", "high"], inputDigest: o.digest, answer: o.answer, incumbent: o.expected,
  outcome: o.outcome === undefined ? o.expected : o.outcome });

/** A `judge_replay.answered` row of the direct lane (lib/judge-replay-batch.ts): the case's expected answer is the outcome. */
function replayed(o: { day: number; run: string; model: string; digest: string; low: number; latency: number; usd: number; caseId: string }): Row {
  return { ts: T(o.day, 3), step: "judge_replay.answered", run_id: o.run, lane: "direct", corpus: "risk-judge-dispositions", case_id: o.caseId,
    custom_id: `risk-${o.caseId}`, model: o.model, deployment: `${o.model}-deployment`, model_surface: "decisions", role: "risk", question: "verdict",
    expected: "low", result: "succeeded", latency_ms: o.latency, settled_usd: o.usd,
    typed_answers: [typed({ model: o.model, surface: "decisions", digest: o.digest, expected: "low", answer: { kind: "distribution", distribution: dist(o.low) } })] };
}

const finished = (day: number, run: string, digest: string): Row => ({ ts: T(day, 4), step: "judge_replay.finished", run_id: run, lane: "direct",
  candidate: "decision-1", model_surface: "decisions", role: "risk", corpus: "risk-judge-dispositions", corpus_digest: digest, outcome: "finished",
  sent: 2, answered: 2, settled_usd: 0.002, median_latency_ms: 100 });

/** Every judge row of the fixture. The first carries a task, a host and an assignment, so a leak into another family shows. */
function judgeRows(): Row[] {
  return [
    // Week A, live, decision-1 on the decisions surface: an answer, a refusal and a malformed reply.
    decision({ day: 6, run: "dec-run-1", candidate: "decision-1", digest: "1111aaaa2222bbbb", latency: 100, usd: 0.001,
      extra: { task_id: "task-judged-private", host: "host-judge-private", head_sha: "beefbeefbeefbeefbeef",
        worker_assignment: { id: "asg-judge", requested: { model: "decision-1" }, selected: { provider: "p", model: "decision-1" } },
        benchmark_run: { work: { taskClass: { state: "observed", value: "implement" } } } } }),
    decision({ day: 6, run: "dec-run-2", candidate: "decision-1", digest: "3333cccc4444dddd", latency: 300, usd: 0.003,
      answers: [{ name: "verdict", outcome: "abstained", reason: "refusal" }] }),
    decision({ day: 7, run: "dec-run-3", candidate: "decision-1", digest: "5555eeee6666ffff", latency: 200, usd: 0.002,
      answers: [{ name: "verdict", outcome: "rejected", reason: "the reply is not a distribution" }] }),
    // Another model in the same role.
    decision({ day: 7, run: "dec-run-4", candidate: "decision-2", digest: "7777aaaa8888bbbb", latency: 40, usd: 0.004 }),
    // The same model id generating text as a shadow judge: one agreement and one disagreement with the current judge.
    shadow({ day: 7, key: SHADOW_KEY, model: "decision-1", primary: "low", answer: "low" }),
    shadow({ day: 8, key: "W1-T901:fedcba9876543210fedc", model: "decision-1", primary: "low", answer: "high" }),
    // A direct replay of one corpus through decision-1. Its own decision.answered rows are not live answers.
    decision({ day: 8, hour: 3, run: "judge-replay-1", candidate: "decision-1", digest: "9999aaaa0000bbbb", latency: 50, usd: 0.0005,
      role: `${JUDGE_REPLAY_DECISION_ROLE_PREFIX}risk` }),
    replayed({ day: 8, run: "judge-replay-1", model: "decision-1", digest: "9999aaaa0000bbbb", low: 0.75, latency: 50, usd: 0.0005, caseId: "case-1" }),
    replayed({ day: 8, run: "judge-replay-1", model: "decision-1", digest: "aaaa1111bbbb2222", low: 0.25, latency: 150, usd: 0.0015, caseId: "case-2" }),
    finished(8, "judge-replay-1", CORPUS_DIGEST),
    // A batch replay result: one generated answer, no latency, no dollars and no finished row.
    { ts: T(9, 3), step: "judge_replay.answered", run_id: "judge-replay-2", corpus: "machine-judge-probes", case_id: "probe-1", custom_id: "probe-1",
      model: "claude-haiku-5-5", batch_id: "batch-private-1", role: "risk", question: "verdict", expected: "low", result: "succeeded",
      usage: { input_tokens: 10, output_tokens: 1 },
      typed_answers: [typed({ model: "claude-haiku-5-5", surface: "text", digest: "cccc3333dddd4444", expected: "low", answer: { kind: "single", option: "low" }, outcome: null })] },
    // Week B, live, decision-1 again.
    decision({ day: 13, run: "dec-run-5", candidate: "decision-1", digest: "eeee5555ffff6666", latency: 80, usd: 0.0008 }),
  ];
}

const LIVE_DECISIONS = `core|${WEEK_A}|live|risk|decision-1|decisions|-`;
const LIVE_TEXT = `core|${WEEK_A}|live|risk|decision-1|text|-`;
const LIVE_OTHER_MODEL = `core|${WEEK_A}|live|risk|decision-2|decisions|-`;
const REPLAY_DECISIONS = `core|${WEEK_A}|replay|risk|decision-1|decisions|${CORPUS_DIGEST}`;
const REPLAY_BATCH = `core|${WEEK_A}|replay|risk|claude-haiku-5-5|text|${JUDGE_CORPUS_DIGEST_UNRECORDED}`;
const LIVE_WEEK_B = `core|${WEEK_B}|live|risk|decision-1|decisions|-`;
const ALL_CELLS = [LIVE_DECISIONS, LIVE_TEXT, LIVE_OTHER_MODEL, REPLAY_DECISIONS, REPLAY_BATCH, LIVE_WEEK_B].sort();

/** Twenty assignments and their attempts: enough for the release and the field note to publish one cell. */
function workerRows(): Row[] {
  return Array.from({ length: 20 }, (_, i) => {
    const id = `asg-worker-${i}`;
    const base = { host: "host-alpha-private", actor: "daemon", task_id: `task-${id}`, run_id: `run-${id}` };
    return [
      { ...base, ts: T(6, 2), step: "worker.assignment", worker_assignment: { id, requested: { model: WORKER_MODEL }, selected: { provider: "p", model: WORKER_MODEL } },
        benchmark_run: { work: { taskClass: { state: "observed", value: "implement" } } } },
      { ...base, ts: T(6, 3), step: "worker.attempt", selection_assignment_id: id, success: true, served_model: WORKER_MODEL },
    ];
  }).flat();
}

function projected(rows: Row[]): FieldTrialsLedgerRead {
  return { state: "observed", reason: null, forms: { gzip: 0, plain: 0, live: 1 }, malformedRows: 0, duplicateRows: 0, futureRows: 0,
    unreadSources: 0, newestTs: null, rows: rows.map((row, i) => projectFlowRow(row, `fp-${i}`)) };
}

function snapshotOf(ledger: FieldTrialsLedgerRead, prior?: FieldTrialsFlowSnapshot): FieldTrialsFlowSnapshot {
  return buildFieldTrialsFlowSnapshot({ asOf: AS_OF, sources: [{ label: "core", repo: REPO, ledger }],
    github: { version: "field-trials-github-v1", repos: {} }, ...(prior ? { prior } : {}) });
}

/** The production read: a three-form ledger on disk, through readFieldTrialsLedger. */
async function readLedger(rows: Row[]): Promise<FieldTrialsLedgerRead> {
  const fixture = writeLedger(rows);
  try {
    return await readFieldTrialsLedger(fixture.dir, Date.parse(AS_OF));
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

const cellsOf = (snapshot: FieldTrialsFlowSnapshot): Record<string, JudgeTrialCell> =>
  Object.fromEntries(Object.entries(snapshot.families.judges).map(([key, partition]) => [key, partition.cells]));

test("W1-T12423 criterion 1: judge rows are read beside the present steps and enter only the judge family", async () => {
  const without = snapshotOf(await readLedger(workerRows()));
  const ledger = await readLedger([...workerRows(), ...judgeRows()]);
  // The reader keeps all four judge steps, each with its judge fields.
  for (const step of ["decision.answered", "shadow_judge.paired", "judge_replay.answered", "judge_replay.finished"]) {
    assert.ok(ledger.rows.some((row) => row.step === step && row.judge !== undefined), `the snapshot reads ${step}`);
  }
  assert.equal(ledger.rows.filter((row) => row.judge !== undefined).length, judgeRows().length);
  const withJudges = snapshotOf(ledger);
  assert.deepEqual(Object.keys(without.families.judges), [], "no judge row, no judge cell");
  assert.deepEqual(Object.keys(withJudges.families.judges).sort(), ALL_CELLS, "decision, shadow and replay rows each reach the judge family");
  // Positive control: the worker rows did build the other families.
  assert.ok(Object.keys(without.families.adoption).length > 0 && Object.keys(without.families.funnel).length > 0);
  const others = (snapshot: FieldTrialsFlowSnapshot) => {
    const { judges, ...families } = snapshot.families;
    void judges;
    return { families, servedTrialCohorts: snapshot.servedTrialCohorts, assignmentTelemetry: snapshot.assignmentTelemetry, links: snapshot.links,
      preventionAdoption: snapshot.preventionAdoption, preventionExecution: snapshot.preventionExecution,
      reviewFindingOutcomes: snapshot.reviewFindingOutcomes, reviewFindingEvidence: snapshot.reviewFindingEvidence };
  };
  assert.deepEqual(others(withJudges), others(without),
    "the adoption, funnel, repair, flow, learning, guardrail and served-cohort figures are the same with or without judge rows");
  assert.deepEqual(withJudges.rebuild.rebuiltPartitions.filter((key) => !key.startsWith("judges:")), without.rebuild.rebuiltPartitions);
});

test("W1-T12423 criterion 2: a judge cell is keyed by source, week, role, model and surface and gives its measures", () => {
  const cells = cellsOf(snapshotOf(projected(judgeRows())));
  const live = cells[LIVE_DECISIONS]!;
  assert.deepEqual({ source: live.source, period: live.period, role: live.role, model: live.model, modelSurface: live.modelSurface },
    { source: "core", period: WEEK_A, role: "risk", model: "decision-1", modelSurface: "decisions" });
  // Three decisions: one distribution, one abstention, one rejection. No current judge's answer, so nothing is compared.
  assert.deepEqual([live.decisions, live.answers, live.distributions, live.abstained, live.rejected], [3, 3, 1, 1, 1]);
  assert.deepEqual([live.abstentionRate, live.rejectionRate], [1 / 3, 1 / 3]);
  assert.deepEqual(live.agreement, { compared: 0, agreed: 0, rate: null });
  assert.deepEqual([live.brier, live.logLoss], [null, null], "a distribution with no outcome has no Brier or log-loss figure");
  // Latencies 100, 200, 300 ms and dollars 0.001, 0.002, 0.003: the median, and the nearest-rank 90th percentile.
  assert.deepEqual(live.latencyMs, { observed: 3, median: 200, p90: 300 });
  assert.deepEqual(live.settledUsd, { observed: 3, median: 0.002 });
  // The same model id on the text surface is another cell: two single answers, one agreeing with the current judge.
  const text = cells[LIVE_TEXT]!;
  assert.deepEqual([text.modelSurface, text.answers, text.singles, text.distributions], ["text", 2, 2, 0]);
  assert.deepEqual(text.agreement, { compared: 2, agreed: 1, rate: 0.5 });
  assert.deepEqual([text.latencyMs, text.settledUsd], [{ observed: 0, median: null, p90: null }, { observed: 0, median: null }],
    "a shadow row records no latency and no dollars, and that is not a zero");
  // Another model in the same role, week and surface is another cell.
  assert.deepEqual([cells[LIVE_OTHER_MODEL]!.model, cells[LIVE_OTHER_MODEL]!.answers, cells[LIVE_OTHER_MODEL]!.latencyMs.median], ["decision-2", 1, 40]);
  // Where a distribution has an outcome the cell has Brier and log-loss: (0.125 + 1.125) / 2 and the mean of -ln 0.75 and -ln 0.25.
  const replay = cells[REPLAY_DECISIONS]!;
  assert.deepEqual(replay.outcomes, { scored: 2, unknown: 0, notDeclared: 0 });
  assert.equal(replay.brier, 0.625);
  assert.equal(replay.logLoss, (-Math.log(0.75) - Math.log(0.25)) / 2);
  assert.deepEqual(replay.agreement, { compared: 2, agreed: 1, rate: 0.5 });
  assert.deepEqual([replay.latencyMs, replay.settledUsd], [{ observed: 2, median: 100, p90: 150 }, { observed: 2, median: 0.001 }]);
  assert.deepEqual(replay.questions.map((entry) => [entry.question, entry.answers, entry.brier]), [["verdict", 2, 0.625]]);
  // No cell holds two models or two surfaces: every (model, surface) of the rows has its own cells.
  const pairs = new Map<string, Set<string>>();
  for (const [key, cell] of Object.entries(cells)) pairs.set(key, new Set([...(pairs.get(key) ?? []), `${cell.model}\n${cell.modelSurface}`]));
  for (const [key, held] of pairs) assert.equal(held.size, 1, key);
  assert.equal(new Set(Object.values(cells).map((cell) => `${cell.period}|${cell.basis}|${cell.corpusDigest}|${cell.role}|${cell.model}|${cell.modelSurface}`)).size,
    Object.keys(cells).length);
});

test("W1-T12423 criterion 3: live and replay answers are in separate cells and a replay cell names its corpus digest", () => {
  const cells = cellsOf(snapshotOf(projected(judgeRows())));
  // The same role, model, surface and week, apart by basis.
  const live = cells[LIVE_DECISIONS]!;
  const replay = cells[REPLAY_DECISIONS]!;
  assert.deepEqual([live.basis, live.corpusDigest, live.answers], ["live", null, 3]);
  assert.deepEqual([replay.basis, replay.corpusDigest, replay.answers], ["replay", CORPUS_DIGEST, 2],
    "a replay answer takes its replay's corpus digest from the finished row of the same run");
  // The direct replay's own decision.answered row is not a live answer: the live cell still has its three decisions.
  assert.equal(live.decisions, 3);
  // A replay that wrote no digest says so: it never joins a cell that names one.
  const batch = cells[REPLAY_BATCH]!;
  assert.deepEqual([batch.basis, batch.corpusDigest, batch.answers, batch.singles], ["replay", JUDGE_CORPUS_DIGEST_UNRECORDED, 1, 1]);
  assert.deepEqual(Object.values(cells).filter((cell) => cell.basis === "replay").map((cell) => cell.corpusDigest).sort(),
    [CORPUS_DIGEST, JUDGE_CORPUS_DIGEST_UNRECORDED].sort());
  for (const cell of Object.values(cells)) assert.equal(cell.corpusDigest === null, cell.basis === "live", `${cell.basis} ${cell.model}`);
});

test("W1-T12423 criterion 4: the cell's agreement, Brier, log-loss and shares are the scorer's", () => {
  const { rows } = judgeTrialRows("core", projected(judgeRows()).rows);
  const key = (cell: JudgeTrialCell) => [cell.source, cell.period, cell.basis, cell.role, cell.model, cell.modelSurface, cell.corpusDigest ?? "-"].join("|");
  const figures = (cell: JudgeTrialCell) => ({ agreement: cell.agreement, abstentionRate: cell.abstentionRate, rejectionRate: cell.rejectionRate,
    brier: cell.brier, logLoss: cell.logLoss });
  // The snapshot's cell equals W1-T12414's scorer on the same recorded answers.
  const snapshotCells = cellsOf(snapshotOf(projected(judgeRows())));
  const recorded = rows.filter((row) => row.basis === "replay" && row.model === "decision-1").flatMap((row) => row.answers);
  assert.equal(recorded.length, 2);
  const group = scoreTypedAnswers(recorded.map((answer) => ({ ...answer, question: null }))).groups[0]!;
  assert.deepEqual(figures(snapshotCells[REPLAY_DECISIONS]!), { agreement: group.agreement, abstentionRate: group.abstentionRate,
    rejectionRate: group.rejectionRate, brier: group.brier, logLoss: group.logLoss });
  // A scorer that changes its figures for one input changes that input's cell by the same amount, and no other cell.
  const marked = "aaaa1111bbbb2222";
  const delta = 0.125;
  const shifted: typeof scoreTypedAnswers = (answers, opts) => {
    const scores = scoreTypedAnswers(answers, opts);
    if (!answers.some((answer) => answer.inputDigest === marked)) return scores;
    return { ...scores, groups: scores.groups.map((entry) => ({ ...entry, abstentionRate: entry.abstentionRate + delta,
      rejectionRate: entry.rejectionRate + delta, brier: entry.brier! + delta, logLoss: entry.logLoss! + delta,
      agreement: { ...entry.agreement, rate: entry.agreement.rate! + delta } })) };
  };
  const base = new Map(judgeTrialCells(rows, periodOf).map((cell) => [key(cell), cell]));
  const moved = new Map(judgeTrialCells(rows, periodOf, shifted).map((cell) => [key(cell), cell]));
  assert.deepEqual([...moved.keys()], [...base.keys()]);
  const before = base.get(REPLAY_DECISIONS)!;
  const after = moved.get(REPLAY_DECISIONS)!;
  assert.deepEqual(figures(after), { agreement: { ...before.agreement, rate: before.agreement.rate! + delta },
    abstentionRate: before.abstentionRate + delta, rejectionRate: before.rejectionRate + delta, brier: before.brier! + delta,
    logLoss: before.logLoss! + delta });
  assert.deepEqual([after.agreement.rate, after.brier, after.abstentionRate, after.rejectionRate], [0.625, 0.75, 0.125, 0.125]);
  for (const [cellKey, cell] of base) if (cellKey !== REPLAY_DECISIONS) assert.deepEqual(moved.get(cellKey), cell, cellKey);
});

const CONSENT: FieldTrialsConsent = { version: "field-trials-consent-v1", repos: [
  { repo: REPO, rights: "aggregate-opt-in", receipt: "owner-2026-10-27-fixture" }] };

test("W1-T12423 criterion 5: the judge family is private and no release reads it", async () => {
  const without = snapshotOf(await readLedger(workerRows()));
  const withJudges = snapshotOf(await readLedger([...workerRows(), ...judgeRows()]));
  // No input digest, decision key, head, run id, task or host enters a cell, and each is a private key.
  const family = JSON.stringify(withJudges.families.judges);
  const secrets = ["1111aaaa2222bbbb", "3333cccc4444dddd", "9999aaaa0000bbbb", "aaaa1111bbbb2222", "cccc3333dddd4444", SHADOW_KEY, SHADOW_HEAD,
    "W1-T901:fedcba9876543210fedc", "dec-run-1", "judge-replay-1", "judge-replay-2", "task-judged-private", "host-judge-private", "beefbeefbeefbeefbeef"];
  assert.ok(family.includes(CORPUS_DIGEST) && family.includes("decision-1"), "positive control: the family text holds the cells");
  for (const secret of secrets) {
    assert.equal(family.includes(secret), false, `${secret} is in no cell`);
    assert.ok(withJudges.privateKeys.includes(secret), `${secret} is a private key`);
    assert.equal(without.privateKeys.includes(secret), false);
  }
  // The release and the field-note candidate are byte-identical with or without judge rows.
  const release = (snapshot: FieldTrialsFlowSnapshot) => buildFieldTrialsRelease(snapshot, CONSENT, "salt-one");
  assert.equal(release(without).state, "candidate", "positive control: the worker rows release a candidate");
  assert.equal(JSON.stringify(release(withJudges)), JSON.stringify(release(without)));
  const note = (snapshot: FieldTrialsFlowSnapshot) => buildModelFieldNoteCandidate({ snapshot, consent: CONSENT, registry: PINNED_SITE_CONSENT_REGISTRY,
    windows: { version: "field-note-windows-v1", windows: [] }, salt: "salt-one", nowIso: T(20, 7) });
  assert.equal(note(without).state, "candidate", "positive control: the worker rows write a field-note candidate");
  assert.equal(JSON.stringify(note(withJudges)), JSON.stringify(note(without)));
  for (const text of [JSON.stringify(release(withJudges)), JSON.stringify(note(withJudges))]) {
    for (const judged of ["decision-1", "decision-2", "claude-haiku-5-5", CORPUS_DIGEST, "replay"]) assert.equal(text.includes(judged), false, judged);
  }
});

test("W1-T12423 criterion 6: an unchanged week is reused and a late row rebuilds only its own week", () => {
  const first = snapshotOf(projected(judgeRows()));
  assert.deepEqual(first.rebuild.rebuiltPartitions.filter((key) => key.startsWith("judges:")).sort(), ALL_CELLS.map((key) => `judges:${key}`));
  for (const partition of Object.values(first.families.judges)) assert.match(partition.inputHash, /^[a-f0-9]{64}$/);
  // The same ledger again: every judge partition is the prior one.
  const again = snapshotOf(projected(judgeRows()), first);
  assert.deepEqual(again.rebuild.rebuiltPartitions.filter((key) => key.startsWith("judges:")), []);
  for (const key of ALL_CELLS) assert.equal(again.families.judges[key], first.families.judges[key], key);
  // A late answer in week A, appended so every earlier row keeps its fingerprint.
  const late = decision({ day: 9, run: "dec-run-late", candidate: "decision-2", digest: "dddd7777eeee8888", latency: 60, usd: 0.006 });
  const next = snapshotOf(projected([...judgeRows(), late]), first);
  assert.deepEqual(next.rebuild.rebuiltPartitions.filter((key) => key.startsWith("judges:")), [`judges:${LIVE_OTHER_MODEL}`],
    "only the late row's own cell, in its own week, is rebuilt");
  assert.equal(next.families.judges[LIVE_WEEK_B], first.families.judges[LIVE_WEEK_B], "week B is the prior partition, not a copy");
  for (const key of ALL_CELLS.filter((cell) => cell !== LIVE_OTHER_MODEL)) assert.equal(next.families.judges[key], first.families.judges[key], key);
  assert.notEqual(next.families.judges[LIVE_OTHER_MODEL]!.inputHash, first.families.judges[LIVE_OTHER_MODEL]!.inputHash);
  assert.deepEqual([next.families.judges[LIVE_OTHER_MODEL]!.cells.decisions, next.families.judges[LIVE_OTHER_MODEL]!.cells.latencyMs.median], [2, 50]);
});
