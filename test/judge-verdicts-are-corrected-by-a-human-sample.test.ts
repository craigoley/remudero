/**
 * W1-T4628 — the judges that grade field-trial outcomes are themselves ungraded. A small
 * operator-labelled random sample yields judge agreement and prediction-powered (PPI)
 * bias-corrected pass rates with valid intervals; unlabelled strata read as unknown.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildAnalyticsRoute,
  deriveAnalyticsSnapshot,
  deriveAnalyticsSnapshotFromCheckpointedLedger,
  deriveAnalyticsSnapshotFromLedger,
  readAnalyticsCheckpoint,
  writeAnalyticsCheckpoint,
} from "../src/lib/analytics-route.js";
import { fixedClock } from "../src/lib/clock.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  cohensKappa,
  deriveJudgeCalibration,
  drawJudgeSample,
  extractJudgeVerdicts,
  fileJudgeLabelStore,
  JUDGE_CALIBRATION_VERSION,
  JUDGE_INTERVAL_Z,
  JUDGE_LABELS_FILENAME,
  JUDGE_SAMPLE_PER_STRATUM,
  JUDGE_VERDICT_REF_RE,
  judgeCalibrationRow,
  loadJudgeLabels,
  MIN_PAIRED_OBSERVATIONS,
  ppiEstimate,
  recordJudgeLabel,
  type JudgeCalibration,
  type JudgeLabel,
  type JudgeLabelStore,
  type JudgeVerdict,
} from "../src/lib/judge-calibration.js";

const NOW = "2026-09-27T12:00:00.000Z";
const TASK = "W1-T9999";
type Row = Record<string, unknown>;

/** Hand-built pairs: judge pass & human pass 4, judge pass & human fail 2, judge fail & human pass 1,
 *  both fail 3. p_o = 0.7; p_e = 0.6 * 0.5 + 0.4 * 0.5 = 0.5; kappa = 0.2 / 0.5 = 0.4. */
const PAIRS = [
  ...Array.from({ length: 4 }, () => ({ judge: true, human: true })),
  ...Array.from({ length: 2 }, () => ({ judge: true, human: false })),
  { judge: false, human: true },
  ...Array.from({ length: 3 }, () => ({ judge: false, human: false })),
];
/** 20 unlabelled judge verdicts, 14 pass: mean 0.7. */
const UNLABELLED = [...Array.from({ length: 14 }, () => true), ...Array.from({ length: 6 }, () => false)];
/** theta = 0.7 + (-2 + 1) / 10 = 0.6. var(f) = (14 * 0.09 + 6 * 0.49) / 19 = 4.2 / 19 over N = 20;
 *  var(h - f) = (2 * 0.81 + 1.21 + 7 * 0.01) / 9 = 2.9 / 9 over n = 10. */
const HAND_SE = Math.sqrt(4.2 / 19 / 20 + 2.9 / 9 / 10);

test("Cohen's kappa matches the hand computation, and names the cases it cannot compute", () => {
  const kappa = cohensKappa(PAIRS.map((p) => [p.judge, p.human] as const));
  assert.equal(kappa.state, "estimated");
  assert.ok(kappa.state === "estimated");
  assert.ok(Math.abs(kappa.kappa - 0.4) < 1e-12, `kappa ${kappa.kappa}`);
  assert.ok(Math.abs(kappa.observedAgreement - 0.7) < 1e-12);
  assert.equal(kappa.count, 10);

  assert.deepEqual(cohensKappa([]), { state: "unknown", reason: "no-paired-observations", count: 0 });
  assert.equal((cohensKappa(PAIRS.slice(0, 3).map((p) => [p.judge, p.human] as const)) as { reason: string }).reason, "too-few-paired-observations (3 of 10)");
  const constant = cohensKappa(Array.from({ length: 10 }, () => [true, true] as const));
  assert.equal(constant.state, "unknown", "chance agreement of 1 leaves kappa undefined, never 0 or 1");
});

