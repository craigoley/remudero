/**
 * W1-T13667: on 2026-11-18 the core analytics refresh at 11:28Z took 19 s, the live ledger rotated while it read, and
 * the checkpoint it adopted carried no live anchor. The next refresh refused that checkpoint (live-position-unanchored)
 * and rescanned all 241 rotations in nine 65 s legs, 76 s of serve main-thread stall. An unanchored fold now serves its
 * snapshot but keeps the previous anchored checkpoint as the one the next refresh resumes from.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  coldAnalyticsSnapshot,
  createAnalyticsSnapshotCache,
  type AnalyticsCheckpoint,
  type AnalyticsSnapshotReader,
  type AnalyticsTimer,
} from "#src/lib/analytics-route.js";
import { clockFromMillisFn } from "#src/lib/clock.js";

const noTimers = (): AnalyticsTimer => ({ unref: () => {}, cancel: () => {} });
const anchor = { ino: 7, prefixBytes: 0, prefixSha256: "e3b0", tailBytes: 4, tailSha256: "abcd" };

/** A finished fold as the reader returns it, named by `asOf`; `anchored` decides whether its live position has an anchor. */
function fold(asOf: string, anchored: boolean) {
  // The cold snapshot with its non-enumerable fields (dimensions and others) carried, dated `asOf`.
  const snapshot = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(coldAnalyticsSnapshot()), asOf: { value: asOf, enumerable: true } });
  const checkpoint = {
    source: { archives: [], live: { name: "ledger.ndjson", size: 40, mtimeMs: 1, ino: 7 }, lastArchive: null, liveOffset: 40, ...(anchored ? { liveAnchor: anchor } : {}) },
    tail: [], state: {}, snapshot,
  };
  return { snapshot, checkpoint, scan: { mode: "resume", rotationsRead: 0, rotationsRemaining: 0 } };
}

function fixture(t: { after: (fn: () => void) => void }, legs: Array<ReturnType<typeof fold>>) {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-analytics-anchor-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  writeFileSync(join(stateDir, "ledger.ndjson"), "");
  const priors: Array<AnalyticsCheckpoint | undefined> = [];
  const logs: string[] = [];
  let leg = 0;
  const readSnapshot: AnalyticsSnapshotReader = async (_dir, _clock, _signal, prior) => {
    priors.push(prior);
    return legs[Math.min(leg++, legs.length - 1)] as never;
  };
  const cache = createAnalyticsSnapshotCache({ stateDir, clock: clockFromMillisFn(() => Date.parse("2026-11-18T12:00:00.000Z")), readSnapshot, schedule: noTimers, log: (step) => void logs.push(step) });
  return { cache, priors, logs };
}

test("W1-T13667 criterion 1: after an anchored fold, an unanchored fold is served but the next refresh resumes from the anchored checkpoint", async (t) => {
  const anchored = fold("2026-11-18T11:13:00.000Z", true);
  const unanchored = fold("2026-11-18T11:28:00.000Z", false);
  const f = fixture(t, [anchored, unanchored, anchored]);
  await f.cache.refresh();
  await f.cache.refresh();
  assert.equal(f.cache.current().asOf, "2026-11-18T11:28:00.000Z", "the unanchored fold's snapshot is served");
  assert.ok(f.logs.includes("serve.analytics_refresh.anchor_kept"), "keeping the anchored checkpoint is logged");
  await f.cache.refresh();
  assert.equal(f.priors[2]?.source.liveAnchor?.tailSha256, "abcd", "the third refresh resumes from the anchored checkpoint");
  assert.equal(f.priors[2]?.snapshot?.asOf, "2026-11-18T11:13:00.000Z");
});

test("W1-T13667 criterion 2: with no anchored checkpoint to keep, an unanchored fold is adopted as before", async (t) => {
  const unanchored = fold("2026-11-18T11:28:00.000Z", false);
  const f = fixture(t, [unanchored, unanchored]);
  await f.cache.refresh();
  await f.cache.refresh();
  assert.equal(f.priors[1]?.snapshot?.asOf, "2026-11-18T11:28:00.000Z", "the only checkpoint there is resumes the next refresh");
  assert.equal(f.logs.includes("serve.analytics_refresh.anchor_kept"), false);
});
