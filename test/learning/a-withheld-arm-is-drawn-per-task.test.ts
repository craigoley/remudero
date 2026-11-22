import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { selectImplementSkills } from "#src/cli/commands/run-task-verb.js";
import type { Config } from "#src/lib/config.js";
import { readLedgerUnionRecordsSync } from "#src/lib/ledger-union.js";
import type { CriterionVerdict } from "#src/lib/review.js";
import {
  buildSkillEffectivenessReport,
  renderSkillEffectivenessReport,
  SKILL_EFFECTIVENESS_LEDGER_STEPS,
  SKILL_WITHHOLDING_SHARE,
} from "#src/lib/skill-workshop.js";
import { SKILL_ARM_EPOCH, TASK_ARM_UNIT, taskArmWithheld } from "#src/lib/task-arm.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
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

/** Ten treated runs whose PRs are still open, and ten controls of which `controlMerged` merged directly: INSUFFICIENT
 *  EVIDENCE while the treated runs are pending. With all ten controls merged, the confidence sequence reads
 *  RETIRE-CANDIDATE once the treated runs settle unmerged; five of ten leave it undecided. */
const pendingComparison = (treatedMs: number, controlMs: number, controlMerged = 5): Row[] => {
  const rows: Row[] = [];
  for (let i = 0; i < 10; i++) {
    const at = { epoch: SKILL_ARM_EPOCH, ts: iso(treatedMs) };
    rows.push(selectionRow(`t-${i}`, false, at),
      verdict(`t-${i}`, "handed_off", { ts: iso(treatedMs), pr_url: `${PR}${100 + i}`, total_cost_usd: 1 }));
    const ctl = { epoch: SKILL_ARM_EPOCH, ts: iso(controlMs) };
    rows.push(selectionRow(`c-${i}`, true, ctl), verdict(`c-${i}`, i < controlMerged ? "merged" : "no_diff", { ts: iso(controlMs), pr_url: `${PR}${200 + i}` }));
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
const comparison = (rows: readonly Record<string, unknown>[]): Record<string, unknown> => {
  const { apart: _apart, ...rest } = buildSkillEffectivenessReport(rows, "proc");
  return rest;
};

const pendingWithSettleWindow = (controlMerged = 5): Row[] => [
  ...pendingComparison(T0 + 5 * HOUR, T0 + 5 * HOUR, controlMerged),
  ...Array.from({ length: 10 }, (_, i) => verdict(`direct-${i}`, "merged", { ts: iso(T0), pr_url: `${PR}${300 + i}` })),
];

test("W1-T14137 criterion 3, fenced settle window: ten legacy merges leave the newest epoch's comparison and status byte-identical", () => {
  // The current rows alone have five merge delays, below the horizon, so no settle window and the treated runs pend.
  const current = pendingComparison(T0, T0 + 5 * HOUR);
  const before = buildSkillEffectivenessReport(current, "proc");
  assert.equal(before.status, "INSUFFICIENT EVIDENCE");
  assert.equal(before.basis, "undecided");
  assert.equal(before.settle_window_ms, null);
  assert.equal(before.selected.pending_merge_runs, 10);
  // Ten legacy runs that merged an hour after their verdict, all before the current epoch began.
  const withLegacy = [...current, ...legacyMerges(T0 - 30 * HOUR, T0 - 29 * HOUR)];
  assert.equal(JSON.stringify(comparison(withLegacy)), JSON.stringify(comparison(current)));
  assert.deepEqual(buildSkillEffectivenessReport(withLegacy, "proc").apart, [{ design: "run-keyed", eligible_runs: 10, terminal_runs: 10 }]);
});

test("W1-T14137 criterion 3, fenced clock: legacy merges dated after the newest epoch's rows do not settle its pending runs", () => {
  // Ten direct merges with no skill row give a zero settle window; the treated runs pend until a later row is seen.
  const current = pendingWithSettleWindow();
  const before = buildSkillEffectivenessReport(current, "proc");
  assert.equal(before.settle_window_ms, 0);
  assert.equal(before.status, "INSUFFICIENT EVIDENCE");
  assert.equal(before.selected.pending_merge_runs, 10);
  // Legacy PRs handed off before the change and merged a day after it.
  const withLegacy = [...current, ...legacyMerges(T0 - 30 * HOUR, T0 + 30 * HOUR)];
  assert.equal(JSON.stringify(comparison(withLegacy)), JSON.stringify(comparison(current)));
});

// Every row of a run counted apart is fenced, not only its verdict: a legacy run can write fix.done before any
// verdict, and a thrown run's verdict omits the PR its pr.opened names, so a later merge of that PR is logged under
// another run id. The implement lane's logger stamps every row with the run's id and task (run-task-verb.ts).
const LEGACY_TASK = "W1-T9301";
const LEGACY_RUN = `${LEGACY_TASK}-1794000000000`;
const LEGACY_PR = `${PR}901`;
const legacySelection = selectionRow(LEGACY_RUN, true, { ts: iso(T0 - 30 * HOUR), taskId: LEGACY_TASK });
const legacyRow = (step: string, ms: number, fields: Record<string, unknown> = {}): Row =>
  ({ ts: iso(ms), run_id: LEGACY_RUN, task_id: LEGACY_TASK, step, lane: "run-task", ...fields });
/** A fix round of the legacy run as fix.ts's logFixDoneRow writes it: its PR by `repair_pr_url`, when it names one. */
const legacyFixDone = (ms: number, pr: Record<string, unknown> = { repair_pr_url: LEGACY_PR }): Row =>
  legacyRow("fix.done", ms, { round_id: "r1", fix_outcome: "FIXED", total_cost_usd: 0.4, ...pr });
const LATER = iso(T0 + 30 * HOUR);
/** The PR's terminal facts as their producers write them, none under the legacy run's own run and task. */
const legacyPrTerminals: Row[] = [
  // sweep.ts runPrTerminalReconcile: the pass's run id, task SWEEP.
  { ts: LATER, run_id: SWEEP_RUN, task_id: "SWEEP", step: "pr.terminal", pr_url: LEGACY_PR, pr_number: 901, state: "merged", merged_at: LATER, source: "sweep.pr_terminal" },
  { ts: LATER, run_id: SWEEP_RUN, task_id: "SWEEP", step: "pr.terminal", pr_url: LEGACY_PR, pr_number: 901, state: "closed", closed_at: LATER, source: "sweep.pr_terminal" },
  // sweep.ts credit backfill: the pass's run id, the credited task.
  { ts: LATER, run_id: SWEEP_RUN, task_id: LEGACY_TASK, step: "verdict.merged", verdict: "merged", pr_number: 901, pr_url: LEGACY_PR, source: "sweep.credit_backfill" },
  // arm-auto-merge.ts direct merge: the merging run's logger, task SWEEP.
  { ts: LATER, run_id: LEGACY_RUN, task_id: "SWEEP", step: "pr.terminal", pr_url: LEGACY_PR, pr_number: 901, state: "merged", merged_at: LATER, source: "automerge.direct_merge" },
];
const directMerges = Array.from({ length: 10 }, (_, i) => verdict(`direct-${i}`, "merged", { ts: iso(T0), pr_url: `${PR}${300 + i}` }));

/** Ten treated and ten control newest-epoch runs handed off at `ms`, PRs open, beside ten direct merges no skill row
 *  names: a zero settle window, so each run pends until a compared row dated after it is read. */
const pendingArms = (ms: number): Row[] => [
  ...directMerges,
  ...Array.from({ length: 10 }, (_, i) => [false, true].flatMap((withheld) => {
    const runId = `${withheld ? "c" : "t"}-${i}`;
    return [selectionRow(runId, withheld, { epoch: SKILL_ARM_EPOCH, ts: iso(ms) }),
      verdict(runId, "handed_off", { ts: iso(ms), pr_url: `${PR}${(withheld ? 200 : 100) + i}` })];
  })).flat(),
];

test("W1-T14137 apart run rows: a legacy fix.done before any verdict moves neither the clock nor a newest-epoch control", () => {
  const current = pendingArms(T0 + 5 * HOUR);
  const before = buildSkillEffectivenessReport(current, "proc");
  assert.equal(before.settle_window_ms, 0);
  assert.equal(before.selected.pending_merge_runs, 10);
  assert.equal(before.control.pending_merge_runs, 10);
  // A day after every compared row, and the run has no verdict yet.
  const legacy = [legacySelection, legacyFixDone(T0 + 30 * HOUR)];
  for (const rows of [[...current, ...legacy], [...legacy].reverse().concat(current), [...current, ...legacy].reverse()]) {
    const report = buildSkillEffectivenessReport(rows, "proc");
    assert.equal(report.control.pending_merge_runs, 10, "the control PRs stay pending");
    assert.equal(report.selected.pending_merge_runs, 10);
    assert.equal(JSON.stringify(comparison(rows)), JSON.stringify(comparison(current)));
    assert.deepEqual(report.apart, [{ design: "run-keyed", eligible_runs: 1, terminal_runs: 0 }]);
  }
});

test("W1-T14137 apart run rows: a legacy fix round naming no PR, or a PR a compared run names, is fenced by its run", () => {
  const current = pendingArms(T0 + 5 * HOUR);
  // fix.ts's commit-refused fix.done names no PR; c-0's PR is compared, so only the row's own run can fence it.
  for (const pr of [{}, { repair_pr_url: `${PR}200` }]) {
    const fixDone = legacyFixDone(T0 + 30 * HOUR, pr);
    for (const rows of [[...current, legacySelection, fixDone], [fixDone, ...current, legacySelection]]) {
      assert.equal(JSON.stringify(comparison(rows)), JSON.stringify(comparison(current)), JSON.stringify(pr));
    }
  }
});

test("W1-T14137 apart run rows: a merge or close under another run id, of a PR only a legacy fix round names, moves nothing", () => {
  const current = pendingArms(T0 + 5 * HOUR);
  for (const terminal of legacyPrTerminals) {
    const label = `${terminal.source as string} ${terminal.step} ${(terminal.state as string | undefined) ?? ""}`;
    const legacy = [legacySelection, legacyFixDone(T0 - 29 * HOUR), terminal];
    for (const rows of [[...current, ...legacy], [...legacy].reverse().concat(current)]) {
      assert.equal(buildSkillEffectivenessReport(rows, "proc").control.pending_merge_runs, 10, `${label}: the controls pend`);
      assert.equal(JSON.stringify(comparison(rows)), JSON.stringify(comparison(current)), label);
    }
  }
});

test("W1-T14137 apart run rows: a legacy run whose thrown verdict omits its PR keeps that PR's later sweep merge out", (t) => {
  // The reviewer's replay: ten newest-epoch treated runs pend against five merged controls, INSUFFICIENT EVIDENCE.
  const current = pendingWithSettleWindow();
  const thrown: Row[] = [
    legacySelection,
    legacyRow("pr.opened", T0 - 29 * HOUR, { pr_url: LEGACY_PR, head_sha: "e".repeat(40) }),
    // endThrownRun after CI polling throws: verdict failed, and no pr_url.
    legacyRow("verdict", T0 - 28 * HOUR, {
      verdict: "failed", reason: "gh pr checks: HTTP 502", stage: "run.error", cause: "unknown", cost_usd: 1.2,
      model: null, served_model: null,
    }),
    legacyPrTerminals[0]!,
  ];
  // Through the report's own step filter, so the pr.opened row is read at all.
  const read = (rows: Row[]): Row[] => {
    const union = readLedgerUnionRecordsSync(writeLedger(rows, { scope: t }).dir, { step: SKILL_EFFECTIVENESS_LEDGER_STEPS, refuseIncomplete: true });
    assert.ok(union.ok);
    return union.rows as Row[];
  };
  const before = buildSkillEffectivenessReport(read(current), "proc");
  assert.equal(before.status, "INSUFFICIENT EVIDENCE");
  assert.equal(before.selected.pending_merge_runs, 10);
  for (const order of [[...current, ...thrown], [...thrown].reverse().concat(current)]) {
    for (const rows of [order, read(order)]) {
      assert.ok(rows.some((row) => row.step === "pr.opened"));
      const report = buildSkillEffectivenessReport(rows, "proc");
      assert.equal(report.status, "INSUFFICIENT EVIDENCE");
      assert.equal(report.selected.pending_merge_runs, 10, "the newest epoch's treated runs stay pending");
      assert.equal(JSON.stringify(comparison(rows)), JSON.stringify(comparison(current)));
      assert.deepEqual(report.apart, [{ design: "run-keyed", eligible_runs: 1, terminal_runs: 1 }]);
    }
  }
});

test("W1-T14137 apart run rows: a sweep pass's PR facts are fenced by their PR, never by the pass's other tasks", () => {
  // A fix-type report. The pass fixed one task under a retired design, so every selection under its run id is apart;
  // its terminal reconcile and credit backfill still log the merge of a compared run's PR under that same run id.
  const asFix = (row: Row): Row => ({ ...row, task_type: "fix" });
  const comparedRun = "W1-T9402-1795300000000";
  const rows: Row[] = [
    asFix(selectionRow(SWEEP_RUN, true, { ts: iso(T0 - 30 * HOUR), taskId: "W1-T9401" })),
    asFix(selectionRow(comparedRun, false, { epoch: SKILL_ARM_EPOCH, ts: iso(T0), taskId: "W1-T9402" })),
    verdict(comparedRun, "handed_off", { ts: iso(T0), task_id: "W1-T9402", pr_url: `${PR}950` }),
  ];
  const facts: Row[] = [
    { ts: LATER, run_id: SWEEP_RUN, task_id: "SWEEP", step: "pr.terminal", pr_url: `${PR}950`, pr_number: 950, state: "merged", merged_at: LATER, source: "sweep.pr_terminal" },
    { ts: LATER, run_id: SWEEP_RUN, task_id: "W1-T9402", step: "verdict.merged", verdict: "merged", pr_number: 950, pr_url: `${PR}950`, source: "sweep.credit_backfill" },
  ];
  for (const fact of facts) {
    const report = buildSkillEffectivenessReport([...rows, fact], "proc", "fix");
    assert.deepEqual(report.selected.outcomes, { merged: 1 }, `${fact.source as string}: the compared run's PR merged`);
    assert.deepEqual(report.apart, [{ design: "run-keyed", eligible_runs: 1, terminal_runs: 0 }]);
  }
});

test("W1-T14137 criterion 3: a PR opened by an apart run is fenced even when its verdict never names the PR", (scope) => {
  const current = pendingWithSettleWindow();
  const legacyTask = { task_id: "W1-T9201" };
  const legacyTs = iso(T0 - 30 * HOUR);
  const later = iso(T0 + 30 * HOUR);
  const { dir, append } = writeLedger(current, {
    scope,
    rotations: [{ at: iso(T0), gz: true, rows: [
      selectionRow("legacy", false, { ts: legacyTs, taskId: legacyTask.task_id }),
      { step: "pr.opened", ts: legacyTs, run_id: "legacy", ...legacyTask, pr_url: `${PR}901` },
      { step: "pr.opened", ts: legacyTs, run_id: "legacy", ...legacyTask, pr_url: `${PR}902` },
      { step: "pr.opened", ts: legacyTs, run_id: "legacy", ...legacyTask, pr_url: `${PR}903` },
      verdict("legacy", "failed", { ts: legacyTs, ...legacyTask, stage: "run.error" }),
    ] }],
  });
  const readRows = () => {
    const union = readLedgerUnionRecordsSync(dir, { step: SKILL_EFFECTIVENESS_LEDGER_STEPS, refuseIncomplete: true });
    assert.ok(union.ok);
    return union.rows;
  };
  const before = buildSkillEffectivenessReport(current, "proc");
  assert.equal(before.status, "INSUFFICIENT EVIDENCE");
  assert.equal(before.selected.pending_merge_runs, 10);
  for (const terminal of [
    { ...merge(901, T0 + 30 * HOUR), run_id: "DAEMON-1", task_id: "SWEEP" },
    { step: "pr.terminal", ts: later, repo: "acme/widgets", pr_number: 902, state: "closed" },
    { step: "verdict.merged", ts: later, run_id: "DAEMON-2", ...legacyTask, pr_url: `${PR}903` },
  ]) {
    append([terminal]);
    const rows = readRows();
    assert.deepEqual(comparison(rows), comparison(current), terminal.step);
    assert.deepEqual(comparison([...rows].reverse()), comparison(current), "PR attribution is independent of read order");
  }
  assert.deepEqual(buildSkillEffectivenessReport(readRows(), "proc").apart,
    [{ design: "run-keyed", eligible_runs: 1, terminal_runs: 1 }]);

  // A current run explicitly names a PR first opened by an older run, so that shared PR's merge still counts.
  append([
    selectionRow("current-shared", false, { epoch: SKILL_ARM_EPOCH, ts: iso(T0 + 5 * HOUR) }),
    verdict("current-shared", "handed_off", { ts: iso(T0 + 5 * HOUR), pr_url: `${PR}901` }),
  ]);
  assert.equal(buildSkillEffectivenessReport(readRows(), "proc").selected.merged_runs, 1);
});

test("W1-T14137 criterion 3: fix completions from apart runs contribute neither elapsed time nor repair cost", () => {
  // Every control merged, so ten settled-unmerged treated runs are a size the confidence sequence decides.
  const current = pendingWithSettleWindow(10);
  const before = buildSkillEffectivenessReport(current, "proc");
  const legacy = { ts: iso(T0 - 30 * HOUR), taskId: "W1-T9202" };
  const legacyRows = [
    selectionRow(SWEEP_RUN, false, legacy),
    verdict(SWEEP_RUN, "failed", { task_id: legacy.taskId, ts: legacy.ts }),
    selectionRow("legacy-taskless", false, { ts: legacy.ts, epoch: OLD_EPOCH }),
  ];
  const later = iso(T0 + 30 * HOUR);
  const sharedPr = `${PR}100`;
  const fixRows: Row[] = [
    { step: "fix.done", ts: later, run_id: SWEEP_RUN, task_id: legacy.taskId, subtype: "commit_refused" },
    { step: "fix.done", ts: later, run_id: "legacy-taskless", repair_pr_url: sharedPr, total_cost_usd: 50 },
  ];
  assert.equal(before.status, "INSUFFICIENT EVIDENCE");
  assert.equal(before.selected.pending_merge_runs, 10);
  assert.equal(before.selected.cost_usd, 10);
  for (const fix of fixRows) {
    assert.deepEqual(comparison([...current, fix, ...legacyRows]), comparison(current));
  }

  // A completion from a different task in the same pass still advances the clock and adds its repair cost.
  const currentFix = { step: "fix.done", ts: later, run_id: SWEEP_RUN, task_id: "W1-T9203", repair_pr_url: sharedPr, total_cost_usd: 2 };
  const after = buildSkillEffectivenessReport([...current, ...legacyRows, ...fixRows, currentFix], "proc");
  assert.equal(after.selected.not_merged_runs, 10);
  assert.equal(after.selected.cost_usd, 12);
  assert.equal(after.status, "RETIRE-CANDIDATE");
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