test("the PPI estimate and its CLT interval match the hand computation", () => {
  const estimate = ppiEstimate(PAIRS, UNLABELLED);
  assert.equal(estimate.state, "estimated");
  assert.ok(estimate.state === "estimated");
  assert.ok(Math.abs(estimate.estimate - 0.6) < 1e-12, `theta ${estimate.estimate}`);
  assert.ok(Math.abs(estimate.standardError - HAND_SE) < 1e-12);
  assert.ok(Math.abs(estimate.lower - (0.6 - JUDGE_INTERVAL_Z * HAND_SE)) < 1e-12);
  assert.equal(estimate.upper, 1, "0.6 + 1.96 * 0.208 exceeds 1 and is clamped");
  assert.equal(estimate.labelled, 10);
  assert.equal(estimate.unlabelled, 20);

  // Every verdict labelled: the human mean, variance var(h) / n = (10 * 0.25 / 9) / 10.
  const full = ppiEstimate(PAIRS, []);
  assert.ok(full.state === "estimated");
  assert.ok(Math.abs(full.estimate - 0.5) < 1e-12);
  assert.ok(Math.abs(full.standardError - Math.sqrt(2.5 / 9 / 10)) < 1e-12);

  // One unlabelled verdict: its variance term is 0, only the rectifier's remains.
  const single = ppiEstimate(PAIRS, [true]);
  assert.ok(single.state === "estimated");
  assert.ok(Math.abs(single.estimate - 0.9) < 1e-12);
  assert.ok(Math.abs(single.standardError - Math.sqrt(2.9 / 9 / 10)) < 1e-12);
});

test("unlabelled or thinly labelled strata read as unknown, never zero and never the raw rate", () => {
  assert.deepEqual(ppiEstimate([], UNLABELLED), { state: "unknown", reason: "unlabelled", labelled: 0 });
  assert.deepEqual(ppiEstimate(PAIRS.slice(0, 3), UNLABELLED), { state: "unknown", reason: "too-few-labels (3 of 10)", labelled: 3 });
  assert.equal(MIN_PAIRED_OBSERVATIONS, 10);
});

/** One authored head per index: the worker assignment, the implement.done that stamps the head,
 *  the review verdict on it, and (optionally) the risk verdict of the same run. */
function authoredHead(i: number, opts: { author: string; reviewPass: boolean; riskLow?: boolean; judge?: string }): Row[] {
  const runId = `run-${TASK}-${1000 + i}`;
  const head = `h${String(i).padStart(3, "0")}${"0".repeat(36)}`;
  const at = (s: number) => new Date(Date.parse("2026-09-20T00:00:00.000Z") + i * 60_000 + s * 1000).toISOString();
  const rows: Row[] = [
    { ts: at(0), step: "worker.assignment", run_id: runId, task_id: TASK, worker_assignment: { id: `asg-${i}`, selected: { provider: "claude", model: opts.author } } },
    { ts: at(1), step: "implement.done", run_id: runId, task_id: TASK, head_sha: head, head_assignment: `asg-${i}` },
    {
      ts: at(2), step: "review.posted", run_id: runId, task_id: TASK, head_sha: head, pr_url: `https://github.com/o/r/pull/${i}`,
      state: opts.reviewPass ? "success" : "failure", reviewer_outcome: "success",
      evaluator_provenance: { provider: "claude", requestedModel: "alias", servedModel: opts.judge ?? "judge-1", effort: "high", sessionId: "s" },
    },
  ];
  if (opts.riskLow !== undefined) {
    rows.push({ ts: at(3), step: "risk_judge.decision", run_id: runId, task_id: TASK, verdict: opts.riskLow ? "low" : "high", confidence: 0.9, model: "risk-model", action: "proceed" });
  }
  return rows;
}

/** Stratum review:judge-1 x author-a: 30 heads. Heads 0-9 get labels reproducing PAIRS; heads
 *  10-29 stay unlabelled with 14 passes. Risk judges heads 0-9: low for 0-4, high for 5-9.
 *  Stratum review:judge-1 x author-b: 5 unlabelled heads. */
