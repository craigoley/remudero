import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDaemon, type DaemonDeps, type LightPassScope } from "../src/lib/daemon.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { RunResult } from "../src/run-task.js";

// W1-T5343 — A PAUSED DISPATCH PHASE STILL REVIEWS. The in-flight phase ticker used to read PAUSE
// before its light pass, ledger `daemon.sweep_light.held` and skip the pass outright (W1-T4191), so
// no review started until every lane drained: 11 dispatch-phase PAUSE episodes held ~210 minutes
// over 8 days with 0 reviews started. Under PAUSE the ticker now runs ONE review-only light pass at
// a time while a lane is still in flight, ledgered as its own step; STOP still holds everything, and
// `daemon.sweep_light.held` keeps meaning "nothing ran".

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}paused-dispatch-reviews-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });

type Line = { step: string; extra: Record<string, unknown> };

/** The dispatch ticker's rows, split into one group per heartbeat (each tick logs `daemon.alive` first). */
function dispatchTicks(lines: Line[]): Line[][] {
  const ticks: Line[][] = [];
  for (const l of lines) {
    if (l.step === "daemon.alive" && l.extra.phase === "dispatch") ticks.push([]);
    else if (ticks.length > 0) ticks[ticks.length - 1].push(l);
  }
  return ticks;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("W1-T5343: under PAUSE the dispatch ticker runs a review-only pass, never a fix pass, and holds only when nothing ran", async () => {
  const lines: Line[] = [];
  let paused = false;
  let releaseRunOne: (() => void) | undefined;
  const runOneGate = new Promise<void>((resolve) => (releaseRunOne = resolve));
  const calls: Array<{ paused: boolean; reviewOnly: boolean }> = [];
  let sleeps = 0;
  const sleep: DaemonDeps["sleep"] = async () => {
    sleeps++;
    if (sleeps === 2) paused = true;
    if (sleeps >= 6) releaseRunOne?.();
  };
  const merged = new Set<string>();
  const s = await runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        await runOneGate;
        merged.add(id);
        return okResult(id);
      },
      sweepLight: async (scope?: LightPassScope) => {
        calls.push({ paused, reviewOnly: scope?.reviewOnly === true });
      },
      checkStop: () => undefined,
      checkPause: () => (paused ? "operator hold while the batch drains" : undefined),
      sleep,
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  await flush();
  assert.deepEqual(s.merged, ["A"], "the admitted batch still drains under the pause");
  assert.ok(calls.some((c) => !c.paused), "control: the ticker ran its ordinary light pass before the pause");
  const pausedCalls = calls.filter((c) => c.paused);
  assert.ok(pausedCalls.length >= 1, `a paused dispatch phase started at least one review pass (saw ${pausedCalls.length})`);
  assert.equal(pausedCalls.filter((c) => !c.reviewOnly).length, 0, "no paused pass may open the fix rung or the requeue batch");
  const reviewRows = lines.filter((l) => l.step === "daemon.sweep_light.review_only");
  assert.equal(reviewRows.length, pausedCalls.length, "each review-only pass is ledgered under its own step");
  assert.ok(
    reviewRows.every((l) => l.extra.phase === "dispatch" && l.extra.detail === "operator hold while the batch drains"),
    "the review-only row names its phase and the pause detail",
  );
  for (const tick of dispatchTicks(lines)) {
    const ran = tick.some((l) => l.step === "daemon.sweep_light.review_only");
    const held = tick.some((l) => l.step === "daemon.sweep_light.held");
    assert.ok(!(ran && held), "a tick that ran a review-only pass never also writes the held row");
  }
});

test("W1-T5343: STOP still holds every pass while PAUSE is also set", async () => {
  const lines: Line[] = [];
  let halted = false;
  let releaseRunOne: (() => void) | undefined;
  const runOneGate = new Promise<void>((resolve) => (releaseRunOne = resolve));
  let callsWhileHalted = 0;
  let sleeps = 0;
  const sleep: DaemonDeps["sleep"] = async () => {
    sleeps++;
    if (sleeps === 2) halted = true;
    if (sleeps >= 6) releaseRunOne?.();
  };
  const merged = new Set<string>();
  await runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        await runOneGate;
        merged.add(id);
        return okResult(id);
      },
      sweepLight: async () => {
        if (halted) callsWhileHalted++;
      },
      checkStop: () => (halted ? "operator stop" : undefined),
      checkPause: () => (halted ? "operator hold" : undefined),
      sleep,
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  await flush();
  assert.equal(callsWhileHalted, 0, "no light pass of any scope runs while STOP holds");
  assert.equal(lines.filter((l) => l.step === "daemon.sweep_light.review_only").length, 0);
  const held = lines.filter((l) => l.step === "daemon.sweep_light.held" && l.extra.phase === "dispatch");
  assert.ok(held.length >= 1, "the held row is still written");
  assert.ok(held.every((l) => l.extra.reason === "stop" && l.extra.detail === "operator stop"), "STOP wins and is named");
});

