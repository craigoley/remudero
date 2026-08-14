import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// W1-T300 (the #1184/#1185 duplicate-triage race). MEASURED 2026-08-03: feedback#fb-1784762630201-
// 4751e0 was triaged TWICE, PRs #1184 and #1185, 5m34s apart — because a feedback entry's `status`
// only advances when its triage PR MERGES, and between dispatch and merge the entry still reads
// `status: new`, so the next idle fire re-selects the same head. This is an IN-FLIGHT gap, not a
// missing dedup, so the fix mirrors the task lane's `isOpenPr`/`readLiveState` pair (W1-T80/W1-T177)
// but keyed on FEEDBACK id: `deps.isFeedbackOpenPr` reports the open PR carrying this id's
// `origin: feedback#<id>` provenance, and `deps.readFeedbackLiveState` confirms a cached OPEN with a
// fresh read before the skip, exactly like the task lane's own guard.

function tmp(p: string): string {
  return mkdtempSync(join(tmpdir(), p));
}

/**
 * Two tasks DECLARING THE SAME FILE, so `partitionByFileOverlap` defers the second on every pass.
 *
 * W1-T469 — WHY THIS IS A COLLIDING PAIR AND NOT ONE TASK. Every fixture in this file used to be an
 * all-merged plan (`refreshMerged: () => () => true`), because the rung was reached only from the
 * daemon's IDLE branch. The operator's ruling replaces that idle conjunct with a DEFERRED PAIRING,
 * which cannot occur on an idle tick — so an all-merged plan now never consults the rung at all and
 * every assertion below would pass vacuously against a rung that is never called. The in-flight
 * guard these tests cover is unchanged; only the way the rung is REACHED has moved.
 */
function fixturePlan(dir: string): string {
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    "- id: T1\n  title: t1\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  files: [src/shared.ts]\n" +
      "- id: T2\n  title: t2\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  files: [src/shared.ts]\n",
  );
  return f;
}

/** Nothing merges, so the collision — and therefore the deferral the rung now gates on — persists. */
const NEVER_MERGED = () => () => false;
const OK_RUN = async (id: string) => ({ taskId: id, ok: true, merged: true }) as never;
/** `partitionByFileOverlap` only runs at N>=2; at laneCount 1 the budget is 1 and nothing collides. */
const TWO_LANES = { laneCount: 2 } as const;

