import assert from "node:assert/strict";
import { test } from "node:test";
import { fixSeedRead } from "#test/helpers/sweep-test.js";

// #15108 (W1-T10822) as the 2026-10-29 operator recon read it from the live ledger, trimmed to the fields
// fixSeedRead and readFixRungEnd read. The worker exited at 03:32:34Z after GitHub refused its push, yet every
// pass until 19:53Z read the seed as live: "fix already dispatched for this head … awaiting its outcome".
const HEAD = "6416e8d";
const TASK = "W1-T10822";
const SEED_RUN = "DAEMON-1793240989095";
const LATER_RUN = "DAEMON-1793296924049";
const ROUND = "DAEMON-1793240989095:1:1793244545155";
const pr = { prNumber: 15108, taskId: TASK, headSha: HEAD };
const seed = { step: "sweep.disposed", pr_number: pr.prNumber, task_id: TASK, head_sha: HEAD,
  disposition: "blocked-fixable", acted: true, run_id: SEED_RUN, ts: "2026-10-29T03:21:06.706Z" };
const dispatch = { step: "fix.dispatch", task_id: TASK, head_sha: HEAD, run_id: SEED_RUN, round_id: ROUND,
  worker_run_id: "DAEMON-1793240989095-fix1-1793244545155", mode: "reviewer-unmet", ts: "2026-10-29T03:31:31.971Z" };
const pushFailed = { step: "fix.push_failed", task_id: TASK, head_sha: HEAD, run_id: SEED_RUN,
  cause: "git-push-failed", ts: "2026-10-29T03:32:34.558Z" };
const done = { step: "fix.done", task_id: TASK, head_sha: HEAD, run_id: SEED_RUN, round_id: ROUND,
  subtype: "push_failed", worker_exit: "exit", worker_exit_code: 0, push_outcome: "failed", ts: "2026-10-29T03:32:34.559Z" };
const refunded = { step: "fix.strike_refunded", task_id: TASK, head_sha: HEAD, run_id: SEED_RUN,
  strike: 1, reason: "push-not-landed", push_outcome: "failed", ts: "2026-10-29T03:32:34.560Z" };
// The later run's boot adopted two live children of OTHER tasks, so the empty-boot recovery never applies.
const adoption = { step: "run_child.adoption_pass", task_id: "DAEMON", run_id: LATER_RUN,
  live: 2, adopted: 2, unreadable: 0, misidentified: 0, ts: "2026-10-29T18:03:43.781Z" };
const boot = { step: "daemon.boot", task_id: "DAEMON", run_id: LATER_RUN, ts: "2026-10-29T18:03:44.018Z" };
const recorded = () => [seed, dispatch, pushFailed, done, refunded, adoption, boot];

test("W1-T10991: a fix round whose push failed ends its seed, a landed push keeps its reading, and an in-flight rung stays live", () => {
  assert.equal(fixSeedRead(recorded(), pr, LATER_RUN)?.kind, "ended", "the recorded #15108 rows: the worker exited, nothing landed");

  const landed = [seed, dispatch, { ...done, subtype: "success", pushed_head_sha: "f5ae787c8", push_outcome: "landed" }, adoption, boot];
  assert.equal(fixSeedRead(landed, pr, LATER_RUN)?.kind, "live", "a landed push keeps its current reading: the new head ends it");

  const inFlight = [seed, dispatch, adoption, boot];
  assert.equal(fixSeedRead(inFlight, pr, LATER_RUN)?.kind, "live", "a dispatch with no fix.done is still running");

  const redispatched = [...recorded(), { ...dispatch, run_id: LATER_RUN, round_id: `${LATER_RUN}:1:1`, ts: "2026-10-29T18:10:00.000Z" }];
  assert.equal(fixSeedRead(redispatched, pr, LATER_RUN)?.kind, "live", "a later fix.dispatch supersedes the failed push");
});
