// test/a-paired-dispatch-trial-shares-one-grader.test.ts — W1-T4625: the paired design of the approved paid
// pilot. Every case runs in an rmd- temp state dir with a fixed clock, a fake attempt dispatcher and a fake or
// grep-only grader: nothing here reads a real ledger, spawns a real worker or spends.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildBenchmarkAaReport, parseAaTrialManifest, type AaLedgerEvidence, type AaRow,
  type BenchmarkAaReport } from "../src/lib/benchmark-aa.js";
import {
  activateBenchmarkPaidPilot, activePaidPilotProtocols, benchmarkPaidPilotCommand, loadPaidPilotProtocol, pairedSampleDraw,
  paidPilotArmAdmission, parsePaidPilotRequest, readPaidPilotControls, readPaidPilotEvidence, summarizePaidPilotSpend,
  PAIRED_UNCERTAINTY_METHOD, type PaidPilotArm, type PaidPilotEvidence, type PaidPilotProtocol, type PaidPilotRow,
  type PairedTrialRowFields,
} from "../src/lib/benchmark-paid-pilot.js";
import type { Clock } from "../src/lib/clock.js";
import type { Config } from "../src/lib/config.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import {
  buildPairedPilotReport, gradeHeadWithReviewerExecutor, mcnemarExact, pairedAttemptOrder, pairedDifference, pairedPilotReportView,
  pairedStackEvidence, runPairedTrial, type GradedPair, type PairedAttemptRequest, type PairedAttemptResult, type PairedGrade,
  type PairedTrialInput, type PairedTrialResult,
} from "../src/lib/paired-trial.js";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import type { TaskCaseFile } from "../src/lib/task-case-file.js";
import type { spawnWorker, WorkerResult, WorkerSelectionAssignment } from "../src/lib/worker.js";
import { HANDLERS, runTask } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const SHA = "a".repeat(40);
const OTHER_SHA = "c".repeat(40);
const AA_NOW = "2026-09-27T12:10:00.000Z";
const ACT = "2026-09-27T13:00:00.000Z";
const DURING = "2026-09-28T13:00:00.000Z";
const AFTER_ANALYSIS = "2026-10-19T13:00:00.000Z";
const CONSENTED = ["fixture-org/alpha", "fixture-org/beta", "fixture-org/gamma"];
const PAID_PIN = { provider: "cash", model: "gpt-oss-120b", effort: "medium" };
const CONTROL_PIN = { provider: "claude", model: "claude-sonnet-5", effort: "high" };
const REVISION_NAMES = ["harnessRevision", "promptRevision", "toolRevision", "scorerRevision", "environmentRevision"];
const HARNESS = { source: "executing-module-git" as const, revision: SHA };
const CRITERIA: AcceptanceCriterion[] = [
  { claim: "the visible marker ships", proof: "grep: PAIRED-OK in notes.txt" },
  { claim: "the hidden marker ships", proof: "grep: HOLDOUT-OK in holdout.txt", holdout: true },
];
type Row = Record<string, unknown>;

function pilotRequest(changes: Record<string, unknown> = {}, taskIds: string[] = Array.from({ length: 12 }, (_, i) => `PP-T${i + 1}`)) {
  return {
    version: "benchmark-paid-pilot-request-v1", pilotId: "paired-fixture-1",
    approval: { reference: "#7418", approvedAt: "2026-09-25T09:00:00.000Z" },
    repos: CONSENTED.map((repo, i) => ({ repo, consentReceipt: `consent-${i}` })),
    pseudonymSalt: "local-salt-7", assignmentSeed: "seed-paired-1",
    arms: { paid: PAID_PIN, control: CONTROL_PIN },
    revisions: Object.fromEntries(REVISION_NAMES.map((field) => [field, SHA])),
    strataRevision: "strata-v1",
    population: taskIds.map((taskId, i) => ({ taskId, repo: CONSENTED[i % 3], taskClass: "fix", risk: "low" })),
    primaryOutcome: "verified-completion", maturityDays: 14,
    protocolText: "Paired pilot: McNemar on discordant pairs, task unit, fixed horizon.\n",
    design: "paired", paired: { samplingRate: 1, maxPairs: 10, shadow: false },
    ...changes,
  };
}

function aaRow(step: string, taskId: string, ts: string): AaRow {
  const assignment = step === "worker.assignment";
  return { ts, step, taskId, runId: `${taskId}-1`, assignmentId: assignment ? `${taskId}-a1` : null,
    selectionAssignmentId: assignment ? null : `${taskId}-a1`, selected: { ...CONTROL_PIN },
    stack: Object.fromEntries(REVISION_NAMES.map((field) => [field, { state: "observed", value: SHA }])),
    work: { taskClass: "fix", risk: "low" }, recordedArm: null, routingExperiment: null, success: true,
    servedModel: CONTROL_PIN.model, billingMode: "subscription", costUsd: 0.5, tokensObserved: true, durationObserved: true, retract: false };
}

function caseFile(taskId: string, prNumber: number, asOf: string): TaskCaseFile {
  const at = <T>(value: T) => ({ state: "observed" as const, value, source: "fixture", asOf });
  const gone = (reason: string) => ({ state: "unavailable" as const, reason, source: "fixture", asOf });
  return {
    version: "task-case-file-v1", taskId, asOf,
    plan: at({ title: taskId, dependsOn: [], verify: "auto", risk: "low" }),
    ledger: at({ windowStart: "2026-08-28T12:10:00.000Z", forms: { gzip: 1, plain: 1, live: 1 }, matchingRows: 3 }),
    runs: [{ runId: `${taskId}-1`, startedAt: "2026-09-27T11:00:00.000Z", assignmentId: `${taskId}-a1`, selectedProvider: "claude",
      selectedModel: CONTROL_PIN.model, servedModel: CONTROL_PIN.model, billingMode: "subscription", costUsd: 0.5, verdict: "passed", prNumber }],
    pr: at({ number: prNumber, url: `https://example.invalid/pull/${prNumber}`, headSha: SHA, state: "MERGED", taskCredit: true }),
    review: at({ headSha: SHA, status: "success" as const }), acceptance: at({ headSha: SHA, status: "success" as const }),
    ci: at({ headSha: SHA, status: "success" as const }), mergedSource: at({ prNumber, mergedAt: asOf }),
    deployment: gone("not-collected"), runtime: gone("not-collected"), next: null,
  };
}

