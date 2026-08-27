/**
 * test/light-pass-tick-is-not-bounded-by-ci.test.ts — W1-T2379.
 *
 * THE DEFECT, IN THREE LINES OF SOURCE. `startInFlightTicker` (lib/daemon.ts) loops
 * `await deps.sleep(pollIntervalMs)`, logs `daemon.alive`, then `await deps.sweepLight()`.
 * `runSweepLightPass` (lib/sweep.ts) returns `Promise.all` over every open PR. And
 * `deps.dispatchFix` — the one lane W1-T1211 admits into the light pass that spends a worker —
 * waits on CI. So the interval between two `daemon.alive` rows was `pollIntervalMs + max(action
 * duration)`, whose second term is bounded by GitHub Actions. A measured pass ran 16m41s against
 * a 60s interval, and two PRs that went green inside it were posted by hand 14m29s and 10m53s
 * late, forty-eight seconds before the next tick.
 *
 * WHAT IS FIXED AND WHAT IS DELIBERATELY NOT. The CI WAIT leaves the await; the DISPATCH and the
 * ROW DO NOT. `runSweep` records `acted: true` for a dispatched fix and `priorActionsFromLedger`
 * seeds `prior.fixed` from that row — the dedup that stops a second strike and that
 * `fixRungStalledWithoutNewHead` (W1-T1110) re-arms FROM ROWS THE RUN ITSELF WROTE. So this is
 * dispatch-and-record synchronously, wait asynchronously, never fire-and-forget, and the tests
 * below hold both halves.
 *
 * THREE THINGS THIS DOES NOT TOUCH, EACH PINNED HERE SO A LATER EDIT TRIPS: W1-T1211's admission
 * of `blocked-fixable`/`conflicted` into the light pass, W1-T526's one-PR-per-pass post-review
 * bound, and the 60,000 ms poll interval — measured intact on every one of 11,772 recorded gaps,
 * with W1-T1066 recording what happened the last time a loop here polled faster.
 *
 * NO NETWORK, NO SPAWN, NO REAL CI, NO REAL CLOCK. Every wait in this file is a promise a test
 * resolves by hand.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_SWEEP_POLICY,
  drainDetachedSweepActions,
  detachedSweepActionCount,
  runSweep,
  runSweepLightPass,
  type FixDispatchEvidence,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { lightPassActionable } from "../src/run-task.js";
import type { RunResult } from "../src/run-task.js";

const RECENT = "2026-07-19T12:00:00Z";
const NOW = Date.parse("2026-07-29T18:00:00Z");

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-t2379-")), "ledger.ndjson");
}

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "https://github.com/o/r/pull/1",
    taskId: "W1-TX",
    reviewState: "pending",
    checksState: "pending",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "aaaa111",
    autoMergeArmed: false,
    ...over,
  };
}

/** The golden blocked-fixable shape every sweep suite in this repo already uses. */
function blockedFixablePr(over: Partial<OpenPrView> = {}): OpenPrView {
  return pr({
    prNumber: 11,
    prUrl: "url/11",
    taskId: "W1-B",
    reviewState: "failure",
    checksState: "green",
    priorStrikes: 0,
    unmetCriteria: [
      { claim: "still needs work", proof: "unit test: x", met: false, reason: "not done", proof_exec: "executed_fail" },
    ],
    reviewSummary: "one criterion unmet",
    ...over,
  });
}

/** A PR the post-review lane is eligible for: checks green, no review posted yet. */
function postReviewPr(n: number): OpenPrView {
  return pr({
    prNumber: n,
    prUrl: `url/${n}`,
    taskId: `W1-R${n}`,
    reviewState: "none",
    checksState: "green",
    headSha: `head${n}`,
    lastActivityAt: RECENT,
  });
}

/**
 * A `dispatchFix` standing in for the real one: it does NOT settle until the test releases it,
 * which is exactly the property CI gives the production dep and which the tick used to inherit.
 */
