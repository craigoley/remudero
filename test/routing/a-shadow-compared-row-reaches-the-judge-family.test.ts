/**
 * W1-T14853 — the field-trials judge family reads the judge_shadow.compared and judge_shadow.skipped rows of every
 * shadow arm, so a live shadow cell carries agreement with the judge it shadows, and each decision-model replay names
 * its age. The decision-arm rows here are written by the real shadowJudgeCall (lib/judge-shadow.ts); only the decision
 * request is a fake, which also writes the decision.answered row the real askDecisionModel writes. No paid call runs.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import type { Config } from "#src/lib/config.js";
import type { DecisionAnsweredRow } from "#src/lib/decision-model.js";
import { buildModelFieldNoteCandidate, PINNED_SITE_CONSENT_REGISTRY } from "#src/lib/field-trials-field-note.js";
import { buildFieldTrialsFlowSnapshot, buildFieldTrialsRelease, periodOf, projectFlowRow, readFieldTrialsLedger, type FieldTrialsConsent,
  type FieldTrialsFlowSnapshot, type FieldTrialsLedgerRead } from "#src/lib/field-trials-flow.js";
import { JUDGE_REPLAY_STALE_DAYS, judgeReplayAges, judgeTrialCells, judgeTrialRows, type JudgeTrialCell } from "#src/lib/field-trials-judges.js";
import { emptyJudgeVerdictFold, foldJudgeVerdictRow, judgeCalibrationRow, typedAnswersWithOutcomes } from "#src/lib/judge-calibration.js";
import { shadowJudgeCall, type ShadowJudgeCall } from "#src/lib/judge-shadow.js";
import { loadMounts, mountsPath, type JudgeMount } from "#src/lib/mounts.js";
import { scoreTypedAnswers, type TypedAnswerRow } from "#src/lib/typed-answer-scores.js";
import type { SpawnWorkerArgs } from "#src/lib/worker.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Row = Record<string, unknown>;
const LUNA = loadMounts(mountsPath(REPO_ROOT)).decision_models!["decisions-eastus"]!;
const WEEK = "2026-10-05";
const AS_OF = "2026-10-20T06:00:00.000Z";
const REPO = "craigoley/remudero";
const OPTIONS = ["automate", "needs_operator", "backlog"];
const mount: JudgeMount = { model: "haiku", effort: "low", maxTurns: 400, contextBudget: 60000,
  shadow: { provider: "decisions", deployment: LUNA.deployment, candidate: LUNA } };

type Reply = { kind: "distribution"; top: string; cannotTell?: number } | { kind: "abstained" } | { kind: "rejected" } | { kind: "budget" } | { kind: "rate-limited" };

/** One real decision-arm shadow call. Returns the decision.answered row the request wrote and the judge_shadow row. */
async function decisionShadow(o: { hour: number; head: string; primary: string; reply: Reply; latency: number; cost: number;
  threshold?: number; learnedLimitTokens?: number }): Promise<Row[]> {
  const rows: Row[] = [];
  const ts = `2026-10-06T${String(o.hour).padStart(2, "0")}:00:00.000Z`;
  const answer = (): DecisionAnsweredRow["answers"][number] =>
    o.reply.kind === "abstained" ? { name: "verify_human", outcome: "abstained", reason: "cannot-tell" }
      : o.reply.kind === "rejected" ? { name: "verify_human", outcome: "rejected", reason: "verify_human summed to 0.974, not 1" }
        : { name: "verify_human", outcome: "distribution", confidence: null, distribution: OPTIONS.map((option) =>
          ({ option, probability: option === (o.reply as { top: string }).top ? 0.8 : 0.1 })),
          ...((o.reply as { cannotTell?: number }).cannotTell === undefined ? {} : { cannotTell: (o.reply as { cannotTell: number }).cannotTell }) };
  const shadowMount: JudgeMount = o.threshold === undefined ? mount
    : { ...mount, threshold: { model: LUNA.deployment, surface: "decisions", value: o.threshold } };
  // A resolvable target, so the learned-limit check runs; the endpoint and key are placeholders and nothing is sent.
  const config = { claudeBin: "/unused", root: "/unused",
    workerProviders: { cashDeploymentEndpoints: { [LUNA.endpoint.source === "cash-default" ? "unused" : LUNA.endpoint.entry]:
      { endpoint: "https://decisions.invalid", keyEnv: "RMD_TEST_DECISIONS_KEY" } } } } as unknown as Config;
  const call: ShadowJudgeCall<string> = { role: "verify-human", key: `shard-${o.head}`, mount: shadowMount, input: "judge this record",
    primaryArgs: { cwd: REPO_ROOT, prompt: "judge this record", tools: [] } as unknown as SpawnWorkerArgs, primary: { costUsd: 0.0004 },
    primaryAnswer: o.primary, parse: (text) => text.trim(), agreementKey: (v) => v, head: { sha: o.head },
    spawn: async () => assert.fail("a decision arm spawns no worker"),
    log: (step, fields) => { rows.push({ ts, step, ...fields }); },
    decisions: { config: () => config, env: { RMD_TEST_DECISIONS_KEY: "placeholder" }, learnedLimit: () => o.learnedLimitTokens,
      ask: async (_config, request) => {
        const refused = o.reply.kind === "budget";
        const limited = o.reply.kind === "rate-limited";
        const row: DecisionAnsweredRow = { role: request.role, input_digest: `in-${o.head}`, candidate: request.candidate.name,
          deployment: request.candidate.deployment, shape: request.candidate.shape, model_surface: "decisions",
          outcome: refused ? "refused" : limited ? "unavailable" : "answered",
          ...(refused ? { reason: "budget-refused", detail: "openweight daily allowance exhausted" } : limited ? { reason: "http-error", status: 429 } : {}),
          served_model: refused || limited ? null : LUNA.deployment, latency_ms: o.latency, reserved_usd: 0.001, settled_usd: refused || limited ? 0 : o.cost,
          held_usd: 0, usage: null, question_count: 1, answers: refused || limited ? [] : [answer()] };
        // What the real askDecisionModel appends: the request's own decision.answered row, with its head.
        rows.push({ ts, step: "decision.answered", run_id: `decision-${o.head}`, ...row, head_sha: o.head });
        return row;
      } } };
  await shadowJudgeCall(call);
  return rows;
}

