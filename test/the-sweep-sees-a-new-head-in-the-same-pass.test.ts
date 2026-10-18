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

import { runDaemon, type DaemonDeps } from "#src/lib/daemon.js";
import { systemClock } from "#src/lib/clock.js";
import type { GhCallPacer } from "#src/lib/open-prs-rest.js";
import type { ReadGeneration } from "#src/lib/read-plane.js";
import { buildRereadPrAtAct, servedTickRead } from "#test/helpers/run-task-test.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { loadPlan, type Plan } from "#src/lib/plan.js";
import { readLedgerLines } from "#src/lib/status.js";
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
} from "#test/helpers/sweep-test.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
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

async function idleDaemon(demand: DaemonDeps["readIdleReviewDemand"], over: Partial<DaemonDeps> = {}) {
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
    ...over,
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

test("W1-T7734: an unreadable idle demand logs its cause and uses the ordinary sleep", async () => {
  let unreadable = false;
  const idle = await idleDaemon(() => {
    unreadable = true;
    throw new Error("review memo unavailable");
  }, { checkStop: () => unreadable ? "fixture complete" : undefined });
  const failures = idle.rows.filter((row) => row.step === "daemon.idle_light_pass.demand_unreadable");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].extra?.error, "review memo unavailable");
  assert.ok(idle.sleeps.includes(5_000));
  assert.equal(idle.sleeps.includes(700), false);
  assert.equal(idle.rows.some((row) => row.step === "daemon.idle_light_pass"), false);
});

test("W1-T7734: a failed idle light pass logs its error and finishes the remaining sleep", async () => {
  let demandReads = 0;
  let idleAttempts = 0;
  const idle = await idleDaemon(
    () => (++demandReads === 1 ? { eligible: 2, cadenceMs: 700 } : { eligible: 0 }),
    { sweepLight: async (opts) => {
      if (opts?.reviewOnly) {
        idleAttempts++;
        throw new Error("idle PR read unavailable");
      }
    } },
  );
  assert.equal(idleAttempts, 1);
  const failures = idle.rows.filter((row) => row.step === "daemon.sweep_light.failed" && row.extra?.phase === "idle");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].extra?.error, "idle PR read unavailable");
  assert.equal(demandReads, 2, "demand is checked again after the failed pass");
  assert.deepEqual(idle.sleeps.slice(-2), [700, 4_300]);
});

test("W1-T7734: cleared idle demand finishes the sleep without another light pass", async () => {
  let demandReads = 0;
  const idle = await idleDaemon(() => (++demandReads === 1 ? { eligible: 2, cadenceMs: 700 } : undefined));
  assert.equal(demandReads, 2);
  assert.equal(idle.rows.filter((row) => row.step === "daemon.idle_light_pass").length, 1);
  assert.equal(idle.lightPasses(), 1);
  assert.deepEqual(idle.sleeps.slice(-2), [700, 4_300]);
});

test("W1-T7734: served facts keep the publication time of their original generation", async (t) => {
  t.mock.method(systemClock, "now", () => NOW);
  const facts = { headSha: LIVE_HEAD };
  let generation: ReadGeneration<typeof facts> = {
    generation: 1, source: "worker", publishedAtMs: NOW - 90_000, facts,
  };
  const read = servedTickRead(async () => {
    generation = { generation: 2, source: "worker", publishedAtMs: NOW, facts: { headSha: AGAIN_HEAD } };
    return facts;
  }, () => generation);
  assert.deepEqual(await read(), { headSha: LIVE_HEAD, servedPublishedAtMs: NOW - 90_000 });
  assert.equal(generation.generation, 2, "a newer publication cannot relabel the served facts");
  assert.equal("servedPublishedAtMs" in facts, false, "the shared generation is not mutated");
});

test("W1-T7734: inline and replaced facts are stamped at request time and absent facts stay absent", async (t) => {
  let clock = NOW;
  t.mock.method(systemClock, "now", () => clock);
  const facts = { headSha: LIVE_HEAD };
  const read = servedTickRead(async () => { clock += 5_000; return facts; }, () => undefined);
  assert.deepEqual(await read(), { ...facts, servedPublishedAtMs: NOW });
  const replaced = servedTickRead(async () => { clock += 5_000; return { ...facts }; },
    () => ({ generation: 1, source: "worker", publishedAtMs: NOW - 90_000, facts }));
  assert.deepEqual(await replaced(), { ...facts, servedPublishedAtMs: NOW + 5_000 });
  assert.equal(await servedTickRead(async () => undefined, () => undefined)(), undefined);
});

const rereadViews = {
  requiredContexts: () => ["ci-gate"],
  readCiGateRequired: () => [],
  readMainPlan: (): Plan => ({ tasks: [], byId: new Map() }),
  fetchCiFailureEvidence: () => [],
};

function rereadRow(over: Record<string, unknown> = {}) {
  return {
    number: 10001, html_url: "https://github.com/o/r/pull/10001", state: "open", draft: false,
    title: "fix: refreshed head", body: "Remudero-Task: W1-T10001",
    updated_at: minutesAgo(0), created_at: minutesAgo(30),
    head: { ref: "run-W1-T10001-1", sha: LIVE_HEAD }, mergeable_state: "clean",
    ...over,
  };
}

function rereadAnswer(args: string[], row = rereadRow()): unknown {
  const path = args[1];
  if (path.includes("/check-runs?")) return { check_runs: [{ id: 77, name: "ci-gate", status: "completed", conclusion: "success" }] };
  if (path.endsWith("/status")) return { statuses: [{ context: "remudero-review", state: "success" }] };
  if (path.includes("/files?")) return [{ filename: "src/lib/sweep.ts" }];
  if (/\/pulls\/\d+$/.test(path)) return row;
  throw new Error(`unexpected reread: ${args.join(" ")}`);
}

