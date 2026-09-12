import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildSweepEffects,
  DEFAULT_SWEEP_POLICY,
  FIXED_MAIN_REFIRE_STEP,
  fixedMainRefireDecision,
  proveFixedMainBlockerViaLocalMerge,
  runSweep,
  type BuildSweepEffectsDeps,
  type FixedMainBlockerProof,
  type OpenPrView,
} from "../src/lib/sweep.js";
import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";

const NOW = Date.parse("2026-09-10T12:50:00Z");
const MAIN = {
  sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  committedAt: "2026-09-10T12:36:48Z",
};
const FIXED_MAIN_DECISION = {
  refire: true,
  reason: "newest failure predates main",
  key: "4938@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  mainTipSha: MAIN.sha,
  mainTipCommittedAt: MAIN.committedAt,
  staleFailureCompletedAt: "2026-09-10T12:31:00Z",
  checkNames: ["comment-load-ratchet"],
} as const;

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 4938,
    prUrl: "https://github.com/craigoley/remudero/pull/4938",
    taskId: "W1-T4938",
    reviewState: "success",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-09-10T12:20:00Z",
    headSha: "head-4938",
    headRefName: "run-W1-T4938-1",
    autoMergeArmed: false,
    ciFailures: [
      {
        name: "comment-load-ratchet",
        logTail: "expiring-fixture-census: BLOCKED",
        completedAt: "2026-09-10T12:31:00Z",
      },
    ],
    ...over,
  };
}

function sibling(over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({
    prNumber: 4950,
    prUrl: "https://github.com/craigoley/remudero/pull/4950",
    taskId: "W1-T4950",
    headSha: "head-4950",
    ...over,
  });
}

async function sweep(
  prs: OpenPrView[],
  over: {
    prior?: Record<string, unknown>[];
    proof?: FixedMainBlockerProof;
  } = {},
) {
  const appended: Record<string, unknown>[] = [];
  const refired: number[] = [];
  const dispatched: number[] = [];
  const proofed: number[] = [];
  const summary = await runSweep(prs, {
    arm: () => {},
    close: () => {},
    dispatchFix: (candidate) => { dispatched.push(candidate.prNumber); },
    escalate: () => {},
    ledgerPath: "/dev/null/w1-t3331.ndjson",
    runId: "W1-T3331-test",
    readLedger: () => over.prior ?? [],
    appendLine: (_path, line) => { appended.push(line); },
    now: () => NOW,
    readMainTip: () => MAIN,
    proveFixedMainBlocker: (candidate) => {
      proofed.push(candidate.prNumber);
      return over.proof ?? { passed: true, reason: "local gate passed", localGateExit: 0 };
    },
    refireFixedMainPr: (candidate) => {
      refired.push(candidate.prNumber);
      return true;
    },
  });
  return { appended, dispatched, proofed, refired, summary };
}

