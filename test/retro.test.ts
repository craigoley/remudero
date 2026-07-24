import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateByClass,
  aggregateByType,
  applyContestedLifecycle,
  applyContradictionResolution,
  assertArchitectAboveWorker,
  buildGather,
  calibrationTable,
  classCalibrationTable,
  codeFilesInDiff,
  contradictionQuestion,
  DEGRADED_SUCCESS_SIGNALS,
  extractStandingRules,
  fixDispatchCountByRun,
  flagContradictions,
  gatherRuns,
  keyContradictionCandidates,
  mergedSince,
  mineDegradedSuccess,
  mineFollowups,
  mineOverrunClasses,
  mineProceduralCandidates,
  ownBranchOf,
  parseLedger,
  phraseProceduralCandidate,
  planHealthSweep,
  PROCEDURAL_SUCCESS_SIGNALS,
  recordFollowupHarvest,
  renderContradictions,
  renderDegradedSuccess,
  renderFollowupCandidates,
  renderGather,
  renderOrientation,
  renderOverrunProposals,
  renderPlanHealth,
  renderProceduralCandidates,
  shippedSince,
  tierOf,
  verdictDistribution,
  type ContradictionCandidatePair,
  type DegradedSuccessSignal,
  type ProceduralCandidate,
  type RunSummary,
  type ShippedGithub,
} from "../src/lib/retro.js";
import type { Task } from "../src/lib/plan.js";
import { selectLearnings, type LearningEntry } from "../src/lib/learnings.js";

// A recorded ledger fixture: two implement runs (one merged, one budget-blocked)
// and a recon run, exactly as run-task.ts writes them.
const LEDGER = [
  `{"ts":"2026-01-01T00:00:00.000Z","run_id":"A","task_id":"TA","step":"run.start","type":"implement","budget_usd":100,"task_class":"docs"}`,
  `{"ts":"2026-01-01T00:01:00.000Z","run_id":"A","task_id":"TA","step":"recon.done","num_turns":2,"cost_usd":0.2}`,
  `{"ts":"2026-01-01T00:02:00.000Z","run_id":"A","task_id":"TA","step":"implement.done","num_turns":10,"cost_usd":1.5}`,
  `{"ts":"2026-01-01T00:03:00.000Z","run_id":"A","task_id":"TA","step":"pr.opened","pr_url":"https://github.com/o/r/pull/1"}`,
  `{"ts":"2026-01-01T00:04:00.000Z","run_id":"A","task_id":"TA","step":"verdict","verdict":"merged","cost_usd":2.0,"pr_url":"https://github.com/o/r/pull/1"}`,
  `torn line that is not json {{{`,
  `{"ts":"2026-01-02T00:00:00.000Z","run_id":"B","task_id":"TB","step":"run.start","type":"implement","budget_usd":100,"task_class":"src"}`,
  `{"ts":"2026-01-02T00:01:00.000Z","run_id":"B","task_id":"TB","step":"recon.done","num_turns":2}`,
  `{"ts":"2026-01-02T00:02:00.000Z","run_id":"B","task_id":"TB","step":"implement.done","num_turns":30}`,
  `{"ts":"2026-01-02T00:03:00.000Z","run_id":"B","task_id":"TB","step":"verdict","verdict":"blocked_budget","cost_usd":5.0}`,
  `{"ts":"2026-01-03T00:00:00.000Z","run_id":"C","task_id":"TC","step":"run.start","type":"diagnose"}`,
  `{"ts":"2026-01-03T00:01:00.000Z","run_id":"C","task_id":"TC","step":"verdict","verdict":"merged","cost_usd":0.3}`,
].join("\n");

test("parseLedger skips torn lines and keeps the valid ones", () => {
  const recs = parseLedger(LEDGER);
  assert.equal(recs.filter((r) => r.step === "run.start").length, 3);
});

test("gatherRuns reduces per-run: type, verdict, cost, summed turns, prUrl", () => {
  const runs = gatherRuns(parseLedger(LEDGER));
  const a = runs.find((r) => r.runId === "A")!;
  assert.equal(a.type, "implement");
  assert.equal(a.verdict, "merged");
  assert.equal(a.costUsd, 2.0); // the verdict line's total, not the per-step costs
  assert.equal(a.numTurns, 12); // recon 2 + implement 10
  assert.equal(a.prUrl, "https://github.com/o/r/pull/1");
  const b = runs.find((r) => r.runId === "B")!;
  assert.equal(b.verdict, "blocked_budget");
  assert.equal(b.numTurns, 32);
});

test("gatherRuns reads the W1-T167 task_class off run.start; a run that never logged it has no taskClass", () => {
  const runs = gatherRuns(parseLedger(LEDGER));
  assert.equal(runs.find((r) => r.runId === "A")!.taskClass, "docs");
  assert.equal(runs.find((r) => r.runId === "B")!.taskClass, "src");
  assert.equal(runs.find((r) => r.runId === "C")!.taskClass, undefined);
});

test("aggregateByClass (W1-T167): per-class cost/outcome so the retro can evaluate the routing table", () => {
  const agg = aggregateByClass(gatherRuns(parseLedger(LEDGER)));
  const docs = agg.find((c) => c.taskClass === "docs")!;
  assert.equal(docs.runs, 1);
  assert.equal(docs.totalCostUsd, 2.0);
  assert.equal(docs.merged, 1);
  assert.equal(docs.mergeRate, 1);
  const src = agg.find((c) => c.taskClass === "src")!;
  assert.equal(src.runs, 1);
  assert.equal(src.totalCostUsd, 5.0);
  assert.equal(src.merged, 0);
  assert.equal(src.mergeRate, 0);
  // A run that omitted task_class is grouped under "unknown" — NEVER dropped
  // (W1-T167 acceptance: "a run that omits the class/cost FAILS" — omitting it
  // from the aggregate entirely would be the same failure by a different name).
  const unknown = agg.find((c) => c.taskClass === "unknown")!;
  assert.equal(unknown.runs, 1);
  assert.equal(unknown.totalCostUsd, 0.3);
});

test("classCalibrationTable renders a markdown table with a row per class, including merge rate", () => {
  const table = classCalibrationTable(aggregateByClass(gatherRuns(parseLedger(LEDGER))));
  assert.match(table, /task_class \| runs \| merged \| merge rate/);
  assert.match(table, /\| docs \| 1 \| 1 \| 100%/);
  assert.match(table, /\| src \| 1 \| 0 \| 0%/);
});

test("buildGather includes byClass (W1-T167) alongside byType, and renderGather prints it", () => {
  const g = buildGather({ ledgerNdjson: LEDGER, learningsMd: "# L\n" });
  const docs = g.byClass.find((c) => c.taskClass === "docs")!;
  assert.equal(docs.runs, 1);
  assert.equal(docs.merged, 1);
  assert.match(renderGather(g), /Calibration \(BY TASK CLASS, W1-T167\)/);
  assert.match(renderGather(g), /\| docs \| 1 \| 1 \| 100%/);
});

test("aggregateByType is the calibration data mounts.yaml needs (avg cost + turns by type)", () => {
  const agg = aggregateByType(gatherRuns(parseLedger(LEDGER)));
  const impl = agg.find((t) => t.type === "implement")!;
  assert.equal(impl.runs, 2);
  assert.equal(impl.totalCostUsd, 7.0);
  assert.equal(impl.avgCostUsd, 3.5);
  assert.equal(impl.avgTurns, 22); // (12 + 32) / 2
  assert.equal(impl.merged, 1);
});

test("verdictDistribution counts each terminal verdict", () => {
  const dist = verdictDistribution(gatherRuns(parseLedger(LEDGER)));
  assert.deepEqual(dist, { blocked_budget: 1, merged: 2 });
});

