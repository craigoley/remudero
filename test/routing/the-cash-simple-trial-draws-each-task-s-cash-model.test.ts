import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  CASH_TRIAL_ID,
  DEFAULT_CASH_TRIAL_POLICY,
  cashTrialArmFor,
  cashTrialEligible,
  cashTrialModelFor,
  cashTrialModels,
  cashTrialPinnedDeployment,
  decideCashTrial,
  readCashTrialReadiness,
  summarizeCashTrialModels,
} from "#src/lib/cash-trial.js";
import type { Config } from "#src/lib/config.js";
import type { ProbeExecResult } from "#src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "#src/lib/isolation.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { GitHub } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { IMPLEMENT_CASH_TOOLS, createClaudeExecutableCache, spawnWorker, type SpawnWorkerArgs, type WorkerResult, type WorkerSelectionAssignment } from "#src/lib/worker.js";
import { gitWorkTreeAncestor } from "#src/lib/worker-home.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { runTask } from "#test/helpers/run-task-test.js";

// The cash arm of the cash-simple trial draws one model per task from the policy's models and the open-weight
// deployments that are paid at a checked price (W1-T10858) and were measured with tools (W1-T10857).

type Row = Record<string, unknown>;
const OSS = "gpt-oss-120b";
const FLASH = "DeepSeek-V4-Flash";
const FLASH41 = "DeepSeek-V4.1-Flash";
const KIMI = "Kimi-K2.6";
const policy = DEFAULT_CASH_TRIAL_POLICY;
const docsTask = { id: "T-DOCS", type: "implement", risk: "low", files: ["docs/guide.md"] };

const invoice = (deployment: string, verdict: Row, day = "2026-11-14", ts = `${day}T23:00:00.000Z`): Row =>
  ({ ts, run_id: "RECONCILE", task_id: `cash-invoice-${day}`, step: "cash.invoice.reconciled", day, deployment, verdict, band: 0.02 });
const reconciled = (deployment: string, day?: string): Row => invoice(deployment, { verdict: "reconciled", meters: [] }, day);
const bakeoff = (candidate: string, over: Row = {}): Row =>
  ({ ts: "2026-11-13T10:00:00.000Z", run_id: "BAKEOFF-1", task_id: "inbox-bakeoff", step: "inbox.bakeoff", candidate, billing: "cash", ...over });

/** The cash arm's models as the dispatch reads them: the real ledger readers over a state directory. */
async function armsFrom(rows: Row[], ready?: (deployment: string) => boolean): Promise<string[]> {
  const ledger = writeLedger(rows);
  try {
    return cashTrialModels(policy, { ...await readCashTrialReadiness(ledger.dir), ...(ready ? { ready } : {}) });
  } finally {
    rmSync(ledger.dir, { recursive: true, force: true });
  }
}

