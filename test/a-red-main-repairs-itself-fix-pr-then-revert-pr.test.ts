/**
 * W1-T6403 — A RED MAIN REPAIRS ITSELF: A FIX PR FIRST, THEN A REVERT PR.
 *
 * 2026-10-08: #10092 (769d8053, merged 12:14:49Z) removed one wall-clock bound, so
 * test/a-wall-clock-bound-declares-itself.test.ts measured 32 files/52 sites against a recorded
 * 33/53. Core ledgered `main.health.observed` red 12 times and repaired nothing; a human fixed it in
 * #10102 at 12:54Z. These fixtures replay that red against the real rung with the repair lane wired:
 * a located first red merge opens ONE fix PR, a stalled fix is followed by ONE revert PR on a branch
 * of its own (never main), and a green head closes out the episode.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AsyncIssueGateway } from "../src/lib/escalate.js";
import type { BaseProbeResult } from "../src/lib/base-reproduction.js";
import {
  buildMainHealthRung,
  escalationFor,
  MAIN_REPAIR_BRANCH_PREFIX,
  MAIN_REPAIR_FIX_STALL_MIN_MS,
  type MainHealthMergeReader,
  type MainRepairDeps,
  type MainRepairFixRequest,
  type MainRepairPrState,
  type MainRepairRevertRequest,
  type MainRepairRevertResult,
} from "../src/lib/main-health-rung.js";
import type { GhApiFetcher } from "../src/lib/open-prs-rest.js";
import { mainHealthFromRollup } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { Config } from "../src/lib/config.js";
import type { Mount } from "../src/lib/mounts.js";
import type { WorkerResult } from "../src/lib/worker.js";
import {
  buildMainRepairEffects,
  dispatchMainRepairFixRun,
  mainRepairTaskId,
  openMainRepairRevertPr,
  type AlertFixDispatchDeps,
  type MainRepairRevertDeps,
} from "../src/run-task.js";

const OWNER = "o";
const REPO = "r";
const GREEN = "26f08d10".padEnd(40, "0"); // main just before #10092
const OFFENDING = "769d8053".padEnd(40, "0"); // #10092's merge — the first red push run
const HEAD = "2d7fa62b".padEnd(40, "0"); // a later merge; main still red
const GREEN_HEAD = "33fc1ed4".padEnd(40, "0"); // #10102's merge — main green again
const FAILING_TEST = "test/a-wall-clock-bound-declares-itself.test.ts";
const LOG_TAIL = [
  `# Subtest: ${FAILING_TEST}`,
  "not ok 1 - the wall-clock census matches its recorded baseline",
  "  expected 33 files / 53 sites, measured 32 / 52",
].join("\n");
const FIX_PR = `https://github.com/${OWNER}/${REPO}/pull/10120`;
const REVERT_PR = `https://github.com/${OWNER}/${REPO}/pull/10121`;

interface Harness {
  rung: ReturnType<typeof buildMainHealthRung>;
  ledgerPath: string;
  fixes: MainRepairFixRequest[];
  reverts: MainRepairRevertRequest[];
  closed: Array<{ url: string; comment: string }>;
  created: Array<{ title: string; body: string }>;
  prStates: Map<string, MainRepairPrState>;
  advance: (ms: number) => void;
  setHead: (sha: string) => void;
  rows: (step?: string) => Array<Record<string, unknown>>;
  cleanup: () => void;
}

interface HarnessOptions {
  /** Whether main's push-run history proves the first red run (else the bisect fallback must). */
  history?: boolean;
  fix?: (request: MainRepairFixRequest) => Promise<string | undefined>;
  revert?: (request: MainRepairRevertRequest) => Promise<MainRepairRevertResult>;
  reproduce?: MainRepairDeps["reproduce"];
  firstParents?: string[];
  ledgerPath?: string;
}

