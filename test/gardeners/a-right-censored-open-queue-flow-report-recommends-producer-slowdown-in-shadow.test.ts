import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";

import { fixedClock } from "#src/lib/clock.js";
import { logArmAttribution } from "#src/lib/arm-auto-merge.js";
import { flowGardenPass } from "#src/lib/garden-registry.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { FLOW_STATE_FILE, flowOpenQueueReader, openQueueShadow, runFlowGardener, type FlowOpenQueuePr, type FlowOpenQueueRead } from "#src/lib/flow-gardener.js";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(ms).toISOString();

function censusResponse(cohort: FlowOpenQueueRead) {
  const node = (pr: FlowOpenQueuePr) => ({ number: pr.number, createdAt: at(pr.createdAtMs), updatedAt: at(pr.updatedAtMs),
    headRefOid: pr.headSha, headRefName: pr.headRefName,
    commits: { nodes: [{ commit: { oid: pr.headSha, statusCheckRollup: { state: pr.checksState } } }] },
    ...(pr.mergedAtMs === undefined ? {} : { mergedAt: at(pr.mergedAtMs) }),
    ...(pr.closedAtMs === undefined ? {} : { closedAt: at(pr.closedAtMs) }) });
  return { data: {
    repository: { pullRequests: { totalCount: cohort.open.length, pageInfo: { hasNextPage: false }, nodes: cohort.open.map(node) } },
    search: { issueCount: cohort.window.length, pageInfo: { hasNextPage: false }, nodes: cohort.window.map(node) },
  } };
}

function assertCommitRollupQuery(args: string[]) {
  const query = args.find((arg) => arg.startsWith("query=")) ?? "";
  assert.equal(query.match(/commits\(last:1\)\{nodes\{commit\{oid statusCheckRollup\{state\}\}\}\}/g)?.length, 2,
    "both PR selections must request the rollup on Commit");
  assert.equal(query.match(/statusCheckRollup/g)?.length, 2, "no rollup may be requested directly on PullRequest");
}

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
    observedAtMs: now - DAY, windowDay: "2026-11-01", window: { fromMs: now - 2 * DAY, toMs: now - DAY },
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

test("recommendation requires consecutive complete rolling 24-hour windows with the same producer", () => {
  const day1 = Date.parse("2026-11-02T12:00:00.000Z");
  const first = openQueueShadow(census(day1), rows(day1), {
    observedAtMs: day1 - DAY, windowDay: "2026-11-01", window: { fromMs: day1 - 2 * DAY, toMs: day1 - DAY },
    reviewP50: HOUR, pressure: false, streak: 0, producer: "plan-task-workers",
  }, day1);
  assert.equal(first.nextState.streak, 1);
  assert.equal(first.recommendation, undefined);
  assert.deepEqual(first.nextState.window, first.window);
  const day2 = day1 + DAY;
  const second = openQueueShadow(census(day2), rows(day2, 3 * HOUR), first.nextState, day2);
  assert.equal(second.nextState.streak, 2);
  assert.equal(second.recommendation, "consider-slowing-plan-task-workers");
  assert.deepEqual(second.nextState.window, second.window);
  assert.equal(first.window.toMs, second.window.fromMs);
});

test("adjacent calendar dates with 22 hours of overlap cannot count the same arrivals twice", () => {
  const firstDay = Date.parse("2026-10-31T23:00:00.000Z");
  const cohort = census(firstDay);
  const first = openQueueShadow(cohort, rows(firstDay), {
    observedAtMs: firstDay - DAY, windowDay: "2026-10-30",
    window: { fromMs: firstDay - 2 * DAY, toMs: firstDay - DAY }, reviewP50: HOUR,
    pressure: false, streak: 0, producer: "plan-task-workers",
  }, firstDay);
  assert.equal(first.nextState.streak, 1);
  const adjacent = firstDay + 2 * HOUR;
  const overlap = openQueueShadow({ ...cohort, observedAtMs: adjacent }, rows(firstDay), first.nextState, adjacent);
  assert.equal(overlap.status, "OBSERVED");
  assert.equal(overlap.cohort.arrivals, 2, "both duplicate arrivals remain in the overlapping window");
  assert.equal(overlap.cohort.merged_or_closed, 1);
  assert.equal(overlap.cohort.review_wait_p50_ms, 4 * HOUR, "review wait worsens without new arrivals");
  assert.equal(overlap.nextState.streak, 0);
  assert.equal(overlap.recommendation, undefined);
  const fullDay = firstDay + DAY;
  const control = openQueueShadow(census(fullDay), rows(fullDay, 3 * HOUR), first.nextState, fullDay);
  assert.equal(control.nextState.streak, 2, "touching rolling windows count across a month boundary");
  assert.equal(control.recommendation, "consider-slowing-plan-task-workers");
});

