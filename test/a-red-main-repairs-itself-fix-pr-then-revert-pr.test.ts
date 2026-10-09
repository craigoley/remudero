/**
 * W1-T6403 — A RED MAIN REPAIRS ITSELF: A FIX PR FIRST, THEN A REVERT PR.
 *
 * 2026-10-08: #10092 (769d8053) merged at 12:14:49Z and turned main red — the wall-clock census
 * measured 32 files/52 sites against a recorded 33/53. Core logged `main.health.observed` red 12
 * times and repaired nothing; every open PR's CI failed the same census until a human merged #10102
 * at 12:54Z. These fixtures replay that red against the real rung: the first red merge is located
 * from main's push run history, ONE priority fix PR is opened for it, and if that PR stalls ONE
 * revert PR of the merge follows — through a fresh branch and a PR, never a push to main.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AsyncIssueGateway } from "../src/lib/escalate.js";
import type { Config } from "../src/lib/config.js";
import {
  buildMainHealthRung,
  MAIN_REPAIR_STALL_MS,
  type MainHealthRungDeps,
  type MainRepairFixRequest,
  type MainRepairLane,
  type MainRepairRevertOutcome,
  type MainRepairRevertRequest,
} from "../src/lib/main-health-rung.js";
import type { Mount } from "../src/lib/mounts.js";
import type { GhApiFetcher } from "../src/lib/open-prs-rest.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { readLedgerLines } from "../src/lib/status.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "./helpers/git-repo.js";
import { writeLedger } from "./helpers/ledger-fixture.js";
import {
  dispatchMainRepairFixRun,
  mainRepairTaskId,
  openMainRepairRevertPr,
  type AlertFixDispatchDeps,
} from "../src/run-task.js";

const OWNER = "craigoley";
const REPO = "remudero";
const HEAD = "a52dd276".padEnd(40, "0"); // main's red head, two merges after the red one
const RED_MERGE = "769d8053".padEnd(40, "0"); // #10092's merge — the first red push run
const GREEN = "5e1f0a00".padEnd(40, "0"); // main just before #10092, green
const NEXT_HEAD = "b6870e6a".padEnd(40, "0"); // a later red head of the same streak
const FIX_PR = `https://github.com/${OWNER}/${REPO}/pull/10102`;
const REVERT_PR = `https://github.com/${OWNER}/${REPO}/pull/10103`;
const CENSUS_TITLE = "a wall-clock bound declares itself";
const CENSUS_LOG = [
  "# Subtest: test/a-wall-clock-bound-declares-itself.test.ts",
  `not ok 7 - ${CENSUS_TITLE}`,
  "  error: 'measured 32 files/52 sites; recorded 33/53'",
  "  location: '/home/runner/work/remudero/test/a-wall-clock-bound-declares-itself.test.ts:88:3'",
].join("\n");

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface FakeLane extends MainRepairLane {
  fixes: MainRepairFixRequest[];
  reverts: MainRepairRevertRequest[];
}

function fakeLane(revert: () => MainRepairRevertOutcome = () => ({ prUrl: REVERT_PR })): FakeLane {
  const fixes: MainRepairFixRequest[] = [];
  const reverts: MainRepairRevertRequest[] = [];
  return {
    fixes,
    reverts,
    openFixPr: async (request) => {
      fixes.push(request);
      return FIX_PR;
    },
    openRevertPr: async (request) => {
      reverts.push(request);
      return revert();
    },
  };
}

/** Main's state as GitHub would answer it: its head, the head's `ci` verdict, and the repair PRs. */
interface World {
  head: string;
  ci: "failure" | "success";
  prs: Map<string, { state: "open" | "closed"; merged: boolean; head: string }>;
  mutations: string[][];
  /** GitHub's read of the offending commit fails, so its diff stat cannot be named. */
  commitUnreadable?: boolean;
}

function world(): World {
  return {
    head: HEAD,
    ci: "failure",
    prs: new Map([
      ["10102", { state: "open", merged: false, head: "f1x0".padEnd(40, "0") }],
      ["10103", { state: "open", merged: false, head: "7e7e".padEnd(40, "0") }],
    ]),
    mutations: [],
  };
}