test("REFUSAL: a feedback id with an open triage PR is never re-fired, and the refusal is ledgered with the id and PR number", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-tid-open-");
  try {
    const plan = loadPlan(fixturePlan(dir));
    let fires = 0;
    let stopChecks = 0;
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];

    const summary = await runDaemon(plan, {
      refreshMerged: NEVER_MERGED,
      runOne: OK_RUN,
      checkStop: () => {
        stopChecks++;
        return stopChecks > 3 ? "test bound reached" : undefined;
      },
      sleep: async () => {},
      checkAutoTriage: () => ({ fire: true, feedbackId: "fb-1784762630201-4751e0", reason: "idle" }),
      runAutoTriage: async () => {
        fires++;
      },
      // The first triage PR is still OPEN — the second fire must be refused, never re-dispatched.
      isFeedbackOpenPr: (feedbackId) => (feedbackId === "fb-1784762630201-4751e0" ? 1184 : undefined),
      log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
    }, TWO_LANES);

    assert.equal(summary.stopReason, "stopped");
    assert.equal(fires, 0, "an id with an open triage PR must never be re-dispatched");
    assert.equal(
      lines.filter((l) => l.step === "auto_triage.fired").length,
      0,
      "a guarded id must never reach the 'fired' step at all",
    );
    const refusals = lines.filter((l) => l.step === "auto_triage.skipped_inflight");
    assert.ok(refusals.length >= 1, "the refusal must be ledgered, not silent");
    for (const r of refusals) {
      assert.equal(r.extra.feedback, "fb-1784762630201-4751e0", "the refusal must name the feedback id");
      assert.equal(r.extra.pr_number, 1184, "the refusal must name the open PR number");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NO OPEN PR: an id with no open triage PR fires exactly as before this guard existed", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-tid-clear-");
  try {
    const plan = loadPlan(fixturePlan(dir));
    let fires = 0;
    let stopChecks = 0;
    const lines: Array<{ step: string }> = [];

    await runDaemon(plan, {
      refreshMerged: NEVER_MERGED,
      runOne: OK_RUN,
      checkStop: () => {
        stopChecks++;
        return stopChecks > 1 ? "bound" : undefined;
      },
      sleep: async () => {},
      checkAutoTriage: () => ({ fire: true, feedbackId: "fb-clear", reason: "idle" }),
      runAutoTriage: async () => {
        fires++;
      },
      isFeedbackOpenPr: () => undefined, // no open PR carries fb-clear's provenance
      log: (step) => lines.push({ step }),
    }, TWO_LANES);

    assert.equal(fires, 1, "an unguarded id must still fire normally");
    assert.equal(lines.filter((l) => l.step === "auto_triage.fired").length, 1);
    assert.equal(lines.filter((l) => l.step === "auto_triage.skipped_inflight").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NO GUARD WIRED: omitting isFeedbackOpenPr behaves exactly as before this guard existed", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-tid-unwired-");
  try {
    const plan = loadPlan(fixturePlan(dir));
    let fires = 0;
    let stopChecks = 0;
    await runDaemon(plan, {
      refreshMerged: NEVER_MERGED,
      runOne: OK_RUN,
      checkStop: () => {
        stopChecks++;
        return stopChecks > 1 ? "bound" : undefined;
      },
      sleep: async () => {},
      checkAutoTriage: () => ({ fire: true, feedbackId: "fb-unwired", reason: "idle" }),
      runAutoTriage: async () => {
        fires++;
      },
      // isFeedbackOpenPr deliberately omitted.
      log: () => {},
    }, TWO_LANES);
    assert.equal(fires, 1, "an omitted guard must not change existing behaviour");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("STALE CACHE CONFIRMED: a fresh read that the cached open PR already merged stands the guard down and fires", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-tid-stale-");
  try {
    const plan = loadPlan(fixturePlan(dir));
    let fires = 0;
    let stopChecks = 0;
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];

    await runDaemon(plan, {
      refreshMerged: NEVER_MERGED,
      runOne: OK_RUN,
      checkStop: () => {
        stopChecks++;
        return stopChecks > 1 ? "bound" : undefined;
      },
      sleep: async () => {},
      checkAutoTriage: () => ({ fire: true, feedbackId: "fb-stale", reason: "idle" }),
      runAutoTriage: async () => {
        fires++;
      },
      // The cached snapshot says an open PR exists, but a FRESH read shows it already merged —
      // W1-T177's confirming-read discipline must stand the guard down rather than parking this
      // entry forever on a stale cache.
      isFeedbackOpenPr: () => 1184,
      readFeedbackLiveState: () => "MERGED",
      log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
    }, TWO_LANES);

    assert.equal(fires, 1, "a confirmed-stale cache must stand down and allow the fire");
    assert.equal(
      lines.filter((l) => l.step === "auto_triage.skipped_inflight").length,
      0,
      "a stood-down guard must never be ledgered as a live in-flight refusal",
    );
    const stoodDown = lines.filter((l) => l.step === "auto_triage.stood_down");
    assert.ok(stoodDown.length >= 1, "standing down must be ledgered too");
    assert.equal(stoodDown[0].extra.feedback, "fb-stale");
    assert.equal(stoodDown[0].extra.pr_number, 1184);
    assert.equal(stoodDown[0].extra.state, "MERGED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("INDETERMINATE LIVE READ FAILS OPEN: an undefined fresh read still refuses the fire", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-tid-indet-");
  try {
    const plan = loadPlan(fixturePlan(dir));
    let fires = 0;
    let stopChecks = 0;
    const lines: Array<{ step: string }> = [];

    await runDaemon(plan, {
      refreshMerged: NEVER_MERGED,
      runOne: OK_RUN,
      checkStop: () => {
        stopChecks++;
        return stopChecks > 1 ? "bound" : undefined;
      },
      sleep: async () => {},
      checkAutoTriage: () => ({ fire: true, feedbackId: "fb-indet", reason: "idle" }),
      runAutoTriage: async () => {
        fires++;
      },
      isFeedbackOpenPr: () => 1184,
      // An indeterminate (rate-limited/network-failed) live read resolves undefined — same
      // fail-OPEN contract as the task lane's readLiveState: never a reason to allow the fire.
      readFeedbackLiveState: () => undefined,
      log: (step) => lines.push({ step }),
    }, TWO_LANES);

    assert.equal(fires, 0, "an indeterminate live read must fail OPEN, never authorise a duplicate fire");
    assert.equal(lines.filter((l) => l.step === "auto_triage.skipped_inflight").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
