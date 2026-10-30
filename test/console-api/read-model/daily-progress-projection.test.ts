import assert from "node:assert/strict";
import { chmodSync, createWriteStream, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gzipSync } from "node:zlib";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { dailyDateAt, dailyWindow, nextDailyDue, resolveDailyDate, shiftDailyDate } from "#src/lib/daily-progress-calendar.js";
import { dailyProgressDayKey, dailyProgressStorePath, prepareDailyProgressPublication, readDailyProgressManifest, readDailyProgressRevision, type DailyProgressRecord } from "#src/lib/daily-progress-store.js";
import { acquireLease, openReadModel } from "#src/lib/read-model-db.js";
import { withTempDir } from "#src/lib/tmp.js";
import { boardClosedCollectionPath, boardClosedRowsDigest, createBoardSnapshotCache, readBoardClosedCollectionReceipt } from "#src/lib/board-snapshot-cache.js";
import { buildBatchedGithub } from "#src/lib/status.js";
import { collectDailyProgress, type DailyProgressCollectionConfig } from "#src/lib/daily-progress-collector.js";
import { improvementEffectNamespaceDir } from "#src/lib/gardener-opportunity-evidence.js";
import { admitStaticWork, readMemoryHeadroom, readVmStat, resolveTestSlotDir, TEST_SLOT_DIR_ENV, type StaticAdmission } from "#src/lib/test-slot.js";
import { SLOW_LANE_HEAP_MB } from "#src/lib/read-model-slow-lane.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

