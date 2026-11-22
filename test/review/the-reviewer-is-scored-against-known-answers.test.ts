/**
 * W1-T12145 — THE REVIEWER IS SCORED AGAINST KNOWN ANSWERS.
 *
 * A merged head later reverted or follow-up-fixed is an escaped defect (right verdict FAIL); a head clean
 * through the window is a control (right verdict PASS). The pass freezes those cases once per epoch, reviews
 * them in shadow mode with each model under test pinned, and scores each model. Every reviewer, GitHub and
 * model seam here is a fake or a local executable: nothing spends and nothing reaches the network.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test, type TestContext } from "node:test";

import { clockFromMillisFn, fixedClock } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import { replayIdleGate } from "#src/lib/golden-corpus.js";
import { wilsonInterval } from "#src/lib/model-drift.js";
import { REVIEWER_SHADOW_FLAG } from "#src/lib/reviewer-health.js";
import * as cal from "#src/lib/reviewer-calibration.js";
import {
  MIN_POPULATION_FLOOR, UNREADABLE_REVIEWER_MODEL, VERDICT_OUTCOME_STEP, mineVerdictRows, verdictCalibrationReport, type VerdictRow,
} from "#src/lib/verdict-calibration.js";
import {
  buildReviewerCalibrationPorts, readReviewerCalibrationIdle, readReviewerCalibrationRows, reviewCommand, runReviewerCalibrationCase,
  spawnRmdReviewForFreshTree,
} from "#src/run-task.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Row = Record<string, unknown>;
const T0 = Date.parse("2026-11-22T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const sha = (label: string): string => createHash("sha1").update(label).digest("hex");
const SONNET: cal.CalibrationModel = { provider: "claude", model: "claude-sonnet-5-5" };
const SOL: cal.CalibrationModel = { provider: "codex", model: "gpt-6.1-sol" };
const CASH: cal.CalibrationModel = { provider: "cash", model: "cash-haiku" };
const IDLE = {
  liveness: { state: "up" as const, quiet: true as const },
  headroom: { billingMode: "subscription" as const, session: { percentUsed: 12 }, weekly: [{ label: "all models", percentUsed: 30 }] },
};

/** `n` escaped defects then `m` clean controls at one risk, each passed live by SONNET on its own pull request. */
function history(n: number, m: number, risk = "high", from = 0) {
  const outcomes: cal.CalibrationOutcomeInput[] = [];
  const reviewed = new Map<string, cal.CalibrationReviewedHead>();
  const ordinal = new Map<string, number>();
  for (let i = 0; i < n + m; i++) {
    const k = from + i;
    const head = sha(`head-${k}`);
    ordinal.set(head, k);
    outcomes.push({ task_id: `W1-T${9000 + k}`, head_sha: head, merge_sha: sha(`merge-${k}`), outcome: i < n ? (i % 2 ? "followup_fixed" : "reverted") : "clean" });
    reviewed.set(head, { prUrl: `https://github.com/acme/remudero/pull/${100 + k}`, risk, incumbent: SONNET });
  }
  return { outcomes, reviewed, ordinal };
}

function merged(...parts: Array<ReturnType<typeof history>>) {
  return {
    outcomes: parts.flatMap((p) => p.outcomes),
    reviewed: new Map(parts.flatMap((p) => [...p.reviewed])),
    ordinal: new Map(parts.flatMap((p) => [...p.ordinal])),
  };
}

interface FakeOptions {
  outcomes: cal.CalibrationOutcomeInput[];
  reviewed: Map<string, cal.CalibrationReviewedHead>;
  models: cal.CalibrationModel[];
  stateDir: string;
  rows?: Row[];
  idle?: () => Awaited<ReturnType<cal.ReviewerCalibrationPorts["idleSignal"]>>;
  result?: (c: cal.CalibrationCase, m: cal.CalibrationModel) => cal.CalibrationCaseResult;
  reserve?: number;
  nowMs?: number;
}

/** The pass's ports over one in-memory ledger; its reader splits rows by step, as run-task.ts's reader does. */
function fakePorts(opts: FakeOptions) {
  let nowMs = opts.nowMs ?? T0;
  const clock = clockFromMillisFn(() => nowMs);
  const rows = opts.rows ?? [];
  const runs: Array<{ c: cal.CalibrationCase; m: cal.CalibrationModel; at: number }> = [];
  const ports: cal.ReviewerCalibrationPorts = {
    stateDir: opts.stateDir,
    clock,
    readOutcomes: async () => opts.outcomes,
    readReviewedHeads: async () => opts.reviewed,
    readPriorRows: async () => ({
      cases: rows.filter((r) => r.step === cal.REVIEW_CALIBRATION_CASE_STEP),
      results: rows.filter((r) => r.step === cal.REVIEW_CALIBRATION_RESULT_STEP),
    }),
    models: async () => opts.models,
    idleSignal: async () => (opts.idle ?? (() => IDLE))(),
    runCase: async (c, m) => {
      runs.push({ c, m, at: nowMs });
      nowMs += 60_000;
      return opts.result ? opts.result(c, m) : { verdict: c.expected, costUsd: 0.25 };
    },
    log: (row) => rows.push({ ts: clock.iso(), ...row }),
    cashCaseReserveUsd: opts.reserve ?? 1,
    casesPerPass: Number.POSITIVE_INFINITY,
  };
  return { ports, rows, runs, advance: (ms: number) => { nowMs += ms; } };
}

const stateOf = (t: TestContext): string => ownedFixtureDir(t, "w1t12145-state").dir;
const epochFiles = (stateDir: string): string[] => readdirSync(cal.calibrationEpochDir(stateDir)).sort();
const scored = (rows: Row[]): Row[] => rows.filter((r) => r.step === cal.REVIEW_CALIBRATION_RESULT_STEP && r.outcome === "scored");
const refusals = (rows: Row[]): Row[] => rows.filter((r) => r.step === cal.REVIEW_CALIBRATION_RESULT_STEP && r.outcome === "refused");

