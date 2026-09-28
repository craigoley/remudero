// test/an-eval-card-is-served-for-a-real-trial.test.ts — W1-T4643: GET /v1/analytics?projectionVersion=
// eval-card-v1 serves the card of a real trial found in the state dir. Every case runs the production
// route table (buildServeRoutes) over a temp state dir, and every trial file is written by its own
// module's operator verb, so the card served is the one that module built, not a fixture of it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { benchmarkAaCommand, buildBenchmarkAaReport, type AaLedgerEvidence, type AaRow, type BenchmarkAaReport } from "../src/lib/benchmark-aa.js";
import { activateBenchmarkPaidPilot, benchmarkPaidPilotCommand, buildPaidPilotReport, loadPaidPilotProtocol, paidPilotEvalCardTrial,
  type PaidPilotEvidence, type PaidPilotReport, type PaidPilotRow } from "../src/lib/benchmark-paid-pilot.js";
import { fixedClock } from "../src/lib/clock.js";
import { buildEvalCard, emptyEvalCardEvidence, parseEvalCardEvidence, parseEvalCardTrial, type EvalCard } from "../src/lib/eval-card.js";
import { buildServeRoutes, EVAL_CARD_SOURCE_MAX_BYTES, readEvalCardInput, type ServeDeps } from "../src/lib/serve.js";
import type { Route } from "../src/lib/service.js";
import type { TaskCaseFile } from "../src/lib/task-case-file.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const clock = fixedClock(Date.parse("2026-09-27T12:10:00.000Z"));
const at = (offsetMs: number) => fixedClock(clock.now() + offsetMs).iso();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const AA_NOW = at(0);
const ACT = at(50 * MINUTE);
const DURING = at(25 * HOUR);
const SHA = "a".repeat(40);
const REVISIONS = ["harnessRevision", "promptRevision", "toolRevision", "scorerRevision", "environmentRevision"];
const CONTROL_PIN = { provider: "claude", model: "claude-sonnet-5", effort: "high" };
const PAID_PIN = { provider: "cash", model: "gpt-oss-120b", effort: "medium" };
const CONSENTED = ["fixture-org/alpha", "fixture-org/beta", "fixture-org/gamma"];
const AA_TASKS = Array.from({ length: 10 }, (_, i) => `AA-T${i + 1}`);

function withStateDir<T>(body: (dir: string, stateDir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4643-`));
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  return body(dir, stateDir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** The production route table's eval-card projection, over `stateDir`. Config is never loaded. */
function analyticsRoute(root: string, stateDir: string): Route {
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const deps: ServeDeps = {
    board: { plan: { tasks: [], byId: new Map() } as never, ledgerPath, github: fakeGitHub() },
    panelGraph: { root, planPath: join(root, "plan", "tasks.yaml"), ledgerPath, github: { prView: () => null },
      statusGithub: fakeGitHub(), ratify: { approve: () => {}, reframe: () => {} } },
    ledgerPath, issues: { close: () => {} }, fleetControlRoot: root, questionsRoot: root,
    tokens: { read: "read-token", write: "write-token" }, consoleSha: SHA,
    githubAppRefresh: { start: () => ({ armed: false }) } as never,
  };
  const route = buildServeRoutes(deps).find((candidate) => candidate.method === "GET" && candidate.path === "/v1/analytics");
  assert.ok(route, "the production route table mounts GET /v1/analytics");
  return route;
}

async function evalCard(route: Route, trial?: string): Promise<EvalCard> {
  let status = 0;
  let body = "";
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    end(chunk?: string) { body = chunk ?? ""; return this; },
  } as unknown as ServerResponse;
  const query = trial === undefined ? "" : `&trial=${encodeURIComponent(trial)}`;
  await route.handler({ url: `/v1/analytics?projectionVersion=eval-card-v1${query}` } as never, res, { params: {} });
  assert.equal(status, 200);
  return JSON.parse(body) as EvalCard;
}

const EMPTY_CARD = JSON.parse(JSON.stringify(buildEvalCard(null, emptyEvalCardEvidence()))) as EvalCard;
const asServed = (card: EvalCard | null) => JSON.parse(JSON.stringify(card)) as EvalCard;

// ── the A/A trial, written by `rmd benchmark-aa` ────────────────────────────────────────────────

function aaRow(step: string, taskId: string, ts: string): AaRow {
  const assignment = step === "worker.assignment";
  return { ts, step, taskId, runId: `${taskId}-1`, assignmentId: assignment ? `${taskId}-a1` : null,
    selectionAssignmentId: assignment ? null : `${taskId}-a1`, selected: { ...CONTROL_PIN },
    stack: Object.fromEntries(REVISIONS.map((field) => [field, { state: "observed", value: SHA }])),
    work: { taskClass: "fix", risk: "low" }, recordedArm: null, routingExperiment: null, success: true,
    servedModel: CONTROL_PIN.model, billingMode: "subscription", costUsd: 0.5, tokensObserved: true, durationObserved: true, retract: false };
}

function caseFile(taskId: string, prNumber: number, asOf: string): TaskCaseFile {
  const seen = <T>(value: T) => ({ state: "observed" as const, value, source: "fixture", asOf });
  const gone = (reason: string) => ({ state: "unavailable" as const, reason, source: "fixture", asOf });
  return {
    version: "task-case-file-v1", taskId, asOf,
    plan: seen({ title: taskId, dependsOn: [], verify: "auto", risk: "low" }),
    ledger: seen({ windowStart: at(-30 * 24 * HOUR), forms: { gzip: 1, plain: 1, live: 1 }, matchingRows: 3 }),
    runs: [{ runId: `${taskId}-1`, startedAt: at(-70 * MINUTE), assignmentId: `${taskId}-a1`, selectedProvider: "claude",
      selectedModel: CONTROL_PIN.model, servedModel: CONTROL_PIN.model, billingMode: "subscription", costUsd: 0.5, verdict: "passed", prNumber }],
    pr: seen({ number: prNumber, url: `https://example.invalid/pull/${prNumber}`, headSha: SHA, state: "MERGED", taskCredit: true }),
    review: seen({ headSha: SHA, status: "success" as const }), acceptance: seen({ headSha: SHA, status: "success" as const }),
    ci: seen({ headSha: SHA, status: "success" as const }), mergedSource: seen({ prNumber, mergedAt: asOf }),
    deployment: gone("not-collected"), runtime: gone("not-collected"), next: null,
  } as TaskCaseFile;
}

