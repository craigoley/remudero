// W1-T9523 (scout: analytics.source_snapshot_failed): the slow lane's actual default scanner runs over a private
// real gzip/plain/live ledger on a controlled clock that charges every read, so each leg exhausts its half-timeout
// budget. The detailed matrix lives in analytics-view.test.ts; this file pins the scout symptom itself — a bounded
// leg is progress, never a failed or a fresh partial snapshot — against a one-pass positive control.
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { deriveAnalyticsSnapshotFromCheckpointedLedger } from "#src/lib/analytics-route.js";
import { ANALYTICS_VIEW_NAME, analyticsSourceBodies } from "#src/lib/analytics-view.js";
import type { Clock } from "#src/lib/clock.js";
import type { SourceSnapshotWrite } from "#src/lib/read-model-db.js";
import { runSlowLaneWorker, type SlowLaneMessage } from "#src/lib/read-model-slow-lane.js";
import { makeTempDir } from "#src/lib/tmp.js";

const T0 = Date.parse("2026-10-05T12:00:00.000Z");
const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const row = (verb: string): string => JSON.stringify({ ts: iso(T0 - MINUTE), step: "cli.invoked", verb });

test("W1-T9523: scout symptom — bounded legs never post a failed or partial snapshot and converge on the one-pass fold", async (t) => {
  const stateDir = makeTempDir("scout-analytics-source-snapshot-failed");
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  writeFileSync(join(stateDir, "ledger.2026-10-05T11-01-00-000Z.ndjson.gz"), gzipSync(row("alpha") + "\n"));
  writeFileSync(join(stateDir, "ledger.2026-10-05T11-02-00-000Z.ndjson"), row("alpha") + "\n" + row("bravo") + "\n");
  writeFileSync(join(stateDir, "ledger.2026-10-05T11-03-00-000Z.ndjson.gz"), gzipSync(row("charlie") + "\n"));
  writeFileSync(join(stateDir, "ledger.ndjson"), row("delta") + "\n");

  let at = T0;
  const clock: Clock = { now: () => (at += 35_000), date: () => new Date(at), iso: () => iso(at) };
  let onMessage: ((msg: { type?: string; held?: unknown; modes?: unknown; instances?: unknown }) => void) | undefined;
  let next: (() => void) | undefined;
  const posted: SlowLaneMessage[] = [];
  const handle = runSlowLaneWorker(
    { on: (_event, run) => (onMessage = run), postMessage: (m) => void posted.push(m as SlowLaneMessage) },
    { analytics: { instances: [{ name: "core", stateDir }], intervalMs: MINUTE } },
    { clock, schedule: (run) => ((next = run), () => void (next = undefined)) },
  );
  t.after(() => handle.stop());
  const snapshots = (): SourceSnapshotWrite[] => posted.flatMap((m) => (m.type === "source_snapshot" ? [m.snapshot] : []));
  const legs = (): number => posted.filter((m) => m.type === "end" && m.work.unit === "analytics" && m.work.instance !== undefined).length;
  const settle = async (want: number): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (legs() < want && Date.now() < deadline) await sleep(5);
    assert.equal(legs(), want);
  };

  onMessage?.({ type: "views", modes: { [ANALYTICS_VIEW_NAME]: "shadow" } });
  onMessage?.({ type: "lease", held: true, instances: ["core"] });
  await settle(1);
  assert.deepEqual(snapshots(), [], "the first bounded leg posts neither a success nor a fresh failure");

  for (let leg = 2; leg <= 6 && !snapshots().length; leg++) {
    at += 2 * MINUTE;
    next?.();
    await settle(leg);
  }
  const [only, ...rest] = snapshots();
  assert.equal(rest.length, 0, "exactly one snapshot is posted, and only once the fold is complete");
  assert.ok(only?.ok, `the completed fold is a success: ${JSON.stringify(posted.filter((m) => m.type === "log"))}`);

  const control = await deriveAnalyticsSnapshotFromCheckpointedLedger(stateDir, { now: () => Date.parse(only.asOf), date: () => new Date(only.asOf), iso: () => only.asOf });
  assert.deepEqual(only.bodies, analyticsSourceBodies(control.snapshot), "resumed legs equal the one-pass positive control");
  assert.equal(control.snapshot.invocationsByVerb.alpha, 1, "the replayed row is counted once");
  assert.ok(posted.some((m) => m.type === "log" && m.step === "analytics.source_snapshot_progress"), "progress is diagnosable apart from success");
});
