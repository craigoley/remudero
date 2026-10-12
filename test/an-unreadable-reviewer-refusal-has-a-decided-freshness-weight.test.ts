import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// Read off the namespace so this file loads at base, where the unreadable count does not exist yet.
import * as daemonModule from "../src/lib/daemon.js";
import type { DaemonFreshness } from "../src/lib/daemon.js";
import type { DeployWorthChange } from "../src/lib/deploy-judge.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { RunResult } from "../src/run-task.js";

/**
 * W1-T5530 — a verdict withheld because reviewer-code freshness is unprovable adds NO restart pressure,
 * and the decision row still counts it. Every unreadable refusal in the live ledger (12 distinct, 09-20
 * to 09-30) was `git fetch origin failed`: a ref-lock race on the shared .git, or a reflog the fetch could
 * not append to. A daemon restart cures neither, so a bound that drained for them would fire on a
 * condition the restart cannot fix.
 */

const OLD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const AT_ISO = "2026-10-03T15:29:13.000Z";
const AT_MS = Date.parse(AT_ISO);
const FETCH_RACE =
  "git fetch origin failed in /home/node/Remudero/worktrees/reviewer-e2926fd76b2e: error: cannot lock ref " +
  "'refs/remotes/origin/main': Unable to create '/home/node/Remudero/remudero/.git/refs/remotes/origin/main.lock': File exists.";

/** Change weight 2, below the busy threshold: only withheld pressure can turn this defer into a restart. */
const TWO_RUNTIME_CHANGES: readonly DeployWorthChange[] = [
  { sha: "c1".repeat(20), subject: "fix: a", files: ["src/lib/review.ts"] },
  { sha: "c2".repeat(20), subject: "fix: b", files: ["src/lib/inbox.ts"] },
];

type WithheldCount =
  | { kind: "counted"; withheld: number; unreadable?: number; unparseable: number }
  | { kind: "unreadable"; error: string };
const withheldReviewsSince = (
  daemonModule as unknown as { withheldReviewsSince: (read: () => readonly string[], sinceMs: number) => WithheldCount }
).withheldReviewsSince;

function stale(ts: string): string {
  return JSON.stringify({ ts, step: "review.post_refused", attempted_state: "success", reviewer_code_freshness: "stale", reviewer_code_sha: OLD_SHA });
}

function unprovable(ts: string): string {
  return JSON.stringify({ ts, step: "review.post_refused", attempted_state: "success", reviewer_code_freshness: "unreadable", reviewer_code_reason: FETCH_RACE });
}

test("W1-T5530: unreadable refusals since the stale reading get their own count, and the stale count is unchanged", () => {
  const counted = withheldReviewsSince(
    () => [
      unprovable("2026-10-03T15:00:00.000Z"), // before the stale reading: another episode
      stale(AT_ISO),
      unprovable(AT_ISO),
      unprovable("2026-10-03T15:31:00.000Z"),
      stale("2026-10-03T15:32:00.000Z"),
      JSON.stringify({ step: "review.post_refused", reviewer_code_freshness: "unreadable" }), // no ts
      JSON.stringify({ ts: AT_ISO, step: "review.posted", reviewer_code_freshness: "unreadable" }),
    ],
    AT_MS,
  );
  assert.deepEqual(counted, { kind: "counted", withheld: 2, unreadable: 2, unparseable: 0 });
  assert.deepEqual(withheldReviewsSince(() => [unprovable(AT_ISO)], AT_MS), { kind: "counted", withheld: 0, unreadable: 1, unparseable: 0 });
  assert.deepEqual(withheldReviewsSince(() => [], AT_MS), { kind: "counted", withheld: 0, unreadable: 0, unparseable: 0 });
});

// ── the daemon's call site ────────────────────────────────────────────────────────────────

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}unreadable-refusal-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });
const staleFreshness = (): DaemonFreshness => ({ stale: true, oldSha: OLD_SHA, newSha: NEW_SHA, changes: TWO_RUNTIME_CHANGES });

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
      checkFreshness: staleFreshness,
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

test("W1-T5530: unreadable refusals alone add no pressure — the busy daemon defers and the row names them", async () => {
  const made = await busyDaemonDecisions(() => [unprovable(AT_ISO), unprovable(AT_ISO)]);
  assert.equal(made[0]!.action, "defer", `a restart cannot cure a failed fetch (saw ${JSON.stringify(made)})`);
  assert.equal(made[0]!.busy, true);
  assert.equal(made[0]!.withheld_unreadable, 2, "the decision row never hides an unreadable refusal");
  assert.equal(made[0]!.withheld_reviews, 0);
  assert.equal(made[0]!.pressure, 2, "change 2 + staleness 0, with no withheld term");
  assert.equal(made[0]!.reason, "busy, and pressure 2 (change 2 + staleness 0) < 18: wait for an idle moment");
});

test("W1-T5530: beside stale refusals the restart is decided by the stale count alone", async () => {
  const made = await busyDaemonDecisions(() => [stale(AT_ISO), unprovable(AT_ISO), unprovable(AT_ISO), unprovable(AT_ISO)]);
  assert.equal(made[0]!.action, "restart");
  assert.equal(made[0]!.withheld_reviews, 1, "the stale count is unchanged by the unreadable rows");
  assert.equal(made[0]!.withheld_unreadable, 3);
  assert.match(String(made[0]!.reason), /busy, but 1 review\(s\) withheld for stale reviewer code/);
});

test("W1-T5530: a decision with no unreadable refusal reports a measured zero, never an absent field", async () => {
  const made = await busyDaemonDecisions(() => []);
  assert.equal(made[0]!.action, "defer");
  assert.equal(made[0]!.withheld_unreadable, 0);
  assert.equal(made[0]!.withheld_reviews, 0);
});
