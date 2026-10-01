/**
 * Memory tier 1 (arch-phase3-design.md §1 "Memory"): when a handoff is short of cgroup headroom, the
 * active serve generation drops its analytics snapshot. It serves the cold shape until the next
 * refresh, and that refresh resumes from the checkpoint on disk rather than re-reading the corpus.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAnalyticsSnapshotCache,
  deriveAnalyticsSnapshotFromCheckpointedLedger,
  type AnalyticsSnapshotReader,
  type AnalyticsTimer,
} from "../src/lib/analytics-route.js";

const noTimers = (): AnalyticsTimer => ({ unref: () => {}, cancel: () => {} });

test("a shed analytics cache serves cold and its next refresh resumes from the disk checkpoint", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-analytics-shed-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  writeFileSync(join(stateDir, "ledger.ndjson"), `${JSON.stringify({ ts: "2026-10-01T00:00:00.000Z", step: "cli.invoked", verb: "status" })}\n`);
  const priors: boolean[] = [];
  const readSnapshot: AnalyticsSnapshotReader = (dir, clock, signal, prior) => {
    priors.push(prior !== undefined);
    return deriveAnalyticsSnapshotFromCheckpointedLedger(dir, clock, signal, prior);
  };
  const steps: string[] = [];
  const cache = createAnalyticsSnapshotCache({ stateDir, readSnapshot, schedule: noTimers, log: (step) => void steps.push(step) });
  await cache.refresh();
  const warm = cache.current();
  assert.notEqual(warm.invocationsByVerb.status, undefined, "the first refresh counted the ledger row");

  cache.shed();
  assert.deepEqual(cache.current().invocationsByVerb, {}, "shed: the in-memory snapshot is gone, so a read sees the cold shape");
  assert.ok(steps.includes("serve.analytics_shed"));

  await cache.refresh();
  assert.deepEqual(priors, [false, true], "the refresh after a shed resumes from the checkpoint the first one wrote to disk");
  assert.deepEqual(cache.current().invocationsByVerb, warm.invocationsByVerb, "and serves the same counts again");
});