function rig(w: World, lane: MainRepairLane | undefined, ledgerPath: string, overrides: Partial<MainHealthRungDeps> = {}) {
  let clock = Date.parse("2026-10-08T12:20:00Z");
  const fetch = ((args: string[]) => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (args.includes("--method")) {
      w.mutations.push(args);
      const pr = /pulls\/(\d+)$/.exec(path)?.[1];
      if (pr && args.includes("state=closed")) w.prs.get(pr)!.state = "closed";
      return {};
    }
    if (path === `repos/${OWNER}/${REPO}`) return { default_branch: "main" };
    if (path === `repos/${OWNER}/${REPO}/commits/main`) return { sha: w.head };
    if (path === `repos/${OWNER}/${REPO}/commits/${w.head}/check-runs?per_page=100`) {
      return { check_runs: [{ name: "ci", status: "completed", conclusion: w.ci }] };
    }
    if (path === `repos/${OWNER}/${REPO}/commits/${w.head}/status`) return { statuses: [] };
    if (path.startsWith(`repos/${OWNER}/${REPO}/actions/runs?`)) {
      return {
        workflow_runs: [
          { id: 3, name: "ci", head_sha: w.head, status: "completed", conclusion: w.ci },
          {
            id: 2,
            name: "ci",
            head_sha: RED_MERGE,
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/craigoley/remudero/actions/runs/2",
            pull_requests: [{ number: 10092, html_url: "https://github.com/craigoley/remudero/pull/10092" }],
          },
          { id: 1, name: "ci", head_sha: GREEN, status: "completed", conclusion: "success" },
        ],
      };
    }
    if (path === `repos/${OWNER}/${REPO}/commits/${RED_MERGE}`) {
      if (w.commitUnreadable) throw new Error("HTTP 502");
      return { files: [{ filename: "test/a-wall-clock-bound-declares-itself.test.ts", additions: 1, deletions: 1 }] };
    }
    const pull = /^repos\/craigoley\/remudero\/pulls\/(\d+)$/.exec(path)?.[1];
    if (pull && w.prs.has(pull)) {
      const pr = w.prs.get(pull)!;
      return { state: pr.state, merged: pr.merged, head: { sha: pr.head } };
    }
    throw new Error(`unrouted gh api call: ${args.join(" ")}`);
  }) as GhApiFetcher;
  const created: Array<{ title: string; body: string }> = [];
  const issues: AsyncIssueGateway = {
    create: async (title, body) => {
      created.push({ title, body });
      return `https://github.com/${OWNER}/${REPO}/issues/${10200 + created.length}`;
    },
    listOpen: async () => [],
    comment: async () => {},
    closeWithComment: async () => {},
  };
  const rung = buildMainHealthRung(OWNER, REPO, {
    fetch,
    issues,
    ledgerPath,
    runId: "DAEMON-T6403",
    log: () => {},
    now: () => clock,
    readRequiredChecks: () => ["ci"],
    readCiFailures: () => [{ name: "ci", conclusion: "FAILURE", logTail: CENSUS_LOG }],
    mergeReader: { prMerge: () => undefined, mergeBase: () => GREEN, prsMergedBetween: () => [] },
    ...(lane ? { repair: lane } : {}),
    ...overrides,
  });
  return {
    created,
    observe: async (advanceMs = 60_000) => {
      clock += advanceMs;
      await rung();
      await flush();
    },
  };
}

