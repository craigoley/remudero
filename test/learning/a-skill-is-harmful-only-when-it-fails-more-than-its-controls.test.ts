import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildSkillEffectivenessReport,
  harmExcessPValue,
  renderSkillEffectivenessReport,
  SKILL_EFFECTIVENESS_HARM_ALPHA,
  skillLifecycleProposalForReport,
  type SkillEffectivenessCohort,
} from "#src/lib/skill-workshop.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// The harm signal used to fire on ANY failed selected run. The W1-T10764 shard records ci-state-forensics with
// selected 44/422 failed against control 19/118: the skill's runs failed LESS often than the runs that withheld
// it, and the knowledge gardener still staged its retirement. Harm now decides only when the selected arm fails
// more often than the control at a predeclared one-sided significance.

type Row = Record<string, unknown>;

const SKILL = "fixture-skill";

const runRows = (arm: "selected" | "control", verdicts: readonly string[]): Row[] =>
  verdicts.flatMap((verdict, i) => {
    const runId = `${arm}-${i}`;
    const selected = arm === "selected";
    return [
      {
        run_id: runId, step: "skills.selection", task_type: "implement", approved_eligible_names: [SKILL],
        selected_names: selected ? [SKILL] : [], budget_omitted_names: [], withheld_names: selected ? [] : [SKILL],
      },
      { run_id: runId, step: "verdict", verdict },
    ];
  });

const report = (selected: readonly string[], control: readonly string[]) =>
  buildSkillEffectivenessReport([...runRows("selected", selected), ...runRows("control", control)], SKILL);

const cohort = (harmful: number, terminal: number): SkillEffectivenessCohort => ({
  observed_eligible_runs: terminal, terminal_runs: terminal, pending_merge_runs: 0, merged_runs: 0,
  harmful_terminal_runs: harmful, outcomes: {},
});

const runs = (counts: Record<string, number>): string[] =>
  Object.entries(counts).flatMap(([verdict, n]) => Array<string>(n).fill(verdict));

test("a skill's harm p-value is the one-sided exact chance of its selected arm's failures", () => {
  // Expected values are exact hypergeometric tails, computed independently with rational arithmetic.
  const close = (actual: number, expected: number, label: string) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
  close(harmExcessPValue(cohort(5, 10), cohort(0, 10)), 21 / 1292, "5/10 vs 0/10");
  close(harmExcessPValue(cohort(4, 10), cohort(0, 10)), 14 / 323, "4/10 vs 0/10");
  close(harmExcessPValue(cohort(3, 10), cohort(0, 10)), 2 / 19, "3/10 vs 0/10");
  close(harmExcessPValue(cohort(1, 10), cohort(0, 10)), 1 / 2, "1/10 vs 0/10");
  close(harmExcessPValue(cohort(2, 10), cohort(4, 10)), 1201 / 1292, "2/10 vs 4/10");
  close(harmExcessPValue(cohort(44, 422), cohort(19, 118)), 0.9651423595747872, "44/422 vs 19/118");
  assert.equal(harmExcessPValue(cohort(0, 10), cohort(0, 10)), 1, "no harm in either arm compares nothing");
  assert.equal(harmExcessPValue(cohort(0, 0), cohort(3, 10)), 1, "an empty selected arm compares nothing");
  assert.equal(harmExcessPValue(cohort(3, 10), cohort(0, 0)), 1, "an empty control arm compares nothing");
});

test("a skill whose selected runs fail less often than its controls is not a harm retire candidate", () => {
  const fewer = report(runs({ merged: 8, failed: 2 }), runs({ merged: 3, failed: 4, no_diff: 3 }));
  assert.equal(fewer.selected.harmful_terminal_runs, 2, "the selected arm did fail");
  assert.notEqual(fewer.basis, "named-harm-signal");
  assert.equal(fewer.status, "REVIEW-CANDIDATE", "it falls through to the merge comparison, which favors it");
  assert.equal(fewer.basis, "favorable-comparison");

  // The production shape: 10.4% selected failures against 16.1% control failures, merge rates a hair apart.
  const production = report(
    runs({ merged: 200, failed: 44, no_diff: 178 }),
    runs({ merged: 56, failed: 19, no_diff: 43 }),
  );
  assert.equal(production.selected.harmful_terminal_runs, 44);
  assert.equal(production.control.harmful_terminal_runs, 19);
  assert.notEqual(production.basis, "named-harm-signal");
  assert.equal(production.basis, "not-better-than-control", "the merge comparison, not harm, decides");
});

test("a selected arm that fails significantly more often than its controls is a harm retire candidate", () => {
  const significant = report(runs({ merged: 6, failed: 4 }), runs({ merged: 3, no_diff: 7 }));
  assert.equal(significant.status, "RETIRE-CANDIDATE");
  assert.equal(significant.basis, "named-harm-signal");

  // One fewer failure is no longer significant, so harm alone does not decide.
  const borderline = report(runs({ merged: 7, failed: 3 }), runs({ merged: 3, no_diff: 7 }));
  assert.ok(harmExcessPValue(borderline.selected, borderline.control) >= SKILL_EFFECTIVENESS_HARM_ALPHA);
  assert.notEqual(borderline.basis, "named-harm-signal");
  assert.equal(borderline.basis, "favorable-comparison");
});

test("the effectiveness report and a retirement proposal both show the harm comparison", () => {
  const significant = report(runs({ merged: 5, failed: 5 }), runs({ merged: 3, no_diff: 7 }));
  const line = "selected 5/10, control 0/10; one-sided exact p=0.016; harm alone retires below p=0.05";
  assert.ok(renderSkillEffectivenessReport(significant).includes(`harm comparison: ${line}`));

  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}harm-comparison-`));
  try {
    const skillsDir = join(root, "skills");
    mkdirSync(join(skillsDir, SKILL), { recursive: true });
    writeFileSync(
      join(skillsDir, SKILL, "SKILL.md"),
      ["---", `name: ${SKILL}`, "applies-to: implement", "---", "", "## Procedure", "", "- Do the thing."].join("\n"),
      "utf8",
    );
    const built = skillLifecycleProposalForReport(significant, skillsDir);
    assert.ok(built.ok, built.ok ? "" : built.reason);
    assert.ok(built.proposal.summary.includes(`Harm: ${line}`), built.proposal.summary);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
