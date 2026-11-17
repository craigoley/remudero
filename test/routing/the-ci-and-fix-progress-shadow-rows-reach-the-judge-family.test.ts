/**
 * W1-T13365 — the ci-judge and fix-progress shadow rows reach judge calibration and the field-trials judge family.
 *
 * The rows are written by the real runJudgeShadow, through the two production judges, with an injected spawn: no
 * network and no paid call runs. One table of compared keys serves the writer and the readers.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CI_JUDGE_HEADS_FILE, judgeCiEscalation, productionCiJudgePorts } from "#src/lib/ci-escalation-judge.js";
import { buildModelFieldNoteCandidate, PINNED_SITE_CONSENT_REGISTRY } from "#src/lib/field-trials-field-note.js";
import { buildFieldTrialsFlowSnapshot, buildFieldTrialsRelease, periodOf, projectFlowRow, readFieldTrialsLedger, type FieldTrialsConsent,
  type FieldTrialsFlowSnapshot, type FieldTrialsLedgerRead } from "#src/lib/field-trials-flow.js";
import { judgeTrialCells, judgeTrialRows, type JudgeTrialCell } from "#src/lib/field-trials-judges.js";
import { buildFixProgressInput } from "#src/lib/fix-progress-judge.js";
import { emptyJudgeVerdictFold, foldJudgeVerdictRow, judgeCalibrationRow } from "#src/lib/judge-calibration.js";
import { mountsPath } from "#src/lib/mounts.js";
import { JUDGE_SHADOW_COMPARED_KEY } from "#src/lib/risk-judge.js";
import { productionFixProgressJudge } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { scoreTypedAnswers, type TypedAnswerRow } from "#src/lib/typed-answer-scores.js";
import { JUDGE_SHADOW_TRIAL_ID, type SpawnWorkerArgs, type WorkerResult } from "#src/lib/worker.js";
import { OpenWeightRequestTooLargeError } from "#src/lib/worker-provider.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Row = Record<string, unknown>;
type Shadow = (args: SpawnWorkerArgs) => Promise<WorkerResult>;

const DEEPSEEK = "DeepSeek-V4-Flash";
// 2026-10-05 is a Monday: the ISO week every shadow row falls in.
const WEEK = "2026-10-05";
const AS_OF = "2026-10-20T06:00:00.000Z";
const REPO = "craigoley/remudero";
const KNOWN = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"];
const JUDGE_ROWS = `
ci_judge: { model: haiku, effort: low, max_turns: 400, context_budget: 60000, shadow: { deployment: ${DEEPSEEK} } }
fix_progress_judge: { model: haiku, effort: low, max_turns: 400, context_budget: 60000, shadow: { deployment: ${DEEPSEEK} } }
`;

/** A root whose mounts file is the real one with a shadow arm on both judges' rows. */
function shadowedRoot(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}shadow-family-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".remudero"), { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });
  const real = readFileSync(mountsPath(REPO_ROOT), "utf8").replace(/^(?:ci_judge|fix_progress_judge):.*\n(?:[ \t]+.*\n)*/gm, "");
  writeFileSync(mountsPath(dir), `${real}\n${JUDGE_ROWS}`);
  return dir;
}

const worker = (text: string, costUsd: number, extra: Partial<WorkerResult> = {}): WorkerResult =>
  ({ sessionId: "s", costUsd, numTurns: 1, text, routedModel: DEEPSEEK, ...extra }) as unknown as WorkerResult;
const isShadow = (args: SpawnWorkerArgs) => args.routingTrial?.id === JUDGE_SHADOW_TRIAL_ID;

/** The ledger rows one judgement wrote, each stamped as the instance ledger stamps a row. */
function stampedRowsAt(hour: number) {
  const rows: Row[] = [];
  return { rows, log: (step: string, extra: Record<string, unknown> = {}) =>
    void rows.push({ ts: `2026-10-06T${String(hour).padStart(2, "0")}:00:00.000Z`, step, run_id: `shadow-run-${hour}`, ...extra }) };
}

const shadowRowOf = (rows: Row[]): Row => {
  const found = rows.filter((row) => String(row.step).startsWith("judge_shadow."));
  assert.equal(found.length, 1);
  return found[0]!;
};

