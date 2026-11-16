/**
 * W1-T12425: a typed answer gains an outcome. The measurement cadence writes one
 * verdict_calibration.outcome row per measured head and kind, from the same git read as the verdict
 * calibration report, and the judge calibration reader gives each typed answer its head's outcome
 * through one declared map per role, so a risk distribution gets a Brier and a log-loss figure.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deriveAnalyticsSnapshot, deriveAnalyticsSnapshotFromCheckpointedLedger, type AnalyticsCheckpoint } from "#src/lib/analytics-route.js";
import { fixedClock } from "#src/lib/clock.js";
import { DECISION_ANSWERED_STEP } from "#src/lib/decision-model.js";
import {
  deriveJudgeCalibration,
  emptyJudgeVerdictFold,
  foldJudgeVerdictRow,
  HEAD_SHA_RE,
  headOfDecisionKey,
  judgeCalibrationRow,
  TYPED_ANSWER_OUTCOME_MAP,
  typedAnswersWithOutcomes,
} from "#src/lib/judge-calibration.js";
import { runMeasurementCadenceReport, type MeasurementCadenceReportOpts } from "#src/lib/measurement-cadence.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { scoreTypedAnswers, type TypedAnswerRow, type TypedAnswerScoreGroup } from "#src/lib/typed-answer-scores.js";
import {
  ATTRIBUTION_POLICY,
  recordedVerdictOutcomes,
  VERDICT_OUTCOME_STEP,
  verdictCalibrationReport,
  verdictOutcomeKey,
  verdictOutcomeRows,
  type VerdictOutcomeRow,
  type VerdictRow,
} from "#src/lib/verdict-calibration.js";

type Row = Record<string, unknown>;

const NOW = new Date("2026-11-16T12:00:00.000Z");
const sha = (c: string): string => c.repeat(40).slice(0, 40);
const H = { reverted: sha("a"), fixed: sha("b"), clean: sha("c"), young: sha("d"), unmeasurable: sha("e"), noMerge: sha("f"), late: sha("1") };
const M = { reverted: sha("2"), fixed: sha("3"), clean: sha("4"), young: sha("5"), late: sha("6") };

function dumpOf(commits: Array<{ sha: string; ts: string; subject: string; body?: string; files?: string[] }>): string {
  return commits.map((c) => `\x02${c.sha}\x00${c.ts}\x00${c.subject}\x00${c.body ?? ""}\x01\n${(c.files ?? []).join("\n")}\n`).join("");
}

/** One merge per task: reverted, followed by a fix, clean, too young, and reverted only after the window. */
const DUMP = dumpOf([
  { sha: M.reverted, ts: "2026-10-01T00:00:00Z", subject: "feat: one (W1-T9001)", files: ["src/one.ts"] },
  { sha: sha("7"), ts: "2026-10-03T00:00:00Z", subject: "Revert \"feat: one\"", body: `This reverts commit ${M.reverted}.`, files: ["src/one.ts"] },
  { sha: M.fixed, ts: "2026-10-01T00:00:00Z", subject: "feat: two (W1-T9002)", files: ["src/two.ts"] },
  { sha: sha("8"), ts: "2026-10-05T00:00:00Z", subject: "fix: two again", files: ["src/two.ts"] },
  { sha: M.clean, ts: "2026-10-01T00:00:00Z", subject: "feat: three (W1-T9003)", files: ["src/three.ts"] },
  { sha: M.young, ts: "2026-11-10T00:00:00Z", subject: "feat: four (W1-T9004)", files: ["src/four.ts"] },
  { sha: M.late, ts: "2026-10-01T00:00:00Z", subject: "feat: five (W1-T9007)", files: ["src/five.ts"] },
  { sha: sha("9"), ts: "2026-10-30T00:00:00Z", subject: "Revert \"feat: five\"", body: `This reverts commit ${M.late}.`, files: ["src/five.ts"] },
]);