function record(size = 205): DailyProgressRecord {
  const window = dailyWindow("2026-11-01");
  const at = "2026-11-02T06:00:00.000Z";
  return { version: "daily-progress-v1", scope: { kind: "repository", repository: "acme/app" }, ...window,
    generatedAt: at, phase: "complete", coverage: { state: "partial", expectedRepositories: ["acme/app"], includedRepositories: ["acme/app"], expectedSources: [
      { id: "acme/app:prs", repository: "acme/app", kind: "pull_requests", instanceId: null, required: true },
      { id: "acme/app:ledger", repository: "acme/app", kind: "ledger_activity", instanceId: null, required: false },
      { id: "acme/app:deployments", repository: "acme/app", kind: "deployments", instanceId: null, required: false }], sources: [{
      id: "acme/app:prs", repository: "acme/app", kind: "pull_requests", instanceId: null, required: true, state: "complete", lastAttemptAt: at, lastSuccessAt: at,
      coverageStart: window.windowStart, coverageThrough: window.windowEnd, nextDueAt: fixedClock(nextDailyDue(Date.parse(at))).iso(), reason: null,
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


test("daily retained history refuses a named pipe without blocking its reader", async () => {
  const { spawnSync } = await import("node:child_process"), { pathToFileURL } = await import("node:url");
  const { repoRoot } = await import("#test/helpers/repo-root.js");
  await withTempDir("daily-history-pipe", async root => {
    const path = join(dailyProgressStorePath(root), "manifest.json"); mkdirSync(dailyProgressStorePath(root), { recursive: true });
    const fifo = spawnSync("mkfifo", [path], { encoding: "utf8" }); assert.equal(fifo.status, 0, fifo.stderr);
    const moduleUrl = pathToFileURL(join(repoRoot(), "src", "lib", "daily-progress-store.ts")).href;
    const code = `import { readDailyProgressManifest } from ${JSON.stringify(moduleUrl)}; try { readDailyProgressManifest(process.argv[1]); process.exitCode = 2; } catch (error) { if (!String(error).includes("bounded regular file")) throw error; }`;
    // BACKSTOP: a corrupt retained source must not stall the admitted test runner.
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code, root], { encoding: "utf8", timeout: 5000 });
    assert.equal(child.error, undefined, "opening retained evidence must refuse before waiting for a pipe writer");
    assert.equal(child.status, 0, child.stderr);
  });
});

const activityClock = fixedClock(Date.parse("2026-11-02T06:00:00Z"));
const activityAt = "2026-11-01T15:00:00.000Z";
const capRefusal = /Daily activity exceeds the bounded collection population; retained history is unchanged[.]/;

function activityFixture(root: string): DailyProgressCollectionConfig {
  const stateDir = join(root, "state"); mkdirSync(stateDir, { recursive: true });
  const cache = createBoardSnapshotCache(root, "acme", "app", { clock: activityClock });
  const rows = Array.from({ length: 3 }, (_, i) => ({ number: i + 1, url: `https://github.com/acme/app/pull/${i + 1}`,
    state: "MERGED", headRefName: `run-W1-T${i + 1}-1234567890123`, headRefOid: "a".repeat(40),
    body: `Remudero-Task: W1-T${i + 1}`, autoMergeRequest: null, title: `Repair ${i + 1}`,
    updatedAt: activityClock.iso(), mergedAt: activityAt }));
  cache.recordClosedAttempt!({ ok: true, persisted: cache.commitClosed(rows) });
  return { stateDir, expectedRepositories: ["acme/app"], instances: [{ name: "core", repository: "acme/app", root, stateDir }], timeZone: "America/New_York" };
}

function activityRow(run: string, payload = ""): Record<string, unknown> {
  return { ts: activityAt, step: "worker.finished", repository: "acme/app", task_id: "W1-T7", run_id: run, payload };
}

function activityId(row: Record<string, unknown>): string {
  const stableRow = Object.fromEntries(Object.entries(row).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return `activity:acme/app:${createHash("sha256").update(JSON.stringify(["acme/app", stableRow])).digest("hex")}`;
}

async function collectActivity(config: DailyProgressCollectionConfig) {
  const publication = await collectDailyProgress(config, activityClock); assert.ok(publication);
  const db = openReadModel({ stateDir: config.stateDir, instance: "activity-proof", schemaVersion: 1 });
  try {
    const lease = acquireLease(db, { clock: activityClock }); assert.ok(lease.ok);
    publication.commit(db, lease.lease);
  } finally { db.close(); }
  const manifest = readDailyProgressManifest(config.stateDir);
  assert.equal(Object.keys(manifest.days).length, 8, "the entire initial correction window is published");
  const key = dailyProgressDayKey("acme/app", "America/New_York", "2026-11-01");
  return readDailyProgressRevision(config.stateDir, manifest.days[key]!);
}

test("daily activity preserves original fields and complete totals across ledger forms", async () => {
  await withTempDir("daily-activity-population", async root => {
    const config = activityFixture(root), payload = "private payload".repeat(4096);
    const rows = [activityRow("gzip", payload), activityRow("plain", payload), activityRow("live", payload)];
    const populations = rows.map(row => [
      { ...activityRow("unrelated", payload), step: "scheduler.tick" }, row,
      { ...activityRow("future"), ts: "2026-11-03T15:00:00Z" },
      { ...activityRow("foreign"), repository: "other/repo" },
      { ...activityRow("old"), ts: "2026-10-01T15:00:00Z" },
    ]);
    writeLedger(populations[2]!, { dir: config.stateDir, rotations: [
      { at: "2026-11-01T00:00:00.000Z", rows: populations[0]!, gz: true },
      { at: "2026-11-02T00:00:00.000Z", rows: populations[1]! },
    ] });
    const saved = await collectActivity(config);
    assert.deepEqual(saved.report.totals, { mergedChanges: { value: 3, precision: "exact" }, completedTasks: { value: 3, precision: "exact" } });
    const events = saved.events.filter(e => e.kind === "activity");
    assert.deepEqual(events.map(e => e.id).sort(), rows.map(activityId).sort(), "identity bytes include the original complete row");
    for (const event of events) {
      assert.equal(event.title, "Worker finished · W1-T7"); assert.equal(event.occurredAt, activityAt);
      assert.equal(event.observedAt, activityClock.iso()); assert.equal(event.repository, "acme/app");
      assert.equal(event.sourceId, "acme/app:ledger:core"); assert.equal(event.fleetAttribution, "confirmed");
      assert.deepEqual(event.taskIds, ["W1-T7"]); assert.equal(event.url, null);
    }
    assert.ok(!JSON.stringify(saved).includes("private payload"), "payloads never enter durable activity projections");
  });
});

/** Each permutation has distinct normalized raw bytes but the same stable semantic event. */
function* activityVariants(count: number): Generator<string> {
  const keys = Array.from({ length: 9 }, (_, i) => `key${i}`);
  for (let n = 0; n < count; n++) {
    yield JSON.stringify({ ...activityRow("key-order"), ...Object.fromEntries(keys.map(key => [key, 0])) }) + "\n";
    let pivot = keys.length - 2;
    while (keys[pivot]! >= keys[pivot + 1]!) pivot--;
    assert.ok(pivot >= 0, "fixture has enough distinct permutations");
    let next = keys.length - 1;
    while (keys[next]! <= keys[pivot]!) next--;
    [keys[pivot], keys[next]] = [keys[next]!, keys[pivot]!];
    keys.splice(pivot + 1, keys.length, ...keys.slice(pivot + 1).reverse());
  }
}

test("Daily progress activity preserves replay deduplication and source gaps: exact raw replay accounting preserves the pre-reconciliation cap and prior publication", async () => {
  await withTempDir("daily-replay-cap", async root => {
    const config = activityFixture(root), isolated = improvementEffectNamespaceDir(config.stateDir, "acme/app", "core");
    mkdirSync(isolated, { recursive: true });
    // Stream exact raw variants: reserialization would obscure whitespace replay evidence.
    await pipeline(Readable.from(activityVariants(50_001)), createGzip(), createWriteStream(join(config.stateDir, "ledger.2026-11-01.ndjson.gz")));
    await pipeline(Readable.from(activityVariants(50_001)), createWriteStream(join(config.stateDir, "ledger.2026-11-02.ndjson")));
    await pipeline(Readable.from((function* () {
      for (const line of activityVariants(50_001)) yield `  ${line.trim()}  \n`;
    })()), createWriteStream(join(config.stateDir, "ledger.ndjson")));
    await pipeline(Readable.from(activityVariants(49_999)), createWriteStream(join(isolated, "ledger.ndjson")));
    const saved = await collectActivity(config);
    assert.equal(saved.events.filter(e => e.kind === "activity").length, 1, "100000 selected replay rows reconcile to one event");
    const variant = JSON.parse(activityVariants(1).next().value!);
    assert.equal(saved.events.find(e => e.kind === "activity")!.id, activityId(variant));
    const before = readFileSync(join(dailyProgressStorePath(config.stateDir), "manifest.json"));
    const files = readdirSync(dailyProgressStorePath(config.stateDir)).sort();
    const later = fixedClock(activityClock.now() + 3_600_000);
    await pipeline(Readable.from(activityVariants(50_000)), createWriteStream(join(isolated, "ledger.ndjson")));
    await assert.rejects(collectDailyProgress(config, later), capRefusal, "copies in independent roots still consume the pre-reconciliation cap");
    assert.deepEqual(readFileSync(join(dailyProgressStorePath(config.stateDir), "manifest.json")), before);
    assert.deepEqual(readdirSync(dailyProgressStorePath(config.stateDir)).sort(), files, "refusal occurs before staging or publication");
    rmSync(isolated, { recursive: true });
    await pipeline(Readable.from(activityVariants(100_001)), createWriteStream(join(config.stateDir, "ledger.ndjson")));
    await assert.rejects(collectDailyProgress(config, later), capRefusal, "100001 raw key-order variants must reach the caller as the original cap error");
    assert.deepEqual(readFileSync(join(dailyProgressStorePath(config.stateDir), "manifest.json")), before);
    assert.deepEqual(readdirSync(dailyProgressStorePath(config.stateDir)).sort(), files);
  });
});

test("Daily progress activity preserves replay deduplication and source gaps: activity source gaps preserve malformed replay audit and availability", async () => {
  await withTempDir("daily-source-gaps", async root => {
    const config = activityFixture(root), row = JSON.stringify(activityRow("positive")) + "\n";
    writeFileSync(join(config.stateDir, "ledger.2026-11-01.ndjson.gz"), gzipSync("bad archive\n" + row));
    writeFileSync(join(config.stateDir, "ledger.2026-11-02.ndjson.gz"), "corrupt gzip");
    writeFileSync(join(config.stateDir, "ledger.2026-11-03.ndjson"), "bad archive\n" + row);
    writeFileSync(join(config.stateDir, "ledger.ndjson"), row + "bad archive\n{\"ts\":");
    const isolated = improvementEffectNamespaceDir(config.stateDir, "acme/app", "core");
    mkdirSync(isolated, { recursive: true }); mkdirSync(join(isolated, "ledger.ndjson"));
    const saved = await collectActivity(config), coverage = saved.report.coverage.sources.find(s => s.kind === "ledger_activity")!;
    assert.equal(saved.events.filter(e => e.kind === "activity").length, 1);
    assert.equal(coverage.state, "partial"); assert.match(coverage.reason!, /6 source or parse gaps/);
    const unavailable = activityFixture(join(root, "unavailable"));
    rmSync(unavailable.stateDir, { recursive: true }); writeFileSync(unavailable.stateDir, "unreadable directory");
    // Fleet publication remains writable while the instance's ledger directory cannot be listed.
    const fleet = join(root, "fleet"); mkdirSync(fleet); unavailable.stateDir = fleet;
    const missing = await collectActivity(unavailable), source = missing.report.coverage.sources.find(s => s.kind === "ledger_activity")!;
    assert.equal(source.state, "unavailable"); assert.equal(source.lastSuccessAt, null);
    assert.match(source.reason!, /1 source or parse gaps/);
    const nonselected = activityFixture(join(root, "nonselected"));
    writeFileSync(join(nonselected.stateDir, "ledger.ndjson"), JSON.stringify({ ...activityRow("nonselected"), step: "scheduler.tick" }) + "\n[]\n");
    const nonselectedSaved = await collectActivity(nonselected);
    assert.equal(nonselectedSaved.events.filter(e => e.kind === "activity").length, 0);
    assert.equal(nonselectedSaved.report.coverage.sources.find(s => s.kind === "ledger_activity")!.state, "partial", "valid nonselected rows still establish availability beside a parse gap");
    const optional = activityFixture(join(root, "optional"));
    const namespace = improvementEffectNamespaceDir(optional.stateDir, "acme/app", "core");
    mkdirSync(namespace, { recursive: true }); rmSync(namespace, { recursive: true }); writeFileSync(namespace, "not a directory");
    const optionalSaved = await collectActivity(optional);
    assert.equal(optionalSaved.report.coverage.sources.find(s => s.kind === "ledger_activity")!.state, "unavailable");
    assert.match(optionalSaved.report.coverage.sources.find(s => s.kind === "ledger_activity")!.reason!, /1 source or parse gaps/);
    rmSync(join(optional.stateDir, "code-health-repositories"), { recursive: true });
    writeFileSync(join(optional.stateDir, "code-health-repositories"), "unreadable namespace ancestor");
    const optionalRead = await collectDailyProgress(optional, fixedClock(activityClock.now() + 3_600_000)); assert.ok(optionalRead);
    const day = optionalRead.manifest.days[dailyProgressDayKey("acme/app", "America/New_York", "2026-11-01")]!;
    const optionalGap = readDailyProgressRevision(optional.stateDir, day).report.coverage.sources.find(s => s.kind === "ledger_activity")!;
    assert.equal(optionalGap.state, "unavailable"); assert.match(optionalGap.reason!, /1 source or parse gaps/);
  });
});

function readHeapHeadroom(measure: typeof readMemoryHeadroom = readMemoryHeadroom): number | undefined {
  return measure(undefined, { vmStat: readVmStat });
}

function assertHeapAdmission(admission: StaticAdmission, dir: string, memoryBytes: number, headroom: number | undefined): void {
  assert.equal(admission.outcome, "admitted", admission.note);
  assert.equal(admission.executionAllowed, true, admission.note);
  assert.equal(admission.childEnvironment?.[TEST_SLOT_DIR_ENV], dir, `capacity reservation must be recorded: ${admission.note}`);
  assert.ok(headroom !== undefined && Number.isFinite(headroom) && headroom >= memoryBytes,
    `measured headroom ${headroom} must cover parent plus child reservation ${memoryBytes}: ${admission.note}`);
}

test("Daily heap proof supplies its Darwin reader and preserves admission refusals; daily heap proof refuses unavailable or unrecorded capacity before spawning", () => {
  const dir = "/unused-admission-control", memoryBytes = 2_048;
  const admitted: StaticAdmission = { outcome: "admitted", executionAllowed: true, waitedMs: 0,
    note: "admission control", childEnvironment: { [TEST_SLOT_DIR_ENV]: dir }, release() {} };
  let measurements = 0;
  const headroom = readHeapHeadroom((read, darwin) => {
    measurements++;
    assert.equal(read, undefined, "Linux retains the maintained default filesystem reader");
    assert.equal(darwin?.vmStat, readVmStat, "the heap fixture must supply the maintained Darwin reader");
    return memoryBytes;
  });
  assert.equal(measurements, 1);
  assert.equal(headroom, memoryBytes);
  assert.doesNotThrow(() => assertHeapAdmission(admitted, dir, memoryBytes, headroom));
  for (const outcome of ["open", "wait_bound_exceeded", "inherited", "slot"] as const) {
    assert.throws(() => assertHeapAdmission({ ...admitted, outcome }, dir, memoryBytes, memoryBytes),
      assert.AssertionError, `${outcome} does not verify this workload's capacity`);
  }
  assert.throws(() => assertHeapAdmission({ ...admitted, executionAllowed: false }, dir, memoryBytes, memoryBytes), assert.AssertionError);
  assert.throws(() => assertHeapAdmission({ ...admitted, childEnvironment: undefined }, dir, memoryBytes, memoryBytes), assert.AssertionError);
  assert.throws(() => assertHeapAdmission({ ...admitted, childEnvironment: { [TEST_SLOT_DIR_ENV]: "/wrong-pool" } }, dir, memoryBytes, memoryBytes), assert.AssertionError);
  for (const headroom of [undefined, NaN, Infinity, memoryBytes - 1]) {
    assert.throws(() => assertHeapAdmission(admitted, dir, memoryBytes, headroom), assert.AssertionError);
  }
});

test("Daily progress activity keeps full counts without retaining unrelated ledger rows; Daily progress activity preserves replay deduplication and source gaps; Daily progress collection stays inside the unchanged slow-lane heap", async t => {
  await withTempDir("daily-heap-workload", async root => {
    const config = activityFixture(root), payload = "x".repeat(64 * 1024), selected = 6_000, unrelated = 18_000;
    const expectedIds: string[] = [];
    // Reuse compressed fixture members; native decompression still reads every complete payload.
    const payloadMember = gzipSync(payload + '"}\n');
    const paths = ["ledger.2026-11-01.ndjson.gz", "ledger.2026-11-02.ndjson.gz", "ledger.2026-11-03.ndjson", "ledger.ndjson"];
    for (const [index, path] of paths.entries()) {
      await pipeline(Readable.from((function* () {
        const count = index === 0 ? unrelated : index === 1 ? selected : 32;
        for (let i = 0; i < count; i++) {
          const row = activityRow(`${index}:${i}`, payload);
          if (index === 0) row.step = "scheduler.tick";
          else expectedIds.push(activityId(row));
          if (index < 2) {
            yield gzipSync(JSON.stringify({ ...row, payload: "" }).slice(0, -2)); yield payloadMember;
          } else yield JSON.stringify(row) + "\n";
        }
        const sentinel = activityRow(`last-row:${index}`); expectedIds.push(activityId(sentinel));
        const last = JSON.stringify(sentinel) + "\n";
        yield index < 2 ? gzipSync(last) : last;
      })()), createWriteStream(join(config.stateDir, path)));
    }
    await pipeline(Readable.from((function* () {
      for (let i = 0; i < selected; i++) {
        yield gzipSync(JSON.stringify(activityRow(`1:${i}`)).slice(0, -2)); yield payloadMember;
      }
    })()), createWriteStream(join(config.stateDir, "ledger.2026-11-04.ndjson.gz")));
    assert.ok(paths.every(path => statSync(join(config.stateDir, path)).size > 0));
    assert.ok(readdirSync(config.stateDir).filter(p => p.endsWith(".gz")).every(p => statSync(join(config.stateDir, p)).size < 8 * 1024 * 1024), "compressed fixtures stay bounded on disk");
    // Reserve both processes in the host pool instead of the test's private fixture slot directory.
    const dir = resolveTestSlotDir({ ...process.env, NODE_TEST_CONTEXT: undefined, NODE_V8_COVERAGE: "" }).dir;
    const memoryBytes = process.resourceUsage().maxRSS * 1024 + (SLOW_LANE_HEAP_MB + 256) * 1024 ** 2;
    let measuredHeadroom: number | undefined;
    const admission = admitStaticWork("daily-progress-heap-proof", {
      dir, memoryBytes, memoryHeadroom: () => (measuredHeadroom = readHeapHeadroom()),
    });
    try {
      assertHeapAdmission(admission, dir, memoryBytes, measuredHeadroom);
      const code = `
        import assert from "node:assert/strict";
        import { collectDailyProgress } from "#src/lib/daily-progress-collector.js";
        import { fixedClock } from "#src/lib/clock.js";
        import { openReadModel, acquireLease } from "#src/lib/read-model-db.js";
        import { dailyProgressDayKey, readDailyProgressManifest, readDailyProgressRevision } from "#src/lib/daily-progress-store.js";
        const config = JSON.parse(process.argv[1]), clock = fixedClock(Date.parse("2026-11-02T06:00:00Z"));
        const publication = await collectDailyProgress(config, clock); assert.ok(publication);
        const db = openReadModel({ stateDir: config.stateDir, instance: "heap-child", schemaVersion: 1 });
        try { const got = acquireLease(db, { clock }); assert.ok(got.ok); publication.commit(db, got.lease); }
        finally { db.close(); }
        const manifest = readDailyProgressManifest(config.stateDir);
        const saved = readDailyProgressRevision(config.stateDir, manifest.days[dailyProgressDayKey("acme/app", "America/New_York", "2026-11-01")]);
        console.log(JSON.stringify({ summary: "daily-workload-complete", days: Object.keys(manifest.days).length,
          ids: saved.events.filter(e => e.kind === "activity").map(e => e.id).sort(), totals: saved.report.totals,
          source: saved.report.coverage.sources.find(s => s.kind === "ledger_activity"), peakRssKiB: process.resourceUsage().maxRSS }));
      `;
      const env = { ...process.env, ...admission.childEnvironment, TMPDIR: root, NODE_V8_COVERAGE: "" };
      const result = await new Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [`--max-old-space-size=${SLOW_LANE_HEAP_MB}`, "--import", "tsx", "--input-type=module", "--eval", code, JSON.stringify(config)], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
        const cancel = () => { child.kill("SIGTERM"); };
        t.signal.addEventListener("abort", cancel, { once: true });
        let stdout = "", stderr = "";
        child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
        child.on("error", reject); child.on("close", (status, signal) => {
          t.signal.removeEventListener("abort", cancel); resolve({ status, signal, stdout, stderr });
        });
      });
      assert.equal(result.signal, null, result.stderr); assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout.trim());
      assert.equal(summary.summary, "daily-workload-complete"); assert.equal(summary.days, 8);
      assert.deepEqual(summary.ids, expectedIds.sort(), "all selected rows and every physical source's final positive control survive");
      assert.deepEqual(summary.totals, { mergedChanges: { value: 3, precision: "exact" }, completedTasks: { value: 3, precision: "exact" } });
      assert.equal(summary.source.state, "partial"); assert.ok(!summary.source.reason.includes("gaps"));
      assert.ok(summary.peakRssKiB > 0); console.log(`daily workload: ${unrelated + selected + 64 + 4 + selected} physical rows; child peak ${summary.peakRssKiB} KiB; ${admission.note}`);
    } finally { admission.release(); }
  });
});