/** Freeze epoch 1 over `h` with a first pass, then move the clock an hour, as the next cadence fire would. */
async function frozenEpoch(t: TestContext, h: ReturnType<typeof history>, models: cal.CalibrationModel[], extra: Partial<FakeOptions> = {}) {
  const fake = fakePorts({ ...h, models, stateDir: stateOf(t), ...extra });
  const first = await cal.scoreReviewersAgainstKnownAnswers(fake.ports);
  assert.equal(first.epoch, 1);
  fake.advance(60 * 60 * 1000);
  const epoch = cal.readCalibrationEpoch(fake.ports.stateDir) as cal.CalibrationEpoch;
  return { ...fake, first, epoch };
}

test("W1-T12145 criterion 1 cases are escaped defects (FAIL) and controls (PASS) from verdict_calibration.outcome rows, sampled per risk level with a seed", () => {
  const high = history(3, 5, "high");
  const low = history(1, 3, "low", 50);
  const both = merged(high, low);
  // A head that was clean and later reverted is an escaped defect; a head with no reviewed pull request is dropped.
  const flipped = sha("head-5");
  both.outcomes.push({ task_id: "W1-T9005", head_sha: flipped, merge_sha: sha("merge-5"), outcome: "reverted" });
  const orphan = sha("orphan");
  both.outcomes.push({ task_id: "W1-T9999", head_sha: orphan, merge_sha: sha("orphan-merge"), outcome: "reverted" });
  const { cases, dropped } = cal.buildCalibrationCases(both.outcomes, both.reviewed, "seed-a");
  for (const c of cases) {
    const k = both.ordinal.get(c.headSha)!;
    const escaped = k < 3 || k === 5 || k === 50;
    assert.equal(c.kind, escaped ? "escaped-defect" : "control", `head ${k}`);
    assert.equal(c.expected, escaped ? "FAIL" : "PASS", `head ${k}`);
    assert.equal(c.prNumber, 100 + k);
  }
  const byRisk = (risk: string, kind: cal.CalibrationCaseKind) => cases.filter((c) => c.risk === risk && c.kind === kind);
  assert.equal(byRisk("high", "escaped-defect").length, 4, "every escaped defect of the level enters");
  assert.equal(byRisk("high", "control").length, 4, "and as many of its controls");
  assert.equal(byRisk("low", "escaped-defect").length, 1);
  assert.equal(byRisk("low", "control").length, 1);
  assert.deepEqual(dropped, [{ headSha: orphan, reason: "no review.posted row names this head's pull request" }]);
  assert.deepEqual(cal.buildCalibrationCases(both.outcomes, both.reviewed, "seed-a"), { cases, dropped }, "the seed reproduces the draw");
  const drawn = (seed: string) => cal.buildCalibrationCases(both.outcomes, both.reviewed, seed).cases.filter((c) => c.kind === "control").map((c) => c.headSha).sort().join();
  assert.ok(["seed-b", "seed-c", "seed-d", "seed-e"].some((seed) => drawn(seed) !== drawn("seed-a")), "another seed draws other controls");

  // The ledger's rows: the passing review names the pull request and incumbent, its run's semantic mode the risk.
  const head = sha("from-rows");
  const rows: Row[] = [
    { step: VERDICT_OUTCOME_STEP, task_id: "W1-T1", head_sha: head, merge_sha: sha("m"), outcome: "followup_fixed" },
    { step: VERDICT_OUTCOME_STEP, task_id: "W1-T1", head_sha: head, merge_sha: sha("m"), outcome: "not-a-kind" },
    { step: "review.semantic_mode", run_id: "review-PR7-1", task_risk: "medium" },
    { step: "review.posted", ts: new Date(T0 - DAY).toISOString(), run_id: "review-PR7-0", state: "failure", head_sha: head, pr_url: "https://github.com/acme/remudero/pull/7",
      evaluator_provenance: { provider: "codex", requestedModel: SOL.model } },
    { step: "review.posted", ts: new Date(T0 - DAY).toISOString(), run_id: "review-PR7-1", state: "success", head_sha: head, pr_url: "https://github.com/acme/remudero/pull/7",
      evaluator_provenance: { provider: "claude", requestedModel: SONNET.model } },
    { step: "review.posted", ts: new Date(T0 - 30 * DAY).toISOString(), state: "success", head_sha: sha("old"), pr_url: "https://github.com/acme/remudero/pull/3",
      evaluator_provenance: { provider: "claude", requestedModel: "claude-retired-4" } },
    { step: "review.posted", ts: new Date(T0).toISOString(), state: "success", head_sha: sha("none"), pr_url: "https://github.com/acme/remudero/pull/4",
      evaluator_provenance: { provider: "not-a-provider", requestedModel: "x" } },
    { step: "review.posted", ts: new Date(T0).toISOString(), state: "success", head_sha: sha("nil"), pr_url: "https://github.com/acme/remudero/pull/5", evaluator_provenance: null },
  ];
  const inputs = cal.calibrationInputsFromRows(rows, T0);
  assert.deepEqual(inputs.outcomes, [{ task_id: "W1-T1", head_sha: head, merge_sha: sha("m"), outcome: "followup_fixed" }]);
  assert.deepEqual(inputs.reviewed.get(head), { prUrl: "https://github.com/acme/remudero/pull/7", risk: "medium", incumbent: SONNET });
  assert.deepEqual(inputs.reviewed.get(sha("nil")), { prUrl: "https://github.com/acme/remudero/pull/5" });
  assert.deepEqual(inputs.models, [SONNET, SOL], "the models reviews named in the window, and no retired one");
  assert.equal(cal.buildCalibrationCases(inputs.outcomes, inputs.reviewed, "s").cases[0]!.kind, "escaped-defect");
});

