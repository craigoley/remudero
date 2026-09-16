import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildReviewerCodeFreshnessGate, type RunResult } from "../src/run-task.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { runDaemon } from "../src/lib/daemon.js";
import type { ReviewerCodeFreshness } from "../src/lib/self-sync.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

/**
 * W1-T3618 — THE REVIEWER PAYS IN FULL AND THEN DISCARDS THE VERDICT.
 *
 * `reviewerCodeFreshness` used to be read as the LAST thing `runReview` did, immediately before
 * `postReviewStatusGuarded` — after a worktree was materialized, every whitelisted proof had
 * executed against it, and the reviewer worker had already been spawned. A stale reading then
 * withheld the verdict it had just paid in full for. MEASURED on the Azure fleet host over four
 * hours: 8 terminal verdicts computed and discarded, 6 of them `success` — a PR that had earned
 * its green sat unmergeable and was re-reviewed, at full price, on a later pass.
 *
 * These tests drive the two halves of the fix directly:
 *  (1) `buildReviewerCodeFreshnessGate` (src/run-task.ts) — the once-per-pass read hoisted in
 *      FRONT of the spend, so a stale reading never reaches the function that would materialize a
 *      worktree, execute a proof or spawn a reviewer.
 *  (2) `runDaemon` (src/lib/daemon.ts) — the sweep's own stale discovery reaching the SAME
 *      pre-admission freshness re-check a `checkFreshness`-driven stale reading already uses, so
 *      the cycle ends through the existing `cyclesEntered > 0` gate rather than idling on code
 *      that already paid for a verdict it could never publish, while dispatch of new work (W1-T2965)
 *      is preserved.
 *
 * W1-T228 IS UNTOUCHED. The publication guard (`reviewerCodePublicationRefusal`, src/lib/review.ts)
 * keeps deciding whether a COMPUTED verdict may post; these tests are about what happens BEFORE
 * that verdict is ever computed, never about the guard itself — see the PR body's grep proof.
 */

const OLD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function staleReading(): ReviewerCodeFreshness {
  return { status: "stale", codeSha: OLD_SHA, originMainSha: NEW_SHA, changedPaths: ["src/lib/review.ts"] };
}

function freshReading(): ReviewerCodeFreshness {
  return { status: "fresh", codeSha: NEW_SHA, originMainSha: NEW_SHA, advance: "none" };
}

// ── claim 1: the gate reads freshness once and materializes nothing when stale ─────────────

test("W1-T3618: a stale reviewer reads freshness once and materializes nothing, across three PRs", async () => {
  let freshnessReads = 0;
  let materializations = 0;
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const gate = buildReviewerCodeFreshnessGate(
    () => {
      freshnessReads++;
      return staleReading();
    },
    (step, extra) => logged.push({ step, extra }),
    // The counting fake stands in for `reviewCommand` — the ONE function that actually
    // materializes a worktree, executes a whitelisted proof and spawns a reviewer. If this gate
    // ever let a stale reading through, this counter would move.
    async () => {
      materializations++;
      return 0;
    },
  );

  const results = await Promise.all([
    gate.call("101", [], {}),
    gate.call("102", [], {}),
    gate.call("103", [], {}),
  ]);

  assert.equal(freshnessReads, 1, "exactly ONE freshness read for three PRs — never re-read per PR");
  assert.equal(materializations, 0, "ZERO materializations — the stale reading never reaches `next`");
  assert.deepEqual(results, [0, 0, 0], "each skipped PR resolves cleanly rather than throwing");
  assert.equal(logged.length, 3, "the skip is ledgered once PER PR, never silent");
  for (const line of logged) {
    assert.equal(line.step, "review.skipped_stale_reviewer_code");
    assert.equal(line.extra?.code_sha, OLD_SHA);
    assert.equal(line.extra?.origin_main_sha, NEW_SHA);
  }
  assert.deepEqual(gate.staleThisPass(), { oldSha: OLD_SHA, newSha: NEW_SHA });
});

// ── the falsifier's other arm: a FRESH reading changes nothing about the ordinary path ─────

test("W1-T3618: a fresh reviewer reading calls `next` for every PR, unchanged — the gate never over-fires", async () => {
  let freshnessReads = 0;
  let materializations = 0;
  const gate = buildReviewerCodeFreshnessGate(
    () => {
      freshnessReads++;
      return freshReading();
    },
    () => {},
    async () => {
      materializations++;
      return 0;
    },
  );

  await gate.call("201", [], {});
  await gate.call("202", [], {});
  await gate.call("203", [], {});

  assert.equal(freshnessReads, 1, "still read once — the cache applies on the fresh path too");
  assert.equal(materializations, 3, "every PR reaches `next` when the reading is fresh");
  assert.equal(gate.staleThisPass(), undefined);
});

test("W1-T3618: an unreadable freshness reading fails toward attempting the review, never toward refusing it", async () => {
  let materializations = 0;
  const gate = buildReviewerCodeFreshnessGate(
    () => ({ status: "unreadable", reason: "git fetch origin failed" }),
    () => {},
    async () => {
      materializations++;
      return 0;
    },
  );

  await gate.call("301", [], {});
  assert.equal(materializations, 1, "unreadable is not stale — the review still runs, matching checkReviewerCodeFreshness's own contract");
  assert.equal(gate.staleThisPass(), undefined);
});

