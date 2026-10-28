// test/benchmark-aa-readiness.test.ts — W1-T5341: the fresh prospective calibration driver runs the existing paired
// seam on runtime-derived pins, reconciles registrations across instance roots, freezes its population, resumes without
// replay and reports missingness instead of zeros. Every case runs in rmd- temp state roots with a fake attempt
// dispatcher, a fake grader, injected runtime pins and a fixed clock: nothing spawns a worker, reads a real ledger or spends.
import assert from "node:assert/strict";
import fs, { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  API_BILLING_REFUSAL, listProspectiveAaRegistrations, prospectiveAaDir, prospectiveAaLedgerRows, runProspectiveAa, runProspectiveAaPair,
} from "../src/lib/benchmark-aa-prospective.js";
import {
  benchmarkAaReadinessCommand, deriveRuntimePins, recordReadinessGap, registryInstanceRoots, READINESS_FOLLOW_UPS_FILE, runBenchmarkAaReadiness,
  runtimePinRefusals,
  type BenchmarkAaReadinessInput, type ReadinessTask, type RuntimePins,
} from "../src/lib/benchmark-aa-readiness.js";
import { clockFromMillisFn, fixedClock } from "../src/lib/clock.js";
import { DEFAULT_INSTANCE_STATE_BASE } from "../src/lib/instance-gateway.js";
import type { PairedAttemptRequest, PairedAttemptResult, PairedGrade } from "../src/lib/paired-trial.js";
import type { AcceptanceCriterion, Task } from "../src/lib/plan.js";
import { benchmarkAaReadinessRuntime, HANDLERS } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const TRIAL = "aa-readiness-1";
const REGISTERED_MS = Date.parse("2026-10-02T08:00:00.000Z");
const RUN_MS = Date.parse("2026-10-02T09:00:00.000Z");
const STACK = { provider: "claude", model: "claude-sonnet-5", effort: "high" };
const REVISIONS = { harnessRevision: SHA, promptRevision: SHA, toolRevision: SHA, scorerRevision: SHA, environmentRevision: SHA };
const CRITERIA: AcceptanceCriterion[] = [{ claim: "the marker ships", proof: "grep: AA-OK in notes.txt" }];
const TASKS = Array.from({ length: 6 }, (_, i) => `RD-T${i + 1}`);
const SUBSCRIPTION = { overflow: "none" as const };

function manifest(trialId = TRIAL): Record<string, unknown> {
  return { version: "benchmark-aa-trial-v1", trialId, cohort: { kind: "opted-in", consentReceipt: "consent-7", pseudonymSalt: "salt-7" },
    stack: { ...STACK, ...REVISIONS }, strataRevision: "strata-v1",
    tasks: TASKS.map((taskId) => ({ taskId, taskClass: "fix", risk: "low" })), protocolText: "Fresh prospective A/A.\n" };
}

function root(): string {
  return mkdtempSync(join(tmpdir(), "rmd-aa-readiness-"));
}

async function register(stateDir: string, trialId = TRIAL): Promise<void> {
  const outcome = await runProspectiveAa({ action: "register", stateDir, manifest: manifest(trialId), clock: fixedClock(REGISTERED_MS) });
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.reason);
}

function pins(changes: Partial<Record<keyof typeof REVISIONS, unknown>> = {}): RuntimePins {
  const artifact = (field: keyof typeof REVISIONS) => (changes[field] ?? { source: "resolved-artifact", revision: SHA }) as never;
  return { harnessRevision: (changes.harnessRevision ?? { source: "executing-module-git", revision: SHA }) as never,
    revisions: { promptRevision: artifact("promptRevision"), toolRevision: artifact("toolRevision"),
      scorerRevision: artifact("scorerRevision"), environmentRevision: artifact("environmentRevision") } };
}

function dispatcher(calls: PairedAttemptRequest<string>[], route: (request: PairedAttemptRequest<string>) => Partial<PairedAttemptResult> = () => ({})) {
  return async (request: PairedAttemptRequest<string>): Promise<PairedAttemptResult> => {
    calls.push(request);
    return { headDir: `/heads/${request.taskId}/${request.arm}`, headSha: SHA, servedModel: request.pin.model, billingMode: "subscription",
      costUsd: 0.4, ...route(request) };
  };
}

function grade({ headDir }: { headDir: string }): PairedGrade {
  const pass = Number(/RD-T(\d+)/.exec(headDir)![1]) % 2 === 0;
  return { verdict: pass ? "pass" : "fail", passed: pass ? 1 : 0, failed: pass ? 0 : 1, unmeasurable: 0, holdouts: 0, reasons: [] };
}

const planTasks = (ids: readonly string[] = TASKS): ReadinessTask[] => ids.map((id) => ({ id, acceptance: CRITERIA }));

function input(stateDir: string, calls: PairedAttemptRequest<string>[], rest: Partial<BenchmarkAaReadinessInput> = {}): BenchmarkAaReadinessInput {
  let ms = RUN_MS;
  return { stateDir, trialId: TRIAL, config: SUBSCRIPTION, env: {}, clock: clockFromMillisFn(() => (ms += 1000)),
    runtimePins: () => pins(), loadPlanTasks: () => planTasks(), dispatcherFor: () => dispatcher(calls), grade, ...rest };
}