function heldDispatch(): {
  dispatchFix: SweepDeps["dispatchFix"];
  calls: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }>;
  release: () => void;
  settled: () => boolean;
} {
  const calls: Array<{ pr: OpenPrView; evidence: FixDispatchEvidence }> = [];
  let release!: () => void;
  let settled = false;
  const gate = new Promise<void>((resolve) => {
    release = () => {
      settled = true;
      resolve();
    };
  });
  return {
    calls,
    release,
    settled: () => settled,
    dispatchFix: (p, evidence) => {
      calls.push({ pr: p, evidence });
      return gate as unknown as ReturnType<NonNullable<SweepDeps["dispatchFix"]>>;
    },
  };
}

function baseDeps(over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    arm: () => {},
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: ledgerPath(),
    runId: "SWEEP-T2379",
    now: () => NOW,
    ...over,
  };
}

/** Resolve once the microtask/timer queues have drained, without advancing any clock. */
const settle = () => new Promise<void>((r) => setImmediate(r));

// ── acceptance 1: a light pass whose action polls does not delay the next tick ──────────────

test("acceptance 1: the light pass RETURNS while its fix dispatch is still waiting — the tick is no longer bounded by CI", async () => {
  const held = heldDispatch();
  const deps = baseDeps({ dispatchFix: held.dispatchFix, actionable: (d) => d === "blocked-fixable" });

  let passResolved = false;
  const pass = runSweepLightPass([blockedFixablePr()], deps).then((s) => {
    passResolved = true;
    return s;
  });
  await settle();

  assert.equal(held.calls.length, 1, "the dispatch was STARTED — this is not a narrowing of what the pass may do");
  assert.equal(held.settled(), false, "and it has NOT settled: the action is still waiting, as CI would keep it");
  assert.equal(passResolved, true, "yet the pass has already returned — the tick is free to come round again");
  assert.equal(detachedSweepActionCount(), 1, "the wait is held for the drain rather than dropped");

  held.release();
  await drainDetachedSweepActions();
  assert.equal(detachedSweepActionCount(), 0, "and the registry empties once it settles");
  const summaries = await pass;
  assert.equal(summaries.length, 1);
});

test("FALSIFIER: the same fixture through the un-detached path (every non-tick caller) still blocks", async () => {
  // `runSweep` is what `rmd sweep` and the daemon's full per-iteration sweep call. It sets no
  // `detachFixWait`, so it must behave EXACTLY as before this task — if this test ever passes
  // without the release below, the change leaked into paths it was never meant to touch.
  const held = heldDispatch();
  const deps = baseDeps({ dispatchFix: held.dispatchFix, actionable: (d) => d === "blocked-fixable" });

  let resolved = false;
  const call = runSweep([blockedFixablePr()], deps).then((s) => {
    resolved = true;
    return s;
  });
  await settle();
  assert.equal(held.calls.length, 1, "the dispatch was started on this path too");
  assert.equal(resolved, false, "and the caller is STILL BLOCKED on it — the old behaviour, deliberately kept here");

  held.release();
  await call;
  assert.equal(resolved, true, "it resolves only once the action does");
});

// ── acceptance 2: the strike is recorded BEFORE the pass returns ────────────────────────────

test("acceptance 2: the sweep.disposed row is written with acted:true before the pass returns, so the dedup seed is unchanged", async () => {
  const held = heldDispatch();
  const path = ledgerPath();
  const deps = baseDeps({ ledgerPath: path, dispatchFix: held.dispatchFix, actionable: (d) => d === "blocked-fixable" });

  const fixPr = blockedFixablePr();
  try {
    await runSweepLightPass([fixPr], deps);

    // READ AT THE MOMENT THE PASS RETURNED — the action is provably still in flight, so this row
    // cannot have come from its completion.
    assert.equal(held.settled(), false, "the wait is still outstanding");
    const disposed = readLedgerLines(path).filter((l) => l.step === "sweep.disposed" && l.pr_number === fixPr.prNumber);
    assert.equal(disposed.length, 1, "exactly one disposed row for this PR");
    assert.equal(disposed[0]!.disposition, "blocked-fixable");
    assert.equal(disposed[0]!.acted, true, "acted:true — the strike is real, not deferred with the wait");
  } finally {
    held.release();
    await drainDetachedSweepActions();
  }
});