/** Runs the real A/A verb into `stateDir` and returns the report it wrote. */
async function runAaVerb(dir: string, stateDir: string, trialId = "aa-fixture-1"): Promise<BenchmarkAaReport> {
  const manifestPath = join(dir, `manifest-${trialId}.json`);
  const casesPath = join(dir, "case-files.json");
  writeFileSync(manifestPath, JSON.stringify({ version: "benchmark-aa-trial-v1", trialId, cohort: { kind: "public-fixture" },
    stack: { ...CONTROL_PIN, ...Object.fromEntries(REVISIONS.map((field) => [field, SHA])) }, strataRevision: "strata-v1",
    tasks: AA_TASKS.map((taskId) => ({ taskId, taskClass: "fix", risk: "low" })),
    protocolText: "A/A: identical arms, verified completion, task unit.\n", preRegisteredAt: at(-26 * 24 * HOUR) }));
  writeFileSync(casesPath, JSON.stringify(AA_TASKS.map((taskId, i) => caseFile(taskId, 500 + i, AA_NOW))));
  const rows = AA_TASKS.flatMap((taskId, i) => [aaRow("worker.assignment", taskId, at(-70 * MINUTE + i * MINUTE)),
    aaRow("verdict", taskId, at(-70 * MINUTE + i * MINUTE + 30_000))]);
  const evidence: AaLedgerEvidence = { state: "observed", forms: { gzip: 0, plain: 0, live: 1 }, unreadSources: [], malformedRows: 0,
    duplicateRows: 0, ledgerAssignments: AA_TASKS.length, newestTs: rows[rows.length - 1]!.ts, rows };
  const printed: string[] = [];
  const code = await benchmarkAaCommand(["--trial", manifestPath, "--state-dir", stateDir, "--case-files", casesPath, "--no-cohort", "--json"],
    buildBenchmarkAaReport, { nowIso: AA_NOW, print: (line) => printed.push(line), readEvidence: async () => evidence,
      resolveStateDir: () => { throw new Error("tests always pass --state-dir"); } });
  assert.equal(code, 0, printed.join("\n"));
  return JSON.parse(printed[0]!) as BenchmarkAaReport;
}

// ── the paid pilot, activated and reported by `rmd benchmark-paid-pilot` ────────────────────────

