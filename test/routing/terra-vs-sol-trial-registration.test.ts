import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { aaStackHash } from "#src/lib/benchmark-aa.js";
import { prospectiveAaDir } from "#src/lib/benchmark-aa-prospective.js";
import type { BenchmarkAaReport } from "#src/lib/benchmark-aa.js";
import { runBenchmarkAaReadiness } from "#src/lib/benchmark-aa-readiness.js";
import { activateBenchmarkPaidPilot, PAID_PILOT_AA_RECEIPT_MAX_AGE_MS, PAID_PILOT_STOPPING_RULE,
  PAID_PILOT_WINDOW_MS, type PaidPilotEvidence } from "#src/lib/benchmark-paid-pilot.js";
import { codexBalancedAttemptAdmission, codexBalancedTrialCommand, registerCodexBalancedTrial,
  type CodexBalancedTrialInput, type CodexBalancedTrialRequest } from "#src/lib/codex-balanced-trial.js";
import { fixedClock } from "#src/lib/clock.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const SHA = "a".repeat(40);
const NOW = Date.parse("2026-10-28T12:00:00Z");
const revisions = { harnessRevision: SHA, promptRevision: SHA, toolRevision: SHA, scorerRevision: SHA, environmentRevision: SHA };
const tasks = Array.from({ length: 12 }, (_, i) => ({ taskId: `TRIAL-${i}`, taskClass: "implement", risk: "low" }));
const plan = tasks.map(({ taskId }) => ({ id: taskId, acceptance: [{ claim: "works", proof: "grep: works in result.txt" }] }));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function request(effort: "low" | "medium" = "low"): CodexBalancedTrialRequest {
  return { phase: "aa", manifest: { version: "benchmark-aa-trial-v1", trialId: `balanced-${effort}-aa`,
    cohort: { kind: "public-fixture" }, stack: { provider: "codex", model: "gpt-6.1-sol", effort, ...revisions },
    labels: ["A1", "A2"], strataRevision: "v1", tasks },
    selections: tasks.map(({ taskId }) => ({ task_id: taskId, worker_assignment: { selected: { provider: "codex", effort },
      routing: { decision: { capability: "balanced" } } } })),
    pilotRequest: { version: "benchmark-paid-pilot-request-v1", pilotId: `balanced-${effort}-ab`,
      approval: { reference: "#7418", approvedAt: null },
      repos: ["fixture/alpha", "fixture/beta", "fixture/gamma"].map(repo => ({ repo, consentReceipt: "fixture-consent" })),
      pseudonymSalt: "fixture-salt", assignmentSeed: "fixture-seed", revisions, strataRevision: "v1",
      arms: { control: { provider: "codex", model: "gpt-6.1-sol", effort }, paid: { provider: "codex", model: "gpt-6.1-terra", effort } },
      population: tasks.map(task => ({ ...task, repo: "fixture/alpha" })),
      primaryOutcome: "verified-completion", maturityDays: 14, protocolText: "operator protocol" } };
}

function runtime(stateDir: string): CodexBalancedTrialInput["readiness"] {
  return { config: { overflow: "none" }, env: {}, clock: fixedClock(NOW),
    instanceRoots: [{ instance: "fixture", stateDir }], loadPlanTasks: () => plan,
    runtimePins: () => ({ harnessRevision: { source: "executing-module-git", revision: SHA }, revisions: {
      promptRevision: { source: "resolved-artifact", revision: SHA }, toolRevision: { source: "resolved-artifact", revision: SHA },
      scorerRevision: { source: "resolved-artifact", revision: SHA }, environmentRevision: { source: "resolved-artifact", revision: SHA } } }),
    dispatcherFor: () => async call => ({ headDir: "/fixture/head", headSha: SHA, servedModel: call.pin.model,
      billingMode: "subscription", costUsd: 0.1 }),
    grade: async () => ({ verdict: "pass", passed: 1, failed: 0, unmeasurable: 0, holdouts: 0, reasons: [] }) };
}