test("calibration driver refuses drifting runtime pins before dispatch", async () => {
  const stateDir = root();
  await register(stateDir);
  const calls: PairedAttemptRequest<string>[] = [];
  const drifted = await runBenchmarkAaReadiness(input(stateDir, calls, { runtimePins: () => pins({ promptRevision: { source: "resolved-artifact", revision: OTHER_SHA } }) }));
  assert.equal(drifted.state, "refused");
  assert.ok(drifted.refusals.includes("runtime-pin-drift:promptRevision"), drifted.refusals.join(","));
  const unknown = await runBenchmarkAaReadiness(input(stateDir, calls, { runtimePins: () => pins({ environmentRevision: { state: "unavailable", reason: "artifact-not-resolved" } }) }));
  assert.ok(unknown.refusals.includes("runtime-pin-unknown:environmentRevision:artifact-not-resolved"), "an unknown pin is refused, never guessed");
  const harness = await runBenchmarkAaReadiness(input(stateDir, calls, { runtimePins: () => pins({ harnessRevision: { source: "executing-module-git", revision: OTHER_SHA } }) }));
  assert.ok(harness.refusals.includes("runtime-pin-drift:harnessRevision"));
  assert.equal(calls.length, 0, "no attempt was dispatched under a drifting or unknown pin");
  assert.deepEqual(prospectiveAaLedgerRows(stateDir, TRIAL), [], "a refused calibration writes no trial row");
  assert.equal(existsSync(join(prospectiveAaDir(stateDir, TRIAL), "population.json")), false, "the population is not frozen under bad pins");

  // Pins that drift mid-run stop the driver before the next pair: one pair ran, the rest were never dispatched.
  let reads = 0;
  const midRun = await runBenchmarkAaReadiness(input(stateDir, calls, { runtimePins: () => (reads++ < 2 ? pins()
    : pins({ toolRevision: { source: "resolved-artifact", revision: OTHER_SHA } })) }));
  assert.match(midRun.run.stoppedBy ?? "", /^runtime-pins-drifted-mid-run:runtime-pin-drift:toolRevision/);
  assert.equal(calls.length, 2, "exactly one pair ran before the drift was seen");
  const assignment = prospectiveAaLedgerRows(stateDir, TRIAL).find((row) => row.step === "worker.assignment")!;
  const stack = (assignment.benchmark_run as { stack: Record<string, { state: string; value?: string }> }).stack;
  for (const field of ["promptRevision", "toolRevision", "scorerRevision", "environmentRevision"]) {
    assert.deepEqual(stack[field], { state: "observed", value: SHA }, `${field} is recorded from runtime and manifest agreeing`);
  }

  // The production pair seam itself refuses a disagreeing runtime pin before spawn.
  const seamCalls: PairedAttemptRequest<string>[] = [];
  const seam = await runProspectiveAaPair({ task: { id: TASKS[5]!, acceptance: CRITERIA }, lane: "implement", stateDir, config: SUBSCRIPTION, env: {},
    clock: fixedClock(RUN_MS), harnessRevision: { source: "executing-module-git", revision: SHA }, grade,
    runtimeRevisions: { scorerRevision: { source: "resolved-artifact", revision: OTHER_SHA } }, dispatchAttempt: dispatcher(seamCalls) });
  assert.equal(seam.state, "refused");
  assert.ok(seam.reasons.includes("runtime-pin-drift:scorerRevision"), seam.reasons.join(","));
  assert.equal(seamCalls.length, 0);

  // The production derivation: source-shipped pins at the executing revision, tools only when clean, environment from the stamp.
  const harnessPin = { source: "executing-module-git" as const, revision: SHA };
  const clean = deriveRuntimePins({ harnessRevision: harnessPin, installRoot: "/install",
    git: (_cwd, args) => args[0] === "rev-parse" ? SHA : "", readStamp: () => `${SHA}\n` });
  assert.deepEqual(clean.revisions.toolRevision, { source: "resolved-artifact", revision: SHA });
  assert.deepEqual(clean.revisions.environmentRevision, { source: "resolved-artifact", revision: SHA });
  const dirty = deriveRuntimePins({ harnessRevision: harnessPin, installRoot: "/install",
    git: (_cwd, args) => args[0] === "rev-parse" ? SHA : " M settings/worker.json\n", readStamp: () => "unknown" });
  assert.deepEqual(dirty.revisions.toolRevision, { state: "unavailable", reason: "executing-source-not-clean" });
  assert.deepEqual(dirty.revisions.environmentRevision, { state: "unavailable", reason: "artifact-not-resolved" });
  const unpinned = deriveRuntimePins({ harnessRevision: { state: "unavailable", reason: "executing-source-not-clean" }, installRoot: "/install",
    git: () => { throw new Error("git must not run without a harness pin"); }, readStamp: () => undefined });
  assert.deepEqual(unpinned.revisions.promptRevision, { state: "unavailable", reason: "executing-source-not-clean" });
});

test("a clean newer tool checkout cannot claim the revision of an already loaded harness", () => {
  const repo = gitRepo({ kind: "runtime-tool-pins" });
  mkdirSync(join(repo.dir, "settings"));
  writeFileSync(join(repo.dir, "settings", "tools.json"), '{"version":1}\n');
  repo.git("add", "settings"); repo.git("commit", "--quiet", "-m", "first tools");
  const revision = repo.git("rev-parse", "HEAD");
  const harnessRevision = { source: "executing-module-git" as const, revision };
  const clean = deriveRuntimePins({ harnessRevision, installRoot: repo.dir, readStamp: () => SHA });
  assert.deepEqual(clean.revisions.toolRevision, { source: "resolved-artifact", revision });
  writeFileSync(join(repo.dir, "settings", "tools.json"), '{"version":2}\n');
  repo.git("add", "settings"); repo.git("commit", "--quiet", "-m", "new tools");
  assert.notEqual(repo.git("rev-parse", "HEAD"), revision);
  assert.equal(repo.git("status", "--porcelain", "--", "settings", "hooks"), "", "the default Git path sees clean committed tools");
  const advanced = deriveRuntimePins({ harnessRevision, installRoot: repo.dir, readStamp: () => SHA });
  assert.deepEqual(advanced.revisions.toolRevision, { state: "unavailable", reason: "executing-tool-revision-drift" });
  assert.deepEqual(runtimePinRefusals(advanced, { ...STACK, ...REVISIONS, harnessRevision: revision,
    promptRevision: revision, toolRevision: revision, scorerRevision: revision }),
  ["runtime-pin-unknown:toolRevision:executing-tool-revision-drift"]);
});

test("a tool checkout advancing during the actual status read remains unavailable", () => {
  const repo = gitRepo({ kind: "runtime-tool-pin-race" });
  mkdirSync(join(repo.dir, "hooks"));
  writeFileSync(join(repo.dir, "hooks", "tool"), "first\n");
  repo.git("add", "hooks"); repo.git("commit", "--quiet", "-m", "first tools");
  const revision = repo.git("rev-parse", "HEAD");
  let headReads = 0;
  const result = deriveRuntimePins({ harnessRevision: { source: "executing-module-git", revision },
    installRoot: repo.dir, readStamp: () => undefined,
    git: (cwd, args) => {
      assert.equal(cwd, repo.dir);
      const output = repo.git(...args);
      if (args[0] === "rev-parse") headReads++;
      if (args[0] === "status") {
        writeFileSync(join(repo.dir, "hooks", "tool"), "new\n");
        repo.git("add", "hooks"); repo.git("commit", "--quiet", "-m", "tools advanced during inspection");
      }
      return output;
    },
  });
  assert.equal(headReads, 2, "the clean status must be bracketed by real commit identity reads");
  assert.deepEqual(result.revisions.toolRevision, { state: "unavailable", reason: "executing-tool-revision-drift" });
});

test("the default tool Git reader preserves a real missing install as unavailable", () => {
  const repo = gitRepo({ kind: "runtime-tool-pin-missing" });
  const result = deriveRuntimePins({ harnessRevision: { source: "executing-module-git", revision: repo.git("rev-parse", "HEAD") },
    installRoot: join(repo.dir, "absent"), readStamp: () => undefined });
  assert.ok(result.revisions.toolRevision !== undefined && "state" in result.revisions.toolRevision);
  assert.equal(result.revisions.toolRevision.state, "unavailable");
  assert.match(result.revisions.toolRevision.reason, /^executing-module-revision-unavailable:/);
});

