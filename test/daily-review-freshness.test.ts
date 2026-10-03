import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRoutingDailyStatus } from "../src/lib/routing-daily-status.js";
import { fixedClock } from "../src/lib/clock.js";
import { writeLedger } from "./helpers/ledger-fixture.js";
import { buildAnalyticsRoute, deriveAnalyticsSnapshot } from "../src/lib/analytics-route.js";
const asOf = "2026-10-02T12:00:00Z";
const now = fixedClock(Date.parse("2026-10-02T14:00:00Z"));
const report = () => ({ version: "routing-daily-review-v1", asOf, nextScheduledReviewAt: "2026-10-03T04:17:00Z",
  state: "observed-partial", sources: [{ label: "core", state: "observed-partial", reasons: ["ledger-source-malformed"],
    futureRows: 5, malformedRows: 2, findings: [{ path: "/private/ledger", raw: "secret" }],
    reports: [{ id: "sol61-vs-sonnet55", reviewState: "source-incomplete", nextAction: "repair-source-evidence", assignments: 3,
      minTasksPerArm: 20, crossoverTasks: 1, arms: [{ arm: "sol61", tasks: 1, merged: 0, costMissingAssignments: 1 }] }] }] });
function fixture() {
  const f = writeLedger([]), dir = join(f.dir, "field-trials/routing-daily");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "latest.json");
  const put = (value: unknown) => writeFileSync(path, JSON.stringify(value));
  return { ...f, path, put, close: () => rmSync(f.dir, { recursive: true, force: true }) };
}
test("daily review freshness is independent of source completeness and exposes no raw receipts", () => {
  const f = fixture();
  try {
    f.put(report());
    const result = readRoutingDailyStatus(f.dir, now);
    assert.equal(result.state, "fresh");
    assert.deepEqual(result.alerts, ["daily-review-source-incomplete"]);
    assert.equal(result.sources[0]!.reports[0]!.assignments, 3);
    assert.equal(result.comparativeClaims, "none");
    assert.doesNotMatch(JSON.stringify(result), /secret|\/private\/ledger/);
    const overdue = readRoutingDailyStatus(f.dir, fixedClock(Date.parse("2026-10-03T07:00:00Z")));
    assert.equal(overdue.state, "stale");
    assert.ok(overdue.alerts.includes("daily-review-overdue"));
  } finally { f.close(); }
});
test("missing, malformed, oversized and future daily reviews stay explicitly unavailable", () => {
  const f = fixture();
  try {
    assert.deepEqual(readRoutingDailyStatus(undefined).alerts, ["daily-review-not-configured"]);
    assert.deepEqual(readRoutingDailyStatus(f.dir).alerts, ["daily-review-missing"]);
    writeFileSync(f.path, "broken"); assert.deepEqual(readRoutingDailyStatus(f.dir).alerts, ["daily-review-json-invalid"]);
    f.put({}); assert.deepEqual(readRoutingDailyStatus(f.dir).alerts, ["daily-review-metadata-invalid"]);
    f.put({ ...report(), sources: [null] }); assert.equal(readRoutingDailyStatus(f.dir).state, "unavailable");
    f.put({ ...report(), asOf: "2026-10-03T12:00:00Z", nextScheduledReviewAt: "2026-10-04T04:17:00Z" });
    assert.deepEqual(readRoutingDailyStatus(f.dir, now).alerts, ["daily-review-timestamp-future"]);
    writeFileSync(f.path, "x".repeat(256 * 1024 + 1)); assert.deepEqual(readRoutingDailyStatus(f.dir).alerts, ["daily-review-size-or-type-invalid"]);
    rmSync(f.path); mkdirSync(f.path); assert.equal(readRoutingDailyStatus(f.dir).state, "unavailable");
  } finally { f.close(); }
});

test("daily status distinguishes measured invalid timestamps from an unmeasured legacy count", () => {
  const f = fixture();
  try {
    f.put(report());
    assert.equal(readRoutingDailyStatus(f.dir, now).sources[0]!.invalidTimestampRows, undefined);
    const next = report();
    f.put({ ...next, sources: next.sources.map((source) => ({ ...source, invalidTimestampRows: 3 })) });
    const result = readRoutingDailyStatus(f.dir, now);
    assert.equal(result.sources[0]!.invalidTimestampRows, 3);
    assert.equal(result.sources[0]!.futureRows, 5);
    assert.equal(result.reviewState, "observed-partial");
    assert.doesNotMatch(JSON.stringify(result), /secret|\/private\/ledger/);
  } finally { f.close(); }
});
test("analytics serves bounded daily freshness through the configured state directory", async () => {
  const f = fixture();
  try {
    f.put(report());
    const route = buildAnalyticsRoute({ currentSnapshot: () => deriveAnalyticsSnapshot([], asOf), dailyReviewStateDir: f.dir, clock: now });
    let body = "";
    await route.handler({ url: "/v1/analytics?projectionVersion=routing-daily-v1" } as never,
      { writeHead: () => {}, end: (value: string) => { body = value; } } as never, { params: {} });
    assert.equal(JSON.parse(body).state, "fresh");
    assert.equal(JSON.parse(body).sources.length, 1);
  } finally { f.close(); }
});


test("daily review refuses symlink replacement of its private report", () => {
  const f = fixture();
  try {
    const alternate = f.path + ".alternate";
    writeFileSync(alternate, JSON.stringify(report()));
    symlinkSync(alternate, f.path);
    const result = readRoutingDailyStatus(f.dir, now);
    assert.equal(result.state, "unavailable");
    assert.deepEqual(result.alerts, ["daily-review-unreadable"]);
  } finally { f.close(); }
});