test("acceptance 2 (differential): two detached passes seed the dedup EXACTLY as two awaited passes do", async () => {
  // The claim is not "the second pass never dispatches" — `fixRungStalledWithoutNewHead`
  // (W1-T1110) DELIBERATELY re-arms a dispatch whose rung ended without landing a new head, and
  // this fixture has no landing rows, so a re-arm is the correct production answer. The claim is
  // that DETACHING CHANGED NOTHING: the detached path must produce byte-identical `acted` and
  // dispatch counts to the awaited path over the same two passes. A seed that failed to land
  // would show up here as a divergence.
  async function twoPasses(detached: boolean): Promise<{ dispatches: number; acted: unknown[] }> {
    const held = heldDispatch();
    const path = ledgerPath();
    const deps = baseDeps({ ledgerPath: path, dispatchFix: held.dispatchFix, actionable: (d) => d === "blocked-fixable" });
    const fixPr = blockedFixablePr();
    try {
      if (detached) {
        await runSweepLightPass([fixPr], deps);
        await runSweepLightPass([fixPr], deps);
      } else {
        const a = runSweep([fixPr], deps);
        held.release();
        await a;
        await runSweep([fixPr], deps);
      }
    } finally {
      held.release();
      await drainDetachedSweepActions();
    }
    const rows = readLedgerLines(path).filter((l) => l.step === "sweep.disposed" && l.pr_number === fixPr.prNumber);
    return { dispatches: held.calls.length, acted: rows.map((r) => r.acted) };
  }
  const detached = await twoPasses(true);
  const awaited = await twoPasses(false);
  assert.deepEqual(detached, awaited, "the detached path's dedup behaviour is identical to the awaited path's");
  assert.equal(detached.acted[0], true, "and the first pass really did record a strike");
});

test("acceptance 2 (both arms): the conflicted twin records its row the same way", async () => {
  const held = heldDispatch();
  const path = ledgerPath();
  const deps = baseDeps({ ledgerPath: path, dispatchFix: held.dispatchFix, actionable: (d) => d === "conflicted" });

  const conflicted = pr({
    prNumber: 21,
    prUrl: "url/21",
    taskId: "W1-C21",
    reviewState: "pending",
    checksState: "pending",
    headSha: "cccc333",
    mergeState: "dirty",
    mergeConflict: { files: [], oursLog: "abc ours", theirsLog: "def theirs" },
  });

  try {
    await runSweepLightPass([conflicted], deps);
    const disposed = readLedgerLines(path).filter((l) => l.step === "sweep.disposed" && l.pr_number === 21);
    assert.equal(disposed.length, 1, "the conflicted arm also wrote exactly one row before returning");
  } finally {
    held.release();
    await drainDetachedSweepActions();
  }
});

// ── acceptance 8: stopping still lets work already in flight finish ─────────────────────────

test("acceptance 8: draining awaits a detached action rather than abandoning it, and is safe when nothing is detached", async () => {
  const held = heldDispatch();
  const deps = baseDeps({ dispatchFix: held.dispatchFix, actionable: (d) => d === "blocked-fixable" });
  await runSweepLightPass([blockedFixablePr()], deps);
  assert.equal(detachedSweepActionCount(), 1);

  let drained = false;
  const drain = drainDetachedSweepActions().then(() => {
    drained = true;
  });
  await settle();
  assert.equal(drained, false, "the drain WAITS — work already in flight is finished, never aborted");

  held.release();
  await drain;
  assert.equal(drained, true);
  assert.equal(detachedSweepActionCount(), 0);

  // Safe to call with nothing detached, and safe to call twice — `stop()` runs it unconditionally.
  await drainDetachedSweepActions();
  await drainDetachedSweepActions();
});