test("overlap or gaps break the streak even when report dates are adjacent", () => {
  const firstDay = Date.parse("2026-11-02T01:00:00.000Z");
  const first = openQueueShadow(census(firstDay), rows(firstDay), {
    observedAtMs: firstDay - DAY, windowDay: "2026-11-01", window: { fromMs: firstDay - 2 * DAY, toMs: firstDay - DAY },
    reviewP50: HOUR, pressure: false, streak: 0, producer: "plan-task-workers",
  }, firstDay);
  assert.equal(first.nextState.streak, 1);
  for (const elapsed of [HOUR, DAY - 1, DAY + 1, 26 * HOUR, 2 * DAY]) {
    const now = firstDay + elapsed;
    const result = openQueueShadow(census(now), rows(now, 3 * HOUR), first.nextState, now);
    assert.equal(result.nextState.streak, 0, `elapsed ${elapsed} ms does not join consecutive windows`);
    assert.equal(result.recommendation, undefined);
  }
  const now = firstDay + DAY;
  const control = openQueueShadow(census(now), rows(now, 3 * HOUR), first.nextState, now);
  assert.equal(control.nextState.streak, 2);
  assert.equal(control.recommendation, "consider-slowing-plan-task-workers");
});

test("legacy dates or incomplete prior window boundaries cannot supply pressure evidence", () => {
  const now = Date.parse("2026-11-02T12:00:00.000Z");
  const previous = { observedAtMs: now - DAY, windowDay: "2026-11-01", reviewP50: HOUR,
    pressure: true, streak: 1, producer: "plan-task-workers" };
  for (const window of [undefined, { fromMs: now - 2 * DAY + HOUR, toMs: now - DAY },
    { fromMs: now - 2 * DAY, toMs: now - DAY - 1 }]) {
    const result = openQueueShadow(census(now), rows(now), { ...previous, window }, now);
    assert.equal(result.nextState.streak, 0);
    assert.equal(result.recommendation, undefined);
  }
  const control = openQueueShadow(census(now), rows(now), { ...previous, observedAtMs: now - DAY - 60_000,
    window: { fromMs: now - 2 * DAY, toMs: now - DAY } }, now);
  assert.equal(control.nextState.streak, 2, "window boundaries control continuity, not census timestamps");
  assert.equal(control.recommendation, "consider-slowing-plan-task-workers");
});