test("mergedSince returns merged runs strictly after the marker ts, keyed by task", () => {
  const runs = gatherRuns(parseLedger(LEDGER));
  assert.deepEqual(mergedSince(runs, undefined).map((r) => r.taskId), ["TA", "TC"]);
  // A marker after run A excludes it; C (2026-01-03) still counts.
  assert.deepEqual(mergedSince(runs, "2026-01-02T00:00:00.000Z").map((r) => r.taskId), ["TC"]);
});

test("Tier Invariant (G-17): the Architect must OUTRANK the worker (fail-closed)", () => {
  assert.equal(tierOf("opus"), 3);
  assert.equal(tierOf("sonnet"), 2);
  assert.doesNotThrow(() => assertArchitectAboveWorker("opus", "sonnet"));
  assert.doesNotThrow(() => assertArchitectAboveWorker("claude-opus-4-8", "claude-sonnet-5"));
  assert.throws(() => assertArchitectAboveWorker("sonnet", "sonnet"), /Tier Invariant/);
  assert.throws(() => assertArchitectAboveWorker("sonnet", "opus"), /Tier Invariant/);
});

test("calibrationTable renders a markdown table with a row per type", () => {
  const table = calibrationTable(aggregateByType(gatherRuns(parseLedger(LEDGER))));
  assert.match(table, /task_type \| runs \| merged \| avg \$/);
  assert.match(table, /\| implement \| 2 \| 1 \|/);
  assert.match(table, /\| diagnose \| 1 \| 1 \|/);
});

test("codeFilesInDiff: a plan-only diff touches no src/test; a code diff is caught (fail-closed guard)", () => {
  const planOnly = [
    "diff --git a/MASTER-PLAN.md b/MASTER-PLAN.md",
    "+++ b/MASTER-PLAN.md",
    "+a plan edit",
    "+++ b/LEARNINGS.md",
    "+a learning",
  ].join("\n");
  assert.deepEqual(codeFilesInDiff(planOnly), []);
  const withCode = planOnly + "\n+++ b/src/run-task.ts\n+code\n+++ b/test/x.test.ts\n+t";
  assert.deepEqual(codeFilesInDiff(withCode), ["src/run-task.ts", "test/x.test.ts"]);
});

// ── W1-T51: SHIPPED union (ledger ∪ GitHub-derived trailered merges), P9 ownership assert + correction-awareness ──

// A ledger fixture with: a blocked run whose task later merged gate-side (T-GATE), a
// clean ledger-merged run whose PR IS its own branch (T-OK), and a run modeled on the
// real W1-T54b/#80/#91 false-attribution incident: verdict.pr_url claims #80 (foreign,
// Dependabot's PR) but a correction.provenance line names the true #91.
const SHIP_LEDGER = [
  `{"ts":"2026-02-01T00:00:00.000Z","run_id":"RGATE","task_id":"T-GATE","step":"run.start","type":"implement"}`,
  `{"ts":"2026-02-01T00:01:00.000Z","run_id":"RGATE","task_id":"T-GATE","step":"verdict","verdict":"blocked_review","cost_usd":1.1}`,
  `{"ts":"2026-02-01T01:00:00.000Z","run_id":"ROK","task_id":"T-OK","step":"run.start","type":"implement"}`,
  `{"ts":"2026-02-01T01:01:00.000Z","run_id":"ROK","task_id":"T-OK","step":"pr.opened","pr_url":"https://github.com/o/r/pull/10"}`,
  `{"ts":"2026-02-01T01:02:00.000Z","run_id":"ROK","task_id":"T-OK","step":"verdict","verdict":"merged","cost_usd":2.2,"pr_url":"https://github.com/o/r/pull/10"}`,
  `{"ts":"2026-02-01T02:00:00.000Z","run_id":"W1-T54b-1784151420811","task_id":"W1-T54b","step":"run.start","type":"implement"}`,
  `{"ts":"2026-02-01T02:01:00.000Z","run_id":"W1-T54b-1784151420811","task_id":"W1-T54b","step":"pr.opened","pr_url":"https://github.com/o/r/pull/80"}`,
  `{"ts":"2026-02-01T02:02:00.000Z","run_id":"W1-T54b-1784151420811","task_id":"W1-T54b","step":"verdict","verdict":"merged","cost_usd":3.3,"pr_url":"https://github.com/o/r/pull/80"}`,
  `{"ts":"2026-02-01T02:03:00.000Z","run_id":"W1-T54b-1784151420811","task_id":"W1-T54b","step":"correction.provenance","claimed_pr_url":"https://github.com/o/r/pull/80","actual_pr_url":"https://github.com/o/r/pull/91"}`,
].join("\n");

test("ownBranchOf: a run's own branch is deterministic run-<runId> (matches run-task.ts worktree naming)", () => {
  assert.equal(ownBranchOf("ROK"), "run-ROK");
});

test("gatherRuns: a correction.provenance line OVERRIDES verdict.pr_url (never the claimed URL)", () => {
  const runs = gatherRuns(parseLedger(SHIP_LEDGER));
  const corrected = runs.find((r) => r.runId === "W1-T54b-1784151420811")!;
  assert.equal(corrected.prUrl, "https://github.com/o/r/pull/91");
  assert.equal(corrected.correctedFromPrUrl, "https://github.com/o/r/pull/80");
  // An uncorrected run is untouched.
  const ok = runs.find((r) => r.runId === "ROK")!;
  assert.equal(ok.prUrl, "https://github.com/o/r/pull/10");
  assert.equal(ok.correctedFromPrUrl, undefined);
});

function fakeGithub(overrides: Partial<ShippedGithub> = {}): ShippedGithub {
  return { findMergedByTrailer: () => null, headRefName: () => undefined, ...overrides };
}

test("shippedSince: a gate-side merge (blocked run, later merged on GitHub) is credited + annotated + the discrepancy is NAMED", () => {
  const runs = gatherRuns(parseLedger(SHIP_LEDGER));
  const github = fakeGithub({
    findMergedByTrailer: (taskId) =>
      taskId === "T-GATE" ? { number: 42, url: "https://github.com/o/r/pull/42" } : null,
    headRefName: (url) => (url === "https://github.com/o/r/pull/42" ? "run-RGATE" : undefined),
  });
  const { shipped, discrepancies } = shippedSince(runs, undefined, github);
  const gate = shipped.find((s) => s.taskId === "T-GATE");
  assert.ok(gate, "gate-side merge must appear in SHIPPED additions");
  assert.equal(gate!.source, "github");
  assert.equal(gate!.annotation, "gate-side merge; run ended blocked_review");
  assert.ok(
    discrepancies.some((d) => d.includes("T-GATE") && d.includes("blocked_review")),
    "the discrepancy must be NAMED in the retro output",
  );
});

test("shippedSince: a ledger-merged run with matching ownership behaves as today — included, no annotation", () => {
  const runs = gatherRuns(parseLedger(SHIP_LEDGER));
  const github = fakeGithub({
    headRefName: (url) => (url === "https://github.com/o/r/pull/10" ? "run-ROK" : undefined),
  });
  const { shipped } = shippedSince(runs, undefined, github);
  const ok = shipped.find((s) => s.taskId === "T-OK");
  assert.ok(ok);
  assert.equal(ok!.source, "ledger");
  assert.equal(ok!.annotation, undefined);
});