test("W1-T12145 criterion 2 the case set is frozen once per epoch with its seed, and a later pass reads it back and never derives it again", async (t) => {
  const stateDir = stateOf(t);
  const short = history(19, 5);
  const none = fakePorts({ ...short, models: [SONNET], stateDir });
  const empty = await cal.scoreReviewersAgainstKnownAnswers(none.ports);
  assert.equal(empty.epoch, null);
  assert.match(String(refusals(none.rows)[0]?.reason), /^no epoch: 19 escaped defect\(s\) have a reviewed pull request, and an epoch needs 20$/);
  assert.equal(existsSync(cal.calibrationEpochDir(stateDir)), false);

  const h = history(20, 25);
  const fake = fakePorts({ ...h, models: [SONNET, SOL], stateDir });
  const first = await cal.scoreReviewersAgainstKnownAnswers(fake.ports);
  assert.equal(first.epoch, 1);
  assert.equal(first.ran, 0, "the freezing pass starts none of its cases");
  const path = join(cal.calibrationEpochDir(stateDir), "epoch-1.json");
  const frozenBytes = readFileSync(path);
  const epoch = JSON.parse(frozenBytes.toString("utf8")) as cal.CalibrationEpoch;
  assert.equal(epoch.seed, `1:${new Date(T0).toISOString()}`);
  assert.deepEqual(epoch.cases, cal.buildCalibrationCases(h.outcomes, h.reviewed, epoch.seed).cases, "frozen with its seed");
  assert.equal(epoch.cases.length, 40);

  // Later history: 19 new escaped defects and more controls. The pass reviews the frozen set, never a new one.
  const later = merged(h, history(19, 5, "high", 100));
  fake.advance(DAY);
  const second = await cal.scoreReviewersAgainstKnownAnswers(fakePorts({ ...later, models: [SONNET, SOL], stateDir, rows: fake.rows, nowMs: T0 + DAY }).ports);
  assert.equal(second.epoch, 1);
  assert.equal(second.ran, 80);
  const frozenIds = new Set(epoch.cases.map((c) => c.caseId));
  const ranIds = fake.rows.filter((r) => r.step === cal.REVIEW_CALIBRATION_CASE_STEP).map((r) => String(r.case_id));
  assert.ok(ranIds.length > 0 && ranIds.every((id) => frozenIds.has(id)), "every case reviewed is one the epoch froze");
  assert.deepEqual(readFileSync(path), frozenBytes, "the epoch file is never rewritten");
  assert.deepEqual(epochFiles(stateDir), ["epoch-1.json"]);

  // A twentieth new escaped defect starts epoch 2; epoch 1 stays as frozen.
  const third = await cal.scoreReviewersAgainstKnownAnswers(
    fakePorts({ ...merged(later, history(1, 0, "high", 200)), models: [SONNET, SOL], stateDir, rows: fake.rows, nowMs: T0 + 2 * DAY }).ports);
  assert.equal(third.epoch, 2);
  assert.deepEqual(epochFiles(stateDir), ["epoch-1.json", "epoch-2.json"]);
  assert.deepEqual(readFileSync(path), frozenBytes);
  assert.throws(() => cal.freezeCalibrationEpoch(stateDir, 2, "again", { cases: [], dropped: [] }, [SONNET], fixedClock(T0)), /EEXIST/);

  // An epoch that cannot be read is refused, never derived again.
  writeFileSync(join(cal.calibrationEpochDir(stateDir), "epoch-3.json"), "{not json");
  const torn = fakePorts({ ...later, models: [SONNET], stateDir });
  assert.equal((await cal.scoreReviewersAgainstKnownAnswers(torn.ports)).epoch, null);
  assert.match(String(refusals(torn.rows)[0]?.reason), /^the frozen epoch cannot be read, so no case set is derived again: .*epoch-3\.json/);
  writeFileSync(join(cal.calibrationEpochDir(stateDir), "epoch-4.json"), JSON.stringify({ epoch: 4 }));
  const shapeless = fakePorts({ ...later, models: [SONNET], stateDir });
  await cal.scoreReviewersAgainstKnownAnswers(shapeless.ports);
  assert.match(String(refusals(shapeless.rows)[0]?.reason), /epoch-4\.json is not a frozen epoch/);
  assert.equal(torn.runs.length + shapeless.runs.length, 0);
  assert.deepEqual(epochFiles(stateDir), ["epoch-1.json", "epoch-2.json", "epoch-3.json", "epoch-4.json"]);
});

test("W1-T12145 criterion 3 one review.calibration.result row per model: false-FAIL rate on controls, detection on escaped defects, Wilson intervals, counts, cost and duration", async (t) => {
  const h = history(20, 20);
  const k = (c: cal.CalibrationCase) => h.ordinal.get(c.headSha)!;
  const result = (c: cal.CalibrationCase, m: cal.CalibrationModel): cal.CalibrationCaseResult => {
    const sonnet = m === SONNET;
    if (!sonnet && k(c) === 39) return { verdict: null, costUsd: 0.25, reason: "the reviewer's outcome was error_max_turns" };
    if (c.kind === "control") return { verdict: (sonnet ? k(c) < 22 : k(c) < 24) ? "FAIL" : "PASS", costUsd: 0.25 };
    return { verdict: (sonnet ? k(c) < 3 : k(c) < 1) ? "PASS" : "FAIL", costUsd: 0.25 };
  };
  const fake = await frozenEpoch(t, h, [SONNET, SOL], { result });
  const before = scored(fake.rows).length;
  assert.equal(before, 2, "the freezing pass writes one scored row per model too");
  const pass = await cal.scoreReviewersAgainstKnownAnswers(fake.ports);
  assert.equal(pass.ran, 80);
  assert.deepEqual(pass.decisions.filter((d) => d.decided), [], "no pair decided, so every case ran");
  const rows = scored(fake.rows).slice(before);
  assert.deepEqual(rows.map((r) => `${r.provider}:${r.model}`), ["claude:claude-sonnet-5-5", "codex:gpt-6.1-sol"]);
  const rate = (hits: number, cases: number) => ({ cases, hits, rate: hits / cases, ...wilsonInterval(hits, cases, 1.96) });
  const [sonnet, sol] = rows as [Row, Row];
  assert.deepEqual(sonnet.control_false_fail, rate(2, 20), "a FAIL on a control is a wrong answer");
  assert.deepEqual(sonnet.escaped_detection, rate(17, 20));
  assert.equal(sonnet.unmeasured, 0);
  assert.deepEqual(sonnet.cost_usd, { total: 10, perCase: 0.25, unread: 0 });
  assert.deepEqual(sonnet.duration_ms, { total: 40 * 60_000, perCase: 60_000 });
  assert.deepEqual(sonnet.incumbent_rerun, rate(21, 40), "the incumbent's re-run agreement is the noise floor");
  assert.deepEqual(sol.control_false_fail, rate(4, 19), "a run with no verdict is in neither count");
  assert.deepEqual(sol.escaped_detection, rate(19, 20));
  assert.equal(sol.unmeasured, 1);
  assert.deepEqual(sol.incumbent_rerun, { cases: 0, hits: 0, rate: null, lower: null, upper: null });
  assert.deepEqual(sol.stopped, []);
  const unmeasured = fake.rows.find((r) => r.step === cal.REVIEW_CALIBRATION_CASE_STEP && r.verdict === null)!;
  assert.equal(unmeasured.reason, "the reviewer's outcome was error_max_turns");
  assert.deepEqual(cal.calibrationRunFromRow({ step: cal.REVIEW_CALIBRATION_CASE_STEP, epoch: 1 }), undefined);
  const lean = cal.calibrationRunFromRow({ epoch: 1, case_id: "c", kind: "control", provider: "claude", model: "m", verdict: "PASS" })!;
  assert.deepEqual([lean.costUsd, lean.durationMs, lean.at, lean.incumbent], [null, 0, "", false]);
});

