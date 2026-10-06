/**
 * 2026-10-06, Azure host: every core serve boot logged `serve.analytics_refresh.timeout` at 120 s
 * with the snapshot retained as of 20:06Z, and the serve was replaced every ~15 min, so the next
 * refresh never came. A cold scan of the whole corpus cannot fit one refresh, and a refresh that
 * timed out kept nothing of what it had read. A budgeted scan stops on a rotation boundary, persists
 * its fold, and the next refresh continues it; the legs must fold exactly what one pass folds.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import * as analytics from "../src/lib/analytics-route.js";
import type { Clock } from "../src/lib/clock.js";

const AS_OF = "2026-10-06T21:00:00.000Z";

function steppingClock(stepMs: number): Clock {
  let at = Date.parse(AS_OF);
  return { now: () => (at += stepMs), date: () => new Date(AS_OF), iso: () => AS_OF };
}

function invoked(verb: string, minute: number): string {
  return JSON.stringify({ ts: `2026-10-06T20:${String(minute).padStart(2, "0")}:00.000Z`, task_id: "CLI", run_id: `CLI-${verb}`, step: "cli.invoked", verb });
}

/** Three rotations and a live file, one distinct verb each. */
function corpus(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-analytics-legs-"));
  ["alpha", "bravo", "charlie"].forEach((verb, index) => {
    writeFileSync(join(dir, `ledger.2026-10-06T20-0${index + 1}-00-000Z.ndjson.gz`), gzipSync(`${invoked(verb, index)}\n`));
  });
  writeFileSync(join(dir, "ledger.ndjson"), `${invoked("delta", 5)}\n`);
  return dir;
}

const ONE_PASS_VERBS = { alpha: 1, bravo: 1, charlie: 1, delta: 1 };

type Partial = analytics.AnalyticsPartialReadResult;
type Complete = analytics.AnalyticsSnapshotReadResult;

test("unit test: a budgeted analytics scan stops on a rotation boundary and its legs fold exactly what one pass folds", async () => {
  const dir = corpus();
  const onePass = await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(dir, steppingClock(0));
  assert.deepEqual(onePass.snapshot.invocationsByVerb, ONE_PASS_VERBS, "positive control: one pass sees all four rows");

  const clock = steppingClock(1_000);
  const legs: Array<analytics.AnalyticsScanReport> = [];
  let progress: analytics.AnalyticsResumePoint | undefined;
  let done: Complete | undefined;
  while (done === undefined && legs.length < 10) {
    // Each leg's budget is already spent when its first rotation finishes.
    const result = await analytics.scanAnalyticsLedger(dir, clock, undefined, undefined, { progress, yieldAtMs: clock.now() });
    legs.push(result.scan!);
    if ("progress" in result) progress = JSON.parse(JSON.stringify((result as Partial).progress)) as analytics.AnalyticsResumePoint;
    else done = result as Complete;
  }
  assert.deepEqual(legs.map((leg) => [leg.mode, leg.rotationsRead, leg.rotationsRemaining]), [
    ["full", 1, 2], ["continue", 1, 1], ["continue", 1, 0], ["continue", 0, 0],
  ], "one rotation per leg, then the live file; every leg says how far it got");
  assert.equal(legs[0]!.reason, "no-checkpoint");
  assert.ok(done !== undefined);
  assert.deepEqual(done.snapshot.invocationsByVerb, ONE_PASS_VERBS);
  assert.deepEqual(JSON.parse(JSON.stringify(done.checkpoint.state)), JSON.parse(JSON.stringify(onePass.checkpoint.state)),
    "the folded state is identical to one pass");
  assert.deepEqual(done.checkpoint.tail, onePass.checkpoint.tail, "and so is the replay window a later resume is seeded with");
  assert.deepEqual(done.checkpoint.source, onePass.checkpoint.source);
});

