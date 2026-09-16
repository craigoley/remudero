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
 *
 * W1-T3697 — THE ONCE-PER-PASS CACHE COULD NOT SEE ITS OWN TARGET CASE. A pass that BEGAN fresh
 * and went stale mid-flight (the shape W1-T3618's own measurement recorded — four withholds
 * inside one cycle that began fresh) still paid in full for every remaining PR, because the gate
 * above cached its first read for the rest of the pass. The block below drives the three
 * mid-pass-transition cases the once-per-pass cache could never exercise: the cache is gone, and
 * `readFreshness` is now called once PER `call()` invocation — i.e. once per PR, immediately
 * before the spend it guards — so a reading that changes between two PRs is observed by the
 * second PR even though the first already ran.
 */

const OLD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function staleReading(): ReviewerCodeFreshness {
  return { status: "stale", codeSha: OLD_SHA, originMainSha: NEW_SHA, changedPaths: ["src/lib/review.ts"] };
}

function freshReading(): ReviewerCodeFreshness {
  return { status: "fresh", codeSha: NEW_SHA, originMainSha: NEW_SHA, advance: "none" };
}

// ── claim 1: a pass that begins stale still skips every PR it sees ─────────────────────────

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

  // W1-T3697: the once-per-pass cache is gone — `readFreshness` is now called once PER `call()`,
  // immediately before the spend it guards, so a pass that STAYS stale reads three times, not one.
  assert.equal(freshnessReads, 3, "read once per PR, immediately before the spend — never cached across a pass");
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

test("W1-T3618/W1-T3697: a pass that stays fresh still reaches every PR — the gate never over-fires", async () => {
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

  // W1-T3697: re-read per PR applies on the fresh path too — no cache means no stale-cache risk.
  assert.equal(freshnessReads, 3, "read once per PR — no cache to short-circuit the re-read");
  assert.equal(materializations, 3, "every PR reaches `next` when the reading is fresh");
  assert.equal(gate.staleThisPass(), undefined);
});

test("W1-T3618/W1-T3697: an unreadable reading still attempts the review, never toward refusing it", async () => {
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

// ── W1-T3697's own target case: fresh at the top of the pass, stale mid-flight ──────────────

test("W1-T3697: a reading that goes stale mid-pass skips the remaining PRs", async () => {
  // This is the exact shape the once-per-pass cache could never observe: the FIRST PR this pass
  // sees a fresh reading and runs; by the SECOND PR, origin/main has advanced past the checked-out
  // reviewer code, and every PR from there on must be skipped rather than paid for in full and
  // discarded later by W1-T228's late guard.
  let freshnessReads = 0;
  let materializations = 0;
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const readings: ReviewerCodeFreshness[] = [freshReading(), staleReading(), staleReading()];
  const gate = buildReviewerCodeFreshnessGate(
    () => {
      const reading = readings[freshnessReads] ?? staleReading();
      freshnessReads++;
      return reading;
    },
    (step, extra) => logged.push({ step, extra }),
    async () => {
      materializations++;
      return 0;
    },
  );

  const first = await gate.call("401", [], {});
  const second = await gate.call("402", [], {});
  const third = await gate.call("403", [], {});

  assert.equal(freshnessReads, 3, "re-read before every PR — the mid-pass transition is observed");
  assert.equal(materializations, 1, "only the PR that ran under a FRESH reading materializes anything");
  assert.deepEqual([first, second, third], [0, 0, 0], "skipped PRs still resolve cleanly, not throw");
  assert.equal(logged.length, 2, "the two PRs read after the transition are ledgered as skipped, the first is not");
  for (const line of logged) {
    assert.equal(line.step, "review.skipped_stale_reviewer_code");
    assert.equal(line.extra?.code_sha, OLD_SHA);
    assert.equal(line.extra?.origin_main_sha, NEW_SHA);
  }
  assert.deepEqual(
    gate.staleThisPass(),
    { oldSha: OLD_SHA, newSha: NEW_SHA },
    "the pass-level signal still fires from the FIRST stale read, even though it was not the first PR",
  );
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

test("W1-T3618: a stale reviewer signals the daemon to stop for freshness, with NO checkFreshness dependency at all", async () => {
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

  assert.equal(s.stopReason, "stale", "a mid-pass reviewer-code discovery ends the cycle through the freshness-stop path");
  const restartLine = lines.find((l) => l.step === "daemon_selfrestart_for_freshness");
  assert.ok(restartLine, "the stop is ledgered under the SAME distinct step a checkFreshness-driven restart uses");
  assert.equal(restartLine?.extra.old_sha, OLD_SHA);
  assert.equal(restartLine?.extra.new_sha, NEW_SHA);
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