test("W1-T12145 criterion 4 the verdict calibration report groups passed pull requests by reviewer model with revert and follow-up fix rates in the 14-day window", (t) => {
  const dump = (commits: Array<{ sha: string; ts: string; subject: string; body?: string; files?: string[] }>): string =>
    commits.map((c) => `\x02${c.sha}\x00${c.ts}\x00${c.subject}\x00${c.body ?? ""}\x01\n${(c.files ?? []).join("\n")}\n`).join("");
  const rows: VerdictRow[] = [];
  const commits: Array<{ sha: string; ts: string; subject: string; body?: string; files?: string[] }> = [];
  const add = (taskId: string, reviewerModel: string | undefined) => {
    rows.push({ taskId, headSha: `h-${taskId}`, armedTs: "2026-01-01T00:00:00.000Z", verdictClass: "full-pass", ...(reviewerModel ? { reviewerModel } : {}) });
    commits.push({ sha: sha(taskId), ts: "2026-01-01T01:00:00+00:00", subject: `feat(x): thing (${taskId})`, files: [`src/${taskId}.ts`] });
  };
  for (let i = 0; i < MIN_POPULATION_FLOOR; i++) add(`W1-T70${i}`, "claude-sonnet-5-5");
  add("W1-T800", "gpt-6.1-sol");
  add("W1-T801", "gpt-6.1-sol");
  add("W1-T900", undefined);
  commits.push({ sha: sha("revert-700"), ts: "2026-01-05T00:00:00+00:00", subject: 'Revert "feat(x): thing (W1-T700)"', body: `This reverts commit ${sha("W1-T700")}.` });
  commits.push({ sha: sha("fix-701"), ts: "2026-01-06T00:00:00+00:00", subject: "fix(x): patch (W1-T701)" });
  commits.push({ sha: sha("revert-702"), ts: "2026-02-20T00:00:00+00:00", subject: 'Revert "feat(x): thing (W1-T702)"', body: `This reverts commit ${sha("W1-T702")}.` });
  commits.push({ sha: sha("revert-800"), ts: "2026-01-04T00:00:00+00:00", subject: 'Revert "feat(x): thing (W1-T800)"', body: `This reverts commit ${sha("W1-T800")}.` });
  const report = verdictCalibrationReport(rows, dump(commits));
  assert.deepEqual(report.byReviewerModel, [
    { reviewerModel: "claude-sonnet-5-5", total: 5, revertedCount: 1, followupFixedCount: 1, revertRate: 1 / 5, followupFixRate: 1 / 5,
      taskIds: ["W1-T700", "W1-T701", "W1-T702", "W1-T703", "W1-T704"] },
    { reviewerModel: "gpt-6.1-sol", total: 2, revertedCount: 1, followupFixedCount: 0, revertRate: null, followupFixRate: null, taskIds: ["W1-T800", "W1-T801"] },
    { reviewerModel: UNREADABLE_REVIEWER_MODEL, total: 1, revertedCount: 0, followupFixedCount: 0, revertRate: null, followupFixRate: null, taskIds: ["W1-T900"] },
  ], "a revert past the window is not counted, and a row naming no model is counted under unreadable");

  // The model is the served model the joined review.posted row's provenance names.
  const dir = ownedFixtureDir(t, "w1t12145-verdict-rows").dir;
  const line = (row: Row) => JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", ...row });
  writeFileSync(join(dir, "ledger.2026-01-02T00-00-00-000Z.ndjson.gz"), gzipSync([
    line({ step: "automerge.armed", task_id: "W1-T1", head_sha: "s1" }),
    line({ step: "review.posted", task_id: "W1-T1", head_sha: "s1", evaluator_provenance: { servedModel: "claude-sonnet-5-5", requestedModel: "sonnet" } }),
    line({ step: "automerge.armed", task_id: "W1-T2", head_sha: "s2" }),
    line({ step: "review.posted", task_id: "W1-T2", head_sha: "s2", evaluator_provenance: { servedModel: null } }),
    line({ step: "automerge.armed", task_id: "W1-T3", head_sha: "s3" }),
    line({ step: "review.posted", task_id: "W1-T3", head_sha: "s3" }),
  ].join("\n") + "\n"));
  const mined = new Map(mineVerdictRows(dir).rows.map((r) => [r.taskId, r.reviewerModel]));
  assert.deepEqual([...mined], [["W1-T1", "claude-sonnet-5-5"], ["W1-T2", undefined], ["W1-T3", undefined]]);
});