test("W1-T12424 criterion 1: the cash arm is the policy's models plus each ready open-weight deployment with a reconciled invoice and a bake-off with tools", async () => {
  assert.deepEqual(await armsFrom([]), [OSS], "an empty ledger leaves the policy's models");
  assert.deepEqual(await armsFrom([
    reconciled(FLASH), bakeoff(`cash:${FLASH}:off`),
    invoice(FLASH41, { verdict: "diverged", meter: "output", meteredUsd: 1, billedUsd: 2, divergence: 1 }), bakeoff(`cash:${FLASH41}:low`),
    bakeoff(`cash:${KIMI}:off`),
  ]), [OSS, FLASH], "a diverged deployment and one with no verdict are not arms");
  assert.deepEqual(await armsFrom([invoice(KIMI, { verdict: "unreconcilable", reason: "no traffic" }), bakeoff(`cash:${KIMI}:off`)]), [OSS],
    "an unreconcilable deployment is not an arm");
  assert.deepEqual(await armsFrom([reconciled(FLASH, "2026-11-13"), bakeoff(`cash:${FLASH}:off`),
    invoice(FLASH, { verdict: "diverged", meter: "input", meteredUsd: 1, billedUsd: 3, divergence: 2 }, "2026-11-14")]), [OSS],
    "the newest verdict decides, and it is diverged");
  assert.deepEqual(await armsFrom([invoice(FLASH, { verdict: "diverged", meter: "input", meteredUsd: 1, billedUsd: 3, divergence: 2 }, "2026-11-13"),
    reconciled(FLASH, "2026-11-14"), bakeoff(`cash:${FLASH}:off`), reconciled(KIMI), bakeoff(`cash-${KIMI}`)]), [OSS, FLASH, KIMI],
    "a newer reconciled verdict admits the deployment");

  assert.deepEqual(await armsFrom([reconciled(FLASH)]), [OSS], "no bake-off row: not measured, so not an arm");
  assert.deepEqual(await armsFrom([reconciled(FLASH), bakeoff(`cash:${FLASH}:off`),
    bakeoff(`cash:${FLASH}:low`, { ts: "2026-11-14T10:00:00.000Z", status: "capacity_shortfall" })]), [OSS],
    "the newest bake-off row did not run");
  assert.deepEqual(await armsFrom([reconciled(FLASH), bakeoff(`cash-${FLASH}-notools`)]), [OSS], "the newest bake-off row ran without tools");
  assert.deepEqual(await armsFrom([reconciled(FLASH), bakeoff(`cash:${FLASH41}:off`)]), [OSS], "another deployment's bake-off does not count");

  assert.deepEqual(await armsFrom([reconciled(FLASH), bakeoff(`cash:${FLASH}:off`)], () => false), [OSS], "a deployment that is not ready is not an arm");
  assert.deepEqual(await armsFrom([reconciled("claude-haiku-5-5"), bakeoff("cash:claude-haiku-5-5:off")]), [OSS],
    "a Foundry Claude deployment is not open-weight");
  assert.deepEqual(await armsFrom([reconciled(OSS), bakeoff(`cash:${OSS}:off`)]), [OSS], "a policy model is listed once");

  const verdicts = { ok: true, unread: [], newest: new Map([[FLASH, reconciled(FLASH)]]) };
  assert.deepEqual(cashTrialModels(policy, { verdicts, bakeoffRows: [bakeoff(`cash:${FLASH}:off`)], ready: () => true }), [OSS, FLASH]);
  assert.deepEqual(cashTrialModels(policy, { verdicts, bakeoffRows: undefined, ready: () => true }), [OSS], "an unread bake-off history admits none");
  assert.deepEqual(cashTrialModels(policy, { verdicts: { ...verdicts, ok: false }, bakeoffRows: [bakeoff(`cash:${FLASH}:off`)], ready: () => true }),
    [OSS], "unread invoice verdicts admit none");

  const broken = writeLedger([reconciled(FLASH), bakeoff(`cash:${FLASH}:off`)]);
  try {
    writeFileSync(join(broken.dir, "ledger.2026-11-12T01-00-00-000Z.ndjson.gz"), "not gzip");
    const readiness = await readCashTrialReadiness(broken.dir);
    assert.equal(readiness.verdicts.ok, false);
    assert.deepEqual(cashTrialModels(policy, readiness), [OSS], "a ledger rotation that cannot be read admits no open-weight arm");
  } finally {
    rmSync(broken.dir, { recursive: true, force: true });
  }
});

// ── The spawn and the dispatch ──────────────────────────────────────────────────────────────────

function config(over: Record<string, unknown> = {}, cashTrial: Record<string, unknown> = {}): Config {
  return {
    claudeBin: "/bin/true",
    root: "/tmp",
    dailyCapUsd: 25,
    workerProviders: { enabled: ["claude", "cash"], harnessCommitsImplement: true, cashTrial },
    ...over,
  } as Config;
}