async function ciRow(root: string, o: { hour: number; pr: number; head: string; primary: string; shadow: Shadow; suiteIds?: () => Promise<string[]> }): Promise<Row> {
  const ledger = stampedRowsAt(o.hour);
  rmSync(join(root, "state", CI_JUDGE_HEADS_FILE), { force: true });
  await judgeCiEscalation(productionCiJudgePorts({
    owner: "o", repo: "r", repoRoot: root, stateDir: join(root, "state"), log: ledger.log,
    ghJson: async () => [{ number: o.pr, head: { sha: o.head } }],
    ghText: async (args) => (args.includes("--name-only") ? "src/a.ts\n" : "diff text"),
    suiteIds: o.suiteIds ?? (() => KNOWN),
    floor: () => ({ suites: ["test/a.test.ts"], fullRun: false }),
    spawn: async (args) => (isShadow(args) ? o.shadow(args) : worker(o.primary, 0.01)),
  }));
  return shadowRowOf(ledger.rows);
}

async function fixRow(root: string, o: { hour: number; pr: number; head: string; primary: string; shadow: Shadow }): Promise<Row> {
  const ledger = stampedRowsAt(o.hour);
  const judge = productionFixProgressJudge({ cwd: root, settingsFile: join(root, "settings", "worker.json"), log: ledger.log,
    spawn: async (args) => (isShadow(args) ? o.shadow(args) : worker(o.primary, 0.01)) });
  await judge(buildFixProgressInput({ taskId: "W1-T1", prNumber: o.pr, headSha: o.head, currentRed: ["ci"], ledger: [] }));
  return shadowRowOf(ledger.rows);
}

const CI_PRIMARY = '{"add":["test/b.test.ts","test/c.test.ts"],"escalateFull":false,"reason":"b and c read a"}';
const CI_KEY = '{"add":["test/b.test.ts","test/c.test.ts"],"escalateFull":false}';
const FIX_PRIMARY = 'FIX_PROGRESS: {"verdict":"continue","reason":"the red shrank"}';
const HEADS = { ciAgree: "a1a1a1a1", ciDisagree: "b2b2b2b2", ciGarbled: "c3c3c3c3", ciRefused: "d4d4d4d4",
  fixAgree: "e5e5e5e5", fixDisagree: "f6f6f6f6", fixThrown: "a7a7a7a7", fixRefused: "b8b8b8b8", fixNoPrimary: "c9c9c9c9" } as const;

/** Every judge_shadow row of the fixture, written by the two production judges. */
async function shadowRows(root: string) {
  return {
    // The same suites in another order, and another reason: the compared key is equal.
    ciAgree: await ciRow(root, { hour: 1, pr: 11, head: HEADS.ciAgree, primary: CI_PRIMARY,
      shadow: async () => worker('{"add":["test/c.test.ts","test/b.test.ts"],"escalateFull":false,"reason":"another reason"}', 0.0001) }),
    ciDisagree: await ciRow(root, { hour: 2, pr: 12, head: HEADS.ciDisagree, primary: CI_PRIMARY,
      shadow: async () => worker('{"add":[],"escalateFull":true,"reason":"too wide"}', 0.0003) }),
    ciGarbled: await ciRow(root, { hour: 3, pr: 13, head: HEADS.ciGarbled, primary: CI_PRIMARY, shadow: async () => worker("no json here", 0.0002) }),
    ciRefused: await ciRow(root, { hour: 4, pr: 14, head: HEADS.ciRefused, primary: CI_PRIMARY,
      shadow: async () => worker("", 0, { isError: true, budgetRefused: true, cashAllowanceLimit: "fleet" } as Partial<WorkerResult>) }),
    fixAgree: await fixRow(root, { hour: 5, pr: 21, head: HEADS.fixAgree, primary: FIX_PRIMARY,
      shadow: async () => worker('FIX_PROGRESS: {"verdict":"continue","reason":"other words"}', 0.0004) }),
    fixDisagree: await fixRow(root, { hour: 6, pr: 22, head: HEADS.fixDisagree, primary: FIX_PRIMARY,
      shadow: async () => worker('FIX_PROGRESS: {"verdict":"escalate","reason":"loop","loop":"oscillation"}', 0.0006) }),
    fixThrown: await fixRow(root, { hour: 7, pr: 23, head: HEADS.fixThrown, primary: FIX_PRIMARY, shadow: async () => { throw new Error("endpoint reset"); } }),
    fixRefused: await fixRow(root, { hour: 8, pr: 24, head: HEADS.fixRefused, primary: FIX_PRIMARY,
      shadow: async () => { throw new OpenWeightRequestTooLargeError({ estimatedTokens: 30_000, capability: "economy", considered: [DEEPSEEK] }); } }),
    // The primary gave no verdict: the shadow's answer has no incumbent.
    fixNoPrimary: await fixRow(root, { hour: 9, pr: 25, head: HEADS.fixNoPrimary, primary: "no verdict here",
      shadow: async () => worker('FIX_PROGRESS: {"verdict":"continue","reason":"fine"}', 0.0005) }),
  };
}