/** A clean benchmark-aa-v1 report from the real W1-T4575 builder, so activation cites the receipt production meets. */
function aaReport(): BenchmarkAaReport {
  const parsed = parseAaTrialManifest({ version: "benchmark-aa-trial-v1", trialId: "aa-fixture-1", cohort: { kind: "public-fixture" },
    stack: { ...CONTROL_PIN, ...Object.fromEntries(REVISION_NAMES.map((field) => [field, SHA])) }, strataRevision: "strata-v1",
    tasks: Array.from({ length: 10 }, (_, i) => ({ taskId: `AA-T${i + 1}`, taskClass: "fix", risk: "low" })) });
  assert.ok(parsed.ok);
  const ids = parsed.manifest.tasks.map((task) => task.taskId);
  const rows = ids.flatMap((taskId, i) => [aaRow("worker.assignment", taskId, `2026-09-27T11:0${i}:00.000Z`),
    aaRow("verdict", taskId, `2026-09-27T11:0${i}:30.000Z`)]);
  const evidence: AaLedgerEvidence = { state: "observed", forms: { gzip: 0, plain: 0, live: 1 }, unreadSources: [], malformedRows: 0,
    duplicateRows: 0, ledgerAssignments: ids.length, newestTs: "2026-09-27T11:09:30.000Z", rows };
  return buildBenchmarkAaReport({ manifest: parsed.manifest, evidence, nowIso: AA_NOW, caseFiles: ids.map((taskId, i) => caseFile(taskId, 500 + i, AA_NOW)) });
}

function pairedProtocol(changes: Record<string, unknown> = {}, taskIds?: string[]): PaidPilotProtocol {
  const parsed = parsePaidPilotRequest(pilotRequest(changes, taskIds));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  const result = activateBenchmarkPaidPilot({ request: parsed.request, aaReport: aaReport(), nowIso: ACT, existing: [] });
  assert.ok(result.ok, result.ok ? "" : result.reason);
  return result.protocol;
}

async function verb(args: string[], nowIso: string, withPairedReport = true): Promise<{ code: number; printed: string[] }> {
  const printed: string[] = [];
  const code = await benchmarkPaidPilotCommand(args, activateBenchmarkPaidPilot, { nowIso, print: (line) => printed.push(line),
    resolveStateDir: () => { throw new Error("tests always pass --state-dir"); }, ...(withPairedReport ? { pairedReport: pairedPilotReportView } : {}) });
  return { code, printed };
}

/** A temp state dir holding an empty live ledger, plus the activated protocol when `request` is given. */
async function stateWith(request?: Record<string, unknown>): Promise<{ dir: string; stateDir: string; protocol: PaidPilotProtocol | null }> {
  const dir = mkdtempSync(join(tmpdir(), "rmd-paired-trial-"));
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ledger.ndjson"), "");
  if (request === undefined) return { dir, stateDir, protocol: null };
  writeFileSync(join(dir, "request.json"), JSON.stringify(request));
  writeFileSync(join(dir, "aa.json"), JSON.stringify(aaReport()));
  const { code, printed } = await verb(["activate", "--request", join(dir, "request.json"), "--aa-report", join(dir, "aa.json"),
    "--state-dir", stateDir], ACT);
  assert.equal(code, 0, printed.join("\n"));
  const loaded = loadPaidPilotProtocol(stateDir, String(request.pilotId));
  assert.ok(loaded.ok);
  return { dir, stateDir, protocol: loaded.protocol };
}

/** Appends every trial row to the temp live ledger under a monotonic fake clock, and keeps a copy. */
function rowWriter(stateDir: string) {
  let tick = 0;
  const rows: Row[] = [];
  const now = () => new Date(Date.parse(DURING) + tick * 1000).toISOString();
  const write = (taskId: string) => (step: string, fields: Record<string, unknown>) => {
    tick += 1;
    const row = { ts: now(), run_id: `${taskId}-run`, task_id: taskId, step, ...fields };
    rows.push(row);
    appendFileSync(join(stateDir, "ledger.ndjson"), `${JSON.stringify(row)}\n`);
  };
  return { rows, now, write };
}

function recordingDispatch(calls: PairedAttemptRequest[], overrides: Partial<Record<PaidPilotArm, Partial<PairedAttemptResult>>> = {},
  heads: Partial<Record<PaidPilotArm, string>> = {}) {
  return async (request: PairedAttemptRequest): Promise<PairedAttemptResult> => {
    calls.push(request);
    return { headDir: heads[request.arm] ?? `/heads/${request.arm}`, headSha: SHA, servedModel: request.pin.model,
      billingMode: request.arm === "paid" ? "api" : "subscription", costUsd: request.arm === "paid" ? 1.25 : 0.8,
      ...overrides[request.arm] };
  };
}

function gradeOf(verdict: PairedGrade["verdict"]): PairedGrade {
  return { verdict, passed: verdict === "pass" ? 2 : 0, failed: verdict === "fail" ? 1 : 0, unmeasurable: verdict === "unmeasurable" ? 1 : 0,
    holdouts: 1, reasons: [] };
}

function byHead(verdicts: Record<string, PairedGrade["verdict"]>, seen: string[] = []) {
  return ({ headDir }: { headDir: string }) => { seen.push(headDir); return gradeOf(verdicts[headDir] ?? "unmeasurable"); };
}

function trialInput(stateDir: string, writer: ReturnType<typeof rowWriter>, taskId: string, rest: Partial<PairedTrialInput> = {}): PairedTrialInput {
  return { task: { id: taskId, acceptance: CRITERIA }, lane: "implement", stateDir, log: writer.write(taskId), clock: clockAt(writer.now),
    harnessRevision: HARNESS, ...rest };
}

const clockAt = (iso: () => string): Clock => ({ iso, now: () => Date.parse(iso()), date: () => new Date(iso()) });
const stepRows = (rows: Row[], step: string) => rows.filter((row) => row.step === step);
const trialOf = (row: Row | undefined) => (row?.paired_trial ?? {}) as Record<string, unknown>;

test("inert without a protocol: no row, no read of a pilot, no spawn", async () => {
  const empty = await stateWith();
  const writer = rowWriter(empty.stateDir);
  const calls: PairedAttemptRequest[] = [];
  const settled: PairedTrialResult[] = [];
  const result = await runPairedTrial(trialInput(empty.stateDir, writer, "PP-T1", { dispatchAttempt: recordingDispatch(calls),
    settled: (outcome) => settled.push(outcome) }));
  assert.deepEqual(result, { state: "inert" });
  assert.deepEqual(settled, [{ state: "inert" }], "the observer hears the same answer the caller gets");
  assert.equal(writer.rows.length, 0, "an inert trial writes no ledger row");
  assert.equal(calls.length, 0, "an inert trial spawns nothing");
  assert.equal(readFileSync(join(empty.stateDir, "ledger.ndjson"), "utf8"), "");

  const unpaired = await stateWith(pilotRequest({ pilotId: "unpaired-1", design: undefined, paired: undefined }));
  assert.equal(unpaired.protocol!.design, "unpaired", "unpaired stays the default design");
  assert.equal(unpaired.protocol!.paired, null);
  const unpairedWriter = rowWriter(unpaired.stateDir);
  assert.deepEqual(await runPairedTrial(trialInput(unpaired.stateDir, unpairedWriter, "PP-T1", { dispatchAttempt: recordingDispatch(calls) })),
    { state: "inert" }, "an active unpaired protocol never pairs");
  assert.equal(unpairedWriter.rows.length + calls.length, 0);

  const expired = await stateWith(pilotRequest({ pilotId: "expired-1" }));
  const late = rowWriter(expired.stateDir);
  assert.deepEqual(await runPairedTrial(trialInput(expired.stateDir, late, "PP-T1", { clock: clockAt(() => AFTER_ANALYSIS),
    dispatchAttempt: recordingDispatch(calls) })), { state: "inert" }, "an expired paired protocol is not active");
  assert.deepEqual(activePaidPilotProtocols(join(empty.dir, "no-such-state"), DURING), [], "an unreadable state dir proves no pilot active");
  assert.equal(late.rows.length + calls.length, 0);
});

