import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as experiments from "#src/lib/routing-experiments.js";
import { selectCodexModel, spawnCodexWorker, codexCandidatesForCapability } from "#src/lib/worker-provider.js";
import { registerCodexBalancedTrial, type CodexBalancedTrialRequest } from "#src/lib/codex-balanced-trial.js";
import { runBenchmarkAaReadiness, type BenchmarkAaReadinessInput } from "#src/lib/benchmark-aa-readiness.js";
import { prospectiveAaDir } from "#src/lib/benchmark-aa-prospective.js";
import { paidPilotArmFor, PAID_PILOT_AA_RECEIPT_MAX_AGE_MS, appendPaidPilotControl } from "#src/lib/benchmark-paid-pilot.js";
import { fixedClock } from "#src/lib/clock.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SOL = "gpt-6.1-sol", TERRA = "gpt-6.1-terra";
const NOW = Date.now();
const SHA = "a".repeat(40);
const revisions = { harnessRevision: SHA, promptRevision: SHA, toolRevision: SHA, scorerRevision: SHA, environmentRevision: SHA };
const tasks = Array.from({ length: 12 }, (_, i) => ({ taskId: `W1-T${90000 + i}`, taskClass: "implement", risk: "low" }));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function registered(root: string, effort: "low" | "medium" = "low") {
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const request: CodexBalancedTrialRequest = { phase: "aa", manifest: { version: "benchmark-aa-trial-v1",
    trialId: `balanced-${effort}-aa`, cohort: { kind: "public-fixture" }, stack: { provider: "codex", model: SOL, effort, ...revisions },
    labels: ["A1", "A2"], strataRevision: "v1", tasks },
    selections: tasks.map(({ taskId }) => ({ task_id: taskId, worker_assignment: { selected: { provider: "codex", effort },
      routing: { decision: { capability: "balanced" } } } })),
    pilotRequest: { version: "benchmark-paid-pilot-request-v1", pilotId: `balanced-${effort}-ab`,
      approval: { reference: "#7418", approvedAt: null },
      repos: ["fixture/alpha", "fixture/beta", "fixture/gamma"].map(repo => ({ repo, consentReceipt: "fixture-consent" })),
      pseudonymSalt: "fixture-salt", assignmentSeed: "fixture-seed", revisions, strataRevision: "v1",
      arms: { control: { provider: "codex", model: SOL, effort }, paid: { provider: "codex", model: TERRA, effort } },
      population: tasks.map(task => ({ ...task, repo: "fixture/alpha" })), primaryOutcome: "verified-completion",
      maturityDays: 14, protocolText: "operator protocol" } };
  const runtime: Omit<BenchmarkAaReadinessInput, "stateDir" | "trialId"> = {
    config: { overflow: "none" }, env: {}, clock: fixedClock(NOW), instanceRoots: [{ instance: "fixture", stateDir }],
    loadPlanTasks: () => tasks.map(task => ({ id: task.taskId, acceptance: [{ claim: "works", proof: "grep: works in result.txt" }] })),
    runtimePins: () => ({ harnessRevision: { source: "executing-module-git", revision: SHA }, revisions: {
      promptRevision: { source: "resolved-artifact", revision: SHA }, toolRevision: { source: "resolved-artifact", revision: SHA },
      scorerRevision: { source: "resolved-artifact", revision: SHA }, environmentRevision: { source: "resolved-artifact", revision: SHA } } }),
    dispatcherFor: () => async call => ({ headDir: "/fixture/head", headSha: SHA, servedModel: call.pin.model,
      billingMode: "subscription", costUsd: 0.1 }),
    grade: async () => ({ verdict: "pass", passed: 1, failed: 0, unmeasurable: 0, holdouts: 0, reasons: [] }) };
  const input = { stateDir, request, clock: fixedClock(NOW),
    readiness: (registration: Parameters<Parameters<typeof registerCodexBalancedTrial>[0]["readiness"]>[0]) =>
      runBenchmarkAaReadiness({ ...runtime, ...registration }), readCatalog: async () => [SOL, TERRA] };
  const aa = await registerCodexBalancedTrial(input);
  assert.ok(aa.ok, JSON.stringify(aa));
  assert.equal((await runBenchmarkAaReadiness({ ...runtime, stateDir, trialId: request.manifest.trialId })).state, "receipt-emitted");
  request.phase = "ab";
  const result = await registerCodexBalancedTrial(input);
  assert.ok(result.ok && result.phase === "ab", JSON.stringify(result));
  writeFileSync(ledgerPathFor({ root }), "");
  return { stateDir, protocol: result.protocol, path: result.path,
    aaPath: join(prospectiveAaDir(stateDir, request.manifest.trialId), `calibration-receipt.${request.manifest.trialId}.json`) };
}
const selectionInput = (stateDir: string, taskId = tasks[0]!.taskId) => ({ stateDir, taskId,
  provider: "codex", capability: "balanced", effort: "low", model: SOL, nowMs: NOW });

