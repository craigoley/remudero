import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";

import { fixedClock } from "#src/lib/clock.js";
import { logArmAttribution } from "#src/lib/arm-auto-merge.js";
import { flowGardenPass } from "#src/lib/garden-registry.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  FLOW_STATE_FILE, flowOpenQueueReader, openQueueShadow, openQueueWindow, runFlowGardener, type FlowOpenQueuePr, type FlowOpenQueueRead,
} from "#src/lib/flow-gardener.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(ms).toISOString();

const dayStart = (ms: number) => Math.floor(ms / DAY) * DAY;
/** The window a pass at `now` reads, and the one the pass before it on the previous UTC date read. */
const windowOf = (now: number) => ({ fromMs: dayStart(now) - DAY, toMs: dayStart(now) });
const previousWindow = (now: number) => ({ fromMs: dayStart(now) - 2 * DAY, toMs: dayStart(now) - DAY });

function prNode(pr: FlowOpenQueuePr) {
  return { number: pr.number, createdAt: at(pr.createdAtMs), updatedAt: at(pr.updatedAtMs),
    headRefOid: pr.headSha, headRefName: pr.headRefName,
    commits: { nodes: [{ commit: { oid: pr.headSha, statusCheckRollup: { state: pr.checksState } } }] },
    ...(pr.mergedAtMs === undefined ? {} : { mergedAt: at(pr.mergedAtMs) }),
    ...(pr.closedAtMs === undefined ? {} : { closedAt: at(pr.closedAtMs) }) };
}

/** One GraphQL round answering every connection the reader asks for: the open queue and the window's created and closed searches. */
function censusResponse(cohort: FlowOpenQueueRead, window: { fromMs: number; toMs: number }) {
  const inWindow = (ms: number | undefined) => ms !== undefined && ms >= window.fromMs && ms < window.toMs;
  const created = cohort.window.filter((pr) => inWindow(pr.createdAtMs));
  const closed = cohort.window.filter((pr) => inWindow(pr.mergedAtMs) || inWindow(pr.closedAtMs));
  return { data: {
    repository: { pullRequests: { totalCount: cohort.open.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: cohort.open.map(prNode) } },
    created: { issueCount: created.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: created.map(prNode) },
    closed: { issueCount: closed.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: closed.map(prNode) },
  } };
}

