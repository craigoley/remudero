/**
 * test/light-pass-tick-is-not-bounded-by-ci.test.ts — W1-T2379.
 *
 * THE DEFECT (plan record's own rationale). `startInFlightTicker` (src/lib/daemon.ts) awaits
 * `deps.sweepLight()`; `runSweepLightPass` (src/lib/sweep.ts) resolves via `Promise.all` over
 * every open PR; and the ONE admitted `blocked-fixable`/`conflicted` dispatch used to await
 * `deps.dispatchFix(...)` to full completion — including whatever CI wait its real wiring runs
 * AFTER the strike is already spent. So the row that fires every `pollIntervalMs` (measured 34
 * times an hour) fired ZERO times for sixteen minutes while two green PRs sat unreviewed: one
 * admitted dispatch's CI wait held the whole tick hostage.
 *
 * THE FIX (design note (i)(a)). `dispatchFix` may now return a {@link DetachedDispatchFix} —
 * `{ dispatched, settled }` — and `runSweep` awaits ONLY `dispatched` (the fast half: the strike
 * is spent and its ledger row written) while `settled` (the slow half: the CI wait, whatever
 * follows it) runs on, never awaited by this pass. See `resolveDispatchFixOutcome`'s own doc
 * (src/lib/sweep.ts) for the full contract.
 *
 * THE FALSIFIER (design note (iv)). Every test below that drives the REAL `runSweepLightPass`/
 * `runSweep` with a `dispatchFix` whose `settled` gate is deliberately left open for the whole
 * test would HANG — and, via the bounded race each one runs, FAIL — against the pre-fix code,
 * which awaited `dispatchFix` whole. No daemon, no network, no real CI: a fake clock
 * (`sleep: async () => {}`) and a fake action (the never-released `settled` gate) are the whole
 * fixture, exactly as the design note requires.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDaemon, DEFAULT_POLL_INTERVAL_MS, type DaemonDeps } from "../src/lib/daemon.js";
import type { RunResult } from "../src/lib/run-result.js";
import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  runSweep,
  runSweepLightPass,
  type DetachedDispatchFix,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";
import { appendLedger } from "../src/lib/ledger.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-08-27T12:00:00Z");
const RECENT = "2026-08-27T11:00:00Z";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-light-pass-tick-")), "ledger.ndjson");
}

const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "light-pass-tick-plan-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

/** A `blocked-fixable` shaped PR (checks green, review failing, one unmet criterion). */
function blockedFixablePr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 11,
    prUrl: "url/11",
    taskId: "W1-B",
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [
      { claim: "criterion one", proof: "unit test: it works", met: false, reason: "not done", proof_exec: "executed_fail" },
    ],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "aaaa111",
    autoMergeArmed: false,
    ...over,
  };
}

/** A `post-review`-eligible PR (checks green, review never posted). */
function postReviewPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 584,
    prUrl: "url/584",
    taskId: "W1-T584",
    reviewState: "none",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "bbbb584",
    autoMergeArmed: false,
    ...over,
  };
}

/** A REAL (macrotask-scheduled, not microtask-instant) delay on the "dispatched" half —
 *  deliberately not `Promise.resolve(...)`. `await <a plain, non-thenable object>` resolves in
 *  ONE microtask turn regardless of what its own properties later do, so a same-tick resolve
 *  here would let a pre-fix call site that still does `await deps.dispatchFix(...)` (ignoring
 *  the object's `dispatched`/`settled` split entirely) return just as fast BY ACCIDENT — proving
 *  nothing about whether that call site actually awaited `dispatched`. A real timer closes that
 *  gap: only a call site that GENUINELY awaits `dispatched` observes it end after this delay. */
function afterRealDelay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** A `dispatchFix` that returns the W1-T2379 detached shape: `dispatched` resolves after a real
 *  short delay (writing the SAME `fix.dispatch` ledger row the real wiring writes before its own
 *  CI wait ever starts), `settled` is a `settleGate` the caller controls (simulating a real CI
 *  wait that has not resolved yet). */
function detachedDispatchFix(
  ledgerPath: string,
  settleGate: Promise<boolean | void>,
  calls: { count: number } = { count: 0 },
): SweepDeps["dispatchFix"] {
  return (pr): DetachedDispatchFix => {
    calls.count++;
    return {
      dispatched: afterRealDelay(20, undefined).then(() => {
        appendLedger(ledgerPath, {
          run_id: "SWEEP-1",
          task_id: pr.taskId ?? "SWEEP",
          step: "fix.dispatch",
          strike: (pr.priorStrikes ?? 0) + 1,
        });
        return true;
      }),
      settled: settleGate,
    };
  };
}

