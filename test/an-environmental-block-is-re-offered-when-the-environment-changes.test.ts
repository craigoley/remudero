// W1-T4597: a containment probe that never ran, an isolation preflight whose spawn failed, a transient
// API storm or the Codex output cap each wrote the same durable `dispatch.blocked_independent` a
// task-caused failure writes, and only a new run.start cleared it — so on 2026-09-27 the console fleet
// starved (#1782) behind three blocks that said nothing about their tasks. An environmental block is now
// re-offered once the daemon runs different code or a cooldown passes, at most twice in a row.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ENVIRONMENTAL_BLOCK_COOLDOWN_MS,
  latestIndependentFailureBlock,
  MAX_ENVIRONMENTAL_REOFFERS,
} from "../src/lib/status.js";

const TASK = "CONSOLE-T80";
const T0 = Date.parse("2026-09-26T12:00:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const HOUR = 60 * 60 * 1000;

const boot = (offsetMs: number, sha: string) => ({ ts: at(offsetMs), task_id: "DAEMON", step: "daemon.boot", head_sha: sha });
const start = (offsetMs: number, run: string) => ({ ts: at(offsetMs), task_id: TASK, run_id: run, step: "run.start" });
const verdict = (offsetMs: number, run: string, v: string, stage?: string) => ({
  ts: at(offsetMs),
  task_id: TASK,
  run_id: run,
  step: "verdict",
  verdict: v,
  ...(stage ? { stage } : {}),
});
const block = (offsetMs: number, run: string, v: string) => ({
  ts: at(offsetMs),
  task_id: "DAEMON",
  task: TASK,
  run_id: run,
  step: "dispatch.blocked_independent",
  verdict: v,
});
/** One run of the task ending in `v` (and the block the daemon writes for it). */
const failedRun = (offsetMs: number, run: string, v: string, stage?: string) => [
  start(offsetMs, run),
  verdict(offsetMs + 1000, run, v, stage),
  block(offsetMs + 2000, run, v),
];

test("W1-T4597: an environmental block is re-offered once after a code change or cooldown, while a task-caused block stays durable", () => {
  const containment = [boot(-HOUR, "aaa"), ...failedRun(0, "r1", "blocked_containment")];
  assert.equal(latestIndependentFailureBlock(containment, TASK, undefined, T0 + HOUR), true, "no change yet: still blocked");
  assert.equal(
    latestIndependentFailureBlock([...containment, boot(HOUR, "aaa")], TASK, undefined, T0 + 2 * HOUR),
    true,
    "a restart on the SAME code is no change",
  );
  assert.equal(
    latestIndependentFailureBlock([...containment, boot(HOUR, "bbb")], TASK, undefined, T0 + 2 * HOUR),
    false,
    "a daemon on different code re-offers it",
  );
  assert.equal(
    latestIndependentFailureBlock(containment, TASK, undefined, T0 + ENVIRONMENTAL_BLOCK_COOLDOWN_MS + 5000),
    false,
    "the cooldown re-offers it without a deploy",
  );
  // No known code at block time: only the cooldown may release it, never a guessed change.
  const unknownBaseline = [...failedRun(0, "r1", "blocked_isolation"), boot(HOUR, "bbb")];
  assert.equal(latestIndependentFailureBlock(unknownBaseline, TASK, undefined, T0 + 2 * HOUR), true);

  // The Codex output cap is a `failed` verdict whose stage names it; any other failed stage is the task's.
  const codexCap = [boot(-HOUR, "aaa"), ...failedRun(0, "r1", "failed", "worker.bounded_output"), boot(HOUR, "bbb")];
  assert.equal(latestIndependentFailureBlock(codexCap, TASK, undefined, T0 + 2 * HOUR), false);
  const taskFailure = [boot(-HOUR, "aaa"), ...failedRun(0, "r1", "failed", "implement"), boot(HOUR, "bbb")];
  assert.equal(
    latestIndependentFailureBlock(taskFailure, TASK, undefined, T0 + ENVIRONMENTAL_BLOCK_COOLDOWN_MS * 10),
    true,
    "a task-caused failure stays blocked through any deploy or wait",
  );
  const noPr = [boot(-HOUR, "aaa"), ...failedRun(0, "r1", "no_pr"), boot(HOUR, "bbb")];
  assert.equal(latestIndependentFailureBlock(noPr, TASK, undefined, T0 + ENVIRONMENTAL_BLOCK_COOLDOWN_MS * 10), true);

  // The re-offered run.start supersedes the block exactly as before.
  assert.equal(latestIndependentFailureBlock([...containment, boot(HOUR, "bbb"), start(2 * HOUR, "r2")], TASK), false);

  // A third consecutive environmental block stays durable instead of looping.
  const later = ENVIRONMENTAL_BLOCK_COOLDOWN_MS + HOUR;
  const streak = (n: number) => [boot(-HOUR, "aaa"), ...Array.from({ length: n }, (_, i) => failedRun(i * later, `r${i + 1}`, "blocked_containment")).flat()];
  const lastBlockAt = (n: number) => T0 + (n - 1) * later + 2000;
  assert.equal(MAX_ENVIRONMENTAL_REOFFERS, 2);
  assert.equal(latestIndependentFailureBlock(streak(2), TASK, undefined, lastBlockAt(2) + ENVIRONMENTAL_BLOCK_COOLDOWN_MS), false, "the second is re-offered");
  assert.equal(latestIndependentFailureBlock(streak(3), TASK, undefined, lastBlockAt(3) + ENVIRONMENTAL_BLOCK_COOLDOWN_MS), true, "the third stays blocked");

  // A task-caused outcome in between resets the streak: the environment is judged afresh.
  const reset = [
    ...streak(2),
    ...failedRun(2 * later, "r3", "blocked_ci"),
    start(3 * later, "r4"),
    ...failedRun(3 * later + 5000, "r4", "blocked_containment"),
  ];
  assert.equal(latestIndependentFailureBlock(reset, TASK, undefined, T0 + 3 * later + 5000 + ENVIRONMENTAL_BLOCK_COOLDOWN_MS + 7000), false);
});