/** A cash-arm judge_shadow.compared row, field for field as judge-shadow.ts:316 writes it. */
const cashCompared = (hour: number, key: string, primary: string, shadow: string): Row => ({ ts: `2026-10-06T${String(hour).padStart(2, "0")}:00:00.000Z`,
  step: "judge_shadow.compared", role: "refresh-value", decision_key: key, primary_model: "gpt-6-luna", primary_provider: null, primary_cost_usd: 0,
  shadow_effort: "default", shadow_model: "gpt-oss-120b", shadow_cost_usd: 0.0004, primary_answer: primary, shadow_answer: shadow, agreement: primary === shadow });

function projected(rows: Row[]): FieldTrialsLedgerRead {
  return { state: "observed", reason: null, forms: { gzip: 0, plain: 0, live: 1 }, malformedRows: 0, duplicateRows: 0, futureRows: 0,
    unreadSources: 0, newestTs: null, rows: rows.map((row, i) => projectFlowRow(row, `fp-${i}`)) };
}
const cellsOf = (rows: Row[]): JudgeTrialCell[] => judgeTrialCells(judgeTrialRows("core", projected(rows).rows).rows, periodOf);
const cellOf = (rows: Row[], key: string): JudgeTrialCell => {
  const cell = cellsOf(rows).find((c) => [c.source, c.period, c.basis, c.role, c.model, c.modelSurface, c.corpusDigest ?? "-"].join("|") === key);
  assert.ok(cell, `a cell ${key}`);
  return cell;
};
const typedOf = (row: Row): TypedAnswerRow[] => (judgeCalibrationRow(row)?.typed_answers ?? []) as TypedAnswerRow[];
const shadowRow = (rows: Row[]): Row => rows.find((row) => String(row.step).startsWith("judge_shadow."))!;
const DECISION_CELL = `core|${WEEK}|live|verify-human|decisions-eastus|decisions|-`;

