/**
 * W1-T7734 — THE SWEEP SEES A NEW HEAD IN THE SAME PASS, NOT A PASS LATER.
 *
 * 2026-10-10 (ledger union 05:53-15:39Z, 38 PRs merged): CI start to the sweep's first sight of the new
 * head took a median 9.8 min (p90 44.9), and 31 `sweep.head_moved` stand-downs in 6 h each waited a whole
 * tick, because the act-time guard stood down instead of re-reading the ONE PR it had caught moving.
 *
 * These fixtures drive the REAL `runSweep` with a snapshot head and a live head that disagree, and the real
 * daemon loop with a review-demand reading, and assert on the rows and effects the new code writes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { readLedgerLines } from "../src/lib/status.js";
import {
  DEFAULT_SWEEP_POLICY,
  deriveIdleLightCadenceMs,
  noteHeadObservation,
  noteIdleReviewDemand,
  noteReviewDuration,
  readIdleLightCadence,
  resetIdleReviewMemo,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "./helpers/sweep-test.js";
import { writeLedger } from "./helpers/ledger-fixture.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = Date.UTC(2026, 9, 10, 15, 0);
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const SNAPSHOT_HEAD = "2b739554aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LIVE_HEAD = "cc291a4bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const AGAIN_HEAD = "dd5e0c77cccccccccccccccccccccccccccccccc";

/** A green, reviewed PR at the snapshot head: disposition `mergeable`, an acting disposition. */
function snapshotPr(): OpenPrView {
  return {
    prNumber: 10001, prUrl: "https://github.com/o/r/pull/10001", taskId: "W1-T10001",
    reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: minutesAgo(5), createdAt: minutesAgo(30), headSha: SNAPSHOT_HEAD, autoMergeArmed: false,
  };
}

/** The same PR as a fresh read sees it after the push: green, no review of THIS head yet. */
function pushedPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return { ...snapshotPr(), headSha: LIVE_HEAD, reviewState: "none", lastActivityAt: minutesAgo(0), ...over };
}

interface Fixture {
  deps: SweepDeps;
  armed: string[];
  reviewed: string[];
  rereads: number;
  rows: () => Array<Record<string, unknown>>;
  clock: { ms: number };
}

function fixture(reread: SweepDeps["rereadPrAtAct"], over: Partial<SweepDeps> = {}): Fixture {
  const { path } = writeLedger();
  const clock = { ms: NOW };
  const f: Fixture = {
    deps: undefined as unknown as SweepDeps, armed: [], reviewed: [], rereads: 0,
    rows: () => readLedgerLines(path), clock,
  };
  f.deps = {
    arm: (pr) => { f.armed.push(pr.headSha); return "armed"; },
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    postReview: (pr) => { f.reviewed.push(pr.headSha); },
    readLiveStateAtAct: () => ({ ok: true, state: "OPEN", headSha: LIVE_HEAD }),
    ...(reread ? { rereadPrAtAct: async (pr: OpenPrView) => { f.rereads++; return reread(pr); } } : {}),
    readLedgerUnion: () => ({ complete: false, lines: [] }),
    ledgerPath: path,
    runId: "DAEMON-T7734",
    now: () => clock.ms,
    ...over,
  };
  return f;
}

test("W1-T7734: a full pass that finds a moved head re-derives that PR from a fresh single-PR read in the same pass", async () => {
  // The fresh read sees the SAME PR green and reviewed at the new head, so the re-derived disposition is `mergeable`.
  const f = fixture((pr) => ({ ...pr, headSha: LIVE_HEAD }));
  const summary = await runSweep([snapshotPr()], f.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(f.rereads, 1, "the one moved PR is read once");
  assert.deepEqual(f.armed, [LIVE_HEAD], "the re-derived disposition acts on the NEW head, in this pass");
  const moved = f.rows().filter((r) => r.step === "sweep.head_moved");
  assert.equal(moved.length, 1);
  assert.equal(moved[0].snapshot_head_sha, SNAPSHOT_HEAD);
  assert.equal(moved[0].live_head_sha, LIVE_HEAD);
  assert.equal(moved[0].rederived, true, "the stand-down row says the PR was re-derived rather than left");
  const disposed = f.rows().filter((r) => r.step === "sweep.disposed");
  assert.equal(disposed.length, 1, "one disposed row, for the new head only");
  assert.equal(disposed[0].head_sha, LIVE_HEAD);
  assert.equal(disposed[0].disposition, "mergeable");
  assert.equal(disposed[0].acted, true);
  assert.equal(disposed[0].rederived, true);
  assert.equal(summary.actionsTaken, 1);
  assert.equal(summary.byDisposition.mergeable, 1, "the stale disposition is not counted a second time");
});

test("W1-T7734: a re-derived post-review head is admitted in the same pass when width allows", async () => {
  const f = fixture(() => pushedPr());
  await runSweep([snapshotPr()], f.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(f.armed, [], "nothing arms the head the PR has left, nor the unreviewed new one");
  assert.deepEqual(f.reviewed, [LIVE_HEAD], "the new head's review is posted in this pass");
  const admitted = f.rows().filter((r) => r.step === "sweep.review_admitted");
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].head_sha, LIVE_HEAD);
  const disposed = f.rows().filter((r) => r.step === "sweep.disposed");
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0].disposition, "post-review");
  assert.equal(disposed[0].head_sha, LIVE_HEAD);
  assert.equal(disposed[0].rederived, true);
});