const rowsOf = (ledgerPath: string, step: string) => readLedgerLines(ledgerPath).filter((row) => row.step === step); // ledger-read-intent: live

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6403-`));
}

test("W1-T6403: a located red merge opens one fix PR with its failing check and offending merge", async () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    const w = world();
    const lane = fakeLane();
    const daemon = rig(w, lane, ledgerPath);
    await daemon.observe();

    assert.equal(lane.fixes.length, 1, "one priority fix PR is opened for the located red");
    const [fix] = lane.fixes;
    assert.equal(fix!.offendingSha, RED_MERGE, "the offending merge is the first red push run after a green one");
    assert.equal(fix!.offendingPr, 10092);
    assert.equal(fix!.headSha, HEAD);
    assert.equal(fix!.branch, "main");
    assert.deepEqual(fix!.failingChecks, ["ci"], "the failing check rides the fix request");
    assert.deepEqual(fix!.failingTestTitles, [CENSUS_TITLE]);
    assert.deepEqual(fix!.testFiles, ["test/a-wall-clock-bound-declares-itself.test.ts"]);
    assert.match(fix!.logExcerpt, /measured 32 files\/52 sites; recorded 33\/53/);
    assert.equal(fix!.diffStat, " test/a-wall-clock-bound-declares-itself.test.ts | +1 -1", "the offending merge's diff stat");
    assert.equal(daemon.created.length, 0, "a red the lane repairs raises no MAIN-HEALTH escalation");

    const [located] = rowsOf(ledgerPath, "main.repair.located");
    assert.equal(located?.offending_sha, RED_MERGE);
    assert.equal(located?.offending_pr, 10092);
    assert.equal(located?.head_sha, HEAD);
    assert.deepEqual(located?.failing_checks, ["ci"]);
    assert.deepEqual(located?.test_files, ["test/a-wall-clock-bound-declares-itself.test.ts"]);
    assert.equal(located?.method, "first-red-run");
    const opened = rowsOf(ledgerPath, "main.repair.fix_opened");
    assert.deepEqual(
      opened.map((row) => [row.offending_sha, row.pr_url]),
      [[RED_MERGE, FIX_PR]],
    );

    // The same red observed again, then on a later head of the same streak, then by a restarted
    // daemon reading the same ledger: still exactly one fix PR for this offending merge.
    await daemon.observe();
    w.head = NEXT_HEAD;
    await daemon.observe();
    const restarted = rig(w, lane, ledgerPath);
    await restarted.observe();
    assert.equal(lane.fixes.length, 1, "a second observation of the same red opens no second fix PR");
    assert.equal(rowsOf(ledgerPath, "main.repair.fix_dispatched").length, 1);
    assert.equal(rowsOf(ledgerPath, "main.repair.located").length, 1);
    assert.equal(daemon.created.length + restarted.created.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T6403: a fix PR that stalls is followed by one revert PR of the offending merge", async () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    const w = world();
    const lane = fakeLane();
    const daemon = rig(w, lane, ledgerPath);
    await daemon.observe(); // locate + fix PR #10102
    await daemon.observe(); // the fix PR's head is recorded as its progress marker
    await daemon.observe(); // one tick without progress
    await daemon.observe(); // a second tick, but well inside the quiet window: the fix PR's CI may still run
    assert.equal(lane.reverts.length, 0, "a fix PR still inside its window is not reverted over");

    await daemon.observe(MAIN_REPAIR_STALL_MS); // two ticks AND the quiet window with no new head, no merge
    assert.equal(lane.reverts.length, 1, "the stalled fix PR is followed by one revert PR");
    const [revert] = lane.reverts;
    assert.equal(revert!.offendingSha, RED_MERGE);
    assert.equal(revert!.offendingPr, 10092);
    assert.equal(revert!.branch, "main");
    assert.equal(revert!.fixPrUrl, FIX_PR);
    assert.deepEqual(revert!.failingChecks, ["ci"]);
    assert.match(revert!.whyFixInsufficient, /no progress \(no new head, no merge\)/);
    const [opened] = rowsOf(ledgerPath, "main.repair.revert_opened");
    assert.equal(opened?.pr_url, REVERT_PR);
    assert.equal(opened?.offending_sha, RED_MERGE);
    assert.equal(opened?.fix_pr_url, FIX_PR);

    await daemon.observe(MAIN_REPAIR_STALL_MS);
    await rig(w, lane, ledgerPath).observe(MAIN_REPAIR_STALL_MS);
    assert.equal(lane.reverts.length, 1, "one revert PR per offending merge, across ticks and restarts");
    assert.equal(lane.fixes.length, 1);
    assert.equal(daemon.created.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // The production revert: a fresh branch off origin/main carries the revert and the PR targets main;
  // origin's main itself is never written.
  const git = gitFixture();
  try {
    const outcome = await git.revert({ ...revertRequest(git.offending), fixPrUrl: FIX_PR });
    assert.deepEqual(outcome, { prUrl: REVERT_PR });
    assert.equal(git.originMain(), git.mainBefore, "origin/main is untouched: nothing is pushed to main");
    const pushed = git.originBranches().filter((branch) => branch !== "main");
    assert.equal(pushed.length, 1);
    assert.match(pushed[0]!, /^main-repair-revert-[0-9a-f]{12}-\d+$/, "the push sends the lane's own new branch");
    const prs = git.prs;
    assert.equal(prs.length, 1);
    assert.equal(prs[0]!.base, "main");
    assert.equal(prs[0]!.head, pushed[0]);
    assert.notEqual(prs[0]!.head, "main");
    assert.match(prs[0]!.title, /^revert\(main\): revert #10092/);
    assert.match(prs[0]!.body, new RegExp(`Reverts \`${git.offending}\``));
    assert.match(prs[0]!.body, /failing check\(s\): ci/);
    assert.match(prs[0]!.body, new RegExp(FIX_PR));
    assert.ok(prs[0]!.body.trimEnd().endsWith(`Remudero-Task: ${mainRepairTaskId(git.offending)}`));
    assert.equal(git.fileOnBranch(pushed[0]!, "census.txt"), "recorded 33/53\n", "the branch carries the revert");
  } finally {
    git.cleanup();
  }
});

