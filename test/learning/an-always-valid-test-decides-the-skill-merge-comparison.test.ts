import assert from "node:assert/strict";
import { test } from "node:test";
import { seededRandom } from "#src/lib/knowledge-value.js";
import { mergeDifferenceSequence, type MergeDifferenceObservation } from "#src/lib/sequential-test.js";
import { buildSkillEffectivenessReport, renderSkillEffectivenessReport } from "#src/lib/skill-workshop.js";

type Run = { verdict?: string; cost?: number };
const skill = "fixture-skill";

function reportFor(selected: readonly Run[], control: readonly Run[]) {
  const rows = [selected, control].flatMap((runs, arm) => runs.flatMap(({ verdict, cost }, index) => {
    const runId = `${arm}-${index}`;
    return [
      {
        step: "skills.selection", run_id: runId, task_type: "implement", ts: new Date(index * 1000).toISOString(),
        approved_eligible_names: [skill], selected_names: arm === 0 ? [skill] : [],
        withheld_names: arm === 1 ? [skill] : [],
      },
      ...(verdict === undefined ? [] : [{ step: "verdict", run_id: runId, verdict, total_cost_usd: cost }]),
    ];
  }));
  return buildSkillEffectivenessReport(rows, skill);
}

function runs(count: number, verdict: string, cost?: number): Run[] {
  return Array.from({ length: count }, () => ({ verdict, cost }));
}

function exact(difference: number): MergeDifferenceObservation {
  return { lower: difference, upper: difference };
}

test("W1-T14147 criterion 1: at most 6% of null simulations ever decide when read after every run", (t) => {
  const random = seededRandom(14147);
  const trials = 3000;
  let decided = 0;
  let fixedHorizonCrossings = 0;
  for (let trial = 0; trial < trials; trial++) {
    const observations: MergeDifferenceObservation[] = [];
    let sum = 0;
    let everDecided = false;
    let everFixedHorizonRejects = false;
    // Each pair adds one outcome per arm. An intervening unpaired run leaves the test unchanged.
    for (let look = 1; look <= 96; look++) {
      const difference = Number(random() < 0.5) - Number(random() < 0.5);
      observations.push(exact(difference));
      sum += difference;
      const result = mergeDifferenceSequence(observations);
      everDecided ||= result.pValue <= 0.05 || result.lower > 0 || result.upper < 0.02;
      // Under this null the variance per pair is 1/2. Reusing the fixed-look z test is the control.
      everFixedHorizonRejects ||= Math.abs(sum) > 1.96 * Math.sqrt(look / 2);
    }
    decided += Number(everDecided);
    fixedHorizonCrossings += Number(everFixedHorizonRejects);
  }
  assert.ok(decided / trials <= 0.06, `${decided}/${trials} null trials ever decided`);
  assert.ok(fixedHorizonCrossings / trials > 0.06, "the same paths expose repeated fixed-horizon testing");
  t.diagnostic(`${decided}/${trials} anytime decisions, ${fixedHorizonCrossings}/${trials} fixed-horizon crossings`);
});

test("W1-T14147 criterion 2: the normal mixture matches the closed form and stops early on a large effect", () => {
  assert.deepEqual(mergeDifferenceSequence([]), { pairs: 0, lower: -1, upper: 1, pValue: 1 });
  const observations = Array.from({ length: 12 }, () => exact(1));
  const result = mergeDifferenceSequence(observations);
  // For 12 differences of 1 and mixing variance 1/4, the mixture has denominator 2
  // and exponent 12²/(2*16). The interval is the inversion at the same look.
  assert.equal(result.pairs, 12);
  assert.ok(Math.abs(result.pValue - 2 * Math.exp(-4.5)) < 1e-12);
  assert.ok(Math.abs(result.lower - (1 - Math.sqrt(16 * Math.log(1600)) / 12)) < 1e-12);
  assert.equal(result.upper, 1);
  const reversed = mergeDifferenceSequence([...observations, ...observations.map(() => exact(-1))]);
  assert.equal(reversed.pValue, result.pValue, "later disagreement cannot erase an earlier crossing");

  const random = seededRandom(14148);
  let earlyDecisions = 0;
  const trials = 100;
  const fixedHorizon = 100;
  for (let trial = 0; trial < trials; trial++) {
    const paired = Array.from({ length: fixedHorizon }, () => exact(Number(random() < 0.9) - Number(random() < 0.1)));
    const stop = paired.findIndex((_, index) => mergeDifferenceSequence(paired.slice(0, index + 1)).lower > 0);
    earlyDecisions += Number(stop >= 0 && stop < fixedHorizon / 2);
  }
  assert.ok(earlyDecisions >= 90, `${earlyDecisions}/${trials} large effects decided before half the horizon`);
});