test("shadow records without spawning, and the pilot report shows the shadow decisions", async () => {
  const shadow = await stateWith(pilotRequest({ pilotId: "shadow-1", paired: { samplingRate: 0.5, maxPairs: 10, shadow: true } }));
  const protocol = shadow.protocol!;
  assert.equal(protocol.paired!.shadow, true);
  assert.equal(protocol.uncertaintyMethod, PAIRED_UNCERTAINTY_METHOD);
  const writer = rowWriter(shadow.stateDir);
  const calls: PairedAttemptRequest[] = [];
  const results: PairedTrialResult[] = [];
  for (const task of protocol.population) {
    results.push(await runPairedTrial(trialInput(shadow.stateDir, writer, task.taskId, { dispatchAttempt: recordingDispatch(calls) })));
  }
  assert.equal(calls.length, 0, "shadow mode never calls the attempt dispatcher, even with one wired");
  assert.deepEqual(stepRows(writer.rows, "paired_trial.spawn"), [], "no spawn marker, so no spend");
  assert.ok(results.every((result) => result.state === "shadow"));
  const decisions = stepRows(writer.rows, "paired_trial.decision");
  assert.equal(decisions.length, protocol.population.length, "every eligible task's decision is recorded");
  const sampled = decisions.filter((row) => trialOf(row).sampled === true);
  assert.ok(sampled.length > 0 && sampled.length < decisions.length, "a 0.5 rate samples some tasks and not others");
  for (const row of decisions) {
    const decision = trialOf(row);
    assert.equal(decision.shadow, true);
    assert.equal(decision.sampled, pairedSampleDraw(protocol.assignment.seed, String(row.task_id)) < 0.5);
    assert.deepEqual(decision.order, pairedAttemptOrder(protocol, String(row.task_id)));
    assert.equal(decision.admitted, decision.sampled, "a sampled shadow task reports whether admission WOULD pass");
  }
  const report = await verb(["report", "--pilot", "shadow-1", "--state-dir", shadow.stateDir, "--json"], DURING);
  assert.equal(report.code, 0, report.printed.join("\n"));
  const parsed = JSON.parse(report.printed[0]!) as ReturnType<typeof buildPairedPilotReport>;
  assert.equal(parsed.shadow, true);
  assert.equal(parsed.decisions.eligible, decisions.length);
  assert.equal(parsed.decisions.sampled, sampled.length);
  assert.equal(parsed.decisions.admitted, sampled.length);
  assert.equal(parsed.decisions.order.paidFirst + parsed.decisions.order.controlFirst, sampled.length);
  assert.equal(parsed.decisions.refusedBy["not-sampled"], decisions.length - sampled.length);
  assert.equal(parsed.cash.spend!.cashEstimateUsd, 0);
  assert.deepEqual(parsed.pairs, []);
  const text = await verb(["report", "--pilot", "shadow-1", "--state-dir", shadow.stateDir], DURING);
  assert.match(text.printed[0]!, /SHADOW \(no spawn, no spend\)/);
  assert.match(text.printed.join("\n"), new RegExp(`${sampled.length} sampled`));

  const live = pilotRequest({ pilotId: "live-1" });
  writeFileSync(join(shadow.dir, "live.json"), JSON.stringify(live));
  const alongside = await verb(["activate", "--request", join(shadow.dir, "live.json"), "--aa-report", join(shadow.dir, "aa.json"),
    "--state-dir", shadow.stateDir], ACT);
  assert.equal(alongside.code, 0, "a shadow pilot does not block the live activation that follows it");
  writeFileSync(join(shadow.dir, "shadow2.json"), JSON.stringify(pilotRequest({ pilotId: "shadow-2", paired: { samplingRate: 1, maxPairs: 1, shadow: true } })));
  const second = await verb(["activate", "--request", join(shadow.dir, "shadow2.json"), "--aa-report", join(shadow.dir, "aa.json"),
    "--state-dir", shadow.stateDir], ACT);
  assert.equal(second.code, 2);
  assert.match(second.printed.join("\n"), /another-pilot-active/);
  const both = activePaidPilotProtocols(shadow.stateDir, DURING).map((entry) => entry.pilotId).sort();
  assert.deepEqual(both, ["live-1", "shadow-1"]);
  const liveWriter = rowWriter(shadow.stateDir);
  const liveResult = await runPairedTrial(trialInput(shadow.stateDir, liveWriter, "PP-T1"));
  assert.equal(liveResult.state === "refused" && liveResult.pilotId, "live-1", "a live protocol wins over a shadow one");
});