const VERDICT_ROWS: VerdictRow[] = [
  { taskId: "W1-T9001", headSha: H.reverted, armedTs: "2026-09-30T00:00:00Z", verdictClass: "full-pass" },
  { taskId: "W1-T9002", headSha: H.fixed, armedTs: "2026-09-30T00:00:00Z", verdictClass: "keyword-floor" },
  { taskId: "W1-T9003", headSha: H.clean, armedTs: "2026-09-30T00:00:00Z", verdictClass: "full-pass" },
  { taskId: "W1-T9004", headSha: H.young, armedTs: "2026-11-09T00:00:00Z", verdictClass: "full-pass" },
  { taskId: "W1-T9005", headSha: H.unmeasurable, armedTs: "2026-09-30T00:00:00Z", verdictClass: null, unjoinableCause: "no-review-posted" },
  { taskId: "W1-T9006", headSha: H.noMerge, armedTs: "2026-09-30T00:00:00Z", verdictClass: "full-pass" },
  { taskId: "W1-T9007", headSha: H.late, armedTs: "2026-09-30T00:00:00Z", verdictClass: "degraded-arm" },
];

const outcomeRow = (taskId: string, head: string, merge: string, outcome: VerdictOutcomeRow["outcome"]): VerdictOutcomeRow & Row =>
  ({ step: VERDICT_OUTCOME_STEP, task_id: taskId, head_sha: head, merge_sha: merge, outcome, window_days: ATTRIBUTION_POLICY.windowDays });

test("W1-T12425 criterion 1: each measurable verdict row gives one outcome row: reverted, followup_fixed, or clean once the window has passed", () => {
  const rows = verdictOutcomeRows(VERDICT_ROWS, DUMP, { now: NOW, recorded: new Set() });
  assert.deepEqual(rows, [
    outcomeRow("W1-T9001", H.reverted, M.reverted, "reverted"),
    outcomeRow("W1-T9002", H.fixed, M.fixed, "followup_fixed"),
    outcomeRow("W1-T9003", H.clean, M.clean, "clean"),
    outcomeRow("W1-T9007", H.late, M.late, "clean"),
  ]);
  assert.equal(ATTRIBUTION_POLICY.windowDays, 14);
  assert.ok(!rows.some((r) => r.head_sha === H.young), "a merge younger than the window with neither gives no row");
  assert.ok(!rows.some((r) => r.head_sha === H.unmeasurable || r.head_sha === H.noMerge), "an unmeasurable row gives no row");
  // The rows and the report read the same join.
  const report = verdictCalibrationReport(VERDICT_ROWS, DUMP);
  assert.equal(report.classes.reduce((sum, c) => sum + c.revertedCount, 0), rows.filter((r) => r.outcome === "reverted").length);
  assert.equal(report.classes.reduce((sum, c) => sum + c.followupFixedCount, 0), rows.filter((r) => r.outcome === "followup_fixed").length);
  assert.deepEqual(report.unmeasurable.map((u) => u.taskId).sort(), ["W1-T9005", "W1-T9006"]);
  // The young merge becomes clean only after its window ends.
  const later = verdictOutcomeRows(VERDICT_ROWS, DUMP, { now: new Date("2026-11-25T00:00:01Z"), recorded: new Set() });
  assert.deepEqual(later.find((r) => r.head_sha === H.young), outcomeRow("W1-T9004", H.young, M.young, "clean"));
  const atEnd = verdictOutcomeRows(VERDICT_ROWS, DUMP, { now: new Date("2026-11-24T00:00:00Z"), recorded: new Set() });
  assert.equal(atEnd.find((r) => r.head_sha === H.young), undefined, "at the window's last instant the merge is not yet older than the window");
  assert.deepEqual(verdictOutcomeRows(VERDICT_ROWS, "", { now: NOW, recorded: new Set() }), [], "no git history, no merge, no row");
});

