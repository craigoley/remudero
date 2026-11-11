import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runDaemon } from "#src/lib/daemon.js";
import { DEPLOY_RESTART_SCORE_THRESHOLD, FRESHNESS_COALESCE_WINDOW_MS } from "#src/lib/deploy-judge.js";
import { loadPlan } from "#src/lib/plan.js";

const windowMs = FRESHNESS_COALESCE_WINDOW_MS.value;
const stale = { stale: true as const, oldSha: "a".repeat(40), newSha: "b".repeat(40),
  changes: Array.from({ length: DEPLOY_RESTART_SCORE_THRESHOLD.value }, (_, index) => ({
    sha: index === 0 ? "b".repeat(40) : String(index).padStart(40, "e"), subject: "fix: refresh", files: ["src/lib/daemon.ts"],
  })) };
type Row = { step: string; extra?: Record<string, unknown> };

// Drives a daemon that reads main stale from its first tick. `passStepMs` is how far each full pass moves the fake
// clock, so a pass that starts after the advance completes strictly after it; with 0 no pass can complete after it.
async function exitAfter(t: TestContext, opts: { idle: boolean; passStepMs: number }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-t9352-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "tasks.yaml");
  writeFileSync(path, opts.idle ? "[]\n"
    : "- id: A\n  title: A\n  repo: remudero\n  type: implement\n  depends_on: [B]\n  status: queued\n  files: [src/A.ts]\n" +
      "- id: B\n  title: B\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: blocked\n  files: [src/B.ts]\n");
  let nowMs = Date.now();
  let calls = 0;
  const rows: Row[] = [];
  const summary = await runDaemon(loadPlan(path), {
    now: () => new Date(nowMs),
    checkFreshness: () => stale,
    refreshMerged: () => () => false,
    runOne: async () => assert.fail("no task is dispatchable"),
    sweep: async () => { calls++; nowMs += opts.passStepMs; },
    sleep: async () => { nowMs += windowMs; },
    log: (step, extra) => { rows.push({ step, extra }); },
  }, { freshnessMinLifetimeMs: 0, laneCount: 1, max: 1, sweepRetriggerIntervalMs: 1 });
  const restart = rows.find(({ step }) => step === "daemon_selfrestart_for_freshness")?.extra;
  return { summary, restart, rows, calls };
}

test("W1-T9352: a tick-top exit does not repeat a pass since the advance", async (t) => {
  const h = await exitAfter(t, { idle: false, passStepMs: 1 });
  assert.equal(h.summary.stopReason, "stale");
  assert.equal(h.restart?.pre_exit_pass, "skipped_ran_since_stale");
  assert.equal(h.calls, 1, "the pass that completed after the advance was not repeated at exit");
});

test("W1-T9352: an idle daemon's tick-top exit does not repeat a pass since the advance", async (t) => {
  const h = await exitAfter(t, { idle: true, passStepMs: 1 });
  assert.equal(h.summary.stopReason, "stale");
  assert.equal(h.restart?.pre_exit_pass, "skipped_ran_since_stale");
  assert.equal(h.calls, 1, "the pass that completed after the advance was not repeated at exit");
});

test("W1-T9352: an exit with no pass since the advance still runs one", async (t) => {
  const h = await exitAfter(t, { idle: true, passStepMs: 0 });
  assert.equal(h.summary.stopReason, "stale");
  assert.equal(h.restart?.pre_exit_pass, "ran");
  assert.equal(h.calls, 2, "the exit ran its own bounded pass");
});

test("W1-T9352: the restart row names the advance skip and its evidence", async (t) => {
  const h = await exitAfter(t, { idle: true, passStepMs: 1 });
  const staleSince = h.restart?.stale_since_ms;
  const lastPass = h.restart?.last_pass_completed_ms;
  assert.equal(h.restart?.old_sha, stale.oldSha);
  assert.equal(h.restart?.new_sha, stale.newSha);
  assert.equal(h.restart?.pre_exit_pass, "skipped_ran_since_stale");
  assert.equal(typeof staleSince, "number");
  assert.equal(typeof lastPass, "number");
  assert.ok((lastPass as number) > (staleSince as number), "the evidence shows a pass completed after the advance");
});