test("W1-T6403: a fix PR closed unmerged is followed by the revert on the next red observation", async () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    const w = world();
    const lane = fakeLane();
    const daemon = rig(w, lane, ledgerPath);
    await daemon.observe();
    w.prs.get("10102")!.state = "closed";
    await daemon.observe();
    assert.equal(lane.reverts.length, 1);
    assert.match(lane.reverts[0]!.whyFixInsufficient, /closed unmerged/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T6403: a revert that does not apply is refused with its conflicting paths and escalated", async () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    const w = world();
    const lane = fakeLane(() => ({ refused: "git revert did not apply cleanly", conflictPaths: ["census.txt"] }));
    const daemon = rig(w, lane, ledgerPath);
    await daemon.observe();
    w.prs.get("10102")!.state = "closed";
    await daemon.observe();
    const [refused] = rowsOf(ledgerPath, "main.repair.revert_refused");
    assert.equal(refused?.offending_sha, RED_MERGE);
    assert.deepEqual(refused?.conflict_paths, ["census.txt"]);
    assert.equal(daemon.created.length, 1, "locate, fix and revert all refused: MAIN-HEALTH is raised");
    assert.match(daemon.created[0]!.body, /could not locate,\s+fix or revert/);
    await daemon.observe(MAIN_REPAIR_STALL_MS);
    assert.equal(lane.reverts.length, 1, "a refused revert is not retried");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const git = gitFixture({ conflict: true });
  try {
    const outcome = await git.revert(revertRequest(git.offending));
    assert.ok("refused" in outcome, JSON.stringify(outcome));
    assert.deepEqual(outcome.conflictPaths, ["census.txt"]);
    assert.match(outcome.refused, /did not apply cleanly/);
    assert.deepEqual(git.originBranches(), ["main"], "a conflicting revert pushes nothing");
    assert.equal(git.prs.length, 0, "and opens nothing");
    assert.equal(git.originMain(), git.mainBefore);
  } finally {
    git.cleanup();
  }
});