test("W1-T7734: the paced single-PR producer rebuilds head facts and preserves board facts", async () => {
  const calls: string[] = [];
  let waits = 0;
  const pacedResults: boolean[] = [];
  const pacer: GhCallPacer = {
    wait: () => { throw new Error("blocking pacer used"); },
    waitAsync: async () => { waits++; },
    recordResult: (limited) => { pacedResults.push(limited); },
  };
  const pr: OpenPrView = {
    ...snapshotPr(), supersededBy: 10002,
    supersessionVerdict: { status: "indeterminate", detail: "whole-board comparison awaits evidence" },
    taskMergedBy: 9999, planResequenceIneligible: "dependency awaits credit",
    planResequenceUnmetDependencies: ["W1-T9999"], planResequenceHeld: "waiting for dependency credit",
  };
  const reread = buildRereadPrAtAct("o", "r", writeLedger().path, {
    pacer, views: rereadViews,
    fetchAsync: async (args) => { calls.push(args[1]); return rereadAnswer(args); },
  });
  const view = await reread(pr);
  assert.ok(view);
  assert.equal(view.prNumber, pr.prNumber);
  assert.equal(view.headSha, LIVE_HEAD);
  assert.equal(view.reviewState, "success");
  assert.equal(view.checksState, "green");
  assert.equal(view.supersededBy, pr.supersededBy);
  assert.equal(view.supersessionVerdict, pr.supersessionVerdict);
  assert.equal(view.taskMergedBy, pr.taskMergedBy);
  assert.equal(view.planResequenceIneligible, pr.planResequenceIneligible);
  assert.deepEqual(view.planResequenceUnmetDependencies, pr.planResequenceUnmetDependencies);
  assert.equal(view.planResequenceHeld, pr.planResequenceHeld);
  assert.equal(waits, 1, "the reread uses the daemon's async pacer");
  assert.deepEqual(pacedResults, [false]);
  assert.equal(calls.filter((path) => path.includes("/check-runs?")).length, 1);
  assert.equal(calls.filter((path) => path.endsWith("/status")).length, 1);
  assert.ok(calls.every((path) => !path.includes("state=open")), "the board is not enumerated again");
});

test("W1-T7734: the single-PR producer reaches its default async transport", async () => {
  const shim = ghShim([
    { when: "/check-runs?", stdout: JSON.stringify(rereadAnswer(["api", "/check-runs?"])) },
    { when: "/status", stdout: JSON.stringify(rereadAnswer(["api", "/status"])) },
    { when: "/files?", stdout: JSON.stringify([{ filename: "src/lib/sweep.ts" }]) },
    { when: "/pulls/10001", stdout: JSON.stringify(rereadRow()) },
    { when: "", stderr: "unexpected single-PR transport call", exit: 1 },
  ], { kind: "same-pass-reread" });
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previousPath ?? ""}`;
  try {
    const view = await buildRereadPrAtAct("o", "r", writeLedger().path, { views: rereadViews })(snapshotPr());
    assert.equal(view?.headSha, LIVE_HEAD);
    assert.equal(view?.checksState, "green");
    assert.equal(view?.reviewState, "success");
    assert.ok(shim.calls().some((call) => call.includes("repos/o/r/pulls/10001")));
    assert.equal(shim.calls().filter((call) => call.includes(`/commits/${LIVE_HEAD}/check-runs?`)).length, 1);
    assert.equal(shim.calls().filter((call) => call.includes(`/commits/${LIVE_HEAD}/status`)).length, 1);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("W1-T7734: the reread rollup preserves a posted gate's job identity", async () => {
  const reread = buildRereadPrAtAct("o", "r", writeLedger().path, {
    views: rereadViews,
    fetchAsync: async (args) => args[1].includes("/check-runs?") ? {
      check_runs: [{ id: 77, name: "ci-gate", status: "completed", conclusion: "cancelled",
        details_url: "https://github.com/o/r/runs/77", external_id: "job:445" }],
    } : rereadAnswer(args),
  });
  const view = await reread(snapshotPr());
  assert.equal(view?.headSha, LIVE_HEAD);
  assert.equal(view?.checksState, "red");
  assert.deepEqual(view?.cancelledRequiredChecks, [{ name: "ci-gate", jobId: "445" }]);
});

test("W1-T7734: the single-PR producer returns absence for closed PRs and rejects failed or mismatched reads", async () => {
  const closed = buildRereadPrAtAct("o", "r", writeLedger().path, {
    views: { ...rereadViews, readMainPlan: () => { throw new Error("closed PR must not be rebuilt"); } },
    fetchAsync: async (args) => rereadAnswer(args, rereadRow({ state: "closed" })),
  });
  assert.equal(await closed(snapshotPr()), undefined);
  const failed = buildRereadPrAtAct("o", "r", writeLedger().path, {
    fetchAsync: async () => { throw new Error("single PR transport failed"); },
  });
  await assert.rejects(failed(snapshotPr()), /single PR transport failed/);
  const mismatch = buildRereadPrAtAct("o", "r", writeLedger().path, {
    views: rereadViews,
    fetchAsync: async (args) => rereadAnswer(args, rereadRow({ number: 10002 })),
  });
  await assert.rejects(mismatch(snapshotPr()), /the rebuilt view list did not contain PR #10001/);
});
