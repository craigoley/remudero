import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { dailyWindow } from "#src/lib/daily-progress-calendar.js";
import { readDailyProgressRepositories } from "#src/lib/daily-progress-collector.js";
import { prepareDailyProgressPublication, type DailyProgressRecord } from "#src/lib/daily-progress-store.js";
import { createDailyProgressView, dailyProgressRequestKey, readDailyProgressReport, validateDailyProgressRequest, DAILY_PROGRESS_VIEW_NAME } from "#src/lib/daily-progress-view.js";
import { acquireLease, openReadModel } from "#src/lib/read-model-db.js";
import { createRepositoriesSourcePublisher } from "#src/lib/repositories-view.js";
import { withTempDir } from "#src/lib/tmp.js";
import { buildReadModelViewRoutes, renderView, type ViewBodyEntry, type ViewBodySource } from "#src/lib/views.js";
import { judgeSource } from "#src/lib/view-freshness.js";

function record(repository: string, count: number, at = "2026-11-02T04:50:00.000Z"): DailyProgressRecord {
  const window = dailyWindow("2026-11-01"), end = at;
  return { version: "daily-progress-v1", scope: { kind: "repository", repository }, ...window, generatedAt: at, phase: "provisional",
    coverage: { state: "partial", expectedRepositories: [repository], includedRepositories: [repository], expectedSources: [
      { id: `${repository}:prs`, repository, kind: "pull_requests", instanceId: null, required: true },
      ...(["ledger_activity", "deployments"] as const).map(kind => ({ id: `${repository}:${kind}`, repository, kind, instanceId: null, required: false }))], sources: [{ id: `${repository}:prs`, repository,
      kind: "pull_requests", instanceId: null, required: true, state: "complete", lastAttemptAt: at, lastSuccessAt: at, coverageStart: window.windowStart, coverageThrough: end, nextDueAt: window.windowEnd, reason: null },
      ...(["ledger_activity", "deployments"] as const).map(kind => ({ id: `${repository}:${kind}`, repository, kind, instanceId: null, required: false, state: "not_collected" as const,
        lastAttemptAt: null, lastSuccessAt: null, coverageStart: null, coverageThrough: null, nextDueAt: null, reason: "This evidence is not collected." }))] },
    totals: { mergedChanges: { value: count, precision: "exact" }, completedTasks: { value: count, precision: "exact" } }, currentWork: null,
    events: Array.from({ length: count }, (_, index) => ({ id: `${repository}:pr:${index + 1}`, repository, kind: "merged", sourceId: `${repository}:prs`, occurredAt: "2026-11-01T15:00:00.000Z",
      observedAt: at, fleetAttribution: "confirmed", taskIds: [`W1-T${index + 1}`], title: `Change ${index + 1}`, url: `https://github.com/${repository}/pull/${index + 1}` })),
  };
}

