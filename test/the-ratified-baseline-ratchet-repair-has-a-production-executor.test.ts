import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Config } from "../src/lib/config.js";
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
}

function buildProductionExecutor(root: string, options: {
  liveHead?: string;
  statuses?: Record<string, number>;
  states?: BaselineRatchetWorktreeState[];
} = {}) {
  mkdirSync(join(root, "state", "inflight"), { recursive: true });
  const calls: ExecutorCalls = { generators: [], pushes: [], commits: 0, removed: [], ghReads: 0 };
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
    log: () => {},
    policy: DEFAULT_SWEEP_POLICY,
    nowMsImpl: () => 1_790_075_494_125,
    reviewRunner: async () => 0,
    issuesImpl: { create: () => "https://github.com/craigoley/remudero/issues/4004" },
    ghJsonImpl: (args) => {
      calls.ghReads++;
      assert.deepEqual(args, ["pr", "view", ratchetPr().prUrl, "--json", "headRefName,headRefOid,body"]);
      return { headRefName: BRANCH, headRefOid: options.liveHead ?? HEAD, body: "Remudero-Task: W1-T4004\n" };
    },
    registeredWorktreeOwnerImpl: () => undefined,
    fixBranchClaimKeyImpl: () => "W1-T4004-ratchet-claim",
    createFixRungWorktreeImpl: () => undefined,
    readBaselineRatchetWorktreeStateImpl: () => states.shift(),
    readPackageScriptsImpl: () => ({
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
      return { changed: true, sha: "c".repeat(40) };
    },
    gitPushRunBranchImpl: (_worktree: string, opts = {}) => {
      calls.pushes.push(opts);
    },
    worktreeRemoveImpl: (_repo: string, path: string) => {
      calls.removed.push(path);
    },
  };
  // This is the entrypoint builder the daemon calls, not a test-only hand-built SweepDeps object.
  return { effects: buildEntrypointSweepEffects(deps), calls, ledgerPath: deps.ledgerPath };
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

test("W1-T4004: baseline repair admission is independent from conflict regeneration", () => {
  assert.deepEqual(Object.keys(RATIFIED_BASELINE_RATCHET_REPAIRS).sort(), ["comment-load-ratchet", "source-size-baseline:legacy"]);
  const nonBaseline = ratchetPr({
    redRequiredChecks: ["plan-index"],
    ciFailures: [{ name: "plan-index", logTail: "generator" }],
  });
  assert.deepEqual(recordableRatchetRepairFor(nonBaseline), ["plan-index"], "the broader conflict registry still recognizes its own member");
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
