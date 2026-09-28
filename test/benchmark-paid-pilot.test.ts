// test/benchmark-paid-pilot.test.ts — W1-T4603: the approved $100/7-day paid model pilot. Every case
// here runs in a temp state dir with a fixed clock; nothing reads a real ledger or spends.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { buildBenchmarkAaReport, parseAaTrialManifest, type AaLedgerEvidence, type AaRow,
  type BenchmarkAaReport } from "../src/lib/benchmark-aa.js";
import {
  activateBenchmarkPaidPilot, benchmarkPaidPilotCommand, buildPaidPilotReport, loadPaidPilotProtocol, paidArmPauseReasons,
  paidPilotArmAdmission, paidPilotArmFor, parsePaidPilotRequest, PAID_PILOT_CASH_CEILING_USD, PAID_PILOT_WINDOW_MS, readPaidPilotEvidence,
  REPO_IDENTITY_RE, summarizePaidPilotSpend, type PaidPilotEvidence, type PaidPilotProtocol, type PaidPilotReport,
} from "../src/lib/benchmark-paid-pilot.js";
import { protocolHash } from "../src/lib/eval-card.js";
import type { TaskCaseFile } from "../src/lib/task-case-file.js";

const SHA = "a".repeat(40);
const AA_NOW = "2026-09-27T12:10:00.000Z";
const APPROVED = "2026-09-25T09:00:00.000Z";
const ACT = "2026-09-27T13:00:00.000Z";
const DURING = "2026-09-28T13:00:00.000Z";
const EXPIRES = "2026-10-04T13:00:00.000Z";
const ANALYSIS = "2026-10-18T13:00:00.000Z";
const AFTER = "2026-10-18T14:00:00.000Z";
const CONSENTED = ["fixture-org/alpha", "fixture-org/beta", "fixture-org/gamma"];
const PAID_PIN = { provider: "cash", model: "gpt-oss-120b", effort: "medium" };
const CONTROL_PIN = { provider: "claude", model: "claude-sonnet-5", effort: "high" };
const REVISION_NAMES = ["harnessRevision", "promptRevision", "toolRevision", "scorerRevision", "environmentRevision"];
type Row = Record<string, unknown>;

function pilotRequest(changes: Record<string, unknown> = {}, taskCount = 24): Record<string, unknown> {
  return {
    version: "benchmark-paid-pilot-request-v1", pilotId: "pilot-fixture-1",
    approval: { reference: "#7418", approvedAt: APPROVED },
    repos: CONSENTED.map((repo, i) => ({ repo, consentReceipt: `consent-${i}` })),
    pseudonymSalt: "local-salt-7", assignmentSeed: "seed-fixture-1",
    arms: { paid: PAID_PIN, control: CONTROL_PIN },
    revisions: Object.fromEntries(REVISION_NAMES.map((field) => [field, SHA])),
    strataRevision: "strata-v1",
    population: Array.from({ length: taskCount }, (_, i) => ({ taskId: `PP-T${i + 1}`, repo: CONSENTED[i % 3],
      taskClass: i % 2 === 0 ? "fix" : "docs", risk: "low" })),
    primaryOutcome: "verified-completion", maturityDays: 14,
    protocolText: "Paid pilot: ITT verified completion, task unit, fixed horizon.\n",
    ...changes,
  };
}

function parsedRequest(changes: Record<string, unknown> = {}, taskCount = 24) {
  const parsed = parsePaidPilotRequest(pilotRequest(changes, taskCount));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  return parsed.request;
}

function aaRow(step: string, taskId: string, ts: string): AaRow {
  const assignment = step === "worker.assignment";
  return { ts, step, taskId, runId: `${taskId}-1`, assignmentId: assignment ? `${taskId}-a1` : null,
    selectionAssignmentId: assignment ? null : `${taskId}-a1`, selected: { ...CONTROL_PIN },
    stack: Object.fromEntries(REVISION_NAMES.map((field) => [field, { state: "observed", value: SHA }])),
    work: { taskClass: "fix", risk: "low" }, recordedArm: null, routingExperiment: null, success: true,
    servedModel: CONTROL_PIN.model, billingMode: "subscription", costUsd: 0.5, tokensObserved: true, durationObserved: true, retract: false };
}

function caseFile(taskId: string, runs: number[], prState: "OPEN" | "CLOSED" | "MERGED", prNumber: number, asOf: string): TaskCaseFile {
  const at = <T>(value: T) => ({ state: "observed" as const, value, source: "fixture", asOf });
  const gone = (reason: string) => ({ state: "unavailable" as const, reason, source: "fixture", asOf });
  return {
    version: "task-case-file-v1", taskId, asOf,
    plan: at({ title: taskId, dependsOn: [], verify: "auto", risk: "low" }),
    ledger: at({ windowStart: "2026-08-28T12:10:00.000Z", forms: { gzip: 1, plain: 1, live: 1 }, matchingRows: 3 }),
    runs: runs.map((n) => ({ runId: `${taskId}-${n}`, startedAt: `2026-09-27T1${n}:00:00.000Z`, assignmentId: `${taskId}-a${n}`,
      selectedProvider: "claude", selectedModel: CONTROL_PIN.model, servedModel: CONTROL_PIN.model,
      billingMode: "subscription", costUsd: 0.5, verdict: "passed", prNumber })),
    pr: at({ number: prNumber, url: `https://example.invalid/pull/${prNumber}`, headSha: SHA, state: prState, taskCredit: prState === "MERGED" }),
    review: at({ headSha: SHA, status: "success" as const }), acceptance: at({ headSha: SHA, status: "success" as const }),
    ci: at({ headSha: SHA, status: "success" as const }),
    mergedSource: prState === "MERGED" ? at({ prNumber, mergedAt: asOf }) : gone("not-merged"),
    deployment: gone("not-collected"), runtime: gone("not-collected"), next: null,
  };
}

