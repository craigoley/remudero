// test/a-run-that-throws-writes-no-verdict.test.ts — W1-T4655: a run whose body throws after the
// implement worker returned used to ledger only `run.error` and rethrow, so 96 fleet runs between
// 2026-09-24 and 2026-09-28 ended with no terminal `verdict` row at all. Each test below drives the
// REAL runTask/runTaskBody against a real local git origin and asserts the run now writes exactly
// one harness-cause verdict before the SAME error still reaches the caller.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runErrorCause, runTask, runTaskBody, type RunTaskContext } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { loadPlan } from "../src/lib/plan.js";
import { latestIndependentFailureBlock, type GitHub } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { SubscriptionOnlyRefusedError, type WorkerResult, type spawnWorker } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TASK_ID = "T-THROWN-VERDICT";

const FIXTURE_PLAN = [
  `- id: ${TASK_ID}`,
  "  title: a run that throws still ends with a verdict",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: test",
  "  status: queued",
  "",
].join("\n");

/** The pre-push refusal text the census hook really prints (fleet ledger, 2026-09-2x). */
const CENSUS_REFUSAL = [
  "census-precheck: this branch grows 1 census count(s) CI will refuse:",
  "  clock-signature: src/lib/serve.ts dateNow 3 > baseline 2 — move it onto the Clock port",
].join("\n");

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 });

const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 });