test("W1-T7734: a failed single-PR re-read stands down naming the read error in its reason", async () => {
  const f = fixture(() => { throw new Error("secondary rate limit on /pulls/10001"); });
  const summary = await runSweep([snapshotPr()], f.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(f.armed, [], "the stale snapshot is never acted on");
  assert.deepEqual(f.reviewed, []);
  const moved = f.rows().find((r) => r.step === "sweep.head_moved");
  assert.match(String(moved?.reread_error), /secondary rate limit on \/pulls\/10001/);
  assert.notEqual(moved?.rederived, true);
  const disposed = f.rows().find((r) => r.step === "sweep.disposed");
  assert.equal(disposed?.acted, false);
  assert.equal(disposed?.head_sha, SNAPSHOT_HEAD, "the row still names the head the pass held");
  assert.match(String(disposed?.stand_down_reason), /re-read failed \(secondary rate limit on \/pulls\/10001\)/);
  assert.equal(summary.actionsTaken, 0);
});

test("W1-T7734: a head that moves again during the re-read stands down and the read is spent once per pass", async () => {
  const f = fixture(() => pushedPr({ headSha: AGAIN_HEAD }));
  await runSweep([snapshotPr()], f.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(f.rereads, 1);
  assert.deepEqual(f.armed, []);
  assert.deepEqual(f.reviewed, []);
  const disposed = f.rows().find((r) => r.step === "sweep.disposed");
  assert.equal(disposed?.acted, false);
  assert.match(String(disposed?.stand_down_reason), /moved again to dd5e0c77 during the re-read/);
});

test("W1-T7734: a PR the re-read finds no longer open is stood down, not re-derived", async () => {
  const f = fixture(() => undefined);
  await runSweep([snapshotPr()], f.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(f.armed, []);
  const disposed = f.rows().find((r) => r.step === "sweep.disposed");
  assert.match(String(disposed?.stand_down_reason), /no longer open/);
});

test("W1-T7734: a disposed row records the snapshot age at act time", async () => {
  // A plain pass: the live head matches, the generation was published 90 s before the PR is acted on.
  const plain = fixture(undefined, {
    readLiveStateAtAct: (pr) => ({ ok: true, state: "OPEN", headSha: (pr as OpenPrView).headSha }),
    snapshotPublishedAtMs: NOW - 90_000,
  });
  await runSweep([snapshotPr()], plain.deps, DEFAULT_SWEEP_POLICY);
  const row = plain.rows().find((r) => r.step === "sweep.disposed");
  assert.equal(row?.snapshot_age_ms, 90_000);
  assert.equal(row?.rederived, undefined, "an unmoved PR is not marked re-derived");

  // A re-derived PR records the age of its FRESH read, measured when it is acted on (the arm takes 2 s).
  const rederived = fixture((pr) => ({ ...pr, headSha: LIVE_HEAD }), { snapshotPublishedAtMs: NOW - 90_000 });
  const arm = rederived.deps.arm;
  rederived.deps.arm = (pr, mode) => { rederived.clock.ms += 2_000; return arm(pr, mode); };
  await runSweep([snapshotPr()], rederived.deps, DEFAULT_SWEEP_POLICY);
  const fresh = rederived.rows().find((r) => r.step === "sweep.disposed");
  assert.equal(fresh?.rederived, true);
  assert.equal(fresh?.snapshot_age_ms, 2_000, "the age of the fresh read, not of the generation");
});

// ── the idle light pass ──────────────────────────────────────────────────────────────────────────

function idlePlan(): Plan {
  const root = mkdtempSync(join(tmpdir(), "rmd-t7734-plan-"));
  const path = join(root, "tasks.yaml");
  writeFileSync(path, `
- id: W1-T7734-HOLD
  title: no dispatch in this idle fixture
  repo: remudero
  type: implement
  verify: human
  depends_on: []
  status: queued
`);
  return loadPlan(path);
}

async function idleDaemon(demand: DaemonDeps["readIdleReviewDemand"]) {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const sleeps: number[] = [];
  let lightPasses = 0;
  await runDaemon(idlePlan(), {
    refreshMerged: () => () => false,
    runOne: async (taskId) => ({ taskId, runId: `${taskId}-run`, merged: true, costUsd: 0, verdict: "merged" }),
    sleep: async () => {},
    sleepUntilSweepWake: async (ms) => {
      sleeps.push(ms);
      await new Promise<void>((resolve) => setImmediate(resolve));
      return "timeout";
    },
    checkStop: () => (rows.some((r) => r.step === "daemon.idle_light_pass") || sleeps.length > 200 ? "fixture complete" : undefined),
    sweepLight: async () => { lightPasses++; },
    readIdleReviewDemand: demand,
    log: (step, extra) => { rows.push({ step, extra }); },
  }, { pollIntervalMs: 5_000 });
  return { rows, sleeps, lightPasses: () => lightPasses };
}

test("W1-T7734: an idle daemon runs a light pass when eligible review demand exists", async () => {
  const idle = await idleDaemon(() => ({ eligible: 2, cadenceMs: 700, medianReviewMs: 1_400, pushesPerPrHour: 0.5 }));
  const passes = idle.rows.filter((r) => r.step === "daemon.idle_light_pass");
  assert.ok(passes.length >= 1, "a light pass ran during the idle sleep");
  assert.equal(passes[0].extra?.eligible, 2, "the row names the demand");
  assert.equal(passes[0].extra?.cadence_ms, 700, "the row names the derived cadence");
  assert.equal(passes[0].extra?.median_review_ms, 1_400);
  assert.ok(idle.sleeps.includes(700), "the idle sleep was cut into cadence-sized chunks");
  assert.ok(idle.lightPasses() >= passes.length);
});

test("W1-T7734: an idle daemon with no review demand sleeps as before and runs no idle light pass", async () => {
  const rows: string[] = [];
  const sleeps: number[] = [];
  let ticks = 0;
  await runDaemon(idlePlan(), {
    refreshMerged: () => () => false,
    runOne: async (taskId) => ({ taskId, runId: `${taskId}-run`, merged: true, costUsd: 0, verdict: "merged" }),
    sleep: async () => {},
    sleepUntilSweepWake: async (ms) => {
      sleeps.push(ms);
      ticks++;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return "timeout";
    },
    checkStop: () => (ticks >= 3 ? "fixture complete" : undefined),
    sweepLight: async () => {},
    readIdleReviewDemand: () => ({ eligible: 0, cadenceMs: 700 }),
    log: (step) => { rows.push(step); },
  }, { pollIntervalMs: 5_000 });
  assert.equal(rows.includes("daemon.idle_light_pass"), false);
  assert.equal(sleeps.includes(700), false, "no cadence-sized chunk without demand");
});

test("W1-T7734: the idle cadence is derived from observed review duration and head churn", () => {
  // Nothing observed: no cadence to invent.
  assert.equal(deriveIdleLightCadenceMs({ reviewDurationsMs: [], headPushes: 0, openPrs: 4, windowMs: 3_600_000 }).cadenceMs, undefined);
  // Review duration alone: its median binds.
  assert.equal(deriveIdleLightCadenceMs({ reviewDurationsMs: [60_000, 180_000, 120_000], headPushes: 0, openPrs: 0, windowMs: 0 }).cadenceMs, 120_000);
  // Churn alone: 6 pushes over 4 PRs in 1 h is 1.5 pushes per PR-hour, so half the 40 min mean gap.
  const churn = deriveIdleLightCadenceMs({ reviewDurationsMs: [], headPushes: 6, openPrs: 4, windowMs: 3_600_000 });
  assert.equal(churn.pushesPerPrHour, 1.5);
  assert.equal(churn.cadenceMs, 1_200_000);
  // Both: the shorter binds, and a hotter board shortens it.
  const calm = deriveIdleLightCadenceMs({ reviewDurationsMs: [600_000], headPushes: 1, openPrs: 4, windowMs: 3_600_000 });
  const hot = deriveIdleLightCadenceMs({ reviewDurationsMs: [600_000], headPushes: 40, openPrs: 4, windowMs: 3_600_000 });
  assert.equal(calm.cadenceMs, 600_000);
  assert.ok(hot.cadenceMs! < calm.cadenceMs!);
});

test("W1-T7734: the memo the daemon reads holds demand, review durations and head pushes", () => {
  resetIdleReviewMemo();
  assert.equal(readIdleLightCadence(NOW), undefined, "no demand observed: the daemon sleeps as before");
  noteIdleReviewDemand(0, 3, NOW - 3_600_000);
  assert.equal(readIdleLightCadence(NOW), undefined, "zero eligible is no demand");
  noteHeadObservation(7, "aaaa", NOW - 3_000_000);
  noteHeadObservation(7, "aaaa", NOW - 2_000_000);
  noteHeadObservation(7, "bbbb", NOW - 1_000_000);
  noteReviewDuration(90_000);
  noteIdleReviewDemand(2, 3, NOW - 500_000);
  const read = readIdleLightCadence(NOW);
  assert.equal(read?.eligible, 2);
  assert.equal(read?.medianReviewMs, 90_000);
  assert.equal(read?.pushesPerPrHour, 1 / 3, "one push, three open PRs, one hour");
  assert.equal(read?.cadenceMs, 90_000);
  resetIdleReviewMemo();
});