test("pause blocks new pairs; in-flight attempts finish; admission is re-read before the paid spawn", async () => {
  const { stateDir, protocol } = await stateWith(pilotRequest());
  const writer = rowWriter(stateDir);
  const calls: PairedAttemptRequest[] = [];
  const paused = await verb(["pause", "--pilot", "paired-fixture-1", "--state-dir", stateDir, "--note", "operator check"], DURING);
  assert.equal(paused.code, 0);
  assert.match(paused.printed[0]!, /paused at .*in-flight attempts finish/);
  assert.equal(readPaidPilotControls(stateDir, "paired-fixture-1").paused, true);
  const held = await runPairedTrial(trialInput(stateDir, writer, "PP-T1", { dispatchAttempt: recordingDispatch(calls), grade: byHead({}) }));
  assert.equal(held.state, "refused");
  assert.ok(held.state === "refused" && held.reasons.includes("operator-paused"));
  assert.equal(calls.length, 0, "a paused pilot starts no new pair");
  const admission = paidPilotArmAdmission({ protocol: protocol!, lane: "implement", taskId: "PP-T2", nowIso: DURING,
    evidence: await readPaidPilotEvidence(stateDir, protocol!), controls: readPaidPilotControls(stateDir, "paired-fixture-1") });
  assert.equal(admission.paidArm, "paused");
  assert.equal(admission.ordinaryFlow, "continues", "a pause holds the paid arm only");

  assert.equal((await verb(["resume", "--pilot", "paired-fixture-1", "--state-dir", stateDir], DURING)).code, 0);
  const controls = readPaidPilotControls(stateDir, "paired-fixture-1");
  assert.deepEqual([controls.paused, controls.entries, controls.lastAction], [false, 2, "resume"], "the control file is append-only");

  const controlFirst = protocol!.population.find((task) => pairedAttemptOrder(protocol!, task.taskId)[0] === "control" && task.taskId !== "PP-T1")!;
  const pauseDuringControl = async (request: PairedAttemptRequest): Promise<PairedAttemptResult> => {
    calls.push(request);
    await verb(["pause", "--pilot", "paired-fixture-1", "--state-dir", stateDir], DURING);
    return { headDir: "/heads/control", headSha: SHA, servedModel: request.pin.model, billingMode: "subscription", costUsd: 0.8 };
  };
  const cut = await runPairedTrial(trialInput(stateDir, writer, controlFirst.taskId, { dispatchAttempt: pauseDuringControl,
    grade: byHead({ "/heads/control": "pass" }) }));
  assert.equal(cut.state, "unmeasurable");
  assert.equal(calls.length, 1, "the paid attempt never spawned once the pilot was paused");
  assert.equal(calls[0]!.arm, "control");
  assert.ok(cut.state === "unmeasurable" && cut.reasons.some((reason) => reason === "paid-admission-lost:operator-paused"));
  assert.deepEqual(cut.state === "unmeasurable" && cut.outcomes, { paid: "not-run", control: "pass" }, "the in-flight control attempt finished");

  assert.equal((await verb(["pause", "--pilot", "bad id!", "--state-dir", stateDir], DURING)).code, 2);
  const missing = await verb(["resume", "--pilot", "no-such-pilot", "--state-dir", stateDir], DURING);
  assert.equal(missing.code, 2);
  assert.match(missing.printed[0]!, /resume refused \(protocol-unreadable-or-not-activated\)/);
  mkdirSync(join(stateDir, "benchmark-paid-pilot-v1.live-2.controls.ndjson"), { recursive: true });
  writeFileSync(join(stateDir, "benchmark-paid-pilot-v1.live-2.protocol.json"), JSON.stringify({ protocol: { ...protocol, pilotId: "live-2" } }));
  const unwritable = await verb(["pause", "--pilot", "live-2", "--state-dir", stateDir], DURING);
  assert.deepEqual([unwritable.code, unwritable.printed[0]], [2, "benchmark-paid-pilot: pause refused (control-not-recorded)"]);
  assert.deepEqual([readPaidPilotControls(stateDir, "live-2").paused, readPaidPilotControls(stateDir, "live-2").reason], [true, "controls-unreadable"]);
  writeFileSync(join(stateDir, "benchmark-paid-pilot-v1.torn.controls.ndjson"), "{not json\n");
  assert.equal(readPaidPilotControls(stateDir, "torn").reason, "controls-malformed");
  writeFileSync(join(stateDir, "benchmark-paid-pilot-v1.other.controls.ndjson"), `${JSON.stringify({ version: "v0", pilotId: "other", action: "pause" })}\n`);
  assert.equal(readPaidPilotControls(stateDir, "other").reason, "controls-malformed");
  assert.equal(HANDLERS.get("benchmark-paid-pilot") !== undefined
    && await HANDLERS.get("benchmark-paid-pilot")!(["resume", "--pilot", "no-such-pilot", "--state-dir", stateDir]), 2);
});

test("both heads are graded by the reviewer's executor and neither is merged", async () => {
  const { dir, stateDir, protocol } = await stateWith(pilotRequest());
  const heads = { paid: join(dir, "head-paid"), control: join(dir, "head-control") };
  mkdirSync(heads.paid);
  mkdirSync(heads.control);
  writeFileSync(join(heads.paid, "notes.txt"), "PAIRED-OK\n");
  writeFileSync(join(heads.paid, "holdout.txt"), "HOLDOUT-OK\n");
  writeFileSync(join(heads.control, "notes.txt"), "PAIRED-OK\n");
  writeFileSync(join(heads.control, "holdout.txt"), "nothing here\n");
  const writer = rowWriter(stateDir);
  const calls: PairedAttemptRequest[] = [];
  const result = await runPairedTrial(trialInput(stateDir, writer, "PP-T3", { dispatchAttempt: recordingDispatch(calls, {}, heads) }));
  assert.equal(result.state, "measured");
  assert.ok(result.state === "measured");
  assert.deepEqual(result.outcomes, { paid: "pass", control: "fail" }, "the holdout, which the worker never saw, separated the heads");
  assert.equal(result.merged, false);
  assert.deepEqual(calls.map((call) => call.arm), pairedAttemptOrder(protocol!, "PP-T3"));
  for (const call of calls) {
    assert.deepEqual(call.isolation, { worktree: "fresh-detached", push: false, openPr: false, merge: false });
    assert.deepEqual(call.pin, protocol!.arms[call.arm], "each attempt runs on its own pinned arm");
    assert.deepEqual(call.revisions, protocol!.revisions, "both attempts share the pinned revisions");
  }
  const attempts = stepRows(writer.rows, "paired_trial.attempt");
  const graded = Object.fromEntries(attempts.map((row) => [trialOf(row).arm, trialOf(row).grade]));
  assert.deepEqual(graded.paid, { passed: 2, failed: 0, unmeasurable: 0, holdouts: 1 });
  assert.deepEqual(graded.control, { passed: 1, failed: 1, unmeasurable: 0, holdouts: 1 });
  const pair = trialOf(stepRows(writer.rows, "paired_trial.pair")[0]);
  assert.deepEqual([pair.merged, pair.pr_opened, pair.status], [false, false, "measured"]);
  assert.deepEqual(writer.rows.map((row) => row.step).filter((step) => !String(step).startsWith("paired_trial.")), [],
    "the trial writes no worker.assignment, pr, review or merge row");
  for (const spawn of stepRows(writer.rows, "paired_trial.spawn")) {
    const stack = (spawn.benchmark_run as { stack: Record<string, { state: string; value?: string }> }).stack;
    for (const field of REVISION_NAMES) assert.deepEqual(stack[field], { state: "observed", value: SHA }, `${field} is pinned`);
    assert.deepEqual(trialOf(spawn).stack_deviations, []);
  }
  const seen: { label: string; cwd: string }[] = [];
  const spied = gradeHeadWithReviewerExecutor([...CRITERIA, { claim: "prose", proof: "the tests pass" }], heads.paid, (whitelisted, cwd) => {
    seen.push({ label: whitelisted.label, cwd });
    return "pass";
  });
  assert.deepEqual(seen.map((entry) => entry.cwd), [heads.paid, heads.paid], "the holdout proof executes on the head too");
  assert.deepEqual([spied.verdict, spied.reasons[2]], ["unmeasurable", "proof-not-executable"], "prose is never a pass");
  assert.equal(gradeHeadWithReviewerExecutor(CRITERIA, heads.paid, () => "no-match").reasons[0], "named-test-not-found");
  assert.equal(gradeHeadWithReviewerExecutor(CRITERIA, heads.paid, () => { throw new Error("timeout"); }).verdict, "unmeasurable");
  assert.equal(gradeHeadWithReviewerExecutor([], heads.paid).verdict, "unmeasurable", "no criteria grades nothing");
});