function capacity(root: string, effort = "low") {
  return selectCodexModel([SOL, TERRA, "gpt-6-sol"].map(id => ({ id,
    supportedReasoningEfforts: ["low", "medium", "high"].map(reasoningEffort => ({ reasoningEffort })) })),
  { rateLimits: { limitId: "codex", primary: { usedPercent: 10 } } }, { root, claudeBin: "/unused" }, undefined, effort);
}

async function runWorker(dir: string, taskId: string, selection = capacity(dir), executable?: string, pinnedModel?: string) {
  const bin = join(dir, "codex-fixture");
  writeFileSync(bin, `#!${process.execPath}\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'trial'}));\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:process.argv[process.argv.indexOf('--model')+1]}}));\nconsole.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:2,output_tokens:1}}));\n`);
  chmodSync(bin, 0o700);
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  return spawnCodexWorker({ cwd: dir, prompt: "report selected model", settingsFile: join(REPO_ROOT, "settings/worker.json"),
    workerHome: home, tools: ["Read"], taskId, runId: "trial-run" },
  { root: dir, claudeBin: "/unused", workerProviders: { codexBin: executable ?? bin, codexModel: pinnedModel } }, selection);
}
const auditRows = (dir: string) => readFileSync(ledgerPathFor({ root: dir }), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));

test("W1-T10842: a Codex-vs-Codex epoch compares two concrete Codex models", async t => {
  const { dir } = ownedFixtureDir(t, "codex-epoch");
  const fixture = await registered(dir);
  const epoch = experiments.CODEX_ROUTING_EXPERIMENTS.find(item => item.effort === "low")!;
  assert.equal(epoch.kind, "codex-vs-codex");
  assert.equal(epoch.modelArms.control.provider, "codex");
  assert.equal(epoch.modelArms.paid.provider, "codex");
  assert.ok(epoch.modelArms.control.model.test(SOL));
  assert.ok(epoch.modelArms.paid.model.test(TERRA));
  assert.equal(epoch.modelArms.paid.model.test("gpt-6.1-terra-alias"), false);
  const assigned = await experiments.codexExperimentArmForTask(selectionInput(fixture.stateDir));
  assert.equal(assigned.state, "assigned", JSON.stringify(assigned));
  assert.equal(experiments.routingExperimentFor({ capability: "balanced", effort: "high", considered: [
    { provider: "claude", model: "claude-sonnet-5", eligible: true }, { provider: "codex", model: "gpt-6-sol", eligible: true },
  ] }), "sol-vs-sonnet");
  assert.deepEqual(experiments.ROUTING_EXPERIMENTS.map(item => item.id), ["sol-vs-sonnet", "sol-vs-sonnet55",
    "sol61-vs-sonnet55", "sol61-vs-sonnet5", "haiku55-vs-luna6-low", "haiku55-vs-luna6-medium", "haiku55-vs-luna6-high"]);
});

test("W1-T10842: assignment is by task and stable across retries", async t => {
  const { dir } = ownedFixtureDir(t, "codex-stable");
  const { stateDir, protocol } = await registered(dir);
  const seen = new Set<string>();
  for (const task of tasks) {
    const input = selectionInput(stateDir, task.taskId);
    const first = await experiments.codexExperimentArmForTask(input);
    assert.equal(first.state, "assigned", JSON.stringify(first));
    assert.equal(first.assignment.assignedArm, paidPilotArmFor(protocol.pilotRequest.assignmentSeed, task.taskId));
    assert.equal(first.assignment.assignedProbability, protocol.assignment.allocation[first.assignment.assignedArm]);
    assert.equal(first.assignment.unit, "task");
    seen.add(first.assignment.assignedArm);
    assert.deepEqual(await experiments.codexExperimentArmForTask({ ...input, nowMs: NOW + 1000 }), first);
    const restarted = await import(`#src/lib/routing-experiments.js?restart=${task.taskId}`);
    assert.deepEqual(await restarted.codexExperimentArmForTask(input), first);
  }
  assert.equal(seen.size, 2);
});