/** A real benchmark-aa-v1 report from the W1-T4575 builder, so the pilot cites the receipt it will meet in production. */
function aaReport(shape: "clean" | "concern" | "untouched" | "stale" = "clean", nowIso = AA_NOW): BenchmarkAaReport {
  const parsed = parseAaTrialManifest({ version: "benchmark-aa-trial-v1", trialId: "aa-fixture-1", cohort: { kind: "public-fixture" },
    stack: { ...CONTROL_PIN, ...Object.fromEntries(REVISION_NAMES.map((field) => [field, SHA])) }, strataRevision: "strata-v1",
    tasks: Array.from({ length: 10 }, (_, i) => ({ taskId: `AA-T${i + 1}`, taskClass: "fix", risk: "low" })) });
  assert.ok(parsed.ok);
  const ids = parsed.manifest.tasks.map((task) => task.taskId);
  const rows = shape === "untouched" ? [] : ids.flatMap((taskId, i) => [aaRow("worker.assignment", taskId, `2026-09-27T11:0${i}:00.000Z`),
    ...(shape === "concern" && i === 0 ? [] : [aaRow("verdict", taskId, `2026-09-27T11:0${i}:30.000Z`)])]);
  const evidence: AaLedgerEvidence = { state: "observed", forms: { gzip: 0, plain: 0, live: 1 }, unreadSources: [], malformedRows: 0,
    duplicateRows: 0, ledgerAssignments: ids.length, newestTs: "2026-09-27T11:09:30.000Z", rows };
  const caseFiles = ids.map((taskId, i) => caseFile(taskId, [1], "MERGED", 500 + i, nowIso));
  const report = buildBenchmarkAaReport({ manifest: parsed.manifest, evidence, nowIso, caseFiles });
  if (shape !== "stale") return report;
  return buildBenchmarkAaReport({ manifest: parsed.manifest, nowIso, prior: report,
    evidence: { ...evidence, state: "unavailable", reason: "ledger-source-unreadable", rows: [] } });
}

function pilot(changes: Record<string, unknown> = {}, taskCount = 24, nowIso = ACT): PaidPilotProtocol {
  const result = activateBenchmarkPaidPilot({ request: parsedRequest(changes, taskCount), aaReport: aaReport(), nowIso, existing: [] });
  assert.ok(result.ok, result.ok ? "" : result.reason);
  return result.protocol;
}

const armTasks = (protocol: PaidPilotProtocol, arm: "paid" | "control") =>
  protocol.population.filter((task) => task.arm === arm).map((task) => task.taskId);

function assignmentRow(taskId: string, n: number, ts: string, pin: Record<string, string>, extra: Row = {}): Row {
  return { ts, step: "worker.assignment", task_id: taskId, run_id: `${taskId}-${n}`, host: "private-host",
    worker_assignment: { id: `${taskId}-a${n}`, requested: { model: pin.model, effort: pin.effort }, selected: pin },
    benchmark_run: { stack: Object.fromEntries(REVISION_NAMES.map((field) => [field, { state: "observed", value: SHA }])),
      allocation: { method: "observational" } }, ...extra };
}

function attemptRow(taskId: string, n: number, ts: string, billing: string | undefined, cost: unknown, extra: Row = {}): Row {
  return { ts, step: "worker.attempt", task_id: taskId, run_id: `${taskId}-${n}`, selection_assignment_id: `${taskId}-a${n}`,
    served_model: billing === "api" ? PAID_PIN.model : CONTROL_PIN.model, billing_mode: billing, total_cost_usd: cost,
    account_label: "private-account", ...extra };
}

