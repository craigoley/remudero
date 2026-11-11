/**
 * W1-T12267 — THE PLAN-MERGE BUDGET OF A LIGHT PASS IS MEASURED BETWEEN TICKS.
 *
 * Measured 2026-11-11 on the core ledger: one tick wrote `sweep.pass` rows at 05:46:22.814Z, 05:46:27.089Z and
 * 05:46:27.117Z, and the next pass named a budget of 4,275 ms. The ticks were 150 to 290 seconds apart, and one
 * plan merge took 60 to 210 seconds. So a light pass made one plan merge.
 *
 * Every test drives the real `buildSweepLightHook` through its io ports.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadDefaultPolicy } from "#src/lib/policy.js";
import { MERGEABLE_PLAN_PR_REASON, type OpenPrView, type SweepDeps } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";
// The run-task test seam, not a direct `src/run-task.ts` import: the reach ratchet caps direct importers.
import { buildSweepLightHook } from "#test/helpers/run-task-test.js";

const NOW = Date.now();
const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

function planPr(prNumber: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber, prUrl: `https://github.com/o/r/pull/${prNumber}`, taskId: `W1-T${prNumber}`,
    headSha: `head-${prNumber}`, headRefName: `run-unfiled-${prNumber}`, lastActivityAt: at(60_000),
    reviewState: "success", checksState: "green", unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false,
    mergeState: "clean", isPlanFiling: true, changedFiles: [`plan/tasks.d/W1-T${prNumber}-a-task.yaml`], ...over,
  };
}

/** Completed light passes of the ordinary scope. Each inner list is one tick: the start offsets of its passes, in ms. */
function priorPasses(ticks: number[][], withTickId: boolean): Array<Record<string, unknown>> {
  const base = NOW - 3_600_000;
  const rows: Array<Record<string, unknown>> = [];
  ticks.forEach((starts, tick) => starts.forEach((offset, pass) => {
    const ids = { pass_id: `prior-${tick}-${pass}`, light_pass_scope: "idle", ...(withTickId ? { tick_id: `tick-${tick}` } : {}) };
    rows.push({ ts: new Date(base + offset).toISOString(), run_id: "PRIOR", task_id: "SWEEP", step: "sweep.pass", ...ids });
    rows.push({ ts: new Date(base + offset).toISOString(), run_id: "PRIOR", task_id: "SWEEP", step: "sweep.summary", ...ids, elapsed_ms: 1 });
  }));
  return rows;
}

/** The pass starts of 2026-11-11 05:46Z to 05:58Z on the core ledger, at one hundredth of their real spacing. */
const NOVEMBER_11_TICKS = [[0, 43, 44], [1587, 1588], [4029], [4457, 4458], [7371, 7372]];
/** A plan merge took 60 to 210 seconds that day; 70 seconds at the same scale. */
const NOVEMBER_11_MERGE_MS = 700;

function heldRow(pr: OpenPrView, msAgo: number): Record<string, unknown> {
  return { ts: at(msAgo), run_id: "review-held", task_id: pr.taskId, step: "automerge.plan_pr_held",
    pr_number: pr.prNumber, pr_url: pr.prUrl, head_sha: pr.headSha, mergeable_state: "blocked", remedy: "retry-later" };
}

