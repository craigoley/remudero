import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// Read off the namespaces so this file loads at base, where the new exports do not exist yet.
import * as daemonModule from "../src/lib/daemon.js";
import * as judge from "../src/lib/deploy-judge.js";
import type { DaemonFreshness } from "../src/lib/daemon.js";
import type { DeployWorthChange } from "../src/lib/deploy-judge.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { RunResult } from "../src/run-task.js";

/**
 * W1-T5476 — 2026-10-03 15:29Z: the daemon deferred a freshness restart ("busy, and pressure 2 (change 2 +
 * staleness 0) < 18: wait for an idle moment") while the reviewer withheld every terminal verdict because
 * its code was materially behind origin/main. The in-flight reviews were what made the daemon busy. A
 * stale-reviewer refusal now counts toward the pressure, so the restart that unblocks the reviews fires.
 */

const OLD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const AT_ISO = "2026-10-03T15:29:13.000Z";
const AT_MS = Date.parse(AT_ISO);

/** Two runtime-reaching advances outside the daemon's own code: change weight 2, as on 2026-10-03. */
const TWO_RUNTIME_CHANGES: readonly DeployWorthChange[] = [
  { sha: "c1".repeat(20), subject: "fix: a", files: ["src/lib/review.ts"] },
  { sha: "c2".repeat(20), subject: "fix: b", files: ["src/lib/inbox.ts"] },
];

type WithheldCount = { kind: "counted"; withheld: number; unreadable: number; unparseable: number } | { kind: "unreadable"; error: string };
const withheldReviewsSince = (
  daemonModule as unknown as { withheldReviewsSince: (read: () => readonly string[], sinceMs: number) => WithheldCount }
).withheldReviewsSince;

const decide = (withheldReviews?: number) =>
  judge.decideFreshnessRestart({
    changes: TWO_RUNTIME_CHANGES,
    busy: true,
    staleSinceMs: AT_MS,
    nowMs: AT_MS,
    state: { total: 0, scoredShas: [] },
    ...(withheldReviews === undefined ? {} : { withheldReviews }),
  } as Parameters<typeof judge.decideFreshnessRestart>[0]);

function refusal(ts: string, freshness: "stale" | "unreadable" = "stale", step = "review.post_refused"): string {
  return JSON.stringify({ ts, step, attempted_state: "success", reviewer_code_freshness: freshness, reviewer_code_sha: OLD_SHA });
}

test("W1-T5476: a stale-reviewer refusal turns a busy defer into a restart that names the withheld reviews", () => {
  const before = decide();
  assert.equal(before.action, "defer", "the 2026-10-03 shape: change 2 + staleness 0 defers while busy");
  assert.equal(before.reason, "busy, and pressure 2 (change 2 + staleness 0) < 18: wait for an idle moment");

  const after = decide(1);
  assert.equal(after.action, "restart");
  assert.equal(after.weight, 2, "the change weight is untouched");
  assert.equal(after.agePressure, 0, "the staleness pressure is untouched");
  assert.ok(after.pressure >= judge.DEPLOY_RESTART_SCORE_THRESHOLD.value, `pressure ${after.pressure} reaches the threshold`);
  assert.match(after.reason, /busy, but 1 review\(s\) withheld for stale reviewer code/);
  assert.match(after.reason, /drain and restart$/);
  assert.equal(decide(3).reason.startsWith("busy, but 3 review(s) withheld"), true);
});

test("W1-T5476: with no refusal the pressure arithmetic and reason are byte-identical to before", () => {
  const absent = decide();
  assert.deepEqual(decide(0), absent);
  assert.equal(absent.weight, 2);
  assert.equal(absent.agePressure, 0);
  assert.equal(absent.pressure, 2);
  assert.equal(absent.reason, "busy, and pressure 2 (change 2 + staleness 0) < 18: wait for an idle moment");
  // An idle daemon restarts at once either way; its reason does not change with the count.
  const idle = judge.decideFreshnessRestart({
    changes: TWO_RUNTIME_CHANGES,
    busy: false,
    staleSinceMs: AT_MS,
    nowMs: AT_MS,
    state: { total: 0, scoredShas: [] },
    withheldReviews: 2,
  } as Parameters<typeof judge.decideFreshnessRestart>[0]);
  assert.equal(idle.action, "restart");
  assert.equal(idle.reason, "idle: nothing in flight, so the restart costs only a boot");
});