test("W1-T12145 criterion 5 invariant calibration-publishes-nothing: a case is a shadow review with the model pinned, and it posts no status", async (t) => {
  // The runner's own argv, captured, is the argv the review command runs.
  const head = sha("calibration-head");
  const c: cal.CalibrationCase = { caseId: head, taskId: "W1-T900", headSha: head, mergeSha: sha("merge"), kind: "escaped-defect", expected: "FAIL",
    risk: "medium", prNumber: 8, prUrl: "https://github.com/acme/remudero/pull/8" };
  let argv: string[] = [];
  const attemptId = "review-PR8-0b6c2a52-3c1e-4c55-8a88-5f8a7c9d1e23";
  const shadowRows = (state: string): Row[] => [
    { step: "shadow.review.reviewer", provider: "codex", model: SOL.model, total_cost_usd: 0.4 },
    { step: "shadow.review.shadow_verdict", state, head_sha: head, reviewer_outcome: "success" },
  ];
  const ran = await runReviewerCalibrationCase(c, SOL, {
    run: async (prArg, rest) => { argv = [prArg, ...rest]; return 0; },
    originMainSha: () => `${sha("main")}\n`,
    readAttemptRows: (id) => (id === attemptId ? shadowRows("failure") : []),
    attemptId, clock: fixedClock(T0),
  });
  assert.deepEqual(ran, { verdict: "FAIL", costUsd: 0.4 });
  assert.equal(argv[0], "8");
  assert.ok(argv.includes(REVIEWER_SHADOW_FLAG), "a case review runs in shadow mode");
  assert.deepEqual(argv.slice(argv.indexOf(cal.CALIBRATION_HEAD_FLAG), argv.indexOf(cal.CALIBRATION_HEAD_FLAG) + 2), [cal.CALIBRATION_HEAD_FLAG, head]);
  assert.deepEqual(argv.slice(argv.indexOf(cal.REVIEWER_MODEL_PIN_FLAG), argv.indexOf(cal.REVIEWER_MODEL_PIN_FLAG) + 2), [cal.REVIEWER_MODEL_PIN_FLAG, "codex:gpt-6.1-sol"]);
  assert.deepEqual(argv.slice(argv.indexOf("--exclude-providers"), argv.indexOf("--exclude-providers") + 2), ["--exclude-providers", "claude,cash,openweight"]);

  // The merged, closed pull request is reviewed at the head it merged, in shadow, by the pinned model: nothing is posted.
  const root = ownedFixtureDir(t, "w1t12145-shadow-command").dir;
  let pending = 0, admissions = 0;
  let reviewed: Record<string, any> | undefined;
  const view = (mergedAt: string | null) => () => ({ number: 8, html_url: c.prUrl, state: "closed", merged_at: mergedAt, body: "## Acceptance\n- it works | grep: review in src/lib/review.ts\n",
    head: { sha: head, ref: "codex/not-a-run-branch" } });
  const deps = (fetchView: () => unknown) => ({
    resolveOwnerRepo: () => ({ owner: "acme", repo: "remudero" }), enforceReviewSubjectCheckout: false,
    loadConfig: () => ({ root, installRoot: REPO_ROOT, claudeBin: "/bin/true" }) as Config,
    fetchView, fetchHead: () => {}, postReviewPending: async () => { pending++; return { posted: true }; },
    contributorAdmission: async () => { admissions++; },
    materialize: () => ({ worktreePath: undefined, failure: { errorClass: "test", message: "fixture" } }),
    runReview: async (args: Record<string, any>) => { reviewed = args; return { state: "failure", headSha: head, reviewerOutcome: "success", criteria: [] }; },
    reviewerCodeFreshness: () => ({ status: "fresh", codeSha: head, originMainSha: head, advance: "none" }),
  });
  const code = await reviewCommand("8", argv.slice(1), deps(view("2026-11-01T00:00:00Z")) as never);
  assert.equal(code, 0, "a shadow review ends at its verdict");
  assert.equal(reviewed?.shadow, true);
  assert.equal(reviewed?.spawnReviewer, true);
  assert.equal(reviewed?.reviewerMount?.provider, "codex");
  assert.equal(reviewed?.reviewerMount?.model, "gpt-6.1-sol");
  assert.deepEqual(reviewed?.excludeProviders, ["claude", "cash", "openweight"]);
  assert.equal(pending, 0, "a case review posts no pending status");
  assert.equal(admissions, 0, "and touches no admission label");
  const steps = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => String((JSON.parse(l) as Row).step));
  assert.ok(steps.length > 0 && steps.every((s) => s.startsWith("shadow.")), "every row it writes is a shadow row no publisher reads");

  // Anything but a shadow review at the merged head is declined as a closed pull request always was.
  reviewed = undefined;
  assert.equal(await reviewCommand("8", ["--repo", "acme/remudero", REVIEWER_SHADOW_FLAG], deps(view("2026-11-01T00:00:00Z")) as never), 2);
  assert.equal(await reviewCommand("8", argv.slice(1), deps(view(null)) as never), 2, "an unmerged closed pull request is no case");
  assert.equal(reviewed, undefined);
  assert.equal(pending, 0);
  const row = { head: { sha: head }, merged_at: "2026-11-01T00:00:00Z" };
  assert.equal(cal.isCalibrationCaseOf([REVIEWER_SHADOW_FLAG, cal.CALIBRATION_HEAD_FLAG, head], row), true);
  assert.equal(cal.isCalibrationCaseOf([cal.CALIBRATION_HEAD_FLAG, head], row), false, "not without shadow mode");
  assert.equal(cal.isCalibrationCaseOf([REVIEWER_SHADOW_FLAG, cal.CALIBRATION_HEAD_FLAG, sha("other")], row), false, "not at another head");
  assert.equal(cal.isCalibrationCaseOf([REVIEWER_SHADOW_FLAG, cal.CALIBRATION_HEAD_FLAG, "HEAD"], { head: { sha: "HEAD" }, merged_at: "x" }), false);
  assert.equal(cal.reviewerModelPin([cal.REVIEWER_MODEL_PIN_FLAG, "codex:gpt-6.1-sol"]), undefined, "no pin outside shadow mode");
  for (const value of ["nope:model", "codex:", ":model", "codex"]) assert.equal(cal.reviewerModelPin([REVIEWER_SHADOW_FLAG, cal.REVIEWER_MODEL_PIN_FLAG, value]), undefined, value);
  assert.equal(cal.reviewerModelPin([REVIEWER_SHADOW_FLAG]), undefined);
});