test("shippedSince: P9 OWNERSHIP ASSERT rejects a trailered PR whose head branch is NOT the claiming run's branch (the #80/W1-T54b class) — never credited; a matching branch IS credited", () => {
  const runs = gatherRuns(parseLedger(SHIP_LEDGER));
  const github = fakeGithub({
    // #80 is foreign (Dependabot's branch); #91 (the corrected URL) IS this run's own branch.
    headRefName: (url) => {
      if (url === "https://github.com/o/r/pull/80") return "dependabot/npm_and_yarn/x";
      if (url === "https://github.com/o/r/pull/91") return "run-W1-T54b-1784151420811";
      return undefined;
    },
  });
  const { shipped, discrepancies } = shippedSince(runs, undefined, github);
  // Correction-aware: the run is credited to #91 (its real, owned PR) — never #80.
  const credited = shipped.find((s) => s.taskId === "W1-T54b");
  assert.ok(credited, "the corrected, owned PR must be credited");
  assert.equal(credited!.prUrl, "https://github.com/o/r/pull/91");
  assert.ok(!shipped.some((s) => s.prUrl === "https://github.com/o/r/pull/80"), "the foreign #80 must NEVER be credited");
  assert.ok(
    !discrepancies.some((d) => d.includes("W1-T54b")),
    "no rejection needed for W1-T54b once the correction is honored — #80 was never even checked",
  );
});

test("shippedSince: OWNERSHIP ASSERT rejects when no correction exists and the ledger's own claimed PR is foreign — GitHub-side trailer with a mismatched branch is rejected too", () => {
  const runs: ReturnType<typeof gatherRuns> = [
    { runId: "RFOREIGN", taskId: "T-FOREIGN", type: "implement", startTs: "2026-03-01T00:00:00.000Z", verdict: "merged", costUsd: 1, numTurns: 5, prUrl: "https://github.com/o/r/pull/999" },
    { runId: "RGATE2", taskId: "T-GATE2", type: "implement", startTs: "2026-03-01T00:00:00.000Z", verdict: "blocked_budget", costUsd: 1, numTurns: 5 },
  ];
  const github = fakeGithub({
    headRefName: (url) => (url === "https://github.com/o/r/pull/999" ? "someone-elses-branch" : undefined),
    findMergedByTrailer: (taskId) =>
      taskId === "T-GATE2" ? { number: 7, url: "https://github.com/o/r/pull/7" } : null,
    // pull/7's head branch resolves to something other than run-RGATE2 too.
  });
  const { shipped, discrepancies } = shippedSince(runs, undefined, github);
  assert.deepEqual(shipped, []);
  assert.ok(discrepancies.some((d) => d.includes("T-FOREIGN") && /reject/i.test(d)));
  assert.ok(discrepancies.some((d) => d.includes("T-GATE2") && /reject/i.test(d)));
});

test("buildGather: without a github gateway, shipped falls back to the ledger-only list (no regression, no unverified annotation)", () => {
  const g = buildGather({ ledgerNdjson: SHIP_LEDGER, learningsMd: "# L\n- a\n" });
  assert.ok(g.shipped.some((s) => s.taskId === "T-OK"));
  assert.ok(g.shipped.every((s) => s.annotation === undefined));
  assert.deepEqual(g.discrepancies, []);
});

test("buildGather: with a github gateway, shipped is the full union and renderGather names the discrepancies", () => {
  const github = fakeGithub({
    findMergedByTrailer: (taskId) =>
      taskId === "T-GATE" ? { number: 42, url: "https://github.com/o/r/pull/42" } : null,
    headRefName: (url) =>
      url === "https://github.com/o/r/pull/42" ? "run-RGATE" : url === "https://github.com/o/r/pull/10" ? "run-ROK" : undefined,
  });
  const g = buildGather({ ledgerNdjson: SHIP_LEDGER, learningsMd: "# L\n- a\n", github });
  assert.ok(g.shipped.some((s) => s.taskId === "T-GATE" && s.annotation));
  assert.ok(g.discrepancies.some((d) => d.includes("T-GATE")));
});

test("buildGather scopes runs by the marker and computes the learnings delta", () => {
  const g = buildGather({
    ledgerNdjson: LEDGER,
    learningsMd: "# L\n- a\n- b\n- c\n",
    sinceTs: "2026-01-02T00:00:00.000Z",
    learningsAtMarker: 1,
  });
  // Only runs started after the marker: B (2026-01-02 is NOT strictly after) and C.
  assert.equal(g.totalRuns, 1); // only C started strictly after 2026-01-02T00:00:00
  assert.equal(g.learningsNow, 3);
  assert.equal(g.learningsNow - g.learningsAtMarker, 2);
});

// ── §5C plan-health sweep (W1-T20d) ────────────────────────────────────────

/** A minimal, otherwise-clean OPEN Task fixture (mirrors test/task-linter.test.ts's shape). */
function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    acceptance: [{ claim: "does the thing", proof: "unit test test/foo.test.ts asserts the thing" }],
    ...over,
  };
}

test("planHealthSweep: an OPEN task violating a standing rule (Rule 19 sizing) is FLAGGED and a corrective task is filed", () => {
  const violating = task({
    id: "W1-T-SEED",
    files: ["src/lib/foo.ts"],
    acceptance: [
      { claim: "the daemon does X", proof: "unit test asserts X" },
      { claim: "launchctl loads the unit", proof: "unit test asserts the unit" },
    ],
  });
  const clean = task({ id: "W1-T-CLEAN" });
  const report = planHealthSweep([violating, clean]);
  assert.equal(report.flags.length, 1);
  assert.equal(report.flags[0]!.taskId, "W1-T-SEED");
  assert.ok(report.flags[0]!.violations.some((v) => v.check === "sizing"));
  assert.equal(report.correctiveTasks.length, 1);
  assert.equal(report.correctiveTasks[0]!.forTaskId, "W1-T-SEED");
  assert.equal(report.correctiveTasks[0]!.origin, "retro#plan-health");
  assert.ok(/sizing/.test(report.correctiveTasks[0]!.title));
});

test("planHealthSweep: a MERGED/DONE task is out of scope even if it would otherwise violate a rule", () => {
  const shippedButBad = task({
    id: "W1-T-OLD",
    status: "merged",
    files: ["src/lib/foo.ts"],
    acceptance: [{ claim: "the daemon does X", proof: "unit test asserts X" }],
  });
  const report = planHealthSweep([shippedButBad]);
  assert.deepEqual(report.flags, []);
  assert.deepEqual(report.correctiveTasks, []);
});

test("planHealthSweep: a WARN-only violation (budget-sanity) is never filed as a corrective task", () => {
  const t = task({ id: "W1-T-WARN" });
  const report = planHealthSweep([t], () => ({ mountMaxTurns: 10, calibration: { avgTurns: 45.2 } }));
  assert.deepEqual(report.flags, []);
  assert.deepEqual(report.correctiveTasks, []);
});

test("renderPlanHealth reports 'no violations' when the open queue is clean", () => {
  const report = planHealthSweep([task({ id: "W1-T-CLEAN" })]);
  assert.match(renderPlanHealth(report), /No violations/);
});

test("renderPlanHealth names the flagged task and its corrective task when the queue is dirty", () => {
  const violating = task({
    id: "W1-T-SEED",
    acceptance: [{ claim: "operator confirms the thing", proof: "unit test asserts the thing" }],
  });
  const report = planHealthSweep([violating]);
  const rendered = renderPlanHealth(report);
  assert.match(rendered, /W1-T-SEED/);
  assert.match(rendered, /Plan-health: fix W1-T-SEED/);
});

// ── Mining overruns for a CLASS-level fix (Standing rule 20) ───────────────

/** A minimal RunSummary fixture for overrun-mining tests. */
function run(over: Partial<RunSummary> & { runId: string; taskId: string }): RunSummary {
  return {
    type: "implement",
    startTs: "2026-01-01T00:00:00.000Z",
    verdict: "failed",
    costUsd: 5,
    numTurns: 80,
    risk: "medium",
    subtype: "error_max_turns",
    ...over,
  };
}

