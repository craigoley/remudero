import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  renderHeldReviewQueueBlocker,
  STALE_REVIEWER_SKIP_RESTART_STREAK,
  trackStaleReviewerSkipRecurrence,
  type StaleReviewerRecurrenceState,
} from "../src/lib/sweep.js";
import { priorStaleReviewerRecurrenceState, runDaemon } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { RunResult } from "../src/run-task.js";

/**
 * W1-T3691 — A review skipped for stale reviewer code retries forever and alarms nothing. Six
 * pull requests went unreviewed for over an hour behind a one-commit lag: `review.skipped_stale_
 * reviewer_code` (buildReviewerCodeFreshnessGate, src/run-task.ts) is re-derived every sweep,
 * forever, and on its own escalates to nothing. `trackStaleReviewerSkipRecurrence` (sweep.ts) is
 * the tiered response this task adds: silent on a single skip, visible-but-inert while held,
 * a freshness restart on sustained recurrence, and needs-human if that restart lands on the same
 * sha again. See plan/tasks.d/W1-T3691-*.yaml's design/acceptance for the five claims below.
 */

const OLD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER_SHA = "cccccccccccccccccccccccccccccccccccccccc";

// ── acceptance claim 2: a single stale-reviewer skip is silent ─────────────────────────────

test("a single stale-reviewer skip is silent", () => {
  const result = trackStaleReviewerSkipRecurrence({ codeSha: OLD_SHA, originMainSha: NEW_SHA }, undefined);
  assert.deepEqual(result.action, { kind: "silent" }, "the first sighting of any sha changes nothing");
  assert.deepEqual(result.state, { codeSha: OLD_SHA, streak: 1, restartRequested: false });
});

// ── acceptance claim 1: a repeated stale-reviewer skip requests a freshness restart ────────

test("a repeated stale-reviewer skip requests a freshness restart", () => {
  let state: StaleReviewerRecurrenceState | undefined;
  let action;
  for (let i = 0; i < STALE_REVIEWER_SKIP_RESTART_STREAK; i++) {
    ({ state, action } = trackStaleReviewerSkipRecurrence({ codeSha: OLD_SHA, originMainSha: NEW_SHA }, state));
    if (i < STALE_REVIEWER_SKIP_RESTART_STREAK - 1) {
      assert.notEqual(action!.kind, "restart", `sweep ${i + 1} is below the streak floor and must not ask yet`);
    }
  }
  assert.deepEqual(action, {
    kind: "restart",
    codeSha: OLD_SHA,
    originMainSha: NEW_SHA,
    streak: STALE_REVIEWER_SKIP_RESTART_STREAK,
  });
});

test("a repeated skip below the restart streak is 'held' -- visible before it is acted on", () => {
  const first = trackStaleReviewerSkipRecurrence({ codeSha: OLD_SHA, originMainSha: NEW_SHA }, undefined);
  const second = trackStaleReviewerSkipRecurrence({ codeSha: OLD_SHA, originMainSha: NEW_SHA }, first.state);
  assert.equal(second.action.kind, "held");
  assert.deepEqual(second.action, { kind: "held", codeSha: OLD_SHA, originMainSha: NEW_SHA, streak: 2 });
});

// ── acceptance claim 3: a new code sha resets the recurrence ───────────────────────────────

test("a new code sha resets the stale-reviewer recurrence", () => {
  let state: StaleReviewerRecurrenceState | undefined;
  ({ state } = trackStaleReviewerSkipRecurrence({ codeSha: OLD_SHA, originMainSha: NEW_SHA }, state));
  ({ state } = trackStaleReviewerSkipRecurrence({ codeSha: OLD_SHA, originMainSha: NEW_SHA }, state));
  assert.equal(state?.streak, 2, "sanity: two sightings of the same sha accumulated a streak");

  // The daemon moved to a NEW sha that is still (a different amount) behind origin/main.
  const moved = trackStaleReviewerSkipRecurrence({ codeSha: OTHER_SHA, originMainSha: NEW_SHA }, state);
  assert.deepEqual(moved.action, { kind: "silent" }, "a daemon that moved is not treated as stuck");
  assert.deepEqual(moved.state, { codeSha: OTHER_SHA, streak: 1, restartRequested: false });
});

test("no observation at all resets the recurrence outright", () => {
  const first = trackStaleReviewerSkipRecurrence({ codeSha: OLD_SHA, originMainSha: NEW_SHA }, undefined);
  const cleared = trackStaleReviewerSkipRecurrence(undefined, first.state);
  assert.deepEqual(cleared, { state: undefined, action: { kind: "silent" } });
});

// ── acceptance claim 4: an unchanged code sha after restart asks for a human ───────────────

test("an unchanged code sha after restart asks for a human", () => {
  // Simulates the state a fresh process reconstructs at boot (priorStaleReviewerRecurrenceState)
  // after it already asked for one freshness restart over this exact sha.
  const priorFromBoot: StaleReviewerRecurrenceState = { codeSha: OLD_SHA, streak: 1, restartRequested: true };
  const result = trackStaleReviewerSkipRecurrence({ codeSha: OLD_SHA, originMainSha: NEW_SHA }, priorFromBoot);
  assert.equal(result.action.kind, "needs_human");
  assert.equal((result.action as { codeSha: string }).codeSha, OLD_SHA);
  if (result.action.kind === "needs_human") {
    assert.match(result.action.reason, /same sha/i);
    assert.match(result.action.reason, /pinned/i);
  }
  // Never a SECOND restart request once needing a human.
  assert.equal(result.state?.restartRequested, true);
});

