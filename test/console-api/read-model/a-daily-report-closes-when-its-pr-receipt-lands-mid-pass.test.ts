import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createBoardSnapshotCache } from "#src/lib/board-snapshot-cache.js";
import { fixedClock, type Clock } from "#src/lib/clock.js";
import { collectDailyProgress } from "#src/lib/daily-progress-collector.js";
import { dailyProgressDayKey, readDailyProgressManifest, readDailyProgressRevision } from "#src/lib/daily-progress-store.js";
import { acquireLease, flushReadModelTransactions, openReadModel } from "#src/lib/read-model-db.js";
import type { BoardPrRest } from "#src/lib/open-prs-rest.js";
import { withTempDir } from "#src/lib/tmp.js";

const T0 = Date.parse("2026-11-02T06:00:00Z");
const ZONE = "America/New_York";
const clockAt = (ms: () => number): Clock => ({ now: ms, iso: () => fixedClock(ms()).iso(), date: () => fixedClock(ms()).date() }) as Clock;
const merged = (number: number, mergedAt: string): BoardPrRest => ({ number, url: `https://github.com/acme/app/pull/${number}`, state: "MERGED",
  headRefName: `run-W1-T${number}-1234567890123`, headRefOid: "a".repeat(40), body: `Remudero-Task: W1-T${number}`, autoMergeRequest: null,
  title: `Repair ${number}`, updatedAt: mergedAt, mergedAt });

/**
 * One pass whose clock starts at T0 and reads later on every call after the first, as a pass that waits behind another
 * repository's ledger read does; the closed-PR receipt and rows are written at `receiptAt`, after the pass began.
 */
async function passWithReceiptAt(receiptAt: number, rows: BoardPrRest[]) {
  return withTempDir("daily-receipt-mid-pass", async (root) => {
    const stateDir = join(root, "state"); mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "ledger.ndjson"), "");
    const cache = createBoardSnapshotCache(root, "acme", "app", { clock: clockAt(() => receiptAt) });
    cache.recordClosedAttempt!({ ok: true, persisted: cache.commitClosed(rows) }); cache.commitOpen!([], receiptAt);
    let calls = 0;
    const clock = clockAt(() => (calls++ === 0 ? T0 : T0 + 3 * 60_000));
    const config = { stateDir, expectedRepositories: ["acme/app"], instances: [{ name: "core", root, stateDir, repository: "acme/app" }], timeZone: ZONE };
    const db = openReadModel({ stateDir, instance: "proof", schemaVersion: 1 });
    try {
      const got = acquireLease(db, { clock: clockAt(() => T0) }); assert.ok(got.ok); if (!got.ok) throw new Error("no lease");
      const built = await collectDailyProgress(config, clock); assert.ok(built); built.commit(db, got.lease);
      const manifest = readDailyProgressManifest(stateDir);
      const revision = (date: string) => readDailyProgressRevision(stateDir, manifest.days[dailyProgressDayKey("acme/app", ZONE, date)]!);
      return { yesterday: revision("2026-11-01").report, today: revision("2026-11-02").report, todayEvents: revision("2026-11-02").events,
        job: Object.values(manifest.jobs)[0]! };
    } finally { db.close(); await flushReadModelTransactions(); }
  });
}
const prSource = (report: { coverage: { sources: Array<{ kind: string; required: boolean; state: string; reason: string | null }> } }) =>
  report.coverage.sources.find((s) => s.kind === "pull_requests" && s.required)!;

test("W1-T13454 criterion 1: a complete PR receipt written after the pass began but before it was read covers the closed day, and the day closes", async () => {
  const { yesterday, job } = await passWithReceiptAt(T0 + 60_000, [merged(1, "2026-11-01T15:00:00.000Z")]);
  assert.equal(prSource(yesterday).state, "complete", `a receipt read after it landed is not from the future: ${prSource(yesterday).reason}`);
  assert.equal(yesterday.phase, "complete");
  assert.deepEqual(yesterday.totals.mergedChanges, { value: 1, precision: "exact" });
  assert.equal(job.closedThrough, "2026-11-01", "the closed day advances the job, so it stops being due every pass");
});

test("W1-T13454 criterion 2: a merge stamped after the pass began but before its rows were read is an event, not an invalid row", async () => {
  const { yesterday, today, todayEvents, job } = await passWithReceiptAt(T0 + 60_000, [merged(1, "2026-11-01T15:00:00.000Z"), merged(2, fixedClock(T0 + 30_000).iso())]);
  // One invalid row makes EVERY required source partial for every date, so yesterday is the falsifier.
  assert.equal(prSource(yesterday).state, "complete", String(prSource(yesterday).reason));
  assert.doesNotMatch(String(prSource(today).reason), /invalid/, "no row reads as invalid");
  assert.ok(todayEvents.some((e) => e.id === "merged:acme/app:2"), "the fresh merge is today's event");
  assert.equal(job.closedThrough, "2026-11-01");
});

test("W1-T13454 criterion 3: a receipt stamped after the files were read is still refused as newer than the cutoff", async () => {
  const { yesterday, job } = await passWithReceiptAt(T0 + 60 * 60_000, [merged(1, "2026-11-01T15:00:00.000Z")]);
  assert.equal(prSource(yesterday).state, "partial");
  assert.equal(prSource(yesterday).reason, "The source receipt is newer than this report's cutoff.");
  assert.notEqual(job.closedThrough, "2026-11-01", "an unproven day never closes");
});

test("W1-T13454 criterion 4: a legacy merge with no mergedAt last updated before the window is skipped; one updated inside it stays invalid", async () => {
  const legacy = (number: number, updatedAt: string): BoardPrRest => {
    const { mergedAt: _dropped, ...row } = merged(number, updatedAt); return row;
  };
  const old = await passWithReceiptAt(T0 + 60_000, [merged(1, "2026-11-01T15:00:00.000Z"), legacy(2, "2026-09-01T12:00:00.000Z")]);
  assert.equal(prSource(old.yesterday).state, "complete", String(prSource(old.yesterday).reason));
  assert.equal(old.job.closedThrough, "2026-11-01", "a legacy row from September no longer blocks November");
  const fresh = await passWithReceiptAt(T0 + 60_000, [merged(1, "2026-11-01T15:00:00.000Z"), legacy(2, "2026-11-01T16:00:00.000Z")]);
  assert.equal(prSource(fresh.yesterday).state, "partial", "positive control: an unknown merge time inside the window is still invalid");
  assert.match(String(prSource(fresh.yesterday).reason), /invalid/);
});