function baseSweepDeps(over: Partial<SweepDeps> = {}): SweepDeps {
  return {
    ledgerPath: ledgerPath(),
    runId: "SWEEP-1",
    now: () => NOW,
    arm: () => {},
    close: () => {},
    escalate: () => {},
    dispatchFix: () => {},
    ...over,
  };
}

/** Races a promise against a bounded timeout so a regression HANGS the test loudly and fast,
 *  rather than silently exhausting the test runner's own (much longer) timeout. */
async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// ── acceptance 1/3/4 — the tick's own cadence ───────────────────────────────
//
// One `runDaemon` drive, wired to the REAL `runSweepLightPass`/`runSweep` (never a fake
// `sweepLight` that stands in for them) over an admitted `blocked-fixable` PR whose
// `dispatchFix` returns a `settled` gate this test deliberately never releases. Proves three
// acceptance lines from the SAME run: the tick keeps its own cadence (1), the poll floor it
// sleeps on is never touched (3), and no second ticker/mechanism appears alongside it (4).

test("W1-T2379: a light pass whose action polls does not delay the next tick beyond the poll interval, the sixty-second floor holds, and no second ticker appears", async () => {
  const plan = fixturePlan();
  const lp = ledgerPath();
  let releaseSettle: (() => void) | undefined;
  const settleGate = new Promise<boolean | void>((resolve) => {
    releaseSettle = () => resolve(true);
  });
  const dispatchCalls = { count: 0 };
  const openPr = blockedFixablePr();
  const sweepDeps = baseSweepDeps({ ledgerPath: lp, dispatchFix: detachedDispatchFix(lp, settleGate, dispatchCalls) });

  let sweepLightCalls = 0;
  let releaseRunOne: (() => void) | undefined;
  const runOneGate = new Promise<void>((resolve) => {
    releaseRunOne = resolve;
  });
  let iterations = 0;
  const sleeps: number[] = [];
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];

  const pending = runDaemon(plan, {
    refreshMerged: () => () => false, // stays OPEN — a real in-flight runOne drives the "dispatch" phase ticker
    runOne: async (): Promise<RunResult> => {
      await runOneGate;
      return { taskId: "A", runId: "A-run", merged: true, costUsd: 0, verdict: "merged" };
    },
    checkStop: () => (iterations >= 1 ? "test bound reached" : undefined),
    sweepLight: async () => {
      sweepLightCalls++;
      // THE REAL PIPELINE, never a stand-in: startInFlightTicker -> sweepLight -> runSweepLightPass
      // -> runSweep -> deps.dispatchFix, exactly the chain the plan record traces the stall to.
      await runSweepLightPass([openPr], sweepDeps, DEFAULT_SWEEP_POLICY);
      // Ends the scenario once the property is demonstrated — never by releasing `settleGate`,
      // which stays open for the WHOLE test (see the assertion below).
      if (sweepLightCalls >= 3) releaseRunOne?.();
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (step, extra = {}) => {
      lines.push({ step, extra: extra ?? {} });
      if (step === "daemon.iteration") iterations++;
    },
  } satisfies DaemonDeps);

  const summary = await withTimeout(
    pending,
    2000,
    "the daemon never finished — a light pass is still gating the next tick on the still-open CI settle, the W1-T2379 regression",
  );
  assert.equal(summary.stopReason, "stopped");

  // Acceptance 1: the tick kept its own cadence — several sweepLight() calls landed while
  // `settleGate` stayed open the entire time (never released above, only after this assertion).
  assert.ok(sweepLightCalls >= 3, `the light pass kept ticking while the admitted fix's CI wait stayed open (saw ${sweepLightCalls})`);
  // The strike written on tick 1's ledger row deduped every later tick's dispatch attempt (the
  // SAME "already dispatched, awaiting its outcome" stand-down blocked-fixable always had) — a
  // detached wait does not turn into repeated re-dispatch of the same still-settling head.
  assert.equal(dispatchCalls.count, 1, "no re-dispatch fired while the first strike was still settling");

  // Acceptance 3: the sixty-second floor is never crossed on this path — every sleep this run
  // performed used the SAME injected poll interval, never a shorter one.
  assert.ok(sleeps.length > 0, "the ticker really did sleep between ticks");
  assert.ok(
    sleeps.every((ms) => ms === DEFAULT_POLL_INTERVAL_MS),
    `every sleep must be the full poll interval (${DEFAULT_POLL_INTERVAL_MS}ms), never shortened — saw ${JSON.stringify(sleeps)}`,
  );

  // Acceptance 4: no second ticker/mechanism. Exactly one `daemon.alive` row per observed
  // sweepLight() tick (never more, which a second concurrent ticker would produce), every one
  // from the SAME "dispatch" phase, every one carrying the SAME unshortened interval.
  const aliveRows = lines.filter((l) => l.step === "daemon.alive");
  assert.equal(aliveRows.length, sweepLightCalls, "one daemon.alive row per tick — no second ticker firing alongside it");
  assert.ok(aliveRows.every((r) => r.extra.phase === "dispatch"), "every liveness row comes from the one dispatch-phase ticker");
  assert.ok(
    aliveRows.every((r) => r.extra.poll_interval_ms === DEFAULT_POLL_INTERVAL_MS),
    "every liveness row carries the unshortened interval",
  );

  releaseSettle?.();
});

