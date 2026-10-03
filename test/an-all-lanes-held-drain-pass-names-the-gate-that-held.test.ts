/**
 * W1-T5482 — AN ALL-LANES-HELD DRAIN PASS NAMES THE GATE THAT HELD.
 *
 * `runDrainLanes` re-checks `checkDispatchGovernors` per lane at admission. When that loop admitted
 * NO lane it returned `cost_governor_deferred` whatever the verdict was, so a pass held by the memory
 * floor (which the pass-level reads above the loop never consult) was reported as a cost deferral.
 *
 * Every pass here is a REAL two-lane pass reached through `runDrain` with `laneCount: 2`: the
 * pass-level cost/queue reads (read 1) admit, and the gate under test refuses at lane 1's admission
 * (read 2), so the all-lanes-held branch is the one that answers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDrain, type DrainDeps, type DrainSummary } from "../src/lib/drain.js";

/** Two runnable tasks with DISJOINT `files:`, so both reach the admission loop in one pass. */
async function drainTwoLanes(over: Partial<DrainDeps> & Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-all-lanes-held-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/a.ts]\n" +
      "- id: B\n  title: b\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/b.ts]\n",
  );
  const ran: string[] = [];
  const rows: { step: string; extra: Record<string, unknown> }[] = [];
  const harness = {
    refreshMerged: () => () => false,
    runOne: async (id: string) => {
      ran.push(id);
      return { taskId: id, runId: `R-${id}`, merged: true, costUsd: 0, verdict: "merged" as const };
    },
    log: (step: string, extra: Record<string, unknown> = {}) => rows.push({ step, extra }),
    ...over,
  };
  try {
    const plan: Plan = loadPlan(f);
    const summary: DrainSummary = await runDrain(plan, harness as DrainDeps, { laneCount: 2, max: 2 });
    return { summary, ran, rows };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A reading that admits on its first call (the pass-level gate) and returns `held` after it. */
function admitsPassThenHolds<T>(held: () => T): () => T | undefined {
  let reads = 0;
  return () => (++reads >= 2 ? held() : undefined);
}

test("W1-T5482: a pass whose every lane the MEMORY gate refused ends memory_governor_deferred, not cost", async () => {
  const { summary, ran, rows } = await drainTwoLanes({
    checkMemoryGovernor: () => ({ deferred: true, observedAvailableMib: 1000, floorMib: 3072 }),
  });
  assert.deepEqual(ran, [], "no lane was admitted");
  assert.equal(summary.stopReason, "memory_governor_deferred");
  assert.match(summary.stopDetail ?? "", /1000 MiB available below the 3072 MiB memory floor/);
  assert.match(summary.stopDetail ?? "", /every lane deferred/);
  const governed = rows.filter((r) => r.step === "dispatch.lane_governed");
  assert.equal(governed.length, 1);
  assert.equal(governed[0].extra.observed_available_mib, 1000);
});

test("W1-T5482: a pass whose every lane the QUEUE gate refused ends queue_governor_deferred", async () => {
  const { summary, ran } = await drainTwoLanes({
    checkQueueGovernor: admitsPassThenHolds(() => ({ deferred: true as const, observedOpenCount: 30, wipLimit: 4 })),
  });
  assert.deepEqual(ran, []);
  assert.equal(summary.stopReason, "queue_governor_deferred");
  assert.match(summary.stopDetail ?? "", /30 open PRs at\/over the 4 WIP limit/);
});

test("W1-T5482: a pass whose every lane the COST gate refused still ends cost_governor_deferred", async () => {
  const { summary, ran } = await drainTwoLanes({
    checkCostGovernor: admitsPassThenHolds(() => ({ deferred: true as const, observedDayCostUsd: 206, ceilingUsd: 150 })),
  });
  assert.deepEqual(ran, []);
  assert.equal(summary.stopReason, "cost_governor_deferred");
  assert.match(summary.stopDetail ?? "", /\$206\.00 spent today at\/over the \$150\.00 daily ceiling/);
});

test("W1-T5482: a quiet-hours hold on every lane ends quiet_hours_deferred, carrying the hold's detail", async () => {
  // `DrainDeps` declares no `checkQuietHours`, but `checkDispatchGovernors` consults one whenever the
  // object it is handed carries it — so the verdict is reachable and must not read as cost.
  const { summary, ran } = await drainTwoLanes({
    checkQuietHours: () => ({ deferred: true as const, detail: "22:00-06:00 UTC" }),
  });
  assert.deepEqual(ran, []);
  assert.equal(summary.stopReason, "quiet_hours_deferred");
  assert.match(summary.stopDetail ?? "", /quiet hours hold: 22:00-06:00 UTC/);
});

test("W1-T5482: a quiet-hours hold with no detail still names quiet hours", async () => {
  const { summary } = await drainTwoLanes({ checkQuietHours: () => ({ deferred: true as const }) });
  assert.equal(summary.stopReason, "quiet_hours_deferred");
  assert.match(summary.stopDetail ?? "", /^quiet hours hold — /);
});

test("W1-T5482: an UNREADABLE queue reading at admission ends queue_governor_deferred with the error", async () => {
  const { summary, ran } = await drainTwoLanes({
    checkQueueGovernor: admitsPassThenHolds((): undefined => {
      throw new Error("gh pr list timed out");
    }),
  });
  assert.deepEqual(ran, []);
  assert.equal(summary.stopReason, "queue_governor_deferred");
  assert.match(summary.stopDetail ?? "", /queue governor reading unreadable \(gh pr list timed out\)/);
});

test("W1-T5482: an UNREADABLE cost reading at admission ends cost_governor_deferred with the error", async () => {
  const { summary, ran } = await drainTwoLanes({
    checkCostGovernor: admitsPassThenHolds((): undefined => {
      throw new Error("ledger read failed");
    }),
  });
  assert.deepEqual(ran, []);
  assert.equal(summary.stopReason, "cost_governor_deferred");
  assert.match(summary.stopDetail ?? "", /cost governor reading unreadable \(ledger read failed\)/);
});