test("W1-T10842: only codex balanced low and medium selections enter the trial", async t => {
  for (const effort of ["low", "medium"] as const) {
    const { dir } = ownedFixtureDir(t, `codex-scope-${effort}`);
    const { stateDir } = await registered(dir, effort);
    const base = { ...selectionInput(stateDir), effort };
    assert.equal((await experiments.codexExperimentArmForTask(base)).state, "assigned");
    for (const patch of [{ capability: "frontier" }, { capability: "economy" }, { effort: "high" },
      { provider: "cash" }, { provider: "claude" }, { taskId: "unfiled" }, { taskId: "W1-T1" }, { model: "gpt-6-sol" }]) {
      assert.equal((await experiments.codexExperimentArmForTask({ ...base, ...patch })).state, "inactive", JSON.stringify(patch));
    }
  }
});

test("W1-T10842: the trial assigns nothing until registered and Sol leads otherwise", async t => {
  const { dir } = ownedFixtureDir(t, "codex-inactive");
  const stateDir = join(dir, "state");
  const input = selectionInput(stateDir);
  assert.equal((await experiments.codexExperimentArmForTask(input)).state, "inactive");
  const fixture = await registered(dir);
  assert.equal((await experiments.codexExperimentArmForTask(input)).state, "assigned", "positive control");
  const report = readFileSync(fixture.aaPath, "utf8");
  rmSync(fixture.aaPath);
  assert.equal((await experiments.codexExperimentArmForTask(input)).state, "inactive");
  const bad = JSON.parse(report);
  bad.receipt.verdict = "integrity-concerns";
  writeFileSync(fixture.aaPath, JSON.stringify(bad));
  assert.equal((await experiments.codexExperimentArmForTask(input)).state, "inactive");
  writeFileSync(fixture.aaPath, report);
  assert.equal((await experiments.codexExperimentArmForTask({ ...input, nowMs: NOW + PAID_PILOT_AA_RECEIPT_MAX_AGE_MS + 1 })).state, "inactive");
  assert.equal((await experiments.codexExperimentArmForTask({ ...input, nowMs: NOW + fixture.protocol.cash.windowMs })).state, "inactive");
  appendPaidPilotControl(stateDir, fixture.protocol.trialId, "pause", new Date(NOW).toISOString(), "guardrail fired");
  assert.equal((await experiments.codexExperimentArmForTask(input)).state, "inactive");
  assert.equal(capacity(dir).model, SOL);
});

test("W1-T10842: intention-to-treat rows record the assigned arm and the served model", async t => {
  const { dir } = ownedFixtureDir(t, "codex-itt");
  const { protocol } = await registered(dir);
  const task = tasks.find(task => paidPilotArmFor(protocol.pilotRequest.assignmentSeed, task.taskId) === "paid")!;
  const result = await runWorker(dir, task.taskId);
  assert.equal(result.text, TERRA, "the actual child argv uses the treatment model");
  const rows = auditRows(dir);
  const assignment = rows.find(row => row.step === "codex_experiment.assignment");
  const receipt = rows.find(row => row.step === "codex_experiment.receipt");
  assert.equal(assignment.experiment.assignedArm, "paid");
  assert.equal(assignment.experiment.assignedProbability, protocol.assignment.allocation.paid);
  assert.equal(assignment.experiment.seed, protocol.pilotRequest.assignmentSeed);
  assert.equal(receipt.assignment_id, assignment.assignment_id);
  assert.equal(receipt.requested_model, TERRA);
  assert.equal(receipt.total_cost_usd, result.costUsd);
  assert.equal(Object.hasOwn(receipt, "cost_usd"), false, "the audit mirrors cost without a second pricing producer");
  assert.equal(receipt.served_model, null, "Codex exec does not report a served model; never echo the requested model");
  assert.equal(receipt.served_model_reason, result.servedModelReason);
  assert.equal(typeof receipt.served_model_reason, "string");
  const report = experiments.evaluateRoutingExperiment(rows, experiments.CODEX_ROUTING_EXPERIMENTS[0]!, new Date(NOW).toISOString().slice(0, 10));
  assert.equal(report.assignments, 1);
  assert.equal(report.arms.find(arm => arm.arm === "paid")!.tasks, 1);
  assert.equal(report.arms.find(arm => arm.arm === "paid")!.receiptCoverage.servedModelKnownAssignments, 0);
  assert.equal((await experiments.codexExperimentArmForTask(selectionInput(join(dir, "state")))).state, "inactive", "missing served-model guardrail pauses further assignments");
});