function input(stateDir: string, req = request()): CodexBalancedTrialInput {
  return { stateDir, request: req, readiness: runtime(stateDir), clock: fixedClock(NOW),
    readCatalog: async () => ["gpt-6.1-sol", "gpt-6.1-terra"] };
}

async function calibrated(stateDir: string, req = request()) {
  const args = input(stateDir, req);
  const registered = await registerCodexBalancedTrial(args);
  assert.ok(registered.ok, JSON.stringify(registered));
  const ready = await runBenchmarkAaReadiness({ ...args.readiness, stateDir, trialId: req.manifest.trialId });
  assert.equal(ready.state, "receipt-emitted", JSON.stringify(ready));
  req.phase = "ab";
  return args;
}

test("W1-T10841: the A/A registers two Sol 6.1 labels on the Codex balanced low and medium population", async t => {
  for (const effort of ["low", "medium"] as const) {
    const { dir } = ownedFixtureDir(t, `balanced-${effort}`);
    const req = request(effort);
    const excluded = [
      { provider: "codex", effort, capability: "frontier" }, { provider: "codex", effort, capability: "economy" },
      { provider: "codex", effort: "high", capability: "balanced" }, { provider: "cash", effort, capability: "balanced" },
      { provider: "claude", effort, capability: "balanced" },
    ];
    excluded.forEach((selection, i) => {
      req.selections[i]!.worker_assignment = { selected: selection, routing: { decision: { capability: selection.capability } } };
    });
    const result = await registerCodexBalancedTrial(input(dir, req));
    assert.ok(result.ok && result.phase === "aa", JSON.stringify(result));
    assert.deepEqual(result.protocol.manifest.labels, ["A1", "A2"]);
    assert.deepEqual(result.protocol.manifest.stack, { provider: "codex", model: "gpt-6.1-sol", effort, ...revisions });
    assert.deepEqual(result.protocol.manifest.tasks.map(task => task.taskId), tasks.slice(5).map(task => task.taskId));
    assert.equal(result.protocol.billing, "subscription-only");
    assert.equal(result.population.denominator, 7);
    assert.equal(result.population.eligible.length, 7);
    assert.deepEqual(readdirSync(prospectiveAaDir(dir, req.manifest.trialId)).sort(), ["population.json", "protocol.json", "readiness.json", `benchmark-aa-v1.${req.manifest.trialId}.json`].sort());
    assert.equal(existsSync(join(dir, `codex-balanced-trial-v1.${(req.pilotRequest as { pilotId: string }).pilotId}.json`)), false);
  }
});

test("W1-T10841: the protocol pre-registers outcome, guardrails and stopping rule before any assignment", async t => {
  const { dir } = ownedFixtureDir(t, "balanced-protocol");
  const args = await calibrated(dir);
  const result = await registerCodexBalancedTrial(args);
  assert.ok(result.ok && result.phase === "ab", JSON.stringify(result));
  const protocol = result.protocol;
  assert.equal(protocol.assignment.unit, "task");
  assert.equal(protocol.primaryOutcome, "verified-completion");
  assert.equal(protocol.analysis, "intention-to-treat");
  assert.deepEqual(protocol.guardrails, ["recovery.repairRunsObserved", "laterDefects", "missingness.servedModel", "missingness.billingMode", "missingness.cost", "accounting.cashEstimate"]);
  assert.equal(protocol.stoppingRule, PAID_PILOT_STOPPING_RULE);
  assert.equal(protocol.lead, "gpt-6.1-sol");
  assert.equal(protocol.liveAssignment, false);
  assert.equal(protocol.pilotRequest.approval.reference, "#7418");
  assert.deepEqual(protocol.pilotRequest.arms, {
    control: { provider: "codex", model: "gpt-6.1-sol", effort: "low" }, paid: { provider: "codex", model: "gpt-6.1-terra", effort: "low" } });
  const { digest, ...body } = protocol;
  assert.equal(digest, hash(body));
  for (const change of [{ assignment: { ...body.assignment, unit: "attempt" } }, { primaryOutcome: "merged" },
    { guardrails: [] }, { stoppingRule: "interim winner" }]) assert.notEqual(hash({ ...body, ...change }), digest);
  assert.deepEqual(JSON.parse(readFileSync(result.path, "utf8")), protocol);
  assert.equal(readdirSync(dir).some(name => name.startsWith("benchmark-paid-pilot-v1.")), false);
  assert.deepEqual(await registerCodexBalancedTrial(args), { ok: false, reason: "trial-already-registered" });
});