function assertCommitRollupQuery(args: string[]) {
  const query = args.find((arg) => arg.startsWith("query=")) ?? "";
  const connections = (query.match(/pageInfo\{/g) ?? []).length;
  assert.ok(connections > 0, "the query selects at least one PR connection");
  assert.equal(query.match(/commits\(last:1\)\{nodes\{commit\{oid statusCheckRollup\{state\}\}\}\}/g)?.length, connections,
    "every PR selection requests the rollup on Commit");
  assert.equal(query.match(/statusCheckRollup/g)?.length, connections, "no rollup may be requested directly on PullRequest");
}

function census(now: number): FlowOpenQueueRead {
  const open: FlowOpenQueuePr[] = [
    { number: 16147, createdAtMs: now - 8 * HOUR, updatedAtMs: now, headSha: "head-16147", headRefName: "run-W1-T16147-1", checksState: "PENDING" },
    { number: 16186, createdAtMs: now - 6 * HOUR, updatedAtMs: now, headSha: "head-16186", headRefName: "run-W1-T16186-1", checksState: "SUCCESS" },
    { number: 17000, createdAtMs: now - 4 * HOUR, updatedAtMs: now, headSha: "head-17000", headRefName: "codex/operator", checksState: "SUCCESS" },
  ];
  const w = windowOf(now).fromMs;
  const window = [
    { number: 18001, createdAtMs: w + 20 * HOUR, updatedAtMs: now, headSha: "h1", headRefName: "run-W1-T18001-1", checksState: "PENDING" },
    { number: 18002, createdAtMs: w + 21 * HOUR, updatedAtMs: now, headSha: "h2", headRefName: "run-W1-T18002-1", checksState: "PENDING" },
    { number: 18003, createdAtMs: w - DAY, updatedAtMs: now, headSha: "h3", headRefName: "old", checksState: "SUCCESS", mergedAtMs: w + 23 * HOUR },
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

function refusalRows(now: number, head = "head-17000") {
  const events: Record<string, unknown>[] = [];
  logArmAttribution((step, extra) => events.push({ ts: at(now - 3 * HOUR), step, ...extra }),
    "direct-merge-preflight-refused", "https://github.com/craigoley/remudero/pull/17000", undefined, "sweep", {}, undefined,
    { priorHeadSha: head, remedy: "retry-later", reason: "plan_merge_unread" });
  return [
    ...rows(now).filter((row) => row.pr_number !== 17000),
    { ts: at(now - 4 * HOUR), step: "review.posted", pr_number: 17000, head_sha: "head-17000", state: "success" },
    ...events,
  ];
}

test("production preflight refusals retain their exact head identity and observed stage age", () => {
  const now = Date.parse("2026-11-02T12:00:00.000Z");
  const result = openQueueShadow(census(now), refusalRows(now), undefined, now);
  assert.equal(result.cohort.merge_preflight_refused, 1);
  assert.equal(result.cohort.merge_preflight_refusal_age_p50_ms, 3 * HOUR);
  assert.equal(result.cohort.ready_to_direct_merge, 1);
  assert.equal(result.cohort.ready_to_direct_merge_age_p50_ms, 2 * HOUR);
  const stale = openQueueShadow(census(now), refusalRows(now, "old-head"), undefined, now);
  assert.equal(stale.cohort.merge_preflight_refused, 0, "a prior head's refusal cannot block the current head");
  assert.equal(stale.cohort.ready_to_direct_merge, 2);
  const noCurrentReview = refusalRows(now).filter((row) => row.pr_number !== 17000 || row.step !== "review.posted");
  noCurrentReview.push({ ts: at(now - HOUR), step: "review.posted", pr_number: 17000,
    head_sha: "old-head", prior_head_sha: "head-17000", state: "success" });
  const unreviewed = openQueueShadow(census(now), noCurrentReview, undefined, now);
  assert.equal(unreviewed.cohort.merge_preflight_refused, 1);
  assert.equal(unreviewed.cohort.ready_to_direct_merge, 1, "only refusal rows may use prior_head_sha");
});

test("#16147 and #16186 remain in review wait until their current heads are reviewed", () => {
  const now = Date.parse("2026-11-02T17:42:00.000Z");
  const cohort = census(now);
  cohort.open = cohort.open.filter((pr) => pr.number !== 17000).map((pr) => ({ ...pr, checksState: "SUCCESS" }));
  const replay = [
    { ts: "2026-11-02T06:13:00.000Z", step: "sweep.review_eligible", pr_number: 16147, head_sha: "head-16147" },
    { ts: "2026-11-02T13:08:00.000Z", step: "sweep.review_eligible", pr_number: 16186, head_sha: "head-16186" },
    ...[16147, 16186].map((pr_number) => ({ ts: at(now - HOUR), step: "review.posted", pr_number, head_sha: "old-head", state: "success" })),
  ];
  const waiting = openQueueShadow(cohort, replay, undefined, now);
  assert.equal(waiting.cohort.open, 2);
  assert.equal(waiting.cohort.review_waiting, 2);
  assert.equal(waiting.cohort.ready_to_direct_merge, 0);
  for (const pr_number of [16147, 16186]) replay.push({ ts: at(now), step: "review.posted", pr_number, head_sha: `head-${pr_number}`, state: "success" });
  const reviewed = openQueueShadow(cohort, replay, undefined, now);
  assert.equal(reviewed.cohort.review_waiting, 0);
  assert.equal(reviewed.cohort.ready_to_direct_merge, 2);
});

test("right-censors the full open cohort, separates review, preflight refusal and ready waits, then recommends only after repeated pressure", () => {
  const now = Date.parse("2026-11-02T12:00:00.000Z");
  const result = openQueueShadow(census(now), rows(now), {
    observedAtMs: now - DAY, windowDay: "2026-11-01", window: previousWindow(now),
    reviewP50: HOUR, pressure: true, streak: 1, producer: "plan-task-workers",
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

test("recommendation requires consecutive complete UTC-day windows with the same producer", () => {
  const day1 = Date.parse("2026-11-02T12:00:00.000Z");
  const first = openQueueShadow(census(day1), rows(day1), {
    observedAtMs: day1 - DAY, windowDay: "2026-11-01", window: previousWindow(day1),
    reviewP50: HOUR, pressure: false, streak: 0, producer: "plan-task-workers",
  }, day1);
  assert.equal(first.nextState.streak, 1);
  assert.equal(first.recommendation, undefined);
  assert.deepEqual(first.window, windowOf(day1), "the window is the last complete UTC day");
  assert.deepEqual(first.nextState.window, first.window);
  const day2 = day1 + DAY;
  const second = openQueueShadow(census(day2), rows(day2, 3 * HOUR), first.nextState, day2);
  assert.equal(second.nextState.streak, 2);
  assert.equal(second.recommendation, "consider-slowing-plan-task-workers");
  assert.equal(first.window.toMs, second.window.fromMs);
});

test("W1-T11111 criterion 1: daily passes at jittery wall-clock times on consecutive UTC dates join their windows", () => {
  // The daily pass runs once per UTC date at whatever systemClock time it reaches: minutes apart across midnight, or
  // well over a day apart. Exact 24 h steps never happen in production, so a rolling window never joined its predecessor.
  const runs = ["2026-11-01T23:58:41.000Z", "2026-11-02T00:03:12.000Z", "2026-11-03T17:41:09.000Z"].map(Date.parse);
  let state: Parameters<typeof openQueueShadow>[2] = {
    observedAtMs: runs[0]! - DAY, windowDay: "2026-10-31", window: previousWindow(runs[0]!),
    reviewP50: HOUR, pressure: false, streak: 0, producer: "plan-task-workers",
  };
  const streaks: number[] = [];
  const recommendations: Array<string | undefined> = [];
  runs.forEach((now, i) => {
    const result = openQueueShadow(census(now), rows(now, (2 + i) * HOUR), state, now);
    assert.equal(result.status, "OBSERVED");
    assert.equal(result.cohort.arrivals, 2, `run ${i + 1} counts only its own complete day's arrivals`);
    streaks.push(result.nextState.streak);
    recommendations.push(result.recommendation);
    state = result.nextState;
  });
  assert.deepEqual(streaks, [1, 2, 3], "five minutes apart or 41 hours apart, consecutive dates join");
  assert.deepEqual(recommendations, [undefined, "consider-slowing-plan-task-workers", "consider-slowing-plan-task-workers"]);
});

test("a second pass on the same UTC date re-reads the same window: the streak neither advances nor resets", () => {
  const firstDay = Date.parse("2026-10-31T23:00:00.000Z");
  const first = openQueueShadow(census(firstDay), rows(firstDay), {
    observedAtMs: firstDay - DAY, windowDay: "2026-10-30", window: previousWindow(firstDay), reviewP50: HOUR,
    pressure: false, streak: 0, producer: "plan-task-workers",
  }, firstDay);
  assert.equal(first.nextState.streak, 1);
  const retry = firstDay + 40 * 60_000;
  const again = openQueueShadow({ ...census(firstDay), observedAtMs: retry }, rows(retry), first.nextState, retry);
  assert.deepEqual(again.window, first.window, "the same date reads the same window");
  assert.equal(again.cohort.arrivals, 2, "the window's arrivals are counted once, not twice");
  assert.equal(again.nextState.streak, 1, "a re-read neither advances nor resets the streak");
  assert.equal(again.recommendation, undefined);
  const nextDate = Date.parse("2026-11-01T00:30:00.000Z");
  const control = openQueueShadow(census(nextDate), rows(nextDate, 3 * HOUR), again.nextState, nextDate);
  assert.equal(control.nextState.streak, 2, "the next date joins, across a month boundary");
  assert.equal(control.recommendation, "consider-slowing-plan-task-workers");
});

test("a skipped UTC date breaks the streak, and any time on the next date joins", () => {
  const firstDay = Date.parse("2026-11-02T01:00:00.000Z");
  const first = openQueueShadow(census(firstDay), rows(firstDay), {
    observedAtMs: firstDay - DAY, windowDay: "2026-11-01", window: previousWindow(firstDay),
    reviewP50: HOUR, pressure: false, streak: 0, producer: "plan-task-workers",
  }, firstDay);
  assert.equal(first.nextState.streak, 1);
  for (const iso of ["2026-11-03T00:00:01.000Z", "2026-11-03T11:59:00.000Z", "2026-11-03T23:59:59.000Z"]) {
    const now = Date.parse(iso);
    const result = openQueueShadow(census(now), rows(now, 3 * HOUR), first.nextState, now);
    assert.equal(result.nextState.streak, 2, `${iso} joins the 2026-11-02 pass`);
    assert.equal(result.recommendation, "consider-slowing-plan-task-workers");
  }
  const skipped = Date.parse("2026-11-04T09:00:00.000Z");
  const gap = openQueueShadow(census(skipped), rows(skipped, 3 * HOUR), first.nextState, skipped);
  assert.equal(gap.nextState.streak, 0, "a missing date is a gap");
  assert.equal(gap.recommendation, undefined);
});

test("legacy dates or misaligned prior window boundaries cannot supply pressure evidence", () => {
  const now = Date.parse("2026-11-02T12:00:00.000Z");
  const previous = { observedAtMs: now - DAY, windowDay: "2026-11-01", reviewP50: HOUR,
    pressure: true, streak: 1, producer: "plan-task-workers" };
  const aligned = previousWindow(now);
  for (const window of [undefined, { fromMs: aligned.fromMs + HOUR, toMs: aligned.toMs },
    { fromMs: aligned.fromMs, toMs: aligned.toMs - 1 }]) {
    const result = openQueueShadow(census(now), rows(now), { ...previous, window }, now);
    assert.equal(result.nextState.streak, 0);
    assert.equal(result.recommendation, undefined);
  }
  const control = openQueueShadow(census(now), rows(now), { ...previous, observedAtMs: now - DAY - 60_000, window: aligned }, now);
  assert.equal(control.nextState.streak, 2, "window boundaries control continuity, not census timestamps");
  assert.equal(control.recommendation, "consider-slowing-plan-task-workers");
});

test("equal drain, improving review wait, or a changed producer prevents a recommendation", () => {
  const now = Date.parse("2026-11-02T12:00:00.000Z");
  const previous = { observedAtMs: now - DAY, windowDay: "2026-11-01", window: previousWindow(now), reviewP50: HOUR,
    pressure: true, streak: 1, producer: "plan-task-workers" };
  const equalDrain = census(now);
  equalDrain.window.push({ ...equalDrain.window[2]!, number: 18004, mergedAtMs: undefined, closedAtMs: windowOf(now).fromMs + 22 * HOUR });
  const drained = openQueueShadow(equalDrain, rows(now), previous, now);
  assert.equal(drained.cohort.merged_or_closed, 2, "closed PRs contribute to drain");
  assert.equal(drained.nextState.streak, 0);
  assert.equal(drained.recommendation, undefined);
  const improving = openQueueShadow(census(now), rows(now, HOUR / 2), previous, now);
  assert.equal(improving.nextState.streak, 0);
  assert.equal(improving.recommendation, undefined);
  const changed = openQueueShadow(census(now), rows(now), { ...previous, producer: "codex" }, now);
  assert.equal(changed.nextState.streak, 0);
  assert.equal(changed.recommendation, undefined);
});

test("incomplete, stale or mismatched census is UNKNOWN and never recommends", () => {
  const now = Date.parse("2026-11-02T12:00:00.000Z");
  const previous = { observedAtMs: now - DAY, windowDay: "2026-11-01", window: previousWindow(now),
    reviewP50: HOUR, pressure: true, streak: 1, producer: "plan-task-workers" };
  const incomplete = openQueueShadow({ ...census(now), complete: false }, rows(now), previous, now);
  assert.equal(incomplete.status, "UNKNOWN");
  assert.equal(incomplete.nextState.streak, 0);
  assert.equal(incomplete.nextState.pressure, false);
  assert.equal(incomplete.recommendation, undefined);
  const stale = openQueueShadow({ ...census(now), observedAtMs: now - 7 * HOUR }, rows(now), previous, now);
  assert.equal(stale.status, "UNKNOWN");
  assert.equal(stale.nextState.streak, 0);
  assert.equal(stale.recommendation, undefined);
  const mismatched = openQueueShadow({ ...census(now), windowMs: previousWindow(now) }, rows(now), previous, now);
  assert.equal(mismatched.status, "UNKNOWN", "a census read for another day is not this day's evidence");
  assert.equal(mismatched.reason, "census-window-mismatch");
  const responseObservedAfterPassStart = openQueueShadow({ ...census(now), observedAtMs: now + 1_000 }, rows(now), previous, now + 1_000);
  assert.equal(responseObservedAfterPassStart.status, "OBSERVED", "freshness is measured at analysis time after the API response");
  const afterUnknown = now + DAY;
  const recovered = openQueueShadow(census(afterUnknown), rows(afterUnknown, 3 * HOUR), incomplete.nextState, afterUnknown);
  assert.equal(recovered.nextState.streak, 0);
  assert.equal(recovered.recommendation, undefined, "incomplete evidence cannot join the next complete window");
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
      readLedger: () => ({ ok: true, rows: refusalRows(now), unread: [] }),
      readOpenQueue: flowOpenQueueReader("acme", "remudero", async (args) => {
        censusReads++;
        assertCommitRollupQuery(args);
        return censusResponse(census(now), windowOf(now));
      }, fixedClock(now)),
      readCi: async () => { perPrCiReads++; return undefined; },
      planTasks: () => [],
    });
    const row = events.find((event) => event.step === "flow.open_queue_shadow");
    assert.ok(row);
    assert.equal(row.extra.mode, "shadow");
    assert.equal(row.extra.permission, "not-granted");
    assert.equal(row.extra.action, "none");
    assert.equal(row.extra.status, "OBSERVED");
    assert.equal(row.extra.reason, "complete-window-no-confirmed-pressure");
    assert.deepEqual(row.extra.window, windowOf(now));
    assert.deepEqual(openQueueWindow(now), windowOf(now));
    const saved = JSON.parse(readFileSync(join(stateDir, FLOW_STATE_FILE), "utf8"));
    assert.deepEqual(saved.openQueue.window, row.extra.window, "actual evidence boundaries survive the daily pass");
    assert.equal(row.extra.producer, "plan-task-workers");
    const cohort = row.extra.cohort as Record<string, number>;
    assert.equal(cohort.open, 3);
    assert.equal(cohort.arrivals, 2);
    assert.equal(cohort.merged_or_closed, 1);
    assert.equal(cohort.review_waiting, 1);
    assert.equal(cohort.review_wait_p50_ms, 2 * HOUR);
    assert.equal(cohort.merge_preflight_refused, 1);
    assert.equal(cohort.merge_preflight_refusal_age_p50_ms, 3 * HOUR);
    assert.equal(cohort.ready_to_direct_merge, 1);
    assert.equal(cohort.ready_to_direct_merge_age_p50_ms, 2 * HOUR);
    assert.equal(cohort.open_age_p50_ms, 6 * HOUR);
    assert.equal(censusReads, 1, "a cohort that fits one page is one batched GraphQL round");
    assert.equal(perPrCiReads, 0, "open queue evidence adds no per-PR GitHub reads");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the production reader batches the open cohort and the window's created and closed PRs in one round", async () => {
  const node = (number: number, updates: Record<string, unknown> = {}) => ({ number, createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T11:00:00.000Z", headRefOid: `head-${number}`, headRefName: "run-W1-T11111-1",
    commits: { nodes: [{ commit: { oid: `head-${number}`, statusCheckRollup: { state: "SUCCESS" } } }] }, ...updates });
  const body = { data: {
    repository: { pullRequests: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node(1)] } },
    created: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node(1)] },
    closed: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node(2, { mergedAt: "2026-11-01T11:00:00.000Z" })] },
  } };
  const calls: string[][] = [];
  const readJson = async (args: string[]) => { calls.push(args); assertCommitRollupQuery(args); return body; };
  const observedAtMs = Date.parse("2026-11-02T12:00:00.000Z");
  const window = openQueueWindow(observedAtMs);
  const read = await flowOpenQueueReader("acme", "remudero", readJson, fixedClock(observedAtMs))(window);
  assert.equal(read.observedAtMs, observedAtMs);
  assert.equal(calls.length, 1);
  const query = calls[0]!.find((arg) => arg.startsWith("query=")) ?? "";
  assert.match(query, /is:pr created:2026-11-01T00:00:00Z\.\.2026-11-01T23:59:59Z/, "arrivals are searched by the window's exact UTC day");
  assert.match(query, /is:pr closed:2026-11-01T00:00:00Z\.\.2026-11-01T23:59:59Z/, "terminals are searched by the window's exact UTC day");
  assert.doesNotMatch(query, /updated:/, "the search is narrowed to what the window counts, not every updated PR");
  assert.equal(read.complete, true);
  assert.deepEqual(read.windowMs, window);
  assert.equal(read.open[0]?.checksState, "SUCCESS");
  assert.equal(read.window.find((pr) => pr.number === 2)?.mergedAtMs, Date.parse("2026-11-01T11:00:00.000Z"));
  body.data.repository.pullRequests.totalCount = 101;
  const truncated = await flowOpenQueueReader("acme", "remudero", readJson, fixedClock(observedAtMs))(window);
  assert.equal(truncated.complete, false);
  assert.equal(truncated.reason, "census-page-cap-exceeded");
});