test("W1-T12425 criterion 2: a recorded head and kind gets no second row, and a head with a reverted or followup_fixed row never gets clean", () => {
  const recordedLines = [
    JSON.stringify(outcomeRow("W1-T9001", H.reverted, M.reverted, "reverted")),
    JSON.stringify({ ...outcomeRow("W1-T9003", H.clean, M.clean, "followup_fixed"), run_id: "VERDICT-OUTCOME-1" }),
    JSON.stringify(outcomeRow("W1-T9007", H.late, M.late, "reverted")),
    "{torn",
    JSON.stringify({ step: VERDICT_OUTCOME_STEP, head_sha: H.fixed, outcome: "maybe" }),
  ];
  const recorded = recordedVerdictOutcomes(recordedLines);
  assert.deepEqual([...recorded].sort(), [
    verdictOutcomeKey(H.reverted, "reverted"), verdictOutcomeKey(H.clean, "followup_fixed"), verdictOutcomeKey(H.late, "reverted"),
  ].sort());
  const rows = verdictOutcomeRows(VERDICT_ROWS, DUMP, { now: NOW, recorded });
  assert.deepEqual(rows, [outcomeRow("W1-T9002", H.fixed, M.fixed, "followup_fixed")]);
  // A recorded clean gives no second clean either; every row written once is recorded once.
  const all = verdictOutcomeRows(VERDICT_ROWS, DUMP, { now: NOW, recorded: new Set() });
  const again = verdictOutcomeRows(VERDICT_ROWS, DUMP, { now: NOW, recorded: recordedVerdictOutcomes(all.map((r) => JSON.stringify(r))) });
  assert.deepEqual(again, []);
  // Two verdict rows for one head give one row per kind.
  const twice = verdictOutcomeRows([VERDICT_ROWS[0]!, VERDICT_ROWS[0]!], DUMP, { now: NOW, recorded: new Set() });
  assert.deepEqual(twice, [outcomeRow("W1-T9001", H.reverted, M.reverted, "reverted")]);
});

function ledgerLine(fields: Row): string {
  return JSON.stringify(fields);
}

/** A state dir whose rotated archive holds the armed and review rows of VERDICT_ROWS' measured tasks. */
function cadenceStateDir(root: string, extra: string[] = []): string {
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const lines = VERDICT_ROWS.filter((r) => r.verdictClass !== null).flatMap((r) => [
    ledgerLine({ ts: r.armedTs, step: "automerge.armed", task_id: r.taskId, head_sha: r.headSha }),
    ledgerLine({ ts: r.armedTs, step: "review.posted", task_id: r.taskId, head_sha: r.headSha, capped: r.verdictClass === "degraded-arm",
      floor_degraded: r.verdictClass === "keyword-floor" }),
  ]);
  writeFileSync(join(stateDir, "ledger.2026-10-01T00-00-00-000Z.ndjson"), [...lines, ...extra].join("\n") + "\n");
  writeFileSync(join(stateDir, "ledger.ndjson"), "");
  return stateDir;
}

