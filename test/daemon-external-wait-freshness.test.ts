import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon, type DaemonDeps, type DaemonFreshness, type DaemonSummary } from "../src/lib/daemon.js";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";
import type { DispatchClaimReserver } from "../src/lib/dispatch-claim.js";
import { daemonCommand, runTask, waitForCiGreen, type PollDeps } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";
import { ghShim } from "./helpers/gh-shim.js";

const PR_URL = "https://github.com/acme/remudero/pull/1";
const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const HEAD_SHA = "c".repeat(40);
const STALE: Extract<DaemonFreshness, { stale: true }> = { stale: true, oldSha: OLD_SHA, newSha: NEW_SHA };

function pendingPollDeps(): PollDeps {
  return {
    readJson: async (args) => {
      const request = args.join(" ");
      if (request.includes("/pulls/1")) {
        return { number: 1, state: "open", merged: false, merged_at: null, head: { sha: HEAD_SHA } };
      }
      if (request.includes("/check-runs")) return { check_runs: [{ name: "ci", status: "queued" }] };
      if (request.includes("/status")) return { statuses: [] };
      throw new Error(`unexpected REST request: ${request}`);
    },
    sleep: async () => assert.fail("a freshness handoff must return before a second CI poll sleeps"),
    requiredContexts: () => ["ci"],
  };
}

test("W1-T3793: a stale daemon yields an external CI wait", async () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let freshnessCalls = 0;
  const outcome = await waitForCiGreen(PR_URL, (step, extra) => logs.push({ step, extra }), 0, {
    ...pendingPollDeps(),
    externalWaitFreshness: () => {
      freshnessCalls++;
      return STALE;
    },
  });

  assert.equal(outcome.state, "freshness_handoff");
  assert.equal(outcome.sha, HEAD_SHA, "the handoff stays pinned to the already-read CI head");
  assert.equal(outcome.oldSha, OLD_SHA);
  assert.equal(outcome.newSha, NEW_SHA);
  assert.equal(freshnessCalls, 1, "the daemon-only callback is sampled once at the stable wait boundary");
  const awaiting = logs.findIndex((entry) => entry.step === "run.awaiting_external");
  const handoff = logs.findIndex((entry) => entry.step === "run.freshness_handoff");
  assert.ok(awaiting >= 0 && handoff > awaiting, "the durable external-wait record precedes the voluntary handoff");
  assert.deepEqual(logs[handoff]?.extra, {
    waiting_on: "ci",
    head_sha: HEAD_SHA,
    old_sha: OLD_SHA,
    new_sha: NEW_SHA,
  });
  assert.equal(logs.some((entry) => entry.step === "ci.polling"), false, "no further CI poll starts after the handoff");
});

test("W1-T3793: a live worker keeps the freshness boundary deferred", async () => {
  const plan = fixturePlan();
  const order: string[] = [];
  let workerStarted!: () => void;
  let finishWorker!: () => void;
  const started = new Promise<void>((resolve) => {
    workerStarted = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finishWorker = resolve;
  });
  let stale = false;
  const daemon = runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async (taskId) => {
      order.push("worker:start");
      stale = true;
      workerStarted();
      await finished;
      order.push("worker:end");
      return { taskId, runId: `${taskId}-run`, merged: true, costUsd: 0, verdict: "merged" };
    },
    sleep: async () => {},
    log: (step) => order.push(`log:${step}`),
    checkFreshness: () => (stale ? STALE : { stale: false }),
  });

  await started;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    order.includes("log:daemon_selfrestart_for_freshness"),
    false,
    "the stale reading cannot restart the daemon while an admitted worker is live",
  );
  finishWorker();
  const summary = await daemon;
  assert.equal(summary.stopReason, "stale", "once the live worker settles, the existing daemon freshness path runs");
  assert.ok(order.indexOf("worker:end") < order.indexOf("log:daemon_selfrestart_for_freshness"));
});

const PLAN_YAML = [
  "- id: T-FRESHNESS-HANDOFF",
  "  title: external CI handoff fixture",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/run-task.ts]",
  "  origin: test",
  "  status: queued",
  "",
].join("\n");