test("W1-T12145 criterion 6 a subscription case starts only while the fleet is idle below 80% of every window, a cash case only inside $25 a week, and a refusal writes one row", async (t) => {
  const h = history(20, 20);
  const busy = { ...IDLE, liveness: { state: "up" as const } };
  const hot = { ...IDLE, headroom: { ...IDLE.headroom, weekly: [{ label: "all models", percentUsed: 30 }, { label: "sonnet", percentUsed: 85 }] } };
  for (const [signal, reason] of [
    [busy, /^refusing to replay: the fleet is up and not in quiet mode/],
    [hot, /^refusing to replay: weekly \(sonnet\) is at 85% \(limit 80%\)$/],
    [{}, /^refusing to replay: fleet idleness was not measured$/],
  ] as const) {
    const fake = await frozenEpoch(t, h, [SONNET, SOL], { idle: () => signal });
    const pass = await cal.scoreReviewersAgainstKnownAnswers(fake.ports);
    assert.equal(fake.runs.length, 0, "no subscription case starts");
    assert.equal(pass.ran, 0);
    const refused = refusals(fake.rows);
    assert.equal(refused.length, 1, "one row, before any spend");
    assert.match(String(refused[0]!.reason), reason);
    assert.equal(refused[0]!.billing, "subscription");
  }
  const idle = await frozenEpoch(t, h, [SONNET]);
  assert.equal((await cal.scoreReviewersAgainstKnownAnswers(idle.ports)).ran, 40, "idle and below 80%: it runs");

  // Cash: the last 7 days of cash cases, across epochs, plus this case's reservation, must fit $25.
  const prior = (costUsd: number | null, agoMs: number): Row => ({ step: cal.REVIEW_CALIBRATION_CASE_STEP, epoch: 0, case_id: "old", kind: "control",
    provider: "cash", model: "cash-haiku", verdict: "PASS", cost_usd: costUsd, duration_ms: 1, at: new Date(T0 - agoMs).toISOString(), incumbent: false });
  const full = await frozenEpoch(t, h, [SONNET, CASH], { rows: [prior(24.5, DAY), prior(400, 8 * DAY)] });
  await cal.scoreReviewersAgainstKnownAnswers(full.ports);
  assert.equal(full.runs.filter((r) => r.m === CASH).length, 0, "$24.50 spent + $1 reserved > $25: no cash case starts");
  assert.equal(full.runs.filter((r) => r.m === SONNET).length, 40, "the subscription model is gated apart");
  const capRefusals = refusals(full.rows);
  assert.equal(capRefusals.length, 1);
  assert.equal(capRefusals[0]!.reason, "the evaluator cap would be exceeded: $24.50 spent in 7 days + $1.00 reserved > $25");
  const room = await frozenEpoch(t, h, [CASH], { rows: [prior(22, DAY), prior(null, 2 * DAY)], result: (c) => ({ verdict: c.expected, costUsd: 1.5 }) });
  await cal.scoreReviewersAgainstKnownAnswers(room.ports);
  assert.equal(room.runs.length, 1, "$22 + an unread cost at its $1 reservation leaves room for one case");
  assert.equal(refusals(room.rows)[0]!.reason, "the evaluator cap would be exceeded: $24.50 spent in 7 days + $1.00 reserved > $25",
    "the case's read cost replaces its reservation");
  const spent = room.rows.filter((r) => r.step === cal.REVIEW_CALIBRATION_CASE_STEP && r.provider === "cash").reduce((a, r) => a + (typeof r.cost_usd === "number" ? r.cost_usd : 1), 0);
  assert.ok(spent <= cal.EVALUATOR_CASH_CAP_USD, `cash spend ${spent} stays inside the cap`);
});

test("W1-T12145 criterion 7 the protocol is registered before the first case of an epoch, so its eval card carries no pre-registration blocker", async (t) => {
  const h = history(20, 20);
  // The freezing pass has cases it could start at the freeze's own instant; it starts none.
  const fake = await frozenEpoch(t, h, [SONNET, SOL]);
  assert.equal(fake.first.ran, 0);
  assert.equal(fake.runs.length, 0);
  const trial = fake.epoch.trial;
  assert.equal(trial.preRegisteredAt, fake.epoch.frozenAt);
  assert.equal(trial.registeredProtocolHash, cal.calibrationEvalCard(fake.epoch, []).preRegistration.protocolHash);
  for (const part of ["alpha 0.05", "mixing variance 0.25", "below 80%", "$25 per 7 days", "escaped defect (right verdict FAIL)"]) {
    assert.ok(String(trial.protocolText).includes(part), part);
  }
  await cal.scoreReviewersAgainstKnownAnswers(fake.ports);
  const runs = fake.rows.map(cal.calibrationRunFromRow).filter((r): r is cal.CalibrationRun => r !== undefined);
  assert.equal(runs.length, 80);
  const card = cal.calibrationEvalCard(fake.epoch, runs);
  assert.deepEqual(card.blockers, []);
  assert.equal(card.preRegistration.precedesFirstAssignment, true);
  assert.ok(!card.deviations.some((d) => d.kind === "crossover"), "a case reviewed by two models is two units, not a crossover");
  // The control: a first case at the registration instant is a blocker, so the card can say so.
  const atFreeze = runs.map((r) => ({ ...r, at: fake.epoch.frozenAt }));
  assert.deepEqual(cal.calibrationEvalCard(fake.epoch, atFreeze).blockers, ["pre-registration-postdates-first-assignment"]);
});