test("W1-T12425 criterion 3: the measurement cadence writes the outcome rows from its one git read, with or without escalate, and never after a failed git read", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}verdict-outcomes-`));
  try {
    const stateDir = cadenceStateDir(root, [JSON.stringify(outcomeRow("W1-T9001", H.reverted, M.reverted, "reverted"))]);
    const run = (patch: Partial<MeasurementCadenceReportOpts>): { written: Row[]; reads: number } => {
      const written: Row[] = [];
      let reads = 0;
      runMeasurementCadenceReport({ stateDir, cwd: root, escalate: false, registryPath: join(root, "registry.json"), now: NOW,
        gitLog: () => { reads += 1; return { dump: DUMP, ref: "fixture" }; },
        outcomes: { writeLedgerLine: (line) => written.push(line) }, ...patch });
      return { written, reads };
    };
    const expected = [
      outcomeRow("W1-T9002", H.fixed, M.fixed, "followup_fixed"),
      outcomeRow("W1-T9003", H.clean, M.clean, "clean"),
      outcomeRow("W1-T9007", H.late, M.late, "clean"),
    ];
    const plain = run({});
    assert.deepEqual(plain.written, expected, "the recorded reverted row is not written again");
    assert.equal(plain.reads, 1, "the outcome rows and the report share one git read");
    assert.deepEqual(run({ escalate: true }).written, expected, "escalate changes nothing about the outcome rows");
    const failed: Row[] = [];
    runMeasurementCadenceReport({ stateDir, cwd: root, escalate: true, registryPath: join(root, "registry.json"), now: NOW,
      gitLog: () => { throw new Error("shallow clone"); }, outcomes: { writeLedgerLine: (line) => failed.push(line) } });
    assert.deepEqual(failed, [], "a failed git read writes no outcome row");
    const unreadable: Row[] = [];
    runMeasurementCadenceReport({ stateDir, cwd: root, escalate: false, registryPath: join(root, "registry.json"), now: NOW,
      gitLog: () => ({ dump: DUMP, ref: "fixture" }), outcomes: { writeLedgerLine: (line) => unreadable.push(line) },
      ledgerUnion: (dir) => ({ ok: false, stateDir: dir, archiveFiles: [], archiveCount: 0, liveFileRead: false, unread: [], matches: [] }) });
    assert.deepEqual(unreadable, [], "without the recorded rows nothing is written, so no head is written twice");

    // The daemon's cadence call gives the writer: test/measurement-cadence-production-wiring.test.ts (it already imports src/run-task.ts).
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const RISK_QUESTION = (distribution: Array<[string, number]>) =>
  [{ name: "risk", outcome: "distribution", distribution: distribution.map(([option, probability]) => ({ option, probability })) }];

function decisionRow(i: number, patch: Row): Row {
  return { ts: `2026-11-12T10:${String(i).padStart(2, "0")}:00.000Z`, step: DECISION_ANSWERED_STEP, run_id: `decision-${i}`, outcome: "answered",
    role: "risk", candidate: "model-d", answers: RISK_QUESTION([["low", 0.8], ["high", 0.2]]), ...patch };
}

function shadowRow(i: number, surface: string, key: string, primary: unknown, shadow: unknown): Row {
  return { ts: `2026-11-12T11:${String(i).padStart(2, "0")}:00.000Z`, step: "shadow_judge.paired", run_id: `run-${i}`, surface,
    decision_key: key, primary_model: "judge-p", shadow_model: "shadow-x", primary_decision: primary, shadow_decision: shadow };
}

function only(groups: readonly TypedAnswerScoreGroup[], model: string, role = "risk", source = "decisions"): TypedAnswerScoreGroup {
  const found = groups.filter((g) => g.model === model && g.role === role && g.source === source);
  assert.equal(found.length, 1, `one group for ${role} x ${model} x ${source}`);
  return found[0]!;
}

test("W1-T12425 criterion 4: the judge calibration reader keeps the outcome rows and maps a head's outcome through one table per role", () => {
  assert.deepEqual(TYPED_ANSWER_OUTCOME_MAP, { risk: { reverted: "high", followup_fixed: "high", clean: "low" } });
  assert.deepEqual(judgeCalibrationRow({ ...outcomeRow("W1-T9001", H.reverted, M.reverted, "reverted"), ts: "x", run_id: "r" }),
    { step: VERDICT_OUTCOME_STEP, head_sha: H.reverted, outcome: "reverted" }, "the reader keeps the head and the kind");
  // The head comes from the row's head_sha, or from the risk key (task id and head) and the review key (pull request, head, digest).
  assert.equal(headOfDecisionKey("risk", `W1-T9001:${H.reverted}`), H.reverted);
  assert.equal(headOfDecisionKey("review", `https://github.com/o/r/pull/7:${H.clean}:0123abcd`), H.clean);
  assert.equal(headOfDecisionKey("risk", "key-1"), null);
  assert.equal(HEAD_SHA_RE.test(H.reverted), true);
  assert.equal(HEAD_SHA_RE.test("key-1"), false);
  assert.equal(headOfDecisionKey("ci", `W1-T9001:${H.reverted}`), null);

  const fold = emptyJudgeVerdictFold();
  const rows: Row[] = [
    decisionRow(1, { head_sha: H.reverted }),
    decisionRow(2, { decision_key: `W1-T9003:${H.clean}` }),
    shadowRow(3, "risk", `W1-T9002:${H.fixed}`, "low", "low"),
    shadowRow(4, "review", `https://github.com/o/r/pull/7:${H.clean}:0123abcd`, [{ pass: true }], [{ pass: true }]),
    outcomeRow("W1-T9001", H.reverted, M.reverted, "reverted"),
    outcomeRow("W1-T9002", H.fixed, M.fixed, "followup_fixed"),
    outcomeRow("W1-T9003", H.clean, M.clean, "clean"),
  ];
  for (const row of rows) foldJudgeVerdictRow(fold, row);
  const joined = typedAnswersWithOutcomes(fold);
  assert.deepEqual(joined.map((r) => [r.role, r.source, r.head, r.outcome]), [
    ["risk", "decisions", H.reverted, "high"],
    ["risk", "decisions", H.clean, "low"],
    ["risk", "generative", H.fixed, "high"],
    ["review", "generative", H.clean, null],
  ]);
  // The worst kind wins: a head with clean and reverted rows is high.
  foldJudgeVerdictRow(fold, outcomeRow("W1-T9003", H.clean, M.clean, "reverted"));
  assert.equal(typedAnswersWithOutcomes(fold)[1]!.outcome, "high");
});