test("mineOverrunClasses: N max_turns verdicts across ONE class propose ONE class-level fix, not N per-task patches", () => {
  const runs = [
    run({ runId: "R1", taskId: "W1-T6" }),
    run({ runId: "R2", taskId: "W1-T9" }),
    run({ runId: "R3", taskId: "W1-T12" }),
  ];
  const proposals = mineOverrunClasses(runs);
  assert.equal(proposals.length, 1); // ONE proposal, not 3
  const p = proposals[0]!;
  assert.equal(p.taskType, "implement");
  assert.equal(p.risk, "medium");
  assert.equal(p.count, 3);
  assert.deepEqual(p.taskIds, ["W1-T12", "W1-T6", "W1-T9"]);
  assert.match(p.proposal, /class-level fix/);
});

test("mineOverrunClasses: a class below threshold (a single incident) proposes NOTHING", () => {
  const runs = [run({ runId: "R1", taskId: "W1-T-ONEOFF" })];
  assert.deepEqual(mineOverrunClasses(runs), []);
});

test("mineOverrunClasses: distinct classes each get their OWN proposal, and a merged run never counts", () => {
  const runs = [
    run({ runId: "R1", taskId: "W1-T6", type: "implement", risk: "medium" }),
    run({ runId: "R2", taskId: "W1-T9", type: "implement", risk: "medium" }),
    run({ runId: "R3", taskId: "W1-T-R1", type: "review", risk: "low", verdict: "blocked_review", subtype: undefined }),
    run({ runId: "R4", taskId: "W1-T-R2", type: "review", risk: "low", verdict: "blocked_review", subtype: undefined }),
    run({ runId: "R5", taskId: "W1-T-OK", verdict: "merged", subtype: undefined }),
  ];
  const proposals = mineOverrunClasses(runs);
  assert.equal(proposals.length, 2);
  assert.ok(proposals.some((p) => p.taskType === "implement" && p.risk === "medium"));
  assert.ok(proposals.some((p) => p.taskType === "review" && p.risk === "low"));
  assert.ok(!proposals.some((p) => p.taskIds.includes("W1-T-OK")));
});

test("renderOverrunProposals reports 'no pattern' when nothing meets threshold", () => {
  assert.match(renderOverrunProposals([]), /No class-level pattern/);
});

test("renderOverrunProposals names the proposed fix when a class overruns", () => {
  const proposals = mineOverrunClasses([
    run({ runId: "R1", taskId: "W1-T6" }),
    run({ runId: "R2", taskId: "W1-T9" }),
  ]);
  assert.match(renderOverrunProposals(proposals), /implement×medium/);
});

// ── Degraded-success mining (W1-T73) — a PASS that used a weaker path ─────

// The canonical fixture (RETRO-1784213948025/W1-T65): RD1 merged at proof_exec
// 0/2, floor_degraded (>=1 dialect-prefixed proof present, nothing OBSERVED).
// RD2 is a fully-observed sibling — N/N executed — that must emit NOTHING.
const DEGRADED_LEDGER = [
  `{"ts":"2026-03-01T00:00:00.000Z","run_id":"RD1","task_id":"W1-T200","step":"run.start","type":"implement"}`,
  `{"ts":"2026-03-01T00:01:00.000Z","run_id":"RD1","task_id":"W1-T200","step":"review.posted","state":"success","proof_exec":["not_executable","not_executable"],"floor_degraded":true}`,
  `{"ts":"2026-03-01T00:02:00.000Z","run_id":"RD1","task_id":"W1-T200","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/200"}`,
  `{"ts":"2026-03-02T00:00:00.000Z","run_id":"RD2","task_id":"W1-T201","step":"run.start","type":"implement"}`,
  `{"ts":"2026-03-02T00:01:00.000Z","run_id":"RD2","task_id":"W1-T201","step":"review.posted","state":"success","proof_exec":["executed_pass","executed_pass"],"floor_degraded":false}`,
  `{"ts":"2026-03-02T00:02:00.000Z","run_id":"RD2","task_id":"W1-T201","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/201"}`,
].join("\n");

test("mineDegradedSuccess: a merged run at proof_exec 0/N with a dialect-prefixed proof present (floor_degraded) emits a finding naming the run", () => {
  const records = parseLedger(DEGRADED_LEDGER);
  const findings = mineDegradedSuccess(gatherRuns(records), records);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.taskId, "W1-T200");
  assert.equal(findings[0]!.runId, "RD1");
  assert.equal(findings[0]!.signal, "zero_executed_dialect");
});

test("mineDegradedSuccess: a fully-observed merged run (N/N) emits nothing; mining the SAME fixture twice emits no duplicate", () => {
  const records = parseLedger(DEGRADED_LEDGER);
  const runs = gatherRuns(records);
  assert.ok(!mineDegradedSuccess(runs, records).some((f) => f.taskId === "W1-T201"));
  const first = mineDegradedSuccess(runs, records);
  const second = mineDegradedSuccess(runs, records);
  assert.equal(first.length, 1); // one finding, not two — a re-run is not a re-count
  assert.deepEqual(first, second);
});

test("mineDegradedSuccess: the signal set is DATA — a caller-supplied second row (reviewer_outcome=error_max_turns) flags a matching run with ZERO executor-code changes", () => {
  const ledger = [
    `{"ts":"2026-03-03T00:00:00.000Z","run_id":"RD3","task_id":"W1-T202","step":"run.start","type":"implement"}`,
    `{"ts":"2026-03-03T00:01:00.000Z","run_id":"RD3","task_id":"W1-T202","step":"review.posted","state":"success","proof_exec":["executed_pass"],"floor_degraded":false,"reviewer_outcome":"error_max_turns"}`,
    `{"ts":"2026-03-03T00:02:00.000Z","run_id":"RD3","task_id":"W1-T202","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/202"}`,
  ].join("\n");
  const records = parseLedger(ledger);
  const runs = gatherRuns(records);
  // The shipped row 1 alone doesn't catch it — fully executed, no floor fallback.
  assert.deepEqual(mineDegradedSuccess(runs, records, [DEGRADED_SUCCESS_SIGNALS[0]!]), []);
  // A brand-new signal row — no new mining function, no new branch — catches it.
  const extraRow: DegradedSuccessSignal = {
    key: "reviewer_error_max_turns",
    matches: (r) => r.reviewerOutcome === "error_max_turns",
    describe: () => "reviewer_outcome=error_max_turns",
  };
  const findings = mineDegradedSuccess(runs, records, [DEGRADED_SUCCESS_SIGNALS[0]!, extraRow]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.taskId, "W1-T202");
  assert.equal(findings[0]!.signal, "reviewer_error_max_turns");
});

test("mineDegradedSuccess: a run with no review.posted line at all is silently skipped — nothing to mine", () => {
  const ledger = [
    `{"ts":"2026-03-04T00:00:00.000Z","run_id":"RD4","task_id":"W1-T203","step":"run.start","type":"implement"}`,
    `{"ts":"2026-03-04T00:01:00.000Z","run_id":"RD4","task_id":"W1-T203","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/203"}`,
  ].join("\n");
  const records = parseLedger(ledger);
  assert.deepEqual(mineDegradedSuccess(gatherRuns(records), records), []);
});

test("mineDegradedSuccess: findings are sorted by taskId+signal, not ledger/scan order", () => {
  // RD-LATER (W1-T210) appears BEFORE RD-EARLIER (W1-T205) in the ledger, so an
  // unsorted (scan-order) result would list them T210 then T205 — the sort must
  // reorder them ascending by taskId.
  const ledger = [
    `{"ts":"2026-03-05T00:00:00.000Z","run_id":"RD-LATER","task_id":"W1-T210","step":"run.start","type":"implement"}`,
    `{"ts":"2026-03-05T00:01:00.000Z","run_id":"RD-LATER","task_id":"W1-T210","step":"review.posted","state":"success","proof_exec":["not_executable"],"floor_degraded":true}`,
    `{"ts":"2026-03-05T00:02:00.000Z","run_id":"RD-LATER","task_id":"W1-T210","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/210"}`,
    `{"ts":"2026-03-06T00:00:00.000Z","run_id":"RD-EARLIER","task_id":"W1-T205","step":"run.start","type":"implement"}`,
    `{"ts":"2026-03-06T00:01:00.000Z","run_id":"RD-EARLIER","task_id":"W1-T205","step":"review.posted","state":"success","proof_exec":["not_executable"],"floor_degraded":true}`,
    `{"ts":"2026-03-06T00:02:00.000Z","run_id":"RD-EARLIER","task_id":"W1-T205","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/205"}`,
  ].join("\n");
  const records = parseLedger(ledger);
  const findings = mineDegradedSuccess(gatherRuns(records), records);
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((f) => f.taskId),
    ["W1-T205", "W1-T210"], // ascending, NOT ledger-scan order (T210 then T205)
  );
});

