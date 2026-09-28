// test/a-prospective-aa-earns-a-clean-receipt.test.ts — W1-T4647: a PROSPECTIVE A/A runs both labels on one pinned stack
// through the paired-trial seam, refuses api billing before spawn, and earns the receipt pilot activation cites only when
// clean. Every case runs in an rmd- temp state dir with a fake attempt dispatcher, a fake grader (one case uses the real
// reviewer executor over a temp head), injected config and a fixed clock: nothing spawns a worker, reads a real ledger or spends.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { aaStackHash, BENCHMARK_AA_RECEIPT_VERSION, BENCHMARK_AA_VERSION, parseAaTrialManifest,
  type BenchmarkAaReport } from "../src/lib/benchmark-aa.js";
import {
  API_BILLING_REFUSAL, prospectiveAaCommand, prospectiveAaDir, prospectiveAaOrder, prospectiveAaUnit, resolveAttemptBilling,
  runProspectiveAa, runProspectiveAaPair, type ProspectiveAaPairInput, type ProspectiveAaPairResult, type ProspectiveAaRequest,
  type ProspectiveAaSummary,
} from "../src/lib/benchmark-aa-prospective.js";
import { activateBenchmarkPaidPilot, parsePaidPilotRequest } from "../src/lib/benchmark-paid-pilot.js";
import { clockFromMillisFn, fixedClock } from "../src/lib/clock.js";
import { claimPairSlot, PAIRED_ATTEMPT_MAX_BUDGET_USD, type PairedAttemptRequest, type PairedAttemptResult,
  type PairedGrade } from "../src/lib/paired-trial.js";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { HANDLERS } from "../src/run-task.js";

type Row = Record<string, unknown>;
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const REGISTERED_MS = Date.parse("2026-09-28T08:00:00.000Z");
const RUN_MS = Date.parse("2026-09-28T09:00:00.000Z");
const REPORT_MS = Date.parse("2026-09-28T12:00:00.000Z");
const ACT = "2026-09-28T13:00:00.000Z";
const STACK = { provider: "claude", model: "claude-sonnet-5", effort: "high" };
const REVISIONS = { harnessRevision: SHA, promptRevision: SHA, toolRevision: SHA, scorerRevision: SHA, environmentRevision: SHA };
const HARNESS = { source: "executing-module-git" as const, revision: SHA };
const CRITERIA: AcceptanceCriterion[] = [{ claim: "the marker ships", proof: "grep: AA-OK in notes.txt" }];
const TASKS = Array.from({ length: 12 }, (_, i) => `PA-T${i + 1}`);
const SUBSCRIPTION = { overflow: "none" as const };

function manifest(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: "benchmark-aa-trial-v1", trialId: "aa-prospective-1", cohort: { kind: "public-fixture" },
    stack: { ...STACK, ...REVISIONS }, strataRevision: "strata-v1",
    tasks: TASKS.map((taskId, i) => ({ taskId, taskClass: i % 2 === 0 ? "fix" : "docs", risk: "low" })),
    protocolText: "Prospective A/A: two labels, one pinned stack, graded side attempts, task unit.\n",
    preRegisteredAt: "2026-09-28T07:00:00.000Z", ...changes };
}

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-aa-prospective-"));
}

async function registered(changes: Record<string, unknown> = {}): Promise<string> {
  const dir = stateDir();
  const outcome = await runProspectiveAa({ action: "register", stateDir: dir, manifest: manifest(changes), clock: fixedClock(REGISTERED_MS) });
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.reason);
  return dir;
}

/** Answers every attempt on the pin it was asked for, unless `route` sends one elsewhere. */
function dispatcher(calls: PairedAttemptRequest<string>[], route: (request: PairedAttemptRequest<string>) => Partial<PairedAttemptResult> = () => ({})) {
  return async (request: PairedAttemptRequest<string>): Promise<PairedAttemptResult> => {
    calls.push(request);
    return { headDir: `/heads/${request.taskId}/${request.arm}`, headSha: SHA, servedModel: request.pin.model, billingMode: "subscription",
      costUsd: 0.4, ...route(request) };
  };
}

