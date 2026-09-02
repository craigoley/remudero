import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeBoardSnapshot,
  createBoardSnapshotCache,
  type BoardDeps,
  type PrQueueRow,
} from "../src/lib/board.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub, PrRef } from "../src/lib/status.js";
import { renderShellHtml } from "../src/lib/serve.js";

function task(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
  };
}

function plan(ids: string[] = []): Plan {
  const tasks = ids.map(task);
  return { tasks, byId: new Map(tasks.map((entry) => [entry.id, entry])) };
}

function openPr(number: number, over: Partial<PrRef> = {}): PrRef {
  return {
    number,
    url: `https://github.com/craigoley/remudero/pull/${number}`,
    state: "OPEN",
    title: `PR ${number}`,
    headRefName: `topic-${number}`,
    headRefOid: `head-${number}`,
    body: "",
    ...over,
  };
}

interface GithubFixture {
  rows: PrRef[] | null;
  failed?: boolean;
  truncated?: boolean;
  reason?: "rate_limit" | "auth" | "transport" | "buffer_overflow" | "unknown";
  listCalls?: number;
  reviews?: Record<string, "success" | "failure" | "pending" | "none">;
}

function github(fixture: GithubFixture): GitHub {
  return {
    prByRef(ref) {
      const number = Number(String(ref).replace(/^.*\//, ""));
      return fixture.rows?.find((row) => row.number === number) ?? null;
    },
    findMergedByTrailer: () => null,
    headRefName: (url) => fixture.rows?.find((row) => row.url === url)?.headRefName,
    prBody: (url) => fixture.rows?.find((row) => row.url === url)?.body,
    listOpenHeadBranches() {
      fixture.listCalls = (fixture.listCalls ?? 0) + 1;
      return fixture.rows;
    },
    reviewState: (url) => fixture.reviews?.[url] ?? "none",
    readFailed: () => fixture.failed ?? false,
    readFailureReason: () => fixture.reason,
    readTruncated: () => fixture.truncated ?? false,
  };
}

function deps(fixture: GithubFixture, lines: Array<Record<string, unknown>> = [], ids: string[] = []): BoardDeps & { ledgerReads: () => number } {
  let reads = 0;
  return {
    plan: plan(ids),
    ledgerPath: "/not-read/ledger.ndjson",
    github: github(fixture),
    readLedger: () => {
      reads += 1;
      return lines;
    },
    ledgerReads: () => reads,
  };
}

function disposed(prNumber: number, headSha: string, disposition: string, reason: string, ts: string): Record<string, unknown> {
  return {
    step: "sweep.disposed",
    run_id: "DAEMON-1",
    task_id: "SWEEP",
    pr_number: prNumber,
    pr_url: `https://github.com/craigoley/remudero/pull/${prNumber}`,
    head_sha: headSha,
    disposition,
    reason,
    ts,
  };
}

test("every current open PR appears exactly once, including unattributed and not-yet-observed heads", () => {
  const rows = [
    openPr(11, { body: "Remudero-Task: W1-T11", headRefName: "run-W1-T11-123" }),
    openPr(12),
  ];
  const input = deps(
    { rows },
    [
      disposed(11, "head-11", "wait", "checks pending", "2026-09-02T10:00:00.000Z"),
      disposed(99, "head-99", "blocked-fixable", "closed history", "2026-09-02T11:00:00.000Z"),
    ],
    ["W1-T11"],
  );
  const snapshot = computeBoardSnapshot(input);

  assert.equal(input.ledgerReads(), 1, "task rows, queue rows and holds share one parsed ledger read");
  assert.deepEqual(snapshot.prQueue.rows.map((row) => row.prNumber), [11, 12]);
  assert.equal(new Set(snapshot.prQueue.rows.map((row) => row.prNumber)).size, 2);
  assert.equal(snapshot.prQueue.rows[0].taskId, "W1-T11");
  assert.equal(snapshot.prQueue.rows[1].taskId, undefined, "an uncredited PR is explicit, never omitted");
  assert.equal(snapshot.prQueue.rows[1].disposition, "not-yet-observed");
  assert.match(snapshot.prQueue.rows[1].reason, /current head/);
  assert.equal(snapshot.prQueue.rows.some((row) => row.prNumber === 99), false, "ledger-only closed history cannot enter the live queue");
});

test("only the newest disposal for the exact current head can describe a queue row", () => {
  const row = openPr(20, { headRefOid: "new-head" });
  const base = [
    disposed(20, "new-head", "post-review", "review worker active", "2026-09-02T10:00:00.000Z"),
    disposed(20, "old-head", "blocked-fixable", "old CI failure", "2026-09-02T11:00:00.000Z"),
  ];
  const current = computeBoardSnapshot(deps({ rows: [row] }, base)).prQueue.rows[0];
  assert.equal(current.disposition, "post-review");
  assert.equal(current.reason, "review worker active");
  assert.equal(current.observedAt, "2026-09-02T10:00:00.000Z");

  const pushed = computeBoardSnapshot(deps({ rows: [{ ...row, headRefOid: "third-head" }] }, base)).prQueue.rows[0];
  assert.equal(pushed.disposition, "not-yet-observed");
  assert.doesNotMatch(pushed.reason, /old CI failure/);
});

test("task-backed review state is reused and taskless review state uses the same vocabulary", () => {
  const taskPr = openPr(30, { body: "Remudero-Task: W1-T30", headRefName: "run-W1-T30-1" });
  const loosePr = openPr(31);
  const reviews = { [taskPr.url]: "success" as const, [loosePr.url]: "pending" as const };
  const snapshot = computeBoardSnapshot(deps({ rows: [taskPr, loosePr], reviews }, [], ["W1-T30"]));
  assert.equal(snapshot.prQueue.rows.find((row) => row.prNumber === 30)?.reviewState, "success");
  assert.equal(snapshot.prQueue.rows.find((row) => row.prNumber === 31)?.reviewState, "pending");
});

test("an unreadable or truncated open index is incomplete, withheld, and carries last-good freshness", () => {
  const fixture: GithubFixture = { rows: [openPr(40)] };
  const input = deps(fixture);
  const cache = createBoardSnapshotCache();
  const good = cache.get(input);
  assert.equal(good.prQueue.complete, true);
  assert.equal(good.prQueue.rows.length, 1);

  fixture.rows = null;
  fixture.failed = true;
  fixture.reason = "auth";
  const failed = cache.get(input);
  assert.equal(failed.prQueue.complete, false);
  assert.deepEqual(failed.prQueue.rows, [], "a stale prior queue is withheld, never drawn as current");
  assert.match(failed.prQueue.unavailableReason ?? "", /auth/);
  assert.equal(failed.prQueue.lastGoodAt, good.generated_at);

  fixture.rows = [openPr(40)];
  fixture.failed = false;
  fixture.truncated = true;
  const truncated = computeBoardSnapshot(input);
  assert.equal(truncated.prQueue.complete, false);
  assert.deepEqual(truncated.prQueue.rows, []);
  assert.match(truncated.prQueue.unavailableReason ?? "", /truncated/);
});

test("the board cache invalidates when the live open-PR index changes without a ledger append", () => {
  const fixture: GithubFixture = { rows: [openPr(41)] };
  const input = deps(fixture);
  const cache = createBoardSnapshotCache();
  assert.deepEqual(cache.get(input).prQueue.rows.map((row) => row.prNumber), [41]);

  fixture.rows = [openPr(41), openPr(42)];
  assert.deepEqual(
    cache.get(input).prQueue.rows.map((row) => row.prNumber),
    [41, 42],
    "a GitHub-only queue change cannot remain hidden behind an unchanged ledger-length cache key",
  );
});

test("queue order is actionable, active, ready or held, waiting, then unknown; numeric inside each class", () => {
  const rows = [80, 71, 70, 62, 61, 60, 51, 50, 40].map((number) => openPr(number));
  const lines = [
    disposed(80, "head-80", "mystery", "unknown", "2026-09-02T10:00:00.000Z"),
    disposed(71, "head-71", "wait", "checks", "2026-09-02T10:00:00.000Z"),
    disposed(70, "head-70", "wait", "checks", "2026-09-02T10:00:00.000Z"),
    disposed(61, "head-61", "mergeable", "ready", "2026-09-02T10:00:00.000Z"),
    disposed(60, "head-60", "mergeable", "ready", "2026-09-02T10:00:00.000Z"),
    { step: "automerge.hold_engaged", task_id: "W1-T62", pr_number: 62, by: "craig", reason: "manual inspection" },
    disposed(51, "head-51", "post-review", "reviewing", "2026-09-02T10:00:00.000Z"),
    disposed(50, "head-50", "post-review", "reviewing", "2026-09-02T10:00:00.000Z"),
    disposed(40, "head-40", "conflicted", "conflict", "2026-09-02T10:00:00.000Z"),
  ];
  const queue = computeBoardSnapshot(deps({ rows }, lines)).prQueue.rows;
  assert.deepEqual(queue.map((row) => row.prNumber), [40, 50, 51, 60, 61, 62, 70, 71, 80]);
  assert.deepEqual(queue.map((row) => row.queueClass), [
    "actionable",
    "active",
    "active",
    "ready-held",
    "ready-held",
    "ready-held",
    "waiting",
    "waiting",
    "unknown",
  ]);
  assert.equal(queue.find((row) => row.prNumber === 62)?.held, true, "an operator-held PR is represented in the ready/held class");
});

test("the rendered queue filters execute against loaded rows and never hide an unknown classification", () => {
  const html = renderShellHtml();
  const functionSource = html.match(/function filteredPrQueueRows\(rows\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(functionSource, "the consuming client filter function is present");
  const buildFilter = (filters: { actionability: string; review: string; task: string }) =>
    new Function("prQueueFilters", `${functionSource}; return filteredPrQueueRows;`)(filters) as (rows: unknown[]) => Array<{ prNumber: number }>;
  const rows = [
    { prNumber: 40, queueClass: "actionable", reviewState: "failure", taskId: "W1-T40" },
    { prNumber: 50, queueClass: "active", reviewState: "pending", taskId: "W1-T50" },
    { prNumber: 60, queueClass: "ready-held", reviewState: "success", taskId: "W1-T60" },
    { prNumber: 70, queueClass: "waiting", reviewState: "none", taskId: undefined },
    { prNumber: 80, queueClass: "unknown", reviewState: "none", taskId: "W1-T80" },
  ];

  const numbers = (filtered: Array<{ prNumber: number }>) => filtered.map((row) => row.prNumber);
  assert.deepEqual(numbers(buildFilter({ actionability: "actionable", review: "all", task: "all" })(rows)), [40, 80]);
  assert.deepEqual(numbers(buildFilter({ actionability: "all", review: "success", task: "all" })(rows)), [60, 80]);
  assert.deepEqual(numbers(buildFilter({ actionability: "all", review: "all", task: "unattributed" })(rows)), [70, 80]);
  assert.deepEqual(numbers(buildFilter({ actionability: "all", review: "all", task: "W1-T60" })(rows)), [60, 80]);
});

test("the Queue tab filters the already-loaded atomic snapshot and adds no write or polling route", () => {
  const html = renderShellHtml();
  for (const marker of [
    'data-tab="queue"',
    'id="pr-queue"',
    'id="pr-queue-list"',
    'id="pr-queue-actionability"',
    'id="pr-queue-review"',
    'id="pr-queue-task"',
    "function renderPrQueue",
  ]) assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /latestPrQueue = statusSnap\.prQueue/);
  assert.doesNotMatch(html, /getJson\("\/v1\/pr-queue/);
  assert.doesNotMatch(html, /postJson\("\/v1\/pr-queue/);
  assert.doesNotMatch(html, /setInterval\([^)]*renderPrQueue/);
});

test("queue rows preserve the exact reason and expose the latest transition in expandable detail", () => {
  const html = renderShellHtml();
  const source = html.match(/function prQueueRowHtml\(row\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(source);
  assert.match(source!, /row\.reason/);
  assert.match(source!, /row\.observedAt/);
  assert.match(source!, /<details/);
});

void (undefined as unknown as PrQueueRow);