test("mineDegradedSuccess: same taskId matching two signals is ordered by signal key (tie-break)", () => {
  const ledger = [
    `{"ts":"2026-03-07T00:00:00.000Z","run_id":"RD-MULTI","task_id":"W1-T206","step":"run.start","type":"implement"}`,
    `{"ts":"2026-03-07T00:01:00.000Z","run_id":"RD-MULTI","task_id":"W1-T206","step":"review.posted","state":"success","proof_exec":["not_executable"],"floor_degraded":true,"reviewer_outcome":"error_max_turns"}`,
    `{"ts":"2026-03-07T00:02:00.000Z","run_id":"RD-MULTI","task_id":"W1-T206","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/206"}`,
  ].join("\n");
  const records = parseLedger(ledger);
  const findings = mineDegradedSuccess(gatherRuns(records), records);
  assert.equal(findings.length, 2); // both signals match this single run
  assert.deepEqual(
    findings.map((f) => f.signal),
    ["reviewer_error_max_turns", "zero_executed_dialect"], // sorted, "r" < "z"
  );
});

test("renderDegradedSuccess reports 'no signal' when nothing was mined, and names the run + signal otherwise", () => {
  assert.match(renderDegradedSuccess([]), /No merged run posted/);
  const rendered = renderDegradedSuccess([
    { runId: "RD1", taskId: "W1-T200", signal: "zero_executed_dialect", description: "proof_exec 0/2 executed" },
  ]);
  assert.match(rendered, /W1-T200 \(RD1\)/);
  assert.match(rendered, /zero_executed_dialect/);
});

test("buildGather/renderGather surface degraded-success findings (W1-T73)", () => {
  const g = buildGather({ ledgerNdjson: DEGRADED_LEDGER, learningsMd: "# L\n" });
  assert.equal(g.degradedSuccess.length, 1);
  assert.equal(g.degradedSuccess[0]!.taskId, "W1-T200");
  assert.match(renderGather(g), /Degraded-success mining/);
  assert.match(renderGather(g), /W1-T200/);
});

// ── Procedural-success mining (W1-T87, ratifies P13) — the OTHER half of the
// flywheel: merged runs are mined for a REUSABLE shape, deterministically. ──

// P1 and P2 share ONE shape: merged, zero fix.dispatch lines (clean single
// strike), review.posted fully executed (never keyword-floored). P3 shares
// only HALF that shape (it needed a fix.dispatch) — a single-run shape that
// must emit NOTHING (the bloat guard: one success is an anecdote).
const PROCEDURAL_LEDGER = [
  `{"ts":"2026-04-01T00:00:00.000Z","run_id":"P1","task_id":"W1-T300","step":"run.start","type":"implement"}`,
  `{"ts":"2026-04-01T00:01:00.000Z","run_id":"P1","task_id":"W1-T300","step":"review.posted","state":"success","proof_exec":["executed_pass","executed_pass"],"floor_degraded":false}`,
  `{"ts":"2026-04-01T00:02:00.000Z","run_id":"P1","task_id":"W1-T300","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/300"}`,
  `{"ts":"2026-04-02T00:00:00.000Z","run_id":"P2","task_id":"W1-T301","step":"run.start","type":"implement"}`,
  `{"ts":"2026-04-02T00:01:00.000Z","run_id":"P2","task_id":"W1-T301","step":"review.posted","state":"success","proof_exec":["executed_pass"],"floor_degraded":false}`,
  `{"ts":"2026-04-02T00:02:00.000Z","run_id":"P2","task_id":"W1-T301","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/301"}`,
  `{"ts":"2026-04-03T00:00:00.000Z","run_id":"P3","task_id":"W1-T302","step":"run.start","type":"implement"}`,
  `{"ts":"2026-04-03T00:01:00.000Z","run_id":"P3","task_id":"W1-T302","step":"fix.dispatch","strike":1,"strike_cap":3,"unmet_count":1,"round":"fresh"}`,
  `{"ts":"2026-04-03T00:02:00.000Z","run_id":"P3","task_id":"W1-T302","step":"review.posted","state":"success","proof_exec":["executed_pass"],"floor_degraded":false}`,
  `{"ts":"2026-04-03T00:03:00.000Z","run_id":"P3","task_id":"W1-T302","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/302"}`,
].join("\n");

test("mineProceduralCandidates: two merged runs sharing a procedure shape yield ONE candidate citing both runs; a single-run shape yields NOTHING", () => {
  const records = parseLedger(PROCEDURAL_LEDGER);
  const runs = gatherRuns(records);
  const candidates = mineProceduralCandidates(runs, records);
  assert.equal(candidates.length, 1);
  const c = candidates[0]!;
  assert.equal(c.kind, "procedural");
  assert.equal(c.taskType, "implement");
  assert.deepEqual(c.signals, ["clean_single_strike", "fully_executed_proof"]);
  assert.deepEqual(c.runIds, ["P1", "P2"]);
  assert.deepEqual(c.taskIds, ["W1-T300", "W1-T301"]);
  assert.equal(c.supportingRuns, 2);
  // W1-T302 (P3) needed a fix.dispatch — a DIFFERENT, single-run shape — never proposed.
  assert.ok(!candidates.some((x) => x.taskIds.includes("W1-T302")));
});

test("mineProceduralCandidates: a shape below threshold (a single success) proposes NOTHING", () => {
  const records = parseLedger(
    [
      `{"ts":"2026-04-05T00:00:00.000Z","run_id":"S1","task_id":"W1-T310","step":"run.start","type":"implement"}`,
      `{"ts":"2026-04-05T00:01:00.000Z","run_id":"S1","task_id":"W1-T310","step":"verdict","verdict":"merged","cost_usd":1.0,"pr_url":"https://github.com/o/r/pull/310"}`,
    ].join("\n"),
  );
  assert.deepEqual(mineProceduralCandidates(gatherRuns(records), records), []);
});

test("mineProceduralCandidates: the signal set is DATA — a caller-supplied signal groups runs with ZERO executor-code changes", () => {
  const records = parseLedger(PROCEDURAL_LEDGER);
  const runs = gatherRuns(records);
  // Every one of P1/P2/P3 is a "fast" run under a made-up threshold — a signal
  // row supplied by the CALLER, not a new mining function or branch.
  const fastRow = { key: "fast", matches: () => true, describe: () => "fast" };
  const candidates = mineProceduralCandidates(runs, records, { signals: [fastRow], threshold: 3 });
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0]!.taskIds, ["W1-T300", "W1-T301", "W1-T302"]);
  assert.equal(candidates[0]!.supportingRuns, 3);
});

test("fixDispatchCountByRun: counts fix.dispatch lines per run_id; a run with none reads as absent (zero)", () => {
  const counts = fixDispatchCountByRun(parseLedger(PROCEDURAL_LEDGER));
  assert.equal(counts.get("P3"), 1);
  assert.equal(counts.get("P1") ?? 0, 0);
});

