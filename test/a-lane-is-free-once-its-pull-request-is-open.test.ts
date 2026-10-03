import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { DispatchClaimReserver } from "../src/lib/dispatch-claim.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { GitHub } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";
// A NAMESPACE import, read inside each test: at a base without this task's exports the file still
// LOADS and every test fails on its own assertion, so the proof discriminates instead of erroring.
import * as runTaskModule from "../src/run-task.js";
import { ciGateState, daemonCommand, runTask, waitForCiGreen, type PollDeps } from "../src/run-task.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import { gitRepo } from "./helpers/git-repo.js";
import { ghShim } from "./helpers/gh-shim.js";

/**
 * W1-T5345 — A LANE IS FREE ONCE ITS PULL REQUEST IS OPEN.
 *
 * MEASURED 2026-10-02: pr.opened -> verdict was 36.7% of all busy implement-lane time (two dispatch
 * lanes, mean slot 37.1 min). The CI wait and the in-run review it precedes are work the sweep
 * already owns for every open PR, and `handed_off` already lets a run leave its PR to it. The
 * daemon's lanes now hand off at the FIRST CI poll; `rmd run-task` by hand and `rmd drain` keep
 * today's in-lane wait, and a run with no pull request never reaches the wait at all.
 */

const PR_URL = "https://github.com/acme/remudero/pull/1";
const HEAD_SHA = "c".repeat(40);

// ── pure path: the CI wait itself ─────────────────────────────────────────────────────────────

function pendingCi(polls: { count: number }, over: Partial<PollDeps> = {}): PollDeps {
  return {
    readJson: async (args) => {
      const request = args.join(" ");
      if (request.includes("/pulls/1")) {
        polls.count++;
        return { number: 1, state: "open", merged: false, merged_at: null, head: { sha: HEAD_SHA } };
      }
      if (request.includes("/check-runs")) {
        return { check_runs: [{ name: "ci", status: polls.count >= 2 ? "completed" : "queued", conclusion: polls.count >= 2 ? "success" : null }] };
      }
      if (request.includes("/status")) return { statuses: [] };
      throw new Error(`unexpected REST request: ${request}`);
    },
    sleep: async () => {},
    requiredContexts: () => ["ci"],
    ...over,
  };
}

test("W1-T5345: with handOffAtPrOpen the CI wait yields on its first poll, after run.awaiting_external, with a pr_open row", async () => {
  const polls = { count: 0 };
  const steps: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const outcome = await waitForCiGreen(PR_URL, (step, extra) => steps.push({ step, extra }), 0, pendingCi(polls, { handOffAtPrOpen: true }));
  assert.equal(ciGateState(outcome), "freshness_handoff");
  assert.equal(polls.count, 1, "the yield is taken on the very first poll, never after a CI cycle");
  assert.equal((outcome as { trigger?: string }).trigger, "pr_open");
  const names = steps.map((s) => s.step);
  assert.ok(names.indexOf("run.awaiting_external") >= 0, "the external-wait record is retained");
  assert.ok(names.indexOf("run.awaiting_external") < names.indexOf("run.freshness_handoff"), "W1-T3793 order: record the wait, then yield");
  const handoff = steps.find((s) => s.step === "run.freshness_handoff");
  assert.equal(handoff?.extra?.trigger, "pr_open");
  assert.equal(handoff?.extra?.waiting_on, "ci");
  assert.equal(handoff?.extra?.head_sha, HEAD_SHA);
  const named = runTaskModule.PR_OPEN_HANDOFF_STEP_OWNERS.filter((s) => s.owner.kind === "in_run_only").map((s) => s.step);
  assert.deepEqual(handoff?.extra?.in_run_only_skipped, named, "every in-run-only step the hand-off skips is NAMED on its row");
});

test("W1-T5345: without handOffAtPrOpen the CI wait polls on to green, unchanged", async () => {
  const polls = { count: 0 };
  const steps: string[] = [];
  const outcome = await waitForCiGreen(PR_URL, (step) => steps.push(step), 0, pendingCi(polls));
  assert.equal(ciGateState(outcome), "green");
  assert.equal(polls.count, 2);
  assert.ok(!steps.includes("run.freshness_handoff"));
});

// ── the post-CI inventory (design 2): every step has an owner, or the yield is declined ───────

