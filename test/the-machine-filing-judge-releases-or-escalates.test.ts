import { operatorReleasePin } from "#src/lib/operator-release.js";
/**
 * Operator ruling 2026-09-29: "There should be an LLM judge in the middle deciding what needs that
 * level of escalation and what can be automated."
 *
 * Every machine filer hard-coded `verify: human`, so 0 of the machine-filed tasks ever dispatched on
 * the record's own authority. These tests pin the four behaviours the ruling asks for: a proceed
 * ruling makes the record dispatchable; an escalate ruling parks it and reaches the inbox; a record
 * edited after judging is judged again; and a judge that fails writes nothing and is asked again.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { GARDENER_ORIGIN_ENV } from "../src/lib/worker-containment.js";

import { fixedClock } from "../src/lib/clock.js";
import { dispatchOrder, runnableCandidates } from "../src/lib/drain.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { costPriority, deterministicEscalation, machineShardHeaderLines, machineShardRisk, renderMachineShard, UNPRICED_PRIORITY } from "../src/lib/machine-filing.js";
import { ciFrictionShardYaml } from "../src/lib/ci-friction-gardener.js";
import { ciLearningShardYaml } from "../src/lib/measurement-cadence.js";
import {
  earnedConfidenceBar,
  familyTrackRecord,
  gardenFamilyRecord,
  isRulingShaped,
  judgeMachineShard,
  MACHINE_JUDGE_STATE_FILE,
  readOperatorReleases,
  readOperatorReleaseRecords,
  recordOperatorRelease,
  machineFamily,
  needsMachineJudgement,
  renderRuledShard,
  runMachineFilingJudge,
  shardRelPath,
  startMachineFilingJudge,
  type MachineJudgePorts,
} from "../src/lib/machine-filing-judge.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import type { Proposal } from "../src/lib/inbox.js";
import { appendLedger, rotateLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { benchmarkNonDispatchSpawn } from "../src/lib/benchmark-run.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult, WorkerSelectionAssignment } from "../src/lib/worker.js";
import { appendOperatorNote } from "../src/lib/operator-notes.js";
import { loadPlan, loadPlanFromYaml, RELEASE_LEDGER_STEP, releasedTaskIds, type Plan } from "../src/lib/plan.js";
import type { RiskJudgeInput, RiskJudgeVerdict } from "../src/lib/risk-judge.js";
import { SELECTOR_SHADOW_MISS_TEST_PATH, selectorShadowMissTask } from "../src/lib/selector-shadow-gardener.js";
import { machineAuthorVerifyViolation, taskRulingPin } from "../src/lib/task-linter.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { approveCommand, daemonCommand, parkedVerifyHumanShards, productionMachineFilingJudgePorts } from "../src/run-task.js";
import { releaseAutomatedShard } from "../src/lib/verify-human-release.js";
import { gitRepo } from "./helpers/git-repo.js";
import { machineJudgeInputsAsync } from "#src/lib/machine-filing-judge.js";

const CLOCK = fixedClock(1790700000000);

test("the production machine judge reads an approved amendment from main while its checkout stays behind", async t => {
  const seed = gitRepo({ kind: "judge-main-plan-seed", scope: t });
  const origin = gitRepo({ bare: true, kind: "judge-main-plan-origin", scope: t });
  const id = "W1-T9068";
  const path = "plan/tasks.d/W1-T9068-x.yaml";
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "[]\n");
  const old = machineShard(id).replace("verify: human", "verify: auto");
  writeFileSync(join(seed.dir, path), old);
  seed.git("add", "-A"); seed.git("commit", "-qm", "original");
  seed.addRemote("origin", origin.dir); seed.git("push", "-q", "origin", "HEAD:main");
  const local = gitRepo({ cloneFrom: origin.dir, kind: "judge-main-plan-local", scope: t });
  const head = local.git("rev-parse", "HEAD");
  const stateDir = join(local.dir, "state"); mkdirSync(stateDir);
  recordOperatorRelease(stateDir, loadPlan(join(local.dir, "plan/tasks.yaml")).byId.get(id)!, CLOCK.iso());
  const before = await machineJudgeInputsAsync(local.dir, stateDir, "origin/main");
  const amended = machineShard(id, { files: ["docs/ci-friction-remedies.md", "docs/approved-companion.md"] });
  writeFileSync(join(seed.dir, path), amended);
  seed.git("add", "-A"); seed.git("commit", "-qm", "approved amendment"); seed.git("push", "-q", "origin", "HEAD:main");
  writeFileSync(join(local.dir, path), old + "# private dirty bytes must survive\n");
  const ports = productionMachineFilingJudgePorts({ repoRoot: local.dir, stateDir,
    worktreesRoot: join(local.dir, "worktrees"), owner: "acme", repo: "remudero", log: () => {}, mainFailures: () => [] });
  const plan = await ports.plan();
  const task = plan.byId.get(id)!;
  assert.equal(task.verify, "human");
  assert.deepEqual(task.files, ["docs/ci-friction-remedies.md", "docs/approved-companion.md"]);
  assert.equal(task.sourcePath, join(local.dir, path));
  recordOperatorRelease(stateDir, task, CLOCK.iso());
  assert.equal(needsMachineJudgement(task, readOperatorReleases(stateDir, plan.tasks)), true);
  assert.notEqual(await machineJudgeInputsAsync(local.dir, stateDir, "origin/main"), before);
  assert.equal(local.git("rev-parse", "HEAD"), head);
  assert.equal(readFileSync(join(local.dir, path), "utf8"), old + "# private dirty bytes must survive\n");
  local.git("remote", "set-url", "origin", join(local.dir, "missing-origin"));
  await assert.rejects(() => Promise.resolve(ports.plan()), /fetch|origin|repository|Git/i);
  assert.equal(readFileSync(join(local.dir, path), "utf8"), old + "# private dirty bytes must survive\n");
});
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const telemetryInput: RiskJudgeInput = { change: { description: "private-prompt-sentinel" },
  gatesState: {}, planContext: { taskId: "W1-T10160" } };
const telemetryVerdict = "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.9\nRISK_REASON: private-result-sentinel";
function telemetryResult(over: Partial<WorkerResult> = {}): WorkerResult {
  return { sessionId: "private-session", costUsd: 0.25, numTurns: 1, text: telemetryVerdict,
    blocks: [], stderr: "private-stderr-sentinel", subtype: "success", isError: false, apiError: false,
    permissionDenials: [], childEnvKeys: ["ANTHROPIC_API_KEY"], provider: "claude", model: "sonnet",
    servedModel: "sonnet", effort: "low", tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false, ...over };
}
function telemetryFixture(t: { after(fn: () => void): void },
  provider: (args: SpawnWorkerArgs, call: number) => Promise<WorkerResult>,
  failLog = false, select = true) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-money-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".remudero"));
  writeFileSync(join(root, ".remudero", "mounts.yaml"), readFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml")));
  const config = { root, claudeBin: "/bin/false" } as Config;
  const path = join(root, "state", "ledger.ndjson");
  let calls = 0;
  const requests: SpawnWorkerArgs[] = [];
  const raw = async (args: SpawnWorkerArgs) => {
    requests.push(args);
    calls++;
    const assignment: WorkerSelectionAssignment = { version: 1, id: `money-assignment-${calls}`, phase: "pre-execution",
      requested: { model: args.model ?? "sonnet", effort: args.effort ?? "low", maxTurns: null },
      selected: { provider: "claude", model: args.model ?? "sonnet", effort: args.effort ?? "low" },
      routing: { mode: "claude-only", policy: { preference: "automatic", reservePercent: 5, provenance: "default" } }, candidates: [] };
    if (select) args.onSelectionAssignment?.(assignment);
    const result = await provider(args, calls);
    if (select) result.selectionAssignmentId ??= assignment.id;
    return result;
  };
  const benchmark = benchmarkNonDispatchSpawn("risk-judge", raw);
  const ports = productionMachineFilingJudgePorts({ repoRoot: root, stateDir: join(root, "state"),
    worktreesRoot: join(root, "wt"), owner: "fixture", repo: "repo", mainFailures: () => [],
    // The real default benchmark and ledger writer run against fixture-owned state. Only the provider is fake.
    spawn: args => benchmark({ ...args, config }),
    log: (step, extra) => { if (failLog) throw new Error("private-log-sentinel");
      appendLedger(path, { run_id: "fixture", task_id: "fixture", step, ...extra }); } });
  return { ports, requests, rows: () => [...readLedgerLines(path)] as unknown as Record<string, unknown>[] };
}

test("W1-T10160: default machine-filing judge emits one owned producer per real attempt", async t => {
  const f = telemetryFixture(t, async (_args, call) => telemetryResult({ costUsd: call / 4 }));
  assert.deepEqual(f.rows(), [], "an unused/cached judge produces no price receipt");
  for (let call = 1; call <= 3; call++) assert.equal((await f.ports.riskJudge(telemetryInput)).verdict, "low");
  const rows = f.rows(), money = rows.filter(r => r.step === "machine_judge.attempt_spend");
  assert.deepEqual(money.map(r => r.total_cost_usd), [0.25, 0.5, 0.75], "no collector can accumulate earlier judgments");
  for (const row of money) {
    assert.equal(row.task_id, "W1-T10160");
    assert.equal(row.provider, "claude");
    assert.equal(row.billing_mode, "api");
    const attempt = rows.find(r => r.step === "worker.attempt" && r.selection_assignment_id === row.selection_assignment_id);
    assert.ok(attempt);
    assert.equal(row.run_id, attempt.run_id);
    assert.equal(row.task_id, attempt.task_id);
  }
  assert.equal(rows.filter(r => r.step === "worker.assignment").length, 3);
  assert.equal(rows.filter(r => r.step === "worker.attempt").length, 3);
  assert.equal(rows.some(r => r.step === "risk_judge.decision"), false);
  assert.doesNotMatch(JSON.stringify(money), /private-prompt|private-result|private-stderr|ANTHROPIC_API_KEY|private-session/);
});

test("W1-T10160: retries failures and missing prices preserve monetary evidence", async t => {
  const f = telemetryFixture(t, async (_args, call) => telemetryResult({ text: call < 3 ? "malformed-private-text" : telemetryVerdict,
    costUsd: call / 4, isError: call === 2, apiError: call === 2 }));
  assert.equal((await f.ports.riskJudge(telemetryInput)).verdict, "low");
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.rows().filter(r => r.step === "machine_judge.attempt_spend").map(r => r.total_cost_usd), [0.25, 0.5, 0.75]);
  for (const [over, price, mode] of [
    [{ costUsd: 0 }, 0, "api"],
    [{ provider: "codex", costUsd: 0, childEnvKeys: [], notionalCostUsd: 1.5 }, undefined, "subscription"],
    [{ subtype: "", costUsd: 0 }, undefined, "unknown"],
    [{ costUsd: Number.NaN }, undefined, "api"],
    [{ costUsd: -1 }, undefined, "api"],
    [{ provider: "cash", costUsd: 0, childEnvKeys: [] }, 0, "api"],
    [{ provider: undefined, childEnvKeys: undefined }, undefined, "unknown"],
  ] as const) {
    const g = telemetryFixture(t, async () => telemetryResult(over as Partial<WorkerResult>));
    await g.ports.riskJudge(telemetryInput);
    const row = g.rows().find(r => r.step === "machine_judge.attempt_spend");
    assert.ok(row);
    assert.equal(row.total_cost_usd, price);
    assert.equal(row.billing_mode, mode);
    assert.equal(row.price_state, price === undefined ? "unknown" : "reported");
    if ("provider" in over && over.provider === "codex") assert.equal(row.notional_cost_usd, 1.5);
  }
  const thrown = new Error("private-provider-failure");
  const g = telemetryFixture(t, async () => { throw thrown; });
  await assert.rejects(g.ports.riskJudge(telemetryInput), e => e === thrown);
  const row = g.rows().find(r => r.step === "machine_judge.attempt_spend");
  assert.ok(row);
  assert.equal(row.total_cost_usd, undefined);
  assert.equal(row.price_state, "unknown");
  assert.equal(row.attempt_state, "failed");
  assert.doesNotMatch(JSON.stringify(row), /private-provider-failure/);
  const unstarted = telemetryFixture(t, async () => { throw thrown; }, false, false);
  await assert.rejects(unstarted.ports.riskJudge(telemetryInput), e => e === thrown);
  const absent = unstarted.rows().find(r => r.step === "machine_judge.attempt_spend");
  assert.equal(absent?.attempt_state, "not-started");
  assert.equal(absent?.price_state, "unknown");
  assert.equal(absent?.total_cost_usd, undefined);
  const interrupted = telemetryFixture(t, async () => telemetryResult({ isError: true,
    subtype: "interrupted", exit: { kind: "signal", signal: "SIGTERM" } }));
  assert.equal((await interrupted.ports.riskJudge(telemetryInput)).verdict, "low");
  assert.equal(interrupted.rows().find(r => r.step === "machine_judge.attempt_spend")?.total_cost_usd, 0.25);
  const exhausted = telemetryFixture(t, async () => telemetryResult({ text: "malformed" }));
  assert.equal((await exhausted.ports.riskJudge(telemetryInput)).availability, "unavailable");
  assert.equal(exhausted.rows().filter(r => r.step === "machine_judge.attempt_spend").length, 3);
  for (const terminalThrows of [false, true]) {
    const fallback = telemetryFixture(t, async (args, call) => {
      const id = `money-assignment-${call}`;
      args.onModelFallbackAttempt?.({ selectionAssignmentId: id, model: "sonnet", reason: "draft-contract", result: telemetryResult({ costUsd: 0.125 }) });
      if (terminalThrows) throw thrown;
      args.onSelectionAssignment?.({ id: "money-fallback-success", requested: { model: "sonnet", effort: "low" },
        selected: { provider: "claude", model: "sonnet", effort: "low" } } as WorkerSelectionAssignment);
      return telemetryResult({ selectionAssignmentId: "money-fallback-success" });
    });
    if (terminalThrows) await assert.rejects(fallback.ports.riskJudge(telemetryInput), e => e === thrown);
    else assert.equal((await fallback.ports.riskJudge(telemetryInput)).verdict, "low");
    assert.deepEqual(fallback.rows().filter(r => r.step === "machine_judge.attempt_spend").map(r => r.total_cost_usd), terminalThrows ? [0.125] : [0.125, 0.25]);
  }
});

test("W1-T10160: missing fallback IDs cannot restate one paid result", async t => {
  for (const select of [false, true]) await t.test(select ? "assignment observed but fallback ID absent" : "all assignment IDs absent", async t => {
    const result = telemetryResult();
    const f = telemetryFixture(t, async args => {
      args.onModelFallbackAttempt?.({ model: "sonnet", reason: "draft-contract", result });
      return result;
    }, false, select);
    for (let judgment = 1; judgment <= 2; judgment++) {
      assert.equal((await f.ports.riskJudge(telemetryInput)).verdict, "low");
      const money = f.rows().filter(r => r.step === "machine_judge.attempt_spend");
      assert.deepEqual(money.map(r => r.total_cost_usd), Array(judgment).fill(0.25), "callback and final return of one paid object are one producer per actual spawn");
      assert.equal(f.requests.length, judgment);
      if (select) assert.equal((f.rows().filter(r => r.step === "worker.assignment").at(-1)!.worker_assignment as WorkerSelectionAssignment).id, `money-assignment-${judgment}`);
      assert.equal(money.at(-1)!.selection_assignment_id, undefined);
      assert.equal(money.at(-1)!.selection_assignment_unavailable_reason, "assignment-not-observed", "do not infer a missing callback identity from an earlier assignment");
      // Each raw spawn below intentionally returns the same provider object. Its next actual
      // invocation is still another paid attempt, even when the previous call carried an ID.
      delete result.selectionAssignmentId;
    }
  });
  await t.test("distinct missing-ID attempt results retain both measured costs", async t => {
    const f = telemetryFixture(t, async args => {
      args.onModelFallbackAttempt?.({ model: "sonnet", reason: "draft-contract", result: telemetryResult() });
      return telemetryResult();
    }, false, false);
    assert.equal((await f.ports.riskJudge(telemetryInput)).verdict, "low");
    assert.deepEqual(f.rows().filter(r => r.step === "machine_judge.attempt_spend").map(r => r.total_cost_usd), [0.25, 0.25], "equal prices are not an identity; distinct results still own their own costs");
    assert.equal(f.requests.length, 1);
  });
});

test("W1-T10160: price telemetry cannot alter a ruling or spawn policy", async t => {
  const results = [telemetryResult({ text: "malformed" }), telemetryResult()];
  const good = telemetryFixture(t, async (_args, call) => results[call - 1]!);
  const broken = telemetryFixture(t, async (_args, call) => results[call - 1]!, true);
  assert.deepEqual(await good.ports.riskJudge(telemetryInput), await broken.ports.riskJudge(telemetryInput));
  for (const f of [good, broken]) {
    assert.equal(f.requests.length, 2);
    const [first, second] = f.requests;
    assert.equal(first!.prompt, second!.prompt);
    assert.equal(first!.model, "sonnet");
    assert.deepEqual(first!.tools, []);
    assert.equal(first!.permissionMode, "bypassPermissions");
    assert.equal(first!.workerClass, second!.workerClass);
  }
  const malformed = telemetryFixture(t, async () => ({ ...telemetryResult(),
    get tokens(): never { throw new Error("private-resource-sentinel"); } }));
  assert.equal((await malformed.ports.riskJudge(telemetryInput)).verdict, "low");
});

test("W1-T10160: default gardener capture joins machine-judge cost without double counting", async t => {
  const repository = "fixture/repo", at = new Date().toISOString();
  const passId = "12345678-1234-4123-8123-123456789abc";
  const parent = { ts: at, step: "garden.lifecycle", name: "config", passId, repository,
    daemon_run_id: "daemon-1", phase: "completed", exit: 0 };
  const archive = (offset = 0) => `ledger.${new Date(Date.parse(at) + offset).toISOString().replace(/[:.]/g, "-")}.ndjson`;
  const runtime = () => ({ version: 1, repository, daemonRunId: "daemon-1", codeSha: null, configuredAt: at, observedAt: at,
    gardens: [{ name: "config", enabled: true, scope: "repository", cadenceMs: 1000, phase: "scheduled", observedAt: at,
      passId: null, nextDueAt: null, queueMs: null, executionMs: null, exit: null, reason: null,
      attempts: 1, completions: 1, failures: 0, lastCompletedAt: null, lastSuccessAt: null, lastFailureAt: null }] });
  const loadSpend = () => import("../src/lib/gardener-spend.js");
  const captured = async (fixture: typeof t, rows: Record<string, unknown>[]) => {
    const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-money-control-`));
    fixture.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "gardener-runtime.json"), JSON.stringify(runtime()));
    writeFileSync(join(dir, "ledger.ndjson"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const { captureGardenerSpendSource, foldGardenerSpend } = await loadSpend();
    return { spend: foldGardenerSpend(await captureGardenerSpendSource(dir), repository, new Date().toISOString()) };
  };
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-money-default-join-`)), dir = join(root, "state"), path = join(dir, "ledger.ndjson");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prior = process.env[GARDENER_ORIGIN_ENV];
  process.env[GARDENER_ORIGIN_ENV] = JSON.stringify({ version: 1, name: "config", passId });
  t.after(() => { if (prior === undefined) delete process.env[GARDENER_ORIGIN_ENV]; else process.env[GARDENER_ORIGIN_ENV] = prior; });
  mkdirSync(dir);
  mkdirSync(join(root, ".remudero"));
  writeFileSync(join(root, ".remudero", "mounts.yaml"), readFileSync(new URL("../.remudero/mounts.yaml", import.meta.url)));
  const inventory = runtime();
  Object.assign(inventory.gardens[0]!, { attempts: 1, completions: 1 });
  writeFileSync(join(dir, "gardener-runtime.json"), JSON.stringify(inventory));
  let calls = 0;
  const spawn = benchmarkNonDispatchSpawn("risk-judge", async args => {
    const id = `private-money-call-${++calls}`;
    args.onSelectionAssignment?.({ version: 1, id, phase: "pre-execution", requested: { model: "sonnet", effort: "low", maxTurns: null },
      selected: { provider: "claude", model: "sonnet", effort: "low" }, candidates: [],
      routing: { mode: "claude-only", policy: { preference: "automatic", reservePercent: 5, provenance: "default" } } } satisfies WorkerSelectionAssignment);
    return { selectionAssignmentId: id, sessionId: "private-session", costUsd: calls === 1 ? 0.25 : calls === 2 ? 0.75 : 0,
      text: "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.9\nRISK_REASON: private-result", numTurns: 1,
      subtype: "success", isError: false, apiError: false, provider: calls === 3 ? "codex" : calls === 4 ? "cash" : "claude",
      model: "sonnet", servedModel: "sonnet", effort: "low", ...(calls === 3 ? { notionalCostUsd: 5 } : {}),
      childEnvKeys: calls === 3 ? [] : ["ANTHROPIC_API_KEY"], tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
      blocks: [], stderr: "", permissionDenials: [], modelUsage: {}, compactionEvents: [], qualitySuspect: false } as WorkerResult;
  });
  const ports = productionMachineFilingJudgePorts({ repoRoot: root, stateDir: dir, worktreesRoot: join(root, "wt"),
    owner: "fixture", repo: "repo", mainFailures: () => [], spawn: args => spawn({ ...args, config: { root } as Config }),
    log: (step, extra) => appendLedger(path, { run_id: "fixture", task_id: "fixture", step, ...extra }) });
  for (let i = 0; i < 2; i++) await ports.riskJudge({ change: { description: "private-prompt" }, gatesState: {}, planContext: { taskId: "W1-T10160" } });
  const { captureGardenerSpendSource, foldGardenerSpend } = await loadSpend();
  const collect = async () => foldGardenerSpend(await captureGardenerSpendSource(dir), repository, new Date().toISOString());
  assert.equal((await collect()).pricedSubtotalUsd, null, "a child cannot invent its parent");
  appendLedger(path, { run_id: "garden-parent", task_id: "MACHINE-JUDGE", ...parent });
  const baseline = await collect();
  assert.equal(baseline.workerCalls?.counts.matched, 2);
  t.diagnostic("positive control: default assignment/attempt capture matched two calls before the monetary assertion");
  assert.equal(baseline.totalUsd, 1);
  assert.deepEqual(baseline.counts, { priced: 2, unpriced: 0, unlinked: 0 });
  const replay = readFileSync(path, "utf8"), rows = [...readLedgerLines(path)] as unknown as Record<string, unknown>[];
  writeFileSync(join(dir, archive() + ".gz"), gzipSync(replay));
  writeFileSync(join(dir, archive(1000)), replay);
  appendLedger(path, { run_id: "terminal", task_id: "W1-T10160", step: "verdict", total_cost_usd: 99 });
  const rotated = await collect();
  assert.equal(rotated.totalUsd, 1, "assignment, attempt, terminal and archive restatements add no dollars");
  assert.equal(rotated.workerCalls?.counts.matched, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(rotated)) <= 65536);
  assert.doesNotMatch(JSON.stringify(rotated), /private-money|private-prompt|private-result|selection_assignment_id/);
  for (const mismatch of [{ passId: "22345678-1234-4123-8123-123456789abc" }, { daemon_run_id: "daemon-2" }, { repository: "wrong/repo" }]) {
    const isolated = await captured(t, rows.map(row => row.step === "garden.lifecycle" ? { ...row, ...mismatch } : row));
    assert.equal(isolated.spend.pricedSubtotalUsd, null);
  }
  const noProducer = await captured(t, rows.filter(row => row.step !== "machine_judge.attempt_spend"));
  assert.equal(noProducer.spend.pricedSubtotalUsd, null, "call coverage alone is not a monetary producer");
  assert.equal(noProducer.spend.workerCalls?.counts.matched, 2);
  writeFileSync(join(dir, "gardener-runtime.json"), JSON.stringify({ ...inventory, daemonRunId: "daemon-2" }));
  assert.equal((await collect()).pricedSubtotalUsd, null, "a new generation cannot infer old parentage");
  writeFileSync(join(dir, "gardener-runtime.json"), JSON.stringify(inventory));
  for (let i = 0; i < 2; i++) await ports.riskJudge({ change: { description: "private-prompt" }, gatesState: {}, planContext: { taskId: "W1-T10160" } });
  const partial = await collect();
  assert.equal(partial.totalUsd, null, "subscription notional cannot close an unknown monetary price");
  assert.equal(partial.pricedSubtotalUsd, 1);
  assert.deepEqual(partial.counts, { priced: 3, unpriced: 1, unlinked: 0 }, "a real reported zero is priced; a Codex placeholder is not");
  assert.equal(partial.workerCalls?.counts.matched, 4);
  assert.deepEqual(partial.workerCalls?.billingModes, { api: 3, subscription: 1, unknown: 0 });
});

function machineShard(id: string, over: { title?: string; files?: string[]; origin?: string } = {}): string {
  const files = over.files ?? ["docs/ci-friction-remedies.md"];
  return [
    `- id: ${id}`,
    `  title: ${JSON.stringify(over.title ?? `record the remedy for ${id}`)}`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    ...machineShardHeaderLines(files),
    `  origin: ${JSON.stringify(over.origin ?? `ci-friction:${id}`)}`,
    "  files:",
    ...files.map((f) => `    - ${f}`),
    "  acceptance:",
    `    - claim: "the remedy for ${id} is recorded"`,
    `      proof: "grep: ${id} in ${files[0]}"`,
    "",
  ].join("\n");
}

function planDir(shards: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-judge-`));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  for (const [name, text] of Object.entries(shards)) writeFileSync(join(root, "plan", "tasks.d", name), text);
  return root;
}

const readPlan = (root: string): Plan => loadPlan(join(root, "plan", "tasks.yaml"));

function verdict(v: "low" | "high", confidence: number, reason = "a docs remedy for a measured gate cost"): RiskJudgeVerdict {
  return { verdict: v, confidence, reasons: [reason] };
}

function ports(root: string, judge: (input: RiskJudgeInput) => Promise<RiskJudgeVerdict>, extra: Partial<MachineJudgePorts> = {}) {
  const proposals: Proposal[] = [];
  const logs: { step: string; extra?: Record<string, unknown> }[] = [];
  const p: MachineJudgePorts = {
    stateDir: root,
    plan: () => readPlan(root),
    riskJudge: judge,
    writeRoot: root,
    stageProposal: (proposal) => void proposals.push(proposal),
    log: (step, e) => void logs.push({ step, extra: e }),
    clock: CLOCK,
    ...extra,
  };
  return { p, proposals, logs };
}

const dispatchable = (plan: Plan): string[] => runnableCandidates(plan, () => false, 50).map((t) => t.id);

test("a machine shard with a proceed ruling dispatches where the unjudged shard parks", async () => {
  const root = planDir({ "W1-T9001-x.yaml": machineShard("W1-T9001") });
  try {
    assert.deepEqual(dispatchable(readPlan(root)), [], "the control: an unjudged machine record is parked");
    const { p } = ports(root, async () => verdict("low", 0.9));
    const report = await runMachineFilingJudge(p);
    assert.deepEqual(report.proceeded, ["W1-T9001"]);
    const task = readPlan(root).byId.get("W1-T9001")!;
    assert.equal(task.verify, "auto");
    assert.equal(task.risk_ruling?.action, "proceed");
    assert.equal(task.risk_ruling?.pin, taskRulingPin(task));
    assert.equal(machineAuthorVerifyViolation(task), undefined, "the pinned ruling clears Law 5's arm");
    assert.deepEqual(dispatchable(readPlan(root)), ["W1-T9001"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an escalate ruling parks the machine shard and reaches the inbox with the judge's reasons", async () => {
  const root = planDir({ "W1-T9002-x.yaml": machineShard("W1-T9002") });
  try {
    const { p, proposals } = ports(root, async () => verdict("high", 0.9, "it rewrites the merge policy"));
    const report = await runMachineFilingJudge(p);
    assert.deepEqual(report.escalated, ["W1-T9002"]);
    const task = readPlan(root).byId.get("W1-T9002")!;
    assert.equal(task.verify, "human");
    assert.equal(task.risk_ruling?.action, "escalate");
    assert.equal(task.risk_ruling?.pin, taskRulingPin(task), "the escalation is pinned so it is not re-asked every pass");
    assert.deepEqual(dispatchable(readPlan(root)), []);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]!.id, "machine-judge:W1-T9002");
    assert.match(proposals[0]!.summary, /it rewrites the merge policy/);
    let asked = 0;
    await runMachineFilingJudge(ports(root, async () => (asked++, verdict("low", 0.9))).p);
    assert.equal(asked, 0, "a pinned escalation stays settled while the record and its evidence are unchanged and no re-ask is due (W1-T8830)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale pin re-judges the machine shard after its record is edited", async () => {
  const root = planDir({ "W1-T9003-x.yaml": machineShard("W1-T9003") });
  try {
    await runMachineFilingJudge(ports(root, async () => verdict("low", 0.9)).p);
    let asked = 0;
    const counting = async () => (asked++, verdict("low", 0.9));
    await runMachineFilingJudge(ports(root, counting).p);
    assert.equal(asked, 0, "the control: a freshly pinned record is not asked again");

    const path = join(root, "plan", "tasks.d", "W1-T9003-x.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace("record the remedy for W1-T9003", "rewrite the lint rule for W1-T9003"));
    const edited = readPlan(root).byId.get("W1-T9003")!;
    assert.ok(needsMachineJudgement(edited), "the edit made the pin stale");
    assert.ok(machineAuthorVerifyViolation(edited), "and the linter refuses the stale ruling");
    const again = await runMachineFilingJudge(ports(root, async () => (asked++, verdict("high", 0.95, "it rewrites a lint rule"))).p);
    assert.equal(asked, 1);
    assert.deepEqual(again.escalated, ["W1-T9003"]);
    const rejudged = readPlan(root).byId.get("W1-T9003")!;
    assert.equal(rejudged.verify, "human");
    assert.equal(rejudged.risk_ruling?.pin, taskRulingPin(rejudged));
    assert.equal((readFileSync(path, "utf8").match(/risk_ruling:/g) ?? []).length, 1, "the old ruling is replaced and not stacked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("judge failure parks the machine shard unchanged and asks again on the next pass", async () => {
  const text = machineShard("W1-T9004");
  const root = planDir({ "W1-T9004-x.yaml": text });
  const path = join(root, "plan", "tasks.d", "W1-T9004-x.yaml");
  try {
    const threw = ports(root, async () => {
      throw new Error("spawn timed out");
    });
    const first = await runMachineFilingJudge(threw.p);
    assert.deepEqual(first.unavailable, ["W1-T9004"]);
    assert.equal(readFileSync(path, "utf8"), text, "nothing is written on a failed judgment");
    assert.match(String(threw.logs.find((l) => l.step === "machine_judge.unavailable")?.extra?.reason), /spawn timed out/);

    const blank = await runMachineFilingJudge(
      ports(root, async () => ({ verdict: "high", availability: "unavailable", confidence: 0, reasons: ["no parseable verdict"] })).p,
    );
    assert.deepEqual(blank.unavailable, ["W1-T9004"], "a verdict-less answer is a failure and never an escalation");
    assert.equal(readFileSync(path, "utf8"), text);
    assert.deepEqual(dispatchable(readPlan(root)), [], "a judge outage never releases anything");

    const healed = await runMachineFilingJudge(ports(root, async () => verdict("low", 0.9)).p);
    assert.deepEqual(healed.proceeded, ["W1-T9004"], "the next pass asks again and the record flows");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("earned autonomy lowers the bar for a family that helps and raises it for one that fails", async () => {
  assert.equal(earnedConfidenceBar(0.7, 0.5), 0.7, "an even record keeps the policy bar");
  assert.ok(earnedConfidenceBar(0.7, 0.8) < 0.7);
  assert.ok(earnedConfidenceBar(0.7, 0.2) > 0.7);

  const shard = (id: string, family: string, tail: string) => machineShard(id, { origin: `${family}:${id}` }) + tail;
  const root = planDir({
    "W1-T9010-x.yaml": shard("W1-T9010", "helps", ""),
    "W1-T9011-x.yaml": shard("W1-T9011", "fails", ""),
    "W1-T9012-x.yaml": shard("W1-T9012", "fails", "").replace("status: queued", "status: blocked\n  retirement: closed"),
    "W1-T9013-x.yaml": shard("W1-T9013", "fails", "").replace("status: queued", "status: blocked\n  retirement: closed"),
    "W1-T9014-x.yaml": shard("W1-T9014", "helps", "").replace("status: queued", "status: merged"),
    "W1-T9015-x.yaml": shard("W1-T9015", "helps", "").replace("status: queued", "status: merged"),
  });
  try {
    const plan = readPlan(root);
    const mergedIds = new Set(["W1-T9014", "W1-T9015"]);
    const merged = (id: string) => mergedIds.has(id);
    assert.equal(machineFamily(plan.byId.get("W1-T9010")!), "helps");
    assert.ok(familyTrackRecord(plan, "helps", merged).mean > 0.5);
    assert.ok(familyTrackRecord(plan, "fails", merged).mean < 0.5);
    const seen: RiskJudgeInput[] = [];
    const report = await runMachineFilingJudge(ports(root,
      async (input) => (seen.push(input), verdict("low", 0.75)), { isMerged: merged }).p);
    assert.deepEqual(report.proceeded, ["W1-T9010"], "the same verdict clears the family that has helped");
    assert.deepEqual(report.escalated, ["W1-T9011"], "and escalates the family that has failed");
    assert.match(String(seen[0]!.planContext.family_track_record), /2 merged/);
    assert.match(String(seen[0]!.gatesState.escalate_only_if), /secrets/);
    assert.match(seen[0]!.change.description, /^OPERATOR ESCALATION RULE:/);
    assert.match(seen[0]!.change.description, /verify: auto/, "judged as it would dispatch and not as parked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a gardener's own Beta credit counts beyond its optimistic prior", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-judge-garden-`));
  try {
    assert.equal(gardenFamilyRecord(dir, "ci-friction"), undefined);
    writeFileSync(join(dir, "ci-friction-gardener.json"), JSON.stringify({ classes: { draft: { alpha: 5, beta: 4 } } }));
    assert.deepEqual(gardenFamilyRecord(dir, "ci-friction"), { alpha: 5, beta: 4 });
    const plan = loadPlanFromYaml("[]\n", "x");
    const record = familyTrackRecord(plan, "ci-friction", () => false, gardenFamilyRecord(dir, "ci-friction"));
    assert.deepEqual([record.alpha, record.beta], [3, 4]);
    writeFileSync(join(dir, "empty-gardener.json"), JSON.stringify({ classes: {} }));
    assert.equal(gardenFamilyRecord(dir, "empty"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a proceed the record cannot honour at verify auto is escalated with the lint reason", async () => {
  const unscoped = machineShard("W1-T9020").replace(/ {2}files:\n {4}- docs\/ci-friction-remedies\.md\n/, "");
  const root = planDir({ "W1-T9020-x.yaml": unscoped });
  try {
    const { p, proposals } = ports(root, async () => verdict("low", 0.95));
    const report = await runMachineFilingJudge(p);
    assert.deepEqual(report.escalated, ["W1-T9020"]);
    assert.match(proposals[0]!.summary, /fails lint \(declared-scope\)/);
    assert.equal(readPlan(root).byId.get("W1-T9020")!.verify, "human");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the rewrite refuses a record that changed since it was judged or is not one record", () => {
  const text = machineShard("W1-T9030");
  const ruling = { verdict: "low", action: "proceed" as const, confidence: 0.9, reasons: ["r"], judgedAt: "2026-09-29T00:00:00.000Z" };
  assert.match(String((renderRuledShard(text, "plan/tasks.d/a.yaml", "not-the-pin", ruling) as { refused: string }).refused), /changed since/);
  assert.match(String((renderRuledShard(text + text, "plan/tasks.d/a.yaml", "x", ruling) as { refused: string }).refused), /exactly one record/);
  const noVerify = text.replace("  verify: human\n", "");
  assert.match(String((renderRuledShard(noVerify, "plan/tasks.d/a.yaml", "x", ruling) as { refused: string }).refused), /no verify: line/);
  const task = loadPlanFromYaml(text, "plan/tasks.d/a.yaml").tasks[0]!;
  const noReasons = renderRuledShard(text, "plan/tasks.d/a.yaml", taskRulingPin({ ...task, verify: "auto" }), { ...ruling, reasons: [] });
  assert.match((noReasons as { contents: string }).contents, /the judge recorded no reason/);
});

test("the filers write an honest risk and leave verify to the judge", () => {
  assert.equal(machineShardRisk(["src/lib/affected-suites.ts"]), "low");
  assert.equal(machineShardRisk([".github/workflows/ci.yml"]), "high");
  assert.equal(machineShardRisk(["src/lib/auth.ts"]), "high");
  assert.ok(machineShardHeaderLines(["plan/policy.yaml"]).includes("  band_meaning: blast-radius"));
  const miss = { runId: 1, headSha: "abc", selection: "narrow" as const, file: "test/x.test.ts" };
  const yaml = selectorShadowMissTask(miss, "W1-T9040");
  assert.match(yaml, /^ {2}risk: low$/m, "a selector edge repair is not high risk");
  assert.match(yaml, /^ {2}verify: human$/m);
});

test("a narrow selector edge shard declares the test that covers its edge, so diff-coverage can pass in scope", () => {
  const miss = { runId: 1, headSha: "abc", selection: "floor" as const, file: "test/prompt-render.test.ts" };
  const task = loadPlanFromYaml(selectorShadowMissTask(miss, "W1-T9041", ["src/run-task.ts"]), "plan/tasks.d/a.yaml").tasks[0]!;
  assert.deepEqual(task.files, ["src/lib/affected-suites.ts", SELECTOR_SHADOW_MISS_TEST_PATH]);
  assert.equal(task.risk, "low", "declaring the test file must not raise the edge repair's risk");
  const proofs = (task.acceptance ?? []).map((a) => a.proof);
  assert.deepEqual(proofs, Array(2).fill("unit test: W1-T9041: the selector covers the recorded suite for every recorded edge"));
  assert.ok(task.note?.includes(`asserts ${miss.file} is selected for each recorded edge`));
  assert.ok(task.note?.includes(SELECTOR_SHADOW_MISS_TEST_PATH));
  assert.match(task.note ?? "", /diff-coverage blocks an edge no test exercises/);
});

test("the verify-human sweep keeps only ruling-shaped records and hands the rest to the machine-filing judge", () => {
  const operator = machineShard("W1-T9050").replace("  author_class: machine\n", "");
  const ruling = machineShard("W1-T9052", { files: ["DECISIONS.md"] }).replace("  author_class: machine\n", "");
  const root = planDir({ "W1-T9050-x.yaml": operator, "W1-T9051-x.yaml": machineShard("W1-T9051"), "W1-T9052-x.yaml": ruling });
  try {
    const plan = readPlan(root);
    assert.deepEqual(parkedVerifyHumanShards(plan, root, CLOCK).map((s) => s.id), ["W1-T9052"]);
    assert.ok(needsMachineJudgement(plan.byId.get("W1-T9050")!), "an operator verify: human record is the judge's");
    assert.equal(needsMachineJudgement(plan.byId.get("W1-T9052")!), false, "a ruling-shaped record stays with the operator");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the production machine judge lands one plan PR and waits on it before asking again", async () => {
  const seed = gitRepo({ kind: "machine-judge-seed" });
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed.dir, ".remudero"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(join(seed.dir, "plan", "policy.yaml"), readFileSync(join(REPO_ROOT, "plan", "policy.yaml"), "utf8"));
  writeFileSync(join(seed.dir, ".remudero", "mounts.yaml"), readFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), "utf8"));
  writeFileSync(join(seed.dir, "plan", "tasks.d", "W1-T9060-x.yaml"), machineShard("W1-T9060"));
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  const origin = gitRepo({ bare: true, kind: "machine-judge-origin" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "HEAD:main");
  const local = gitRepo({ cloneFrom: origin.dir, kind: "machine-judge-local" });
  local.git("config", "user.email", "g@example.invalid");
  local.git("config", "user.name", "g");
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-judge-state-`));
  const worktrees = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-judge-wt-`));
  const calls: string[][] = [];
  let prOpen = true;
  let spawned = 0;
  let spawnedModel: string | undefined;
  try {
    const p = productionMachineFilingJudgePorts({
      repoRoot: local.dir,
      stateDir,
      worktreesRoot: worktrees,
      owner: "acme",
      repo: "remudero",
      log: () => {},
      clock: CLOCK,
      spawn: (async (args: { model?: string }) => {
        spawned += 1;
        spawnedModel = args.model;
        return { text: "RISK_VERDICT: low\nRISK_CONFIDENCE: 0.9\nRISK_REASON: a docs remedy", costUsd: 0, numTurns: 1 };
      }) as never,
      fetcher: ((args: string[]) => {
        calls.push(args);
        if (args.some((a) => a.includes("/pulls/7"))) return { merged: false, state: prOpen ? "open" : "closed" };
        return { html_url: "https://github.com/acme/remudero/pull/7", number: 7 };
      }) as never,
    });
    assert.equal(p.gardenRecord?.("ci-friction"), undefined);
    assert.equal(p.operatorReleases?.().size, 0);
    p.stageProposal({ id: "machine-judge:probe", summary: "probe", evidenceAnchors: [] });
    assert.match(readFileSync(join(stateDir, "inbox-proposals.json"), "utf8"), /machine-judge:probe/);

    const first = await withLiveWritesAllowed(() => runMachineFilingJudge(p));
    assert.equal(spawned, 1, "the real judge construction ran once over this checkout's mounts");
    assert.equal(spawnedModel, "sonnet", "the machine judge runs on its own named mount");
    assert.equal(first.prUrl, "https://github.com/acme/remudero/pull/7");
    const landed = origin.git("show", `machine-judge-garden-${CLOCK.now()}:plan/tasks.d/W1-T9060-x.yaml`);
    assert.match(landed, /^ {2}verify: auto$/m);
    assert.match(landed, /^ {4}action: proceed$/m);
    const state = JSON.parse(readFileSync(join(stateDir, MACHINE_JUDGE_STATE_FILE), "utf8"));
    assert.deepEqual(state.pending.ids, ["W1-T9060"]);

    await runMachineFilingJudge(p);
    assert.equal(spawned, 1, "an open judge PR is waited on and nothing is asked twice");

    prOpen = false;
    const declined = await runMachineFilingJudge(p);
    assert.equal(spawned, 1, "a closed judge PR is a decline and the unchanged record is not re-asked");
    assert.deepEqual(declined.proceeded, []);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
    origin.cleanup();
    seed.cleanup();
    local.cleanup();
  }
});

test("a ruling whose shard is absent from the landing tree is refused and nothing is written", async () => {
  const judged = planDir({ "W1-T9070-x.yaml": machineShard("W1-T9070") });
  const landing = planDir({});
  try {
    const { p, logs } = ports(judged, async () => verdict("low", 0.9), { writeRoot: landing });
    const report = await runMachineFilingJudge(p);
    assert.deepEqual(report.refused, ["W1-T9070"]);
    assert.deepEqual(report.proceeded, []);
    assert.match(String(logs.find((l) => l.step === "machine_judge.refused")?.extra?.reason), /absent from the landing tree/);
  } finally {
    rmSync(judged, { recursive: true, force: true });
    rmSync(landing, { recursive: true, force: true });
  }
});

test("the machine judge runs one pass at a time and logs a failed pass", async () => {
  const root = planDir({ "W1-T9080-x.yaml": machineShard("W1-T9080") });
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let asked = 0;
  const { p } = ports(root, async () => {
    asked += 1;
    await gate;
    return verdict("low", 0.9);
  });
  const judge = startMachineFilingJudge(p, 5);
  try {
    for (let waited = 0; asked === 0 && waited < 5_000; waited += 5) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(asked, 1, "later ticks skip while a pass is still running");
  } finally {
    judge.stop();
    release();
    rmSync(root, { recursive: true, force: true });
  }
  const logs: string[] = [];
  const failing = startMachineFilingJudge(
    { ...ports(root, async () => verdict("low", 0.9)).p, plan: () => { throw new Error("plan unreadable"); }, log: (step) => void logs.push(step) },
    60_000,
  );
  try {
    for (let waited = 0; logs.length === 0 && waited < 5_000; waited += 5) await new Promise((r) => setTimeout(r, 5));
  } finally {
    failing.stop();
  }
  assert.deepEqual(logs, ["machine_judge.failed"]);
});

test("a self-hosting daemon wires the machine judge as its ninth garden", async () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}machine-judge-home-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  let captured: DaemonDeps | undefined;
  try {
    await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      gardenPassesInProcess: true,
      runDaemon: async (_plan, d): Promise<DaemonSummary> => {
        captured = d;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    // plan, gate, test, config, export, ci-friction, selector-shadow, evidence-coverage, then this one.
    const start = captured?.gardens?.[8];
    assert.ok(start, "a ninth garden is wired after the evidence-coverage gardener");
    // Stopped before its first tick, so no judge is spawned against the real plan.
    start!(60 * 60 * 1000).stop();
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a pinned release survives ledger rotation and compaction where a ledger release row is shed", async () => {
  const root = planDir({ "W1-T9090-x.yaml": machineShard("W1-T9090") });
  const ledger = join(root, "ledger.ndjson");
  try {
    const row = (id: string, i: number) =>
      JSON.stringify({ ts: new Date(1790000000000 + i * 1000).toISOString(), run_id: `R${i}`, task_id: id, step: RELEASE_LEDGER_STEP, released: "verify-human", release_pin: readPlan(root).byId.has(id) ? operatorReleasePin(readPlan(root).byId.get(id)!) : undefined });
    const lines = [row("W1-T9090", 0), ...Array.from({ length: 220 }, (_, i) => row(`W1-T8${String(i).padStart(3, "0")}`, i + 1))];
    writeFileSync(ledger, lines.join("\n") + "\n");
    assert.ok(releasedTaskIds(readFileSync(ledger, "utf8").split("\n"), readPlan(root)).has("W1-T9090"), "the control: released by a ledger row");
    assert.equal(rotateLedger(ledger, { ceilingBytes: 1, smoothingWindowMs: 0 }).rotated, true);
    const survivors = releasedTaskIds(readFileSync(ledger, "utf8").split("\n"), readPlan(root));
    assert.equal(survivors.has("W1-T9090"), false, "rotation shed the ledger release");
    assert.deepEqual(runnableCandidates(readPlan(root), () => false, 50, { releasedIds: survivors }).map((t) => t.id), []);

    await runMachineFilingJudge(ports(root, async () => verdict("low", 0.9)).p);
    assert.deepEqual(
      runnableCandidates(readPlan(root), () => false, 50, { releasedIds: survivors }).map((t) => t.id),
      ["W1-T9090"],
      "the pinned ruling releases with no ledger row at all",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the shared filing path renders a whole machine record and names a lint refusal", () => {
  const spec = {
    taskId: "W1-T9095",
    title: "record the remedy for W1-T9095",
    origin: "ci-friction:check:x",
    files: ["docs/ci-friction-remedies.md"],
    acceptance: [{ claim: "the remedy is recorded", proof: "grep: ci-friction:check:x in docs/ci-friction-remedies.md" }],
    note: "priced at 12 PR minutes",
  };
  const ok = renderMachineShard(spec);
  assert.equal(ok.refused, undefined);
  const task = loadPlanFromYaml(ok.text, "a.yaml").tasks[0]!;
  assert.deepEqual([task.verify, task.risk, task.author_class, task.origin], ["human", "low", "machine", "ci-friction:check:x"]);
  assert.match(String(renderMachineShard({ ...spec, acceptance: [{ claim: "c", proof: "no dialect" }] }).refused), /proof/);
  assert.match(String(renderMachineShard({ ...spec, taskId: "not an id: [" }).refused), /unparseable/);
});

type Probe = { id: string; expect: "escalate" | "proceed"; title: string; files: string[]; claims: string[] };
const PROBES = (JSON.parse(readFileSync(join(REPO_ROOT, "test", "fixtures", "machine-judge-probes.json"), "utf8")) as { probes: Probe[] }).probes;

test("the regression eval escalates all six risky probes and passes all four benign ones even under a judge that always proceeds", async () => {
  assert.equal(PROBES.filter((p) => p.expect === "escalate").length, 6);
  assert.equal(PROBES.filter((p) => p.expect === "proceed").length, 4);
  const record = { family: "probe", merged: 0, declined: 0, alpha: 1, beta: 1, mean: 0.5 };
  let asked = 0;
  const lenient = async () => (asked++, verdict("low", 0.99, "looks fine"));
  for (const probe of PROBES) {
    const task = loadPlanFromYaml(machineShard(probe.id, { title: probe.title, files: probe.files }), "p.yaml").tasks[0]!;
    const judged = await judgeMachineShard({ ...task, acceptance: probe.claims.map((claim) => ({ claim, proof: "grep: x in y" })) }, record, {
      riskJudge: lenient,
      policy: { confidenceThreshold: 0.7, verifyHumanReleaseEnabled: true },
      clock: CLOCK,
    });
    assert.equal(judged.kind, "ruled");
    assert.equal(judged.kind === "ruled" && judged.ruling.action, probe.expect, `${probe.id}: ${probe.title}`);
  }
  assert.equal(asked, 4, "the backstop decides the risky six without spending a model call");
});

test("a pass refuses an unreadable state file and a ruling with nowhere to land", async () => {
  const root = planDir({ "W1-T9096-x.yaml": machineShard("W1-T9096") });
  try {
    const noWhere = ports(root, async () => verdict("low", 0.9), { writeRoot: undefined });
    await assert.rejects(runMachineFilingJudge(noWhere.p), /neither a workspace nor a write root/);

    writeFileSync(join(root, MACHINE_JUDGE_STATE_FILE), "null\n");
    await assert.rejects(runMachineFilingJudge(ports(root, async () => verdict("low", 0.9)).p), /invalid state/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the backstop reads what a record will do and never its note", () => {
  assert.match(String(deterministicEscalation({ title: "x", files: ["src/lib/merge-queue.ts"] })), /merge-queue/);
  assert.match(String(deterministicEscalation({ title: "force-push the rebased branch" })), /irreversible/);
  assert.match(String(deterministicEscalation({ title: "x", prompt: "disable the review gate for docs PRs" })), /policy/);
  assert.equal(deterministicEscalation({ title: "record the lesson", acceptance: [{ claim: "a learnings entry exists" }] }), undefined);
});

const operatorShard = (id: string, over: { title?: string; files?: string[] } = {}) =>
  machineShard(id, { ...over, origin: `operator-request#${id}` }).replace("  author_class: machine\n", "");

test("an operator verify human record is released by a proceed ruling and stays parked on an escalation", async () => {
  const root = planDir({
    "W1-T9100-x.yaml": operatorShard("W1-T9100"),
    "W1-T9101-x.yaml": operatorShard("W1-T9101", { title: "purge every archive in state" }),
  });
  try {
    const seen: RiskJudgeInput[] = [];
    const { p, proposals } = ports(root, async (input) => (seen.push(input), verdict("low", 0.9)));
    const report = await runMachineFilingJudge(p);
    assert.deepEqual(report.proceeded, ["W1-T9100"]);
    assert.deepEqual(report.escalated, ["W1-T9101"], "the backstop holds for operator records too");
    const released = readPlan(root).byId.get("W1-T9100")!;
    assert.equal(released.verify, "auto");
    assert.equal(released.risk_ruling?.pin, taskRulingPin(released));
    assert.equal(seen[0]!.gatesState.author_class, "operator");
    assert.match(proposals[0]!.summary, /is your verify: human record/);
    assert.deepEqual(dispatchable(readPlan(root)), ["W1-T9100"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rmd approve becomes a pinned operator ruling that no ledger rotation can shed", async () => {
  const root = planDir({
    "W1-T9110-x.yaml": operatorShard("W1-T9110"),
    "W1-T9111-x.yaml": machineShard("W1-T9111", { title: "prune the stale backups" }),
  });
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), readFileSync(join(root, "plan", "tasks.d", "W1-T9110-x.yaml"), "utf8"));
  rmSync(join(root, "plan", "tasks.d", "W1-T9110-x.yaml"));
  try {
    assert.equal(await approveCommand(["W1-T9110"], { config: { root } as never, clock: CLOCK, planPath: join(root, "plan", "tasks.yaml") }), 0);
    assert.deepEqual([...readOperatorReleases(state, readPlan(root).tasks)], ["W1-T9110"], "the operator's bit is kept outside the ledger");
    // Monolith records are never rewritten, so file the shard where the judge can pin it.
    writeFileSync(join(root, "plan", "tasks.d", "W1-T9110-x.yaml"), readFileSync(join(root, "plan", "tasks.yaml"), "utf8"));
    writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
    const escalated = await runMachineFilingJudge(ports(root, async () => verdict("high", 0.9, "needs him"), { operatorReleases: () => new Map() }).p);
    assert.deepEqual(escalated.escalated.sort(), ["W1-T9110", "W1-T9111"], "the judge and the backstop parked both");

    recordOperatorRelease(state, readPlan(root).byId.get("W1-T9111")!, CLOCK.iso());
    let asked = 0;
    const report = await runMachineFilingJudge(
      ports(root, async () => (asked++, verdict("high", 0.99)), { operatorReleases: () => readOperatorReleaseRecords(state) }).p,
    );
    assert.equal(asked, 0, "an operator release asks no model and no backstop");
    assert.deepEqual(report.proceeded.sort(), ["W1-T9110", "W1-T9111"]);
    const plan = readPlan(root);
    for (const id of ["W1-T9110", "W1-T9111"]) {
      assert.equal(plan.byId.get(id)!.risk_ruling?.verdict, "operator");
      assert.equal(plan.byId.get(id)!.verify, "auto");
    }
    assert.deepEqual(dispatchable(plan).sort(), ["W1-T9110", "W1-T9111"], "released with an empty ledger");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record the rewrite refuses is settled until it changes and not re-judged every pass", async () => {
  // A verify value on its own continuation line is valid YAML the rewrite cannot place (a trailing comment no longer is).
  const text = machineShard("W1-T9120").replace("  verify: human\n", "  verify:\n    human\n");
  const root = planDir({ "W1-T9120-x.yaml": text });
  try {
    let asked = 0;
    const counting = async () => (asked++, verdict("low", 0.9));
    const first = await runMachineFilingJudge(ports(root, counting).p);
    assert.deepEqual(first.refused, ["W1-T9120"]);
    await runMachineFilingJudge(ports(root, counting).p);
    assert.equal(asked, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupt judge state file is refused loudly and a pass with no landing tree throws", async () => {
  const root = planDir({ "W1-T9140-x.yaml": machineShard("W1-T9140") });
  try {
    writeFileSync(join(root, MACHINE_JUDGE_STATE_FILE), "null\n");
    await assert.rejects(runMachineFilingJudge(ports(root, async () => verdict("low", 0.9)).p), /invalid state/);
    rmSync(join(root, MACHINE_JUDGE_STATE_FILE));
    await assert.rejects(
      runMachineFilingJudge(ports(root, async () => verdict("low", 0.9), { writeRoot: undefined }).p),
      /neither a workspace nor a write root/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record with no origin belongs to the unknown family", () => {
  const task = loadPlanFromYaml(machineShard("W1-T9141").replace(/ {2}origin:.*\n/, ""), "a.yaml").tasks[0]!;
  assert.equal(machineFamily(task), "unknown");
});

test("the verify-human release names the reason it releases nothing, and releases only on a clean proceed", async () => {
  const shard = { id: "W1-T9150", title: "t", rationale: "", acceptance: [], ageDays: 1, depsAllMerged: true, citedInSrc: false };
  const automate = { decision: "automate" as const, reason: "mechanical" };
  const task = loadPlanFromYaml(operatorShard("W1-T9150"), "a.yaml").tasks[0]!;
  const written: string[] = [];
  const base = {
    task: () => task,
    riskJudge: async () => verdict("low", 0.99),
    writeRelease: (id: string) => (written.push(id), { code: 0, message: "ok", released: true }),
  };
  const run = (over: Partial<Parameters<typeof releaseAutomatedShard>[2]>) => releaseAutomatedShard(shard, automate, { ...base, ...over });

  const missing = await run({ task: () => undefined });
  assert.deepEqual([missing.kind, (missing as { reason: string }).reason], ["unavailable", "W1-T9150 does not resolve to a plan record"]);
  assert.match((await run({ task: () => ({ ...task, verify: "auto" }) }) as { reason: string }).reason, /not parked/);
  assert.match((await run({ task: () => ({ ...task, status: "merged" }) }) as { reason: string }).reason, /not queued/);
  const threw = await run({ riskJudge: async () => { throw new Error("spawn timed out"); } });
  assert.match((threw as { reason: string }).reason, /the risk judge threw: spawn timed out/);
  const blank = await run({ riskJudge: async () => ({ verdict: "high", availability: "unavailable", confidence: 0, reasons: [] }) });
  assert.equal(blank.kind, "unavailable");
  assert.equal((await run({ riskJudge: async () => verdict("high", 0.95, "it changes merge policy") })).kind, "escalated");
  assert.equal(written.length, 0, "none of the refusals above wrote a release row");

  const refused = await run({ writeRelease: () => ({ code: 1, message: "refused by approve" }) });
  assert.deepEqual([refused.kind, (refused as { reason: string }).reason], ["unavailable", "refused by approve"]);
  const notReleased = await run({ writeRelease: () => ({ code: 0, message: "already released", released: false }) });
  assert.deepEqual([notReleased.kind, (notReleased as { reason: string }).reason], ["escalated", "already released"]);
  assert.equal((await run({})).kind, "released");
  assert.deepEqual(written, ["W1-T9150"]);
});

test("the verify-human release refuses a ruling-shaped record", async () => {
  const task = loadPlanFromYaml(operatorShard("W1-T9130", { files: ["DECISIONS.md"] }), "a.yaml").tasks[0]!;
  assert.ok(isRulingShaped(task));
  const out = await releaseAutomatedShard(
    { id: "W1-T9130", title: task.title, rationale: "", acceptance: [], ageDays: 1, depsAllMerged: true, citedInSrc: false },
    { decision: "automate", reason: "r" },
    { task: () => task, riskJudge: async () => verdict("low", 0.99), writeRelease: () => ({ code: 0, message: "x", released: true }) },
  );
  assert.equal(out.kind, "escalated");
});

test("released work dispatches costliest first and unpriced work mid-queue", async () => {
  const pop = [15, 81, 465];
  assert.ok(costPriority(465, pop) < costPriority(81, pop) && costPriority(81, pop) < costPriority(15, pop), "more cost dispatches sooner");
  assert.equal(costPriority(465, pop), 1);
  assert.equal(costPriority(15, pop), 4);
  assert.equal(costPriority(27), UNPRICED_PRIORITY, "a cost with no peers sits mid-band");
  const reviewer = { cause: { kind: "check", name: "reviewer-unmet" }, minutes: 465.7, rounds: 40, prs: 30 } as never;
  const friction = ciFrictionShardYaml({ price: reviewer, rung: 1, owner: { files: ["src/run-task.ts"], why: [] }, rounds: [] }, "W1-T9200", [reviewer, { minutes: 33.9 } as never]);
  assert.match(friction, new RegExp(`^ {2}priority: ${costPriority(465.7, [465.7, 33.9])}$`, "m"), "ci-friction prices its PR minutes");
  const lesson = ciLearningShardYaml({ findingId: "ci-learning:1:ci-gate", title: "t", gate: "ci-gate", pr: 1, prs: Array.from({ length: 36 }, (_, i) => i + 1), repairFiles: [], dominantRepairFiles: [], author_class: "machine", verify: "human", remedySurface: "learnings/*.yaml" }, "W1-T9201", [36, 10]);
  assert.match(lesson, new RegExp(`^ {2}priority: ${costPriority(36, [36, 10])}$`, "m"), "the CI-learning rung prices its occurrences");

  const root = planDir({
    "W1-T9200-x.yaml": friction,
    "W1-T9202-x.yaml": machineShard("W1-T9202"),
    "W1-T9203-x.yaml": operatorShard("W1-T9203"),
  });
  try {
    await runMachineFilingJudge(ports(root, async () => verdict("low", 0.95)).p);
    const plan = readPlan(root);
    assert.equal(plan.byId.get("W1-T9202")!.priority, UNPRICED_PRIORITY, "a machine release with no cost goes mid-queue");
    assert.equal(plan.byId.get("W1-T9203")!.priority, undefined, "an operator record's priority is his");
    assert.equal(plan.byId.get("W1-T9202")!.risk_ruling?.pin, taskRulingPin(plan.byId.get("W1-T9202")!), "priority is inside the pin");
    assert.deepEqual(dispatchable(plan), ["W1-T9200", "W1-T9202", "W1-T9203"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shardRelPath names a shard by its plan directory and refuses the monolith, a nested path and a non-yaml file", () => {
  assert.equal(shardRelPath({ sourcePath: "/repo/plan/tasks.d/W1-T1-x.yaml" }), "plan/tasks.d/W1-T1-x.yaml");
  assert.equal(shardRelPath({ sourcePath: "plan\\tasks.d\\W1-T1-x.yml" }), "plan/tasks.d/W1-T1-x.yml", "a windows-style label is normalised");
  assert.equal(shardRelPath({ sourcePath: "/repo/docs/tasks.d/W1-T1-x.yaml" }), "docs/tasks.d/W1-T1-x.yaml", "a relocated plan dir is named by the record's own path");
  assert.equal(shardRelPath({ sourcePath: "docs/tasks.d/W1-T1-x.yaml" }), "docs/tasks.d/W1-T1-x.yaml", "a root-relative label keeps its plan dir");
  assert.equal(shardRelPath({ sourcePath: "tasks.d/W1-T1-x.yaml" }), undefined, "a shard dir with no plan dir above it is not a shard");
  assert.equal(shardRelPath({ sourcePath: "/repo/plan/tasks.yaml" }), undefined, "the monolith is never a shard");
  assert.equal(shardRelPath({ sourcePath: "/repo/plan/tasks.d/sub/W1-T1-x.yaml" }), undefined, "a nested path is not a shard");
  assert.equal(shardRelPath({ sourcePath: "/repo/plan/tasks.d/notes.txt" }), undefined, "a non-yaml file is not a shard");
  assert.equal(shardRelPath({}), undefined, "a record with no source is not a shard");
});

/** An operator record at an explicit priority, for the shared-band comparisons below. */
const operatorAt = (id: string, priority: number) =>
  operatorShard(id, { files: [`docs/${id}.md`] }).replace("  verify: human\n", `  verify: auto\n  priority: ${priority}\n`);

