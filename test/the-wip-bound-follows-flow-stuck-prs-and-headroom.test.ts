import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { makeTempDir } from "../src/lib/tmp.js";
import * as sweep from "../src/lib/sweep.js";
import { readLedgerLines, type GitHub } from "../src/lib/status.js";
import { drainCommand } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { DrainDeps, DrainSummary } from "../src/lib/drain.js";

// Operator ruling 2026-10-09: "I hate hard ceilings" — the queue governor's WIP bound follows measured flow,
// stuck work and host headroom instead of a fixed policy.wipLimit. W1-T7243 owns the other fixed budgets.
const adaptive = () => import("../src/lib/adaptive-wip.js");
const BASE = { ...sweep.DEFAULT_SWEEP_POLICY, wipLimit: 10 };
const NOW = Date.parse("2026-10-09T22:00:00.000Z");
const disposed = (pr: number, blocker: string, ageMin: number) => ({
  ts: new Date(NOW - 60_000).toISOString(), step: "sweep.disposed", pr_number: pr, blocker,
  blocker_age_ms: ageMin * 60_000,
});

test("a queue of mostly stuck PRs still admits new work", async () => {
  const { assembleAdaptiveQueueFlow } = await adaptive();
  const owned = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const lines = [
    ...[1, 2, 3, 4].map((n) => disposed(n, "strikes-exhausted", 5)),
    ...[5, 6, 7].map((n) => disposed(n, "own-red", 120)),
    disposed(8, "operator-hold", 1),
    disposed(9, "awaiting-ci", 300),
  ];
  const flow = assembleAdaptiveQueueFlow({
    lines, ownedPrNumbers: owned, nowMs: NOW, baseLimit: BASE.wipLimit, trailingMergedCount: 0, readHeadroom: () => 0.6,
  });
  assert.equal(flow.stuckOwnedCount, 8, "parked blockers count at any age, ageing ones past the SLO, awaiting-ci never");
  const result = sweep.checkQueueGovernor(owned.length, BASE, { stuckOwnedCount: flow.stuckOwnedCount, adaptiveBound: flow.adaptiveBound });
  assert.equal(result.deferred, false);
  assert.equal(result.tier, "under_limit");
  assert.equal(result.stuckOwnedCount, 8);
});

test("low host headroom tightens the WIP bound continuously", async () => {
  const { adaptiveWipBound } = await adaptive();
  const comfortable = adaptiveWipBound({ baseLimit: 10, headroomFraction: 0.5 });
  const tight = adaptiveWipBound({ baseLimit: 10, headroomFraction: 0.15 });
  const starved = adaptiveWipBound({ baseLimit: 10, headroomFraction: 0.01 });
  assert.equal(comfortable, 10);
  assert.ok(tight < comfortable && tight > starved, `tight ${tight} sits between ${comfortable} and ${starved}`);
  assert.ok(starved >= 1);
  const held = sweep.checkQueueGovernor(8, BASE, { adaptiveBound: tight });
  assert.equal(held.deferred, true, "8 open PRs exceed the tightened bound under memory pressure");
});

test("high merge throughput loosens the WIP bound up to its backstop", async () => {
  const { adaptiveWipBound, WIP_BOUND_BACKSTOP_MULTIPLE } = await adaptive();
  const loosened = adaptiveWipBound({ baseLimit: 10, trailingMergedCount: 6, headroomFraction: 0.6 });
  assert.equal(loosened, 16);
  assert.equal(sweep.checkQueueGovernor(12, BASE, { adaptiveBound: loosened, trailingMergedCount: 6 }).deferred, false);
  assert.equal(adaptiveWipBound({ baseLimit: 10, trailingMergedCount: 500 }), 10 * WIP_BOUND_BACKSTOP_MULTIPLE);
});

test("an unreadable headroom reading leaves the bound unscaled and says so", async () => {
  const { assembleAdaptiveQueueFlow, readMemoryHeadroomFraction } = await adaptive();
  const flow = assembleAdaptiveQueueFlow({
    lines: [], ownedPrNumbers: undefined, nowMs: NOW, baseLimit: 10, trailingMergedCount: 2,
    readHeadroom: () => { throw new Error("no /proc/meminfo"); },
  });
  assert.deepEqual([flow.headroomUnread, flow.headroomFraction, flow.adaptiveBound, flow.stuckOwnedCount], [true, undefined, 12, 0]);
  const dir = makeTempDir("adaptive-wip-meminfo");
  try {
    const path = join(dir, "meminfo");
    writeFileSync(path, "MemTotal:       16000000 kB\nMemFree:  100 kB\nMemAvailable:    4000000 kB\n");
    assert.equal(readMemoryHeadroomFraction(path), 0.25);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the wired drain gate ledgers admission above the base limit when its owned PRs are stuck", async () => {
  const root = makeTempDir("adaptive-wip-drain");
  const planPath = join(root, "tasks.yaml");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const owned = BASE.wipLimit + 2;
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    listOpenHeadBranches: () => Array.from({ length: owned }, (_, i) => ({
      number: i + 1, url: `https://github.com/o/r/pull/${i + 1}`, state: "OPEN",
      headRefName: `run-W1-T${i + 1}-1791586243048`,
    })),
  };
  try {
    mkdirSync(join(root, "state"));
    writeFileSync(planPath, "[]\n");
    let gate: DrainDeps["checkQueueGovernor"];
    const code = await drainCommand([], {
      config: { claudeBin: "/bin/true", root } as Config,
      planPath,
      skipGitSync: true,
      githubFactory: () => github,
      notifyChannel: { send: () => true } as never,
      now: () => NOW,
      runDrain: async (_plan, deps): Promise<DrainSummary> => {
        deps.refreshMerged();
        gate = deps.checkQueueGovernor;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, resumeCommand: "rmd drain" };
      },
    });
    assert.equal(code, 0);
    assert.ok(gate);

    const blocked = gate();
    assert.equal(blocked?.deferred, true, "without blocker evidence, all owned PRs still occupy slots");
    for (let pr = 1; pr <= owned; pr++) {
      writeFileSync(ledgerPath, JSON.stringify(disposed(pr, "operator-hold", 1)) + "\n", { flag: "a" });
    }

    assert.equal(gate(), undefined, "the same above-base board is admitted once its PRs are parked");
    const lines = readLedgerLines(ledgerPath);
    const admitted = lines.filter((line) => line.step === "dispatch_admitted_adaptive_wip");
    assert.equal(admitted.length, 1, "the real gate writes one admission row");
    assert.equal(admitted[0].run_id, lines.find((line) => line.step === "drain.start")?.run_id);
    assert.equal(admitted[0].task_id, "GOVERNOR");
    assert.equal(admitted[0].observed_open_count, owned);
    assert.equal(admitted[0].base_wip_limit, sweep.DEFAULT_SWEEP_POLICY.wipLimit);
    assert.equal(admitted[0].stuck_owned_count, owned);
    assert.equal(admitted[0].tier, "under_limit");
    assert.equal(admitted[0].trailing_merged_count, 0);
    assert.equal(admitted[0].trailing_opened_count, 0);
    assert.equal(admitted[0].headroom_unread, false);
    assert.equal(admitted[0].headroom_error, null);
    assert.equal(typeof admitted[0].headroom_fraction, "number");
    assert.ok(Number(admitted[0].wip_limit) <= sweep.DEFAULT_SWEEP_POLICY.wipLimit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
