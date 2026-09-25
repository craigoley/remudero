import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Config } from "../src/lib/config.js";
import { acquireInflightLock } from "../src/lib/inflight-lock.js";
import type { Plan } from "../src/lib/plan.js";
import {
  DEFAULT_SWEEP_POLICY,
  RATIFIED_BASELINE_RATCHET_REPAIRS,
  readBaselineRatchetWorktreeState,
  recordableRatchetRepairFor,
  ratifiedBaselineRatchetRepairFor,
  runSweep,
  type BaselineRatchetWorktreeState,
  type BuildSweepEffectsDeps,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { buildSweepEffects as buildEntrypointSweepEffects } from "../src/run-task.js";

const HEAD = "a".repeat(40);
const MOVED_HEAD = "b".repeat(40);
const BRANCH = "run-W1-T4004-1790075494125";

function ratchetPr(overrides: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 4004,
    prUrl: "https://github.com/craigoley/remudero/pull/4004",
    taskId: "W1-T4004",
    headSha: HEAD,
    headRefName: BRANCH,
    reviewState: "failure",
    checksState: "red",
    mergeState: "clean",
    mergeable: true,
    redRequiredChecks: ["comment-load-ratchet"],
    ciFailures: [{ name: "comment-load-ratchet", logTail: "record the baseline" }],
    unmetCriteria: [],
    ...overrides,
  } as OpenPrView;
}

interface ExecutorCalls {
  generators: string[];
  pushes: Array<{ expectedHeadSha?: string }>;
  commits: number;
  removed: string[];
  ghReads: number;
  logs: Array<{ step: string; extra: Record<string, unknown> | undefined }>;
}

interface ExecutorOptions {
  liveHead?: string;
  liveBranch?: string;
  missingLiveHead?: boolean;
  missingLiveBranch?: boolean;
  ghError?: Error;
  registeredOwner?: string;
  registeredOwnerError?: Error;
  fixBranchClaimError?: Error;
  statuses?: Record<string, number>;
  states?: Array<BaselineRatchetWorktreeState | undefined>;
  packageScripts?: Readonly<Record<string, string>>;
  commitResult?: { changed?: boolean; sha?: string };
  createWorktreeError?: Error;
  pushError?: Error;
  removeWorktreeError?: Error;
}