test("renderProceduralCandidates reports 'no shape' when nothing was mined, and names the shape + tasks otherwise", () => {
  assert.match(renderProceduralCandidates([]), /No shape shared by/);
  const rendered = renderProceduralCandidates(
    mineProceduralCandidates(gatherRuns(parseLedger(PROCEDURAL_LEDGER)), parseLedger(PROCEDURAL_LEDGER)),
  );
  assert.match(rendered, /implement/);
  assert.match(rendered, /W1-T300, W1-T301/);
});

test("buildGather/renderGather surface procedural-success candidates (W1-T87/P13)", () => {
  const g = buildGather({ ledgerNdjson: PROCEDURAL_LEDGER, learningsMd: "# L\n" });
  assert.equal(g.proceduralCandidates.length, 1);
  assert.deepEqual(g.proceduralCandidates[0]!.taskIds, ["W1-T300", "W1-T301"]);
  assert.match(renderGather(g), /Procedural-success mining/);
});

// ── Follow-up harvest (W1-T105) ─────────────────────────────────────────────
// The operator's requirement, verbatim: "ensure that if any implementations
// come back with follow-up research, actions, tasks, etc — they get added to
// the plan." run-task.ts ledgers a worker's OPTIONAL '## Follow-ups' section as
// ONE `report.followups` event (type, text, run/task/PR provenance); this
// module mines the unharvested ones into PROPOSAL CANDIDATES (rule 15: never
// an auto-filed task) and marks each processed so a later pass mints nothing
// twice.

test("mineFollowups: a report.followups event ledgers entries with provenance, and mints ONE candidate per entry citing run/task/PR", () => {
  const records = parseLedger(
    [
      `{"ts":"2026-05-01T00:00:00.000Z","run_id":"W1-T400-1","task_id":"W1-T400","step":"report.followups","pr_url":"https://github.com/o/r/pull/400","entries":[{"type":"research","text":"confirm the mutation gate needs the same diff-scope trick"},{"type":"task","text":"extend ci-gate.yml REQUIRED array for the new check"}]}`,
    ].join("\n"),
  );
  const harvest = mineFollowups(records);
  assert.equal(harvest.candidates.length, 2);
  assert.equal(harvest.deduped.length, 0);
  const [research, task] = harvest.candidates;
  assert.equal(research!.type, "research");
  assert.equal(research!.text, "confirm the mutation gate needs the same diff-scope trick");
  assert.equal(research!.runId, "W1-T400-1");
  assert.equal(research!.taskId, "W1-T400");
  assert.equal(research!.prUrl, "https://github.com/o/r/pull/400");
  assert.equal(task!.type, "task");
  // Each candidate's harvest line names ITS OWN entry — the mark that stops a
  // second mining pass from minting the same entry twice.
  assert.deepEqual(
    harvest.harvestLines.map((l) => l.step),
    ["followup.harvested", "followup.harvested"],
  );
});

test("mineFollowups: an already-harvested entry mints NOTHING again — a second pass over the updated ledger is empty", () => {
  const base = [
    `{"ts":"2026-05-02T00:00:00.000Z","run_id":"R1","task_id":"W1-T401","step":"report.followups","pr_url":"https://github.com/o/r/pull/401","entries":[{"type":"action","text":"rotate the leaked fixture token"},{"type":"research","text":"unaffected second entry, still unharvested"}]}`,
  ];
  // Simulate: entry 0 was ALREADY harvested by a prior retro; entry 1 was not.
  const alreadyHarvested = `{"ts":"2026-05-02T01:00:00.000Z","run_id":"R1","task_id":"W1-T401","step":"followup.harvested","entry_id":"R1:0"}`;
  const records = parseLedger([...base, alreadyHarvested].join("\n"));
  const first = mineFollowups(records);
  assert.equal(first.candidates.length, 1, "only the NOT-yet-harvested entry mints");
  assert.equal(first.candidates[0]!.text, "unaffected second entry, still unharvested");

  // Now simulate a REAL retro run: append first.harvestLines (recordFollowupHarvest's
  // job), then mine again over the updated ledger — mints ZERO.
  const updated = parseLedger(
    [...base, alreadyHarvested, ...first.harvestLines.map((l) => JSON.stringify({ ts: "2026-05-02T02:00:00.000Z", ...l }))].join(
      "\n",
    ),
  );
  const second = mineFollowups(updated);
  assert.equal(second.candidates.length, 0);
  assert.equal(second.deduped.length, 0);
});

test("mineFollowups: absent report.followups events change nothing — no candidates, no harvest lines", () => {
  const records = parseLedger(LEDGER); // the module-level fixture, carries no report.followups step
  const harvest = mineFollowups(records);
  assert.deepEqual(harvest, { candidates: [], deduped: [], harvestLines: [] });
});

test("mineFollowups: an entry matching an open task/proposal title is DEDUPED, not minted, and ledgers followup.deduped", () => {
  const records = parseLedger(
    [
      `{"ts":"2026-05-03T00:00:00.000Z","run_id":"R2","task_id":"W1-T402","step":"report.followups","pr_url":"https://github.com/o/r/pull/402","entries":[{"type":"task","text":"ci-gate REQUIRED array should be one entry per line"},{"type":"action","text":"a genuinely new, unrelated action"}]}`,
    ].join("\n"),
  );
  const openTitles = ["ci-gate REQUIRED array — one entry per line, so concurrent gate additions merge"];
  const harvest = mineFollowups(records, openTitles);
  assert.equal(harvest.candidates.length, 1);
  assert.equal(harvest.candidates[0]!.text, "a genuinely new, unrelated action");
  assert.equal(harvest.deduped.length, 1);
  assert.equal(harvest.deduped[0]!.text, "ci-gate REQUIRED array should be one entry per line");
  assert.equal(harvest.harvestLines.find((l) => l.entry_id === harvest.deduped[0]!.entryId)?.step, "followup.deduped");
  // A second pass over an updated ledger carrying that dedup mark mints neither candidate nor dup again.
  const updated = parseLedger(
    [
      ...records.map((r) => JSON.stringify(r)),
      ...harvest.harvestLines.map((l) => JSON.stringify({ ts: "2026-05-03T01:00:00.000Z", ...l })),
    ].join("\n"),
  );
  assert.deepEqual(mineFollowups(updated, openTitles), { candidates: [], deduped: [], harvestLines: [] });
});

test("recordFollowupHarvest: writes every harvest line via the injectable writer, never touching disk in a test", () => {
  const harvest = mineFollowups(
    parseLedger(
      `{"ts":"2026-05-04T00:00:00.000Z","run_id":"R3","task_id":"W1-T403","step":"report.followups","entries":[{"type":"research","text":"x"}]}`,
    ),
  );
  const written: unknown[] = [];
  recordFollowupHarvest(harvest, {
    ledgerPath: "/dev/null/unused",
    writeLedger: (_path, line) => {
      written.push(line);
    },
  });
  assert.equal(written.length, 1);
  assert.equal((written[0] as { step: string }).step, "followup.harvested");
});

test("renderFollowupCandidates: names each candidate's origin verbatim as a CANDIDATE, and notes dedup matches without minting them", () => {
  const harvest = mineFollowups(
    parseLedger(
      [
        `{"ts":"2026-05-05T00:00:00.000Z","run_id":"R4","task_id":"W1-T404","step":"report.followups","pr_url":"https://github.com/o/r/pull/404","entries":[{"type":"research","text":"brand new research idea"},{"type":"task","text":"already-open dup"}]}`,
      ].join("\n"),
    ),
    ["already-open dup task exists verbatim"],
  );
  const rendered = renderFollowupCandidates(harvest);
  assert.match(rendered, /PROPOSAL CANDIDATES/);
  assert.match(rendered, /brand new research idea/);
  assert.match(rendered, /W1-T404/);
  assert.match(rendered, /pull\/404/);
  assert.doesNotMatch(rendered, /- \[task\] already-open dup/); // deduped, never minted as a bulleted candidate
  assert.match(rendered, /already-open dup.*not re-minted|not re-minted.*already-open dup/s);
});

