/**
 * W1-T13174: serve wrote its analytics checkpoint (79 MB for core on 2026-11-16) after every refresh, on its
 * main thread. A cache now writes it at most once an hour and at stop; between writes the fold resumes from the
 * in-memory checkpoint, and the disk copy is only the resume point of the next cache made on the state dir.
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ANALYTICS_CHECKPOINT_WRITE_INTERVAL_MS,
  createAnalyticsSnapshotCache,
  deriveAnalyticsSnapshotFromCheckpointedLedger,
  type AnalyticsCheckpoint,
  type AnalyticsSnapshotReader,
  type AnalyticsTimer,
} from "#src/lib/analytics-route.js";
import { clockFromMillisFn } from "#src/lib/clock.js";

const CHECKPOINT = ".analytics-console-v1.checkpoint.json";
const noTimers = (): AnalyticsTimer => ({ unref: () => {}, cancel: () => {} });
const row = (ts: string, verb: string): string => `${JSON.stringify({ ts, step: "cli.invoked", verb })}\n`;

function fixture(t: { after: (fn: () => void) => void }) {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-analytics-hourly-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  writeFileSync(join(stateDir, "ledger.ndjson"), row("2026-10-01T00:00:00.000Z", "status"));
  let nowMs = Date.parse("2026-10-01T01:00:00.000Z");
  const clock = clockFromMillisFn(() => nowMs);
  const priors: Array<AnalyticsCheckpoint | undefined> = [];
  const returned: AnalyticsCheckpoint[] = [];
  const readSnapshot: AnalyticsSnapshotReader = async (dir, refreshClock, signal, prior) => {
    priors.push(prior);
    const result = await deriveAnalyticsSnapshotFromCheckpointedLedger(dir, refreshClock, signal, prior);
    if ("checkpoint" in result) returned.push(result.checkpoint);
    return result;
  };
  const onDisk = (): string | undefined => existsSync(join(stateDir, CHECKPOINT)) ? readFileSync(join(stateDir, CHECKPOINT), "utf8") : undefined;
  const make = () => createAnalyticsSnapshotCache({ stateDir, clock, readSnapshot, schedule: noTimers });
  return { stateDir, make, onDisk, priors, returned, advance: (ms: number) => void (nowMs += ms), add: (verb: string) => appendFileSync(join(stateDir, "ledger.ndjson"), row(new Date(nowMs).toISOString(), verb)) };
}

test("W1-T13174 criterion 1: the first refresh writes the checkpoint and refreshes within the hour write nothing", async (t) => {
  const f = fixture(t);
  const cache = f.make();
  assert.equal(f.onDisk(), undefined, "positive control: no checkpoint before a refresh");
  await cache.refresh();
  const first = f.onDisk();
  assert.ok(first, "the first completed refresh of a cache writes its checkpoint");
  for (const verb of ["doctor", "plan", "serve"]) {
    f.advance(15 * 60_000 - 1);
    f.add(verb);
    await cache.refresh();
    assert.notEqual(cache.current().invocationsByVerb[verb], undefined, `the ${verb} refresh still serves the new rows`);
  }
  assert.equal(f.onDisk(), first, "three refreshes inside the hour left the disk checkpoint as the first one wrote it");
});

test("W1-T13174 criterion 2: a refresh an hour after the last write writes again, and stop writes the unwritten checkpoint", async (t) => {
  const f = fixture(t);
  const cache = f.make();
  await cache.refresh();
  const first = f.onDisk();
  f.advance(ANALYTICS_CHECKPOINT_WRITE_INTERVAL_MS);
  f.add("doctor");
  await cache.refresh();
  const second = f.onDisk();
  assert.notEqual(second, first, "a refresh one interval after the last write writes the newest checkpoint");
  f.advance(60_000);
  f.add("plan");
  await cache.refresh();
  assert.equal(f.onDisk(), second, "positive control: a refresh a minute later did not write");
  cache.stop();
  assert.notEqual(f.onDisk(), second, "stop wrote the checkpoint the last refresh held unwritten");
  const next = f.make();
  assert.notEqual(next.current().invocationsByVerb.plan, undefined, "a cache made next on the state dir resumes from it");
});

test("W1-T13174 criterion 3: refreshes between writes resume from the in-memory checkpoint, not the older disk one", async (t) => {
  const f = fixture(t);
  const cache = f.make();
  await cache.refresh();
  for (const verb of ["doctor", "plan"]) {
    f.advance(15 * 60_000);
    f.add(verb);
    await cache.refresh();
  }
  assert.equal(f.priors.length, 3);
  assert.equal(f.priors[0], undefined, "the first refresh had no checkpoint");
  assert.strictEqual(f.priors[1], f.returned[0], "the second resumed from the first refresh's checkpoint object");
  assert.strictEqual(f.priors[2], f.returned[1], "the third resumed from the second's, which was never written");
});
