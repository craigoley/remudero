import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  CASH_TRIAL_ID,
  DEFAULT_CASH_TRIAL_POLICY,
  cashTrialArmFor,
  cashTrialEligible,
  cashTrialSpawnFields,
  cashTrialStopReason,
  decideCashTrial,
  summarizeCashTrial,
  type CashTrialEvidence,
} from "../src/lib/cash-trial.js";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { GitHub } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { selectOpenWeightModel } from "../src/lib/worker-provider.js";
import { loadMounts, mountsPath } from "../src/lib/mounts.js";
import {
  IMPLEMENT_CASH_TOOLS,
  createClaudeExecutableCache,
  spawnWorker,
  type SpawnWorkerArgs,
  type WorkerResult,
  type WorkerSelectionAssignment,
} from "../src/lib/worker.js";
import { gitWorkTreeAncestor } from "../src/lib/worker-home.js";
import { runTask } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

// Operator ruling 2026-09-24 (DECISIONS.md): a small capped share of the simplest implement work
// runs on a cheap cash model beside a same-class subscription control, tagged trial "cash-simple",
// and stops itself when the cash arm falls below the bar. It re-opens as its failures age out.

const REPO_ROOT = join(import.meta.dirname, "..");
const docsTask = { id: "T-DOCS", type: "implement", risk: "low", files: ["docs/guide.md"] };

test("only low-risk single-file docs or plan implement work is trial work", () => {
  assert.equal(cashTrialEligible(docsTask, "docs"), true);
  assert.equal(cashTrialEligible({ ...docsTask, files: ["plan/tasks.d/x.yaml"] }, "plan-lint"), true);
  assert.equal(cashTrialEligible({ ...docsTask, files: ["docs/a.md", "docs/b.md"] }, "docs"), false, "one file only");
  assert.equal(cashTrialEligible({ ...docsTask, risk: "medium" }, "docs"), false);
  assert.equal(cashTrialEligible({ ...docsTask, files: ["src/a.ts"] }, "src"), false);
  assert.equal(cashTrialEligible({ ...docsTask, type: "recon" }, "docs"), false);
  assert.equal(cashTrialEligible({ ...docsTask, files: undefined }, "docs"), false);
});

test("a task keeps its arm and the share splits the population", () => {
  assert.equal(cashTrialArmFor("W1-T1", 50), cashTrialArmFor("W1-T1", 50));
  assert.equal(cashTrialArmFor("W1-T1", 0), "control");
  assert.equal(cashTrialArmFor("W1-T1", 100), "cash");
  const cash = Array.from({ length: 1000 }, (_, i) => cashTrialArmFor(`W1-T${i}`, 50)).filter((arm) => arm === "cash").length;
  assert.ok(cash > 420 && cash < 580, `an even share lands near half, got ${cash}`);
  assert.deepEqual(DEFAULT_CASH_TRIAL_POLICY.models, ["gpt-oss-120b"], "nano does not take implement work");
});

function tagged(run: string, id: string, arm: string) {
  return { ts: "2026-09-24T01:00:00Z", run_id: run, step: "worker.assignment", worker_assignment: { id, routing: { decision: { trial: CASH_TRIAL_ID, trialArm: arm } } } };
}
const verdict = (run: string, pr: boolean, id?: string, cost?: number, ts = "2026-09-24T02:00:00Z") => ({
  ts,
  run_id: run,
  step: "verdict",
  verdict: pr ? "blocked_ci" : "no_pr",
  ...(pr ? { pr_url: "https://example.test/pull/1" } : {}),
  ...(id ? { selection_assignment_id: id } : {}),
  ...(cost !== undefined ? { cost_usd: cost } : {}),
});

test("the ledger fold counts PRs per arm and today's cash spend", () => {
  const rows = [
    tagged("r1", "a1", "cash"), verdict("r1", true, "a1", 0.2),
    tagged("r2", "a2", "cash"), verdict("r2", false, "a2", 0.3, "2026-09-23T02:00:00Z"),
    tagged("r3", "a3", "control"), verdict("r3", true, "a3", 5),
    tagged("r4", "a4", "held"), verdict("r4", true),
    tagged("r5", "a5", "cash"),
    { ts: "2026-09-24T01:00:00Z", run_id: "r6", step: "worker.assignment", worker_assignment: { id: "a6", routing: { decision: {} } } },
    verdict("r6", true, "a6", 9),
  ];
  assert.deepEqual(summarizeCashTrial(rows, "2026-09-24"), {
    cash: { runs: 2, prs: 1 },
    control: { runs: 1, prs: 0 + 1 },
    spentTodayUsd: 0.2,
  });
});

const evidence = (cash: [number, number], control: [number, number], spent = 0): CashTrialEvidence => ({
  cash: { runs: cash[0], prs: cash[1] },
  control: { runs: control[0], prs: control[1] },
  spentTodayUsd: spent,
});