test("the costliest released machine task sorts among operator priority-1 work", () => {
  const costs = [465.7, 33.9, 12];
  const top = machineShard("W1-T9400", { files: ["docs/w1-t9400.md"] }).replace("  verify: human\n", `  verify: auto\n  priority: ${costPriority(465.7, costs)}\n`);
  const root = planDir({ "W1-T9400-x.yaml": top, "W1-T9401-x.yaml": operatorAt("W1-T9401", 1), "W1-T9402-x.yaml": operatorAt("W1-T9402", 2) });
  try {
    const order = dispatchOrder(readPlan(root).tasks).map((t) => t.id);
    assert.equal(costPriority(465.7, costs), 1);
    assert.ok(order.indexOf("W1-T9400") < order.indexOf("W1-T9402"), "ahead of operator priority-2 work");
    assert.deepEqual(order.slice(0, 2).sort(), ["W1-T9400", "W1-T9401"], "in the priority-1 tier with the operator's own");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cheap released machine task does not jump ahead of operator priority-1 work", () => {
  const costs = [1880.7, 465.7, 33.9, 12];
  const cheap = machineShard("W1-T9410", { files: ["docs/w1-t9410.md"] }).replace("  verify: human\n", `  verify: auto\n  priority: ${costPriority(12, costs)}\n`);
  const root = planDir({ "W1-T9410-x.yaml": cheap, "W1-T9411-x.yaml": operatorAt("W1-T9411", 1), "W1-T9412-x.yaml": operatorAt("W1-T9412", 4) });
  try {
    const order = dispatchOrder(readPlan(root).tasks).map((t) => t.id);
    assert.ok(costPriority(12, costs) > 1 && costPriority(12, costs) <= 4, "the cheapest stays inside the operator band");
    assert.ok(order.indexOf("W1-T9411") < order.indexOf("W1-T9410"), "operator priority-1 work goes first");
    assert.ok(costPriority(UNPRICED_PRIORITY) <= 4, "and unpriced released work is never pushed out of the band");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T9043: the production ruling reader takes the newest of a ledgered release and an operator note", (t) => {
  const repoRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}unanswered-rulings-`));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const stateDir = join(repoRoot, "state");
  mkdirSync(stateDir);
  const iso = (days: number) => new Date(CLOCK.now() - days * 86_400_000).toISOString();
  const row = (step: string, task_id: string, ts: string) => JSON.stringify({ ts, step, task_id }) + "\n";
  writeFileSync(join(stateDir, "ledger.ndjson"), [
    row("ratify.approved", "W1-T9300", iso(20)),
    row("dispatch.breaker_released", "W1-T9301", iso(25)),
    row("review.posted", "W1-T9303", iso(1)),
  ].join(""));
  for (const [taskId, days] of [["W1-T9300", 22], ["W1-T9301", 3], ["W1-T9302", 9], ["W1-T9302", 4]] as const) {
    assert.ok(appendOperatorNote(repoRoot, { ts: iso(days), taskId, author: "operator", note: `ruled on ${taskId}` }));
  }
  const p = productionMachineFilingJudgePorts({
    repoRoot, stateDir, worktreesRoot: join(repoRoot, "wt"), owner: "acme", repo: "remudero",
    log: () => {}, clock: CLOCK, mainFailures: () => [],
  });
  const ruledAt = p.operatorRulings!();
  assert.equal(ruledAt("W1-T9300"), iso(20), "a ledgered release newer than the note wins");
  assert.equal(ruledAt("W1-T9301"), iso(3), "a note newer than the ledgered release wins");
  assert.equal(ruledAt("W1-T9302"), iso(4), "with no ledgered ruling, the newest note is the ruling");
  assert.equal(ruledAt("W1-T9303"), undefined, "a review is not an operator ruling");
});