test("equal drain, improving review wait, or a changed producer prevents a recommendation", () => {
  const now = Date.parse("2026-11-02T12:00:00.000Z");
  const previous = { observedAtMs: now - DAY, windowDay: "2026-11-01",
    window: { fromMs: now - 2 * DAY, toMs: now - DAY }, reviewP50: HOUR,
    pressure: true, streak: 1, producer: "plan-task-workers" };
  const equalDrain = census(now);
  equalDrain.window.push({ ...equalDrain.window[2]!, number: 18004, mergedAtMs: undefined, closedAtMs: now - HOUR });
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

test("incomplete or stale census is UNKNOWN and never recommends", () => {
  const now = Date.parse("2026-11-02T12:00:00.000Z");
  const previous = { observedAtMs: now - DAY, windowDay: "2026-11-01", window: { fromMs: now - 2 * DAY, toMs: now - DAY },
    reviewP50: HOUR, pressure: true, streak: 1, producer: "plan-task-workers" };
  const incomplete = openQueueShadow({ ...census(now), complete: false }, rows(now), previous, now);
  assert.equal(incomplete.status, "UNKNOWN");
  assert.equal(incomplete.nextState.streak, 0);
  assert.equal(incomplete.nextState.pressure, false);
  assert.equal(incomplete.recommendation, undefined);
  const stale = openQueueShadow({ ...census(now), observedAtMs: now - 7 * HOUR }, rows(now), previous, now);
  assert.equal(stale.status, "UNKNOWN");
  assert.equal(stale.nextState.streak, 0);
  assert.equal(stale.nextState.pressure, false);
  assert.equal(stale.recommendation, undefined);
  const responseObservedAfterPassStart = openQueueShadow({ ...census(now), observedAtMs: now + 1_000 }, rows(now), previous, now + 1_000);
  assert.equal(responseObservedAfterPassStart.status, "OBSERVED", "freshness is measured at analysis time after the API response");
  const afterUnknown = now + DAY;
  const recovered = openQueueShadow(census(afterUnknown), rows(afterUnknown, 3 * HOUR), incomplete.nextState, afterUnknown);
  assert.equal(recovered.nextState.streak, 0);
  assert.equal(recovered.recommendation, undefined, "incomplete evidence cannot join the next complete window");
  const sameWindow = openQueueShadow(census(now), rows(now), { ...previous,
    observedAtMs: now - HOUR, window: { fromMs: now - DAY, toMs: now } }, now);
  assert.equal(sameWindow.recommendation, undefined, "retries of a rolling window cannot advance the streak");
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
        return censusResponse(census(now));
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
    assert.deepEqual(row.extra.window, { fromMs: now - DAY, toMs: now });
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
    assert.equal(censusReads, 1);
    assert.equal(perPrCiReads, 0, "open queue evidence adds no per-PR GitHub reads");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("the production reader batches open and recent-terminal census data in one GitHub query and refuses a truncated page", async () => {
  const node = (number: number, updates: Record<string, unknown> = {}) => ({ number, createdAt: "2026-11-02T10:00:00.000Z",
    updatedAt: "2026-11-02T11:00:00.000Z", headRefOid: `head-${number}`, headRefName: "run-W1-T11111-1",
    commits: { nodes: [{ commit: { oid: `head-${number}`, statusCheckRollup: { state: "SUCCESS" } } }] }, ...updates });
  const body = { data: {
    repository: { pullRequests: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [node(1)] } },
    search: { issueCount: 2, pageInfo: { hasNextPage: false }, nodes: [node(1), node(2, { mergedAt: "2026-11-02T11:00:00.000Z" })] },
  } };
  const calls: string[][] = [];
  const readJson = async (args: string[]) => { calls.push(args); assertCommitRollupQuery(args); return body; };
  const observedAtMs = Date.parse("2026-11-02T12:00:00.000Z");
  const read = await flowOpenQueueReader("acme", "remudero", readJson, fixedClock(observedAtMs))("2026-11-01T12:00:00.000Z");
  assert.equal(read.observedAtMs, observedAtMs);
  assert.equal(calls.length, 1);
  assert.equal(read.complete, true);
  assert.equal(read.open[0]?.number, 1);
  assert.equal(read.open[0]?.checksState, "SUCCESS");
  assert.equal(read.window.find((pr) => pr.number === 2)?.checksState, "SUCCESS");
  assert.equal(read.window.find((pr) => pr.number === 2)?.mergedAtMs, Date.parse("2026-11-02T11:00:00.000Z"));
  body.data.repository.pullRequests.totalCount = 101;
  const truncated = await flowOpenQueueReader("acme", "remudero", readJson, fixedClock(observedAtMs))("2026-11-01T12:00:00.000Z");
  assert.equal(truncated.complete, false);
  assert.equal(truncated.reason, "census-page-cap-exceeded");
});

test("the production reader never credits a missing or different-head commit rollup as merge-ready", async () => {
  const now = Date.parse("2026-11-02T12:00:00.000Z");
  for (const commits of [undefined, { nodes: [] }, { nodes: [{}, {}] }, { nodes: [{ commit: {
    oid: "old-head", statusCheckRollup: { state: "SUCCESS" },
  } }] }, { nodes: [{ commit: { oid: "head-16186", statusCheckRollup: null } }] },
  { nodes: [{ commit: { oid: "head-16186", statusCheckRollup: { state: "UNRECOGNIZED" } } }] }]) {
    const body = censusResponse(census(now));
    const node = body.data.repository.pullRequests.nodes.find((pr) => pr.number === 16186)!;
    Object.assign(node, { commits });
    const read = await flowOpenQueueReader("acme", "remudero", async () => body, fixedClock(now))(at(now - DAY));
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