test("the trial stops on its budget on early failures and on a measured shortfall", () => {
  const policy = DEFAULT_CASH_TRIAL_POLICY;
  assert.equal(cashTrialStopReason(evidence([3, 3], [3, 3]), policy, 25), undefined, "healthy and young: open");
  assert.match(cashTrialStopReason(evidence([1, 1], [0, 0], 2.5), policy, 25)!, /budget spent today/);
  assert.equal(cashTrialStopReason(evidence([4, 0], [0, 0]), policy, 25), undefined, "four failures are within the bar at n=20");
  assert.match(cashTrialStopReason(evidence([5, 0], [0, 0]), policy, 25)!, /5 failed cash runs/);
  assert.equal(cashTrialStopReason(evidence([20, 16], [20, 20]), policy, 25), undefined, "exactly at the bar stays open");
  assert.equal(cashTrialStopReason(evidence([40, 34], [20, 20]), policy, 25), undefined, "past the sample, six failures at 85% are fine");
  assert.match(cashTrialStopReason(evidence([40, 28], [20, 18]), policy, 25)!, /70% is below 0.8 x control 90%/);
  assert.equal(cashTrialStopReason(evidence([40, 28], [20, 16]), { ...policy, minRelativeSuccess: 0.8 }, 25), undefined, "70% clears 0.8 x a 80% control");
  assert.match(cashTrialStopReason(evidence([20, 15], [5, 5]), policy, 25)!, /unmeasured control taken as 100%/);
  assert.equal(cashTrialStopReason(evidence([19, 16], [30, 30]), policy, 25), undefined, "no relative verdict below the minimum sample");
});

function config(over: Record<string, unknown> = {}, cashTrial: Record<string, unknown> = {}): Config {
  return {
    claudeBin: "/bin/true",
    root: "/tmp",
    dailyCapUsd: 25,
    workerProviders: { enabled: ["claude", "cash"], harnessCommitsImplement: true, cashTrial },
    ...over,
  } as Config;
}

test("a trial decision is held with its reason until every precondition holds", () => {
  const base = { task: docsTask, taskClass: "docs", harnessCommits: true, stateDir: "/state", readRows: () => [], today: "2026-09-24" };
  assert.equal(decideCashTrial({ ...base, taskClass: "src", config: config() }), undefined, "not trial work at all");
  assert.match(decideCashTrial({ ...base, config: config({}, { enabled: false }) })!.reason, /enabled is false/);
  assert.match(decideCashTrial({ ...base, config: config({ workerProviders: { enabled: ["claude"] } }) })!.reason, /cash is not an enabled/);
  assert.match(decideCashTrial({ ...base, config: config({ dailyCapUsd: undefined }) })!.reason, /unbounded/);
  assert.match(decideCashTrial({ ...base, harnessCommits: false, config: config() })!.reason, /harnessCommitsImplement/);
  const failing = Array.from({ length: 5 }, (_, i) => [tagged(`f${i}`, `x${i}`, "cash"), verdict(`f${i}`, false)]).flat();
  const stopped = decideCashTrial({ ...base, readRows: () => failing, config: config() });
  assert.equal(stopped?.arm, "held");
  assert.match(stopped!.reason, /failed cash runs/);
  assert.equal(decideCashTrial({ ...base, config: config({}, { sharePercent: 100 }) })?.arm, "cash");
  assert.equal(decideCashTrial({ ...base, config: config({}, { sharePercent: 0 }) })?.arm, "control");
});

test("the trial reads its window from the real ledger union", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-cash-trial-state-"));
  try {
    const failing = Array.from({ length: 5 }, (_, i) => [tagged(`f${i}`, `x${i}`, "cash"), verdict(`f${i}`, false)]).flat();
    writeFileSync(join(stateDir, "ledger.ndjson"), [...failing.map((row) => JSON.stringify(row)), "{torn"].join("\n") + "\n");
    const decision = decideCashTrial({ task: docsTask, taskClass: "docs", config: config(), harnessCommits: true, stateDir });
    assert.equal(decision?.arm, "held", "five failed cash runs on disk stop the trial");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a cash-arm decision moves the spawn onto the trial models and a control keeps its route", () => {
  assert.deepEqual(cashTrialSpawnFields(undefined, IMPLEMENT_CASH_TOOLS, ["gpt-oss-120b"]), {});
  const control = cashTrialSpawnFields({ id: CASH_TRIAL_ID, arm: "control", reason: "r" }, IMPLEMENT_CASH_TOOLS, ["gpt-oss-120b"]);
  assert.deepEqual(control, { routingTrial: { id: CASH_TRIAL_ID, arm: "control", reason: "r" } });
  const cash = cashTrialSpawnFields({ id: CASH_TRIAL_ID, arm: "cash", reason: "r" }, IMPLEMENT_CASH_TOOLS, ["gpt-oss-120b"]);
  assert.equal(cash.mountProvider, "cash");
  assert.deepEqual(cash.tools, [...IMPLEMENT_CASH_TOOLS]);
  assert.deepEqual(cash.routingTrial?.models, ["gpt-oss-120b"]);
});

