import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { parse, stringify } from "yaml";
import { aaStackHash } from "#src/lib/benchmark-aa.js";
import { prospectiveAaDir } from "#src/lib/benchmark-aa-prospective.js";
import { citeAaReceipt, paidPilotArmFor, PAID_PILOT_AA_RECEIPT_MAX_AGE_MS, PAID_PILOT_STOPPING_RULE,
  PAID_PILOT_WINDOW_MS } from "#src/lib/benchmark-paid-pilot.js";
import { systemClock } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import type { CodexBalancedTrialProtocol } from "#src/lib/codex-balanced-trial.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import { codexExperimentArmForTask, codexRoutingExperiment, experimentArmForTask, readCodexBalancedTrialProtocols, routingAbCommand,
  routingExperimentFor, ROUTING_EXPERIMENTS } from "#src/lib/routing-experiments.js";
import { balancedTrialControl, codexCandidatesForCapability, selectCodexModel, spawnCodexWorker,
  type ProviderCapacity } from "#src/lib/worker-provider.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const CONTROL = "gpt-6.2-sol";
const NEXT_CONTROL = "gpt-6.3-sol";
const TERRA = "gpt-6.1-terra";
const SEED = "fixture-balanced-seed";
const THREAD = "codex-trial-fixture";
const REVISION = "a".repeat(40);
const revisions = { harnessRevision: REVISION, promptRevision: REVISION, toolRevision: REVISION,
  scorerRevision: REVISION, environmentRevision: REVISION };
const tasks = Array.from({ length: 32 }, (_, i) => ({ taskId: `W1-T${i + 100}`, repo: "fixture/alpha", taskClass: "implement", risk: "low" }));
const paidTask = tasks.find(task => paidPilotArmFor(SEED, task.taskId) === "paid")!.taskId;
const controlTask = tasks.find(task => paidPilotArmFor(SEED, task.taskId) === "control")!.taskId;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function fixture(t: TestContext) {
  const { dir: root } = ownedFixtureDir(t, "codex-balanced-epoch");
  const stateDir = join(root, "state");
  const codexHome = join(root, "codex-home");
  const config = { root, workerProviders: { enabled: ["codex"], codexBin: "/bin/sh", codexHome } } as Config;
  const mounts = parse(readFileSync(mountsPath(REPO_ROOT), "utf8"));
  mkdirSync(join(root, ".remudero"));
  const setControl = (control: string) => {
    mounts.capabilities.codex.balanced.low = [control, "gpt-6-sol"];
    mounts.capabilities.codex.balanced.medium = [control, "gpt-6-sol"];
    writeFileSync(mountsPath(root), stringify(mounts));
  };
  setControl(CONTROL);
  const nowMs = systemClock.now();
  return { config, stateDir, codexHome, setControl, nowMs,
    selection: { stateDir, nowMs, taskId: paidTask, provider: "codex", capability: "balanced",
      effort: "low", model: CONTROL, currentSol: CONTROL } };
}

