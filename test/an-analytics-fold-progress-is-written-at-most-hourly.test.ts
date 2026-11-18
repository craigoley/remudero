/**
 * W1-T13483: serve wrote a partial analytics fold's resume point (about 80 MB of JSON on the Azure host) synchronously on
 * its request loop after every partial refresh, several times an hour; each write stalled every Console read for 10 to
 * 27 s on 2026-11-17. The cache now writes it at most once an hour and at stop, and resumes from memory in between.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ANALYTICS_CHECKPOINT_WRITE_INTERVAL_MS,
  coldAnalyticsSnapshot,
  createAnalyticsSnapshotCache,
  type AnalyticsSnapshotReader,
  type AnalyticsTimer,
} from "#src/lib/analytics-route.js";
import { clockFromMillisFn } from "#src/lib/clock.js";

const PROGRESS = ".analytics-console-v1.progress.json";
const noTimers = (): AnalyticsTimer => ({ unref: () => {}, cancel: () => {} });

/** A cache whose reader returns a partial fold (a numbered resume point) until told to finish. */
function fixture(t: { after: (fn: () => void) => void }) {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-analytics-progress-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  writeFileSync(join(stateDir, "ledger.ndjson"), "");
  let nowMs = Date.parse("2026-11-17T20:00:00.000Z");
  let leg = 0;
  let finish = false;
  const readSnapshot: AnalyticsSnapshotReader = async () => {
    // A finished fold, as the real reader returns it: the snapshot and its (here empty) checkpoint.
    if (finish) return { snapshot: coldAnalyticsSnapshot(), checkpoint: { source: { archives: [] } } } as never;
    leg += 1;
    return { progress: { leg } } as never;
  };
  const onDisk = (): number | undefined => existsSync(join(stateDir, PROGRESS)) ? (JSON.parse(readFileSync(join(stateDir, PROGRESS), "utf8")) as { leg: number }).leg : undefined;
  const cache = createAnalyticsSnapshotCache({ stateDir, clock: clockFromMillisFn(() => nowMs), readSnapshot, schedule: noTimers });
  return { cache, onDisk, advance: (ms: number) => void (nowMs += ms), finish: () => void (finish = true) };
}

test("W1-T13483 criterion 1: the first partial writes its resume point, later partials within the hour write nothing, and one an hour on writes again", async (t) => {
  const f = fixture(t);
  await f.cache.refresh();
  assert.equal(f.onDisk(), 1, "positive control: the first partial is written at once");
  for (let i = 0; i < 5; i += 1) {
    f.advance(10 * 60_000 - 1);
    await f.cache.refresh();
  }
  assert.equal(f.onDisk(), 1, "five partials inside the hour wrote nothing");
  f.advance(ANALYTICS_CHECKPOINT_WRITE_INTERVAL_MS);
  await f.cache.refresh();
  assert.equal(f.onDisk(), 7, "the first partial past the hour writes the newest resume point");
});

test("W1-T13483 criterion 2: stop writes the resume point the hour held back", async (t) => {
  const f = fixture(t);
  await f.cache.refresh();
  f.advance(60_000);
  await f.cache.refresh();
  assert.equal(f.onDisk(), 1);
  f.cache.stop();
  assert.equal(f.onDisk(), 2, "the held-back leg reached disk at stop");
});

test("W1-T13483 criterion 3: a fold that finishes clears its resume point and leaves nothing for stop to write", async (t) => {
  const f = fixture(t);
  await f.cache.refresh();
  f.advance(60_000);
  await f.cache.refresh();
  f.finish();
  f.advance(60_000);
  await f.cache.refresh();
  assert.equal(f.onDisk(), undefined, "a finished fold removes its progress file");
  f.cache.stop();
  assert.equal(f.onDisk(), undefined, "and stop does not write a stale resume point back");
});