test("W1-T14147 criterion 3: a noisy merge deficit leaves the skill undecided", () => {
  const report = reportFor(
    [...runs(4, "merged"), ...runs(6, "no_diff")],
    [...runs(5, "merged"), ...runs(5, "no_diff")],
  );
  assert.equal(report.status, "INSUFFICIENT EVIDENCE");
  assert.equal(report.basis, "undecided");
  assert.match(renderSkillEffectivenessReport(report), /merge comparison:.*confidence sequence.*always-valid p=/);
});

test("W1-T14147 criterion 4: a clear merge deficit retires and harm and cost retain precedence", () => {
  const inferior = reportFor(runs(24, "no_diff"), runs(24, "merged"));
  assert.equal(inferior.basis, "not-better-than-control");
  assert.equal(inferior.status, "RETIRE-CANDIDATE");
  assert.ok(inferior.merge_difference.upper < 0);

  const belowMinimum = reportFor(runs(10, "no_diff"), runs(10, "merged"));
  assert.ok(belowMinimum.merge_difference.upper > 0);
  assert.ok(belowMinimum.merge_difference.upper < 0.02);
  assert.equal(belowMinimum.basis, "not-better-than-control");

  const harmful = reportFor([...runs(18, "merged"), ...runs(6, "failed")], runs(24, "no_diff"));
  assert.ok(harmful.merge_difference.lower > 0);
  assert.equal(harmful.basis, "named-harm-signal");

  const expensive = reportFor(runs(24, "merged", 100), [...runs(5, "merged", 1), ...runs(19, "no_diff", 1)]);
  assert.ok(expensive.merge_difference.lower > 0);
  assert.equal(expensive.basis, "costs-more-than-it-saves");
});

test("unresolved outcomes in either arm widen the merge sequence and delay a decision", () => {
  const merged = runs(24, "merged");
  const pending = runs(24, "handed_off");
  const noDiff = runs(24, "no_diff");
  const unfavorable = reportFor(pending, merged);
  const favorable = reportFor(merged, pending);
  for (const report of [unfavorable, favorable]) {
    assert.equal(report.basis, "undecided");
    assert.equal(report.merge_difference.pValue, 1);
  }
  assert.equal(reportFor(noDiff, merged).basis, "not-better-than-control");
  assert.equal(reportFor(merged, noDiff).basis, "favorable-comparison");
});

test("an enrolled run without a verdict retains its place in the comparison", () => {
  const control = runs(12, "no_diff");
  const completed = runs(12, "merged");
  const waiting = reportFor([{}, {}, ...completed], control);
  assert.equal(waiting.merge_difference.pairs, 12);
  assert.equal(waiting.basis, "undecided");
  assert.equal(reportFor([...runs(2, "merged"), ...completed], control).basis, "favorable-comparison");
});

test("inconsistent merge evidence leaves the skill undecided", () => {
  const report = reportFor(
    [...runs(50, "merged"), ...runs(300, "no_diff")],
    [...runs(50, "no_diff"), ...runs(300, "merged")],
  );
  assert.ok(report.merge_difference.lower > report.merge_difference.upper);
  assert.equal(report.basis, "undecided");
  assert.match(renderSkillEffectivenessReport(report), /confidence sequence empty/);
});