function fixture(prs: OpenPrView[], opts: {
  prior: Array<Record<string, unknown>>;
  seed?: Array<Record<string, unknown>>;
  liveHead?: (pr: OpenPrView) => string;
  mergeMs?: number;
}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12267-`));
  const shim = ghShim([{ when: "", stdout: "[]" }]);
  const keys = ["PATH", "RMD_GH_CACHE_HOME", "RMD_GH_TRANSPORT_FLOOR", "RMD_GH_SHARED_READ_GAP_MS"] as const;
  const oldEnv = keys.map((key) => [key, process.env[key]] as const);
  process.env.PATH = `${shim.dir}:${process.env.PATH}`;
  process.env.RMD_GH_CACHE_HOME = join(root, "gh-cache");
  process.env.RMD_GH_TRANSPORT_FLOOR = "advisory";
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  const rows: Array<Record<string, unknown>> = [
    ...opts.prior,
    ...prs.filter((p) => p.reviewState === "success").map((p) => ({ ts: at(120_000), step: "review.posted", task_id: p.taskId,
      pr_url: p.prUrl, head_sha: p.headSha, state: "success", capped: false, plan_only: p.isPlanFiling === true })),
    ...prs.filter((p) => p.isPlanFiling === true && p.reviewState === "success").map((p, i) => heldRow(p, 30 * 60_000 - i * 1000)),
    ...(opts.seed ?? []),
  ];
  const merged: number[] = [];
  const effects: SweepDeps = {
    ledgerPath: join(root, "ledger.ndjson"), runId: "T12267", readLedger: () => rows,
    appendLine: (_path, row) => { rows.push({ ts: new Date().toISOString(), ...row }); },
    readLedgerUnion: () => ({ complete: true, lines: rows }),
    readActiveWorkerCount: () => 0, readFixPressure: () => ({ availableMib: 8192, floorMib: 1024 }),
    // The one merge function of production: each call makes its own merge-safety read before it merges.
    arm: async (p): Promise<"direct-merged"> => {
      merged.push(p.prNumber);
      if (opts.mergeMs) await new Promise<void>((resolve) => setTimeout(resolve, opts.mergeMs));
      return "direct-merged";
    },
    postReview: () => {}, close: () => assert.fail("unexpected close"),
    dispatchFix: () => assert.fail("unexpected fix"),
    escalate: () => {},
    readMainTip: async () => "main-1",
    readLiveState: (p) => ({ ok: true, state: "OPEN", headSha: opts.liveHead?.(p) ?? p.headSha }),
    rereadPrAtAct: async () => undefined,
    readActionsStatusSummary: async () => ({ components: [], incidents: [] }),
    readBranchProtectionStrict: async () => false,
    updateBranch: () => assert.fail("unexpected update-branch"),
  };
  const io: NonNullable<Parameters<typeof buildSweepLightHook>[12]> = {
    openPrViews: async () => prs,
    effects: () => effects,
    readCompare: async () => ({ ahead_by: 0, files: [] }),
  };
  // The hook's own log is the ledger writer in production: the pass rows land beside the disposition rows.
  const log = (step: string, extra: Record<string, unknown> = {}): void => {
    rows.push({ ts: new Date().toISOString(), run_id: "T12267", task_id: "SWEEP", step, ...extra });
  };
  const hook = buildSweepLightHook("o", "r", { root } as never, effects.ledgerPath, "T12267",
    { tasks: [], byId: new Map() } as never, log,
    undefined, undefined, undefined, undefined, undefined, io);
  const own = (step: string) => rows.filter((r) => r.step === step && r.run_id === "T12267");
  const disposed = (prNumber: number) => rows.findLast((r) => r.step === "sweep.disposed" && r.pr_number === prNumber);
  /** The summary row of the pass that held the plan merge turns. */
  const planSummary = () => own("sweep.summary").findLast((r) => r.plan_merge_attempts !== undefined);
  return { rows, merged, hook, own, disposed, planSummary,
    cleanup: () => {
      for (const [key, value] of oldEnv) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(shim.dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    } };
}

const FIVE_MINUTE_TICKS = [[0], [300_000], [600_000], [900_000]];

test("W1-T12267 criterion 1: every light pass that one tick starts writes the same tick id on its pass row and its summary row", async () => {
  // A head that waits for its review and a ready plan PR: the tick starts one pass for each batch.
  const waiting = planPr(1226701, { isPlanFiling: false, reviewState: "pending", headRefName: "run-W1-T1226701-1", changedFiles: ["src/subject.ts"] });
  const ready = planPr(1226702);
  const f = fixture([waiting, ready], { prior: priorPasses(FIVE_MINUTE_TICKS, true) });
  try {
    await f.hook();
    const starts = f.own("sweep.pass");
    assert.ok(starts.length >= 2, `one tick started ${starts.length} passes`);
    const tickIds = new Set(starts.map((r) => r.tick_id));
    assert.equal(tickIds.size, 1, "one tick, one tick id");
    assert.ok(typeof starts[0]?.tick_id === "string" && starts[0].tick_id.length > 0);
    assert.equal(new Set(starts.map((r) => r.pass_id)).size, starts.length, "each pass keeps its own pass id");
    const summaries = f.own("sweep.summary");
    assert.equal(summaries.length, starts.length);
    for (const summary of summaries) assert.equal(summary.tick_id, starts[0]?.tick_id);
    await f.hook();
    assert.equal(new Set(f.own("sweep.pass").map((r) => r.tick_id)).size, 2, "the next tick has its own id");
  } finally { f.cleanup(); }
});

test("W1-T12267 criterion 2: the interval counts one start for each tick, the earliest", async () => {
  // Four ticks 300 seconds apart, each with three passes a few milliseconds apart.
  const ticks = [0, 300_000, 600_000, 900_000].map((start) => [start, start + 4, start + 9]);
  const f = fixture([planPr(1226711)], { prior: priorPasses(ticks, true) });
  try {
    await f.hook();
    assert.deepEqual(f.merged, [1226711]);
    assert.equal(f.planSummary()?.plan_merge_interval_ms, 300_000);
    assert.equal(f.planSummary()?.plan_merge_budget_ms, 300_000);
  } finally { f.cleanup(); }
});

test("W1-T12267 criterion 3: a pass row with no tick id counts as its own tick", async () => {
  // Rows from before this task, one pass in each tick: the same interval as before.
  const single = fixture([planPr(1226721)], { prior: priorPasses(FIVE_MINUTE_TICKS, false) });
  try {
    await single.hook();
    assert.equal(single.planSummary()?.plan_merge_interval_ms, 300_000);
  } finally { single.cleanup(); }
  // Rows from before this task with several passes in a tick keep the old reading: the gap between two passes.
  const ticks = [0, 300_000, 600_000, 900_000].map((start) => [start, start + 4, start + 9]);
  const batches = fixture([planPr(1226722)], { prior: priorPasses(ticks, false) });
  try {
    await batches.hook();
    assert.equal(batches.planSummary()?.plan_merge_interval_ms, 5);
  } finally { batches.cleanup(); }
});

test("W1-T12267 criterion 4: with the intervals of 2026-11-11 a light pass merges four ready plan PRs, not one", async () => {
  const prs = [1226731, 1226732, 1226733, 1226734, 1226735].map((n) => planPr(n));
  // Before: the same pass starts with no tick id. The budget is the gap between two passes of one tick.
  const before = fixture(prs, { prior: priorPasses(NOVEMBER_11_TICKS, false), mergeMs: NOVEMBER_11_MERGE_MS });
  try {
    await before.hook();
    assert.equal(before.planSummary()?.plan_merge_interval_ms, 1);
    assert.deepEqual(before.merged, [1226731], "one plan merge in the pass");
  } finally { before.cleanup(); }
  // After: the interval between ticks is 24.4 seconds at this scale (244 seconds on the day).
  const after = fixture(prs, { prior: priorPasses(NOVEMBER_11_TICKS, true), mergeMs: NOVEMBER_11_MERGE_MS });
  try {
    await after.hook();
    assert.equal(after.planSummary()?.plan_merge_interval_ms, 2442);
    assert.deepEqual(after.merged, [1226731, 1226732, 1226733, 1226734], "four plan merges fit before the interval is spent");
    for (const n of after.merged) assert.equal(after.disposed(n)?.reason, MERGEABLE_PLAN_PR_REASON);
    const waiting = after.disposed(1226735);
    assert.equal(waiting?.acted, false);
    assert.match(String(waiting?.stand_down_reason), /measured interval budget 2442ms spent .*stopped before the next plan merge/);
  } finally { after.cleanup(); }
});

test("W1-T12267 criterion 5: the budget never passes the sweep tick bound, and a hold or a moved head still stops a merge", async () => {
  const bound = loadDefaultPolicy().values.sweepWallClockBoundMs;
  const held = planPr(1226741);
  const moved = planPr(1226742);
  const ready = planPr(1226743);
  const next = planPr(1226744);
  // Ticks 20 minutes apart: longer than the bound of one sweep tick.
  const f = fixture([held, moved, ready, next], {
    prior: priorPasses([[0], [1_200_000], [2_400_000], [3_000_000 + 600_000]], true),
    seed: [{ ts: at(10 * 60_000), run_id: "R", task_id: held.taskId, step: "automerge.hold_engaged", pr_number: held.prNumber,
      authority: "interactive-cli", by: "operator", reason: "hold for a decision" }],
    liveHead: (p) => p.prNumber === moved.prNumber ? "pushed-after-the-verdict" : p.headSha,
  });
  try {
    await f.hook();
    assert.equal(f.planSummary()?.plan_merge_interval_ms, 1_200_000);
    assert.ok(bound < 1_200_000, "precondition: the measured interval is above the bound");
    assert.equal(f.planSummary()?.plan_merge_budget_ms, bound, "the budget is the bound, not the interval");
    assert.deepEqual(f.merged, [ready.prNumber, next.prNumber], "one merge call for each merged PR, none for the held or the moved one");
    assert.match(String(f.disposed(held.prNumber)?.reason), /held by .*hold for a decision/);
    assert.match(String(f.disposed(moved.prNumber)?.stand_down_reason), /^head moved from head-122/);
  } finally { f.cleanup(); }
});

test("W1-T12267 criterion 6: the summary row of the pass names the budget, the time spent, the attempts, the merges and the stop", async () => {
  const prs = [1226751, 1226752, 1226753].map((n) => planPr(n));
  const f = fixture(prs, { prior: priorPasses([[0, 3], [100, 104], [200, 203], [300, 302]], true), mergeMs: 60 });
  try {
    await f.hook();
    const summary = f.planSummary();
    assert.equal(summary?.plan_merge_budget_ms, 100);
    assert.equal(summary?.plan_merge_attempts, 2);
    assert.equal(summary?.plan_merges, 2);
    assert.ok(typeof summary?.plan_merge_spent_ms === "number" && summary.plan_merge_spent_ms >= 100);
    assert.match(String(summary?.plan_merge_stop), /measured interval budget 100ms spent .*stopped before the next plan merge/);
    assert.deepEqual(f.merged, [1226751, 1226752]);
  } finally { f.cleanup(); }
  // A pass with no plan merge turn carries none of the fields.
  const none = fixture([planPr(1226754, { isPlanFiling: false, headRefName: "run-W1-T1226754-1", changedFiles: ["src/subject.ts"] })],
    { prior: priorPasses(FIVE_MINUTE_TICKS, true) });
  try {
    await none.hook();
    assert.ok(none.own("sweep.summary").length > 0);
    assert.equal(none.planSummary(), undefined);
  } finally { none.cleanup(); }
});
