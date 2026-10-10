import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import type { RunResult } from "../src/run-task.js";
import { daemonCommand } from "../src/run-task.js";
import * as drain from "../src/lib/drain.js";
import { laneDispatchBudget, runDrain, type QueueAdmissionReading } from "../src/lib/drain.js";

// Read through the namespace so this file still LOADS on a tree without the helper and each test fails on its own.
const wipDeferredAdmissionFields = (admitted: QueueAdmissionReading | undefined): Record<string, unknown> | undefined =>
  (drain as { wipDeferredAdmissionFields?: (a: QueueAdmissionReading | undefined) => Record<string, unknown> }).wipDeferredAdmissionFields?.(admitted);
import { runDaemon, type DaemonDeps, type DaemonSummary } from "../src/lib/daemon.js";
import { makeTempDir } from "../src/lib/tmp.js";

// MEASURED 2026-10-10 13:38-14:01Z on DAEMON-1791634616149: every tick wrote
// `dispatch_admitted_adaptive_wip` (owned 10-11, adaptive wip_limit 11-14, tier under_limit) and then
// `dispatch.wip_deferred` (wip_limit 10, observed 10-11), so no build started for over an hour. The
// queue governor admitted against its adaptive bound (#10510) while the lane budget sized the pass
// against the static policy limit, and the admitting reading was never handed to the budget.

const ADMITTED_AT_14: QueueAdmissionReading = {
  wipLimit: 14, baseWipLimit: 10, observedOpenCount: 10, stuckOwnedCount: 1, tier: "under_limit",
};

function threeTaskPlan(): Plan {
  const dir = makeTempDir("lane-admission-plan");
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    ["A", "B", "C"]
      .map((id) => `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id.toLowerCase()}.ts]\n`)
      .join(""),
  );
  return loadPlan(f);
}

const ok = (id: string): RunResult => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0.1, verdict: "merged" }) as RunResult;

test("an adaptive queue admission sizes the lane budget instead of the static wipLimit", () => {
  assert.equal(
    laneDispatchBudget({ laneCount: 3, wipLimit: 10, openPrCount: 10, queueAdmission: ADMITTED_AT_14 }),
    3,
    "admitted at 14 with 9 counted open PRs leaves room for all three lanes",
  );
  assert.equal(
    laneDispatchBudget({ laneCount: 3, wipLimit: 10, openPrCount: 10, queueAdmission: { ...ADMITTED_AT_14, wipLimit: 11 } }),
    2,
    "the admitted bound, less stuck PRs, still caps the pass",
  );
  assert.equal(laneDispatchBudget({ laneCount: 3, wipLimit: 10, openPrCount: 10 }), 0, "un-wired sites keep the static sizing");
});

test("a draining queue admission sizes the lane budget to one lane, never zero", () => {
  const draining: QueueAdmissionReading = { wipLimit: 10, baseWipLimit: 10, observedOpenCount: 12, stuckOwnedCount: 0, tier: "draining" };
  assert.equal(laneDispatchBudget({ laneCount: 3, wipLimit: 10, openPrCount: 12, queueAdmission: draining }), 1);
});

test("a wip_deferred row sized by a queue admission names that admission", () => {
  assert.deepEqual(wipDeferredAdmissionFields(undefined), {});
  assert.deepEqual(wipDeferredAdmissionFields({ ...ADMITTED_AT_14, wipLimit: 9 }), {
    budget_source: "queue_governor_admission",
    admitted_wip_limit: 9,
    admitted_open_count: 10,
    stuck_owned_count: 1,
    tier: "under_limit",
  });
});

test("runDaemon dispatches the lanes an adaptive queue admission leaves room for", async () => {
  const merged = new Set<string>();
  const ran: string[] = [];
  const steps: string[] = [];
  let ticks = 0;
  await runDaemon(
    threeTaskPlan(),
    {
      refreshMerged: () => (id: string) => merged.has(id),
      openPrCount: () => 10,
      checkQueueGovernor: () => undefined,
      readQueueAdmission: () => ADMITTED_AT_14,
      checkStop: () => (++ticks > 3 ? "tick cap" : undefined),
      log: (step: string) => steps.push(step),
      runOne: async (id: string) => {
        ran.push(id);
        merged.add(id);
        return ok(id);
      },
      sleep: async () => {},
    } as unknown as DaemonDeps,
    { max: 3, laneCount: 3, wipLimit: 10 },
  );
  assert.ok(!steps.includes("dispatch.wip_deferred"), "an admitted tick is not sized to zero against the static limit");
  assert.deepEqual(ran.sort(), ["A", "B", "C"]);
});

test("runDrain lanes dispatch what an adaptive queue admission leaves room for", async () => {
  const merged = new Set<string>();
  const ran: string[] = [];
  const steps: string[] = [];
  const s = await runDrain(
    threeTaskPlan(),
    {
      refreshMerged: () => (id) => merged.has(id),
      openPrCount: () => 10,
      readQueueAdmission: () => ADMITTED_AT_14,
      runOne: async (id) => {
        ran.push(id);
        merged.add(id);
        return ok(id);
      },
      log: (step) => steps.push(step),
    },
    { laneCount: 3, wipLimit: 10, max: 3 },
  );
  assert.notEqual(s.stopReason, "wip_deferred");
  assert.ok(!steps.includes("dispatch.wip_deferred"));
  assert.deepEqual(ran.sort(), ["A", "B", "C"]);
});

test("the daemon wiring exposes the queue governor's admitting reading", async () => {
  const home = makeTempDir("lane-admission-daemon");
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planDir = makeTempDir("lane-admission-wiring-plan");
  const planPath = join(planDir, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const board: GitHub = {
    prByRef: (ref) => ({ number: Number(ref), url: `https://github.com/o/r/pull/${ref}`, state: "OPEN" }),
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    listOpenHeadBranches: () => [
      { number: 30_000, url: "https://github.com/o/r/pull/30000", state: "OPEN", headRefName: "run-W1-T9001-1721400000000" },
    ],
  };
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    let captured: DaemonDeps | undefined;
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      githubFactory: () => board,
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        deps.refreshMerged();
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.ok(captured?.readQueueAdmission, "the daemon is handed the admission reader");
    assert.equal(captured.readQueueAdmission(), undefined, "no admission before the governor is consulted");
    assert.equal(captured.checkQueueGovernor!(), undefined, "one fleet PR is admitted");
    const admission = captured.readQueueAdmission();
    assert.ok(admission, "the admitting reading is readable after the consultation");
    assert.equal(admission.observedOpenCount, 1);
    assert.equal(admission.tier, "under_limit");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(planDir, { recursive: true, force: true });
  }
});