test("W1-T12425 criterion 5: a risk distribution whose head has an outcome is scored; one with no head, no outcome row or no map entry is unknown", () => {
  const rows: Row[] = [
    decisionRow(1, { head_sha: H.reverted }), // outcome high, p(high) = 0.2
    decisionRow(2, { head_sha: H.clean }), // outcome low, p(low) = 0.8
    decisionRow(3, {}), // no head
    decisionRow(4, { head_sha: H.young }), // no outcome row
    decisionRow(5, { head_sha: H.reverted, role: "ci" }), // no map entry
    shadowRow(6, "risk", `W1-T9004:${H.young}`, "high", "high"), // the current judge said high; never the outcome
    outcomeRow("W1-T9001", H.reverted, M.reverted, "reverted"),
    outcomeRow("W1-T9003", H.clean, M.clean, "clean"),
  ];
  const calibration = deriveJudgeCalibration(rows, { asOf: NOW.toISOString(), labels: { labels: [] } });
  const risk = only(calibration.typedAnswerScores.groups, "model-d");
  assert.deepEqual(risk.outcomes, { scored: 2, unknown: 2, notDeclared: 0 });
  const brier = ((0.8 - 0) ** 2 + (0.2 - 1) ** 2 + (0.8 - 1) ** 2 + (0.2 - 0) ** 2) / 2;
  assert.ok(risk.brier !== null && Math.abs(risk.brier - brier) < 1e-12, `brier ${risk.brier}`);
  assert.ok(risk.logLoss !== null && Math.abs(risk.logLoss - (-Math.log(0.2) - Math.log(0.8)) / 2) < 1e-12, `log-loss ${risk.logLoss}`);
  const ci = only(calibration.typedAnswerScores.groups, "model-d", "ci");
  assert.deepEqual(ci.outcomes, { scored: 0, unknown: 1, notDeclared: 0 });
  assert.equal(ci.brier, null);
  // A typed answer with the current judge's answer and no outcome row keeps a null outcome.
  const withIncumbent: TypedAnswerRow = { role: "risk", question: "risk", model: "model-e", source: "decisions", modelSurface: "decisions", questionType: "choice",
    options: ["low", "high"], inputDigest: null, head: H.young, incumbent: "high", outcome: null,
    answer: { kind: "distribution", distribution: [{ option: "low", probability: 0.3 }, { option: "high", probability: 0.7 }] } };
  const joined = typedAnswersWithOutcomes({ typedAnswers: [withIncumbent], outcomes: new Map() });
  assert.equal(joined[0]!.outcome, null, "the current judge's answer is never the outcome");
  const scored = only(scoreTypedAnswers(joined).groups, "model-e");
  assert.deepEqual(scored.outcomes, { scored: 0, unknown: 1, notDeclared: 0 });
  assert.equal(scored.brier, null);
});

