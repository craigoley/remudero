// test/the-daemon-entry-point-and-daemon-scoped-commits-restart-it-at-once.test.ts — W1-T6273, repointed by W1-T9089.
//
// W1-T6273 gave the daemon's own entry point and any daemon-scoped commit full restart weight, because a restart had
// to drain runs inside the daemon's process and a change to that process could not wait. Build runs are children a
// booting daemon adopts (ADR 0007 A.10), so the self-path list and the self-scope commit test are gone: the daemon's own
// code weighs as any other source, and a busy daemon takes it at the age horizon or its next idle moment.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as judge from "#src/lib/deploy-judge.js";

const SHA = "c".repeat(40);
const OWN_CODE = [
  { sha: SHA, subject: "fix(daemon): reload the dispatch loop", files: ["src/lib/daemon.ts"] },
  { sha: SHA, subject: "fix: entry point", files: ["src/cli/commands/daemon.ts"] },
  { sha: SHA, subject: "feat(daemon): a new lane rule", files: ["src/run-task.ts"] },
];

function decide(change: judge.DeployWorthChange, options: { busy: boolean; nowMs?: number }) {
  return judge.decideFreshnessRestart({
    changes: [change], busy: options.busy, staleSinceMs: 0, nowMs: options.nowMs ?? 0, state: { total: 0, scoredShas: [] },
  });
}

test("W1-T9089: the daemon's entry point and daemon-scoped commits weigh as any other source", () => {
  for (const change of OWN_CODE) {
    const worth = judge.freshnessAdvanceWorth(change);
    assert.equal(worth.score, 1, `${change.files[0]} scores the source floor, not the retired full weight`);
    assert.match(worth.reason, /deterministic floor 1/);
  }
});

test("W1-T9089: a busy daemon does not restart at once for its own code", () => {
  for (const change of OWN_CODE) {
    const decision = decide(change, { busy: true });
    assert.equal(decision.action, "defer", `${change.files[0]} waits for an idle moment`);
    assert.equal(decision.weight, 1);
    assert.match(decision.reason, /wait for an idle moment/);
  }
});

test("W1-T9089: an idle daemon still restarts at once, and a busy one at the age horizon", () => {
  for (const change of OWN_CODE) {
    const idle = decide(change, { busy: false });
    assert.equal(idle.action, "restart");
    assert.equal(idle.restartTrigger, "idle");
    const aged = decide(change, { busy: true, nowMs: judge.DEPLOY_RESTART_RATE_CEILING_MS });
    assert.equal(aged.action, "restart");
    assert.equal(aged.restartTrigger, "age");
  }
});