function buildProductionExecutor(root: string, options: ExecutorOptions = {}) {
  mkdirSync(join(root, "state", "inflight"), { recursive: true });
  const calls: ExecutorCalls = { generators: [], pushes: [], commits: 0, removed: [], ghReads: 0, logs: [] };
  const task = {
    id: "W1-T4004",
    title: "ratified baseline executor",
    risk: "high",
    acceptance: [],
    files: [],
    status: "queued",
  };
  const states = [...(options.states ?? [
    { headSha: HEAD, changedPaths: [] },
    { headSha: HEAD, changedPaths: ["scripts/comment-load-baseline.json"] },
  ])];
  const deps: BuildSweepEffectsDeps = {
    owner: "craigoley",
    repo: "remudero",
    repoRoot: process.cwd(),
    localRepoName: "remudero",
    config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(root, "state", "ledger.ndjson"),
    runId: "SWEEP-W1-T4004",
    plan: { tasks: [task], byId: new Map([[task.id, task]]) } as unknown as Plan,
    log: (step, extra) => { calls.logs.push({ step, extra }); },
    policy: DEFAULT_SWEEP_POLICY,
    nowMsImpl: () => 1_790_075_494_125,
    reviewRunner: async () => 0,
    issuesImpl: { create: () => "https://github.com/craigoley/remudero/issues/4004" },
    ghJsonImpl: (args) => {
      calls.ghReads++;
      assert.deepEqual(args, ["pr", "view", ratchetPr().prUrl, "--json", "headRefName,headRefOid,body"]);
      if (options.ghError) throw options.ghError;
      return {
        ...(options.missingLiveBranch ? {} : { headRefName: options.liveBranch ?? BRANCH }),
        ...(options.missingLiveHead ? {} : { headRefOid: options.liveHead ?? HEAD }),
        body: "Remudero-Task: W1-T4004\n",
      };
    },
    registeredWorktreeOwnerImpl: () => {
      if (options.registeredOwnerError) throw options.registeredOwnerError;
      return options.registeredOwner;
    },
    fixBranchClaimKeyImpl: () => {
      if (options.fixBranchClaimError) throw options.fixBranchClaimError;
      return "W1-T4004-ratchet-claim";
    },
    createFixRungWorktreeImpl: () => {
      if (options.createWorktreeError) throw options.createWorktreeError;
    },
    readBaselineRatchetWorktreeStateImpl: () => states.shift(),
    readPackageScriptsImpl: () => options.packageScripts ?? ({
      "comment-load-ratchet": "node scripts/comment-load-ratchet.mjs",
      "comment-load-signal": "node scripts/comment-load-ratchet.mjs --no-record",
      "source-size-baseline:legacy": "node scripts/source-size-ratchet.mjs --baseline scripts/source-size-baseline.json",
      "source-size-signal": "node scripts/source-size-ratchet.mjs",
    }),
    runNpmScriptImpl: (script: string) => {
      calls.generators.push(script);
      return { status: options.statuses?.[script] ?? 0, stdout: "", stderr: "" };
    },
    commitGeneratorOutputImpl: () => {
      calls.commits++;
      return options.commitResult ?? { changed: true, sha: "c".repeat(40) };
    },
    gitPushRunBranchImpl: (_worktree: string, opts = {}) => {
      calls.pushes.push(opts);
      if (options.pushError) throw options.pushError;
    },
    worktreeRemoveImpl: (_repo: string, path: string) => {
      calls.removed.push(path);
      if (options.removeWorktreeError) throw options.removeWorktreeError;
    },
  };
  // This is the entrypoint builder the daemon calls, not a test-only hand-built SweepDeps object.
  return { effects: buildEntrypointSweepEffects(deps), calls, ledgerPath: deps.ledgerPath };
}

function declineReason(calls: ExecutorCalls): unknown {
  return calls.logs.find(({ step }) => step === "sweep.ratchet_repair_executor_declined")?.extra?.reason;
}

function sweepDeps(root: string, repairRecordableRatchet: NonNullable<SweepDeps["repairRecordableRatchet"]>) {
  const fixed: number[] = [];
  const deps: SweepDeps = {
    ledgerPath: join(root, "state", "ledger.ndjson"),
    runId: "SWEEP-W1-T4004",
    now: () => 1_790_075_494_125,
    arm: () => {},
    close: () => {},
    dispatchFix: (pr) => { fixed.push(pr.prNumber); },
    escalate: () => {},
    repairRecordableRatchet,
  };
  return { deps, fixed };
}

