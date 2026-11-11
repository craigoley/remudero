/**
 * W1-T12266 — A READY PLAN PR MERGES IN THE LIGHT PASS THAT FINDS IT.
 *
 * Measured 2026-11-11 on the core ledger: #17844 was reviewed and green at 05:49:10Z. Three light passes
 * (05:49:10Z, 05:53:59Z, 05:58:50Z) each stood its merge down with "prior plan-merge duration unavailable or
 * invalid, stopped before another attempt". #17837 stood ahead of it in every pass: a held plan PR that the
 * risk judge had escalated, so its turn made no merge attempt. The pass read "no attempt" as "an attempt
 * with no measured duration" and stopped. The full pass merged #17844 at 06:03:00Z.
 *
 * Every test drives the real `buildSweepLightHook` through its io ports. Nothing stands in for the turn rule.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

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

function codePr(prNumber: number): OpenPrView {
  return planPr(prNumber, { isPlanFiling: false, headRefName: `run-W1-T${prNumber}-1`, changedFiles: ["src/subject.ts"] });
}

/** Completed light passes of the ordinary scope, `intervalMs` apart: the measured interval budget. */
function priorPasses(intervalMs: number): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 4; i++) {
    const startedAt = NOW - 3_600_000 + i * intervalMs;
    rows.push({ ts: new Date(startedAt).toISOString(), run_id: "PRIOR", task_id: "SWEEP", step: "sweep.pass",
      pass_id: `prior-${i}`, light_pass_scope: "idle" });
    rows.push({ ts: new Date(startedAt + 1).toISOString(), run_id: "PRIOR", task_id: "SWEEP", step: "sweep.summary",
      pass_id: `prior-${i}`, light_pass_scope: "idle", elapsed_ms: 1 });
  }
  return rows;
}

/** The review's own hold of a plan PR whose checks were still running: the pass re-evaluates it oldest first. */
function heldRow(pr: OpenPrView, msAgo: number): Record<string, unknown> {
  return { ts: at(msAgo), run_id: "review-held", task_id: pr.taskId, step: "automerge.plan_pr_held",
    pr_number: pr.prNumber, pr_url: pr.prUrl, head_sha: pr.headSha, mergeable_state: "blocked", remedy: "retry-later" };
}

function fixture(prs: OpenPrView[], opts: {
  seed?: Array<Record<string, unknown>>;
  intervalMs?: number;
  liveHead?: (pr: OpenPrView) => string;
  arm?: SweepDeps["arm"];
} = {}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12266-`));
  const shim = ghShim([{ when: "", stdout: "[]" }]);
  const keys = ["PATH", "RMD_GH_CACHE_HOME", "RMD_GH_TRANSPORT_FLOOR", "RMD_GH_SHARED_READ_GAP_MS"] as const;
  const oldEnv = keys.map((key) => [key, process.env[key]] as const);
  process.env.PATH = `${shim.dir}:${process.env.PATH}`;
  process.env.RMD_GH_CACHE_HOME = join(root, "gh-cache");
  process.env.RMD_GH_TRANSPORT_FLOOR = "advisory";
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  const rows: Array<Record<string, unknown>> = [
    ...priorPasses(opts.intervalMs ?? 300_000),
    ...prs.map((p) => ({ ts: at(120_000), step: "review.posted", task_id: p.taskId, pr_url: p.prUrl, head_sha: p.headSha,
      state: "success", capped: false, plan_only: p.isPlanFiling === true })),
    ...(opts.seed ?? []),
  ];
  const merged: number[] = [];
  const effects: SweepDeps = {
    ledgerPath: join(root, "ledger.ndjson"), runId: "T12266", readLedger: () => rows,
    appendLine: (_path, row) => { rows.push({ ts: new Date().toISOString(), ...row }); },
    readLedgerUnion: () => ({ complete: true, lines: rows }),
    readActiveWorkerCount: () => 0, readFixPressure: () => ({ availableMib: 8192, floorMib: 1024 }),
    arm: opts.arm ?? ((p) => { merged.push(p.prNumber); return "direct-merged"; }),
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
    rows.push({ ts: new Date().toISOString(), run_id: "T12266", task_id: "SWEEP", step, ...extra });
  };
  const hook = buildSweepLightHook("o", "r", { root } as never, effects.ledgerPath, "T12266",
    { tasks: [], byId: new Map() } as never, log,
    undefined, undefined, undefined, undefined, undefined, io);
  const disposed = (prNumber: number) => rows.findLast((r) => r.step === "sweep.disposed" && r.pr_number === prNumber);
  return { rows, merged, hook, disposed,
    cleanup: () => {
      for (const [key, value] of oldEnv) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(shim.dir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    } };
}

test("W1-T12266 criterion 1: a ready plan PR merges in the light pass that finds it, behind a plan PR that makes no attempt", async () => {
  // The 2026-11-11 shape: the longest-held plan PR is refused by the risk judge, so its turn calls no merge.
  const refused = planPr(1226601);
  const ready = planPr(1226602);
  const next = planPr(1226603);
  const f = fixture([refused, ready, next], { seed: [
    heldRow(refused, 30 * 60_000), heldRow(ready, 6 * 60_000), heldRow(next, 5 * 60_000),
    { ts: at(20 * 60_000), run_id: "R", task_id: refused.taskId, step: "risk_judge.escalated", pr_number: refused.prNumber,
      head_sha: refused.headSha, issue_url: "https://github.com/o/r/issues/1" },
  ] });
  try {
    await f.hook();
    assert.match(String(f.disposed(refused.prNumber)?.stand_down_reason), /^risk judge escalated this head/);
    assert.deepEqual(f.merged, [ready.prNumber, next.prNumber], "both ready plan PRs merge in this pass, in held order");
    for (const pr of [ready, next]) {
      const row = f.disposed(pr.prNumber);
      assert.equal(row?.disposition, "mergeable");
      assert.equal(row?.reason, MERGEABLE_PLAN_PR_REASON);
      assert.equal(row?.acted, true, `#${pr.prNumber} is merged by the pass that found it`);
      assert.equal(row?.arm_outcome, "direct-merged");
    }
  } finally { f.cleanup(); }
});