test("W1-T10842: the trial never re-leads a Codex row by itself", async t => {
  const { dir } = ownedFixtureDir(t, "codex-no-relead");
  const { stateDir } = await registered(dir);
  const row = [...codexCandidatesForCapability(undefined, "balanced", "low")];
  assert.equal((await experiments.codexExperimentArmForTask(selectionInput(stateDir))).state, "assigned");
  assert.deepEqual(codexCandidatesForCapability(undefined, "balanced", "low"), row);
  assert.equal(row[0], SOL);
  assert.equal(row.includes(TERRA), false);
});

test("Codex trial fallback keeps the assigned arm when Terra is unavailable", async t => {
  for (const unavailable of ["invisible", "unsupported-effort", "below-reserve"] as const) {
    const { dir } = ownedFixtureDir(t, `codex-fallback-${unavailable}`);
    const { protocol } = await registered(dir);
    const task = tasks.find(task => paidPilotArmFor(protocol.pilotRequest.assignmentSeed, task.taskId) === "paid")!;
    const selection = capacity(dir);
    const decision = selection.modelDecision!;
    const terra = decision.options.find(option => option.id === TERRA)!;
    if (unavailable === "invisible") decision.options = decision.options.filter(option => option !== terra);
    if (unavailable === "unsupported-effort") terra.supportedEfforts = ["high"];
    if (unavailable === "below-reserve") terra.windows = [{ name: "full", usedPercent: 100 }];
    const result = await runWorker(dir, task.taskId, selection);
    assert.equal(result.text, SOL);
    const assignment = auditRows(dir).find(row => row.step === "codex_experiment.assignment");
    assert.equal(assignment.experiment.assignedArm, "paid");
    assert.equal(assignment.crossover, true);
    const report = experiments.evaluateRoutingExperiment(auditRows(dir), experiments.CODEX_ROUTING_EXPERIMENTS[0]!, "2026-10-29");
    assert.equal(report.arms.find(arm => arm.arm === "paid")!.tasks, 1);
    assert.equal(report.crossoverTasks, 1);
  }
});

test("the control runs Sol and an unregistered Codex worker records no trial assignment", async t => {
  const { dir } = ownedFixtureDir(t, "codex-control");
  const { protocol } = await registered(dir);
  const task = tasks.find(task => paidPilotArmFor(protocol.pilotRequest.assignmentSeed, task.taskId) === "control")!;
  assert.equal((await runWorker(dir, task.taskId)).text, SOL);
  assert.equal(auditRows(dir).find(row => row.step === "codex_experiment.assignment").experiment.assignedArm, "control");
  const { dir: plain } = ownedFixtureDir(t, "codex-unregistered");
  mkdirSync(join(plain, "state"));
  writeFileSync(ledgerPathFor({ root: plain }), "");
  assert.equal((await runWorker(plain, task.taskId)).text, SOL);
  assert.equal(auditRows(plain).some(row => row.step === "codex_experiment.assignment"), false);
});

test("a Codex spawn failure leaves an assigned row and a reasoned missing receipt", async t => {
  const { dir } = ownedFixtureDir(t, "codex-spawn-failure");
  await registered(dir);
  await assert.rejects(runWorker(dir, tasks[0]!.taskId, capacity(dir), join(dir, "absent-codex")));
  const rows = auditRows(dir);
  const assignment = rows.find(row => row.step === "codex_experiment.assignment");
  const receipt = rows.find(row => row.step === "codex_experiment.receipt");
  assert.equal(receipt.assignment_id, assignment.assignment_id);
  assert.equal(receipt.success, false);
  assert.equal(receipt.total_cost_usd, null);
  assert.equal(receipt.served_model, null);
  assert.match(receipt.served_model_reason, /absent-codex/);
});

