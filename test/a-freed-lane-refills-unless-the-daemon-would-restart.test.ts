// W1-T5083 — A FREED LANE ALMOST NEVER REFILLED. W1-T4416's lane pool held 19 of 21 refills on 2026-09-30..10-01:
// any stale reading held the lane ("stale code") although the top of tick now defers a low-weight advance
// (W1-T4945), and any rejected sibling closed refill for the whole pass ("a lane rejected"). On 10-01 W1-T4810
// merged at 06:24 after 71 min and its lane stayed empty behind W1-T4772's 80+ min run. These drive the REAL
// runDaemon at laneCount 2; only the worker spawn and the freshness reading are faked.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { test } from "node:test";
import { loadPlan } from "../src/lib/plan.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { FRESHNESS_COALESCE_WINDOW_MS } from "../src/lib/deploy-judge.js";
import type { RunResult } from "../src/run-task.js";

function threeDisjointPlan() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-lane-refill-fresh-"));
  const f = join(dir, "tasks.yaml");
  const task = (id: string) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`;
  writeFileSync(f, task("A") + task("B") + task("C"));
  return loadPlan(f);
}

const okResult = (id: string): RunResult =>
  ({ taskId: id, merged: true, verdict: "merged", costUsd: 0, prUrl: `https://x/${id}` }) as unknown as RunResult;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

type Line = { step: string; extra?: Record<string, unknown> };

const staleWith = (files: string[]) => ({
  stale: true as const,
  oldSha: "a".repeat(40),
  newSha: "b".repeat(40),
  // One commit per file: W1-T9089 weighs every source commit alike, so a material advance is a threshold of them.
  changes: files.map((file, n) => ({ sha: n.toString(16).padStart(40, "b"), subject: "feat: x", files: [file] })),
});
/** W1-T9089: with the self-path list retired, a restart-worthy advance is a threshold's worth (18) of source commits. */
const MATERIAL = Array.from({ length: 18 }, (_, n) => `src/lib/module-${n}.ts`);

/** A and B are held open until released; C completes at once. Freshness reads fresh until `goStale` flips it. */
function harness(staleFiles: string[] | undefined) {
  const steps: Line[] = [];
  const started: string[] = [];
  const release = { A: deferred<RunResult>(), B: deferred<RunResult>() };
  const bothStarted = deferred<void>();
  let aSettled = false;
  let stale = false;
  let nowMs = Date.now();
  const sleeps: Array<ReturnType<typeof deferred<void>>> = [];
  const startedWhileARan: string[] = [];
  const runOne = (id: string): Promise<RunResult> => {
    started.push(id);
    if (!aSettled && id !== "A") startedWhileARan.push(id);
    if (started.includes("A") && started.includes("B")) bothStarted.resolve();
    if (id === "A" || id === "B") return release[id].promise;
    return Promise.resolve(okResult(id));
  };
  const run = runDaemon(
    threeDisjointPlan(),
    {
      refreshMerged: () => () => false,
      log: (step: string, extra?: Record<string, unknown>) => steps.push({ step, extra }),
      runOne,
      now: () => new Date(nowMs),
      sleep: () => {
        const sleep = deferred<void>();
        sleeps.push(sleep);
        return sleep.promise;
      },
      checkFreshness: () => (stale && staleFiles ? staleWith(staleFiles) : { stale: false }),
    } as unknown as DaemonDeps,
    { freshnessMinLifetimeMs: 0, max: 3, laneCount: 2 },
  );
  return {
    steps,
    started,
    release,
    bothStarted,
    startedWhileARan,
    run,
    goStale: () => {
      stale = true;
    },
    tick: async () => {
      await drainMicrotasks();
      sleeps.shift()?.resolve();
      await drainMicrotasks();
      await drainMicrotasks();
    },
    advanceClock: (ms: number) => { nowMs += ms; },
    settleA: () => {
      aSettled = true;
      release.A.resolve(okResult("A"));
    },
  };
}