test("priorStaleReviewerRecurrenceState reconstructs a restart-already-requested sha from raw ledger lines", () => {
  const lines = [
    JSON.stringify({ step: "daemon.tick" }),
    "not json at all -- a torn write mid-append",
    JSON.stringify({ step: "review.stale_reviewer_restart_requested", code_sha: OLD_SHA, origin_main_sha: NEW_SHA, streak: 3 }),
  ];
  assert.deepEqual(priorStaleReviewerRecurrenceState(lines), { codeSha: OLD_SHA, streak: 1, restartRequested: true });
});

test("priorStaleReviewerRecurrenceState reads the NEWEST restart-requested marker, not the first", () => {
  const lines = [
    JSON.stringify({ step: "review.stale_reviewer_restart_requested", code_sha: OLD_SHA }),
    JSON.stringify({ step: "review.stale_reviewer_restart_requested", code_sha: OTHER_SHA }),
  ];
  assert.deepEqual(priorStaleReviewerRecurrenceState(lines), { codeSha: OTHER_SHA, streak: 1, restartRequested: true });
});

test("priorStaleReviewerRecurrenceState is undefined with no marker in the ledger", () => {
  assert.equal(priorStaleReviewerRecurrenceState([JSON.stringify({ step: "daemon.tick" })]), undefined);
  assert.equal(priorStaleReviewerRecurrenceState([]), undefined);
});

// ── acceptance claim 5: a held review queue renders with its sha and pull requests ─────────

test("a held review queue renders with its sha and pull requests", () => {
  const rendered = renderHeldReviewQueueBlocker({
    kind: "held_review_queue",
    codeSha: OLD_SHA,
    originMainSha: NEW_SHA,
    prNumbers: [5762, 5763, 5764],
    streak: 2,
  });
  assert.match(rendered, new RegExp(OLD_SHA.slice(0, 7)), "names the held code sha");
  assert.match(rendered, new RegExp(NEW_SHA.slice(0, 7)), "names origin/main's sha");
  assert.match(rendered, /#5762/);
  assert.match(rendered, /#5763/);
  assert.match(rendered, /#5764/);
});

test("a held review queue with no attributed pull requests still renders, naming none rather than guessing", () => {
  const rendered = renderHeldReviewQueueBlocker({
    kind: "held_review_queue",
    codeSha: OLD_SHA,
    originMainSha: NEW_SHA,
    prNumbers: [],
    streak: 2,
  });
  assert.match(rendered, /no pull requests attributed yet/);
});

// ── integration: the daemon's own tick loop reaches all four outcomes end to end ───────────

const PLAN_YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function fixturePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}stale-reviewer-recurrence-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, PLAN_YAML);
  return loadPlan(f);
}

function fakeClock(): { sleep: (ms: number) => Promise<void> } {
  return { sleep: async () => {} };
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.5, verdict: "merged" });

test("the daemon reports needing a human, not another restart, when it boots already having asked for one over this sha", async () => {
  const plan = fixturePlan();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let needsHumanCalls = 0;
  let sweepCalls = 0;

  const s = await runDaemon(plan, {
    refreshMerged: () => () => true, // nothing runnable -> idle every tick
    runOne: async (id) => okResult(id),
    sleep: fakeClock().sleep,
    log: (step, extra = {}) => lines.push({ step, extra }),
    // A prior process already asked for a freshness restart over OLD_SHA and this fresh
    // process boots to find the ledger says so.
    readLedgerLines: () => [
      JSON.stringify({ step: "review.stale_reviewer_restart_requested", code_sha: OLD_SHA, origin_main_sha: NEW_SHA }),
    ],
    checkStop: () => (++sweepCalls >= 2 ? "test done" : undefined),
    sweep: async () => ({ reviewerCodeStale: { oldSha: OLD_SHA, newSha: NEW_SHA } }),
    onStaleReviewerNeedsHuman: () => {
      needsHumanCalls++;
    },
  });

  // Never restarts again -- (design v): the daemon just keeps polling until the ordinary
  // checkStop path ends it, exactly as a pinned deployment that must not loop should.
  assert.equal(s.stopReason, "stopped");
  assert.equal(lines.filter((l) => l.step === "daemon_selfrestart_for_freshness").length, 0, "no second restart");
  assert.equal(lines.filter((l) => l.step === "review.stale_reviewer_restart_requested").length, 0, "not asked again");
  assert.ok(lines.some((l) => l.step === "review.stale_reviewer_needs_human"), "escalated as needing a human");
  assert.equal(needsHumanCalls, 1, "the hook fires once per stuck sha, not once per tick");
});

test("the daemon renders a held review queue on the board before it ever restarts", async () => {
  const plan = fixturePlan();
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let sweepCalls = 0;

  const s = await runDaemon(plan, {
    refreshMerged: () => () => true,
    runOne: async (id) => okResult(id),
    sleep: fakeClock().sleep,
    log: (step, extra = {}) => lines.push({ step, extra }),
    // Stop after exactly two sweep passes -- the second sighting is "held", never a restart.
    checkStop: () => (++sweepCalls >= 3 ? "test done" : undefined),
    sweep: async () => ({ reviewerCodeStale: { oldSha: OLD_SHA, newSha: NEW_SHA } }),
  });

  assert.equal(s.stopReason, "stopped");
  const held = lines.filter((l) => l.step === "review.stale_reviewer_held");
  assert.ok(held.length >= 1, "the second sighting rendered as a held review queue");
  assert.equal(held[0]?.extra.code_sha, OLD_SHA);
  assert.equal(held[0]?.extra.origin_main_sha, NEW_SHA);
  assert.match(String(held[0]?.extra.description), new RegExp(OLD_SHA.slice(0, 7)));
});