function harness(options: HarnessOptions = {}): Harness {
  let head = HEAD;
  let clock = Date.parse("2026-10-08T12:20:00Z");
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6403-`));
  const ledgerPath = options.ledgerPath ?? join(root, "ledger.ndjson");
  const history = options.history ?? true;
  const fetch = ((args: string[]) => {
    const path = args[1] ?? "";
    if (path === `repos/${OWNER}/${REPO}`) return { default_branch: "main" };
    if (path === `repos/${OWNER}/${REPO}/commits/main`) return { sha: head };
    if (path === `repos/${OWNER}/${REPO}/commits/${head}/check-runs?per_page=100`) {
      const conclusion = head === GREEN_HEAD ? "success" : "failure";
      return { check_runs: [{ name: "ci", status: "completed", conclusion, details_url: "https://x/job/1" }] };
    }
    if (path === `repos/${OWNER}/${REPO}/commits/${head}/status`) return { statuses: [] };
    if (path.startsWith(`repos/${OWNER}/${REPO}/actions/runs?`)) {
      if (!history) return { workflow_runs: [] };
      return {
        workflow_runs: [
          { id: 3, name: "ci", head_sha: HEAD, status: "completed", conclusion: "failure" },
          { id: 2, name: "ci", head_sha: OFFENDING, status: "completed", conclusion: "failure", html_url: "https://x/runs/2" },
          { id: 1, name: "ci", head_sha: GREEN, status: "completed", conclusion: "success" },
        ],
      };
    }
    if (path.startsWith(`repos/${OWNER}/${REPO}/commits?sha=`)) {
      const chain = options.firstParents ?? [HEAD, OFFENDING, GREEN];
      return chain.map((sha, i) => ({ sha, parents: chain[i + 1] ? [{ sha: chain[i + 1] }] : [] }));
    }
    throw new Error(`unrouted gh api path: ${path}`);
  }) as GhApiFetcher;
  const created: Array<{ title: string; body: string }> = [];
  const issues: AsyncIssueGateway = {
    create: async (title, body) => {
      created.push({ title, body });
      return `https://github.com/${OWNER}/${REPO}/issues/${9900 + created.length}`;
    },
    listOpen: async () => [],
    comment: async () => {},
    closeWithComment: async () => {},
  };
  const mergeReader: MainHealthMergeReader = {
    prMerge: (sha) => (sha === OFFENDING ? { number: 10092, headSha: "aa".padEnd(40, "0"), parentSha: GREEN } : undefined),
    mergeBase: () => GREEN,
    prsMergedBetween: () => [],
  };
  const fixes: MainRepairFixRequest[] = [];
  const reverts: MainRepairRevertRequest[] = [];
  const closed: Array<{ url: string; comment: string }> = [];
  const prStates = new Map<string, MainRepairPrState>();
  const repair: MainRepairDeps = {
    openFixPr: async (request) => {
      fixes.push(request);
      const url = options.fix ? await options.fix(request) : FIX_PR;
      if (url) prStates.set(url, { state: "open", headSha: "f1".padEnd(40, "0") });
      return url;
    },
    openRevertPr: async (request) => {
      reverts.push(request);
      const result = options.revert ? await options.revert(request) : { prUrl: REVERT_PR };
      if ("prUrl" in result) prStates.set(result.prUrl, { state: "open", headSha: "e1".padEnd(40, "0") });
      return result;
    },
    readPr: (url) => prStates.get(url) ?? { state: "open" },
    closePr: (url, comment) => {
      closed.push({ url, comment });
      prStates.set(url, { ...(prStates.get(url) ?? {}), state: "closed" });
    },
    ...(options.reproduce ? { reproduce: options.reproduce } : {}),
  };
  const rung = buildMainHealthRung(OWNER, REPO, {
    fetch,
    issues,
    ledgerPath,
    runId: "DAEMON-T6403",
    log: () => {},
    now: () => clock,
    readRequiredChecks: () => ["ci"],
    readCiFailures: () => (head === GREEN_HEAD ? [] : [{ name: "ci", logTail: LOG_TAIL, conclusion: "FAILURE" }]),
    mergeReader,
    readPrFiles: () => ["src/x.ts"],
    repair,
  });
  const rows = (step?: string): Array<Record<string, unknown>> => {
    let text = "";
    try {
      text = readFileSync(ledgerPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => step === undefined || row.step === step);
  };
  return {
    rung,
    ledgerPath,
    fixes,
    reverts,
    closed,
    created,
    prStates,
    advance: (ms) => {
      clock += ms;
    },
    setHead: (sha) => {
      head = sha;
    },
    rows,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** One daemon tick: observe, then let any repair effect the observation started settle. */
async function tick(h: Harness, ms = 60_000): Promise<void> {
  h.advance(ms);
  await h.rung();
  await h.rung.repairIdle();
}

test("W1-T6403: a located red merge opens one fix PR with its failing check and offending merge", async () => {
  const h = harness();
  try {
    await tick(h);
    assert.equal(h.fixes.length, 1, "one fix PR is opened for the located first red merge");
    const [request] = h.fixes;
    assert.equal(request!.offendingSha, OFFENDING, "the fix names the first red merge, not main's head");
    assert.equal(request!.offendingPr, 10092, "the offending merge's PR is resolved from its squash subject");
    assert.deepEqual(request!.failingChecks, ["ci"]);
    assert.deepEqual(request!.failingTestTitles, ["the wall-clock census matches its recorded baseline"]);
    assert.deepEqual(request!.testFiles, [FAILING_TEST]);
    assert.match(request!.logExcerpt, /measured 32 \/ 52/);
    assert.equal(request!.base, "main");
    assert.notEqual(request!.branch, "main", "a fix PR is a branch of its own, never a push to main");
    assert.ok(request!.branch.startsWith(MAIN_REPAIR_BRANCH_PREFIX), request!.branch);

    const [located] = h.rows("main.repair.located");
    assert.equal(located?.offending_sha, OFFENDING);
    assert.equal(located?.offending_pr, 10092);
    assert.equal(located?.head_sha, HEAD);
    assert.equal(located?.method, "first-red-run");
    assert.deepEqual(located?.failing_checks, ["ci"]);
    assert.deepEqual(located?.test_files, [FAILING_TEST]);
    const opened = h.rows("main.repair.fix_opened");
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.offending_sha, OFFENDING);
    assert.equal(opened[0]?.pr_url, FIX_PR);
    assert.equal(h.created.length, 0, "a red the lane is repairing raises no MAIN-HEALTH escalation");

    await tick(h);
    await tick(h);
    assert.equal(h.fixes.length, 1, "a second observation of the same red opens no second fix PR");
    assert.equal(h.rows("main.repair.located").length, 1, "the episode's offending merge is located once");
  } finally {
    h.cleanup();
  }
});

test("a restarted daemon reading the same ledger opens no second fix PR for the same offending merge", async () => {
  const first = harness();
  try {
    await tick(first);
    const second = harness({ ledgerPath: first.ledgerPath });
    try {
      await tick(second);
      assert.equal(first.fixes.length + second.fixes.length, 1, "the ledger, not process memory, dedupes on offending_sha");
    } finally {
      second.cleanup();
    }
  } finally {
    first.cleanup();
  }
});

test("W1-T6403: a fix PR that stalls is followed by one revert PR of the offending merge", async () => {
  // Arm 1: the fix PR closes unmerged while main stays red.
  const closedFix = harness();
  try {
    await tick(closedFix);
    closedFix.prStates.set(FIX_PR, { state: "closed", headSha: "f1".padEnd(40, "0") });
    await tick(closedFix);
    assert.equal(closedFix.reverts.length, 1, "a fix PR closed unmerged with main still red opens one revert PR");
    const [request] = closedFix.reverts;
    assert.equal(request!.offendingSha, OFFENDING);
    assert.equal(request!.offendingPr, 10092);
    assert.equal(request!.base, "main", "the revert is a PR against main");
    assert.notEqual(request!.branch, "main", "a revert never targets main directly");
    assert.ok(request!.branch.startsWith(MAIN_REPAIR_BRANCH_PREFIX), request!.branch);
    assert.equal(request!.fixPrUrl, FIX_PR, "the revert names the fix PR it follows");
    assert.match(request!.whyFixNotEnough, /closed unmerged/);
    const [opened] = closedFix.rows("main.repair.revert_opened");
    assert.equal(opened?.offending_sha, OFFENDING);
    assert.equal(opened?.pr_url, REVERT_PR);
    assert.equal(opened?.fix_pr_url, FIX_PR);
    await tick(closedFix);
    await tick(closedFix);
    assert.equal(closedFix.reverts.length, 1, "one revert PR per offending merge");
    assert.equal(closedFix.fixes.length, 1, "and still one fix PR");
    assert.equal(closedFix.created.length, 0, "an open revert PR is the repair in flight, not an escalation");
  } finally {
    closedFix.cleanup();
  }

  // Arm 2: the fix PR stays open on one head (no new head, no merge) across the stall window.
  const stalled = harness();
  try {
    await tick(stalled);
    await tick(stalled);
    await tick(stalled);
    assert.equal(stalled.reverts.length, 0, "a fix PR inside its window is given time");
    await tick(stalled, MAIN_REPAIR_FIX_STALL_MIN_MS);
    assert.equal(stalled.reverts.length, 1, "a fix PR with no progress across the window is followed by a revert");
    assert.match(stalled.reverts[0]!.whyFixNotEnough, /no progress/);
  } finally {
    stalled.cleanup();
  }

  // Arm 3: a fix PR that keeps moving (a new head each tick) is never reverted over.
  const moving = harness();
  try {
    await tick(moving);
    for (let i = 0; i < 4; i++) {
      moving.prStates.set(FIX_PR, { state: "open", headSha: `${i}`.padEnd(40, "0") });
      await tick(moving, MAIN_REPAIR_FIX_STALL_MIN_MS);
    }
    assert.equal(moving.reverts.length, 0, "a new fix head is progress");
  } finally {
    moving.cleanup();
  }
});

test("a fix run that opens no PR is followed by the revert at once", async () => {
  const h = harness({ fix: async () => undefined });
  try {
    await tick(h);
    assert.equal(h.rows("main.repair.fix_unopened").length, 1);
    await tick(h);
    assert.equal(h.reverts.length, 1);
    assert.equal(h.reverts[0]!.fixPrUrl, undefined);
  } finally {
    h.cleanup();
  }
});

test("a revert that does not apply cleanly is ledgered with its conflicting paths and escalated", async () => {
  const h = harness({ revert: async () => ({ refused: "git revert conflicted", conflictingPaths: ["src/x.ts"] }) });
  try {
    await tick(h);
    h.prStates.set(FIX_PR, { state: "closed" });
    await tick(h);
    const [refused] = h.rows("main.repair.revert_refused");
    assert.deepEqual(refused?.conflicting_paths, ["src/x.ts"]);
    assert.equal(h.created.length, 0, "the refusal is ledgered first");
    await tick(h);
    assert.equal(h.created.length, 1, "locate, fix and revert all refused: the MAIN-HEALTH escalation is raised");
    assert.equal(h.reverts.length, 1, "a refused revert is never retried");
  } finally {
    h.cleanup();
  }
});

test("a red with no first red run is located by bisecting main's merges with the reproduction probe", async () => {
  const probed: string[] = [];
  const reproduce = async (sha: string, files: readonly string[]): Promise<BaseProbeResult> => {
    probed.push(sha);
    const outcome = sha === GREEN ? "passes" : "fails";
    return files.map((file) => ({ file, outcome, duration_ms: 1, cached: false }));
  };
  const h = harness({ history: false, reproduce });
  try {
    await tick(h);
    const [located] = h.rows("main.repair.located");
    assert.equal(located?.method, "bisect");
    assert.equal(located?.offending_sha, OFFENDING, "the first parent-green/child-red pair names its child");
    assert.deepEqual(probed, [HEAD, OFFENDING, GREEN], "nearest the head first, stopping at the first green parent");
    assert.equal(h.created.length, 0);
    await tick(h);
    assert.equal(h.fixes.length, 1);
    assert.equal(h.fixes[0]!.offendingPr, 10092);
  } finally {
    h.cleanup();
  }
});

test("a red no merge can be located for is ledgered unlocated and escalated as today", async () => {
  const h = harness({ history: false });
  try {
    await tick(h);
    const [unlocated] = h.rows("main.repair.unlocated");
    assert.match(String(unlocated?.reason), /no reproduction probe/);
    assert.equal(h.fixes.length, 0);
    assert.equal(h.created.length, 1, "today's escalation stands");
  } finally {
    h.cleanup();
  }
});

test("a green head closes out the episode and closes the repair PR that is now redundant", async () => {
  const h = harness();
  try {
    await tick(h);
    h.prStates.set(FIX_PR, { state: "closed" });
    await tick(h);
    h.prStates.set(REVERT_PR, { state: "merged" });
    h.setHead(GREEN_HEAD);
    await tick(h);
    const [resolved] = h.rows("main.repair.resolved");
    assert.equal(resolved?.by, "revert");
    assert.equal(resolved?.offending_sha, OFFENDING);
    assert.equal(h.closed.length, 0, "nothing open is left to close");
  } finally {
    h.cleanup();
  }
  const other = harness();
  try {
    await tick(other);
    other.setHead(GREEN_HEAD);
    await tick(other);
    const [resolved] = other.rows("main.repair.resolved");
    assert.equal(resolved?.by, "other", "main went green without either repair PR merging");
    assert.deepEqual(other.closed.map((c) => c.url), [FIX_PR], "the open fix PR is redundant and closed");
    assert.match(other.closed[0]!.comment, /green/);
    other.setHead(HEAD);
    await tick(other);
    assert.equal(other.fixes.length, 2, "a new red after the episode resolved starts a new one");
  } finally {
    other.cleanup();
  }
});

test("the MAIN-HEALTH escalation describes the repair lane it now follows", () => {
  const observation = mainHealthFromRollup(HEAD, [{ name: "ci", conclusion: "FAILURE" }], ["ci"]);
  const { detail } = escalationFor(observation, "main");
  assert.match(detail, /fix PR/);
  assert.match(detail, /revert PR/);
  assert.match(detail, /never a push to main/);
});

// ── The daemon's wiring (src/run-task.ts): the fix run, the revert PR, PR reads and closes ───────

function wiringRoot(): { root: string; ledgerPath: string; config: Config; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6403-wiring-`));
  return { root, ledgerPath: join(root, "ledger.ndjson"), config: { root } as Config, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function fixRequest(branch = `${MAIN_REPAIR_BRANCH_PREFIX}fix-769d80530000-1`): MainRepairFixRequest {
  return {
    headSha: HEAD,
    offendingSha: OFFENDING,
    offendingPr: 10092,
    failingChecks: ["ci"],
    failingTestTitles: ["the wall-clock census matches its recorded baseline"],
    testFiles: [FAILING_TEST],
    logExcerpt: LOG_TAIL,
    branch,
    base: "main",
  };
}

function revertRequest(branch = `${MAIN_REPAIR_BRANCH_PREFIX}revert-769d80530000-1`): MainRepairRevertRequest {
  return {
    headSha: HEAD,
    offendingSha: OFFENDING,
    offendingPr: 10092,
    failingChecks: ["ci"],
    branch,
    base: "main",
    fixPrUrl: FIX_PR,
    whyFixNotEnough: `fix PR ${FIX_PR} closed unmerged while main stayed red`,
  };
}

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

function fixDeps(text: string, prompts: string[], extra: Partial<AlertFixDispatchDeps> = {}): AlertFixDispatchDeps {
  return {
    worktreeAdd: () => {},
    worktreeRemove: () => {},
    renderWorkerSettings: () => "/tmp/fake-settings.json",
    loadMounts: () => ({}) as never,
    resolveMount: () => ({ model: "fake-model", effort: "low", maxTurns: 5, contextBudget: 1000 }) as Mount,
    spawn: async (args) => {
      prompts.push(args.prompt);
      return workerResult(text);
    },
    ensureTaskTrailer: () => {},
    checkAcceptance: () => ({ ok: true }) as never,
    ...extra,
  };
}

test("the fix run tells its worker the failing check, its output and the offending merge, and returns its PR", async () => {
  const w = wiringRoot();
  try {
    const prompts: string[] = [];
    const trailers: string[] = [];
    const url = await dispatchMainRepairFixRun("o", "r", w.config, fixRequest(), w.ledgerPath, "DAEMON-T6403", {
      ...fixDeps(`REPORT\nPR_URL: ${FIX_PR}\n`, prompts, { ensureTaskTrailer: (_url, taskId) => void trailers.push(taskId) }),
      diffStat: async () => " src/lib/wall-clock.ts | 3 +--",
    });
    assert.equal(url, FIX_PR);
    assert.deepEqual(trailers, [mainRepairTaskId(OFFENDING)]);
    const [prompt] = prompts;
    assert.match(prompt!, /Failing check\(s\): ci/);
    assert.match(prompt!, new RegExp(`Offending merge \\(the first red push run\\): ${OFFENDING} \\(PR #10092\\)`));
    assert.match(prompt!, /src\/lib\/wall-clock\.ts \| 3/);
    assert.match(prompt!, /measured 32 \/ 52/);
    assert.match(prompt!, /Do NOT revert the offending merge/);
    assert.match(prompt!, /--base main/);
  } finally {
    w.cleanup();
  }
});

