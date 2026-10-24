import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { dailyDateAt, dailyWindow, nextDailyDue, resolveDailyDate, shiftDailyDate } from "#src/lib/daily-progress-calendar.js";
import { dailyProgressDayKey, dailyProgressStorePath, prepareDailyProgressPublication, readDailyProgressManifest, readDailyProgressRevision, type DailyProgressRecord } from "#src/lib/daily-progress-store.js";
import { acquireLease, openReadModel } from "#src/lib/read-model-db.js";
import { withTempDir } from "#src/lib/tmp.js";

function record(size = 205): DailyProgressRecord {
  const window = dailyWindow("2026-11-01");
  const at = "2026-11-02T06:00:00.000Z";
  return { version: "daily-progress-v1", scope: { kind: "repository", repository: "acme/app" }, ...window,
    generatedAt: at, phase: "complete", coverage: { state: "partial", expectedRepositories: ["acme/app"], includedRepositories: ["acme/app"], sources: [{
      id: "acme/app:prs", repository: "acme/app", kind: "pull_requests", required: true, state: "complete", lastAttemptAt: at, lastSuccessAt: at,
      coverageStart: window.windowStart, coverageThrough: window.windowEnd, nextDueAt: "2026-11-02T07:00:00.000Z", reason: null,
    }, { id: "acme/app:deployments", repository: "acme/app", kind: "deployments", required: false, state: "not_collected", lastAttemptAt: null,
      lastSuccessAt: null, coverageStart: null, coverageThrough: null, nextDueAt: null, reason: "Deployment evidence is not collected." }] },
    totals: { mergedChanges: { value: size, precision: "exact" }, completedTasks: { value: size, precision: "exact" } }, currentWork: null,
    events: Array.from({ length: size }, (_, i) => ({ id: `acme/app:pr:${i + 1}`, repository: "acme/app", kind: "merged", sourceId: "acme/app:prs",
      occurredAt: "2026-11-01T15:00:00.000Z", observedAt: at, fleetAttribution: "confirmed", taskIds: [`W1-T${i + 1}`], title: `Repair ${i + 1}`, url: `https://github.com/acme/app/pull/${i + 1}` })),
  };
}

test("daily progress uses calendar days across DST and midnight", () => {
  const spring = dailyWindow("2026-03-08"), fall = dailyWindow("2026-11-01");
  assert.equal(Date.parse(spring.windowEnd) - Date.parse(spring.windowStart), 23 * 3_600_000);
  assert.equal(Date.parse(fall.windowEnd) - Date.parse(fall.windowStart), 25 * 3_600_000);
  assert.equal(fall.windowStart, "2026-11-01T04:00:00.000Z");
  assert.equal(fall.windowEnd, "2026-11-02T05:00:00.000Z");
  const midnight = Date.parse(fall.windowEnd);
  assert.equal(resolveDailyDate("today", midnight - 1), "2026-11-01");
  assert.equal(resolveDailyDate("today", midnight), "2026-11-02");
  assert.equal(resolveDailyDate("yesterday", midnight), "2026-11-01");
  assert.equal(shiftDailyDate("2027-01-01", -1), "2026-12-31");
  assert.equal(dailyDateAt(Date.parse("2027-01-01T01:00:00Z")), "2026-12-31");
  assert.equal(nextDailyDue(Date.parse("2026-11-01T04:25:00Z")), Date.parse("2026-11-01T05:00:00Z"));
  assert.equal(nextDailyDue(Date.parse("2026-11-01T05:25:00Z")), Date.parse("2026-11-01T06:00:00Z"));
  for (const date of ["2026-02-30", "../history", "2026-1-01"]) assert.throws(() => dailyWindow(date), RangeError);
  assert.throws(() => dailyWindow("2026-11-01", "Not/A_Zone"), RangeError);
});