test("W1-T5343: a second paused review pass waits for the first to settle", async () => {
  const lines: Line[] = [];
  let paused = false;
  let releaseRunOne: (() => void) | undefined;
  const runOneGate = new Promise<void>((resolve) => (releaseRunOne = resolve));
  let releaseReview: (() => void) | undefined;
  const slowReview = new Promise<void>((resolve) => (releaseReview = resolve));
  let started = 0;
  let startedBeforeRelease = 0;
  let reviewReleased = false;
  let sleeps = 0;
  const sleep: DaemonDeps["sleep"] = async () => {
    sleeps++;
    if (sleeps === 2) paused = true;
    if (sleeps === 6) {
      reviewReleased = true;
      releaseReview?.();
      await flush();
    }
    if (sleeps >= 9) releaseRunOne?.();
  };
  const merged = new Set<string>();
  await runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        await runOneGate;
        merged.add(id);
        return okResult(id);
      },
      sweepLight: async (scope?: LightPassScope) => {
        if (!scope?.reviewOnly) return;
        started++;
        if (!reviewReleased) startedBeforeRelease++;
        await slowReview;
      },
      checkStop: () => undefined,
      checkPause: () => (paused ? "operator hold" : undefined),
      sleep,
      log: (step, extra = {}) => lines.push({ step, extra }),
    },
    { max: 1 },
  );
  await flush();
  assert.equal(startedBeforeRelease, 1, "while the first review is still running, no second one starts");
  assert.ok(
    lines.some((l) => l.step === "daemon.sweep_light.held" && l.extra.reason === "review_in_flight"),
    "a tick that finds the slot taken writes the held row and names why",
  );
  assert.ok(started >= 2, `control: once the first settles, a later tick starts another (saw ${started})`);
});

test("W1-T5343: no paused review pass starts once no lane is in flight", async () => {
  const lines: Line[] = [];
  let paused = false;
  let laneSettled = false;
  let releaseRunOne: (() => void) | undefined;
  const runOneGate = new Promise<void>((resolve) => (releaseRunOne = resolve));
  let settledSeen: (() => void) | undefined;
  const settledSet = new Promise<void>((resolve) => (settledSeen = resolve));
  let reviewsBeforeSettle = 0;
  let reviewsAfterSettle = 0;
  let sleeps = 0;
  const sleep: DaemonDeps["sleep"] = async () => {
    sleeps++;
    if (sleeps === 2) paused = true;
  };
  const merged = new Set<string>();
  await runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        await runOneGate;
        merged.add(id);
        return okResult(id);
      },
      sweepLight: async (scope?: LightPassScope) => {
        if (!scope?.reviewOnly) return;
        if (laneSettled) reviewsAfterSettle++;
        else reviewsBeforeSettle++;
      },
      // An awaited hook inside the tick, between the heartbeat and the light pass: the last lane settles
      // while the ticker is parked here, so the tick resumes into a phase with no lane left in flight.
      readDiskHeadroom: () => (sleeps >= 4 ? { freeBytes: 1, verdict: "WARN" } : { freeBytes: 1 << 30, verdict: "OK" }),
      onDiskHeadroomBreach: async () => {
        releaseRunOne?.();
        await settledSet;
      },
      checkStop: () => undefined,
      checkPause: () => (paused ? "operator hold" : undefined),
      sleep,
      log: (step, extra = {}) => {
        lines.push({ step, extra });
        if (step === "dispatch.settled_set") {
          laneSettled = true;
          settledSeen?.();
        }
      },
    },
    { max: 1 },
  );
  await flush();
  assert.ok(laneSettled, "fixture: the lane settled while the ticker was parked");
  assert.ok(reviewsBeforeSettle >= 1, "control: a paused review ran while the lane was in flight");
  assert.equal(reviewsAfterSettle, 0, "no review-only pass is admitted after the last lane settled");
  assert.ok(
    lines.some((l) => l.step === "daemon.sweep_light.held" && l.extra.reason === "no_lane"),
    "the tick that found no lane writes the held row and names why",
  );
});

/** One paused dispatch phase, driven by the given light-pass hook; returns its ledger rows. */
async function pausedPhase(deps: Partial<DaemonDeps>): Promise<Line[]> {
  const lines: Line[] = [];
  let paused = false;
  let releaseRunOne: (() => void) | undefined;
  const runOneGate = new Promise<void>((resolve) => (releaseRunOne = resolve));
  let sleeps = 0;
  const merged = new Set<string>();
  await runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => (id) => merged.has(id),
      runOne: async (id) => {
        await runOneGate;
        merged.add(id);
        return okResult(id);
      },
      checkStop: () => undefined,
      checkPause: () => (paused ? "operator hold" : undefined),
      sleep: async () => {
        sleeps++;
        if (sleeps === 2) paused = true;
        if (sleeps >= 5) releaseRunOne?.();
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
      ...deps,
    },
    { max: 1 },
  );
  await flush();
  return lines;
}

test("W1-T5343: a paused review pass that throws is ledgered as a failed light pass and frees its slot", async () => {
  let attempts = 0;
  const lines = await pausedPhase({
    sweepLight: async (scope?: LightPassScope) => {
      if (!scope?.reviewOnly) return;
      attempts++;
      throw new Error("review read failed");
    },
  });
  const failed = lines.filter((l) => l.step === "daemon.sweep_light.failed" && l.extra.review_only === true);
  assert.ok(failed.length >= 1, "the thrown review is named, never an unhandled rejection");
  assert.equal(failed[0].extra.error, "review read failed");
  assert.ok(attempts >= 2, `the slot is released after a throw, so a later tick retries (saw ${attempts})`);
});

test("W1-T5343: a paused phase whose ticker has no light-pass hook holds and says so", async () => {
  // The ticker also runs for the dispatch freshness hook alone (W1-T5083); with no light pass to run,
  // a paused tick ran nothing and must say so rather than claim a review.
  const lines = await pausedPhase({ checkFreshness: () => ({ stale: false }) });
  assert.equal(lines.filter((l) => l.step === "daemon.sweep_light.review_only").length, 0);
  assert.ok(lines.some((l) => l.step === "daemon.sweep_light.held" && l.extra.reason === "no_light_pass"));
});