test("W1-T4004: production executor repairs an admitted baseline without dispatching a worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4004-success-"));
  try {
    const { effects, calls } = buildProductionExecutor(root);
    const { deps, fixed } = sweepDeps(root, effects.repairRecordableRatchet!);
    await runSweep([ratchetPr()], deps, { ...DEFAULT_SWEEP_POLICY, recordableRatchetRepairEnabled: true });

    assert.deepEqual(calls.generators, ["comment-load-ratchet", "comment-load-signal"]);
    assert.equal(calls.commits, 1, "the existing generator-commit helper owns the one commit");
    assert.deepEqual(calls.pushes, [{ stdio: "ignore", expectedHeadSha: "c".repeat(40) }]);
    assert.deepEqual(fixed, [], "a successful deterministic repair must prevent an LLM fix dispatch");
    assert.equal(calls.removed.length, 1, "the established fix worktree is always released");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4004: production executor records both ratified baselines in one guarded repair", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4004-both-"));
  try {
    const { effects, calls } = buildProductionExecutor(root, {
      states: [
        { headSha: HEAD, changedPaths: [] },
        { headSha: HEAD, changedPaths: ["scripts/comment-load-baseline.json", "scripts/source-size-baseline.json"] },
      ],
    });
    const pr = ratchetPr({
      redRequiredChecks: ["comment-load-ratchet", "source-size-baseline:legacy"],
      ciFailures: [
        { name: "comment-load-ratchet", logTail: "record the baseline" },
        { name: "source-size-baseline:legacy", logTail: "record the baseline" },
      ],
    });

    assert.equal(await effects.repairRecordableRatchet!(pr, ratifiedBaselineRatchetRepairFor(pr)!), true);
    assert.deepEqual(calls.generators, [
      "comment-load-ratchet",
      "comment-load-signal",
      "source-size-baseline:legacy",
      "source-size-signal",
    ]);
    assert.equal(calls.commits, 1);
    assert.deepEqual(calls.pushes, [{ stdio: "ignore", expectedHeadSha: "c".repeat(40) }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4004: baseline repair admission is independent from conflict regeneration", () => {
  assert.deepEqual(Object.keys(RATIFIED_BASELINE_RATCHET_REPAIRS).sort(), ["comment-load-ratchet", "source-size-baseline:legacy"]);
  const nonBaseline = ratchetPr({
    redRequiredChecks: ["docs-index"],
    ciFailures: [{ name: "docs-index", logTail: "generator" }],
  });
  assert.deepEqual(recordableRatchetRepairFor(nonBaseline), ["docs-index"], "the broader conflict registry still recognizes its own member");
  assert.equal(ratifiedBaselineRatchetRepairFor(nonBaseline), undefined, "that membership grants no unattended baseline-write authority");
});

test("W1-T4004: a changed head declines the repair before any generator or push", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4004-moved-head-"));
  try {
    const { effects, calls } = buildProductionExecutor(root, { liveHead: MOVED_HEAD });
    const repaired = await effects.repairRecordableRatchet!(ratchetPr(), ["comment-load-ratchet"]);

    assert.equal(repaired, false);
    assert.deepEqual(calls.generators, []);
    assert.deepEqual(calls.pushes, []);
    assert.equal(calls.commits, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4004: production executor names each unsafe refusal and only pushes on success", async () => {
  const cases: ReadonlyArray<{
    name: string;
    options?: ExecutorOptions;
    scripts?: readonly string[];
    reason: string;
  }> = [
    { name: "unratified script", scripts: ["source-size-signal"], reason: "unratified_script_set" },
    { name: "duplicate script", scripts: ["comment-load-ratchet", "comment-load-ratchet"], reason: "unratified_script_set" },
    { name: "unreadable live head", options: { ghError: new Error("GitHub unavailable") }, reason: "live_head_unreadable" },
    { name: "missing live branch", options: { missingLiveBranch: true }, reason: "live_head_missing" },
    { name: "missing live sha", options: { missingLiveHead: true }, reason: "live_head_missing" },
    { name: "unowned head", options: { liveBranch: "human-branch" }, reason: "unowned_head" },
    { name: "registered worktree owner", options: { registeredOwner: "/tmp/owned-worktree" }, reason: "registered_worktree_owner" },
    { name: "unreadable registered owner", options: { registeredOwnerError: new Error("git failed") }, reason: "registered_worktree_owner_unreadable" },
    { name: "branch claim error", options: { fixBranchClaimError: new Error("lock failed") }, reason: "executor_error" },
    {
      name: "moved or dirty worktree",
      options: { states: [{ headSha: MOVED_HEAD, changedPaths: [] }] },
      reason: "worktree_head_or_cleanliness_mismatch",
    },
    { name: "unreadable worktree", options: { states: [undefined] }, reason: "worktree_unreadable" },
    {
      name: "missing signal script",
      options: { packageScripts: { "comment-load-ratchet": "node scripts/comment-load-ratchet.mjs" } },
      reason: "script_not_declared",
    },
    {
      name: "worktree changed while generating",
      options: { states: [{ headSha: HEAD, changedPaths: [] }, { headSha: MOVED_HEAD, changedPaths: [] }] },
      reason: "worktree_head_changed_before_commit",
    },
    {
      name: "generator made no change",
      options: { states: [{ headSha: HEAD, changedPaths: [] }, { headSha: HEAD, changedPaths: [] }] },
      reason: "generator_made_no_change",
    },
    {
      name: "generator wrote outside the ratified baseline",
      options: { states: [{ headSha: HEAD, changedPaths: [] }, { headSha: HEAD, changedPaths: ["scripts/unrelated.json"] }] },
      reason: "unexpected_generated_path",
    },
    { name: "signal failed", options: { statuses: { "comment-load-signal": 1 } }, reason: "signal_failed" },
    { name: "empty generator commit", options: { commitResult: { changed: false } }, reason: "generator_commit_empty" },
    { name: "missing commit sha", options: { commitResult: { changed: true, sha: "" } }, reason: "generator_commit_empty" },
    { name: "push failed", options: { pushError: new Error("push unavailable") }, reason: "executor_error" },
    {
      name: "executor or cleanup failure",
      options: { createWorktreeError: new Error("worktree unavailable"), removeWorktreeError: new Error("cleanup unavailable") },
      reason: "executor_error",
    },
    {
      name: "cleanup failure after refusal",
      options: {
        states: [{ headSha: HEAD, changedPaths: [] }, { headSha: HEAD, changedPaths: [] }],
        removeWorktreeError: new Error("cleanup unavailable"),
      },
      reason: "generator_made_no_change",
    },
  ];
  for (const refusal of cases) {
    const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4004-refusal-"));
    try {
      const { effects, calls } = buildProductionExecutor(root, refusal.options);
      assert.equal(await effects.repairRecordableRatchet!(ratchetPr(), refusal.scripts ?? ["comment-load-ratchet"]), false, refusal.name);
      assert.equal(declineReason(calls), refusal.reason, refusal.name);
      assert.deepEqual(
        calls.pushes,
        refusal.options?.pushError ? [{ stdio: "ignore", expectedHeadSha: "c".repeat(40) }] : [],
        `${refusal.name} push behavior`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("W1-T4004: an already-held branch claim declines before a writer starts", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4004-claim-"));
  const { effects, calls } = buildProductionExecutor(root);
  const held = acquireInflightLock(join(root, "state", "inflight"), "W1-T4004-ratchet-claim", { run_id: "OTHER-RUN" });
  try {
    assert.equal(await effects.repairRecordableRatchet!(ratchetPr(), ["comment-load-ratchet"]), false);
    assert.equal(declineReason(calls), "inflight_lock_owner");
    assert.deepEqual(calls.generators, []);
    assert.deepEqual(calls.pushes, []);
  } finally {
    held.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4004: a declined baseline repair falls through to fix dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4004-fallback-"));
  try {
    const { effects, calls } = buildProductionExecutor(root, { statuses: { "comment-load-ratchet": 1 } });
    const { deps, fixed } = sweepDeps(root, effects.repairRecordableRatchet!);
    await runSweep([ratchetPr()], deps, { ...DEFAULT_SWEEP_POLICY, recordableRatchetRepairEnabled: true });

    assert.deepEqual(calls.generators, ["comment-load-ratchet"]);
    assert.equal(calls.commits, 0);
    assert.deepEqual(calls.pushes, []);
    assert.deepEqual(fixed, [4004], "a failed generator is a decline, not a false repaired receipt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4004: disabled policy never invokes the production executor", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t4004-disabled-"));
  try {
    const { effects, calls } = buildProductionExecutor(root);
    const { deps, fixed } = sweepDeps(root, effects.repairRecordableRatchet!);
    await runSweep([ratchetPr()], deps, DEFAULT_SWEEP_POLICY);

    assert.equal(calls.ghReads, 0, "the false shipped policy must not even start the branch-write executor");
    assert.deepEqual(calls.generators, []);
    assert.deepEqual(calls.pushes, []);
    assert.deepEqual(fixed, [4004]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4004: the default worktree reader names a real head and refuses unreadable paths", () => {
  const observed = readBaselineRatchetWorktreeState(process.cwd());
  assert.match(observed?.headSha ?? "", /^[0-9a-f]{40}$/);
  assert.equal(readBaselineRatchetWorktreeState(join(tmpdir(), "rmd-no-such-worktree-w1-t4004")), undefined);
});