// ── claim 2 & 3: the daemon's own reaction to a stale sweep discovery ───────────────────────

const PLAN_YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: B
  title: b
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}review-freshness-stops-before-it-spends-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, PLAN_YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });

function fakeClock(): { sleep: (ms: number) => Promise<void> } {
  return { sleep: async () => {} };
}

test("W1-T3618: a stale review cycle still dispatches work — W1-T2965 is preserved", async () => {
  const plan = fixturePlan();
  let runOneCalls = 0;
  let sweepCalls = 0;

  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => () => false, // both A and B are runnable
      runOne: async (id) => {
        runOneCalls++;
        return okResult(id);
      },
      sleep: fakeClock().sleep,
      // The sweep discovers reviewer-code staleness on EVERY pass — the daemon must still dispatch
      // the batch it already selected rather than trading that progress away (W1-T2965).
      sweep: async () => {
        sweepCalls++;
        return { reviewerCodeStale: { oldSha: OLD_SHA, newSha: NEW_SHA } };
      },
    },
    { max: 1 },
  );

  assert.equal(s.stopReason, "max_reached");
  assert.deepEqual(s.attempted, ["A"], "the selected task is admitted and runs despite the stale sweep signal");
  assert.equal(runOneCalls, 1);
  assert.ok(sweepCalls >= 1, "the sweep really ran and really returned the stale signal this test asserts on");
});

test("W1-T3618/W1-T3691: a SUSTAINED stale reviewer signal (not a single one) stops the daemon for freshness, with NO checkFreshness dependency at all", async () => {
  const plan = fixturePlan();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];

  const s = await runDaemon(plan, {
    refreshMerged: () => () => true, // nothing runnable this tick -> dispatchSet is empty
    runOne: async (id) => okResult(id),
    sleep: fakeClock().sleep,
    log: (step, extra = {}) => lines.push({ step, extra }),
    // No `checkFreshness` dep is wired here at all — the stop below can only be driven by the
    // sweep's OWN discovery, proving this is a genuinely new signal path, not a coincidence of the
    // pre-existing self-freshness re-check.
    sweep: async () => ({ reviewerCodeStale: { oldSha: OLD_SHA, newSha: NEW_SHA } }),
  });

  assert.equal(s.stopReason, "stale", "sustained recurrence still ends the cycle through the freshness-stop path");
  const restartLine = lines.find((l) => l.step === "daemon_selfrestart_for_freshness");
  assert.ok(restartLine, "the stop is ledgered under the SAME distinct step a checkFreshness-driven restart uses");
  assert.equal(restartLine?.extra.old_sha, OLD_SHA);
  assert.equal(restartLine?.extra.new_sha, NEW_SHA);
  // W1-T3691 (design iv): the FIRST couple of sightings must not have stopped anything — only
  // the held marker, never a restart, until the streak crosses the floor.
  const heldLines = lines.filter((l) => l.step === "review.stale_reviewer_held");
  assert.ok(heldLines.length >= 1, "the recurrence was visible before it was acted on");
  const requestedLine = lines.find((l) => l.step === "review.stale_reviewer_restart_requested");
  assert.ok(requestedLine, "the eventual restart is ledgered under its own W1-T3691 marker too");
});

test("W1-T3691: a SINGLE stale reviewer sighting changes nothing — no stop, no held row, no restart marker", async () => {
  const plan = fixturePlan();
  const lines: Array<{ step: string }> = [];
  let sweepCalls = 0;

  const s = await runDaemon(plan, {
    refreshMerged: () => () => true,
    runOne: async (id) => okResult(id),
    sleep: fakeClock().sleep,
    log: (step) => lines.push({ step }),
    // `checkStop` is consulted at the TOP of every tick, before `sweep` runs (W1-T1274) — so
    // letting it through once (the first top-of-loop check) and only THEN stopping lets exactly
    // one sweep pass run, a single sighting that never gets a chance to recur.
    checkStop: () => (++sweepCalls >= 2 ? "test done after one sweep pass" : undefined),
    sweep: async () => ({ reviewerCodeStale: { oldSha: OLD_SHA, newSha: NEW_SHA } }),
  });

  assert.equal(s.stopReason, "stopped", "a single sighting never itself ends the cycle for freshness");
  assert.equal(lines.filter((l) => l.step === "daemon_selfrestart_for_freshness").length, 0);
  assert.equal(lines.filter((l) => l.step === "review.stale_reviewer_held").length, 0);
  assert.equal(lines.filter((l) => l.step === "review.stale_reviewer_restart_requested").length, 0);
});

test("W1-T3618: an ordinary sweep with no reviewer-code signal never triggers a freshness stop", async () => {
  const plan = fixturePlan();
  const lines: Array<{ step: string }> = [];
  let sweepCalls = 0;

  const s = await runDaemon(plan, {
    refreshMerged: () => () => true,
    runOne: async (id) => okResult(id),
    sleep: fakeClock().sleep,
    log: (step) => lines.push({ step }),
    checkStop: () => (++sweepCalls >= 3 ? "test done" : undefined),
    sweep: async () => {
      // Every existing production `sweep` hook that predates this task resolves `void` — this must
      // change nothing about a healthy pass.
    },
  });

  assert.equal(s.stopReason, "stopped");
  assert.equal(lines.filter((l) => l.step === "daemon_selfrestart_for_freshness").length, 0);
});