function baseDeps(root: string, overrides: Partial<BuildSweepEffectsDeps> = {}): BuildSweepEffectsDeps {
  return {
    owner: "craigoley",
    repo: "remudero-fixture",
    repoRoot: root,
    localRepoName: "remudero-fixture",
    config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(root, "state", "ledger.ndjson"),
    runId: "SWEEP-W1-T3331",
    plan: { tasks: [], byId: new Map() } as unknown as Plan,
    log: () => {},
    policy: DEFAULT_SWEEP_POLICY,
    reviewRunner: async () => 0,
    issuesImpl: { create: () => "https://github.com/craigoley/remudero/issues/3331" },
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

function fakeGit(over: { observedHead?: string; throwOn?: string } = {}) {
  const calls: string[][] = [];
  const git = (_cmd: string, args: readonly string[]) => {
    const argv = [...args];
    calls.push(argv);
    const op = argv[2];
    if (over.throwOn === op) throw new Error(`${op} exploded`);
    if (op === "rev-parse") return `${over.observedHead ?? "head-4938"}\n`;
    return "";
  };
  return { calls, git };
}

test("W1-T3331 criterion 1 and 4: a stale PR whose local merge passes is refired once and ledgered", async () => {
  const result = await sweep([pr(), sibling()]);

  assert.deepEqual(result.proofed, [4938, 4950]);
  assert.deepEqual(result.refired, [4938, 4950]);
  assert.deepEqual(result.dispatched, [], "the fix rung must not spend a strike for a fixed-main blocker");
  const row = result.appended.find((line) => line.step === FIXED_MAIN_REFIRE_STEP && line.pr_number === 4938);
  assert.deepEqual(row && {
    pr_number: row.pr_number,
    head_sha: row.head_sha,
    main_tip_sha: row.main_tip_sha,
    main_tip_committed_at: row.main_tip_committed_at,
    stale_failure_completed_at: row.stale_failure_completed_at,
    check_names: row.check_names,
    local_gate_exit: row.local_gate_exit,
  }, {
    pr_number: 4938,
    head_sha: "head-4938",
    main_tip_sha: MAIN.sha,
    main_tip_committed_at: MAIN.committedAt,
    stale_failure_completed_at: "2026-09-10T12:31:00Z",
    check_names: ["comment-load-ratchet"],
    local_gate_exit: 0,
  });
  const disposed = result.appended.find((line) => line.step === "sweep.disposed" && line.pr_number === 4938);
  assert.equal(disposed?.acted, false);
  assert.match(String(disposed?.stand_down_reason), /close\/reopen event emitted once/);
});

test("W1-T3331 criterion 2: a stale PR whose local merge still fails is not refired", async () => {
  const result = await sweep([pr(), sibling()], {
    proof: { passed: false, reason: "comment-load-ratchet still fails on merged tree", localGateExit: 1 },
  });

  assert.deepEqual(result.proofed, [4938, 4950]);
  assert.deepEqual(result.refired, []);
  assert.deepEqual(result.dispatched, [], "base-caused red still stands down instead of spending a strike");
  assert.equal(result.appended.some((line) => line.step === FIXED_MAIN_REFIRE_STEP), false);
});

test("W1-T3331 criterion 3: the same PR is not refired twice against the same main tip", async () => {
  const first = await sweep([pr()]);
  const second = await sweep([pr()], { prior: first.appended });

  assert.deepEqual(first.refired, [4938]);
  assert.deepEqual(second.proofed, [], "a prior fixed-main refire skips even the local proof");
  assert.deepEqual(second.refired, []);
});

test("W1-T3331 in-flight control: a PR with a queued or running check is left untouched", () => {
  const decision = fixedMainRefireDecision(
    { ...pr(), inFlightCheckNames: ["comment-load-ratchet"] },
    MAIN,
    new Set(),
  );

  assert.equal(decision.refire, false);
  assert.match(decision.reason, /already in flight/);
});

test("W1-T3331 decision controls: post-main failures and already-refired keys are not refired", () => {
  const afterMain = fixedMainRefireDecision(
    pr({ ciFailures: [{ name: "coverage-ratchet", logTail: "still red", completedAt: "2026-09-10T12:40:00Z" }] }),
    MAIN,
    new Set(),
  );
  assert.equal(afterMain.refire, false);
  assert.match(afterMain.reason, /not before main/);

  const duplicate = fixedMainRefireDecision(pr(), MAIN, new Set([`4938@${MAIN.sha}`]));
  assert.deepEqual(duplicate, {
    refire: false,
    reason: `already refired PR #4938 against main ${MAIN.sha}`,
    key: `4938@${MAIN.sha}`,
    mainTipSha: MAIN.sha,
    mainTipCommittedAt: MAIN.committedAt,
    staleFailureCompletedAt: "2026-09-10T12:31:00Z",
    checkNames: ["comment-load-ratchet"],
  });
});

test("W1-T3331 proof helper: local merge runs every named stale gate and cleans up the worktree", () => {
  const { calls, git } = fakeGit();
  const scriptsRead: string[] = [];
  const scriptsRun: Array<{ script: string; cwd: string }> = [];
  const added: Array<{ repoDir: string; worktreePath: string; branch: string; base?: string }> = [];
  const removed: string[] = [];
  const proof = proveFixedMainBlockerViaLocalMerge(
    "/repo",
    "/tmp/fixed-main-refire-4938",
    pr(),
    FIXED_MAIN_DECISION,
    {
      git,
      worktreeAddImpl: (repoDir, worktreePath, branch, base) => {
        added.push({ repoDir, worktreePath, branch, base });
      },
      readPackageScripts: (worktreePath) => {
        scriptsRead.push(worktreePath);
        return { "comment-load-ratchet": "node scripts/comment-load-ratchet.mjs" };
      },
      runScript: (script, cwd) => {
        scriptsRun.push({ script, cwd });
        return { status: 0, stdout: "OK", stderr: "" };
      },
      worktreeRemoveImpl: (_repoDir, worktreePath) => { removed.push(worktreePath); },
    },
  );

  assert.deepEqual(proof, {
    passed: true,
    reason: "every stale failing gate passed on the local merge with main",
    localGateExit: 0,
  });
  assert.deepEqual(calls.map((argv) => argv[2]), ["fetch", "rev-parse", "merge", "branch"]);
  assert.deepEqual(added, [{
    repoDir: "/repo",
    worktreePath: "/tmp/fixed-main-refire-4938",
    branch: "fixed-main-refire-4938",
    base: "head-4938",
  }]);
  assert.deepEqual(scriptsRead, ["/tmp/fixed-main-refire-4938"]);
  assert.deepEqual(scriptsRun, [{ script: "comment-load-ratchet", cwd: "/tmp/fixed-main-refire-4938" }]);
  assert.deepEqual(removed, ["/tmp/fixed-main-refire-4938"]);
});

test("W1-T3331 proof helper: unsafe or still-red local proofs decline with named reasons", () => {
  const noDecision = proveFixedMainBlockerViaLocalMerge("/repo", "/tmp/wt", pr(), { refire: false, reason: "no" }, {
    git: fakeGit().git,
    readPackageScripts: () => ({}),
    runScript: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  assert.match(noDecision.reason, /did not name any failing check/);

  const noHead = proveFixedMainBlockerViaLocalMerge("/repo", "/tmp/wt", pr({ headRefName: "" }), FIXED_MAIN_DECISION, {
    git: fakeGit().git,
    readPackageScripts: () => ({}),
    runScript: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  assert.match(noHead.reason, /no head branch/);

  const moved = proveFixedMainBlockerViaLocalMerge("/repo", "/tmp/wt", pr(), FIXED_MAIN_DECISION, {
    git: fakeGit({ observedHead: "new-head" }).git,
    readPackageScripts: () => ({}),
    runScript: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  assert.match(moved.reason, /moved from head-4938 to new-head/);

  const mergeFailed = proveFixedMainBlockerViaLocalMerge("/repo", "/tmp/wt", pr(), FIXED_MAIN_DECISION, {
    git: fakeGit({ throwOn: "merge" }).git,
    worktreeAddImpl: () => {},
    readPackageScripts: () => ({}),
    runScript: () => ({ status: 0, stdout: "", stderr: "" }),
    worktreeRemoveImpl: () => {},
  });
  assert.match(mergeFailed.reason, /local merge with main failed/);

  const missingScript = proveFixedMainBlockerViaLocalMerge("/repo", "/tmp/wt", pr(), FIXED_MAIN_DECISION, {
    git: fakeGit().git,
    worktreeAddImpl: () => {},
    readPackageScripts: () => ({}),
    runScript: () => ({ status: 0, stdout: "", stderr: "" }),
    worktreeRemoveImpl: () => {},
  });
  assert.match(missingScript.reason, /no script named comment-load-ratchet/);

  const stillFails = proveFixedMainBlockerViaLocalMerge("/repo", "/tmp/wt", pr(), FIXED_MAIN_DECISION, {
    git: fakeGit().git,
    worktreeAddImpl: () => {},
    readPackageScripts: () => ({ "comment-load-ratchet": "node scripts/comment-load-ratchet.mjs" }),
    runScript: () => ({ status: 1, stdout: "fixture expired", stderr: "blocked" }),
    worktreeRemoveImpl: () => {
      throw new Error("cleanup refused");
    },
  });
  assert.equal(stillFails.localGateExit, 1);
  assert.match(stillFails.reason, /comment-load-ratchet still fails/);

  const outerFailure = proveFixedMainBlockerViaLocalMerge("/repo", "/tmp/wt", pr(), FIXED_MAIN_DECISION, {
    git: fakeGit({ throwOn: "fetch" }).git,
    readPackageScripts: () => ({}),
    runScript: () => ({ status: 0, stdout: "", stderr: "" }),
  });
  assert.match(outerFailure.reason, /fetch exploded/);
});

test("W1-T3331 effect wiring: default proof, refire, and main-tip readers carry real evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-fixed-main-effects-"));
  const ghCalls: string[][] = [];
  const logs: Record<string, unknown>[] = [];
  const { git } = fakeGit();
  try {
    const effects = buildSweepEffects(baseDeps(root, {
      fixedMainProofGitImpl: git,
      fixedMainProofWorktreeAddImpl: () => {},
      readPackageScriptsImpl: () => ({ "comment-load-ratchet": "node scripts/comment-load-ratchet.mjs" }),
      runNpmScriptImpl: (script, cwd) => ({ status: 0, stdout: `${script} in ${cwd}`, stderr: "" }),
      worktreeRemoveImpl: () => {},
      ghRunImpl: (_cmd, args) => {
        ghCalls.push([...args]);
        return "";
      },
      log: (step, extra) => { logs.push({ step, ...extra }); },
      readJsonImpl: async () => ({
        sha: MAIN.sha,
        commit: { committer: { date: MAIN.committedAt } },
      }),
    }));

    assert.deepEqual(await effects.readMainTip!(), MAIN);
    const proof = await effects.proveFixedMainBlocker!(pr(), FIXED_MAIN_DECISION);
    if (proof.passed !== true) throw new Error("expected the default proof to pass");
    assert.equal(await effects.refireFixedMainPr!(pr(), FIXED_MAIN_DECISION, proof), true);

    assert.deepEqual(ghCalls, [
      [
        "pr",
        "close",
        "https://github.com/craigoley/remudero/pull/4938",
        "--comment",
        `Temporarily closed by rmd sweep to refire checks after main ${MAIN.sha} fixed comment-load-ratchet.`,
      ],
      ["pr", "reopen", "https://github.com/craigoley/remudero/pull/4938"],
    ]);
    assert.deepEqual(logs[0], {
      step: "sweep.fixed_main_refire.dispatched",
      pr_number: 4938,
      head_sha: "head-4938",
      main_tip_sha: MAIN.sha,
      stale_failure_completed_at: "2026-09-10T12:31:00Z",
      check_names: ["comment-load-ratchet"],
      local_gate_exit: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3331 effect wiring: injected proof and refire overrides remain reachable", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-fixed-main-overrides-"));
  try {
    const proofed: number[] = [];
    const refired: number[] = [];
    const effects = buildSweepEffects(baseDeps(root, {
      proveFixedMainBlockerImpl: async (candidate) => {
        proofed.push(candidate.prNumber);
        return { passed: true, reason: "override proof", localGateExit: 0 };
      },
      refireFixedMainPrImpl: async (candidate) => {
        refired.push(candidate.prNumber);
        return true;
      },
    }));

    const proof = await effects.proveFixedMainBlocker!(pr(), FIXED_MAIN_DECISION);
    if (proof.passed !== true) throw new Error("expected the override proof to pass");
    assert.deepEqual(proofed, [4938]);
    assert.equal(proof.reason, "override proof");
    assert.equal(await effects.refireFixedMainPr!(pr(), FIXED_MAIN_DECISION, proof), true);
    assert.deepEqual(refired, [4938]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