test("W1-T5476: only stale-reviewer refusals since the stale reading count, and a torn line is named", () => {
  assert.equal(typeof withheldReviewsSince, "function", "daemon.ts exports withheldReviewsSince");
  const counted = withheldReviewsSince(
    () => [
      refusal("2026-10-03T15:00:00.000Z"), // before the stale reading: another episode
      refusal(AT_ISO),
      refusal("2026-10-03T15:30:00.000Z"),
      refusal("2026-10-03T15:31:00.000Z", "unreadable"), // unprovable, not stale
      refusal("2026-10-03T15:32:00.000Z", "stale", "review.posted"),
      JSON.stringify({ step: "review.post_refused", reviewer_code_freshness: "stale" }), // no ts
      '{"ts":"2026-10-03T15:33:00.000Z","step":"review.post_refused","reviewer_code_fresh', // torn
      JSON.stringify({ ts: AT_ISO, step: "daemon.idle_reasons" }),
    ],
    AT_MS,
  );
  assert.deepEqual(counted, { kind: "counted", withheld: 2, unreadable: 1, unparseable: 1 });
  assert.deepEqual(withheldReviewsSince(() => [], AT_MS), { kind: "counted", withheld: 0, unreadable: 0, unparseable: 0 });
  const unreadable = withheldReviewsSince(() => {
    throw new Error("ENOENT: no ledger");
  }, AT_MS);
  assert.deepEqual(unreadable, { kind: "unreadable", error: "ENOENT: no ledger" }, "a failed read is not a zero");
});

// ── the daemon's call site ────────────────────────────────────────────────────────────────

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}withheld-review-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });
const stale = (): DaemonFreshness => ({ stale: true, oldSha: OLD_SHA, newSha: NEW_SHA, changes: TWO_RUNTIME_CHANGES });

type Line = { step: string; extra: Record<string, unknown> };

/** A daemon kept busy by a full pass that never finishes on its own, until a restart is decided. */
async function busyDaemonDecisions(readLedgerLines: () => readonly string[]): Promise<Record<string, unknown>[]> {
  const lines: Line[] = [];
  let releaseSweep: (() => void) | undefined;
  let passes = 0;
  let waits = 0;
  const done = daemonModule.runDaemon(
    fixturePlan(),
    {
      refreshMerged: () => () => true,
      runOne: async (id) => okResult(id),
      now: () => new Date(AT_MS),
      sleep: async () => {
        waits++;
        if (waits >= 4) releaseSweep?.();
      },
      log: (step, extra = {}) => {
        lines.push({ step, extra });
        if (step === "daemon.freshness_decision" && extra.action === "restart") setTimeout(() => releaseSweep?.(), 5);
      },
      sweep: async () => {
        passes++;
        if (passes === 1) await new Promise<void>((resolve) => (releaseSweep = resolve));
        return {};
      },
      checkFreshness: stale,
      readLedgerLines,
    },
    { sweepWallClockBoundMs: 60_000 },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"timed-out">((resolve) => (timer = setTimeout(() => resolve("timed-out"), 5_000)));
  const summary = await Promise.race([done, bound]).finally(() => clearTimeout(timer));
  releaseSweep?.();
  assert.notEqual(summary, "timed-out");
  return lines.filter((l) => l.step === "daemon.freshness_decision").map((l) => l.extra);
}

test("W1-T5476: the daemon passes the withheld count and logs it on the freshness decision", async () => {
  const made = await busyDaemonDecisions(() => [refusal(AT_ISO), refusal(AT_ISO)]);
  assert.equal(made[0]!.action, "restart", `a busy daemon restarts for the withheld reviews (saw ${JSON.stringify(made)})`);
  assert.equal(made[0]!.busy, true);
  assert.equal(made[0]!.withheld_reviews, 2);
  assert.equal(made[0]!.withheld_reviews_unparseable, undefined);
  assert.match(String(made[0]!.reason), /2 review\(s\) withheld for stale reviewer code/);
});

test("W1-T5476: no refusal leaves the busy daemon deferring, and a torn line is counted on the row", async () => {
  const made = await busyDaemonDecisions(() => ['{"step":"review.post_refused","tor']);
  assert.equal(made[0]!.action, "defer");
  assert.equal(made[0]!.busy, true);
  assert.equal(made[0]!.withheld_reviews, 0);
  assert.equal(made[0]!.withheld_reviews_unparseable, 1);
  assert.equal(made[0]!.reason, "busy, and pressure 2 (change 2 + staleness 0) < 18: wait for an idle moment");
});

test("W1-T5476: an unreadable ledger is named on the row and decides on today's arithmetic", async () => {
  let reads = 0;
  const made = await busyDaemonDecisions(() => {
    // The boot read succeeds; every later read fails, as a ledger that became unreadable mid-life would.
    if (reads++ === 0) return [];
    throw new Error("EACCES: ledger unreadable");
  });
  assert.equal(made[0]!.action, "defer");
  assert.equal(made[0]!.withheld_reviews, undefined, "an unread count is not a zero");
  assert.match(String(made[0]!.withheld_reviews_error), /EACCES: ledger unreadable/);
});