test("a fix run whose worker opens no PR returns none, and an unreadable diff stat or teardown is named", async () => {
  const w = wiringRoot();
  try {
    const prompts: string[] = [];
    const url = await dispatchMainRepairFixRun("o", "r", w.config, fixRequest(), w.ledgerPath, "DAEMON-T6403",
      fixDeps("REPORT\nno pr\n", prompts, { worktreeRemove: () => { throw new Error("worktree busy"); } }));
    assert.equal(url, undefined);
    assert.match(prompts[0]!, /diff stat unavailable/, "the real `git show --stat` ran in a worktree that does not exist");
    assert.ok(readFileSync(w.ledgerPath, "utf8").includes("main-repair.worktree_remove_failed"));
    await assert.rejects(
      dispatchMainRepairFixRun("o", "r", w.config, fixRequest("main"), w.ledgerPath, "DAEMON-T6403", fixDeps("", [])),
      /refusing a main-repair fix on branch main/,
    );
  } finally {
    w.cleanup();
  }
});

function revertDeps(fail?: "revert" | "diff" | "abort"): MainRepairRevertDeps & { gitCalls: string[][]; ghCalls: string[][]; removed: string[] } {
  const gitCalls: string[][] = [];
  const ghCalls: string[][] = [];
  const removed: string[] = [];
  return {
    gitCalls,
    ghCalls,
    removed,
    worktreeAdd: () => {},
    worktreeRemove: (_repo, path) => void removed.push(path),
    git: async (args) => {
      gitCalls.push(args);
      const verb = args.slice(2).join(" ");
      if (fail && verb.startsWith("revert --no-commit")) throw new Error("CONFLICT (content): src/x.ts");
      if (verb.startsWith("diff --name-only")) {
        if (fail === "diff") throw new Error("index locked");
        return "src/x.ts\ntest/x.test.ts\n";
      }
      if (fail === "abort" && verb === "revert --abort") throw new Error("no revert in progress");
      return "";
    },
    gh: async (args) => {
      ghCalls.push(args);
      return { html_url: REVERT_PR };
    },
  };
}