test("an ungradeable pair is unmeasurable, never a loss for either arm", async () => {
  const { stateDir, protocol } = await stateWith(pilotRequest());
  const paidFirst = protocol!.population.filter((task) => pairedAttemptOrder(protocol!, task.taskId)[0] === "paid").map((task) => task.taskId);
  const controlFirst = protocol!.population.filter((task) => pairedAttemptOrder(protocol!, task.taskId)[0] === "control").map((task) => task.taskId);
  const writer = rowWriter(stateDir);
  const calls: PairedAttemptRequest[] = [];
  const ungradeable = await runPairedTrial(trialInput(stateDir, writer, controlFirst[0]!, { dispatchAttempt: recordingDispatch(calls),
    grade: byHead({ "/heads/control": "pass", "/heads/paid": "unmeasurable" }) }));
  assert.equal(ungradeable.state, "unmeasurable");
  assert.deepEqual(ungradeable.state === "unmeasurable" && ungradeable.outcomes, { control: "pass", paid: "unmeasurable" });
  assert.ok(ungradeable.state === "unmeasurable" && ungradeable.reasons.includes("ungradeable:paid"));
  const cases: [string, Partial<PairedTrialInput>, string][] = [
    [paidFirst[1]!, { dispatchAttempt: recordingDispatch(calls, { paid: { headDir: null } }) }, "no-head:paid"],
    [paidFirst[2]!, { dispatchAttempt: recordingDispatch(calls, { paid: { prUrl: "https://example.invalid/pull/9" } }) }, "isolation-breach:paid"],
    [paidFirst[3]!, { dispatchAttempt: recordingDispatch(calls), grade: () => { throw new Error("grader down"); } }, "grading-failed:paid"],
  ];
  const crashed = (taskId: string) => runPairedTrial(trialInput(stateDir, writer, taskId, { grade: byHead({}),
    dispatchAttempt: async (request) => { calls.push(request); throw new Error("worker crashed"); } }));
  for (const [taskId, seams, reason] of cases) {
    const before = calls.length;
    const result = await runPairedTrial(trialInput(stateDir, writer, taskId, { grade: byHead({}), ...seams }));
    assert.equal(result.state, "unmeasurable", reason);
    assert.ok(result.state === "unmeasurable" && result.reasons.includes(reason), reason);
    assert.ok(result.state === "unmeasurable" && result.reasons.includes("stopped-after-an-unmeasurable-attempt"));
    assert.equal(calls.length - before, 1, `${reason}: the second attempt is never paid for once the pair is unmeasurable`);
  }
  const cleaned = await runPairedTrial(trialInput(stateDir, writer, controlFirst[1]!, { grade: byHead({ "/heads/paid": "fail", "/heads/control": "fail" }),
    dispatchAttempt: recordingDispatch(calls, { control: { cleanup: () => { throw new Error("busy"); } } }) }));
  assert.equal(cleaned.state, "measured", "a failed cleanup is recorded but does not unmeasure a graded head");
  assert.ok(cleaned.state === "measured" && cleaned.reasons.includes("cleanup-failed:control"));
  const crash = await crashed(paidFirst[0]!);
  assert.ok(crash.state === "unmeasurable" && crash.reasons.includes("attempt-failed:paid") && crash.reasons.includes("stopped-after-an-unmeasurable-attempt"));
  const afterCrash = await crashed(paidFirst[4] ?? controlFirst[2]!);
  assert.ok(afterCrash.state === "refused" && afterCrash.reasons.includes("cost-evidence-ambiguous"),
    "a paid attempt that crashed with unknown spend holds every later pair");
  const evidence = await readPaidPilotEvidence(stateDir, protocol!);
  const report = buildPairedPilotReport({ protocol: protocol!, evidence, nowIso: AFTER_ANALYSIS });
  assert.equal(report.counts.unmeasurable, 5);
  assert.equal(report.counts.measured, 1);
  assert.deepEqual([report.mcnemar.paidOnly, report.mcnemar.controlOnly, report.mcnemar.bothFail], [0, 0, 1],
    "no unmeasurable pair counts as a discordant loss for the paid arm");
  assert.equal(report.winnerDeclared, false);
});

test("order randomisation is stable per task and drawn from the seed", async () => {
  const protocol = pairedProtocol();
  const again = pairedProtocol();
  const orders = protocol.population.map((task) => pairedAttemptOrder(protocol, task.taskId));
  assert.deepEqual(protocol.population.map((task) => pairedAttemptOrder(again, task.taskId)), orders, "a re-activation redraws identically");
  assert.ok(orders.some((order) => order[0] === "paid") && orders.some((order) => order[0] === "control"), "both orders occur");
  for (const [i, task] of protocol.population.entries()) {
    assert.equal(orders[i]![0], task.arm, "the registered draw names the arm that runs first");
    assert.deepEqual([...orders[i]!].sort(), ["control", "paid"]);
  }
  const reseeded = pairedProtocol({ assignmentSeed: "seed-paired-2" });
  assert.notDeepEqual(protocol.population.map((task) => pairedAttemptOrder(reseeded, task.taskId)), orders, "the seed, not the run, decides");
  const { stateDir } = await stateWith(pilotRequest());
  const writer = rowWriter(stateDir);
  const calls: PairedAttemptRequest[] = [];
  await runPairedTrial(trialInput(stateDir, writer, "PP-T5", { dispatchAttempt: recordingDispatch(calls),
    grade: byHead({ "/heads/paid": "pass", "/heads/control": "fail" }) }));
  const retried = await runPairedTrial(trialInput(stateDir, writer, "PP-T5", { dispatchAttempt: recordingDispatch(calls), grade: byHead({}) }));
  assert.deepEqual(calls.map((call) => call.arm), pairedAttemptOrder(protocol, "PP-T5"), "the attempts ran in the drawn order");
  assert.deepEqual(stepRows(writer.rows, "paired_trial.decision").map((row) => trialOf(row).order),
    [pairedAttemptOrder(protocol, "PP-T5"), pairedAttemptOrder(protocol, "PP-T5")], "a retried dispatch records the same order");
  assert.ok(retried.state === "refused" && retried.reasons.includes("task-already-paired"), "a task is paired at most once");
  const decision = stepRows(writer.rows, "paired_trial.decision")[0]!.randomization as Record<string, unknown>;
  assert.deepEqual([decision.unit, decision.seed_hash, decision.draw], ["task", protocol.assignment.seedHash,
    pairedSampleDraw(protocol.assignment.seed, "PP-T5")]);
  assert.equal(pairedSampleDraw("seed-paired-1", "PP-T5"), pairedSampleDraw("seed-paired-1", "PP-T5"));
});

