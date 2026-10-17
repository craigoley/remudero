/**
 * A RUN REFUSED BEFORE IT COULD RESTORE KEEPS ITS TASK'S CHECKPOINT RECEIPT. On 2026-10-17 the P1 W1-T9089 held a
 * kept receipt for run-W1-T9089-1792218237304 (11:27Z). Its next run, W1-T9089-1792248074276, was refused at 14:44Z
 * by the same-package lockfile guard before any worktree work, and its `failed` verdict (stage worktree.node_modules)
 * consumed the receipt. Both pushed run branches then blocked every pass as run-branch-already-pushed for 5 h.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { pendingWorkerBoundaryHandoffs, runBranchStateFrom, runBranchDispatchOpts } from "#src/lib/daemon.js";
import { THROWN_RUN_VERDICT_STAGES } from "#src/lib/status.js";

/** Every run-ending stage but run.error ends a run before its checkpoint restore can run. */
const PRE_RESTORE = [...THROWN_RUN_VERDICT_STAGES].filter((stage) => stage !== "run.error");

const TASK = "W1-T9089";
const OLDER = `run-${TASK}-1792184599830`;
const KEPT = `run-${TASK}-1792218237304`;
const OLDER_SHA = "2d86f2cfc5508be382946aad93af5e8c2daab716";
const KEPT_SHA = "229ae51e44759405f930da07f4c146f38dd2c6a4";
const lines = (rows: Record<string, unknown>[]) => rows.map((row) => JSON.stringify(row));

/** The receipt chain the live ledger held for W1-T9089 on 2026-10-17, in its own row shapes. */
const chain = (refusal: Record<string, unknown>) => [
  { task_id: TASK, run_id: `${TASK}-1792184599830`, step: "verdict", verdict: "handed_off", reason: "freshness_yield", branch: OLDER, head_sha: OLDER_SHA },
  { task_id: TASK, run_id: `${TASK}-1792218237304`, step: "run.freshness_handoff", waiting_on: "worker_round", branch: KEPT, head_sha: KEPT_SHA },
  { task_id: TASK, run_id: `${TASK}-1792218237304`, step: "verdict", verdict: "handed_off", reason: "freshness_yield", branch: KEPT, head_sha: KEPT_SHA },
  { task_id: TASK, run_id: `${TASK}-1792234580171`, step: "implement.checkpoint_restored", source_branch: KEPT, source_head_sha: KEPT_SHA },
  { task_id: TASK, run_id: `${TASK}-1792234580171`, step: "verdict", verdict: "failed", stage: "run.error", cause: "git-push-failed" },
  { task_id: TASK, run_id: `${TASK}-1792234580171`, step: "implement.checkpoint_kept", source_branch: KEPT, head_sha: KEPT_SHA },
  { task_id: TASK, run_id: `${TASK}-1792248074276`, step: "verdict", verdict: "failed", cause: "run-error", ...refusal },
];

test("a run refused before its restore keeps the checkpoint receipt it never consumed", () => {
  const pending = pendingWorkerBoundaryHandoffs(lines(chain({ stage: "worktree.node_modules" })));
  assert.deepEqual(pending.get(TASK), { branch: KEPT, headSha: KEPT_SHA });
  assert.ok(PRE_RESTORE.length > 0);
  for (const stage of PRE_RESTORE) {
    assert.deepEqual(pendingWorkerBoundaryHandoffs(lines(chain({ stage }))).get(TASK), { branch: KEPT, headSha: KEPT_SHA }, stage);
  }
});

test("a run refused before its restore leaves its task's own run branches unblocking", () => {
  const listing = [`${OLDER_SHA}\trefs/heads/${OLDER}`, `${KEPT_SHA}\trefs/heads/${KEPT}`].join("\n");
  const pending = pendingWorkerBoundaryHandoffs(lines(chain({ stage: "worktree.node_modules" })));
  const opts = runBranchDispatchOpts(runBranchStateFrom(listing, undefined, pending), [], () => {});
  assert.equal(opts.hasPushedRunBranch?.(TASK), false, "the kept head and an older epoch both resume, never block");
});

test("a run that could have restored still consumes the receipt", () => {
  assert.ok(THROWN_RUN_VERDICT_STAGES.has("run.error"));
  for (const refusal of [{ stage: "run.error" }, { reason: "tests failed" }, { stage: "fallback_push.census" }]) {
    assert.equal(pendingWorkerBoundaryHandoffs(lines(chain(refusal))).size, 0, JSON.stringify(refusal));
  }
});
