import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { createBoardSnapshotCache } from "#src/lib/board-snapshot-cache.js";
import { collectDailyProgress } from "#src/lib/daily-progress-collector.js";
import { dailyProgressDayKey, prepareDailyProgressPublication, readDailyProgressManifest, readDailyProgressRevision } from "#src/lib/daily-progress-store.js";
import { acquireLease, openReadModel, readModelLeaseEpoch, releaseLease } from "#src/lib/read-model-db.js";
import { LEDGER_PROJECTOR_SCHEMA_VERSION } from "#src/lib/ledger-projector.js";
import { withTempDir } from "#src/lib/tmp.js";
import { createReadModelTicker } from "#src/lib/read-model-worker.js";
import { runSlowLaneWorker, type SlowLaneMessage } from "#src/lib/read-model-slow-lane.js";

test("daily progress collector reuses complete snapshots with truthful attribution and source clocks", async () => {
  await withTempDir("daily-collector", async root => {
    const stateDir = join(root, "state"); mkdirSync(stateDir, { recursive: true });
    let now = Date.parse("2026-11-02T06:00:00Z");
    const clock = { now: () => now, iso: () => fixedClock(now).iso(), date: () => fixedClock(now).date() };
    const cache = createBoardSnapshotCache(root, "acme", "app", { clock });
    const rows = Array.from({ length: 207 }, (_, index) => ({ number: index + 1, url: `https://github.com/acme/app/pull/${index + 1}`,
      state: index === 206 ? "CLOSED" : "MERGED", headRefName: index < 205 ? `run-W1-T${index + 1}-1234567890123` : "manual-change", headRefOid: "a".repeat(40),
      body: index < 205 ? `Remudero-Task: W1-T${index + 1}` : "", autoMergeRequest: null, title: `Repair ${index + 1}`,
      updatedAt: "2026-11-02T05:30:00.000Z", mergedAt: index === 206 ? undefined : "2026-11-01T15:00:00.000Z" }));
    cache.recordClosedAttempt!({ ok: true, persisted: cache.commitClosed(rows) }); cache.commitOpen!([], now);
    const line = (step: string, run: string) => JSON.stringify({ ts: "2026-11-01T16:00:00.000Z", task_id: "W1-T7", run_id: run, step, private: "/secret/path" }) + "\n";
    writeFileSync(join(stateDir, "ledger.2026-11-01.ndjson.gz"), gzipSync(line("worker.spawn", "one")));
    writeFileSync(join(stateDir, "ledger.2026-11-02.ndjson"), line("worker.finished", "two"));
    writeFileSync(join(stateDir, "ledger.ndjson"), line("verdict", "three"));
    const config = { stateDir, instances: [{ name: "core", root, stateDir, repository: "acme/app" }], timeZone: "America/New_York" };
    const db = openReadModel({ stateDir, instance: "proof", schemaVersion: 1 });
    try {
      const got = acquireLease(db, { clock }); assert.ok(got.ok); if (!got.ok) return;
      const first = await collectDailyProgress(config, clock); assert.ok(first); first.commit(db, got.lease);
      let manifest = readDailyProgressManifest(stateDir);
      const key = dailyProgressDayKey("acme/app", config.timeZone, "2026-11-01");
      const yesterday = readDailyProgressRevision(stateDir, manifest.days[key]!);
      assert.equal(yesterday.report.totals.mergedChanges.value, 205);
      assert.equal(yesterday.report.totals.mergedChanges.precision, "at_least", "unattributed merges are outside confirmed totals");
      assert.equal(yesterday.report.totals.completedTasks.value, 205);
      assert.equal(yesterday.events.filter(e => e.fleetAttribution === "unknown" && e.kind === "merged").length, 1);
      assert.equal(yesterday.events.filter(e => e.kind === "activity").length, 3, "gzip, plain rotation and live ledger positive controls");
      assert.equal(yesterday.report.coverage.state, "partial");
      assert.equal(yesterday.report.coverage.sources.find(s => s.kind === "deployments")!.state, "not_collected");
      assert.ok(!JSON.stringify(yesterday).includes("/secret/path"));
      const today = readDailyProgressRevision(stateDir, manifest.days[dailyProgressDayKey("acme/app", config.timeZone, "2026-11-02")]!);
      assert.deepEqual(today.report.totals.mergedChanges, { value: 0, precision: "exact" }, "a measured zero needs the complete-corpus control");
      assert.equal(await collectDailyProgress(config, clock), undefined, "no page demand or repeated call makes an early hourly job");
      now += 3_600_000;
      rows.push({ ...rows[0]!, number: 208, url: "https://github.com/acme/app/pull/208", headRefName: "run-W1-T208-1234567890123", body: "Remudero-Task: W1-T208" });
      cache.recordClosedAttempt!({ ok: true, persisted: cache.commitClosed(rows) });
      const late = await collectDailyProgress(config, clock); assert.ok(late); late.commit(db, got.lease);
      manifest = readDailyProgressManifest(stateDir);
      assert.equal(readDailyProgressRevision(stateDir, manifest.days[key]!, 1).report.totals.mergedChanges.value, 205);
      assert.equal(readDailyProgressRevision(stateDir, manifest.days[key]!).report.totals.mergedChanges.value, 206);
      assert.equal(readDailyProgressRevision(stateDir, manifest.days[key]!).events.find(e => e.id === yesterday.events.find(e => e.kind === "merged")!.id)!.observedAt, yesterday.events.find(e => e.kind === "merged")!.observedAt);
      now += 3_600_000; cache.recordClosedAttempt!({ ok: false });
      const failed = await collectDailyProgress(config, clock); assert.ok(failed); failed.commit(db, got.lease);
      const retained = readDailyProgressRevision(stateDir, readDailyProgressManifest(stateDir).days[key]!);
      assert.equal(retained.report.totals.mergedChanges.value, 206);
      assert.equal(retained.report.coverage.sources.find(s => s.kind === "pull_requests")!.state, "unavailable");
    } finally { db.close(); }
  });
});