test("the cash ladder restricted to the trial models never reaches nano", () => {
  const ladder = loadMounts(mountsPath(REPO_ROOT)).capabilities;
  const ready = () => true;
  assert.equal(selectOpenWeightModel(ladder, "sonnet", "high", undefined, { ready }).model, "gpt-5-nano", "the balanced row leads nano");
  assert.equal(selectOpenWeightModel(ladder, "sonnet", "high", undefined, { ready, only: ["gpt-oss-120b"] }).model, "gpt-oss-120b");
  assert.throws(() => selectOpenWeightModel(ladder, "sonnet", "high", undefined, { ready, only: ["nonexistent"] }), /no safe deployment/);
});

// ── Through the real spawn path ─────────────────────────────────────────────────────────────────

function fixtureRoot(prefix: string): string {
  const parent = [tmpdir(), dirname(REPO_ROOT)].find((candidate) => gitWorkTreeAncestor(candidate) === undefined);
  assert.ok(parent, "the test host must provide a scratch parent outside every Git work tree");
  return mkdtempSync(join(parent, prefix));
}

test("a cash-arm spawn records the cash-trial rule and runs the trial model", async () => {
  const root = fixtureRoot("rmd-cash-trial-spawn-");
  try {
    const assignments: WorkerSelectionAssignment[] = [];
    const models: string[] = [];
    await spawnWorker({
      cwd: root,
      permissionMode: "bypassPermissions" as const,
      settingsFile: join(REPO_ROOT, "settings", "worker.json"),
      prompt: "work",
      model: "sonnet",
      effort: "high",
      mountProvider: "cash",
      tools: [...IMPLEMENT_CASH_TOOLS],
      routingTrial: { id: CASH_TRIAL_ID, arm: "cash", reason: "cash arm", models: ["gpt-oss-120b"] },
      config: config({ root }) as never,
      providerRouting: {
        spawnOpenWeight: async (_args, _config, selection) => {
          models.push(selection.model);
          return { provider: "cash", text: "done", isError: false, subtype: "success" } as never;
        },
        writeStatus: () => {},
      },
      onSelectionAssignment: (assignment) => assignments.push(assignment),
      claudeExecutable: { cache: createClaudeExecutableCache(), deps: { env: {}, home: root, exists: () => true, which: () => "/fake", canExecute: () => true, locations: [] } },
    } as SpawnWorkerArgs);
    assert.deepEqual(models, ["gpt-oss-120b"]);
    const decision = assignments.at(-1)?.routing.decision;
    assert.equal(decision?.rule, "cash-trial");
    assert.equal(decision?.trial, CASH_TRIAL_ID);
    assert.equal(decision?.trialArm, "cash");
    assert.equal(decision?.trialReason, "cash arm");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Through the real runTask dispatch ───────────────────────────────────────────────────────────

const OFFLINE_GITHUB: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
const HOLDING_CONTAINMENT = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: `touch ../${token}.txt: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 });
const CLEAN_ISOLATION = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 });

function result(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s", costUsd: 0, numTurns: 0, text: "", blocks: [], stderr: "", subtype: "success", isError: false, apiError: false,
    permissionDenials: [], childEnvKeys: [], model: "default", effort: "default", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {}, compactionEvents: [], qualitySuspect: false, ...over,
  };
}

async function dispatchDocsTask(sharePercent: number): Promise<SpawnWorkerArgs[]> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}cash-trial-root-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, [
    "- id: T-CASH-TRIAL",
    "  title: cash trial dispatch probe",
    "  repo: remudero",
    "  type: implement",
    "  verify: auto",
    "  risk: low",
    "  files: [docs/guide.md]",
    "  origin: architect",
    "  status: queued",
    "",
  ].join("\n"));
  const origin = gitRepo({ bare: true, kind: "cash-trial-origin" });
  const seed = gitRepo({ cloneFrom: origin.dir, kind: "cash-trial-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "origin", "main");
  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "cash-trial-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "cash-trial-test"]);
  const spawnCalls: SpawnWorkerArgs[] = [];
  const spawn = async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
    spawnCalls.push(args);
    return spawnCalls.length === 1
      ? result({ text: "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n" })
      : result({ text: "REPORT\nno PR opened yet\n" });
  };
  try {
    await withLiveWritesAllowed(() =>
      runTask("T-CASH-TRIAL", {
        skipGitSync: true,
        planPath,
        config: { ...config({ root, installRoot: process.cwd() }, { sharePercent }) },
        github: OFFLINE_GITHUB,
        spawn,
        containmentExec: HOLDING_CONTAINMENT,
        isolationExec: CLEAN_ISOLATION,
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return spawnCalls;
}

test("a real runTask dispatch sends a cash-arm docs task to the trial and a control task to its mount", async () => {
  const cash = await dispatchDocsTask(100);
  const implement = cash[1]!;
  assert.equal(implement.mountProvider, "cash");
  assert.deepEqual(implement.tools, [...IMPLEMENT_CASH_TOOLS]);
  assert.deepEqual(implement.routingTrial, { id: CASH_TRIAL_ID, arm: "cash", reason: "cash arm by stable task hash at 100% share", models: ["gpt-oss-120b"] });
  const control = (await dispatchDocsTask(0))[1]!;
  assert.equal(control.mountProvider, undefined, "the control keeps its own mount");
  assert.equal(control.routingTrial?.arm, "control");
});
