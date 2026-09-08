// Standing rule 28 (MASTER-PLAN §12, DR-28, P47) as CODE: a terminal run verdict records what the
// orchestrator observed at that instant, not whether the pull request ultimately failed. R44 read
// eight `blocked_ci` verdicts as eight verification failures and seven of them had already merged
// gate-side; R45 read five and four had. The census below joins every member to the SAME SHIPPED
// union `renderGather` already prints before classifying it, names the join's source, and keeps an
// unjoinable member UNCONFIRMED rather than counting it as a failure.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildGather,
  censusMergeStateFrom,
  gatherRuns,
  infrastructureEvents,
  loadMastMapping,
  mastCategoryDistribution,
  mastDistributionTable,
  parseLedger,
  renderGather,
  taskDefectCounts,
  type CensusMergeState,
  type ShippedGithub,
  type ShippedRecord,
} from "../src/lib/retro.js";

const REAL_MAPPING = loadMastMapping(join(process.cwd(), "plan", "mast-mapping.yaml"));

function line(runId: string, taskId: string, verdict: string, prUrl?: string): string[] {
  return [
    `{"ts":"2026-09-02T12:30:00.000Z","run_id":"${runId}","task_id":"${taskId}","step":"run.start","type":"implement"}`,
    `{"ts":"2026-09-02T13:00:00.000Z","run_id":"${runId}","task_id":"${taskId}","step":"verdict","verdict":"${verdict}","cost_usd":5${
      prUrl ? `,"pr_url":"${prUrl}"` : ""
    }}`,
  ];
}

// R44's shape in miniature: three blocked_ci runs, two of which merged gate-side; one guard-fired
// containment block; one blocked_review that genuinely never merged.
const RUN_MERGED_A = "W1-T2613-1788352000000";
const RUN_MERGED_B = "W1-T2617-1788352100000";
const RUN_REAL_FAIL = "W1-T2999-1788352200000";
const RUN_GUARD = "W1-T2998-1788352300000";
const RUN_REVIEW = "W1-T2997-1788352400000";
const LEDGER = [
  ...line(RUN_MERGED_A, "W1-T2613", "blocked_ci", "https://github.com/o/r/pull/3651"),
  ...line(RUN_MERGED_B, "W1-T2617", "blocked_ci", "https://github.com/o/r/pull/3661"),
  ...line(RUN_REAL_FAIL, "W1-T2999", "blocked_ci", "https://github.com/o/r/pull/3999"),
  ...line(RUN_GUARD, "W1-T2998", "blocked_containment"),
  ...line(RUN_REVIEW, "W1-T2997", "blocked_review", "https://github.com/o/r/pull/3997"),
].join("\n");

const SHIPPED: ShippedRecord[] = [
  { taskId: "W1-T2613", runId: RUN_MERGED_A, prUrl: "https://github.com/o/r/pull/3651", costUsd: 5, numTurns: 0, source: "github", annotation: "gate-side merge; run ended blocked_ci" },
  { taskId: "W1-T2617", runId: RUN_MERGED_B, prUrl: "https://github.com/o/r/pull/3661", costUsd: 5, numTurns: 0, source: "github", annotation: "gate-side merge; run ended blocked_ci" },
];

const JOINED: CensusMergeState = { creditedRunIds: new Set([RUN_MERGED_A, RUN_MERGED_B]), source: "github" };

test("a verdict-blocked run whose PR merged gate-side is RECONCILED and named, never a verification failure", () => {
  const runs = gatherRuns(parseLedger(LEDGER));
  const dist = mastCategoryDistribution(runs, REAL_MAPPING, JOINED);
  assert.deepEqual(dist.byCategory, { infrastructure: 1, verification: 2 }, "only the un-merged blocked_ci and the blocked_review count as verification");
  assert.deepEqual(
    dist.reconciled.map((m) => [m.taskId, m.verdict]),
    [["W1-T2613", "blocked_ci"], ["W1-T2617", "blocked_ci"]],
    "both merged members are named with the verdict the ledger recorded",
  );
  assert.deepEqual(dist.unconfirmed, {});
  assert.equal(dist.mergeStateSource, "github");
  // The per-task defect census and the infrastructure list honour the same join.
  assert.deepEqual(taskDefectCounts(runs, REAL_MAPPING, JOINED), { "W1-T2997": 1, "W1-T2999": 1 });
  assert.equal(infrastructureEvents(runs, REAL_MAPPING, JOINED).length, 1);
});

test("FALSIFIER: without the join the same corpus reads four verification failures — the old, wrong census is reachable only by omitting merge state", () => {
  const runs = gatherRuns(parseLedger(LEDGER));
  const dist = mastCategoryDistribution(runs, REAL_MAPPING);
  assert.deepEqual(dist.byCategory, { infrastructure: 1, verification: 4 });
  assert.deepEqual(dist.reconciled, []);
  assert.equal(dist.mergeStateSource, "ledger-only", "the un-joined census must SAY it is un-joined");
  assert.match(mastDistributionTable(dist), /Merge-state join: ledger-only — NOT joined to live merge state/);
});

