import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon, type DaemonDeps, type DaemonFreshness } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import { inboxDraftBatchesInFlight, trackInboxDraftBatch } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { RunResult } from "#src/lib/run-result.js";

/**
 * 2026-11-28 14:44Z a draft batch spawned three Architects inside a background sweep pass; at 14:48Z a freshness
 * restart read the daemon as "idle: nothing in flight" and killed them mid-draft. A running batch is work a restart
 * interrupts, so it makes the decision busy (W1-T10054's rule) and a low-weight advance defers until it ends.
 */

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const stale = (): DaemonFreshness => ({ stale: true, oldSha: OLD_SHA, newSha: NEW_SHA, changes: [{ sha: NEW_SHA, subject: "feat: x", files: ["src/lib/inbox.ts"] }] });
const planOf = () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}freshness-draft-batch-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, "- id: A\n  title: A\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/a.ts]\n");
  return loadPlan(f);
};
const okResult = (id: string): RunResult => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }) as RunResult;

function within<T>(work: Promise<T>, ms: number): Promise<T | "timed-out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"timed-out">((resolve) => { timer = setTimeout(() => resolve("timed-out"), ms); });
  return Promise.race([work, bound]).finally(() => clearTimeout(timer));
}

test("a freshness restart waits for a running inbox draft batch", async () => {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let finish!: () => void;
  const batch = trackInboxDraftBatch(() => new Promise<void>((resolve) => { finish = resolve; }));
  assert.equal(inboxDraftBatchesInFlight(), 1);
  let ticks = 0;
  const daemon = runDaemon(
    planOf(),
    {
      refreshMerged: () => () => true,
      runOne: async (id: string) => okResult(id),
      // The batch ends on the third idle wait, so the daemon defers while it drafts and restarts after.
      sleep: async () => { if (++ticks === 3) finish(); },
      log: (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra }),
      sweep: async () => ({}),
      checkFreshness: stale,
    } as unknown as DaemonDeps,
    { freshnessMinLifetimeMs: 0, sweepWallClockBoundMs: 60_000 },
  );
  const summary = await within(daemon, 5_000);
  finish();
  await batch;
  assert.notEqual(summary, "timed-out");
  const made = lines.filter((l) => l.step === "daemon.freshness_decision").map((l) => l.extra);
  assert.equal(made[0]!.busy, true, "a running draft batch makes the decision busy");
  assert.deepEqual(made[0]!.busy_reasons, ["inbox_draft"]);
  assert.equal(made[0]!.action, "defer", "a busy daemon defers a low-weight advance");
  assert.equal(made.at(-1)!.action, "restart", "the restart follows once the batch ends");
  assert.equal(inboxDraftBatchesInFlight(), 0);
});

test("a draft batch that throws still releases the busy count", async () => {
  await assert.rejects(trackInboxDraftBatch(async () => { throw new Error("spawn failed"); }), /spawn failed/);
  assert.equal(inboxDraftBatchesInFlight(), 0);
});