test("W1-T10841: the A/B refuses to register without a passing A/A receipt", async t => {
  const { dir } = ownedFixtureDir(t, "balanced-receipt");
  const args = input(dir);
  (args.request as CodexBalancedTrialRequest).phase = "ab";
  assert.deepEqual(await registerCodexBalancedTrial(args), { ok: false, reason: "aa-registration-missing" });
  (args.request as CodexBalancedTrialRequest).phase = "aa";
  await registerCodexBalancedTrial(args);
  (args.request as CodexBalancedTrialRequest).phase = "ab";
  assert.deepEqual(await registerCodexBalancedTrial(args), { ok: false, reason: "aa-calibration-unreadable:ENOENT" });
  (args.request as CodexBalancedTrialRequest).phase = "aa";
  const calibratedArgs = await calibrated(dir);
  const receiptPath = join(prospectiveAaDir(dir, request().manifest.trialId), `calibration-receipt.${request().manifest.trialId}.json`);
  const original = readFileSync(receiptPath, "utf8");
  const altered = (change: (report: BenchmarkAaReport) => void) => {
    const report = JSON.parse(original);
    change(report);
    const { receipt, ...body } = report;
    receipt.reportHash = hash(body);
    writeFileSync(receiptPath, JSON.stringify(report));
  };
  for (const [change, reason] of [
    [(report: BenchmarkAaReport) => { report.receipt.verdict = "inconclusive"; }, "aa-receipt-inconclusive"],
    [(report: BenchmarkAaReport) => { report.receipt.verdict = "integrity-concerns"; }, "aa-receipt-integrity-concerns"],
    [(report: BenchmarkAaReport) => { report.receipt.asOf = new Date(NOW - PAID_PILOT_AA_RECEIPT_MAX_AGE_MS - 1).toISOString(); }, "aa-receipt-stale"],
    [(report: BenchmarkAaReport) => { report.receipt.stackHash = aaStackHash({ ...request().manifest.stack, model: "other" }); }, "aa-stack-mismatch"],
    [(report: BenchmarkAaReport) => { report.receipt.allocationReceiptHash = SHA; }, "aa-population-mismatch"],
  ] as const) {
    altered(change);
    assert.deepEqual(await registerCodexBalancedTrial(calibratedArgs), { ok: false, reason });
  }
  writeFileSync(receiptPath, original);
  const changed = structuredClone(calibratedArgs.request) as CodexBalancedTrialRequest;
  changed.manifest.stack.toolRevision = "b".repeat(40);
  assert.deepEqual(await registerCodexBalancedTrial({ ...calibratedArgs, request: changed }), { ok: false, reason: "aa-stack-mismatch" });
  changed.manifest = request().manifest;
  changed.manifest.tasks = changed.manifest.tasks.slice(1);
  assert.deepEqual(await registerCodexBalancedTrial({ ...calibratedArgs, request: changed }), { ok: false, reason: "aa-population-mismatch" });
});

test("W1-T10841: registration refuses when the Codex catalog does not list Terra 6.1", async t => {
  const { dir } = ownedFixtureDir(t, "balanced-catalog");
  const args = await calibrated(dir);
  assert.deepEqual(await registerCodexBalancedTrial({ ...args, readCatalog: async () => ["gpt-6.1-sol"] }),
    { ok: false, reason: "codex-catalog-missing:gpt-6.1-terra" });
  assert.deepEqual(await registerCodexBalancedTrial({ ...args, readCatalog: async () => { throw new Error("offline"); } }),
    { ok: false, reason: "codex-catalog-unreadable:offline" });
});