test("the revert PR is a revert commit on its own branch, pushed there and opened against main, never pushed to main", async () => {
  const w = wiringRoot();
  try {
    const deps = revertDeps();
    const request = revertRequest();
    const result = await openMainRepairRevertPr("o", "r", w.config, request, w.ledgerPath, "DAEMON-T6403", deps);
    assert.deepEqual(result, { prUrl: REVERT_PR });
    const verbs = deps.gitCalls.map((args) => args.slice(2));
    assert.deepEqual(verbs[0], ["revert", "--no-commit", OFFENDING]);
    assert.equal(verbs[1]![0], "commit");
    assert.match(verbs[1]![2]!, /^revert\(main\): undo #10092 \(769d80530000\)/);
    assert.match(verbs[1]![2]!, new RegExp(`This reverts commit ${OFFENDING}\\.`));
    assert.deepEqual(verbs[2], ["push", "origin", `HEAD:refs/heads/${request.branch}`]);
    assert.ok(verbs.every((args) => !args.includes("main") && !args.some((a) => /refs\/heads\/main$/.test(a))), "nothing names main as a push target");
    const [post] = deps.ghCalls;
    assert.deepEqual(post!.slice(0, 4), ["api", "-X", "POST", "repos/o/r/pulls"]);
    assert.ok(post!.includes(`head=${request.branch}`));
    assert.ok(post!.includes("base=main"));
    const body = post!.find((a) => a.startsWith("body="))!;
    assert.match(body, /Failing check\(s\): ci/);
    assert.ok(body.includes(FIX_PR), "the body names the fix PR");
    assert.match(body, /closed unmerged/, "and why it was not enough");
    assert.match(body, new RegExp(`Remudero-Task: ${mainRepairTaskId(OFFENDING)}$`));
    assert.equal(deps.removed.length, 1, "the worktree is torn down");
    await assert.rejects(
      openMainRepairRevertPr("o", "r", w.config, revertRequest("main"), w.ledgerPath, "DAEMON-T6403", revertDeps()),
      /refusing a main-repair revert on branch main/,
    );
  } finally {
    w.cleanup();
  }
});

test("a revert that does not apply is aborted and returned with its conflicting paths", async () => {
  const w = wiringRoot();
  try {
    const deps = revertDeps("revert");
    const result = await openMainRepairRevertPr("o", "r", w.config, revertRequest(), w.ledgerPath, "DAEMON-T6403", deps);
    assert.ok("refused" in result);
    assert.deepEqual(result.conflictingPaths, ["src/x.ts", "test/x.test.ts"]);
    assert.match(result.refused, /did not apply/);
    assert.ok(deps.gitCalls.some((args) => args.slice(2).join(" ") === "revert --abort"));
    assert.equal(deps.ghCalls.length, 0, "no PR is opened for a revert that did not apply");
    const unreadable = await openMainRepairRevertPr("o", "r", w.config, revertRequest(), w.ledgerPath, "DAEMON-T6403", revertDeps("diff"));
    assert.ok("refused" in unreadable && /conflicting paths unreadable/.test(unreadable.conflictingPaths[0]!));
    await openMainRepairRevertPr("o", "r", w.config, revertRequest(), w.ledgerPath, "DAEMON-T6403", revertDeps("abort"));
    assert.ok(readFileSync(w.ledgerPath, "utf8").includes("main-repair.revert_abort_failed"));
  } finally {
    w.cleanup();
  }
});

test("the daemon's repair effects read a PR's state and close a redundant one with a comment", async () => {
  const w = wiringRoot();
  try {
    const calls: string[][] = [];
    const replies: Record<string, unknown> = {
      "repos/o/r/pulls/10120": { state: "open", head: { sha: "f1" } },
      "repos/o/r/pulls/10121": { state: "closed", merged_at: "2026-10-08T12:50:00Z" },
      "repos/o/r/pulls/10122": { state: "closed", merged_at: null },
    };
    const effects = buildMainRepairEffects("o", "r", w.config, w.ledgerPath, "DAEMON-T6403", w.root, () => {}, async (args) => {
      calls.push(args);
      return replies[args[args.length - 1]!] ?? {};
    });
    assert.deepEqual(await effects.readPr(FIX_PR), { state: "open", headSha: "f1" });
    assert.deepEqual(await effects.readPr(REVERT_PR), { state: "merged" });
    assert.deepEqual(await effects.readPr(`https://github.com/o/r/pull/10122`), { state: "closed" });
    await assert.rejects(Promise.resolve().then(() => effects.readPr("https://github.com/o/r/issues/1")), /not a pull request url/);
    calls.length = 0;
    await effects.closePr(FIX_PR, "main is green");
    assert.deepEqual(calls, [
      ["api", "-X", "POST", "repos/o/r/issues/10120/comments", "-f", "body=main is green"],
      ["api", "-X", "PATCH", "repos/o/r/pulls/10120", "-f", "state=closed"],
    ]);
    assert.equal(typeof effects.reproduce, "function", "the bisect fallback is wired to W1-T6024's probe");
  } finally {
    w.cleanup();
  }
});