function fixture(): { rows: Row[]; labels: JudgeLabel[] } {
  const rows: Row[] = [];
  const reviewPass = (i: number) => (i < 10 ? i < 6 : i < 24);
  for (let i = 0; i < 30; i += 1) rows.push(...authoredHead(i, { author: "author-a", reviewPass: reviewPass(i), ...(i < 10 ? { riskLow: i < 5 } : {}) }));
  for (let i = 30; i < 35; i += 1) rows.push(...authoredHead(i, { author: "author-b", reviewPass: true }));
  const { verdicts } = extractJudgeVerdicts(rows);
  const humanPass = [true, true, true, true, false, false, true, false, false, false];
  const labels = verdicts
    .filter((v) => v.kind === "review" && v.authorModel === "author-a")
    .slice(0, 10)
    .map((v, i) => ({ verdictRef: v.ref, label: humanPass[i] ? "pass" as const : "fail" as const, labeller: "operator", labelledAt: NOW }));
  return { rows, labels };
}

function stratum(calibration: JudgeCalibration, judge: string, author: string) {
  const found = calibration.strata.find((s) => `${s.judge.kind}:${s.judge.model}` === judge && s.authorModel === author);
  assert.ok(found, `stratum ${judge} x ${author}`);
  return found;
}

test("the judge x author matrix reports PPI-corrected rates beside raw ones, kappa with a count, and unknown for unlabelled strata", () => {
  const { rows, labels } = fixture();
  const calibration = deriveJudgeCalibration(rows, { asOf: NOW, labels: { labels } });
  assert.equal(calibration.version, JUDGE_CALIBRATION_VERSION);
  assert.equal(calibration.state, "observed");
  assert.match(calibration.method.estimator, /prediction-powered inference/);
  assert.match(calibration.method.interval, /CLT/);
  assert.deepEqual(calibration.labels, { state: "read", count: 10, matched: 10, unmatched: 0 });

  const a = stratum(calibration, "review:judge-1", "author-a");
  assert.equal(a.verdicts, 30);
  assert.ok(Math.abs(a.rawPassRate - 20 / 30) < 1e-12, "raw rate over every verdict");
  assert.equal(a.labelled, 10);
  assert.equal(a.sampled, JUDGE_SAMPLE_PER_STRATUM);
  assert.ok(a.corrected.state === "estimated");
  assert.ok(Math.abs(a.corrected.estimate - 0.6) < 1e-12, "PPI corrects 0.667 down to 0.6");
  assert.ok(Math.abs(a.corrected.standardError - HAND_SE) < 1e-12);
  assert.ok(a.humanAgreement.state === "estimated");
  assert.ok(Math.abs(a.humanAgreement.kappa - 0.4) < 1e-12);
  assert.equal(a.humanAgreement.count, 10);

  const b = stratum(calibration, "review:judge-1", "author-b");
  assert.equal(b.rawPassRate, 1);
  assert.deepEqual(b.corrected, { state: "unknown", reason: "unlabelled", labelled: 0 });
  assert.equal(b.humanAgreement.state, "unknown");

  const judge = calibration.judges.find((j) => j.judge.kind === "review")!;
  assert.equal(judge.verdicts, 35);
  assert.ok(Math.abs(judge.rawPassRate - 25 / 35) < 1e-12);
  assert.deepEqual(judge.corrected, { state: "unknown", reason: "1 of 2 author strata have no corrected rate", labelled: 10 });
  const risk = calibration.judges.find((j) => j.judge.kind === "risk")!;
  assert.equal(risk.verdicts, 10);
  assert.deepEqual(risk.corrected, { state: "unknown", reason: "1 of 1 author strata have no corrected rate", labelled: 0 });

  // Review P P P P P P F F F F vs risk P P P P P F F F F F on heads 0-9: p_o 0.9, p_e 0.5, kappa 0.8.
  assert.equal(calibration.betweenJudges.length, 1);
  const pair = calibration.betweenJudges[0]!;
  assert.deepEqual(pair.judges, [{ kind: "review", model: "judge-1" }, { kind: "risk", model: "risk-model" }]);
  assert.ok(pair.agreement.state === "estimated");
  assert.ok(Math.abs(pair.agreement.kappa - 0.8) < 1e-12);
  assert.equal(pair.agreement.count, 10);

  const text = JSON.stringify(calibration);
  assert.equal(text.includes(TASK), false, "no task id reaches the projection");
  assert.equal(text.includes("run-"), false, "no run id reaches the projection");
  assert.equal(text.includes("asg-"), false, "no assignment id reaches the projection");
});

