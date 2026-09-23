/**
 * W1-T4105 — a fix-rung worker kept repairing PR #6681's stale head 3dd6d72 for 45+ minutes after
 * dde0c1861 landed and went green. While a fix worker runs, the PR head and the failing check are
 * now re-read at the sweep's cadence; a supersession stops the worker through the existing
 * reclaim path, is ledgered `fix.superseded`, keeps the worktree and never spends a strike.
 * Every GitHub read is injected — nothing here touches the network.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Plan } from "../src/lib/plan.js";
import type { CriterionVerdict, ReviewVerdict } from "../src/lib/review.js";
import {
  buildSweepEffects,
  decideFixSuperseded,
  DEFAULT_SWEEP_POLICY,
  headIsInWorktree,
  watchFixSuperseded,
  type BuildSweepEffectsDeps,
  type FixDispatchSnapshot,
  type RollupCheckEntry,
} from "../src/lib/sweep.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { priorStrikesFor, runFixRung } from "../src/run-task.js";
import { ghShim, type GhShimRoute } from "./helpers/gh-shim.js";

const OLD_HEAD = "3dd6d72aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_HEAD = "dde0c1861bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TASK = "W1-T4079";
const RUN = "SWEEP-W1-T4079-1790128037477";

type Row = { step: string; extra?: Record<string, unknown> };

/** Any `gh` a default seam shells answers from a PATH shim, never the network. */
async function withGhShim<T>(routes: GhShimRoute[], body: (calls: () => string[]) => Promise<T>): Promise<T> {
  const shim = ghShim(routes, { kind: "w1-t4105-gh" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  try {
    return await body(() => shim.calls());
  } finally {
    process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
}

function fakeWorkerResult(): WorkerResult {
  return {
    sessionId: "s-w1t4105",
    costUsd: 0,
    numTurns: 1,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "sonnet",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  };
}

function review(state: "success" | "failure", headSha: string): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  const c: CriterionVerdict = { claim: "ci is green", met: state === "success", proof: "proof", reason: "", proof_exec: "not_executable" };
  return {
    state,
    criteria: [c],
    testTheater: false,
    summary: state,
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "success",
  };
}

const MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };
const NEVER_ISSUES: IssueGateway = {
  create() {
    throw new Error("no escalation expected");
  },
};

/** Drive the real runFixRung in ci-log mode with the real watcher; `read` is the one PR read. */
async function runWatchedRung(opts: {
  read: () => Promise<{ headSha?: string; rollup?: RollupCheckEntry[] }>;
  spawn: (reads: () => number) => Promise<WorkerResult>;
  watchSuperseded?: (s: FixDispatchSnapshot, signal: AbortSignal) => Promise<never>;
}) {
  const logs: Row[] = [];
  const reclaims: string[] = [];
  let reads = 0;
  const ledgerDir = mkdtempSync(join(tmpdir(), "rmd-w1t4105-ledger-"));
  try {
    const outcome = await withGhShim([], async () => runFixRung({
      taskId: TASK,
      runId: RUN,
      task: { id: TASK, title: "the PR a human fixed 69 s after dispatch" },
      prUrl: "https://github.com/craigoley/remudero/pull/6681",
      branch: "run-W1-T4079-1790000000000",
      worktreePath: "/tmp/rmd-w1t4105-no-such-worktree",
      initialSessionId: "",
      mount: MOUNT,
      settingsFile: "/tmp/rmd-w1t4105-settings.json",
      config: {} as Config,
      budgetUsd: 10,
      strikeCap: 2,
      reviewBase: { owner: "craigoley", repo: "remudero", headCheckoutDir: "/tmp/rmd-w1t4105-no-such-worktree", reviewerMount: MOUNT },
      initialReview: review("failure", OLD_HEAD),
      ciFailures: [{ name: "ci", logTail: "coverage suite red" }],
      deps: {
        spawn: () => opts.spawn(() => reads),
        waitForCiGreen: async () => "green",
        runReview: async () => review("success", NEW_HEAD),
        push: () => {},
        issues: NEVER_ISSUES,
        ledgerPath: join(ledgerDir, "ledger.ndjson"),
        log: (step, extra) => logs.push({ step, extra: { task_id: TASK, ...extra } }),
        say: () => {},
        account: (r) => r,
        spawnWallClockBoundMs: 60_000,
        reclaimWorker: (info) => void reclaims.push(info.runId),
        watchSuperseded:
          opts.watchSuperseded ??
          ((snapshot, signal) =>
            watchFixSuperseded({
              snapshot,
              signal,
              intervalMs: 1,
              read: () => {
                reads++;
                return opts.read();
              },
              isWorkerHead: () => false,
              log: (step, extra) => logs.push({ step, extra }),
            })),
      },
    }));
    return { outcome, logs, reclaims };
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
}

const NEVER_RETURNS = () => new Promise<WorkerResult>(() => {});

test("a fix worker whose PR head moves is stopped and ledgered as superseded", async () => {
  const { outcome, logs, reclaims } = await runWatchedRung({
    read: async () => ({ headSha: NEW_HEAD, rollup: [{ name: "ci", conclusion: "SUCCESS" }] }),
    spawn: NEVER_RETURNS,
  });
  assert.equal(outcome.outcome, "stood_down");
  assert.equal(outcome.superseded?.condition, "head-moved");
  assert.deepEqual(reclaims, [RUN], "the worker is stopped through the existing reclaim path, exactly once");
  const row = logs.find((l) => l.step === "fix.superseded");
  assert.ok(row, "fix.superseded must be ledgered");
  assert.equal(row.extra?.old_head, OLD_HEAD);
  assert.equal(row.extra?.new_head, NEW_HEAD);
  assert.equal(row.extra?.condition, "head-moved");
  assert.equal(row.extra?.worktree_path, "/tmp/rmd-w1t4105-no-such-worktree");
});

test("a fix worker whose failing check turns green is stopped and ledgered as superseded", async () => {
  const { outcome, logs, reclaims } = await runWatchedRung({
    read: async () => ({
      headSha: OLD_HEAD,
      rollup: [
        { name: "ci", conclusion: "FAILURE", startedAt: "2026-09-23T01:40:00Z" },
        { name: "ci", conclusion: "SUCCESS", startedAt: "2026-09-23T01:50:00Z" },
      ],
    }),
    spawn: NEVER_RETURNS,
  });
  assert.equal(outcome.outcome, "stood_down");
  assert.deepEqual(reclaims, [RUN]);
  const row = logs.find((l) => l.step === "fix.superseded");
  assert.equal(row?.extra?.condition, "check-green");
  assert.equal(row?.extra?.old_head, OLD_HEAD);
  assert.equal(row?.extra?.new_head, OLD_HEAD);
});

test("a superseded fix run is not counted as a repair strike", async () => {
  const { outcome, logs } = await runWatchedRung({
    read: async () => ({ headSha: NEW_HEAD }),
    spawn: NEVER_RETURNS,
  });
  assert.equal(outcome.strikes, 0);
  assert.equal(logs.filter((l) => l.step === "fix.dispatch").length, 0, "no fix.dispatch row — the only row a strike is read from");
  const lines = logs.map((l) => ({ step: l.step, ...l.extra }));
  assert.ok(lines.some((l) => l.step === "fix.superseded"));
  assert.equal(priorStrikesFor(lines, TASK), 0);
  assert.equal(priorStrikesFor(lines, TASK, "keyword_only", NEW_HEAD), 0);
});

test("an unreadable PR head leaves the fix worker running and says so", async () => {
  let call = 0;
  const { outcome, logs, reclaims } = await runWatchedRung({
    read: async () => {
      call++;
      if (call === 1) throw new Error("gh: HTTP 502");
      return {};
    },
    // The worker finishes only after the watcher has failed to read the head twice.
    spawn: async (reads) => {
      for (let i = 0; reads() < 2 && i < 2000; i++) await new Promise((r) => setTimeout(r, 1));
      return fakeWorkerResult();
    },
  });
  assert.deepEqual(reclaims, [], "an unreadable head never stops the worker");
  assert.equal(outcome.superseded, undefined);
  assert.equal(outcome.outcome, "fixed");
  assert.equal(outcome.strikes, 1, "the worker ran to completion, so its round is an ordinary strike");
  assert.equal(logs.filter((l) => l.step === "fix.superseded").length, 0);
  const unknown = logs.filter((l) => l.step === "fix.superseded_unknown");
  assert.ok(unknown.length >= 2, "each unreadable read is said out loud");
  assert.equal(unknown[0]!.extra?.reason, "gh: HTTP 502");
  assert.equal(unknown[1]!.extra?.reason, "PR head missing from the read");
  assert.equal(unknown[0]!.extra?.worker, "left running");
  assert.equal(unknown[0]!.extra?.old_head, OLD_HEAD);
});

test("W1-T4105: a watcher that throws never stops the fix worker", async () => {
  const { outcome, reclaims } = await runWatchedRung({
    read: async () => ({}),
    spawn: async () => fakeWorkerResult(),
    watchSuperseded: async () => {
      throw new Error("watcher broke");
    },
  });
  assert.deepEqual(reclaims, []);
  assert.equal(outcome.outcome, "fixed");
});

test("W1-T4105: the worker's own push is not a supersession, and a still-red check keeps it running", () => {
  const snap: FixDispatchSnapshot = { headSha: OLD_HEAD, failingChecks: ["ci"] };
  assert.deepEqual(decideFixSuperseded(snap, { headSha: NEW_HEAD }, () => true), { kind: "continue" });
  assert.deepEqual(
    decideFixSuperseded(snap, { headSha: OLD_HEAD, rollup: [{ name: "ci", conclusion: "FAILURE" }] }, () => false),
    { kind: "continue" },
  );
  assert.deepEqual(decideFixSuperseded(snap, { headSha: OLD_HEAD }, () => false), { kind: "continue" });
  assert.deepEqual(
    decideFixSuperseded({ headSha: OLD_HEAD, failingChecks: [] }, { headSha: OLD_HEAD, rollup: [] }, () => false),
    { kind: "continue" },
    "a round with no failing check (review mode) only ever supersedes on a head move",
  );
  assert.deepEqual(
    decideFixSuperseded(snap, { headSha: OLD_HEAD, rollup: [{ context: "ci", state: "success" }] }, () => false),
    { kind: "superseded", condition: "check-green", oldHead: OLD_HEAD, newHead: OLD_HEAD },
  );
});

test("W1-T4105: headIsInWorktree reads the worktree's own history", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1t4105-git-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "worker push");
    const own = git("rev-parse", "HEAD");
    assert.equal(headIsInWorktree(dir, own), true);
    assert.equal(headIsInWorktree(dir, NEW_HEAD), false, "a commit the worktree never saw is foreign");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4105: an aborted watcher returns without reading", async () => {
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  const result = await watchFixSuperseded({
    snapshot: { headSha: OLD_HEAD, failingChecks: [] },
    signal: controller.signal,
    intervalMs: 1,
    read: async () => {
      reads++;
      return {};
    },
    isWorkerHead: () => false,
    log: () => {},
  });
  assert.equal(result, undefined);
  assert.equal(reads, 0);
  const late = new AbortController();
  const pending = watchFixSuperseded({
    snapshot: { headSha: OLD_HEAD, failingChecks: [] },
    signal: late.signal,
    intervalMs: 60_000,
    read: async () => ({}),
    isWorkerHead: () => false,
    log: () => {},
  });
  late.abort();
  assert.equal(await pending, undefined, "aborting mid-sleep ends the watch");
});