test("an UNAVAILABLE gateway leaves every un-credited PR-bearing member UNCONFIRMED, never a failure; a guard-fired block stays a host signal", () => {
  const runs = gatherRuns(parseLedger(LEDGER));
  const state: CensusMergeState = { creditedRunIds: new Set([RUN_MERGED_A]), source: "unavailable", unavailableReason: "HTTP 403 secondary rate limit" };
  const dist = mastCategoryDistribution(runs, REAL_MAPPING, state);
  assert.deepEqual(dist.byCategory, { infrastructure: 1 }, "the containment block never opened a PR, so its classification does not depend on merge state");
  assert.deepEqual(dist.unconfirmed, { blocked_ci: 2, blocked_review: 1 });
  assert.equal(dist.reconciled.length, 1, "a credit the union already holds still reconciles under an outage");
  assert.deepEqual(taskDefectCounts(runs, REAL_MAPPING, state), {}, "an unconfirmed member is never a task defect");
  const rendered = mastDistributionTable(dist, undefined, state.unavailableReason);
  assert.match(rendered, /Merge-state join: UNAVAILABLE \(HTTP 403 secondary rate limit\) — 3 member\(s\) UNCONFIRMED, never counted as failures/);
  assert.match(rendered, /blocked_ci×2, blocked_review×1/);
});

test("the rendered table names each reconciled member beside the categories it was excluded from", () => {
  const runs = gatherRuns(parseLedger(LEDGER));
  const rendered = mastDistributionTable(mastCategoryDistribution(runs, REAL_MAPPING, JOINED), { verification: 8 });
  assert.match(rendered, /\| verification \| 2 \| -6 \|/);
  assert.match(rendered, /Merge-state join: github — 2 verdict-blocked run\(s\) merged gate-side and are excluded above \(Standing rule 28\)/);
  assert.match(rendered, /- W1-T2613 \(W1-T2613-1788352000000\): ledger verdict=blocked_ci, PR MERGED — reconciled, not a failure/);
});

test("censusMergeStateFrom derives the join from the SHIPPED union and names its source: no gateway, a healthy one, a degraded one", () => {
  const github: ShippedGithub = { findMergedByTrailer: () => null, headRefName: () => undefined };
  assert.deepEqual(censusMergeStateFrom(SHIPPED, undefined, undefined), { creditedRunIds: new Set([RUN_MERGED_A, RUN_MERGED_B]), source: "ledger-only" });
  assert.deepEqual(censusMergeStateFrom(SHIPPED, github, undefined), { creditedRunIds: new Set([RUN_MERGED_A, RUN_MERGED_B]), source: "github" });
  assert.deepEqual(censusMergeStateFrom([], github, "throttled"), { creditedRunIds: new Set(), source: "unavailable", unavailableReason: "throttled" });
});

test("buildGather wires the join: a gateway that credits a blocked_ci run gate-side removes it from the MAST census, the defect counts and the infrastructure list in one pass", () => {
  const merged = new Map([
    ["W1-T2613", { number: 3651, url: "https://github.com/o/r/pull/3651" }],
    ["W1-T2617", { number: 3661, url: "https://github.com/o/r/pull/3661" }],
  ]);
  const github: ShippedGithub = {
    findMergedByTrailer: (taskId) => merged.get(taskId) ?? null,
    // The P9 ownership assert: each PR's head is its claiming run's own branch.
    headRefName: (prUrl) => (prUrl.endsWith("3651") ? `run-${RUN_MERGED_A}` : prUrl.endsWith("3661") ? `run-${RUN_MERGED_B}` : undefined),
  };
  const g = buildGather({ ledgerNdjson: LEDGER, learningsMd: "", github, mastMapping: REAL_MAPPING });
  assert.equal(g.shipped.length, 2, "the union credits both gate-side merges");
  assert.deepEqual(g.mast.byCategory, { infrastructure: 1, verification: 2 });
  assert.deepEqual(g.mast.reconciled.map((m) => m.taskId), ["W1-T2613", "W1-T2617"]);
  assert.equal(g.mast.mergeStateSource, "github");
  assert.deepEqual(g.taskDefectCounts, { "W1-T2997": 1, "W1-T2999": 1 });
  assert.equal(g.infrastructureEvents.length, 1);
  const rendered = renderGather(g);
  assert.match(rendered, /Merge-state join: github — 2 verdict-blocked run\(s\)/);

  // Under a degraded gateway the same corpus renders UNCONFIRMED members and carries the reason.
  const degraded: ShippedGithub = { ...github, unavailable: () => "GitHub gateway throttled" };
  const g2 = buildGather({ ledgerNdjson: LEDGER, learningsMd: "", github: degraded, mastMapping: REAL_MAPPING });
  assert.equal(g2.mast.mergeStateSource, "unavailable");
  assert.deepEqual(g2.mast.unconfirmed, { blocked_ci: 1, blocked_review: 1 });
  assert.match(renderGather(g2), /Merge-state join: UNAVAILABLE \(GitHub gateway throttled\)/);

  // No gateway at all: the census says so instead of pretending it joined.
  const g3 = buildGather({ ledgerNdjson: LEDGER, learningsMd: "", mastMapping: REAL_MAPPING });
  assert.equal(g3.mast.mergeStateSource, "ledger-only");
  assert.deepEqual(g3.mast.byCategory, { infrastructure: 1, verification: 4 });
});
