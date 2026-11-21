import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { selectImplementSkills } from "#src/cli/commands/run-task-verb.js";
import type { Config } from "#src/lib/config.js";
import type { CriterionVerdict } from "#src/lib/review.js";
import {
  buildSkillEffectivenessReport,
  renderSkillEffectivenessReport,
  SKILL_WITHHOLDING_SHARE,
} from "#src/lib/skill-workshop.js";
import { SKILL_ARM_EPOCH, TASK_ARM_UNIT, taskArmWithheld } from "#src/lib/task-arm.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { runFixRung } from "#test/helpers/run-task-test.js";

// W1-T14137: the skill arm was drawn per run id. A task's implement run (`<task>-<ms>`) and its later fix rounds
// (another run id, or the sweep's pass-wide `SWEEP-<ms>`) fell in different arms, so the task's one outcome could
// not be credited to one arm, and every task fixed in one sweep pass shared a single draw. The arm is now drawn per
// task; these tests drive both lanes' own selection code with nothing injected in place of the draw.

type Row = Record<string, unknown> & { step: string };

const SKILL = "shared-procedure";
const SKILL_BODY = "Write the failing test before the fix.";

const skillDraw = (taskId: string): boolean =>
  taskArmWithheld({ taskId, unit: SKILL, share: SKILL_WITHHOLDING_SHARE, epoch: SKILL_ARM_EPOCH });

/** The first `n` task ids of `W1-T9<i>` the skill draw puts in the wanted arm, so each arm is exercised. */
const tasksInArm = (withheld: boolean, n: number): string[] => {
  const out: string[] = [];
  for (let i = 1; out.length < n; i++) if (skillDraw(`W1-T9${String(i).padStart(3, "0")}`) === withheld) out.push(`W1-T9${String(i).padStart(3, "0")}`);
  return out;
};

/** A state root that is also a repo root: one approved skill both lanes are eligible for, no staged retirement. */
const skillRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}task-arm-`));
  mkdirSync(join(root, ".claude", "skills", SKILL), { recursive: true });
  writeFileSync(join(root, ".claude", "skills", SKILL, "SKILL.md"),
    `---\nname: ${SKILL}\napplies-to: implement, fix\n---\n\n${SKILL_BODY}\n`);
  return root;
};

const criteria: CriterionVerdict[] = [
  { claim: "wire producer", proof: "unit test: wires it", met: false, reason: "consumer disconnected", proof_exec: "executed_fail" },
];
const mount = { model: "sonnet", effort: "medium", maxTurns: 10, contextBudget: 120000 };

/** One fix round of `taskId` under `runId` through the fix lane's own selection; returns its skills.selection row. */
async function fixSelection(root: string, taskId: string, runId: string): Promise<Row> {
  const worktree = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}task-arm-fix-`));
  const task = { id: taskId, title: "wire the producer", files: ["src/changed.ts"], acceptance: criteria };
  const initialReview = {
    state: "failure" as const, criteria, testTheater: false, summary: "one visible gap",
    floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    headSha: "a".repeat(40), reviewerOutcome: "success",
  };
  const rows: Row[] = [];
  try {
    await runFixRung({
      task, taskId, runId, prUrl: "https://github.com/acme/remudero/pull/1",
      branch: `run-${taskId}-1791151948510`, worktreePath: worktree, initialSessionId: "", initialReview,
      mount, settingsFile: join(worktree, "settings.json"), config: { root } as Config, budgetUsd: 1, strikeCap: 1,
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: worktree, reviewerMount: mount },
      deps: {
        approvedSkillsDir: join(root, ".claude", "skills"),
        ledgerLines: () => [], ledgerPath: join(worktree, "ledger.ndjson"),
        spawn: async () => ({
          sessionId: "fix", costUsd: 0, numTurns: 1, text: "fixed", blocks: [], stderr: "",
          subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
          model: "sonnet", effort: "medium", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
          modelUsage: {}, compactionEvents: [], qualitySuspect: false,
        } satisfies WorkerResult),
        waitForCiGreen: async () => "green",
        runReview: async () => ({ ...initialReview, state: "success", criteria: criteria.map((c) => ({ ...c, met: true })), headSha: "d".repeat(40) }),
        push: () => {}, fetchPrBody: async () => "implemented", fetchPrDiffFiles: async () => task.files,
        issues: { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} },
        log: (step, extra) => rows.push({ ...extra, step }), say: () => {}, account: (worker) => worker,
      },
    });
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
  const selection = rows.filter((row) => row.step === "skills.selection");
  assert.equal(selection.length, 1, "one selection row per fix rung");
  return selection[0]!;
}