test("cash counts only the paid attempt, and an unreceipted paid spawn holds the next pair", async () => {
  const { stateDir, protocol } = await stateWith(pilotRequest());
  const writer = rowWriter(stateDir);
  const calls: PairedAttemptRequest[] = [];
  const pair = await runPairedTrial(trialInput(stateDir, writer, "PP-T4", { dispatchAttempt: recordingDispatch(calls),
    grade: byHead({ "/heads/paid": "pass", "/heads/control": "fail" }) }));
  assert.equal(pair.state, "measured");
  const normal = writer.write("PP-T4");
  normal("worker.assignment", { worker_assignment: { id: "PP-T4-normal", selected: { provider: "cash", model: "normal-model", effort: "high" } } });
  normal("worker.attempt", { selection_assignment_id: "PP-T4-normal", billing_mode: "api", total_cost_usd: 5, served_model: "normal-model" });
  const spend = summarizePaidPilotSpend((await readPaidPilotEvidence(stateDir, protocol!)).rows, protocol!);
  assert.deepEqual([spend.cashEstimateUsd, spend.cashReceipts, spend.notionalUsd, spend.notionalReceipts], [1.25, 1, 0.8, 1],
    "the paid side attempt is the only cash; control is notional and normal dispatch is not pilot spend");
  assert.deepEqual([spend.missingReceipts, spend.ambiguousReceipts], [0, 0]);
  const attempts = Object.fromEntries(stepRows(writer.rows, "paired_trial.attempt").map((row) => [trialOf(row).arm, row]));
  assert.deepEqual([attempts.paid!.total_cost_usd, attempts.paid!.billing_mode, attempts.paid!.served_model], [1.25, "api", PAID_PIN.model]);
  assert.deepEqual([attempts.control!.total_cost_usd, attempts.control!.billing_mode], [0.8, "subscription"]);

  const oddControl = writer.write("PP-T6");
  oddControl("paired_trial.spawn", { paired_trial: { pilot_id: "paired-fixture-1", pair_id: "pair-odd", arm: "control" } });
  oddControl("paired_trial.attempt", { paired_trial: { pilot_id: "paired-fixture-1", pair_id: "pair-odd", arm: "control" }, billing_mode: "api", total_cost_usd: 3 });
  oddControl("paired_trial.spawn", { paired_trial: { pilot_id: "paired-fixture-1", pair_id: "pair-crash", arm: "control" } });
  oddControl("paired_trial.attempt", { paired_trial: { pilot_id: "paired-fixture-1", pair_id: "pair-crash", arm: "control" }, total_cost_usd: null });
  const withOdd = summarizePaidPilotSpend((await readPaidPilotEvidence(stateDir, protocol!)).rows, protocol!);
  assert.equal(withOdd.cashEstimateUsd, 1.25, "an API-billed control attempt never becomes cash");
  assert.equal(withOdd.ambiguousReceipts, 1, "it is ambiguous, which pauses the paid arm");
  assert.equal(withOdd.missingReceipts, 0, "a control attempt with no billing report is unknown notional, not a missing cash receipt");

  const fresh = await stateWith(pilotRequest({ pilotId: "inflight-1" }));
  const inflight = rowWriter(fresh.stateDir);
  inflight.write("PP-T7")("paired_trial.spawn", { paired_trial: { pilot_id: "inflight-1", pair_id: "pair-open", arm: "paid" } });
  const blocked = await runPairedTrial(trialInput(fresh.stateDir, inflight, "PP-T8", { dispatchAttempt: recordingDispatch(calls) }));
  assert.ok(blocked.state === "refused" && blocked.reasons.includes("cost-evidence-missing"), "paid attempts run one at a time");
});

test("McNemar is checked on hand-computed discordant counts", () => {
  const make = (paid: GradedPair["paid"], control: GradedPair["control"], n: number): GradedPair[] => Array.from({ length: n }, () => ({ paid, control }));
  const pairs = [...make("pass", "fail", 8), ...make("fail", "pass", 2), ...make("pass", "pass", 5), ...make("fail", "fail", 5)];
  const test8of10 = mcnemarExact(pairs);
  assert.deepEqual([test8of10.pairs, test8of10.paidOnly, test8of10.controlOnly, test8of10.bothPass, test8of10.bothFail, test8of10.discordant],
    [20, 8, 2, 5, 5, 10]);
  assert.ok(Math.abs(test8of10.pValue - 112 / 1024) < 1e-12, "2 * (C(10,0) + C(10,1) + C(10,2)) / 2^10 = 0.109375");
  const difference = pairedDifference(test8of10);
  assert.ok(!("unavailable" in difference));
  assert.ok(Math.abs(difference.estimate - 0.3) < 1e-12, "(8 - 2) / 20");
  const se = Math.sqrt(10 - 36 / 20) / 20;
  assert.ok(Math.abs(difference.high - difference.low - 2 * 1.959963984540054 * se) < 1e-6, "Wald interval over the paired variance");
  assert.ok(Math.abs(mcnemarExact(make("pass", "fail", 10)).pValue - 2 / 1024) < 1e-12, "10 of 10 discordant for one arm: 2 / 2^10");
  assert.equal(mcnemarExact(make("pass", "pass", 4)).pValue, 1, "no discordant pair carries no evidence");
  assert.deepEqual(pairedDifference(mcnemarExact([])), { unavailable: "no-measured-pairs" });

  const protocol = pairedProtocol();
  let n = 0;
  const row = (step: string, fields: Partial<PairedTrialRowFields>, extra: Partial<PaidPilotRow> = {}): PaidPilotRow => ({
    ts: new Date(Date.parse(DURING) + (n += 1) * 1000).toISOString(), step, taskId: `PP-T${(n % 12) + 1}`, runId: null, assignmentId: null,
    selectionAssignmentId: null, selected: { provider: null, model: null, effort: null }, recordedArm: null, revisionsOffPin: 0,
    revisionsUnpinned: 0, servedModel: null, billingMode: null, cost: { state: "missing" }, ...extra,
    paired: { pairId: `pair-${n}`, arm: null, shadow: false, sampled: true, admitted: true, order: ["paid", "control"], reasons: [],
      deviations: [], outcome: null, outcomes: null, status: null, ...fields } });
  const measured = pairs.map((pair, i) => row("paired_trial.pair", { pairId: `p${i}`, status: "measured", outcomes: pair }));
  const evidence: PaidPilotEvidence = { state: "observed", forms: { gzip: 0, plain: 0, live: 1 }, unreadSources: [], malformedRows: 0,
    duplicateRows: 0, newestTs: null, rows: [...measured, row("paired_trial.decision", { pairId: "p0", admitted: false, reasons: ["pair-in-flight"] }),
      row("paired_trial.decision", { pairId: "p0" }), row("paired_trial.pair", { pairId: "p-odd", status: "unmeasurable", outcomes: null })] };
  const early = buildPairedPilotReport({ protocol, evidence, nowIso: DURING });
  assert.deepEqual([early.conclusion.state, early.winnerDeclared], ["no-conclusion", false], "no winner before the stopping rule");
  assert.equal(early.decisions.admitted, 1, "a later admitted decision replaces an earlier refusal for the same pair");
  const late = buildPairedPilotReport({ protocol, evidence, nowIso: AFTER_ANALYSIS });
  assert.deepEqual([late.counts.measured, late.counts.unmeasurable, late.mcnemar.paidOnly, late.mcnemar.controlOnly], [20, 1, 8, 2]);
  assert.deepEqual([late.conclusion.state, late.winnerDeclared], ["inconclusive", false], "p = 0.109 is not decisive");
  assert.equal(late.evalCard.kind, "paired-pilot");
  assert.equal(late.evalCard.version, "eval-card-v1");
  const decisive = buildPairedPilotReport({ protocol, nowIso: AFTER_ANALYSIS, evidence: { ...evidence,
    rows: make("pass", "fail", 12).map((pair, i) => row("paired_trial.pair", { pairId: `d${i}`, status: "measured", outcomes: pair })) } });
  assert.deepEqual([decisive.conclusion, decisive.winnerDeclared], [{ state: "difference-observed", favors: "paid" }, true]);
  const none = buildPairedPilotReport({ protocol, nowIso: AFTER_ANALYSIS, evidence: { ...evidence, rows: [] } });
  assert.deepEqual(none.conclusion, { state: "inconclusive", reason: "no-measured-pairs" });
  const unavailable = pairedPilotReportView({ protocol, nowIso: DURING, evidence: { ...evidence, state: "unavailable", reason: "spend-source-missing", rows: [] } });
  assert.equal(unavailable.observed, false);
  assert.match(unavailable.lines.join("\n"), /unavailable \(spend-source-missing\)[\s\S]*cash estimate unknown/);
});