const digestOf = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);
const typedOf = (row: Row): TypedAnswerRow[] => (judgeCalibrationRow(row)?.typed_answers ?? []) as TypedAnswerRow[];
const answerOf = (row: Row): TypedAnswerRow => {
  const typed = typedOf(row);
  assert.equal(typed.length, 1);
  return typed[0]!;
};
const expected = (role: string, key: string, head: string, answer: TypedAnswerRow["answer"], incumbent: string | null): TypedAnswerRow => ({
  role, model: DEEPSEEK, source: "generative", modelSurface: "text", head, inputDigest: digestOf(key), question: null, questionType: null,
  options: null, answer, incumbent, outcome: null });

test("W1-T13365 criterion 1: a judge_shadow.paired row reads as one typed answer of its surface and deployment, and a shadow_judge.paired row reads as before", async (t) => {
  const rows = await shadowRows(shadowedRoot(t));
  assert.deepEqual([rows.ciDisagree.step, rows.fixDisagree.step], ["judge_shadow.paired", "judge_shadow.paired"]);
  const ci = expected("ci-judge", `PR12@${HEADS.ciDisagree}`, HEADS.ciDisagree, { kind: "single", option: '{"add":[],"escalateFull":true}' }, CI_KEY);
  const fix = expected("fix-progress", `PR22@${HEADS.fixDisagree}`, HEADS.fixDisagree, { kind: "single", option: "escalate" }, "continue");
  assert.deepEqual(answerOf(rows.ciDisagree), ci);
  assert.deepEqual(answerOf(rows.fixDisagree), fix);
  assert.equal(rows.fixNoPrimary.primary_verdict, null);
  assert.deepEqual(answerOf(rows.fixNoPrimary),
    expected("fix-progress", `PR25@${HEADS.fixNoPrimary}`, HEADS.fixNoPrimary, { kind: "single", option: "continue" }, null));
  // A paired row whose shadow verdict the table cannot read is a rejected answer, never a dropped row.
  assert.deepEqual(answerOf({ ...rows.fixDisagree, shadow_verdict: { other: 1 } }).answer, { kind: "rejected", reason: "the shadow verdict has no compared key" });
  // A decision key with no head after an `@` gives no head.
  assert.equal(answerOf({ ...rows.fixDisagree, decision_key: "unknown" }).head, null);
  assert.equal(answerOf({ ...rows.fixDisagree, decision_key: "PR22@not-a-head" }).head, null);
  // A row that names no surface or no deployment is not read.
  assert.equal(judgeCalibrationRow({ ...rows.fixDisagree, shadow_deployment: undefined }), undefined);
  // The fold reads the raw row and the row judgeCalibrationRow kept the same way.
  const fold = emptyJudgeVerdictFold();
  foldJudgeVerdictRow(fold, rows.ciDisagree);
  foldJudgeVerdictRow(fold, judgeCalibrationRow(rows.fixDisagree)!);
  assert.deepEqual(fold.typedAnswers, [ci, fix]);

  // The older step keeps its name and its reading.
  const older: Row = { ts: "2026-10-06T10:00:00.000Z", step: "shadow_judge.paired", surface: "risk", decision_key: "W1-T900:0123abcdef0123abcdef",
    primary_model: "claude-opus-5-5", primary_decision: "low", shadow_model: "decision-1", shadow_decision: "high", agreement: false };
  assert.deepEqual(judgeCalibrationRow(older), { step: "shadow_judge.paired", typed_answers: [{ role: "risk", question: null, model: "decision-1",
    source: "generative", modelSurface: "text", questionType: null, options: null, head: "0123abcdef0123abcdef",
    inputDigest: digestOf("W1-T900:0123abcdef0123abcdef"), answer: { kind: "single", option: "high" }, incumbent: "low", outcome: null }] });
  assert.equal(judgeCalibrationRow(rows.ciDisagree)!.step, "judge_shadow.paired");
});

