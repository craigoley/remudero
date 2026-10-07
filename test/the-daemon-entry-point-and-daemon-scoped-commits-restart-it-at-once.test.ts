import assert from "node:assert/strict";
import { test } from "node:test";

// A NAMESPACE import: the W1-T6273 export does not exist at the merge base, and a named import would fail the whole
// file at load, which the reviewer reads as "never ran" rather than as a red.
import * as judge from "../src/lib/deploy-judge.js";

/**
 * W1-T6273 — THE DAEMON'S ENTRY POINT AND DAEMON-SCOPED COMMITS RESTART IT AT ONCE. freshnessAdvanceWorth gave full
 * weight only to DAEMON_SELF_PATH_PREFIXES, which omitted src/run-task.ts (daemonCommand, the tick and the lane
 * gateways). On 2026-10-07 W1-T6259 (#9927), a fix to the daemon's own loop, scored the generic src/ floor of 1, so a
 * busy daemon waited ~63 min for its upper-age horizon before it would take it.
 */

const FULL = judge.DEPLOY_RESTART_SCORE_THRESHOLD.value;
const MIN = 60_000;
// The real advance that waited, as daemonFreshnessFromService reports it.
const W1_T6259 = {
  sha: "683f762c0",
  subject: "perf(daemon): every daemon-side gateway reads changed files off the loop (W1-T6259)",
  files: ["src/run-task.ts", "test/a-dispatched-runs-projection-reads-changed-files-off-the-loop.test.ts"],
};

test("W1-T6273: a change to run-task.ts, the daemon's own entry point, is full freshness weight", () => {
  assert.equal(judge.freshnessAdvanceWorth({ sha: "1", files: ["src/run-task.ts"] }).score, FULL);
  assert.equal(judge.freshnessAdvanceWorth({ sha: "2", files: ["src/lib/sweep.ts"] }).score, FULL, "the sweep runs on the daemon loop too");
  const decision = judge.decideFreshnessRestart({ changes: [W1_T6259], busy: true, staleSinceMs: 0, nowMs: 2 * MIN,
    state: { total: 0, scoredShas: [] } });
  assert.equal(decision.action, "restart", `a busy daemon takes W1-T6259 at once, not at the horizon: ${decision.reason}`);
  assert.equal(decision.restartTrigger, "change");
});

test("W1-T6273: a daemon-scoped commit is full weight wherever its files are", () => {
  for (const subject of ["perf(daemon): x", "fix(drain): x", "feat(dispatch)!: x", "fix(sweep): x"]) {
    assert.equal(judge.freshnessAdvanceWorth({ sha: "3", subject, files: ["src/lib/reader-agreement.ts"] }).score, FULL, subject);
  }
  assert.equal(judge.DAEMON_SELF_COMMIT_SCOPE.test("chore(daemonless): x"), false, "the scope must match whole");
});

test("W1-T6273: an unrelated src change still waits for an idle moment", () => {
  const change = { sha: "4", subject: "fix(inbox): x", files: ["src/lib/inbox.ts"] };
  assert.equal(judge.freshnessAdvanceWorth(change).score, 1);
  const decision = judge.decideFreshnessRestart({ changes: [change], busy: true, staleSinceMs: 0, nowMs: 2 * MIN,
    state: { total: 0, scoredShas: [] } });
  assert.equal(decision.action, "defer", "a busy daemon is not drained for a change outside its own machinery");
});