async function runPilotVerb(dir: string, stateDir: string, args: string[], nowIso: string,
  readEvidence?: () => Promise<PaidPilotEvidence>): Promise<string[]> {
  const printed: string[] = [];
  const code = await benchmarkPaidPilotCommand([...args, "--state-dir", stateDir], activateBenchmarkPaidPilot, { nowIso,
    print: (line) => printed.push(line), resolveStateDir: () => { throw new Error("tests always pass --state-dir"); },
    ...(readEvidence ? { readEvidence } : {}) });
  assert.equal(code, 0, printed.join("\n"));
  return printed;
}

async function activatePilot(dir: string, stateDir: string, aa: BenchmarkAaReport): Promise<void> {
  const requestPath = join(dir, "pilot-request.json");
  const aaPath = join(dir, "aa-report.json");
  writeFileSync(aaPath, JSON.stringify(aa));
  writeFileSync(requestPath, JSON.stringify({
    version: "benchmark-paid-pilot-request-v1", pilotId: "pilot-fixture-1", approval: { reference: "#7418", approvedAt: at(-2 * 24 * HOUR) },
    repos: CONSENTED.map((repo, i) => ({ repo, consentReceipt: `consent-${i}` })), pseudonymSalt: "local-salt-7",
    assignmentSeed: "seed-fixture-1", arms: { paid: PAID_PIN, control: CONTROL_PIN },
    revisions: Object.fromEntries(REVISIONS.map((field) => [field, SHA])), strataRevision: "strata-v1",
    population: Array.from({ length: 24 }, (_, i) => ({ taskId: `PP-T${i + 1}`, repo: CONSENTED[i % 3], taskClass: i % 2 === 0 ? "fix" : "docs", risk: "low" })),
    primaryOutcome: "verified-completion", maturityDays: 14, protocolText: "Paid pilot: ITT verified completion, task unit, fixed horizon.\n",
  }));
  await runPilotVerb(dir, stateDir, ["activate", "--request", requestPath, "--aa-report", aaPath, "--confirm-cash-ceiling-usd", "100", "--json"], ACT);
}

function assignment(taskId: string, pin: typeof PAID_PIN, ts: string): PaidPilotRow {
  return { ts, step: "worker.assignment", taskId, runId: `${taskId}-1`, assignmentId: `${taskId}-a1`, selectionAssignmentId: null,
    selected: { ...pin }, recordedArm: null, revisionsOffPin: 0, revisionsUnpinned: 0, servedModel: null, billingMode: null,
    cost: { state: "missing" }, paired: null };
}

async function reportPilot(dir: string, stateDir: string): Promise<PaidPilotReport> {
  const loaded = loadPaidPilotProtocol(stateDir, "pilot-fixture-1");
  assert.ok(loaded.ok);
  const rows = loaded.protocol.population.slice(0, 6).map((task, i) =>
    assignment(task.taskId, task.arm === "paid" ? PAID_PIN : CONTROL_PIN, at(2 * HOUR + i * MINUTE)));
  const evidence: PaidPilotEvidence = { state: "observed", forms: { gzip: 0, plain: 0, live: 1 }, unreadSources: [], malformedRows: 0,
    duplicateRows: 0, newestTs: rows[rows.length - 1]!.ts, rows };
  const printed = await runPilotVerb(dir, stateDir, ["report", "--pilot", "pilot-fixture-1", "--json"], DURING, async () => evidence);
  return JSON.parse(printed[0]!) as PaidPilotReport;
}

// ── the cases ───────────────────────────────────────────────────────────────────────────────────

test("W1-T4643: a real A/A report in the state dir is served as its own card, by id and as the newest trial", async () => {
  await withStateDir(async (dir, stateDir) => {
    const report = await runAaVerb(dir, stateDir);
    assert.equal(report.verdict, "no-integrity-concern-detected", "the fixture is a clean, observed A/A trial");
    const route = analyticsRoute(dir, stateDir);
    const served = await evalCard(route, "aa-fixture-1");
    assert.deepEqual(served, asServed(report.evalCard), "the served card is the one the A/A module built for its own report");
    assert.equal(served.state, "observed");
    assert.equal(served.trialId, "aa-fixture-1");
    assert.equal(served.kind, "aa");
    assert.equal(served.visibility, "private");
    assert.notDeepEqual(served, EMPTY_CARD);
    assert.deepEqual(await evalCard(route), served, "with no trial named, the newest trial file is served");
  });
});