test("W1-T5345: every step the in-run path does after CI green has a named owner once the run hands off", () => {
  const steps = runTaskModule.PR_OPEN_HANDOFF_STEP_OWNERS.map((s) => s.step);
  for (const required of ["review_post", "fix_rung", "capped_arm_refusal", "automerge_arm", "risk_judge", "follow_up_harvest", "task_credit_trailer", "irreversible_arm_refusal", "no_merge_boundary", "shadow_instance_arm_refusal"]) {
    assert.ok(steps.includes(required), `${required} is inventoried`);
  }
  assert.equal(new Set(steps).size, steps.length, "no step is listed twice");
  for (const entry of runTaskModule.PR_OPEN_HANDOFF_STEP_OWNERS) {
    const owner = entry.owner;
    if (owner.kind === "declined") {
      assert.ok(owner.reason.length > 0, `${entry.step}: a declined step names its run.handoff_declined reason`);
    } else {
      assert.ok(owner.by.length > 0, `${entry.step}: names the code that owns it`);
    }
  }
  const byStep = new Map(runTaskModule.PR_OPEN_HANDOFF_STEP_OWNERS.map((s) => [s.step, s.owner.kind]));
  assert.equal(byStep.get("review_post"), "sweep");
  assert.equal(byStep.get("fix_rung"), "sweep", "the fix rung still applies — the sweep's");
  assert.equal(byStep.get("follow_up_harvest"), "before_yield");
  assert.equal(byStep.get("task_credit_trailer"), "before_yield");
  assert.equal(byStep.get("risk_judge"), "sweep", "W1-T5403: the sweep judges a handed-off head before arming it");
});

test("W1-T5345: a run whose post-CI gate has no sweep-side owner declines the hand-off by name", () => {
  const clean = { irreversible: false, noMerge: false, shadowInstance: false };
  assert.equal(runTaskModule.prOpenHandoffDecline(clean), undefined);
  assert.equal(runTaskModule.prOpenHandoffDecline({ ...clean, irreversible: true }), "irreversible_diff");
  assert.equal(runTaskModule.prOpenHandoffDecline({ ...clean, noMerge: true }), "no_merge_boundary");
  assert.equal(runTaskModule.prOpenHandoffDecline({ ...clean, shadowInstance: true }), "shadow_instance");
  const declinedReasons = runTaskModule.PR_OPEN_HANDOFF_STEP_OWNERS.flatMap((s) => (s.owner.kind === "declined" ? [s.owner.reason] : []));
  assert.deepEqual([...declinedReasons].sort(), ["irreversible_diff", "no_merge_boundary", "shadow_instance"]);
});

// ── the whole run ─────────────────────────────────────────────────────────────────────────────

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

const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 });

const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 });

const RED_CI = JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] });

interface RunOutcome {
  verdict: string | undefined;
  prUrl: string | undefined;
  ledger: Record<string, unknown>[];
  ciPolls: number;
}

