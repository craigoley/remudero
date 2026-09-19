import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ATTRIBUTION_POLICY,
  MIN_POPULATION_FLOOR,
  verdictCalibrationReport,
  type VerdictRow,
} from "../src/lib/verdict-calibration.js";
import {
  OPERATOR_AGENT_OUTCOMES_VERSION,
  operatorAgentOutcomeReport,
} from "../src/lib/operator-agent-outcomes.js";

const SHA = (n: number): string => n.toString(16).padStart(40, "0");

function dumpOf(commits: Array<{ sha: string; ts: string; subject: string; body?: string; files?: string[] }>): string {
  return commits
    .map((commit) => `\x02${commit.sha}\x00${commit.ts}\x00${commit.subject}\x00${commit.body ?? ""}\x01\n${(commit.files ?? []).join("\n")}\n`)
    .join("");
}

function measurableRows(count: number, lane = "review"): {
  rows: VerdictRow[];
  commits: Array<{ sha: string; ts: string; subject: string; body?: string; files: string[] }>;
} {
  const rows: VerdictRow[] = [];
  const commits: Array<{ sha: string; ts: string; subject: string; body?: string; files: string[] }> = [];
  for (let i = 0; i < count; i++) {
    const taskId = `W1-T3795-${i}`;
    rows.push({
      taskId,
      headSha: `head-${i}`,
      armedTs: "2026-01-01T00:00:00.000Z",
      lane,
      verdictClass: "full-pass",
    });
    commits.push({
      sha: SHA(i + 1),
      ts: "2026-01-02T00:00:00+00:00",
      subject: `feat(console): outcome ${taskId}`,
      files: [`src/outcome-${i}.ts`],
    });
  }
  return { rows, commits };
}

// W1-T3795 criterion 1 in test/operator-agent-outcomes.test.ts
test("reports rates with the attribution policy and a named denominator", () => {
  const { rows, commits } = measurableRows(MIN_POPULATION_FLOOR);
  commits.push({
    sha: SHA(100),
    ts: "2026-01-03T00:00:00+00:00",
    subject: `Revert "feat(console): outcome ${rows[0].taskId}"`,
    body: `This reverts commit ${SHA(1)}.`,
    files: ["src/outcome-0.ts"],
  });
  commits.push({
    sha: SHA(101),
    ts: "2026-01-04T00:00:00+00:00",
    subject: "fix(console): repair the measured outcome",
    files: ["src/outcome-1.ts"],
  });

  const projection = operatorAgentOutcomeReport(verdictCalibrationReport(rows, dumpOf(commits)));
  const fullPass = projection.classes.find((outcome) => outcome.verdictClass === "full-pass")!;

  assert.equal(projection.version, OPERATOR_AGENT_OUTCOMES_VERSION);
  assert.equal(projection.status, "measured");
  assert.deepEqual(projection.attributionPolicy, ATTRIBUTION_POLICY);
  assert.equal(projection.minPopulationFloor, MIN_POPULATION_FLOOR);
  assert.equal(fullPass.denominator, MIN_POPULATION_FLOOR);
  assert.equal(fullPass.revertedCount, 1);
  assert.equal(fullPass.followupFixedCount, 1);
  assert.equal(fullPass.revertRate, 1 / MIN_POPULATION_FLOOR);
  assert.equal(fullPass.followupFixRate, 1 / MIN_POPULATION_FLOOR);
});

// W1-T3795 criterion 2 in test/operator-agent-outcomes.test.ts
test("keeps below-floor, mixed-lane, and unmeasurable rows explicit", () => {
  const belowFloor = measurableRows(1);
  belowFloor.rows[0].verdictClass = "keyword-floor";
  const mixed = measurableRows(MIN_POPULATION_FLOOR, "review");
  mixed.rows[0].lane = "operator";
  const unmeasurable: VerdictRow = {
    taskId: "W1-T3795-unmeasurable",
    headSha: "missing-review-head",
    armedTs: "2026-01-01T00:00:00.000Z",
    verdictClass: null,
    classifyWhy: "worker result did not produce a review verdict",
    unjoinableCause: "no-review-posted",
  };
  const report = verdictCalibrationReport(
    [...belowFloor.rows, ...mixed.rows, unmeasurable],
    dumpOf([...belowFloor.commits, ...mixed.commits]),
  );
  const projection = operatorAgentOutcomeReport(report);
  const fullPass = projection.classes.find((outcome) => outcome.verdictClass === "full-pass")!;
  const keywordFloor = projection.classes.find((outcome) => outcome.verdictClass === "keyword-floor")!;

  assert.equal(projection.status, "measured");
  assert.equal(keywordFloor.denominator, 1);
  assert.equal(keywordFloor.revertRate, null);
  assert.equal(keywordFloor.followupFixRate, null);
  assert.equal(keywordFloor.rateRefusedReason, "below-population-floor");
  assert.equal(fullPass.denominator, MIN_POPULATION_FLOOR);
  assert.equal(fullPass.revertRate, null);
  assert.equal(fullPass.followupFixRate, null);
  assert.equal(fullPass.rateRefusedReason, "mixed-lane-population");
  assert.equal(projection.armsSeen, MIN_POPULATION_FLOOR + 2);
  assert.equal(projection.armsClassified, MIN_POPULATION_FLOOR + 1);
  assert.equal(projection.unmeasurable.length, 1);
  assert.equal(projection.unmeasurable[0].cause, "no-review-posted");
  assert.equal(projection.unmeasurableByCause["no-review-posted"], 1);

  const historyUnavailable = operatorAgentOutcomeReport(
    verdictCalibrationReport(belowFloor.rows, "partial history", { gitReadError: "shallow clone" }),
  );
  assert.equal(historyUnavailable.status, "not-collected");
  assert.match(historyUnavailable.notCollectedReason ?? "", /required git history unavailable/);
  assert.equal(historyUnavailable.unmeasurableByCause["git-history-unavailable"], 1);
});

// W1-T3795 criterion 3 in test/operator-agent-outcomes.test.ts
test("does not classify a failed worker result as a reverted task", () => {
  const report = verdictCalibrationReport(
    [
      {
        taskId: "W1-T3795-worker-failed",
        headSha: "worker-failed-head",
        armedTs: "2026-01-01T00:00:00.000Z",
        verdictClass: null,
        classifyWhy: "worker failed before review.posted was written",
        unjoinableCause: "no-review-posted",
      },
    ],
    dumpOf([
      {
        sha: SHA(200),
        ts: "2026-01-03T00:00:00+00:00",
        subject: "fix(worker): repair an unrelated worker failure",
        files: ["src/worker.ts"],
      },
    ]),
  );
  const projection = operatorAgentOutcomeReport(report);

  assert.equal(projection.status, "not-collected");
  assert.match(projection.notCollectedReason ?? "", /no verdict outcome could be joined/);
  assert.equal(projection.armsClassified, 0);
  assert.equal(projection.classes.every((outcome) => outcome.revertedCount === 0), true);
  assert.equal(projection.unmeasurable[0].cause, "no-review-posted");
});
