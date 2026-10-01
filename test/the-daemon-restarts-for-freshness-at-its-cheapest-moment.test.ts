import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon, type DaemonFreshness } from "../src/lib/daemon.js";
import {
  DEPLOY_RESTART_RATE_CEILING_MS,
  DEPLOY_RESTART_SCORE_THRESHOLD,
  decideFreshnessRestart,
  freshnessAdvanceWorth,
} from "../src/lib/deploy-judge.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { checkServiceFreshness, daemonFreshnessFromService } from "../src/lib/self-sync.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { RunResult } from "../src/run-task.js";

/**
 * W1-T4945 — every src/ merge restarted the daemon, half of them mid-work. Measured 2026-09-28..30:
 * ~25 boots a day, 36 freshness drains (median 8.3 min, ~82 min a day with no new dispatch) and ~31
 * freshness handoffs among 113 build verdicts. The daemon now decides WHEN to take a material
 * advance: at once when idle; while busy only when the weighted change pressure — which also grows
 * with how long the daemon has been stale — justifies the drain.
 */

const OLD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const PLAN_YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}freshness-cheapest-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, PLAN_YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });

function staleWith(files: string[]): DaemonFreshness {
  return { stale: true, oldSha: OLD_SHA, newSha: NEW_SHA, changes: [{ sha: NEW_SHA, subject: "feat: x", files }] };
}

function within<T>(work: Promise<T>, ms: number): Promise<T | "timed-out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), ms);
  });
  return Promise.race([work, bound]).finally(() => clearTimeout(timer));
}

type Line = { step: string; extra: Record<string, unknown> };
const decisions = (lines: Line[]) => lines.filter((l) => l.step === "daemon.freshness_decision").map((l) => l.extra);

test("W1-T4945: an idle daemon takes a material advance at once", async () => {
  const lines: Line[] = [];
  const summary = await within(
    runDaemon(
      fixturePlan(),
      {
        refreshMerged: () => () => true, // nothing runnable: every tick idles
        runOne: async (id) => okResult(id),
        sleep: async () => {},
        log: (step, extra = {}) => lines.push({ step, extra }),
        sweep: async () => ({}),
        checkFreshness: () => staleWith(["src/lib/inbox.ts"]),
      },
      { sweepWallClockBoundMs: 60_000 },
    ),
    5_000,
  );
  assert.notEqual(summary, "timed-out");
  assert.equal((summary as { stopReason: string }).stopReason, "stale");
  const made = decisions(lines);
  assert.equal(made.length, 1, "one decision, and it restarted");
  assert.equal(made[0]!.action, "restart");
  assert.equal(made[0]!.busy, false);
  assert.equal(lines.filter((l) => l.step === "daemon.freshness_drain.started").length, 0, "an idle restart drains nothing");
});

test("W1-T4945: a busy daemon defers a low-weight advance to the next idle moment", async () => {
  const lines: Line[] = [];
  let releaseSweep: (() => void) | undefined;
  let passes = 0;
  let idleWaits = 0;
  const daemon = runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => () => true,
      runOne: async (id) => okResult(id),
      sleep: async () => {
        idleWaits++;
        // Two busy ticks first: the full pass started on the first tick is still running.
        if (idleWaits === 3) releaseSweep?.();
      },
      log: (step, extra = {}) => lines.push({ step, extra }),
      sweep: async () => {
        passes++;
        if (passes === 1) await new Promise<void>((resolve) => (releaseSweep = resolve));
        return {};
      },
      checkFreshness: () => staleWith(["src/lib/inbox.ts"]),
    },
    { sweepWallClockBoundMs: 60_000 },
  );
  const summary = await within(daemon, 5_000);
  releaseSweep?.();
  assert.notEqual(summary, "timed-out", "the busy daemon kept ticking instead of waiting on its pass to restart");
  const made = decisions(lines);
  assert.ok(made.length >= 2, `a deferral and then a restart (saw ${JSON.stringify(made)})`);
  assert.equal(made[0]!.action, "defer");
  assert.equal(made[0]!.busy, true);
  assert.equal(made[0]!.weight, 1, "a runtime path outside the daemon's own code is the low-weight floor");
  const last = made[made.length - 1]!;
  assert.equal(last.action, "restart");
  assert.equal(last.busy, false, "the restart waited for the idle moment");
  assert.equal((summary as { stopReason: string }).stopReason, "stale");
});

test("W1-T4945: a change to the daemon own loop still drains and restarts while busy", async () => {
  const lines: Line[] = [];
  let releaseSweep: (() => void) | undefined;
  let passes = 0;
  const daemon = runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => () => true,
      runOne: async (id) => okResult(id),
      sleep: async () => {},
      log: (step, extra = {}) => {
        lines.push({ step, extra });
        // The exit waits for the pass still running; let it finish once the decision is made.
        if (step === "daemon.freshness_decision") setTimeout(() => releaseSweep?.(), 5);
      },
      sweep: async () => {
        passes++;
        if (passes === 1) await new Promise<void>((resolve) => (releaseSweep = resolve));
        return {};
      },
      checkFreshness: () => staleWith(["src/lib/daemon.ts"]),
    },
    { sweepWallClockBoundMs: 60_000 },
  );
  const summary = await within(daemon, 5_000);
  releaseSweep?.();
  assert.notEqual(summary, "timed-out");
  const made = decisions(lines);
  assert.equal(made.length, 1);
  assert.equal(made[0]!.action, "restart");
  assert.equal(made[0]!.busy, true);
  assert.equal(made[0]!.weight, DEPLOY_RESTART_SCORE_THRESHOLD.value);
  assert.equal((summary as { stopReason: string }).stopReason, "stale");
});