test("unit test: a refresh that cannot finish advances its fold on disk, says so, and the next refresh finishes it", async () => {
  const dir = corpus();
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const delays: number[] = [];
  const cache = analytics.createAnalyticsSnapshotCache({
    stateDir: dir,
    clock: steppingClock(1_000),
    // Budget is half the bound: 1 s, i.e. the first rotation boundary of each leg.
    refreshTimeoutMs: 2_000,
    schedule: (_callback, delayMs) => { delays.push(delayMs); return { unref: () => {}, cancel: () => {} }; },
    log: (step, extra) => void logs.push({ step, extra }),
  });
  cache.start();
  await cache.refresh();
  const partial = logs.find((row) => row.step === "serve.analytics_refresh.partial");
  assert.ok(partial, "a refresh that ran out of budget says so in its own row, not as a timeout or a completion");
  assert.equal(partial.extra?.retained_as_of, null);
  assert.equal(partial.extra?.scan_mode, "full");
  assert.equal(partial.extra?.scan_reason, "no-checkpoint");
  assert.equal(partial.extra?.rotations_remaining, 2);
  assert.equal(cache.current().asOf, null, "a partial fold is never published as a snapshot");
  assert.ok(readdirSync(dir).includes(".analytics-console-v1.progress.json"), "the fold advanced on disk, where the next serve finds it");
  assert.equal(existsSync(join(dir, ".analytics-console-v1.checkpoint.json")), false);
  assert.ok(delays.includes(partial.extra?.duration_ms as number), "the continuation waits as long as the leg ran, not the 15-minute interval");

  // A new serve boots onto the same state dir and continues the fold, never restarts it.
  const next = analytics.createAnalyticsSnapshotCache({
    stateDir: dir, clock: steppingClock(1_000), refreshTimeoutMs: 2_000,
    schedule: () => ({ unref: () => {}, cancel: () => {} }), log: (step, extra) => void logs.push({ step, extra }),
  });
  for (let i = 0; i < 5 && next.current().asOf === null; i += 1) await next.refresh();
  const modes = logs.filter((row) => row.step.startsWith("serve.analytics_refresh.") && row.extra?.scan_mode !== undefined).map((row) => row.extra?.scan_mode);
  assert.deepEqual(modes, ["full", "continue", "continue", "continue"]);
  assert.equal(logs.at(-1)?.step, "serve.analytics_refresh.completed");
  assert.equal(logs.at(-1)?.extra?.rotations_remaining, 0);
  assert.deepEqual(next.current().invocationsByVerb, ONE_PASS_VERBS);
  assert.equal(readdirSync(dir).includes(".analytics-console-v1.progress.json"), false, "a finished fold removes its progress");
  assert.ok(existsSync(join(dir, ".analytics-console-v1.checkpoint.json")), "and leaves a checkpoint the next refresh resumes");
  await next.refresh();
  assert.equal(logs.at(-1)?.extra?.scan_mode, "resume");
});

test("unit test: an unreadable rotation read in an earlier leg still marks the finished fold unreadable", async () => {
  const dir = corpus();
  writeFileSync(join(dir, "ledger.2026-10-06T20-01-00-000Z.ndjson.gz"), "not gzip");
  const clock = steppingClock(1_000);
  const first = await analytics.scanAnalyticsLedger(dir, clock, undefined, undefined, { yieldAtMs: clock.now() }) as Partial;
  assert.equal(first.progress.unreadRotations, 1);
  const progress = JSON.parse(JSON.stringify(first.progress)) as analytics.AnalyticsResumePoint;
  const rest = await analytics.scanAnalyticsLedger(dir, clock, undefined, undefined, { progress }) as Complete;
  assert.equal(rest.scan?.mode, "continue");
  assert.equal(rest.snapshot.benchmarkEvidence.reason, "ledger-source-unreadable",
    "the leg that finishes must not claim a corpus a previous leg could not read");
});

test("unit test: a progress whose rotations changed underneath it is refused and the scan starts over", async () => {
  const dir = corpus();
  const clock = steppingClock(1_000);
  const first = await analytics.scanAnalyticsLedger(dir, clock, undefined, undefined, { yieldAtMs: clock.now() }) as Partial;
  writeFileSync(join(dir, "ledger.2026-10-06T20-01-00-000Z.ndjson.gz"), gzipSync(`${invoked("alpha", 0)}\n${invoked("echo", 0)}\n`));
  const rest = await analytics.scanAnalyticsLedger(dir, clock, undefined, undefined, { progress: first.progress }) as Complete;
  assert.equal(rest.scan?.mode, "full");
  assert.equal(rest.scan?.progressRefused, "archive-rewritten");
  assert.deepEqual(rest.snapshot.invocationsByVerb, { ...ONE_PASS_VERBS, echo: 1 });
});