test("W1-T6403: a red with no first red merge is ledgered unlocated and escalates as before", async () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    const lane = fakeLane();
    const daemon = rig(world(), lane, ledgerPath, { readMainRunHistory: () => [] });
    await daemon.observe();
    assert.equal(lane.fixes.length, 0);
    const [unlocated] = rowsOf(ledgerPath, "main.repair.unlocated");
    assert.equal(unlocated?.head_sha, HEAD);
    assert.match(String(unlocated?.reason), /names no first red merge/);
    assert.equal(daemon.created.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T6403: main green on its own head resolves the repair and closes its redundant PRs", async () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    const w = world();
    const lane = fakeLane();
    const daemon = rig(w, lane, ledgerPath);
    await daemon.observe();
    await daemon.observe();
    await daemon.observe();
    await daemon.observe(MAIN_REPAIR_STALL_MS); // the revert PR is opened beside the fix PR
    assert.equal(lane.reverts.length, 1);

    w.prs.get("10103")!.merged = true;
    w.prs.get("10103")!.state = "closed";
    w.head = NEXT_HEAD;
    w.ci = "success";
    await daemon.observe();
    const [resolved] = rowsOf(ledgerPath, "main.repair.resolved");
    assert.equal(resolved?.offending_sha, RED_MERGE);
    assert.equal(resolved?.by, "revert");
    assert.deepEqual(resolved?.closed_prs, [FIX_PR], "the now-redundant fix PR is closed");
    assert.equal(w.prs.get("10102")!.state, "closed");
    assert.ok(
      w.mutations.some((args) => args.includes("repos/craigoley/remudero/issues/10102/comments")),
      "the close carries a comment",
    );

    await daemon.observe();
    assert.equal(rowsOf(ledgerPath, "main.repair.resolved").length, 1, "a resolved repair is resolved once");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T6403: an unreadable fix PR decides nothing and a refused fix run goes straight to the revert", async () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    const w = world();
    w.prs.delete("10102");
    const lane = fakeLane();
    const daemon = rig(w, lane, ledgerPath);
    await daemon.observe();
    await daemon.observe(MAIN_REPAIR_STALL_MS);
    await daemon.observe(MAIN_REPAIR_STALL_MS);
    assert.equal(lane.reverts.length, 0, "an unreadable fix PR is never reverted over on a guess");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const root2 = tmpRoot();
  const ledgerPath2 = join(root2, "ledger.ndjson");
  try {
    const lane = fakeLane();
    lane.openFixPr = async (request) => {
      lane.fixes.push(request);
      return undefined;
    };
    const daemon = rig(world(), lane, ledgerPath2);
    await daemon.observe();
    assert.equal(rowsOf(ledgerPath2, "main.repair.fix_refused")[0]?.reason, "the fix run opened no pull request");
    await daemon.observe();
    assert.equal(lane.reverts.length, 1);
    assert.equal(lane.reverts[0]!.fixPrUrl, undefined);
    assert.match(lane.reverts[0]!.whyFixInsufficient, /opened no fix PR/);
  } finally {
    rmSync(root2, { recursive: true, force: true });
  }
});

