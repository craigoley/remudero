import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";

import { fixedClock } from "#src/lib/clock.js";
import { flowGardenPass } from "#src/lib/garden-registry.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { flowOpenQueueReader, openQueueShadow, runFlowGardener, type FlowOpenQueuePr, type FlowOpenQueueRead } from "#src/lib/flow-gardener.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(ms).toISOString();

function census(now: number): FlowOpenQueueRead {
  const open: FlowOpenQueuePr[] = [
    { number: 16147, createdAtMs: now - 8 * HOUR, updatedAtMs: now, headSha: "head-16147", headRefName: "run-W1-T16147-1", checksState: "PENDING" },
    { number: 16186, createdAtMs: now - 6 * HOUR, updatedAtMs: now, headSha: "head-16186", headRefName: "run-W1-T16186-1", checksState: "SUCCESS" },
    { number: 17000, createdAtMs: now - 4 * HOUR, updatedAtMs: now, headSha: "head-17000", headRefName: "codex/operator", checksState: "SUCCESS" },
  ];
  const window = [
    { number: 18001, createdAtMs: now - 3 * HOUR, updatedAtMs: now, headSha: "h1", headRefName: "run-W1-T18001-1", checksState: "PENDING" },
    { number: 18002, createdAtMs: now - 2 * HOUR, updatedAtMs: now, headSha: "h2", headRefName: "run-W1-T18002-1", checksState: "PENDING" },
    { number: 18003, createdAtMs: now - 2 * DAY, updatedAtMs: now, headSha: "h3", headRefName: "old", checksState: "SUCCESS", mergedAtMs: now - HOUR },
  ];
  return { ok: true, complete: true, observedAtMs: now, open, window };
}

function rows(now: number, reviewAge = 2 * HOUR) {
  return [
    { ts: at(now - reviewAge), step: "sweep.review_eligible", pr_number: 16147, head_sha: "head-16147", review_key: "k16147" },
    // A previous-head PASS cannot make #16147 merge-ready at its current head.
    { ts: at(now - HOUR), step: "review.posted", pr_number: 16147, head_sha: "old-head", state: "success" },
    { ts: at(now - 2 * HOUR), step: "review.posted", pr_number: 16186, head_sha: "head-16186", state: "success" },
    { ts: at(now - 3 * HOUR), step: "automerge.direct_merge_preflight_refused", pr_number: 17000, head_sha: "head-17000" },
  ];
}

test("right-censors the full open cohort, separates review, preflight refusal and ready waits, then recommends only after repeated pressure", () => {
  const now = Date.parse("2026-11-02T12:00:00.000Z");
  const result = openQueueShadow(census(now), rows(now), {
    observedAtMs: now - DAY, windowDay: "2026-11-01", reviewP50: HOUR, pressure: true, streak: 1, producer: "plan-task-workers",
  }, now);
  assert.equal(result.status, "OBSERVED");
  assert.equal(result.mode, "shadow");
  assert.equal(result.permission, "not-granted");
  assert.equal(result.action, "none");
  assert.equal(result.cohort.open, 3, "the open PRs stay in the right-censored cohort");
  assert.equal(result.cohort.review_waiting, 1);
  assert.equal(result.cohort.merge_preflight_refused, 1);
  assert.equal(result.cohort.ready_to_direct_merge, 1);
  assert.equal(result.cohort.arrivals, 2);
  assert.equal(result.cohort.merged_or_closed, 1);
  assert.equal(result.cohort.open_age_p50_ms, 6 * HOUR);
  assert.equal(result.producer, "plan-task-workers");
  assert.equal(result.recommendation, "consider-slowing-plan-task-workers");
});

test("recommendation requires two distinct complete UTC windows with the same producer", () => {
  const day1 = Date.parse("2026-11-02T12:00:00.000Z");
  const first = openQueueShadow(census(day1), rows(day1), {
    observedAtMs: day1 - DAY, windowDay: "2026-11-01", reviewP50: HOUR, pressure: false, streak: 0, producer: "plan-task-workers",
  }, day1);
  assert.equal(first.nextState.streak, 1);
  assert.equal(first.recommendation, undefined);
  const day2 = day1 + DAY;
  const second = openQueueShadow(census(day2), rows(day2, 3 * HOUR), first.nextState, day2);
  assert.equal(second.nextState.streak, 2);
  assert.equal(second.recommendation, "consider-slowing-plan-task-workers");
});