test("Codex admission refuses corrupt registration, mismatched calibration and guardrail evidence", async t => {
  const { dir } = ownedFixtureDir(t, "codex-evidence-refusals");
  const fixture = await registered(dir);
  const input = selectionInput(fixture.stateDir);
  const original = readFileSync(fixture.path, "utf8");
  const modify = (mutate: (value: typeof fixture.protocol) => void) => {
    const protocol = JSON.parse(original);
    mutate(protocol);
    const { digest: _digest, ...body } = protocol;
    protocol.digest = hash(body);
    writeFileSync(fixture.path, JSON.stringify(protocol));
  };
  writeFileSync(fixture.path, "{");
  assert.equal((await experiments.codexExperimentArmForTask(input)).state, "inactive");
  writeFileSync(fixture.path, JSON.stringify({ ...fixture.protocol, lead: TERRA }));
  assert.deepEqual(await experiments.codexExperimentArmForTask(input), { state: "inactive", reason: "registration-invalid" });
  modify(protocol => { protocol.aa.receipt.stackHash = "b".repeat(64); });
  assert.deepEqual(await experiments.codexExperimentArmForTask(input), { state: "inactive", reason: "aa-citation-mismatch" });
  modify(protocol => { protocol.pilotRequest.arms.paid.model = "gpt-6.1-terra-alias"; });
  assert.deepEqual(await experiments.codexExperimentArmForTask(input), { state: "inactive", reason: "registration-pins-invalid" });
  modify(protocol => { protocol.pilotRequest.population = []; });
  assert.deepEqual(await experiments.codexExperimentArmForTask(input), { state: "inactive", reason: "population-missing" });
  writeFileSync(fixture.path, original);
  const ledger = ledgerPathFor({ root: dir });
  const assignment = { ts: new Date(NOW).toISOString(), step: "codex_experiment.assignment", task_id: tasks[0]!.taskId,
    assignment_id: "positive-control", experiment: { trialId: fixture.protocol.trialId } };
  const receipt = { ts: new Date(NOW).toISOString(), step: "codex_experiment.receipt", assignment_id: "positive-control",
    served_model: TERRA, billing_mode: "subscription", total_cost_usd: 0 };
  for (const patch of [{}, { served_model: null }, { billing_mode: null }, { total_cost_usd: null }, { total_cost_usd: 1 }, { guardrail_fired: true }]) {
    writeFileSync(ledger, [assignment, { ...receipt, ...patch }].map(row => JSON.stringify(row)).join("\n") + "\n");
    const decision = await experiments.codexExperimentArmForTask(input);
    assert.equal(decision.state, Object.keys(patch).length === 0 ? "assigned" : "inactive", JSON.stringify(decision));
  }
  const { total_cost_usd: _cost, ...legacyReceipt } = receipt;
  for (const legacyCost of [0, null, 1]) {
    writeFileSync(ledger, [assignment, { ...legacyReceipt, cost_usd: legacyCost }].map(row => JSON.stringify(row)).join("\n") + "\n");
    assert.equal((await experiments.codexExperimentArmForTask(input)).state, legacyCost === 0 ? "assigned" : "inactive");
  }
  writeFileSync(ledger, [assignment, { ...receipt, total_cost_usd: null, cost_usd: 0 }].map(row => JSON.stringify(row)).join("\n") + "\n");
  assert.equal((await experiments.codexExperimentArmForTask(input)).state, "inactive", "an unknown summary cannot fall back to a legacy zero");
  writeFileSync(ledger, "{bad-json}\n");
  assert.deepEqual(await experiments.codexExperimentArmForTask(input), { state: "inactive", reason: "guardrail-evidence-unreadable" });
});

test("an explicit Codex model pin bypasses the registered trial", async t => {
  const { dir } = ownedFixtureDir(t, "codex-pinned");
  const { protocol } = await registered(dir);
  const task = tasks.find(task => paidPilotArmFor(protocol.pilotRequest.assignmentSeed, task.taskId) === "paid")!;
  assert.equal((await runWorker(dir, task.taskId, capacity(dir), undefined, SOL)).text, SOL);
  assert.equal(auditRows(dir).some(row => row.step.startsWith("codex_experiment.")), false);
});
