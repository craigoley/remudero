import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  retroTriggerCheck,
  recordRetroAttempt,
  recentRetroAttempt,
  retroAttemptPath,
  RETRO_ATTEMPT_RETRY_MS,
} from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import {
  saveMarker,
  evaluateRetroBackoff,
  nextRetroAttemptRecord,
  loadRetroAttemptRecord,
  defaultRetroBackoffPolicy,
  type ShippedGithub,
} from "../src/lib/retro.js";

// ── W1-T4664 — A RETRO THAT FAILS PREPUBLISH RE-FIRES EVERY POLL ───────────────────────
//
// The marker only advances on a successful publish (by design — the runs a failed retro read
// are still unconsumed), so a failing prepublish leaves mergesSinceMarker frozen over threshold
// and `evaluateRetroTrigger` fires again on the very next poll: 24 of 37 retros 2026-09-25..28
// re-fired inside the hour, each a full 379-suite Opus attempt. This file proves the tiered
// backoff (src/lib/retro.ts's `evaluateRetroBackoff`, wired through `retroTriggerCheck`):
// a failed attempt is remembered and the next trigger is declined until a growing interval (or,
// pure-unit-level, "a further threshold's worth of merges") justifies another, and a PUBLISHED
// retro (the marker moving) resets the back-off entirely.

function healthyGithub(): ShippedGithub {
  return {
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    unavailable: () => undefined,
  };
}