// ── acceptance 2 — the strike is recorded before the pass returns ──────────

test("W1-T2379: the fix rung's strike is recorded before the pass returns, so the dedup seed is unchanged", async () => {
  const lp = ledgerPath();
  const openPr = blockedFixablePr();
  let releaseSettle: (() => void) | undefined;
  const settleGate = new Promise<boolean | void>((resolve) => {
    releaseSettle = () => resolve(true);
  });
  const sweepDeps = baseSweepDeps({ ledgerPath: lp, dispatchFix: detachedDispatchFix(lp, settleGate) });

  // The pass returns despite `settleGate` never having been released — proves `dispatched`
  // alone, never `settled`, is what `runSweep` waits on.
  const summaries = await withTimeout(
    runSweepLightPass([openPr], sweepDeps, DEFAULT_SWEEP_POLICY),
    2000,
    "runSweepLightPass never returned — it is still awaiting the detached settle, the W1-T2379 regression",
  );
  assert.equal(summaries.length, 1);

  const rows = readLedgerLines(lp);
  const disposed = rows.filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0].disposition, "blocked-fixable");
  assert.equal(disposed[0].acted, true, "the dispatch is recorded as acted — the row exists before the pass returns");
  assert.ok(
    rows.some((r) => r.step === "fix.dispatch" && r.task_id === openPr.taskId),
    "the strike's own fix.dispatch row is written before the pass returns, not deferred to the settle",
  );

  // A SECOND pass over the same (stale) snapshot must dedup rather than re-dispatch — the dedup
  // seed this task's rationale names (W1-T1127/W1-T1110) is unchanged by detaching the wait.
  const calls2 = { count: 0 };
  const sweepDeps2 = baseSweepDeps({ ledgerPath: lp, dispatchFix: detachedDispatchFix(lp, settleGate, calls2) });
  await runSweepLightPass([openPr], sweepDeps2, DEFAULT_SWEEP_POLICY);
  assert.equal(calls2.count, 0, "the still-settling head deduped — no second strike spent while its outcome is pending");

  releaseSettle?.();
});

// ── acceptance 5/7 — the blocked-fixable admission is untouched ────────────

