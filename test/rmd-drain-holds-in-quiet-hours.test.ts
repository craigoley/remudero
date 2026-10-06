import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { drainCommand } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import { runDrain, type DrainDeps } from "../src/lib/drain.js";
import { quietHoursFilePath } from "../src/lib/fleet-control.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { DEFAULT_SWEEP_POLICY } from "../src/lib/sweep.js";

const PROOF = "test/rmd-drain-holds-in-quiet-hours.test.ts";

async function withPlan(body: (plan: Plan, root: string, planPath: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "rmd-drain-quiet-hours-"));
  const planPath = join(root, "tasks.yaml");
  mkdirSync(join(root, "state"));
  writeFileSync(planPath, ["A", "B"].map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`,
  ).join(""));
  try {
    await body(loadPlan(planPath), root, planPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function harness(overrides: Partial<DrainDeps> = {}) {
  const ran: string[] = [];
  const merged = new Set<string>();
  const rows: { step: string; extra: Record<string, unknown> }[] = [];
  const deps: DrainDeps = {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => {
      ran.push(id);
      merged.add(id);
      return { taskId: id, runId: `R-${id}`, merged: true, costUsd: 0, verdict: "merged" };
    },
    log: (step, extra = {}) => rows.push({ step, extra }),
    ...overrides,
  };
  return { deps, ran, rows };
}

for (const detail of ["QUIET_HOURS file present", undefined]) {
  test(`${PROOF}: a single-lane quiet-hours hold dispatches nothing (${detail ?? "no detail"})`, async () => {
    await withPlan(async (plan) => {
      const reads: string[] = [];
      const h = harness({
        checkMemoryGovernor: () => { reads.push("memory"); return undefined; },
        checkQuietHours: () => { reads.push("quiet"); return { deferred: true, detail }; },
      });
      const summary = await runDrain(plan, h.deps, { laneCount: 1, max: 2 });
      assert.equal(summary.stopReason, "quiet_hours_deferred");
      assert.deepEqual(summary.attempted, []);
      assert.deepEqual(h.ran, []);
      assert.deepEqual(reads, ["memory", "quiet"]);
      assert.match(summary.stopDetail!, /quiet hours hold/);
      if (detail) assert.ok(summary.stopDetail!.includes(detail));
      assert.deepEqual(h.rows.filter((r) => r.step === "drain.quiet_hours").map((r) => r.extra),
        [{ quiet_hours: true, ...(detail ? { detail } : {}) }]);
    });
  });
}

test(`${PROOF}: quiet hours are read again after a single-lane dispatch`, async () => {
  await withPlan(async (plan) => {
    let reads = 0;
    const h = harness({ checkQuietHours: () => ++reads === 1 ? undefined : { deferred: true } });
    const summary = await runDrain(plan, h.deps, { max: 2 });
    assert.equal(summary.stopReason, "quiet_hours_deferred");
    assert.deepEqual(h.ran, ["A"]);
    assert.deepEqual(summary.attempted, ["A"]);
    assert.equal(reads, 2);
  });
});

for (const error of [new Error("quiet marker EIO"), "quiet marker gone"]) {
  test(`${PROOF}: an unreadable quiet-hours preference fails open and logs ${String(error)}`, async () => {
    await withPlan(async (plan) => {
      const h = harness({ checkQuietHours: () => { throw error; } });
      const summary = await runDrain(plan, h.deps, { max: 1 });
      assert.equal(summary.stopReason, "max_reached");
      assert.deepEqual(h.ran, ["A"]);
      assert.deepEqual(h.rows.filter((r) => r.step === "drain.quiet_hours.unreadable").map((r) => r.extra),
        [{ error: error instanceof Error ? error.message : error }]);
    });
  });
}

test(`${PROOF}: an absent quiet-hours dependency admits a single-lane dispatch`, async () => {
  await withPlan(async (plan) => {
    const h = harness();
    const summary = await runDrain(plan, h.deps, { max: 1 });
    assert.equal(summary.stopReason, "max_reached");
    assert.deepEqual(h.ran, ["A"]);
  });
});

test(`${PROOF}: drainCommand wires a live QUIET_HOURS check for its default lanes and one lane`, async () => {
  await withPlan(async (_plan, root, planPath) => {
    let reached = false;
    const code = await drainCommand(["--max", "2"], {
      config: { claudeBin: "/bin/true", root } as Config,
      planPath,
      skipGitSync: true,
      githubFactory: () => ({
        prByRef: () => null, findMergedByTrailer: () => null,
        headRefName: () => undefined, prBody: () => undefined,
      }),
      notifyChannel: { send: () => true } as never,
      runDrain: async (plan, deps, opts) => {
        reached = true;
        assert.equal(typeof deps.checkQuietHours, "function");
        const checkQuietHours = deps.checkQuietHours!;
        assert.equal(checkQuietHours(), undefined);
        writeFileSync(quietHoursFilePath(root), "");
        assert.deepEqual(checkQuietHours(), { deferred: true, detail: "QUIET_HOURS file present" });
        assert.equal(opts!.laneCount, DEFAULT_SWEEP_POLICY.dispatchLanes);
        assert.ok(opts!.laneCount! >= 2);
        for (const laneCount of [1, opts!.laneCount!]) {
          const h = harness({ checkQuietHours });
          const held = await runDrain(plan, h.deps, { ...opts, laneCount });
          assert.equal(held.stopReason, "quiet_hours_deferred");
          assert.deepEqual(held.attempted, []);
          assert.deepEqual(h.ran, []);
          assert.ok(held.stopDetail!.includes("QUIET_HOURS file present"));
        }
        rmSync(quietHoursFilePath(root));
        assert.equal(checkQuietHours(), undefined);
        const h = harness({ checkQuietHours });
        return runDrain(plan, h.deps, { ...opts, max: 1 });
      },
    });
    assert.equal(code, 0);
    assert.equal(reached, true);
  });
});
