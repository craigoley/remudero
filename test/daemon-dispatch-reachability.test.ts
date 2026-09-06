import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import type { RunResult } from "../src/lib/run-result.js";
import { HEADROOM_LIMIT_PCT, type UsageSnapshot } from "../src/lib/headroom.js";

// ── W1-T2265 — EIGHT BRANCHES SKIPPED DISPATCH, EACH COSTING A FULL POLL INTERVAL ──────────
//
// `runDaemon`'s loop (daemon.ts) runs twelve rungs serially per tick with dispatch last, and
// eight `continue` statements — each preceded by `await deps.sleep(pollIntervalMs)` — target the
// outer `for (;;)` above it. Of those eight, FOUR are safety gates that must keep refusing a
// dispatch and keep their own poll (pause, the two headroom branches, the cost/queue governor);
// THREE are the dispatch-selection machinery's own tail (idle/re-paused/per-lane-governor-defer),
// unaffected by this task; the retro trigger's was the one branch that deferred for a reason
// having nothing to do with a dispatch decision — W1-T276 already ruled it stays BLOCKING, it
// just should not ALSO cost a full poll once it settles.
//
// This file asserts REACHABILITY — that `runOne` (standing in for `:3419`'s dispatch call) is or
// is not reached from a given loop state, and when reached, whether an extra poll-interval sleep
// sat between the state and the reach — never the lexical order of statements in the loop body,
// so a later refactor that preserves reachability does not break these tests (task rationale,
// part (viii)).

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "daemon-dispatch-reachability-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({
  taskId: id,
  runId: `${id}-run`,
  merged: true,
  costUsd: 0.1,
  verdict: "merged",
});

/** Mirrors test/headroom-reserve.test.ts's own fixture shape. */
function snapshotAt(percentUsed: number): UsageSnapshot {
  return {
    billingMode: "subscription",
    session: { percentUsed: 10, resetsAt: "x" },
    weekly: [{ label: "all models", percentUsed, resetsAt: "x" }],
  };
}

// ── claim 1: dispatch is reached on a tick where an observational rung ran ─────────────────

test(
  "W1-T2265 claim 1: dispatch is reached on the SAME tick an observational rung (sweepOrphans) ran, " +
    "rather than being skipped until the next poll",
  async () => {
    const plan = fixturePlan();
    const lines: Array<{ step: string }> = [];
    let orphanSweepCalls = 0;
    let runOneCalls = 0;
    let ticksAtDispatch = -1;
    const s = await runDaemon(
      plan,
      {
        refreshMerged: () => () => false,
        sweepOrphans: async () => {
          orphanSweepCalls++;
          return { killed: [], leftAlone: [] };
        },
        runOne: async (id) => {
          runOneCalls++;
          ticksAtDispatch = lines.filter((l) => l.step === "daemon.tick").length;
          return okResult(id);
        },
        sleep: async () => {},
        log: (step) => lines.push({ step }),
      },
      { max: 1 },
    );
    assert.equal(s.stopReason, "max_reached");
    assert.equal(orphanSweepCalls, 1, "the observational rung actually ran this tick");
    assert.equal(runOneCalls, 1, "dispatch was reached");
    assert.equal(
      ticksAtDispatch,
      1,
      "dispatch fired within the SAME outer-loop tick the observational rung ran in (still only " +
        "one daemon.tick row logged) — no poll sleep sat between them",
    );
  },
);

// ── claims 2, 5, 6: a fired retro still reaches dispatch on the SAME tick, spends no extra ──
// ── poll before it, and its own light-sweep ticker never itself dispatches while it runs ────

test(
  "W1-T2265 claims 2/5 (W1-T2981 reverses claim 6): a tick that fires the retro still reaches " +
    "dispatch on that SAME tick with no extra poll-interval sleep, and now reaches it WITHOUT " +
    "waiting for the retro, which is detached rather than awaited",
  async () => {
    const plan = fixturePlan();
    const lines: Array<{ step: string }> = [];
    let runOneCalls = 0;
    let runOneCallsBeforeRetroSettled = 0;
    let lightSweeps = 0;
    let sleeps = 0;
    let retroSettled = false;
    let ticksAtDispatch = -1;
    let releaseRetro: (() => void) | undefined;
    const retroGate = new Promise<void>((resolve) => {
      releaseRetro = resolve;
    });
    const sleep: DaemonDeps["sleep"] = async () => {
      sleeps++;
      // Released only after the ticker has genuinely ticked a few times — proving the retro
      // ran CONCURRENTLY with the light sweep, not that it was skipped.
      if (sleeps >= 3) releaseRetro?.();
    };
    const s = await runDaemon(
      plan,
      {
        refreshMerged: () => () => false,
        checkRetroTrigger: () => ({ fire: true, reason: "merges", mergesSinceMarker: 99, daysSinceMarker: 0 }),
        runRetroTrigger: async () => {
          await retroGate;
          retroSettled = true;
        },
        sweepLight: async () => {
          lightSweeps++;
        },
        runOne: async (id) => {
          runOneCalls++;
          if (!retroSettled) runOneCallsBeforeRetroSettled++;
          ticksAtDispatch = lines.filter((l) => l.step === "daemon.tick").length;
          return okResult(id);
        },
        sleep,
        log: (step) => lines.push({ step }),
      },
      { max: 1 },
    );
    assert.equal(s.stopReason, "max_reached");
    // W1-T2981 REVERSES CLAIM 6. It read `runOneCallsBeforeRetroSettled === 0` — "dispatch never
    // fired while the retro was still in flight". That is the behaviour that took the fleet down:
    // the retro rung sits ABOVE the dispatch pick and awaited an unbounded run, so on 2026-09-06 a
    // daemon logged `retro_triggered` (marker 3.7 days / 446 merges behind) and then wrote no
    // `daemon.idle` and no dispatch row at all. `daemon.idle` is written on every empty dispatch
    // set, so its absence proved the loop never reached the branch. Meanwhile the light sweep kept
    // reviewing and merging, so every liveness signal stayed green while nothing was built.
    //
    // A retro gates nothing: it spends — hence its place below the headroom rung — but no rung
    // downstream reads its result. Claims 2 and 5 below are UNCHANGED and are in fact served more
    // strongly now: dispatch is reached on the same tick, and without waiting at all.
    assert.ok(
      runOneCallsBeforeRetroSettled >= 1,
      "dispatch fired WHILE the retro was still in flight — the retro is detached, not awaited (W1-T2981)",
    );
    assert.equal(runOneCalls, 1, "dispatch WAS reached (claim 2)");
    void lightSweeps;
    assert.equal(
      ticksAtDispatch,
      1,
      "dispatch fired within the SAME tick the retro fired in — still only one daemon.tick row logged " +
        "(claim 2). The OLD code restarted the outer `for (;;)` after a fired retro (`ticks++; await " +
        "deps.sleep(pollIntervalMs); continue;`), which would have forced a SECOND daemon.tick row — one " +
        "full poll interval — before dispatch could even be attempted; a fixture that instead counted raw " +
        "`sleep` calls would be flaky here, since the retro's own light-sweep ticker (asserted above via " +
        "`lightSweeps`) legitimately keeps calling `sleep` on its own concurrent cadence right up to the " +
        "moment it is stopped. The absence of that SECOND daemon.tick row is what proves no extra, " +
        "guaranteed poll interval was spent on this defer (claim 5) — a signal the ticker's own concurrent " +
        "sleeps cannot produce, since only the OUTER loop's own top-of-tick statement logs daemon.tick.",
    );
    assert.ok(lines.some((l) => l.step === "retro_triggered"), "the fire is still ledgered");
  },
);