function fixtureRoot(): { config: Config; markerPath: string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}retro-backoff-`));
  mkdirSync(join(root, "state"), { recursive: true });
  const config: Config = { claudeBin: "/bin/true", root };
  return { config, markerPath: join(root, "state", "last-retro.json") };
}

test("W1-T4664: a retro that failed prepublish does not re-fire on the next poll", () => {
  const { config, markerPath } = fixtureRoot();
  const markerTs = "2026-09-25T00:00:00.000Z";
  saveMarker(markerPath, { ts: markerTs, learnings_count: 0, runs_seen: 0 });

  // The retro FIRED, spent ~11 minutes on a 379-suite Opus attempt, and FAILED prepublish — the
  // marker stays frozen by design (run-task.ts's prepublish preflight never calls saveMarker on
  // failure). `recordRetroAttempt` is exactly what the daemon's real hook calls right before
  // every spawn (buildRetroDaemonHooks's default arm), success or failure alike.
  const firstAttemptAt = new Date("2026-09-25T12:00:00.000Z");
  recordRetroAttempt(config.root, firstAttemptAt, 30);

  // The very next poll, ~50 minutes later (the measured incident's own cadence) — well inside
  // the 6h fence — must NOT see the trigger fire again.
  const nextPoll = new Date(firstAttemptAt.getTime() + 50 * 60 * 1000);
  const github = healthyGithub();
  const decision = retroTriggerCheck(nextPoll, { config, github });
  assert.equal(decision, undefined, "a poll inside the back-off window declines rather than re-firing");
  assert.equal(
    recentRetroAttempt(config.root, markerTs, nextPoll),
    true,
    "the attempt fence still reports itself recent for this marker cycle",
  );

  // The persisted record carries what the daemon needs to compute the back-off: when, the merge
  // count observed, and the streak (design (i): "records its attempt (merge count seen, when,
  // why) in state the trigger reads").
  const record = loadRetroAttemptRecord(retroAttemptPath(config.root));
  assert.ok(record, "an attempt record was persisted");
  assert.equal(record!.markerTs, markerTs);
  assert.equal(record!.mergesSinceMarker, 30);
  assert.equal(record!.streak, 1);

  // TIERED, NO FIXED CEILING (design (ii)): a SECOND consecutive failed attempt in the same
  // marker cycle doubles the wait rather than repeating the same flat fence.
  recordRetroAttempt(config.root, nextPoll, 31);
  const secondRecord = loadRetroAttemptRecord(retroAttemptPath(config.root));
  assert.equal(secondRecord!.streak, 2, "a second failure in the same cycle grows the streak");

  const justPastFlatFence = new Date(nextPoll.getTime() + RETRO_ATTEMPT_RETRY_MS + 1);
  const stillBackedOff = evaluateRetroBackoff(secondRecord, secondRecord!.mergesSinceMarker, markerTs, justPastFlatFence, defaultRetroBackoffPolicy());
  assert.equal(
    stillBackedOff.eligible,
    false,
    "the SECOND failure's wait exceeds the original flat fence — it must have doubled, not repeated it",
  );
  const doubledElapsed = new Date(nextPoll.getTime() + 2 * RETRO_ATTEMPT_RETRY_MS + 1);
  const eligibleAfterDouble = evaluateRetroBackoff(secondRecord, secondRecord!.mergesSinceMarker, markerTs, doubledElapsed, defaultRetroBackoffPolicy());
  assert.equal(eligibleAfterDouble.eligible, true, "eligibility opens once the DOUBLED delay has actually elapsed");
});

test("W1-T4664: a published retro resets the back-off", () => {
  const { config, markerPath } = fixtureRoot();
  const originalMarkerTs = "2026-09-25T00:00:00.000Z";
  saveMarker(markerPath, { ts: originalMarkerTs, learnings_count: 0, runs_seen: 0 });

  // Two consecutive failed attempts build up a streak and a growing wait, exactly like the test
  // above.
  const firstAttemptAt = new Date("2026-09-25T12:00:00.000Z");
  recordRetroAttempt(config.root, firstAttemptAt, 30);
  const secondAttemptAt = new Date(firstAttemptAt.getTime() + 50 * 60 * 1000);
  recordRetroAttempt(config.root, secondAttemptAt, 31);
  const beforePublish = loadRetroAttemptRecord(retroAttemptPath(config.root));
  assert.equal(beforePublish!.streak, 2);

  const stillBackedOffMs = new Date(secondAttemptAt.getTime() + 60 * 60 * 1000);
  assert.equal(
    recentRetroAttempt(config.root, originalMarkerTs, stillBackedOffMs),
    true,
    "one hour after the second failure, still well inside even the ORIGINAL flat fence",
  );

  // Now the retro PUBLISHES — the marker moves forward, exactly as `saveMarker` does on a real
  // successful publish. Design (ii): "a published retro resets both."
  const publishedMarkerTs = "2026-09-28T09:00:00.000Z";
  saveMarker(markerPath, { ts: publishedMarkerTs, learnings_count: 3, runs_seen: 12 });

  // The very next poll after publication, only a minute later — nowhere near any delay this
  // file's own math would compute — must NOT be declined: a fresh cycle earns a fresh attempt.
  const rightAfterPublish = new Date("2026-09-28T09:01:00.000Z");
  assert.equal(
    recentRetroAttempt(config.root, publishedMarkerTs, rightAfterPublish),
    false,
    "a moved marker (a publish) is a different cycle — the OLD attempt record no longer fences it",
  );

  const decision = retroTriggerCheck(rightAfterPublish, { config, github: healthyGithub() });
  assert.notEqual(decision, undefined, "the trigger evaluates again on the new cycle rather than staying declined forever");

  // The pure predicate agrees for the same reason: a differing markerTs is always eligible.
  const record = loadRetroAttemptRecord(retroAttemptPath(config.root));
  const freshCycle = evaluateRetroBackoff(record, 0, publishedMarkerTs, rightAfterPublish, defaultRetroBackoffPolicy());
  assert.equal(freshCycle.eligible, true, "evaluateRetroBackoff itself treats a moved marker as always eligible");

  // And `nextRetroAttemptRecord` — what a THIRD attempt (now on the new cycle) would persist —
  // resets the streak to 1 rather than continuing to climb from 2.
  const thirdRecord = nextRetroAttemptRecord(record, rightAfterPublish, publishedMarkerTs, 0);
  assert.equal(thirdRecord.streak, 1, "a fresh marker cycle resets the streak, not just the clock");
});

test("W1-T4664: evaluateRetroBackoff — a further threshold's worth of merges also opens an early exit", () => {
  // expiring-fixture: exempt -- this pure predicate receives a pinned now five minutes after the attempt.
  const attempt = { retroAttemptAt: "2026-09-25T12:00:00.000Z", markerTs: "2026-09-25T00:00:00.000Z", mergesSinceMarker: 30, streak: 1 };
  const soonAfter = new Date("2026-09-25T12:05:00.000Z"); // 5 minutes later — nowhere near the 6h delay
  const policy = { baseDelayMs: RETRO_ATTEMPT_RETRY_MS, mergesThreshold: 25 };

  const stillFew = evaluateRetroBackoff(attempt, 40, attempt.markerTs, soonAfter, policy);
  assert.equal(stillFew.eligible, false, "40 merges is short of the 30+25=55 floor — still backed off");

  const enoughMerges = evaluateRetroBackoff(attempt, 55, attempt.markerTs, soonAfter, policy);
  assert.equal(enoughMerges.eligible, true, "55 merges clears the floor — eligible well before the clock would allow it");
});

test("W1-T4664: retroTriggerCheck widens the merges reading with a cheap (non-GitHub) read before declining", () => {
  const { config, markerPath } = fixtureRoot();
  const markerTs = "2026-09-25T00:00:00.000Z";
  saveMarker(markerPath, { ts: markerTs, learnings_count: 0, runs_seen: 0 });

  const firstAttemptAt = new Date("2026-09-25T12:00:00.000Z");
  // A low mergesThreshold (via the default retro policy) keeps this test's fixture small; the
  // real floor for the DEFAULT policy is the attempt's own count plus the policy's threshold, so
  // this attempt starts the streak at 0 merges to keep the arithmetic obvious.
  recordRetroAttempt(config.root, firstAttemptAt, 0);

  const soonAfter = new Date(firstAttemptAt.getTime() + 5 * 60 * 1000); // 5 minutes — far inside the 6h delay
  let githubReads = 0;
  // `mergedCommits()` is this repo's own `git log` (never a GitHub round-trip) — plenty of
  // untrailered commits after the marker, well past ANY reasonable merges threshold.
  const manyRunlessMerges: ShippedGithub = {
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    unavailable: () => { githubReads += 1; return undefined; },
    mergedCommits: () => Array.from({ length: 40 }, (_, i) => ({ date: `2026-09-26T00:00:0${i % 10}.000Z`, message: `commit ${i}` })),
  };

  const decision = retroTriggerCheck(soonAfter, { config, github: manyRunlessMerges });
  assert.notEqual(
    decision,
    undefined,
    "40 runless merges since the attempt clears the merges floor — the trigger proceeds past the doubling delay",
  );
  assert.equal(githubReads, 1, "clearing the merges floor let the normal (GitHub-backed) evaluation proceed, exactly once");
});