test("a judge whose every stratum is estimated gets a verdict-weighted corrected rate", () => {
  const rows: Row[] = [];
  for (let i = 0; i < 6; i += 1) rows.push(...authoredHead(i, { author: "author-a", reviewPass: i < 4 }));
  for (let i = 6; i < 10; i += 1) rows.push(...authoredHead(i, { author: "author-b", reviewPass: i < 7 }));
  const { verdicts } = extractJudgeVerdicts(rows);
  const labels = verdicts.filter((_, i) => i % 2 === 0).map((v) => ({ verdictRef: v.ref, label: "pass" as const, labeller: "op", labelledAt: NOW }));
  const calibration = deriveJudgeCalibration(rows, { asOf: NOW, labels: { labels }, minPairedObservations: 2 });
  const strata = calibration.strata;
  assert.ok(strata.every((s) => s.corrected.state === "estimated"));
  const judge = calibration.judges[0]!;
  assert.ok(judge.corrected.state === "estimated");
  let expected = 0;
  let variance = 0;
  for (const s of strata) {
    const cell = s.corrected as Extract<typeof s.corrected, { state: "estimated" }>;
    expected += (s.verdicts / 10) * cell.estimate;
    variance += (s.verdicts / 10) ** 2 * cell.standardError ** 2;
  }
  assert.ok(Math.abs(judge.corrected.estimate - expected) < 1e-12);
  assert.ok(Math.abs(judge.corrected.standardError - Math.sqrt(variance)) < 1e-12);
});

test("stratified sampling is deterministic for a seed and respects the per-stratum size", () => {
  const { rows } = fixture();
  const { verdicts } = extractJudgeVerdicts(rows);
  const first = drawJudgeSample(verdicts, { seed: "s1", perStratum: 3 });
  assert.deepEqual(drawJudgeSample(verdicts, { seed: "s1", perStratum: 3 }), first, "same seed, same queue");
  const counts = new Map<string, number>();
  for (const item of first) counts.set(`${item.judge.kind}:${item.judge.model}|${item.authorModel}`, (counts.get(`${item.judge.kind}:${item.judge.model}|${item.authorModel}`) ?? 0) + 1);
  assert.deepEqual([...counts.entries()].sort(), [["review:judge-1|author-a", 3], ["review:judge-1|author-b", 3], ["risk:risk-model|author-a", 3]]);
  assert.notDeepEqual(drawJudgeSample(verdicts, { seed: "s2", perStratum: 3 }).map((i) => i.verdictRef), first.map((i) => i.verdictRef), "the seed moves the draw");
  const byDefault = drawJudgeSample(verdicts);
  assert.equal(byDefault.filter((i) => i.judge.kind === "review" && i.authorModel === "author-a").length, JUDGE_SAMPLE_PER_STRATUM);
  assert.equal(byDefault.filter((i) => i.authorModel === "author-b").length, 5, "a stratum smaller than the size is taken whole");
  assert.equal("pass" in (byDefault[0] as unknown as Row), false, "the queue never shows the judge's own verdict");
  // Order within a stratum is the seeded digest's, not ledger order.
  const shuffled = drawJudgeSample([...verdicts].reverse(), { seed: "s1", perStratum: 3 });
  assert.deepEqual(shuffled, first, "the draw is a function of the verdict set, not its order");
});