function sweepDeps(root: string, over: Partial<BuildSweepEffectsDeps>): BuildSweepEffectsDeps {
  const task = { id: TASK, title: "t", risk: "low", acceptance: [], verify: "auto", files: [], status: "queued" };
  return {
    owner: "craigoley",
    repo: "remudero-fixture",
    repoRoot: process.cwd(),
    localRepoName: "remudero",
    config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(root, "state", "ledger.ndjson"),
    runId: RUN,
    plan: { tasks: [task], byId: new Map([[task.id, task]]) } as unknown as Plan,
    log: () => {},
    policy: DEFAULT_SWEEP_POLICY,
    reviewRunner: async () => 0,
    issuesImpl: { create: () => "https://github.com/craigoley/remudero/issues/4105" },
    stallNotice: () => {},
    armImpl: () => "armed",
    armSessionPrsOverride: false,
    updateBranchImpl: async () => "updated",
    captureRepairFeedbackImpl: () => {},
    ghRunImpl: () => {},
    spawnWallClockBoundMsOverride: 60_000,
    fixSupersededPollMsOverride: 1,
    reclaimWorkerImpl: () => {},
    disarmImpl: () => undefined,
    readJsonImpl: async () => ({}),
    updatePrBodyImpl: async () => {},
    registeredWorktreeOwnerImpl: () => undefined,
    registeredOwnerRecovery: { capture: () => undefined, remove: () => undefined },
    dispatchFixPreflightStandDownImpl: async () => undefined,
    fixBranchClaimKeyImpl: () => "claim-key-w1t4105",
    createFixRungWorktreeImpl: () => undefined,
    captureWorktreeSnapshotImpl: () => ({ headSha: OLD_HEAD }),
    buildFixRungDispatchArgsImpl: () => ({}),
    openTaskIdsFromPlanImpl: () => new Set([TASK]),
    readPackageScriptsImpl: () => ({}),
    ...over,
  };
}