test("acceptance 8: a detached action that REJECTS never becomes an unhandled rejection and never blocks the drain", async () => {
  const deps = baseDeps({
    dispatchFix: () => Promise.reject(new Error("CI wait blew up")) as never,
    actionable: (d) => d === "blocked-fixable",
    ledgerPath: ledgerPath(),
  });
  // The pass must still return, and the drain must still settle — the row was already written,
  // and a dispatch that ends without landing a new head is exactly what W1-T1110 re-arms from.
  await runSweepLightPass([blockedFixablePr()], deps);
  await drainDetachedSweepActions();
  assert.equal(detachedSweepActionCount(), 0, "a rejection empties the registry like any other settle");
});

// ── acceptance 1, through the REAL ticker ───────────────────────────────────────────────────

const PLAN_YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "t2379-plan-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, PLAN_YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });

/**
 * Drives the REAL `startInFlightTicker` through `runDaemon`, with a `sweepLight` that runs a REAL
 * `runSweepLightPass` whose fix dispatch never settles. Returns the ticker's own rows and every
 * interval it slept.
 */
async function ticksWhileAFixDispatchHangs(): Promise<{
  alive: number;
  sleptMs: number[];
  passes: number;
  stillHangingAtSecondTick: boolean;
}> {
  const held = heldDispatch();
  const plan = fixturePlan();
  const merged = new Set<string>();
  const sleptMs: number[] = [];
  let alive = 0;
  let passes = 0;
  let stillHangingAtSecondTick = false;
  let release: (() => void) | undefined;
  const dispatchGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deps: Partial<DaemonDeps> = {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => {
      await dispatchGate;
      merged.add(id);
      return okResult(id);
    },
    sweepLight: async () => {
      passes++;
      await runSweepLightPass(
        [blockedFixablePr({ prNumber: 100 + passes, headSha: `head${passes}` })],
        baseDeps({ dispatchFix: held.dispatchFix, actionable: (d) => d === "blocked-fixable" }),
      );
    },
    sleep: async (ms) => {
      sleptMs.push(ms);
      // Snapshot at the SECOND sleep: the first light pass has run and returned by now, so if the
      // dispatch is still unsettled here, the tick provably did not wait for it. Under the old
      // behaviour the first pass never returns and this second sleep never happens at all.
      if (sleptMs.length === 2) stillHangingAtSecondTick = !held.settled();
      // Four ticks is enough. Release BOTH gates: `stop()` now drains the detached action, so
      // leaving it pending would deadlock the shutdown this test is not trying to exercise.
      if (sleptMs.length >= 4) {
        release?.();
        held.release();
      }
    },
    log: (step) => {
      if (step === "daemon.alive") alive++;
    },
  };
  await runDaemon(plan, deps as DaemonDeps, { max: 1 });
  held.release();
  await drainDetachedSweepActions();
  return { alive, sleptMs, passes, stillHangingAtSecondTick };
}

test("acceptance 1 (through the real ticker): daemon.alive keeps arriving while a fix dispatch hangs, and every sleep is the poll interval", async () => {
  const r = await ticksWhileAFixDispatchHangs();
  assert.ok(r.passes >= 2, `the ticker ran more than one light pass while the dispatch hung (saw ${r.passes})`);
  assert.ok(r.alive >= 2, `and emitted a daemon.alive row for each (saw ${r.alive})`);
  assert.equal(r.stillHangingAtSecondTick, true, "the dispatch was STILL hanging when the second tick came round — the tick did not wait for it");
});

// ── acceptance 3 and 4: the floor, and no second ticker ─────────────────────────────────────