test("W1-T4643: a paid pilot is served from its protocol, then from its report once one is written", async () => {
  await withStateDir(async (dir, stateDir) => {
    const aa = await runAaVerb(dir, stateDir);
    await activatePilot(dir, stateDir, aa);
    const route = analyticsRoute(dir, stateDir);
    const loaded = loadPaidPilotProtocol(stateDir, "pilot-fixture-1");
    assert.ok(loaded.ok);
    const registered = await evalCard(route, "pilot-fixture-1");
    assert.deepEqual(registered, asServed(buildEvalCard(paidPilotEvalCardTrial(loaded.protocol), emptyEvalCardEvidence())),
      "an activated pilot with no report yet reads its registered trial with no evidence, never invented outcomes");
    assert.equal(registered.kind, "paid-pilot");
    assert.deepEqual(registered.aa, { state: "cited", receipt: loaded.protocol.aaReceipt.reportHash });
    assert.equal(registered.preRegistration.firstAssignmentAt, null);

    const report = await reportPilot(dir, stateDir);
    const reported = await evalCard(route, "pilot-fixture-1");
    assert.deepEqual(reported, asServed(report.evalCard), "the served card is the one the pilot module built for its own report");
    assert.equal(reported.preRegistration.firstAssignmentAt, at(2 * HOUR));

    const aaFile = join(stateDir, "benchmark-aa-v1.aa-fixture-1.json");
    const pilotFiles = ["protocol", "report"].map((role) => join(stateDir, `benchmark-paid-pilot-v1.pilot-fixture-1.${role}.json`));
    const stamp = (path: string, offsetMs: number) => utimesSync(path, new Date(clock.now() + offsetMs), new Date(clock.now() + offsetMs));
    stamp(aaFile, 0);
    for (const path of pilotFiles) stamp(path, HOUR);
    assert.equal((await evalCard(route)).trialId, "pilot-fixture-1", "the newest trial file names the trial served");
    stamp(aaFile, 2 * HOUR);
    assert.equal((await evalCard(route)).trialId, "aa-fixture-1");
  });
});

test("W1-T4643: an unknown trial, or a state dir with no trials, reads the empty card", async () => {
  await withStateDir(async (dir, stateDir) => {
    const route = analyticsRoute(dir, stateDir);
    assert.deepEqual(await evalCard(route), EMPTY_CARD, "no trial file: the empty card");
    await runAaVerb(dir, stateDir);
    assert.deepEqual(await evalCard(route, "no-such-trial"), EMPTY_CARD);
    assert.deepEqual(await evalCard(route, "../benchmark-aa-v1.aa-fixture-1"), EMPTY_CARD, "an id is matched, never resolved as a path");
    assert.equal(readEvalCardInput(join(dir, "missing-state"), undefined), undefined, "an unreadable state dir is no trial at all");
  });
});

test("W1-T4643: an unreadable, malformed or oversized trial file reads the empty card, never a fabricated one", async () => {
  await withStateDir(async (dir, stateDir) => {
    const route = analyticsRoute(dir, stateDir);
    const write = (name: string, body: string) => writeFileSync(join(stateDir, name), body);

    write("benchmark-aa-v1.torn.json", '{"version":"benchmark-aa-v1","trialId":"torn","evalCardIn');
    assert.deepEqual(await evalCard(route, "torn"), EMPTY_CARD, "a torn A/A report");
    write("benchmark-aa-v1.legacy.json", JSON.stringify({ version: "benchmark-aa-v1", trialId: "legacy", evalCard: { trialId: "legacy" } }));
    assert.deepEqual(await evalCard(route, "legacy"), EMPTY_CARD, "an A/A report written before it carried its card input");
    write("benchmark-aa-v1.unavailable.json", JSON.stringify({ version: "benchmark-aa-v1", trialId: "unavailable", evalCardInput: null }));
    assert.deepEqual(await evalCard(route, "unavailable"), EMPTY_CARD, "an A/A report that could not read its sources");
    write("benchmark-aa-v1.null.json", "null");
    assert.deepEqual(await evalCard(route, "null"), EMPTY_CARD, "a report that is not an object");

    const real = await runAaVerb(dir, stateDir, "aa-oversized");
    assert.equal(real.trialId, "aa-oversized");
    truncateSync(join(stateDir, "benchmark-aa-v1.aa-oversized.json"), EVAL_CARD_SOURCE_MAX_BYTES + 1);
    assert.deepEqual(await evalCard(route, "aa-oversized"), EMPTY_CARD, "a file past the backstop is refused unread");

    write("benchmark-paid-pilot-v1.orphan.report.json", JSON.stringify({ version: "benchmark-paid-pilot-v1", pilotId: "orphan", evalCardEvidence: null }));
    assert.deepEqual(await evalCard(route, "orphan"), EMPTY_CARD, "a pilot report with no protocol has no trial to show");
    write("benchmark-paid-pilot-v1.hollow.protocol.json", JSON.stringify({ protocol: { version: "benchmark-paid-pilot-v1", pilotId: "hollow" } }));
    assert.deepEqual(await evalCard(route, "hollow"), EMPTY_CARD, "a protocol missing its population");
    write("benchmark-paid-pilot-v1.wrong.protocol.json", JSON.stringify({ protocol: { version: "benchmark-paid-pilot-v1", pilotId: "other" } }));
    assert.deepEqual(await evalCard(route, "wrong"), EMPTY_CARD, "a protocol naming a different pilot");
  });
});