test("W1-T12425 criterion 6: the analytics checkpoint fold keeps the outcome rows, so the analytics body and a host fold give the same scores", async () => {
  const answers: Row[] = [decisionRow(1, { head_sha: H.reverted }), decisionRow(2, { head_sha: H.clean }), decisionRow(3, { head_sha: H.fixed })];
  const outcomes: Row[] = [
    { ts: "2026-11-13T00:00:00.000Z", run_id: "VERDICT-OUTCOME-1", lane: "measurement-cadence", ...outcomeRow("W1-T9001", H.reverted, M.reverted, "reverted") },
    { ts: "2026-11-13T00:00:01.000Z", run_id: "VERDICT-OUTCOME-1", lane: "measurement-cadence", ...outcomeRow("W1-T9003", H.clean, M.clean, "clean") },
    { ts: "2026-11-13T00:00:02.000Z", run_id: "VERDICT-OUTCOME-2", lane: "measurement-cadence", ...outcomeRow("W1-T9002", H.fixed, M.fixed, "followup_fixed") },
  ];
  const rows = [...answers, ...outcomes];
  const host = deriveJudgeCalibration(rows, { asOf: NOW.toISOString(), labels: { labels: [] } }).typedAnswerScores;
  assert.deepEqual(only(host.groups, "model-d").outcomes, { scored: 3, unknown: 0, notDeclared: 0 }, "positive control: the host fold scores");
  const body = deriveAnalyticsSnapshot(rows, NOW.toISOString(), { judgeLabels: { labels: [] } }).judgeCalibration?.typedAnswerScores;
  assert.deepEqual(body, host, "the analytics body gives the host's scores");

  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}typed-answer-outcomes-`));
  try {
    const live = join(dir, "ledger.ndjson");
    const ndjson = (part: readonly Row[]): string => part.map((r) => JSON.stringify(r)).join("\n") + "\n";
    // The answers and the first outcome land before the checkpoint; the rest after it.
    writeFileSync(live, ndjson(rows.slice(0, 4)));
    const clock = fixedClock(NOW.getTime());
    const options = { judgeLabels: { labels: [] } };
    const first = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock, undefined, undefined, options);
    const prior = JSON.parse(JSON.stringify(first.checkpoint)) as AnalyticsCheckpoint;
    appendFileSync(live, ndjson(rows.slice(4)));
    const resumed = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock, undefined, prior, options);
    assert.equal(resumed.scan?.mode, "resume", `positive control: the fold resumed (refused: ${resumed.scan?.reason})`);
    assert.deepEqual(resumed.snapshot.judgeCalibration?.typedAnswerScores, host, "a resumed checkpoint gives the host's scores");
    const scratch = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock, undefined, undefined, options);
    assert.deepEqual(scratch.snapshot.judgeCalibration?.typedAnswerScores, host, "a scratch fold gives the host's scores");
    const older = JSON.parse(JSON.stringify(first.checkpoint)) as AnalyticsCheckpoint;
    delete (older.state.judgeCalibrationFold as Row).outcomes;
    const rescanned = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock, undefined, older, options);
    assert.notEqual(rescanned.scan?.mode, "resume", "a checkpoint from before the outcomes forces a full scan");
    assert.deepEqual(rescanned.snapshot.judgeCalibration?.typedAnswerScores, host);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