test("W1-T10841: the trial spends only inside the paid pilot ceiling and window", async t => {
  const { dir } = ownedFixtureDir(t, "balanced-budget");
  const args = await calibrated(dir);
  const registered = await registerCodexBalancedTrial(args);
  assert.ok(registered.ok && registered.phase === "ab");
  const report = JSON.parse(readFileSync(join(prospectiveAaDir(dir, request().manifest.trialId), `calibration-receipt.${request().manifest.trialId}.json`), "utf8"));
  const active = activateBenchmarkPaidPilot({ request: registered.protocol.pilotRequest, aaReport: report,
    nowIso: new Date(NOW).toISOString(), existing: [] });
  assert.ok(active.ok);
  const evidence: PaidPilotEvidence = { state: "observed", forms: { gzip: 0, plain: 0, live: 1 }, unreadSources: [], malformedRows: 0, duplicateRows: 0, newestTs: null, rows: [] };
  const base = { protocol: active.protocol, evidence, nowIso: new Date(NOW).toISOString(), billing: "api" as const, reserveUsd: 2 };
  assert.deepEqual(codexBalancedAttemptAdmission(base), { admitted: true, reserveUsd: 2, reasons: [] });
  assert.deepEqual(codexBalancedAttemptAdmission({ ...base, reserveUsd: 100 }), { admitted: false, reserveUsd: 0, reasons: ["cash-budget-exhausted"] });
  assert.deepEqual(codexBalancedAttemptAdmission({ ...base, nowIso: new Date(NOW + PAID_PILOT_WINDOW_MS).toISOString() }),
    { admitted: false, reserveUsd: 0, reasons: ["pilot-window-expired"] });
  assert.deepEqual(codexBalancedAttemptAdmission({ ...base, reserveUsd: Number.NaN }), { admitted: false, reserveUsd: 0, reasons: ["cash-reserve-invalid"] });
  assert.deepEqual(codexBalancedAttemptAdmission({ ...base, billing: "subscription", evidence: { ...evidence, state: "unavailable", reason: "offline" } }),
    { admitted: true, reserveUsd: 0, reasons: [] });
  assert.equal(registered.protocol.cash.ceilingUsd, 100);
  assert.equal(registered.protocol.cash.windowMs, PAID_PILOT_WINDOW_MS);
});

test("the registration command parses an operator request and reports named failures", async t => {
  const { dir } = ownedFixtureDir(t, "balanced-command");
  const file = join(dir, "request.json");
  writeFileSync(file, JSON.stringify(request()));
  const lines: string[] = [];
  const run = (value: unknown, stateDir: string) => registerCodexBalancedTrial({ ...input(stateDir), request: value });
  assert.equal(await codexBalancedTrialCommand(["--request", file, "--state-dir", dir], run, { print: line => lines.push(line) }), 0);
  assert.ok(lines[0]!.includes('"phase":"aa"'));
  assert.equal(await codexBalancedTrialCommand([], run, { print: line => lines.push(line) }), 2);
  assert.equal(await codexBalancedTrialCommand(["--bad"], run, { print: line => lines.push(line) }), 2);
  assert.equal(await codexBalancedTrialCommand(["--request", join(dir, "missing")], run, { print: line => lines.push(line) }), 2);
  writeFileSync(file, "{");
  assert.equal(await codexBalancedTrialCommand(["--request", file], run, { print: line => lines.push(line) }), 2);
  writeFileSync(file, JSON.stringify({ phase: "unexpected" }));
  assert.equal(await codexBalancedTrialCommand(["--request", file], run, { print: line => lines.push(line), resolveStateDir: () => dir }), 2);
});