test("W1-T14853 criterion 1: a judge_shadow.compared row is one typed answer of its role and shadow model, with the primary's answer as its incumbent", async () => {
  const agree = await decisionShadow({ hour: 1, head: "a1a1a1a1", primary: "automate", reply: { kind: "distribution", top: "automate" }, latency: 300, cost: 0.0002 });
  const differ = await decisionShadow({ hour: 2, head: "b2b2b2b2", primary: "backlog", reply: { kind: "distribution", top: "automate" }, latency: 310, cost: 0.0003 });
  assert.equal(shadowRow(agree).step, "judge_shadow.compared");
  const [typed] = typedOf(shadowRow(agree));
  assert.deepEqual([typed!.role, typed!.model, typed!.modelSurface, typed!.source, typed!.question, typed!.incumbent, typed!.head, typed!.answer.kind],
    ["verify-human", "decisions-eastus", "decisions", "decisions", "verify_human", "automate", "a1a1a1a1", "distribution"]);
  const cell = cellOf([...agree, ...differ], DECISION_CELL);
  assert.deepEqual(cell.agreement, { compared: 2, agreed: 1, rate: 0.5 });
  assert.deepEqual([cell.distributions, cell.decisions], [2, 2]);

  const cash = [cashCompared(3, "20916@c3c3c3c3", "overlap", "overlap"), cashCompared(4, "20917@d4d4d4d4", "overlap", "independent")];
  const [single] = typedOf(cash[0]!);
  assert.deepEqual([single!.model, single!.modelSurface, single!.source, single!.answer, single!.incumbent, single!.head],
    ["gpt-oss-120b", "text", "generative", { kind: "single", option: "overlap" }, "overlap", "c3c3c3c3"]);
  const textCell = cellOf(cash, `core|${WEEK}|live|refresh-value|gpt-oss-120b|text|-`);
  assert.deepEqual([textCell.agreement, textCell.singles, textCell.settledUsd.median], [{ compared: 2, agreed: 1, rate: 0.5 }, 2, 0.0004]);

  // A compared row that only says whether the reply parsed (decision-summary) carries no option, so it is no answer either way.
  const parseOnly = (hour: number, parses: boolean): Row => ({ ts: `2026-10-06T${String(hour).padStart(2, "0")}:00:00.000Z`, step: "judge_shadow.compared",
    role: "decision-summary", decision_key: "a32d45d68a3b06aa", primary_model: "gpt-6-luna", primary_provider: null, primary_cost_usd: 0,
    shadow_effort: "low", shadow_model: "gpt-oss-120b", shadow_cost_usd: 0.0006, parses });
  assert.equal(judgeCalibrationRow(parseOnly(5, true)), undefined);
  assert.equal(judgeCalibrationRow(parseOnly(6, false)), undefined);
  assert.equal(cellsOf([parseOnly(5, true), parseOnly(6, false)]).length, 0, "no decision-summary cell reports a parse as a rejection");
});

test("W1-T14853 criterion 2: a skipped decision-arm row is an abstained or a rejected answer, and a budget refusal is no answer", async () => {
  const abstained = await decisionShadow({ hour: 5, head: "e5e5e5e5", primary: "automate", reply: { kind: "abstained" }, latency: 200, cost: 0.0001 });
  const rejected = await decisionShadow({ hour: 6, head: "f6f6f6f6", primary: "automate", reply: { kind: "rejected" }, latency: 210, cost: 0.0001 });
  const refused = await decisionShadow({ hour: 7, head: "a7a7a7a7", primary: "automate", reply: { kind: "budget" }, latency: 6, cost: 0 });
  const below = await decisionShadow({ hour: 8, head: "b8b8b8b8", primary: "automate", reply: { kind: "distribution", top: "automate" }, latency: 220, cost: 0.0001,
    threshold: 0.95 });
  const limited = await decisionShadow({ hour: 9, head: "c9c9c9c9", primary: "automate", reply: { kind: "rate-limited" }, latency: 90, cost: 0 });
  const capacity = await decisionShadow({ hour: 10, head: "d0d0d0d0", primary: "automate", reply: { kind: "distribution", top: "automate" }, latency: 0, cost: 0,
    learnedLimitTokens: 1 });
  const skipped = [abstained, rejected, refused, below, limited, capacity].map(shadowRow);
  assert.deepEqual(skipped.map((row) => [row.step, row.refusal ?? row.abstained ?? null]), [["judge_shadow.skipped", "cannot-tell"],
    ["judge_shadow.skipped", null], ["judge_shadow.skipped", "budget"], ["judge_shadow.skipped", "below-threshold"], ["judge_shadow.skipped", null],
    ["judge_shadow.skipped", "capacity"]], "positive control: the real writer skipped each request for its own reason");
  assert.match(String(shadowRow(limited).reason), /429/);
  assert.equal(capacity.some((row) => row.step === "decision.answered"), false, "a capacity refusal sends no request");
  assert.deepEqual(typedOf(shadowRow(abstained))[0]!.answer, { kind: "abstained", reason: "cannot-tell" });
  assert.deepEqual(typedOf(shadowRow(below))[0]!.answer, { kind: "abstained", reason: "refusal" });
  assert.equal(typedOf(shadowRow(rejected))[0]!.answer.kind, "rejected");
  assert.equal(typedOf(shadowRow(limited))[0]!.answer.kind, "rejected", "an unavailable model is a rejected answer");
  assert.equal(judgeCalibrationRow(shadowRow(refused)), undefined, "a budget refusal made no answer");
  assert.equal(judgeCalibrationRow(shadowRow(capacity)), undefined, "a capacity refusal made no answer");
  const cell = cellOf([...abstained, ...rejected, ...refused, ...below, ...limited, ...capacity], DECISION_CELL);
  assert.deepEqual([cell.decisions, cell.answers, cell.abstained, cell.rejected, cell.refused], [4, 4, 2, 2, 2]);
  assert.deepEqual(cell.agreement, { compared: 0, agreed: 0, rate: null }, "no answer is never a disagreement");
});