test("W1-T12145 criterion 8 a model pair the always-valid sequential test reads decided gets no more cases that epoch, and the row records why it stopped", async (t) => {
  const h = history(20, 20);
  // Sonnet detects every escaped defect and Sol none; both pass every control.
  const result = (c: cal.CalibrationCase, m: cal.CalibrationModel): cal.CalibrationCaseResult =>
    ({ verdict: c.kind === "control" ? "PASS" : m === SONNET ? "FAIL" : "PASS", costUsd: 0.25 });
  const fake = await frozenEpoch(t, h, [SONNET, SOL], { result });
  const pass = await cal.scoreReviewersAgainstKnownAnswers(fake.ports);
  const escapedRuns = (m: cal.CalibrationModel) => fake.runs.filter((r) => r.m === m && r.c.kind === "escaped-defect").length;
  const decided = pass.decisions.find((d) => d.decided)!;
  assert.deepEqual([decided.metric, decided.better], ["escaped-detection", "claude:claude-sonnet-5-5"]);
  assert.ok(decided.pValue <= cal.CALIBRATION_ALPHA);
  assert.ok(escapedRuns(SONNET) < 20, "the decided metric stopped before the epoch's escaped defects ran out");
  assert.equal(escapedRuns(SOL), escapedRuns(SONNET));
  assert.equal(decided.casesSpent, escapedRuns(SONNET));
  assert.equal(fake.runs.filter((r) => r.c.kind === "control").length, 40, "the undecided metric keeps every case");
  const stop = { pair: ["claude:claude-sonnet-5-5", "codex:gpt-6.1-sol"], metric: "escaped-detection", decision: "decided: claude:claude-sonnet-5-5 is right more often",
    p_value: decided.pValue, cases_spent: decided.casesSpent };
  for (const row of scored(fake.rows).slice(-2)) assert.deepEqual(row.stopped, [stop]);

  // A later pass that lost the case rows still reads the decision off the result rows and spends nothing on it.
  const later = fakePorts({ ...h, models: [SONNET, SOL], stateDir: fake.ports.stateDir, rows: scored(fake.rows), result, nowMs: T0 + DAY });
  await cal.scoreReviewersAgainstKnownAnswers(later.ports);
  assert.equal(later.runs.filter((r) => r.c.kind === "escaped-defect").length, 0);
  assert.equal(cal.decidedFromResultRows([{ outcome: "scored", epoch: 1, stopped: [{ pair: "x" }, { pair: ["a", "b"], metric: "control-false-fail", decision: 7 }] }], 1)
    .get("a|b\0control-false-fail")?.better, undefined);
  assert.equal(cal.modelNeedsMetric(SONNET, "escaped-detection", [], [SONNET]), true, "one model has no pair and keeps scoring");
});