test("the sampler refuses by name and never lets a failure reach its caller", async () => {
  const { stateDir, protocol } = await stateWith(pilotRequest({ paired: { samplingRate: 1, maxPairs: 1, shadow: false } }));
  const writer = rowWriter(stateDir);
  const calls: PairedAttemptRequest[] = [];
  assert.deepEqual(await runPairedTrial(trialInput(stateDir, writer, "PP-T1", { lane: "fix" })), { state: "not-eligible", pilotId: "paired-fixture-1" });
  assert.deepEqual(await runPairedTrial(trialInput(stateDir, writer, "NOT-IN-POPULATION")), { state: "not-eligible", pilotId: "paired-fixture-1" });
  const unwired = await runPairedTrial(trialInput(stateDir, writer, "PP-T1"));
  assert.ok(unwired.state === "refused" && unwired.reasons.includes("attempt-dispatch-not-wired"), "production refuses until a sandboxed dispatcher exists");
  assert.deepEqual(stepRows(writer.rows, "paired_trial.spawn"), []);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow = async (request: PairedAttemptRequest): Promise<PairedAttemptResult> => { calls.push(request); await gate;
    return { headDir: `/heads/${request.arm}`, headSha: SHA, servedModel: request.pin.model, billingMode: request.arm === "paid" ? "api" : "subscription", costUsd: 1 }; };
  const first = runPairedTrial(trialInput(stateDir, writer, "PP-T2", { dispatchAttempt: slow, grade: byHead({}), harnessRevision: undefined }));
  const second = await runPairedTrial(trialInput(stateDir, writer, "PP-T3", { dispatchAttempt: slow }));
  assert.ok(second.state === "refused" && second.reasons.includes("pair-in-flight"), "one live pair per process");
  release();
  const firstResult = await first;
  assert.equal(firstResult.state, "unmeasurable");
  assert.deepEqual(trialOf(stepRows(writer.rows, "paired_trial.pair").at(-1)).stack_deviations, ["harnessRevision:unpinned"],
    "an unattested harness is a recorded deviation");
  const capped = await runPairedTrial(trialInput(stateDir, writer, "PP-T4", { dispatchAttempt: recordingDispatch(calls) }));
  assert.ok(capped.state === "refused" && capped.reasons.includes("pair-cap-reached"));

  const low = await stateWith(pilotRequest({ pilotId: "low-rate", paired: { samplingRate: 0.01, maxPairs: 5, shadow: false } }));
  const unsampled = low.protocol!.population.find((task) => pairedSampleDraw(low.protocol!.assignment.seed, task.taskId) >= 0.01)!;
  const lowWriter = rowWriter(low.stateDir);
  const skipped = await runPairedTrial(trialInput(low.stateDir, lowWriter, unsampled.taskId, { dispatchAttempt: recordingDispatch(calls) }));
  assert.deepEqual(skipped.state === "not-sampled" && skipped.reasons, ["not-sampled"]);
  assert.equal(trialOf(lowWriter.rows[0]).sampled, false, "an unsampled decision is still recorded");

  const deviant = await stateWith(pilotRequest({ pilotId: "deviant" }));
  const deviantWriter = rowWriter(deviant.stateDir);
  await runPairedTrial(trialInput(deviant.stateDir, deviantWriter, "PP-T9", { dispatchAttempt: recordingDispatch(calls), grade: byHead({}),
    harnessRevision: { source: "executing-module-git", revision: OTHER_SHA } }));
  const deviation = trialOf(stepRows(deviantWriter.rows, "paired_trial.spawn")[0]).stack_deviations as string[];
  assert.deepEqual(deviation, [`harnessRevision:executing-${OTHER_SHA}-pinned-${SHA}`], "a harness off the protocol's pin is recorded, not hidden");
  const deviantReport = buildPairedPilotReport({ protocol: deviant.protocol!, nowIso: DURING, evidence: await readPaidPilotEvidence(deviant.stateDir, deviant.protocol!) });
  assert.deepEqual([deviantReport.stack.deviatingPairs, deviantReport.stack.offPinAttempts], [1, 1]);

  const failingLog = await stateWith(pilotRequest({ pilotId: "failing-log" }));
  const throwing = (failOn: string) => (step: string) => { if (step === failOn) throw new Error("disk full"); };
  const noDecision = await runPairedTrial({ ...trialInput(failingLog.stateDir, rowWriter(failingLog.stateDir), "PP-T1",
    { dispatchAttempt: recordingDispatch(calls) }), log: throwing("paired_trial.decision") });
  assert.ok(noDecision.state === "refused" && noDecision.reasons.includes("decision-not-recorded"), "no randomisation receipt, no pair");
  const before = calls.length;
  const noMarker = await runPairedTrial({ ...trialInput(failingLog.stateDir, rowWriter(failingLog.stateDir), "PP-T2",
    { dispatchAttempt: recordingDispatch(calls), grade: byHead({}) }), log: throwing("paired_trial.spawn") });
  assert.ok(noMarker.state === "unmeasurable" && noMarker.reasons.some((reason) => reason.startsWith("spawn-marker-not-recorded")));
  assert.equal(calls.length, before, "an attempt whose spend marker cannot be written never spawns");
  const exploded = await runPairedTrial(trialInput(failingLog.stateDir, rowWriter(failingLog.stateDir), "PP-T3", {
    protocols: () => { throw new Error("state dir vanished"); }, settled: () => { throw new Error("observer bug"); } }));
  assert.deepEqual(exploded.state === "refused" && exploded.reasons, ["paired-trial-failed"]);
  assert.equal(protocol!.paired!.maxPairs, 1);
});

