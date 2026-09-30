import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { buildRecentRoute, computeRecentActivity, createRecentActivityCache, type BoardDeps } from "../src/lib/board.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

/**
 * /v1/recent never showed a merge on the live fleet. The console's "Just merged" panel and its
 * merged-today count read `verb === "merged"` off this feed, and the only step that minted it was a
 * run's own `verdict` row carrying `verdict: "merged"`. On the core ledger (2026-09-30, live file)
 * the merge is recorded instead by the sweep's `verdict.merged` credit (200 retained rows), while the
 * run's `verdict` row closes as `blocked_ci` long before GitHub merges. `run.start`, `review.posted` and
 * `automerge.armed` (122, 47 and 46 rows) were dropped by the same allowlist. The rows below are the live rows' shapes, trimmed.
 */

function task(over: Partial<Task> = {}): Task {
  return { id: "W1-T4811", title: "rename-only PRs take the fast lane", repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0, ...over };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

const github: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };

const PR = "https://github.com/craigoley/remudero/pull/8003";

const RUN_START = { ts: "2026-09-30T09:26:10.000Z", run_id: "W1-T4811-1790759962720", task_id: "W1-T4811", step: "run.start", lane: "run-task", type: "implement", risk: "medium" };
const PR_OPENED = { ts: "2026-09-30T09:33:37.379Z", run_id: "W1-T4811-1790759962720", task_id: "W1-T4811", step: "pr.opened", lane: "run-task", pr_url: PR };
const RUN_VERDICT = { ts: "2026-09-30T09:38:19.985Z", run_id: "W1-T4811-1790759962720", task_id: "W1-T4811", step: "verdict", verdict: "blocked_ci", pr_url: PR, cost_usd: 1.15 };
const REVIEW_POSTED = { ts: "2026-09-30T09:58:41.695Z", run_id: "review-PR8003-1790762288063", task_id: "W1-T4811", step: "review.posted", lane: "review", state: "success", pr_url: PR };
const ARMED = { ts: "2026-09-30T09:58:47.310Z", run_id: "review-PR8003-1790762288063", task_id: "W1-T4811", step: "automerge.armed", outcome: "armed", pr_number: 8003, pr_url: PR };
const MERGE_CREDIT = { ts: "2026-09-30T10:00:03.232Z", run_id: "DAEMON-1790759538138", task_id: "W1-T4811", step: "verdict.merged", verdict: "merged", pr_number: 8003, pr_url: PR, source: "sweep.credit_backfill" };

function depsFor(rows: Array<Record<string, unknown>>): BoardDeps & { fixture: ReturnType<typeof writeLedger> } {
  const fixture = writeLedger(rows);
  return { plan: planOf([task()]), ledgerPath: fixture.path, github, fixture };
}

test("a sweep verdict.merged credit reaches the recent feed as a merge", () => {
  const feed = computeRecentActivity(depsFor([RUN_VERDICT, MERGE_CREDIT]), createRecentActivityCache());
  const merges = feed.filter((e) => e.verb === "merged");
  assert.equal(merges.length, 1, "the credit is the merge the console's Just merged panel counts");
  assert.equal(merges[0].prUrl, PR);
  assert.equal(merges[0].prNumber, 8003);
  assert.equal(merges[0].ts, MERGE_CREDIT.ts);
});

test("a run start and its review and auto-merge each reach the recent feed", () => {
  const feed = computeRecentActivity(depsFor([RUN_START, PR_OPENED, RUN_VERDICT, REVIEW_POSTED, ARMED, MERGE_CREDIT]), createRecentActivityCache());
  // `pr.opened` stays silent on purpose: it is the feed's PR-url carrier for later rows of the run.
  assert.deepEqual(feed.map((e) => e.verb), ["merged", "automerge", "review", "verdict", "started"]);
  const byVerb = new Map(feed.map((e) => [e.verb, e]));
  assert.equal(byVerb.get("started")?.detail, "implement");
  assert.equal(byVerb.get("review")?.prNumber, 8003);
  assert.equal(byVerb.get("review")?.detail, "success", "the review's own state, verbatim");
  assert.equal(byVerb.get("automerge")?.detail, "armed");
});

test("one merge recorded by a verdict row and a verdict.merged credit is one merged row", () => {
  const ownVerdict = { ...RUN_VERDICT, verdict: "merged" };
  const feed = computeRecentActivity(depsFor([ownVerdict, MERGE_CREDIT]), createRecentActivityCache());
  assert.equal(feed.filter((e) => e.verb === "merged").length, 1, "the console counts merges off this feed, so a double row double-counts");
});

test("a rotation that leaves the live ledger with more lines than were scanned is rescanned not skipped", () => {
  // Rotation rewrites the live file smaller in BYTES; with short rows it can still hold more LINES
  // than the feed had scanned, and the old line cursor then skipped the new file's head.
  const bulky = { ...RUN_VERDICT, verdict: "blocked_ci", reason: "x".repeat(4000) };
  const deps = depsFor([bulky, bulky, bulky]);
  const cache = createRecentActivityCache();
  assert.equal(computeRecentActivity(deps, cache).length, 3);
  writeFileSync(deps.ledgerPath, [MERGE_CREDIT, RUN_START, PR_OPENED, REVIEW_POSTED].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const feed = computeRecentActivity(deps, cache);
  assert.deepEqual(feed.map((e) => e.verb), ["review", "started", "merged"], "exactly the rewritten file, from its first row");
});

function call(route: ReturnType<typeof buildRecentRoute>, url: string): { status: number; body: { entries?: Array<{ verb: string }>; error?: string } } {
  let status = 0;
  let text = "";
  const res = { writeHead: (s: number) => { status = s; }, end: (b: string) => { text = b; } } as unknown as ServerResponse;
  void route.handler({ url, headers: {} } as IncomingMessage, res, { params: {} });
  return { status, body: JSON.parse(text) as { entries?: Array<{ verb: string }>; error?: string } };
}

test("GET recent narrows to the asked verbs and sizes the page by limit", () => {
  const rows = [RUN_START, PR_OPENED, REVIEW_POSTED, ARMED, MERGE_CREDIT];
  const route = buildRecentRoute(depsFor(rows));
  assert.deepEqual(call(route, "/v1/recent?verb=merged").body.entries?.map((e) => e.verb), ["merged"]);
  assert.deepEqual(call(route, "/v1/recent?verb=review,started").body.entries?.map((e) => e.verb), ["review", "started"]);
  assert.equal(call(route, "/v1/recent?limit=2").body.entries?.length, 2);
  assert.equal(call(route, "/v1/recent").body.entries?.length, 4, "a bare GET is the whole default page, as before");
});

test("GET recent refuses an unknown verb or an out-of-range limit with a 400", () => {
  const route = buildRecentRoute(depsFor([MERGE_CREDIT]));
  for (const url of ["/v1/recent?verb=merge", "/v1/recent?verb=", "/v1/recent?limit=0", "/v1/recent?limit=201", "/v1/recent?limit=abc"]) {
    const out = call(route, url);
    assert.equal(out.status, 400, url);
    assert.equal(out.body.error, "invalid_request", url);
  }
});