test("calibration resumes identity-qualified assignments without replaying completed pairs", async () => {
  const core = root();
  const beta = root();
  await register(beta);
  const digest = (JSON.parse(readFileSync(join(prospectiveAaDir(beta, TRIAL), "protocol.json"), "utf8")) as { digest: string }).digest;
  const roots = [{ instance: "core", stateDir: core }, { instance: "beta", stateDir: beta }];
  const calls: PairedAttemptRequest<string>[] = [];
  const first = await runBenchmarkAaReadiness(input(core, calls, { instanceRoots: roots, maxPairs: 2 }));
  assert.equal(first.identity, `beta/${TRIAL}@${digest.slice(0, 16)}`, "the trial is identified by its owning instance and protocol digest");
  assert.deepEqual(first.sources.roots.map((source) => [source.instance, source.state]), [["core", "read"], ["beta", "read"]]);
  assert.equal(first.sources.complete, true);
  assert.equal(first.run.dispatchedPairs, 2);
  assert.equal(first.run.stoppedBy, "max-pairs-reached");
  assert.equal(calls.length, 4);
  assert.equal(existsSync(join(core, "benchmark-aa-prospective")), false, "no duplicate registration on the reading instance");

  const restarted = await runBenchmarkAaReadiness(input(core, calls, { instanceRoots: roots }));
  assert.equal(restarted.run.completedBefore, 2, "the restart reads the two completed pairs back");
  assert.equal(restarted.run.dispatchedPairs, TASKS.length - 2);
  assert.equal(calls.length, TASKS.length * 2, "every eligible task ran exactly one pair across both runs");
  for (const taskId of TASKS) assert.equal(calls.filter((call) => call.taskId === taskId).length, 2, `${taskId} was not replayed`);
  const again = await runBenchmarkAaReadiness(input(core, calls, { instanceRoots: roots }));
  assert.equal(again.run.dispatchedPairs, 0);
  assert.equal(calls.length, TASKS.length * 2, "a third run replays nothing");
  const decisions = prospectiveAaLedgerRows(beta, TRIAL).filter((row) => row.step === "aa_prospective.decision");
  assert.equal(decisions.length, TASKS.length, "one admission per task: the joins carry no duplicate attempt");

  // The same trial registered on a second instance is a duplicate trial: refused before any dispatch.
  await register(core);
  const duplicate = await runBenchmarkAaReadiness(input(core, calls, { instanceRoots: roots }));
  assert.equal(duplicate.state, "refused");
  assert.ok(duplicate.refusals.includes("trial-registered-in-multiple-roots"), duplicate.refusals.join(","));
  // An instance root that cannot be read leaves the source window incomplete: no duplicate can be ruled out.
  const gamma = join(root(), "absent");
  const unread = await runBenchmarkAaReadiness(input(beta, calls, { instanceRoots: [{ instance: "beta", stateDir: beta }, { instance: "gamma", stateDir: gamma }] }));
  assert.equal(unread.sources.complete, false);
  assert.ok(unread.refusals.includes("instance-root-unreadable:gamma"));
  // A fresh manifest is never registered beside another instance's active trial.
  const fresh = root();
  const other = await runBenchmarkAaReadiness(input(fresh, calls, { trialId: "aa-readiness-2", manifest: manifest("aa-readiness-2"),
    instanceRoots: [{ instance: "fresh", stateDir: fresh }, { instance: "beta", stateDir: beta }] }));
  assert.match(other.refusals[0] ?? "", /^another-prospective-aa-active:beta\/aa-readiness-1@/);
  assert.equal(existsSync(join(fresh, "benchmark-aa-prospective")), false);
  assert.equal(calls.length, TASKS.length * 2);
});

test("calibration reports eligibility and per-stage missingness by arm", async () => {
  const stateDir = root();
  await register(stateDir);
  const plan: ReadinessTask[] = [...planTasks(TASKS.slice(0, 3)), { id: TASKS[3]!, acceptance: [] },
    { id: TASKS[4]!, acceptance: [{ claim: "it reads well", proof: "a careful reader agrees" }] }];
  const calls: PairedAttemptRequest<string>[] = [];
  // The first attempt dispatched produces no head (unmeasurable, so its pair stops); the second pair reports no cost.
  const route = () => calls.length === 1 ? { headDir: null } : { costUsd: null };
  const result = await runBenchmarkAaReadiness(input(stateDir, calls, { loadPlanTasks: () => plan, dispatcherFor: () => dispatcher(calls, route), maxPairs: 2 }));
  assert.equal(result.population?.denominator, TASKS.length, "the denominator is the whole registered population");
  assert.equal(result.population?.eligible, 3);
  assert.deepEqual(result.population?.refused.map((entry) => entry.reason).sort(),
    ["no-acceptance-criteria", "no-executable-proof", "task-not-in-plan"].sort(), "every ineligible task keeps its reason");
  assert.equal(result.population?.consent, "opted-in");
  assert.equal(calls.length, 3, "the unmeasurable first attempt stopped its pair; the second pair ran both labels");
  const missing = result.missingness!;
  assert.deepEqual(missing.denominators, { eligible: 3, triggered: 2 });
  assert.deepEqual(missing.untriggered, { count: 1, byReason: { "not-yet-run": 1 } }, "an untriggered task is an exclusion, not a zero");
  const first = calls[0]!.arm;
  const second = Object.keys(missing.arms).find((label) => label !== first)!;
  assert.deepEqual(missing.arms[first], { assigned: { observed: 2, missing: 0 }, attempted: { observed: 2, missing: 0 },
    terminal: { observed: 2, missing: 0 }, verified: { observed: 1, missing: 1 }, refusedBeforeSpawn: 0 });
  assert.deepEqual(missing.arms[second], { assigned: { observed: 1, missing: 1 }, attempted: { observed: 1, missing: 1 },
    terminal: { observed: 1, missing: 1 }, verified: { observed: 1, missing: 1 }, refusedBeforeSpawn: 0 });
  assert.deepEqual(result.cash?.observedCash, { usd: 0, apiBilledAttempts: 0, unknownCostAttempts: 0 }, "cash is observed apart from notional usage");
  assert.deepEqual(result.cash?.notionalUsage, { usd: 0.4, attempts: 3, unknownCostAttempts: 2 }, "an unreported cost is counted as unknown, never zero");
  assert.equal(result.state, "withheld", "missing evidence withholds the receipt");
  assert.equal(result.receipt.state, "withheld");
  assert.equal(result.nextGap?.kind, "untriggered-eligible-tasks");
  assert.ok(result.nextGap?.machineRepairable, "the next gap is machine-repairable");
  assert.equal(result.followUp?.state, "recorded");

  // The frozen population survives a later plan change, and the same gap is not filed twice.
  const later = await runBenchmarkAaReadiness(input(stateDir, calls, { loadPlanTasks: () => planTasks(), dispatcherFor: () => dispatcher(calls), maxPairs: 1 }));
  assert.equal(later.population?.eligible, 3, "eligibility is frozen at the first run");
  assert.equal(later.population?.denominator, TASKS.length);
  assert.equal(later.missingness?.untriggered.count, 0);
  assert.equal(later.nextGap?.kind, "stage-missing");
  assert.equal(later.followUp?.state, "recorded");
  const rerun = await runBenchmarkAaReadiness(input(stateDir, calls, { loadPlanTasks: () => planTasks(), dispatcherFor: () => dispatcher(calls) }));
  assert.equal(rerun.run.dispatchedPairs, 0);
  assert.equal(rerun.followUp?.state, "already-recorded", "a gap already recorded is not recorded again");
  assert.equal(readFileSync(join(stateDir, READINESS_FOLLOW_UPS_FILE), "utf8").trim().split("\n").length, 2);
  assert.notEqual(rerun.state, "receipt-emitted", "a small sample with lost evidence is never a receipt");
});