test("W1-T13365 criterion 2: invariant:one-compared-key — the scorer's agreement for a row equals the row's own agreement field", async (t) => {
  const rows = await shadowRows(shadowedRoot(t));
  const cases: Array<[string, Row, boolean]> = [["ci agree", rows.ciAgree, true], ["ci disagree", rows.ciDisagree, false],
    ["fix agree", rows.fixAgree, true], ["fix disagree", rows.fixDisagree, false]];
  for (const [name, row, agrees] of cases) {
    assert.equal(row.step, "judge_shadow.paired", name);
    assert.equal(row.agreement, agrees, name);
    assert.deepEqual(scoreTypedAnswers([answerOf(row)]).groups[0]!.agreement, { compared: 1, agreed: agrees ? 1 : 0, rate: agrees ? 1 : 0 }, name);
  }
  // Two ci verdicts that differ only in `reason` or in the order of `add` agree; two fix-progress verdicts that differ only in `reason` agree.
  const ci = JUDGE_SHADOW_COMPARED_KEY["ci-judge"];
  assert.equal(ci({ add: ["b", "a"], escalateFull: false, reason: "one" }), ci({ add: ["a", "b"], escalateFull: false, reason: "two" }));
  assert.notEqual(ci({ add: ["a"], escalateFull: false }), ci({ add: ["a"], escalateFull: true }));
  const fix = JUDGE_SHADOW_COMPARED_KEY["fix-progress"];
  assert.equal(fix({ verdict: "continue", reason: "one" }), fix({ verdict: "continue", reason: "two" }));
  assert.deepEqual([ci(null), ci("text"), ci({ add: "a", escalateFull: false }), fix(undefined), fix({ verdict: 1 })], [undefined, undefined, undefined, undefined, undefined]);
});

function projected(rows: Row[]): FieldTrialsLedgerRead {
  return { state: "observed", reason: null, forms: { gzip: 0, plain: 0, live: 1 }, malformedRows: 0, duplicateRows: 0, futureRows: 0,
    unreadSources: 0, newestTs: null, rows: rows.map((row, i) => projectFlowRow(row, `fp-${i}`)) };
}
const cellsOfRows = (rows: Row[]): JudgeTrialCell[] => judgeTrialCells(judgeTrialRows("core", projected(rows).rows).rows, periodOf);
const CI_CELL = `core|${WEEK}|live|ci-judge|${DEEPSEEK}|text|-`;
const FIX_CELL = `core|${WEEK}|live|fix-progress|${DEEPSEEK}|text|-`;

