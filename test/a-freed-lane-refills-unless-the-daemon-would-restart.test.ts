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
  changes: [{ sha: "b".repeat(40), subject: "feat: x", files }],
});

/** A and B are held open until released; C completes at once. Freshness reads fresh until `goStale` flips it. */
function harness(staleFiles: string[] | undefined) {
  const steps: Line[] = [];
  const started: string[] = [];
  const release = { A: deferred<RunResult>(), B: deferred<RunResult>() };
  const bothStarted = deferred<void>();
  let aSettled = false;
  let stale = false;
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
      sleep: async () => {},
      checkFreshness: () => (stale && staleFiles ? staleWith(staleFiles) : { stale: false }),
    } as unknown as DaemonDeps,
    { max: 3, laneCount: 2 },
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

test("W1-T5083: an advance that would restart the daemon still holds the freed lane", async () => {
  const h = harness(["src/lib/daemon.ts"]);
  await h.bothStarted.promise;
  h.goStale(); // a change to the daemon's own loop: restart-worthy even while busy
  h.release.B.resolve(okResult("B"));
  await drainMicrotasks();
  assert.deepEqual(h.startedWhileARan, ["B"], "nothing admitted onto B's freed lane");
  const held = h.steps.find((l) => l.step === "dispatch.lane_refill_held");
  assert.equal(held?.extra?.reason, "stale code");
  assert.equal(held?.extra?.freshness_action, "restart");
  h.settleA();
  await h.run.catch(() => undefined);
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