test("W1-T6403: a fix run lost to a daemon restart stalls into the revert, and a throwing revert opener is refused", async () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    // The previous daemon process located the red and dispatched its fix run, then died with it.
    const row = (step: string, extra: Record<string, unknown>) =>
      ({ run_id: "DAEMON-OLD", task_id: "MAIN-HEALTH", step, offending_sha: RED_MERGE, ...extra });
    writeLedger(
      [row("main.repair.located", { offending_pr: 10092, failing_checks: ["ci"] }), row("main.repair.fix_dispatched", {})],
      { dir: root },
    );
    const lane = fakeLane(() => {
      throw new Error("push refused by the remote");
    });
    const daemon = rig(world(), lane, ledgerPath);
    await daemon.observe();
    await daemon.observe();
    await daemon.observe(MAIN_REPAIR_STALL_MS);
    assert.equal(lane.fixes.length, 0, "the lost fix run is not re-dispatched");
    assert.equal(lane.reverts.length, 1);
    assert.match(lane.reverts[0]!.whyFixInsufficient, /dispatched before this daemon process started/);
    const [refused] = rowsOf(ledgerPath, "main.repair.revert_refused");
    assert.equal(refused?.reason, "push refused by the remote");
    assert.deepEqual(refused?.conflict_paths, []);
    assert.equal(daemon.created.length, 1, "the refused revert raises MAIN-HEALTH");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T6403: green while the fix run is still in flight waits for its PR, then closes it", async () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    const w = world();
    let release!: (url: string) => void;
    const lane = fakeLane();
    lane.openFixPr = (request) => {
      lane.fixes.push(request);
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };
    w.commitUnreadable = true;
    const daemon = rig(w, lane, ledgerPath);
    await daemon.observe();
    assert.equal(lane.fixes.length, 1);
    assert.equal(lane.fixes[0]!.diffStat, "(diff stat unreadable: HTTP 502)", "an unread diff stat says why");

    w.head = NEXT_HEAD;
    w.ci = "success";
    await daemon.observe();
    assert.equal(rowsOf(ledgerPath, "main.repair.resolved").length, 0, "a fix run still in flight is not resolved over");

    release(FIX_PR);
    await flush();
    await daemon.observe();
    const [resolved] = rowsOf(ledgerPath, "main.repair.resolved");
    assert.equal(resolved?.by, "other", "main turned green without this lane's PRs merging");
    assert.deepEqual(resolved?.closed_prs, [FIX_PR]);
    assert.equal(w.prs.get("10102")!.state, "closed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const MOUNT: Mount = { model: "fake-model", effort: "low", maxTurns: 5, contextBudget: 1000 };

function workerResult(text: string): WorkerResult {
  return {
    sessionId: "s-t6403",
    costUsd: 0.01,
    numTurns: 1,
    text,
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
  } as unknown as WorkerResult;
}

test("W1-T6403: the fix worker is told the failing check, its log and the offending merge, and returns its PR", async () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    const prompts: string[] = [];
    const trailers: Array<[string, string]> = [];
    const starts: string[] = [];
    let report = `REPORT\nPR_URL: ${FIX_PR}\n`;
    const deps: AlertFixDispatchDeps = {
      worktreeAdd: (_repoDir, _path, _branch, startPoint) => {
        starts.push(startPoint);
      },
      worktreeRemove: () => {
        throw new Error("worktree already gone");
      },
      renderWorkerSettings: () => "/tmp/fake-settings.json",
      loadMounts: () => ({}) as never,
      resolveMount: () => MOUNT,
      spawn: async (args) => {
        prompts.push(args.prompt);
        return workerResult(report);
      },
      ensureTaskTrailer: (prUrl, taskId) => {
        trailers.push([prUrl, taskId]);
      },
      checkAcceptance: () => ({ ok: true }) as never,
    };
    const request: MainRepairFixRequest = {
      branch: "main",
      headSha: HEAD,
      offendingSha: RED_MERGE,
      offendingPr: 10092,
      diffStat: " test/a-wall-clock-bound-declares-itself.test.ts | +1 -1",
      failingChecks: ["ci"],
      failingTestTitles: [CENSUS_TITLE],
      testFiles: ["test/a-wall-clock-bound-declares-itself.test.ts"],
      logExcerpt: CENSUS_LOG,
      reason: "required check ci failed",
    };
    const prUrl = await dispatchMainRepairFixRun(OWNER, "fixture-repo", { root } as Config, request, ledgerPath, "R", deps);
    assert.equal(prUrl, FIX_PR);
    assert.deepEqual(starts, ["origin/main"], "a fresh branch off origin/main");
    assert.deepEqual(trailers, [[FIX_PR, mainRepairTaskId(RED_MERGE)]]);
    const [prompt] = prompts;
    assert.match(prompt!, /Failing check\(s\): ci/);
    assert.match(prompt!, new RegExp(`first red merge is \`${RED_MERGE}\` \\(PR #10092\\)`));
    assert.match(prompt!, /a-wall-clock-bound-declares-itself\.test\.ts \| \+1 -1/, "the offending merge's diff stat");
    assert.match(prompt!, /measured 32 files\/52 sites/);
    assert.match(prompt!, /Do NOT revert that merge/);
    assert.match(prompt!, new RegExp(`Remudero-Task: ${mainRepairTaskId(RED_MERGE)}`));
    assert.equal(rowsOf(ledgerPath, "main-repair.worktree_remove_failed").length, 1);

    report = "REPORT\nno pull request\n";
    assert.equal(await dispatchMainRepairFixRun(OWNER, "fixture-repo", { root } as Config, request, ledgerPath, "R", deps), undefined);
    assert.equal(rowsOf(ledgerPath, "main-repair.no_pr").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function revertRequest(offendingSha: string): MainRepairRevertRequest {
  return {
    branch: "main",
    headSha: HEAD,
    offendingSha,
    offendingPr: 10092,
    failingChecks: ["ci"],
    whyFixInsufficient: "fix PR made no progress",
  };
}

/** A real origin + clone: a green commit, the offending merge, and (for a conflict) a later edit. */
function gitFixture(opts: { conflict?: boolean } = {}) {
  const root = tmpRoot();
  const originFixture = gitRepo({ bare: true, kind: "t6403-origin" });
  const origin = originFixture.dir;
  const checkout = gitRepo({ seedCommit: false, kind: "t6403-checkout" });
  const repoDir = join(root, "repos", "fixture-repo");
  const identity: Record<string, string> = {
    GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
    GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
    GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
    GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
  };
  const env = { ...process.env, ...identity, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const run = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  mkdirSync(join(root, "repos"), { recursive: true });
  renameSync(checkout.dir, repoDir);
  run(repoDir, "remote", "add", "origin", origin);
  writeFileSync(join(repoDir, "census.txt"), "recorded 33/53\n");
  run(repoDir, "add", ".");
  run(repoDir, "commit", "--quiet", "-m", "green");
  writeFileSync(join(repoDir, "census.txt"), "recorded 32/52 by #10092\n");
  run(repoDir, "commit", "--quiet", "-am", "test(review): witness timer progress (#10092)");
  const offending = run(repoDir, "rev-parse", "HEAD");
  if (opts.conflict) {
    writeFileSync(join(repoDir, "census.txt"), "recorded 31/51 by a later merge\n");
    run(repoDir, "commit", "--quiet", "-am", "a later merge on the same line");
  }
  run(repoDir, "push", "--quiet", "origin", "main");
  run(repoDir, "fetch", "--quiet", "origin");
  const mainBefore = run(origin, "rev-parse", "refs/heads/main");
  const prs: Array<Record<string, string>> = [];
  /** GitHub's PR create, as the REST argv `ratifyPrCreateRestArgs` builds: `-f key=value` pairs. */
  const fetch = ((args: string[]) => {
    assert.ok(args.includes("POST") && args.includes(`repos/${OWNER}/fixture-repo/pulls`), args.join(" "));
    const fields: Record<string, string> = {};
    args.forEach((arg, i) => {
      if (args[i - 1] !== "-f") return;
      const eq = arg.indexOf("=");
      fields[arg.slice(0, eq)] = arg.slice(eq + 1);
    });
    prs.push(fields);
    return { html_url: REVERT_PR };
  }) as GhApiFetcher;
  return {
    root,
    offending,
    mainBefore,
    prs,
    /** The production opener, with this fixture's identity and live writes allowed for its local origin. */
    revert: async (request: MainRepairRevertRequest) => {
      const saved = { ...process.env };
      Object.assign(process.env, identity);
      try {
        return await withLiveWritesAllowed(() =>
          openMainRepairRevertPr(OWNER, "fixture-repo", { root } as Config, request, join(root, "ledger.ndjson"), "DAEMON-T6403", fetch),
        );
      } finally {
        for (const key of Object.keys(identity)) {
          if (saved[key] === undefined) delete process.env[key];
          else process.env[key] = saved[key];
        }
      }
    },
    originMain: () => run(origin, "rev-parse", "refs/heads/main"),
    originBranches: () => run(origin, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean).sort(),
    fileOnBranch: (branch: string, file: string) => `${run(origin, "show", `refs/heads/${branch}:${file}`)}\n`,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      originFixture.cleanup();
    },
  };
}