test("W1-T12145 the calibration rows come from the whole ledger union, and a union with an unreadable archive refuses the pass", async (t) => {
  const root = ownedFixtureDir(t, "w1t12145-union").dir;
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const line = (row: Row) => JSON.stringify({ ts: "2026-11-01T00:00:00.000Z", ...row });
  writeFileSync(join(stateDir, "ledger.2026-11-02T00-00-00-000Z.ndjson.gz"), gzipSync(line({ step: VERDICT_OUTCOME_STEP, task_id: "W1-T1", head_sha: "a", outcome: "clean" }) + "\n"));
  writeFileSync(join(stateDir, "ledger.ndjson"), [
    line({ step: cal.REVIEW_CALIBRATION_CASE_STEP, epoch: 1, case_id: "c1" }),
    line({ step: cal.REVIEW_CALIBRATION_RESULT_STEP, outcome: "scored", epoch: 1 }),
    line({ step: "review.posted", head_sha: "a", ts: new Date(T0).toISOString(), state: "success", pr_url: "https://github.com/acme/remudero/pull/1",
      evaluator_provenance: { provider: "claude", requestedModel: SONNET.model } }),
    line({ step: "sweep.summary" }),
  ].join("\n") + "\n");
  assert.deepEqual(readReviewerCalibrationRows(stateDir).map((r) => r.step),
    [VERDICT_OUTCOME_STEP, cal.REVIEW_CALIBRATION_CASE_STEP, cal.REVIEW_CALIBRATION_RESULT_STEP, "review.posted"]);
  const ports = buildReviewerCalibrationPorts({ root } as Config, fixedClock(T0));
  assert.deepEqual(await ports.readPriorRows(), {
    cases: [{ ts: "2026-11-01T00:00:00.000Z", step: cal.REVIEW_CALIBRATION_CASE_STEP, epoch: 1, case_id: "c1" }],
    results: [{ ts: "2026-11-01T00:00:00.000Z", step: cal.REVIEW_CALIBRATION_RESULT_STEP, outcome: "scored", epoch: 1 }],
  });
  assert.deepEqual(await ports.models(), [SONNET]);
  assert.equal((await ports.readOutcomes()).length, 1);
  assert.equal((await ports.readReviewedHeads()).get("a")?.prUrl, "https://github.com/acme/remudero/pull/1");

  writeFileSync(join(stateDir, "ledger.2026-11-03T00-00-00-000Z.ndjson.gz"), "not gzip");
  assert.throws(() => readReviewerCalibrationRows(stateDir), /is incomplete; unread: .*ledger\.2026-11-03T00-00-00-000Z\.ndjson\.gz/);
  const refused = await cal.scoreReviewersAgainstKnownAnswers(buildReviewerCalibrationPorts({ root } as Config, fixedClock(T0)));
  assert.equal(refused.epoch, null);
  assert.match(refused.refused[0]!, /^the ledger could not be read whole, so no case runs on a short count of earlier cases and spend: /);
  const written = readFileSync(join(stateDir, "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Row).at(-1)!;
  assert.deepEqual([written.step, written.outcome, written.task_id, written.lane], [cal.REVIEW_CALIBRATION_RESULT_STEP, "refused", "REVIEWER-CALIBRATION", "measurement-cadence"]);
  assert.match(String(written.run_id), /^REVIEWER-CALIBRATION-\d+$/);
});

test("W1-T12145 the idle signal reads the fleet's liveness and usage, and an unreadable liveness ledger is no measurement", async (t) => {
  const usage = { billingMode: "subscription" as const, weekly: [{ label: "all models", percentUsed: 40 }] };
  const usageDeps = { viaSdk: async () => usage, viaCli: () => undefined };
  const missing = join(ownedFixtureDir(t, "w1t12145-idle-missing").dir, "state");
  const unmeasured = await readReviewerCalibrationIdle(missing, { root: missing } as Config, fixedClock(T0), usageDeps);
  assert.deepEqual(unmeasured, { headroom: usage });
  assert.match(replayIdleGate(unmeasured, cal.IDLE_LIMIT_PCT).reason, /fleet idleness was not measured/);
  const stateDir = ownedFixtureDir(t, "w1t12145-idle").dir;
  writeFileSync(join(stateDir, "ledger.ndjson"), JSON.stringify({ ts: new Date(T0 - 60_000).toISOString(), step: "sweep.summary", poll_interval_ms: 60_000 }) + "\n");
  const measured = await readReviewerCalibrationIdle(stateDir, { root: stateDir } as Config, fixedClock(T0), { viaSdk: async () => undefined, viaCli: () => undefined });
  assert.equal(measured.liveness?.state, "up");
  assert.equal(measured.headroom, undefined);
});

test("W1-T12145 a case result is a verdict only at the case's head from the pinned model's finished review; anything else is null with its reason", async () => {
  const head = sha("h");
  const c = { headSha: head };
  const verdictRow = (over: Row = {}): Row => ({ step: "shadow.review.shadow_verdict", state: "success", head_sha: head, reviewer_outcome: "success", ...over });
  const reviewer: Row = { step: "shadow.review.reviewer", provider: "codex", model: SOL.model, total_cost_usd: 0.3 };
  assert.deepEqual(cal.calibrationCaseResult(c, SOL, [reviewer, verdictRow()], { code: 0 }), { verdict: "PASS", costUsd: 0.3 });
  assert.deepEqual(cal.calibrationCaseResult(c, SOL, [], { code: undefined, failure: "fetch failed" }),
    { verdict: null, costUsd: null, reason: "the review could not run: fetch failed" });
  assert.deepEqual(cal.calibrationCaseResult(c, SOL, [], { code: undefined }), { verdict: null, costUsd: null, reason: "the review could not run" });
  assert.deepEqual(cal.calibrationCaseResult(c, SOL, [reviewer], { code: 2 }), { verdict: null, costUsd: 0.3, reason: "the review exited 2 with no shadow verdict" });
  assert.equal(cal.calibrationCaseResult(c, SOL, [reviewer, verdictRow({ head_sha: sha("x") })], { code: 0 }).reason, `the review judged ${sha("x")}, not the case's head`);
  assert.equal(cal.calibrationCaseResult(c, SONNET, [reviewer, verdictRow()], { code: 0 }).reason, "the review ran codex:gpt-6.1-sol, not the pinned claude:claude-sonnet-5-5");
  assert.equal(cal.calibrationCaseResult(c, SOL, [verdictRow()], { code: 0 }).reason, "the review ran no reviewer, not the pinned codex:gpt-6.1-sol");
  assert.equal(cal.calibrationCaseResult(c, SOL, [reviewer, verdictRow({ reviewer_outcome: "error_max_turns" })], { code: 0 }).reason, "the reviewer's outcome was error_max_turns");
  assert.equal(cal.calibrationCaseResult(c, SOL, [reviewer, verdictRow({ state: "pending" })], { code: 0 }).reason, "the shadow verdict was pending");

  const base = { caseId: head, taskId: "W1-T1", headSha: head, mergeSha: head, kind: "control" as const, expected: "PASS" as const, risk: "low", prNumber: 1 };
  const io = { run: async () => assert.fail("never started"), readAttemptRows: () => [], attemptId: "review-PR1-x", clock: fixedClock(T0) };
  assert.deepEqual(await runReviewerCalibrationCase({ ...base, prUrl: "not a url" }, SOL, { ...io, originMainSha: () => "m" }),
    { verdict: null, costUsd: null, reason: "the case's pull request URL not a url names no repository" });
  assert.deepEqual(await runReviewerCalibrationCase({ ...base, prUrl: "https://github.com/acme/remudero/pull/1" }, SOL, { ...io, originMainSha: () => { throw new Error("no origin"); } }),
    { verdict: null, costUsd: null, reason: "origin/main could not be read: no origin" });
});

test("W1-T12145 the production ports run a case through the fresh-tree runner and the real review spawn, read its rows by attempt id, and log to the ledger", async (t) => {
  const root = ownedFixtureDir(t, "w1t12145-ports").dir;
  mkdirSync(join(root, "state"), { recursive: true });
  const ledger = join(root, "state", "ledger.ndjson");
  const argsFile = join(root, "args.txt");
  const main = sha("origin-main");
  const head = sha("case-head");
  const bin = join(root, "worktrees", `reviewer-${main.slice(0, 12)}`, "bin");
  mkdirSync(bin, { recursive: true });
  const row = (fields: string) => `echo "{\\"ts\\":\\"2026-11-22T00:00:01.000Z\\",\\"review_attempt_id\\":\\"$attempt\\",${fields}}" >> ${JSON.stringify(ledger)}`;
  writeFileSync(join(bin, "rmd"), [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`,
    'attempt=""; prev=""',
    'for a in "$@"; do if [ "$prev" = "--review-attempt-id" ]; then attempt="$a"; fi; prev="$a"; done',
    row('\\"step\\":\\"shadow.review.reviewer\\",\\"provider\\":\\"codex\\",\\"model\\":\\"gpt-6.1-sol\\",\\"total_cost_usd\\":0.25'),
    row(`\\"step\\":\\"shadow.review.shadow_verdict\\",\\"state\\":\\"failure\\",\\"head_sha\\":\\"${head}\\",\\"reviewer_outcome\\":\\"success\\"`),
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(join(bin, "rmd"), 0o755);
  const ports = buildReviewerCalibrationPorts({ root } as Config, fixedClock(T0), {
    review: {
      git: (args) => (args.includes("rev-parse") ? `${main}\n` : ""), addWorktree: () => {}, inspectExistingWorktree: () => "reusable",
      prepareWorktree: () => true, spawnReview: spawnRmdReviewForFreshTree, worktreeRoot: join(root, "worktrees"),
    },
  });
  const c: cal.CalibrationCase = { caseId: head, taskId: "W1-T9", headSha: head, mergeSha: sha("m"), kind: "escaped-defect", expected: "FAIL", risk: "high",
    prNumber: 8, prUrl: "https://github.com/acme/remudero/pull/8" };
  assert.deepEqual(await ports.runCase(c, SOL), { verdict: "FAIL", costUsd: 0.25 });
  const args = readFileSync(argsFile, "utf8").trim().split("\n");
  assert.equal(args[args.indexOf("review") + 1], "8");
  assert.ok(args.includes(REVIEWER_SHADOW_FLAG));
  assert.equal(args[args.indexOf(cal.CALIBRATION_HEAD_FLAG) + 1], head);
  assert.equal(args[args.indexOf(cal.REVIEWER_MODEL_PIN_FLAG) + 1], "codex:gpt-6.1-sol");
  assert.match(args[args.indexOf("--review-attempt-id") + 1]!, /^review-PR8-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(args[args.indexOf("--repo") + 1], "acme/remudero");
  assert.equal(ports.casesPerPass > 0 && ports.cashCaseReserveUsd > 0, true);
});