test("W1-T4945: a deferred advance cannot wait indefinitely", async () => {
  const lines: Line[] = [];
  let releaseSweep: (() => void) | undefined;
  let passes = 0;
  let nowMs = Date.parse("2026-10-01T00:00:00.000Z");
  const tickMs = 10 * 60_000;
  const daemon = runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => () => true,
      runOne: async (id) => okResult(id),
      now: () => new Date(nowMs),
      sleep: async () => {
        nowMs += tickMs;
      },
      log: (step, extra = {}) => {
        lines.push({ step, extra });
        if (step === "daemon.freshness_decision" && extra.action === "restart") setTimeout(() => releaseSweep?.(), 5);
      },
      // The first pass never finishes on its own: the daemon stays busy for its whole life.
      sweep: async () => {
        passes++;
        if (passes === 1) await new Promise<void>((resolve) => (releaseSweep = resolve));
        return {};
      },
      checkFreshness: () => staleWith(["src/lib/inbox.ts"]),
    },
    { sweepWallClockBoundMs: 24 * 60 * 60_000 },
  );
  const summary = await within(daemon, 5_000);
  releaseSweep?.();
  assert.notEqual(summary, "timed-out", "a permanently busy daemon still took the advance");
  const made = decisions(lines);
  const deferred = made.filter((d) => d.action === "defer");
  assert.ok(deferred.length >= 1);
  for (let i = 1; i < made.length; i++) {
    assert.ok((made[i]!.pressure as number) >= (made[i - 1]!.pressure as number), "pressure never falls while stale");
  }
  const last = made[made.length - 1]!;
  assert.equal(last.action, "restart");
  assert.equal(last.busy, true, "it restarted although still busy");
  assert.ok((last.age_pressure as number) > 0, "staleness age is what carried it over");
  const waitedMs = (made.length - 1) * tickMs;
  assert.ok(waitedMs <= DEPLOY_RESTART_RATE_CEILING_MS, `waited ${waitedMs} ms`);
});

test("freshness scoring: the daemon's own code is full weight, other runtime paths the floor, unreadable fails toward restarting", () => {
  assert.equal(freshnessAdvanceWorth({ sha: "1", files: ["src/lib/drain.ts"] }).score, DEPLOY_RESTART_SCORE_THRESHOLD.value);
  assert.equal(freshnessAdvanceWorth({ sha: "2", files: ["package-lock.json"] }).score, DEPLOY_RESTART_SCORE_THRESHOLD.value);
  assert.equal(freshnessAdvanceWorth({ sha: "3", files: ["src/lib/inbox.ts"] }).score, 1);
  assert.equal(freshnessAdvanceWorth({ sha: "4", files: ["plan/tasks.d/x.yaml"] }).score, 0);
  const unreadable = decideFreshnessRestart({ busy: true, staleSinceMs: 0, nowMs: 0, state: { total: 0, scoredShas: [] } });
  assert.equal(unreadable.action, "restart");
  assert.equal(unreadable.weight, DEPLOY_RESTART_SCORE_THRESHOLD.value);
  const once = decideFreshnessRestart({
    changes: [{ sha: "5", files: ["src/lib/inbox.ts"] }],
    busy: true,
    staleSinceMs: 0,
    nowMs: 0,
    state: { total: 0, scoredShas: [] },
  });
  const again = decideFreshnessRestart({
    changes: [{ sha: "5", files: ["src/lib/inbox.ts"] }],
    busy: true,
    staleSinceMs: 0,
    nowMs: 0,
    state: once.state,
  });
  assert.equal(again.weight, 1, "an advance already scored is not scored twice");
});

test("service freshness carries each advanced commit's files, and an unreadable log reads as unknown", () => {
  const git = (failLog: boolean) => (args: string[]): string => {
    if (args[0] === "fetch") return "";
    if (args[0] === "rev-parse") return args[1] === "HEAD" ? OLD_SHA : NEW_SHA;
    if (args[0] === "status") return "";
    if (args[0] === "diff") return "src/lib/inbox.ts\nsrc/lib/daemon.ts\n";
    if (args[0] === "log") {
      if (failLog) throw new Error("git log failed");
      return `\x1e${NEW_SHA}\x1ffeat: two\n\nsrc/lib/daemon.ts\n\x1e${"c".repeat(40)}\x1ffix: one\n\nsrc/lib/inbox.ts\n`;
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const read = daemonFreshnessFromService(checkServiceFreshness("/repo", {}, { git: git(false) }));
  assert.deepEqual(read, {
    stale: true,
    oldSha: OLD_SHA,
    newSha: NEW_SHA,
    changes: [
      { sha: NEW_SHA, subject: "feat: two", files: ["src/lib/daemon.ts"] },
      { sha: "c".repeat(40), subject: "fix: one", files: ["src/lib/inbox.ts"] },
    ],
  });
  const blind = daemonFreshnessFromService(checkServiceFreshness("/repo", {}, { git: git(true) }));
  assert.deepEqual(blind, { stale: true, oldSha: OLD_SHA, newSha: NEW_SHA });
});