function fixturePlan(): Plan {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}daemon-external-wait-plan-`));
  const path = join(root, "tasks.yaml");
  writeFileSync(path, PLAN_YAML);
  return loadPlan(path);
}

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

function workerResult(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "test-session",
    costUsd: 0,
    numTurns: 0,
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

function writeOfflineGitFixture(root: string): { advanceOrigin: () => void; cleanup: () => void } {
  const origin = gitRepo({ bare: true, kind: "freshness-handoff-origin" });
  const seed = gitRepo({ seedCommit: false, kind: "freshness-handoff-seed" });
  seed.addRemote("origin", origin.dir);
  const repo = join(root, "repos", "remudero");
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "-u", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
  return {
    advanceOrigin: () => {
      mkdirSync(join(seed.dir, "src"), { recursive: true });
      writeFileSync(join(seed.dir, "src", "freshness.ts"), "export const fresh = true;\n");
      seed.git("add", "-A");
      seed.git("commit", "-q", "-m", "advance source for freshness handoff");
      seed.git("push", "-q", "origin", "main");
    },
    cleanup: () => {
      origin.cleanup();
      seed.cleanup();
    },
  };
}

function writePendingGateGh(branch: string) {
  return ghShim(
    [
      { when: "pr view", stdout: JSON.stringify({ headRefName: branch, body: "" }) },
      { when: "/pulls/", stdout: JSON.stringify({ number: 1, state: "open", merged: false, merged_at: null, head: { sha: HEAD_SHA } }) },
      { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "queued" }] }) },
      { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
    ],
    { kind: "freshness-handoff" },
  );
}

const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 });

const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 });

test("W1-T3793: external wait handoff releases claims with freshness evidence", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}daemon-external-wait-root-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, PLAN_YAML);
  const cleanupGit = writeOfflineGitFixture(root);
  const fixedTime = 1789842000000;
  const branch = `run-T-FRESHNESS-HANDOFF-${fixedTime}`;
  const gh = writePendingGateGh(branch);
  const previousPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${previousPath}`;
  const now = t.mock.method(Date, "now", () => fixedTime);
  const calls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    calls.push(args);
    return calls.length === 1
      ? workerResult({ text: "RECON REPORT\nOBSERVED: fixture\n" })
      : workerResult({ text: `REPORT\nPR_URL: ${PR_URL}\n` });
  };
  const drops: Array<{ taskId: string; expect?: string }> = [];
  const claimReserver: DispatchClaimReserver = {
    mintAnchor: () => "freshness-handoff-anchor",
    attempt: () => "created",
    holder: () => undefined,
    drop: (taskId, options) => {
      drops.push({ taskId, expect: options?.expect });
      return options?.expect === "freshness-handoff-anchor";
    },
  };

  try {
    const config: Config = { claudeBin: "/bin/true", root };
    const result = await withLiveWritesAllowed(() =>
      runTask("T-FRESHNESS-HANDOFF", {
        skipGitSync: true,
        planPath,
        config,
        github: OFFLINE_GITHUB,
        spawn,
        claimReserver,
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
        externalWaitFreshness: () => STALE,
      }),
    );
    assert.equal(result.verdict, "blocked_transient", "the run returns a retryable named outcome, not a CI failure");
    assert.equal(result.prUrl, PR_URL);
    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const awaiting = ledger.findIndex((line) => line.step === "run.awaiting_external");
    const handoff = ledger.findIndex((line) => line.step === "run.freshness_handoff");
    assert.ok(awaiting >= 0 && handoff > awaiting, "the handoff cannot precede the retained external-wait entry");
    assert.deepEqual(
      {
        old_sha: ledger[handoff]?.old_sha,
        new_sha: ledger[handoff]?.new_sha,
        head_sha: ledger[handoff]?.head_sha,
      },
      { old_sha: OLD_SHA, new_sha: NEW_SHA, head_sha: HEAD_SHA },
      "the handoff ledger record carries both freshness revisions and the CI head it leaves for the next daemon",
    );
    assert.equal(ledger.some((line) => line.step === "verdict" && line.verdict === "blocked_transient"), true);
    assert.equal(
      ledger.some((line) => line.step === "dispatch.claim_released" && line.dropped === true),
      true,
      "the normal runTask finally releases its cross-host claim on the voluntary handoff",
    );
    assert.equal(existsSync(join(root, "state", "inflight", "T-FRESHNESS-HANDOFF.lock")), false, "runTask's ordinary inflight lock is released");
    assert.deepEqual(drops, [{ taskId: "T-FRESHNESS-HANDOFF", expect: "freshness-handoff-anchor" }]);
  } finally {
    now.mock.restore();
    process.env.PATH = previousPath;
    rmSync(gh.dir, { recursive: true, force: true });
    cleanupGit.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("DAEMON WIRING: the production runOne supplies a material freshness handoff only after an origin advance", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}daemon-external-wait-daemon-root-`));
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}daemon-external-wait-daemon-home-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, PLAN_YAML);
  const cleanupGit = writeOfflineGitFixture(root);
  const repoRoot = join(root, "repos", "remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const previousCi = process.env.CI;
  const previousGithubActions = process.env.GITHUB_ACTIONS;
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;

  try {
    let captured: DaemonDeps | undefined;
    let forwarded: Parameters<typeof runTask>[1] | undefined;
    const code = await daemonCommand(["--repo", "acme/remudero", "--plan", planPath, "--max", "0"], {
      repoRoot,
      githubFactory: () => OFFLINE_GITHUB,
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
      runTask: async (taskId, options) => {
        forwarded = options;
        return { taskId, runId: "freshness-handoff-test", merged: false, costUsd: 0, verdict: "blocked_transient" };
      },
    });
    assert.equal(code, 0, "the composition root reaches the injected daemon loop");
    assert.ok(captured, "the composition root supplies its real runOne closure");
    const oldSha = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    cleanupGit.advanceOrigin();
    const newSha = execFileSync("git", ["-C", repoRoot, "ls-remote", "origin", "refs/heads/main"], { encoding: "utf8" })
      .trim()
      .split(/\s+/)[0];
    const result = await captured.runOne("T-FRESHNESS-HANDOFF");
    assert.equal(result.verdict, "blocked_transient");
    assert.ok(forwarded, "the daemon runOne invokes its configured runTask implementation");
    const freshness = forwarded.externalWaitFreshness?.();
    assert.deepEqual(freshness, { stale: true, oldSha, newSha }, "only a clean material origin advance crosses the daemon handoff boundary");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousGithubActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = previousGithubActions;
    cleanupGit.cleanup();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