test("W1-T11111 criterion 2: a cohort past one page is read whole by following each connection's cursor", async () => {
  const node = (number: number) => ({ number, createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T11:00:00.000Z",
    headRefOid: `head-${number}`, headRefName: "run-W1-T11111-1",
    commits: { nodes: [{ commit: { oid: `head-${number}`, statusCheckRollup: { state: "PENDING" } } }] } });
  const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => node(from + i));
  const queries: string[] = [];
  const readJson = async (args: string[]) => {
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    queries.push(query);
    assertCommitRollupQuery(args);
    const data: Record<string, unknown> = {};
    if (query.includes("repository(")) {
      data.repository = { pullRequests: query.includes('after:"open-1"')
        ? { totalCount: 130, pageInfo: { hasNextPage: false, endCursor: "open-2" }, nodes: range(1100, 30) }
        : { totalCount: 130, pageInfo: { hasNextPage: true, endCursor: "open-1" }, nodes: range(1000, 100) } };
    }
    if (query.includes("created: search")) {
      data.created = query.includes('after:"created-1"')
        ? { issueCount: 150, pageInfo: { hasNextPage: false, endCursor: "created-2" }, nodes: range(2100, 50) }
        : { issueCount: 150, pageInfo: { hasNextPage: true, endCursor: "created-1" }, nodes: range(2000, 100) };
    }
    if (query.includes("closed: search")) data.closed = { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
    return { data };
  };
  const now = Date.parse("2026-11-02T12:00:00.000Z");
  const read = await flowOpenQueueReader("acme", "remudero", readJson, fixedClock(now))(openQueueWindow(now));
  assert.equal(read.complete, true, "every page was followed, so the census is complete");
  assert.equal(read.reason, undefined);
  assert.equal(read.open.length, 130);
  assert.equal(read.window.length, 150);
  assert.equal(queries.length, 2, "one batched first round, then one round for the connections still paging");
  assert.doesNotMatch(queries[1]!, /closed: search/, "a finished connection is not asked again");
  assert.match(queries[1]!, /after:"open-1"/);
  assert.match(queries[1]!, /after:"created-1"/);

  const stalled = async (args: string[]) => {
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    return { data: {
      ...(query.includes("repository(") ? { repository: { pullRequests: { totalCount: 200, pageInfo: { hasNextPage: true, endCursor: "same" }, nodes: query.includes("after:") ? [] : range(1, 100) } } } : {}),
      ...(query.includes("created: search") ? { created: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } : {}),
      ...(query.includes("closed: search") ? { closed: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } : {}),
    } };
  };
  const stuck = await flowOpenQueueReader("acme", "remudero", stalled, fixedClock(now))(openQueueWindow(now));
  assert.equal(stuck.complete, false);
  assert.equal(stuck.reason, "census-pagination-stalled", "a page that makes no progress ends the read as incomplete, never a loop");

  const huge = async (args: string[]) => {
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    return { data: {
      ...(query.includes("repository(") ? { repository: { pullRequests: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } : {}),
      ...(query.includes("created: search") ? { created: { issueCount: 1001, pageInfo: { hasNextPage: true, endCursor: "c" }, nodes: range(1, 100) } } : {}),
      ...(query.includes("closed: search") ? { closed: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } : {}),
    } };
  };
  const capped = await flowOpenQueueReader("acme", "remudero", huge, fixedClock(now))(openQueueWindow(now));
  assert.equal(capped.complete, false);
  assert.equal(capped.reason, "github-search-result-limit", "GitHub's own search ceiling is named, not read as a pass");
});

test("the production reader never credits a missing or different-head commit rollup as merge-ready", async () => {
  const now = Date.parse("2026-11-02T12:00:00.000Z");
  for (const commits of [undefined, { nodes: [] }, { nodes: [{}, {}] }, { nodes: [{ commit: {
    oid: "old-head", statusCheckRollup: { state: "SUCCESS" },
  } }] }, { nodes: [{ commit: { oid: "head-16186", statusCheckRollup: null } }] },
  { nodes: [{ commit: { oid: "head-16186", statusCheckRollup: { state: "UNRECOGNIZED" } } }] }]) {
    const body = censusResponse(census(now), windowOf(now));
    const node = body.data.repository.pullRequests.nodes.find((pr) => pr.number === 16186)!;
    Object.assign(node, { commits });
    const read = await flowOpenQueueReader("acme", "remudero", async () => body, fixedClock(now))(openQueueWindow(now));
    assert.equal(read.open.find((pr) => pr.number === 16186)?.checksState, "UNKNOWN");
    const report = openQueueShadow(read, rows(now), undefined, now);
    assert.equal(report.cohort.ready_to_direct_merge, 0, "a current-head review also needs current-head green checks");
    assert.equal(report.cohort.open, 3, "unknown checks do not remove right-censored open PRs");
  }
});

test("the registered production flow pass wires one batched queue read in shadow mode", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}flow-open-registry-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.parse("2026-11-02T12:00:00.000Z");
  const events: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const reads: string[][] = [];
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const empty = { totalCount: 0, issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
  const body = { data: { repository: { pullRequests: empty }, created: empty, closed: empty } };
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
