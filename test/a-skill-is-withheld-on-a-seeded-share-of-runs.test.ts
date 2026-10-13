import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSkillEffectivenessReport,
  observeSkillSelection,
  renderSkillEffectivenessReport,
  SKILL_EFFECTIVENESS_HORIZON,
  SKILL_WITHHOLDING_SHARE,
  skillWithheldForRun,
  type InjectableSkill,
} from "../src/lib/skill-workshop.js";

// Without withholding, a skill that fits the budget is selected on every eligible run, so the
// effectiveness report's control cohort (eligible but not selected) is empty and it can never
// reach a verdict. These tests pin the randomized control that replaces it.

const skill = (name: string, body = "small"): InjectableSkill => ({ name, appliesTo: ["implement"], body });

test("a withheld skill is neither selected nor charged to the budget, and the row names it", () => {
  const observed = observeSkillSelection(
    [skill("held", "x".repeat(8)), skill("fits", "y".repeat(8))],
    "implement",
    10,
    undefined,
    (name) => name === "held",
  );
  assert.deepEqual(observed.selected.map((s) => s.name), ["fits"],
    "'fits' only fits the 10-char budget because the withheld skill did not spend it");
  assert.deepEqual(observed.observation.approved_eligible_names, ["held", "fits"]);
  assert.deepEqual(observed.observation.selected_names, ["fits"]);
  assert.deepEqual(observed.observation.budget_omitted_names, []);
  assert.deepEqual(observed.observation.withheld_names, ["held"]);
});

test("without a withholding predicate the observation keeps today's shape, with no withheld_names key", () => {
  const observed = observeSkillSelection([skill("fits")], "implement", 10);
  assert.equal("withheld_names" in observed.observation, false);
});

test("the assignment is stable per (run, skill) and lands near the predeclared share", () => {
  assert.equal(skillWithheldForRun("run-1", "a"), skillWithheldForRun("run-1", "a"));
  let withheld = 0;
  let both = 0;
  const n = 10_000;
  for (let i = 0; i < n; i++) {
    const a = skillWithheldForRun(`run-${i}`, "a");
    const b = skillWithheldForRun(`run-${i}`, "b");
    if (a) withheld++;
    if (a && b) both++;
  }
  assert.ok(Math.abs(withheld / n - SKILL_WITHHOLDING_SHARE) < 0.02, `share ${withheld / n}`);
  assert.ok(Math.abs(both / n - SKILL_WITHHOLDING_SHARE ** 2) < 0.02,
    `skills are assigned independently (joint share ${both / n})`);
  assert.equal(skillWithheldForRun("run-1", "a", 0), false, "share 0 never withholds");
  assert.equal(skillWithheldForRun("run-1", "a", 1), true, "share 1 always withholds");
});

const selectionRow = (runId: string, opts: { selected: boolean; withheld?: boolean; omitted?: boolean }) => ({
  run_id: runId,
  step: "skills.selection",
  task_type: "implement",
  approved_eligible_names: ["proc"],
  path_filtered_names: [],
  selected_names: opts.selected ? ["proc"] : [],
  budget_omitted_names: opts.omitted ? ["proc"] : [],
  budget_chars: 100,
  zero_selection: !opts.selected,
  ...(opts.withheld === undefined ? {} : { withheld_names: opts.withheld ? ["proc"] : [] }),
});
const verdict = (runId: string, v: string) => ({ run_id: runId, step: "verdict", verdict: v });

test("randomized rows compare withheld runs against every other eligible run, and drop legacy rows", () => {
  const rows = [
    selectionRow("treated", { selected: true, withheld: false }),
    verdict("treated", "merged"),
    selectionRow("assigned-but-omitted", { selected: false, withheld: false, omitted: true }),
    verdict("assigned-but-omitted", "blocked_ci"),
    selectionRow("withheld", { selected: false, withheld: true }),
    verdict("withheld", "blocked_ci"),
    selectionRow("legacy", { selected: false }),
    verdict("legacy", "merged"),
  ];
  const report = buildSkillEffectivenessReport(rows, "proc");
  assert.equal(report.assignment, "randomized");
  assert.equal(report.selected.observed_eligible_runs, 2,
    "intent to treat: a budget-omitted run that was not withheld stays in the treated arm");
  assert.deepEqual(report.selected.outcomes, { blocked_ci: 1, merged: 1 });
  assert.equal(report.control.observed_eligible_runs, 1, "only the withheld run is control; the legacy row is dropped");
  assert.deepEqual(report.control.outcomes, { blocked_ci: 1 });
  assert.match(renderSkillEffectivenessReport(report), /^assignment: randomized/m);
});

test("with a control cohort, a skill that fits the budget reaches a verdict at the horizon", () => {
  const rows = [];
  for (let i = 0; i < SKILL_EFFECTIVENESS_HORIZON; i++) {
    rows.push(selectionRow(`t-${i}`, { selected: true, withheld: false }), verdict(`t-${i}`, i < 8 ? "merged" : "blocked_ci"));
    rows.push(selectionRow(`c-${i}`, { selected: false, withheld: true }), verdict(`c-${i}`, i < 3 ? "merged" : "blocked_ci"));
  }
  const favorable = buildSkillEffectivenessReport(rows, "proc");
  assert.equal(favorable.status, "REVIEW-CANDIDATE");
  assert.equal(favorable.basis, "favorable-comparison");
});

test("legacy rows alone keep the observational comparison", () => {
  const report = buildSkillEffectivenessReport([
    selectionRow("sel", { selected: true }),
    verdict("sel", "merged"),
    selectionRow("ctl", { selected: false, omitted: true }),
    verdict("ctl", "blocked_ci"),
  ], "proc");
  assert.equal(report.assignment, "observational");
  assert.equal(report.selected.observed_eligible_runs, 1);
  assert.equal(report.control.observed_eligible_runs, 1);
  assert.match(renderSkillEffectivenessReport(report), /^assignment: observational/m);
});