test("W1-T13365 criterion 3: invariant:no-answer-is-never-wrong — an unavailable shadow is a rejected answer and a refused shadow is no answer, counted apart", async (t) => {
  const rows = await shadowRows(shadowedRoot(t));
  assert.deepEqual([rows.ciGarbled.step, rows.fixThrown.step, rows.ciRefused.step, rows.fixRefused.step],
    ["judge_shadow.unavailable", "judge_shadow.unavailable", "judge_shadow.refused", "judge_shadow.refused"]);
  assert.deepEqual(answerOf(rows.ciGarbled), expected("ci-judge", `PR13@${HEADS.ciGarbled}`, HEADS.ciGarbled,
    { kind: "rejected", reason: "unparseable shadow verdict" }, CI_KEY));
  assert.deepEqual(answerOf(rows.fixThrown).answer, { kind: "rejected", reason: "endpoint reset" });
  // The ci judge's own unavailable row (no suite list, so no shadow call) names its deployment and is read the same way.
  let reads = 0;
  const noSuites = await ciRow(shadowedRoot(t), { hour: 10, pr: 15, head: "d0d0d0d0", primary: CI_PRIMARY, shadow: async () => assert.fail("no shadow is asked"),
    suiteIds: async () => { if (++reads === 1) throw new Error("git ls-files exploded"); return KNOWN; } });
  assert.deepEqual([noSuites.step, noSuites.shadow_deployment], ["judge_shadow.unavailable", DEEPSEEK]);
  assert.deepEqual(answerOf(noSuites), { role: "ci-judge", model: DEEPSEEK, source: "generative", modelSurface: "text", head: null, inputDigest: null,
    question: null, questionType: null, options: null, answer: { kind: "rejected", reason: "suite list unreadable: git ls-files exploded" },
    incumbent: null, outcome: null });
  assert.equal(judgeCalibrationRow(rows.ciRefused), undefined);
  assert.equal(judgeCalibrationRow(rows.fixRefused), undefined);

  const paired = cellsOfRows([rows.ciAgree, rows.ciDisagree]);
  const all = cellsOfRows([rows.ciAgree, rows.ciDisagree, rows.ciGarbled, rows.ciRefused]);
  assert.equal(paired.length, 1);
  assert.equal(all.length, 1);
  const figures = (cell: JudgeTrialCell) => ({ agreement: cell.agreement, brier: cell.brier, logLoss: cell.logLoss });
  assert.deepEqual(figures(all[0]!), figures(paired[0]!));
  assert.deepEqual(figures(all[0]!), { agreement: { compared: 2, agreed: 1, rate: 0.5 }, brier: null, logLoss: null });
  assert.deepEqual([all[0]!.decisions, all[0]!.answers, all[0]!.singles, all[0]!.rejected, all[0]!.refused], [3, 3, 2, 1, 1]);
  assert.deepEqual([paired[0]!.decisions, paired[0]!.rejected, paired[0]!.refused], [2, 0, 0]);

  // A cell of only refused rows still appears, with 0 answers.
  const refusedOnly = cellsOfRows([rows.fixRefused, rows.fixRefused]);
  assert.equal(refusedOnly.length, 1);
  const cell = refusedOnly[0]!;
  assert.deepEqual([cell.role, cell.model, cell.modelSurface, cell.basis, cell.decisions, cell.answers, cell.refused],
    ["fix-progress", DEEPSEEK, "text", "live", 0, 0, 2]);
  assert.deepEqual(figures(cell), { agreement: { compared: 0, agreed: 0, rate: null }, brier: null, logLoss: null });
  assert.deepEqual([cell.settledUsd, cell.questions], [{ observed: 0, median: null }, []]);
  // A row of another step is never counted as refused.
  for (const other of cellsOfRows([{ ts: "2026-10-06T10:00:00.000Z", step: "shadow_judge.paired", surface: "risk", decision_key: "W1-T900:0123abcdef0123abcdef",
    primary_decision: "low", shadow_model: "decision-1", shadow_decision: "low" }])) assert.equal(other.refused, 0);
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

function snapshotOf(ledger: FieldTrialsLedgerRead): FieldTrialsFlowSnapshot {
  return buildFieldTrialsFlowSnapshot({ asOf: AS_OF, sources: [{ label: "core", repo: REPO, ledger }], github: { version: "field-trials-github-v1", repos: {} } });
}

/** The production read: a ledger on disk, through readFieldTrialsLedger. */
async function readLedger(rows: Row[]): Promise<FieldTrialsLedgerRead> {
  const fixture = writeLedger(rows);
  try {
    return await readFieldTrialsLedger(fixture.dir, Date.parse(AS_OF));
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

test("W1-T13365 criterion 4: the snapshot's judge family has a live cell per surface and shadow deployment, with dollars from cost_usd and no latency", async (t) => {
  const rows = Object.values(await shadowRows(shadowedRoot(t)));
  const without = snapshotOf(await readLedger(workerRows()));
  const ledger = await readLedger([...workerRows(), ...rows]);
  assert.equal(ledger.rows.filter((row) => row.judge !== undefined).length, rows.length, "the snapshot reads all three judge_shadow steps");
  const withRows = snapshotOf(ledger);
  assert.deepEqual(Object.keys(without.families.judges), []);
  assert.deepEqual(Object.keys(withRows.families.judges).sort(), [CI_CELL, FIX_CELL].sort());
  const ci = withRows.families.judges[CI_CELL]!.cells;
  assert.deepEqual({ source: ci.source, period: ci.period, basis: ci.basis, role: ci.role, model: ci.model, modelSurface: ci.modelSurface, corpusDigest: ci.corpusDigest },
    { source: "core", period: WEEK, basis: "live", role: "ci-judge", model: DEEPSEEK, modelSurface: "text", corpusDigest: null });
  // Shadow dollars 0.0001, 0.0003 and 0.0002 (the unreadable answer was still paid for); the refused call has none.
  assert.deepEqual(ci.settledUsd, { observed: 3, median: 0.0002 });
  assert.deepEqual(ci.latencyMs, { observed: 0, median: null, p90: null });
  assert.deepEqual([ci.decisions, ci.answers, ci.refused, ci.agreement], [3, 3, 1, { compared: 2, agreed: 1, rate: 0.5 }]);
  const fix = withRows.families.judges[FIX_CELL]!.cells;
  // Paired dollars 0.0004, 0.0006 and 0.0005; the thrown call records none.
  assert.deepEqual(fix.settledUsd, { observed: 3, median: 0.0005 });
  assert.deepEqual([fix.decisions, fix.answers, fix.rejected, fix.refused, fix.agreement], [4, 4, 1, 1, { compared: 2, agreed: 1, rate: 0.5 }]);
  const others = (snapshot: FieldTrialsFlowSnapshot) => {
    const { judges, ...families } = snapshot.families;
    void judges;
    return { families, servedTrialCohorts: snapshot.servedTrialCohorts, assignmentTelemetry: snapshot.assignmentTelemetry, links: snapshot.links };
  };
  assert.ok(Object.keys(without.families.adoption).length > 0 && Object.keys(without.families.funnel).length > 0);
  assert.deepEqual(others(withRows), others(without), "the adoption, funnel, repair, flow, learning, guardrail and served-cohort figures are the same");
});

const CONSENT: FieldTrialsConsent = { version: "field-trials-consent-v1", repos: [
  { repo: REPO, rights: "aggregate-opt-in", receipt: "owner-2026-10-27-fixture" }] };

test("W1-T13365 criterion 5: invariant:the-release-is-byte-identical — the release and the field note do not change, and every key of the rows is private", async (t) => {
  const rows = await shadowRows(shadowedRoot(t));
  const without = snapshotOf(await readLedger(workerRows()));
  const withRows = snapshotOf(await readLedger([...workerRows(), ...Object.values(rows)]));
  const family = JSON.stringify(withRows.families.judges);
  assert.ok(family.includes(DEEPSEEK) && family.includes("ci-judge"), "positive control: the family text holds the cells");
  const keys = [["PR11", HEADS.ciAgree], ["PR12", HEADS.ciDisagree], ["PR13", HEADS.ciGarbled], ["PR14", HEADS.ciRefused], ["PR21", HEADS.fixAgree],
    ["PR22", HEADS.fixDisagree], ["PR23", HEADS.fixThrown], ["PR24", HEADS.fixRefused], ["PR25", HEADS.fixNoPrimary]].map(([pr, head]) => `${pr}@${head}`);
  for (const key of keys) {
    for (const secret of [key, key.split("@")[1]!, digestOf(key)]) {
      assert.equal(family.includes(secret), false, `${secret} is in no cell`);
      assert.ok(withRows.privateKeys.includes(secret), `${secret} is a private key`);
      assert.equal(without.privateKeys.includes(secret), false);
    }
  }
  const release = (snapshot: FieldTrialsFlowSnapshot) => buildFieldTrialsRelease(snapshot, CONSENT, "salt-one");
  assert.equal(release(without).state, "candidate", "positive control: the worker rows release a candidate");
  assert.equal(JSON.stringify(release(withRows)), JSON.stringify(release(without)));
  const note = (snapshot: FieldTrialsFlowSnapshot) => buildModelFieldNoteCandidate({ snapshot, consent: CONSENT, registry: PINNED_SITE_CONSENT_REGISTRY,
    windows: { version: "field-note-windows-v1", windows: [] }, salt: "salt-one", nowIso: "2026-10-20T07:00:00.000Z" });
  assert.equal(note(without).state, "candidate", "positive control: the worker rows write a field-note candidate");
  assert.equal(JSON.stringify(note(withRows)), JSON.stringify(note(without)));
  for (const text of [JSON.stringify(release(withRows)), JSON.stringify(note(withRows))]) {
    for (const judged of [DEEPSEEK, "ci-judge", "fix-progress"]) assert.equal(text.includes(judged), false, judged);
  }
});
