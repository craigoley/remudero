import assert from "node:assert/strict";
import { test } from "node:test";
import { DEPLOY_RESTART_SCORE_THRESHOLD, decideFreshnessRestart } from "#src/lib/deploy-judge.js";

// Hermetic stand-in for the git-backed handoff boundary that test/daemon-external-wait-freshness.test.ts
// walks through real clones: the same decision, driven by plain data with no process or filesystem.
const change = (n: number, file: string) => ({ sha: `${n}`.padStart(40, "c"), subject: `advance ${n}`, files: [file] });

test("W1-T10263: check:test:test/the-daemon-restarts-for-freshness-at-its-cheapest-moment.test.ts is prevented, not retried", () => {
  const threshold = DEPLOY_RESTART_SCORE_THRESHOLD.value;
  const decide = (count: number, file: (i: number) => string) =>
    decideFreshnessRestart({
      changes: Array.from({ length: count }, (_, i) => change(i + 1, file(i))),
      busy: true,
      staleSinceMs: 1000,
      nowMs: 1000,
      state: { total: 0, scoredShas: [] },
    });
  // The daemon's own loop weighs the source floor, so a single commit to it still defers while busy.
  assert.equal(decide(1, () => "src/lib/daemon.ts").action, "defer");
  // Below the threshold stays deferred; reaching it with source commits hands off, with no clock involved.
  assert.equal(decide(threshold - 1, (i) => `src/lib/advance-${i}.ts`).action, "defer");
  const crossed = decide(threshold, (i) => `src/lib/advance-${i}.ts`);
  assert.equal(crossed.action, "restart");
  assert.equal(crossed.restartTrigger, "change");
  // Unreadable advance fails toward restarting.
  assert.equal(
    decideFreshnessRestart({ busy: true, staleSinceMs: 1000, nowMs: 1000, state: { total: 0, scoredShas: [] } }).restartTrigger,
    "unreadable",
  );
});