test("W1-T4643: a pilot whose report is unreadable reads the empty card, and a report with no evidence reads the protocol alone", async () => {
  await withStateDir(async (dir, stateDir) => {
    await activatePilot(dir, stateDir, await runAaVerb(dir, stateDir));
    const route = analyticsRoute(dir, stateDir);
    const loaded = loadPaidPilotProtocol(stateDir, "pilot-fixture-1");
    assert.ok(loaded.ok);
    const reportPath = join(stateDir, "benchmark-paid-pilot-v1.pilot-fixture-1.report.json");
    writeFileSync(reportPath, "{ torn");
    assert.deepEqual(await evalCard(route, "pilot-fixture-1"), EMPTY_CARD, "an unreadable report hides nothing behind the protocol");
    writeFileSync(reportPath, JSON.stringify({ version: "benchmark-paid-pilot-v1", pilotId: "pilot-fixture-1", evalCard: null }));
    assert.deepEqual(await evalCard(route, "pilot-fixture-1"), EMPTY_CARD, "a report written before it carried its card evidence");
    const unavailable = buildPaidPilotReport({ protocol: loaded.protocol, nowIso: DURING, evidence: { state: "unavailable",
      reason: "spend-source-missing", forms: { gzip: 0, plain: 0, live: 0 }, unreadSources: [], malformedRows: 0, duplicateRows: 0, newestTs: null, rows: [] } });
    assert.equal(unavailable.evalCardEvidence, null);
    writeFileSync(reportPath, JSON.stringify(unavailable));
    assert.deepEqual(await evalCard(route, "pilot-fixture-1"),
      asServed(buildEvalCard(paidPilotEvalCardTrial(loaded.protocol), emptyEvalCardEvidence())), "no evidence read yet: the registered trial alone");
  });
});

test("W1-T4643: persisted trial and evidence are read back only in the shape buildEvalCard accepts", () => {
  const trial = { trialId: "t", kind: "aa", protocolText: null, preRegisteredAt: null, estimand: "e", randomizationUnit: "task",
    plannedAllocation: { A1: 0.5, A2: 0.5 }, cells: ["A1|fix"] };
  assert.deepEqual(parseEvalCardTrial(trial), trial);
  for (const broken of [null, [], { ...trial, kind: "winner" }, { ...trial, protocolText: 3 }, { ...trial, estimand: undefined },
    { ...trial, plannedAllocation: { A1: "half" } }, { ...trial, cells: [1] }]) assert.equal(parseEvalCardTrial(broken), undefined);
  const evidence = { assignments: [{ unitId: "u", arm: "A1", assignedAt: AA_NOW }], outcomes: [{ unitId: "u", arm: "A1", stratum: "fix", success: null }],
    reviewRows: [{ step: "review.posted" }], deviations: [{ at: null, kind: "k", description: "d" }] };
  assert.deepEqual(parseEvalCardEvidence(evidence), evidence);
  for (const broken of [undefined, { ...evidence, outcomes: undefined }, { ...evidence, assignments: [{ unitId: "u", arm: "A1" }] },
    { ...evidence, outcomes: [{ unitId: "u", arm: "A1", stratum: "fix", success: "yes" }] }, { ...evidence, reviewRows: ["row"] },
    { ...evidence, deviations: [{ at: 1, kind: "k", description: "d" }] }]) assert.equal(parseEvalCardEvidence(broken), undefined);
});
