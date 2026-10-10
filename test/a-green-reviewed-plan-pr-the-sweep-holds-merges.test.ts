// W1-T6595 — #10141 (a plan-only scope amendment) sat ~45 min with required checks green and review
// success while every sweep pass logged `automerge.plan_pr_held` (GitHub read mergeable=true,
// mergeable_state=blocked) and its disposition row said "arming auto-merge". A local `rmd review`
// then merged it at once via `automerge.clean_status_direct_merge`. The sweep now tells the plan-PR
// path what its `mergeable` disposition observed, so a green, reviewed, mergeable plan PR takes the
// direct merge (W1-T5748's merge-safety rules a behind one), and a held one's row names the hold.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  armAutoMergeDetailedAsync,
  armIfVerdictPermits,
  armAutoMergeDetailed,
  type ArmDeps,
} from "../src/lib/arm-auto-merge.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  deriveDisposition,
  MERGEABLE_PLAN_PR_REASON,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { readLedgerLines } from "../src/lib/status.js";
import { buildSweepEffects } from "../src/run-task.js";

const PR_URL = "https://github.com/craigoley/remudero/pull/10141";
const HEAD = "630b5d245922108bb15f88f2781f40e681e2f64b";
const TASK = "PR-10141";

const REVIEW_PASSED = {
  ts: new Date(Date.now() - 60_000).toISOString(),
  run_id: "review-PR10141",
  task_id: TASK,
  step: "review.posted",
  lane: "review",
  state: "success",
  head_sha: HEAD,
  pr_url: PR_URL,
  capped: false,
};

const PLAN_PR: OpenPrView = {
  prNumber: 10141,
  prUrl: PR_URL,
  taskId: TASK,
  headSha: HEAD,
  reviewState: "success",
  checksState: "green",
  unmetCriteria: [],
  priorStrikes: 0,
  lastActivityAt: new Date().toISOString(),
  autoMergeArmed: false,
  changedFiles: ["plan/tasks.d/W1-T6358-the-drain-reads-the-ledger-once-per-pass.yaml"],
};

/** GitHub seams answering #10141's facts. `mergeableState` is what that pass read. */
function remoteFacts(mergeableState: string, behindBy = 0) {
  const calls: string[] = [];
  const said: string[] = [];
  const seams = {
    headSha: () => HEAD,
    ledgerLines: () => [REVIEW_PASSED],
    armAuto: () => void calls.push("armAuto"),
    mergeDirect: () => void calls.push("mergeDirect"),
    disableAuto: () => {},
    isMerged: () => false,
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy, mergeableState }),
    updateBranch: () => {
      calls.push("updateBranch");
      return { ok: true };
    },
    readPlanTouch: () => "touched" as const,
    readPlanMergeSafety: () => ({
      prPlanPaths: ["plan/tasks.d/W1-T6358-the-drain-reads-the-ledger-once-per-pass.yaml"],
      mainPlanPaths: ["plan/tasks.d/W1-T6600.yaml"],
      mergedTree: { state: "loads" },
    }),
    stackPrerequisite: () => ({ state: "unstacked" as const, parentNumbers: [] }),
    mergeQueue: () => false,
    sleep: () => {},
    say: (msg: string) => void said.push(msg),
  };
  return { seams, calls, said };
}

/** The production sweep effects, with `armImpl` running the REAL arm over the sweep's own deps and
 *  only the GitHub seams faked — so whatever the sweep wires (or fails to) decides the outcome. */