async function dispatchWithRung(rungReturns: "watch" | "plain") {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1t4105-sweep-"));
  try {
    mkdirSync(join(root, "state", "inflight"), { recursive: true });
    mkdirSync(join(root, "repos", "remudero-fixture"), { recursive: true });
    mkdirSync(join(root, "tmp"), { recursive: true });
    const logs: Row[] = [];
    const removed: string[] = [];
    const ghCalls: string[][] = [];
    const effects = buildSweepEffects(
      sweepDeps(root, {
        log: (step, extra) => logs.push({ step, extra }),
        ghJsonImpl: (args) => {
          ghCalls.push(args);
          if (ghCalls.filter((a) => a.includes("headRefOid,statusCheckRollup")).length === 1) throw new Error("gh: HTTP 502");
          return { headRefOid: NEW_HEAD, statusCheckRollup: [] };
        },
        worktreeRemoveImpl: (_repo: string, wt: string) => void removed.push(wt),
        runFixRungImpl: async (args: { deps: { watchSuperseded: (s: FixDispatchSnapshot, sig: AbortSignal) => Promise<unknown> } }) => {
          if (rungReturns === "plain") return { outcome: "fixed" };
          const superseded = await args.deps.watchSuperseded({ headSha: OLD_HEAD, failingChecks: ["ci"] }, new AbortController().signal);
          return { outcome: "stood_down", superseded };
        },
      }),
    );
    const shimCalls = await withGhShim(
      [
        {
          when: "headRefName,headRefOid,body",
          stdout: JSON.stringify({ headRefName: "run-W1-T4079-1790000000000", headRefOid: OLD_HEAD, body: "" }),
        },
      ],
      async (calls) => {
        await effects.dispatchFix!(
      {
        prNumber: 6681,
        prUrl: "https://github.com/craigoley/remudero/pull/6681",
        headSha: OLD_HEAD,
        taskId: TASK,
        priorStrikes: 0,
        mergeState: "clean",
        checksState: "red",
      } as never,
      { unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "red" }] } as never,
        );
        return calls();
      },
    );
    assert.ok(!shimCalls.some((c) => c.includes("headRefOid,statusCheckRollup")), "the watch read goes through the injected reader");
    return { logs, removed, ghCalls };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T4105: the sweep's fix dispatch watches the PR with one read per poll and keeps a superseded worktree", async () => {
  const { logs, removed, ghCalls } = await dispatchWithRung("watch");
  assert.deepEqual(removed, [], "a superseded worker's worktree is kept for diagnosis");
  const watchReads = ghCalls.filter((a) => a.includes("headRefOid,statusCheckRollup"));
  assert.equal(watchReads.length, 2, "one PR read per poll: the unreadable one, then the one that saw the new head");
  const unknown = logs.find((l) => l.step === "fix.superseded_unknown");
  assert.equal(unknown?.extra?.task_id, TASK);
  assert.equal(unknown?.extra?.pr_number, 6681);

  const plain = await dispatchWithRung("plain");
  assert.equal(plain.removed.length, 1, "an ordinary round's worktree is still removed");
});
