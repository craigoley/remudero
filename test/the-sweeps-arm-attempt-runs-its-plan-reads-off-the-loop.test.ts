// W1-T5781 — the sweep armed through the synchronous `armAutoMergeDetailed` over `realArmDeps`, so
// W1-T5748's plan merge-safety reads (`git fetch`, `git merge-tree`, `cat-file --batch`, 60 s cap each,
// plus three REST reads) blocked the daemon loop on every behind, green plan PR. The sweep now arms
// through `armAutoMergeDetailedAsync` over `realArmDepsAsync`: the same steps, awaited.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { armAutoMergeDetailed, armAutoMergeDetailedAsync, type ArmDeps } from "../src/lib/arm-auto-merge.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { OpenPrView } from "../src/lib/sweep.js";
import { buildSweepEffects } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";

const PR_URL = "https://github.com/craigoley/remudero/pull/9155";
const HEAD = "634285b5634285b5634285b5634285b5634285b5";
const TASK = "W1-T5781";
const CLEAN = "Pull request is in clean status";

const REVIEW_PASSED = {
  ts: new Date(Date.now() - 60_000).toISOString(),
  run_id: "review-PR9155",
  task_id: TASK,
  step: "review.posted",
  lane: "review",
  state: "success",
  head_sha: HEAD,
  pr_url: PR_URL,
  capped: false,
};

const SAFE_READINGS = {
  prPlanPaths: ["plan/tasks.d/W1-T5730.yaml"],
  mainPlanPaths: ["plan/tasks.d/W1-T5700.yaml"],
  mergedTree: { state: "loads" },
};

/** A behind, green plan PR whose merge-safety read takes `readMs` and answers `SAFE_READINGS`. */
function behindPlanPr(readMs: number, onRead: () => void = () => {}) {
  const said: string[] = [];
  const calls: string[] = [];
  const deps = {
    headSha: () => HEAD,
    ledgerLines: () => [REVIEW_PASSED],
    armAuto: () => {
      calls.push("armAuto");
      throw Object.assign(new Error("boom"), { stderr: CLEAN });
    },
    mergeDirect: () => void calls.push("mergeDirect"),
    disableAuto: () => {},
    isMerged: () => false,
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 4, mergeableState: "clean" }),
    updateBranch: () => {
      calls.push("updateBranch");
      return { ok: true };
    },
    readPlanTouch: () => "touched",
    readPlanMergeSafety: async () => {
      onRead();
      await new Promise((resolve) => setTimeout(resolve, readMs));
      return SAFE_READINGS;
    },
    say: (msg: string) => void said.push(msg),
  };
  return { deps: deps as unknown as ArmDeps<true>, said, calls };
}

test("an async arm of a behind plan PR lets a timer fire while the merge-safety read is in flight and matches the sync driver's outcome and rows", async () => {
  const fired: string[] = [];
  const log: string[] = [];
  const asyncRun = behindPlanPr(80, () => log.push("read-started"));
  const timer = setTimeout(() => {
    fired.push("timer");
    log.push("timer-fired");
  }, 10);
  const asyncResult = await armAutoMergeDetailedAsync(PR_URL, TASK, asyncRun.deps);
  log.push("arm-settled");
  clearTimeout(timer);
  assert.deepEqual(log, ["read-started", "timer-fired", "arm-settled"], "the loop turned while the read was in flight");
  assert.deepEqual(fired, ["timer"]);

  // The sync driver cannot await a reader, so it is given the same readings as a plain value.
  const syncRun = behindPlanPr(0);
  (syncRun.deps as unknown as Record<string, unknown>).readPlanMergeSafety = () => SAFE_READINGS;
  const syncResult = armAutoMergeDetailed(PR_URL, TASK, syncRun.deps as unknown as ArmDeps);

  assert.equal(asyncResult.outcome, "direct-merged");
  assert.deepEqual(asyncResult, syncResult);
  assert.deepEqual(asyncRun.said, syncRun.said, "the same automerge.* lines");
  assert.deepEqual(asyncRun.calls, syncRun.calls);
  assert.deepEqual(asyncRun.calls, ["mergeDirect"], "merged as-is, never updated, never armed");
  assert.match(asyncRun.said.join("\n"), /automerge\.plan_pr_merge_safe \(W1-T5748\)/);
});

test("the async driver refuses a missing task id and an unreadable head exactly as the sync driver does", async () => {
  const none = behindPlanPr(0);
  assert.deepEqual(await armAutoMergeDetailedAsync(PR_URL, undefined, none.deps), { outcome: "no-task-id" });
  const failing = behindPlanPr(0);
  (failing.deps as unknown as Record<string, unknown>).headSha = async () => {
    throw new Error("HTTP 502");
  };
  const result = await armAutoMergeDetailedAsync(PR_URL, TASK, failing.deps);
  assert.equal(result.outcome, "head-unavailable");
  assert.match(failing.said.join("\n"), /automerge\.head_sha_unavailable \(W1-T230\): HTTP 502/);
});

test("the sweep's default arm reads GitHub off the loop: a timer fires while its gh child is in flight", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}sweep-arm-off-loop-`));
  const shim = ghShim([{ when: "pulls/9155", stderr: "HTTP 502", exit: 1, delaySeconds: 0.5 }]);
  const priorPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${priorPath ?? ""}`;
  try {
    const effects = buildSweepEffects({
      owner: "craigoley",
      repo: "remudero",
      config: { root: dir } as never,
      ledgerPath: join(dir, "ledger.ndjson"),
      runId: "RUN-sweep-arm-off-loop",
      plan: { tasks: [], byId: new Map() },
      log: () => {},
      policy: undefined,
      ghJsonImpl: () => ({}),
      reviewRunner: undefined,
      spawnImpl: undefined,
      pushEmptyCommit: undefined,
      issuesImpl: undefined,
      stallNotice: undefined,
      armImpl: undefined, // the production default — the falsifier: the sync driver would block the timer
      armSessionPrsOverride: undefined,
      updateBranchImpl: undefined,
      captureRepairFeedbackImpl: undefined,
      ghRunImpl: undefined,
      spawnWallClockBoundMsOverride: undefined,
      reclaimWorkerImpl: undefined,
    });
    const log: string[] = [];
    const timer = setTimeout(() => log.push("timer-fired"), 100);
    const pr = { prUrl: PR_URL, prNumber: 9155, taskId: TASK, headSha: HEAD, body: "" } as unknown as OpenPrView;
    // The head read fails before any write leaf; the exemption only admits reaching the real deps.
    const outcome = await withLiveWritesAllowed(() => effects.arm(pr));
    log.push("arm-settled");
    clearTimeout(timer);
    assert.deepEqual(log, ["timer-fired", "arm-settled"]);
    assert.equal(outcome, "head-unavailable");
    assert.ok(shim.calls().some((c) => c.includes("pulls/9155")), `the head read went through the shim: ${shim.calls().join(" | ")}`);
  } finally {
    process.env.PATH = priorPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