/** Every cash deployment a cash-arm spawn weighed for one trial model list: the selected one, then its ladder alternatives. */
async function servedBy(models: string[]): Promise<string[]> {
  const parent = [tmpdir(), dirname(REPO_ROOT)].find((candidate) => gitWorkTreeAncestor(candidate) === undefined);
  assert.ok(parent, "the test host must provide a scratch parent outside every Git work tree");
  const root = mkdtempSync(join(parent, "rmd-cash-trial-draw-"));
  try {
    const tried: string[] = [];
    const assignments: WorkerSelectionAssignment[] = [];
    await spawnWorker({
      cwd: root,
      permissionMode: "bypassPermissions" as const,
      settingsFile: join(REPO_ROOT, "settings", "worker.json"),
      prompt: "work",
      model: "haiku",
      effort: "low",
      mountProvider: "cash",
      tools: [...IMPLEMENT_CASH_TOOLS],
      routingTrial: { id: CASH_TRIAL_ID, arm: "cash", reason: "cash arm", models },
      config: config({ root }) as never,
      providerRouting: {
        spawnOpenWeight: async (_args, _config, selection) => {
          tried.push(selection.model);
          return { provider: "cash", text: "done", isError: false, subtype: "success" } as never;
        },
        writeStatus: () => {},
      },
      onSelectionAssignment: (assignment) => assignments.push(assignment),
      claudeExecutable: { cache: createClaudeExecutableCache(), deps: { env: {}, home: root, exists: () => true, which: () => "/fake", canExecute: () => true, locations: [] } },
    } as SpawnWorkerArgs);
    assert.equal(assignments.length, 1, "one assignment, so no second rung ran");
    const weighed = (assignments[0]!.routing.decision?.considered ?? []).filter((entry) => entry.provider === "cash").map((entry) => entry.model);
    assert.deepEqual(tried, weighed.slice(0, 1), "the selected model is the one that ran");
    return weighed as string[];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const OFFLINE_GITHUB: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
const HOLDING_CONTAINMENT = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: `touch ../${token}.txt: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 });
const CLEAN_ISOLATION = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 });

function workerResult(text: string): WorkerResult {
  return {
    sessionId: "s", costUsd: 0, numTurns: 0, text, blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
    permissionDenials: [], childEnvKeys: [], model: "default", effort: "default", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false,
  };
}

/** One real `runTask` dispatch of a docs task at a 100% cash share, over a seeded ledger. No worker runs. */
async function dispatch(taskId: string, seed: Row[]): Promise<{ implement: SpawnWorkerArgs; decided: Row }> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}cash-trial-draw-root-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, [`- id: ${taskId}`, "  title: cash trial draw probe", "  repo: remudero", "  type: implement", "  verify: auto",
    "  risk: low", "  files: [docs/guide.md]", "  origin: architect", "  status: queued", ""].join("\n"));
  const origin = gitRepo({ bare: true, kind: "cash-trial-draw-origin" });
  const clone = gitRepo({ cloneFrom: origin.dir, kind: "cash-trial-draw-seed" });
  writeFileSync(join(clone.dir, "README.md"), "seed\n");
  clone.git("add", "-A");
  clone.git("commit", "-q", "-m", "seed");
  clone.git("push", "-q", "origin", "main");
  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "cash-trial-draw@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "cash-trial-draw"]);
  mkdirSync(join(root, "state"), { recursive: true });
  const ledger = writeLedger(seed, { dir: join(root, "state") });
  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn = async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
    spawnCalls.push(args);
    return workerResult(spawnCalls.length === 1
      ? "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n" : "REPORT\nno PR opened yet\n");
  };
  try {
    await withLiveWritesAllowed(() =>
      runTask(taskId, {
        skipGitSync: true,
        planPath,
        config: { ...config({ root, installRoot: process.cwd() }, { sharePercent: 100 }) },
        github: OFFLINE_GITHUB,
        spawn,
        containmentExec: HOLDING_CONTAINMENT,
        isolationExec: CLEAN_ISOLATION,
      }),
    );
    const rows = readFileSync(ledger.path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
    return { implement: spawnCalls[1]!, decided: rows.find((row) => row.step === "cash_trial.decided")! };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A task id whose draw over `models` is `model`. */
function taskDrawn(model: string, models: string[]): string {
  for (let i = 0; i < 200; i++) if (cashTrialModelFor(`T-CASH-DRAW-${i}`, models) === model) return `T-CASH-DRAW-${i}`;
  throw new Error(`no task id in 200 draws ${model}`);
}

test("W1-T12424 criterion 2: a cash-arm task draws one model by its task id, and the spawn gets that model alone", async () => {
  const models = [OSS, FLASH, KIMI];
  const draws = Array.from({ length: 600 }, (_, i) => cashTrialModelFor(`W1-T${i}`, models)!);
  for (const model of models) {
    const share = draws.filter((drawn) => drawn === model).length;
    assert.ok(share > 140 && share < 260, `${model} takes about a third of the tasks, got ${share}`);
  }
  for (let i = 0; i < 600; i++) {
    const id = `W1-T${i}`;
    assert.equal(cashTrialModelFor(id, models), draws[i], "every retry of a task draws the same model");
    assert.equal(cashTrialModelFor(id, [KIMI, FLASH, OSS]), draws[i], "the order the models are listed in does not change the draw");
    if (draws[i] !== KIMI) assert.equal(cashTrialModelFor(id, [OSS, FLASH]), draws[i], "a model that leaves moves only its own tasks");
  }
  const cashTasks = Array.from({ length: 600 }, (_, i) => `W1-T${i}`).filter((id) => cashTrialArmFor(id, 50) === "cash");
  const flashOfCash = cashTasks.filter((id) => cashTrialModelFor(id, [OSS, FLASH]) === FLASH).length;
  assert.ok(flashOfCash > cashTasks.length * 0.35 && flashOfCash < cashTasks.length * 0.65,
    `the model draw does not follow the cash draw: ${flashOfCash} of ${cashTasks.length} cash tasks`);
  assert.equal(cashTrialModelFor("W1-T1", []), undefined);

  assert.deepEqual(await servedBy([FLASH]), [FLASH], "a drawn open-weight model is the spawn's only candidate");
  assert.deepEqual(await servedBy([KIMI]), [KIMI]);
  assert.deepEqual(await servedBy([OSS]), [OSS], "a policy model has no fallback to another deployment either");
  assert.equal(cashTrialPinnedDeployment({ id: CASH_TRIAL_ID, arm: "cash", models: [FLASH] }, config()), FLASH);
  assert.equal(cashTrialPinnedDeployment({ id: CASH_TRIAL_ID, arm: "control", models: [FLASH] }, config()), undefined);
  assert.equal(cashTrialPinnedDeployment({ id: "another-trial", arm: "cash", models: [FLASH] }, config()), undefined);
  assert.equal(cashTrialPinnedDeployment(undefined, config()), undefined);

  const seed = [reconciled(FLASH), bakeoff(`cash:${FLASH}:off`)];
  const taskId = taskDrawn(FLASH, [OSS, FLASH]);
  const first = await dispatch(taskId, seed);
  assert.equal(first.implement.mountProvider, "cash");
  assert.deepEqual(first.implement.routingTrial?.models, [FLASH], "the implement spawn gets the one drawn model");
  assert.equal(first.decided.trial, CASH_TRIAL_ID);
  assert.equal(first.decided.model, FLASH, "the decision row names the drawn model");
  assert.deepEqual(first.decided.models, [FLASH, OSS]);
  const retry = await dispatch(taskId, seed);
  assert.deepEqual(retry.implement.routingTrial?.models, [FLASH], "a retry of the task gets the same model");
  const other = await dispatch(taskDrawn(OSS, [OSS, FLASH]), seed);
  assert.deepEqual(other.implement.routingTrial?.models, [OSS]);
});

// ── The summary and the stop rule ───────────────────────────────────────────────────────────────

const DAY = "2026-11-16";
const decidedRow = (run: string, model: string): Row =>
  ({ ts: `${DAY}T01:00:00Z`, run_id: run, step: "cash_trial.decided", trial: CASH_TRIAL_ID, arm: "cash", model });
const assigned = (run: string, id: string, arm: string, served?: string): Row => ({
  ts: `${DAY}T01:01:00Z`, run_id: run, step: "worker.assignment",
  worker_assignment: { id, ...(served ? { selected: { provider: "cash", model: served } } : {}), routing: { decision: { trial: CASH_TRIAL_ID, trialArm: arm } } },
});
const cashCall = (run: string, id: string, usd: number, over: Row = {}): Row =>
  ({ ts: `${DAY}T01:30:00Z`, run_id: run, step: "implement.done", selection_assignment_id: id, provider: "cash", billing_mode: "api", total_cost_usd: usd, ...over });
const verdictRow = (run: string, pr: boolean): Row =>
  ({ ts: `${DAY}T02:00:00Z`, run_id: run, step: "verdict", verdict: pr ? "blocked_ci" : "no_pr", ...(pr ? { pr_url: "https://example.test/pull/1" } : {}) });
const mergedRow = (run: string): Row => ({ ts: `${DAY}T03:00:00Z`, run_id: run, step: "pr.merged", state: "MERGED" });

/** `count` finished runs of one arm, `prs` of them with a PR. A cash run is drawn to and served by `model`. */
function runs(prefix: string, model: string | undefined, count: number, prs: number): Row[] {
  return Array.from({ length: count }, (_, i) => {
    const run = `${prefix}-${i}`;
    return model === undefined
      ? [assigned(run, `${run}-a`, "control"), verdictRow(run, i < prs)]
      : [decidedRow(run, model), assigned(run, `${run}-a`, "cash", model), cashCall(run, `${run}-a`, 0.01), verdictRow(run, i < prs)];
  }).flat();
}

test("W1-T12424 criterion 3: the trial summary counts assignments, PRs, merges and settled dollars per drawn cash model beside the control", () => {
  const rows: Row[] = [
    decidedRow("f1", FLASH), assigned("f1", "f1-a", "cash", FLASH), cashCall("f1", "f1-a", 0.2), verdictRow("f1", true), mergedRow("f1"),
    // A second attempt of the same run, served by another model: a crossover for the drawn model.
    decidedRow("f2", FLASH), assigned("f2", "f2-a", "cash", FLASH), cashCall("f2", "f2-a", 0.1),
    assigned("f2", "f2-b", "cash", OSS), cashCall("f2", "f2-b", 0.05), verdictRow("f2", false),
    decidedRow("o1", OSS), assigned("o1", "o1-a", "cash", OSS), cashCall("o1", "o1-a", 0.3), cashCall("o1", "o1-a", 0.3), verdictRow("o1", true),
    // A cash run from before the draw existed has no drawn model: it counts for the first policy model.
    assigned("o2", "o2-a", "cash"), cashCall("o2", "o2-a", 0.4), verdictRow("o2", true), mergedRow("o2"),
    // Still running: an assignment, no verdict yet.
    decidedRow("o3", OSS), assigned("o3", "o3-a", "cash", OSS),
    assigned("c1", "c1-a", "control"), cashCall("c1", "c1-a", 9, { provider: "claude", billing_mode: "subscription" }), verdictRow("c1", true), mergedRow("c1"),
    assigned("c2", "c2-a", "control"), verdictRow("c2", false),
    assigned("h1", "h1-a", "held"), verdictRow("h1", true),
    { ts: `${DAY}T01:00:00Z`, run_id: "x1", step: "cash_trial.decided", trial: CASH_TRIAL_ID, arm: "control" },
    { ts: `${DAY}T01:00:00Z`, run_id: "x2", step: "worker.assignment", worker_assignment: { id: "x2-a", routing: { decision: {} } } },
    verdictRow("x2", true), mergedRow("x2"),
  ];
  const expected = {
    models: {
      [FLASH]: { runs: 2, prs: 1, assignments: 3, crossovers: 1, merges: 1, settledUsd: 0.35 },
      [OSS]: { runs: 2, prs: 2, assignments: 3, crossovers: 0, merges: 1, settledUsd: 0.7 },
    },
    control: { runs: 2, prs: 1, assignments: 2, crossovers: 0, merges: 1, settledUsd: 0 },
  };
  const summary = summarizeCashTrialModels(rows, OSS);
  assert.deepEqual(summary, expected);
  assert.deepEqual(Object.keys(summary.models), [FLASH, OSS], "the models are in name order");

  // The decision reads the same summary from the real ledger union.
  const ledger = writeLedger(rows);
  try {
    const decision = decideCashTrial({ task: docsTask, taskClass: "docs", config: config({}, { sharePercent: 100 }), harnessCommits: true,
      stateDir: ledger.dir, today: DAY, models: [OSS, FLASH] });
    assert.match(decision!.reason, /no worker-call cost receipt/, "run o3 is still in flight, so the paid arm waits, as before");
    assert.deepEqual(decision?.summary, expected);
  } finally {
    rmSync(ledger.dir, { recursive: true, force: true });
  }
});

test("W1-T12424 criterion 4: the stop rule takes one weak cash model out of the draw and leaves the others and the control", () => {
  const base = { taskClass: "docs", harnessCommits: true, stateDir: "/unused", today: DAY };
  const cashAt100 = config({}, { sharePercent: 100 });
  const flashTask = { ...docsTask, id: taskDrawn(FLASH, [OSS, FLASH]) };
  const ossTask = { ...docsTask, id: taskDrawn(OSS, [OSS, FLASH]) };
  // After minSample runs each: Flash opens a PR on 50%, below 0.8 x the control's 100%. gpt-oss-120b is at 100%.
  const weakFlash = [...runs("f", FLASH, 20, 10), ...runs("o", OSS, 20, 20), ...runs("c", undefined, 20, 20)];
  const decided = decideCashTrial({ ...base, task: flashTask, config: cashAt100, models: [OSS, FLASH], readRows: () => weakFlash });
  assert.equal(decided?.arm, "cash", "one weak model does not stop the trial");
  assert.deepEqual(decided?.models, [OSS], "the weak model leaves the draw");
  assert.match(decided!.stopped![FLASH]!, /cash PR rate 50% is below 0\.8 x control 100%/);
  assert.equal(decided!.stopped![OSS], undefined);
  assert.equal(cashTrialModelFor(flashTask.id, decided!.models!), OSS, "a task drawn to the stopped model draws again over the models left");
  const kept = decideCashTrial({ ...base, task: ossTask, config: cashAt100, models: [OSS, FLASH], readRows: () => weakFlash });
  assert.equal(cashTrialModelFor(ossTask.id, kept!.models!), OSS, "a task on a healthy model keeps it");
  assert.equal(decideCashTrial({ ...base, task: docsTask, config: config({}, { sharePercent: 0 }), models: [OSS, FLASH], readRows: () => weakFlash })?.arm,
    "control", "the control arm goes on");

  // Before the sample is complete, five failures already cannot clear the bar: that model alone leaves.
  const early = [...runs("f", FLASH, 5, 0), ...runs("o", OSS, 5, 5)];
  const young = decideCashTrial({ ...base, task: flashTask, config: cashAt100, models: [OSS, FLASH], readRows: () => early });
  assert.deepEqual(young?.models, [OSS]);
  assert.match(young!.stopped![FLASH]!, /5 failed cash runs/);

  // A healthy model is not stopped by the pooled rate of the cash arm.
  const pooled = [...runs("f", FLASH, 20, 20), ...runs("o", OSS, 20, 8), ...runs("c", undefined, 20, 20)];
  assert.deepEqual(decideCashTrial({ ...base, task: flashTask, config: cashAt100, models: [OSS, FLASH], readRows: () => pooled })?.models, [FLASH]);

  // Every model below the bar: the task is held, with the reason of the model it drew.
  const allWeak = [...runs("f", FLASH, 20, 10), ...runs("o", OSS, 20, 5), ...runs("c", undefined, 20, 20)];
  const held = decideCashTrial({ ...base, task: flashTask, config: cashAt100, models: [OSS, FLASH], readRows: () => allWeak });
  assert.equal(held?.arm, "held");
  assert.match(held!.reason, /cash PR rate 50% is below/);
  assert.deepEqual(Object.keys(held!.stopped!).sort(), [FLASH, OSS]);
  const none = decideCashTrial({ ...base, task: flashTask, config: config({}, { sharePercent: 100, models: [] }), readRows: () => [] });
  assert.equal(none?.arm, "held");
  assert.equal(none?.reason, "the cash trial has no model");
});

test("W1-T12424 criterion 5: the budget, the eligible population and the share are unchanged, and with no reconciled deployment the cash arm is gpt-oss-120b", async () => {
  assert.equal(policy.sharePercent, 50);
  assert.equal(policy.budgetShareOfDailyCap, 0.1);
  assert.deepEqual(policy.models, [OSS]);
  assert.equal(cashTrialEligible(docsTask, "docs"), true);
  assert.equal(cashTrialEligible({ ...docsTask, risk: "medium" }, "docs"), false);
  assert.equal(cashTrialEligible({ ...docsTask, files: ["src/a.ts"] }, "src"), false);
  const cash = Array.from({ length: 1000 }, (_, i) => cashTrialArmFor(`W1-T${i}`, 50)).filter((arm) => arm === "cash").length;
  assert.ok(cash > 420 && cash < 580, `an even share lands near half, got ${cash}`);

  // One budget for the whole cash arm: $2.50 of a $25 cap, whichever models spent it.
  const base = { task: docsTask, taskClass: "docs", harnessCommits: true, stateDir: "/unused", today: DAY, config: config({}, { sharePercent: 100 }) };
  const spent = [decidedRow("f1", FLASH), assigned("f1", "f1-a", "cash", FLASH), cashCall("f1", "f1-a", 1.5),
    decidedRow("o1", OSS), assigned("o1", "o1-a", "cash", OSS), cashCall("o1", "o1-a", 1)];
  const overBudget = decideCashTrial({ ...base, models: [OSS, FLASH], readRows: () => spent });
  assert.equal(overBudget?.arm, "held");
  assert.match(overBudget!.reason, /trial budget spent today \(\$2\.50 of \$2\.50\)/);
  assert.deepEqual(decideCashTrial({ ...base, readRows: () => [] })?.models, [OSS], "with no model list the decision draws from the policy's models");

  assert.equal(cashTrialPinnedDeployment({ id: CASH_TRIAL_ID, arm: "cash", models: [OSS] }, config()), undefined,
    "a policy model stays on its capability row's own selection");
  // No cash.invoice.reconciled row: a bake-off alone admits nothing, and the dispatch is the one main has today.
  const today = await dispatch("T-CASH-TRIAL", [bakeoff(`cash:${FLASH}:off`), bakeoff(`cash:${KIMI}:off`)]);
  assert.equal(today.implement.mountProvider, "cash");
  assert.deepEqual(today.implement.tools, [...IMPLEMENT_CASH_TOOLS]);
  assert.deepEqual(today.implement.routingTrial, { id: CASH_TRIAL_ID, arm: "cash", reason: "cash arm by stable task hash at 100% share", models: [OSS] });
  assert.equal(today.decided.model, OSS);
  assert.deepEqual(today.decided.models, [OSS]);
});