function registration(stateDir: string, nowMs: number, effort: "low" | "medium" = "low", control = CONTROL, suffix = "") {
  const trialId = `balanced-${effort}${suffix}`;
  const aaId = `${trialId}-aa`;
  const arms = { control: { provider: "codex", model: control, effort }, paid: { provider: "codex", model: TERRA, effort } };
  const asOf = new Date(nowMs).toISOString();
  const reportBody = { version: "benchmark-aa-v1", trialId: aaId };
  const receipt = { version: "benchmark-aa-receipt-v1", trialId: aaId, asOf,
    state: "observed", verdict: "no-integrity-concern-detected", winnerDeclared: false, reportHash: hash(reportBody),
    allocationReceiptHash: REVISION, stackHash: aaStackHash({ ...arms.control, ...revisions }) };
  const report = { ...reportBody, receipt };
  const cited = citeAaReceipt(report, nowMs);
  assert.ok(cited.ok);
  const body: Omit<CodexBalancedTrialProtocol, "digest"> = {
    version: "codex-balanced-trial-v1", trialId, lead: control, registeredAt: asOf, liveAssignment: false,
    assignment: { unit: "task", method: "sha256(benchmark-aa-allocation-v1, seed, taskId) parity", allocation: { control: 0.5, paid: 0.5 } },
    primaryOutcome: "verified-completion", analysis: "intention-to-treat",
    guardrails: ["recovery.repairRunsObserved", "laterDefects", "missingness.servedModel", "missingness.billingMode",
      "missingness.cost", "accounting.cashEstimate"],
    stoppingRule: PAID_PILOT_STOPPING_RULE,
    cash: { ceilingUsd: 100, windowMs: PAID_PILOT_WINDOW_MS, api: "reserve-before-each-attempt", subscriptionUsd: 0 },
    aa: { protocolDigest: REVISION, populationDigest: REVISION, receipt: cited.citation },
    pilotRequest: { version: "benchmark-paid-pilot-request-v1", pilotId: trialId, design: "unpaired", paired: null,
      approval: { reference: "#7418", approvedAt: null }, arms, revisions, population: tasks,
      pseudonymSalt: "fixture-salt", assignmentSeed: SEED, strataRevision: "fixture",
      primaryOutcome: "verified-completion", maturityDays: 14, protocolText: "fixture protocol",
      repos: ["fixture/alpha", "fixture/beta", "fixture/gamma"].map(repo => ({ repo, consentReceipt: "consented" })) },
  };
  const protocol = { ...body, digest: hash(body) };
  const aaDir = prospectiveAaDir(stateDir, aaId);
  mkdirSync(aaDir, { recursive: true });
  const receiptPath = join(aaDir, `calibration-receipt.${aaId}.json`);
  const protocolPath = join(stateDir, `codex-balanced-trial-v1.${trialId}.json`);
  writeFileSync(receiptPath, JSON.stringify(report));
  writeFileSync(protocolPath, JSON.stringify(protocol));
  return { protocol, protocolPath, receiptPath, report };
}

function spawnSelection(config: Config, effort: string, includeTerra = true): ProviderCapacity {
  const capabilities = loadMounts(mountsPath(config.root)).capabilities;
  const models = [...codexCandidatesForCapability(capabilities, "balanced", effort), ...(includeTerra ? [TERRA] : [])];
  return selectCodexModel(models.map(id => ({ id, supportedReasoningEfforts: [{ reasoningEffort: effort }] })),
    { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300 } } }, config, undefined, effort, capabilities);
}

async function spawn(f: ReturnType<typeof fixture>, taskId = paidTask, servedModel?: string, includeTerra = true, spawnError?: Error) {
  const { config, codexHome } = f;
  const sessionDay = join(codexHome, "sessions", ...new Date(f.nowMs).toISOString().slice(0, 10).split("-"));
  const session = join(sessionDay, `rollout-fixture-${THREAD}.jsonl`);
  mkdirSync(sessionDay, { recursive: true });
  if (servedModel === undefined) rmSync(session, { force: true });
  else writeFileSync(session, JSON.stringify({ type: "turn_context", payload: { model: servedModel } }) + "\n");
  let requested: string | undefined;
  const result = await spawnCodexWorker({
    cwd: config.root, workerHome: join(config.root, "worker-home"), prompt: "fixture",
    settingsFile: join(REPO_ROOT, "settings", "worker.json"), tools: ["Read"], taskId, runId: "fixture",
    containment: { spawn: (opts) => {
      if (spawnError !== undefined) throw spawnError;
      requested = opts.args[opts.args.indexOf("--model") + 1];
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
      setImmediate(() => {
        for (const event of [{ type: "thread.started", thread_id: THREAD }, { type: "turn.started" },
          { type: "item.completed", item: { type: "agent_message", text: "done" } },
          { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 10 } }]) {
          child.stdout.write(JSON.stringify(event) + "\n");
        }
        child.stdout.end();
        child.emit("exit", 0);
      });
      return { process: child as never, pid: 31351 };
    }, teardown: () => {} },
  }, config, spawnSelection(config, "low", includeTerra));
  return { result, requested };
}

