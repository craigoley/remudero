import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSkillEffectivenessReport } from "#src/lib/skill-workshop.js";

// W1-T10764: a run's own `verdict` row hands off (`handed_off`, `blocked_ci`) and never reads `merged`. The merge is
// ledgered later under another run id: the sweep's `verdict.merged` credit backfill naming the task and the PR, or
// the direct merge's `pr.terminal` row naming only the PR. The rows below are shaped like those writers'
// (run-task-verb.ts's handed-off verdict, sweep.ts's credit backfill, arm-auto-merge.ts's direct merge).

type Row = Record<string, unknown>;

const SKILL = "fixture-skill";
const PR_BASE = "https://github.com/acme/widgets/pull/";
const SWEEP_RUN_ID = "DAEMON-1793000000000";

/** A randomized selection row: `selected` puts the run in the selected arm, otherwise the skill was withheld. */
const selection = (runId: string, taskId: string, selected: boolean): Row => ({
  ts: "2026-10-20T10:00:00.000Z", run_id: runId, task_id: taskId, step: "skills.selection", task_type: "implement",
  approved_eligible_names: [SKILL], selected_names: selected ? [SKILL] : [], budget_omitted_names: [],
  withheld_names: selected ? [] : [SKILL],
});

const runVerdict = (runId: string, taskId: string, verdict: string, fields: Row = {}): Row => ({
  ts: "2026-10-20T10:30:00.000Z", run_id: runId, task_id: taskId, step: "verdict", verdict, lane: "run-task", ...fields,
});

const sweepMerge = (taskId: string, fields: Row): Row => ({
  ts: "2026-10-20T11:00:00.000Z", run_id: SWEEP_RUN_ID, task_id: taskId, step: "verdict.merged", verdict: "merged",
  source: "sweep.credit_backfill", ...fields,
});

test("W1-T10764: a handed-off run whose PR later merged counts as merged", () => {
  const rows = [
    selection("W1-T1-1", "W1-T1", true),
    runVerdict("W1-T1-1", "W1-T1", "handed_off", { pr_url: `${PR_BASE}101`, reason: "pr_open_yield" }),
    sweepMerge("W1-T1", { pr_number: 101, pr_url: `${PR_BASE}101` }),
  ];
  const report = buildSkillEffectivenessReport(rows, SKILL);
  assert.equal(report.selected.terminal_runs, 1);
  assert.equal(report.selected.merged_runs, 1, `merged_runs=${report.selected.merged_runs}`);
  assert.equal(report.selected.pending_merge_runs, 0, "a merged PR is no longer pending shipment");
  assert.deepEqual(report.selected.outcomes, { merged: 1 });
  // A union read need not return the merge after the verdict it credits.
  assert.deepEqual(buildSkillEffectivenessReport([...rows].reverse(), SKILL), report);
});

test("W1-T10764: a merge of another run's PR for the same task is never credited", () => {
  const report = buildSkillEffectivenessReport([
    // Three runs of ONE task: the first's PR was superseded unmerged, the second's merged, the third opened none.
    selection("W1-T2-1", "W1-T2", true),
    runVerdict("W1-T2-1", "W1-T2", "handed_off", { pr_url: `${PR_BASE}201` }),
    selection("W1-T2-2", "W1-T2", false),
    runVerdict("W1-T2-2", "W1-T2", "handed_off", { pr_url: `${PR_BASE}202` }),
    selection("W1-T2-3", "W1-T2", true),
    runVerdict("W1-T2-3", "W1-T2", "failed"),
    sweepMerge("W1-T2", { pr_number: 202, pr_url: `${PR_BASE}202` }),
    // A merge naming the task but no PR, and #201's number on another repo, credit nothing.
    sweepMerge("W1-T2", {}),
    sweepMerge("W1-T2", { repo: "acme/gadgets", pr_number: 201 }),
  ], SKILL);
  assert.equal(report.selected.merged_runs, 0);
  assert.deepEqual(report.selected.outcomes, { failed: 1, handed_off: 1 });
  assert.equal(report.control.merged_runs, 1, "the run whose own PR merged is still credited");
  assert.deepEqual(report.control.outcomes, { merged: 1 });
});

test("W1-T10764: a PR named only by number matches a merge on the same repo, never on another", () => {
  const report = buildSkillEffectivenessReport([
    selection("W1-T3-1", "W1-T3", true),
    runVerdict("W1-T3-1", "W1-T3", "blocked_ci", { repo: "acme/widgets", pr_number: 301 }),
    sweepMerge("W1-T3", { repo: "acme/widgets", pr_number: 301 }),
    selection("W1-T4-1", "W1-T4", true),
    runVerdict("W1-T4-1", "W1-T4", "blocked_ci", { repo: "acme/widgets", pr_number: 302 }),
    sweepMerge("W1-T4", { repo: "acme/gadgets", pr_number: 302 }),
    // A number with no repo scopes to nothing, so it matches nothing.
    selection("W1-T5-1", "W1-T5", true),
    runVerdict("W1-T5-1", "W1-T5", "blocked_ci", { pr_number: 303 }),
    sweepMerge("W1-T5", { pr_number: 303 }),
  ], SKILL);
  assert.equal(report.selected.merged_runs, 1);
  assert.deepEqual(report.selected.outcomes, { blocked_ci: 2, merged: 1 });
});

test("W1-T10764: a merge recorded only as a pr.terminal row is credited to the run whose PR it names", () => {
  const directMerge = (fields: Row): Row => ({
    ts: "2026-10-20T11:00:00.000Z", task_id: "SWEEP", step: "pr.terminal", source: "automerge.direct_merge", ...fields,
  });
  const report = buildSkillEffectivenessReport([
    selection("W1-T6-1", "W1-T6", true),
    runVerdict("W1-T6-1", "W1-T6", "handed_off", { pr_url: `${PR_BASE}601` }),
    directMerge({ pr_url: `${PR_BASE}601`, pr_number: 601, state: "merged" }),
    // A PR closed unmerged is a terminal row too, and is never a merge.
    selection("W1-T7-1", "W1-T7", true),
    runVerdict("W1-T7-1", "W1-T7", "handed_off", { pr_url: `${PR_BASE}701` }),
    directMerge({ pr_url: `${PR_BASE}701`, pr_number: 701, state: "closed" }),
  ], SKILL);
  assert.equal(report.selected.merged_runs, 1, `merged_runs=${report.selected.merged_runs}`);
  assert.deepEqual(report.selected.outcomes, { handed_off: 1, merged: 1 });
});