test("daily progress retains complete history and immutable late corrections", async () => {
  await withTempDir("daily-progress-history", async root => {
    const db = openReadModel({ stateDir: root, instance: "proof", schemaVersion: 1 });
    try {
      const clock = fixedClock(Date.parse("2026-11-02T06:00:00Z")), got = acquireLease(db, { holder: "first", clock });
      assert.ok(got.ok); if (!got.ok) return;
      const input = record(), key = dailyProgressDayKey("acme/app", input.timeZone, input.reportDate);
      prepareDailyProgressPublication(root, [input], []).commit(db, got.lease);
      let manifest = readDailyProgressManifest(root);
      const originalHash = manifest.days[key]!.revisions[0]!;
      const first = readDailyProgressRevision(root, manifest.days[key]!);
      assert.equal(first.events.length, 205);
      assert.equal(first.report.totals.mergedChanges.value, 205);
      assert.equal(first.report.totals.completedTasks.value, 205);
      // A new store reader after a scratch-only rebuild still reads canonical history.
      const scratch = join(root, "scratch"); mkdirSync(scratch);
      writeFileSync(join(scratch, "unrelated-cache"), "rebuilt");
      assert.equal(readDailyProgressRevision(root, readDailyProgressManifest(root).days[key]!).events.length, 205);
      const late = record(206); late.generatedAt = "2026-11-02T07:00:00.000Z";
      for (const source of late.coverage.sources) if (source.required) source.lastAttemptAt = source.lastSuccessAt = late.generatedAt;
      for (const event of late.events) event.observedAt = late.generatedAt;
      prepareDailyProgressPublication(root, [late], []).commit(db, got.lease);
      manifest = readDailyProgressManifest(root);
      assert.equal(manifest.days[key]!.revisions.length, 2);
      const corrected = readDailyProgressRevision(root, manifest.days[key]!);
      assert.equal(corrected.events.length, 206);
      assert.equal(corrected.report.phase, "corrected");
      assert.equal(corrected.events.find(e => e.id === input.events[0]!.id)!.observedAt, input.events[0]!.observedAt);
      assert.equal(readDailyProgressRevision(root, manifest.days[key]!, 1).events.length, 205);
      assert.equal(manifest.days[key]!.revisions[0], originalHash);
      prepareDailyProgressPublication(root, [late], []).commit(db, got.lease);
      assert.equal(readDailyProgressManifest(root).days[key]!.revisions.length, 2, "an identical retry creates no new evidence revision");
      const superseded = prepareDailyProgressPublication(root, [], []);
      prepareDailyProgressPublication(root, [], []).commit(db, got.lease);
      assert.throws(() => superseded.commit(db, got.lease), /superseded/);
      const stale = prepareDailyProgressPublication(root, [], []);
      const second = acquireLease(db, { holder: "successor", clock: fixedClock(clock.now() + 60_000) }); assert.ok(second.ok);
      assert.throws(() => stale.commit(db, got.lease), /lease_lost/);
      if (second.ok) assert.throws(() => prepareDailyProgressPublication(root, [], []).commit(db, second.lease, () => false), /ownership epoch/);
      assert.equal(readDailyProgressRevision(root, readDailyProgressManifest(root).days[key]!).events.length, 206);
    } finally { db.close(); }
  });
});

test("daily history refuses real filesystem failures and preserves corrupt evidence", async () => {
  await withTempDir("daily-progress-failure", async root => {
    const db = openReadModel({ stateDir: root, instance: "proof", schemaVersion: 1 });
    try {
      const got = acquireLease(db); assert.ok(got.ok); if (!got.ok) return;
      prepareDailyProgressPublication(root, [record(1)], []).commit(db, got.lease);
      const store = dailyProgressStorePath(root), manifest = join(store, "manifest.json"), preserved = readFileSync(manifest, "utf8");
      const staged = prepareDailyProgressPublication(root, [], []);
      renameSync(manifest, join(store, "preserved-manifest.json")); mkdirSync(manifest);
      assert.throws(() => staged.commit(db, got.lease), /regular file|directory|EISDIR/);
      assert.equal(readFileSync(join(store, "preserved-manifest.json"), "utf8"), preserved);
      assert.ok(readdirSync(store).includes("manifest.json"));
    } finally { db.close(); }
  });
});
