import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { dailyDateAt, dailyWindow, nextDailyDue, resolveDailyDate, shiftDailyDate } from "#src/lib/daily-progress-calendar.js";
import { dailyProgressDayKey, dailyProgressStorePath, prepareDailyProgressPublication, readDailyProgressManifest, readDailyProgressRevision, type DailyProgressRecord } from "#src/lib/daily-progress-store.js";
import { acquireLease, openReadModel } from "#src/lib/read-model-db.js";
import { withTempDir } from "#src/lib/tmp.js";
import { boardClosedCollectionPath, boardClosedRowsDigest, createBoardSnapshotCache, readBoardClosedCollectionReceipt } from "#src/lib/board-snapshot-cache.js";
import { buildBatchedGithub } from "#src/lib/status.js";

function record(size = 205): DailyProgressRecord {
  const window = dailyWindow("2026-11-01");
  const at = "2026-11-02T06:00:00.000Z";
  return { version: "daily-progress-v1", scope: { kind: "repository", repository: "acme/app" }, ...window,
    generatedAt: at, phase: "complete", coverage: { state: "partial", expectedRepositories: ["acme/app"], includedRepositories: ["acme/app"], expectedSources: [
      { id: "acme/app:prs", repository: "acme/app", kind: "pull_requests", instanceId: null, required: true },
      { id: "acme/app:ledger", repository: "acme/app", kind: "ledger_activity", instanceId: null, required: false },
      { id: "acme/app:deployments", repository: "acme/app", kind: "deployments", instanceId: null, required: false }], sources: [{
      id: "acme/app:prs", repository: "acme/app", kind: "pull_requests", instanceId: null, required: true, state: "complete", lastAttemptAt: at, lastSuccessAt: at,
      coverageStart: window.windowStart, coverageThrough: window.windowEnd, nextDueAt: "2026-11-02T07:00:00.000Z", reason: null,
    }, { id: "acme/app:ledger", repository: "acme/app", kind: "ledger_activity", instanceId: null, required: false, state: "not_collected", lastAttemptAt: null,
      lastSuccessAt: null, coverageStart: null, coverageThrough: null, nextDueAt: null, reason: "Activity evidence is not collected." },
    { id: "acme/app:deployments", repository: "acme/app", kind: "deployments", instanceId: null, required: false, state: "not_collected", lastAttemptAt: null,
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
  const repeatedMidnight = dailyWindow("2026-11-01", "America/Havana");
  assert.equal(repeatedMidnight.windowStart, "2026-11-01T04:00:00.000Z", "a repeated midnight starts at its first occurrence");
  assert.equal(dailyWindow("2010-11-07", "America/St_Johns").windowStart, "2010-11-07T02:30:00.000Z", "a short first occurrence is not lost when local dates briefly go backwards");
  const skippedMidnight = dailyWindow("2018-11-04", "America/Sao_Paulo");
  assert.equal(skippedMidnight.windowStart, "2018-11-04T03:00:00.000Z", "a civil day begins at its first actual instant even when 00:00 was skipped");
  assert.equal(skippedMidnight.windowEnd, "2018-11-05T02:00:00.000Z");
  assert.throws(() => dailyWindow("2011-12-30", "Pacific/Apia"), RangeError, "a skipped civil date cannot become an invented report day");
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
    let db = openReadModel({ stateDir: root, instance: "proof", schemaVersion: 1 });
    try {
      const clock = fixedClock(Date.parse("2026-11-02T06:00:00Z")), got = acquireLease(db, { holder: "first", clock });
      assert.ok(got.ok); if (!got.ok) return;
      const input = record(), key = dailyProgressDayKey("acme/app", input.timeZone, input.reportDate);
      const prepared = prepareDailyProgressPublication(root, [input], []);
      assert.ok("publication" in prepared, "the slow lane must stage a serializable publication for the owning projector");
      assert.doesNotThrow(() => structuredClone(prepared.publication));
      prepared.commit(db, got.lease);
      let manifest = readDailyProgressManifest(root);
      const originalHash = manifest.days[key]!.revisions[0]!;
      const first = readDailyProgressRevision(root, manifest.days[key]!);
      assert.equal(first.events.length, 205);
      assert.equal(first.report.totals.mergedChanges.value, 205);
      assert.equal(first.report.totals.completedTasks.value, 205);
      db.close(); db = openReadModel({ stateDir: root, instance: "proof", schemaVersion: 1 });
      // A new store reader after a scratch-only rebuild still reads canonical history.
      const scratch = join(root, "scratch"); mkdirSync(scratch);
      writeFileSync(join(scratch, "unrelated-cache"), "rebuilt");
      const mapping = process.env.RMD_READ_MODEL_DB_DIR;
      try {
        process.env.RMD_READ_MODEL_DB_DIR = `${root}:${scratch}`;
        assert.equal(readDailyProgressRevision(root, readDailyProgressManifest(root).days[key]!).events.length, 205);
      } finally {
        if (mapping === undefined) delete process.env.RMD_READ_MODEL_DB_DIR;
        else process.env.RMD_READ_MODEL_DB_DIR = mapping;
      }
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
      const rechecked = structuredClone(late); rechecked.generatedAt = "2026-11-02T08:00:00.000Z";
      for (const source of rechecked.coverage.sources) if (source.required) {
        source.lastAttemptAt = source.lastSuccessAt = rechecked.generatedAt; source.nextDueAt = "2026-11-02T09:00:00.000Z";
      }
      for (const event of rechecked.events) event.observedAt = rechecked.generatedAt;
      prepareDailyProgressPublication(root, [rechecked], []).commit(db, got.lease);
      assert.equal(readDailyProgressManifest(root).days[key]!.revisions.length, 2, "rechecking an already closed day without new evidence is not a correction");
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

test("daily progress treats the first closing pass as completion rather than a late correction", async () => {
  await withTempDir("daily-first-closing", async root => {
    const db = openReadModel({ stateDir: root, instance: "proof", schemaVersion: 1 });
    try {
      const got = acquireLease(db); assert.ok(got.ok); if (!got.ok) return;
      const provisional = record(1); provisional.generatedAt = "2026-11-02T04:59:00.000Z"; provisional.phase = "provisional";
      provisional.events[0]!.observedAt = provisional.generatedAt;
      for (const source of provisional.coverage.sources) if (source.required) {
        source.lastAttemptAt = source.lastSuccessAt = source.coverageThrough = provisional.generatedAt;
      }
      prepareDailyProgressPublication(root, [provisional], []).commit(db, got.lease);
      const closed = record(1); prepareDailyProgressPublication(root, [closed], []).commit(db, got.lease);
      const key = dailyProgressDayKey("acme/app", closed.timeZone, closed.reportDate);
      const report = readDailyProgressRevision(root, readDailyProgressManifest(root).days[key]!).report;
      assert.equal(report.phase, "complete"); assert.equal(report.correctionReason, null);
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
      renameSync(manifest, join(store, "preserved-manifest.json"));
      assert.throws(() => readDailyProgressManifest(root), /manifest is missing beside retained evidence/);
      mkdirSync(manifest);
      assert.throws(() => staged.commit(db, got.lease), /regular file|directory|EISDIR/);
      assert.equal(readFileSync(join(store, "preserved-manifest.json"), "utf8"), preserved);
      assert.ok(readdirSync(store).includes("manifest.json"));
    } finally { db.close(); }
  });
});

test("daily first publication can abandon staged evidence without blocking its successor", async () => {
  await withTempDir("daily-abandoned-stage", async root => {
    const db = openReadModel({ stateDir: root, instance: "proof", schemaVersion: 1 });
    try {
      const abandoned = prepareDailyProgressPublication(root, [record(205)], []);
      assert.equal(readDailyProgressManifest(root).generation, 0, "staging alone has never published a report");
      const got = acquireLease(db); assert.ok(got.ok); if (!got.ok) return;
      const successor = prepareDailyProgressPublication(root, [record(1)], []); successor.commit(db, got.lease);
      const key = dailyProgressDayKey("acme/app", "America/New_York", "2026-11-01");
      assert.equal(readDailyProgressRevision(root, readDailyProgressManifest(root).days[key]!).events.length, 1, "unpublished predecessor evidence cannot enter the successor report");
      assert.ok(readdirSync(dailyProgressStorePath(root)).includes(abandoned.manifest.days[key]!.revisions[0]! + ".json"), "orphaned evidence remains available for diagnosis");
    } finally { db.close(); }
  });
});

test("daily publication serializes independent projector databases and releases refused writers", async () => {
  await withTempDir("daily-publication-serialization", async root => {
    const first = openReadModel({ stateDir: root, instance: "first-generation", schemaVersion: 1 });
    const second = openReadModel({ stateDir: root, instance: "second-generation", schemaVersion: 1 });
    try {
      const a = acquireLease(first), b = acquireLease(second); assert.ok(a.ok && b.ok); if (!a.ok || !b.ok) return;
      const earlier = prepareDailyProgressPublication(root, [record(1)], []), overlapping = prepareDailyProgressPublication(root, [record(2)], []);
      earlier.commit(first, a.lease, () => {
        assert.throws(() => overlapping.commit(second, b.lease), /locked|busy/i, "a second valid database lease cannot overlap the durable manifest publication");
        return true;
      });
      assert.throws(() => overlapping.commit(second, b.lease), /superseded/, "after the first writer releases, the generation check still refuses stale content");
      const retry = prepareDailyProgressPublication(root, [record(2)], []); retry.commit(second, b.lease);
      const key = dailyProgressDayKey("acme/app", "America/New_York", "2026-11-01");
      const report = readDailyProgressRevision(root, readDailyProgressManifest(root).days[key]!);
      assert.equal(report.events.length, 2); assert.equal(report.report.revision, 2, "a refused writer releases the lock for a fresh publication");
    } finally { first.close(); second.close(); }
  });
});

test("daily PR source records complete truncated and failed attempts separately from saved rows", async () => {
  await withTempDir("daily-source-receipts", async root => {
    const cache = createBoardSnapshotCache(root, "acme", "app", { clock: fixedClock(Date.parse("2026-11-02T06:00:00Z")) });
    assert.ok(cache.recordClosedAttempt, "the production snapshot cache must expose collection receipts");
    const rows = [{ number: 1, url: "https://github.com/acme/app/pull/1", state: "MERGED", headRefName: "run-W1-T1-1234567890123", headRefOid: "a".repeat(40),
      body: "Remudero-Task: W1-T1", autoMergeRequest: null, title: "Repair", updatedAt: "2026-11-02T05:00:00.000Z", mergedAt: "2026-11-01T15:00:00.000Z" }];
    cache.recordClosedAttempt({ ok: true, persisted: cache.commitClosed(rows) });
    let read = readBoardClosedCollectionReceipt(root, "acme", "app", rows); assert.ok(read.ok); if (!read.ok) return;
    assert.equal(read.receipt.state, "complete"); assert.equal(read.receipt.rowsDigest, boardClosedRowsDigest(rows));
    const success = read.receipt.lastSuccessAt;
    cache.recordClosedAttempt({ ok: true, truncated: true });
    read = readBoardClosedCollectionReceipt(root, "acme", "app", rows); assert.ok(read.ok); if (!read.ok) return;
    assert.equal(read.receipt.state, "partial"); assert.equal(read.receipt.reason, "truncated"); assert.equal(read.receipt.lastSuccessAt, success);
    cache.recordClosedAttempt({ ok: false });
    read = readBoardClosedCollectionReceipt(root, "acme", "app", rows); assert.ok(read.ok); if (!read.ok) return;
    assert.equal(read.receipt.state, "unavailable"); assert.equal(read.receipt.lastSuccessAt, success);
    assert.equal(readBoardClosedCollectionReceipt(root, "acme", "app", []).ok, false, "a receipt cannot certify another corpus");
  });
});

test("daily collection receipts are reached by the normal synchronous PR gateway", async () => {
  await withTempDir("daily-gateway-receipts", async root => {
    let now = Date.parse("2026-11-02T06:00:00Z"), failed = false;
    const clock = { now: () => now, iso: () => fixedClock(now).iso(), date: () => fixedClock(now).date() };
    const cache = createBoardSnapshotCache(root, "acme", "app", { clock });
    const gateway = buildBatchedGithub("acme", "app", { snapshotCache: cache, now: clock.now, ttlMs: 0, mergedTtlMs: 0,
      commitTrailerIndex: () => new Map(), exec(args) {
        if (failed) throw Object.assign(new Error("offline fixture"), { code: "ENETUNREACH" });
        if (args.some(arg => arg.includes("state=open"))) return "[]";
        return JSON.stringify([{ number: 7, html_url: "https://github.com/acme/app/pull/7", state: "closed", title: "Repair", body: "Remudero-Task: W1-T7",
          head: { ref: "run-W1-T7-1234567890123", sha: "a".repeat(40) }, updated_at: "2026-11-02T05:00:00Z", merged_at: "2026-11-01T15:00:00Z", auto_merge: null }]);
      } });
    assert.equal(gateway.listMergedHeadBranches!()!.length, 1, "positive control sees the authoritative merge");
    const rows = cache.closedSeed(); assert.ok(rows);
    let read = readBoardClosedCollectionReceipt(root, "acme", "app", rows.values()); assert.ok(read.ok);
    if (read.ok) assert.equal(read.receipt.state, "complete");
    now += 60_000; failed = true;
    assert.equal(gateway.listMergedHeadBranches!(), null);
    read = readBoardClosedCollectionReceipt(root, "acme", "app", rows.values()); assert.ok(read.ok);
    if (read.ok) { assert.equal(read.receipt.state, "unavailable"); assert.equal(read.receipt.lastAttemptAt, clock.iso()); assert.notEqual(read.receipt.lastSuccessAt, clock.iso()); }
  });
});

test("daily source receipt IO failures stay unavailable and preserve source data", async () => {
  await withTempDir("daily-source-io", async root => {
    const missing = readBoardClosedCollectionReceipt(root, "acme", "app", []);
    assert.equal(missing.ok, false); if (!missing.ok) assert.match(missing.reason, /unavailable/);
    const logs: string[] = [];
    const cache = createBoardSnapshotCache(root, "acme", "app", { log: step => logs.push(step) });
    assert.equal(cache.commitClosed([]), true);
    const path = boardClosedCollectionPath(root, "acme", "app"); mkdirSync(path);
    cache.recordClosedAttempt!({ ok: true, persisted: true });
    assert.ok(logs.includes("board_snapshot.collection_receipt_failed"));
    assert.equal(cache.closedSeed()!.size, 0, "a failed receipt write does not replace the known empty corpus");
    assert.equal(readBoardClosedCollectionReceipt(root, "acme", "app", []).ok, false);
  });
});

test("daily source receipts follow the real background PR collector on success and transport failure", { timeout: 30_000 }, async () => {
  await withTempDir("daily-background-receipts", async root => {
    let now = Date.parse("2026-11-02T06:00:00Z");
    const clock = { now: () => now, iso: () => fixedClock(now).iso(), date: () => fixedClock(now).date() };
    const ghBin = join(root, "fixture-gh"), failed = join(root, "offline");
    const merged = [{ number: 7, html_url: "https://github.com/acme/app/pull/7", state: "closed", title: "Repair", body: "Remudero-Task: W1-T7",
      head: { ref: "run-W1-T7-1234567890123", sha: "a".repeat(40) }, updated_at: "2026-11-02T05:00:00Z", merged_at: "2026-11-01T15:00:00Z", auto_merge: null }];
    writeFileSync(ghBin, `#!${process.execPath}\nconst fs = require("node:fs");\nif (fs.existsSync(${JSON.stringify(failed)})) { process.stderr.write("offline fixture"); process.exit(1); }\nprocess.stdout.write(process.argv.some(a => a.includes("state=closed")) ? ${JSON.stringify(JSON.stringify(merged))} : "[]");\n`);
    chmodSync(ghBin, 0o700);
    const cache = createBoardSnapshotCache(root, "acme", "app", { clock });
    const gateway = buildBatchedGithub("acme", "app", { ghBin, snapshotCache: cache, now: clock.now, ttlMs: 0, mergedTtlMs: 0, offLoop: true });
    const warm = async () => {
      gateway.warm!();
      // BACKSTOP: fail the fixture if the real worker does not settle; never start a second collector.
      for (let attempt = 0; gateway.readState?.() === "in_flight" && attempt < 1000; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.notEqual(gateway.readState?.(), "in_flight");
    };
    await warm();
    const rows = cache.closedSeed(); assert.ok(rows); assert.deepEqual([...rows.keys()], [7]);
    let receipt = readBoardClosedCollectionReceipt(root, "acme", "app", rows.values()); assert.ok(receipt.ok);
    if (receipt.ok) assert.equal(receipt.receipt.state, "complete");
    now += 60_000; writeFileSync(failed, "offline"); await warm();
    receipt = readBoardClosedCollectionReceipt(root, "acme", "app", rows.values()); assert.ok(receipt.ok);
    if (receipt.ok) {
      assert.equal(receipt.receipt.state, "unavailable"); assert.equal(receipt.receipt.lastAttemptAt, clock.iso());
      assert.equal(receipt.receipt.lastSuccessAt, "2026-11-02T06:00:00.000Z");
    }
    assert.deepEqual([...cache.closedSeed()!.keys()], [7], "a failed background refresh preserves the merged evidence");
  });
});