test("rows that are not LLM judgments are counted, and an unjoinable author is kept under unattributed", () => {
  const base = { ts: NOW, run_id: "run-x-1", reviewer_outcome: "success", state: "success", evaluator_provenance: { servedModel: "judge-1" } };
  const rows: Row[] = [
    { ts: NOW, step: "worker.assignment", worker_assignment: { id: "asg-known", selected: { model: "author-a" } } },
    { ts: NOW, step: "pr.opened", head_sha: "head-unattr", head_assignment: "unattributed" },
    { ts: NOW, step: "pr.opened", head_sha: "head-ghost", head_assignment: "asg-never-seen" },
    { ts: NOW, step: "pr.opened", head_sha: "head-late" },
    { ts: NOW, step: "implement.done", head_sha: "head-late", head_assignment: "asg-known" },
    { ...base, step: "review.posted", dep_review: true, head_sha: "x" },
    { ...base, step: "review.posted", reviewer_outcome: "error_max_turns", head_sha: "x" },
    { ...base, step: "review.posted", state: "pending", head_sha: "x" },
    { ...base, step: "review.posted", evaluator_provenance: { requestedModel: null }, head_sha: "x" },
    { ...base, step: "review.posted" },
    { ...base, step: "review.posted", head_sha: "head-missing" },
    { ...base, step: "review.posted", head_sha: "head-unattr" },
    { ...base, step: "review.posted", head_sha: "head-ghost" },
    { ...base, step: "review.posted", head_sha: "head-late", ts: "2026-09-27T12:00:01.000Z" },
    { ...base, step: "review.posted", head_sha: "head-late", ts: "2026-09-27T12:00:01.000Z" },
    { ts: NOW, step: "risk_judge.decision", run_id: "run-x-1", availability: "unavailable", verdict: "high" },
    { ts: NOW, step: "risk_judge.decision", run_id: "run-x-1", verdict: "medium", model: "r" },
    { ts: NOW, step: "risk_judge.decision", run_id: "run-x-1", verdict: "low" },
    { ts: "2026-09-27T11:00:00.000Z", step: "risk_judge.decision", run_id: "run-none", verdict: "low", model: "r" },
  ].map((row) => judgeCalibrationRow(row)!);
  const { verdicts, excluded, authorUnattributed } = extractJudgeVerdicts(rows);
  assert.deepEqual(excluded, {
    "dep-review-not-llm-judged": 1,
    "reviewer-did-not-complete": 1,
    "no-verdict": 2,
    "judge-model-unrecorded": 2,
    "judge-unavailable": 1,
  });
  assert.deepEqual(authorUnattributed, { "no-head": 2, "head-not-observed": 1, "head-unattributed": 1, "assignment-not-observed": 1 });
  assert.equal(verdicts.length, 6, "a replayed identical judgment is counted once");
  assert.equal(verdicts.find((v) => v.headSha === "head-late")?.authorModel, "author-a", "a named assignment wins over an earlier unrecorded head");
  assert.ok(verdicts.every((v: JudgeVerdict) => JUDGE_VERDICT_REF_RE.test(v.ref)));
  assert.equal(judgeCalibrationRow({ step: "cli.invoked" }), undefined);
  assert.equal(judgeCalibrationRow({ step: 7 }), undefined);

  const empty = deriveJudgeCalibration([rows[5]!], { asOf: NOW, labels: { labels: [] } });
  assert.equal(empty.state, "unavailable");
  assert.equal(empty.reason, "no-judge-verdicts-observed");
  assert.deepEqual(empty.excluded, { "dep-review-not-llm-judged": 1 });
});

test("the verdict reference pattern accepts only an opaque jv- digest", () => {
  assert.equal(JUDGE_VERDICT_REF_RE.test("jv-0123456789abcdef"), true);
  assert.equal(JUDGE_VERDICT_REF_RE.test("run-W1-T9999-1"), false);
  assert.equal(JUDGE_VERDICT_REF_RE.test("jv-0123456789ABCDEF"), false);
});

function memoryStore(initial: JudgeLabel[] = []): JudgeLabelStore & { labels: JudgeLabel[] } {
  const store = {
    labels: [...initial],
    read: () => [...store.labels],
    write: (labels: readonly JudgeLabel[]) => { store.labels = [...labels]; },
  };
  return store;
}