test("daily progress collects hourly and closes local days without page demand", { timeout: 15_000 }, async () => {
  await withTempDir("daily-worker", async root => {
    const stateDir = join(root, "state"); mkdirSync(stateDir, { recursive: true }); writeFileSync(join(stateDir, "ledger.ndjson"), "");
    let now = Date.parse("2026-11-01T04:25:00Z");
    const clock = { now: () => now, iso: () => fixedClock(now).iso(), date: () => fixedClock(now).date() };
    const cache = createBoardSnapshotCache(root, "acme", "app", { clock });
    cache.recordClosedAttempt!({ ok: true, persisted: cache.commitClosed([]) }); cache.commitOpen!([], now);
    const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], views: [], oracle: "off", holder: "daily-worker-proof", clock, post: () => {} });
    ticker.start();
    let receive: (msg: { type: string; held?: boolean; instances?: string[]; ownershipEpoch?: number; modes?: Record<string, string> }) => void = () => { throw new Error("worker port not attached"); };
    let scheduled: (() => void) | undefined;
    let notify: () => void = () => {}, cancelled: () => void = () => {};
    let rejection: (error: Error) => void = () => {};
    const nextCommit = () => new Promise<void>((resolve, reject) => { notify = resolve; rejection = reject; });
    let commits = 0;
    const lane = runSlowLaneWorker({ on(_event, listener) { receive = listener; }, postMessage(value) {
      const message = value as SlowLaneMessage;
      if (message.type === "daily_progress") {
        try { assert.equal(message.ownershipEpoch, 1); ticker.publishDailyProgress(structuredClone(message.publication), ticker.homeLeaseIdentity()!); commits++; notify(); }
        catch (error) { rejection(error as Error); }
      }
      if (message.type === "log" && message.step === "read_model.daily_failed") rejection(new Error(String(message.extra.reason)));
      if (message.type === "log" && message.step === "read_model.daily_cancelled") cancelled();
    } }, { dailyProgress: { stateDir, expectedRepositories: ["acme/app"], instances: [{ name: "core", repository: "acme/app", stateDir, root }] } }, {
      clock, schedule(run) { scheduled = run; return () => { if (scheduled === run) scheduled = undefined; }; },
    });
    try {
      receive({ type: "views", modes: { analytics: "off", "daily-progress": "off" } });
      const first = nextCommit(); receive({ type: "lease", held: true, instances: ["core"], ownershipEpoch: 1 }); await first;
      assert.equal(commits, 1);
      assert.ok(readDailyProgressManifest(stateDir).days[dailyProgressDayKey("acme/app", "America/New_York", "2026-11-01")]);
      now = Date.parse("2026-11-01T05:00:00Z"); ticker.tick();
      const hourly = nextCommit(); assert.ok(scheduled); scheduled(); await hourly;
      assert.equal(commits, 2, "the repeated local hour remains a distinct hourly collection slot");
      now = Date.parse("2026-11-02T05:00:00Z"); ticker.tick();
      cache.recordClosedAttempt!({ ok: true, persisted: cache.commitClosed([]) });
      const midnight = nextCommit(); assert.ok(scheduled); scheduled(); await midnight;
      const manifest = readDailyProgressManifest(stateDir);
      const closed = readDailyProgressRevision(stateDir, manifest.days[dailyProgressDayKey("acme/app", "America/New_York", "2026-11-01")]!);
      assert.equal(closed.report.windowEnd, "2026-11-02T05:00:00.000Z");
      assert.ok(["complete", "corrected"].includes(closed.report.phase));
      assert.ok(manifest.days[dailyProgressDayKey("acme/app", "America/New_York", "2026-11-02")]);
      now += 3_600_000; ticker.tick();
      const aborted = new Promise<void>(resolve => { cancelled = resolve; });
      assert.ok(scheduled); scheduled(); receive({ type: "lease", held: false, instances: [], ownershipEpoch: 2 }); await aborted;
      assert.equal(readDailyProgressManifest(stateDir).generation, manifest.generation, "lost ownership cannot advance durable jobs or reports");
      const oldIdentity = ticker.homeLeaseIdentity(); assert.ok(oldIdentity);
      const staged = prepareDailyProgressPublication(stateDir, [], []);
      const peer = openReadModel({ stateDir, instance: "core", schemaVersion: LEDGER_PROJECTOR_SCHEMA_VERSION });
      try {
        const originalAcquisition = Number(peer.prepare("SELECT acquired_ms FROM lease WHERE name = 'projector'").get()!.acquired_ms);
        now += 60_000;
        const other = acquireLease(peer, { holder: "other-proof-owner", clock }); assert.ok(other.ok); if (!other.ok) return;
        releaseLease(peer, other.lease);
        now = originalAcquisition; // Same owner and repeated clock must still get a different epoch.
        const regained = acquireLease(peer, { holder: "daily-worker-proof", clock }); assert.ok(regained.ok); if (!regained.ok) return;
        const epoch = readModelLeaseEpoch(peer, regained.lease); assert.ok(epoch);
        const renewal = acquireLease(peer, { holder: "daily-worker-proof", clock }); assert.ok(renewal.ok);
        if (renewal.ok) assert.equal(readModelLeaseEpoch(peer, renewal.lease), epoch, "heartbeat renewal preserves ownership identity");
        assert.notEqual(ticker.homeLeaseIdentity(), oldIdentity);
        assert.throws(() => ticker.publishDailyProgress(staged.publication, oldIdentity), /ownership epoch/);
        assert.equal(readDailyProgressManifest(stateDir).generation, manifest.generation);
      } finally { peer.close(); }
    } finally { lane.stop(); ticker.release(); }
  });
});