/** Both labels of one task grade alike (even tasks pass, odd fail): the arms are identical, so is their success. */
function gradeByTask({ headDir }: { headDir: string }): PairedGrade {
  const pass = Number(/PA-T(\d+)/.exec(headDir)![1]) % 2 === 0;
  return { verdict: pass ? "pass" : "fail", passed: pass ? 1 : 0, failed: pass ? 0 : 1, unmeasurable: 0, holdouts: 0, reasons: [] };
}

function pairInput(dir: string, taskId: string, rest: Partial<ProspectiveAaPairInput> = {}): ProspectiveAaPairInput {
  let ms = RUN_MS;
  return { task: { id: taskId, acceptance: CRITERIA }, lane: "implement", stateDir: dir, config: SUBSCRIPTION, env: {},
    clock: clockFromMillisFn(() => (ms += 1000)), harnessRevision: HARNESS, grade: gradeByTask, ...rest };
}

function trialRows(dir: string): Row[] {
  const path = join(prospectiveAaDir(dir, "aa-prospective-1"), "ledger.ndjson");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row) : [];
}

const stepRows = (rows: Row[], step: string) => rows.filter((row) => row.step === step);
const tagOf = (row: Row) => row.aa_prospective as Record<string, unknown>;

async function runAll(dir: string, calls: PairedAttemptRequest<string>[], route?: Parameters<typeof dispatcher>[1]): Promise<ProspectiveAaPairResult[]> {
  const results: ProspectiveAaPairResult[] = [];
  for (const taskId of TASKS) results.push(await runProspectiveAaPair(pairInput(dir, taskId, { dispatchAttempt: dispatcher(calls, route) })));
  return results;
}

async function reportOf(dir: string): Promise<{ code: number; report: BenchmarkAaReport; summary: ProspectiveAaSummary; lines: string[] }> {
  const lines: string[] = [];
  const code = await prospectiveAaCommand(["report", "--trial-id", "aa-prospective-1", "--state-dir", dir, "--json"],
    (request) => runProspectiveAa(request), { print: (line) => lines.push(line), clock: fixedClock(REPORT_MS) });
  const parsed = JSON.parse(lines[0]!) as { report: BenchmarkAaReport; summary: ProspectiveAaSummary };
  return { code, ...parsed, lines };
}

/** The W1-T4603 pilot request the receipt is cited by: a paid arm and a subscription control. */
function pilotRequest() {
  const parsed = parsePaidPilotRequest({ version: "benchmark-paid-pilot-request-v1", pilotId: "pilot-after-aa",
    approval: { reference: "#7418", approvedAt: "2026-09-25T09:00:00.000Z" },
    repos: ["fixture-org/alpha", "fixture-org/beta", "fixture-org/gamma"].map((repo, i) => ({ repo, consentReceipt: `consent-${i}` })),
    pseudonymSalt: "local-salt-7", assignmentSeed: "seed-fixture-1",
    arms: { paid: { provider: "cash", model: "gpt-oss-120b", effort: "medium" }, control: STACK }, revisions: REVISIONS,
    strataRevision: "strata-v1", population: TASKS.map((taskId, i) => ({ taskId, repo: "fixture-org/alpha", taskClass: i % 2 === 0 ? "fix" : "docs", risk: "low" })),
    primaryOutcome: "verified-completion", maturityDays: 14, protocolText: "Paid pilot after a prospective A/A.\n" });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  return parsed.request;
}

test("inert without a registered protocol: nothing is read, logged or spawned", async () => {
  const dir = stateDir();
  const calls: PairedAttemptRequest<string>[] = [];
  const result = await runProspectiveAaPair(pairInput(dir, "PA-T1", { dispatchAttempt: dispatcher(calls) }));
  assert.equal(result.state, "inert");
  assert.equal(calls.length, 0, "an inert A/A spawns nothing");
  assert.deepEqual(readdirSync(dir), [], "an inert A/A writes no file and creates no directory");

  const trial = await registered();
  const other = await runProspectiveAaPair(pairInput(trial, "NOT-IN-TRIAL", { dispatchAttempt: dispatcher(calls) }));
  assert.deepEqual([other.state, other.trialId], ["not-eligible", null], "a task the manifest does not name is never paired");
  const review = await runProspectiveAaPair(pairInput(trial, "PA-T1", { lane: "review", dispatchAttempt: dispatcher(calls) }));
  assert.deepEqual([review.state, review.trialId], ["not-eligible", "aa-prospective-1"], "only implement admission pairs");
  assert.equal(calls.length + trialRows(trial).length, 0);
});