test("W1-T5083: a deferred low-weight advance does not hold a freed lane", async () => {
  const h = harness(["src/lib/inbox.ts"]);
  await h.bothStarted.promise;
  h.goStale(); // main advanced AFTER admission, by a low-weight change: a busy daemon defers it
  h.release.B.resolve(okResult("B"));
  await drainMicrotasks();
  assert.deepEqual(h.startedWhileARan, ["B", "C"], "C started on B's freed lane while A still ran");
  const decision = h.steps.find((l) => l.step === "daemon.freshness_decision");
  assert.equal(decision?.extra?.action, "defer");
  assert.equal(decision?.extra?.busy, true, "a sibling in flight makes the refill's reading busy by construction");
  assert.deepEqual(
    h.steps.filter((l) => l.step === "dispatch.lane_refilled").map((l) => l.extra),
    [{ lane: 1, finished_task: "B", next_task: "C" }],
  );
  h.settleA();
  await h.run.catch(() => undefined);
});

test("W1-T5083: an advance that would restart the daemon still holds the freed lane after the quiet window", async () => {
  const h = harness(MATERIAL);
  await h.bothStarted.promise;
  h.goStale();
  await h.tick();
  const coalesced = h.steps.find((l) => l.step === "daemon.freshness_coalesced");
  assert.equal(coalesced?.extra?.action, "hold");
  assert.equal(coalesced?.extra?.held_ms, 0);
  assert.equal(h.steps.some((l) => l.step === "daemon.freshness_decision" && l.extra?.action === "restart"), false);
  h.advanceClock(FRESHNESS_COALESCE_WINDOW_MS.value);
  await h.tick(); // past the window: the dispatch tick decides to restart
  assert.ok(h.steps.some((l) => l.step === "daemon.freshness_decision" && l.extra?.action === "restart"));
  // W1-T9089: A in flight at the decision is awaited; no daemon latch reaches into it.
  h.release.B.resolve(okResult("B"));
  await drainMicrotasks();
  assert.deepEqual(h.startedWhileARan, ["B"], "nothing admitted onto B's freed lane");
  const held = h.steps.find((l) => l.step === "dispatch.lane_refill_held");
  assert.equal(held?.extra?.reason, "restart decided: no candidate runs as a child");
  const released = h.steps.filter((l) => l.step === "daemon.freshness_coalesced").at(-1);
  assert.equal(released?.extra?.reason, "window_quiet");
  assert.equal(released?.extra?.held_ms, FRESHNESS_COALESCE_WINDOW_MS.value);
  h.settleA();
  assert.equal((await h.run).stopReason, "stale");
});

test("W1-T5083: a coalesced self-path advance refills a freed lane during the hold", async () => {
  const h = harness(MATERIAL);
  await h.bothStarted.promise;
  h.goStale();
  await h.tick();
  h.advanceClock(FRESHNESS_COALESCE_WINDOW_MS.value - 1);
  h.release.B.resolve(okResult("B"));
  await drainMicrotasks();
  assert.deepEqual(h.startedWhileARan, ["B", "C"]);
  const held = h.steps.filter((l) => l.step === "daemon.freshness_coalesced").at(-1);
  assert.equal(held?.extra?.action, "hold");
  assert.equal(held?.extra?.held_ms, FRESHNESS_COALESCE_WINDOW_MS.value - 1);
  assert.equal(h.steps.some((l) => l.step === "daemon.freshness_decision" && l.extra?.action === "restart"), false);
  h.settleA();
  assert.equal((await h.run).stopReason, "max_reached");
});

test("W1-T5083: one rejected sibling does not close refill for the rest of the pass", async () => {
  const h = harness(undefined);
  await h.bothStarted.promise;
  // A lane-local GitHub read failure: the settle loop logs it and the pass continues (W1-T4466), so it is
  // no reason to stop refilling the other lanes either.
  h.release.B.reject(new Error("Command failed: gh api repos/o/r/commits/deadbeef/check-runs?per_page=100"));
  await drainMicrotasks();
  assert.deepEqual(h.startedWhileARan, ["B", "C"], "C started on B's freed lane although B rejected");
  assert.equal(h.steps.filter((l) => l.step === "dispatch.lane_refill_held" && l.extra?.reason === "a lane rejected").length, 0);
  h.settleA();
  await h.run;
  assert.ok(h.steps.some((l) => l.step === "daemon.gh_read_failed"), "the rejected lane is still classified as today");
});