test("W1-T2379: the blocked-fixable admission still fires exactly where it fires today", () => {
  const r = deriveDisposition(blockedFixablePr(), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-fixable");
});

test("W1-T2379: the two-strike fix ceiling is unchanged — strikes at cap route to blocked-ambiguous, never another dispatch", () => {
  const exhausted = blockedFixablePr({ priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap });
  const r = deriveDisposition(exhausted, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(r.disposition, "blocked-ambiguous");
  assert.match(r.reason, /strikes exhausted/);
});

// ── acceptance 6 — the one-per-pass review admission is untouched ──────────

test("W1-T2379: at most one open PR is still admitted to post-review per pass", async () => {
  const lp = ledgerPath();
  const posted: number[] = [];
  const sweepDeps = baseSweepDeps({
    ledgerPath: lp,
    postReview: (pr) => {
      posted.push(pr.prNumber);
    },
  });
  const older = postReviewPr({ prNumber: 584, prUrl: "url/584", taskId: "W1-T584", lastActivityAt: "2026-08-20T00:00:00Z" });
  const younger = postReviewPr({
    prNumber: 585,
    prUrl: "url/585",
    taskId: "W1-T585",
    headSha: "cccc585",
    lastActivityAt: "2026-08-26T00:00:00Z",
  });
  const summaries = await runSweepLightPass([older, younger], sweepDeps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(posted, [584], "only the oldest-head PR's review actually posted this pass");
  assert.equal(summaries.length, 2, "both PRs still get their own summary — the non-admitted one stands down, never dropped");
});

// ── acceptance 8 — stopping the ticker lets in-flight work finish, never aborts it ─────

test("W1-T2379: stopping the ticker still lets work already in flight finish rather than aborting it", async () => {
  const plan = fixturePlan();
  const lp = ledgerPath();
  const openPr = blockedFixablePr();

  // The "dispatched" half itself is gated here — this test proves the TICKER's own stop()
  // discipline, so it holds open the fast half this task's fix otherwise lets resolve quickly.
  let releaseDispatched: (() => void) | undefined;
  const dispatchedGate = new Promise<void>((resolve) => {
    releaseDispatched = resolve;
  });
  const sweepDeps = baseSweepDeps({
    ledgerPath: lp,
    dispatchFix: (pr): DetachedDispatchFix => ({
      dispatched: dispatchedGate.then(() => {
        appendLedger(lp, { run_id: "SWEEP-1", task_id: pr.taskId ?? "SWEEP", step: "fix.dispatch", strike: 1 });
        return true;
      }),
      settled: Promise.resolve(true),
    }),
  });

  let sweepLightCalls = 0;
  let sweepLightCompletions = 0;
  let releaseRunOne: (() => void) | undefined;
  const runOneGate = new Promise<void>((resolve) => {
    releaseRunOne = resolve;
  });
  let iterations = 0;

  const pending = runDaemon(plan, {
    refreshMerged: () => () => false,
    runOne: async (): Promise<RunResult> => {
      await runOneGate;
      return { taskId: "A", runId: "A-run", merged: true, costUsd: 0, verdict: "merged" };
    },
    checkStop: () => (iterations >= 1 ? "test bound reached" : undefined),
    log: (step) => {
      if (step === "daemon.iteration") iterations++;
    },
    sweepLight: async () => {
      sweepLightCalls++;
      await runSweepLightPass([openPr], sweepDeps, DEFAULT_SWEEP_POLICY);
      sweepLightCompletions++;
    },
    sleep: async () => {},
  } satisfies DaemonDeps);

  // Let the first sweepLight() call start and genuinely be in flight (its own "dispatched" half
  // still gated) before releasing runOne.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sweepLightCalls, 1, "one sweepLight() call is in flight");
  assert.equal(sweepLightCompletions, 0, "and it has not resolved yet — its own dispatch is still gated");

  releaseRunOne?.();
  // Flush every microtask this unblocks: runOne resolves, the "dispatch" phase's own await
  // settles, and the ticker's stop() is reached and begins awaiting the in-flight sweepLight()
  // call — which is STILL gated, so it must not have been allowed to finish (let alone abort).
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sweepLightCompletions, 0, "stop() must be awaiting the in-flight call, not have skipped past it");

  releaseDispatched?.();
  const summary = await withTimeout(
    pending,
    2000,
    "the daemon never finished after releasing the in-flight call's own gate",
  );
  assert.equal(summary.stopReason, "stopped");
  assert.equal(sweepLightCompletions, 1, "the in-flight sweepLight() call was allowed to finish, not aborted, once released");
  assert.ok(readLedgerLines(lp).some((r) => r.step === "fix.dispatch"), "and its own strike still landed on the ledger");
});

// ── W1-T463 regression check — the same fixture drives runSweep directly, so a reader can see
//    the detached shape behaves identically whether reached via the light pass's concurrent
//    fan-out (runSweepLightPass, above) or a bare runSweep call (rmd sweep's own path). ─────────

test("W1-T2379: a bare runSweep call (rmd sweep's own path) still awaits dispatchFix's plain-promise shape to completion, unchanged", async () => {
  const lp = ledgerPath();
  const openPr = blockedFixablePr();
  let resolved = false;
  const sweepDeps = baseSweepDeps({
    ledgerPath: lp,
    dispatchFix: async (pr) => {
      await new Promise((r) => setTimeout(r, 5));
      resolved = true;
      appendLedger(lp, { run_id: "SWEEP-1", task_id: pr.taskId ?? "SWEEP", step: "fix.dispatch", strike: 1 });
    },
  });
  await runSweep([openPr], sweepDeps, DEFAULT_SWEEP_POLICY);
  assert.equal(resolved, true, "a bare-promise dispatchFix is still awaited to completion — the widening is opt-in, not a behavior change for existing callers");
});
