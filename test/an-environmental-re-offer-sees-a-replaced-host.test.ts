// W1-T4600: W1-T4597 re-offers an environmental block once a later daemon boots on different code, judged
// against the boot that preceded the block. MEASURED 2026-09-27: the live console ledger kept only its two
// newest daemon.boot rows, so CONSOLE-T76's preceding boot had rotated away and its block waited out the full
// cooldown although its container (host 6502f909f6e7) had been replaced (1650153cf0d1). A block row carries
// its host; a later boot on another host is a changed environment.
import assert from "node:assert/strict";
import { test } from "node:test";
import { latestIndependentFailureBlock } from "../src/lib/status.js";

const TASK = "CONSOLE-T76";
const T0 = Date.parse("2026-09-27T01:45:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const MIN = 60 * 1000;

const boot = (offsetMs: number, host: string, sha: string) => ({ ts: at(offsetMs), host, task_id: "DAEMON", step: "daemon.boot", head_sha: sha });
const codexCapBlock = (host: string) => [
  { ts: at(-3 * MIN), host, task_id: TASK, run_id: "r1", step: "run.start" },
  { ts: at(0), host, task_id: TASK, run_id: "r1", step: "verdict", verdict: "failed", stage: "worker.bounded_output" },
  { ts: at(2000), host, task_id: TASK, task: TASK, run_id: "r1", step: "dispatch.blocked_independent", verdict: "failed" },
];

test("W1-T4600: an environmental block whose preceding boot has rotated away is re-offered once a later daemon boots on a different host", () => {
  // The live shape: no boot visible before the block, two later boots on a replaced container.
  const rotated = [...codexCapBlock("6502f909f6e7"), boot(108 * MIN, "1650153cf0d1", "5a09ce7d"), boot(177 * MIN, "1650153cf0d1", "7dc9f5b5")];
  assert.equal(latestIndependentFailureBlock(rotated, TASK, undefined, T0 + 205 * MIN), false, "the replaced container re-offers it");

  // Every later boot on the SAME host, and no boot visible before the block: nothing proves a change.
  const sameHost = [...codexCapBlock("6502f909f6e7"), boot(108 * MIN, "6502f909f6e7", "5a09ce7d")];
  assert.equal(latestIndependentFailureBlock(sameHost, TASK, undefined, T0 + 205 * MIN), true, "a restart in the same container proves nothing");

  // A block or boot without a host contributes no host evidence either way.
  const hostless = [...codexCapBlock("6502f909f6e7").map(({ host: _h, ...row }) => row), boot(108 * MIN, "1650153cf0d1", "5a09ce7d")];
  assert.equal(latestIndependentFailureBlock(hostless, TASK, undefined, T0 + 205 * MIN), true);

  // A task-caused failure is never released by a new host.
  const taskCaused = [
    { ts: at(0), host: "6502f909f6e7", task_id: TASK, run_id: "r1", step: "verdict", verdict: "failed", stage: "implement" },
    { ts: at(2000), host: "6502f909f6e7", task_id: TASK, task: TASK, run_id: "r1", step: "dispatch.blocked_independent", verdict: "failed" },
    boot(108 * MIN, "1650153cf0d1", "5a09ce7d"),
  ];
  assert.equal(latestIndependentFailureBlock(taskCaused, TASK, undefined, T0 + 205 * MIN), true);
});