const withholds = (row: Record<string, unknown>): boolean => {
  assert.ok(Array.isArray(row.withheld_names), "the row records its randomized assignment");
  return (row.withheld_names as string[]).includes(SKILL);
};

test("W1-T14137 criterion 1: every run of one task, implement lane and fix lane alike, draws the same withheld arm for a skill", async () => {
  const root = skillRoot();
  try {
    const tasks = [...tasksInArm(true, 2), ...tasksInArm(false, 2)];
    for (const taskId of tasks) {
      const expected = skillDraw(taskId);
      const implement = selectImplementSkills(root, root, { id: taskId, type: "implement", files: ["src/changed.ts"] }).observation;
      assert.equal(withholds(implement), expected, `${taskId}: the implement lane draws the task's arm`);
      assert.equal(implement.arm_unit, TASK_ARM_UNIT);
      assert.equal(implement.arm_epoch, SKILL_ARM_EPOCH);
      // The implement run's own fix round, a later rung's fix round and a sweep pass's fix round: three run ids.
      for (const runId of [`${taskId}-1795000000000`, `${taskId}-1795000999999`, "SWEEP-1795001234567"]) {
        const fix = await fixSelection(root, taskId, runId);
        assert.equal(fix.task_type, "fix");
        assert.equal(withholds(fix), expected, `${taskId} under ${runId}: the fix lane draws the same arm`);
        assert.equal(fix.arm_unit, TASK_ARM_UNIT);
        assert.equal(fix.arm_epoch, SKILL_ARM_EPOCH);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T14137 criterion 2: two tasks fixed in one sweep pass draw independently, and the withheld share over many tasks is near 25%", async () => {
  const root = skillRoot();
  try {
    const sweepRunId = "SWEEP-1795001234567";
    const [withheldTask] = tasksInArm(true, 1);
    const [keptTask] = tasksInArm(false, 1);
    assert.equal(withholds(await fixSelection(root, withheldTask!, sweepRunId)), true, `${withheldTask} is withheld`);
    assert.equal(withholds(await fixSelection(root, keptTask!, sweepRunId)), false,
      `${keptTask} keeps the skill in the same sweep pass: the pass's run id is not the draw`);

    const n = 1000;
    let laneWithheld = 0;
    for (let i = 0; i < n; i++) {
      const observed = selectImplementSkills(root, root, { id: `W1-T${20000 + i}`, type: "implement", files: [] }).observation;
      if (withholds(observed)) laneWithheld++;
    }
    assert.ok(Math.abs(laneWithheld / n - SKILL_WITHHOLDING_SHARE) < 0.04, `lane share ${laneWithheld / n}`);
    let withheld = 0;
    let both = 0;
    const draws = 10_000;
    for (let i = 0; i < draws; i++) {
      const a = taskArmWithheld({ taskId: `T-${i}`, unit: "a", share: SKILL_WITHHOLDING_SHARE, epoch: SKILL_ARM_EPOCH });
      const b = taskArmWithheld({ taskId: `T-${i}`, unit: "b", share: SKILL_WITHHOLDING_SHARE, epoch: SKILL_ARM_EPOCH });
      if (a) withheld++;
      if (a && b) both++;
    }
    assert.ok(Math.abs(withheld / draws - SKILL_WITHHOLDING_SHARE) < 0.02, `share ${withheld / draws}`);
    assert.ok(Math.abs(both / draws - SKILL_WITHHOLDING_SHARE ** 2) < 0.02, `units draw independently (joint ${both / draws})`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const OLD_EPOCH = "zz-retired-epoch";
const selectionRow = (runId: string, withheld: boolean, design: { epoch?: string; ts: string; taskId?: string }): Row => ({
  ts: design.ts, run_id: runId, ...(design.taskId === undefined ? {} : { task_id: design.taskId }),
  step: "skills.selection", task_type: "implement",
  approved_eligible_names: ["proc"], path_filtered_names: [], selected_names: withheld ? [] : ["proc"],
  budget_omitted_names: [], budget_chars: 100, zero_selection: withheld, withheld_names: withheld ? ["proc"] : [],
  ...(design.epoch === undefined ? {} : { arm_unit: TASK_ARM_UNIT, arm_epoch: design.epoch }),
});
const verdict = (runId: string, v: string, fields: Row | Record<string, unknown> = {}): Row =>
  ({ run_id: runId, step: "verdict", verdict: v, ...fields });

test("W1-T14137 criterion 3: the effectiveness report compares only the newest arm epoch's rows and reports run-keyed rows apart", () => {
  const legacy = { ts: "2026-11-01T00:00:00.000Z" };
  // Named to sort after the current epoch: the newest epoch is the one whose rows began last, not the larger name.
  const older = { epoch: OLD_EPOCH, ts: "2026-11-10T00:00:00.000Z" };
  const newest = { epoch: SKILL_ARM_EPOCH, ts: "2026-11-21T00:00:00.000Z" };
  const rows: Row[] = [
    selectionRow("legacy-treated", false, legacy), verdict("legacy-treated", "merged"),
    selectionRow("legacy-withheld-1", true, legacy), verdict("legacy-withheld-1", "merged"),
    selectionRow("legacy-withheld-2", true, legacy), verdict("legacy-withheld-2", "merged"),
    selectionRow("old-treated", false, older), verdict("old-treated", "merged"),
    selectionRow("new-treated-1", false, newest), verdict("new-treated-1", "blocked_ci"),
    selectionRow("new-treated-2", false, newest), verdict("new-treated-2", "merged"),
    selectionRow("new-withheld", true, newest), verdict("new-withheld", "failed"),
    selectionRow("new-withheld-pending", true, newest),
  ];
  const report = buildSkillEffectivenessReport(rows, "proc");
  assert.equal(report.arm_epoch, SKILL_ARM_EPOCH);
  assert.equal(report.assignment, "randomized");
  assert.equal(report.selected.observed_eligible_runs, 2, "only the newest epoch's treated rows");
  assert.deepEqual(report.selected.outcomes, { blocked_ci: 1, merged: 1 });
  assert.equal(report.control.observed_eligible_runs, 2, "only the newest epoch's withheld rows");
  assert.deepEqual(report.control.outcomes, { failed: 1 });
  assert.deepEqual(report.apart, [
    { design: "run-keyed", eligible_runs: 3, terminal_runs: 3 },
    { design: OLD_EPOCH, eligible_runs: 1, terminal_runs: 1 },
  ]);
  assert.deepEqual(buildSkillEffectivenessReport([...rows].reverse(), "proc"), report, "row order does not pick the epoch");
  const rendered = renderSkillEffectivenessReport(report);
  assert.match(rendered, new RegExp(`^arm design: task-keyed, epoch ${SKILL_ARM_EPOCH}; apart, never pooled: run-keyed eligible=3 terminal=3; ${OLD_EPOCH} eligible=1 terminal=1$`, "m"));

  // Before any task-keyed row exists the run-keyed rows are the comparison, exactly as before.
  const legacyOnly = buildSkillEffectivenessReport(rows.filter((row) => row.step !== "skills.selection" || row.arm_unit === undefined), "proc");
  assert.equal(legacyOnly.arm_epoch, null);
  assert.equal(legacyOnly.selected.observed_eligible_runs, 1);
  assert.equal(legacyOnly.control.observed_eligible_runs, 2);
  assert.deepEqual(legacyOnly.apart, []);
  assert.match(renderSkillEffectivenessReport(legacyOnly), /^arm design: before task-keyed arms \(run-keyed or observational rows\); apart, never pooled: none$/m);
});

// A sweep pass logs every task's fix-lane rows under its one pass-wide run id, each with its own task_id.
const SWEEP_RUN = "SWEEP-1795001234567";

test("W1-T14137 criterion 3, one sweep pass: two newest-epoch tasks in opposite arms under one run id both count", () => {
  const newest = (taskId: string) => ({ epoch: SKILL_ARM_EPOCH, ts: "2026-11-21T00:00:00.000Z", taskId });
  const rows: Row[] = [
    selectionRow(SWEEP_RUN, true, newest("W1-T9101")), verdict(SWEEP_RUN, "no_diff", { task_id: "W1-T9101" }),
    selectionRow(SWEEP_RUN, false, newest("W1-T9102")), verdict(SWEEP_RUN, "merged", { task_id: "W1-T9102" }),
  ];
  for (const order of [rows, [...rows].reverse()]) {
    const report = buildSkillEffectivenessReport(order, "proc");
    assert.equal(report.control.observed_eligible_runs, 1, "the withheld task is counted");
    assert.equal(report.selected.observed_eligible_runs, 1, "the treated task is counted");
    assert.deepEqual(report.control.outcomes, { no_diff: 1 }, "each task joins its own outcome");
    assert.deepEqual(report.selected.outcomes, { merged: 1 });
  }
});

test("W1-T14137 criterion 3, one sweep pass: two legacy rows under one run id both count, apart", () => {
  const legacy = (taskId: string) => ({ ts: "2026-11-01T00:00:00.000Z", taskId });
  const newest = { epoch: SKILL_ARM_EPOCH, ts: "2026-11-21T00:00:00.000Z" };
  const legacyRun = "SWEEP-1794000000000";
  const report = buildSkillEffectivenessReport([
    selectionRow(legacyRun, true, legacy("W1-T9201")), verdict(legacyRun, "merged", { task_id: "W1-T9201" }),
    selectionRow(legacyRun, false, legacy("W1-T9202")), verdict(legacyRun, "no_diff", { task_id: "W1-T9202" }),
    selectionRow("new-treated", false, newest), verdict("new-treated", "merged"),
    selectionRow("new-withheld", true, newest), verdict("new-withheld", "no_diff"),
  ], "proc");
  assert.deepEqual(report.apart, [{ design: "run-keyed", eligible_runs: 2, terminal_runs: 2 }]);
  assert.equal(report.selected.observed_eligible_runs, 1);
  assert.equal(report.control.observed_eligible_runs, 1);
});

const T0 = Date.parse("2026-11-21T00:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const PR = "https://github.com/acme/widgets/pull/";
const merge = (n: number, ms: number): Row => ({ ts: iso(ms), step: "pr.terminal", pr_url: `${PR}${n}`, pr_number: n, state: "merged" });

/** Ten treated runs whose PRs are still open, and ten controls of which five merged directly: INSUFFICIENT
 *  EVIDENCE while the treated runs are pending, RETIRE-CANDIDATE once they settle unmerged. */
const pendingComparison = (treatedMs: number, controlMs: number): Row[] => {
  const rows: Row[] = [];
  for (let i = 0; i < 10; i++) {
    const at = { epoch: SKILL_ARM_EPOCH, ts: iso(treatedMs) };
    rows.push(selectionRow(`t-${i}`, false, at), verdict(`t-${i}`, "handed_off", { ts: iso(treatedMs), pr_url: `${PR}${100 + i}` }));
    const ctl = { epoch: SKILL_ARM_EPOCH, ts: iso(controlMs) };
    rows.push(selectionRow(`c-${i}`, true, ctl), verdict(`c-${i}`, i < 5 ? "merged" : "no_diff", { ts: iso(controlMs), pr_url: `${PR}${200 + i}` }));
  }
  return rows;
};

/** Ten legacy run-keyed runs, handed off at `verdictMs` and merged at `mergedMs`, on PRs no current run shares. */
const legacyMerges = (verdictMs: number, mergedMs: number): Row[] => Array.from({ length: 10 }, (_, i) => [
  selectionRow(`legacy-${i}`, i % 2 === 0, { ts: iso(verdictMs) }),
  verdict(`legacy-${i}`, "handed_off", { ts: iso(verdictMs), pr_url: `${PR}${900 + i}` }),
  merge(900 + i, mergedMs),
]).flat();

/** The comparison with the `apart` counts left out: those name the added rows, and nothing else may move. */
const comparison = (rows: Row[]): Record<string, unknown> => {
  const { apart: _apart, ...rest } = buildSkillEffectivenessReport(rows, "proc");
  return rest;
};

test("W1-T14137 criterion 3, fenced settle window: ten legacy merges leave the newest epoch's comparison and status byte-identical", () => {
  // The current rows alone have five merge delays, below the horizon, so no settle window and the treated runs pend.
  const current = pendingComparison(T0, T0 + 5 * HOUR);
  const before = buildSkillEffectivenessReport(current, "proc");
  assert.equal(before.status, "INSUFFICIENT EVIDENCE");
  assert.equal(before.basis, "pending-shipment");
  assert.equal(before.settle_window_ms, null);
  assert.equal(before.selected.pending_merge_runs, 10);
  // Ten legacy runs that merged an hour after their verdict, all before the current epoch began.
  const withLegacy = [...current, ...legacyMerges(T0 - 30 * HOUR, T0 - 29 * HOUR)];
  assert.equal(JSON.stringify(comparison(withLegacy)), JSON.stringify(comparison(current)));
  assert.deepEqual(buildSkillEffectivenessReport(withLegacy, "proc").apart, [{ design: "run-keyed", eligible_runs: 10, terminal_runs: 10 }]);
});

test("W1-T14137 criterion 3, fenced clock: legacy merges dated after the newest epoch's rows do not settle its pending runs", () => {
  // Ten direct merges with no skill row give a zero settle window; the treated runs pend until a later row is seen.
  const neutral = Array.from({ length: 10 }, (_, i) => verdict(`direct-${i}`, "merged", { ts: iso(T0), pr_url: `${PR}${300 + i}` }));
  const current = [...pendingComparison(T0 + 5 * HOUR, T0 + 5 * HOUR), ...neutral];
  const before = buildSkillEffectivenessReport(current, "proc");
  assert.equal(before.settle_window_ms, 0);
  assert.equal(before.status, "INSUFFICIENT EVIDENCE");
  assert.equal(before.selected.pending_merge_runs, 10);
  // Legacy PRs handed off before the change and merged a day after it.
  const withLegacy = [...current, ...legacyMerges(T0 - 30 * HOUR, T0 + 30 * HOUR)];
  assert.equal(JSON.stringify(comparison(withLegacy)), JSON.stringify(comparison(current)));
});

test("the task arm is a pure function of its four inputs, pinned to its published hash", () => {
  const input = { taskId: "W1-T14138", unit: "fix-learnings", share: 0.25, epoch: "fix-learnings-shadow-v1" };
  const digest = createHash("sha256").update(["task-arm/v1", input.epoch, input.unit, input.taskId].join("\0")).digest();
  assert.equal(taskArmWithheld(input), digest.readUInt32BE(0) / 0x1_0000_0000 < input.share);
  assert.equal(taskArmWithheld(input), taskArmWithheld({ ...input }));
  for (let i = 0; i < 50; i++) {
    assert.equal(taskArmWithheld({ ...input, taskId: `T-${i}`, share: 0 }), false, "share 0 never withholds");
    assert.equal(taskArmWithheld({ ...input, taskId: `T-${i}`, share: 1 }), true, "share 1 always withholds");
  }
  let disagree = 0;
  for (let i = 0; i < 2000; i++) {
    const a = taskArmWithheld({ ...input, taskId: `T-${i}`, share: 0.5 });
    const b = taskArmWithheld({ ...input, taskId: `T-${i}`, share: 0.5, epoch: "fix-prompt-lessons-v1" });
    if (a !== b) disagree++;
  }
  assert.ok(Math.abs(disagree / 2000 - 0.5) < 0.05, `a new epoch redraws every task (disagree ${disagree / 2000})`);
});