test("renderFollowupCandidates: no unharvested follow-up renders an explicit empty state, not a blank section", () => {
  assert.match(renderFollowupCandidates({ candidates: [], deduped: [], harvestLines: [] }), /No unharvested follow-up/);
});

test("buildGather/renderGather surface the follow-up harvest, deduping via opts.openTitles", () => {
  const ledgerNdjson = [
    `{"ts":"2026-05-06T00:00:00.000Z","run_id":"R5","task_id":"W1-T405","step":"report.followups","pr_url":"https://github.com/o/r/pull/405","entries":[{"type":"action","text":"a fresh, unmatched action"}]}`,
  ].join("\n");
  const g = buildGather({ ledgerNdjson, learningsMd: "# L\n", openTitles: ["something entirely different"] });
  assert.equal(g.followups.candidates.length, 1);
  assert.equal(g.followups.candidates[0]!.text, "a fresh, unmatched action");
  assert.match(renderGather(g), /Follow-up harvest/);
  assert.match(renderGather(g), /a fresh, unmatched action/);
});

test("phraseProceduralCandidate: evidence is deterministic — the LLM stub receives ONLY the pre-detected candidate, never raw ledger records", async () => {
  const candidate: ProceduralCandidate = {
    kind: "procedural",
    shapeKey: "implement:clean_single_strike+fully_executed_proof",
    taskType: "implement",
    signals: ["clean_single_strike", "fully_executed_proof"],
    runIds: ["P1", "P2"],
    taskIds: ["W1-T300", "W1-T301"],
    supportingRuns: 2,
  };
  let received: unknown;
  const draft = await phraseProceduralCandidate(candidate, {
    phrase: (c) => {
      received = c; // captured — must be the CANDIDATE ONLY (deep-equal), no ledger records/other candidates
      return "Recon-first, single-strike shape: a fully-observed proof pass with no fix rung needed.";
    },
  });
  assert.deepEqual(received, candidate);
  assert.equal(draft.subsystem, "procedural");
  assert.equal(draft.fact, "Recon-first, single-strike shape: a fully-observed proof pass with no fix rung needed.");
  assert.match(draft.src, /W1-T300, W1-T301/);
});

test("phraseProceduralCandidate's draft rides the EXISTING learnings pipeline — selectLearnings injects it like any other entry (no parallel store)", async () => {
  const candidate: ProceduralCandidate = {
    kind: "procedural",
    shapeKey: "implement:clean_single_strike+fully_executed_proof",
    taskType: "implement",
    signals: ["clean_single_strike", "fully_executed_proof"],
    runIds: ["P1", "P2"],
    taskIds: ["W1-T300", "W1-T301"],
    supportingRuns: 2,
  };
  const draft = await phraseProceduralCandidate(candidate, { phrase: () => "A clean single-strike merge shape." });
  const entry: LearningEntry = {
    id: draft.id,
    subsystem: draft.subsystem,
    lifecycle: "active",
    files: ["src/lib/retro.ts"],
    fact: draft.fact,
    src: draft.src,
  };
  // The W1-T19 matcher (learnings.ts's selectLearnings) — UNTOUCHED by this task —
  // selects the drafted entry exactly like any ordinary factual entry: no `kind`
  // special-casing, no second store, no new injection path.
  const { selected } = selectLearnings([entry], ["src/lib/retro.ts"]);
  assert.deepEqual(selected, [entry]);
});

test("PROCEDURAL_SUCCESS_SIGNALS: shipped signal set names 'clean_single_strike' and 'fully_executed_proof' exactly (design note)", () => {
  assert.deepEqual(
    PROCEDURAL_SUCCESS_SIGNALS.map((s) => s.key),
    ["clean_single_strike", "fully_executed_proof"],
  );
});

// ── Consolidation contradiction detection (W1-T88, ratifies P14, extends W1-T33) ──

const BUDGET_A: LearningEntry = {
  id: "budget-dollar-ceiling",
  subsystem: "budget",
  lifecycle: "active",
  files: ["src/lib/inbox.ts"],
  fact: "Unattended-window budget is a per-window dollar ceiling.",
  src: "P34 round 1",
};

const BUDGET_B: LearningEntry = {
  id: "budget-subscription-headroom",
  subsystem: "budget",
  lifecycle: "active",
  files: ["src/lib/inbox.ts"],
  fact: "Unattended-window budget is subscription headroom, never a dollar ceiling.",
  src: "P34 round 3",
};

/** A deterministic "opposing" stub judge — flags exactly the two named ids, nothing else. */
function opposingJudge(idA: string, idB: string) {
  return {
    judge: (pair: ContradictionCandidatePair): { opposing: boolean; reasoning?: string } => {
      const ids = [pair.a.id, pair.b.id].sort();
      const expected = [idA, idB].sort();
      return ids[0] === expected[0] && ids[1] === expected[1]
        ? { opposing: true, reasoning: "mutually-exclusive budget models" }
        : { opposing: false };
    },
  };
}

test("keyContradictionCandidates: two active entries sharing subsystem + a files glob pair up; a third with no shared glob does not", () => {
  const unrelated: LearningEntry = {
    id: "unrelated",
    subsystem: "budget",
    lifecycle: "active",
    files: ["src/lib/other.ts"],
    fact: "Something else entirely.",
    src: "PR#1",
  };
  const pairs = keyContradictionCandidates([BUDGET_A, BUDGET_B, unrelated]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].key, "budget:src/lib/inbox.ts");
  assert.deepEqual([pairs[0].a.id, pairs[0].b.id].sort(), ["budget-dollar-ceiling", "budget-subscription-headroom"]);
});

test("keyContradictionCandidates: different subsystems never pair, even with identical files globs", () => {
  const otherSubsystem: LearningEntry = { ...BUDGET_B, id: "ci-fact", subsystem: "ci" };
  assert.deepEqual(keyContradictionCandidates([BUDGET_A, otherSubsystem]), []);
});

test("keyContradictionCandidates: a superseded/quarantined/contested entry is never re-proposed as a candidate", () => {
  const decided: LearningEntry = { ...BUDGET_B, lifecycle: "superseded", supersededBy: BUDGET_A.id };
  assert.deepEqual(keyContradictionCandidates([BUDGET_A, decided]), []);
});