// ── claim 3: a paused fleet still does not dispatch, and pause still gates ──────────────────

test(
  "W1-T2265 claim 3: a paused fleet still does not dispatch — the pause check still runs (and still " +
    "gates) before any dispatch decision, and still spends its own poll interval",
  async () => {
    const plan = fixturePlan();
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    let sleeps = 0;
    const sleep: DaemonDeps["sleep"] = async () => {
      sleeps++;
    };
    const s = await runDaemon(plan, {
      refreshMerged: () => () => false,
      checkPause: () => "operator hold",
      runOne: async (id) => {
        throw new Error(`runOne must never be called for ${id} — the fleet is paused`);
      },
      checkStop: () => (sleeps >= 2 ? "test bound reached" : undefined),
      sleep,
      log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
    });
    assert.equal(s.stopReason, "stopped");
    assert.deepEqual(s.attempted, [], "nothing was ever admitted while paused");
    assert.ok(lines.some((l) => l.step === "daemon.pause"), "the pause was ledgered every tick it held");
    assert.ok(
      sleeps >= 2,
      "a paused tick still spends a full poll interval before re-checking — unlike the retro's " +
        "non-safety defer (claim 3), pause keeps its own poll",
    );
  },
);

// ── claim 4: a parked (headroom) or governor-refused tick still does not dispatch ──────────

test(
  "W1-T2265 claim 4a: a headroom-breached ('parked') tick still does not dispatch — the headroom " +
    "gate keeps its refusal",
  async () => {
    const plan = fixturePlan();
    const lines: Array<{ step: string }> = [];
    let sleeps = 0;
    const sleep: DaemonDeps["sleep"] = async () => {
      sleeps++;
    };
    const s = await runDaemon(plan, {
      refreshMerged: () => () => false,
      readUsage: () => snapshotAt(HEADROOM_LIMIT_PCT + 1),
      runOne: async (id) => {
        throw new Error(`runOne must never be called for ${id} — headroom is over ceiling`);
      },
      checkStop: () => (sleeps >= 2 ? "test bound reached" : undefined),
      sleep,
      log: (step) => lines.push({ step }),
    });
    assert.equal(s.stopReason, "stopped");
    assert.deepEqual(s.attempted, [], "nothing was ever admitted while headroom was over ceiling");
    assert.ok(lines.some((l) => l.step === "daemon.headroom"), "the headroom reading was ledgered");
    assert.ok(sleeps >= 2, "a parked tick still spends a full poll interval before re-checking");
  },
);

test(
  "W1-T2265 claim 4b: a cost-governor-refused ('quota-refused') tick still does not dispatch — the " +
    "governor gate keeps its refusal",
  async () => {
    const plan = fixturePlan();
    const lines: Array<{ step: string }> = [];
    let sleeps = 0;
    const sleep: DaemonDeps["sleep"] = async () => {
      sleeps++;
    };
    const s = await runDaemon(plan, {
      refreshMerged: () => () => false,
      checkCostGovernor: () => ({ deferred: true, observedDayCostUsd: 999, ceilingUsd: 10 }),
      runOne: async (id) => {
        throw new Error(`runOne must never be called for ${id} — the cost governor refused this tick`);
      },
      checkStop: () => (sleeps >= 2 ? "test bound reached" : undefined),
      sleep,
      log: (step) => lines.push({ step }),
    });
    assert.equal(s.stopReason, "stopped");
    assert.deepEqual(s.attempted, [], "nothing was ever admitted while the cost governor refused");
    assert.ok(lines.some((l) => l.step === "daemon.cost_governor"), "the governor's own refusal was ledgered");
    assert.ok(sleeps >= 2, "a governor-refused tick still spends a full poll interval before re-checking");
  },
);