test("registration rejects malformed requests and refuses unknown runtime pins before writing", async t => {
  const { dir } = ownedFixtureDir(t, "balanced-invalid");
  const args = input(dir);
  assert.deepEqual(await registerCodexBalancedTrial({ ...args, request: null }), { ok: false, reason: "request-invalid" });
  assert.deepEqual(await registerCodexBalancedTrial({ ...args, request: { phase: "other" } }), { ok: false, reason: "phase-invalid" });
  for (const [mutate, reason] of [
    [(req: CodexBalancedTrialRequest) => { req.manifest.version = "wrong" as typeof req.manifest.version; }, "manifest-version-unsupported"],
    [(req: CodexBalancedTrialRequest) => { req.manifest.stack.model = "other"; }, "aa-needs-codex-sol-balanced-low-or-medium"],
    [(req: CodexBalancedTrialRequest) => { req.selections = undefined as unknown as typeof req.selections; }, "selection-evidence-missing"],
    [(req: CodexBalancedTrialRequest) => { req.selections.push(req.selections[0]!); }, "selection-evidence-invalid-or-duplicated"],
    [(req: CodexBalancedTrialRequest) => { req.selections = []; }, "codex-balanced-population-empty"],
  ] as const) {
    const req = request();
    mutate(req);
    assert.deepEqual(await registerCodexBalancedTrial({ ...args, request: req }), { ok: false, reason });
  }
  const result = await registerCodexBalancedTrial({ ...args, readiness: { ...args.readiness, runtimePins: () => ({
    ...runtime(dir).runtimePins(), harnessRevision: { state: "unavailable", reason: "fixture" } }) } });
  assert.ok(!result.ok && result.reason.includes("runtime-pin-unknown:harnessRevision"), JSON.stringify(result));
  assert.equal(existsSync(prospectiveAaDir(dir, request().manifest.trialId)), false);
  assert.ok((await registerCodexBalancedTrial({ ...args, readiness: { ...args.readiness,
    dispatcherFor: () => { assert.fail("registration must never dispatch an attempt"); } } })).ok);
});

test("the A/B binds pilot consent, arms, effort, revisions and eligible task metadata", async t => {
  const { dir } = ownedFixtureDir(t, "balanced-pilot-pins");
  const args = await calibrated(dir);
  for (const [patch, reason] of [
    [{ approval: { reference: "other" } }, "pilot-approval-must-cite-7418"],
    [{ repos: [] }, "three-consented-repos-required"],
    [{ design: "paired", paired: { samplingRate: 1, maxPairs: 12, shadow: true } }, "task-randomization-required"],
    [{ arms: { control: { provider: "codex", model: "other-sol", effort: "low" }, paid: { provider: "codex", model: "gpt-6.1-terra", effort: "low" } } }, "trial-arm-mismatch:control"],
    [{ arms: { control: { provider: "codex", model: "gpt-6.1-sol", effort: "low" }, paid: { provider: "codex", model: "gpt-6.1-terra", effort: "medium" } } }, "trial-arm-mismatch:paid"],
    [{ revisions: { ...revisions, scorerRevision: "b".repeat(40) } }, "pilot-stack-mismatch"],
    [{ population: [] }, "population-missing"],
    [{ population: tasks.slice(1).map(task => ({ ...task, repo: "fixture/alpha" })) }, "pilot-population-mismatch"],
    [{ population: tasks.map(task => ({ ...task, taskClass: "different", repo: "fixture/alpha" })) }, "pilot-population-mismatch"],
    [{ strataRevision: "different" }, "pilot-population-mismatch"],
  ] as const) {
    const req = structuredClone(args.request) as CodexBalancedTrialRequest;
    req.pilotRequest = { ...(req.pilotRequest as Record<string, unknown>), ...patch };
    assert.deepEqual(await registerCodexBalancedTrial({ ...args, request: req }), { ok: false, reason });
  }
});

test("registration reports an unwritable protocol and refuses API-billed calibration", async t => {
  const { dir } = ownedFixtureDir(t, "balanced-write-refusal");
  const args = await calibrated(dir);
  chmodSync(dir, 0o500);
  try {
    assert.deepEqual(await registerCodexBalancedTrial(args), { ok: false, reason: "trial-registration-unwritable:EACCES" });
  } finally { chmodSync(dir, 0o700); }
  const { dir: apiDir } = ownedFixtureDir(t, "balanced-api-refusal");
  const api = input(apiDir);
  const result = await registerCodexBalancedTrial({ ...api, readiness: { ...api.readiness,
    config: { overflow: "api_key" }, env: { ANTHROPIC_API_KEY: "fixture-only" } } });
  assert.ok(!result.ok && result.reason.includes("api-billing-refused-before-spawn"), JSON.stringify(result));
});