test("ACCEPTANCE: a seeded contradicting pair is marked contested, excluded from injection, and surfaced as a decidable question", async () => {
  const pairs = keyContradictionCandidates([BUDGET_A, BUDGET_B]);
  const findings = await flagContradictions(pairs, opposingJudge(BUDGET_A.id, BUDGET_B.id));
  assert.equal(findings.length, 1);

  const updated = applyContestedLifecycle([BUDGET_A, BUDGET_B], findings);
  const a = updated.find((e) => e.id === BUDGET_A.id)!;
  const b = updated.find((e) => e.id === BUDGET_B.id)!;
  assert.equal(a.lifecycle, "contested");
  assert.equal(b.lifecycle, "contested");
  assert.equal(a.contestedWith, BUDGET_B.id);
  assert.equal(b.contestedWith, BUDGET_A.id);

  // the matcher (learnings.ts's selectLearnings) skips BOTH contested entries
  const { selected } = selectLearnings(updated, ["src/lib/inbox.ts"]);
  assert.deepEqual(selected, []);

  // the retro report carries BOTH texts
  const report = renderContradictions(findings);
  assert.match(report, /CONTESTED/);
  assert.match(report, new RegExp(BUDGET_A.fact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(report, new RegExp(BUDGET_B.fact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // the question carries both texts and names the decision ("which governs?")
  const question = contradictionQuestion(findings[0], "2026-07-23T00:00:00.000Z");
  assert.equal(question.task, "retro");
  assert.match(question.question, /which governs\?/);
  assert.match(question.question, new RegExp(BUDGET_A.fact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(question.question, new RegExp(BUDGET_B.fact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("ACCEPTANCE: a refining (non-opposing) newer learning supersedes exactly as today — no contested flag", async () => {
  const pairs = keyContradictionCandidates([BUDGET_A, BUDGET_B]);
  // the judge sees the pair but finds it a REFINEMENT, not a contradiction
  const findings = await flagContradictions(pairs, { judge: () => ({ opposing: false }) });
  assert.deepEqual(findings, []);

  const updated = applyContestedLifecycle([BUDGET_A, BUDGET_B], findings);
  assert.deepEqual(updated, [BUDGET_A, BUDGET_B], "nothing is flipped when the judge finds no opposition");

  // ordinary recency-overwrite (a human/Architect marking the elder superseded) is untouched
  const recencySuperseded: LearningEntry[] = [BUDGET_A, { ...BUDGET_B, lifecycle: "superseded", supersededBy: BUDGET_A.id }];
  const { selected } = selectLearnings(recencySuperseded, ["src/lib/inbox.ts"]);
  assert.deepEqual(selected.map((e) => e.id), [BUDGET_A.id]);
});

test("ACCEPTANCE: resolution is Architect-authored and ledgered — re-admits the winner, marks the loser superseded, and no code path auto-resolves", async () => {
  const pairs = keyContradictionCandidates([BUDGET_A, BUDGET_B]);
  const findings = await flagContradictions(pairs, opposingJudge(BUDGET_A.id, BUDGET_B.id));
  const contested = applyContestedLifecycle([BUDGET_A, BUDGET_B], findings);

  const ledgerLines: Array<{ path: string; line: Record<string, unknown> }> = [];
  const resolved = applyContradictionResolution(
    contested,
    { activeId: BUDGET_B.id, supersededId: BUDGET_A.id, by: "architect", reason: "P34 round 3 ratified" },
    {
      ledgerPath: "/tmp/fixture-ledger.ndjson",
      writeLedger: (path, line) => {
        ledgerLines.push({ path, line: line as Record<string, unknown> });
      },
    },
  );

  const winner = resolved.find((e) => e.id === BUDGET_B.id)!;
  const loser = resolved.find((e) => e.id === BUDGET_A.id)!;
  assert.equal(winner.lifecycle, "active", "the named winner is re-admitted to injection");
  assert.equal(winner.contestedWith, undefined);
  assert.equal(loser.lifecycle, "superseded");
  assert.equal(loser.supersededBy, BUDGET_B.id);
  assert.equal(loser.contestedWith, undefined);

  // re-admitted: the matcher selects the winner again, never the loser
  const { selected } = selectLearnings(resolved, ["src/lib/inbox.ts"]);
  assert.deepEqual(selected.map((e) => e.id), [BUDGET_B.id]);

  // the resolution is ledgered
  assert.equal(ledgerLines.length, 1);
  assert.equal(ledgerLines[0].path, "/tmp/fixture-ledger.ndjson");
  assert.equal(ledgerLines[0].line.step, "contradiction.resolved");
  assert.equal(ledgerLines[0].line.active_id, BUDGET_B.id);
  assert.equal(ledgerLines[0].line.superseded_id, BUDGET_A.id);
  assert.equal(ledgerLines[0].line.by, "architect");
});

test("flagContradictions: judge receives ONLY the candidate pair — never the whole corpus, never sibling pairs", async () => {
  const received: ContradictionCandidatePair[] = [];
  const pairs = keyContradictionCandidates([BUDGET_A, BUDGET_B]);
  await flagContradictions(pairs, {
    judge: (pair) => {
      received.push(pair);
      return { opposing: false };
    },
  });
  assert.deepEqual(received, pairs);
});

test("renderContradictions: reports 'no contradicting pair' when nothing was found", () => {
  assert.match(renderContradictions([]), /No contradicting pair found/);
});

// ── docs/ORIENTATION.md (W1-T39) ───────────────────────────────────────────

const STANDING_RULES_FIXTURE = `
## 11. Open decisions

Some unrelated section with a numbered list that must NOT leak into §12:
1. not a standing rule.

## 12. Standing rules

1. PROVENANCE OR IT DOESN'T GO IN A PROMPT.
2. Trust, scheduling, strikes, budgets = deterministic predicates. Never LLM decisions.
3B. **The merge gate is a GitHub-enforced CONTRACT**, wrapped onto
   a SECOND line that must fold back into rule 3B, never becoming its own bullet.
20. A LAST NUMBERED RULE.

- Lives at repo root. Header carries sync date + focus, his-house style.
- A second trailing bullet that is NOT a Standing rule.

## 12A. Documentation as a gated artifact, in tiers

Unrelated section content that must never appear in the extracted list.
`;

test("extractStandingRules: pulls ONLY the numbered rules from §12, folding wrapped continuation lines back in", () => {
  const rules = extractStandingRules(STANDING_RULES_FIXTURE);
  assert.deepEqual(rules, [
    "1. PROVENANCE OR IT DOESN'T GO IN A PROMPT.",
    "2. Trust, scheduling, strikes, budgets = deterministic predicates. Never LLM decisions.",
    "3B. The merge gate is a GitHub-enforced CONTRACT, wrapped onto a SECOND line that must fold back into rule 3B, never becoming its own bullet.",
    "20. A LAST NUMBERED RULE.",
  ]);
});

test("extractStandingRules: never leaks a numbered list from a DIFFERENT section, and stops at the trailing bullets after the numbered list", () => {
  const rules = extractStandingRules(STANDING_RULES_FIXTURE);
  assert.ok(!rules.some((r) => r.includes("not a standing rule")));
  assert.ok(!rules.some((r) => r.includes("Lives at repo root")));
  assert.ok(!rules.some((r) => r.includes("gated artifact")));
});

test("extractStandingRules: a missing §12 heading fails SOFT (empty list), never throws", () => {
  assert.deepEqual(extractStandingRules("# Some doc\n\nNo standing rules here.\n"), []);
});

function fixtureTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "Example next task",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    ...overrides,
  };
}

test("renderOrientation: names the next runnable task, the shipped-since-marker list, and the invariants", () => {
  const gather = buildGather({ ledgerNdjson: SHIP_LEDGER, learningsMd: "# L\n- a\n" });
  const md = renderOrientation({
    generatedAt: "2026-07-18T00:00:00.000Z",
    gather,
    nextTask: fixtureTask({ id: "W1-T7", title: "Transient-vs-strike classifier", depends_on: ["W1-T3"] }),
    standingRules: ["1. RULE ONE.", "2. RULE TWO."],
  });
  assert.match(md, /# ORIENTATION/);
  assert.match(md, /MAINTAINED BY `rmd retro`/);
  assert.match(md, /## Next runnable task/);
  assert.match(md, /\*\*W1-T7\*\* — Transient-vs-strike classifier/);
  assert.match(md, /depends_on: W1-T3/);
  assert.match(md, /## Never-do invariants/);
  assert.match(md, /1\. RULE ONE\./);
  assert.match(md, /2\. RULE TWO\./);
});

test("renderOrientation: no runnable task renders an explicit '(none runnable)' state, never a blank/undefined section", () => {
  const gather = buildGather({ ledgerNdjson: "", learningsMd: "# L\n" });
  const md = renderOrientation({ generatedAt: "2026-07-18T00:00:00.000Z", gather, standingRules: [] });
  assert.match(md, /none runnable right now/);
  assert.doesNotMatch(md, /undefined/);
});

// The saveMarker/loadMarker atomicity + corrupt-vs-absent-marker coverage for W1-T242
// lives in test/retro-marker-atomic.test.ts, mirroring test/ledger-atomic.test.ts and
// test/status-atomic-write.test.ts's precedent of one dedicated file per atomic-write
// surface (not folded into this module's general render/gather tests).