function workerResult(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "test-session",
    costUsd: 0.02,
    numTurns: 1,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "test",
    effort: "test",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

/** A bare origin, a seed that carries the plan, and the clone runTask works from. */
function buildFixture(opts: { censusHook?: boolean } = {}): { root: string; planPath: string; config: Config; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}thrown-verdict-root-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FIXTURE_PLAN);
  const origin = gitRepo({ bare: true, kind: "thrown-verdict-origin" });
  const seed = gitRepo({ cloneFrom: origin.dir, kind: "thrown-verdict-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  mkdirSync(join(seed.dir, "plan"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), FIXTURE_PLAN);
  if (opts.censusHook) {
    // A TRACKED hooks/pre-push, which worktreeAdd's `core.hooksPath hooks` runs — the fleet's census
    // path. Only the run BRANCH is refused; the dispatch-claim ref push must still land.
    mkdirSync(join(seed.dir, "hooks"), { recursive: true });
    const lines = CENSUS_REFUSAL.split("\n").map((l) => `  echo '${l}' >&2`);
    const hook = join(seed.dir, "hooks", "pre-push");
    writeFileSync(hook, ["#!/bin/sh", "if grep -q ' refs/heads/run-'; then", ...lines, "  exit 1", "fi", "exit 0", ""].join("\n"));
    chmodSync(hook, 0o755);
  }
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  const repoDir = join(root, "repos", "remudero");
  execFileSync("git", ["clone", "-q", origin.dir, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "fixture@remudero.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero test fixture"]);
  const config: Config = { claudeBin: "/bin/true", root, installRoot: process.cwd() };
  return {
    root,
    planPath,
    config,
    cleanup: () => {
      origin.cleanup();
      seed.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function readLedger(root: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Recon succeeds; implement is handed `implement` (a result, or a throw). */
function twoStepSpawn(implement: () => Promise<WorkerResult>): typeof spawnWorker {
  let calls = 0;
  return async () => {
    calls += 1;
    return calls === 1 ? workerResult({ text: "RECON REPORT\nOBSERVED: fixture\n" }) : implement();
  };
}

test("W1-T4655: a census-refused push after implement writes one run.error verdict and the error still propagates", async () => {
  const fx = buildFixture({ censusHook: true });
  try {
    let thrown: unknown;
    await withLiveWritesAllowed(() =>
      runTask(TASK_ID, {
        skipGitSync: true,
        planPath: fx.planPath,
        config: fx.config,
        github: OFFLINE_GITHUB,
        spawn: twoStepSpawn(async () => workerResult({ text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/1\n" })),
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
      }),
    ).then(
      () => assert.fail("a refused push must still reject runTask"),
      (err: unknown) => {
        thrown = err;
      },
    );
    assert.match(String((thrown as Error).message), /census-precheck: this branch grows 1 census count/);

    const ledger = readLedger(fx.root);
    assert.ok(ledger.some((row) => row.step === "implement.done"), "the implement worker returned before the throw");
    const runError = ledger.filter((row) => row.step === "run.error");
    assert.equal(runError.length, 1);
    assert.equal(runError[0]?.error, (thrown as Error).message, "the rethrown error is the one the run ledgered");
    const verdicts = ledger.filter((row) => row.step === "verdict");
    assert.equal(verdicts.length, 1, "exactly one terminal verdict row");
    const verdict = verdicts[0] ?? {};
    assert.equal(verdict.verdict, "failed");
    assert.equal(verdict.stage, "run.error");
    assert.equal(verdict.cause, "census-refused-push");
    assert.equal(verdict.run_id, runError[0]?.run_id);
    assert.match(String(verdict.reason), /census-precheck:/);
    assert.equal(typeof verdict.cost_usd, "number");
    assert.equal(verdict.model, null, "no worker outcome is read off a thrown run");
    assert.ok(ledger.indexOf(verdict) > ledger.indexOf(runError[0] ?? {}), "the verdict follows the run.error row");
  } finally {
    fx.cleanup();
  }
});

test("W1-T4655: a run whose implement step throws rejects with the SAME error object and writes one run-error verdict", async () => {
  const fx = buildFixture();
  try {
    const sentinel = new Error("fixture: implement blew up after the worker returned");
    await assert.rejects(
      withLiveWritesAllowed(() =>
        runTask(TASK_ID, {
          skipGitSync: true,
          planPath: fx.planPath,
          config: fx.config,
          github: OFFLINE_GITHUB,
          spawn: twoStepSpawn(async () => {
            throw sentinel;
          }),
          containmentExec: holdingContainmentExec,
          isolationExec: cleanIsolationExec,
        }),
      ),
      (err: unknown) => err === sentinel,
    );
    const verdicts = readLedger(fx.root).filter((row) => row.step === "verdict");
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0]?.stage, "run.error");
    assert.equal(verdicts[0]?.cause, "run-error");
  } finally {
    fx.cleanup();
  }
});

/** runTaskBody with the fixture's real repo and a recording ledger, so `log`/`say` can be made to throw. */
function bodyContext(
  fx: ReturnType<typeof buildFixture>,
  spawn: typeof spawnWorker,
  hooks: { log?: RunTaskContext["log"]; say?: RunTaskContext["say"] },
): RunTaskContext {
  const plan = loadPlan(fx.planPath);
  return {
    config: fx.config,
    fetchPrBodyFn: async () => {
      throw new Error("PR body fetch is unreachable in this fixture");
    },
    github: OFFLINE_GITHUB,
    isMerged: () => false,
    ledgerPath: join(fx.root, "state", "ledger.ndjson"),
    log: hooks.log ?? (() => {}),
    openTaskIds: new Set([TASK_ID]),
    opts: { containmentExec: holdingContainmentExec, isolationExec: cleanIsolationExec },
    owner: "acme",
    plan,
    planPath: fx.planPath,
    recordDecisionFn: () => ({ landed: false, files: [] }),
    repoRoot: REPO_ROOT,
    runId: `${TASK_ID}-1`,
    runReviewFn: async () => {
      throw new Error("review is unreachable in this fixture");
    },
    say: hooks.say ?? (() => {}),
    spawn,
    task: plan.byId.get(TASK_ID)!,
    taskId: TASK_ID,
    workerStateSensor: { observer: () => {}, startPolling: () => () => {}, setRunawayBound: () => {} },
  };
}

test("W1-T4655: a run that already wrote its verdict before throwing gets no second verdict", async () => {
  const fx = buildFixture();
  try {
    const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const sayFailure = new Error("fixture: narration failed after the verdict landed");
    const ctx = bodyContext(fx, twoStepSpawn(async () => workerResult({ text: "REPORT\nno PR this time\n" })), {
      log: (step, extra) => rows.push({ step, extra }),
      say: (message) => {
        if (message.startsWith("verdict:")) throw sayFailure;
      },
    });
    await assert.rejects(withLiveWritesAllowed(() => runTaskBody(ctx)), (err: unknown) => err === sayFailure);
    const verdicts = rows.filter((row) => row.step === "verdict");
    assert.equal(verdicts.length, 1, "the no_pr verdict is the run's only terminal row");
    assert.equal(verdicts[0]?.extra?.verdict, "no_pr");
    assert.ok(rows.some((row) => row.step === "run.error"), "the throw still took the run.error path");
  } finally {
    fx.cleanup();
  }
});

test("W1-T4655: a ledger failure on the run.error verdict never replaces the original error", async () => {
  const fx = buildFixture();
  try {
    const sentinel = new Error("fixture: the original failure");
    const rows: string[] = [];
    const ctx = bodyContext(
      fx,
      twoStepSpawn(async () => {
        throw sentinel;
      }),
      {
        log: (step, extra) => {
          if (step === "verdict" && extra?.stage === "run.error") throw new Error("fixture: ledger append failed");
          rows.push(step);
        },
      },
    );
    await assert.rejects(withLiveWritesAllowed(() => runTaskBody(ctx)), (err: unknown) => err === sentinel);
    assert.ok(rows.includes("worktree.remove"), "the worktree is still reclaimed after the failed verdict write");
  } finally {
    fx.cleanup();
  }
});

test("W1-T4655: every measured run.error shape classifies into the closed cause set", () => {
  const cases: Array<[unknown, string]> = [
    [new Error(`Command failed: git -C /w/run-W1-T1-1 push origin HEAD\n${CENSUS_REFUSAL}`), "census-refused-push"],
    [new Error("Command failed: git -C /w/run-W1-T1-1 push origin HEAD\nremote: Internal Server Error"), "git-push-failed"],
    [new Error("Command failed: git -C /w/run-W1-T1-1 commit -m fix: x\nmkdtemp-callsite-check: FAILED"), "git-commit-failed"],
    [new Error("Command failed: gh api --method POST repos/acme/remudero/pulls -f title=x -f body=y"), "pr-create-failed"],
    [new Error("Command failed: gh api repos/acme/remudero/commits/abc/check-runs?per_page=100\n"), "github-read-failed"],
    [new Error("gh api response body was unreadable"), "github-read-failed"],
    [new Error("openPullRequestChecked: W1-T1 proof did not pass against merge base (grep: x in y)"), "base-proof-refused"],
    [new SubscriptionOnlyRefusedError("opus"), "subscription-only-refused"],
    [new Error("TypeError: Cannot read properties of undefined"), "run-error"],
    ["a bare string throw", "run-error"],
  ];
  for (const [err, cause] of cases) assert.equal(runErrorCause(err), cause, String((err as Error)?.message ?? err));
});

test("W1-T4655: the new run.error verdict leaves the environmental re-offer streak where the verdict-less run left it", () => {
  const rows: Array<Record<string, unknown>> = [];
  const block = (runId: string, ts: string) =>
    rows.push(
      { task_id: TASK_ID, run_id: runId, step: "run.start", ts },
      { task_id: TASK_ID, run_id: runId, step: "verdict", verdict: "blocked_transient", ts },
      { task_id: TASK_ID, run_id: runId, step: "dispatch.blocked_independent", verdict: "blocked_transient", ts },
    );
  const thrown = (runId: string, ts: string, withVerdict: boolean) =>
    rows.push(
      { task_id: TASK_ID, run_id: runId, step: "run.start", ts },
      { task_id: TASK_ID, run_id: runId, step: "run.error", error: "boom", ts },
      ...(withVerdict ? [{ task_id: TASK_ID, run_id: runId, step: "verdict", verdict: "failed", stage: "run.error", ts }] : []),
    );
  const nowMs = Date.parse("2026-01-02T00:00:00.000Z");
  const latch = (withVerdict: boolean): boolean => {
    rows.length = 0;
    block("a", "2026-01-01T00:00:00.000Z");
    thrown("b", "2026-01-01T00:10:00.000Z", withVerdict);
    block("c", "2026-01-01T00:20:00.000Z");
    thrown("d", "2026-01-01T00:30:00.000Z", withVerdict);
    block("e", "2026-01-01T00:40:00.000Z");
    return latestIndependentFailureBlock(rows, TASK_ID, undefined, nowMs);
  };
  assert.equal(latch(false), true, "three consecutive environmental blocks stay durable (the pre-W1-T4655 ledger)");
  assert.equal(latch(true), latch(false), "the thrown runs' new verdict rows must not reset that streak");
});