test("W1-T14853 criterion 3: invariant:one-request-one-answer — a decision-arm request counts once, whichever rows it wrote", async () => {
  const requests = [
    await decisionShadow({ hour: 8, head: "a8a8a8a8", primary: "automate", reply: { kind: "distribution", top: "automate" }, latency: 300, cost: 0.0002 }),
    await decisionShadow({ hour: 9, head: "b9b9b9b9", primary: "automate", reply: { kind: "distribution", top: "backlog" }, latency: 320, cost: 0.0004 }),
    await decisionShadow({ hour: 10, head: "c0c0c0c0", primary: "automate", reply: { kind: "abstained" }, latency: 250, cost: 0.0001 }),
  ];
  for (const rows of requests) assert.deepEqual(rows.map((row) => row.step).sort(), ["decision.answered", rows.find((r) => r.step !== "decision.answered")!.step],
    "positive control: each request wrote both rows");
  const cell = cellOf(requests.flat(), DECISION_CELL);
  assert.deepEqual([cell.decisions, cell.answers, cell.settledUsd.observed, cell.latencyMs.observed], [3, 3, 3, 3]);
  assert.equal(cell.settledUsd.median, 0.0002);
  // A decision model asked as a judge's primary writes decision.answered alone; it is not a shadow request and still counts.
  const primaryOnly = { ...requests[0]!.find((row) => row.step === "decision.answered")!, ts: "2026-10-06T11:00:00.000Z", head_sha: "d1d1d1d1", latency_ms: 999 };
  assert.equal(cellOf([...requests.flat(), primaryOnly], DECISION_CELL).decisions, 4);

  // The judge calibration fold (the analytics body's reader) counts each request once too.
  const fold = emptyJudgeVerdictFold();
  for (const row of [...requests.flat(), primaryOnly]) foldJudgeVerdictRow(fold, row);
  const scored = scoreTypedAnswers(typedAnswersWithOutcomes(fold)).groups.filter((group) => group.role === "verify-human" && group.model === "decisions-eastus");
  assert.equal(scored.reduce((sum, group) => sum + group.answers, 0), 4, "three shadow requests and one primary request");
  assert.equal(scored.reduce((sum, group) => sum + group.abstained, 0), 1, "the abstention counts once");
  // The same rows folded through the checkpoint (judgeCalibrationRow, then JSON) still count once.
  const viaCheckpoint = emptyJudgeVerdictFold();
  for (const row of [...requests.flat(), primaryOnly]) {
    const kept = judgeCalibrationRow(row);
    if (kept) foldJudgeVerdictRow(viaCheckpoint, JSON.parse(JSON.stringify(kept)) as Row);
  }
  assert.equal(scoreTypedAnswers(typedAnswersWithOutcomes(viaCheckpoint)).groups
    .filter((group) => group.role === "verify-human").reduce((sum, group) => sum + group.answers, 0), 4);
});