const encode = (rows: Row[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

function writeCorpus(dir: string, forms: { gz?: Row[]; plain?: Row[]; live?: Row[] | string }): void {
  mkdirSync(dir, { recursive: true });
  if (forms.gz) writeFileSync(join(dir, "ledger.2026-09-28T00-00-00-000Z.ndjson.gz"), gzipSync(encode(forms.gz)));
  if (forms.plain) writeFileSync(join(dir, "ledger.2026-09-28T01-00-00-000Z.ndjson"), encode(forms.plain));
  if (forms.live !== undefined) writeFileSync(join(dir, "ledger.ndjson"), typeof forms.live === "string" ? forms.live : encode(forms.live));
}

async function withDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "rmd-benchmark-paid-pilot-"));
  try { return await body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function evidenceOver(dir: string, protocol: PaidPilotProtocol, forms: Parameters<typeof writeCorpus>[1]): Promise<PaidPilotEvidence> {
  const stateDir = join(dir, `corpus-${readdirSync(dir).length}`);
  writeCorpus(stateDir, forms);
  return readPaidPilotEvidence(stateDir, protocol);
}

function admit(protocol: PaidPilotProtocol | null | { unavailable: string }, taskId: string, evidence: PaidPilotEvidence,
  nowIso = DURING, lane = "implement", nextCallReserveUsd?: number) {
  return paidPilotArmAdmission({ protocol, lane, taskId, nowIso, evidence, ...(nextCallReserveUsd === undefined ? {} : { nextCallReserveUsd }) });
}

async function runVerb(args: string[], nowIso: string, activate = activateBenchmarkPaidPilot,
  readEvidence?: (stateDir: string, protocol: PaidPilotProtocol) => Promise<PaidPilotEvidence>): Promise<{ code: number; printed: string[] }> {
  const printed: string[] = [];
  const code = await benchmarkPaidPilotCommand(args, activate, { nowIso, print: (line) => printed.push(line),
    resolveStateDir: () => { throw new Error("tests always pass --state-dir"); }, ...(readEvidence ? { readEvidence } : {}) });
  return { code, printed };
}

function activationArgs(dir: string, request: Record<string, unknown>, report: unknown, stateDir = join(dir, "state")): string[] {
  mkdirSync(stateDir, { recursive: true });
  const requestPath = join(dir, `request-${String(request.pilotId)}.json`);
  const aaPath = join(dir, "aa-report.json");
  writeFileSync(requestPath, JSON.stringify(request));
  writeFileSync(aaPath, JSON.stringify(report));
  return ["activate", "--request", requestPath, "--aa-report", aaPath, "--state-dir", stateDir];
}

const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

test("paid benchmark pilot persists approved protocol and bounded cash window", async () => {
  const aa = aaReport();
  assert.equal(aa.verdict, "no-integrity-concern-detected", "the fixture A/A receipt is a current, clean one");
  await withDir(async (dir) => {
    const first = await runVerb(activationArgs(dir, pilotRequest(), aa), ACT);
    assert.equal(first.code, 0, first.printed.join("\n"));
    assert.ok(first.printed[0]!.includes(`activated ${ACT}`));
    const path = join(dir, "state", "benchmark-paid-pilot-v1.pilot-fixture-1.protocol.json");
    const bytes = readFileSync(path, "utf8");
    const { protocol, receipt } = JSON.parse(bytes) as { protocol: PaidPilotProtocol; receipt: Record<string, unknown> };
    assert.equal(protocol.activatedAt, ACT, "the clock starts at activation");
    assert.equal(protocol.expiresAt, EXPIRES, "seven days from activation");
    assert.equal(protocol.analysisAt, ANALYSIS, "expiry plus the fourteen-day maturity window");
    assert.equal(protocol.approval.approvedAt, APPROVED, "the approval time is recorded as provenance only");
    assert.equal(protocol.activation, "operator-command");
    assert.deepEqual(protocol.cash, { ceilingUsd: 100, currency: "USD", counts: "api-billed-worker-calls", source: "worker-result-estimate-not-invoice" });
    assert.equal(PAID_PILOT_CASH_CEILING_USD, 100);
    assert.deepEqual(protocol.repos.map((repo) => [repo.repo, repo.consentReceipt]), CONSENTED.map((repo, i) => [repo, `consent-${i}`]));
    assert.ok(protocol.repos.every((repo) => /^[0-9a-f]{16}$/.test(repo.pseudonym)));
    assert.equal(protocol.assignment.seed, "seed-fixture-1");
    assert.equal(protocol.assignment.seedHash, createHash("sha256").update("seed-fixture-1").digest("hex"));
    assert.equal(protocol.assignment.unit, "task");
    assert.deepEqual(protocol.assignment.plannedAllocation, { paid: 0.5, control: 0.5 });
    assert.equal(protocol.population.length, 24);
    for (const task of protocol.population) assert.equal(task.arm, paidPilotArmFor("seed-fixture-1", task.taskId));
    assert.deepEqual({ ...protocol.arms.paid, stackHash: "" }, { ...PAID_PIN, billing: "api", stackHash: "" });
    assert.deepEqual({ ...protocol.arms.control, stackHash: "" }, { ...CONTROL_PIN, billing: "subscription", stackHash: "" });
    assert.notEqual(protocol.arms.paid.stackHash, protocol.arms.control.stackHash);
    assert.deepEqual(Object.keys(protocol.revisions), REVISION_NAMES);
    assert.equal(protocol.primaryOutcome, "verified-completion");
    assert.equal(protocol.maturityDays, 14);
    assert.match(protocol.uncertaintyMethod, /Wald 95% interval/);
    assert.match(protocol.stoppingRule, /no interim winner/);
    assert.equal(protocol.aaReceipt.reportHash, aa.receipt.reportHash, "the protocol cites the current A/A receipt");
    assert.equal(protocol.aaReceipt.verdict, "no-integrity-concern-detected");
    assert.equal(protocol.protocolHash, protocolHash(pilotRequest().protocolText as string));
    assert.equal(receipt.version, "benchmark-paid-pilot-receipt-v1");
    assert.equal(receipt.activatedAt, ACT);
    assert.equal(receipt.cashCeilingUsd, 100);
    assert.equal(receipt.protocolDigest, protocol.digest);
    for (const secret of ["PP-T1", "fixture-org", "local-salt-7", "seed-fixture-1", "consent-0"])
      assert.equal(JSON.stringify(receipt).includes(secret), false, secret);

    const again = await runVerb(activationArgs(dir, pilotRequest(), aa), plus(ACT, 3_600_000));
    assert.equal(again.code, 2);
    assert.ok(again.printed[0]!.includes("pilot-already-activated"));
    assert.equal(readFileSync(path, "utf8"), bytes, "a second activation never restarts the clock");
    const second = await runVerb(activationArgs(dir, pilotRequest({ pilotId: "pilot-fixture-2" }), aa), plus(ACT, 3_600_000));
    assert.ok(second.printed[0]!.includes("another-pilot-active"), "one approved pilot at a time");
    const json = await runVerb([...activationArgs(dir, pilotRequest({ pilotId: "pilot-fixture-3" }), aaReport("clean", EXPIRES)), "--json"],
      plus(EXPIRES, 60_000));
    assert.equal(json.code, 0, "a later pilot may start only after the first has expired");
    assert.equal((JSON.parse(json.printed[0]!) as { activatedAt: string }).activatedAt, plus(EXPIRES, 60_000));
  });

  const refusal = (aaValue: unknown, nowIso = ACT) => {
    const result = activateBenchmarkPaidPilot({ request: parsedRequest(), aaReport: aaValue, nowIso, existing: [] });
    return result.ok ? "activated" : result.reason;
  };
  const clean = aaReport();
  assert.equal(refusal(undefined), "aa-receipt-missing");
  assert.equal(refusal({ ...clean, version: "benchmark-aa-v0" }), "aa-receipt-invalid");
  assert.equal(refusal({ ...clean, asOf: ACT }), "aa-receipt-hash-mismatch", "a tampered report no longer matches its receipt");
  assert.equal(refusal(clean, plus(AA_NOW, 25 * 3_600_000)), "aa-receipt-stale", "an A/A receipt older than a day is not current");
  assert.equal(refusal(clean, plus(AA_NOW, -60_000)), "aa-receipt-stale", "a receipt from the future is not current");
  assert.equal(refusal(aaReport("stale")), "aa-receipt-stale");
  assert.equal(aaReport("concern").verdict, "integrity-concerns");
  assert.equal(refusal(aaReport("concern")), "aa-receipt-integrity-concerns");
  assert.equal(refusal(aaReport("untouched")), "aa-receipt-inconclusive");
  assert.equal(refusal(clean, "not-a-time"), "activation-clock-invalid");
  assert.equal(activateBenchmarkPaidPilot({ request: parsedRequest(), aaReport: clean, nowIso: ACT,
    existing: [{ pilotId: "other", expiresAt: null }] }).ok, false, "an unreadable prior protocol is treated as active");

  const protocol = pilot();
  const [p1, p2] = armTasks(protocol, "paid");
  const controls = armTasks(protocol, "control");
  await withDir(async (dir) => {
    const at = (minutes: number) => plus(ACT, minutes * 60_000);
    const rows: Row[] = [
      assignmentRow(p1!, 1, at(60), PAID_PIN), attemptRow(p1!, 1, at(61), "api", 60),
      assignmentRow(p2!, 1, at(70), PAID_PIN), attemptRow(p2!, 1, at(71), "api", 39.5),
      ...controls.slice(0, 5).flatMap((taskId, i) => [assignmentRow(taskId, 1, at(80 + i), CONTROL_PIN),
        attemptRow(taskId, 1, at(81 + i), "subscription", 100)]),
    ];
    const evidence = await evidenceOver(dir, protocol, { live: rows });
    const spend = summarizePaidPilotSpend(evidence.rows, protocol);
    assert.equal(spend.cashEstimateUsd, 99.5);
    assert.equal(spend.notionalUsd, 500, "subscription notional is reported");
    const open = admit(protocol, p1!, evidence);
    assert.equal(open.paidArm, "admitted", `notional never depletes the cash ceiling: ${open.reasons.join(",")}`);
    assert.equal(open.remainingCashUsd, 0.5);
    assert.equal(admit(protocol, p1!, evidence, plus(APPROVED, PAID_PILOT_WINDOW_MS + 3_600_000)).paidArm, "admitted",
      "seven days from approval is still inside the window that activation opened");
    assert.deepEqual(admit(protocol, p1!, evidence, plus(ACT, -60_000)).reasons, ["pilot-not-started"]);
    assert.deepEqual(admit(protocol, p1!, evidence, EXPIRES).reasons, ["pilot-window-expired"]);
    assert.deepEqual(admit(protocol, p1!, evidence, DURING, "implement", 1).reasons, ["cash-budget-exhausted"],
      "a call that could cross the ceiling is not admitted");
    const spent = await evidenceOver(dir, protocol, { live: [...rows, assignmentRow(p1!, 2, at(90), PAID_PIN), attemptRow(p1!, 2, at(91), "api", 0.5)] });
    assert.deepEqual(admit(protocol, p1!, spent).reasons, ["cash-budget-exhausted"]);
    assert.equal(admit(protocol, p1!, spent).remainingCashUsd, 0);
  });
});

test("paid benchmark pilot preserves intention to treat across attempts", async () => {
  const protocol = pilot();
  const paid = armTasks(protocol, "paid");
  const control = armTasks(protocol, "control");
  for (const task of protocol.population) {
    for (let retry = 0; retry < 5; retry += 1) assert.equal(paidPilotArmFor("seed-fixture-1", task.taskId), task.arm, "a retry reads the same draw");
  }
  assert.ok(protocol.population.some((task) => paidPilotArmFor("seed-fixture-2", task.taskId) !== task.arm), "the pilot seed drives the draw");
  const [retried, fellBack] = paid;
  const [controlRun, controlCrossover] = control;
  const at = (minutes: number) => plus(ACT, minutes * 60_000);
  const rows: Row[] = [
    assignmentRow(retried!, 1, at(60), PAID_PIN, { ts: plus(ACT, -60_000) }),
    assignmentRow(retried!, 1, at(60), PAID_PIN), attemptRow(retried!, 1, at(61), "api", 1),
    assignmentRow(retried!, 2, at(120), PAID_PIN), attemptRow(retried!, 2, at(121), "api", 1.5),
    assignmentRow(retried!, 3, at(180), CONTROL_PIN), attemptRow(retried!, 3, at(181), "subscription", 2),
    assignmentRow(fellBack!, 1, at(200), PAID_PIN), attemptRow(fellBack!, 1, at(201), "api", 0.5, { served_model: "gpt-5-nano" }),
    assignmentRow(controlRun!, 1, at(220), CONTROL_PIN), attemptRow(controlRun!, 1, at(221), "subscription", 0.25),
    assignmentRow(controlCrossover!, 1, at(240), PAID_PIN), attemptRow(controlCrossover!, 1, at(241), "api", 0.75),
    assignmentRow("NOT-IN-PILOT", 1, at(250), PAID_PIN), attemptRow("NOT-IN-PILOT", 1, at(251), "api", 50),
  ];
  const caseFiles = [caseFile(retried!, [1, 2, 3], "MERGED", 11, DURING), caseFile(fellBack!, [1], "CLOSED", 12, DURING),
    caseFile(controlRun!, [1], "OPEN", 13, DURING)];
  await withDir(async (dir) => {
    const evidence = await evidenceOver(dir, protocol, { gz: rows.slice(1, 5), plain: rows.slice(5, 9), live: rows });
    assert.deepEqual(evidence.forms, { gzip: 1, plain: 1, live: 1 }, "every form of the union was opened");
    assert.equal(evidence.duplicateRows, 8, "a receipt replayed across rotations counts once");
    const spend = summarizePaidPilotSpend(evidence.rows, protocol);
    assert.equal(spend.cashEstimateUsd, 3.75, "each distinct API-billed call is charged once, whichever arm ran it");
    assert.equal(spend.cashReceipts, 4);
    assert.equal(spend.notionalUsd, 2.25);
    const report = buildPaidPilotReport({ protocol, evidence, nowIso: DURING, caseFiles });
    const cell = (arm: string, taskClass = "*") => report.cells.find((entry) => entry.arm === arm && entry.taskClass === taskClass)!;
    const paidTotal = cell("paid");
    assert.equal(paidTotal.allocatedUnits, paid.length);
    assert.equal(paidTotal.exposedUnits, 2);
    assert.equal(paidTotal.nonStarters, paid.length - 2, "non-starters stay in their arm's denominator");
    assert.equal(paidTotal.assignments, 4, "the pre-activation assignment is not pilot work");
    assert.deepEqual(paidTotal.recovery, { retries: 2, repairRunsObserved: 2 }, "every retry stays in the task's original arm");
    assert.equal(paidTotal.crossovers, 1, "a retry run on the control model is a crossover, never moved");
    assert.equal(paidTotal.fallbacks, 1, "a served-model fallback is kept and counted");
    assert.deepEqual(paidTotal.accounting.subscriptionNotional, { usd: 2, receipts: 1 }, "the crossover's cost stays with its original arm");
    assert.deepEqual(paidTotal.accounting.cashEstimate, { usd: 3, receipts: 3 });
    assert.equal(paidTotal.outcomes.completed, 1);
    assert.equal(paidTotal.outcomes.failed, 1);
    assert.equal(paidTotal.outcomes.reasons["non-starter"], paid.length - 2);
    assert.deepEqual(paidTotal.verifiedCompletion, { completed: 1, denominator: paid.length, rate: 1 / paid.length });
    const controlTotal = cell("control");
    assert.equal(controlTotal.crossovers, 1);
    assert.deepEqual(controlTotal.accounting.cashEstimate, { usd: 0.75, receipts: 1 }, "a crossover's cash is charged to its original arm");
    assert.equal(controlTotal.outcomes.censored, 1, "an open PR is censored, not failed");
    assert.equal(controlTotal.outcomes.reasons["case-file-missing"], 1);
    assert.equal(controlTotal.verifiedCompletion.denominator, control.length);
    for (const arm of ["paid", "control"]) {
      const classes = report.cells.filter((entry) => entry.arm === arm && entry.taskClass !== "*");
      assert.deepEqual(classes.map((entry) => entry.taskClass).sort(), ["docs", "fix"]);
      assert.equal(classes.reduce((sum, entry) => sum + entry.allocatedUnits, 0), cell(arm).allocatedUnits);
    }
    assert.equal(report.sampleRatio.exposed.paid, 2);
    assert.ok(report.evalCard!.deviations.some((deviation) => deviation.kind === "crossover") === false,
      "no recorded pilot label moved a unit; treatment crossovers are counted in the cells");
    const unjoined = buildPaidPilotReport({ protocol, evidence, nowIso: DURING });
    assert.equal(unjoined.cells.find((entry) => entry.arm === "paid" && entry.taskClass === "*")!.outcomes.reasons["no-verified-outcome-join"], 2);
  });
});

test("paid benchmark pilot isolates cost uncertainty from ordinary flow", async () => {
  const protocol = pilot();
  const [paidTask, paidOther] = armTasks(protocol, "paid");
  const [controlTask] = armTasks(protocol, "control");
  const at = (minutes: number) => plus(ACT, minutes * 60_000);
  const assertOrdinaryFlows = (evidence: PaidPilotEvidence, candidate: PaidPilotProtocol = protocol) => {
    const controlAnswer = admit(candidate, controlTask!, evidence);
    assert.deepEqual([controlAnswer.arm, controlAnswer.paidArm, controlAnswer.ordinaryFlow], ["control", "not-applicable", "continues"]);
    assert.deepEqual(admit(candidate, "NOT-IN-PILOT", evidence).reasons, ["not-pilot-work"]);
    for (const lane of ["review", "ci", "merge", "fix"]) {
      const answer = admit(candidate, paidTask!, evidence, DURING, lane);
      assert.deepEqual([answer.paidArm, answer.ordinaryFlow], ["not-applicable", "continues"], lane);
    }
  };
  const pausedFor = (evidence: PaidPilotEvidence, candidate: PaidPilotProtocol = protocol) => {
    const answer = admit(candidate, paidTask!, evidence);
    assert.equal(answer.arm, "paid");
    assertOrdinaryFlows(evidence, candidate);
    return answer.paidArm === "paused" ? answer.reasons : ["admitted"];
  };
  await withDir(async (dir) => {
    const healthy = await evidenceOver(dir, protocol, { live: [assignmentRow(paidTask!, 1, at(10), PAID_PIN), attemptRow(paidTask!, 1, at(11), "api", 2)] });
    assert.deepEqual(pausedFor(healthy), ["admitted"]);

    const inFlight = await evidenceOver(dir, protocol, { live: [assignmentRow(paidTask!, 1, at(10), PAID_PIN)] });
    assert.deepEqual(pausedFor(inFlight), ["cost-evidence-missing"], "a paid call without its receipt holds the next one");
    assert.equal(summarizePaidPilotSpend(inFlight.rows, protocol).cashEstimateUsd, 0);
    assert.equal(admit(protocol, paidTask!, inFlight).remainingCashUsd, 100);
    const cashProvider = await evidenceOver(dir, protocol, { live: [assignmentRow(controlTask!, 1, at(10), PAID_PIN)] });
    assert.deepEqual(pausedFor(cashProvider), ["cost-evidence-missing"], "a cash-provider call in either arm must carry a receipt");

    const noPrice = await evidenceOver(dir, protocol, { live: [assignmentRow(paidTask!, 1, at(10), PAID_PIN), attemptRow(paidTask!, 1, at(11), "api", undefined)] });
    assert.deepEqual(pausedFor(noPrice), ["cost-evidence-missing"], "a missing price is unknown, never zero");
    const noPriceReport = buildPaidPilotReport({ protocol, evidence: noPrice, nowIso: DURING });
    const paidCell = noPriceReport.cells.find((entry) => entry.arm === "paid" && entry.taskClass === "*")!;
    assert.deepEqual(paidCell.accounting.unknown, { receipts: 1, reasons: { "cash-price-missing": 1 } });
    assert.deepEqual(paidCell.accounting.cashEstimate, { usd: 0, receipts: 0 });
    assert.deepEqual(paidCell.missingness.cost, { observed: 0, missing: 1, noAttempt: 0 });

    for (const [label, attempt] of [
      ["negative price", attemptRow(paidTask!, 1, at(11), "api", -1)],
      ["billing mode not reported", attemptRow(paidTask!, 1, at(11), undefined, 1)],
      ["unattributed paid call", attemptRow(paidTask!, 1, at(11), "api", 1, { selection_assignment_id: "unknown-assignment" })],
    ] as const) {
      const evidence = await evidenceOver(dir, protocol, { live: [assignmentRow(paidTask!, 1, at(10), PAID_PIN), attemptRow(paidTask!, 1, at(11), "api", 1), attempt] });
      assert.deepEqual(pausedFor(evidence), ["cost-evidence-ambiguous"], label);
    }
    const subscriptionUnknown = await evidenceOver(dir, protocol, { live: [assignmentRow(paidTask!, 1, at(10), PAID_PIN),
      attemptRow(paidTask!, 1, at(11), "api", 1), assignmentRow(controlTask!, 1, at(12), CONTROL_PIN),
      attemptRow(controlTask!, 1, at(13), "subscription", undefined)] });
    assert.deepEqual(pausedFor(subscriptionUnknown), ["admitted"], "an unpriced subscription call is notional debt, not cash risk");

    const blindRotation = join(dir, "blind");
    writeCorpus(blindRotation, { live: [assignmentRow(paidTask!, 1, at(10), PAID_PIN), attemptRow(paidTask!, 1, at(11), "api", 1)] });
    writeFileSync(join(blindRotation, "ledger.2026-09-28T00-00-00-000Z.ndjson.gz"), "not gzip at all");
    const unreadable = await readPaidPilotEvidence(blindRotation, protocol);
    assert.equal(unreadable.state, "unavailable");
    assert.deepEqual(unreadable.unreadSources, ["ledger.2026-09-28T00-00-00-000Z.ndjson.gz"]);
    assert.deepEqual(pausedFor(unreadable), ["spend-source-unreadable"], "a source the spend window needs cannot read as zero");
    assert.equal(admit(protocol, paidTask!, unreadable).remainingCashUsd, null);
    unlinkSync(join(blindRotation, "ledger.2026-09-28T00-00-00-000Z.ndjson.gz"));
    writeFileSync(join(blindRotation, "ledger.2026-09-20T00-00-00-000Z.ndjson.gz"), "an old broken archive");
    assert.deepEqual(pausedFor(await readPaidPilotEvidence(blindRotation, protocol)), ["admitted"],
      "an archive rotated before activation holds no spend-window row and is not required");
    assert.deepEqual(pausedFor(await readPaidPilotEvidence(join(dir, "no-such-state"), protocol)), ["spend-source-unreadable"]);
    const noLive = join(dir, "no-live");
    writeCorpus(noLive, { plain: [] });
    assert.deepEqual(pausedFor(await readPaidPilotEvidence(noLive, protocol)), ["spend-source-missing"]);

    const good = encode([assignmentRow(paidTask!, 1, at(10), PAID_PIN), attemptRow(paidTask!, 1, at(11), "api", 1)]);
    const malformed = await evidenceOver(dir, protocol, { live: `${good}{"ts":"2026-09-28T00:00:00.000Z","step":\n${good}` });
    assert.equal(malformed.state, "observed-partial");
    assert.deepEqual(pausedFor(malformed), ["spend-source-malformed"]);
    const tornTail = await evidenceOver(dir, protocol, { live: `${good}{"ts":"2026-09-28T00:00:00.000Z","step":"worker.att` });
    assert.deepEqual(pausedFor(tornTail), ["admitted"], "a torn live tail is an append in flight, not damage");

    const relabeled = await evidenceOver(dir, protocol, { live: [assignmentRow(paidTask!, 1, at(10), PAID_PIN,
      { benchmark_run: { allocation: { method: "randomized", experimentId: protocol.pilotId, arm: "control" } } }),
    attemptRow(paidTask!, 1, at(11), "api", 1)] });
    assert.deepEqual(pausedFor(relabeled), ["allocation-drift:recorded-label"]);
    const tampered = { ...protocol, cash: { ...protocol.cash, ceilingUsd: 1000 } };
    assert.deepEqual(pausedFor(healthy, tampered), ["allocation-drift:protocol-changed"]);
    const flipped = { ...protocol, population: protocol.population.map((task) => task.taskId === paidOther ? { ...task, arm: "control" as const } : task) };
    const { digest: _digest, ...body } = flipped;
    void _digest;
    const redrawn = { ...flipped, digest: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
    assert.deepEqual(pausedFor(healthy, redrawn), ["allocation-drift:draw-changed"]);

    assert.deepEqual(admit(null, paidTask!, unreadable), { arm: null, paidArm: "not-applicable", reasons: ["no-activated-pilot"],
      ordinaryFlow: "continues", remainingCashUsd: null });
    const unreadableProtocol = admit({ unavailable: "protocol-invalid" }, controlTask!, healthy);
    assert.deepEqual([unreadableProtocol.arm, unreadableProtocol.paidArm, unreadableProtocol.ordinaryFlow], [null, "paused", "continues"],
      "an unreadable protocol holds paid work only; everything else dispatches ordinarily");
    assert.deepEqual(paidArmPauseReasons(protocol, unreadable, EXPIRES).reasons, ["pilot-window-expired", "spend-source-unreadable"]);
    assert.deepEqual(paidArmPauseReasons(protocol, { ...unreadable, reason: undefined }, DURING).reasons, ["spend-source-unavailable"]);
  });
});

test("paid benchmark pilot reports evidence without fabricated wins", async () => {
  const protocol = pilot();
  const paid = armTasks(protocol, "paid");
  const control = armTasks(protocol, "control");
  const at = (minutes: number) => plus(ACT, minutes * 60_000);
  const rows: Row[] = [...paid, ...control].flatMap((taskId, i) => {
    const pin = paid.includes(taskId) ? PAID_PIN : CONTROL_PIN;
    return [assignmentRow(taskId, 1, at(10 + i), pin), attemptRow(taskId, 1, at(40 + i), paid.includes(taskId) ? "api" : "subscription", 0.5)];
  });
  rows[0] = assignmentRow(paid[0]!, 1, at(10), PAID_PIN, { benchmark_run: { stack: { harnessRevision: { state: "observed", value: "b".repeat(40) } } } });
  const files = (asOf: string, controlState: "MERGED" | "CLOSED") => [...paid.map((taskId, i) => caseFile(taskId, [1], "MERGED", 100 + i, asOf)),
    ...control.map((taskId, i) => caseFile(taskId, [1], controlState, 200 + i, asOf))];
  await withDir(async (dir) => {
    const evidence = await evidenceOver(dir, protocol, { live: rows });
    const early = buildPaidPilotReport({ protocol, evidence, nowIso: DURING, caseFiles: files(DURING, "CLOSED") });
    assert.equal(early.cells.find((cell) => cell.arm === "paid" && cell.taskClass === "*")!.verifiedCompletion.rate, 1);
    assert.equal(early.cells.find((cell) => cell.arm === "control" && cell.taskClass === "*")!.verifiedCompletion.rate, 0);
    assert.deepEqual(early.conclusion, { state: "no-conclusion", reason: "stopping-rule-not-met" }, "a lopsided interim result is not a win");
    assert.equal(early.winnerDeclared, false);
    assert.equal(early.stoppingRule.met, false);
    assert.equal(early.cells[0]!.laterDefects.state, "censored", "later defects are censored until the maturity window closes");
    assert.deepEqual([early.visibility, early.export, early.publicClaim], ["private", "none", "requires-reviewed-release"]);
    assert.ok("estimate" in early.uncertainty.difference && early.uncertainty.difference.estimate === 1);
    const paidCell = early.cells.find((cell) => cell.arm === "paid" && cell.taskClass === "*")!;
    const controlCell = early.cells.find((cell) => cell.arm === "control" && cell.taskClass === "*")!;
    assert.deepEqual(paidCell.accounting.cashEstimate, { usd: paid.length * 0.5, receipts: paid.length });
    assert.deepEqual(paidCell.accounting.subscriptionNotional, { usd: 0, receipts: 0 });
    assert.deepEqual(controlCell.accounting.subscriptionNotional, { usd: control.length * 0.5, receipts: control.length });
    assert.deepEqual(controlCell.accounting.cashEstimate, { usd: 0, receipts: 0 }, "cash and notional are never one total");
    assert.equal(early.cash.spentEstimateUsd, paid.length * 0.5);
    assert.equal(early.cash.subscriptionNotionalUsd, control.length * 0.5);
    assert.equal(early.cash.invoice, "unavailable-no-invoice-receipt");
    assert.equal(early.cash.source, "worker-result-estimate-not-invoice");
    assert.deepEqual(paidCell.humanEffort, { state: "unavailable", reason: "no-independent-human-effort-receipt" });
    assert.deepEqual(paidCell.missingness.servedModel, { observed: paid.length, missing: 0, noAttempt: 0 });
    assert.deepEqual(early.stack.revisions, protocol.revisions);
    assert.equal(early.stack.offPinExposures, 1);
    assert.equal(early.stack.unpinnedExposures, 1);
    assert.equal(early.evalCard!.kind, "paid-pilot");
    assert.deepEqual(early.evalCard!.aa, { state: "cited", receipt: protocol.aaReceipt.reportHash });
    assert.ok(early.sampleRatio.exactBinomialPValue !== null && early.sampleRatio.exactBinomialPValue > 0.001);
    const text = JSON.stringify(early);
    for (const secret of [...paid, ...control, ...CONSENTED, "private-host", "private-account", `${paid[0]}-1`, "local-salt-7", "seed-fixture-1"])
      assert.equal(text.includes(secret), false, `the report carries no ${secret}`);

    const late = buildPaidPilotReport({ protocol, evidence, nowIso: AFTER, caseFiles: files(AFTER, "CLOSED") });
    assert.equal(late.stoppingRule.met, true);
    assert.deepEqual(late.conclusion, { state: "difference-observed", favors: "paid" });
    assert.equal(late.winnerDeclared, true, "only the declared stopping rule reaches a conclusion");
    assert.equal(late.publicClaim, "requires-reviewed-release");
    assert.equal(late.cells[0]!.laterDefects.state, "unavailable");
    assert.equal(late.window.expired, true);
    assert.equal(late.paidArm.state, "paused");
    const balanced = buildPaidPilotReport({ protocol, evidence, nowIso: AFTER, caseFiles: files(AFTER, "MERGED") });
    assert.deepEqual(balanced.conclusion, { state: "inconclusive", reason: "no-decisive-difference" });
    assert.equal(balanced.winnerDeclared, false);
    const oneArm = pilot({ population: parsedRequest().population.filter((task) => paidPilotArmFor("seed-fixture-1", task.taskId) === "paid") });
    const lonely = buildPaidPilotReport({ protocol: oneArm, evidence: { ...evidence, rows: [] }, nowIso: AFTER });
    assert.deepEqual(lonely.conclusion, { state: "inconclusive", reason: "an-arm-has-no-allocated-units" });
    assert.equal(lonely.sampleRatio.exactBinomialPValue, null);
  });

  await withDir(async (dir) => {
    const stateDir = join(dir, "state");
    assert.equal((await runVerb(activationArgs(dir, pilotRequest(), aaReport()), ACT)).code, 0);
    writeCorpus(stateDir, { live: rows });
    writeFileSync(join(dir, "cases.json"), JSON.stringify(files(DURING, "CLOSED")));
    const reportArgs = ["report", "--pilot", "pilot-fixture-1", "--state-dir", stateDir];
    const first = await runVerb([...reportArgs, "--case-files", join(dir, "cases.json")], DURING);
    assert.equal(first.code, 0, first.printed.join("\n"));
    assert.ok(first.printed[0]!.includes("paid arm admitting"));
    const saved = join(stateDir, "benchmark-paid-pilot-v1.pilot-fixture-1.report.json");
    assert.equal((JSON.parse(readFileSync(saved, "utf8")) as PaidPilotReport).lastGoodAt, DURING);
    unlinkSync(join(stateDir, "ledger.ndjson"));
    const later = plus(DURING, 3_600_000);
    const stale = await runVerb([...reportArgs, "--json"], later);
    assert.equal(stale.code, 1);
    const kept = JSON.parse(stale.printed[0]!) as PaidPilotReport;
    assert.equal(kept.state, "stale");
    assert.equal(kept.lastGoodAt, DURING, "the last-known-good report keeps its date");
    assert.equal(kept.unavailableReason, "spend-source-missing");
    assert.deepEqual(kept.paidArm, { state: "paused", reasons: ["spend-source-missing"] });
    assert.equal(kept.followUps[0]!.kind, "repair");
    assert.ok(kept.cells.length > 0, "the dated evidence survives the outage");
    const text = await runVerb(reportArgs, later);
    assert.ok(text.printed.some((line) => line.startsWith("  follow-up: file a task")));
    const blank = await runVerb([...reportArgs, "--out", join(dir, "fresh.json"), "--json"], later, activateBenchmarkPaidPilot,
      async () => { throw new Error("stream failed"); });
    const fresh = JSON.parse(blank.printed[0]!) as PaidPilotReport;
    assert.deepEqual([fresh.state, fresh.unavailableReason, fresh.lastGoodAt], ["unavailable", "spend-source-read-failed", null]);
    assert.deepEqual(fresh.cells, []);
    assert.equal(fresh.followUps.length, 1);
    writeFileSync(join(dir, "other.json"), JSON.stringify({ ...kept, pilotId: "someone-else" }));
    const other = await runVerb([...reportArgs, "--out", join(dir, "other.json"), "--json"], later);
    assert.equal((JSON.parse(other.printed[0]!) as PaidPilotReport).state, "unavailable", "another pilot's report is never a prior");
  });
});

test("rmd benchmark-paid-pilot is an operator verb, and a refused activation starts nothing", async () => {
  const { COMMANDS, HANDLERS } = await import("../src/run-task.js");
  assert.ok(COMMANDS.some((spec) => spec.name === "benchmark-paid-pilot" && spec.syntax.includes("activate --request") && !spec.syntax.includes("confirm-cash-ceiling")));
  const home = mkdtempSync(join(tmpdir(), "rmd-benchmark-paid-pilot-home-"));
  const savedHome = process.env.HOME;
  const savedLog = console.log;
  try {
    const root = join(home, "Remudero");
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
    mkdirSync(join(root, "state"), { recursive: true });
    process.env.HOME = home;
    const printed: string[] = [];
    console.log = (line: string) => { printed.push(line); };
    const args = activationArgs(home, pilotRequest(), aaReport("clean", "2026-01-01T00:00:00.000Z"), join(root, "state")).slice(0, -2);
    assert.equal(await HANDLERS.get("benchmark-paid-pilot")!(args), 2, "a receipt from 2026-01-01 is not current on the real clock");
    assert.ok(printed[0]!.includes("aa-receipt-stale") && printed[0]!.includes("nothing was activated"));
    assert.deepEqual(readdirSync(join(root, "state")), [], "a refused activation writes nothing");
    assert.equal(await HANDLERS.get("benchmark-paid-pilot")!(["report", "--pilot", "pilot-fixture-1"]), 2);
    assert.ok(printed[1]!.includes("protocol-unreadable-or-not-activated"));
  } finally {
    console.log = savedLog;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("rmd benchmark-paid-pilot refuses malformed invocations by name", async () => {
  await withDir(async (dir) => {
    const reasonOf = async (args: string[], activate = activateBenchmarkPaidPilot) => (await runVerb(args, ACT, activate)).printed[0]!;
    assert.match(await reasonOf([]), /^usage: /);
    assert.match(await reasonOf(["bogus"]), /^usage: /);
    assert.match(await reasonOf(["activate", "--nope"]), /arguments-invalid/);
    const good = activationArgs(dir, pilotRequest(), aaReport());
    const without = (flag: string) => good.filter((_, i) => good[i] !== flag && good[i - 1] !== flag);
    // Operator ruling 2026-09-28: the confirm flag is gone; the $100 ceiling stays in the protocol.
    assert.match(await reasonOf([...good, "--confirm-cash-ceiling-usd", "100"]), /arguments-invalid/);
    assert.match(await reasonOf(without("--request")), /request-and-aa-report-required/);
    assert.match(await reasonOf(good.map((arg) => arg.endsWith("request-pilot-fixture-1.json") ? join(dir, "missing.json") : arg)), /request-unreadable/);
    writeFileSync(join(dir, "bad-request.json"), JSON.stringify({ version: "v0" }));
    assert.match(await reasonOf(good.map((arg) => arg.endsWith("request-pilot-fixture-1.json") ? join(dir, "bad-request.json") : arg)),
      /request-version-unsupported/);
    writeFileSync(join(dir, "a-file"), "");
    assert.match(await reasonOf([...good, "--state-dir", join(dir, "a-file")]), /state-dir-unreadable/);
    const stateDir = join(dir, "state");
    const racing = (input: Parameters<typeof activateBenchmarkPaidPilot>[0]) => {
      const result = activateBenchmarkPaidPilot(input);
      writeFileSync(join(stateDir, "benchmark-paid-pilot-v1.pilot-fixture-1.protocol.json"), "{}");
      return result;
    };
    assert.match(await reasonOf(good, racing), /protocol-not-persisted/, "a protocol that appeared first is never overwritten");
    assert.equal(readFileSync(join(stateDir, "benchmark-paid-pilot-v1.pilot-fixture-1.protocol.json"), "utf8"), "{}");
    assert.deepEqual(readdirSync(stateDir).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left behind");
    assert.match(await reasonOf(activationArgs(dir, pilotRequest({ pilotId: "pilot-fixture-9" }), aaReport())), /another-pilot-active/,
      "an unreadable protocol on disk counts as an active pilot");
    assert.deepEqual(loadPaidPilotProtocol(stateDir, "pilot-fixture-1"), { ok: false, reason: "protocol-invalid" });
    assert.match(await reasonOf(["report", "--pilot", "../escape", "--state-dir", stateDir]), /^usage: /);
    assert.match(await reasonOf(["report", "--pilot", "pilot-fixture-1", "--state-dir", stateDir]), /protocol-invalid/);

    const liveState = join(dir, "live-state");
    assert.equal((await runVerb(activationArgs(dir, pilotRequest(), aaReport(), liveState), ACT)).code, 0);
    const reportArgs = ["report", "--pilot", "pilot-fixture-1", "--state-dir", liveState];
    assert.match(await reasonOf([...reportArgs, "--case-files", join(dir, "missing.json")]), /case-file-snapshot-unreadable/);
    writeFileSync(join(dir, "bad-cases.json"), JSON.stringify([{ version: "v0" }]));
    assert.match(await reasonOf([...reportArgs, "--case-files", join(dir, "bad-cases.json")]), /case-file-snapshot-invalid/);
    const unwritable = await runVerb([...reportArgs, "--out", join(dir, "no-such-dir", "report.json")], DURING);
    assert.ok(unwritable.printed[0]!.includes("report-not-persisted"));
    assert.equal(unwritable.code, 1, "no live ledger: the report is unavailable, and says so");
    assert.equal(existsSync(join(dir, "no-such-dir")), false);
  });

  const reasonOf = (changes: Record<string, unknown>) => {
    const parsed = parsePaidPilotRequest(pilotRequest(changes));
    return parsed.ok ? "accepted" : parsed.reason;
  };
  const population = pilotRequest().population as Record<string, unknown>[];
  assert.equal(reasonOf({}), "accepted");
  assert.equal(parsePaidPilotRequest(null).ok, false);
  assert.equal(reasonOf({ pilotId: "../x" }), "pilot-id-invalid");
  assert.equal(reasonOf({ approval: {} }), "approval-reference-missing");
  assert.equal(reasonOf({ repos: CONSENTED.slice(0, 2).map((repo) => ({ repo, consentReceipt: "c" })) }), "three-consented-repos-required");
  assert.equal(reasonOf({ repos: [CONSENTED[0], CONSENTED[0], CONSENTED[1]].map((repo) => ({ repo, consentReceipt: "c" })) }), "three-consented-repos-required");
  assert.equal(reasonOf({ repos: CONSENTED.map((repo) => ({ repo })) }), "three-consented-repos-required");
  assert.equal(reasonOf({ repos: "none" }), "three-consented-repos-required");
  assert.equal(reasonOf({ assignmentSeed: " " }), "seed-and-salt-required");
  assert.equal(reasonOf({ arms: { paid: PAID_PIN } }), "arm-not-pinned:control");
  assert.equal(reasonOf({ arms: { paid: PAID_PIN, control: PAID_PIN } }), "arms-must-differ-in-model");
  assert.equal(reasonOf({ revisions: { harnessRevision: "main" } }), "revision-not-pinned:harnessRevision");
  assert.equal(reasonOf({ strataRevision: "" }), "strata-revision-missing");
  assert.equal(reasonOf({ population: [] }), "population-missing");
  assert.equal(reasonOf({ population: [{ taskId: "T1" }] }), "population-entry-invalid");
  assert.equal(reasonOf({ population: [{ ...population[0], repo: "fixture-org/delta" }] }), "population-repo-not-consented");
  assert.equal(reasonOf({ population: [population[0], population[0]] }), "population-task-duplicated");
  assert.equal(reasonOf({ primaryOutcome: "merged" }), "primary-outcome-must-be-verified-completion");
  assert.equal(reasonOf({ maturityDays: 0 }), "maturity-days-invalid");
  assert.equal(reasonOf({ maturityDays: 1.5 }), "maturity-days-invalid");
  assert.equal(reasonOf({ protocolText: "" }), "protocol-text-missing");
  assert.equal(parsedRequest({ approval: { reference: "#7418" } }).approval.approvedAt, null);
  assert.equal(REPO_IDENTITY_RE.test("fixture-org/alpha"), true);
  assert.equal(REPO_IDENTITY_RE.test("alpha"), false);
  assert.equal(REPO_IDENTITY_RE.test("-org/alpha"), false);
});