test("a label is recorded with its provenance, the latest per verdict wins, and an unreadable store is unavailable", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}judge-labels-`));
  const store = fileJudgeLabelStore(dir);
  assert.deepEqual(store.read(), [], "a missing file is no labels yet");
  const first = recordJudgeLabel(store, { verdictRef: "jv-0123456789abcdef", label: "pass", labeller: " operator " }, fixedClock(Date.parse("2026-09-27T10:00:00.000Z")));
  assert.deepEqual(first, { verdictRef: "jv-0123456789abcdef", label: "pass", labeller: "operator", labelledAt: "2026-09-27T10:00:00.000Z" });
  recordJudgeLabel(store, { verdictRef: "jv-0123456789abcdef", label: "fail", labeller: "second" }, fixedClock(Date.parse("2026-09-27T11:00:00.000Z")));
  assert.equal(fileJudgeLabelStore(dir).read().length, 2, "every label is kept, atomically, for provenance");
  assert.throws(() => recordJudgeLabel(store, { verdictRef: "task-W1-T1", label: "pass", labeller: "op" }, fixedClock(0)), /judge label refused/);
  assert.throws(() => recordJudgeLabel(store, { verdictRef: "jv-0123456789abcdef", label: "maybe", labeller: "op" }, fixedClock(0)), /judge label refused/);
  assert.throws(() => recordJudgeLabel(store, { verdictRef: "jv-0123456789abcdef", label: "pass", labeller: "  " }, fixedClock(0)), /judge label refused/);

  // Latest label per verdict wins in the projection.
  const { rows } = fixture();
  const ref = extractJudgeVerdicts(rows).verdicts[0]!.ref;
  const memory = memoryStore();
  recordJudgeLabel(memory, { verdictRef: ref, label: "fail", labeller: "op" }, fixedClock(Date.parse("2026-09-27T09:00:00.000Z")));
  recordJudgeLabel(memory, { verdictRef: ref, label: "pass", labeller: "op" }, fixedClock(Date.parse("2026-09-27T10:00:00.000Z")));
  recordJudgeLabel(memory, { verdictRef: ref, label: "fail", labeller: "op" }, fixedClock(Date.parse("2026-09-27T08:00:00.000Z")));
  recordJudgeLabel(memory, { verdictRef: "jv-ffffffffffffffff", label: "pass", labeller: "op" }, fixedClock(0));
  const calibration = deriveJudgeCalibration(rows, { asOf: NOW, labels: loadJudgeLabels(memory), minPairedObservations: 1 });
  assert.deepEqual(calibration.labels, { state: "read", count: 4, matched: 1, unmatched: 1 });
  // Head 0's review passed; the 10:00 "pass" wins, so the rectifier is 0 and theta is the
  // unlabelled mean 19/29. Had an earlier "fail" won, theta would be 19/29 - 1, clamped to 0.
  const corrected = stratum(calibration, "review:judge-1", "author-a").corrected;
  assert.ok(corrected.state === "estimated" && Math.abs(corrected.estimate - 19 / 29) < 1e-12, JSON.stringify(corrected));
  const queued = calibration.sample.find((item) => item.verdictRef === ref);
  assert.equal(queued === undefined || queued.labelled, true, "a labelled verdict in the queue is marked labelled");
  assert.equal(calibration.sample.filter((item) => item.labelled).length <= 1, true);

  writeFileSync(join(dir, JUDGE_LABELS_FILENAME), "{not json");
  assert.deepEqual(loadJudgeLabels(fileJudgeLabelStore(dir)), { unavailable: "label-store-unreadable" });
  writeFileSync(join(dir, JUDGE_LABELS_FILENAME), JSON.stringify({ labels: [{ verdictRef: "nope" }] }));
  assert.deepEqual(loadJudgeLabels(fileJudgeLabelStore(dir)), { unavailable: "label-store-unreadable" });
  const blind = deriveJudgeCalibration(rows, { asOf: NOW, labels: { unavailable: "label-store-unreadable" } });
  assert.deepEqual(blind.labels, { state: "unavailable", reason: "label-store-unreadable", count: 0, matched: 0, unmatched: 0 });
  assert.ok(blind.strata.every((s) => s.corrected.state === "unknown" && s.humanAgreement.state === "unknown"));
  assert.ok(blind.judges.every((j) => j.corrected.state === "unknown" && (j.corrected as { reason: string }).reason === "label-store-unreadable"));
});

function fakeResponse() {
  let body = "";
  let status = 0;
  const res = {
    statusCode: 0,
    setHeader() {},
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { body = chunk ?? ""; },
  } as unknown as ServerResponse;
  return { res, body: () => body, status: () => status || (res as unknown as { statusCode: number }).statusCode };
}

test("the analytics route serves the judge calibration only when it is requested", async () => {
  const { rows, labels } = fixture();
  const base = deriveAnalyticsSnapshot(rows, NOW, { judgeLabels: { labels } });
  const route = buildAnalyticsRoute({ currentSnapshot: () => base });

  const versioned = fakeResponse();
  await route.handler({ url: `/v1/analytics?projectionVersion=${JUDGE_CALIBRATION_VERSION}` } as never, versioned.res, { params: {} });
  assert.equal(versioned.status(), 200);
  const calibration = JSON.parse(versioned.body()) as JudgeCalibration;
  assert.equal(calibration.version, JUDGE_CALIBRATION_VERSION);
  assert.equal(calibration.state, "observed");
  const a = stratum(calibration, "review:judge-1", "author-a");
  assert.ok(a.corrected.state === "estimated" && Math.abs(a.corrected.estimate - 0.6) < 1e-12);
  assert.equal(versioned.body().includes(TASK), false);

  const full = fakeResponse();
  await route.handler({ url: "/v1/analytics" } as never, full.res, { params: {} });
  assert.equal("judgeCalibration" in (JSON.parse(full.body()) as Row), false, "never in the unversioned body");

  const cold = buildAnalyticsRoute({ currentSnapshot: () => ({ ...base }) });
  const pending = fakeResponse();
  await cold.handler({ url: `/v1/analytics?projection=${JUDGE_CALIBRATION_VERSION}` } as never, pending.res, { params: {} });
  const unavailable = JSON.parse(pending.body()) as JudgeCalibration;
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.reason, "judge-calibration-refresh-pending");

  const unlabelled = deriveAnalyticsSnapshot(rows, NOW).judgeCalibration!;
  assert.deepEqual(unlabelled.labels, { state: "unavailable", reason: "no-label-store-supplied", count: 0, matched: 0, unmatched: 0 });
});

test("the ledger readers load labels beside the ledger and the checkpoint carries the judge rows", async () => {
  const { rows, labels } = fixture();
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}judge-calibration-ledger-`));
  writeFileSync(join(dir, "ledger.ndjson"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  fileJudgeLabelStore(dir).write(labels);
  const clock = fixedClock(Date.parse(NOW));

  const plain = await deriveAnalyticsSnapshotFromLedger(dir, clock);
  assert.equal(plain.judgeCalibration?.labels.matched, 10, "the default store is the state dir's label file");

  const first = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock);
  const firstA = stratum(first.snapshot.judgeCalibration!, "review:judge-1", "author-a");
  assert.ok(firstA.corrected.state === "estimated" && Math.abs(firstA.corrected.estimate - 0.6) < 1e-12);
  assert.ok(Array.isArray(first.checkpoint.state.judgeCalibrationRows));
  writeAnalyticsCheckpoint(dir, first.checkpoint);
  const prior = readAnalyticsCheckpoint(dir)!;

  const resumed = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock, undefined, prior, { judgeLabelStore: memoryStore(labels) });
  assert.deepEqual(resumed.snapshot.judgeCalibration, first.snapshot.judgeCalibration, "a resumed scan hydrates the judge rows");

  const legacy = { ...prior, state: { ...prior.state, judgeCalibrationRows: undefined } };
  const rescanned = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock, undefined, legacy);
  assert.deepEqual(rescanned.snapshot.judgeCalibration, first.snapshot.judgeCalibration, "a checkpoint predating the judge rows forces a full scan, never an empty calibration");

  const injected = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock, undefined, undefined, { judgeLabels: { labels: [] } });
  assert.equal(injected.snapshot.judgeCalibration?.labels.matched, 0, "injected labels win over the store");
});