test("W1-T14853 criterion 4: invariant:one-compared-key — the scorer's agreement equals each compared row's own agreement field", async () => {
  const rows = [
    ...await decisionShadow({ hour: 12, head: "a2a2a2a2", primary: "automate", reply: { kind: "distribution", top: "automate" }, latency: 300, cost: 0.0002 }),
    ...await decisionShadow({ hour: 13, head: "b3b3b3b3", primary: "needs_operator", reply: { kind: "distribution", top: "backlog" }, latency: 301, cost: 0.0002 }),
    // A dominant cannot-tell mass: the writer compares the declared options, and so must the reader.
    ...await decisionShadow({ hour: 14, head: "c4c4c4c4", primary: "automate", reply: { kind: "distribution", top: "automate", cannotTell: 0.7 }, latency: 302, cost: 0.0002 }),
    cashCompared(15, "20918@e4e4e4e4", "overlap", "overlap"), cashCompared(16, "20919@f5f5f5f5", "independent", "overlap"),
  ];
  const compared = rows.filter((row) => row.step === "judge_shadow.compared" && typeof row.primary_answer === "string");
  assert.equal(compared.length, 5);
  assert.equal(compared.find((row) => row.head_sha === "c4c4c4c4")!.cannot_tell, 0.7, "positive control: the writer kept the cannot-tell mass");
  for (const row of compared) {
    const scored = scoreTypedAnswers(typedOf(row)).groups[0]!;
    assert.deepEqual(scored.agreement, { compared: 1, agreed: row.agreement === true ? 1 : 0, rate: row.agreement === true ? 1 : 0 });
  }
});

test("W1-T14853 criterion 5: every cell names newestAt, and each decision-model candidate names its newest replay and whether it is stale", async () => {
  const live = await decisionShadow({ hour: 16, head: "a6a6a6a6", primary: "automate", reply: { kind: "distribution", top: "automate" }, latency: 300, cost: 0.0002 });
  assert.equal(cellOf(live, DECISION_CELL).newestAt, "2026-10-06T16:00:00.000Z");
  const replay = (ts: string, model: string, role: string): Row => ({ ts, step: "judge_replay.answered", run_id: `judge-replay-${model}-${ts}`,
    corpus_digest: "0fefb4a5a9a02081", model, model_surface: "decisions", role,
    typed_answers: [{ role, question: "q", model, source: "decisions", modelSurface: "decisions", questionType: "choice", options: ["escalate", "proceed"],
      inputDigest: `case-${ts}`, answer: { kind: "distribution", distribution: [{ option: "escalate", probability: 0.9 }, { option: "proceed", probability: 0.1 }] },
      incumbent: "escalate", outcome: "escalate" }] });
  const fresh = new Date(Date.parse(AS_OF) - 2 * 86_400_000).toISOString();
  const old = new Date(Date.parse(AS_OF) - (JUDGE_REPLAY_STALE_DAYS + 1) * 86_400_000).toISOString();
  const offline = { ...live.find((row) => row.step === "decision.answered")!, candidate: "systemone-eastus2", role: "probe", head_sha: "b7b7b7b7", latency_ms: 41 };
  const rows = [...live, replay(old, "decisions-eastus", "risk"), replay(fresh, "decisions-eastus", "machine-filing"), offline];
  assert.equal(JUDGE_REPLAY_STALE_DAYS, 7);
  assert.deepEqual(judgeReplayAges(cellsOf(rows), AS_OF), [
    { model: "decisions-eastus", role: "machine-filing", newestReplayAt: fresh, stale: false },
    { model: "decisions-eastus", role: "risk", newestReplayAt: old, stale: true },
    { model: "systemone-eastus2", role: null, newestReplayAt: null, stale: true },
  ]);
  const snapshot = snapshotOf(await readLedger([...workerRows(), ...rows]));
  assert.deepEqual(snapshot.judgeReplayAges.map((age) => [age.model, age.role, age.stale]),
    [["decisions-eastus", "machine-filing", false], ["decisions-eastus", "risk", true], ["systemone-eastus2", null, true]]);
});

/** Twenty assignments and their attempts: enough for the release and the field note to publish one cell. */
function workerRows(): Row[] {
  return Array.from({ length: 20 }, (_, i) => {
    const id = `asg-worker-${i}`;
    const base = { host: "host-alpha-private", actor: "daemon", task_id: `task-${id}`, run_id: `run-${id}` };
    return [
      { ...base, ts: "2026-10-06T02:00:00.000Z", step: "worker.assignment",
        worker_assignment: { id, requested: { model: "gpt-6.1-sol" }, selected: { provider: "p", model: "gpt-6.1-sol" } },
        benchmark_run: { work: { taskClass: { state: "observed", value: "implement" } } } },
      { ...base, ts: "2026-10-06T03:00:00.000Z", step: "worker.attempt", selection_assignment_id: id, success: true, served_model: "gpt-6.1-sol" },
    ];
  }).flat();
}