function sweepArm(mergeableState: string, behindBy = 0) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t6595-`));
  const gh = remoteFacts(mergeableState, behindBy);
  const effects = buildSweepEffects({
    owner: "craigoley",
    repo: "remudero",
    config: { root: dir } as never,
    ledgerPath: join(dir, "ledger.ndjson"),
    runId: "RUN-w1-t6595",
    plan: { tasks: [], byId: new Map() },
    log: () => {},
    policy: undefined,
    ghJsonImpl: () => ({}),
    reviewRunner: undefined,
    spawnImpl: undefined,
    pushEmptyCommit: undefined,
    issuesImpl: undefined,
    stallNotice: undefined,
    // `Object.entries` drops the production-deps marker symbol: every string-keyed field the sweep
    // wired is kept, and only the GitHub seams are replaced.
    armImpl: (prUrl, taskId, deps) =>
      armAutoMergeDetailedAsync(prUrl, taskId, { ...Object.fromEntries(Object.entries(deps ?? {})), ...gh.seams } as unknown as ArmDeps<true>),
    armSessionPrsOverride: true,
    updateBranchImpl: undefined,
    captureRepairFeedbackImpl: undefined,
    ghRunImpl: undefined,
    spawnWallClockBoundMsOverride: undefined,
    reclaimWorkerImpl: undefined,
  });
  return { effects, gh, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("W1-T6595: the sweep merges a green reviewed plan PR the review would merge", async () => {
  // The review lane, on the facts it read at 18:29Z (clean): a direct merge.
  const review = remoteFacts("clean");
  const logged: string[] = [];
  const reviewOutcome = armIfVerdictPermits(
    { state: "success", capped: false, planOnly: false },
    { prUrl: PR_URL, taskId: TASK, headSha: HEAD, ledgerPath: "/nonexistent", log: (step) => void logged.push(step) },
    { arm: (prUrl, taskId) => armAutoMergeDetailed(prUrl, taskId, review.seams as unknown as ArmDeps) },
  );
  assert.equal(reviewOutcome, "direct-merged");
  assert.deepEqual(review.calls, ["mergeDirect"]);

  // The sweep, on the facts every one of its passes read (blocked): the same direct merge.
  const sweep = sweepArm("blocked");
  try {
    const outcome = await sweep.effects.arm(PLAN_PR);
    assert.equal(outcome, "direct-merged", `sweep said: ${sweep.gh.said.join(" | ")}`);
    assert.deepEqual(sweep.gh.calls, ["mergeDirect"], "merged directly, never armed");
    assert.doesNotMatch(sweep.gh.said.join("\n"), /plan_pr_held/);
    assert.match(sweep.gh.said.join("\n"), /automerge\.clean_status_direct_merge \(already green — merged now\)/);
  } finally {
    sweep.cleanup();
  }
});

test("W1-T6595: a behind, blocked, green plan PR reaches W1-T5748's merge-safety decision from the sweep", async () => {
  const sweep = sweepArm("blocked", 3);
  try {
    const outcome = await sweep.effects.arm(PLAN_PR);
    assert.equal(outcome, "direct-merged");
    assert.deepEqual(sweep.gh.calls, ["mergeDirect"], "merged as-is, never updated, never armed");
    assert.match(sweep.gh.said.join("\n"), /automerge\.plan_pr_merge_safe \(W1-T5748\)/);
  } finally {
    sweep.cleanup();
  }
});

test("W1-T6595: a blocked plan PR nobody observed green is still held, as at open", async () => {
  const gh = remoteFacts("blocked");
  const result = await armAutoMergeDetailedAsync(PR_URL, TASK, gh.seams as unknown as ArmDeps<true>);
  assert.equal(result.outcome, "plan-pr-held");
  assert.deepEqual(gh.calls, []);
  assert.match(gh.said.join("\n"), /automerge\.plan_pr_held \(W1-T5615\): plan_touch=touched mergeable_state=blocked/);
});

test("W1-T6595: a red-or-unreviewed PR never carries the green observation into the arm", async () => {
  const sweep = sweepArm("blocked");
  try {
    const outcome = await sweep.effects.arm({ ...PLAN_PR, checksState: "pending" });
    assert.equal(outcome, "plan-pr-held");
    assert.deepEqual(sweep.gh.calls, []);
  } finally {
    sweep.cleanup();
  }
});

test("W1-T6595: a plan PR's mergeable row says merging directly; any other PR still says arming", () => {
  assert.equal(deriveDisposition(PLAN_PR).reason, MERGEABLE_PLAN_PR_REASON);
  assert.match(MERGEABLE_PLAN_PR_REASON, /merging directly/);
  assert.equal(
    deriveDisposition({ ...PLAN_PR, changedFiles: ["src/lib/sweep.ts"] }).reason,
    "review success, required checks green — arming auto-merge",
  );
});

test("W1-T6595: a held plan PR's disposed row names the hold, never an arm", async () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t6595-held-`)), "ledger.ndjson");
  try {
    const deps: SweepDeps = {
      ledgerPath,
      runId: "RUN-w1-t6595-held",
      arm: () => "plan-pr-held",
      close: () => {},
      dispatchFix: () => {},
      escalate: () => {},
    };
    await runSweep([PLAN_PR], deps);
    const row = readLedgerLines(ledgerPath).find((line) => line.step === "sweep.disposed");
    assert.ok(row, "a disposed row was written");
    assert.equal(row.disposition, "mergeable");
    assert.match(String(row.reason), /^review success, required checks green — held: /);
    assert.doesNotMatch(String(row.reason), /arming auto-merge/);
  } finally {
    rmSync(join(ledgerPath, ".."), { recursive: true, force: true });
  }
});