test("calibration refuses API billing without blocking PR flow", async () => {
  const stateDir = root();
  await register(stateDir);
  const calls: PairedAttemptRequest<string>[] = [];
  const result = await runBenchmarkAaReadiness(input(stateDir, calls, { config: { overflow: "api_key" }, env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-fixture" } }));
  assert.equal(result.state, "refused");
  assert.equal(result.billing, "api");
  assert.ok(result.refusals.includes(API_BILLING_REFUSAL), result.refusals.join(","));
  assert.equal(calls.length, 0, "no attempt is spawned on the paid lane");
  assert.equal(result.paidPilot, "not-activated");
  assert.deepEqual(result.holds, { dispatch: false, pr: false, daemon: false }, "ordinary dispatch, PRs and the daemon are never held");
  const trialDir = prospectiveAaDir(stateDir, TRIAL);
  assert.equal(existsSync(join(trialDir, "controls.ndjson")), false, "the trial is not paused and nothing is held");
  assert.deepEqual(readdirSync(stateDir).sort(), ["benchmark-aa-prospective", READINESS_FOLLOW_UPS_FILE, `${READINESS_FOLLOW_UPS_FILE}.admissions`].sort(),
    "no paid-pilot protocol, hold or control file is written");
  assert.deepEqual(readdirSync(trialDir), ["protocol.json"]);
  assert.equal(result.nextGap?.machineRepairable, false, "api billing is an operator setting, not a machine repair");
  // A subscription run right after proceeds normally: the refusal left nothing behind that blocks work.
  const after = await runBenchmarkAaReadiness(input(stateDir, calls, { maxPairs: 1 }));
  assert.equal(after.run.dispatchedPairs, 1);
  assert.ok(calls.every((call) => call.pin.billing === "subscription"));
});

test("calibration names unavailable runtime and registry evidence", async () => {
  const failed = deriveRuntimePins({ harnessRevision: pins().harnessRevision, installRoot: root(),
    git: () => { throw new Error("tool status unavailable"); } });
  assert.deepEqual(failed.revisions.toolRevision,
    { state: "unavailable", reason: "executing-module-revision-unavailable:tool status unavailable" });
  const local = root();
  const registry = "instances:\n  core:\n    repo: owner/core\n  beta:\n    repo: owner/beta\n  retired:\n    repo: owner/old\n    retired: true\n";
  assert.deepEqual(registryInstanceRoots(local, () => registry), { roots: [
    { instance: "core", stateDir: local }, { instance: "beta", stateDir: join(DEFAULT_INSTANCE_STATE_BASE, "beta", "state") },
  ] });
  const missing = registryInstanceRoots(local, () => { throw new Error("registry missing"); });
  assert.deepEqual(missing, { reason: "instance-registry-unreadable:registry missing" });
  assert.match((registryInstanceRoots(local, () => "invalid") as { reason: string }).reason, /^instance-registry-unreadable:/);
  const calls: PairedAttemptRequest<string>[] = [];
  const result = await runBenchmarkAaReadiness(input(local, calls, { defaultInstanceRoots: () => missing }));
  assert.equal(result.state, "refused");
  assert.equal(result.sources.complete, false);
  assert.ok(result.refusals.includes("instance-registry-unreadable:registry missing"));
  assert.equal(calls.length, 0);
});

test("calibration refuses an unreadable protocol root and preserves its reason", async () => {
  const stateDir = root();
  writeFileSync(join(stateDir, "benchmark-aa-prospective"), "not a directory");
  assert.deepEqual(listProspectiveAaRegistrations(stateDir),
    { state: "unreadable", reason: "protocol-root-unreadable:ENOTDIR" });
  const calls: PairedAttemptRequest<string>[] = [];
  const result = await runBenchmarkAaReadiness(input(stateDir, calls));
  assert.equal(result.state, "refused");
  assert.equal(result.sources.complete, false);
  assert.equal(result.sources.roots[0]?.reason, "protocol-root-unreadable:ENOTDIR");
  assert.deepEqual(result.refusals, ["instance-root-unreadable:local"]);
  assert.equal(calls.length, 0);
});

test("calibration registers a fresh manifest and refuses invalid registration", async () => {
  const stateDir = root();
  const calls: PairedAttemptRequest<string>[] = [];
  const result = await runBenchmarkAaReadiness(input(stateDir, calls, { manifest: manifest(), maxPairs: 1 }));
  assert.equal(result.run.dispatchedPairs, 1);
  assert.equal(result.population?.denominator, TASKS.length);
  assert.match(result.identity ?? "", /^local\/aa-readiness-1@/);
  assert.equal(listProspectiveAaRegistrations(stateDir).state, "read");
  assert.equal(calls.length, 2);
  const invalid = await runBenchmarkAaReadiness(input(root(), calls, { manifest: {} }));
  assert.equal(invalid.state, "refused");
  assert.match(invalid.refusals[0] ?? "", /^registration-refused:/);
  assert.equal(calls.length, 2);
});

test("calibration refuses unreadable plans and frozen populations before dispatch", async () => {
  const stateDir = root();
  await register(stateDir);
  const calls: PairedAttemptRequest<string>[] = [];
  const plan = await runBenchmarkAaReadiness(input(stateDir, calls, {
    loadPlanTasks: () => { throw new Error("plan missing"); },
  }));
  assert.equal(plan.state, "refused");
  assert.deepEqual(plan.refusals, ["plan-unreadable:plan missing"]);
  assert.equal(existsSync(join(prospectiveAaDir(stateDir, TRIAL), "population.json")), false);
  writeFileSync(join(prospectiveAaDir(stateDir, TRIAL), "population.json"), "{");
  const population = await runBenchmarkAaReadiness(input(stateDir, calls));
  assert.equal(population.state, "refused");
  assert.match(population.refusals[0] ?? "", /^population-unreadable:/);
  assert.equal(population.receipt.state, "withheld");
  assert.equal(calls.length, 0);
});

test("calibration preserves the opened follow-up file when its path is replaced", async (t) => {
  const stateDir = root();
  const path = join(stateDir, READINESS_FOLLOW_UPS_FILE);
  const moved = join(stateDir, "original-follow-ups.ndjson");
  const prior = `${JSON.stringify({ key: "another-trial:trial-not-registered" })}\n`;
  writeFileSync(path, prior);
  const read = fs.readFileSync;
  let replaced = false;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof read>) => {
    const text = read(...args);
    if (!replaced && text === prior) {
      replaced = true;
      renameSync(path, moved);
      writeFileSync(path, "replacement\n");
    }
    return text;
  });
  syncBuiltinESMExports();
  try {
    const result = await runBenchmarkAaReadiness(input(stateDir, []));
    assert.equal(result.followUp?.state, "recorded");
    assert.equal(replaced, true, "the path was replaced between reading and appending");
    assert.equal(readFileSync(path, "utf8"), "replacement\n", "the replacement file is untouched");
    const rows = readFileSync(moved, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { key: string });
    assert.deepEqual(rows.map((row) => row.key), ["another-trial:trial-not-registered", `${TRIAL}:trial-not-registered`]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("calibration distinguishes unreadable population and follow-up files from absence", async () => {
  const stateDir = root();
  await register(stateDir);
  const population = join(prospectiveAaDir(stateDir, TRIAL), "population.json");
  mkdirSync(population);
  const calls: PairedAttemptRequest<string>[] = [];
  const result = await runBenchmarkAaReadiness(input(stateDir, calls));
  assert.equal(result.state, "refused");
  assert.match(result.refusals[0] ?? "", /^population-unreadable:.*EISDIR/);
  assert.equal(calls.length, 0);
  assert.deepEqual(readdirSync(population), []);
  const unreadable = root();
  mkdirSync(join(unreadable, READINESS_FOLLOW_UPS_FILE));
  await assert.rejects(runBenchmarkAaReadiness(input(unreadable, calls)), { code: "EISDIR" });
  assert.equal(calls.length, 0);
});

test("readiness CLI rejects invalid arguments and unreadable manifests without running", async () => {
  const lines: string[] = [];
  let runs = 0;
  const run = async () => { runs++; throw new Error("driver must not run"); };
  const deps = { print: (line: string) => lines.push(line), resolveStateDir: root };
  assert.equal(await benchmarkAaReadinessCommand(["--unknown"], run, deps), 2);
  assert.match(lines.pop()!, /arguments-invalid:/);
  const directory = root();
  const path = join(directory, "manifest.json");
  for (const contents of [undefined, "{"]) {
    if (contents !== undefined) writeFileSync(path, contents);
    assert.equal(await benchmarkAaReadinessCommand(["--trial-id", TRIAL, "--trial", path], run, deps), 2);
    assert.match(lines.pop()!, /trial-manifest-unreadable:/);
  }
  assert.equal(runs, 0);
});

test("readiness CLI prints refused, withheld and emitted calibration outcomes", async () => {
  const stateDir = root();
  const path = join(stateDir, "manifest.json");
  writeFileSync(path, JSON.stringify(manifest()));
  const calls: PairedAttemptRequest<string>[] = [];
  const lines: string[] = [];
  const deps = { print: (line: string) => lines.push(line), resolveStateDir: () => stateDir };
  const run = (request: Parameters<Parameters<typeof benchmarkAaReadinessCommand>[1]>[0]) =>
    runBenchmarkAaReadiness(input(request.stateDir, calls, request));
  assert.equal(await benchmarkAaReadinessCommand(["--trial-id", TRIAL], run, deps), 1);
  assert.ok(lines.some((line) => line.includes("refused: trial-not-registered")));
  lines.length = 0;
  assert.equal(await benchmarkAaReadinessCommand(["--trial-id", TRIAL, "--trial", path, "--max-pairs", "1"], run, deps), 1);
  assert.ok(lines.some((line) => line.includes(`population ${TASKS.length}: ${TASKS.length} eligible, 0 refused`)));
  assert.ok(lines.some((line) => line.includes("stopped: max-pairs-reached")));
  assert.ok(lines.some((line) => line.includes("next gap: untriggered-eligible-tasks:")));
  lines.length = 0;
  const receipt = join(stateDir, "receipt.json");
  assert.equal(await benchmarkAaReadinessCommand(["--trial-id", TRIAL, "--out", receipt], run, deps), 0);
  assert.ok(lines.some((line) => line.includes("receipt-emitted")));
  assert.ok(lines.some((line) => line.endsWith(`written to ${receipt}`)));
  const emitted = JSON.parse(readFileSync(receipt, "utf8")) as { receipt: { state: string; verdict: string } };
  assert.equal(emitted.receipt.state, "observed");
  assert.equal(emitted.receipt.verdict, "no-integrity-concern-detected");
  assert.equal(calls.length, TASKS.length * 2);
});

test("rmd benchmark-aa readiness reaches the readiness driver", async () => {
  const home = mkdtempSync(join(tmpdir(), "rmd-aa-readiness-cli-"));
  const savedHome = process.env.HOME;
  const savedLog = console.log;
  const printed: string[] = [];
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root: join(home, "Remudero") }));
    const stateDir = join(home, "state");
    mkdirSync(stateDir, { recursive: true });
    process.env.HOME = home;
    const runtime = benchmarkAaReadinessRuntime(stateDir, 1000);
    assert.equal(typeof runtime.dispatcherFor({ ...planTasks()[0], repo: "fixture" } as Task), "function");
    console.log = (line: string) => { printed.push(line); };
    const code = await HANDLERS.get("benchmark-aa")!(["readiness", "--trial-id", "aa-missing", "--state-dir", stateDir,
      "--instance-root", `core=${stateDir}`, "--json"]);
    assert.equal(code, 1);
    const result = JSON.parse(printed[0]!) as { state: string; refusals: string[]; holds: Record<string, boolean> };
    assert.equal(result.state, "refused");
    assert.deepEqual(result.refusals, ["trial-not-registered"]);
    const lines: string[] = [];
    assert.equal(await benchmarkAaReadinessCommand(["--max-pairs", "0", "--trial-id", "x"], async () => { throw new Error("unreached"); },
      { print: (line) => lines.push(line) }), 2, "a bad bound is refused before the driver runs");
  } finally {
    console.log = savedLog;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("runtime pin refusals leave prospective registration untouched", async () => {
  for (const field of Object.keys(REVISIONS) as Array<keyof typeof REVISIONS>) {
    for (const bad of [undefined, null, false, [], { revision: "not-immutable" },
      { source: "resolved-artifact", revision: OTHER_SHA }, { state: "unavailable", reason: "fixture-pin-unavailable" }]) {
      const stateDir = root();
      const calls: PairedAttemptRequest<string>[] = [];
      const runtime = pins();
      if (field === "harnessRevision") runtime.harnessRevision = bad as never;
      else runtime.revisions[field] = bad as never;
      const result = await runBenchmarkAaReadiness(input(stateDir, calls, { manifest: manifest(), runtimePins: () => runtime }));
      assert.equal(result.state, "refused", `${field}: ${JSON.stringify(bad)}`);
      assert.ok(result.refusals.some(reason => reason.startsWith(`runtime-pin-unknown:${field}:`)
        || reason === `runtime-pin-drift:${field}`), result.refusals.join(","));
      assert.equal(existsSync(join(stateDir, "benchmark-aa-prospective")), false, "a pin refusal must precede the real registration writer");
      assert.equal(calls.length, 0);
      assert.deepEqual(prospectiveAaLedgerRows(stateDir, TRIAL), []);
      assert.deepEqual(listProspectiveAaRegistrations(stateDir), { state: "read", registrations: [] });
    }
  }
  for (const malformed of [undefined, null, {}, { revisions: null }]) {
    const stateDir = root();
    const calls: PairedAttemptRequest<string>[] = [];
    const result = await runBenchmarkAaReadiness(input(stateDir, calls, {
      manifest: manifest(), runtimePins: () => malformed as unknown as RuntimePins,
    }));
    assert.equal(result.state, "refused");
    assert.ok(result.refusals.some(reason => reason.startsWith("runtime-pin-unknown:")));
    assert.equal(existsSync(join(stateDir, "benchmark-aa-prospective")), false);
    assert.equal(calls.length, 0);
  }
});

test("matching revisions with malformed source provenance leave registration untouched", async () => {
  for (const field of Object.keys(REVISIONS) as Array<keyof typeof REVISIONS>) {
    const good = field === "harnessRevision" ? pins().harnessRevision : pins().revisions[field];
    const revision = (good as { revision: string }).revision;
    const wrongSource = field === "harnessRevision" ? "resolved-artifact" : "executing-module-git";
    for (const bad of [{ revision }, { source: "bogus", revision }, { source: 5, revision }, { source: wrongSource, revision },
      [{ source: "bogus", revision }]]) {
      const stateDir = root();
      const calls: PairedAttemptRequest<string>[] = [];
      const runtime = pins();
      if (field === "harnessRevision") runtime.harnessRevision = bad as never;
      else runtime.revisions[field] = bad as never;
      const result = await runBenchmarkAaReadiness(input(stateDir, calls, { manifest: manifest(), runtimePins: () => runtime }));
      assert.equal(result.state, "refused", `${field}: ${JSON.stringify(bad)}`);
      assert.ok(result.refusals.some(reason => reason.startsWith(`runtime-pin-unknown:${field}:pin-source-invalid`)), result.refusals.join(","));
      assert.equal(existsSync(join(stateDir, "benchmark-aa-prospective")), false);
      assert.equal(calls.length, 0);
      assert.deepEqual(listProspectiveAaRegistrations(stateDir), { state: "read", registrations: [] });
    }
  }
});

test("pre-registration pin validation preserves valid registration and registered-owner controls", async () => {
  const stateDir = root();
  const calls: PairedAttemptRequest<string>[] = [];
  const first = await runBenchmarkAaReadiness(input(stateDir, calls, { manifest: manifest(), maxPairs: 1 }));
  assert.equal(first.run.dispatchedPairs, 1);
  assert.equal(calls.length, 2, "the positive control reaches the actual writer and one fake pair");
  const protocolPath = join(prospectiveAaDir(stateDir, TRIAL), "protocol.json");
  const before = readFileSync(protocolPath, "utf8");
  const different = manifest();
  different.stack = { ...STACK, ...REVISIONS, promptRevision: OTHER_SHA };
  await runBenchmarkAaReadiness(input(stateDir, calls, { manifest: different, maxPairs: 1 }));
  assert.equal(readFileSync(protocolPath, "utf8"), before, "a supplied manifest never overwrites the registered owner's protocol");
  const otherRoot = root();
  const sameProtocol = await runProspectiveAa({ action: "register", stateDir: otherRoot, manifest: manifest(),
    clock: fixedClock(Date.parse((JSON.parse(before) as { registeredAt: string }).registeredAt)) });
  assert.ok(sameProtocol.ok, sameProtocol.ok ? "" : sameProtocol.reason);
  const duplicates = await runBenchmarkAaReadiness(input(stateDir, calls, { manifest: manifest(), instanceRoots: [
    { instance: "first", stateDir }, { instance: "other", stateDir: otherRoot },
  ] }));
  assert.ok(duplicates.refusals.includes("trial-registered-in-multiple-roots"));
  assert.equal(readFileSync(protocolPath, "utf8"), before);
});

test("runtime drift after registration still withholds pair dispatch", async () => {
  const stateDir = root();
  const calls: PairedAttemptRequest<string>[] = [];
  let reads = 0;
  const result = await runBenchmarkAaReadiness(input(stateDir, calls, { manifest: manifest(),
    runtimePins: () => ++reads <= 2 ? pins() : pins({ toolRevision: { source: "resolved-artifact", revision: OTHER_SHA } }),
  }));
  assert.equal(existsSync(join(prospectiveAaDir(stateDir, TRIAL), "protocol.json")), true, "registration's valid-pin positive control ran");
  assert.match(result.run.stoppedBy ?? "", /^runtime-pins-drifted-mid-run:runtime-pin-drift:toolRevision/);
  assert.equal(calls.length, 0, "the independently maintained pre-dispatch check still fires after registration");
  assert.equal(result.paidPilot, "not-activated");
  assert.deepEqual(result.holds, { dispatch: false, pr: false, daemon: false });
});

test("registration ordering fails without the pre-registration pin guard", async () => {
  const stateDir = root();
  const calls: PairedAttemptRequest<string>[] = [];
  const refused = await runBenchmarkAaReadiness(input(stateDir, calls, { manifest: manifest(),
    runtimePins: () => pins({ environmentRevision: { source: "resolved-artifact", revision: OTHER_SHA } }),
  }));
  assert.ok(refused.refusals.includes("runtime-pin-drift:environmentRevision"));
  assert.equal(existsSync(join(stateDir, "benchmark-aa-prospective")), false, "removing just the pre-registration guard writes an orphan protocol here");
  const restored = await runBenchmarkAaReadiness(input(stateDir, calls, { manifest: manifest(), maxPairs: 1 }));
  assert.equal(restored.run.dispatchedPairs, 1, "a later qualified call can use the same pristine private root");
  assert.equal(calls.length, 2);
  assert.equal(existsSync(join(prospectiveAaDir(stateDir, TRIAL), "protocol.json")), true);
});

test("registration pin refusals preserve truthful idempotent readiness gaps", async () => {
  const stateDir = root();
  const calls: PairedAttemptRequest<string>[] = [];
  const request = () => input(stateDir, calls, { manifest: manifest(), runtimePins: () => pins({
    scorerRevision: { state: "unavailable", reason: "fixture-runtime-unknown" },
  }) });
  const first = await runBenchmarkAaReadiness(request());
  const second = await runBenchmarkAaReadiness(request());
  assert.equal(first.followUp?.state, "recorded");
  assert.equal(second.followUp?.state, "already-recorded");
  assert.equal(first.nextGap?.kind, "runtime-pin-unknown");
  assert.equal(first.report, null);
  assert.equal(first.receipt.state, "withheld");
  assert.equal(first.paidPilot, "not-activated");
  assert.equal(existsSync(join(stateDir, "benchmark-aa-prospective")), false);
  assert.equal(readFileSync(join(stateDir, READINESS_FOLLOW_UPS_FILE), "utf8").trim().split("\n").length, 1);
  assert.equal(calls.length, 0);
  const invalidRoot = root();
  let pinReads = 0;
  const invalid = await runBenchmarkAaReadiness(input(invalidRoot, calls, { manifest: {}, runtimePins: () => { pinReads++; return pins(); } }));
  assert.ok(invalid.refusals.includes("registration-refused:manifest-version-unsupported"));
  assert.equal(pinReads, 0, "malformed manifests reach the existing parser before their stack is inspected");
  assert.equal(existsSync(join(invalidRoot, "benchmark-aa-prospective")), false);
});

const GAP = { kind: "stage-missing", machineRepairable: true, detail: "stage-missing:a:verified:1" };
const GAP_KEY = `${TRIAL}:${GAP.kind}`;
const REPO = "craigoley/remudero";

function followUpRows(stateDir: string): string[] {
  return readFileSync(join(stateDir, READINESS_FOLLOW_UPS_FILE), "utf8").split("\n").filter((line) => line !== "");
}

function ownerStem(stateDir: string, repo: string | undefined = REPO): string {
  return join(stateDir, `${READINESS_FOLLOW_UPS_FILE}.admissions`, createHash("sha256").update(`${repo ?? ""}\0${GAP_KEY}`).digest("hex").slice(0, 32));
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  assert.ok(child.pid);
  return child.pid;
}

function owner(pid: number, host = hostname(), at = "2026-10-02T09:00:00.000Z") {
  const row = { ts: at, key: GAP_KEY, trialId: TRIAL, gap: GAP, repo: REPO };
  return `${JSON.stringify({ host, pid, nonce: "n-dead", row })}\n`;
}

test("competing calibration gap writers admit one record", async (t) => {
  const stateDir = root();
  const path = join(stateDir, READINESS_FOLLOW_UPS_FILE);
  writeFileSync(path, "");
  const read = fs.readFileSync;
  const outcomes: string[] = [];
  let barrier = 0;
  // Both writers cross the same pre-append barrier: the second runs to completion between the first's read and its claim.
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof read>) => {
    const text = read(...args);
    if (barrier === 0 && typeof args[0] === "number") {
      barrier = 1;
      outcomes.push(recordReadinessGap(stateDir, TRIAL, GAP, "2026-10-02T09:00:01.000Z", REPO)!.state);
      barrier = 2;
    }
    return text;
  });
  syncBuiltinESMExports();
  try {
    outcomes.push(recordReadinessGap(stateDir, TRIAL, GAP, "2026-10-02T09:00:00.000Z", REPO)!.state);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(barrier, 2, "the competing writer ran inside the first writer's read-to-claim window");
  assert.deepEqual(outcomes, ["recorded", "already-recorded"], "the inner writer owned admission; the outer one saw the key it had read as absent");
  assert.equal(followUpRows(stateDir).length, 1, "one canonical row, not two");
  assert.equal((JSON.parse(followUpRows(stateDir)[0]!) as { key: string }).key, GAP_KEY);
  // Sequential positive control: the same writer again reports already-recorded and appends nothing.
  assert.equal(recordReadinessGap(stateDir, TRIAL, GAP, "2026-10-02T09:00:02.000Z", REPO)!.state, "already-recorded");
  assert.equal(followUpRows(stateDir).length, 1);
  // A writer meeting a live owner that has not yet appended gets an explicit pending, not a second row.
  const other = root();
  const append = fs.appendFileSync;
  let during = "";
  t.mock.method(fs, "appendFileSync", (...args: Parameters<typeof append>) => {
    during = recordReadinessGap(other, TRIAL, GAP, "2026-10-02T09:00:03.000Z", REPO)!.state;
    return append(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(recordReadinessGap(other, TRIAL, GAP, "2026-10-02T09:00:00.000Z", REPO)!.state, "recorded");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(during, "pending", "a competitor behind a live owner is told pending");
  assert.equal(followUpRows(other).length, 1);
});

test("a writer that loses the owner-file race yields to the winner and never appends", (t) => {
  const write = fs.writeFileSync;
  const row = { ts: "2026-10-02T09:00:00.000Z", key: GAP_KEY, trialId: TRIAL, gap: GAP, repo: REPO };
  for (const winnerAppended of [false, true]) {
    const stateDir = root();
    const path = join(stateDir, READINESS_FOLLOW_UPS_FILE);
    // The winner publishes generation 0 between the loser's scan (absent) and its link(2).
    t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => {
      if (String(args[0]).endsWith(".tmp")) {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        write(`${ownerStem(stateDir)}.0.owner`, `${JSON.stringify({ host: hostname(), pid: process.pid, nonce: "n-winner", row })}\n`);
        if (winnerAppended) appendFileSync(path, `${JSON.stringify(row)}\n`);
      }
      return write(...args);
    });
    syncBuiltinESMExports();
    let state: string | undefined;
    try {
      state = recordReadinessGap(stateDir, TRIAL, GAP, "2026-10-02T09:00:05.000Z", REPO)?.state;
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(state, winnerAppended ? "already-recorded" : "pending", "the loser reports the winner's outcome explicitly");
    assert.equal(readdirSync(join(stateDir, `${READINESS_FOLLOW_UPS_FILE}.admissions`)).filter((name) => name.endsWith(".tmp")).length, 0, "the loser's temp file is removed");
    assert.equal(existsSync(`${ownerStem(stateDir)}.1.owner`), false, "the winner's live ownership is never taken over");
    assert.equal(winnerAppended ? followUpRows(stateDir).length : readFileSync(path, "utf8").length, winnerAppended ? 1 : 0, "the loser appended nothing");
  }
});

test("an owner-file publish failure other than EEXIST propagates and cleans up", (t) => {
  const stateDir = root();
  t.mock.method(fs, "linkSync", () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => recordReadinessGap(stateDir, TRIAL, GAP, "2026-10-02T09:00:00.000Z", REPO), /denied/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(readdirSync(join(stateDir, `${READINESS_FOLLOW_UPS_FILE}.admissions`)).length, 0, "no owner and no temp file is left behind");
  assert.equal(readFileSync(join(stateDir, READINESS_FOLLOW_UPS_FILE), "utf8"), "", "nothing was recorded");
});

test("interrupted calibration gap admission resumes safely", () => {
  const stateDir = root();
  mkdirSync(join(stateDir, `${READINESS_FOLLOW_UPS_FILE}.admissions`), { recursive: true });
  const dead = owner(deadPid(), hostname(), "2026-10-02T08:30:00.000Z");
  writeFileSync(`${ownerStem(stateDir)}.0.owner`, dead);
  // Owner died after claiming and before appending, leaving a torn trailing line from an earlier crash.
  writeFileSync(join(stateDir, READINESS_FOLLOW_UPS_FILE), '{"key":"torn');
  const resumed = recordReadinessGap(stateDir, TRIAL, GAP, "2026-10-02T09:00:00.000Z", REPO);
  assert.equal(resumed?.state, "recorded", "the unrecorded gap is admitted, not suppressed");
  const rows = followUpRows(stateDir);
  assert.equal(rows[0], '{"key":"torn', "the torn line is kept as evidence");
  assert.equal(rows.length, 2);
  assert.equal((JSON.parse(rows[1]!) as { ts: string }).ts, "2026-10-02T08:30:00.000Z", "the dead owner's own row is the one admitted");
  assert.equal(readFileSync(`${ownerStem(stateDir)}.0.owner`, "utf8"), dead, "the dead owner's file is never deleted");
  assert.equal(existsSync(`${ownerStem(stateDir)}.1.owner`), true, "recovery took a new generation");
  assert.equal(recordReadinessGap(stateDir, TRIAL, GAP, "2026-10-02T09:00:05.000Z", REPO)!.state, "already-recorded", "a second restart does not replay");
  assert.equal(followUpRows(stateDir).length, 2);

  // An owner that died AFTER appending leaves one row; the restart reports it instead of appending again.
  const appended = root();
  mkdirSync(join(appended, `${READINESS_FOLLOW_UPS_FILE}.admissions`), { recursive: true });
  writeFileSync(`${ownerStem(appended)}.0.owner`, dead);
  appendFileSync(join(appended, READINESS_FOLLOW_UPS_FILE), `${JSON.stringify({ ts: "2026-10-02T08:30:00.000Z", key: GAP_KEY, trialId: TRIAL, gap: GAP, repo: REPO })}\n`);
  assert.equal(recordReadinessGap(appended, TRIAL, GAP, "2026-10-02T09:00:00.000Z", REPO)!.state, "already-recorded");
  assert.equal(followUpRows(appended).length, 1);

  // Ownership that may still be live (this process, or another host) is pending and untouched.
  for (const [pid, host] of [[process.pid, hostname()], [deadPid(), "another-host"]] as const) {
    const held = root();
    mkdirSync(join(held, `${READINESS_FOLLOW_UPS_FILE}.admissions`), { recursive: true });
    writeFileSync(`${ownerStem(held)}.0.owner`, owner(pid, host));
    assert.equal(recordReadinessGap(held, TRIAL, GAP, "2026-10-02T09:00:00.000Z", REPO)!.state, "pending");
    assert.equal(followUpRows(held).length, 0, "pending ownership appends nothing");
    assert.equal(existsSync(`${ownerStem(held)}.1.owner`), false, "contested ownership is never taken over");
  }
});

test("calibration gap admission preserves replaced and corrupt evidence", () => {
  const stateDir = root();
  const path = join(stateDir, READINESS_FOLLOW_UPS_FILE);
  // A line that merely mentions the key, an unparseable one, and another repo's row are none of them this repo's canonical record.
  const lookalike = `{"key":"${GAP_KEY}","note":"not canonical"}`;
  const foreign = JSON.stringify({ ts: "2026-10-02T08:00:00.000Z", key: GAP_KEY, trialId: TRIAL, gap: GAP, repo: "someone/else" });
  writeFileSync(path, `${lookalike}\n{"key":"${GAP_KEY}"\n${foreign}\n`);
  const result = recordReadinessGap(stateDir, TRIAL, GAP, "2026-10-02T09:00:00.000Z", REPO);
  assert.equal(result?.state, "recorded");
  assert.equal(result?.unvalidated, 3, "the three uncanonical lines naming the key are reported");
  const rows = followUpRows(stateDir);
  assert.equal(rows.length, 4, "prior corrupt evidence is preserved and one canonical row is added");
  assert.deepEqual(rows.slice(0, 3), [lookalike, `{"key":"${GAP_KEY}"`, foreign]);
  assert.equal((JSON.parse(rows[3]!) as { repo: string }).repo, REPO);
  // An unreadable owner file is explicit pending evidence, never read as free.
  const unreadable = root();
  mkdirSync(join(unreadable, `${READINESS_FOLLOW_UPS_FILE}.admissions`), { recursive: true });
  writeFileSync(`${ownerStem(unreadable)}.0.owner`, "{not json");
  assert.equal(recordReadinessGap(unreadable, TRIAL, GAP, "2026-10-02T09:00:00.000Z", REPO)!.state, "pending");
  assert.equal(readFileSync(`${ownerStem(unreadable)}.0.owner`, "utf8"), "{not json");
  // Without a repo identity the admission is keyed and validated without one.
  const bare = root();
  assert.equal(recordReadinessGap(bare, TRIAL, GAP, "2026-10-02T09:00:00.000Z")!.state, "recorded");
  assert.equal(recordReadinessGap(bare, TRIAL, GAP, "2026-10-02T09:00:01.000Z")!.state, "already-recorded");
  assert.equal(followUpRows(bare).length, 1);
  assert.equal(existsSync(`${ownerStem(bare, "")}.0.owner`), true);
});