test("incomplete or stale census is UNKNOWN and never recommends", () => {
  const now = Date.parse("2026-11-02T12:00:00.000Z");
  const previous = { observedAtMs: now - DAY, windowDay: "2026-11-01", reviewP50: HOUR, pressure: true, streak: 1 };
  const incomplete = openQueueShadow({ ...census(now), complete: false }, rows(now), previous, now);
  assert.equal(incomplete.status, "UNKNOWN");
  assert.equal(incomplete.recommendation, undefined);
  const stale = openQueueShadow({ ...census(now), observedAtMs: now - 7 * HOUR }, rows(now), previous, now);
  assert.equal(stale.status, "UNKNOWN");
  assert.equal(stale.recommendation, undefined);
  const responseObservedAfterPassStart = openQueueShadow({ ...census(now), observedAtMs: now + 1_000 }, rows(now), previous, now + 1_000);
  assert.equal(responseObservedAfterPassStart.status, "OBSERVED", "freshness is measured at analysis time after the API response");
  const sameWindow = openQueueShadow(census(now), rows(now), { ...previous, observedAtMs: now - HOUR, windowDay: "2026-11-02" }, now);
  assert.equal(sameWindow.recommendation, undefined, "retries in one UTC day do not count as consecutive windows");
});


test("the daily flow pass emits a reason-bearing shadow row from one batched census read", async () => {
  const now = Date.parse("2026-11-02T12:00:00.000Z");
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flow-open-queue-`));
  const events: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let censusReads = 0;
  let perPrCiReads = 0;
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  try {
    await runFlowGardener({ stateDir, repoRoot: root, clock: fixedClock(now),
      openWorkspace: () => ({ root, branch: "test", land: () => "", dispose: () => {} }),
      log: (step, extra = {}) => events.push({ step, extra }) }, {
      mintTaskId: () => "W1-T11111",
      readLedger: () => ({ ok: true, rows: [], unread: [] }),
      readOpenQueue: async () => { censusReads++; return census(now); },
      readCi: async () => { perPrCiReads++; return undefined; },
      planTasks: () => [],
    });
    const row = events.find((event) => event.step === "flow.open_queue_shadow");
    assert.ok(row);
    assert.equal(row.extra.mode, "shadow");
    assert.equal(row.extra.permission, "not-granted");
    assert.equal(row.extra.action, "none");
    assert.equal(typeof row.extra.reason, "string");
    assert.equal(censusReads, 1);
    assert.equal(perPrCiReads, 0, "open queue evidence adds no per-PR GitHub reads");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("the production reader batches open and recent-terminal census data in one GitHub query and refuses a truncated page", async () => {
  const node = (number: number, updates: Record<string, unknown> = {}) => ({ number, createdAt: "2026-11-02T10:00:00.000Z",
    updatedAt: "2026-11-02T11:00:00.000Z", headRefOid: `head-${number}`, headRefName: "run-W1-T11111-1",
    statusCheckRollup: { state: "SUCCESS" }, ...updates });
  const body = { data: {
    repository: { pullRequests: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [node(1)] } },
    search: { issueCount: 2, pageInfo: { hasNextPage: false }, nodes: [node(1), node(2, { mergedAt: "2026-11-02T11:00:00.000Z" })] },
  } };
  const calls: string[][] = [];
  const readJson = async (args: string[]) => { calls.push(args); return body; };
  const observedAtMs = Date.parse("2026-11-02T12:00:00.000Z");
  const read = await flowOpenQueueReader("acme", "remudero", readJson, fixedClock(observedAtMs))("2026-11-01T12:00:00.000Z");
  assert.equal(read.observedAtMs, observedAtMs);
  assert.equal(calls.length, 1);
  assert.equal(read.complete, true);
  assert.equal(read.open[0]?.number, 1);
  assert.equal(read.window.find((pr) => pr.number === 2)?.mergedAtMs, Date.parse("2026-11-02T11:00:00.000Z"));
  body.data.repository.pullRequests.totalCount = 101;
  const truncated = await flowOpenQueueReader("acme", "remudero", readJson, fixedClock(observedAtMs))("2026-11-01T12:00:00.000Z");
  assert.equal(truncated.complete, false);
  assert.equal(truncated.reason, "census-page-cap-exceeded");
});


test("the registered production flow pass wires one batched queue read in shadow mode", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flow-open-registry-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.parse("2026-11-02T12:00:00.000Z");
  const events: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const reads: string[][] = [];
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const body = { data: {
    repository: { pullRequests: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] } },
    search: { issueCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
  } };
  const pass = flowGardenPass({ stateDir, repoRoot: root, clock: fixedClock(now),
    openWorkspace: () => ({ root, branch: "test", land: () => "", dispose: () => {} }),
    log: (step, extra = {}) => events.push({ step, extra }),
  }, "acme", "remudero", () => "W1-T11111", {
    readJson: async (args) => { reads.push(args); return args[1] === "graphql" ? body : { workflow_runs: [] }; },
    admission: { owner: "acme", repo: "remudero" },
  });
  await pass();
  assert.equal(reads.filter((args) => args[1] === "graphql").length, 1);
  const row = events.find((event) => event.step === "flow.open_queue_shadow");
  assert.ok(row);
  assert.equal(row.extra.status, "OBSERVED");
  assert.equal(row.extra.mode, "shadow");
  assert.equal(row.extra.permission, "not-granted");
  assert.equal(row.extra.action, "none");
});