async function runFixture(
  t: { mock: { method: (obj: object, name: string, impl: () => number) => { mock: { restore: () => void } } } },
  opts: { handOffAtPrOpen?: boolean; noMerge?: boolean; workerReportsPr?: boolean },
): Promise<RunOutcome> {
  const taskId = "T-PR-OPEN-HANDOFF";
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}pr-open-handoff-root-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(
    planPath,
    [`- id: ${taskId}`, "  title: pr open handoff fixture", "  repo: remudero", "  type: implement", "  verify: auto", "  risk: medium", "  files: [src/run-task.ts]", "  origin: test", "  status: queued", ""].join("\n"),
  );
  const origin = gitRepo({ bare: true, kind: "pr-open-handoff-origin" });
  const seed = gitRepo({ seedCommit: false, kind: "pr-open-handoff-seed" });
  seed.addRemote("origin", origin.dir);
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "-u", "origin", "main");
  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "test"]);

  const fixedTime = 1789842000000;
  const branch = `run-${taskId}-${fixedTime}`;
  // `ci` is queued until the run's per-poll recycle check (first reached AFTER poll 1's rollup read)
  // turns it red — so a run that waits in-lane ends `blocked_ci` after exactly one poll interval,
  // and one that hands off on poll 1 never reaches that check at all.
  const gh = ghShim(
    [
      { when: "pr view", stdout: JSON.stringify({ headRefName: branch, body: "" }) },
      { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "queued" }] }) },
      { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
      { when: "/pulls/", stdout: JSON.stringify({ number: 1, state: "open", merged: false, merged_at: null, head: { sha: HEAD_SHA } }) },
    ],
    { kind: "pr-open-handoff" },
  );
  let ciTurnedRed = false;
  const previousPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${previousPath}`;
  const now = t.mock.method(Date, "now", () => fixedTime);
  const calls: SpawnWorkerArgs[] = [];
  const spawn: typeof spawnWorker = async (args) => {
    calls.push(args);
    if (calls.length === 1) return workerResult({ text: "RECON REPORT\nOBSERVED: fixture\n" });
    return workerResult({ text: opts.workerReportsPr === false ? "REPORT\nno pull request\n" : `REPORT\nPR_URL: ${PR_URL}\n` });
  };
  const claimReserver: DispatchClaimReserver = { mintAnchor: () => "pr-open-handoff-anchor", attempt: () => "created", holder: () => undefined, drop: () => true };
  try {
    const config: Config = { claudeBin: "/bin/true", root, installRoot: process.cwd() };
    const result = await withLiveWritesAllowed(() =>
      runTask(taskId, {
        skipGitSync: true,
        planPath,
        config,
        github: OFFLINE_GITHUB,
        spawn,
        claimReserver,
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
        externalWaitFreshness: () => undefined,
        externalWaitRecycle: () => {
          if (!ciTurnedRed) gh.addRoute({ when: "/check-runs", stdout: RED_CI });
          ciTurnedRed = true;
          return undefined;
        },
        ...(opts.handOffAtPrOpen !== undefined ? { handOffAtPrOpen: opts.handOffAtPrOpen } : {}),
        ...(opts.noMerge ? { noMerge: true } : {}),
      }),
    );
    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const ciPolls = gh.calls().filter((call) => call.includes("/check-runs")).length;
    return { verdict: result.verdict, prUrl: result.prUrl, ledger, ciPolls };
  } finally {
    now.mock.restore();
    process.env.PATH = previousPath;
    rmSync(gh.dir, { recursive: true, force: true });
    origin.cleanup();
    seed.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}

const verdictRow = (ledger: Record<string, unknown>[]) => ledger.find((line) => line.step === "verdict");
const prOpenRows = (ledger: Record<string, unknown>[]) => ledger.filter((line) => line.step === "run.freshness_handoff" && line.trigger === "pr_open");

test("W1-T5345: with the PR-open handoff on, a run that opened its PR ends handed_off (pr_open_yield) on the first CI poll", async (t) => {
  const run = await runFixture(t, { handOffAtPrOpen: true });
  assert.equal(run.verdict, "handed_off", "the lane is given back at PR open");
  assert.equal(run.prUrl, PR_URL, "the hand-off carries the PR it left open for the sweep");
  assert.equal(run.ciPolls, 1, "it yielded on the first poll — it never waited a CI cycle");
  const row = verdictRow(run.ledger);
  assert.equal(row?.verdict, "handed_off");
  assert.equal(row?.reason, "pr_open_yield");
  assert.equal(row?.pr_url, PR_URL);
  assert.equal(row?.head_sha, HEAD_SHA);
  assert.equal(prOpenRows(run.ledger).length, 1, "exactly one pr_open freshness_handoff row");
  assert.ok(!run.ledger.some((line) => line.step === "review.posted"), "the run posts no review of its own — the sweep owns it");
  assert.ok(!run.ledger.some((line) => line.step === "run.handoff_declined"));
});

test("W1-T5345: with the option off the run still waits for CI in-lane", async (t) => {
  const run = await runFixture(t, {});
  assert.equal(run.verdict, "blocked_ci", "today's in-run wait: it polled on and saw CI go red itself");
  assert.equal(run.ciPolls, 2, "it waited past the first poll");
  assert.equal(prOpenRows(run.ledger).length, 0, "no pr_open row without the option");
});

test("W1-T5345: a run whose post-CI gate the sweep cannot own declines the hand-off by name and waits in-lane", async (t) => {
  const run = await runFixture(t, { handOffAtPrOpen: true, noMerge: true });
  const declined = run.ledger.find((line) => line.step === "run.handoff_declined");
  assert.equal(declined?.reason, "no_merge_boundary", "the decline is ledgered, never silent");
  assert.equal(declined?.trigger, "pr_open");
  assert.equal(run.verdict, "blocked_ci");
  assert.equal(run.ciPolls, 2);
  assert.equal(prOpenRows(run.ledger).length, 0);
});

test("W1-T5345: a run with no pull request never hands off", async (t) => {
  const run = await runFixture(t, { handOffAtPrOpen: true, workerReportsPr: false });
  assert.notEqual(run.verdict, "handed_off");
  assert.equal(run.prUrl, undefined);
  assert.equal(run.ciPolls, 0, "no PR, no CI wait");
  assert.equal(prOpenRows(run.ledger).length, 0);
  assert.ok(!run.ledger.some((line) => line.step === "run.awaiting_external"));
});

test("W1-T5345: the daemon's production runOne turns the PR-open handoff on", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}pr-open-handoff-daemon-root-`));
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}pr-open-handoff-daemon-home-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, ["- id: T-PR-OPEN-DAEMON", "  title: daemon wiring fixture", "  repo: remudero", "  type: implement", "  verify: auto", "  risk: medium", "  files: [src/run-task.ts]", "  origin: test", "  status: queued", ""].join("\n"));
  const origin = gitRepo({ bare: true, kind: "pr-open-handoff-daemon-origin" });
  const seed = gitRepo({ seedCommit: false, kind: "pr-open-handoff-daemon-seed" });
  seed.addRemote("origin", origin.dir);
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "-u", "origin", "main");
  const repoRoot = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, repoRoot]);
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const previous = { HOME: process.env.HOME, CI: process.env.CI, GITHUB_ACTIONS: process.env.GITHUB_ACTIONS };
  process.env.HOME = home;
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
        return { taskId, runId: "pr-open-daemon", merged: false, costUsd: 0, verdict: "handed_off" };
      },
    });
    assert.equal(code, 0);
    assert.ok(captured, "the composition root supplies its real runOne closure");
    await captured.runOne("T-PR-OPEN-DAEMON");
    assert.equal(forwarded?.handOffAtPrOpen, true, "a daemon lane is given back at PR open");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    origin.cleanup();
    seed.cleanup();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
