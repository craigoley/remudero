import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runDaemon, type DaemonFreshness } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import {
  DEFAULT_SWEEP_POLICY,
  drainDetachedSweepActions,
  detachedSweepActionCount,
  runSweepLightPass,
  type OpenPrView,
} from "../src/lib/sweep.js";

const OLD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function fixturePlan() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-t2913-plan-"));
  const path = join(dir, "tasks.yaml");
  writeFileSync(path, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  return loadPlan(path);
}

/** ACTIVE, measured against the REAL clock — deliberately not a constant.
 *
 *  `deriveDisposition` compares `lastActivityAt` to `Date.now()` against `staleDays` (14), so a
 *  hardcoded stamp here is a time bomb: it reds at a clock boundary with no diff involved. Measured
 *  by clock-shift probe — this fixture read `2026-09-06T06:00:00Z`, and at `2026-09-20` (exactly
 *  `staleDays` later) both tests below would have begun classifying this PR `stale` instead of
 *  `blocked-fixable`, so `actionable` never fires, no detached action is created, and the bound
 *  these tests exist to prove is never exercised.
 *
 *  Moving the constant forward only re-arms it (CLAUDE.md, code traps). Anchoring to `Date.now()`
 *  disarms it: this fixture is "an hour ago" on every run, forever. */
function activeLastActivityAt(): string {
  return new Date(Date.now() - 60 * 60 * 1000).toISOString();
}

function blockedPr(): OpenPrView {
  return {
    prNumber: 2913,
    prUrl: "https://github.com/o/r/pull/2913",
    taskId: "W1-T2913-FIX",
    reviewState: "failure",
    checksState: "green",
    unmetCriteria: [
      { claim: "finish the repair", proof: "unit test: x", met: false, reason: "not done", proof_exec: "executed_fail" },
    ],
    priorStrikes: 0,
    lastActivityAt: activeLastActivityAt(),
    headSha: "detached-fix-head",
    autoMergeArmed: false,
  };
}

function freshness(): DaemonFreshness {
  return { stale: true, oldSha: OLD_SHA, newSha: NEW_SHA };
}

test("W1-T2913: a never-settling detached action cannot hold a freshness restart past the explicit bound", { timeout: 250 }, async () => {
  assert.equal(detachedSweepActionCount(), 0, "precondition: no detached action leaked from another test");
  const root = mkdtempSync(join(tmpdir(), "rmd-t2913-never-settles-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    const summary = await runDaemon(fixturePlan(), {
      refreshMerged: () => () => false,
      runOne: async (taskId) => ({ taskId, runId: `${taskId}-run`, merged: false, costUsd: 0, verdict: "blocked" }),
      sleep: async () => {},
      checkFreshness: freshness,
      log: (step, extra = {}) => rows.push({ step, extra }),
      sweep: async () => {
        await runSweepLightPass([blockedPr()], {
          arm: () => {},
          close: () => {},
          dispatchFix: () => held as never,
          escalate: () => {},
          actionable: (disposition) => disposition === "blocked-fixable",
          ledgerPath,
          runId: "SWEEP-T2913",
        });
      },
    }, { sweepWallClockBoundMs: 20 });

    assert.equal(summary.stopReason, "stale");
    assert.equal(detachedSweepActionCount(), 1, "the timed-out action remains registered until it settles");
    const abandoned = rows.filter((row) => row.step === "daemon.detached_action_abandoned");
    assert.equal(abandoned.length, 1, "one abandonment row is emitted per pending detached action");
    assert.equal(abandoned[0]!.extra.action_kind, "fix-dispatch");
    assert.equal(abandoned[0]!.extra.task_id, "W1-T2913-FIX");
    assert.equal(typeof abandoned[0]!.extra.age_ms, "number");
    assert.ok(rows.findIndex((row) => row.step === "daemon.detached_action_abandoned") < rows.findIndex((row) => row.step === "daemon_selfrestart_for_freshness"));
  } finally {
    release();
    await drainDetachedSweepActions();
  }
});

test("W1-T2913 control: a detached action that settles within the bound emits no abandonment", async () => {
  assert.equal(detachedSweepActionCount(), 0, "precondition: no detached action leaked from another test");
  const root = mkdtempSync(join(tmpdir(), "rmd-t2913-settles-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];

  const summary = await runDaemon(fixturePlan(), {
    refreshMerged: () => () => false,
    runOne: async (taskId) => ({ taskId, runId: `${taskId}-run`, merged: false, costUsd: 0, verdict: "blocked" }),
    sleep: async () => {},
    checkFreshness: freshness,
    log: (step, extra = {}) => rows.push({ step, extra }),
    sweep: async () => {
      await runSweepLightPass([blockedPr()], {
        arm: () => {},
        close: () => {},
        dispatchFix: () => new Promise<void>((resolve) => setTimeout(resolve, 10)) as never,
        escalate: () => {},
        actionable: (disposition) => disposition === "blocked-fixable",
        ledgerPath,
        runId: "SWEEP-T2913-CONTROL",
      });
    },
  }, { sweepWallClockBoundMs: 100 });

  assert.equal(summary.stopReason, "stale");
  assert.equal(detachedSweepActionCount(), 0);
  assert.equal(rows.some((row) => row.step === "daemon.detached_action_abandoned"), false);
  assert.equal(rows.filter((row) => row.step === "daemon.freshness_drain.completed").length, 1);
});

// ── THE FIXTURE'S OWN GUARD. Same shape as W1-T3270's in test/stale-ci-gate-wiring.test.ts: without
// it, a later edit can put a date literal back and nothing refuses until the wall clock reaches it.
test("the blocked-PR fixture ages from the wall clock, so no calendar date can flip its disposition out from under this suite", () => {
  // FRESH BY CONSTRUCTION. Both cases below reach the detached-drain bound only because `runSweep`
  // does not dispose this PR `stale` first — `actionable` admits `blocked-fixable` and nothing else,
  // so a fixture that ages is a suite that silently stops testing its own subject.
  const fixtureAgeDays = (Date.now() - Date.parse(blockedPr().lastActivityAt!)) / 86_400_000;
  assert.ok(fixtureAgeDays < 1, `the fixture must be hours old, not days — measured ${fixtureAgeDays.toFixed(2)}d`);
  assert.ok(
    fixtureAgeDays < DEFAULT_SWEEP_POLICY.staleDays,
    "and it must sit clear of the staleness threshold it is judged against",
  );

  // THE RETIRED CONSTANT, AND WHY ITS CONTROL IS NOT WRITTEN AS AN ASSERTION HERE. W1-T3270's guard
  // can assert its own retired literal is ALREADY stale, because that bomb had fired. This one had
  // not: `2026-09-06T06:00:00Z` was still fresh when it was replaced, and an assertion that it is
  // stale today would have been RED on the commit that fixed it and green only afterwards — a second
  // time bomb in the guard against the first. The fuse is arithmetic on a constant, so asserting it
  // proves nothing; the evidence the bomb was real is the +365d clock-shift run recorded in the
  // commit, and `scripts/clock-sweep.mjs --only detached-sweep-drain-is-bounded` re-derives it.
  // Its fuse was 2026-09-20.
});