test("daily progress served scope preserves partial evidence and rejects foreign repositories", async () => {
  await withTempDir("daily-view", async stateDir => {
    const repositories = ["acme/a", "acme/b", "acme/missing"];
    createRepositoriesSourcePublisher({ stateDir, instances: () => repositories.map((repository, index) => {
      const [owner, repo] = repository.split("/") as [string, string];
      return { instanceId: `source-${index}`, options: { root: stateDir, instanceRepository: { owner, repo } } };
    }) })();
    assert.deepEqual(readDailyProgressRepositories(stateDir), repositories);
    const db = openReadModel({ stateDir, instance: "proof", schemaVersion: 1 });
    try {
      const lease = acquireLease(db); assert.ok(lease.ok); if (!lease.ok) return;
      prepareDailyProgressPublication(stateDir, [record("acme/a", 205), record("acme/b", 2), record("evil/hidden", 12)], []).commit(db, lease.lease);
      const now = Date.parse("2026-11-02T04:59:00Z"), params = new URLSearchParams({ repository: "all", date: "today" });
      const first = readDailyProgressReport({ stateDir, params, now });
      assert.deepEqual(first.data.coverage.expectedRepositories, repositories);
      assert.deepEqual(first.data.coverage.includedRepositories, ["acme/a", "acme/b"]);
      assert.deepEqual(first.data.totals.mergedChanges, { value: 207, precision: "at_least" });
      assert.deepEqual(first.data.totals.completedTasks, { value: 207, precision: "at_least" }, "equal task labels in separate repositories remain separate identities");
      assert.equal(first.data.events.length, 200); assert.equal(first.data.page.totalEvents, 207); assert.ok(first.data.page.nextCursor);
      assert.ok(!JSON.stringify(first).includes("evil/hidden"));
      const second = readDailyProgressReport({ stateDir, params: new URLSearchParams({ repository: "all", date: "2026-11-01", page: first.data.page.nextCursor }), now });
      assert.equal(second.data.events.length, 7); assert.equal(second.data.revision, first.data.revision);
      assert.deepEqual(readDailyProgressReport({ stateDir, params: new URLSearchParams({ repository: "acme/a", date: "today" }), now }).data.totals.mergedChanges, { value: 205, precision: "exact" });
      assert.throws(() => readDailyProgressReport({ stateDir, params: new URLSearchParams({ repository: "evil/hidden", date: "today" }), now }), /unknown repository/);
      assert.throws(() => readDailyProgressReport({ stateDir, params: new URLSearchParams({ repository: "acme/a", date: "today", page: first.data.page.nextCursor! }), now }), /scope|page/);
      const changed = record("acme/a", 205, "2026-11-02T04:55:00.000Z"); changed.events[0]!.title = "Corrected title";
      prepareDailyProgressPublication(stateDir, [changed], []).commit(db, lease.lease);
      assert.deepEqual(readDailyProgressReport({ stateDir, params: new URLSearchParams({ repository: "all", date: "2026-11-01", page: first.data.page.nextCursor! }), now }).data.events, second.data.events, "late evidence does not mutate a pinned page");

      const clock = { now: () => now, iso: () => fixedClock(now).iso(), date: () => fixedClock(now).date() };
      const selected = new URLSearchParams({ repository: "acme/a", date: "today" });
      const key = dailyProgressRequestKey(selected, now);
      const built = createDailyProgressView({ stateDir, keys: () => [key] }).materialize({ now, instances: [] });
      const entries = new Map<string, ViewBodyEntry>();
      for (const item of built) {
        const rendered = renderView({ name: DAILY_PROGRESS_VIEW_NAME, version: 1, compute: () => item }, clock);
        assert.ok(!("error" in rendered)); if ("error" in rendered) continue;
        entries.set(item.key, { view: DAILY_PROGRESS_VIEW_NAME, key: item.key, version: 1, generation: 1, ...rendered });
      }
      const reads: string[] = [];
      const source: ViewBodySource = { switches: () => ({ views: { [DAILY_PROGRESS_VIEW_NAME]: "serve" } }), body(_view, requestKey = "") { reads.push(requestKey); return entries.get(requestKey); },
        judge: (sources, at) => sources.map(s => judgeSource(s, at)) };
      let requestNow = now;
      const routeClock = { now: () => requestNow, iso: () => fixedClock(requestNow).iso(), date: () => fixedClock(requestNow).date() };
      const routes = buildReadModelViewRoutes({ legacy: [], readModelViews: [DAILY_PROGRESS_VIEW_NAME], readModel: source,
        requestValidators: { [DAILY_PROGRESS_VIEW_NAME]: (query, model) => validateDailyProgressRequest(query, model, routeClock.now()) }, clock: routeClock });
      const route = routes[0]!; assert.equal(route.scope, "read");
      const request = (query: string, headers: Record<string, string> = {}) => {
        let status = 0, body = "";
        route.handler({ url: `/v1/views/daily-progress?${query}`, headers } as Parameters<typeof route.handler>[0], {
          writeHead(code: number) { status = code; }, end(value: string) { body = value; }, once() {},
        } as unknown as Parameters<typeof route.handler>[1], { params: {} });
        return { status, body };
      };
      assert.equal(request("repository=acme%2Fa&date=today").status, 200, "positive control reaches the actual cached route");
      const conditional = { "if-none-match": entries.get(key)!.etag };
      assert.equal(request("repository=acme%2Fa&date=today", conditional).status, 304, "the held body conditional-read path is reached");
      const foreign = request("repository=evil%2Fhidden&date=today"); assert.equal(foreign.status, 400); assert.ok(!foreign.body.includes("totals"));
      assert.equal(request("repository=evil%2Fhidden&date=today", conditional).status, 400, "scope is checked before a held body or ETag can answer");
      assert.equal(request("repository=acme%2Fa&date=today&url=https://evil.example").status, 400);
      assert.equal(request("repository=acme%2Fa&repository=evil%2Fhidden&date=today").status, 400);
      requestNow = Date.parse("2026-11-02T05:00:00Z");
      assert.equal(request("repository=acme%2Fa&date=yesterday").status, 200, "at midnight the retained Today report becomes Yesterday independently of closing collection");
      assert.equal(request("repository=acme%2Fa&date=today").status, 503, "midnight resolves the new date before an old cached body can answer");
      assert.equal(request("repository=acme%2Fa&date=today", conditional).status, 503, "an old-day ETag cannot answer for the new Today");
      assert.ok(reads.some(read => read.includes("2026-11-02")), "the new civil date is actually queried");
    } finally { db.close(); }
  });
});

test("daily source freshness does not move forward just because another retry is scheduled", async () => {
  await withTempDir("daily-source-age", async stateDir => {
    createRepositoriesSourcePublisher({ stateDir, instances: () => [{ instanceId: "core", options: { root: stateDir, instanceRepository: { owner: "acme", repo: "a" } } }] })();
    const db = openReadModel({ stateDir, instance: "proof", schemaVersion: 1 });
    try {
      const lease = acquireLease(db); assert.ok(lease.ok); if (!lease.ok) return;
      const saved = record("acme/a", 1, "2026-11-02T05:55:00.000Z"); saved.phase = "finalizing";
      saved.totals.mergedChanges.precision = saved.totals.completedTasks.precision = "at_least";
      const source = saved.coverage.sources[0]!;
      Object.assign(source, { state: "partial", lastAttemptAt: "2026-11-02T04:50:00.000Z", lastSuccessAt: "2026-11-02T04:50:00.000Z",
        coverageThrough: "2026-11-02T04:50:00.000Z", nextDueAt: "2026-11-02T07:00:00.000Z", reason: "The saved source does not cover the report cutoff." });
      prepareDailyProgressPublication(stateDir, [saved], []).commit(db, lease.lease);
      const read = () => readDailyProgressReport({ stateDir, params: new URLSearchParams({ repository: "acme/a", date: "2026-11-01" }), now: Date.parse("2026-11-02T06:00:00Z") });
      assert.equal(read().sources[0]!.state, "stale", "a future retry cannot extend an old successful reading's freshness");
      assert.deepEqual(read().data.totals.mergedChanges, { value: 1, precision: "at_least" }, "the last good evidence stays visible");
      Object.assign(source, { lastAttemptAt: "2026-11-02T05:45:00.000Z", lastSuccessAt: "2026-11-02T05:45:00.000Z", coverageThrough: saved.windowEnd });
      prepareDailyProgressPublication(stateDir, [saved], []).commit(db, lease.lease);
      assert.equal(read().sources[0]!.state, "fresh", "a genuinely newer source receipt is the positive control");
    } finally { db.close(); }
  });
});
