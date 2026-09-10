import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { logArmAttribution } from "../src/lib/arm-auto-merge.js";
import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import {
  buildSweepEffects as buildLibSweepEffects,
  DEFAULT_SWEEP_POLICY,
  requiredSweepRuntimeCtor,
  sweepArmAttemptOutcome,
  type BuildSweepEffectsDeps,
} from "../src/lib/sweep.js";
import { buildSweepEffects as buildEntrypointSweepEffects } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";

const EFFECT_KEYS = [
  "arm",
  "captureRepairFeedback",
  "close",
  "depReview",
  "disarmAutoMerge",
  "dispatchFix",
  "escalate",
  "escalateCancelledCheck",
  "escalateInfrastructureCheck",
  "postReview",
  "readCiGateRollup",
  "readLiveState",
  "readMainTip",
  "readRedBaseRefreshFacts",
  "reaggregateCiGate",
  "releaseBaseCausedStandDown",
  "repairMissingTaskTrailer",
  "rebaseDirtyFleetBranch",
  "repushAbsent",
  "requeueCheck",
  "selectAdaptiveReviewWidth",
  "terminalFixStandDown",
  "updateBranch",
] as const;

test("W1-T2890: sweep effects are built from the lib module with the same effect surface", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-sweep-effects-in-lib-"));
  try {
    const deps: BuildSweepEffectsDeps = {
      owner: "craigoley",
      repo: "remudero",
      config: { root, claudeBin: "/bin/true" } as Config,
      ledgerPath: join(root, "state", "ledger.ndjson"),
      runId: "SWEEP-W1-T2890",
      plan: { tasks: [], byId: new Map() } as unknown as Plan,
      log: () => {},
      policy: DEFAULT_SWEEP_POLICY,
      reviewRunner: async () => 0,
      issuesImpl: { create: () => "https://github.com/craigoley/remudero/issues/2890" },
      stallNotice: () => {},
      armImpl: () => "armed",
      armSessionPrsOverride: false,
      updateBranchImpl: async () => "updated",
      captureRepairFeedbackImpl: () => {},
      ghRunImpl: () => {},
      spawnWallClockBoundMsOverride: 1,
      reclaimWorkerImpl: () => {},
      disarmImpl: () => undefined,
      readJsonImpl: async () => ({}),
      updatePrBodyImpl: async () => {},
      registeredWorktreeOwnerImpl: () => undefined,
      registeredOwnerRecovery: { capture: () => undefined, remove: () => undefined },
    };

    const libEffects = buildLibSweepEffects(deps);
    const entrypointEffects = buildEntrypointSweepEffects(deps);

    assert.deepEqual(Object.keys(libEffects).sort(), [...EFFECT_KEYS].sort());
    assert.deepEqual(
      Object.keys(libEffects).sort(),
      Object.keys(entrypointEffects).sort(),
      "the lib-built orchestration must expose the same sweep effect set the entrypoint exposed before the move",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function baseDeps(root: string, overrides: Partial<BuildSweepEffectsDeps> = {}): BuildSweepEffectsDeps {
  const task = {
    id: "W1-T2890",
    title: "move sweep orchestration",
    risk: "low",
    acceptance: [],
    verify: "auto",
    files: [],
    status: "queued",
  };
  return {
    owner: "craigoley",
    repo: "remudero-fixture",
    repoRoot: process.cwd(),
    localRepoName: "remudero",
    config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(root, "state", "ledger.ndjson"),
    runId: "SWEEP-W1-T2890",
    plan: { tasks: [task], byId: new Map([[task.id, task]]) } as unknown as Plan,
    log: () => {},
    policy: DEFAULT_SWEEP_POLICY,
    reviewRunner: async () => 0,
    issuesImpl: { create: () => "https://github.com/craigoley/remudero/issues/2890" },
    stallNotice: () => {},
    armImpl: () => "armed",
    armSessionPrsOverride: false,
    updateBranchImpl: async () => "updated",
    captureRepairFeedbackImpl: () => {},
    ghRunImpl: () => {},
    spawnWallClockBoundMsOverride: 1,
    reclaimWorkerImpl: () => {},
    disarmImpl: () => undefined,
    readJsonImpl: async () => ({}),
    updatePrBodyImpl: async () => {},
    registeredWorktreeOwnerImpl: () => undefined,
    registeredOwnerRecovery: { capture: () => undefined, remove: () => undefined },
    ...overrides,
  };
}

test("W1-T2890: lib buildSweepEffects keeps the moved default seam failures explicit", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-sweep-effects-required-"));
  try {
    const effects = buildLibSweepEffects({
      ...baseDeps(root),
      updatePrBodyImpl: undefined,
    });

    await assert.rejects(
      async () => {
        await effects.repairMissingTaskTrailer!(
          { prNumber: 2890, prUrl: "https://github.com/craigoley/remudero/pull/2890", headSha: "abc123" } as never,
          { taskId: "W1-T2890", repairedBody: "Remudero-Task: W1-T2890\n" } as never,
        );
      },
      /buildSweepEffects requires updatePrBodyImpl from its entrypoint adapter/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2890: lib constructor defaults fail with the same explicit adapter message", () => {
  const MissingCtor = requiredSweepRuntimeCtor<new () => unknown>("fixRungCheckoutRefusedErrorImpl");

  assert.throws(
    () => new MissingCtor(),
    /buildSweepEffects requires fixRungCheckoutRefusedErrorImpl from its entrypoint adapter/,
  );
});

test("W1-T2890: lib arm wiring parses PR numbers from URL and bare refs before applying session policy", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-sweep-effects-arm-"));
  try {
    const calls: Array<{ prUrl: string; taskId: string | undefined }> = [];
    const effects = buildLibSweepEffects({
      ...baseDeps(root),
      armSessionPrsOverride: true,
      armImpl: (prUrl, taskId) => {
        calls.push({ prUrl, taskId });
        return "armed";
      },
    });

    effects.arm!({ prNumber: 2890, prUrl: "https://github.com/craigoley/remudero/pull/2890", headSha: "abc123" } as never);
    effects.arm!({ prNumber: 7, prUrl: "#7", headSha: "def456" } as never);
    effects.arm!({ prNumber: 8, prUrl: "not-a-pr", headSha: "bad999" } as never);

    assert.deepEqual(calls.map((c) => c.taskId), ["PR-2890", "PR-7", undefined]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2890: moved arm attribution still treats undefined as legacy armed and names skips", () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const log = (step: string, extra?: Record<string, unknown>) => logs.push({ step, extra });

  logArmAttribution(log, undefined as never, "https://github.com/craigoley/remudero/pull/2890", "W1-T2890", "sweep");
  logArmAttribution(log, "armed", "https://github.com/craigoley/remudero/pull/2891", "W1-T2890", "sweep");
  logArmAttribution(log, "ledger-refused", "https://github.com/craigoley/remudero/pull/2892", "W1-T2890", "sweep");

  assert.deepEqual(logs.map((l) => l.step), ["automerge.armed", "automerge.armed", "automerge.arm_skipped"]);
  assert.deepEqual(logs.map((l) => l.extra?.pr_number), [2890, 2891, 2892]);
});

test("W1-T2890: sweep arm-attempt folding leaves direct-merge failures retryable", () => {
  assert.equal(
    sweepArmAttemptOutcome("arm-error-ignored", "GraphQL: Pull request is in clean status"),
    "arm-error-ignored",
  );
});

test("W1-T2890: dispatchFix moved to lib wires owner recovery and fix-rung adapter deps", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-sweep-effects-dispatch-"));
  const shim = ghShim(
    [
      {
        when: "pr view https://github.com/craigoley/remudero/pull/2890 --json headRefName,headRefOid,body",
        stdout: JSON.stringify({ headRefName: "run-W1-T2890-1789022939729", headRefOid: "remote123456789", body: "" }),
      },
      {
        when: "pr view https://github.com/craigoley/remudero/pull/2890 --json statusCheckRollup",
        stdout: JSON.stringify({ statusCheckRollup: [{ name: "ci", status: "completed", conclusion: "failure" }] }),
      },
    ],
    { kind: "w1-t2890-dispatch-gh" },
  );
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${shim.dir}:${oldPath}`;
    mkdirSync(join(root, "state", "inflight"), { recursive: true });
    mkdirSync(join(root, "repos", "remudero-fixture"), { recursive: true });
    mkdirSync(join(root, "tmp"), { recursive: true });

    const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const adapterCalls: string[] = [];
    let ownerReads = 0;
    const effects = buildLibSweepEffects({
      ...baseDeps(root),
      log: (step, extra) => logs.push({ step, extra }),
      dispatchFixPreflightStandDownImpl: async () => undefined,
      registeredWorktreeOwnerImpl: () => (++ownerReads === 1 ? join(root, "worktrees", "owner") : undefined),
      registeredOwnerRecovery: {
        capture: () => ({
          path: join(root, "worktrees", "owner"),
          localSha: "local123456789",
          remoteSha: "remote123456789",
          ageMs: 10,
          pathState: "managed",
          attachmentState: "exact",
          treeState: "clean",
          remoteState: "exact",
          historyState: "ahead",
          claimState: "clear",
          processState: "clear",
        }),
        publishAhead: () => adapterCalls.push("publishAhead"),
        remove: () => adapterCalls.push("remove"),
      },
      decideRegisteredFixOwnerRecoveryImpl: () => ({ kind: "publish-ahead" }),
      fixBranchClaimKeyImpl: () => "claim-key",
      createFixRungWorktreeImpl: () => undefined,
      captureWorktreeSnapshotImpl: () => ({ headSha: "birth123" }),
      buildFixRungDispatchArgsImpl: () => ({ fromBuilder: true }),
      openTaskIdsFromPlanImpl: () => new Set(["W1-T2890"]),
      waitForCiGreenImpl: async () => true,
      restRollupForImpl: async () => [],
      fetchCiFailuresImpl: () => [{ name: "ci", logTail: "red" }],
      runReviewImpl: async () => ({ verdict: "PASS" }),
      fetchPrBodyImpl: async () => "body",
      readHeadShaImpl: async () => "head123",
      ghLiveStateImpl: async () => ({ state: "OPEN" }),
      ghLiveHeadImpl: async () => ({ headRefName: "run-W1-T2890-1789022939729" }),
      fetchPrDiffFilesImpl: async () => ["src/lib/sweep.ts"],
      fixRebaseMergeFactsImpl: async () => ({ merged: false }),
      redBaseRefreshFactsImpl: async () => ({ state: "red" }),
      ghUpdateBranchImpl: async () => "updated",
      readFixRoundCommitsImpl: () => [],
      runNpmScriptImpl: async () => ({ status: 0, stdout: "ok", stderr: "" }),
      commitGeneratorOutputImpl: () => "commit123",
      readPackageScriptsImpl: () => ({ test: "node --test" }),
      runFixRungImpl: async (args: any) => {
        await args.deps.spawn({ resumeSessionId: "", task: { id: "W1-T2890" } });
        await args.deps.fetchCiFailures("https://github.com/craigoley/remudero/pull/2890");
        await args.deps.readCiRollup("https://github.com/craigoley/remudero/pull/2890");
        args.deps.push("/tmp/rmd-no-such-worktree", "run-W1-T2890-1789022939729", "expected");
        args.deps.log("fix.dispatch", { note: "started" });
        args.deps.account({ ok: true });
        await args.deps.readPrerequisiteState(2890);
        await args.deps.readMergeFacts(2890);
        await args.deps.readRedBaseRefreshFacts(2890);
        await args.deps.updateBranch(2890);
        await args.deps.runGeneratorScript("source-size-signal", root);
        args.deps.commitGeneratorOutput({ cwd: root });
        assert.deepEqual(args.deps.packageScripts, { test: "node --test" });
      },
      spawnImpl: async () => ({ sessionId: "new-session" }) as never,
    });

    await effects.dispatchFix!(
      {
        prNumber: 2890,
        prUrl: "https://github.com/craigoley/remudero/pull/2890",
        headSha: "remote123456789",
        taskId: "W1-T2890",
        priorStrikes: 0,
        mergeState: "clean",
        checksState: "failure",
      } as never,
      { unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "red" }] } as never,
    );

    assert.deepEqual(adapterCalls, ["publishAhead", "remove"]);
    assert.ok(logs.some((l) => l.step === "sweep.fix.checkout_owner_ahead_published"));
    assert.ok(logs.some((l) => l.step === "sweep.fix.checkout_owner_reclaimed"));
    assert.ok(logs.some((l) => l.step === "fix.dispatch" && l.extra?.task_id === "W1-T2890"));
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("W1-T2890: dispatchFix moved to lib preserves diverged owner refs before recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-sweep-effects-dispatch-diverged-"));
  const shim = ghShim(
    [
      {
        when: "pr view https://github.com/craigoley/remudero/pull/2890 --json headRefName,headRefOid,body",
        stdout: JSON.stringify({ headRefName: "run-W1-T2890-1789022939729", headRefOid: "remote123456789", body: "" }),
      },
    ],
    { kind: "w1-t2890-diverged-gh" },
  );
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${shim.dir}:${oldPath}`;
    mkdirSync(join(root, "state", "inflight"), { recursive: true });
    mkdirSync(join(root, "repos", "remudero-fixture"), { recursive: true });
    mkdirSync(join(root, "tmp"), { recursive: true });

    const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    let ownerReads = 0;
    const effects = buildLibSweepEffects({
      ...baseDeps(root),
      log: (step, extra) => logs.push({ step, extra }),
      dispatchFixPreflightStandDownImpl: async () => undefined,
      registeredWorktreeOwnerImpl: () => (++ownerReads === 1 ? join(root, "worktrees", "owner") : undefined),
      registeredOwnerRecovery: {
        capture: () => ({
          path: join(root, "worktrees", "owner"),
          localSha: "local123456789",
          remoteSha: "remote123456789",
          ageMs: 10,
          pathState: "managed",
          attachmentState: "exact",
          treeState: "clean",
          remoteState: "exact",
          historyState: "diverged",
          claimState: "clear",
          processState: "clear",
        }),
        preserveDiverged: () => "refs/rmd-recovery/W1-T2890",
        remove: () => undefined,
      },
      decideRegisteredFixOwnerRecoveryImpl: () => ({ kind: "preserve-diverged" }),
      fixBranchClaimKeyImpl: () => "claim-key",
      createFixRungWorktreeImpl: () => undefined,
      captureWorktreeSnapshotImpl: () => ({ headSha: "birth123" }),
      buildFixRungDispatchArgsImpl: () => ({}),
      openTaskIdsFromPlanImpl: () => new Set(["W1-T2890"]),
      readPackageScriptsImpl: () => ({}),
      runFixRungImpl: async () => undefined,
    });

    await effects.dispatchFix!(
      {
        prNumber: 2890,
        prUrl: "https://github.com/craigoley/remudero/pull/2890",
        headSha: "remote123456789",
        taskId: "W1-T2890",
        priorStrikes: 0,
        mergeState: "clean",
        checksState: "failure",
      } as never,
      { unmetCriteria: [], ciFailures: [] } as never,
    );

    assert.equal(
      logs.find((l) => l.step === "sweep.fix.checkout_owner_divergence_preserved")?.extra?.recovery_ref,
      "refs/rmd-recovery/W1-T2890",
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("W1-T2890: dispatchFix moved to lib names unreadable owner salvage identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-sweep-effects-dispatch-missing-sha-"));
  const shim = ghShim(
    [
      {
        when: "pr view https://github.com/craigoley/remudero/pull/2890 --json headRefName,headRefOid,body",
        stdout: JSON.stringify({ headRefName: "run-W1-T2890-1789022939729", headRefOid: "remote123456789", body: "" }),
      },
    ],
    { kind: "w1-t2890-missing-sha-gh" },
  );
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${shim.dir}:${oldPath}`;
    mkdirSync(join(root, "state", "inflight"), { recursive: true });
    mkdirSync(join(root, "repos", "remudero-fixture"), { recursive: true });

    const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const effects = buildLibSweepEffects({
      ...baseDeps(root),
      log: (step, extra) => logs.push({ step, extra }),
      dispatchFixPreflightStandDownImpl: async () => undefined,
      registeredWorktreeOwnerImpl: () => join(root, "worktrees", "owner"),
      registeredOwnerRecovery: {
        capture: () => ({
          path: join(root, "worktrees", "owner"),
          localSha: undefined,
          remoteSha: "remote123456789",
          ageMs: 10,
          pathState: "managed",
          attachmentState: "exact",
          treeState: "clean",
          remoteState: "exact",
          historyState: "ahead",
          claimState: "clear",
          processState: "clear",
        }),
        remove: () => undefined,
      },
      decideRegisteredFixOwnerRecoveryImpl: () => ({ kind: "publish-ahead" }),
      fixBranchClaimKeyImpl: () => "claim-key",
    });

    await effects.dispatchFix!(
      {
        prNumber: 2890,
        prUrl: "https://github.com/craigoley/remudero/pull/2890",
        headSha: "remote123456789",
        taskId: "W1-T2890",
        priorStrikes: 0,
        mergeState: "clean",
        checksState: "failure",
      } as never,
      { unmetCriteria: [], ciFailures: [] } as never,
    );

    const declined = logs.find(
      (l) => l.step === "sweep.fix.checkout_claim_declined" && l.extra?.owner_recovery_reason === "owner_salvage_identity_unreadable",
    );
    assert.equal(declined?.extra?.worktree_path, join(root, "worktrees", "owner"));
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("W1-T2890: readMainTip from the lib-built effects degrades unreadable REST to undefined", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-sweep-effects-main-tip-"));
  try {
    const effects = buildLibSweepEffects({
      ...baseDeps(root),
      readJsonImpl: async () => {
        throw new Error("network unavailable");
      },
    });

    assert.equal(await effects.readMainTip!(), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