function audit(f: ReturnType<typeof fixture>): Record<string, unknown>[] {
  return readFileSync(ledgerPathFor(f.config), "utf8").trim().split("\n").map(line => JSON.parse(line));
}

test("W1-T10842: a Codex-vs-Codex epoch compares two concrete Codex models", t => {
  const f = fixture(t);
  const { protocol } = registration(f.stateDir, f.nowMs);
  const epoch = codexRoutingExperiment(protocol);
  assert.equal(epoch.kind, "codex-vs-codex");
  assert.deepEqual(Object.values(epoch.arms).map(pin => [pin.provider, pin.modelId]), [["codex", CONTROL], ["codex", TERRA]]);
  for (const arm of Object.values(epoch.arms)) {
    assert.equal(arm.model.test(arm.modelId), true);
    assert.equal(arm.model.test(arm.modelId.replace(".", "x")), false);
    assert.equal(arm.model.test(`${arm.modelId}-alias`), false);
  }
  const legacy = ROUTING_EXPERIMENTS.find(row => row.id === "sol62-vs-sonnet55")!;
  assert.equal(routingExperimentFor({ capability: "balanced", effort: "high", considered: [
    { provider: "claude", model: "claude-sonnet-5-5", eligible: true }, { provider: "codex", model: CONTROL, eligible: true },
  ] }), legacy.id);
});

test("W1-T10842: assignment is by task and stable across retries", t => {
  const f = fixture(t);
  registration(f.stateDir, f.nowMs);
  const first = codexExperimentArmForTask(f.selection);
  assert.deepEqual(codexExperimentArmForTask({ ...f.selection, nowMs: f.nowMs + 1 }), first);
  assert.equal(first?.assignedArm, "paid");
  assert.equal(first?.assignedProbability, 0.5);
  assert.equal(first?.seed, SEED);
  assert.equal(codexExperimentArmForTask({ ...f.selection, taskId: controlTask })?.assignedArm, "control");
  const [diskProtocol] = readCodexBalancedTrialProtocols(f.stateDir);
  assert.deepEqual(experimentArmForTask(codexRoutingExperiment(diskProtocol!), paidTask), { arm: "paid", probability: 0.5 });
});

test("W1-T10842: only codex balanced low and medium selections enter the trial", t => {
  const f = fixture(t);
  for (const effort of ["low", "medium"] as const) {
    registration(f.stateDir, f.nowMs, effort);
    assert.equal(codexExperimentArmForTask({ ...f.selection, effort })?.assignedModel, TERRA);
  }
  for (const outside of [{ provider: "cash" }, { provider: "claude" }, { capability: "frontier" },
    { capability: "economy" }, { effort: "high" }, { taskId: "HARNESS" }, { taskId: "W1-T999" }]) {
    assert.equal(codexExperimentArmForTask({ ...f.selection, ...outside }), undefined);
  }
});

test("W1-T10842: the trial assigns nothing until registered and Sol leads otherwise", async t => {
  const f = fixture(t);
  assert.equal((await spawn(f)).requested, CONTROL);
  const { protocolPath, protocol, receiptPath, report } = registration(f.stateDir, f.nowMs);
  writeFileSync(protocolPath, "{");
  assert.equal(codexExperimentArmForTask(f.selection), undefined);
  writeFileSync(protocolPath, JSON.stringify(protocol));
  const failed = { ...report, receipt: { ...report.receipt, verdict: "integrity-concerns" } };
  writeFileSync(receiptPath, JSON.stringify(failed));
  assert.equal((await spawn(f)).requested, CONTROL);
  writeFileSync(receiptPath, JSON.stringify(report));
  for (const age of [PAID_PILOT_AA_RECEIPT_MAX_AGE_MS + 1, PAID_PILOT_WINDOW_MS]) {
    assert.equal(codexExperimentArmForTask({ ...f.selection, nowMs: f.nowMs + age }), undefined);
  }
  assert.equal((await spawn(f)).requested, TERRA);
  const [assignment, receipt] = audit(f);
  assert.equal(assignment?.step, "codex_experiment.assignment");
  assert.equal(receipt?.assignment_id, assignment?.assignment_id);
  assert.equal(receipt?.guardrail, "missingness.servedModel");
  assert.equal(codexExperimentArmForTask(f.selection), undefined);
  assert.equal((await spawn(f)).requested, CONTROL);
  assert.equal(audit(f).length, 2);
});