test("W1-T12266 criterion 2: a ready plan PR under an operator merge hold does not merge, and does not stop the PR behind it", async () => {
  const held = planPr(1226611);
  const ready = planPr(1226612);
  const f = fixture([held, ready], { seed: [
    heldRow(held, 30 * 60_000), heldRow(ready, 5 * 60_000),
    { ts: at(10 * 60_000), run_id: "R", task_id: held.taskId, step: "automerge.hold_engaged", pr_number: held.prNumber,
      authority: "interactive-cli", by: "operator", reason: "hold for a decision" },
  ] });
  try {
    await f.hook();
    assert.deepEqual(f.merged, [ready.prNumber], "the held PR never reaches the merge call");
    const row = f.disposed(held.prNumber);
    assert.equal(row?.acted, false);
    assert.match(String(row?.reason), /held by .*hold for a decision/);
    assert.equal(f.disposed(ready.prNumber)?.arm_outcome, "direct-merged");
  } finally { f.cleanup(); }
});

test("W1-T12266 criterion 3: a plan PR whose head moved since the verdict does not merge, and does not stop the PR behind it", async () => {
  const moved = planPr(1226621);
  const ready = planPr(1226622);
  const f = fixture([moved, ready], {
    seed: [heldRow(moved, 30 * 60_000), heldRow(ready, 5 * 60_000)],
    liveHead: (p) => p.prNumber === moved.prNumber ? "pushed-after-the-verdict" : p.headSha,
  });
  try {
    await f.hook();
    assert.deepEqual(f.merged, [ready.prNumber], "the moved head never reaches the merge call");
    const row = f.disposed(moved.prNumber);
    assert.equal(row?.acted, false);
    assert.match(String(row?.stand_down_reason), /^head moved from head-122/);
    assert.equal(f.disposed(ready.prNumber)?.arm_outcome, "direct-merged");
  } finally { f.cleanup(); }
});

test("W1-T12266 criterion 4: the row that records the merge names the light pass and its pass id", async () => {
  const plan = planPr(1226631);
  const code = codePr(1226632);
  const f = fixture([plan, code], { seed: [heldRow(plan, 5 * 60_000)] });
  try {
    await f.hook();
    const planRow = f.disposed(plan.prNumber);
    assert.equal(planRow?.arm_outcome, "direct-merged");
    assert.equal(planRow?.arm_surface, "light");
    assert.equal(planRow?.plan_merge_outcome, "direct-merged");
    const passIds = f.rows.filter((r) => r.step === "sweep.pass" && r.run_id === "T12266").map((r) => r.pass_id);
    assert.ok(typeof planRow?.pass_id === "string" && passIds.includes(planRow.pass_id),
      "the merge row carries the pass id of a pass that this tick started");
    // A code PR that GitHub will not arm because it is already clean is merged by the same call, in the same pass.
    const codeRow = f.disposed(code.prNumber);
    assert.equal(codeRow?.acted, true);
    assert.equal(codeRow?.arm_outcome, "direct-merged");
    assert.equal(codeRow?.arm_surface, "light");
  } finally { f.cleanup(); }
});

test("W1-T12266 criterion 5: a merge attempt still spends the measured budget, and a turn with no attempt spends none", async () => {
  const refused = planPr(1226641);
  const first = planPr(1226642);
  const second = planPr(1226643);
  const merged: number[] = [];
  const slowArm: SweepDeps["arm"] = async (pr): Promise<"direct-merged"> => {
    merged.push(pr.prNumber);
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    return "direct-merged";
  };
  const f = fixture([refused, first, second], { intervalMs: 100, arm: slowArm, seed: [
    heldRow(refused, 30 * 60_000), heldRow(first, 6 * 60_000), heldRow(second, 5 * 60_000),
    { ts: at(20 * 60_000), run_id: "R", task_id: refused.taskId, step: "risk_judge.escalated", pr_number: refused.prNumber,
      head_sha: refused.headSha, issue_url: "https://github.com/o/r/issues/1" },
  ] });
  try {
    await f.hook();
    assert.deepEqual(merged, [first.prNumber], "the first attempt runs; it spends the 100 ms budget");
    const waiting = f.disposed(second.prNumber);
    assert.equal(waiting?.acted, false);
    assert.match(String(waiting?.stand_down_reason), /measured interval budget 100ms spent .*stopped before the next plan merge/);
  } finally { f.cleanup(); }
});
