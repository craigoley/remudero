import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { test } from "node:test";
import { runDaemon, type DaemonDeps, type DaemonFreshness } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import { detachSweepAction, inFlightReviewCount, restartInterruptibleDetachedActionCount, trackInFlightReview } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { RunResult } from "#src/lib/run-result.js";

/**
 * W1-T10054 — every one of 1,488 freshness decisions of 2026-10-12..17 read busy true, so W1-T4945's idle arm never fired
 * and every freshness restart paid a drain. Busy now counts only work a restart would interrupt: live lanes, in-flight
 * reviews and detached worker/admission work. The daemon's own passes are named on the row as `background`.
 */

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const stale = (files: string[]): DaemonFreshness => ({ stale: true, oldSha: OLD_SHA, newSha: NEW_SHA, changes: [{ sha: NEW_SHA, subject: "feat: x", files }] });
const MATERIAL = Array.from({ length: 18 }, (_, n) => `src/lib/module-${n}.ts`);
const staleMaterial = (): DaemonFreshness => ({
  stale: true, oldSha: OLD_SHA, newSha: NEW_SHA,
  changes: MATERIAL.map((file, n) => ({ sha: n.toString(16).padStart(40, "b"), subject: "feat: x", files: [file] })),
});

const task = (id: string, file: string) =>
  `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [${file}]\n`;
const planOf = (yaml: string) => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}freshness-idle-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, yaml);
  return loadPlan(f);
};
const okResult = (id: string): RunResult => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" }) as RunResult;

type Line = { step: string; extra: Record<string, unknown> };
const decisions = (lines: Line[]) => lines.filter((l) => l.step === "daemon.freshness_decision").map((l) => l.extra);

function within<T>(work: Promise<T>, ms: number): Promise<T | "timed-out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"timed-out">((resolve) => { timer = setTimeout(() => resolve("timed-out"), ms); });
  return Promise.race([work, bound]).finally(() => clearTimeout(timer));
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test("W1-T10054: a stale daemon whose only work is a background sweep pass restarts as idle", async () => {
  const lines: Line[] = [];
  const pass = deferred<void>();
  let passes = 0;
  const daemon = runDaemon(
    planOf(task("A", "src/a.ts")),
    {
      refreshMerged: () => () => true,
      runOne: async (id: string) => okResult(id),
      sleep: async () => {},
      log: (step: string, extra: Record<string, unknown> = {}) => {
        lines.push({ step, extra });
        // The pass is the daemon's own work: it ends only once the restart is decided.
        if (step === "daemon.freshness_decision") pass.resolve();
      },
      sweep: async () => { passes++; if (passes === 1) await pass.promise; return {}; },
      checkFreshness: () => stale(["src/lib/inbox.ts"]),
    } as unknown as DaemonDeps,
    { freshnessMinLifetimeMs: 0, sweepWallClockBoundMs: 60_000 },
  );
  const summary = await within(daemon, 5_000);
  pass.resolve();
  assert.notEqual(summary, "timed-out");
  const made = decisions(lines);
  assert.equal(made[0]!.action, "restart", "the pass in flight did not defer the restart");
  assert.equal(made[0]!.busy, false);
  assert.deepEqual(made[0]!.busy_reasons, []);
  assert.equal((made[0]!.background as Record<string, unknown>).sweep_pass, true, "the row names the pass as background");
  assert.equal(lines.filter((l) => l.step === "daemon.freshness_drain.started").length, 0, "an idle restart drains nothing");
});

test("W1-T10054: a lane refill with no sibling in flight reads idle", async () => {
  const lines: Line[] = [];
  const release = deferred<RunResult>();
  let started = 0;
  let isStale = false;
  const sleeps: Array<ReturnType<typeof deferred<void>>> = [];
  // B overlaps A's file, so A runs alone; A finishing is a refill with no sibling in flight.
  const run = runDaemon(
    planOf(task("A", "src/shared.ts") + task("B", "src/shared.ts")),
    {
      refreshMerged: () => () => false,
      log: (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra }),
      runOne: (id: string) => { started++; return id === "A" ? release.promise : Promise.resolve(okResult(id)); },
      sleep: () => { const s = deferred<void>(); sleeps.push(s); return s.promise; },
      checkFreshness: () => (isStale ? staleMaterial() : { stale: false }),
    } as unknown as DaemonDeps,
    { freshnessMinLifetimeMs: 0, max: 2, laneCount: 2 },
  );
  await drainMicrotasks();
  assert.equal(started, 1, "A runs alone");
  isStale = true;
  release.resolve(okResult("A"));
  await drainMicrotasks();
  await drainMicrotasks();
  const made = decisions(lines);
  assert.ok(made.length >= 1, `the refill asked the freshness question (${JSON.stringify(lines.map((l) => l.step))})`);
  assert.equal(made[0]!.busy, false, "no sibling lane, review or worker: nothing for a restart to interrupt");
  assert.deepEqual(made[0]!.busy_reasons, []);
  for (const s of sleeps) s.resolve();
  await within(run.catch(() => undefined), 2_000);
});

test("W1-T10054: an in-flight review or a live fix worker still makes the daemon busy", async () => {
  for (const kind of ["review", "worker", "released"] as const) {
    const lines: Line[] = [];
    const held = deferred<void>();
    if (kind === "review") void trackInFlightReview(held.promise, { taskId: "A", prNumber: 1 });
    if (kind === "worker") detachSweepAction(held.promise, { actionKind: "fix-dispatch", taskId: "A" });
    if (kind === "released") detachSweepAction(held.promise, { actionKind: "retro", taskId: "A" });
    assert.equal(inFlightReviewCount(), kind === "review" ? 1 : 0);
    assert.equal(restartInterruptibleDetachedActionCount(), kind === "worker" ? 1 : 0, "the retro cadence is released at once, never interruptible");
    let ticks = 0;
    const daemon = runDaemon(
      planOf(task("A", "src/a.ts")),
      {
        refreshMerged: () => () => true,
        runOne: async (id: string) => okResult(id),
        // The held work ends on the third idle wait, so the daemon defers while it runs and restarts after.
        sleep: async () => { if (++ticks === 3) held.resolve(); },
        log: (step: string, extra: Record<string, unknown> = {}) => lines.push({ step, extra }),
        sweep: async () => ({}),
        checkFreshness: () => stale(["src/lib/inbox.ts"]),
      } as unknown as DaemonDeps,
      { freshnessMinLifetimeMs: 0, sweepWallClockBoundMs: 60_000 },
    );
    const summary = await within(daemon, 5_000);
    held.resolve();
    assert.notEqual(summary, "timed-out", kind);
    const made = decisions(lines);
    const first = made[0]!;
    if (kind === "released") {
      assert.equal(first.busy, false, "a release-at-once action is not busy");
      assert.equal((first.background as Record<string, unknown>).released_actions, 1);
      assert.equal(first.action, "restart");
    } else {
      assert.equal(first.busy, true, `${kind} makes the decision busy`);
      assert.deepEqual(first.busy_reasons, [kind === "review" ? "reviews" : "detached_work"]);
      assert.equal(first.action, "defer", "a busy daemon defers a low-weight advance");
    }
    await drainMicrotasks();
  }
});