test("acceptance 3: every interval the ticker sleeps is the 60,000 ms poll interval, and nothing on this path sleeps less", async () => {
  const r = await ticksWhileAFixDispatchHangs();
  assert.ok(r.sleptMs.length >= 2, "the ticker slept more than once");
  for (const ms of r.sleptMs) {
    assert.ok(ms >= 60_000, `a sleep of ${ms}ms would cross the 60,000 ms floor — W1-T1066 is why that must never happen`);
  }
  assert.deepEqual([...new Set(r.sleptMs)], [60_000], "and there is exactly ONE interval in use, unchanged");
});

test("acceptance 4: no second ticker and no shortened interval — one sleeper, one value, and the drain adds no timer of its own", async () => {
  // A second ticker would show up as a second, different interval in the same run.
  const r = await ticksWhileAFixDispatchHangs();
  assert.equal(new Set(r.sleptMs).size, 1, "exactly one distinct interval across the whole run");

  // And the drain itself must not schedule anything: global timer counts are unchanged across it.
  const held = heldDispatch();
  const deps = baseDeps({ dispatchFix: held.dispatchFix, actionable: (d) => d === "blocked-fixable" });
  await runSweepLightPass([blockedFixablePr()], deps);
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  let timers = 0;
  globalThis.setTimeout = ((...a: unknown[]) => {
    timers++;
    return (realSetTimeout as unknown as (...x: unknown[]) => unknown)(...a);
  }) as typeof setTimeout;
  globalThis.setInterval = ((...a: unknown[]) => {
    timers++;
    return (realSetInterval as unknown as (...x: unknown[]) => unknown)(...a);
  }) as typeof setInterval;
  try {
    held.release();
    await drainDetachedSweepActions();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
  }
  assert.equal(timers, 0, "the drain schedules no timer — it waits on the promise it already holds");
});

// ── acceptance 5, 6 and 7: the three bounds this task does NOT touch ────────────────────────

test("acceptance 5: W1-T1211's blocked-fixable admission still fires exactly where it fires today", () => {
  // This is a fix to how long the dispatcher's CALLER blocks, never to WHETHER it may dispatch.
  assert.equal(lightPassActionable("blocked-fixable", true), true, "admitted when the fix rung may act");
  assert.equal(lightPassActionable("conflicted", true), true);
  assert.equal(lightPassActionable("blocked-fixable", false), false, "and still stood down when it may not");
  assert.equal(lightPassActionable("conflicted", false), false);
  assert.equal(lightPassActionable("post-review", false), true, "post-review remains unconditional");
  for (const d of ["stale", "blocked-ambiguous", "dep-review", "mergeable", "wait"] as const) {
    assert.equal(lightPassActionable(d, true), false, `${d} still stands down`);
  }
});

test("acceptance 6: at most one open PR is still admitted to post-review per light pass", async () => {
  const posted: number[] = [];
  const deps = baseDeps({
    ledgerPath: ledgerPath(),
    actionable: (d) => d === "post-review",
    postReview: (p: OpenPrView) => {
      posted.push(p.prNumber);
      return Promise.resolve(undefined) as never;
    },
  } as Partial<SweepDeps>);

  await runSweepLightPass([postReviewPr(31), postReviewPr(32), postReviewPr(33)], deps);
  assert.ok(posted.length <= 1, `W1-T526's one-per-pass bound is untouched; saw ${posted.length} review dispatches`);
  await drainDetachedSweepActions();
});

test("acceptance 7: the two-strike fix ceiling is unchanged", () => {
  assert.equal(DEFAULT_SWEEP_POLICY.strikeCap, 2, "detaching a wait must not detach the bound that stops the rung retrying");
});

test("acceptance 7: a PR already at the strike cap is still not dispatched from a light pass", async () => {
  const held = heldDispatch();
  const deps = baseDeps({ dispatchFix: held.dispatchFix, actionable: (d) => d === "blocked-fixable" });
  await runSweepLightPass([blockedFixablePr({ priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap })], deps);
  assert.equal(held.calls.length, 0, "at the cap, no dispatch is started at all — detaching changed nothing here");
  await drainDetachedSweepActions();
});