/** Twenty filed evidence follow-ups beside the worker rows: their cells put plain words such as "unknown" in the release. */
function learningRows(): Row[] {
  return Array.from({ length: 20 }, (_, i) => ({ ts: "2026-10-06T04:00:00.000Z", step: "evidence_coverage.filed", action: "filed",
    host: "host-alpha-private", actor: "daemon", task_id: `task-evidence-${i}`, run_id: `run-evidence-${i}` }));
}

function snapshotOf(ledger: FieldTrialsLedgerRead): FieldTrialsFlowSnapshot {
  return buildFieldTrialsFlowSnapshot({ asOf: AS_OF, sources: [{ label: "core", repo: REPO, ledger }], github: { version: "field-trials-github-v1", repos: {} } });
}

async function readLedger(rows: Row[]): Promise<FieldTrialsLedgerRead> {
  const fixture = writeLedger(rows);
  try {
    return await readFieldTrialsLedger(fixture.dir, Date.parse(AS_OF));
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

const CONSENT: FieldTrialsConsent = { version: "field-trials-consent-v1", repos: [
  { repo: REPO, rights: "aggregate-opt-in", receipt: "owner-2026-10-27-fixture" }] };

test("W1-T14853 criterion 6: invariant:the-release-is-byte-identical — compared and skipped rows change neither the release nor the field note", async () => {
  const shadowRows = [
    ...await decisionShadow({ hour: 17, head: "c7c7c7c7", primary: "automate", reply: { kind: "distribution", top: "automate" }, latency: 300, cost: 0.0002 }),
    ...await decisionShadow({ hour: 18, head: "d8d8d8d8", primary: "automate", reply: { kind: "abstained" }, latency: 200, cost: 0.0001 }),
    cashCompared(19, "20920@e9e9e9e9", "overlap", "independent"),
    // The risk judge keys a row with no task or pull request as the bare word "unknown" (lib/risk-judge.ts).
    { ts: "2026-10-06T20:00:00.000Z", step: "judge_shadow.compared", role: "risk-judge", decision_key: "unknown", primary_model: "gpt-6-luna",
      primary_provider: null, primary_cost_usd: 0, shadow_effort: "low", shadow_model: "gpt-oss-120b", shadow_cost_usd: 0.0004,
      primary_answer: "low", shadow_answer: "low", agreement: true },
  ];
  const without = snapshotOf(await readLedger([...workerRows(), ...learningRows()]));
  const withRows = snapshotOf(await readLedger([...workerRows(), ...learningRows(), ...shadowRows]));
  const family = JSON.stringify(withRows.families.judges);
  assert.ok(family.includes("decisions-eastus") && family.includes("gpt-oss-120b"), "positive control: the family holds both arms' cells");
  for (const secret of ["c7c7c7c7", "d8d8d8d8", "e9e9e9e9", "20920@e9e9e9e9", "shard-c7c7c7c7"]) {
    assert.equal(family.includes(secret), false, `${secret} is in no cell`);
    assert.equal(JSON.stringify(withRows.judgeReplayAges).includes(secret), false);
  }
  const release = (snapshot: FieldTrialsFlowSnapshot) => buildFieldTrialsRelease(snapshot, CONSENT, "salt-one");
  assert.equal(release(without).state, "candidate", "positive control: the worker rows release a candidate");
  assert.equal(JSON.stringify(release(withRows)), JSON.stringify(release(without)));
  assert.ok(family.includes("risk-judge"), "positive control: the bare-word keyed row is in the family");
  assert.equal(withRows.privateKeys.includes("unknown"), false, "a bare word is never a private join key");
  assert.equal(release({ ...withRows, privateKeys: [...withRows.privateKeys, "unknown"] }).state, "refused",
    "positive control: a bare word taken as a private key would refuse the whole release");
  const note = (snapshot: FieldTrialsFlowSnapshot) => buildModelFieldNoteCandidate({ snapshot, consent: CONSENT, registry: PINNED_SITE_CONSENT_REGISTRY,
    windows: { version: "field-note-windows-v1", windows: [] }, salt: "salt-one", nowIso: "2026-10-20T07:00:00.000Z" });
  assert.equal(note(without).state, "candidate", "positive control: the worker rows write a field-note candidate");
  assert.equal(JSON.stringify(note(withRows)), JSON.stringify(note(without)));
});