test("a paired request is refused by name unless its sampler is fully pre-registered", () => {
  const refused = (changes: Record<string, unknown>) => {
    const parsed = parsePaidPilotRequest(pilotRequest(changes));
    return parsed.ok ? "accepted" : parsed.reason;
  };
  assert.equal(refused({ design: "crossover" }), "design-invalid");
  assert.equal(refused({ design: undefined }), "paired-settings-need-paired-design");
  assert.equal(refused({ paired: undefined }), "paired-settings-missing");
  assert.equal(refused({ paired: { samplingRate: 0, maxPairs: 3, shadow: false } }), "paired-sampling-rate-invalid");
  assert.equal(refused({ paired: { samplingRate: 1.5, maxPairs: 3, shadow: false } }), "paired-sampling-rate-invalid");
  assert.equal(refused({ paired: { samplingRate: 1, maxPairs: 501, shadow: false } }), "paired-max-pairs-invalid");
  assert.equal(refused({ paired: { samplingRate: 1, maxPairs: 2.5, shadow: false } }), "paired-max-pairs-invalid");
  assert.equal(refused({ paired: { samplingRate: 1, maxPairs: 3 } }), "paired-shadow-flag-required");
  assert.equal(refused({}), "accepted");
  const protocol = pairedProtocol();
  assert.deepEqual(pairedStackEvidence(protocol, HARNESS).scorerRevision, { source: "trial-manifest", revision: SHA });
});

test("paired report verb refuses without a builder and keeps printing when it cannot persist", async () => {
  const { dir, stateDir } = await stateWith(pilotRequest({ pilotId: "verb-1" }));
  const unwired = await verb(["report", "--pilot", "verb-1", "--state-dir", stateDir], DURING, false);
  assert.deepEqual([unwired.code, unwired.printed[0]], [2, "benchmark-paid-pilot: report refused (paired-report-not-wired)"]);
  mkdirSync(join(dir, "out-is-a-dir"));
  const unpersisted = await verb(["report", "--pilot", "verb-1", "--state-dir", stateDir, "--out", join(dir, "out-is-a-dir")], DURING);
  assert.equal(unpersisted.code, 0);
  assert.match(unpersisted.printed[0]!, /report-not-persisted/);
  assert.match(unpersisted.printed.join("\n"), /paired; observed/);
});

/** A throwaway origin, seed and plan for driving the REAL runTask through recon and implement. */
function dispatchFixture(taskId: string) {
  const root = mkdtempSync(join(tmpdir(), "rmd-paired-dispatch-"));
  const origin = gitRepo({ bare: true, kind: "paired-dispatch-origin" });
  const seed = gitRepo({ kind: "paired-dispatch-seed" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "--quiet", origin.dir, join(root, "repos", "remudero")]);
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, `- id: ${taskId}\n  title: paired dispatch fixture\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n`
    + "  risk: medium\n  origin: fixture\n  files: [src/lib/daemon.ts]\n  status: queued\n");
  return { root, planPath, cleanup: () => { seed.cleanup(); origin.cleanup(); } };
}

const ROUTING_KEYS = ["model", "effort", "maxTurns", "maxBudgetUsd", "mountProvider", "permissionMode", "cashSqueezed",
  "cashOpusEmergency", "routingFallback", "routingTrial", "tools", "disallowedTools"] as const;

async function normalDispatch(taskId: string, pairedTrial: Partial<PairedTrialInput>) {
  const fixture = dispatchFixture(taskId);
  const spawned: Record<string, unknown>[] = [];
  const assignment: WorkerSelectionAssignment = {
    version: 1, id: "paired-normal-1", phase: "pre-execution", requested: { model: "requested-model", effort: "high", maxTurns: null },
    selected: { provider: "codex", model: "selected-model", effort: "high" },
    routing: { mode: "multi-provider", policy: { preference: "automatic", reservePercent: 5, provenance: "default" } }, candidates: [],
  };
  const spawn: typeof spawnWorker = async (args) => {
    spawned.push(Object.fromEntries(ROUTING_KEYS.map((key) => [key, args[key] ?? null])));
    args.onSelectionAssignment?.(assignment);
    const worker: WorkerResult = {
      sessionId: `paired-session-${spawned.length}`, costUsd: 0.25, numTurns: 1,
      text: spawned.length === 1 ? "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n" : "REPORT\nno PR opened\n",
      blocks: [], stderr: "", subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
      model: "selected-model", servedModel: "served-model", effort: "high", tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
      modelUsage: {}, compactionEvents: [], qualitySuspect: false, selectionAssignmentId: assignment.id, workerDurationMs: 27,
    };
    return worker;
  };
  let settle: (result: PairedTrialResult) => void = () => {};
  const trialEnded = new Promise<PairedTrialResult>((resolve) => { settle = resolve; });
  try {
    const outcome = await withLiveWritesAllowed(() => runTask(taskId, {
      skipGitSync: true, planPath: fixture.planPath,
      config: { claudeBin: "/bin/true", root: fixture.root, installRoot: process.cwd() } as Config,
      benchmarkStackEvidence: { harnessRevision: HARNESS },
      github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
      spawn,
      containmentExec: async (token) => ({ transcript: `touch ../${token}.txt: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
      isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
      pairedTrial: { ...pairedTrial, settled: settle },
    }));
    const trial = await trialEnded;
    const rows = readFileSync(join(fixture.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row);
    return { verdict: outcome.verdict, spawned, trial, rows };
  } finally {
    fixture.cleanup();
  }
}

test("normal dispatch is unchanged whether a pair is sampled or not", async () => {
  const taskId = "T-PAIRED-DISPATCH";
  const protocol = pairedProtocol({}, [taskId, "PP-T2"]);
  const observed: PaidPilotEvidence = { state: "observed", forms: { gzip: 0, plain: 0, live: 1 }, unreadSources: [], malformedRows: 0,
    duplicateRows: 0, newestTs: null, rows: [] };
  const sideCalls: PairedAttemptRequest[] = [];
  const unsampled = await normalDispatch(taskId, { protocols: () => [] });
  const sampled = await normalDispatch(taskId, { protocols: () => [protocol], clock: clockAt(() => DURING), readEvidence: async () => observed,
    readControls: () => ({ state: "observed", paused: false, reason: null, entries: 0, lastAction: null, lastAt: null }),
    dispatchAttempt: recordingDispatch(sideCalls), grade: byHead({ "/heads/paid": "pass", "/heads/control": "pass" }) });
  assert.deepEqual(unsampled.trial, { state: "inert" });
  assert.equal(sampled.trial.state, "measured", "the sampled run really paired the task");
  assert.equal(sideCalls.length, 2, "two extra side attempts, through their own seam");
  assert.deepEqual(sideCalls.map((call) => call.pin.model).sort(), [CONTROL_PIN.model, PAID_PIN.model].sort());
  assert.ok(unsampled.spawned.length >= 2, "recon and implement both spawned");
  assert.deepEqual(sampled.spawned, unsampled.spawned, "the normal spawns carry the same model, effort, routing and budget");
  assert.equal(sampled.verdict, unsampled.verdict, "and reach the same verdict");
  const assignments = (rows: Row[]) => rows.filter((row) => row.step === "worker.assignment").length;
  assert.equal(assignments(sampled.rows), assignments(unsampled.rows), "the side attempts wrote no worker.assignment of their own");
  assert.ok(sampled.rows.some((row) => row.step === "paired_trial.decision" && trialOf(row).admitted === true));
  assert.ok(!unsampled.rows.some((row) => String(row.step).startsWith("paired_trial.")), "an inert trial wrote nothing into the run");
});
