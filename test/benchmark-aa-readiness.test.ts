// test/benchmark-aa-readiness.test.ts — W1-T5341: the fresh prospective calibration driver runs the existing paired
// seam on runtime-derived pins, reconciles registrations across instance roots, freezes its population, resumes without
// replay and reports missingness instead of zeros. Every case runs in rmd- temp state roots with a fake attempt
// dispatcher, a fake grader, injected runtime pins and a fixed clock: nothing spawns a worker, reads a real ledger or spends.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  API_BILLING_REFUSAL, prospectiveAaDir, prospectiveAaLedgerRows, runProspectiveAa, runProspectiveAaPair,
} from "../src/lib/benchmark-aa-prospective.js";
import {
  benchmarkAaReadinessCommand, deriveRuntimePins, READINESS_FOLLOW_UPS_FILE, runBenchmarkAaReadiness,
  type BenchmarkAaReadinessInput, type ReadinessTask, type RuntimePins,
} from "../src/lib/benchmark-aa-readiness.js";
import { clockFromMillisFn, fixedClock } from "../src/lib/clock.js";
import type { PairedAttemptRequest, PairedAttemptResult, PairedGrade } from "../src/lib/paired-trial.js";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { HANDLERS } from "../src/run-task.js";

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
  const clean = deriveRuntimePins({ harnessRevision: harnessPin, installRoot: "/install", git: () => "", readStamp: () => `${SHA}\n` });
  assert.deepEqual(clean.revisions.toolRevision, { source: "resolved-artifact", revision: SHA });
  assert.deepEqual(clean.revisions.environmentRevision, { source: "resolved-artifact", revision: SHA });
  const dirty = deriveRuntimePins({ harnessRevision: harnessPin, installRoot: "/install", git: () => " M settings/worker.json\n", readStamp: () => "unknown" });
  assert.deepEqual(dirty.revisions.toolRevision, { state: "unavailable", reason: "executing-source-not-clean" });
  assert.deepEqual(dirty.revisions.environmentRevision, { state: "unavailable", reason: "artifact-not-resolved" });
  const unpinned = deriveRuntimePins({ harnessRevision: { state: "unavailable", reason: "executing-source-not-clean" }, installRoot: "/install",
    git: () => { throw new Error("git must not run without a harness pin"); }, readStamp: () => undefined });
  assert.deepEqual(unpinned.revisions.promptRevision, { state: "unavailable", reason: "executing-source-not-clean" });
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
  assert.equal(result.followUp?.state, "filed");

  // The frozen population survives a later plan change, and the same gap is not filed twice.
  const later = await runBenchmarkAaReadiness(input(stateDir, calls, { loadPlanTasks: () => planTasks(), dispatcherFor: () => dispatcher(calls), maxPairs: 1 }));
  assert.equal(later.population?.eligible, 3, "eligibility is frozen at the first run");
  assert.equal(later.population?.denominator, TASKS.length);
  assert.equal(later.missingness?.untriggered.count, 0);
  assert.equal(later.nextGap?.kind, "stage-missing");
  assert.equal(later.followUp?.state, "filed");
  const rerun = await runBenchmarkAaReadiness(input(stateDir, calls, { loadPlanTasks: () => planTasks(), dispatcherFor: () => dispatcher(calls) }));
  assert.equal(rerun.run.dispatchedPairs, 0);
  assert.equal(rerun.followUp?.state, "already-filed", "a gap already filed is not filed again");
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
  assert.deepEqual(readdirSync(stateDir).sort(), ["benchmark-aa-prospective", READINESS_FOLLOW_UPS_FILE].sort(),
    "no paid-pilot protocol, hold or control file is written");
  assert.deepEqual(readdirSync(trialDir), ["protocol.json"]);
  assert.equal(result.nextGap?.machineRepairable, false, "api billing is an operator setting, not a machine repair");
  // A subscription run right after proceeds normally: the refusal left nothing behind that blocks work.
  const after = await runBenchmarkAaReadiness(input(stateDir, calls, { maxPairs: 1 }));
  assert.equal(after.run.dispatchedPairs, 1);
  assert.ok(calls.every((call) => call.pin.billing === "subscription"));
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
