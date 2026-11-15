// W1-T11983: 51 SWEEP_WAKE_REQUESTED.tmp-<pid>-<uuid> files sat in the core state directory on 2026-11-10, the oldest
// from 2026-10-18 and up to eleven from one process: writers killed between the temp write and the rename.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  SWEEP_WAKE_TEMP_MAX_AGE_MS,
  sweepStaleWakeMarkerTemps,
  sweepWakeMarkerPath,
  wireSweepWakeToDaemon,
  writeSweepWakeMarkerAtomic,
  writeSweepWakeMarkerAtomicAsync,
  type SweepWakeMarker,
} from "#src/lib/github-event-wake.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const NOW = Date.parse("2026-11-10T05:00:00.000Z");
const RECORD: SweepWakeMarker = { deliveryId: "d-1", event: "pull_request", action: "closed", repository: "craigoley/remudero", receivedAtIso: new Date(NOW).toISOString() };

function fixture(t: TestContext): { root: string; dir: string; marker: string; temp(name: string, ageMs: number): string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}wake-temp-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = sweepWakeMarkerPath(root);
  const dir = dirname(marker);
  mkdirSync(dir, { recursive: true });
  return {
    root, dir, marker,
    temp(name, ageMs) {
      const path = join(dir, name);
      writeFileSync(path, "");
      utimesSync(path, (NOW - ageMs) / 1000, (NOW - ageMs) / 1000);
      return path;
    },
  };
}

test("W1-T11983 criterion 1: a marker write whose write or rename throws removes its temp file before rethrowing", async (t) => {
  const f = fixture(t);
  // A directory where the marker belongs makes the rename throw after the temp file was written whole.
  mkdirSync(f.marker);
  writeFileSync(join(f.marker, "occupied"), "");
  assert.throws(() => writeSweepWakeMarkerAtomic(f.marker, RECORD));
  await assert.rejects(writeSweepWakeMarkerAtomicAsync(f.marker, RECORD));
  assert.deepEqual(readdirSync(f.dir), ["SWEEP_WAKE_REQUESTED"], "both failed writes left nothing beside the path they could not replace");
  // Control: the same two writes over a free path install the marker, so the throws above were the rename's.
  rmSync(f.marker, { recursive: true });
  writeSweepWakeMarkerAtomic(f.marker, RECORD);
  await writeSweepWakeMarkerAtomicAsync(f.marker, RECORD);
  assert.deepEqual(readdirSync(f.dir), ["SWEEP_WAKE_REQUESTED"]);
});

test("W1-T11983 criterion 2: a start removes this writer's temp files older than an hour, and never the marker or a younger temp", (t) => {
  const f = fixture(t);
  writeSweepWakeMarkerAtomic(f.marker, RECORD);
  const stale = [f.temp("SWEEP_WAKE_REQUESTED.tmp-208821-aaaa", SWEEP_WAKE_TEMP_MAX_AGE_MS + 1_000), f.temp("SWEEP_WAKE_REQUESTED.tmp-189-bbbb", 23 * 24 * 3_600_000)];
  const kept = [
    f.temp("SWEEP_WAKE_REQUESTED.tmp-77-young", SWEEP_WAKE_TEMP_MAX_AGE_MS - 1_000),
    f.temp("SWEEP_WAKE_REQUESTED.consume-77-claim", 2 * SWEEP_WAKE_TEMP_MAX_AGE_MS),
    f.temp("gardener-runtime.json.tmp-77-other", 2 * SWEEP_WAKE_TEMP_MAX_AGE_MS),
  ];
  const wiring = wireSweepWakeToDaemon(f.root, () => {}, undefined, { now: () => NOW });
  t.after(() => wiring.close());
  assert.deepEqual(stale.map((path) => existsSync(path)), [false, false], "the daemon's start swept both stale temps");
  assert.deepEqual(kept.map((path) => existsSync(path)), [true, true, true], "a young temp, a consumer's claim and another writer's temp are not this sweep's");
  assert.ok(existsSync(f.marker), "the marker itself is never a temp file");
});

test("W1-T11983 criterion 3: the removal is counted on one github.wake.temp_swept row and a failed removal is reported there, never thrown", (t) => {
  const f = fixture(t);
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  const log = (step: string, extra?: Record<string, unknown>) => void rows.push([step, extra]);
  assert.deepEqual(sweepStaleWakeMarkerTemps(f.root, NOW, log), { removed: 0, failed: 0 });
  assert.deepEqual(rows, [], "a directory with nothing to sweep writes no row");

  for (const n of [1, 2, 3]) f.temp(`SWEEP_WAKE_REQUESTED.tmp-9-${n}`, 2 * SWEEP_WAKE_TEMP_MAX_AGE_MS);
  const refused = join(f.dir, "SWEEP_WAKE_REQUESTED.tmp-9-2");
  const result = sweepStaleWakeMarkerTemps(f.root, NOW, log, (path) => {
    if (path === refused) throw new Error("EPERM: operation not permitted");
    rmSync(path);
  });
  assert.deepEqual(result, { removed: 2, failed: 1 });
  assert.deepEqual(rows, [["github.wake.temp_swept", { removed: 2, failed: 1, error: "EPERM: operation not permitted" }]]);
  assert.deepEqual(readdirSync(f.dir), ["SWEEP_WAKE_REQUESTED.tmp-9-2"], "the one it could not remove is still there for the next start");
});