test("both labels run on one pinned stack, in a seeded order per task, one pair at a time", async () => {
  const dir = await registered();
  const parsed = parseAaTrialManifest(manifest());
  assert.ok(parsed.ok);
  const calls: PairedAttemptRequest<string>[] = [];
  const results = await runAll(dir, calls);
  assert.ok(results.every((result) => result.state === "measured"), JSON.stringify(results.filter((r) => r.state !== "measured")));
  assert.equal(calls.length, TASKS.length * 2, "every task runs both labels");
  for (const taskId of TASKS) {
    const mine = calls.filter((call) => call.taskId === taskId);
    assert.deepEqual(mine.map((call) => call.arm), prospectiveAaOrder(parsed.manifest, taskId), "the seeded order, stable per task");
    assert.deepEqual(mine.map((call) => call.position), [0, 1]);
  }
  const orders = new Set(TASKS.map((taskId) => prospectiveAaOrder(parsed.manifest, taskId)[0]));
  assert.deepEqual([...orders].sort(), ["A1", "A2"], "the draw puts each label first on some task");
  for (const call of calls) {
    assert.deepEqual({ provider: call.pin.provider, model: call.pin.model, effort: call.pin.effort }, STACK, "both labels carry the one pin");
    assert.equal(call.pin.stackHash, aaStackHash(parsed.manifest.stack));
    assert.equal(call.pin.billing, "subscription");
    assert.deepEqual(call.revisions, REVISIONS);
    assert.deepEqual(call.isolation, { worktree: "fresh-detached", push: false, openPr: false, merge: false });
  }
  const assignments = stepRows(trialRows(dir), "worker.assignment");
  assert.equal(assignments.length, TASKS.length * 2);
  for (const row of assignments) {
    const tag = tagOf(row);
    const receipt = row.benchmark_run as { stack: Record<string, { state: string; value?: string }>; allocation: Record<string, unknown> };
    assert.equal(tag.trial_id, "aa-prospective-1", "the receipt names the trial");
    assert.equal(row.task_id, prospectiveAaUnit(parsed.manifest, String(tag.task_id), String(tag.label)), "each attempt is its own A/A unit");
    assert.deepEqual(receipt.allocation, { method: "randomized", experimentId: "aa-prospective-1", arm: tag.label, position: tag.position,
      orderMethod: "sha256(benchmark-aa-prospective-order-v1, trialId, taskId) parity" }, "the receipt names the label");
    for (const field of Object.keys(REVISIONS)) assert.deepEqual(receipt.stack[field], { state: "observed", value: SHA }, `${field} is pinned`);
    assert.equal((row.worker_assignment as { routing?: unknown }).routing, undefined, "no live routing tag");
  }
  assert.equal(PAIRED_ATTEMPT_MAX_BUDGET_USD, 15);
  const protocol = JSON.parse(readFileSync(join(prospectiveAaDir(dir, "aa-prospective-1"), "protocol.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual([protocol.billing, protocol.maxAttemptBudgetUsd], ["subscription-only", PAIRED_ATTEMPT_MAX_BUDGET_USD]);

  const again = await runProspectiveAaPair(pairInput(dir, "PA-T1", { dispatchAttempt: dispatcher(calls) }));
  assert.deepEqual([again.state, again.reasons], ["refused", ["task-already-paired"]], "a retried dispatch never pairs a task twice");

  const held = claimPairSlot();
  assert.ok(held, "the pair slot is free between pairs");
  const fresh = await registered({ trialId: "aa-prospective-1" });
  const blocked = await runProspectiveAaPair(pairInput(fresh, "PA-T2", { dispatchAttempt: dispatcher(calls) }));
  held();
  assert.deepEqual([blocked.state, blocked.reasons], ["refused", ["pair-in-flight"]], "a second pair waits for the first");
  assert.equal(calls.length, TASKS.length * 2, "neither refusal spawned");
});

test("api billing is refused before spawn and recorded, and cash is reported as zero observed", async () => {
  const dir = await registered();
  const calls: PairedAttemptRequest<string>[] = [];
  const env = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-fixture" };
  assert.equal(resolveAttemptBilling("claude", { overflow: "api_key" }, env), "api", "the engaged overflow valve bills api");
  assert.equal(resolveAttemptBilling("claude", { overflow: "none" }, env), "subscription", "the key alone never bills api");
  assert.equal(resolveAttemptBilling("openweight", undefined, {}), "api", "a cash provider is api-billed");
  const refused = await runProspectiveAaPair(pairInput(dir, "PA-T1", { config: { overflow: "api_key" }, env, dispatchAttempt: dispatcher(calls) }));
  assert.equal(refused.state, "refused");
  assert.ok(refused.reasons.includes(`${API_BILLING_REFUSAL}:${refused.order[0]}`), refused.reasons.join(","));
  assert.equal(calls.length, 0, "the attempt never reached the dispatcher");
  const rows = trialRows(dir);
  assert.equal(stepRows(rows, "worker.assignment").length, 0, "no assignment is receipted for a refused attempt");
  const refusal = stepRows(rows, "aa_prospective.refused");
  assert.equal(refusal.length, 1);
  assert.deepEqual([tagOf(refusal[0]!).reason, tagOf(refusal[0]!).resolved_billing], [API_BILLING_REFUSAL, "api"]);
  const pair = stepRows(rows, "aa_prospective.pair")[0]!;
  assert.equal(tagOf(pair).status, "refused");

  const breach = await runProspectiveAaPair(pairInput(dir, "PA-T2", { dispatchAttempt: dispatcher(calls, () => ({ billingMode: "api", costUsd: 0.9 })) }));
  assert.equal(breach.state, "unmeasurable", "an attempt that billed api anyway is never graded");
  assert.ok(breach.reasons.some((reason) => reason.startsWith("billing-breach:")));
  const { summary, report } = await reportOf(dir);
  assert.deepEqual(summary.refusedBeforeSpawn, { apiBilling: 1 });
  assert.deepEqual(summary.cash, { state: "observed", usd: 0.9, apiBilledAttempts: 1, basis: "subscription-only: api billing is refused before spawn" },
    "an api bill that got through is counted, never hidden");
  assert.equal(report.arms!.A1!.accounting.unknown.assignments + report.arms!.A2!.accounting.unknown.assignments, 0);

  const cash = await registered({ stack: { ...STACK, provider: "cash", ...REVISIONS } });
  const cashCalls: PairedAttemptRequest<string>[] = [];
  const cashPair = await runProspectiveAaPair(pairInput(cash, "PA-T3", { dispatchAttempt: dispatcher(cashCalls) }));
  assert.deepEqual([cashPair.state, cashCalls.length], ["refused", 0], "a cash-provider pin is refused before any spawn");
  const clean = await registered();
  await runProspectiveAaPair(pairInput(clean, "PA-T4", { dispatchAttempt: dispatcher([]) }));
  assert.deepEqual((await reportOf(clean)).summary.cash, { state: "observed", usd: 0, apiBilledAttempts: 0,
    basis: "subscription-only: api billing is refused before spawn" }, "zero, observed, never unknown");
});

test("a clean prospective receipt is accepted by the real pilot activation check", async () => {
  const dir = await registered();
  await runAll(dir, []);
  const { code, report, summary } = await reportOf(dir);
  assert.equal(code, 0);
  assert.equal(report.version, BENCHMARK_AA_VERSION);
  assert.equal(report.receipt.version, BENCHMARK_AA_RECEIPT_VERSION);
  assert.equal(report.state, "observed");
  assert.deepEqual(report.findings.filter((item) => item.severity === "concern"), []);
  assert.equal(report.verdict, "no-integrity-concern-detected");
  assert.deepEqual(report.sampleRatio.allocated.state === "observed" && report.sampleRatio.allocated.counts, { A1: 12, A2: 12 });
  assert.equal(report.arms!.A1!.exposedUnits + report.arms!.A2!.exposedUnits, 24);
  assert.deepEqual([report.arms!.A1!.outcomes.completed, report.arms!.A1!.outcomes.failed], [6, 6], "graded outcomes, not case files");
  assert.deepEqual(summary.pairs, { admitted: 12, measured: 12, unmeasurable: 0, refused: 0 });
  assert.deepEqual(readdirSync(dir), ["benchmark-aa-prospective"], "the A/A never writes a paid-pilot file");

  const saved = JSON.parse(readFileSync(join(prospectiveAaDir(dir, "aa-prospective-1"), "benchmark-aa-v1.aa-prospective-1.json"), "utf8")) as unknown;
  const activation = activateBenchmarkPaidPilot({ request: pilotRequest(), aaReport: saved, nowIso: ACT, existing: [] });
  assert.ok(activation.ok, activation.ok ? "" : activation.reason);
  assert.equal(activation.protocol.aaReceipt.reportHash, report.receipt.reportHash, "the pilot cites this very receipt");
  assert.equal(activation.protocol.aaReceipt.trialId, "aa-prospective-1");

  const refreshed = await reportOf(dir);
  assert.equal(refreshed.report.lateEvidence.state, "none", "a refresh reads the persisted report as its prior");
});

test("falsifier: one side attempt routed off the pinned stack reads stack-deviation and pilot activation refuses it", async () => {
  const dir = await registered();
  await runAll(dir, [], (request) => request.taskId === "PA-T5" && request.arm === "A2" ? { servedModel: "live-routed-model" } : {});
  const { report } = await reportOf(dir);
  assert.ok(report.findings.some((item) => item.kind === "stack-deviation"), JSON.stringify(report.findings));
  assert.equal(report.verdict, "integrity-concerns");
  const saved = JSON.parse(readFileSync(join(prospectiveAaDir(dir, "aa-prospective-1"), "benchmark-aa-v1.aa-prospective-1.json"), "utf8")) as unknown;
  assert.deepEqual(activateBenchmarkPaidPilot({ request: pilotRequest(), aaReport: saved, nowIso: ACT, existing: [] }),
    { ok: false, reason: "aa-receipt-integrity-concerns" });

  const calls: PairedAttemptRequest<string>[] = [];
  const offPin = await runProspectiveAaPair(pairInput(await registered(), "PA-T1", { harnessRevision: { source: "executing-module-git", revision: OTHER_SHA },
    dispatchAttempt: dispatcher(calls) }));
  assert.deepEqual([offPin.state, offPin.reasons], ["refused", ["harness-off-pin"]], "a harness off the pin never spawns");
  const unpinned = await runProspectiveAaPair(pairInput(await registered(), "PA-T1", { harnessRevision: undefined, dispatchAttempt: dispatcher(calls) }));
  assert.deepEqual([unpinned.state, unpinned.reasons], ["refused", ["harness-unpinned:not-pinned-by-harness"]]);
  assert.equal(calls.length, 0);
});

test("an attempt that cannot be graded stops its pair, and a paused or unwired trial spawns nothing", async () => {
  const dir = await registered();
  const cleaned: string[] = [];
  const cases: [string, Parameters<typeof dispatcher>[1], Partial<ProspectiveAaPairInput>, string][] = [
    ["PA-T1", () => { throw new Error("spawn failed"); }, {}, "attempt-failed"],
    ["PA-T2", () => ({ pushedRef: "refs/heads/leak" }), {}, "isolation-breach"],
    ["PA-T3", () => ({ headDir: null }), {}, "no-head"],
    ["PA-T4", () => ({}), { grade: () => { throw new Error("grader down"); } }, "grading-failed"],
    ["PA-T5", (request) => ({ cleanup: () => { cleaned.push(request.arm); throw new Error("rm failed"); } }), {}, "cleanup-failed"],
  ];
  for (const [taskId, route, rest, reason] of cases) {
    const calls: PairedAttemptRequest<string>[] = [];
    const result = await runProspectiveAaPair(pairInput(dir, taskId, { dispatchAttempt: dispatcher(calls, route), ...rest }));
    assert.equal(result.state, "unmeasurable", taskId);
    assert.ok(result.reasons.some((item) => item.startsWith(`${reason}:`)), `${taskId}: ${result.reasons.join(",")}`);
    assert.ok(result.reasons.includes("stopped-after-an-unmeasurable-attempt"));
    assert.equal(calls.length, 1, "the pair stops after its first unmeasurable attempt");
    assert.deepEqual(Object.values(result.outcomes).sort(), ["not-run", "unmeasurable"]);
  }
  assert.equal(cleaned.length, 1);
  const ungraded = await runProspectiveAaPair(pairInput(dir, "PA-T6", { dispatchAttempt: dispatcher([]),
    grade: () => ({ verdict: "unmeasurable", passed: 0, failed: 0, unmeasurable: 1, holdouts: 0, reasons: [] }) }));
  assert.equal(ungraded.state, "unmeasurable");
  const { report } = await reportOf(dir);
  assert.ok(report.findings.some((item) => item.kind === "verified-join-incomplete"), "an ungraded unit is never a clean one");
  assert.ok(report.arms!.A1!.nonStarters + report.arms!.A2!.nonStarters > 0, "a stopped pair's second label is a non-starter");
  assert.notEqual(report.verdict, "no-integrity-concern-detected");

  const noWire = await runProspectiveAaPair(pairInput(dir, "PA-T7", { dispatchRefusal: "pair-needs-the-daemon" }));
  assert.deepEqual([noWire.state, noWire.reasons], ["refused", ["pair-needs-the-daemon"]]);
  const unnamed = await runProspectiveAaPair(pairInput(dir, "PA-T7"));
  assert.deepEqual(unnamed.reasons, ["attempt-dispatch-not-wired"]);
  const paused = await runProspectiveAa({ action: "pause", stateDir: dir, trialId: "aa-prospective-1", note: "operator stop", clock: fixedClock(RUN_MS) });
  assert.ok(paused.ok);
  const calls: PairedAttemptRequest<string>[] = [];
  const afterPause = await runProspectiveAaPair(pairInput(dir, "PA-T8", { dispatchAttempt: dispatcher(calls) }));
  assert.deepEqual([afterPause.state, afterPause.reasons, calls.length], ["refused", ["protocol-paused"], 0]);
  assert.equal((await reportOf(dir)).summary.paused, true);

  const broken = await registered();
  mkdirSync(join(prospectiveAaDir(broken, "aa-prospective-1"), "ledger.ndjson"));
  const failed = await runProspectiveAaPair(pairInput(broken, "PA-T1", { dispatchAttempt: dispatcher(calls) }));
  assert.deepEqual([failed.state, failed.reasons], ["refused", ["prospective-aa-failed"]], "a trial that cannot write never throws at dispatch");
  const next = claimPairSlot();
  assert.ok(next, "a failed pair releases the slot");
  next();
});

test("the default grader is the reviewer's own executor over the attempt's head", async () => {
  const dir = await registered();
  const heads = mkdtempSync(join(tmpdir(), "rmd-aa-prospective-heads-"));
  for (const label of ["A1", "A2"]) {
    mkdirSync(join(heads, label));
    writeFileSync(join(heads, label, "notes.txt"), "AA-OK\n");
  }
  const input = pairInput(dir, "PA-T1", { dispatchAttempt: dispatcher([], (request) => ({ headDir: join(heads, request.arm) })) });
  delete input.grade;
  const result = await runProspectiveAaPair(input);
  assert.deepEqual([result.state, result.outcomes], ["measured", { A1: "pass", A2: "pass" }]);
  const verdicts = stepRows(trialRows(dir), "verdict");
  assert.deepEqual(verdicts.map((row) => row.success), [true, true]);
});

test("the operator verb registers, reports and pauses through the command registry, and refuses bad input by name", async () => {
  const dir = stateDir();
  const manifestPath = join(mkdtempSync(join(tmpdir(), "rmd-aa-prospective-manifest-")), "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest()));
  const printed: string[] = [];
  const savedLog = console.log;
  console.log = (line: string) => { printed.push(line); };
  const verb = (args: string[]) => HANDLERS.get("benchmark-aa")!(["prospective", ...args]);
  let codes: number[];
  try {
    codes = [await verb(["register", "--trial", manifestPath, "--state-dir", dir]),
      await verb(["register", "--trial", manifestPath, "--state-dir", dir]),
      await verb(["report", "--trial-id", "aa-prospective-1", "--state-dir", dir]),
      await verb(["pause", "--trial-id", "aa-prospective-1", "--state-dir", dir])];
  } finally { console.log = savedLog; }
  assert.deepEqual(codes, [0, 2, 1, 0], printed.join("\n"));
  assert.match(printed[0]!, /registered 12 task\(s\), two labels on one pinned stack \(claude\/claude-sonnet-5\/high\); subscription only/);
  assert.match(printed[1]!, /refused \(trial-already-registered\)/);
  assert.ok(printed.some((line) => /aa-prospective-1: unavailable; verdict unavailable; no winner is declared/.test(line)), "no rows yet is unavailable, never zero");
  assert.ok(printed.some((line) => /cash \$0\.00 observed/.test(line)));
  assert.match(printed.at(-1)!, /paused; no new pair is admitted/);

  const lines: string[] = [];
  const run = (args: string[], stateDirFor: () => string = () => dir) => prospectiveAaCommand(args, (request: ProspectiveAaRequest) => runProspectiveAa(request),
    { print: (line) => lines.push(line), resolveStateDir: stateDirFor, clock: fixedClock(REPORT_MS) });
  assert.equal(await run(["register", "--bogus"]), 2);
  assert.match(lines.at(-1)!, /arguments-invalid/);
  assert.equal(await run(["launch", "--trial-id", "x"]), 2);
  assert.match(lines.at(-1)!, /^usage: rmd benchmark-aa prospective register/);
  assert.equal(await run(["report"]), 2);
  assert.equal(await run(["register", "--trial", join(dir, "missing.json")]), 2);
  assert.match(lines.at(-1)!, /refused \(trial-manifest-unreadable\)/);
  const other = stateDir();
  assert.equal(await run(["register", "--trial", manifestPath], () => other), 0, "the state dir resolves when --state-dir is absent");
  writeFileSync(manifestPath, JSON.stringify(manifest({ trialId: "aa-prospective-2" })));
  assert.equal(await run(["register", "--trial", manifestPath], () => other), 2);
  assert.match(lines.at(-1)!, /refused \(another-prospective-aa-active\)/);
  writeFileSync(manifestPath, JSON.stringify(manifest({ cohort: { kind: "live-fleet" } })));
  assert.equal(await run(["register", "--trial", manifestPath], () => other), 2);
  assert.match(lines.at(-1)!, /cohort-not-public-fixture-or-opted-in/);
  assert.equal(await run(["report", "--trial-id", "never-registered"]), 2);
  assert.match(lines.at(-1)!, /refused \(trial-not-registered\)/);
  assert.equal(await run(["pause", "--trial-id", "aa-prospective-1", "--json"]), 0);
  assert.equal((JSON.parse(lines.at(-1)!) as { trialId: string }).trialId, "aa-prospective-1");
  const protocolPath = join(prospectiveAaDir(other, "aa-prospective-1"), "protocol.json");
  const tampered = JSON.parse(readFileSync(protocolPath, "utf8")) as { manifest: { stack: { model: string } } };
  tampered.manifest.stack.model = "a-different-model";
  writeFileSync(protocolPath, JSON.stringify(tampered));
  assert.equal(await run(["report", "--trial-id", "aa-prospective-1"], () => other), 2);
  assert.match(lines.at(-1)!, /refused \(protocol-changed-since-registration\)/);
  writeFileSync(protocolPath, "{ torn");
  assert.equal(await run(["report", "--trial-id", "aa-prospective-1"], () => other), 2);
  assert.match(lines.at(-1)!, /refused \(protocol-changed-since-registration\)/);
  assert.equal(await run(["report", "--trial-id", "aa-prospective-1", "--out", join(other, "elsewhere.json")]), 1, "a report with no rows yet is unavailable");
  assert.ok(existsSync(join(other, "elsewhere.json")), "--out names where the report is written");
});