test("a thrown Codex attempt preserves its error and leaves an auditable held epoch", async t => {
  const f = fixture(t);
  registration(f.stateDir, f.nowMs);
  const refusal = new Error("fixture Codex spawn refused");
  await assert.rejects(spawn(f, paidTask, undefined, true, refusal), error => error === refusal);
  const [assignment, receipt] = audit(f);
  assert.equal(receipt?.assignment_id, assignment?.assignment_id);
  assert.equal(receipt?.success, false);
  assert.equal(receipt?.served_model, null);
  assert.equal(receipt?.guardrail, "missingness.servedModel");
  assert.equal((await spawn(f)).requested, CONTROL);
});

test("W1-T10842: the trial never re-leads a Codex row by itself", async t => {
  const f = fixture(t);
  registration(f.stateDir, f.nowMs);
  assert.equal((await spawn(f, paidTask, TERRA)).requested, TERRA);
  assert.equal((await spawn(f, controlTask, CONTROL)).requested, CONTROL);
  assert.equal((await spawn(f, paidTask, CONTROL, false)).requested, CONTROL);
  assert.equal(spawnSelection(f.config, "low").model, CONTROL);
  assert.deepEqual(codexCandidatesForCapability(loadMounts(mountsPath(f.config.root)).capabilities, "balanced", "low"),
    [CONTROL, "gpt-6-sol"]);
});

test("W1-T10842: the control is the current Sol of the Codex balanced row", async t => {
  const f = fixture(t);
  const initial = registration(f.stateDir, f.nowMs);
  const fromMounts = () => balancedTrialControl(loadMounts(mountsPath(f.config.root)).capabilities, "low");
  assert.equal(fromMounts(), initial.protocol.lead);
  assert.equal((await spawn(f, paidTask, TERRA)).requested, TERRA);
  f.setControl(NEXT_CONTROL);
  assert.equal(fromMounts(), NEXT_CONTROL);
  assert.equal((await spawn(f)).requested, NEXT_CONTROL);
  const replacement = registration(f.stateDir, f.nowMs, "low", NEXT_CONTROL, "-next");
  assert.notEqual(codexRoutingExperiment(initial.protocol).id, codexRoutingExperiment(replacement.protocol).id);
  assert.equal((await spawn(f, paidTask, TERRA)).requested, TERRA);
  assert.equal(audit(f).length, 4);
});

test("W1-T10842: the audit pairs assignment and observed served model through the Codex transport", async t => {
  const f = fixture(t);
  registration(f.stateDir, f.nowMs);
  const { result, requested } = await spawn(f, paidTask, CONTROL);
  assert.equal(requested, TERRA);
  assert.equal(result.servedModel, CONTROL);
  const [assignment, receipt] = audit(f);
  assert.ok(assignment && receipt);
  assert.equal(receipt.assignment_id, assignment.assignment_id);
  assert.deepEqual(receipt.experiment, assignment.experiment);
  assert.deepEqual(receipt.experiment, codexExperimentArmForTask(f.selection));
  assert.equal(receipt.served_model, CONTROL);
  assert.equal(receipt.served_model_source, "codex-session-file");
  assert.equal(receipt.crossover, true);
  const printed: string[] = [];
  await routingAbCommand(["--json"], { stateDir: f.stateDir, classifyAttempt: () => ({ outcome: "model", signal: "fixture" }),
    print: line => printed.push(line) });
  assert.deepEqual(JSON.parse(printed[0]!).codexReports.map((report: Record<string, unknown>) =>
    [report.assignments, report.crossovers, report.missingServedModel]), [[1, 1, 0]]);
  await routingAbCommand([], { stateDir: f.stateDir, classifyAttempt: () => ({ outcome: "model", signal: "fixture" }),
    print: line => printed.push(line) });
  assert.ok(printed.some(line => line.includes("1 assignments, 1 crossovers, 0 without served-model evidence")));
});
